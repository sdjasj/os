# 02. PyTorch 分布式基础：rank、进程组与 collective

Megatron 的并行不是简单“把模型放到多张卡”，而是为同一批进程建立多组相交通信域。一个 rank 可同时属于 TP、PP、DP、CP 和 embedding group；同一个 `all_reduce` 在不同 group 上代表不同数学操作。

## 一张 GPU、一个进程

典型启动让 `torch.distributed.run` 为每张 GPU 创建一个进程，并提供：

```text
RANK        全局序号，[0, WORLD_SIZE)
LOCAL_RANK  节点内序号
WORLD_SIZE  总进程数
```

`pretrain_gpt.py` 导入早期读取 `RANK`，只让 rank 0 保留常见 warning。正式初始化由 `initialize_megatron()` 建立默认 process group、选择设备并创建模型并行子组。

```bash
uv run python -m torch.distributed.run \
  --nproc-per-node 8 pretrain_gpt.py <args>
```

八个进程并不自动等于 DP=8；如何分组由 TP/PP/CP 等配置决定。

## Process group 是 collective 作用域

```python
torch.distributed.all_reduce(tensor, group=tp_group)
torch.distributed.all_reduce(tensor, group=dp_group)
```

第一行通常拼合层内计算，第二行聚合不同数据副本的梯度。描述通信时必须同时记录 group。

当前生产代码逐步显式传递 `ProcessGroupCollection`：

```text
pg_collection.tp / pp / cp / dp / dp_cp / ep / expt_dp
```

它比深层模块随时读取全局 `parallel_state` 更容易组合和测试。

## 四种基础 collective

| 操作 | 输入与输出 | 项目中的典型用途 |
| --- | --- | --- |
| broadcast | 一个源复制给 group 全员 | TP rank 0 分发 batch |
| all-reduce | 规约后全员持有结果 | RowParallel 输出、DP 梯度 |
| all-gather | 收集每个 rank 的 shard | 完整 TP 输出、参数重建 |
| reduce-scatter | 规约后每人保留一段 | 分布式优化器梯度分片 |

reduce-scatter 适合结果本来就要分片保存的场景，避免先产生每人完整结果。

## 通信怎样进入 autograd

TP 的关键是 backward 对偶通信。`tensor_parallel/mappings.py` 用 autograd Function 封装语义：有些操作 forward 是 identity，backward 却 all-reduce；有些 forward gather，backward 则 split/reduce-scatter。

| mapping 直觉 | forward | backward |
| --- | --- | --- |
| copy to TP region | identity | all-reduce grad |
| reduce from TP region | all-reduce | identity |
| scatter to TP region | split/RS | gather |
| gather from TP region | gather | split/RS |

具体实现会受 sequence parallel 和优化路径影响，应以当前函数为准。

## 把全局 rank 写成坐标

假设：

```text
WORLD_SIZE=16, TP=2, PP=2, CP=2
DP=16/(2*2*2)=2
```

每个 rank 可理解为：

```text
(dp_rank, pp_rank, cp_rank, tp_rank)
```

同一 TP group 固定前三个坐标，只改变 `tp_rank`；PP/CP/DP group 同理。Expert Parallel 会重组 expert 与 expert-DP 关系，不能无条件再乘进公式，应读取初始化校验。

## Collective 的三个不变量

1. group 全员按一致顺序进入；
2. tensor dtype、形状与 API 语义一致；
3. group 构造在所有进程上一致。

一个 rank 先抛 Python shape error，其他 rank 常随后在 NCCL 中 timeout。排错应寻找最早的非 NCCL traceback，而不是把最后的 timeout 当根因。

## 异步通信与重叠

```python
handle = torch.distributed.all_reduce(
    tensor, async_op=True, group=group
)
# 做不依赖 tensor 结果的计算
handle.wait()
```

真正加速要求依赖图存在独立计算、stream 能并发且使用结果前正确 wait。Megatron 的 TP overlap、gradient reduce overlap、parameter gather overlap 都是在更高层安排这种时序；单独加 `async_op=True` 不保证收益。

## 实验：画四维 group

对 `WORLD_SIZE=16, TP=2, PP=2, CP=2, DP=2`：

1. 为每个 rank 写坐标；
2. 列出包含 rank 5 的 TP/PP/CP/DP group；
3. 指出 batch broadcast、RowParallel 输出和梯度同步使用哪个 group；
4. 改为 `TP=4, PP=2, CP=1` 后重算 DP。

```bash
rg -n "def initialize_model_parallel|create_group\(" \
  megatron/core/parallel_state.py
rg -n "class ProcessGroupCollection" \
  megatron/core/process_groups_config.py
```

## 自测

1. `RANK` 与 `LOCAL_RANK` 的区别是什么？
2. 为什么 collective 必须带 group 才有完整语义？
3. reduce-scatter 为何能减少后续存储？
4. shape error 为什么会诱发其他 rank 的 NCCL timeout？
5. 显式 `ProcessGroupCollection` 有何工程收益？

## 源码定位

- [parallel_state.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/parallel_state.py)
- [process_groups_config.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/process_groups_config.py)
- [TP mappings](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/tensor_parallel/mappings.py)
- [batch broadcast](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/utils.py)

下一章用 FLOPs、字节与生命周期理解 GPU 优化。
