# 7. 资源调度、放置与容错

## 7.1 逻辑资源不是物理隔离

Ray resource 是字符串到浮点数量的映射：

```python
ray.init(
    num_cpus=8,
    num_gpus=2,
    resources={"fast_disk": 1},
)

@ray.remote(num_cpus=2, resources={"fast_disk": 0.25})
def task():
    ...
```

它主要用于：

- 判断 Task/Actor 能否在节点运行；
- 限制并发总量；
- 表达 GPU/TPU/自定义硬件；
- 向 Autoscaler 暴露资源需求。

它通常不提供 CPU 核绑定或内存硬限制。Ray 会为 GPU 设置可见设备，并会根据 `num_cpus` 设置一些线程环境变量，但用户代码仍需遵守声明。

## 7.2 资源从 API 到 TaskSpec

```text
@ray.remote/options
  -> ray_option_utils 校验
  -> resources_from_ray_options
  -> Cython prepare_resources
  -> TaskOptions.resources
  -> BuildCommonTaskSpec
  -> TaskSpec.required_resources
  -> SchedulingKey / LeaseSpecification
  -> raylet ClusterResourceScheduler
```

如果一个选项只在 Python 校验但没有进入 TaskOptions/TaskSpec，它不会影响 C++ 调度。反过来，协议字段没有公共 API 也可能是内部策略。

## 7.3 Worker lease 模型

普通 Task 的调度单位可以理解为“为一类任务租一个 Worker”：

```text
CoreWorker pending Task queue
  -> 选择 raylet
  -> RequestWorkerLease(TaskSpec/resources/runtime env)
  -> raylet 选择/启动 Worker 并分配资源
  -> 返回 Worker address + resource mapping
  -> CoreWorker PushNormalTask
  -> 完成后 Worker idle/return lease/继续复用
```

为何不让 raylet 永久接管完整 Task body？提交者保持 pending 状态和结果所有权，Task 可以从提交方直接发送到执行 Worker，减少中心中转；raylet 专注节点资源、Worker 池和放置。

## 7.4 节点选择与本地 dispatch

调度至少分两层：

1. **选择节点**：`ClusterResourceScheduler` 根据集群资源视图、策略、对象 locality、标签等选候选节点；
2. **本地分配**：`LocalLeaseManager` 等待本地资源、参数依赖和 Worker，随后 dispatch。

集群资源视图可能有传播延迟，所以候选远端可以拒绝 spillback 请求；提交方再回到本地入口重新选节点。分布式调度接受短暂不一致，用重试而不是全局锁维持吞吐。

关键源码：

- [cluster_resource_scheduler.cc](../src/ray/raylet/scheduling/cluster_resource_scheduler.cc)
- [cluster_resource_manager.cc](../src/ray/raylet/scheduling/cluster_resource_manager.cc)
- [cluster_lease_manager.cc](../src/ray/raylet/scheduling/cluster_lease_manager.cc)
- [local_lease_manager.cc](../src/ray/raylet/scheduling/local_lease_manager.cc)

## 7.5 Scheduling Strategy

### DEFAULT

使用默认混合策略，综合本地性、资源和集群负载。不要把 DEFAULT 简化成“永远本地优先”。

### SPREAD

倾向分散到不同节点，适合减少热点或故障相关性，但可能增加对象传输。

### NodeAffinity

指定某节点的软/硬亲和。硬亲和节点不可用时任务可能不可调度；软亲和允许回退。

### Label selector

用节点 label 表达硬件、可用区或自定义属性。Label 适合布尔/分类约束，custom resource 适合可计量容量。

### Fallback strategy

当前 API 还可表达一组软约束回退。阅读时注意它会从 Python task options 转换到 C++ `FallbackOption` 并写入 TaskOptions。

## 7.6 Placement Group

Placement Group（PG）原子预留多个 resource bundle：

```python
from ray.util.placement_group import placement_group

pg = placement_group(
    [{"CPU": 2, "GPU": 1}, {"CPU": 2, "GPU": 1}],
    strategy="SPREAD",
)
ray.get(pg.ready())
```

