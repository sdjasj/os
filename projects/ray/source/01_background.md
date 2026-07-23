# 1. 分布式系统背景知识

本章补足后续源码阅读所需的最低背景。重点是建立概念之间的联系，而不是展开成完整的分布式系统教材。

## 1.1 进程、线程与节点

- **进程**拥有独立虚拟地址空间。两个 Python Worker 即使在同一台机器上，也不能直接读取对方的普通 Python 对象。
- **线程**共享同一进程的堆。线程间传对象便宜，但要处理锁、数据竞争和 Python GIL。
- **节点**在 Ray 中通常是一台机器或一个容器实例。每个节点运行一个 raylet，并有节点级对象存储能力。
- **集群**由一个 head 节点和零个或多个 worker 节点组成。head 节点额外运行 GCS 等控制面组件。

因此，“分布式调用”至少需要解决三件事：在哪里执行、如何传参数、如何拿结果。Ray 分别用调度器、序列化/对象存储、ObjectRef 解决。

## 1.2 同步调用、异步提交与 Future

普通 Python 调用：

```python
y = f(x)  # 调用者等待 f 完成，y 是值
```

Ray 调用：

```python
y_ref = f.remote(x)  # 提交后尽快返回，y_ref 是未来结果的句柄
y = ray.get(y_ref)   # 需要值时才等待
```

`ObjectRef` 在这里扮演 Future/Promise 的“读端”。这种间接层带来两个关键能力：

1. **流水化**：下游任务可以依赖上游 ObjectRef，无需 Driver 先把值取回。
2. **位置透明**：引用不要求对象与引用持有者位于同一节点。

```python
@ray.remote
def inc(x):
    return x + 1

a = inc.remote(1)
b = inc.remote(a)  # 传引用；Ray 在 b 执行前解析依赖
print(ray.get(b))
```

源码对应关系：公共 `ObjectRef` 类型由扩展模块导出，见
[python/ray/__init__.py](../python/ray/__init__.py)；任务参数在 protobuf 中表示为按引用或按值的 `TaskArg`，见
[src/ray/protobuf/common.proto](../src/ray/protobuf/common.proto) 的 `TaskArg` 和 `ObjectReference`。

## 1.3 RPC、IPC 与协议

跨进程调用不能直接调用对方函数，需要把“方法名 + 参数”编码成消息。

- **IPC**：同一节点上的进程间通信，例如 Worker 与本地 raylet 的 Unix domain socket 通道。
- **RPC**：跨地址空间的请求/响应。Ray 大量使用 gRPC。
- **protobuf**：描述消息结构和服务接口，生成多语言代码。Ray 的任务、Actor、worker lease、GCS 服务定义集中在 [src/ray/protobuf](../src/ray/protobuf)。
- **pub/sub**：一方发布状态更新，多方订阅；适合 Actor 状态、对象位置等异步变化。

阅读源码时，看到 `HandleXxx(request, reply, callback)` 往往是服务端 RPC handler；看到 `XxxClient` 或 `AsyncXxx` 往往是客户端。

## 1.4 序列化与零拷贝

Python 对象不能原样跨进程。Ray 需要把它变成字节：

- Python 函数和复杂对象通常借助 cloudpickle；
- 数据结构可能使用 Pickle protocol 5 的 out-of-band buffer；
- NumPy/Arrow 等连续内存数据有机会通过共享内存减少复制；
- 反序列化会重新建立 Python 对象，因此“远程 Worker 修改参数”通常不会修改 Driver 原对象。

Ray 源码入口包括：

- [python/ray/_common/serialization.py](../python/ray/_common/serialization.py)：Python 序列化上下文；
- [python/ray/cloudpickle](../python/ray/cloudpickle)：函数、闭包、类等 Python 对象序列化；
- [python/ray/_raylet.pyx](../python/ray/_raylet.pyx)：Python/C++ 对象转换边界。

“零拷贝”不是“永远不复制”。它通常意味着同节点读取某些共享内存 buffer 时避免一次数据复制；Python 容器、跨节点网络传输和格式转换仍可能复制。

## 1.5 共享内存对象存储

若每个 Worker 都保留一份大型数组，内存会快速膨胀。节点级共享内存存储允许多个进程映射同一份不可变数据。Ray 的 Plasma store 提供创建、seal、get、release 等操作；对象 seal 后不可修改，从而简化一致性。

当前源码中的关键类：

- [src/ray/object_manager/plasma/store.h](../src/ray/object_manager/plasma/store.h)：`PlasmaStore`；
- [src/ray/object_manager/object_manager.h](../src/ray/object_manager/object_manager.h)：节点间对象 pull/push；
- [src/ray/core_worker/store_provider/memory_store/memory_store.h](../src/ray/core_worker/store_provider/memory_store/memory_store.h)：进程内 `CoreWorkerMemoryStore`。

Ray 并非所有返回值都无条件放进 Plasma。CoreWorker 有进程内 memory store；较大的或需要共享/传输的对象会涉及 Plasma。阅读时应区分“worker heap”“CoreWorker memory store”“shared object store”和“spill 到磁盘”。

