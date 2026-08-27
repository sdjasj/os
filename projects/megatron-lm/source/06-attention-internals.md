# 06. Attention 内部：QKV、RoPE、mask 与并行布局

`SelfAttention` 不是一个单 kernel。它连接 QKV projection、可选 Q/K norm、RoPE、KV cache、core attention、输出 projection，以及 TP/CP/packed-sequence 语义。学习时先锁定训练 happy path，再逐步加入推理分支。

## 训练主路径

```text
hidden_states [S,B,H]
  -> linear_qkv / q + kv projections
  -> reshape Q,K,V [S,B,heads,D] (本地 heads)
  -> optional Q/K norm
  -> rotary position embedding
  -> core attention(mask, packed params, CP group)
  -> context [S,B,local hidden]
  -> linear_proj (RowParallel)
  -> output [S,B,H] + optional bias
```

QKV 投影常为 ColumnParallel，输出投影为 RowParallel，构成 TP 配对。

## MHA、GQA 与本地 head

标准 MHA 中 query heads 与 KV heads 数量相同。GQA 让多个 query heads 共享较少 KV groups，减少 KV 参数与 cache：

```text
num_query_heads = A
num_query_groups = G, G <= A
queries per group = A/G
```

TP 要求 heads/groups 能按配置合理切分。shape error 常源于 `num_attention_heads % TP` 或 query group 分布不满足约束。

## RoPE 应用位置

`GPTModel._preprocess` 生成 rotary tensor，SelfAttention 把它应用于 Q/K。Packed sequence 时还要依据 THD layout 与 `cu_seqlens` 解释位置；CP 时 rotary 生成与局部序列布局也必须一致。

位置编码不是简单在 embedding 上加一项，因此调试长序列错误要检查 Q/K 旋转长度、offset 和 cache，而不只看 input ids。

## Mask 的多层语义

Attention 可同时受到：

- causal mask；
- padding/document boundary mask；
- sliding window；
- packed `cu_seqlens`；
- inference cache 的 sequence offset。

在 fused attention 中，显式 `[B,1,S,S]` mask 可能不存在，而由 mask type 与 metadata 告诉 kernel。不能以“batch dict 里 mask 是 None”推断模型没有 causal mask。

## Core attention 与外壳分离

SelfAttention 负责 projection 与布局，`core_attention` 插槽负责 score/softmax/value 聚合。Spec 可把它替换为 TE DotProductAttention、local 实现或其他 backend，而外层仍保持 QKV 和输出契约。

这种分离也允许 CP attention 在 core 计算附近插入 K/V 交换，而不重写整个 TransformerLayer。

## Packed sequence 的 THD

普通 layout 常用 `[S,B,H]`；packed varlen kernel 可把 token 压成 THD，其中 T 表示总 token 流，`cu_seqlens` 给出每段边界。这样不同文档不会互相 attention，也避免为最大长度填充整个 batch。

关键不变量：

```text
cu_seqlens[0] = 0
cu_seqlens[-1] = total_tokens
相邻差值 = 每个 packed sequence 的真实长度
```

## 推理分支先识别、后深入

`inference_context` 会引入 KV cache、decode offset、static/dynamic batching、Flash decode 与 CUDA graph。它们都复用同一 Attention 外壳，但 tensor 生命周期与训练不同。初次学习可把 `InferenceMode.is_active()` 分支折叠，只跟踪 training path。

## 数值与性能观察点

- softmax 前减全局/局部 max 保持稳定；
- QK score 规模受 `1/sqrt(D)`、QK norm/clip 影响；
- attention dropout 需要并行一致 RNG；
- fused attention 可避免显式保存完整 `[B,A,S,S]`；
- CP 通信是否被 attention 计算隐藏决定长上下文扩展效率。

## 实验：用 shape 走一遍

设 `S=2048,B=2,H=4096,A=32,G=8,TP=4`：

1. 每 TP rank 有 8 个 query heads；
2. 若 groups 均匀分片，每 rank 有 2 个 KV groups；
3. head dim 为 128；
4. 写出本地 Q/K/V 的逻辑形状；
5. 指出哪个 projection 后需要 TP reduction。

```bash
rg -n "class SelfAttention|def forward" \
  megatron/core/transformer/attention.py
rg -n "core_attention|linear_qkv|linear_proj" \
  megatron/core/models/gpt/gpt_layer_specs.py
```

## 自测

1. SelfAttention 外壳与 core attention 如何分工？
2. GQA 为什么减少 KV 参数/cache？
3. mask tensor 为 None 为什么不等于没有 causal mask？
4. THD 的 `cu_seqlens` 保证什么？
5. 输出投影为什么适合 RowParallel？

## 源码定位

- [attention.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/attention.py)
- [GPT layer specs](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/models/gpt/gpt_layer_specs.py)
- [RoPE embedding](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/models/common/embeddings/rotary_pos_embedding.py)

下一章对比 dense MLP 与 MoE 的 route-dispatch-compute-combine 路径。
