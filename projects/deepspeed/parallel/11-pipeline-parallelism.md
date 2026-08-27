# 11. Pipeline Parallel：层分段、1F1B 调度与 PipelineEngine

Pipeline Parallel 把连续层放到不同 stage，通过 micro-batch 让多个 stage 同时工作。它改变的不只是模型布局，还改变训练 API：`PipelineModule` 选择 `PipelineEngine`，用户通常调用 `train_batch()`，由 schedule 统一发出加载、前向、收发激活、反向和更新指令。

## 为什么需要 Pipeline Parallel

数据并行要求每个 rank 放完整模型；ZeRO-3 可以动态 gather 参数，但每一层的计算仍在单个 rank 上。若模型深度很大、希望不同层稳定驻留不同设备，Pipeline 把层序列切成：

```text
stage 0: embedding + blocks 0..7
stage 1: blocks 8..15
stage 2: blocks 16..23
stage 3: blocks 24..31 + head + loss
```

单个样本依次穿过 stages。若一次只处理一个 batch，后续 stage 在开始时空闲、前面 stage 在结束时空闲，产生 pipeline bubble；micro-batching 用不同样本填充空槽。

## PipelineModule 的核心约束

[`PipelineModule`](module.py) 要求 forward 能表达为层序列：

```python
x = inputs
for layer in layers:
    x = layer(x)
return x
```

层间接口必须能作为 point-to-point message 传输。复杂的跨层跳连、共享状态和任意控制流需要显式包装，不能假定普通 `nn.Module.forward` 会自动被图切分。

当前类文档还明确指出：Pipeline Parallel 不兼容 ZeRO Stage 2/3。学习组合并行时必须以当前提交实现为准，不能把论文中的可能组合直接当成现有 API 支持。

## LayerSpec 为什么延迟构造

若每个 rank 先构造所有层，再只保留本 stage，初始化峰值仍然是完整模型。`LayerSpec` 保存类型和构造参数，`PipelineModule._build()` 只在当前 stage 构造本地分片：

```python
from deepspeed.pipe import LayerSpec, PipelineModule

layers = [
    LayerSpec(torch.nn.Linear, 1024, 4096),
    torch.nn.GELU(),
    LayerSpec(torch.nn.Linear, 4096, 1024),
]

model = PipelineModule(
    layers=layers,
    num_stages=2,
    loss_fn=loss_fn,
    partition_method="parameters",
)
```

`TiedLayerSpec` 额外描述跨位置共享的 module 和权重属性。各 stage 的 tied weights 需要专门 process group 同步，不能靠 Python 对象引用跨进程共享。

## 拓扑：rank 不等于 stage

`ProcessTopology` 用命名轴把全局 rank 映射为坐标，例如：

```text
axes = [pipe, data]
dims = [4, 2]

rank 0 → pipe=0, data=0
rank 1 → pipe=0, data=1
rank 2 → pipe=1, data=0
...
```

同一 pipeline replica 内，相邻 pipe 坐标收发 activation/gradient；相同 pipe stage、不同 data 坐标组成数据并行组，拥有相同层分片并同步梯度。

因此总 world size 为：

\[
N=N_{pp}\times N_{dp}
\]

若再加入 tensor axis，拓扑可扩成 `pipe × model × data`。

## 层如何分到 stages

`PipelineModule._partition_layers()` 支持按层数、参数量或显式方法分区。按层数均分不一定均衡：embedding、attention、MoE 和 output head 的参数/计算差异很大。

真正目标不是每 stage 参数数完全相等，而是稳态 step 中最慢 stage 时间尽量接近：

\[
T_{pipeline}\approx \max_s(T_s)+communication+bubble
\]

参数量可作为初始代理，之后应用 profile 调整。Activation shape 和 P2P 带宽也会让参数均衡的分区失衡。

## TrainSchedule：同步 1F1B

[`TrainSchedule`](schedule.py) 产生一系列 `PipeInstruction`：

- `LoadMicroBatch`；
- `ForwardPass` / `BackwardPass`；
- `SendActivation` / `RecvActivation`；
- `SendGrad` / `RecvGrad`；
- `ReduceTiedGrads` / `ReduceGrads`；
- `OptimizerStep`。

每个时钟步可包含不会互相依赖的一组指令。偶数/奇数 stage 使用不同 send/recv 顺序，避免双方都先发送或都先接收造成死锁。

概念上的 4-stage、4-micro-batch 时间线：

```text
time →   0   1   2   3   4   5   6 ...
stage 0  F0  F1  F2  F3  B0  B1  B2 ...
stage 1      F0  F1  B0  F2  B1  F3 ...
stage 2          F0  B0  F1  B1  F2 ...
stage 3              F0  B0  F1  B1 ...
```

