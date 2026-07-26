# 05. REINFORCE：从动作概率到蒙特卡洛策略梯度

DQN 先估计每个动作的长期价值，再取最大值选择动作。策略梯度换了一个训练对象：网络直接给出动作概率，采样动作与环境交互，再根据整条轨迹的回报调整这些概率。这个转变使随机策略成为模型本身的一部分，也把训练噪声从 TD 目标带到了整回合梯度估计中。

本章围绕 [`reinforce_cartpole.py`](./reinforce_cartpole.py) 展开，从轨迹概率推导 REINFORCE，再逐行对应 `Categorical`、反向累计回报、`gather` 和负对数概率损失。最后阅读 [`reinforce_with_baseline.py`](./reinforce_with_baseline.py) 中的价值基线，但把时序差分 Actor-Critic 留到下一章。

## 学习目标与运行方式

完成本章后，你应当能够：

- 区分价值网络输出与策略网络输出；
- 从期望回报推导对数导数形式的策略梯度；
- 解释为什么每一步使用从该步开始的 \(G_t\)；
- 写出 `[T,4] → [T,2] → [T]` 的张量流；
- 用具体数字解释损失负号怎样改变动作概率；
- 说明 REINFORCE 的在策略、蒙特卡洛与高方差性质；
- 解释状态基线为何能降低方差，以及它和下一章方法的边界。

先进入上游仓库的 `code/` 目录：

```bash
cd <project-root>/code
python -m pip install -r chapter05_policy_gradient/requirements.txt
python chapter05_policy_gradient/reinforce_cartpole.py
```

默认训练 500 回合，保存 `output/reinforce_cartpole_rewards.png`。无图形界面时可执行：

```bash
MPLBACKEND=Agg python chapter05_policy_gradient/reinforce_cartpole.py
```

## 策略网络直接回答“怎样行动”

### 从 Q 值到概率分布

CartPole 状态仍是 4 维向量，动作仍是 2 个。DQN 网络输出两个没有概率约束的 Q 值；`PolicyNetwork` 输出满足和为 1 的概率：

\[
\pi_\theta(a\mid s)=P(A_t=a\mid S_t=s).
\]

\(\theta\) 是策略网络参数，\(s\) 是状态，\(a\) 是动作。真实结构为 `4 → 128 → 128 → 2`：

```python
logits = self.network(x)
probs = torch.softmax(logits, dim=-1)
return probs
```

最后一层的两个 `logits` 可以取任意实数。Softmax 把它们变为正数概率：

\[
\pi_\theta(a=i\mid s)=\frac{e^{z_i}}{\sum_j e^{z_j}}.
\]

\(z_i\) 是动作 \(i\) 的 logit，分母遍历两个动作。若 logits 为 `[1.0,2.0]`，概率约为 `[0.269,0.731]`。增大一个动作的 logit 会提高它的概率，同时通过归一化降低另一动作的概率。

### 采样保留了探索

收集轨迹时，代码没有取 `argmax`：

```python
probs = policy(state_tensor)
dist = torch.distributions.Categorical(probs)
action = dist.sample().item()
```

若输出 `[0.2,0.8]`，动作 0 仍有 20% 概率发生。随机性允许策略继续发现不同轨迹，并且正是策略梯度期望所对应的数据分布。训练阶段若改成 `argmax`，收集分布就不再等于声明的 \(\pi_\theta\)，REINFORCE 推导不再直接适用。

`state_tensor` 的形状从 `[4]` 经 `unsqueeze(0)` 变为 `[1,4]`，网络输出 `[1,2]`。轨迹收集放在 `torch.no_grad()` 内，避免为整个环境交互过程保存计算图；更新时会用收集到的状态重新前向计算一次，从而建立新的梯度图。

## 优化目标从一条随机轨迹开始

### 轨迹与期望回报

一条长度为 \(T\) 的轨迹写作

\[
\tau=(s_0,a_0,r_1,s_1,a_1,r_2,\ldots,s_T).
\]

策略希望最大化期望回报：

\[
J(\theta)=\mathbb E_{\tau\sim\pi_\theta}[G_0].
\]

期望中的轨迹由当前策略和环境共同产生。若环境初始状态分布为 \(\rho\)，转移概率为 \(P\)，则轨迹概率可以分解为

\[
p_\theta(\tau)=\rho(s_0)\prod_{t=0}^{T-1}\pi_\theta(a_t\mid s_t)P(s_{t+1}\mid s_t,a_t).
\]

环境转移 \(P\) 通常不可微，也不含策略参数。对数把乘积变成和：

