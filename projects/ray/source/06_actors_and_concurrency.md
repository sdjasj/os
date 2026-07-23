# 6. Actor、状态与并发

## 6.1 Task 与 Actor 的选择

```python
# 无状态、输入决定输出：Task
@ray.remote
def preprocess(batch):
    return transform(batch)

# 模型/连接/计数等跨调用状态：Actor
@ray.remote
class ModelWorker:
    def __init__(self, model_path):
        self.model = load_model(model_path)

    def predict(self, batch):
        return self.model(batch)
```

Actor 的本质不是“类语法更漂亮”，而是让一组方法固定路由到同一个长期 Worker，从而共享该进程内状态。

## 6.2 装饰 class：`ActorClass`

`@ray.remote` 发现输入是 class 后，在 [actor.py](../python/ray/actor.py) 中创建 `ActorClass`。Ray 会修改/包装原 class，收集：

- `__init__` 和各方法签名；
- generator/async 方法信息；
- 每个方法返回数、重试、concurrency group；
- class function descriptor；
- 默认 Actor options。

`ActorClass.__call__` 禁止 `Counter()`，要求 `Counter.remote()`。这是因为创建结果不是本地实例，而是 `ActorHandle`。

## 6.3 创建 Actor 的调用链

```text
Counter.remote(args)
  -> ActorClass._remote
     - 校验 name/namespace/lifetime
     - 判断 sync/async 与 max_concurrency
     - 导出 actor class
     - 计算 lifetime resources 和 placement resources
     - flatten __init__ args
  -> Cython core_worker.create_actor
  -> C++ CoreWorker::CreateActor
     - 生成 ActorID 和 actor creation TaskID
     - 构造 ActorCreationTaskSpec
     - 注册 Actor handle/owner 状态
     - 发起 Actor 创建与 GCS 调度
  -> 返回 ActorHandle
```

Actor 创建由 GCS actor manager 参与，因为 Actor 是需要全局定位、重启和命名的长期实体；这与普通 Task 的 worker lease 路径不同。GCS 相关实现位于
[src/ray/gcs/actor](../src/ray/gcs/actor)，创建侧 C++ 入口位于
[core_worker.cc](../src/ray/core_worker/core_worker.cc) 的 `CreateActor`。

与普通 Task 一样，`Counter.remote()` 返回 handle 不代表构造函数已经完成。首次方法调用对 creation task 有依赖；构造失败会通过 Actor 错误传播。

## 6.4 Actor 资源的历史默认值

`ActorClass._remote` 中存在兼容性较强的默认规则：没有显式资源时，Actor 创建需要 CPU 才能被放置，但生命周期内方法的 CPU 语义与“显式指定资源”的 Actor 不同。官方源码注释也建议显式设置 `num_cpus`，避免惊讶：

```python
@ray.remote(num_cpus=1, num_gpus=1)
class GPUModel:
    ...
```

资源通常为 Actor 整个生命周期保留，而不是每次方法调用重新找节点。这正适合常驻模型，但也意味着空闲 Actor 仍占逻辑资源。

## 6.5 方法调用链

```python
counter = Counter.remote()
ref = counter.inc.remote()
```

`ActorHandle` 为方法动态建立 `ActorMethod` shell，最终进入 `ActorHandle._actor_method_call`：

```text
actor.method.remote(args)
  -> ActorHandle._actor_method_call
     - flatten args
     - 选择方法 function descriptor
     - 处理 num_returns/retry/concurrency group
  -> Cython core_worker.submit_actor_task
  -> C++ CoreWorker::SubmitActorTask
     - 用 ActorID 找 ActorHandle 状态
     - 构造 ActorTaskSpec 和 sequence 信息
     - TaskManager 登记返回引用
  -> ActorTaskSubmitter::SubmitTask
  -> 直接发送到 Actor Worker CoreWorker
  -> TaskReceiver 的 Actor execution queue
  -> 调用目标 Python 实例方法
```

关键区别：Actor 已经固定在某个 Worker，普通方法调用无需为每次调用做任意节点的普通 Task 调度。`ActorTaskSubmitter` 仍要处理 Actor 未创建完成、重启换地址、网络失败、pending 上限和调用顺序。

## 6.6 ActorHandle 也是分布式引用

Handle 可被：

- Driver 持有；
- 作为参数传给 Task/另一个 Actor；
- cloudpickle 序列化；
- 通过 name 重新获取。

Actor 生命周期不能只看创建者的一个 Python 变量。`ActorHandle` 区分 original handle、forked handle 和 weak handle；CoreWorker 跟踪 handle references。最后一个强引用消失时，非 detached Actor 才可能被 GC。

源码注释集中在 [actor.py](../python/ray/actor.py) 的 `ActorHandle` 类，以及 C++ 的
[actor_manager.h](../src/ray/core_worker/actor_management/actor_manager.h)。

## 6.7 默认串行与调用顺序

同步 Actor 默认一次执行一个方法：

