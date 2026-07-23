# 03. Ray Core Actors：有状态并行计算

## 1. Actor 是什么

Actor 是远程类的实例。Ray 为它启动一个长期存在的 Worker 进程，类字段留在该进程内，方法通过 Actor Handle 远程调用。

```python
import ray

ray.init()

@ray.remote(num_cpus=1)
class Counter:
    def __init__(self):
        self.value = 0

    def increment(self, amount=1):
        self.value += amount
        return self.value

    def get(self):
        return self.value

counter = Counter.remote()
refs = [counter.increment.remote() for _ in range(3)]
print(ray.get(refs))
print(ray.get(counter.get.remote()))
```

完整示例见 [`examples/actors.py`](examples/actors.py)。

## 2. Actor 与 Task 的区别

| 维度 | Task | Actor |
| --- | --- | --- |
| 状态 | 每次调用独立 | 实例字段跨调用保留 |
| Worker | 可由调度器选择 | 固定 Actor 进程 |
| 调用开销 | 适合批量无状态计算 | 适合复用昂贵初始化 |
| 默认顺序 | 调用相互独立 | 同一同步 Actor 方法通常串行 |
| 典型用途 | 转换、仿真、独立请求 | 模型服务、缓存、连接、协调器 |
| 扩缩方式 | 增加 Task 即可 | 创建 Actor 池或使用上层库 |

Actor 不是“共享内存对象”。Driver 持有的是 Handle，真实状态在远端进程中；读取字段也必须通过远程方法。

## 3. Actor 最有价值的三种场景

### 3.1 复用昂贵初始化

```python
@ray.remote(num_gpus=1)
class ModelWorker:
    def __init__(self, model_path):
        self.model = load_model(model_path)

    def predict(self, batch):
        return self.model(batch)
```

模型只加载一次，后续调用复用显存和权重。若要在线 HTTP 服务和自动扩缩，优先 Ray Serve；若做批量推理，优先 Ray Data 的类 UDF。

### 3.2 持有外部连接

```python
@ray.remote
class DatabaseWriter:
    def __init__(self, dsn):
        self.client = connect(dsn)

    def write_batch(self, rows):
        return self.client.upsert(rows)
```

这避免每次 Task 重建连接，但要处理连接断开、重连、幂等写入和凭证生命周期。

### 3.3 串行化状态更新

同一个同步 Actor 的方法按邮箱顺序执行，可以把并发写操作收敛到单个状态所有者。例如计数、速率限制或参数更新。但单 Actor 也可能成为吞吐瓶颈，需要分片多个 Actor。

## 4. 方法调用仍然是异步的

```python
ref1 = counter.increment.remote()
ref2 = counter.increment.remote()

# 此时 Driver 没有等待。
values = ray.get([ref1, ref2])
```

不要在热循环里每次立刻 `ray.get()`：

```python
for item in items:
    ray.get(worker.process.remote(item))  # 串行等待
```

可以先提交一批，或使用多个 Actor 组成池。注意：对同一个串行 Actor，先提交并不会让方法并发执行，但能让 Driver 与 Actor 重叠工作；跨多个 Actor 才能获得水平并行。

## 5. Actor 并发模型

### 5.1 同步 Actor

普通方法默认串行执行，最容易推理状态一致性。显式设置 `num_cpus`：

```python
@ray.remote(num_cpus=1)
class SafeState:
    ...
```

Ray Actor 的历史默认 CPU 语义比较特殊，所以生产代码不要依赖默认值。

### 5.2 Async Actor

包含 `async def` 方法的 Actor 可以在一个事件循环中并发等待 I/O：

```python
@ray.remote
class Fetcher:
    async def fetch(self, url):
        async with self.session.get(url) as response:
            return await response.text()
```

异步并发适合 I/O，不会让单线程 CPU 计算自动并行。方法中使用阻塞库会阻塞 Actor 事件循环。

### 5.3 并发组

Concurrency Group 可为不同方法配置并发上限，例如把快速查询和慢写入分开。使用它意味着你必须自己保证共享状态的并发安全；初学时先用串行 Actor。