\[
\log p_\theta(\tau)=\log\rho(s_0)+\sum_t\log\pi_\theta(a_t\mid s_t)+\sum_t\log P(s_{t+1}\mid s_t,a_t).
\]

对 \(\theta\) 求梯度后，只剩策略项。这让算法无需对环境动力学求导。

### 对数导数技巧

对任意正函数 \(p_\theta(x)\)，有

\[
\nabla_\theta p_\theta(x)=p_\theta(x)\nabla_\theta\log p_\theta(x).
\]

把它用于期望回报，可以得到采样形式：

\[
\nabla_\theta J(\theta)
=\mathbb E_{\tau\sim\pi_\theta}\left[
G_0\sum_{t=0}^{T-1}\nabla_\theta\log\pi_\theta(a_t\mid s_t)
\right].
\]

这条式子表达了一个可实现的过程：按当前策略采样轨迹，用回报给所选动作的对数概率梯度加权。

### 因果性把 \(G_0\) 换成 \(G_t\)

时间 \(t\) 的动作不能影响它之前已经发生的奖励。去掉这些与 \(a_t\) 无关的过去奖励，不改变梯度期望，还能减少无关噪声。于是 REINFORCE 使用 reward-to-go：

\[
G_t=\sum_{k=t}^{T-1}\gamma^{k-t}r_{k+1},
\]

并估计

\[
\nabla_\theta J(\theta)\approx
\sum_{t=0}^{T-1}G_t\nabla_\theta\log\pi_\theta(a_t\mid s_t).
\]

\(\gamma\) 是折扣因子，\(G_t\) 只包含从动作 \(a_t\) 之后开始的奖励。代码对时间步取均值而非求和，这会按 \(1/T\) 缩放单回合梯度，不改变该回合梯度方向，但让不同回合长度拥有不同的整体尺度关系。

## 反向递推计算每一步回报

### 为什么从后向前

定义直接求和会重复计算大量后缀。利用递推

\[
G_t=r_{t+1}+\gamma G_{t+1},
\]

只需一次反向遍历：

```python
returns = []
G = 0
for reward in reversed(rewards):
    G = reward + gamma * G
    returns.insert(0, G)
```

时间复杂度来自循环本身是 \(O(T)\)；Python 列表头插 `insert(0, ...)` 会移动已有元素，严格实现成本可到 \(O(T^2)\)。CartPole 轨迹很短，教学脚本可以接受。工程实现常预分配数组或反向 `append` 后再翻转。

### 三步数值推演

设奖励为 `[1,1,1]`，\(\gamma=0.9\)。从最后一步开始：

\[
G_2=1,
\]

\[
G_1=1+0.9\times1=1.9,
\]

\[
G_0=1+0.9\times1.9=2.71.
\]

结果列表是 `[2.71,1.9,1.0]`。早期动作影响更多后续生存奖励，因此权重更大。CartPole 每存活一步通常得到 +1，回合越长，总奖励越高，策略由此学习保持杆平衡。

## 从一条轨迹构造损失

### 批次维度其实是时间维度

假设一回合长度为 \(T\)。`train_one_episode` 构造：

| 对象 | 形状 | 含义 |
| --- | --- | --- |
| `states_tensor` | `[T,4]` | 轨迹中的状态 |
| `actions_tensor` | `[T]` | 每步采样动作 |
| `returns_tensor` | `[T]` | 每步折扣回报 |
| `probs` | `[T,2]` | 两动作概率 |
| `actions_tensor.unsqueeze(1)` | `[T,1]` | gather 索引 |
| `action_probs` | `[T]` | 实际动作概率 |
| `log_probs` | `[T]` | 实际动作对数概率 |

这里没有混合多个回合。\(T\) 会随本回合存活时间变化，因此每次优化的样本量也变化。

`gather` 与 DQN 中的用法相同，选择每行实际动作对应的一列：

```python
action_probs = probs.gather(
    1, actions_tensor.unsqueeze(1)
).squeeze(1)
log_probs = torch.log(action_probs + 1e-8)
```

小常数避免浮点下溢后出现 `log(0)`。更数值稳定的实现可以让网络返回 logits，并使用 `Categorical(logits=logits).log_prob(actions)`，避免先 Softmax 再取对数。

### 负号把梯度上升变成损失下降

PyTorch 优化器默认最小化损失，代码定义

\[
L(\theta)=-\frac1T\sum_{t=0}^{T-1}
\log\pi_\theta(a_t\mid s_t)G_t.
\]

因此

\[
\nabla_\theta L=-\frac1T\sum_tG_t\nabla_\theta\log\pi_\theta(a_t\mid s_t),
\]

