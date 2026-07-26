# 01. 运行基础：Python、PyTorch、Gymnasium 与第一次 CartPole

这一章解决一个先于算法的问题：仓库里的训练脚本究竟在操作哪些对象？
如果不能区分 NumPy 数组、PyTorch 张量、环境状态和动作分布，后续公式即使能背下来，也很难映射到代码。
我们先补足最小背景，再用 Stable-Baselines3 版 CartPole 跑通第一条闭环。

本章的源码路径以[代码索引](README.md)所在的 `code/` 目录为语境。
所有命令都假定当前工作目录是上游仓库的 `code/`。

## 环境准备：按章安装依赖

项目提供[全局依赖文件](requirements.txt)，但它更像依赖汇总，不是所有脚本都经过统一锁定的完整环境。
固定快照中至少有几类例外：

- CartPole 日志使用 SwanLab，而全局文件没有列出它；
- Actor-Critic 与 PPO 的 GIF 脚本需要 `imageio`，全局文件没有列出它；
- Agentic RL 的合成数据脚本导入 `openai`，对应章节依赖也没有列出它；
- Box2D、MuJoCo、Atari 和 PyBoy 带有额外系统或数据要求；
- LLM 章节固定了若干 Hugging Face 包版本，与任意已有环境混装可能冲突。

因此，第一次实验只安装[第 1 章依赖](chapter01_cartpole/requirements.txt)：

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r chapter01_cartpole/requirements.txt
```

Windows PowerShell 激活命令不同，但“创建独立环境、用当前 Python 调用 pip”这两个原则不变。
使用 `python -m pip` 可以减少 `pip` 指向另一个解释器的歧义。

安装后先做导入检查：

```bash
python - <<'PY'
import gymnasium
import numpy
import stable_baselines3
import swanlab
import torch

print("gymnasium", gymnasium.__version__)
print("numpy", numpy.__version__)
print("torch", torch.__version__)
print("cuda available", torch.cuda.is_available())
PY
```

CartPole 首跑不需要 GPU；打印 CUDA 状态只是确认设备语境，结果为 `False` 不应中止实验。

## Python：先看清对象的生命周期

强化学习脚本通常有三类对象：

- 环境对象保存物理状态，并通过 `reset()`、`step()` 推进；
- 模型对象保存参数，并通过前向计算产生动作分数或状态价值；
- 优化器对象保存动量等训练状态，并根据梯度修改模型参数。

类把长期状态和操作状态的方法放在一起。
环境的物理状态、模型权重和优化器动量会跨函数调用保存；观测和一个 batch 则是本次调用的输入。
Gymnasium 返回固定位置的元组，轨迹代码常用字典给字段命名：

```python
observation, info = env.reset()
next_observation, reward, terminated, truncated, info = env.step(action)
transition = {
    "observation": observation,
    "action": action,
    "reward": float(reward),
    "terminated": bool(terminated),
    "truncated": bool(truncated),
}
```

读代码时先列出每个字段的类型与形状，再看更新公式。
大量训练错误来自边界类型不一致，例如把零维张量、NumPy 标量和 Python `int` 混在同一条路径。

## NumPy：状态、批次与广播

CartPole 的单个观测包含四个浮点数：小车位置、小车速度、杆角度和杆角速度。
一条观测通常具有形状 `[4]`；收集 `B` 条以后，批次形状是 `[B, 4]`。

```python
import numpy as np
observation = np.array([0.02, -0.11, 0.03, 0.20], dtype=np.float32)
batch = np.stack([observation, observation * 0.5])  # [2, 4]
per_sample = batch.mean(axis=-1)                    # [2]
per_feature = batch.mean(axis=0)                    # [4]
```

形状决定运算含义：最后一维聚合每条样本，沿第 0 维聚合整个批次。
后续看到 `axis`、`dim`、`unsqueeze`、`squeeze` 或 `gather` 时，应在旁边写出变化前后的形状；API 名称本身不足以说明运算含义。

## PyTorch：从张量到参数更新

### 张量形状与网络输出

NumPy 主要承担环境数据整理，PyTorch 张量则参与自动微分。
CartPole 上常见的形状关系是：

| 对象 | 单样本 | 批次 |
| --- | --- | --- |
| 观测 | `[4]` | `[B, 4]` |
| 两个动作的 logits 或 Q 值 | `[2]` | `[B, 2]` |
| 离散动作索引 | 标量 | `[B]` |
| 状态价值 | 标量 | `[B]` 或 `[B, 1]` |
| 每步奖励、回报、优势 | 标量 | `[B]` |

最小策略网络把 `[B, 4]` 映射为 `[B, 2]`：

```python
import torch
from torch import nn

