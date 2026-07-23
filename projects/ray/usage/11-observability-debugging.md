# 11. 可观测性、调试与故障处理

## 1. 分布式排障的基本原则

不要从一条错误日志直接猜根因。先确定问题属于哪一层：

```text
业务结果错误
  ├─ 用户代码 / 数据 / 随机性
Task/Actor 失败或卡住
  ├─ 异常 / 资源 / 依赖 / 死锁 / 节点失败
性能或内存问题
  ├─ 任务粒度 / 数据传输 / 对象引用 / spill / 线程 / GPU
集群问题
  ├─ 节点 / Autoscaler / Kubernetes / 网络 / 存储 / 镜像
```

观测信息也分五类：

- **State**：现在有哪些 Job、Task、Actor、Node、Object、Placement Group；
- **Logs**：某个进程发生了什么；
- **Metrics**：随时间变化的吞吐、延迟、资源和错误；
- **Profiles/Timeline**：时间花在哪里；
- **Application signals**：业务指标、输入版本、请求 ID、检查点。

## 2. Dashboard

安装包含 Dashboard 的组件：

```bash
python -m pip install "ray[default]"
```

本机：

```python
import ray

context = ray.init()
print(context.dashboard_url)
```

默认通常是 `http://127.0.0.1:8265`。主要视图：

- Jobs：作业、Task/Actor 状态、错误和时间线；
- Cluster：Node、Worker、CPU/GPU/内存；
- Actors：Actor 状态、所属 Job 和日志；
- Serve：Application、Deployment、Replica 和请求指标；
- Logs：节点和 Worker 日志；
- Metrics：需集成 Prometheus/Grafana 的时序指标。

远端 Dashboard 不应直接开放公网，使用 SSH 端口转发、`kubectl port-forward`、受保护 Ingress 或平台网关。

## 3. State CLI

```bash
ray list jobs
ray list nodes
ray list actors
ray list tasks
ray list placement-groups
ray list workers
```

汇总视图：

```bash
ray summary tasks
ray summary actors
ray summary objects
```

State API 是调试和自动化查询工具，不应假设它无限保留历史。大量已完成 Task 可能受控制面缓存和展示上限影响，长期审计应导出到外部日志/指标系统。

Python State API 示例：

```python
from ray.util.state import list_actors, list_tasks

running_actors = list_actors(
    filters=[("state", "=", "ALIVE")],
    limit=100,
)

failed_tasks = list_tasks(
    filters=[("state", "=", "FAILED")],
    limit=100,
)
```

字段和过滤操作符应以当前版本 API 为准。探索时先运行无过滤查询或查看 `ray list --help`。

## 4. `ray status`：先看资源需求

```bash
ray status
```

重点区分：

- active/pending/failed nodes；
- 集群逻辑资源使用；
- resource demands；
- Placement Group demands；
- Autoscaler 最近错误。

Task 长期 Pending 时，先看是否存在不可满足资源需求，而不是先假设 Worker 代码死循环。若请求 `GPU:4`，但每节点最多 2 GPU，总 GPU 再多也无法放置一个 Task。

## 5. 日志模型

### 5.1 Driver 日志

Task/Actor 的 stdout/stderr 默认可转发到 Driver，并带 Worker/Actor 前缀。业务日志应使用 Python `logging`，包含：

- Job ID/业务运行 ID；
- Task/Actor/Replica 名称；
- 数据分片或请求 ID；
- 模型/数据版本；
- 关键耗时和记录数；
- 异常堆栈。

### 5.2 节点本地日志

本机默认可在以下位置查看：

```text
/tmp/ray/session_latest/logs/
```

其中包含 worker、raylet、GCS、dashboard、runtime_env、autoscaler 等日志。生产节点可能使用不同临时目录，且节点删除后本地日志消失，所以必须由 Fluent Bit、Vector、云日志 Agent 等汇聚到外部系统。

### 5.3 日志去重

