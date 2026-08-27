# 01. GPT 数学与张量形状：把公式翻译成 tensor

阅读训练源码最有效的背景能力，是把数学对象翻译成张量形状、局部切片和 loss。Megatron Core 大量接口沿用 `[sequence,batch,hidden]`，数据集输出却通常是 `[batch,sequence]`；忽略这点，后续 TP、SP、CP 会迅速混淆。

## Next-token prediction

给定 `S+1` 个 token：

```text
x = [x0, x1, ..., xS]
tokens = [x0, ..., x(S-1)]
labels = [x1, ..., xS]
```

`GPTDataset.__getitem__` 的实现正是：

```python
if self.config.add_extra_token_to_sequence:
    tokens = text[:-1].contiguous()
    labels = text[1:].contiguous()
```

所以长度 `S` 的训练样本常要读取 `S+1` 个 token；多出的 token 是最后位置的监督目标。

## 贯穿源码的符号

| 符号 | 含义 |
| --- | --- |
| `B` | micro batch 样本数 |
| `S` | 序列长度 |
| `H` | hidden size |
| `A` | attention heads |
| `D=H/A` | 每 head 维度 |
| `F` | FFN hidden size |
| `V` | padding 后词表大小 |
| `P_t` | TP size |

```text
tokens                     [B, S]
embedding output           [S, B, H]
Q/K/V                      [S, B, A, D]
attention output           [S, B, H]
MLP intermediate           [S, B, F]
logits                     [S, B, V] 或本地 [S, B, V/P_t]
per-token loss             [B, S]
```

## Attention 的形状与复杂度

```text
Q = X Wq, K = X Wk, V = X Wv
scores = Q K^T / sqrt(D)
P = softmax(causal_mask(scores))
Y = P V
```

普通 dense attention 的逻辑 score 形状为 `[B,A,S,S]`。投影计算大体随 `S` 线性增长，score 计算随 `S²` 增长。Context Parallelism 针对长上下文，把序列分给多个 rank，并通过通信让局部 query 获得所需 K/V。

RoPE 对 Q/K 的二维子空间施加位置相关旋转，不改变 `[S,B,A,D]` 形状。源码把 rotary tensor 与 hidden state 分开传给 attention，体现了它在 attention 内生效。

## MLP 与 SwiGLU

普通 MLP：

```text
Z = activation(X W1 + b1)
Y = Z W2 + b2
```

若启用 GLU，第一层先产生两份中间值。项目先把 `ffn_hidden_size` 乘二，再做：

```python
x_glu, x_linear = torch.chunk(x, 2, dim=-1)
return activation(x_glu) * x_linear
```

因此观察 `linear_fc1` 局部宽度时，还要考虑 GLU 和 TP。

## Vocab-parallel cross entropy

对位置 `t`：

```text
L_t = -log softmax(logits_t)[label_t]
```

TP 切分词表后，每个 rank 只有 `V/P_t` 个 logits。不能各自做局部 softmax，因为归一化分母需要全局词表。分布式算法通常：

1. TP all-reduce 得到全局最大值；
2. 各 rank 计算本地指数和；
3. TP all-reduce 得到全局分母；
4. 目标 token 所属 rank 提取目标 logit并规约。

因此 `parallel_output=True` 时无需先收集完整 `[S,B,V]` 也能算 loss。

## Loss mask 不等于 attention mask

- `attention_mask`：控制一个 token 可以看哪些上下文；
- `loss_mask`：控制哪些位置计入训练目标。

`pretrain_gpt.loss_func` 核心是：

```python
losses = output_tensor.view(-1).float()
loss_mask = loss_mask.view(-1).float()
loss = torch.sum(losses * loss_mask)
num_tokens = loss_mask.sum()
```

这里返回局部 loss **总和**和有效 token 数；训练框架再按全局 token 语义缩放与汇总。它不是已经归一化的平均 loss。

## 参数与显存的近似

忽略 bias/norm，一个 dense layer 近似：

```text
attention projections: 4 H²
MLP:                   2 H F
SwiGLU MLP:            3 H F
```

这只是数量级检查。GQA、MLA、MoE、MTP、共享 embedding 都会改变精确结果。

训练显存还包括保存给 backward 的激活、临时 workspace、梯度和优化器状态。随着 `S` 增大，激活与 attention 状态可能比参数更难控制，所以项目提供 SP/CP、重计算、fused attention、offload 和 microbatching。

## 实验：形状账本

设：

```text
B=2, S=1024, H=4096, A=32, D=128, F=11008, TP=4
```

填写本地形状：

| 张量 | 全局形状 | 典型 TP 本地形状 |
| --- | --- | --- |
| Q heads | `[1024,2,32,128]` | `[1024,2,8,128]` |
| fc1 output | `[1024,2,11008]` | `[1024,2,2752]`（非 gated） |
| logits | `[1024,2,V]` | `[1024,2,V/4]` |

用注释核对：

```bash
rg -n "\[s, b, h\]|\[sequence, batch, hidden\]" \
  megatron/core/transformer megatron/core/tensor_parallel
```

## 自测

1. 为什么样本通常读取 `S+1` 个 token？
2. `loss_mask` 与 `attention_mask` 有何区别？
3. 为什么局部词表不能独立做普通 softmax？
4. RoPE 会改变 hidden size 吗？
5. SwiGLU 为什么让 fc1 先生成双倍宽度？

## 源码定位

- [GPTDataset](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/datasets/gpt_dataset.py)
- [GPTModel](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/models/gpt/gpt_model.py)
- [Attention](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/attention.py)
- [MLP](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/mlp.py)

下一章补齐 rank、process group、collective 和 autograd 通信语义。
