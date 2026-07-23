# 04. MoE 模型

## 1. Dense FFN 与 MoE 的区别

Dense 模型每个 token 都经过同一个 FFN。Mixture of Experts 把 FFN 换成多个专家，router 为每个 token 选择少量专家：

```text
token hidden state
  -> router scores over E experts
  -> select Top-K
  -> selected expert FFNs
  -> weighted sum
```

MiniMind 只替换 block 内的 `mlp`：

```python
self.mlp = FeedForward(config) if not config.use_moe \
    else MOEFeedForward(config)
```

Attention 和其余网络不变。

## 2. Router 与 Top-K

`MOEFeedForward.forward` 位于 `model/model_minimind.py:156-176`：

```python
x_flat = x.view(-1, hidden_dim)             # [B*T,D]
scores = softmax(gate(x_flat), dim=-1)      # [B*T,E]
topk_weight, topk_idx = topk(scores, k=K)   # [B*T,K]
```

默认 `E=4, K=1`。若 `norm_topk_prob=True`，选中权重重新归一化。`K=1` 时选中专家的权重因此变成 1。

## 3. Token 如何送入专家

项目用清晰但不是极致高性能的 Python 循环：

```python
y = torch.zeros_like(x_flat)
for i, expert in enumerate(self.experts):
    mask = (topk_idx == i)
    if mask.any():
        token_idx = mask.any(dim=-1).nonzero().flatten()
        weight = topk_weight[mask].view(-1, 1)
        y.index_add_(0, token_idx,
                     expert(x_flat[token_idx]) * weight)
```

`index_add_` 将不同专家结果累加回原 token 位置。`K>1` 时一个 token 会出现于多个专家分支，最终是加权和。

某张 DDP 卡上可能没有 token 路由给某专家。训练分支仍执行一个乘 0 的参数表达式：

```python
y[0, 0] += 0 * sum(p.sum() for p in expert.parameters())
```

它让该专家参数仍进入计算图，减少 DDP 对“未使用参数”的处理问题，但梯度为 0。

## 4. 总参数量与激活参数量

MoE 的特点是总容量大，但每 token 只激活少量专家。项目的 `get_model_params` 分别打印：

```text
Model Params: total M-A active M
```

总参数包含全部 `E` 个专家，激活参数近似只包含 `K` 个专家。注意：

- 权重显存通常仍要容纳全部专家；
- 单 token 计算量接近激活专家数，而不是总专家数；
- 当前单机朴素实现没有 expert parallel，不能直接等同工业级分布式 MoE。

## 5. 为什么需要负载均衡损失

只按主任务 loss 训练，router 可能把大多数 token 发给少数专家，形成 expert collapse。项目计算：

```python
load = one_hot(topk_idx, num_experts).float().mean(0)
aux_loss = (load * scores.mean(0)).sum() \
           * num_experts * router_aux_loss_coef
```

- `load`：实际 Top-K 选择频率；
- `scores.mean(0)`：router 给各专家的平均软概率；
- 二者点积乘专家数，在分配集中时倾向更大。

每层把 `aux_loss` 暂存在 `mlp.aux_loss`，模型最后求和。训练脚本使用：

```python
loss = res.loss + res.aux_loss
```

辅助损失不是语言建模质量本身，而是对路由行为的正则化。系数过大可能牺牲主任务，过小则可能失去均衡作用。

## 6. 一个手算例子

假设 4 个 token、2 个专家、Top-1：

```text
router softmax:
t0 [0.9, 0.1] -> expert 0
t1 [0.8, 0.2] -> expert 0
t2 [0.7, 0.3] -> expert 0
t3 [0.4, 0.6] -> expert 1

load       = [0.75, 0.25]
mean score = [0.70, 0.30]
dot        = 0.75*0.70 + 0.25*0.30 = 0.60
```

若完全均匀，两者约 `[0.5,0.5]`，点积为 `0.5`。乘专家数后，均匀基线约 1，集中分配更大。

## 7. 观察真实路由

下面的实验复用 router 权重，统计第一层的 Top-1 选择：

```bash
python - <<'PY'
import torch
from model.model_minimind import MiniMindConfig, MiniMindForCausalLM
cfg = MiniMindConfig(hidden_size=64, num_hidden_layers=2,
                     num_attention_heads=4, num_key_value_heads=2,
                     vocab_size=100, max_position_embeddings=64,
                     use_moe=True, num_experts=4,
                     num_experts_per_tok=1, flash_attn=False)
m = MiniMindForCausalLM(cfg).train()
x = torch.randint(0, 100, (8, 20))
out = m(x, labels=x)
moe = m.model.layers[0].mlp
with torch.no_grad():
    h = m.model.dropout(m.model.embed_tokens(x))
    scores = moe.gate(h.reshape(-1, cfg.hidden_size)).softmax(-1)
    count = scores.argmax(-1).bincount(minlength=cfg.num_experts)
print('routes:', count.tolist())
print('lm loss:', out.loss.item(), 'aux:', out.aux_loss.item())
PY
```

随机初始化不保证每次完全均匀。真正应监控的是训练过程中长期的专家负载、router entropy 和 aux/main loss 比例。

## 8. Dense 与 MoE 的选择

学习和低成本复现建议先用 Dense，因为：

- 前向路径更直接；
- 调试变量更少；
- 总参数与激活参数概念不会混淆；
- 朴素 MoE 路由循环未必在小硬件上更快。

掌握 Dense 后再打开 `--use_moe 1`，比较参数量、速度、峰值显存、主损失、aux loss 和专家负载。

## 9. 常见误解

- **MoE 总参数大，所以每 token 计算必然同比例变大**：错误，只激活 Top-K 专家；但路由和通信有额外开销。
- **负载均衡意味着每个 batch 每个专家严格相同 token 数**：错误，它是软约束。
- **aux loss 越低越好**：它必须和主任务质量共同观察。
- **开启 `use_moe` 就能加载 Dense 权重继续训练**：结构 key/shape 不同；`strict=False` 也不代表转换语义正确。

## 10. 本章检查题

1. 当 `K=1` 且归一化开启时，router softmax 的非最大概率还会不会影响主路径输出？会不会影响 aux loss？
2. 为什么无 token 命中的专家仍需出现在 DDP 计算图中？
3. 将专家数翻倍但保持 Top-1 时，总参数、激活计算和路由难度分别如何变化？
4. 为当前实现增加 router entropy 日志，应该在哪个类收集、在哪个训练脚本打印？
