# 04. DQN：从 Q 表到神经网络、经验回放与目标网络

GridWorld 只有 16 个位置，可以为每个状态—动作对保存一个数。CartPole 的状态包含连续的位置、速度、角度和角速度，可能取值无法枚举。Q-Learning 的贝尔曼目标仍然可用，但价值存储方式必须从表格变为函数近似。

本章沿 [`dqn_cartpole.py`](./dqn_cartpole.py) 追踪一次完整更新：环境转移怎样进入回放缓冲区，批量状态怎样经过网络，`gather` 怎样选出实际动作的 Q 值，终止掩码怎样关闭自举。随后用 [`double_dqn_cartpole.py`](./double_dqn_cartpole.py) 解释过估计与实验比较的统计要求。

## 学习目标与最小运行

完成本章后，你应当能够：

- 说明为什么连续状态需要 \(Q_\theta(s,a)\)；
- 写出网络、回放样本和各中间张量的形状；
- 从 `gather`、目标网络和终止掩码还原 DQN 损失；
- 区分 Gymnasium 的 `terminated` 与 `truncated`；
- 解释 Double DQN 如何分离动作选择和价值评估；
- 用多随机种子而非一条曲线比较两个算法；
- 判断 Atari 与 Pokémon 实验的算力、存储和 ROM 边界。

先运行最小 CartPole 版本：

```bash
cd <project-root>/code
python -m pip install -r chapter04_dqn/requirements.txt
python chapter04_dqn/dqn_cartpole.py
```

脚本训练 500 回合，保存 `output/dqn_cartpole_training.png`，随后测试 10 回合。无桌面环境可执行：

```bash
MPLBACKEND=Agg python chapter04_dqn/dqn_cartpole.py
```

## 连续状态改变了价值的表示方式

### CartPole 的输入与动作

`CartPole-v1` 的单个状态是长度为 4 的浮点向量，可理解为小车位置、小车速度、杆角度和杆角速度。动作空间有两个离散值，对应向左或向右施力。代码从环境读取维度：

```python
state_dim = env.observation_space.shape[0]  # 4
action_dim = env.action_space.n            # 2
```

每维连续量都有大量可能值，直接离散化会产生组合爆炸，还会让相邻状态无法共享经验。神经网络使用同一组参数处理所有状态，使相近输入可以得到相近价值估计。

### 从槽位到参数函数

表格 Q-Learning 读取 \(Q[s,a]\)。DQN 用带参数的函数代替它：

\[
Q_\theta(s,a)\approx Q_*(s,a),
\]

\(\theta\) 是神经网络全部权重，\(s\) 是连续状态，\(a\) 是动作。网络一次输出当前状态下所有动作的价值：

\[
Q_\theta(s)=[Q_\theta(s,0),Q_\theta(s,1)].
\]

这种表示能泛化，也让一次更新可能改变许多状态的预测。后一个性质提高了数据效率，同时带来训练目标不断移动、样本相关和估计误差相互放大的风险。

## QNetwork 的张量流

### 三层线性网络

真实网络结构为：

```python
self.net = nn.Sequential(
    nn.Linear(state_dim, 128),
    nn.ReLU(),
    nn.Linear(128, 128),
    nn.ReLU(),
    nn.Linear(128, action_dim),
)
```

单状态在 `select_action` 中先执行 `unsqueeze(0)`，形状从 `[4]` 变为 `[1, 4]`。经过网络后得到 `[1, 2]`，`argmax(dim=1).item()` 返回 Python 动作整数。

训练批次大小默认是 \(B=64\)，形状依次为：

| 对象 | 形状 | 数据类型 | 含义 |
| --- | --- | --- | --- |
| `states` | `[B, 4]` | `float32` | 当前状态 |
| `actions` | `[B]` | `int64` | 实际动作索引 |
| `rewards` | `[B]` | `float32` | 即时奖励 |
| `next_states` | `[B, 4]` | `float32` | 下一状态 |
| `dones` | `[B]` | `float32` | 真实终止掩码 |
| `q_net(states)` | `[B, 2]` | `float32` | 每个动作的预测 |
| `q_values` | `[B]` | `float32` | 实际动作的预测 |
| `targets` | `[B]` | `float32` | 贝尔曼目标 |

### `gather` 选择哪一列