policy = nn.Sequential(
    nn.Linear(4, 32),
    nn.Tanh(),
    nn.Linear(32, 2),
)

observations = torch.zeros(8, 4)
logits = policy(observations)
assert logits.shape == (8, 2)
```

最后两个数是动作分数；策略还要把它们解释为分布，再采样或选取最大项。

### 自动微分

PyTorch 会记录由需要梯度的张量参与的运算。
`backward()` 从标量损失反向计算导数：

```python
w = torch.tensor(2.0, requires_grad=True)
loss = (w - 5.0) ** 2
loss.backward()

print(w.grad)  # -6
```

梯度只说明局部方向。
训练循环还要依次调用优化器的 `zero_grad()`、损失的 `backward()` 和优化器的 `step()`。
PyTorch 默认累加梯度，所以基础脚本通常在每个更新批次先清空旧梯度。

### `no_grad()`、`detach()` 与 `item()`

三个操作都可能出现在张量离开训练图的位置，作用不同：

- `torch.no_grad()`：在整个代码块中不构建梯度图，适合选动作、评估和计算固定目标；
- `tensor.detach()`：得到共享数据但停止向原张量传播梯度的张量，适合切断某一条分支；
- `tensor.item()`：把只含一个元素的张量转为 Python 标量，转换后不再有设备和梯度信息。

DQN 的目标分支和策略评估不需要梯度；若在损失形成前过早调用 `detach()` 或 `item()`，学习信号会被切断。

## 动作分布：`Categorical` 与 `log_prob`

离散策略输出两个 logits 后，可以构造分类分布：

```python
from torch.distributions import Categorical

logits = torch.tensor([0.2, 1.1])
distribution = Categorical(logits=logits)
action = distribution.sample()
log_probability = distribution.log_prob(action)

print(distribution.probs)
print(action.shape)           # 零维张量
print(log_probability.shape)  # 零维张量
```

`sample()` 保留随机性，适合训练时探索。
`argmax` 选择概率最大的动作，适合确定性评估。
`log_prob(action)` 给出模型对实际动作分配的对数概率，后续 REINFORCE 和 PPO 都用它构造策略损失。

对数概率还能把一串 token 或动作的概率乘积转为对数和：

\[
\log \prod_t \pi(a_t\mid s_t)=\sum_t \log \pi(a_t\mid s_t).
\]

这一点连接经典控制与大模型生成：语言模型每次从词表分类分布中选择一个 token。

## Gymnasium：正确处理回合边界

### `reset()` 与 `step()`

一个最小交互循环如下：

```python
import gymnasium as gym

env = gym.make("CartPole-v1")
observation, info = env.reset(seed=0)
episode_return = 0.0

while True:
    action = env.action_space.sample()
    observation, reward, terminated, truncated, info = env.step(action)
    episode_return += float(reward)
    if terminated or truncated:
        break

env.close()
print(episode_return)
```

`info` 保存额外诊断信息，不应被当作固定结构。
不同环境和 wrapper 可以添加不同字段。

### `terminated` 与 `truncated`

二者都要求当前 episode 停止，但学习含义不同：

- `terminated=True` 表示环境定义的终止状态，例如杆子倒下；该状态之后没有同一 episode 的未来价值；
- `truncated=True` 表示时间上限或外部限制截断了轨迹；环境本身未必进入终止状态。

价值目标因此应区分二者：

```python
episode_done = terminated or truncated
bootstrap_multiplier = 0.0 if terminated else 1.0
target = reward + gamma * bootstrap_multiplier * next_value
```

`episode_done` 决定何时重置环境，`bootstrap_multiplier` 决定是否保留下一状态价值。
把二者都压成一个 `done` 会让时间截断处错误地把价值设为零；反过来忽略截断，又可能把重置后的新 episode 接到旧轨迹上。

## 随机种子与独立评估

### 固定随机性来源

一次经典 RL 实验至少涉及 Python、NumPy、PyTorch、环境和动作空间的随机性：

```python
import random
import numpy as np
import torch

def seed_experiment(env, seed):
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    env.action_space.seed(seed)
    observation, info = env.reset(seed=seed)
    return observation, info
