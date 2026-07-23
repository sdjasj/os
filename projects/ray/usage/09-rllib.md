# 09. RLlib：强化学习

## 1. RLlib 适合什么

强化学习的基本闭环是：策略观察环境状态，选择动作，环境返回下一状态和奖励，算法根据轨迹更新策略。RLlib 提供：

- PPO、DQN、SAC 等算法实现；
- 单智能体和多智能体环境；
- 并行 EnvRunner 采样；
- 一个或多个 Learner/GPU 学习；
- RLModule 模型接口；
- 评估、检查点和恢复；
- 与 Tune 的实验管理集成；
- 离线数据与外部环境支持。

安装：

```bash
python -m pip install "ray[rllib]" torch gymnasium
```

如果只是监督学习或数据并行训练，使用 Ray Train；只有问题明确包含环境、动作、奖励和策略优化时才使用 RLlib。

## 2. 关键组件

```text
Algorithm
  ├─ EnvRunnerGroup
  │    ├─ EnvRunner 0 → 一个或多个环境 → 轨迹样本
  │    └─ EnvRunner N → 一个或多个环境 → 轨迹样本
  ├─ LearnerGroup
  │    └─ Learner / RLModule / Optimizer
  ├─ Evaluation EnvRunners
  └─ Checkpoint / Metrics
```

- **Environment**：定义 observation、action、reward、termination；
- **EnvRunner**：与环境交互并收集样本；
- **RLModule**：策略网络及前向接口；
- **Learner**：根据批数据更新 RLModule；
- **AlgorithmConfig**：组合环境、采样、训练、资源、评估配置；
- **Algorithm**：实际运行训练、评估、保存和恢复的对象。

## 3. 最小 PPO 示例

```python
from pprint import pprint
from ray.rllib.algorithms.ppo import PPOConfig

config = (
    PPOConfig()
    .environment("CartPole-v1")
    .env_runners(num_env_runners=2)
    .training(lr=3e-4)
)

algorithm = config.build_algo()

for _ in range(3):
    result = algorithm.train()
    pprint(result)

checkpoint_path = algorithm.save_to_path()
print(checkpoint_path)
algorithm.stop()
```

完整示例见 [`examples/rllib_ppo.py`](examples/rllib_ppo.py)。当前仓库使用新的 API stack 和 `build_algo()`；较老教程可能出现 `.rollouts()`、`num_rollout_workers` 或 `.build()`，不要混用不同代际配置。

## 4. 自定义 Gymnasium 环境

```python
import gymnasium as gym
from gymnasium.spaces import Box, Discrete
import numpy as np

class SimpleEnv(gym.Env):
    def __init__(self, config=None):
        self.observation_space = Box(-1.0, 1.0, shape=(1,), dtype=np.float32)
        self.action_space = Discrete(2)
        self.position = 0.0

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.position = 0.0
        return np.array([self.position], dtype=np.float32), {}

    def step(self, action):
        self.position += 0.1 if action == 1 else -0.1
        terminated = abs(self.position) >= 1.0
        truncated = False
        reward = 1.0 if self.position >= 1.0 else -0.01
        observation = np.array([self.position], dtype=np.float32)
        return observation, reward, terminated, truncated, {}
```

Gymnasium 的 `reset` 返回 `(observation, info)`，`step` 返回五元组。旧 Gym 四元组接口会导致兼容错误。

配置环境：

```python
config = PPOConfig().environment(SimpleEnv, env_config={"difficulty": 2})
```

环境类必须能在远端 Worker 导入。不要在环境构造函数中依赖只在 Driver 本地的全局对象或不可序列化连接。

## 5. 环境采样扩展

```python
config.env_runners(
    num_env_runners=4,
    num_envs_per_env_runner=8,
)
```

两种并行：

- 增加 `num_env_runners`：更多 Ray Actor，可跨核/节点；
- 增加每 EnvRunner 的环境数：在同一进程内向量化环境。

选择取决于环境代价：

- 环境 step 很重、可并行：增加 EnvRunner；
- 模型推理可批处理、环境较轻：增加向量化环境；
- 样本生成远快于学习：继续加 EnvRunner 没用；
- 学习器等待样本：检查采样吞吐、批大小和网络。

## 6. 训练与 Learner 资源

当前新 API stack 使用 Learner 相关配置扩展学习。具体参数会随算法和版本演进，基本原则是：

- 先在单 Learner/单 GPU 验证算法收敛；
- 再增加 Learner 或 GPU；
- 检查训练 batch、minibatch、epoch 和学习率随规模变化；
- 同时测量采样吞吐与学习吞吐；
- 不要只追求 samples/s，最终目标是单位时间/成本的策略质量。

示例训练参数：

```python
config.training(
    lr=2e-4,
    train_batch_size_per_learner=2000,
    num_epochs=10,
)
```

不同算法的有效参数不同，使用对应 `PPOConfig`、`DQNConfig` 等类型可以更早发现无效字段。

## 7. 训练结果

```python
result = algorithm.train()
```

结果字典包含采样、学习、计时、容错和资源统计。字段层次会随 API stack 版本变化，开发时先 `pprint(result)`，再选择需要持久化的字段，不要盲目复制旧版本路径。

