# 14. 教程与当前仓库代码导航

本章帮助你在使用某个 API 后，快速找到项目中的公共入口、官方示例、文档和实现。目标是“带着使用问题读源码”，不是从整个仓库根目录漫游。

## 1. 仓库总布局

```text
ray/
  ├─ python/ray/         Python 公共 API 与大多数库实现
  ├─ src/ray/            C++ 核心运行时
  ├─ rllib/              RLlib 源码（与 python/ray/rllib 关联）
  ├─ doc/source/         Sphinx/MyST 文档和可执行示例
  ├─ dashboard/          Dashboard 前后端
  ├─ release/            发布测试和工作负载
  ├─ python/ray/tests/   Core Python 测试
  └─ BUILD.bazel 等      构建定义
```

作为使用者，优先从 `doc/source` 和公共 Python API 开始；只有需要理解行为或排查 bug 时，才沿调用进入 `_private` 或 C++。

## 2. 使用问题到代码入口的映射

| 使用问题 | 公共入口 | 官方文档/示例 | 主要实现 |
| --- | --- | --- | --- |
| `ray.init`/连接 | [`python/ray/__init__.py`](../python/ray/__init__.py) | [`ray-core/walkthrough.rst`](../doc/source/ray-core/walkthrough.rst) | [`python/ray/_private/worker.py`](../python/ray/_private/worker.py) |
| `@ray.remote` Task | [`python/ray/__init__.py`](../python/ray/__init__.py) | [`ray-core/tasks.rst`](../doc/source/ray-core/tasks.rst) | [`python/ray/remote_function.py`](../python/ray/remote_function.py) |
| Actor | [`python/ray/actor.py`](../python/ray/actor.py) | [`ray-core/actors.rst`](../doc/source/ray-core/actors.rst) | [`python/ray/actor.py`](../python/ray/actor.py) |
| ObjectRef/get/put/wait | [`python/ray/_raylet.pyx`](../python/ray/_raylet.pyx) | [`ray-core/objects.rst`](../doc/source/ray-core/objects.rst) | Worker + C++ object manager |
| Resource | Task/Actor `.options()` | [`scheduling/resources.rst`](../doc/source/ray-core/scheduling/resources.rst) | [`python/ray/_private/resource_and_label_spec.py`](../python/ray/_private/resource_and_label_spec.py) |
| Placement Group | [`python/ray/util/placement_group.py`](../python/ray/util/placement_group.py) | [`scheduling/placement-group.rst`](../doc/source/ray-core/scheduling/placement-group.rst) | Core scheduler/GCS |
| Runtime Environment | `ray.init(runtime_env=...)` | [`handling-dependencies.rst`](../doc/source/ray-core/handling-dependencies.rst) | [`python/ray/_private/runtime_env`](../python/ray/_private/runtime_env) |
| State API | `ray.util.state` | Observability 文档 | [`python/ray/util/state`](../python/ray/util/state) |

`_private` 表示内部实现，不保证像公共 API 一样稳定。业务代码不应直接依赖它。

## 3. Ray Data

| 目标 | 位置 |
| --- | --- |
| 入门 | [`doc/source/data/quickstart.rst`](../doc/source/data/quickstart.rst) |
| Dataset 公共方法 | [`python/ray/data/dataset.py`](../python/ray/data/dataset.py) |
| 读取 API | [`python/ray/data/read_api.py`](../python/ray/data/read_api.py) |
| 数据源/数据接收器 | [`python/ray/data/datasource`](../python/ray/data/datasource) |
| 执行计划 | [`python/ray/data/_internal/logical/interfaces/plan.py`](../python/ray/data/_internal/logical/interfaces/plan.py) |
| 流式执行器 | [`python/ray/data/_internal/execution`](../python/ray/data/_internal/execution) |
| `map_batches` 用户指南 | [`doc/source/data/transforming-data.rst`](../doc/source/data/transforming-data.rst) |
| 批量推理 | [`doc/source/data/batch_inference.rst`](../doc/source/data/batch_inference.rst) |
| 性能建议 | [`doc/source/data/performance-tips.rst`](../doc/source/data/performance-tips.rst) |

建议追踪路径：`Dataset.map_batches` → logical operator → physical operator → streaming executor → Core Task/Actor。

## 4. Ray Train

