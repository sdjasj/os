# 06. Token 对齐与 Mask

## 1. 这是整个实现最关键的一章

文本轨迹最终必须变成统一张量。语言模型用位置 `t` 的 logits 预测 token `t+1`，所以：

```text
input_ids / source mask: 长度 L
per-token logp / completion mask: 长度 L-1
```

任何一位偏移都可能让工具 observation 的概率被训练，或让 action token 没有梯度。

## 2. 轨迹的四种 token 来源

| 来源 | 进入 input_ids | policy mask | old logp |
|---|---:|---:|---:|
| 初始 system/user/tool schema prompt | 是 | 0 | 占位 0 |
| 模型生成 tool call | 是 | 1 | 采样 logp |
| 模板边界与 tool observation | 是 | 0 | 0 |
| 模型最终回答 | 是 | 1 | 采样 logp |
| padding | 是 | 0 | 0 |

observation 必须进入 input_ids，因为后续动作以它为条件；但它不是 policy 采样动作，因此 mask 为 0。

## 3. 初始打包

`train_agent.py:255-258`：

```python
ids = prompt_ids + response_ids                 # L
mask = [0] * len(prompt_ids) + response_mask    # L
old_logps = (
    [0.0] * max(len(prompt_ids) - 1, 0)
    + response_old_logps
)                                                # L-1
```

为什么 prompt 占位是 `P-1` 而不是 `P`？`old_logps[j]` 对应 `input_ids[j+1]`。第一项 logp 预测第二个 prompt token，所以长度总共是 `L-1`。

## 4. 右移后的对应关系

当前 policy：

```python
logits = model(input_ids).logits[:, :-1, :]       # [B,L-1,V]
targets = input_ids[:, 1:]                        # [B,L-1]
per_token_logps = gather(log_softmax(logits), targets)
completion_mask = full_response_masks[:, 1:]      # [B,L-1]
```

位置表：

```text
input_ids index      0   1   2   ... L-1
target index             1   2   ... L-1
logp/mask index       0   1   2   ... L-2
```

`full_response_masks[:,1:]` 让目标 token 的来源决定是否训练。

## 5. 可变长 padding

先求 batch 最大轨迹长度：

```python
max_len = max(len(ids) for ids in samples)
input_ids = ids + [pad_id] * (max_len-len(ids))
full_response_masks = mask + [0] * padding
old_per_token_logps = old_lp + [0.0] * ((max_len-1)-len(old_lp))
full_mask = (input_ids != pad_id).long()
```

这里 pad token 同时也是 tokenizer 的 `<|endoftext|>`。用 id 比较生成 attention mask 的前提是有效文本中不应把同 id 当普通内容。

## 6. 左侧截断

超出 `max_total_len`：

```python
ids = ids[-max_total_len:]
mask = mask[-max_total_len:]
old_logps = old_logps[-(len(ids)-1):]
```

三者从尾部对齐截断，长度仍是 `L/L/L-1`。但语义风险是：

- system 工具定义可能被删；
- 原始用户问题可能被删；
- 剩下 observation 与回答失去前因；
- `prompt_len` 不再代表原始 prompt 长度，而是截断后第一个 action 的位置。

仅保证 shape 对齐不代表轨迹语义完整。更好的 token budget 应按消息/片段优先级截断。

## 7. `prompt_len` 的实际含义

```python
prompt_len = next(
    (i for i, value in enumerate(mask) if value == 1),
    len(mask),
)
```

它是“第一个 action token 的索引”，用于 debug 切片，不再一定等于初始 `prompt_ids` 长度，尤其在左截断后。训练 loss 本身主要依赖 completion_mask。

## 8. EOS 二次处理

打包后代码再次寻找 action mask 内的第一个 EOS：

```python
is_eos = (input_ids[:,1:] == eos_id) & completion_mask.bool()
completion_mask *= positions <= first_eos
```

但 `rollout_single` 已从模型 completion 中过滤 EOS，并把模板重建边界设成 observation mask 0，所以当前正常轨迹的 action mask 中通常没有 EOS。这个逻辑更多是防御性处理或为未来后端差异保留。

如果希望训练模型更好停止，应明确保留模型生成 EOS 的 old logp，并把它标为 action，而不是依赖模板重建的 EOS。

## 9. Reference log-prob

```python
ref_per_token_logps = compute_per_token_logps(
    ref_model, input_ids, input_ids.size(1)-1,
    attention_mask=full_mask,
)
```

reference 为全部 `L-1` 目标计算 logp，随后只有 completion mask 为 1 的位置进入 KL/policy loss。为 observation 算出的 ref logp 虽浪费计算，但不会参与最终平均。

## 10. 长度断言

建议在训练前加入：

```python
assert len(ids) == len(mask)
assert len(old_logps) == len(ids) - 1
assert input_ids.shape[1] == full_response_masks.shape[1]
assert old_per_token_logps.shape[1] == input_ids.shape[1] - 1
assert per_token_logps.shape == old_per_token_logps.shape
assert completion_mask.shape == per_token_logps.shape
```

并检查每行 `token_counts>0` 的比例。代码会跳过无 action 行的 policy average，但大量无效行说明 rollout 管线有问题。

## 11. 打印 token 来源

调试时不要只 decode 整段，逐 token 打印：

```python
for i, token_id in enumerate(input_ids[0].tolist()):
    source = 'prompt/obs'
    if full_response_masks[0, i].item() == 1:
        source = 'action'
    print(i, repr(tokenizer.decode([token_id])), source)
```

进一步把 `old_logps[i-1]` 与 token `i` 放在同一行，避免肉眼产生一位偏移。

## 12. 一个最小对齐手算

```text
ids:       [BOS, USER, A1, OBS, A2]
src mask:  [  0,    0,  1,   0,  1]

targets:        [USER, A1, OBS, A2]
loss mask:      [   0,  1,   0,  1]
old logp:       [ 0.0, lp1, 0.0, lp2]
```

模型对 A1 的概率来自 USER 位置 logits，对 A2 的概率来自 OBS 位置 logits。OBS 自身不被优化，但它改变 A2 的条件状态。

## 13. 截断实验

```bash
conda activate deepspeed
python - <<'PY'
p = [10,11,12]
r = [20,21,30,31,22]
m = [1,1,0,0,1]
lp = [-.1,-.2,0.,0.,-.3]
ids = p+r
mask = [0]*len(p)+m
old = [0.]*(len(p)-1)+lp
assert len(ids)==len(mask) and len(old)==len(ids)-1
limit=6
ids=ids[-limit:]; mask=mask[-limit:]; old=old[-(len(ids)-1):]
assert len(ids)==len(mask) and len(old)==len(ids)-1
print(ids, mask, old)
PY
```

## 14. 本章检查题

1. 为什么 prompt old-logp 占位只有 `P-1` 个？
2. observation mask 为 0 后，它还能否影响后续 action 的梯度？
3. 左截断保持 shape 正确，为什么仍可能让训练语义错误？
4. 当前 EOS 是否作为 action 参与 loss？如何修改才能参与？
