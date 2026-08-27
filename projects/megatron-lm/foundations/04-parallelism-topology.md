# 04. 并行拓扑：DP、TP、PP、SP、CP、EP 如何组合

Megatron 的核心能力是组合多种分片方式。学习时不能只记缩写，而要问每种方式切参数、激活、token 还是层，复制了什么，又何时通信。

## 六种主要方式

| 方式 | 切分对象 | 典型通信 | 收益 | 代价 |
| --- | --- | --- | --- | --- |
| DP | batch | 梯度 AR/RS | 吞吐扩展 | 参数/激活副本 |
| TP | 层内矩阵、head、词表 | AR/AG/RS | 单层分片 | 高频层内通信 |
| PP | Transformer layers | stage 间 send/recv | 深度分片 | bubble、调度复杂 |
| SP | 非 TP 区域的 sequence 激活 | TP group AG/RS | 降激活冗余 | 依赖 TP |
| CP | 长上下文 token | attention P2P/A2A | 长序列分片 | 通信与平衡 |
| EP | MoE experts/token | A2A/AG | 专家参数分片 | 路由不均 |

SP 通常与 TP 共享 group，不是额外 world 维度；EP 也与 expert-TP/expert-DP 形成专门关系，不能盲目把所有 size 相乘。

## 两个基础方程

常规 dense 模型：

```text
WORLD_SIZE = TP * PP * CP * DP
global_batch = micro_batch * DP * num_microbatches
```

例：

```text
WORLD_SIZE=64, TP=4, PP=4, CP=2
DP=2
micro=2, num_microbatches=8 -> global_batch=32
```

TP/PP/CP 不产生新样本副本，所以不进入 global batch 乘法。动态 batch/packing 时需读取实时 microbatch calculator。

## TP：列并行与行并行

列并行按输出维切权重：

```text
A = [A0, A1, ..., Ap]
Yi = X Ai
```

若下一层直接消费 shard，就不立即 gather。

行并行按输入维切权重，输入也已分片：

```text
X = [X0, ..., Xp]
Y = sum_i Xi Ai
```

因此前向末尾需要 TP reduction。MLP 的 fc1/fc2 是经典列并行—行并行配对。

## PP：microbatch 时间线

四个 stage 的单个 microbatch 依次经过 0→1→2→3。多个 microbatch 交错后形成：

```text
warmup -> steady 1F1B -> cooldown
```

VPP 再把物理 stage 分成 model chunks，可减少 bubble，但会让 schedule、iterator 和参数同步更复杂。

## SP 与 CP 都切 sequence，但层级不同

- SP 配合 TP，分片 LayerNorm/dropout/residual 等原本重复的序列激活；
- CP 面向长上下文，分发 attention 输入，并在 attention 中交换 K/V 或部分结果。

CP 还要处理因果 attention 的负载不均。项目提供 per-sequence zigzag、per-document balancing、hybrid CP 等布局，因此不能把 CP 理解成简单 `torch.chunk`。

## EP：token 去找专家

```text
hidden states -> route -> dispatch -> expert GEMM -> combine
```

专家分布在 EP ranks，token 数却随路由动态变化。负载均衡 loss、dispatcher 类型、capacity 和 shared expert 都会影响吞吐。

## 所有权检查表

| 对象 | 复制/分片 | 恢复完整值的通信 |
| --- | --- | --- |
| token batch | TP 内广播；DP 间不同；CP 可切 S | broadcast / CP layout |
| dense weight | DP 常复制；TP/PP/FSDP 可切 | gather/reshard |
| expert weight | EP/expert TP 分片 | expert group |
| activation | TP/SP/PP/CP 依配置切分 | gather/reduce/P2P |
| optimizer state | DistOpt/FSDP 可切 | parameter all-gather |

## 实用选择顺序

1. 单层放不下时先考虑 TP；
2. 再按总层数和节点拓扑配置 PP；
3. 长上下文不足时考虑 CP/SP/recompute；
4. 用剩余 world size 形成 DP；
5. MoE 结合专家数与网络选择 EP/expert TP；
6. 以 profiler 验证，而非凭公式宣布最优。

## 实验：验算 128 GPU

```text
WORLD_SIZE=128
TP=4, PP=8, CP=2
micro_batch_size=1
global_batch_size=64
```

计算：

```text
DP = 128/(4*8*2) = 2
num_microbatches = 64/(1*2) = 32
```

再回答：heads=32 时每 TP rank 有几个 query heads？layers=80 且均匀 PP 时每 stage 几层？VPP/MTP/非均匀 layout 会破坏哪些假设？

## 自测

1. TP/PP/CP 为什么不进入 global batch 乘法？
2. ColumnParallelLinear 为何可避免立即 gather？
3. SP 与 CP 的目标差异是什么？
4. PP 为什么需要多个 microbatch？
5. EP 负载为何比 dense TP 动态？

## 源码定位

- [并行指南](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/docs/user-guide/parallelism-guide.md)
- [ModelParallelConfig](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/model_parallel_config.py)
- [TP layers](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/tensor_parallel/layers.py)
- [PP schedules](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/pipeline_parallel/schedules.py)
- [MoE layer](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/moe/moe_layer.py)

背景轨道结束。下一条轨道从真实启动命令进入源码。
