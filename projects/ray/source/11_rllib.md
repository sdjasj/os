# 11. RLlib 强化学习系统

## 11.1 先补足强化学习循环

Agent 在环境中反复：观察 `obs` → 选择动作 `action` → 环境返回 `reward, next_obs, terminated/truncated`。训练系统需要同时解决：

- 大量环境交互采样；
- observation/action 的预处理与后处理；
- 策略/价值网络推理；
- trajectory/episode 组批；
- loss、梯度和参数更新；
- 新权重同步回采样进程；
- 多智能体映射与 checkpoint。

RLlib 是完整的分布式 RL execution system，不只是 PPO loss 实现。

## 11.2 当前新 API stack 的核心组件

| 组件 | 责任 | 典型源码 |
|---|---|---|
| `AlgorithmConfig` | 声明环境、采样、训练、资源和评估 | `rllib/algorithms/algorithm_config.py` |
| `Algorithm` | 顶层控制循环、组件生命周期、checkpoint | `rllib/algorithms/algorithm.py` |
| `EnvRunner` | 与一个/多个环境交互并产出 episodes | `rllib/env/` |
| `ConnectorV2` | env 数据 ↔ module 输入、learner batch 转换 | `rllib/connectors/` |
| `RLModule` | 框架原生的推理/探索/训练 forward | `rllib/core/rl_module/` |
| `Learner` | loss、optimizer、梯度更新 | `rllib/core/learner/` |
| `LearnerGroup` | 一个或多个 Learner 的分布式执行 | `rllib/core/learner/learner_group.py` |
| `EnvRunnerGroup` | 本地/远程 EnvRunner 管理和容错 | `rllib/env/env_runner_group.py` |

旧 API stack 的 `Policy`、`RolloutWorker`、旧 Connector 仍存在于仓库。看到同一算法两条分支时先找 `enable_env_runner_and_connector_v2`，不要拼接新旧内部类型。

## 11.3 最小 PPO

```python
from ray.rllib.algorithms.ppo import PPOConfig

config = (
    PPOConfig()
    .environment("CartPole-v1")
    .env_runners(num_env_runners=1)
    .learners(num_learners=0)
    .training(
        lr=5e-4,
        train_batch_size_per_learner=1024,
        minibatch_size=128,
    )
)

algo = config.build_algo()
for _ in range(3):
    result = algo.train()
    print(result["env_runners"]["episode_return_mean"])

algo.stop()
```

API 参数会演进；本例用于理解对象关系，运行时以当前 [PPOConfig](../rllib/algorithms/ppo/ppo.py) 和官方示例为准。

## 11.4 Config builder 做了什么

`PPOConfig` 继承 `AlgorithmConfig`，设置 PPO 默认超参并实现：

- `get_default_rl_module_spec`；
- `get_default_learner_class`；
- PPO-specific `training` 配置；
- validation。

`AlgorithmConfig.build_algo` 最终执行：

```python
return algo_class(config=copy.deepcopy(self))
```

Config 不是普通随意字典：它分组校验环境、framework、resources、multi-agent、evaluation、offline 和新 API stack，并在 Algorithm 使用时 freeze，避免运行中被无意修改。

## 11.5 Algorithm 初始化

[algorithm.py](../rllib/algorithms/algorithm.py) 的 `setup` 按 config 建立：

1. EnvRunnerGroup（训练采样）；
2. 可选 evaluation EnvRunnerGroup；
3. observation/action spaces；
4. env-to-module connector；
5. learner connector；
6. LearnerGroup 和 RLModule；
7. 初始权重/connector state 同步；
8. offline data、callbacks、metrics 等。

远程 EnvRunner/Learner 底层是 Ray Actor。`num_env_runners` 和 `num_learners` 决定分布式组件数量，单个 actor 的 CPU/GPU 由相关 config 决定。

## 11.6 EnvRunner

EnvRunner 包含环境实例、RLModule inference copy、connector pipeline、episode state 和 metrics。典型一次 sample：

