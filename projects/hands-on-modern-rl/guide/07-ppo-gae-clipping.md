# 07. PPO、GAE 与裁剪：在复用轨迹时控制策略变化

Actor-Critic 已经能逐步更新，但一步 TD 优势偏差较大，完整回报又有较大方差。进一步地，神经网络训练希望对同一批数据做多个小批量更新；策略一旦在第一次更新后改变，这批动作就不再来自“当前策略”。更新次数越多，数据分布与新策略之间的错位越明显。

PPO 处理这两个问题。GAE 用参数 \(\lambda\) 连接一步 TD 与多步回报，PPO-Clip 用新旧策略概率比率限制单批数据上的更新幅度。本章围绕 [从零实现 PPO](ppo_from_scratch.py) 的数据流展开：采样旧策略轨迹、计算优势、冻结旧对数概率、分小批多轮更新、监控裁剪与熵。

## 先把一批 PPO 数据画清楚

源脚本每次收集 2048 个环境步。每条记录包含：

```text
state_t
action_t
old_logprob_t = log π_old(action_t | state_t)
reward_t
done_t
value_t = V_old(state_t)
```

采样完成后，`old_logprobs` 和旧价值被当作固定数据。优化阶段用当前参数重新计算 `new_logprobs` 和 `new_values`。这条时间边界非常重要：

```text
rollout 阶段：策略固定，产生行为数据
        ↓ 冻结 old_logprobs / values
update 阶段：同一批数据训练多个 epoch
        ↓
丢弃这批 on-policy 数据，重新采样
```

如果更新过程中又向同一个批次追加新动作，“旧策略”就不再是一个明确快照，概率比率也失去含义。

## GAE：把多个 TD 误差连起来

一步 TD 误差为：

\[
\delta_t=r_t+\gamma(1-d_t)V(s_{t+1})-V(s_t)
\]

GAE 从后向前递推：

\[
A_t^{\mathrm{GAE}(\gamma,\lambda)}
=\delta_t+\gamma\lambda(1-d_t)A_{t+1}
\]

展开后可以看见它是未来 TD 误差的加权和：

\[
A_t=\delta_t+(\gamma\lambda)\delta_{t+1}
+(\gamma\lambda)^2\delta_{t+2}+\cdots
\]

参数含义：

- \(\gamma\) 决定未来奖励的任务权重；
- \(\lambda\) 决定优势估计向未来传播多远；
- \(d_t\) 在真正终止处切断传播；
- \(A_t\) 是 Actor 的更新权重；
- \(R_t=A_t+V(s_t)\) 是 Critic 的回归目标。

### \(\lambda\) 如何改变偏差与方差

| 设置 | 主要依赖 | 特性 |
| --- | --- | --- |
| \(\lambda=0\) | 当前一步 TD 误差 | 方差低，对 Critic 偏差敏感 |
| \(0<\lambda<1\) | 指数衰减的多步误差 | 实践中的折中 |
| \(\lambda\approx1\) | 很长的后续轨迹 | 偏差较低，方差较高 |

先运行仓库的 [GAE 可视化](gae_visualization.py)：

```bash
cd <project-root>/code
python -m pip install -r chapter07_ppo/requirements.txt
python chapter07_ppo/gae_visualization.py
```

修改 \(\lambda\) 时，不要只看优势曲线是否平滑。还要观察早期 TD 误差能影响多少个之前的时间步，以及终止标志是否正确切断递推。

## 对照源码理解反向递推

`compute_gae` 从最后一步向前遍历：

```python
for t in reversed(range(len(rewards))):
    if dones[t]:
        next_value = 0
        gae = 0

    delta = rewards[t] + gamma * next_value - values[t]
    gae = delta + gamma * lam * gae
    advantages.insert(0, gae)
    next_value = values[t]
```

反向遍历使 `gae` 恰好保存 \(A_{t+1}\)。在终止点把 `gae` 清零，防止下一个 episode 的误差越界传播到前一个 episode。

源实现随后执行：

```python
returns = advantages + torch.FloatTensor(values)
advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)
```

先构造 `returns`，再归一化 Actor 使用的优势。这样 Critic 的目标保持原有回报尺度；若先归一化再相加，价值网络会学习人为改变的目标。

## 重要性采样比率：衡量动作概率改了多少

旧轨迹中的动作由 \(\pi_{old}\) 采样。更新后的策略为 \(\pi_\theta\)。对同一个状态动作对，概率比率为：

\[
r_t(\theta)=\frac{\pi_\theta(a_t\mid s_t)}
{\pi_{old}(a_t\mid s_t)}
=\exp\left(\log\pi_\theta(a_t\mid s_t)
-\log\pi_{old}(a_t\mid s_t)\right)
\]

