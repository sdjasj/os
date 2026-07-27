# 01. 背景知识：从轨迹回报到 GRPO 相对优势

verl 的训练入口叫 `main_ppo`，但它支持的不只是经典 PPO。要理解 GRPO 配置，先把环境、轨迹、
reward、advantage 与 policy loss 分开。

## 把语言模型看成策略

对 prompt 或多轮会话状态 \(s_t\)，语言模型给出下一个 token 的分布：

\[
\pi_\theta(a_t\mid s_t)
\]

一次 rollout 生成 token、调用工具、接收 observation，直到结束，构成轨迹 \(\tau\)。在本教程中，
CyberGym 最终验证给整条轨迹一个标量 \(R(\tau)\)。这叫 outcome reward：它评价最终产物，不要求
知道每个 token 的即时价值。

多轮工具轨迹中并非所有 token 都是策略动作。模型生成的 reasoning、tool call 与最终回答是动作；
bridge 返回的源码片段、编译输出和验证结果是环境 observation。verl 用 `response_mask` 区分二者：

```text
模型 token:       1 1 1 1       1 1 1
工具 observation:         0 0 0
padding:                          0 0
```

只有 mask 为 1 的 token 进入 policy loss。

## PPO 解决什么

直接最大化高 reward 轨迹的 log probability 容易让策略一步走太远。PPO 使用新旧策略概率比：

\[
r_t(\theta)=\frac{\pi_\theta(a_t\mid s_t)}{\pi_{\text{old}}(a_t\mid s_t)}
\]

并将它限制在 \([1-\epsilon,1+\epsilon]\) 附近。简化后的 clipped objective 是：

\[
L(\theta)=\mathbb{E}_t\left[
\min(r_t A_t,\operatorname{clip}(r_t,1-\epsilon,1+\epsilon)A_t)
\right]
\]

关键输入是优势 \(A_t\)：当前动作比 baseline 好多少。经典 PPO 常训练 critic 估计 value，再用 GAE
构造 advantage。大语言模型 critic 很贵，GRPO 用同题多样本的组内统计替代它。

## GRPO 怎样构造 advantage

对同一个 prompt 采样 \(G\) 条轨迹，得到 reward \(R_1,\ldots,R_G\)。标准 GRPO 计算：

\[
\mu=\frac{1}{G}\sum_i R_i,\qquad
\sigma=\operatorname{std}(R_1,\ldots,R_G)
\]

\[
A_i=\frac{R_i-\mu}{\sigma+\varepsilon}
\]

verl 的 `compute_grpo_outcome_advantage` 先对 `token_level_rewards` 沿 token 维求和得到每条轨迹的
score，再按 `uid` 分组计算均值与标准差，最后把标量优势广播到 `response_mask` 为 1 的位置。
对应源码的核心结构可以简化为：

```python
scores = token_level_rewards.sum(dim=-1)
for uid in groups:
    mean = scores_of(uid).mean()
    std = scores_of(uid).std()
for trajectory in batch:
    scalar = (score - mean) / (std + epsilon)
advantages = scalar.unsqueeze(-1) * response_mask
```

这解释了三个配置事实：

- `actor_rollout_ref.rollout.n` 必须大于 1 才有组内比较；
- 同一 task 的多条 rollout 必须共享同一个 `uid`；
- 四阶段 reward 必须先汇总成每条轨迹的 score，标准 GRPO 不会自动逐维比较。

## 一个四轨迹例子

假设四条轨迹的 staged reward 是 `[0.05, 0.20, 0.55, 1.00]`。忽略具体标准差值，组内关系是：

- 只产生合法 artifact 的轨迹低于平均，得到负优势；
- 通过前两个 stage 的轨迹可能仍低于平均；
- 通过测试但未通过 ground-truth PoC 的轨迹高于平均；
- 全通过的轨迹得到最大正优势。

GRPO 学的是相对排序。如果四条都得到 1.0，虽然绝对表现很好，但这一组 advantage 全为 0；如果
四条都得到 0，同样没有梯度信号。这叫 uniform-reward group，训练时必须监控比例。

## outcome reward 为什么放在末 token

`AgentLoopOutput.reward_score` 被后处理成与 response 同长的 `rm_scores`，只在最后一个有效位置写入
标量。随后 GRPO 对 token 维求和，仍得到同一个 trajectory score。这样做的意义是保持统一 tensor
接口，而不是声称最后一个 token 独自造成了全部结果。

之后 advantage 才会广播到所有模型生成 token。因此最终 reward 会强化或抑制整条生成路径；工具
observation 因 mask 为 0 不更新。

## KL 有两种放置方式

verl 配置中容易混淆：

1. `algorithm.use_kl_in_reward=True`：先从 token reward 中减去 KL penalty；
2. `actor_rollout_ref.actor.use_kl_loss=True`：把 KL 作为 actor loss 的正则项。

仓库的 GRPO 脚本默认使用第二种并关闭第一种。对昂贵、噪声较大的 CyberGym reward，教程沿用这个
选择，便于把日志中的环境 score 与策略 KL 分开解释。不要在没有消融的情况下同时大幅增加两种 KL。

## Dr. GRPO 与标准 GRPO

设置 `algorithm.norm_adv_by_std_in_grpo=False` 后，只减组均值，不除标准差。这会改变不同组的尺度。
仓库 README 还给出与 loss aggregation 配套的 Dr. GRPO 参数。首次接入 CyberGym 时先使用标准
GRPO，确认 reward 分布后再比较 Dr. GRPO；否则很难判断问题来自环境还是算法变体。

## staged reward 的设计原则

四个 stage 不是简单的四个独立 bit。CyberGym 的执行存在依赖：stage1 不通过，stage2 应跳过；
stage2 不通过，stage3 应跳过；stage3 不通过，stage4 应跳过。因此 reward 应遵守：

```text
artifact_valid
  -> stage1_passed
      -> stage2_passed
          -> stage3_passed
              -> stage4_passed
```

门控累加比无条件相加更抗投机。比如测试通过不能补偿 PoC 根本不触发；ground-truth PoC 通过也不能
补偿测试失败。

## 本章自测

1. `rollout.n=1` 时，标准 GRPO 能否得到有意义的同题 baseline？
2. 为什么 stage 指标应该作为 reward extra info 一起记录？
3. 为什么工具输出 token 的 `response_mask` 是 0？
4. staged reward 改善了稀疏性，为什么仍可能出现全组同分？

stage 指标用于诊断 reward 卡在哪一关，但标准 GRPO只消费汇总 score；工具输出不是策略采样动作；
如果当前策略的所有样本都停在相同关卡，分段 reward 也仍会产生 uniform group。

[上一章](./00-learning-roadmap.md) · [下一章：verl 架构](./02-verl-architecture.md)