大量 Worker 打印相同消息时，Ray 可能进行日志去重，防止 Driver 被淹没。调试需要完整逐条输出时可查看相关环境变量，但生产更好的做法是结构化日志、采样和指标聚合，而不是关闭所有保护。

## 6. Task/Actor 失败排查

推荐顺序：

1. 在 Driver 捕获并打印完整 `RayTaskError`/`RayActorError`；
2. State/Dashboard 确认失败对象、节点和时间；
3. 查看对应 Worker 日志，而不是只看 Head 控制面日志；
4. 判断是用户异常、进程退出、节点失败还是依赖安装失败；
5. 用同一输入构造最小复现；
6. 先单机单 Worker 复现，再恢复并行度；
7. 明确重试是否安全。

常见信号：

| 现象 | 优先检查 |
| --- | --- |
| `RayTaskError` | 用户堆栈、输入、依赖 |
| `RayActorError` | 构造/方法异常、进程/节点退出、重启配置 |
| Runtime env setup failed | pip/conda 日志、网络、包版本、工作目录 |
| Worker died unexpectedly | OOM、native crash、节点 event、容器限制 |
| Task Pending | `ray status`、资源和 Placement Group |
| `ObjectLostError` | 对象拥有者/节点失败、重建策略 |

## 7. 内存问题要分三类

### 7.1 Worker heap

Python、NumPy、PyTorch、缓存、模型等进程内内存。看进程 RSS、堆分析器和对象生命周期。

### 7.2 Object store

Task 参数/返回值和 `ray.put` 对象。用：

```bash
ray memory
```

检查哪些 ObjectRef 持有对象、对象大小、调用位置和引用类型。

### 7.3 操作系统/容器内存

包含 Worker、object store、raylet、GCS、文件缓存、共享内存和其他进程。Kubernetes OOMKilled 或节点 OOM 需要查看 Pod limit、node event 和系统日志。

内存增长的处理顺序：

1. 判断是哪一类内存；
2. 查谁持有大对象或堆引用；
3. 限制在途 Task/数据 Block；
4. 用流式消费代替全量收集；
5. 减少对象尺寸/复制；
6. 配置 spill 容量；
7. 最后才是单纯增加内存。

## 8. 性能问题的分解

### 8.1 Driver 提交瓶颈

症状：Worker 空闲，Driver 单核忙，Task 极其细碎。改进：批处理、Ray Data、减少元数据和 Python 循环提交。

### 8.2 调度/资源等待

症状：Task Pending、资源需求堆积。检查资源声明、Actor 占用、Placement Group 和 Autoscaler。

### 8.3 数据传输/对象存储

症状：大量 fetch/spill、网络高、Worker 等输入。改进数据局部性、减少中间 `ray.get`、缩小对象、使用批次、避免全局 shuffle。

### 8.4 Worker 计算

症状：Task Running 时间长。用 CPU profiler、GPU profiler、框架 profiler；检查内部线程、Python GIL、batch size。

### 8.5 下游系统

症状：CPU/GPU 空闲但 I/O 慢。检查对象存储/数据库限速、连接池、服务错误与重试风暴。

## 9. Timeline 与 Profiling

Dashboard 可以导出 Task timeline，用 Perfetto 等查看：

- 提交、调度、反序列化、执行、序列化；
- Worker 是否有空洞；
- Task 是否过细；
- 串行依赖是否限制并行；
- 数据阶段和计算阶段是否重叠。

CPU flame graph 和 stack trace 适合定位运行中 Job/Actor。GPU 工作负载还要结合 PyTorch Profiler、Nsight Systems 等。Profiling 会有开销，生产中限定时间窗口和对象范围。

## 10. 指标与自定义指标

Ray 暴露系统指标，可由 Prometheus 抓取并在 Grafana 展示。默认指标涵盖：

- Task、Actor、Placement Group 状态；
- 逻辑资源；
- 节点硬件；
- 对象存储；
- Autoscaler；
- Serve 请求和 Replica。

