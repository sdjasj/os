# 07. PPO、GRPO 与 CISPO

## 1. 为什么在线 RL 比 DPO 复杂

DPO 直接读取静态 chosen/rejected。在线策略优化必须完成闭环：

```text
当前策略生成回答
  -> 奖励函数打分
  -> 估计回答相对好坏（advantage）
  -> 约束新策略不要离旧策略/参考策略太远
  -> 更新策略
  -> 再用新策略采样
```

代码中的三种模型角色：

- **policy/actor**：可训练，生成回答；
- **reference**：冻结，作为语言能力锚点并计算 KL；
- **reward model**：冻结，把 prompt+response 映射成分数；
- **critic**：只在 PPO 中存在，可训练，估计每个状态的价值。

## 2. Rollout Engine 的抽象

`trainer/rollout_engine.py` 统一接口：

```python
class RolloutEngine(ABC):
    def rollout(prompt_ids, attention_mask,
                num_generations, max_new_tokens,
                temperature): ...
    def update_policy(model): ...
```

`RolloutResult` 包含：

```text
output_ids       [B*G, P+R]
completion_ids   [B*G, R]
per_token_logps  [B*G, R]  采样时旧策略 log probability
completions      解码文本
prompt_lens      每条 prompt 长度
completion_mask  有效回答 token
```

这里 `G=num_generations`。

### Torch 引擎

本地 `model.generate` 后，调用 `compute_per_token_logps` 重新前向，取得每个 completion token 的 log probability。

### SGLang 引擎

通过 HTTP `/generate` 获取 token 和 logprob。`update_policy` 将当前模型保存到共享路径，再请求服务 `/update_weights_from_disk`。这是同步训推分离：每批采样/训练后在指定间隔同步，不是异步 replay buffer。

## 3. old policy 与 reference policy 不同

最容易混淆：

- `old_per_token_logps`：产生本批 rollout 时 policy 的 logp，用于 importance ratio；
- `per_token_logps`：当前正在更新的 policy 对同一 token 的 logp；
- `ref_per_token_logps`：固定 SFT reference 的 logp，用于 KL 正则。

概率比：

$$r_t=\frac{\pi_\theta(a_t|s_t)}{\pi_{old}(a_t|s_t)}
=\exp(\log\pi_\theta-\log\pi_{old})$$

KL 项则比较当前 policy 与 reference。old 会随 rollout 更新，reference 通常整个训练过程不变。

## 4. Reward 的组成

`train_grpo.py:37-68` 混合：

- Reward Model 分数；
- 回答长度规则；
- thinking 长度和标签闭合规则；
- n-gram 重复惩罚。

`LMForRewardModel.get_score` 把历史与回答送入外部模型，最后裁剪到 `[-3,3]`。奖励是训练目标的规格说明。若规格有漏洞，模型可能通过 reward hacking 提高分数而不提高真实质量。

## 5. PPO：Actor-Critic

`CriticModel` 复用 MiniMind backbone，新增：

```python
self.value_head = nn.Linear(hidden_size, 1)
values = self.value_head(hidden_states).squeeze(-1)  # [B,T]
```

当前实现中，`self.model(...)` 返回的 hidden states 已经过 backbone 最后的 RMSNorm，`CriticModel.forward` 又调用了一次 `self.model.norm(outputs[0])`。这是本项目代码的实际行为；阅读时不要误认为所有 Actor-Critic 都需要双重 norm，做结构实验时可以将其列为对照变量。

外部 reward 只加在回答最后一个有效 token 上，随后通过 GAE 计算 advantage：

$$\delta_t=r_t+\gamma V(s_{t+1})-V(s_t)$$

$$A_t=\delta_t+\gamma\lambda A_{t+1}$$

项目在 response token 上从后向前递推，并用 mask 排除无效位置。reference KL 不写入这里的 `token_rewards`，而是在后面的 actor policy loss 中作为单独惩罚项加入。

## 6. PPO 的裁剪目标

策略损失核心位于 `train_ppo.py:191-203`：

```python
ratio = exp(new_logp - old_logp)
policy_loss = mean(max(
    -advantage * ratio,
    -advantage * clamp(ratio, 1-eps, 1+eps)
)) + kl_coef * kl_ref_penalty
```

写成最大化形式：

$$\min(r_tA_t,\operatorname{clip}(r_t,1-\epsilon,1+\epsilon)A_t)$$

clip 限制单批数据被重复使用时 policy 偏移过大。

Critic 也使用裁剪 value loss，防止价值估计一步变化太大。Actor 和 Critic 分别有 optimizer/scheduler。

## 7. PPO 的多轮更新与 early stop

同一批 rollout 会做 `ppo_update_iters` 轮 mini-batch 更新。新策略逐渐偏离 old policy，因此代码监控 approximate KL：

```python
approx_kl = 0.5 * (log_ratio ** 2)
if approx_kl > early_stop_kl:
    stop_ppo = True
```

DDP 下先 `all_reduce` KL，让所有卡得出相同停止决定。为了保持 DDP forward/backward 通信闭环，停止时将 loss 乘 0，而不是某张卡直接 break 当前通信路径。

