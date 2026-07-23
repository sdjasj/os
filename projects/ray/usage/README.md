# Ray 使用与功能教程

这是一套从“使用者视角”出发的 Ray 教程。它不要求你先理解 Ray 的内部实现，而是先回答三个实际问题：

1. Ray 能解决什么问题？
2. 面对一个任务，应该选择 Ray Core、Data、Train、Tune、Serve 还是 RLlib？
3. 如何从本机示例逐步迁移到多机集群和生产环境？

教程针对当前仓库快照编写：

- 仓库：`ray-project/ray`
- 提交：`6623e6b1e7`
- 源码版本：`3.0.0.dev0`
- 编写日期：2026-07-20

> 当前仓库是开发版本。用 PyPI 稳定版运行时，少量参数或返回字段可能不同。遇到差异时，优先查看安装版本的 API 文档和错误信息，不要直接把开发分支示例复制到较老版本中。

## 1. 一句话理解 Ray

Ray 把普通 Python 函数和类变成可以并行、跨进程、跨机器执行的任务与有状态工作进程，并在此基础上提供数据处理、分布式训练、超参数搜索、强化学习和在线推理框架。

一个最小例子：

```python
import ray

ray.init()

@ray.remote
def square(x):
    return x * x

refs = [square.remote(i) for i in range(4)]
print(ray.get(refs))  # [0, 1, 4, 9]
```

这里的关键变化不是算法，而是执行方式：`square.remote(i)` 立即返回一个 `ObjectRef`，真正的计算由 Ray 调度到工作进程执行；`ray.get()` 在结果边界处取回值。

## 2. 功能选择速查表

| 你的问题 | 首选功能 | 核心抽象 | 典型例子 |
| --- | --- | --- | --- |
| 让很多独立 Python 调用并行运行 | Ray Core Tasks | 远程函数、`ObjectRef` | 文件转换、仿真、并行请求 |
| 需要长期保存可变状态或昂贵模型 | Ray Core Actors | 远程类、Actor Handle | 参数服务器、模型缓存、状态服务 |
| 处理大规模表格、图像或离线推理 | Ray Data | `Dataset`、Block、算子流水线 | ETL、批量推理、训练数据读取 |
| 将 PyTorch 等训练扩展到多卡多机 | Ray Train | Trainer、Worker、Checkpoint | DDP 训练、容错训练 |
| 并行搜索超参数和提前停止差试验 | Ray Tune | Trial、Search Space、Scheduler | 学习率搜索、模型选择 |
| 部署可扩缩的在线模型服务 | Ray Serve | Deployment、Application、Handle | HTTP 推理、模型组合 |
| 训练单智能体或多智能体强化学习 | RLlib | AlgorithmConfig、EnvRunner、RLModule | PPO、DQN、多智能体训练 |
| 把程序提交到远端集群并管理生命周期 | Ray Jobs | Job、Runtime Environment | 批处理任务、训练作业 |
| 在 Kubernetes 上管理 Ray 集群与服务 | KubeRay | RayCluster、RayJob、RayService | 弹性集群、生产服务 |

如果只想并行化已有 Python 代码，从 Core 开始；如果目标已经明确是数据、训练、调参、强化学习或在线服务，直接使用对应上层库，通常不需要自己手写底层调度逻辑。

## 3. 推荐阅读路线

### 路线 A：第一次使用 Ray

1. [Ray 的定位与整体功能](00-overview.md)
2. [安装、启动与第一个程序](01-install-and-first-run.md)
3. [Tasks：无状态并行计算](02-core-tasks.md)
4. [Actors：有状态并行计算](03-core-actors.md)
5. [对象、资源、依赖与调度](04-objects-resources-runtime-env.md)
6. [观测、调试与故障处理](11-observability-debugging.md)

### 路线 B：构建机器学习流水线

1. [Ray Data：数据处理与批量推理](05-data.md)
2. [Ray Train：分布式训练](06-train.md)
3. [Ray Tune：超参数搜索](07-tune.md)
4. [Ray Serve：在线推理服务](08-serve.md)
5. [端到端组合场景](12-end-to-end-scenarios.md)

### 路线 C：强化学习

