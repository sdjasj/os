# 06. Actor-Critic 与连续控制：让价值估计参与每一步更新

REINFORCE 已经能直接优化随机策略，但它要等一个回合结束后才能计算回报。CartPole 的回合只有几百步，这个等待还能接受；机器人行走、长文本生成和多轮工具任务的轨迹更长，一次失败还会同时影响许多早期动作。我们需要一个能在轨迹尚未结束时评价当前局面的估计器。

Actor-Critic 为策略网络配上价值网络。Actor 决定动作，Critic 估计状态价值。Critic 用一步转移构造学习目标，Actor 再用“实际结果比 Critic 预期好多少”调整动作概率，于是每一步交互后都可以更新。

本章以 [CartPole Actor-Critic](actor_critic_cartpole.py) 为主线，再用 [Pendulum](../chapter06_actor_critic/actor_critic_pendulum.py) 和 [BipedalWalker](../chapter06_actor_critic/actor_critic_bipedalwalker.py) 说明连续动作带来的变化。

## 从完整回报到一步预测误差

上一章使用从时刻 \(t\) 开始的完整回报：

\[
G_t=r_t+\gamma r_{t+1}+\gamma^2r_{t+2}+\cdots
\]

它使用真实的后续奖励，偏差较小；代价是必须等到后续奖励全部出现，而且同一状态可能因随机轨迹得到差异很大的 \(G_t\)。

有了价值估计 \(V_\phi(s)\)，一步之后尚未发生的回报可以由下一状态的价值代替：

\[
y_t=r_t+\gamma(1-d_t)V_\phi(s_{t+1})
\]

其中：

- \(r_t\) 是当前动作得到的即时奖励；
- \(\gamma\) 是折扣因子；
- \(d_t\) 表示任务在这一步真正终止；
- \(V_\phi(s_{t+1})\) 是 Critic 对后续回报的估计；
- \(y_t\) 是训练当前价值的 TD 目标。

当前估计与这个目标的差就是 TD 误差：

\[
\delta_t=y_t-V_\phi(s_t)
=r_t+\gamma(1-d_t)V_\phi(s_{t+1})-V_\phi(s_t)
\]

在一步 Actor-Critic 中，\(\delta_t\) 同时充当优势估计。正值表示这次动作后的结果优于当前预期，Actor 应提高该动作概率；负值表示结果低于预期，Actor 应降低该动作概率。

### 一个数值例子

设 \(r_t=1\)、\(\gamma=0.99\)、\(V(s_t)=4.2\)、\(V(s_{t+1})=5.0\)，任务尚未终止：

\[
y_t=1+0.99\times5.0=5.95
\]

\[
\delta_t=5.95-4.2=1.75
\]

这次转移比 Critic 原先预期好 1.75。若动作来自 \(\pi_\theta(a_t\mid s_t)\)，Actor 损失写成：

\[
L_{actor}=-\log\pi_\theta(a_t\mid s_t)\,\operatorname{stopgrad}(\delta_t)
\]

Critic 则最小化：

\[
L_{critic}=\left(V_\phi(s_t)-\operatorname{stopgrad}(y_t)\right)^2
\]

`stopgrad` 在 PyTorch 中通常由 `detach()` 表达。它让优势作为 Actor 的训练权重，而不让 Actor 损失反向修改产生该权重的 Critic 计算图。

## 读懂共享主干与两个输出头

`ActorCritic` 把 CartPole 的 4 维状态送入一个共享隐藏层，然后分成两个输出头：

```python
features = self.shared_backbone(x)

action_logits = self.actor_head(features)
probs = torch.softmax(action_logits, dim=-1)

value = self.critic_head(features).squeeze(-1)
return probs, value
```

对一个批次大小为 \(B\) 的输入，形状如下：

| 张量 | 形状 | 含义 |
| --- | --- | --- |
| `x` | `[B, 4]` | CartPole 状态 |
| `features` | `[B, 128]` | 共享状态表示 |
| `action_logits` | `[B, 2]` | 左推、右推的未归一化分数 |
| `probs` | `[B, 2]` | 动作概率 |
| `value` | `[B]` | 每个状态的价值估计 |