## 1.6 DAG、数据依赖与惰性执行

有向无环图（DAG）由节点和边组成。对计算图而言，节点是操作，边是数据依赖。例如：

```text
read_parquet -> map_batches -> filter -> write_parquet
```

惰性执行表示 API 调用先构建逻辑计划，真正需要结果时再优化并执行。优势是系统能融合操作、安排并行度并施加背压。Ray Data 的逻辑计划接口位于
[python/ray/data/_internal/logical/interfaces](../python/ray/data/_internal/logical/interfaces)，物理执行位于
[python/ray/data/_internal/execution](../python/ray/data/_internal/execution)。

普通 Ray Task 也自然形成动态任务 DAG，但它与 Ray Data 的显式逻辑/物理计划层不是同一个抽象。

## 1.7 背压

若生产者每秒产生 100 个 block，消费者每秒只处理 20 个，没有背压时中间队列会不断增长直至 OOM。背压就是让上游根据下游承载能力减速。

Ray 中可在不同层看到背压：

- `ray.wait` 控制 Driver 同时在途的 Task 数；
- streaming generator 限制未消费结果数；
- Ray Data executor 根据资源和输出队列决定是否继续调度 operator；
- Serve 用 `max_ongoing_requests` 和 `max_queued_requests` 限制副本与调用方队列；
- Actor 可限制 `max_pending_calls`。

背压不是单一开关，而是每个生产者/消费者边界都需要考虑的协议。

## 1.8 资源调度基础

Ray 的 `CPU`、`GPU` 和 custom resource 首先是**逻辑资源**。调度器用它们做准入和放置：

```python
@ray.remote(num_cpus=2, num_gpus=1, resources={"fast_disk": 0.5})
def train_one_shard():
    ...
```

这不等于 Linux cgroup 的硬隔离。`num_cpus=1` 不会阻止函数创建 32 个线程；GPU 则通常通过 `CUDA_VISIBLE_DEVICES` 做可见性隔离。源码中的 Python 选项校验位于
[python/ray/_common/ray_option_utils.py](../python/ray/_common/ray_option_utils.py)，集群资源调度位于
[src/ray/raylet/scheduling](../src/ray/raylet/scheduling)。

常见策略：

- PACK：尽量放在少量节点，减少通信；
- SPREAD：尽量分散，降低单节点故障域或资源竞争；
- Placement Group：一次原子预留多个 resource bundle，适合 gang scheduling；
- label selector/custom resource：表达硬件或拓扑约束。

## 1.9 Actor 模型

Actor 是“拥有私有状态、通过消息调用”的计算实体。Ray Actor 对应一个长期存在的 Worker 进程：

```python
@ray.remote
class Counter:
    def __init__(self):
        self.value = 0

    def inc(self):
        self.value += 1
        return self.value
```

与普通 Task 相比：

- Task 适合无状态、可横向并行的函数；
- Actor 适合模型常驻、连接池、状态机和需要顺序的更新；
- Actor handle 是远程实体句柄，不是 Actor 实例本身；
- 默认同步 Actor 方法按顺序执行；async 或多线程 Actor 可以并发，顺序语义随之变化。

## 1.10 故障模型与语义

分布式系统中要区分：

- 用户代码抛异常；
- Worker 进程崩溃；
- raylet/节点失败；
- 网络暂时不可达；
- 对象丢失；
- Driver 或所有者死亡。

“重试”也有不同层次：普通 Task 可按 `max_retries` 重试系统故障；`retry_exceptions` 决定是否重试应用异常；Actor 有 `max_restarts` 和 `max_task_retries`；Train/Tune/Serve 又各自有更高层恢复策略。

重试通常提供“至少一次尝试”，并不自动让外部副作用恰好执行一次。因此写文件、扣款、发送消息等任务必须自行保证幂等或使用事务键。

## 1.11 分布式垃圾回收

单进程引用计数只看本地指针，分布式对象引用可能被序列化到其他 Worker。Ray 的所有者要追踪 borrower；当全局没有有效引用且相关任务依赖结束时，数据才可回收。

关键实现位于 [src/ray/core_worker/reference_counter.h](../src/ray/core_worker/reference_counter.h)，测试位于
[src/ray/core_worker/tests/reference_counter_test.cc](../src/ray/core_worker/tests/reference_counter_test.cc)。后续第五章会把它与 ObjectRef 生命周期连起来。

## 1.12 机器学习上层库所需背景

- **数据并行训练**：每个 worker 持有模型副本，处理不同数据 shard，再通过 collective（如 all-reduce）同步梯度。
- **超参数搜索**：一个 Trial 是一组配置的一次训练；Search Algorithm 选择新配置，Scheduler 决定暂停、继续或提前终止 Trial。
- **在线服务副本**：多个 Replica 承载同一 Deployment，请求路由器做负载均衡、背压和重试。
- **强化学习**：EnvRunner 与环境交互产生轨迹，RLModule 做推理，Learner 消费样本更新参数；采样与学习可分布式扩展。

这些上层概念最终仍落到 Task、Actor、ObjectRef 和资源调度四个 Core 原语上。
