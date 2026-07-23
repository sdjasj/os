# 00. Ray 的定位与整体功能

## 1. Ray 解决的核心问题

普通 Python 程序通常在一个进程中顺序执行。即使使用多进程，也要自己处理进程池、进程间通信、异常、数据复制和机器边界。一旦扩展到多机，问题会进一步变成：任务放到哪台机器、资源够不够、节点挂了怎么办、依赖如何分发、日志去哪里看。

Ray 把这些问题收敛为几个统一抽象：

- **Task**：无状态的远程函数调用。
- **Actor**：有状态的远程对象，方法在固定工作进程中执行。
- **ObjectRef**：远程结果的引用，用来表达数据和依赖关系。
- **Resource**：CPU、GPU、内存和自定义资源的逻辑需求。
- **Runtime Environment**：工作目录、Python 包、环境变量等运行依赖。

上层库复用这些抽象：Data 用 Task/Actor 执行数据算子，Train 用 Worker Actor 组织分布式训练，Tune 用 Trial 并行运行实验，Serve 用 Replica Actor 承载服务副本，RLlib 用分布式采样和学习组件训练策略。

## 2. Ray 的三个层次

```text
业务应用
  ├─ 数据加工 / 训练 / 调参 / 强化学习 / 在线推理
  │
Ray AI Libraries
  ├─ Data ─ Train ─ Tune ─ RLlib ─ Serve
  │
Ray Core
  ├─ Tasks ─ Actors ─ Objects ─ Scheduling ─ Runtime Envs
  │
集群与运维
  ├─ Jobs ─ Autoscaler ─ Dashboard ─ State API ─ KubeRay
```

理解这一层次很重要：上层库不是与 Core 竞争的另一套运行时，而是把常见领域模式封装在 Core 上。使用 Data 时仍然会在 Dashboard 中看到 Task 和 Actor；使用 Serve 时仍然要为 Replica 配置 CPU/GPU。

## 3. 一次调用发生了什么

以远程函数为例：

```python
@ray.remote(num_cpus=1)
def preprocess(path):
    return load_and_transform(path)

result_ref = preprocess.remote("input.parquet")
result = ray.get(result_ref)
```

可以按以下模型理解：

1. 运行主程序的 Python 进程是 **Driver**。
2. `preprocess.remote(...)` 向 Ray 提交 Task，而不是在 Driver 中直接调用函数。
3. Ray Scheduler 找到满足 `num_cpus=1` 的节点和 Worker。
4. Worker 执行函数，结果进入分布式对象存储。
5. Driver 得到的 `result_ref` 是引用；只有 `ray.get()` 才把值解析到当前进程。
6. 如果另一个 Task 直接接收这个引用，Ray 会把依赖关系加入任务图，并在数据可用后调度下游任务。

这就是 Ray 的数据流式执行方式：程序提交调用，`ObjectRef` 连接依赖，调度器在资源允许时并行推进。

## 4. 主要功能详解

### 4.1 Ray Core：通用分布式 Python

适合：

- 大量相互独立或形成 DAG 的 Python 调用；
- 需要持有状态、连接、缓存或模型的长期工作进程；
- 工作负载中混合 CPU、GPU、I/O 和自定义硬件；
- 现成领域库无法完整表达的自定义系统。

Core 给你最大的灵活性，也意味着背压、任务粒度、幂等性和错误处理需要自己设计。

### 4.2 Ray Data：分布式数据处理

Ray Data 面向批处理和流式执行的数据流水线，支持读取 Parquet、CSV、JSON、图像、数据库和对象存储，提供 `map`、`map_batches`、`filter`、`groupby`、`repartition`、`write_*` 等算子。

适合：

- 训练前的数据清洗与转换；
- 大模型/视觉模型批量推理；
- 数据在 CPU 预处理和 GPU 推理之间流动；
- 直接向 Train Worker 提供分片数据。

它不是事务型数据仓库，也不是低延迟单记录查询系统。

### 4.3 Ray Train：分布式训练

Ray Train 管理训练 Worker 的启动、进程组初始化、资源申请、数据分片、指标汇报和检查点。你保留框架原生训练循环，只把它包装进训练函数。

适合 PyTorch、PyTorch Lightning、Transformers、XGBoost、LightGBM、JAX 等训练工作负载。Train 重点解决“一次训练如何分布式运行”，而 Tune 解决“很多组训练配置如何搜索”。

### 4.4 Ray Tune：实验与超参数优化

Tune 把一次配置运行称为 Trial。它负责生成配置、分配资源、并发运行、收集指标、提前停止差的 Trial、恢复检查点并选择最佳结果。

