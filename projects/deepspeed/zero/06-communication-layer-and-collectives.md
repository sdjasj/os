# 06. `deepspeed.comm`：通信门面、进程组与性能观测

DeepSpeed 项目规则要求内部使用 `import deepspeed.comm as dist`，而不是直接绑定 PyTorch distributed。这个门面既保留常用 collective 语义，又提供 accelerator 后端选择、兼容层和通信 profiling。理解它之后，ZeRO 源码中的 collective 才不再只是函数名。

## 全局 backend 对象

[`deepspeed/comm/comm.py`](comm.py) 用全局 `cdb` 表示当前通信数据库/后端，并维护 Torch、CCL 等后端对象。公共函数大多是薄包装：

```python
@timed_op
def all_reduce(tensor, op=ReduceOp.SUM, group=None, async_op=False, ...):
    return cdb.all_reduce(tensor, op, group, async_op)
```

薄包装很重要：业务代码依赖稳定门面，具体 backend 负责把 group、work handle 和 op 翻译给底层框架。

## 初始化路径

`deepspeed.initialize()` 会根据 accelerator 选择 backend name，再调用 `dist.init_distributed()`。初始化函数大致处理三种情况：

1. DeepSpeed comm 已初始化：复用现有 `cdb`；
2. 外部已初始化兼容的 torch process group：用 `TorchBackend` 接管；
3. 尚未初始化：从环境变量、MPI discovery 或显式参数建立 process group。

关键环境通常包括：

```text
RANK          全局 rank
WORLD_SIZE    全局进程数
LOCAL_RANK    当前节点内 rank / 常用于选择设备
MASTER_ADDR   rendezvous 主节点地址
MASTER_PORT   rendezvous 端口
```

这些值必须在每个进程中一致地描述同一个 world。一个 rank 用错 world size，常表现为其他 rank 永远等不到 collective。

## Process group 是 collective 的作用域

`group=None` 表示默认 world group，但复杂并行中几乎不能只想象一个 group：

```text
global world
├── data parallel groups
├── tensor parallel groups
├── pipeline parallel groups
├── sequence parallel groups
└── expert / expert-data-parallel groups
```

同一个 `all_reduce()`，传 DP group 时同步模型副本的梯度，传 TP group 时合并同一层的张量分片。错误 group 可能形状上仍可运行，却产生错误数值或多余通信。

## 四类 API 形状

### list-based All-Gather

```python
parts = [torch.empty_like(local) for _ in range(dist.get_world_size(group))]
dist.all_gather(parts, local, group=group)
full = torch.cat(parts)
```

直观但 Python list 和多 tensor 管理有开销。

### tensor-based All-Gather

```python
full = torch.empty(world_size * local.numel(), device=local.device)
dist.all_gather_into_tensor(full, local, group=group)
```

要求输入布局和输出大小符合契约，便于 flat partition 和大 bucket。

### Reduce-Scatter

list 或 tensor 版本都要求输入能按 world size 切分。ZeRO 常先 padding/flatten，确保每个 rank partition 等长。

### Async work

`async_op=True` 返回 handle，不表示数据立刻可用。必须在依赖点 `wait()`，或依赖 accelerator stream/event 建立正确顺序。错误的异步代码可能只在负载变大时暴露竞态。

## `timed_op` 做了什么

装饰器先判断通信 logger 是否启用，匹配 `prof_all`、指定 op 或显式 `prof=True` 后：

1. 根据函数参数估算消息大小；
2. 启动同步 wall-clock timer；
3. 调用实际 collective；
4. 同步 accelerator，必要时 barrier；
5. 记录 op、调用名、耗时和字节数。

同步是为了得到准确耗时，也会改变原本异步执行和重叠。因此 profiling 结果用于诊断，不能假定开启日志后训练性能完全无扰动。

配置示例：

```json
{
  "comms_logger": {
    "enabled": true,
    "verbose": true,
    "prof_all": false,
    "debug": false,
    "prof_ops": ["all_reduce", "reduce_scatter", "all_gather"]
  }
}
```

## collective 的次序契约

同一 group 中，各 rank 必须以兼容次序调用 collective。下面是典型死锁：