```text
env obs
  -> EnvToModule Connector
     - 添加/整理 observation
     - batch/vectorize
     - numpy -> tensor
  -> RLModule.forward_exploration/inference
  -> action distribution/sample
  -> ModuleToEnv Connector
     - tensor -> numpy
     - unbatch/clip/normalize
  -> env.step(action)
  -> SingleAgentEpisode/MultiAgentEpisode
```

实现见 [single_agent_env_runner.py](../rllib/env/single_agent_env_runner.py) 和
[multi_agent_env_runner.py](../rllib/env/multi_agent_env_runner.py)。

一个 EnvRunner 可 vectorize 多个 env；“EnvRunner Actor 数”和“总环境实例数”不同。前者影响 Ray 进程/资源，后者还乘以每 runner 的 env 数与 vectorization mode。

## 11.7 ConnectorV2

Connector 把环境/episode 数据与模型/learner 的张量协议解耦。常见变换：

- 添加 observation、previous action/reward；
- multi-agent 的 agent→module 映射；
- recurrent state 与 time dimension/padding；
- batch/unbatch；
- NumPy↔Tensor；
- advantage/return 等 learner-side 数据准备。

基类在 [connector_v2.py](../rllib/connectors/connector_v2.py)。自定义 connector 时必须明确运行位置：EnvRunner connector 可能每环境 step 执行，昂贵 Python 操作会直接降低采样吞吐；Learner connector 则影响训练 batch。

## 11.8 RLModule

RLModule 负责模型的 forward 接口，而不负责 optimizer/control loop。通常区分：

- `forward_inference`：确定性/部署推理所需输出；
- `forward_exploration`：训练采样时可带探索；
- `forward_train`：Learner 计算 loss 所需中间量。

基类与 `RLModuleSpec` 在 [rl_module.py](../rllib/core/rl_module/rl_module.py)。Spec 描述如何构造 module，便于在 EnvRunner 和 Learner 上创建相容副本。

多智能体使用 `MultiRLModule` 容纳多个 module ID，并通过 policy/module mapping 把 agent 分配到 module。不是每个 agent 都必须有独立神经网络。

## 11.9 Learner 与 LearnerGroup

Learner 拥有训练态 RLModule、optimizer、loss 和梯度更新逻辑。LearnerGroup 把更新分发给一个或多个 Learner，并聚合结果。可扩展两种不同维度：

- 增加 EnvRunner：提升采样吞吐；
- 增加 Learner/GPU：提升训练吞吐。

只增加采样但 Learner 消费不过来，会产生样本 backlog/陈旧策略；只增加 Learner但采样不足，GPU 会空闲。RL 系统性能调优就是平衡这两个速率。

## 11.10 PPO 的 `training_step`

[rllib/algorithms/ppo/ppo.py](../rllib/algorithms/ppo/ppo.py) 当前新栈主路径非常适合学习：

```text
1. synchronous_parallel_sample(EnvRunnerGroup)
   直到达到 total_train_batch_size
2. 聚合 EnvRunner metrics
3. LearnerGroup.update(
       episodes,
       num_epochs,
       minibatch_size,
       shuffle_batch_per_epoch,
   )
4. 聚合 learner results
5. EnvRunnerGroup.sync_weights(from LearnerGroup)
```

这就是 PPO 的系统闭环：采样 → 学习 → 同步。PPO-specific clipped objective 在 Learner/Module 具体实现中，分布式 orchestration 在 Algorithm。

旧栈分支则产生 `SampleBatch`，调用 `train_one_step`/`multi_gpu_train_one_step`，再同步 Policy weights。阅读时不要用旧栈的 Policy loss 解释新栈 Learner 的所有行为。

## 11.11 Sample 并行与同步点

PPO 的 `synchronous_parallel_sample` 会等待组成完整 train batch，因此慢 EnvRunner 可拖累 iteration。可能原因：

- 某环境 step 很慢或卡死；
- episode 长度/fragment 不均；
- remote actor 节点资源争用；
- 模型 inference 太慢；
- observation 很大，跨进程传输昂贵；
- sample timeout/故障恢复。