共享主干减少参数，也让两个任务互相提供表征信号。它同时引入耦合：Critic 的大梯度可能改变 Actor 正在使用的特征，Actor 的更新也会移动 Critic 的输入表示。更大的实现常用独立网络，或者为两个损失设置不同系数和优化器。

## 沿训练循环追踪一条转移

主循环每一步完成六件事。

### 1. 同时预测策略与价值

```python
state_tensor = torch.FloatTensor(state).unsqueeze(0)
probs, value = model(state_tensor)
probs = probs.squeeze(0)
value = value.squeeze()
```

`unsqueeze(0)` 添加批次维。即使当前只有一个状态，线性层仍按 `[batch, feature]` 处理输入。

### 2. 从策略分布采样

```python
dist = torch.distributions.Categorical(probs)
action = dist.sample()
log_prob = dist.log_prob(action)
```

训练阶段保留采样，因为策略需要探索。`log_prob` 仍连接 Actor 的计算图；后面乘上优势后，梯度会改变这次动作的概率。

### 3. 与环境交互

```python
next_state, reward, done, truncated, _ = env.step(action.item())
```

Gymnasium 把自然终止和时间上限分开返回。自然终止意味着未来任务价值确实为零；时间截断通常表示采样停止，底层任务可能仍有后续价值。源脚本把两者都作为 `is_done`，适合保持教学循环简洁，但会在时间上限处丢掉应当自举的价值。

### 4. 估计下一状态价值

```python
with torch.no_grad():
    _, next_value = model(next_state_tensor)
```

下一价值只用于构造目标，所以不需要保留计算图。`no_grad()` 同时减少显存和计算。

### 5. 构造两个损失

```python
advantage, target = compute_advantage(
    reward, value, next_value, gamma, done=is_done
)
actor_loss = -log_prob * advantage
critic_loss = nn.MSELoss()(value, target.detach())
```

这里值得做一次源码审计。`advantage` 包含 `-value`，源脚本没有在 Actor 损失中将它分离，因此 `actor_loss` 也会通过优势项向 Critic 头和共享主干传播梯度。教材中的常见写法是：

```python
actor_loss = -log_prob * advantage.detach()
critic_loss = F.mse_loss(value, target.detach())
```

这项修改不影响“正优势鼓励动作”的含义，却让 Actor 和 Critic 的优化职责更清楚。把它作为本章的第一个代码实验。

### 6. 每一步立即更新

```python
total_loss = actor_loss + critic_loss
optimizer.zero_grad()
total_loss.backward()
optimizer.step()
```

这就是与 REINFORCE 最直观的差别：训练数据从“完整回合”缩短为“一条转移”。代价是目标含有 Critic 自己的预测，产生了自举偏差。Actor-Critic 用更低的方差换取了一定偏差。

## 基线为什么不改变期望梯度

策略梯度可以减去只依赖状态的基线 \(b(s)\)：

\[
\mathbb{E}\left[\nabla_\theta\log\pi_\theta(a\mid s)b(s)\right]
=b(s)\sum_a\pi_\theta(a\mid s)\nabla_\theta\log\pi_\theta(a\mid s)
\]

利用 \(\pi\nabla\log\pi=\nabla\pi\)：

\[
b(s)\nabla_\theta\sum_a\pi_\theta(a\mid s)=b(s)\nabla_\theta 1=0
\]

因此以 \(V(s)\) 为基线不会在期望上改变梯度方向，却能减少不同轨迹带来的共同波动。[带基线的 REINFORCE](reinforce_with_baseline.py) 使用完整回报 \(G_t-V(s_t)\)，本章脚本进一步用一步 TD 目标替代完整回报。

## 从离散动作走到连续动作

CartPole 的两个动作可以用分类分布。Pendulum 的动作是区间内的连续力矩，无法为每个可能值输出一个概率。策略通常输出高斯分布参数：

\[
\mu_\theta(s),\quad \log\sigma_\theta(s),\quad
a\sim\mathcal{N}(\mu_\theta(s),\sigma_\theta(s)^2)
\]

