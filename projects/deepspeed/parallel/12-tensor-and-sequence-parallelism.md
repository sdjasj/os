# 12. Tensor Parallel 与 Sequence Parallel：切矩阵，还是切 token

Tensor Parallel（TP）把单层矩阵计算分到多个 rank，Sequence Parallel（SP）把序列维分片。二者都让单个 rank 只持有/计算一部分张量，但切分轴、collective 和适用瓶颈不同。本章用线性层和 Ulysses attention 建立形状模型，再对应 AutoTP 与 `sequence/layer.py`。

## Column Parallel Linear

线性层：

\[
Y=XW^T,\quad X\in\mathbb{R}^{B\times H_{in}},
W\in\mathbb{R}^{H_{out}\times H_{in}}
\]

把 (W) 按输出维切为 (p) 片：

\[
W=[W_0;W_1;\dots;W_{p-1}]
\]

每个 rank 拥有完整 (X) 和一个 (W_i)，计算 (Y_i=XW_i^T)。结果在输出维上分片：

```text
replicated X
  ├─ rank0 × W0 → Y0
  ├─ rank1 × W1 → Y1
  └─ ...
All-Gather（仅当下一个算子需要完整 Y）
```

很多 Transformer 结构可以让下一层直接消费分片输出，避免立即 gather。

## Row Parallel Linear

把 (W) 按输入维切分，同时 (X) 也按输入维分片：

\[
Y=\sum_i X_iW_i^T
\]

每个 rank 得到 partial output，需 All-Reduce 求和。Column/Row parallel 常成对使用：第一层扩展 hidden 并保持分片，第二层按输入分片并 reduce 回 replicated hidden。

## Attention 中切什么

多头 attention 很适合按 head 分片：每 rank 负责一部分 Q/K/V heads，本地完成 attention，再在 output projection 合并。约束包括：

- head 数通常要能被 TP size 合理分配；
- GQA/MQA 的 query heads 与 KV heads 比例需要专门切分；
- rotary embedding、ALiBi、attention mask 必须与本地 head/sequence shape 对齐；
- vocab projection 和 tied embeddings 有不同切分规则。

所以 AutoTP 不能只按“遇到 Linear 就切”。它需要识别模块语义和成对的输出边界。

## AutoTP 的三层工作

DeepSpeed 的 module injection/AutoTP 路径可以概括为：

1. **发现**：解析模型，识别可切的 Transformer block 和 linear pattern；
2. **替换**：将目标 module 替换为带 TP 通信的实现，切分权重/偏置；
3. **运行**：在 forward/backward 中按 row/column 规则触发 collective。

训练初始化会读取 `tensor_parallel.autotp_size`，公共 `tp_model_init()` 也能提前按 TP 初始化模型并记录 size、dtype、group，随后 `initialize()` 校验配置是否一致。

概念配置：

```json
{
  "tensor_parallel": {
    "autotp_size": 2
  }
}
```

具体模型是否支持、与 ZeRO/compile 的组合应以当前测试为准。

## Process group 决定 TP 语义

若 world size 8、TP=2、DP=4：

```text
TP groups: [0,1] [2,3] [4,5] [6,7]
DP groups: [0,2,4,6] [1,3,5,7]
```

TP group 内 ranks 共同表示一个模型副本；DP group 连接同一 TP shard 位置的四个副本。参数 gradient 需要在正确组上处理：TP collective 完成层内数学，DP collective 同步数据副本。

## Sequence Parallel 的动机

长序列训练中，activation 随 sequence length 快速增长。把输入 token 维 (S) 切到 (p) 个 rank：

```text
rank i input: [B, S/p, H]
```

FFN、LayerNorm 等逐 token 操作可直接本地执行。但 attention 的每个 query 通常需要看到全序列 K/V，必须重新组织数据。

## Ulysses 的 All-to-All 转置

DeepSpeed Ulysses 在 sequence-parallel group 中用 All-to-All 在“序列分片”和“head 分片”表示之间转换。设 Q/K/V 原布局为：

```text
[batch, local_sequence, heads, head_dim]
```