它解决单个 Task resource 无法表达的 gang scheduling 问题。例如两名训练 worker 必须一起获得 GPU，否则先拿到资源的 worker 空等并形成死锁。

常见策略：

- PACK：bundle 尽量同节点；
- STRICT_PACK：所有 bundle 同节点；
- SPREAD：尽量分散；
- STRICT_SPREAD：不同 bundle 严格不同节点。

PG 由 GCS placement group scheduler 参与管理，见
[gcs_placement_group_scheduler.h](../src/ray/gcs/gcs_placement_group_scheduler.h)。Task/Actor 侧将 bundle 约束编码进 scheduling strategy 和特殊资源键。

## 7.7 Pending、infeasible 与暂时不可用

调度不成功要区分：

- **资源当前忙**：等待现有任务释放；
- **集群总容量不足但节点类型可扩**：Autoscaler 可加节点；
- **请求在任何允许节点上都不可能满足**：infeasible/unschedulable；
- **runtime env 构建失败**：不是加机器能解决；
- **PG 已移除**：依赖该 PG 的任务应失败；
- **Worker 启动失败**：需要明确错误而不是无限排队。

`RequestWorkerLeaseReply::SchedulingFailureType` 把这些失败传回 `NormalTaskSubmitter`，后者将同一 scheduling key 队列中的相关 Task 失败或重试。

## 7.8 Autoscaler 的位置

Scheduler 决定“当前集群放在哪里”，Autoscaler 决定“是否改变集群容量”。raylet/GCS 汇总资源 demand，Autoscaler 依据节点类型和需求启动/终止节点。它不能修复：

- 请求了集群配置中不存在的 custom resource；
- 单 Task 需要 16 GPU，但最大节点只有 8 GPU；
- 用户代码死锁或 ObjectRef 循环依赖；
- PG 策略在拓扑上不可能满足。

调度问题诊断时，先看 demand shape，再看节点模板容量，而不是只看总 CPU/GPU 数。

## 7.9 容错分层

| 故障 | Core 默认/选项 | 上层还需做什么 |
|---|---|---|
| 用户函数异常 | 结果成为 `RayTaskError`；`retry_exceptions` 可选 | 确认异常是否真可重试 |
| 普通 Worker 崩溃 | `max_retries` 控制 Task 重试 | 外部副作用幂等 |
| Actor Worker 崩溃 | `max_restarts`, `max_task_retries` | checkpoint 恢复 Actor 状态 |
| 对象副本丢失 | 可尝试 lineage reconstruction | 关键状态持久化 |
| raylet/节点失败 | 节点标记死亡，相关 Task/Actor/对象恢复 | 多节点容量与副本策略 |
| Owner 死亡 | owned ObjectRef 可能失效 | 不把临时 owner 当永久存储 |
| Driver 死亡 | Job 与非 detached 实体受影响 | Job 重提、detached/外部编排 |
| GCS 故障 | 取决于持久化/高可用配置 | 集群级恢复设计 |

## 7.10 Task 重试语义

```python
@ray.remote(max_retries=3, retry_exceptions=[TimeoutError])
def write_once(request_id, value):
    ...
```

系统故障重试与应用异常重试分开配置。重试意味着相同逻辑 Task 的另一次 attempt，不保证第一次 attempt 完全没执行。若 Worker 在完成外部写入后、回复结果前崩溃，第二次 attempt 会再次写。

幂等模式：

- 使用业务 request ID 做去重；
- 目标存储使用 compare-and-set/事务；
- 写临时文件后原子 rename；
- 把可重复计算和不可重复提交拆为两阶段；
- 记录已提交 checkpoint/offset。

## 7.11 Actor 恢复语义

Actor restart 是“创建一个新进程并再次运行构造函数”，不是恢复旧进程内存。GCS/owner 维护 ActorID、重启和新 Worker address；ActorTaskSubmitter 订阅状态更新并重连。

