# 02. Ray Core Tasks：无状态并行计算

## 1. Task 适合表达什么

Task 是一次远程函数调用，适合输入决定输出、调用之间不需要共享可变状态的计算：

- 文件或数据分片转换；
- 参数扫描和仿真；
- 并行网络请求；
- CPU/GPU 推理批次；
- 构建 fan-out/fan-in 的计算 DAG。

如果多次调用需要复用模型、数据库连接或可变状态，Actor 往往更合适。

## 2. 基础语法

```python
import ray

ray.init()

@ray.remote
def normalize(values):
    total = sum(values)
    return [value / total for value in values]

result_ref = normalize.remote([1, 2, 3])
result = ray.get(result_ref)
```

普通调用与远程调用的对应关系：

| 普通 Python | Ray Task |
| --- | --- |
| `normalize(data)` | `normalize.remote(data)` |
| 直接返回值 | 立即返回 `ObjectRef` |
| 当前进程执行 | Ray Worker 执行 |
| 调用点同步 | 提交异步，`ray.get` 时同步 |

不要写 `normalize(...)`；被 `@ray.remote` 包装后，公开调用入口是 `.remote()`。

## 3. 用 ObjectRef 表达依赖图

```python
@ray.remote
def load(partition):
    return [partition, partition + 1]

@ray.remote
def transform(values):
    return [value * 10 for value in values]

@ray.remote
def merge(parts):
    return [value for part in parts for value in part]

loaded = [load.remote(i) for i in range(4)]
transformed = [transform.remote(ref) for ref in loaded]
final_ref = merge.remote(transformed)
print(ray.get(final_ref))
```

顶层参数是 `ObjectRef` 时，Ray 会在值就绪后把解析后的对象传给下游 Task。Driver 不需要先 `ray.get(loaded)`，因此调度器能保留流水线并行和数据局部性。

应避免：

```python
# Driver 先把所有中间结果拉回，再重新发出去。
loaded_values = ray.get(loaded)
transformed = [transform.remote(value) for value in loaded_values]
```

只有 Driver 本身必须读取、打印或做本地决策时，才需要在中间 `ray.get()`。

## 4. 多返回值

当一个 Task 逻辑上产生多个独立下游结果，可以声明返回数量：

```python
@ray.remote(num_returns=2)
def split(values):
    midpoint = len(values) // 2
    return values[:midpoint], values[midpoint:]

left_ref, right_ref = split.remote(list(range(10)))
```

这样下游可以分别等待左右分片。若返回数量运行时变化，查看动态返回值 API；初学阶段优先保持固定结构。

## 5. `ray.get` 与 `ray.wait`

### 5.1 `ray.get`

`ray.get(ref)` 等待一个对象，`ray.get(list_of_refs)` 等待列表中的全部对象。

```python
values = ray.get(refs)
```

适合必须收齐全部结果的 barrier。

### 5.2 `ray.wait`

`ray.wait` 等到部分结果完成，适合流式消费、超时和限制在途任务：

```python
pending = [work.remote(item) for item in items]

while pending:
    ready, pending = ray.wait(pending, num_returns=1)
    value = ray.get(ready[0])
    consume(value)
```

结果顺序是完成顺序，而不是提交顺序。如果业务必须保序，需要携带索引并在最终排序。

## 6. 限制在途任务，避免内存爆炸

一次提交百万个 Task 会让控制面和对象存储承受压力。常用模式是维护固定窗口：

```python
MAX_IN_FLIGHT = 32
pending = []
results = []

for item in items:
    pending.append(work.remote(item))
    if len(pending) >= MAX_IN_FLIGHT:
        ready, pending = ray.wait(pending, num_returns=1)
        results.append(ray.get(ready[0]))

while pending:
    ready, pending = ray.wait(pending, num_returns=1)
    results.append(ray.get(ready[0]))
```

完整版本见 [`examples/bounded_tasks.py`](examples/bounded_tasks.py)。这个窗口同时实现两种背压：限制调度元数据数量，并及时消费完成对象。

对于标准数据处理，优先考虑 Ray Data；它已经实现算子级流式执行和并发控制，不必自己维护大量细粒度 Task。

## 7. 配置资源

装饰器级固定配置：

```python
@ray.remote(num_cpus=2, num_gpus=0.5, memory=2 * 1024**3)
def infer(batch):
    ...
```