| 目标 | 位置 |
| --- | --- |
| PyTorch 入门 | [`doc/source/train/getting-started-pytorch.rst`](../doc/source/train/getting-started-pytorch.rst) |
| TorchTrainer | [`python/ray/train/torch/torch_trainer.py`](../python/ray/train/torch/torch_trainer.py) |
| 训练上下文 API | [`python/ray/train/context.py`](../python/ray/train/context.py) |
| 训练配置 | [`python/ray/train`](../python/ray/train) 中搜索 `ScalingConfig`/`RunConfig` |
| PyTorch helpers | [`python/ray/train/torch/train_loop_utils.py`](../python/ray/train/torch/train_loop_utils.py) |
| 数据输入 | [`doc/source/train/user-guides/data-loading-preprocessing.rst`](../doc/source/train/user-guides/data-loading-preprocessing.rst) |
| Checkpoint | [`doc/source/train/user-guides/checkpoints.rst`](../doc/source/train/user-guides/checkpoints.rst) |
| 容错 | [`doc/source/train/user-guides/fault-tolerance.rst`](../doc/source/train/user-guides/fault-tolerance.rst) |

不同 Trainer 最终复用 Train 的 Worker Group、Backend、Session/Context 与 Result/Checkpoint 协议。

## 5. Ray Tune

| 目标 | 位置 |
| --- | --- |
| 入门 | [`doc/source/tune/getting-started.rst`](../doc/source/tune/getting-started.rst) |
| 入门示例真实代码 | [`python/ray/tune/tests/tutorial.py`](../python/ray/tune/tests/tutorial.py) |
| Tuner | [`python/ray/tune/tuner.py`](../python/ray/tune/tuner.py) |
| 搜索空间 | [`python/ray/tune/search/sample.py`](../python/ray/tune/search/sample.py) |
| Search Algorithms | [`python/ray/tune/search`](../python/ray/tune/search) |
| Trial Schedulers | [`python/ray/tune/schedulers`](../python/ray/tune/schedulers) |
| Trial/控制器 | [`python/ray/tune/experiment/trial.py`](../python/ray/tune/experiment/trial.py) 与 `execution/` |
| ResultGrid | [`python/ray/tune/result_grid.py`](../python/ray/tune/result_grid.py) |

阅读 `Tuner.fit()` 时不要一口气钻到底层；先区分配置转换、Trial 生成、资源申请、调度器决策和结果持久化五条链。

## 6. Ray Serve

| 目标 | 位置 |
| --- | --- |
| 快速示例 | [`doc/source/serve/doc_code/quickstart.py`](../doc/source/serve/doc_code/quickstart.py) |
| 组合示例 | [`doc/source/serve/doc_code/quickstart_composed.py`](../doc/source/serve/doc_code/quickstart_composed.py) |
| `@serve.deployment` | [`python/ray/serve/deployment.py`](../python/ray/serve/deployment.py) |
| `serve.run` | [`python/ray/serve/api.py`](../python/ray/serve/api.py) |
| DeploymentHandle | [`python/ray/serve/handle.py`](../python/ray/serve/handle.py) |
| Router | [`python/ray/serve/_private/router.py`](../python/ray/serve/_private/router.py) |
| Replica | [`python/ray/serve/_private/replica.py`](../python/ray/serve/_private/replica.py) |
| Autoscaling | [`python/ray/serve/autoscaling_policy.py`](../python/ray/serve/autoscaling_policy.py) 与 `_private/autoscaling_state.py` |
| 生产指南 | [`doc/source/serve/production-guide`](../doc/source/serve/production-guide) |
| LLM 服务 | [`doc/source/serve/llm/index.md`](../doc/source/serve/llm/index.md) |

建议按请求链阅读：Proxy → Handle/Router → Replica → 用户 Deployment 方法 → response。

## 7. RLlib

| 目标 | 位置 |
| --- | --- |
| 当前入门 | [`doc/source/rllib/getting-started.rst`](../doc/source/rllib/getting-started.rst) |
| AlgorithmConfig | [`rllib/algorithms/algorithm_config.py`](../rllib/algorithms/algorithm_config.py) |
| Algorithm | [`rllib/algorithms/algorithm.py`](../rllib/algorithms/algorithm.py) |
| PPO | [`rllib/algorithms/ppo`](../rllib/algorithms/ppo) |
| EnvRunner | [`rllib/env`](../rllib/env) |
| Learner | [`rllib/core/learner`](../rllib/core/learner) |
| RLModule | [`rllib/core/rl_module`](../rllib/core/rl_module) |
| 多智能体 | [`doc/source/rllib/multi-agent-envs.rst`](../doc/source/rllib/multi-agent-envs.rst) |