真实 `TrainSchedule._step_to_micro_batch()` 生成同步 1F1B 交错顺序，并在最后追加 tied grad reduction、普通 grad reduction 和 optimizer step。

## Bubble 与 micro-batch 数

只有很少 micro-batches 时，warm-up/drain 占比高。粗略 bubble 比例随：

\[
\frac{N_{pp}-1}{N_{micro}+N_{pp}-1}
\]

下降。增加 micro-batches 能提高利用率，但会：

- 增加调度/P2P 次数；
- 改变每次 micro-batch shape；
- 增加某些 stage 保留的 activation buffer；
- 改变全局 batch 或需要减小 micro-batch size。

PipelineEngine 把 micro-batch 数与 gradient accumulation steps 联系起来。

## 为什么只需要有限 activation buffers

同步 1F1B 不必保存所有 micro-batch 的 activation。`TrainSchedule.num_pipe_buffers()` 根据当前 stage 到最后 stage 的距离和 micro-batch 数计算最大 in-flight forward 数，并循环复用 buffer id。

越靠前的 stage，forward 结果等待 backward 的时间越长，通常需要更多 buffer；最后 stage 很快得到 loss 并开始 backward，所需更少。

## `train_batch()` 接管什么

[`PipelineEngine.train_batch()`](engine.py) 会：

1. 选择或设置 data iterator；
2. 切换 module 为 train；
3. 创建 `TrainSchedule(micro_batches, stages, stage_id)`；
4. `_exec_schedule()` 逐步解释指令；
5. 聚合最后 stage 的 loss；
6. 写监控和 pipeline timers。

它每次会从每条 pipeline 的 iterator 取 `gradient_accumulation_steps` 个条目。数据不足会 `StopIteration`，上游提供 `RepeatingLoader` 作为循环包装。

普通 Engine 的 `forward/backward/step` 不能替代 schedule，因为各 rank 若自行推进，很容易让 P2P 次序不一致。

## `_exec_schedule()` 是解释器

Schedule 只描述命令；Engine 建立“指令类型 → bound method”映射，并按每个 step 的命令列表执行。这个分离有两个好处：

- 调度算法可以独立生成/测试；
- 具体 send/recv、buffer 和 optimizer 实现在 Engine 中复用。

新增 schedule 时，应证明每个 step 内指令可安全并行、跨 ranks 的 P2P 匹配、最后状态等价于同步训练。

## Activation checkpointing 的位置

`PipelineModule` 能按 layer interval 对本 stage 的 layer block 做 activation checkpoint：前向不保存全部中间激活，反向时重算。它降低 activation memory，但增加 compute，并影响 pipeline stage 时长。

Checkpoint interval 不应只按统一层数设定。若某 stage 更慢，额外重算会扩大 stage imbalance。

## 动态 shape 的代价

固定 shape 时，后续 P2P 可复用 buffer 和元数据。`dynamic_shape=True` 支持变化输入，但 Engine 需要交换/重建 shape 信息和 buffer，产生额外开销。序列长度课程学习/动态 batching 改变 shape 时还需正确 reset activation shape。

## 本章实验：打印一个 schedule

静态执行 schedule 不需要 GPU：

```python
from deepspeed.runtime.pipe.schedule import TrainSchedule

for stage in range(3):
    print("stage", stage)
    schedule = TrainSchedule(micro_batches=4, stages=3, stage_id=stage)
    for clock, commands in enumerate(schedule):
        print(clock, [type(command).__name__ for command in commands])
```

检查：

1. stage 0/1/2 的 send 与 recv 是否匹配；
2. 每个有效 micro-batch 是否各 forward/backward 一次；
3. reduction 和 optimizer step 是否只在末尾出现；
4. 每个 stage 需要多少 buffers。

源码导航：

```bash
rg -n '^class (PipelineModule|TrainSchedule|PipelineEngine|ProcessTopology)' \
  deepspeed/runtime/pipe
rg -n 'def train_batch|def _exec_schedule' deepspeed/runtime/pipe/engine.py
```

## 常见误区

- 将任意动态图模型直接当成层序列自动切分。
- 用普通 Engine 训练循环驱动 PipelineEngine。
- 只按参数量均衡，不测 stage compute/communication 时间。
- micro-batch 越多越好，忽略 P2P、buffer 和全局 batch。
- 认为 tied weight 在不同进程仍是同一个 Python 对象。
- 在当前实现中把 Pipeline 与 ZeRO-2/3 配在一起。

## 自测

1. LayerSpec 相比预先构造 nn.Module 的主要内存收益是什么？
2. 为什么偶数/奇数 stage 的 send/recv 顺序要错开？
3. PipelineEngine 为什么把 optimizer step 写进 schedule？
4. 参数量均衡的 partition 为什么仍可能有明显气泡？
