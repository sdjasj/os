# 00. 学习路线：从 CartPole 走到现代大模型强化学习

Hands-On Modern RL 把经典控制、深度强化学习和大模型后训练放在同一条学习线上。
这条线的起点是一段能在普通 CPU 上运行的 CartPole 训练，终点则包括 RLHF、DPO、GRPO、工具调用智能体和多模态奖励。
项目内容很多，代码目录和课程章号还保留了不同历史阶段的编号。
有效的学习方式应沿着“环境给出什么信息、策略如何利用信息、奖励怎样变成参数更新”这条因果线前进；文件树只用于定位证据。

## 本教程要建立的能力

完成 14 章后，你应当能够：

1. 读懂 Gymnasium 环境交互、轨迹收集、训练更新和独立评估四段代码；
2. 从回报、价值函数和贝尔曼递推推到 Q-Learning、DQN 与 TD 误差；
3. 从动作概率推到 REINFORCE、Actor-Critic、GAE 与 PPO 裁剪目标；
4. 说明经典控制中的“动作”如何映射为大语言模型生成的 token；
5. 区分 SFT、奖励模型、PPO-RLHF、DPO、GRPO 与 RLVR 的数据和优化目标；
6. 把单轮回答扩展成多轮工具轨迹，并分析逐步信用分配；
7. 用多随机种子、独立任务指标和受控消融判断一次训练是否真的有效；
8. 根据机器、时间和费用边界分级选择可复现实验。

## 固定源码快照

本教程依据下面的上游快照独立创作：

```text
repository:  https://github.com/walkinglabs/hands-on-modern-rl
commit:      7c0372d4806c0dc478df46ed522ab64e58dda1d6
commit date: 2026-07-03 10:16:52 +08:00
subject:     fix: replace language dropdown with direct toggle link
```

固定提交有两个作用。
第一，教程所说的文件、函数和已知局限都有明确语境；上游继续修改后，不能假定行号和行为仍然相同。
第二，仓库本身是快速演进的课程项目，固定快照提醒我们把“教学脚本的意图”和“当前生产实践”分开判断。

遇到当前分支与教程不一致时，先搜索函数名、命令行参数和输出文件，再重新建立调用关系。
不要为迁就旧教程而覆盖当前代码。

