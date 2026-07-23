# 00. 全局心智模型

## 1. 这里的“Agentic”具体指什么

MiniMind 当前实现聚焦一个有限但完整的闭环：模型读取问题和工具 schema，决定是否调用工具，环境执行工具并返回 observation，模型读取 observation 后继续调用或给出最终回答，整条轨迹结束后获得奖励。

它不包含长期记忆、复杂规划器、跨任务持久状态或工业级异步调度。理解这个边界很重要：这里是在学习 Agentic RL 的最小闭环，而不是完整 Agent 平台。

## 2. Tool SFT、普通 GRPO 与 Agentic RL

### Tool SFT

给定人工/教师轨迹，做 teacher forcing：

$$\mathcal L_{SFT}=-\sum_{t\in assistant}\log\pi_\theta(a_t|s_t)$$

模型学习已知的工具调用格式和示范行为，但不会探索不同轨迹。

### 普通 GRPO

同一 prompt 生成多个单轮回答，打分后做组内相对优化。状态没有真实环境变化。

### Agentic RL

模型动作会改变后续状态：

$$s_{t+1}=\operatorname{Env}(s_t,a_t)$$

如果 `a_t` 是工具调用，环境返回 observation；后续动作以新上下文为条件。优化对象是整条轨迹而非一段静态回答。

## 3. 用 MDP/POMDP 语言描述

一条训练样本可记为：

```text
x:  初始 messages
T:  可用工具集合
gt: 最终验证目标
```

轨迹：

$$\tau=(s_0,a_0,o_0,s_1,a_1,o_1,\ldots,a_T)$$

- `s_t`：模板化后的完整消息上下文；
- `a_t`：模型生成的 token 序列；
- `o_t`：工具结果；
- `R(τ)`：轨迹结束后的标量奖励。

严格说，语言模型看到的是文本化状态而非环境全部内部状态，因此复杂任务常更接近 POMDP。但当前模拟工具是确定且信息充分的，用 MDP 直觉已经足够。

## 4. 项目完整调用链

```text
train_agent.py main
  |
  +-- init_model(policy, full_sft)       可训练
  +-- init_model(reference, full_sft)    冻结
  +-- LMForRewardModel                   冻结
  +-- AgentRLDataset -> DataLoader
  +-- create_rollout_engine(torch|sglang)
  |
  `-- rl_train_epoch
       |
       +-- rollout_batch
       |    `-- rollout_single
       |         +-- apply_chat_template
       |         +-- rollout_engine.rollout
       |         +-- parse_tool_calls
       |         +-- execute_tool
       |         `-- observation 回填
       |
       +-- pack variable-length trajectories
       +-- calculate_rewards
       +-- current/ref per-token log-prob
       +-- group-relative advantages
       +-- GRPO or CISPO loss + KL
       +-- backward / optimizer / scheduler
       `-- checkpoint + rollout policy sync
```

## 5. 三个策略分布

代码同时出现三个概率，必须区分：

| 名称 | 来源 | 是否变化 | 用途 |
|---|---|---|---|
| `old_per_token_logps` | 生成本批轨迹时的策略 | 每次 rollout 更新 | importance ratio 分母 |
| `per_token_logps` | 当前可训练 policy 再评估轨迹 | optimizer 后变化 | 策略梯度 |
| `ref_per_token_logps` | 固定 full-SFT reference | 整个训练不变 | KL 锚点 |

$$r_t=\exp(\log\pi_\theta-\log\pi_{old})$$

old policy 解决“这批样本由谁生成”，reference 解决“新策略不要离语言基座太远”。两者不是同一概念，即使一开始可能参数相同。

## 6. 为什么先 SFT 再 Agent RL

随机或仅预训练模型很难稳定产生合法 `<tool_call>` JSON。若同一 prompt 的所有轨迹都解析失败、奖励相同，GRPO advantage 会接近 0：

$$A_i=\frac{R_i-\mu}{\sigma+\epsilon}\approx0$$

Tool SFT 先把策略带到“偶尔能成功”的区域，Agent RL 再用环境反馈区分更优轨迹。这个过程常被概括为：先模仿获得基础行为，再通过试错优化任务成功率。

## 7. 延迟奖励与信用分配

项目最终为每条轨迹计算一个 reward，然后把同一个 advantage 广播到该轨迹全部 action token。优点是简单；缺点是无法精确判断哪一步调用导致成功或失败。

例如：

```text
正确工具选择 -> 错误参数 -> 修正参数 -> 正确答案
```

最终正奖励会同时鼓励早期错误动作和后续修正动作。reference KL、组内比较和大量样本能缓解，但不会彻底解决信用分配。

## 8. Online 的含义

轨迹由当前 policy 现场生成，而不是从 JSONL 直接读取标准答案。这使策略能够探索，但也带来：

- rollout 成本高；
- 权重同步必须及时；
- 数据不能无限重复离线复用；
- 训练中生成分布持续变化；
- reward 和环境必须足够快、稳定、可复现。

当前实现是同步 online：采样一批，更新一次，再周期性同步 rollout policy。不是异步 actor/learner 架构。

## 9. 本章应掌握的判断

1. 模型生成的是 action，工具结果是 observation。
2. observation 影响未来 action，却不能当作模型采样 token 训练。
3. reward 不需要可导；它通过 advantage 缩放 log-prob 梯度。
4. 相同 reward 的组不会产生有效相对优势。
5. 格式正确率、环境成功率和最终答案正确率是不同指标。

## 10. 代码阅读练习

打开 `trainer/train_agent.py`，用不同颜色标记：

- 绿色：无梯度 rollout/reward/reference；
- 红色：当前 policy 前向和 loss；
- 蓝色：文本/JSON 环境逻辑；
- 黄色：mask 与长度对齐。

如果能解释 `rollout_single -> packed_samples -> completion_mask -> policy_loss` 之间每个列表/张量的长度变化，就具备继续修改代码的基础。