它既可以调普通 Python 训练函数，也可以调 Ray Train Trainer。搜索算法决定“下一组参数是什么”，Trial Scheduler 决定“正在运行的 Trial 应继续、暂停还是停止”。

### 4.5 Ray Serve：在线服务

Serve 把 Python 类或函数包装成 Deployment，并运行一个或多个 Replica。它支持 HTTP 入口、Python DeploymentHandle、模型组合、动态批处理、自动扩缩和滚动更新。

适合将机器学习模型和业务预后处理组合成在线推理应用。它不替代外部 API 网关、身份认证、TLS 终止和跨地域流量管理。

### 4.6 RLlib：强化学习

RLlib 提供强化学习算法、环境采样、学习器、模型模块、评估、检查点和多智能体能力。它建立在 Ray 的并行执行上，让环境采样和梯度学习扩展到多核、多 GPU 和多节点。

如果只是普通监督学习，优先 Train；如果任务包含环境、动作、奖励和策略优化，再选择 RLlib。

### 4.7 集群、Jobs 和 KubeRay

Ray Cluster 由一个 Head 节点和零个或多个 Worker 节点组成。Head 承载控制面服务，不意味着所有业务计算都必须在 Head 上。

- **Ray Jobs**：把入口命令、代码和运行环境提交到已有集群。
- **Autoscaler**：根据逻辑资源请求和节点类型扩缩 Worker。
- **KubeRay**：用 Kubernetes CRD 管理 RayCluster、RayJob、RayService。
- **Dashboard/State API**：观察任务、Actor、节点、对象和错误。

## 5. Ray 不会自动替你解决什么

### 5.1 不会自动让任意代码变快

程序必须存在可并行部分，而且单个任务计算量要足以覆盖序列化、调度和进程通信开销。把微秒级函数逐个变成 Task 往往更慢，应先批处理。

### 5.2 不会替你保证业务幂等

Task 失败重试可能导致外部副作用重复发生。例如“写数据库后进程崩溃”，Ray 无法知道写入是否成功。生产任务要使用幂等键、事务或去重机制。

### 5.3 不会把资源声明变成硬隔离

`num_cpus=1` 是调度配额，不会阻止代码创建多个本地线程。GPU 可见性由 Ray 帮助设置，但显存仍由框架和用户代码管理。

### 5.4 不会自动持久化内存状态

对象存储和 Actor 状态主要是运行时状态。重要结果和检查点要写到共享、持久化存储，例如 S3、GCS、Azure Blob、NFS 或数据库。

## 6. 什么时候不用 Ray

- 程序只有一个很短的串行步骤；
- NumPy/PyTorch 单机向量化已经充分利用硬件；
- 主要需求是 SQL 事务、流消息持久化或 Web CRUD；
- 团队无法承担分布式部署和观测成本；
- 跨节点数据量远大于计算量，且无法通过数据局部性或批处理改善。

是否使用 Ray 的有效判断方式是：先写出计算单元、依赖关系、资源需求和结果边界，再评估 Ray 是否能简化这些关系。

## 7. 从问题到功能的决策流程

```text
是否是强化学习？ ─ 是 → RLlib
       │ 否
是否是在线请求服务？ ─ 是 → Serve
       │ 否
是否是多组参数实验？ ─ 是 → Tune（训练主体可用 Train）
       │ 否
是否是一次多卡/多机训练？ ─ 是 → Train
       │ 否
是否以大规模数据读写/转换为主？ ─ 是 → Data
       │ 否
需要长期状态？ ─ 是 → Actor
       │ 否
大量独立或有依赖的调用？ ─ 是 → Task
       │ 否
先保留普通 Python 实现
```

## 8. 本章对应的仓库入口

- 项目总览：[`../README.rst`](../README.rst)
- 入门总览：[`../doc/source/ray-overview/getting-started.md`](../doc/source/ray-overview/getting-started.md)
- Ray Core：[`../doc/source/ray-core/walkthrough.rst`](../doc/source/ray-core/walkthrough.rst)
- Ray Data：[`../doc/source/data/quickstart.rst`](../doc/source/data/quickstart.rst)
- Ray Train：[`../doc/source/train/train.rst`](../doc/source/train/train.rst)
- Ray Tune：[`../doc/source/tune/index.rst`](../doc/source/tune/index.rst)
- Ray Serve：[`../doc/source/serve/index.md`](../doc/source/serve/index.md)
- RLlib：[`../doc/source/rllib/index.rst`](../doc/source/rllib/index.rst)
- 集群：[`../doc/source/cluster/getting-started.rst`](../doc/source/cluster/getting-started.rst)

下一章先建立一个可重复的本机环境，然后运行第一个 Task 和 Actor 程序。