应用还应增加业务指标：

```python
from ray.util.metrics import Counter, Histogram

processed = Counter(
    "records_processed_total",
    description="Number of processed records",
)
latency = Histogram(
    "batch_latency_seconds",
    description="Batch processing latency",
    boundaries=[0.01, 0.05, 0.1, 0.5, 1, 5],
)

processed.inc(100)
latency.observe(0.12)
```

避免高基数 tag，例如把 user ID、完整 URL、ObjectRef 或 request ID 作为指标标签；这些应进入日志/trace。

## 11. 卡住与死锁

程序“无输出”时区分：

- Task 是 `PENDING_NODE_ASSIGNMENT`：资源/调度；
- Task 是 `PENDING_ARGS_FETCH`：依赖对象未就绪/丢失；
- Task 是 `RUNNING`：用户代码、I/O 或死锁；
- Actor 方法排队：前一个方法很慢或 Actor 串行；
- Driver 卡在 `ray.get`：追踪它等待的引用和上游；
- Placement Group Pending：bundle 无法满足。

使用分布式调试器、stack trace 或 profiler 看运行进程栈。不要在未确认对象的情况下直接重启整个集群，那会丢掉最有价值的现场信息。

## 12. OOM 与 Ray 内存监控

Ray 会监控节点内存压力并可能终止 Worker 以保护节点。若频繁发生：

- 查看被终止的是 Task 还是 Actor；
- 检查重试是否形成循环；
- 降低并发/批大小；
- 清理 Actor 缓存/ObjectRef；
- 调整资源声明和 Pod memory limit；
- 将大结果写外部存储而非全部留内存；
- 检查模型显存与主机内存是否同时增长。

简单增加 `max_retries` 可能把 OOM 变成无限重试风暴。

## 13. 调试清单

### Task 长期 Pending

- `ray status`
- `ray list tasks`
- `ray list placement-groups`
- 最大 bundle 是否能装入节点
- Autoscaler 和 Kubernetes event

### 作业很慢

- Timeline 看 Task 粒度和空洞
- Cluster view 看物理资源
- Data/Train/Serve 自己的指标
- 对象 spill、网络和存储
- Driver 是否过早 `ray.get`

### 内存不断增长

- `ray memory`
- Driver/Actor 是否保存 ObjectRef
- 在途数量是否有限
- Worker heap profiler
- Pod/node limit 与 OOM event

### Serve 尾延迟高

- 请求队列和 ongoing requests
- Replica 数和启动状态
- 动态 batch 参数
- 下游 Handle/外部服务
- GPU 利用与显存
- P99 而非只有均值

### Train 无法扩展

- 数据加载是否供不上
- 梯度通信比例
- Worker GPU 是否都忙
- 全局 batch/学习率
- Checkpoint 写入是否阻塞

## 14. 本章对应的项目代码

- Dashboard：[`../doc/source/ray-observability/getting-started.rst`](../doc/source/ray-observability/getting-started.rst)
- 调试指南：[`../doc/source/ray-observability/user-guides/debug-apps/index.md`](../doc/source/ray-observability/user-guides/debug-apps/index.md)
- State CLI/API：[`../python/ray/util/state`](../python/ray/util/state)
- 日志配置：[`../doc/source/ray-observability/user-guides/configure-logging.md`](../doc/source/ray-observability/user-guides/configure-logging.md)
- Profiling：[`../doc/source/ray-observability/user-guides/profiling.md`](../doc/source/ray-observability/user-guides/profiling.md)
- 自定义指标：[`../doc/source/ray-observability/user-guides/add-app-metrics.rst`](../doc/source/ray-observability/user-guides/add-app-metrics.rst)
- 内存调试：[`../doc/source/ray-observability/user-guides/debug-apps/debug-memory.rst`](../doc/source/ray-observability/user-guides/debug-apps/debug-memory.rst)

下一章把 Core 和 AI Libraries 组合成几个完整业务场景。
