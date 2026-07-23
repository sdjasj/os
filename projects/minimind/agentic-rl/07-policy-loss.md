# 07. GRPO/CISPO 策略更新

## 1. 从轨迹 reward 到组内优势

每个原始样本生成 `G=num_generations` 条轨迹。扁平 reward `[B*G]` reshape：

```python
grouped_rewards = rewards.view(-1, G)       # [B,G]
mean_r = grouped_rewards.mean(1).repeat_interleave(G)
std_r = grouped_rewards.std(1, unbiased=False).repeat_interleave(G)
advantages = (rewards - mean_r) / (std_r + 1e-4)
```

$$A_i=\frac{R_i-\mu_g}{\sigma_g+10^{-4}}$$

每条轨迹只有一个 advantage，再 `unsqueeze(1)` 广播到该轨迹所有 action token。

## 2. 为什么不用 Critic

PPO 学一个 value model 估计 baseline。GRPO 用同一问题的其他回答作为 baseline，省掉 Critic。代价是每个 prompt 必须采样多条轨迹，且组内 reward 要有差异。

`num_generations=1` 时均值就是自身，std 为 0，advantage 恒为 0；训练只剩 KL 和 MoE aux，不会学习任务偏好。

## 3. 三种 token log-prob

```python
new = per_token_logps
old = old_per_token_logps
ref = ref_per_token_logps

ratio = exp(new - old)
delta = ref - new
per_token_kl = exp(delta) - delta - 1
```

`per_token_kl>=0`，在 `new==ref` 时为 0。Taylor 展开在小 delta 时约为 `delta^2/2`。

## 4. GRPO 策略项

```python
ratio_clipped = clamp(ratio, 1-epsilon, 1+epsilon)
gain1 = ratio * advantage
gain2 = ratio_clipped * advantage
per_token_loss = -(
    min(gain1, gain2) - beta * per_token_kl
)
```

正 advantage 鼓励提高该动作概率，负 advantage 鼓励降低。clip 限制 policy 相对 rollout old policy 单次改变过大。

## 5. CISPO 策略项

```python
weight = clamp(ratio, max=epsilon_high).detach()
per_token_loss = -(
    weight * advantage * new_logp
    - beta * per_token_kl
)
```

ratio 裁剪后 `.detach()`，只作为 importance 权重；梯度直接通过 `new_logp`。即使 ratio 超过上界并被截成常数，`new_logp` 仍保留梯度。

当前默认 `loss_type='cispo'`、`epsilon_high=5.0`。GRPO 使用对称 `[0.8,1.2]`，CISPO 这里只设上界，没有显式下界。

## 6. KL 正则

两个 loss 都减去 gain、加上 `beta*KL`：

$$\mathcal L_t=-\text{policy gain}+\beta KL_t$$

reference 是初始 full-SFT 模型。beta 越大，偏离 reference 的代价越高；但训练表现还与 reward 尺度、学习率、同步陈旧度和裁剪共同决定。

## 7. Token 到轨迹再到 batch 的平均

```python
trajectory_loss = (
    per_token_loss * completion_mask
).sum(1) / token_counts.clamp(min=1)

policy_loss = trajectory_loss[valid_rows].mean()
```

先对每条轨迹 action token 平均，再对有效轨迹平均。这避免长回答仅因 token 多而权重更大。

但一个轨迹的 advantage 同样作用于所有动作，因此每 token 平均也意味着长短轨迹在 batch 层权重接近相等。

## 8. 无有效 action 的行

```python
if valid_rows.any():
    policy_loss = ...
else:
    policy_loss = per_token_loss.sum() * 0.0
```

乘 0 保留计算图，让 backward/DDP 流程完整。它只能防止崩溃；如果频繁发生，应修 rollout/mask。

## 9. MoE 辅助损失

```python
aux_loss = res.aux_loss if lm_config.use_moe else 0
loss = (policy_loss + aux_loss) / accumulation_steps
```

MoE router 的负载均衡与策略 loss 一起反向。日志中的 `Loss` 取总 loss，但代码没有单独打印 aux；分析 MoE Agent 训练时应增加分项。

## 10. 梯度累积与 scheduler

```python
loss.backward()
if step % accumulation_steps == 0:
    clip_grad_norm_(model.parameters(), grad_clip)
    optimizer.step()
    scheduler.step()
    optimizer.zero_grad()
```

epoch 尾部不足一个 accumulation window 时也会补 step。scheduler 的 `T_max` 按 `ceil(iters/accumulation)*epochs` 计算，与 optimizer step 数近似对齐。

## 11. On-policy 新鲜度

Torch engine 持有同一个 model 对象，optimizer step 后 rollout 自动看到新权重。SGLang 只在 `update_policy` 时刷新远端。因此：

- Torch 路径 ratio 在单次 update 前通常接近 1；
- SGLang 若隔多 step 同步，ratio 可能偏离更大；
- CISPO/GRPO 的 importance correction 和 clip 用于控制这种差异，但不能无限补偿陈旧轨迹。

## 12. 组退化数值实验

```bash
conda activate deepspeed
python - <<'PY'
import torch
r = torch.tensor([1.,2.,3., 5.,5.,5.]).view(2,3)
a = (r-r.mean(1,keepdim=True)) / (
    r.std(1,unbiased=False,keepdim=True)+1e-4
)
print(a)
assert a[0].abs().sum() > 0
assert torch.equal(a[1], torch.zeros(3))
PY
```

## 13. CISPO 梯度实验

下面验证 ratio 被上界裁剪后，梯度仍通过 `new_logp`：

```bash
conda activate deepspeed
python - <<'PY'
import torch
new = torch.tensor([3.0], requires_grad=True)
old = torch.tensor([0.0])
adv = torch.tensor([1.0])
ratio = torch.exp(new-old)
weight = torch.clamp(ratio, max=5.0).detach()
loss = -(weight * adv * new)
loss.backward()
print('ratio=', ratio.item(), 'weight=', weight.item(),
      'grad=', new.grad.item())
assert new.grad.item() == -5.0
PY
```

## 14. 应增加的训练指标

当前日志已有 reward、KL、group std、advantage、loss、平均长度和 LR。建议再加：

- ratio mean/max/p95；
- GRPO clip fraction 或 CISPO upper-clip fraction；
- policy entropy；
- action token 数分布；
- 有效轨迹比例；
- reward 分项；
- parse/schema/execute/GT/final success rate；
- 每 turn 工具调用率；
- SGLang policy age。

## 15. 本章检查题

1. `G=1` 为什么无法做 group-relative 学习？
2. reward 不可导，为什么 `advantage * logp` 仍能训练 policy？
3. 先按 token 平均再按轨迹平均解决了什么长度偏差？
4. CISPO 的 ratio 为什么 detach？如果不 detach，梯度多出什么路径？