网络为每条状态输出两列，但一次转移只执行了一个动作。代码为：

```python
all_q = self.q_net(states)
q_values = all_q.gather(1, actions.unsqueeze(1)).squeeze(1)
```

假设 \(B=3\)：

```text
all_q = [[1.2, 2.0],
         [3.1, 2.7],
         [0.4, 0.9]]
actions = [1, 0, 1]
```

`actions.unsqueeze(1)` 的形状是 `[3,1]`，内容为 `[[1],[0],[1]]`。`gather(1, ...)` 沿动作维选列，得到 `[[2.0],[3.1],[0.9]]`；`squeeze(1)` 后成为 `[2.0,3.1,0.9]`。损失只直接监督这些实际执行动作的值。

## 经验回放把轨迹变成训练集

### 缓冲区保存什么

`ReplayBuffer` 用容量 10000 的 `deque` 保存五元组：

\[
(s_t,a_t,r_{t+1},s_{t+1},d_{t+1}).
\]

容量满后最旧样本自动移除。`random.sample` 无放回抽取一个批次，并把状态与下一状态转为 `float32`、动作转为 `int64`、奖励与终止标记转为 `float32`。

连续轨迹中的相邻状态高度相关。若按发生顺序立刻反复训练，梯度方向会被当前轨迹片段主导。随机回放打乱时间顺序，并让一条经验可能参与多次更新。它降低相关性，但有限缓冲区中的数据仍来自逐渐变化的行为策略，不能严格视为独立同分布样本。

### 何时开始学习

`update` 在 `len(buffer) < batch_size` 时返回 `0.0`。因此默认前 63 条转移只收集、不反向传播；第 64 条后每个环境步都采样 64 条并更新一次。

这个最小实现没有单独的 `learning_starts` 预热参数。早期缓冲区很小，许多批次来自少量相近轨迹。更完整的实现通常先积累几千条经验，再开始优化。

## 目标网络稳定自举目标

### DQN 目标

对批次中的第 \(i\) 条转移，目标为

\[
y_i=r_i+\gamma(1-d_i)\max_{a'}Q_{\bar\theta}(s'_i,a').
\]

\(r_i\) 是奖励，\(\gamma=0.99\)，\(d_i\in\{0,1\}\) 是终止标记，\(\bar\theta\) 是目标网络参数。当前网络参数记为 \(\theta\)，其预测是 \(Q_\theta(s_i,a_i)\)。

批次均方误差为

\[
L(\theta)=\frac1B\sum_{i=1}^{B}\left(Q_\theta(s_i,a_i)-y_i\right)^2.
\]

`torch.no_grad()` 包围目标计算，梯度只通过 `q_net` 的当前预测传播。Adam 更新 `q_net` 后，目标网络不会立刻变化。

### 一个目标值的数值推演

若 `reward=1`、下一状态目标网络输出 `[3.5,4.0]`、`gamma=0.99`：

- 非终止转移的目标为 \(1+0.99\times4.0=4.96\)；
- 终止转移的 `done=1`，目标为 \(1+0.99\times4.0\times0=1\)。

假设当前预测是 3.0，非终止样本的平方误差为 \((3.0-4.96)^2=3.8416\)。真实批次损失会再对 64 条样本取平均。

### 为什么需要另一组参数

若目标也由正在每一步更新的 `q_net` 产生，梯度刚改变预测，下一批监督目标也随之移动。代码创建结构相同的 `target_net`，初始化时硬复制一次，并每 10 个回合执行：

```python
self.target_net.load_state_dict(self.q_net.state_dict())
```

在两次复制之间，\(\bar\theta\) 固定，优化对象更稳定。更新太频繁会重新接近“追逐自己”；间隔太长会让目标滞后。当前频率按回合计数，所以每次复制之间的环境步数会随回合长度变化。

### 梯度裁剪

反向传播后，代码调用：

```python
torch.nn.utils.clip_grad_norm_(self.q_net.parameters(), max_norm=10)
```

当所有参数梯度的整体范数超过 10 时，它们会按比例缩小。裁剪限制极端 TD 误差造成的单次更新，不会修复错误奖励、错误终止掩码或系统性目标偏差。

## `terminated` 与 `truncated` 的语义

Gymnasium 的 `step` 返回：

```python
next_state, reward, done, truncated, _ = env.step(action)
```

这里变量名 `done` 实际接收的是 `terminated`：系统进入任务定义的终止状态，例如杆角或小车位置越界。`truncated` 表示外部限制截断了轨迹，CartPole 常见情形是达到时间上限。

主循环保存的是：

```python
agent.buffer.push(state, action, reward, next_state, float(done))
```

它只把 `terminated` 写入回放缓冲区，却在 `done or truncated` 时结束回合。结果是：

- 真正终止的转移令 `d=1`，目标停止自举；
- 时间上限截断的转移令 `d=0`，仍从 `next_state` 自举；
- 无论哪种情况，采样循环都会重置环境。

若时间限制只是采样边界，底层任务本来可以继续，保留自举可以避免把“时间到了”误当作价值为零。若你的任务明确把固定时域结束定义为终止，掩码就应包含截断。关键是先写清任务语义，再决定：

```python
terminal_for_target = terminated
# 或在固定时域本身属于任务定义时：
terminal_for_target = terminated or truncated
```

不要仅把两个标记机械合并，也不要让含糊的变量名替你作决定。更清楚的写法应直接命名为 `terminated, truncated`。

## 一次完整训练怎样运转

每回合先 `env.reset()`，随后以 ε-贪心选动作、存转移、更新网络。ε 从 1.0 开始，每回合乘 0.995，最低为 0.01。500 回合后的乘积约为 0.0816，所以默认训练结束时仍有约 8% 的随机动作分支。

每 10 回合同步目标网络，每 50 回合报告最近 50 回合平均奖励。测试阶段把 ε 设为 0，运行 10 回合。训练奖励同时受探索率影响，测试奖励更接近当前贪心策略性能；测试只有 10 回合，方差估计仍较粗。

脚本最后只保存 `q_net.state_dict()`。它没有保存目标网络、优化器、ε、回放缓冲区或训练回合数，因此该文件适合推理，不能无损恢复训练过程。

## Double DQN 分离选择与评估

### 最大值带来的过估计

每个动作估计都含噪声。对多个带噪声估计取最大值，更容易选中被高估的那个动作。标准 DQN 的目标网络同时完成“选择最大动作”和“给这个动作估值”：

\[
y^{DQN}=r+\gamma Q_{\bar\theta}\left(s',\arg\max_aQ_{\bar\theta}(s',a)\right).
\]