如果 Actor 的业务状态重要：

```text
__init__
  -> 从 durable checkpoint 读取 last_version
method(request_id)
  -> 检查是否已处理
  -> 更新业务数据
  -> 原子保存 version / result
```

否则 `max_restarts` 只让“进程活回来”，业务状态仍回到初始值。

## 7.12 对象恢复与 owner

由 Task 产生的对象可以保留 lineage；对象丢失时，owner/TaskManager 发起重新执行。由 `ray.put` 产生的对象没有生产 Task。分布式引用计数还依赖 owner 存活，因此把 ObjectRef 保存成字符串/bytes 放到外部数据库，稍后跨 Ray session 构造回来，并不构成合法持久化协议。

跨 session 的数据应使用文件、数据库或对象存储 URI，新的 Job 再读取数据生成新的 ObjectRefs。

## 7.13 资源死锁案例

Ray 对普通 Task 内的阻塞 `ray.get` 有资源释放机制；例如
[test_basic.py](../python/ray/tests/test_basic.py) 的 `test_release_cpu_resources` 验证 parent 等待 child 时会释放普通 CPU 资源。因此不能把所有嵌套 `ray.get` 都简单判成死锁。

但长生命周期 Actor 保留显式资源时，仍可能等待需要同一稀缺资源的子任务：

```python
ray.init(num_gpus=1)

@ray.remote(num_gpus=1)
def child():
    return 1

@ray.remote(num_gpus=1)
class Parent:
    def run(self):
        # Parent Actor 生命周期内占有唯一 GPU，child 无法获得 GPU。
        return ray.get(child.remote())

parent = Parent.remote()
ray.get(parent.run.remote())
```

这会形成资源等待环。类似问题也可能出现在 Placement Group bundle、custom resource、多个 Actor 互相同步等待中。解决方向不是盲目增加超时，而是：

- 避免 Task 内阻塞等待子 Task；
- 给 parent/child 设计合适资源；
- 用异步/continuation 结构；
- 确保集群最小容量满足嵌套并发；
- 用 PG 时防止 bundle 互相占用等待。

## 7.14 调度问题诊断清单

1. `ray status` 看 resource demands 和 pending nodes；
2. State API/Dashboard 看 Task state 是 waiting for scheduling、dependencies、runtime env 还是 execution；
3. 对照 Task required resources 与单节点容量，不只看集群总量；
4. 检查 label、NodeAffinity、PG bundle index；
5. 检查 Actor 是否长期占用资源；
6. 检查嵌套 `ray.get` 和资源死锁；
7. 查 raylet 日志中的 lease cancellation/unschedulable 原因；
8. 最小化为单个 TaskSpec 再写 scheduler/lease manager 测试。

## 7.15 推荐源码测试

- [cluster_resource_scheduler_test.cc](../src/ray/raylet/scheduling/tests/cluster_resource_scheduler_test.cc)：节点选择与资源；
- [cluster_lease_manager_test.cc](../src/ray/raylet/scheduling/tests/cluster_lease_manager_test.cc)：集群 lease；
- [local_lease_manager_test.cc](../src/ray/raylet/scheduling/tests/local_lease_manager_test.cc)：本地排队/dispatch；
- [normal_task_submitter_test.cc](../src/ray/core_worker/task_submission/tests/normal_task_submitter_test.cc)：lease client 与重试；
- [actor_task_submitter_test.cc](../src/ray/core_worker/task_submission/tests/actor_task_submitter_test.cc)：Actor 连接、顺序与失败。

## 7.16 自测题

1. 为什么 16 个总 CPU 不一定能运行一个需要 8 CPU 的 Task？
2. 远端 raylet 为什么可以拒绝另一个 raylet/submitter 的选择？
3. Placement Group 与一次请求多个 CPU 的差别是什么？
4. Autoscaler 为什么不能解决任意 pending Task？
5. Task retry 为什么要求业务副作用幂等？
6. Actor restart 与进程内 checkpoint 有何区别？