沿 \(-\nabla L\) 更新就对应提高采样到的期望回报。

考虑三步所选动作概率 `[0.5,0.8,0.25]`，回报 `[2.71,1.9,1]`。对数概率约为 `[-0.693,-0.223,-1.386]`，损失为

\[
-\frac{(-0.693)(2.71)+(-0.223)(1.9)+(-1.386)(1)}{3}
\approx1.23.
\]

对某一步而言，正回报会推动已选动作的对数概率上升。CartPole 的 \(G_t\) 几乎都为正，因此学习信号来自成功轨迹中动作被更强强化、短轨迹贡献较少，以及 Softmax 概率之间的竞争。把每个正回报简单解释成“这个动作绝对正确”会忽略状态、轨迹长度和采样期望。

## 训练循环为什么必须收集后再更新

每个回合按以下顺序运行：

```text
当前策略收集完整轨迹
  → 反向计算所有 G_t
  → 用同一策略重新计算 log π(a_t|s_t)
  → 反向传播并更新一次
  → 丢弃轨迹，进入下一回合
```

REINFORCE 是在策略算法。参数更新后，旧轨迹来自 \(\pi_{\theta_{old}}\)，不能未经重要性采样校正就长期反复当作当前策略数据。原脚本每条轨迹只用一次，没有经验回放。

它也是蒙特卡洛算法：必须等回合结束，才知道每个 \(G_t\)。优点是目标不依赖价值自举；代价是更新延迟，并且整段未来随机性都会进入早期动作的权重，方差较高。

`collect_episode` 在 `done or truncated` 时结束。随后回报递推从 0 开始，所以真实终止与时间截断都被当作轨迹尾端，不再估计截断之后的价值。若截断只是外部时间限制，这个蒙特卡洛回报会漏掉潜在后续奖励；纯 REINFORCE 没有价值函数可用于尾端自举。

## 训练日志中容易误读的两点

### 损失值不等于策略质量

策略损失同时受到轨迹长度、回报尺度和动作概率影响。策略变好后，回合更长，\(G_t\) 可能整体更大，损失未必像监督学习那样持续下降。判断 CartPole 性能应看独立评价回报及其分布，损失主要用于排查 NaN、爆炸或实现异常。

### `episode_losses` 是未消费的记录

当前快照先创建 `episode_losses = []`，每回合只执行一次 `episode_losses.append(loss_value)`，但后续绘图函数只接收 `episode_rewards`。所以损失列表是冗余的记录数据，不参与参数更新。

有些代码副本或阅读记录会出现重复的 `episode_losses.append(loss_value)`。这种重复只会让记录列表长度翻倍或让损失曲线错位；`optimizer.step()` 已在 `train_one_episode` 内只执行一次，策略学习本身不会因此多更新一次。修复时删除重复记录即可。就本快照而言，追加语句只有一处。

## 用状态基线降低方差

### 基线为何不改变期望梯度

可以从回报中减去只依赖状态、与当前动作无关的基线 \(b(s_t)\)：

\[
\nabla_\theta J(\theta)=
\mathbb E\left[\sum_t
\nabla_\theta\log\pi_\theta(a_t\mid s_t)
(G_t-b(s_t))\right].
\]

原因是对固定状态求动作期望时：

\[
\mathbb E_{a\sim\pi_\theta}
[\nabla_\theta\log\pi_\theta(a\mid s)b(s)]
=b(s)\nabla_\theta\sum_a\pi_\theta(a\mid s)=0.
\]

若基线接近该状态的平均回报，\(G_t-b(s_t)\) 会围绕 0 波动，减少所有动作都被大正数同向放大的现象。

### 项目中的 ValueNetwork

[`reinforce_with_baseline.py`](./reinforce_with_baseline.py) 定义 `ValueNetwork`，结构为 `4 → 128 → 128 → 1`。输入 `[T,4]`，输出经 `squeeze(-1)` 变成 `[T]`，用均方误差拟合完整蒙特卡洛回报：

\[
L_V=\frac1T\sum_t(V_\phi(s_t)-G_t)^2.
\]

然后计算

\[
A_t=G_t-V_\phi(s_t),
\]

并把策略损失改为

\[
L_\pi=-\frac1T\sum_t\log\pi_\theta(a_t\mid s_t)A_t.
\]

若某状态预测基线为 8，实际回报为 11，优势是 +3，对应动作概率应增加；实际回报为 6 时优势是 -2，对应动作概率应降低。比较对象从“回报是否为正”变为“结果是否高于该状态的预期”。

### 这仍是整回合 REINFORCE