训练仍使用 `log_prob(a)`，变化在于分布从 `Categorical` 变为 `Normal`。有界动作还要处理范围约束：直接 `clip` 会改变分布；更严谨的实现常先采样无界变量，再用 `tanh` 映射并修正对数概率。

仓库的连续控制脚本使用 Stable-Baselines3 的 A2C：

```bash
cd <project-root>/code
python -m pip install -r chapter06_actor_critic/requirements.txt
python chapter06_actor_critic/actor_critic_pendulum.py
```

先检查环境依赖。BipedalWalker 依赖 Box2D，而该章依赖文件只声明了 `classic-control`；如果环境创建失败，需要安装与你的平台匹配的 Gymnasium Box2D 额外依赖。不要把系统依赖错误归因于算法。

### 连续控制中新增的观测指标

| 指标 | 说明 | 异常信号 |
| --- | --- | --- |
| 动作均值 | 策略倾向的控制量 | 长期贴边可能发生饱和 |
| 动作标准差 | 探索强度 | 过早接近零会失去探索 |
| 价值损失 | Critic 的拟合误差 | 持续爆炸会污染优势 |
| 策略熵 | 动作分布不确定性 | 快速坍缩常伴随退化 |
| 回合长度 | 控制是否稳定 | 只看奖励可能掩盖行为变化 |

## 动手实验：验证分离优势的影响

复制脚本到临时位置，保持原文件不变，比较两种 Actor 损失：

```python
# A：仓库当前写法
actor_loss = -log_prob * advantage

# B：职责分离写法
actor_loss = -log_prob * advantage.detach()
```

每种配置至少运行 5 个随机种子，并记录：

- 最近 50 回合平均奖励；
- Critic 损失的中位数和 95% 分位数；
- 每回合平均梯度范数；
- 达到同一奖励阈值所需回合数。

单次曲线只能说明一次随机过程发生了什么。比较算法时要报告跨种子均值和离散程度。

## 动手实验：区分终止与截断

把环境时间上限调小，使 `truncated=True` 经常出现。分别使用两种掩码：

```python
# 简化写法：终止或截断都不自举
bootstrap_mask = 1.0 - float(terminated or truncated)

# 持续任务常用写法：只在真正终止时停止自举
bootstrap_mask = 1.0 - float(terminated)
```

比较两种价值目标的均值。第二种写法仍需保证截断后的 `next_state` 是有效的最终观测；向量化环境还可能在 `info` 中提供单独的 final observation。

## 实现边界

- 本章 CartPole 脚本是一步更新的教学实现，没有批量轨迹、优势归一化、熵奖励、学习率调度或独立评估环境。
- `compare_with_reinforce` 打印的是经验性参考范围，并没有在同一脚本、同一随机种子和同一预算下运行 REINFORCE，不能当作实验结论。
- 连续控制脚本调用成熟库，适合观察问题设定和指标；它没有展示高斯策略与 A2C 损失的内部实现。

## 本章小结

Actor-Critic 用 Critic 估计 \(V(s)\)，把一步 TD 误差作为优势，使 Actor 能在每一步得到方向明确的训练信号。这个方法缩短了信用传播距离并降低方差，同时引入自举偏差和两个学习器之间的耦合。连续动作不会改变策略梯度的核心形式，策略输出从离散概率变为参数化密度。

下一步仍有一个矛盾：一步 TD 的偏差较大，完整回报的方差较大；同一批 on-policy 数据若只更新一次，样本利用率也不高。GAE 在两种优势估计之间连续调节，PPO 再限制重复更新时的策略变化幅度。

## 自测

1. 为什么 \(\delta_t>0\) 时应提高已采样动作的概率？
2. Critic 的目标为什么需要 `detach()`？Actor 使用的优势为什么通常也要 `detach()`？
3. `terminated` 与 `truncated` 对价值自举分别意味着什么？
4. 共享主干会给 Actor 和 Critic 带来哪些收益与耦合？
5. 连续动作策略为什么需要输出一个分布，而不只输出动作均值？