```text
rank 0: all_reduce(A) → all_gather(B)
rank 1: all_gather(B) → all_reduce(A)
```

即使 tensor shape 都正确，后端也无法匹配操作。条件分支、unused parameter、异常和不同 dataloader 长度都可能让 rank 走出不同序列。

排查时先记录：

- rank 和 group；
- collective 名；
- tensor shape/dtype/device；
- sequence number 或调用位置；
- 是否 async，在哪等待；
- 所有 rank 是否进入同一训练 step。

## All-Reduce 中的平均策略

底层 collective 常执行 SUM，Engine 再选择 pre-scale 或 post-scale：

```text
pre-scale:  tensor /= world_size → all_reduce(SUM)
post-scale: all_reduce(SUM) → tensor /= world_size
predivide:  先除一部分，reduce 后再乘剩余系数
```

数学上相同，浮点范围和舍入不同。Engine 的 `gradient_average`、`prescale_gradients`、`gradient_predivide_factor` 和 `gradient_allreduce_op` 共同决定路径。

## Bucket、重叠与 stream

Backward 按层从后向前产生梯度。若一个 bucket 填满就发起异步 reduction：

```text
GPU compute stream:  grad L_n | grad L_n-1 | grad L_n-2 | ...
comm stream:                reduce bucket 0 | reduce bucket 1
```

理想情况是通信藏在后续计算背后。实际效果受以下因素影响：

- bucket 太小：启动延迟高；
- bucket 太大：开始得晚，峰值 buffer 大；
- backward 太快：没有足够 compute 隐藏通信；
- 拓扑慢：跨节点带宽成为瓶颈；
- profiling 强制同步：重叠被破坏；
- 依赖/stream 处理错误：数据未就绪或过度同步。

## 分布式测试框架是通信契约的样例

[`tests/unit/common.py`](../../tests/unit/common.py) 的 `DistributedTest` 会：

1. 选择空闲端口；
2. 按 `world_size` 生成多个进程；
3. 设置 rank/world 环境；
4. 初始化 backend；
5. 运行每个测试方法；
6. 汇总 skip/failure 并清理进程。

[`tests/unit/comm/test_dist.py`](../../tests/unit/comm/test_dist.py) 展示了如何声明不同 world size、检查 rank 和测试 collective。读它比自己从零写 multiprocessing harness 更可靠。

## 本章实验：两 rank 验证 Reduce-Scatter

在 DeepSpeed 测试框架中设计一个 `world_size=2` 的实验：

```python
import torch
import deepspeed.comm as dist

rank = dist.get_rank()
local = torch.tensor([rank + 1.0, rank + 2.0], device="cuda")
output = torch.empty(1, device=local.device)
inputs = list(local.chunk(2))
dist.reduce_scatter(output, inputs)
```

先手算两个 rank 的输出，再根据 backend 是否默认 SUM 验证。实际加入测试时应使用仓库的 `DistributedTest` 和 accelerator device，而非硬编码 CUDA；这里代码只表达 collective 形状。

静态实验：

```bash
rg -n '^def (init_distributed|all_reduce|reduce_scatter|all_gather)' \
  deepspeed/comm/comm.py
rg -n '^class TorchBackend' deepspeed/comm/torch.py
rg -n 'world_size =|pytest.mark.world_size' tests/unit/comm
```

## 常见误区

- 只看 collective 名，不记录 group。
- `async_op=True` 后立刻读取输出，未建立依赖。
- 开启通信 profiling 后把同步开销也当成原始训练开销。
- rank 条件分支导致 collective 次序不一致。
- 把 LOCAL_RANK 当全局 rank，或把 WORLD_SIZE 当 DP size。
- 在 DeepSpeed 内部新增代码时直接导入 torch distributed，绕过 comm 门面。

## 自测

1. All-Reduce 与 Reduce-Scatter 的输出布局有何不同？
2. 为什么同一个 op 在不同 process group 中语义不同？
3. `timed_op` 为什么需要同步，这会怎样影响被测程序？
4. 两个 rank collective shape 一样，为什么仍可能死锁？