RLlib 有新旧 API stack 迁移历史。阅读示例时优先看当前入门文件和类型注解，遇到 `.rollouts()`、`num_rollout_workers`、ModelV2 等关键词时先确认示例面向哪个版本。

## 8. Cluster、Jobs 与 Dashboard

| 目标 | 位置 |
| --- | --- |
| 集群总览 | [`doc/source/cluster/getting-started.rst`](../doc/source/cluster/getting-started.rst) |
| Jobs CLI/SDK | [`doc/source/cluster/running-applications/job-submission`](../doc/source/cluster/running-applications/job-submission) |
| Jobs Python 包 | [`python/ray/dashboard/modules/job`](../python/ray/dashboard/modules/job) |
| Autoscaler | [`python/ray/autoscaler`](../python/ray/autoscaler) |
| KubeRay 文档 | [`doc/source/cluster/kubernetes`](../doc/source/cluster/kubernetes) |
| Dashboard Python 后端 | [`python/ray/dashboard`](../python/ray/dashboard) |
| Dashboard 前端 | [`python/ray/dashboard/client`](../python/ray/dashboard/client) |
| Observability | [`doc/source/ray-observability`](../doc/source/ray-observability) |

KubeRay Operator 本体是独立的 `ray-project/kuberay` 项目；本仓库主要包含 Ray 侧集成与用户文档。

## 9. C++ Core 入口

只有当 Python 行为无法解释调度、对象或节点问题时，再进入：

| 组件 | 大致位置 |
| --- | --- |
| Raylet/Node Manager | [`src/ray/raylet`](../src/ray/raylet) |
| Core Worker | [`src/ray/core_worker`](../src/ray/core_worker) |
| GCS | [`src/ray/gcs`](../src/ray/gcs) |
| Object Manager | [`src/ray/object_manager`](../src/ray/object_manager) |
| 公共 ID/状态等 | [`src/ray/common`](../src/ray/common) |

Python 与 C++ 绑定大量集中在 [`python/ray/_raylet.pyx`](../python/ray/_raylet.pyx)。从 `ray.get`、Task 提交等公共调用追踪时，它通常是进入 Core Worker 的桥梁。

## 10. 用搜索验证当前版本

仓库 API 变化时，先搜索而不是猜路径：

```bash
# 找类定义
rg -n "class TorchTrainer" python/ray

# 找公开示例调用
rg -n "build_algo\(\)" doc/source/rllib rllib

# 找 Serve 配置字段
rg -n "max_queued_requests" doc/source/serve python/ray/serve

# 找测试中的真实用法
rg -n "Tuner\(" python/ray/tune/tests doc/source/tune
```

判断一个 API 是否适合业务依赖时，依次看：

1. 当前用户文档是否推荐；
2. 公共模块是否导出；
3. docstring 是否标注 Alpha/Beta/Deprecated；
4. 测试是否覆盖；
5. release notes/迁移说明；
6. `_private` 路径通常不作为稳定承诺。

## 11. 本教程示例与官方示例的关系

本教程 `examples/` 中的脚本是为了展示最小用法，使用当前仓库文档公开的 API 形态；它们不是 Ray 官方测试目标，也不替代仓库自带的可执行文档示例。

需要更强验证时：

- Core：看 `doc/source/ray-core/doc_code` 和 `python/ray/tests`；
- Data：看 `doc/source/data/doc_code` 和 `python/ray/data/tests`；
- Train：看 `doc/source/train/doc_code` 和 `python/ray/train/tests`；
- Tune：看 `python/ray/tune/tests`；
- Serve：看 `doc/source/serve/doc_code` 和 `python/ray/serve/tests`；
- RLlib：看 `rllib/examples` 和各算法测试。

至此，你已经有了从“Ray 能做什么”到“怎么用、怎么部署、怎么排障、代码在哪里”的完整地图。建议回到 [README](README.md)，选择最符合当前目标的一条路线，并真正运行对应的最小示例。
