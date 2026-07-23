# 03. Dense Transformer 模型

## 1. 总体结构

MiniMind 是 decoder-only、pre-norm Transformer：

```text
input_ids [B,T]
  -> Embedding [B,T,D]
  -> N x Transformer Block
       RMSNorm -> Causal Self-Attention -> Residual
       RMSNorm -> SwiGLU MLP            -> Residual
  -> RMSNorm
  -> LM Head [B,T,V]
```

入口类是 `MiniMindConfig`（`model/model_minimind.py:10`）、`MiniMindModel`（`:196`）和 `MiniMindForCausalLM`（`:234`）。默认关键值：`D=768`、层数 `N=8`、`H=8`、`H_kv=4`、`V=6400`。

## 2. Config 是结构契约

`MiniMindConfig` 不只是参数字典。它决定每个权重的形状，因此加载 `.pth` 时必须一致。

```python
self.head_dim = hidden_size // num_attention_heads
self.intermediate_size = math.ceil(hidden_size * math.pi / 64) * 64
self.tie_word_embeddings = True
```

默认 `intermediate_size` 将 `D*pi` 向上取到 64 的倍数。对于 `D=768`，得到 2432。若训练权重是 `hidden_size=768, num_hidden_layers=8, use_moe=False`，推理时用 512 维或 MoE 配置加载会产生 shape/key mismatch。

## 3. Embedding 与权重绑定

```python
self.embed_tokens = nn.Embedding(vocab_size, hidden_size)
self.lm_head = nn.Linear(hidden_size, vocab_size, bias=False)
if config.tie_word_embeddings:
    self.model.embed_tokens.weight = self.lm_head.weight
```

Embedding 按 token id 查 `[V,D]` 矩阵的一行。LM Head 把 `[D]` 隐状态与同一矩阵各行做点积，得到词表 logits。权重绑定减少约 `V*D` 参数，并让输入输出 token 表示共享几何空间。

## 4. RMSNorm

实现位于 `model_minimind.py:50-60`：

$$\operatorname{RMSNorm}(x)=w\odot\frac{x}{\sqrt{\operatorname{mean}(x^2)+\epsilon}}$$

与 LayerNorm 相比，它不减均值，也没有 bias。项目先将输入转 FP32 计算，再转回原 dtype，提高混合精度稳定性。

## 5. Self-Attention 的形状

输入 `x: [B,T,D]`。投影后：

```text
Q: [B,T,H,d]    = [B,T,8,96]
K: [B,T,H_kv,d] = [B,T,4,96]
V: [B,T,H_kv,d] = [B,T,4,96]
```

`q_norm`、`k_norm` 在每个 head 的 `d` 维做 RMSNorm。之后 RoPE 作用在 Q/K，不作用于 V。转置后是 `[B,H,T,d]`。

分数与输出：

$$S=\frac{QK^T}{\sqrt d},\qquad O=\operatorname{softmax}(S)V$$

其中 `S` 为 `[B,H,T,T]`。再合并所有 head，经 `o_proj` 返回 `[B,T,D]`。

## 6. GQA：为什么 Q head 多于 KV head

Grouped Query Attention 让多个 query head 共享一个 K/V head。默认 `H/H_kv=2`：

```python
self.n_rep = self.n_local_heads // self.n_local_kv_heads
xk = repeat_kv(xk, self.n_rep)
xv = repeat_kv(xv, self.n_rep)
```

训练的 `k_proj/v_proj` 输出更小，推理时 KV Cache 也更小。`repeat_kv` 用 expand+reshape 形成 attention 需要的 head 数。

粗略地，单层单样本缓存元素数为：

$$2\times T\times H_{kv}\times d$$

其中 2 代表 K 和 V。把 `H_kv` 从 8 降至 4，KV Cache 近似减半。

## 7. 因果 mask 与 padding mask

手写 attention 分支：

```python
scores = (xq @ xk.transpose(-2, -1)) / math.sqrt(head_dim)
scores[:, :, :, -seq_len:] += torch.full(
    (seq_len, seq_len), float('-inf'), device=scores.device
).triu(1)
scores += (1.0 - attention_mask[:, None, None, :]) * -1e9
```

因果上三角禁止位置 `t` 读取 `t+1` 之后的信息。padding mask 禁止读取补齐 token。Flash Attention 条件满足时调用 `F.scaled_dot_product_attention`；否则使用显式路径。

## 8. RoPE：把位置旋转进 Q/K

RoPE 为每一对维度使用不同频率。项目预计算 `cos/sin` buffer：

```python
freqs = 1.0 / rope_base ** (arange(0, dim, 2) / dim)
phase = outer(position, freqs)
```

应用：

