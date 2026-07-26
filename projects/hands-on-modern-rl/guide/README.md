# Hands-On Modern RL 代码驱动学习教程索引

本目录是一套基于 Hands-On Modern RL 提交 `7c0372d4806c0dc478df46ed522ab64e58dda1d6` 独立编写的中文学习教程。教程沿项目中的可运行代码组织知识依赖，补足 Python、PyTorch、Gymnasium、强化学习数学和 LLM 后训练背景。它不是上游 `docs/` 的复制，也不复制模型、数据集、训练产物或源码树。

## 推荐顺序

1. `00`—`01`：确认学习目标、运行成本与必要背景。
2. `02`—`03`：从老虎机进入 MDP、贝尔曼方程和表格 Q-learning。
3. `04`—`07`：依次学习 DQN、REINFORCE、Actor-Critic、GAE 与 PPO。
4. `08`—`10`：把经典 RL 映射到 RLHF、DPO、GRPO 与 RLVR。
5. `11`—`12`：扩展到 Agentic RL、VLM、多智能体与推理时搜索。
6. `13`：建立诊断流程并完成综合项目。

## 章节清单

- `00-learning-roadmap.md`：项目地图、固定快照、资源分级与学习方法
- `01-foundations-and-environment.md`：Python、PyTorch、Gymnasium 与首次实验
- `02-bandits-and-exploration.md`：老虎机、样本均值、ε-贪心与 UCB
- `03-mdp-bellman-q-learning.md`：MDP、价值函数、贝尔曼方程与 Q-learning
- `04-dqn-from-table-to-network.md`：函数近似、经验回放、目标网络与 Double DQN
- `05-policy-gradient-reinforce.md`：随机策略、对数导数与 REINFORCE
- `06-actor-critic-continuous-control.md`：价值基线、TD 优势与连续动作
- `07-ppo-gae-clipping.md`：GAE、策略比率、PPO 裁剪与 rollout 边界
- `08-rlhf-pipeline.md`：SFT、奖励模型、PPO-RLHF 与 KL 约束
- `09-dpo-preference-optimization.md`：偏好数据、DPO 目标、β 与评估
- `10-grpo-rlvr.md`：组内优势、可验证奖励与教学实现边界
- `11-agentic-rl-credit-assignment.md`：工具策略、多轮轨迹、ORM/PRM 与动作掩码
- `12-vlm-marl-search.md`：多模态、多智能体与推理时搜索
- `13-debugging-capstone.md`：训练诊断、奖励审计与综合项目

## 使用约定

- `<project-root>` 表示 Hands-On Modern RL 仓库根目录。
- 以每章命令块给出的工作目录为准。大多数实验从 `<project-root>/code` 运行；`chapter02_dpo`、`chapter08_rlhf`、`chapter09_alignment` 和 `chapter09_grpo_rlvr` 的训练脚本从各自目录运行，以正确解析相对模型路径和 `output/`。
- 主线优先选择纯 NumPy、CartPole 和机制模拟；Atari、MuJoCo、Box2D、PyBoy、LLM/VLM 训练与外部 API 属于资源或环境敏感实验。
- 教程会明确指出当前固定快照中的运行问题和算法简化。相关说明用于帮助读者建立审计能力，并未修改上游源码。
- 比较算法时至少使用多个随机种子，并把训练奖励与独立任务指标分开记录。

## 归属与许可

上游课程与代码使用 CC BY-NC-SA 4.0。本教程基于该固定快照的源码结构与教学材料独立改写，保留项目归属，并按相同许可证边界使用。`UPSTREAM_LICENSE` 原样保存上游许可证说明；它不扩大任何模型、数据集、游戏 ROM 或第三方依赖的授权。