IMPALA/APPO 等算法使用不同的异步流水，不能把 PPO 同步采样的性能模型套到所有算法。

## 11.12 权重同步与策略陈旧

Learner 更新后，Algorithm 将新 module state 同步到 EnvRunner。同步有成本：模型参数大、runner 多时，传输和反序列化显著。异步算法减少等待但允许采样策略落后于 Learner，形成 off-policy/staleness trade-off。

这再次复用 ObjectRef/Actor 通信，但 RLlib 在算法层决定同步频率和一致性。

## 11.13 多智能体

MultiAgentEnv 每 step 返回按 agent ID 映射的数据；RLlib 需要：

- agent 生命周期与 episode；
- agent→module/policy mapping；
- 不同 observation/action spaces；
- shared 或独立 module；
- centralized training/decentralized execution 等结构。

关键代码在 [multi_agent_env_runner.py](../rllib/env/multi_agent_env_runner.py)、
[multi_rl_module.py](../rllib/core/rl_module/multi_rl_module.py) 和 config 的 `multi_agent` 部分。先用两个 agent、一个 shared module 的环境验证数据结构，再增加复杂 mapping。

## 11.14 RLlib 与 Tune

Algorithm 继承/兼容 Tune Trainable，RLlib 配置可作为 Tune param space：

```python
from ray import tune
from ray.rllib.algorithms.ppo import PPOConfig

config = (
    PPOConfig()
    .environment("CartPole-v1")
    .env_runners(num_env_runners=1)
)

tune.Tuner(
    "PPO",
    param_space=config,
    tune_config=tune.TuneConfig(num_samples=4),
    run_config=tune.RunConfig(stop={"training_iteration": 10}),
).fit()
```

一个 Trial 内部又有 EnvRunner/Learner Actors。资源估算必须展开整个 Algorithm 的 actor topology，再乘 Trial 并发。

## 11.15 Checkpoint

Algorithm checkpoint 不只是神经网络 weights，还可能包含：

- Learner/RLModule state；
- optimizer；
- connector state；
- counters/metrics；
- multi-agent module mapping；
- algorithm-specific state。

只保存 `state_dict` 适合推理导出，不等于可恢复完整训练。新栈组件实现 `Checkpointable`，Algorithm 按 component tree 保存/恢复。入口可从 `Algorithm.save_to_path`、`get_state`、`set_state` 追踪。

## 11.16 性能诊断顺序

1. 分开看 sampling time 与 learner update time；
2. 算总 env steps/s，而不只看 iteration/s；
3. 检查 EnvRunner 数 × vector env 数；
4. 看 CPU/GPU utilization，判断采样还是学习瓶颈；
5. 看 episode/fragment 长尾；
6. 看 observation/episode 传输大小和 object store；
7. 看权重同步时间；
8. 只改变一个维度，记录吞吐和训练样本效率。

更高系统吞吐不必然更快收敛；batch size、policy lag、数据分布改变会影响算法统计性质。

## 11.17 推荐阅读路径

1. [ppo.py](../rllib/algorithms/ppo/ppo.py) 的 `PPOConfig` 和 `training_step`；
2. [algorithm_config.py](../rllib/algorithms/algorithm_config.py) 的 `build_algo` 与 connector builder；
3. [algorithm.py](../rllib/algorithms/algorithm.py) 的 `setup`；
4. `single_agent_env_runner.py::sample`；
5. PPO default RLModule；
6. PPO Torch Learner；
7. LearnerGroup.update；
8. EnvRunnerGroup.sync_weights；
9. 最后再读 multi-agent/offline/async 算法。

## 11.18 自测题

1. EnvRunner、RLModule、Learner 分别拥有哪类状态？
2. 增加 EnvRunner 和增加 Learner 分别解决什么瓶颈？
3. Connector 为什么不应全部塞进模型 forward？
4. PPO `training_step` 的三个主要阶段是什么？
5. 新旧 API stack 为什么不能按类名随意混用？
6. 一个 Tune Trial 运行 RLlib 时，资源为何远大于 Trial driver 本身？