```python
@ray.remote
class BankAccount:
    def __init__(self):
        self.balance = 0

    def deposit(self, value):
        self.balance += value
        return self.balance
```

来自同一 submitter/handle 的调用带顺序元数据；Actor task queue 保证所需顺序并处理重试时的序列问题。但不要把它扩大解释成“所有网络来源之间天然具有全局实时顺序”。多 handle、多调用方和并发 Actor 需要更谨慎地定义一致性。

## 6.8 Async Actor

```python
import asyncio
import ray

@ray.remote
class Downloader:
    async def fetch(self, url):
        await asyncio.sleep(0.1)
        return url
```

若 class 含 async 方法，Ray 将其识别为 asyncio Actor。多个协程可在同一 Actor event loop 交错执行，适合高并发 I/O。注意：

- `time.sleep`、阻塞 `ray.get`、同步网络库会卡住整个 event loop；
- CPU 密集 Python 代码仍受 GIL 和单进程限制；
- `await` 处允许其他任务观察中间状态，应自己维护不变量；
- async Actor 默认允许 out-of-order execution，因为并发与严格完成顺序不兼容。

## 6.9 Threaded Actor 与 `max_concurrency`

同步方法配合 `max_concurrency > 1` 可由线程并发执行：

```python
@ray.remote(max_concurrency=4)
class ThreadedService:
    def handle(self, request):
        return blocking_io(request)
```

这适合释放 GIL 的原生库或阻塞 I/O。若多个方法修改同一字段，需要普通线程锁。Ray 只负责调度调用，不会自动让用户状态线程安全。

`ActorClass._remote` 会在 async/multithreaded Actor 上要求 out-of-order execution 与并发语义相容。

## 6.10 Concurrency Group

Concurrency group 让不同方法使用不同并发池/上限。例如将慢 I/O 与状态更新分开，避免一个类别占满全部并发。相关元数据在 Python `ActorClass` 收集，随创建请求传到 CoreWorker，执行侧按 group 选择 executor。

使用前先问：这是真正独立的资源域，还是在掩盖 Actor 承担了过多职责？很多时候拆成两个 Actor 更容易推理和扩缩容。

## 6.11 Named 与 detached Actor

```python
actor = Service.options(
    name="shared-service",
    namespace="demo",
    lifetime="detached",
).remote()

same_actor = ray.get_actor("shared-service", namespace="demo")
```

- **name + namespace**：提供发现机制；
- **detached**：生命周期不再绑定创建 Job，可跨 Driver 存活；
- `get_if_exists`：尝试获取或创建，但要考虑竞争；
- name 是控制面身份，不是负载均衡服务名。

Detached Actor 容易变成遗留资源。生产系统必须设计清理、版本迁移和所有权，而不是只依赖进程退出。

## 6.12 Actor 故障与重启

```python
@ray.remote(max_restarts=3, max_task_retries=2)
class StatefulWorker:
    ...
```

- `max_restarts`：Actor 进程/节点失败后允许重建实例的次数；
- `max_task_retries`：Actor task 遇到系统故障后重试次数；
- 用户方法异常默认不等于 Actor 进程死亡；
- 重启会重新运行 `__init__`，普通进程内字段丢失；
- 要恢复业务状态，必须从 checkpoint/外部存储加载。

方法“可能执行过但回复丢失”时，重试会重复副作用。为写数据库/消息系统的方法设计 request ID 和幂等处理。

## 6.13 Actor 反模式

1. 用一个全局 Actor 串行处理所有 CPU 工作：形成瓶颈。
2. 为每个微小请求创建 Actor：创建和调度成本过高。
3. 在 Actor 字段中无限保存 ObjectRefs：对象长期 pinned。
4. async Actor 内调用阻塞库：吞吐骤降。
5. 依赖进程内状态却配置重启：重启后语义错误。
6. 未显式设置资源：规模扩大后放置与并发行为意外。
7. 把 named Actor 当永久数据库：GCS 名字发现不提供业务持久性。

## 6.14 何时拆 Actor

当一个 Actor 同时出现以下三个以上特征，应考虑拆分：

- 不同方法需要不同资源；
- 一部分要严格串行，另一部分要高并发；
- 状态可以按 key 分片；
- checkpoint/恢复周期不同；
- 一个慢调用会阻塞不相关请求；
- 单 Actor mailbox 持续积压。

常见模式是 supervisor Actor 管元数据，多个 worker Actor 按 key 或 shard 承载状态。

## 6.15 自测题

1. 为什么 `ActorClass.remote()` 返回时 `__init__` 可能还没完成？
2. 普通 Task 和 Actor method 在调度路径上的关键差异是什么？
3. async Actor 内为什么不能用阻塞 `ray.get`？
4. Actor 重启后哪些状态自动恢复，哪些不会？
5. ActorHandle 从 Driver 传到 Worker 后，生命周期为什么变复杂？
6. 什么情况下 concurrency group 不如拆成多个 Actor？