使用对数概率相减再取指数，数值上比先求两个很小的概率再相除稳定。

- \(r_t=1\)：动作概率没有变化；
- \(r_t=1.2\)：新策略将该动作概率提高了 20%；
- \(r_t=0.7\)：新策略将该动作概率降低了 30%。

未经限制的替代目标是 \(r_tA_t\)。如果优势为正，它会不断提高动作概率；如果优势为负，它会不断降低动作概率。同一批数据更新多个 epoch 时，极端比率可能迅速把策略推离采样分布。

## PPO-Clip 的逐符号解释

PPO 的裁剪目标为：

\[
L^{CLIP}(\theta)=\mathbb{E}_t\left[
\min\left(
r_t(\theta)A_t,
\operatorname{clip}(r_t(\theta),1-\epsilon,1+\epsilon)A_t
\right)
\right]
\]

源码把最大化目标改写成最小化负值：

```python
ratio = torch.exp(new_logprobs - old_logprobs)
surr1 = ratio * advantages
surr2 = torch.clamp(ratio, 1.0 - clip_eps, 1.0 + clip_eps) * advantages
policy_loss = -torch.min(surr1, surr2).mean()
```

`min` 要与优势符号一起理解：

| 优势 | 策略变化 | 裁剪效果 |
| --- | --- | --- |
| \(A_t>0\) | 动作概率提高过多，\(r_t>1+\epsilon\) | 收益封顶 |
| \(A_t>0\) | 动作概率降低 | 不阻止错误方向，损失会推动它回来 |
| \(A_t<0\) | 动作概率降低过多，\(r_t<1-\epsilon\) | 收益封顶 |
| \(A_t<0\) | 动作概率提高 | 不阻止错误方向，损失会推动它回来 |

裁剪限制的是继续朝“已知有利方向”走得过远所带来的收益。它不是参数距离的硬约束，也不能保证每次更新后的 KL 都小。

## Actor、Critic 与熵组成总损失

源脚本的小批量总损失为：

\[
L=L_{policy}+c_vL_{value}-c_eH(\pi)
\]

对应代码：

```python
value_loss = F.mse_loss(new_values, mb_returns)
entropy_bonus = entropy.mean()
loss = policy_loss + vf_coef * value_loss - ent_coef * entropy_bonus
```

- `policy_loss` 更新 Actor；
- `value_loss` 让 Critic 拟合 GAE 构造的目标回报；
- 熵 \(H(\pi)\) 越大，动作分布越分散；前面的负号使最小化损失时保留探索；
- `vf_coef` 和 `ent_coef` 把不同量纲的目标组合起来。

共享网络时，这三项都会更新主干。单看总损失无法知道是哪一项主导了梯度，所以脚本分别记录策略损失、价值损失和熵。

## 从采样到更新的张量形状

假设 `n_steps=2048`、`batch_size=64`、CartPole 有 4 维状态和 2 个动作：

| 名称 | 完整批次 | 小批次 | 说明 |
| --- | ---: | ---: | --- |
| `states` | `[2048, 4]` | `[64, 4]` | 环境观测 |
| `actions` | `[2048]` | `[64]` | 离散动作索引 |
| `old_logprobs` | `[2048]` | `[64]` | 采样时冻结的对数概率 |
| `advantages` | `[2048]` | `[64]` | 已归一化优势 |
| `returns` | `[2048]` | `[64]` | Critic 目标 |
| `new_logprobs` | — | `[64]` | 当前策略重新评估 |
| `new_values` | — | `[64]` | 当前 Critic 预测 |

每个 epoch 用 `torch.randperm` 重新打乱索引。10 个 epoch 意味着每条样本被重复用于 10 次更新，这正是需要比率和裁剪的原因。

## 四个核心监控指标

### 平均回合奖励

它回答任务是否改善，但回报只在 episode 完成时进入列表。若 rollout 在回合中途结束，该部分回报不会出现在当前打印值里。

### 价值损失

持续很高可能意味着回报尺度、学习率或 bootstrap 有问题。价值损失下降也不保证策略变好；Critic 可以准确拟合一批很差的轨迹。

### 策略熵

熵逐渐下降通常表示策略更确定。快速接近零时应同时检查奖励是否停滞、动作分布是否坍缩。

### 裁剪比例