Double DQN 让在线网络选择动作，目标网络评估该动作：

\[
a^*=\arg\max_aQ_\theta(s',a),
\]

\[
y^{DDQN}=r+\gamma Q_{\bar\theta}(s',a^*).
\]

对应实现位于 [`double_dqn_cartpole.py`](./double_dqn_cartpole.py)：

```python
best_actions = self.q_net(next_states).argmax(dim=1, keepdim=True)
next_q_values = self.target_net(next_states).gather(1, best_actions).squeeze(1)
```

若在线网络给出 `[5.0,4.8]`，目标网络给出 `[4.2,4.6]`，Double DQN 先按在线网络选动作 0，再用目标网络取 4.2。标准 DQN 直接取目标网络最大值 4.6。分离两步降低同一估计误差同时控制选择和评价的机会，不能保证每个样本的目标都更小或训练一定更快。

### 为什么一条对比曲线不能下结论

对比脚本依次训练一个 DQN 和一个 Double DQN，各运行一次，没有设置 Python、NumPy、PyTorch 和环境随机种子。两个智能体的初始化、探索动作、回放采样和环境轨迹都不同，后训练的算法还继续消耗同一进程的全局随机流。

因此该图只能演示代码路径。可靠比较至少需要：

1. 选择 10 至 30 个种子；
2. 每个种子分别重置 `random`、NumPy、PyTorch、环境及动作空间；
3. 两算法使用同一组种子和相同评价回合；
4. 分离训练环境与评价环境，评价时 ε 为 0；
5. 报告每种子最终窗口均值，再汇总均值与置信区间。

可以先运行原始演示，观察实现差异，但不要把单次末 50 回合均值写成性能结论：

```bash
python chapter04_dqn/double_dqn_cartpole.py
```

## 参数实验与预期观察

### 回放容量与预热

比较容量 1000、10000、50000，并增加明确的 `learning_starts`。小缓冲区更快遗忘旧策略数据，也更容易被近期轨迹支配；大缓冲区保留更多覆盖范围，同时包含更陈旧的数据。先收集 1000 条再训练，通常会让早期批次更多样。

### 目标更新间隔

比较每 1、10、50 回合同步。记录损失、训练奖励和独立评价奖励。频繁同步可能让目标波动更快；过慢同步可能降低学习速度。由于这里按回合同步，还应记录实际环境步数。

### 损失函数

把 `nn.MSELoss()` 换成 `nn.SmoothL1Loss()`。Huber 型损失在误差较大时近似线性，通常降低异常 TD 误差的影响。预期是损失数值尺度和梯度尖峰改变，最终奖励未必在每个种子上提升。

### 探索日程

比较按回合衰减与按环境步衰减。回合越长时，按回合方案会让同一 ε 持续更多步；按步方案能让不同训练运行拥有更可比的探索预算。

## 从 CartPole 扩展到像素与游戏

同目录还提供 [`dqn_atari_sb3.py`](./dqn_atari_sb3.py) 和 [`dqn_pokemon_red_pyboy.py`](./dqn_pokemon_red_pyboy.py)。它们用于理解工程扩展，不是完成本章的必跑项。

Atari 脚本默认使用 `ALE/Pong-v5`、84×84 图像、4 帧堆叠、100000 容量回放和 100000 步预热，总训练步数默认 100 万。未启用内存优化时，当前帧与下一帧回放可能消耗数 GB 内存；训练时间也远高于 CartPole，GPU 能加速网络训练，环境模拟仍有 CPU 成本。先用小步数做管线检查，不能把短跑结果当作收敛结果。

Atari 环境依赖 ALE 及对应游戏内容。安装 Python 包不自动赋予游戏 ROM 的使用权；只使用你有权使用的游戏文件，并遵守所在地法律和内容许可。本教程不提供 ROM、下载地址或绕过检查的方法。

Pokémon 脚本明确不分发 ROM、模拟器状态或预训练权重。它要求用户提供合法获得的 Pokémon Red ROM，可选提供已过开场菜单的 PyBoy 状态，并默认校验特定 ROM 的 SHA1。奖励由画面与内存地址构造，默认训练 500000 步。这是早期区域探索基线，不能据此声称学会完整游戏。ROM、状态文件和训练产物都不应加入教程或版本库。

## 教学实现的边界

- 网络与回放都在 CPU 上创建，没有设备迁移；
- 没有标准化连续状态，也没有显式预热阶段；
- 目标网络按回合硬更新，间隔对应的步数不固定；
- 使用 MSE 和梯度裁剪，没有优先经验回放或 n 步回报；
- 只把 `terminated` 存为终止掩码，变量名 `done` 容易混淆；
- 没有完整 checkpoint、训练恢复或系统随机种子；
- 单次 Double DQN 对比只能展示机制；
- Atari 与 Pokémon 脚本有显著资源和内容授权前提。

DQN 仍通过 \(\max_a Q(s,a)\) 间接得到动作。下一章会让网络直接输出动作概率，并从采样到的整条轨迹推导策略梯度。

## 自测

### 题目

1. 批次大小 64 时，`q_net(states)`、`actions.unsqueeze(1)` 和最终 `q_values` 的形状分别是什么？
2. 奖励为 1、下一状态最大目标 Q 为 5、\(\gamma=0.9\)、`done=0` 时，目标是多少？`done=1` 时呢？
3. 为什么目标网络也必须放在 `torch.no_grad()` 中？
4. 时间上限截断时只存 `terminated` 会产生什么目标？
5. Double DQN 的两个网络分别承担哪一步？
6. 为什么同一个种子只跑一次仍不足以比较 DQN 与 Double DQN？

### 参考答案

1. 分别是 `[64,2]`、`[64,1]` 和 `[64]`。
2. 非终止目标为 \(1+0.9\times5=5.5\)；终止目标为 1。
3. 目标只作为监督值，若保留计算图，梯度会流入目标分支并增加内存；优化器本来也只应更新在线网络。
4. 缓冲区中的掩码为 0，目标保留 \(\gamma\max Q(s',a')\) 自举项。
5. 在线网络用 `argmax` 选择下一动作，目标网络评估该动作的价值。
6. 随机初始化、探索、采样和环境轨迹仍能造成巨大偶然差异；需要一组种子的结果分布与独立评价。