All-to-All 将不同 rank 的 sequence slices 按 head 交换，使每个 rank 得到：

```text
[batch, full_sequence, local_heads, head_dim]
```

本地执行 attention 后，再做逆向 All-to-All，把输出恢复为 local sequence：

```text
sequence shards
  → scatter heads / gather sequence (All-to-All)
  → local attention over full sequence, subset of heads
  → scatter sequence / gather heads (All-to-All)
  → sequence shards
```

[`single_all_to_all()`](layer.py) 会通过 permute/reshape 把 scatter axis 移到合适位置，创建输出，调用 `dist.all_to_all_single`，再恢复目标维度。

## 形状必须满足什么

基础路径常要求：

- sequence length 能按 SP size 切分，或显式处理不均匀 split；
- attention heads 能按 SP size 分配，或使用支持非均匀 heads 的路径；
- batch/head/sequence axis index 与 layout 一致；
- tensor contiguous 或在通信前转 contiguous；
- backward 使用与 forward 对偶的 All-to-All。

当前 `sequence/layer.py` 还包含对不均匀 head split 的处理，说明真实模型的 GQA/head 数不总能整除。读源码时不要把均匀示意图当成全部契约。

## TP 与 SP 的差别

| 维度 | TP | SP/Ulysses |
| --- | --- | --- |
| 主要切分 | 权重输出/输入/head | token sequence |
| 参数是否分片 | 是 | 通常不是由 SP 本身决定 |
| activation 收益 | 层内 hidden/head 分片 | sequence 维显著分片 |
| 典型通信 | All-Reduce/All-Gather | All-to-All |
| 适用瓶颈 | 单层参数/计算过大 | 长上下文 activation |

二者可以组合，但进程网格、head 数、sequence 长度和 collective 成本会更复杂。

## Communication volume 的直觉

SP attention 的 All-to-All 不做求和，主要重排几乎同等数量的 Q/K/V/输出元素。序列越长，消息越大；跨节点 SP 会直接受网络带宽影响。通常优先把通信密集的 TP/SP group 放在节点内高速互联，再用 DP 跨节点，但需结合硬件拓扑验证。

## AutoSP 与 compile

当前仓库包含 `sequence/auto_sp.py`、`autosp_*` 和 compile passes，用于自动化/专门模型的序列切分。学习顺序仍应先掌握手工 shape 转换，再读 pass 如何识别图和插入 collective；否则难以判断自动转换是否保持语义。

## 本章实验：手算 All-to-All 形状

设 `B=1, S=8, heads=4, head_dim=2, SP=2`：

1. 每 rank 初始 Q shape 是什么？
2. All-to-All 后 local heads 数和 full sequence 长度是什么？
3. 每 rank 发给对方多少元素？
4. 逆变换后怎样恢复原 local sequence shape？

答案：初始 `[1,4,4,2]`；转换后 `[1,8,2,2]`；每 rank 的 32 个元素按 head 分给两个目标，每目标 16；逆变换回 `[1,4,4,2]`。

源码导航：

```bash
rg -n 'def single_all_to_all|all_to_all_single' deepspeed/sequence/layer.py
rg -n 'class AutoTP|autotp_size|tp_model_init' deepspeed
rg -n 'tensor_parallel|sequence_parallel' tests/unit/model_parallelism tests/unit
```

## 常见误区

- 把 TP 只理解为参数切片，忽略 forward 中的 collective。
- 认为 SP 后 attention 只看 local sequence。
- 用全局 world size 代替 TP/SP group size。
- 假设 head 和 sequence 一定能均匀整除。
- 把 All-to-All 当作 All-Reduce；前者重排，后者求和。
- 未验证模型结构就认为 AutoTP 能安全切所有 Linear。

## 自测

1. Column Parallel 的输出为何天然分片，Row Parallel 为何需要求和？
2. Ulysses 为什么先把 sequence shard 转成 head shard？
3. TP=2、DP=4 时，为什么一个 rank 同时属于两类 group？
4. SP 主要降低哪类显存，为什么网络拓扑很重要？