项目总体定位见[中文 README](https://github.com/walkinglabs/hands-on-modern-rl/blob/7c0372d4806c0dc478df46ed522ab64e58dda1d6/README.zh.md)，可运行脚本索引见[代码目录说明](code/README.md)，网站的当前中文课程树见[VitePress 配置](docs/.vitepress/config.mjs)。

## 先认识两棵树

### 课程内容树

课程网站按知识关系组织：

```text
序章：导论与环境
Part I：CartPole、MDP、价值函数、DP / MC / TD
Part II：DQN、策略梯度、Actor-Critic、PPO、连续控制
Part III：离线、模仿、探索、多智能体与分层 RL
Part IV：RLHF、DPO、GRPO、RLVR、推理、PRM、CAI
Part V：Agentic RL、代码智能体、Deep Research、Computer Use
Part VI：VLM、音频、具身与视觉生成
Part VII：对齐失败、评估、自博弈与前沿
附录：训练工程、算法速查、资源与数学基础
```

这棵树适合查概念。
例如，贝尔曼方程位于[价值函数章节](docs/chapter03_mdp/value-bellman.md)，PPO 位于[信任域章节](docs/chapter10_ppo/trust-region-clipping.md)，RLHF 位于[大模型后训练章节](docs/chapter15_rlhf/intro.md)。

### 实验代码树

`code/` 按较早的实验编排保留目录名。
它适合运行脚本，却不能直接当作当前课程章号。
同一个概念有时还分布在两个代码目录中：Actor-Critic 的从零 CartPole 实现在策略梯度目录，连续控制实验则在独立目录。

下面的交叉表是学习时最重要的导航工具。

| 当前课程主题 | 主要文档 | 主要代码 | 编号说明 |
| --- | --- | --- | --- |
| CartPole 入门 | `docs/chapter01_cartpole/` | `code/chapter01_cartpole/` | 两边一致 |
| MDP、贝尔曼与 Q-Learning | `docs/chapter03_mdp/` 的课程第 2–4 章 | `code/chapter03_mdp/` | 一个代码目录覆盖三章理论 |
| 深度 Q 网络，课程第 5 章 | `docs/chapter07_dqn/` | `code/chapter04_dqn/` | 代码仍使用旧第 4 章编号 |
| 策略梯度，课程第 6 章 | `docs/chapter08_policy_gradient/` | `code/chapter05_policy_gradient/` | 代码仍使用旧第 5 章编号 |
| Actor-Critic，课程第 7 章 | `docs/chapter09_actor_critic/` | `code/chapter05_policy_gradient/`、`code/chapter06_actor_critic/` | 从零实现与连续实验分开 |
| PPO，课程第 8 章 | `docs/chapter10_ppo/` | `code/chapter07_ppo/`、`code/chapter01_cartpole/2-pytorch_ppo.py` | 首章完整实现要到此处重读 |
| 连续控制，课程第 9 章 | `docs/chapter11_continuous_control/` | `code/chapter09_continuous_control/` | 需要额外仿真依赖 |
| RLHF，课程第 13 章 | `docs/chapter15_rlhf/` | `code/chapter08_rlhf/` | 代码是缩小的三阶段流水线 |
| DPO，课程第 15 章 | `docs/chapter17_dpo/` | `code/chapter02_dpo/`、`code/chapter09_alignment/` | 早期体验与深入实验各一套 |
| GRPO / RLVR，课程第 16 章 | `docs/chapter18_grpo/` | `code/chapter09_grpo_rlvr/` | 含机制模拟和小模型训练 |
| Agentic RL，课程第 20 章 | `docs/chapter22_agentic/` | `code/chapter10_agentic_rl/`、`docs/chapter22_agentic/code/` | 部分脚本保留旧导入路径 |
| VLM RL，课程第 24 章 | `docs/chapter26_vlm/` | `code/chapter11_vlm_rl/` | 主训练脚本是流程模拟 |
| 多智能体与推理搜索 | `docs/chapter14_exploration_marl_hierarchical/`、`docs/chapter20_prm_search/` | `code/chapter12_future_trends/` | 作为扩展实验 |
| 训练失败与奖励错位 | `docs/appendix_industrial_training/`、`docs/chapter30_alignment_failures/` | `code/appendix_common_pitfalls/` | 最终综合诊断 |

课程页内部还存在少量旧小节编号。
学习时以文件路径、页面标题和实际函数为准，不根据标题中的数字猜代码位置。

## 14 章学习路线

### 第一阶段：先建立可观察的闭环

| 章 | 教程文件 | 核心问题 | 主要实践 | 完成标志 |
| ---: | --- | --- | --- | --- |
| 00 | `00-learning-roadmap.md` | 整个项目怎样连成一条因果线 | 建立交叉表、资源预算和实验记录 | 能为任意脚本找到对应文档 |
| 01 | `01-foundations-and-environment.md` | 运行代码前必须懂哪些工具 | Python、NumPy、PyTorch、Gymnasium 与环境 | 能解释一次 `reset/step` 的所有返回值 |
| 02 | `02-bandits-and-exploration.md` | 没有状态转移时为何仍需要探索 | 多臂老虎机、贪心、ε-贪心与 UCB | 能区分即时奖励与累计遗憾 |

第 01 章先用 CartPole 观察，再由第 02 章把问题缩小到一次选择。
这与项目“实践先行”的设计一致：第一次运行 PPO 时只把它当作能产生轨迹和指标的策略优化器，暂不展开裁剪公式。

### 第二阶段：走通经典深度强化学习主线

| 章 | 教程文件 | 核心问题 | 主要实践 | 完成标志 |
| ---: | --- | --- | --- | --- |
| 03 | `03-mdp-bellman-q-learning.md` | 多步决策怎样评价状态和动作 | MDP、回报、贝尔曼、TD 与 Q-Learning | 能手算一次 TD 或 Q 更新 |
| 04 | `04-dqn-from-table-to-network.md` | Q 表装不下以后怎样保留贝尔曼目标 | DQN、回放缓冲区、目标网络 | 能标出一个 batch 的张量形状 |
| 05 | `05-policy-gradient-reinforce.md` | 怎样直接优化动作概率 | REINFORCE 与回报加权对数概率 | 能解释梯度为何有高方差 |
| 06 | `06-actor-critic-continuous-control.md` | 怎样让策略每一步都获得学习信号 | 优势、Critic、Actor-Critic 与连续动作 | 能算一条 TD 误差并说明符号 |
| 07 | `07-ppo-gae-clipping.md` | 怎样复用数据又限制策略突变 | GAE、策略比率、PPO 裁剪 | 能把公式逐项映射到实现 |

这五章拥有严格的概念归属：
DQN 章定义经验回放和目标网络；策略梯度章定义对数导数；Actor-Critic 章定义优势与 Critic；PPO 章才定义 GAE 和裁剪。
后章只引用前章，不重复推导。

### 第三阶段：把控制问题迁移到语言模型

| 章 | 教程文件 | 核心问题 | 主要实践 | 完成标志 |
| ---: | --- | --- | --- | --- |
| 08 | `08-rlhf-pipeline.md` | token 怎样成为动作，偏好怎样成为奖励 | SFT、奖励模型、PPO-RLHF | 能画出三阶段 artifact 流 |
| 09 | `09-dpo-preference-optimization.md` | 能否直接从偏好对更新策略 | DPO、参考模型与 β | 能解释 chosen/rejected 的概率比 |
| 10 | `10-grpo-rlvr.md` | 能否用同题多回答替代独立 Critic | GRPO、组内优势与 RLVR | 能手算一组归一化优势 |

这一步需要保留经典 RL 的对应关系：
状态变成提示词及已生成前缀，动作变成下一个 token，一段回答形成轨迹，最终或逐步评分提供奖励。
映射建立后，再引入大模型专属的长度、KL、格式和 verifier 问题。

### 第四阶段：从回答扩展到任务

| 章 | 教程文件 | 核心问题 | 主要实践 | 完成标志 |
| ---: | --- | --- | --- | --- |
| 11 | `11-agentic-rl-credit-assignment.md` | 多轮工具调用如何形成环境 | 工具策略、轨迹、结果奖励与过程奖励 | 能写出一条结构化轨迹 |
| 12 | `12-vlm-marl-search.md` | 输入和参与者扩展后会改变什么 | VLM、多模态奖励、多智能体与搜索 | 能按任务特征选择实验模型 |
| 13 | `13-debugging-capstone.md` | 如何证明训练真的有效 | 诊断矩阵、多种子实验和三个综合项目 | 能提交可复现的实验报告 |

如果目标是 LLM 后训练，可以在第 07 章后直接进入第 08–11 章。
如果目标是经典控制，应完整学习第 02–07 章，并用第 13 章完成多随机种子复现。

## 资源与成本分级

### A 级：CPU 与纯阅读实验

这一层足以掌握主线机制：

- 双臂老虎机、贝尔曼数值验证和 GridWorld；
- CartPole 的 SB3、DQN、REINFORCE 与 Actor-Critic；
- GAE、GRPO 组内归一化和规则奖励的合成演示；
- 工具选择、多轮奖励分配、几何数据生成和 VLM 流程模拟；
- 所有静态源码阅读和纸面推导。

先完成这一层再决定是否增加硬件。
算法理解不依赖下载大模型。

### B 级：中型本地实验

这一层增加原生依赖、运行时间或磁盘占用：

- LunarLander 与 BipedalWalker 需要 Box2D；
- HalfCheetah 需要 MuJoCo；
- Atari 需要 ALE 和图像处理依赖；
- Pokemon 示例要求学习者自行准备合法 ROM；
- 更长的 PPO、SAC 与多随机种子经典控制实验可能运行数小时。

这里的主要成本通常是环境安装和重复训练，不一定是 GPU。
先用短预算验证命令、日志和保存路径，再开始完整运行。

### C 级：本地 GPU 与模型下载

DPO、奖励模型、PPO-RLHF、真实 GRPO 和 GeoQA 等实验会下载模型或数据，并占用显存与磁盘。
仓库中的小模型示例仍可能因 batch size、生成长度、优化器状态和精度设置而超出显存。

开始前记录：

- 模型精确名称与修订；
- 权重下载大小和缓存位置；
- 训练精度、batch size、梯度累积与最大长度；
- 预计训练步数和 checkpoint 数量；
- 峰值显存与可接受运行时间。

无法满足预算时，先运行机制模拟，不要把“脚本能导入”误当成“训练可完成”。

### D 级：外部 API

合成 Agent 轨迹的可选脚本会调用兼容 OpenAI 接口的服务。
这一级会产生网络、费用、隐私和配额问题，且不是主线必需步骤。

使用前应做到：

1. 只通过环境变量或受控凭据存储配置密钥；
2. 不把密钥、完整请求或敏感回复写入教程、日志和提交；
3. 为请求数、最大 token、重试次数和总费用设上限；
4. 先用离线固定任务验证数据格式；
5. 明确合成数据的许可证、隐私和质量审查责任。

## 四遍实验法

### 第一遍：确认边界

先读脚本入口、依赖文件、默认参数和输出路径。
写下环境、训练预算、随机性来源以及是否会下载模型或调用网络。
这一遍不改参数。

### 第二遍：跑最小基线

使用默认或缩短预算，只验证完整闭环：环境能重置、训练能更新、评估能结束、产物能保存。
记录原始日志，不根据一条奖励曲线下结论。

### 第三遍：只改变一个因素

选择一个能回答问题的变量，例如学习率、折扣因子、是否使用基线、PPO 裁剪范围或奖励权重。
保持环境、预算、评估协议和随机种子集合不变。
一次改多个变量会失去因果解释。

### 第四遍：加入重复与反例

至少使用多个随机种子，报告均值、波动和失败运行。
再构造一个反例：错误奖励、未见初始状态、格式诱导回复或无效工具调用。
只有主指标和反例都支持假设，实验结论才足够可靠。

## 实验记录模板

每次实验保留一份纯文本记录即可：

```markdown
## 实验名称

- 源码快照：7c0372d4806c0dc478df46ed522ab64e58dda1d6
- 问题：这次实验要区分哪两个解释？
- 环境：Python / PyTorch / Gymnasium / OS / device
- 命令：可重新运行的完整命令
- 配置：算法参数、环境参数、模型修订
- 预算：步数、回合数、生成数、时间或费用上限
- 随机种子：训练种子和评估种子
- 训练指标：只记录与假设有关的量
- 独立任务指标：与训练奖励分开
- 产物：日志、CSV、图、模型及其相对路径
- 异常：失败运行、警告和偏离预期之处
- 结论：证据支持什么，不支持什么
- 下一步：只改变哪个变量
```

记录的重点是让另一个人能够复现你的判断。
只保存截图而没有命令、配置和种子，无法形成可检验的结论。

## 许可、归属与发布边界

上游课程采用 [CC BY-NC-SA 4.0](LICENSE)。
共享或改编上游材料时，需要署名、标明改动、限于非商业用途，并以相同许可证分发衍生内容。
本教程是基于固定快照独立创作的源码导读，不声称这些教程文件存在于上游提交。

还需要分别处理以下边界：

- 外部论文、图片、数据集、模型权重和游戏 ROM 可能采用各自许可证；
- 教程不复制模型、数据集、日志、缓存、虚拟环境或构建产物；
- 不发布 `.env`、访问令牌、API 请求中的敏感数据或本机绝对路径；
- 不把教学用进程执行器描述为生产级安全沙箱；
- 运行外部模型和环境前，应阅读其许可证与使用条款；
- 当前上游分支发生变化时，应明确教程依据的仍是固定快照。

## 开始前的自检

进入下一章前，请确认你能回答：

1. 为什么课程第 5 章 DQN 位于 `code/chapter04_dqn/`？
2. 为什么第一次跑 CartPole 时可以暂时不懂 PPO 裁剪？
3. CPU 机制演示与真实大模型训练分别能证明什么？
4. 四遍实验法怎样避免把随机波动当成算法改进？
5. 使用外部 API 前需要固定哪些成本和隐私边界？
6. 为什么教程必须记录固定提交而不能只写“当前 main”？

下一章补足运行代码所需的 Python、NumPy、PyTorch 与 Gymnasium 背景，并完成第一次 CartPole 观察实验。