```python
q_embed = q * cos + rotate_half(q) * sin
k_embed = k * cos + rotate_half(k) * sin
```

旋转后 Q/K 点积包含相对位置信息。buffer 以 `persistent=False` 注册，不写入 state dict，加载时可由 config 重建。

### YaRN 外推

`inference_rope_scaling=True` 时启用 YaRN，对一部分频率插值。它缓解超出训练长度时的位置编码问题，但不能凭空赋予模型理解超长文档的能力。长上下文还受训练数据、注意力模式和检索能力影响。

## 9. SwiGLU MLP

Dense FFN：

```python
return down_proj(silu(gate_proj(x)) * up_proj(x))
```

$$\operatorname{FFN}(x)=W_d(\operatorname{SiLU}(W_gx)\odot W_ux)$$

`gate_proj` 决定信息通过比例，`up_proj` 提供内容，逐元素相乘后 `down_proj` 回到 `D`。

## 10. Pre-Norm 与残差

`MiniMindBlock.forward`：

```python
residual = hidden_states
attn_out, cache = self.self_attn(
    self.input_layernorm(hidden_states), ...
)
hidden_states = attn_out + residual
hidden_states = hidden_states + self.mlp(
    self.post_attention_layernorm(hidden_states)
)
```

Pre-Norm 是先归一化再进入子层。残差提供恒等路径，使深层网络更容易传播梯度。

## 11. KV Cache

首次推理把所有 prompt token 的 K/V 存起来。之后每一步只输入最新 token：

```python
past_len = past_key_values[0][0].shape[1]
outputs = self.forward(input_ids[:, past_len:],
                       past_key_values=past_key_values,
                       use_cache=True)
```

Attention 将旧 K/V 与新 K/V 拼接：

```python
xk = torch.cat([past_key_value[0], xk], dim=1)
xv = torch.cat([past_key_value[1], xv], dim=1)
```

没有 cache 时，第 `n` 个生成步骤会重复计算整个前缀；有 cache 时只计算新 token 的投影。注意力仍需让新 Q 读取全部历史 K/V，所以每一步的 attention 成本仍随上下文长度增长。

## 12. 从 hidden state 到 loss

`MiniMindModel` 返回：

```text
hidden_states [B,T,D]
presents      每层一个 (K,V)
aux_loss      Dense 为 0，MoE 为路由辅助损失之和
```

`MiniMindForCausalLM` 用 LM Head 得到 `[B,T,V]`，需要 labels 时内部做位移交叉熵，并封装成 Transformers 的 `MoeCausalLMOutputWithPast`。

## 13. 参数量粗算

忽略 norm，每个 Dense block 约：

```text
Attention:
  Q = D*(H*d)
  K = D*(H_kv*d)
  V = D*(H_kv*d)
  O = (H*d)*D
MLP:
  gate + up + down = 3*D*I
```

完整模型再加绑定后的 `V*D` embedding/head。用代码核对：

```bash
python - <<'PY'
from model.model_minimind import MiniMindConfig, MiniMindForCausalLM
for moe in (False, True):
    m = MiniMindForCausalLM(MiniMindConfig(use_moe=moe))
    print('moe=', moe, 'params=', sum(p.numel() for p in m.parameters()))
PY
```

## 14. Hook 观察真实形状

```bash
python - <<'PY'
import torch
from model.model_minimind import MiniMindConfig, MiniMindForCausalLM
cfg = MiniMindConfig(hidden_size=64, num_hidden_layers=1,
                     num_attention_heads=4, num_key_value_heads=2,
                     vocab_size=100, max_position_embeddings=32,
                     flash_attn=False)
m = MiniMindForCausalLM(cfg)
for name in ['q_proj', 'k_proj', 'v_proj', 'o_proj']:
    layer = getattr(m.model.layers[0].self_attn, name)
    layer.register_forward_hook(
        lambda mod, ins, out, n=name:
            print(n, tuple(ins[0].shape), '->', tuple(out.shape))
    )
x = torch.randint(0, 100, (2, 6))
out = m(x, use_cache=True)
print('logits', tuple(out.logits.shape))
print('K cache', tuple(out.past_key_values[0][0].shape))
PY
```

## 15. 本章检查题

1. 为什么 RoPE 应用到 Q/K 而不是 V？
2. 默认 GQA 下，一个 K head 被多少个 Q head 共享？
3. 为什么 `attention_mask` 和 `labels == -100` 不能互相替代？
4. 权重绑定后，修改 `lm_head.weight` 会不会同时修改 Embedding？写一行 `data_ptr()` 实验验证。
5. `use_cache=False` 时生成结果语义应与 cache 模式接近，但速度和显存为什么不同？