至少关注：

- episode return 的均值和分布；
- episode length；
- environment steps / agent steps；
- 采样和学习吞吐；
- policy loss、value loss、entropy、KL 等算法指标；
- 采样 Worker 重启/失败；
- 评估环境指标，而非只看训练采样。

多智能体中要区分各 policy 指标和聚合指标。

## 8. 独立评估

```python
config.evaluation(
    evaluation_interval=1,
    evaluation_num_env_runners=2,
    evaluation_duration=10,
    evaluation_duration_unit="episodes",
)
```

训练探索策略和真实部署策略可能不同，独立评估可使用固定随机种子、无探索动作和不同环境配置。不要用参与训练更新的同一批轨迹作为唯一性能结论。

强化学习方差大，应该报告多个 seed 和置信区间，而不是单次最高回报。

## 9. Checkpoint 与恢复

```python
checkpoint_path = algorithm.save_to_path("/shared/checkpoints/ppo")
```

恢复方式应依据当前 `Algorithm`/Checkpoint API；常见流程是从同类型 Algorithm 配置构建并恢复状态。检查点必须放在所有恢复节点可访问的持久存储，并记录：

- 环境代码和版本；
- RLlib/Ray/框架版本；
- AlgorithmConfig；
- observation/action space；
- 自定义 RLModule；
- 训练步和随机种子。

只保存神经网络权重与保存完整 Algorithm 状态不同。继续训练通常还需要 optimizer、计数器和调度状态。

## 10. 与 Tune 结合

RLlib Algorithm 类兼容 Tune。示意：

```python
from ray import tune
from ray.rllib.algorithms.ppo import PPOConfig

config = (
    PPOConfig()
    .environment("CartPole-v1")
    .training(lr=tune.loguniform(1e-5, 1e-3))
)

tuner = tune.Tuner(
    "PPO",
    param_space=config.to_dict(),
    tune_config=tune.TuneConfig(num_samples=8),
)
results = tuner.fit()
```

实际实验还应配置停止条件、指标、模式、每 Trial 资源、检查点和持久存储。不同 RLlib 版本对字符串 Trainable 和 Config 的推荐组合可能变化，优先参考当前仓库 [`getting-started.rst`](../doc/source/rllib/getting-started.rst) 的 Tune 小节。

## 11. 多智能体

多智能体系统需要定义：

- 哪些 agent 出现在环境中；
- 每个 agent 使用哪一个 policy；
- policy 是否共享；
- observation/action space 是否相同；
- 奖励是个体还是团队；
- agent 动态加入/退出如何表示。

policy mapping function 将 agent ID 映射到 policy ID。它必须稳定、可序列化，并避免每步做昂贵外部查询。多智能体是 RLlib 的重要能力，但调试难度远高于单智能体；先让单环境、单 policy 的接口和奖励正确，再扩展。

## 12. RLModule 自定义

RLModule 是新 API stack 中承载策略模型的核心接口，区分探索、推理和训练前向路径。自定义时要明确：

- 输入/输出规格；
- action distribution 参数；
- recurrent/attention 状态；
- inference 与 exploration 差异；
- Learner 需要的额外输出；
- Checkpoint 可恢复性。

不要沿用旧版 ModelV2 教程去实现新 API stack，除非明确启用了旧栈兼容路径。

## 13. 常见错误

- Gymnasium `step` 仍返回旧四元组；
- 环境无法在 Worker import；
- reward scale、termination 或 observation dtype 错误；
- 一开始就多节点，掩盖环境本身的 bug；
- 盲目增加 EnvRunner，Learner 已经是瓶颈；
- 只看训练 return，不做独立评估；
- 混用旧 `.rollouts()` 与新 `.env_runners()` API；
- 多智能体 policy mapping 不稳定；
- Checkpoint 只有权重，恢复训练时缺 optimizer 状态；
- 单个 seed 得出算法优劣结论。

## 14. 推荐实践顺序

1. 用 Gymnasium 自带 checker 验证环境。
2. 单环境随机动作跑通 reset/step/termination。
3. `num_env_runners=0` 或最小本地设置跑短训练。
4. 检查 reward、episode length 和模型输出。
5. 添加独立评估和 Checkpoint。
6. 增加 EnvRunner/向量环境，定位采样瓶颈。
7. 再扩 Learner/GPU。
8. 最后用 Tune 做系统超参数搜索。

## 15. 本章对应的项目代码

- 当前入门：[`../doc/source/rllib/getting-started.rst`](../doc/source/rllib/getting-started.rst)
- 算法配置：[`../rllib/algorithms/algorithm_config.py`](../rllib/algorithms/algorithm_config.py)
- PPO：[`../rllib/algorithms/ppo`](../rllib/algorithms/ppo)
- 环境：[`../rllib/env`](../rllib/env)
- RLModule：[`../rllib/core/rl_module`](../rllib/core/rl_module)
- 多智能体：[`../doc/source/rllib/multi-agent-envs.rst`](../doc/source/rllib/multi-agent-envs.rst)

下一章把这些功能放到本地多进程、多机、VM 和 Kubernetes 集群中运行。