这个文件虽然在注释中使用 Actor 和 Critic 名称，价值网络目标仍是回合结束后得到的完整 \(G_t\)，策略也每回合只更新一次。下一章会讨论使用 TD 目标、边交互边更新或短 rollout 更新的 Actor-Critic。这里先保留边界：价值网络当前充当蒙特卡洛基线，不展开 TD 误差、n 步回报或 GAE。

原对比脚本为 vanilla 使用 `SEED`，为 baseline 使用 `SEED + 100`，两者没有共享同一组环境与初始化种子；记录的 `gradient_estimates` 还是每回合一个标量代理量，并非完整参数梯度向量的方差。因此图适合说明基线机制，算法优劣仍需成对多种子实验。

运行基线演示：

```bash
MPLBACKEND=Agg python chapter05_policy_gradient/reinforce_with_baseline.py
```

## 参数实验与预期观察

### 折扣因子 γ

比较 `gamma=0.9, 0.99, 1.0`。γ 较小时，早期动作收到的远期生存奖励衰减更快；γ 为 1 时，\(G_t\) 就是从当前步到回合末的剩余步数。保持种子组一致，报告评价回报分布。

### 学习率

比较 `1e-4, 1e-3, 3e-3`。REINFORCE 梯度方差高，较大学习率可能让动作概率迅速接近 0 或 1，随后探索不足；较小值通常更稳，也需要更多回合。

### 回报标准化

在单回合内尝试：

```python
returns_tensor = (
    returns_tensor - returns_tensor.mean()
) / (returns_tensor.std() + 1e-8)
```

它改变梯度尺度，并把该回合平均水平当作简单基线。单回合长度短时均值和标准差本身噪声很大，建议同时尝试跨多个回合组成批次，再比较梯度范数与学习曲线。

### 多回合批量更新

收集 5 或 10 个回合，把全部 `log_prob × return` 合并后更新一次。更多轨迹可降低一次梯度估计的方差，代价是更新频率降低；所有轨迹必须在参数更新前由同一策略版本收集。

### 显式评价

训练每 25 回合暂停一次，在独立环境中运行 20 个评价回合。若用 `argmax` 评价，测量确定性策略；若继续按分布采样，测量随机策略。两种口径都可以，但必须在所有实验中一致，并报告均值和标准差。

## 教学实现的边界

- 每次只用一条轨迹，梯度估计方差高；
- 主脚本没有随机种子、独立评价或 checkpoint；
- 轨迹截断后不进行尾端价值自举；
- Softmax 后再 `log(prob + 1e-8)` 的数值稳定性有限；
- 没有梯度裁剪、熵奖励或概率分布诊断；
- CartPole 奖励几乎总为正，损失注释中的“负回报降低概率”在默认任务里很少直接出现；
- `episode_losses` 被记录却没有用于绘图，重复追加若出现在副本中也只影响记录；
- baseline 对比没有使用成对多种子，所谓梯度方差指标只是标量代理；
- 价值基线仍依赖完整回合回报，Actor-Critic 的 TD 更新留到下一章。

## 自测

### 题目

1. 为什么轨迹收集时要从 `Categorical` 采样，而不能总取 `argmax`？
2. 奖励 `[1,2,3]`、\(\gamma=0.5\) 时，三个 \(G_t\) 分别是多少？
3. 长度 \(T=100\) 时，`probs`、`actions_tensor.unsqueeze(1)` 和 `action_probs` 的形状是什么？
4. 损失前面的负号有什么作用？
5. 为什么状态基线不能依赖当前选中的动作？
6. `episode_losses` 重复追加为什么不会造成两次梯度更新？
7. REINFORCE with baseline 与下一章 Actor-Critic 的关键数据差别是什么？

### 参考答案

1. REINFORCE 的数据应来自当前随机策略分布；采样还保留了发现其他动作与轨迹的机会。
2. \(G_2=3\)，\(G_1=2+0.5\times3=3.5\)，\(G_0=1+0.5\times3.5=2.75\)。
3. 分别是 `[100,2]`、`[100,1]` 和 `[100]`。
4. 优化器执行梯度下降；负号使最小化损失等价于沿期望回报的上升方向更新。
5. 动作相关基线通常无法在动作期望中抵消为零，会改变梯度目标并引入偏差。
6. 参数更新发生在 `train_one_episode` 的一次 `optimizer.step()` 中；外部 append 只复制 Python 标量记录。
7. 当前基线用回合结束后算出的完整蒙特卡洛 \(G_t\) 训练价值网络；下一章方法会引入由下一状态价值自举的 TD 或短 rollout 目标。
