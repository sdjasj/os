# 3. Ray Core 总体架构

## 3.1 一句话模型

Ray Core 是一个把“Python 函数/类方法 + 资源需求 + 对象依赖”转换成跨进程执行的分布式运行时。

最小用户程序：

```python
import ray

ray.init()

@ray.remote
def square(x):
    return x * x

refs = [square.remote(i) for i in range(4)]
print(ray.get(refs))
```

背后至少涉及 Driver 的 CoreWorker、本地 raylet、Worker 进程、对象存储；多节点时还会涉及远端 raylet/ObjectManager 和 GCS。

## 3.2 组件关系

```text
Head node
┌─────────────────────────────────────────────────────────────┐
│ Driver process                                              │
│ Python API ─ Cython _raylet ─ CoreWorker                    │
│          │ TaskSpec / lease request                         │
│          ▼                                                  │
│ raylet: NodeManager + WorkerPool + lease/resource scheduler │
│          │                          │                       │
│          ▼                          ▼                       │
│ Python Worker(s)             Plasma/ObjectManager           │
│                                                             │
│ GCS server: jobs, nodes, actors, placement groups, metadata │
└─────────────────────────────────────────────────────────────┘
                 │ gRPC / pub-sub / object transfer
Worker node      ▼
┌─────────────────────────────────────────────────────────────┐
│ raylet + Worker(s) + Plasma/ObjectManager                   │
└─────────────────────────────────────────────────────────────┘
```

图中 CoreWorker 不是单独的系统进程，而是链接到 Driver/Worker 进程内的本地运行时对象。

## 3.3 Driver

Driver 是运行用户入口脚本的进程。它负责：

- 调用 `ray.init()` 加入或创建集群；
- 导出远程函数和 Actor class 定义；
- 提交任务与创建 Actor；
- 持有 ObjectRef/ActorHandle；
- 可选择阻塞等待结果。

Driver 不等于 head node。Driver 可以连接远程集群，也可以有多个 Job/Driver 共享一个集群。

## 3.4 Worker 与 CoreWorker

Worker 是实际执行 Python 远程函数或承载 Actor 的进程。每个 Driver/Worker 内部都有 `CoreWorker`：

- 生成 TaskID/ObjectID；
- 构造 TaskSpec；
- 管理任务提交与执行；
- 管理进程内对象、共享对象和引用；
- 与 raylet、其他 CoreWorker、GCS 通信。

C++ 类定义在 [core_worker.h](../src/ray/core_worker/core_worker.h)，实现位于
[core_worker.cc](../src/ray/core_worker/core_worker.cc)。它是理解 Ray Core 的中心枢纽，但不建议从类第一行顺序读完；应按 `SubmitTask`、`Get`、`CreateActor` 等用例分段阅读。

## 3.5 raylet

每个节点一个 raylet，主入口在 [src/ray/raylet/main.cc](../src/ray/raylet/main.cc)。它组合了：

- `NodeManager`：RPC handler 和节点级协调；
- Worker pool：启动、注册、复用 Worker；
- resource/lease scheduler：根据资源和策略选择节点；
- ObjectManager 与 Plasma store runner；
- 本地对象、spill、GC、节点状态等回调。

普通任务并不是“GCS 给每个 Task 选节点”。当前主路径由提交方 CoreWorker 向 raylet 请求 worker lease，raylet 的分布式调度逻辑决定本地接收或重定向/重试。

## 3.6 GCS

GCS（Global Control Service）是集群控制面的核心。入口在
[gcs_server_main.cc](../src/ray/gcs/gcs_server_main.cc)，`GcsServer` 在
[gcs_server.h](../src/ray/gcs/gcs_server.h)。它管理或服务于：

- Job 和节点注册；
- Actor 元数据与 Actor 调度；
- Placement Group；
- 集群资源/Autoscaler 信息；
- internal KV；
- pub/sub 和可观测性数据。

控制面存“在哪里、是什么状态”等元数据，数据面负责搬运实际对象字节。把所有对象内容都经过 GCS 会形成中心瓶颈，因此 Ray 将对象传输放在节点 ObjectManager 之间。

## 3.7 对象存储与 ObjectManager

每个节点有共享对象存储。`PlasmaStore` 管理本地共享内存中的不可变对象；`ObjectManager` 负责对象位置、pull/push 和跨节点分块传输。CoreWorker 还维护进程内 memory store。

当任务依赖的对象不在执行节点：

1. 调度/依赖管理知道该 Task 需要哪些 ObjectID；
2. 本地 ObjectManager 请求拉取；
3. 拥有副本的远端 ObjectManager 发送数据；
4. 对象本地可用后，Task 才能运行。

这解释了为什么“任务已分配 Worker”不等于“用户函数马上开始”：它还可能等待参数获取、runtime env 或 Worker 启动。

## 3.8 `ray.init()` 启动了什么

Python 入口在 [worker.py](../python/ray/_private/worker.py) 的 `init`。本地启动主路径简化如下：