1. [Ray 的定位与整体功能](00-overview.md)
2. [安装、启动与第一个程序](01-install-and-first-run.md)
3. [RLlib：强化学习](09-rllib.md)
4. [集群、Jobs 与 KubeRay](10-clusters-jobs-kuberay.md)
5. [观测、调试与故障处理](11-observability-debugging.md)

### 路线 D：部署到集群

1. [对象、资源、依赖与调度](04-objects-resources-runtime-env.md)
2. [集群、Jobs 与 KubeRay](10-clusters-jobs-kuberay.md)
3. [观测、调试与故障处理](11-observability-debugging.md)
4. [选型、性能与生产检查表](13-selection-best-practices.md)

## 4. 模块目录

| 文件 | 内容 |
| --- | --- |
| [00-overview.md](00-overview.md) | Ray 的边界、组件关系、功能选择 |
| [01-install-and-first-run.md](01-install-and-first-run.md) | 虚拟环境、安装组合、连接方式、首个程序 |
| [02-core-tasks.md](02-core-tasks.md) | 远程函数、依赖图、`ray.wait`、限流、重试 |
| [03-core-actors.md](03-core-actors.md) | 状态、并发、命名 Actor、生命周期与容错 |
| [04-objects-resources-runtime-env.md](04-objects-resources-runtime-env.md) | 对象存储、资源、调度、Placement Group、运行环境 |
| [05-data.md](05-data.md) | 读写、转换、流式执行、批量推理、训练供数 |
| [06-train.md](06-train.md) | Trainer、分布式训练函数、数据分片、报告与检查点 |
| [07-tune.md](07-tune.md) | 搜索空间、Trial、资源、Scheduler、最佳结果 |
| [08-serve.md](08-serve.md) | Deployment、HTTP、Handle、组合、批处理与扩缩容 |
| [09-rllib.md](09-rllib.md) | 环境、算法配置、训练、评估、检查点、多智能体 |
| [10-clusters-jobs-kuberay.md](10-clusters-jobs-kuberay.md) | 本地/多机集群、Jobs、VM、Kubernetes |
| [11-observability-debugging.md](11-observability-debugging.md) | Dashboard、State、日志、内存、性能和故障定位 |
| [12-end-to-end-scenarios.md](12-end-to-end-scenarios.md) | 常见业务场景及功能组合 |
| [13-selection-best-practices.md](13-selection-best-practices.md) | 选型边界、性能模式、生产上线检查表 |
| [14-source-map.md](14-source-map.md) | 教程示例对应的仓库代码与官方文档位置 |

可直接运行或改造的示例位于 [examples](examples/) 目录。每个示例也会在相应章节中解释。

## 5. 使用本教程的约定

- 命令默认在 Linux/macOS Shell 中执行。
- 所有 Python 安装都应放在独立虚拟环境中，不要写入系统 Python。
- 教程使用显式 `ray.init()`，这样连接方式和生命周期更清楚。
- 本机学习阶段使用 `ray.init()` 即可；远端生产运行优先使用 Ray Jobs。
- 资源参数是逻辑调度资源，不等同于操作系统级 CPU 隔离。
- 示例以理解核心行为为目标；生产系统还必须补充鉴权、持久存储、限流、告警和故障恢复。

## 6. 最短实践路径

```bash
python -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
python -m pip install "ray[default]"
python ray_usage_guide/examples/core_tasks.py
```

之后访问 `http://127.0.0.1:8265` 查看 Dashboard。若脚本退出后页面不可访问，说明脚本启动的本地 Ray 实例已随 Driver 结束；想持续观察，可以先执行 `ray start --head`，再运行示例。

## 7. 重要边界

Ray 很适合动态、异构、以 Python 为主的分布式工作负载，但它不是数据库、消息队列或 Kubernetes 的替代品：

- 需要事务、索引和长期数据保存时，仍使用数据库或对象存储。
- 需要跨系统可靠事件传递时，仍使用 Kafka 等消息系统。
- 需要容器编排、网络策略和集群生命周期管理时，使用 Kubernetes；KubeRay 负责让 Ray 更好地运行在 Kubernetes 上。
- 一个很小、很快、没有并行空间的函数，远程调用开销可能比计算本身更大。

先用单机最小示例确认并行模型正确，再扩展到集群，是学习和排障成本最低的路线。