## 8. GRPO：用组内相对奖励替代 Critic

对每个 prompt 生成 `G` 个回答。奖励 reshape 为 `[B,G]`：

```python
grouped = rewards.view(-1, num_generations)
mean = grouped.mean(1).repeat_interleave(G)
std = grouped.std(1, unbiased=False).repeat_interleave(G)
advantages = (rewards - mean) / (std + 1e-4)
```

$$A_i=\frac{R_i-\mu_{group}}{\sigma_{group}+\epsilon}$$

同一问题内部高于平均的回答得到正优势，低于平均得到负优势。这样不需要 Critic，显存和优化复杂度更低。

### 退化组

若同一 prompt 的所有回答 reward 相同，则 `R_i-mean=0`，整组 advantage 为 0，只有 KL/aux 等信号。小模型面对过难任务时常出现“全部答错、同分”的退化，因此：

- 数据难度要在模型能力边界附近；
- reward 应尽量有连续区分度；
- 监控 group reward std；
- 增大 `G` 有时有帮助，但会线性增加 rollout 成本。

## 9. GRPO loss

`train_grpo.py:132-144`：

```python
kl_div = ref_logp - policy_logp
per_token_kl = exp(kl_div) - kl_div - 1
ratio = exp(policy_logp - old_logp)
clipped_ratio = clamp(ratio, 1-epsilon, 1+epsilon)
loss = -min(ratio*A, clipped_ratio*A) + beta*per_token_kl
```

再乘 completion mask，先对每条回答的有效 token 平均，再对 batch 平均。

项目使用的 `exp(delta)-delta-1` 是一种非负 KL estimator，`delta=0` 时为 0。

## 10. CISPO 的代码差异

`--loss_type cispo` 时：

```python
clamped_ratio = torch.clamp(ratio, max=epsilon_high).detach()
per_token_loss = -(
    clamped_ratio * advantage * per_token_logps
    - beta * per_token_kl
)
```

关键是 ratio 裁剪后 `.detach()`，只作为权重；梯度通过 `per_token_logps` 流动。与直接把 ratio clip 成常数相比，超出上界时仍保留 log-policy 梯度路径。

## 11. EOS 与 completion mask

生成张量可能 padding 到统一长度。代码先找每行第一个 EOS，再只保留 EOS 及之前的位置：

```python
is_eos = (completion_ids == eos_id) & pad_mask
eos_idx = first_eos_or_last
completion_mask = positions <= eos_idx
```

所有 token 级 loss、KL、平均长度都必须乘 mask。否则 padding logp 会污染梯度，长短回答的权重也会失真。

## 12. 训练时应该监控什么

| 指标 | 含义 | 风险信号 |
|---|---|---|
| reward mean | 平均目标分 | 上升但真实质量不升可能 reward hacking |
| group reward std | 同问题回答差异 | 长期接近 0 表示 GRPO 信号退化 |
| KL to reference | 偏离 SFT 基座 | 快速增大可能遗忘/崩坏 |
| approx KL to old | 单轮更新幅度 | PPO 超阈值需 early stop |
| clip fraction | 多少 token 被 clip | 过高说明更新过激 |
| response length | 回答长度 | 奖励可能诱导长度投机 |
| entropy（项目未直接打印） | 探索程度 | 过低可能模式坍缩 |

## 13. 运行前提与命令

PPO/GRPO 默认需要同级目录中的外部 Reward Model，且已经有 `out/full_sft_768.pth`：

```bash
(cd trainer && python train_ppo.py --reward_model_path ../../internlm2-1_8b-reward)
(cd trainer && python train_grpo.py --reward_model_path ../../internlm2-1_8b-reward)
```

在线 RL 成本很高。先开启 `--debug_mode` 并缩短生成长度，用极小数据观察 prompt、completion 与 reward 是否合理，再开始正式训练。

## 14. 常见失败模式

- **所有 reward 一样**：数据过难、RM 分辨率不足或规则奖励太粗。
- **reward 上升但回答变差**：奖励可被投机，检查长度、标签、重复等捷径。
- **KL 暴涨**：学习率/beta/clip/更新轮数不合适，或 rollout 权重未及时同步。
- **显存远超 SFT**：策略、参考、RM、PPO Critic 和 rollout 激活同时存在，这是预期差异。
- **SGLang logprob 对不齐**：检查 prompt 去 padding、completion 长度、服务返回字段和 tokenizer 是否完全相同。
- **DDP 卡死**：各 rank 控制流或 collective 次数不同，尤其检查 early stop 和只在主进程执行的代码。

## 15. 本章检查题

1. old policy 与 reference policy 为什么不能合并成一个概念？
2. GRPO 中 `num_generations=1` 会发生什么？
3. 为什么 reward 没有 `requires_grad`，策略仍能学到？
4. PPO 的 Critic 预测的是 token 级价值还是整段回答一个价值？项目如何把终局 reward 传到前面 token？
5. CISPO 中为什么要对裁剪后的 ratio 使用 `.detach()`？