`clip_fraction` 是 \(|r_t-1|>\epsilon\) 的样本比例。接近零可能表示更新很小；长期很高说明大量样本触达裁剪区。它是比例，而 `clip_eps=0.2` 是概率比率的范围参数，两者量纲不同。源脚本在图中用 0.2 水平线标注 `clip_range`，只能作为视觉参考，不能解释为“裁剪比例目标值”。

生产实现还常记录近似 KL、explained variance、梯度范数、学习率和每秒环境步数。

## 源实现的 rollout 边界简化

`compute_gae` 初始令 `next_value = 0`。这只在批次最后一步确实终止时成立。若 2048 步恰好停在一个尚未结束的 episode 中，正确做法应计算批次末观测的价值：

```python
with torch.no_grad():
    _, bootstrap_value = model(last_observation_tensor)
```

然后从该值开始反向递推。源脚本还在每次 `collect_trajectories` 开头调用 `env.reset()`，因此批次末尾未完成的回合不会延续到下一批。这会同时造成：

- 最后一段优势被当作终止回报，产生边界偏差；
- 未完成 episode 的环境状态被丢弃；
- 打印的完成回合奖励忽略这段采样。

这是教学实现为了缩短接口做出的简化。修正时让收集函数接收并返回当前 `obs`，同时返回 `last_value`。

另一个边界是 `dones.append(done or truncated)`。时间上限截断是否应停止自举取决于任务语义；经典持续任务通常只对真正 `terminated` 的状态置零。

## 先做不训练模型的单元实验

构造三个样本直接调用 `ppo_clip_loss`：

```python
old = torch.log(torch.tensor([0.5, 0.5, 0.5]))
new = torch.log(torch.tensor([0.5, 0.8, 0.2]))
adv = torch.tensor([1.0, 1.0, -1.0])

loss, clip_fraction = ppo_clip_loss(old, new, adv, clip_eps=0.2)
print(loss.item(), clip_fraction)
```

手工先算比率 `[1.0, 1.6, 0.4]`，再判断每个样本是否进入裁剪区。这个实验能把符号问题从完整训练中分离出来。

## 完整运行与对照实验

```bash
cd <project-root>/code
python chapter07_ppo/ppo_from_scratch.py
```

建议依次改变一个因素：

1. `n_epochs`: 1、5、10、20；观察裁剪比例和近似 KL。
2. `clip_eps`: 0.1、0.2、0.3；保持学习率不变。
3. `lam`: 0、0.95、1；比较价值损失和跨种子奖励方差。
4. `ent_coef`: 0、0.01、0.05；观察熵衰减与收敛速度。
5. rollout 末尾是否 bootstrap；专门缩短 `n_steps` 放大差异。

每个配置至少使用 5 个随机种子，报告固定训练步数后的均值、标准差和置信区间。不要用“第一次达到阈值”的单个数字替代整个学习曲线。

仓库还提供 [LunarLander PPO](ppo_lunar_lander.py) 和 [BipedalWalker PPO](ppo_bipedal_walker.py)。它们依赖 Box2D，训练预算也更高。先在 CartPole 验证实现，再扩大环境复杂度。

## 与首章 PPO 脚本的关系

`chapter01_cartpole/1-ppo_cartpole.py` 使用 Stable-Baselines3，适合先观察训练指标；本章脚本把核心计算展开。`chapter01_cartpole/2-pytorch_ppo.py` 也是可运行的手写实现：`get_action` 的随机与确定性分支都返回零维张量，调用处再用 `action.item()` 转成环境需要的 Python 整数。它还更完整地区分了自然终止、时间截断和 rollout 末尾自举，适合与本章的简化实现逐项对照。

## 本章小结

GAE 把连续 TD 误差组合为可调的优势估计；PPO 保存采样时的旧对数概率，用新旧策略比率修正重复更新，并通过裁剪让过度变化不再继续获益。一个可靠实现还必须正确处理 rollout 末尾的价值自举、自然终止与时间截断，并同时监控奖励、价值损失、熵、裁剪比例和 KL。

这套结构会在 LLM 对齐中再次出现。环境动作会变成 token，回合会变成一段回答，奖励会来自偏好模型或规则验证器，但“旧策略采样—估计优势—限制新策略变化”的计算骨架仍然适用。

## 自测

1. 为什么 GAE 要从轨迹末尾向前计算？
2. \(\lambda=0\) 和 \(\lambda\approx1\) 分别依赖什么信息？
3. 为什么 PPO 必须保存采样时的 `old_logprobs`？
4. 对负优势样本，哪一侧的概率比率会触发收益裁剪？
5. rollout 在非终止状态结束时，为什么不能把下一价值固定为零？
6. `clip_fraction=0.2` 与 `clip_eps=0.2` 为什么表达不同概念？