调用级动态配置：

```python
ref = infer.options(
    num_cpus=1,
    num_gpus=0.25,
    resources={"accelerator_type_a": 0.001},
).remote(batch)
```

资源数影响调度并发度。声明过小会过载节点，声明过大会造成资源闲置或 Task 永远等待。CPU 密集函数通常从 `num_cpus=1` 开始；内部使用多线程的数值计算要与 `OMP_NUM_THREADS`、框架线程数一起校准。

## 8. Task 粒度

远程调用包含序列化、提交、调度、进程通信和结果管理开销。经验原则：

- 不要把每个标量运算变成一个 Task；
- 把很多小元素组成批次；
- 让单个 Task 至少包含有意义的计算或 I/O；
- 用基准测试选择批大小，而不是照搬固定数字。

例如将 10 万行逐行 Task 改成每 1,000 行一个 Task，通常会显著降低调度开销。

## 9. 传参、序列化与闭包

Ray 使用序列化传递函数、参数和结果。常见要求：

- 函数和自定义类应可导入或可被 cloudpickle 序列化；
- 不要把线程锁、打开的套接字等不可序列化对象作为参数；
- 不要在闭包里无意捕获很大的模型或数据；
- 大型只读对象可先 `ray.put()`，然后把引用传给多个调用；
- 连接应在 Worker 内创建，或者由 Actor 长期持有。

```python
large_lookup_ref = ray.put(large_lookup)
refs = [lookup.remote(item, large_lookup_ref) for item in items]
```

`ray.put` 能表达共享引用，但不意味着每台机器永远只有一份物理副本；跨节点使用时仍可能发生对象传输。

## 10. 错误、重试与超时

Worker 中的异常会在 `ray.get()` 时以 Ray 异常传播到 Driver：

```python
try:
    value = ray.get(may_fail.remote(item))
except ray.exceptions.RayTaskError as exc:
    print(exc)
```

可配置 Task 重试：

```python
@ray.remote(max_retries=3, retry_exceptions=True)
def flaky_operation(item):
    ...
```

重试前必须区分：

- **系统故障**：Worker/节点失败，通常适合重试；
- **业务异常**：输入非法，盲目重试没有意义；
- **外部副作用**：写库、扣费、发消息，重试可能重复执行。

超时读取：

```python
try:
    value = ray.get(ref, timeout=10)
except ray.exceptions.GetTimeoutError:
    ...
```

读取超时不一定取消 Task。若确实需要取消，使用 `ray.cancel(ref)`，并明确理解是否递归取消子任务以及底层操作能否被安全中断。

## 11. 常见模式

### 11.1 Fan-out / fan-in

```python
partials = [map_partition.remote(part) for part in partitions]
total = ray.get(reduce_results.remote(partials))
```

### 11.2 流水线

```python
loaded = load.remote(path)
cleaned = clean.remote(loaded)
features = featurize.remote(cleaned)
saved = save.remote(features)
ray.get(saved)
```

### 11.3 嵌套 Task

远程函数可以提交子任务，但要避免父 Task 在占有稀缺资源时同步等待大量同资源子任务，从而造成调度饥饿。优先由 Driver 编排，或使用合理的资源/Placement Group 策略。

## 12. 何时升级为 Actor 或 Data

选择 Actor：

- 每次 Task 都在重复加载同一个大模型；
- 需要保持连接、缓存或计数器；
- 需要把一串操作串行地作用于同一状态。

选择 Data：

- 输入天然是数据集或文件集合；
- 需要 map、filter、groupby、repartition 和多种读写器；
- 需要批量推理、流式执行和自动背压；
- 需要直接把数据分片送入 Train。

## 13. 本章对应的项目代码

- `@ray.remote` 公共入口：[`../python/ray/__init__.py`](../python/ray/__init__.py)
- 远程函数实现：[`../python/ray/remote_function.py`](../python/ray/remote_function.py)
- Worker/Driver API：[`../python/ray/_private/worker.py`](../python/ray/_private/worker.py)
- Task 用户指南：[`../doc/source/ray-core/tasks.rst`](../doc/source/ray-core/tasks.rst)
- 限制并发模式：[`../doc/source/ray-core/patterns/limit-running-tasks.rst`](../doc/source/ray-core/patterns/limit-running-tasks.rst)

下一章用 Actor 解决“计算需要长期状态”的问题。
