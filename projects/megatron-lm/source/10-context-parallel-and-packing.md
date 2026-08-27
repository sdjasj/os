# 10. Context Parallel 与 sequence packing：长上下文怎样分片

CP 与 packing 都减少长序列浪费，但作用层不同：packing 把多个变长序列紧密放入 token 流；CP 把上下文计算分到多个 rank。组合时，数据布局、文档边界、位置和 attention 通信必须一致。

## 普通 CP 的目标

完整输入 `[B,S]` 在 CP group 上切成局部序列，理想本地规模约 `[B,S/CP]`。但因果 attention 的计算不均匀：序列后部 query 看更多历史。简单连续切分会让后部 rank 更忙。

## Zigzag 平衡直觉

把序列首尾 chunk 配对：

```text
rank 0: early chunk + late chunk
rank 1: second-early + second-late
...
```

每个 rank 同时拿“便宜”和“昂贵”部分，改善因果 attention 工作量。`get_batch_on_this_cp_rank` 会根据 batch metadata 与模式选择具体策略。

## 四种分发分支

当前 utility 的路由是：

```text
contiguous requested
  -> contiguous CP
no cu_seqlens or per-sequence balancing
  -> per-sequence zigzag
cu_seqlens + hybrid CP
  -> dynamic local CP group + per-sequence balancing
otherwise
  -> per-document balancing
```

这说明数据 metadata 会影响 group 与切分算法，不只是 tensor slice。

## Packing 的边界表示

将长度 3、5、2 的序列打包：

```text
tokens:       [aaa][bbbbb][cc]
cu_seqlens:   [0, 3, 8, 10]
max_seqlen:   5
```

Varlen attention 用边界阻止跨序列 attention；position ids 可在每段重置。若 `cu_seqlens[-1]` 与 total tokens 不一致，kernel 会读错边界或报 shape error。

## `cu_seqlens_padded`

CP kernel 可能要求每段对齐到特定粒度。真实 `cu_seqlens` 描述有效 token，padded 版本描述执行布局。二者用途不同：

- attention 参数可能暂时使用 padded offsets；
- FLOPs 与有效 token 统计必须使用真实 offsets；
- loss mask 仍应排除 padding。

## Hybrid CP

变长 packed batch 中，不同 microbatch 的最长序列和有效 token 差异很大。固定 CP size 可能浪费通信。Hybrid CP 根据 batch 的 `local_cp_size` 选择子组，把短序列用更小 CP group，长序列用更大 group。

这意味着 batch 还携带运行时 process group 选择信息，`forward_step` 会把 `hybrid_cp_group` 放入 `PackedSeqParams` 交给 attention。

## TP broadcast 与 CP slice 的顺序

数据先在 TP group 内广播，使同一 TP replica 获得一致完整 batch；再按 CP rank 切 sequence。顺序反过来会让 TP 同伴拿到不同输入，破坏层内并行语义。

```text
dataloader on TP rank 0
  -> TP broadcast
  -> flatten packed batch
  -> CP partition
  -> model forward
```

## 诊断不变量

```text
sum(real sequence lengths) = valid tokens
cu_seqlens monotonic, first=0, last=total tokens
local CP shards可重组成原序列布局
position ids 与文档边界一致
loss mask 不计 padding
所有 CP ranks 使用兼容 group/collective 顺序
```

## 实验：打包并切分

对长度 `[3,5,2]`：

1. 写 `cu_seqlens` 与 max；
2. padding 到总长度 16 时写 loss mask 有效数；
3. CP=2 时设计一种首尾平衡切法；
4. 说明为什么不能让两个 CP rank 各自独立重置全局 position；
5. 比较真实与 padded offsets 应进入哪些统计。

```bash
rg -n "def get_batch_on_this_cp_rank" megatron/core/utils.py
rg -n "PackedSeqParams|cu_seqlens" pretrain_gpt.py
rg -n "hybrid_context_parallel" megatron/core/model_parallel_config.py
```

## 自测

1. Packing 与 CP 分别减少什么浪费？
2. 因果 attention 为什么需要 zigzag？
3. `cu_seqlens_padded` 为何不能用于有效 FLOPs？
4. Hybrid CP 为什么需要运行时 group？
5. 为什么 TP broadcast 先于 CP partition？

## 源码定位

- [CP batch dispatch](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/utils.py)
- [PackedSeqParams](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/packed_seq_params.py)
- [Context parallel 模块](https://github.com/NVIDIA/Megatron-LM/tree/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/context_parallel)
- [GPT forward step](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/pretrain_gpt.py)

下一章进入 DP、梯度 bucket 与分布式优化器。