## 6. 多个 Actor 的分片模式

```python
NUM_SHARDS = 4
shards = [KeyValueShard.remote() for _ in range(NUM_SHARDS)]

def shard_for(key):
    return shards[hash(key) % NUM_SHARDS]

refs = [shard_for(key).put.remote(key, value) for key, value in records]
ray.get(refs)
```

分片提高吞吐量，但带来重新分片、热点键、跨分片事务和一致性问题。若需求已经是成熟键值数据库语义，不应自己用 Actor 重造数据库。

## 7. 命名 Actor 与命名空间

命名 Actor 允许其他 Driver 找到已有 Actor：

```python
worker = Worker.options(name="shared-worker", namespace="demo").remote()
```

另一个连接到同一集群、同一命名空间的 Driver：

```python
ray.init(address="auto", namespace="demo")
worker = ray.get_actor("shared-worker")
```

需要跨 Driver 存活时可配置 detached 生命周期：

```python
worker = Worker.options(
    name="shared-worker",
    lifetime="detached",
).remote()
```

Detached Actor 不会随创建它的 Driver 自动退出，必须有清理、所有权和版本升级策略。不要把它当作永久持久化存储。

## 8. Actor 生命周期与故障

Actor 可能因为以下原因退出：

- 构造函数异常；
- 未捕获的进程级错误；
- 节点失败或被抢占；
- 调用 `ray.kill(actor)`；
- 所有引用消失且生命周期允许回收；
- Driver 退出。

可配置重启：

```python
@ray.remote(max_restarts=3, max_task_retries=-1)
class RecoverableWorker:
    ...
```

重启只会重建进程并再次执行 `__init__`，内存字段不会自动恢复。可靠 Actor 要把关键状态写入外部持久存储，或定期创建检查点并在构造时加载。

## 9. Actor 句柄传递

Actor Handle 可以作为 Task/Actor 参数传递：

```python
@ray.remote
def submit_to_counter(counter, amount):
    return ray.get(counter.increment.remote(amount))
```

这可以构建协调关系，但过多组件都直接依赖同一个 Actor 会形成中心瓶颈和复杂调用图。尽量让所有权清晰，避免循环等待。

## 10. 避免死锁和饥饿

危险模式包括：

- Actor A 同步等待 B，B 又同步等待 A；
- Actor 占有唯一 GPU，却等待另一个也需要唯一 GPU 的 Task；
- 并发方法同时修改未加保护的状态；
- 长方法阻塞了同一 Actor 的健康检查或快速查询。

改进方式：

- 用 ObjectRef 组合异步依赖，减少内部阻塞；
- 拆分控制 Actor 与计算 Actor；
- 显式声明资源并检查总需求；
- 对长任务提供独立 Worker 或分片；
- 使用超时、状态查询和幂等重试。

## 11. Actor 池与上层库

若你只是需要 N 个同构模型 Worker，可以自己轮询 Actor，但优先考虑已有抽象：

- 批量推理：Ray Data `map_batches` + callable class；
- 在线服务：Ray Serve Deployment replicas；
- 分布式训练：Ray Train workers；
- 超参数试验：Ray Tune trials。

它们已经处理分片、并发、生命周期和观测，减少自定义调度代码。

## 12. 本章对应的项目代码

- Actor 公共实现：[`../python/ray/actor.py`](../python/ray/actor.py)
- Actor 用户指南：[`../doc/source/ray-core/actors.rst`](../doc/source/ray-core/actors.rst)
- Async Actor：[`../doc/source/ray-core/actors/async_api.rst`](../doc/source/ray-core/actors/async_api.rst)
- 命名 Actor：[`../doc/source/ray-core/actors/named-actors.rst`](../doc/source/ray-core/actors/named-actors.rst)
- Actor 容错：[`../doc/source/ray-core/fault_tolerance/actors.rst`](../doc/source/ray-core/fault_tolerance/actors.rst)

下一章解释 Task 和 Actor 共同依赖的对象存储、资源调度、Placement Group 和 Runtime Environment。