```

固定种子提高可复现性，却不保证所有设备和并行库逐位确定。
研究结论仍应来自多个种子的完整分布；一条最好曲线不构成稳定性证据。

### 训练环境与评估环境分离

训练策略含探索，训练奖励也受采样分布影响。
评估应创建独立环境，禁用参数更新，并在预先固定的一组种子上运行确定性策略。

至少分开记录：

- 训练环境步数；
- 训练期间的滚动回合奖励；
- 独立评估的平均回报与标准差；
- 成功率或任务专属指标；
- 评估回合数和种子集合。

训练损失下降不能替代任务评估。
强化学习的目标还会随策略改变而改变，损失曲线往往不像监督学习那样单调。

## 工作目录决定产物位置

固定快照中的许多脚本直接使用相对路径 `output/`、`swanlog/` 或模型目录。
从 `code/` 运行可以让产物集中在可预期位置：

```bash
python chapter01_cartpole/1-ppo_cartpole.py
find output -maxdepth 2 -type f
```

若从别的目录调用同一个脚本，相对输出可能写到当前目录，因此记录必须包含工作目录和命令。

模型权重、日志、缓存和虚拟环境属于本地产物，不应提交进教程目录。

## 第一次 CartPole：先观察闭环

### 运行 SB3 版本

[SB3 CartPole 脚本](chapter01_cartpole/1-ppo_cartpole.py)是首跑主线：

```bash
python chapter01_cartpole/1-ppo_cartpole.py
```

训练阶段默认无图形渲染，结束后会：

1. 输出观测空间、动作空间和终止阈值；
2. 用 PPO 采集数据并更新策略；
3. 在 10 个回合上调用独立评估工具；
4. 把模型保存到 `output/ppo_cartpole`；
5. 运行若干确定性演示回合并打印得分；
6. 把本地训练指标写入 SwanLab 日志。

需要桌面图形环境时才运行 `python chapter01_cartpole/1-ppo_cartpole.py --gui`。

无头服务器不应使用 GUI 作为训练是否成功的判断条件。
平均回报和保存产物已经足够验证闭环。

### 首跑只回答五个问题

此时先不要追 PPO 内部实现，只记录：

1. 一个观测为什么有四个数？
2. 环境为什么只有两个离散动作？
3. 单步奖励如何累积成回合奖励？
4. 训练日志中的回合奖励在何时开始明显上升？
5. 训练滚动奖励与训练后确定性评估是否一致？

指标含义可对照[第 1 章指标页](../docs/chapter01_cartpole/metrics.md)。
算法公式将在 PPO 章节集中解释。

### 纯 PyTorch 版本的动作边界

[纯 PyTorch PPO 脚本](chapter01_cartpole/2-pytorch_ppo.py)把网络、轨迹、GAE 和裁剪更新全部展开，适合学完 Actor-Critic 与 PPO 后重读。
它不作为第一次运行主线。

固定快照中的 `get_action` 在随机采样和确定性选择两条路径上都返回零维 PyTorch 张量。调用处用 `action.item()` 把它转换为 Gymnasium 接受的 Python 整数，同时把同一个动作以整数形式写入轨迹。这是一次正常的框架边界转换：策略分布计算 `log_prob` 时需要张量索引，环境接口需要普通整数。

如果重构动作接口，应明确约定返回类型，并只在环境边界转换一次。例如：

```python
def to_python_action(action):
    if isinstance(action, torch.Tensor):
        return int(action.item())
    return int(action)
```

重构后应以一个短 rollout 同时覆盖随机动作和确定性动作路径，检查环境收到的值是整数，轨迹中的动作仍能恢复为训练所需的张量。

## 本章检查点

进入下一章前，请确认你能：

- 写出单观测和批次观测的形状；
- 解释 logits、概率、动作索引和 `log_prob` 的关系；
- 说明 `no_grad()`、`detach()` 和 `item()` 的不同作用；
- 分别说明 `terminated`、`truncated` 对重置和 bootstrap 的影响；
- 固定环境、NumPy 与 PyTorch 的随机种子；
- 从 `code/` 运行首个 CartPole 实验并找到输出；
- 解释为什么按章安装依赖比一次安装全局汇总更稳妥；
- 说明训练奖励、训练损失和独立评估各自能证明什么。

下一章把连续的环境状态暂时拿掉，从多臂老虎机开始研究探索与利用。