```text
ray.init()
  -> 构造 RayParams
  -> Node(..., head=True)
       -> start_head_processes()
            -> start_gcs_server()
            -> start_monitor()
            -> start_api_server()/dashboard
       -> start_ray_processes()
            -> determine_plasma_store_config()
            -> start_log_monitor()
            -> start_raylet()
  -> connect(... global_worker ...)
       -> 创建/连接 Driver CoreWorker
```

对应代码：

- [python/ray/_private/worker.py](../python/ray/_private/worker.py)：本地创建与 `connect`；
- [python/ray/_private/node.py](../python/ray/_private/node.py)：`start_head_processes`、`start_ray_processes`；
- [python/ray/_private/services.py](../python/ray/_private/services.py)：拼接并启动 GCS/raylet 等进程命令。

连接已有集群时不会在 Driver 机器上按同样方式创建新集群；`ray.init(address=...)` 主要建立到已有控制面的连接。

## 3.9 控制面与数据面

| 问题 | 主要平面 | 典型组件 |
|---|---|---|
| 节点是否存活？Actor 在哪？ | 控制面 | GCS、raylet heartbeat/pub-sub |
| Task 需要多少 CPU？ | 控制面/调度 | TaskSpec、raylet scheduler |
| 大数组的实际字节在哪里？ | 数据面 | Plasma、ObjectManager |
| 远端 Actor 方法参数与结果 | 数据面 + 控制元数据 | CoreWorker RPC、对象依赖 |
| Dashboard 显示任务状态 | 可观测性/控制数据 | task events、GCS/dashboard |

真实系统里边界不是绝对的，但这个划分能避免把“元数据查询”和“对象搬运”混为一谈。

## 3.10 普通任务的高层时序

```text
Driver Python        Driver CoreWorker       raylet          Worker CoreWorker
     |                       |                  |                    |
     | f.remote(args)        |                  |                    |
     |---------------------->| Build TaskSpec   |                    |
     |<-- ObjectRef ---------|                  |                    |
     |                       | request lease    |                    |
     |                       |----------------->| choose/start worker|
     |                       |<-----------------| worker address     |
     |                       | push task --------------------------->|
     |                       |                  |   resolve args     |
     |                       |                  |   execute Python   |
     |                       |<---------------------- result --------|
     | ray.get(ref)          |                  |                    |
     |---------------------->| wait/fetch       |                    |
     |<----------------------| deserialize      |                    |
```

重要点：ObjectRef 在任务执行完成前就创建；返回值 ObjectID 可由 TaskID 和返回索引等确定性信息构造，因此调用者无需等 Worker 先“发一个 ID 回来”。

## 3.11 状态所有权表

| 状态 | 主要所有者 | 失效影响 |
|---|---|---|
| 用户入口与本地引用 | Driver | Driver 死亡会影响其拥有对象和非 detached Actor 生命周期 |
| Task 提交、pending task | 提交方 CoreWorker | 用于重试、结果引用和 lineage |
| 节点资源与 Worker 池 | raylet | 节点级调度与 Worker 生命周期 |
| Actor 全局状态 | GCS actor manager + Actor owner | Actor 重启、命名和位置解析 |
| 对象实际 bytes | 某节点 memory/Plasma/spill | 可有多副本；丢失时可能重建 |
| 分布式对象引用 | owner CoreWorker + borrowers | 决定对象何时可释放 |
| Job/node/PG 元数据 | GCS | 集群控制与查询 |

“谁拥有状态”是定位 bug 的第一步。例如 Actor 方法发不出去，应区分 handle 本地状态、GCS Actor 状态、ActorTaskSubmitter 连接状态和目标 Worker 是否存活。

## 3.12 先读哪些源文件

建议顺序：

1. [python/ray/__init__.py](../python/ray/__init__.py)：公共 API 从哪导出；
2. [python/ray/_private/worker.py](../python/ray/_private/worker.py)：初始化和对象 API；
3. [python/ray/remote_function.py](../python/ray/remote_function.py)：普通任务 Python 入口；
4. [python/ray/_raylet.pyx](../python/ray/_raylet.pyx)：语言边界；
5. [src/ray/core_worker/core_worker.cc](../src/ray/core_worker/core_worker.cc)：TaskSpec 与提交；
6. [normal_task_submitter.cc](../src/ray/core_worker/task_submission/normal_task_submitter.cc)：lease；
7. [node_manager.cc](../src/ray/raylet/node_manager.cc) 的 `HandleRequestWorkerLease`；
8. [src/ray/raylet/scheduling](../src/ray/raylet/scheduling)：节点选择和本地 dispatch。

下一章会严格沿这条链展开。

## 3.13 自测题

1. CoreWorker 为什么不是 raylet 的别名？
2. Driver 一定运行在 head node 吗？
3. 为什么实际对象不全部存进 GCS？
4. 为什么拿到 ObjectRef 不代表任务已开始？
5. 一个任务已经获得 Worker 后，还可能等待哪些条件？
6. 如果要查“Actor 当前在哪个节点”，你首先想到控制面还是对象数据面？

