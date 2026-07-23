# 5. ObjectRef、序列化与内存

## 5.1 ObjectRef 不是对象地址

`ObjectRef` 包含对象身份和 owner 等运行时信息，但不是可以在任意进程解引用的裸内存地址。它解决的是“如何指代未来或远端对象”，实际 bytes 可能：

- 尚未产生；
- 在当前 Worker 的进程内 memory store；
- 在本节点 Plasma；
- 在其他节点 Plasma；
- 已 spill 到磁盘；
- 因故障丢失，等待 lineage reconstruction；
- 以错误对象表示任务失败。

因此 `ref` ready、对象本地可用和 Python 值已反序列化是三个不同状态。

## 5.2 `ray.put` 调用链

```python
data_ref = ray.put({"values": list(range(1000))})
```

主路径：

```text
worker.py::put
  -> Worker.put_object
  -> SerializationContext.serialize(value)
  -> _raylet.pyx::CoreWorker.put_object
  -> put_serialized_object_and_increment_local_ref
  -> C++ CoreWorker::CreateOwnedAndIncrementLocalRef
  -> Plasma provider Create / write bytes / SealOwned
  -> 返回带 owner address 的 ObjectRef
```

C++ 在创建对象前生成 ObjectID，并通过 `ReferenceCounter::AddOwnedObject` 登记所有权、contained ObjectRefs、大小、call site 等。随后创建 buffer，Cython 把序列化结果写入 buffer，最后 seal。

`ray.put` 产生的对象通常不可通过 lineage 重算，因为它没有一个可重执行的生产 Task；源码给它标记 `INELIGIBLE_PUT`。这也是“把关键中间状态只 `ray.put` 一次”与“由可重试 Task 产出”的容错差异。

## 5.3 Task 返回对象

普通 Task 返回值的 ObjectID 在提交侧已生成。执行 Worker 对结果序列化后，根据大小、传输和配置选择内联返回或 Plasma 路径。小结果可以随 Task reply 返回，减少额外对象存储往返；大结果进入共享存储。

不要把优化细节当成 API 语义：用户只应依赖 ObjectRef 和不可变对象语义，不应假设某个大小的返回值一定在进程内或 Plasma。

## 5.4 按值传参和按引用传参

```python
large = make_large_array()

# 每次提交都处理普通 Python 参数。
refs = [consume.remote(large) for _ in range(100)]

# 明确只 put 一次，再复用引用。
large_ref = ray.put(large)
refs = [consume.remote(large_ref) for _ in range(100)]
```

第二种写法明确表达共享依赖，通常能减少重复序列化和 Driver heap 压力。Ray 也会自动把过大的按值参数放入对象存储，但显式 `ray.put` 更清楚地控制复用边界。

例外：不要在远程函数里 `return ray.put(value)`。这会让返回值成为嵌套 ObjectRef，增加所有权和容错复杂性，并可能让生产 Task 的 lineage 无法直接重建实际值。通常直接 `return value`。

## 5.5 `ray.get` 的 C++ 路径

`CoreWorker::Get` 最终进入 `GetObjects`：

1. 验证对象 owner 已知；
2. 先向 `CoreWorkerMemoryStore` 请求；
3. memory store 中的 `OBJECT_IN_PLASMA` 是一个哨兵，表示应去 Plasma；
4. 对 Plasma 对象获取 owner address，并调用 store provider 的 fetch-and-get；
5. 按输入 ID 顺序组装结果；
6. Python 层反序列化并把错误对象转成异常。

关键代码见 [core_worker.cc](../src/ray/core_worker/core_worker.cc) 的 `CoreWorker::Get`、`GetObjects`，以及
[memory_store.h](../src/ray/core_worker/store_provider/memory_store/memory_store.h)。

### `get` 是同步边界

```python
# 反模式：每次提交后立刻等待，趋向串行。
results = [ray.get(work.remote(x)) for x in xs]

# 正确的批量并行形状。
refs = [work.remote(x) for x in xs]
results = ray.get(refs)
```

在 async Actor 内，阻塞 `ray.get` 会卡住 event loop；应优先 `await ref` 或 `asyncio.gather`。

## 5.6 `ray.wait` 与有界并发

`ray.wait(refs, num_returns=k, timeout=t, fetch_local=...)` 返回 ready 和 remaining 两组引用。它适合：

- 按完成顺序消费，避免慢任务阻塞整个列表；
- 限制在途任务数，建立 Driver 侧背压；
- 实现超时、投机执行或部分结果。

```python
pending = []
results = []
max_in_flight = 8

for item in items:
    pending.append(process.remote(item))
    if len(pending) >= max_in_flight:
        ready, pending = ray.wait(pending, num_returns=1)
        results.extend(ray.get(ready))

while pending:
    ready, pending = ray.wait(pending, num_returns=1)
    results.extend(ray.get(ready))
```

Cython `CoreWorker.wait` 将 refs 转成 ObjectID，C++ `CoreWorker::Wait` 分别处理 memory store 与 Plasma availability。`fetch_local=False` 表示对象在集群任意位置 ready 即可，不必先拉到当前节点；它能避免只做调度判断时的无谓数据传输。

## 5.7 分布式所有权

Ray 对象有一个 owner CoreWorker。Owner 负责：

- 追踪 local references；
- 追踪借给其他 Worker 的 references；
- 保存对象位置/状态所需信息；
- 在无引用时触发释放；
- 对可重建对象参与 lineage reconstruction。

`ReferenceCounter` 位于 [reference_counter.h](../src/ray/core_worker/reference_counter.h)。几个关键操作：

| 操作 | 含义 |
|---|---|
| `AddOwnedObject` | 当前 CoreWorker 成为对象 owner |
| `AddLocalReference` | 本进程又持有一个 ObjectRef |
| `RemoveLocalReference` | 本地 Python/C++ 引用离开作用域 |
| `AddBorrowedObject` | 当前进程从其他 owner 借用引用 |
| `UpdateSubmittedTaskReferences` | 参数引用被 pending Task 持有，返回引用被登记 |

Python 的 ObjectRef 构造/析构会与本地引用计数衔接，但 Python GC 时机、循环引用和解释器退出顺序会让“`del ref` 后立刻释放”不是可靠同步保证。

## 5.8 嵌套 ObjectRef

对象可能包含另一个 ObjectRef：

```python
inner = ray.put([1, 2, 3])
outer = ray.put({"inner": inner})
del inner
```

序列化上下文会记录 `contained_object_refs`。Outer 仍在作用域时，Ray 必须让 inner 保持可达；跨进程传递 outer 后，borrower/owner 关系也要传播。这正是分布式引用计数远比本地 `sys.getrefcount` 复杂的原因。

阅读 [reference_counter_test.cc](../src/ray/core_worker/tests/reference_counter_test.cc) 时，先画 `owner -> borrower -> nested ref` 图，再看断言，否则很容易迷失在 ID 名字里。

## 5.9 四类内存必须分开看

| 内存 | 内容 | 常见问题 |
|---|---|---|
| Driver/Worker heap | Python 对象、反序列化结果、模型 | heap OOM、对象被列表/闭包长期引用 |
| CoreWorker memory store | 小型直接返回、状态/错误对象 | 大量小对象、pending refs |
| Plasma shared memory | 大对象、跨进程共享 block | pinned objects、store full、spill |
| Spill storage | Plasma 淘汰到磁盘的数据 | 磁盘空间、吞吐、恢复延迟 |

“object store 只占 30% 内存”不表示 Ray 应用不会吃完机器内存；Worker heap 与系统进程同样消耗 RAM。

## 5.10 Pin、eviction 与 spilling

- **pin**：对象当前不能被安全淘汰，例如有效引用或任务依赖仍需要它；
- **eviction**：从共享内存移除可淘汰对象；
- **spilling**：先把对象写到外部/本地磁盘，再释放 Plasma 空间；
- **restore**：需要时从 spill location 拉回对象存储。

Plasma 中“有引用”与“当前 client 映射了 buffer”也是不同维度。`PutInLocalPlasmaStore` 在创建后请求 raylet pin，再 release 本地 Plasma client 引用，以避免 pin RPC 到达前对象被淘汰的竞态。

源码入口：

- [plasma/store.h](../src/ray/object_manager/plasma/store.h)：create/seal/get/release；
- [object_manager.h](../src/ray/object_manager/object_manager.h)：pull/push；
- [local_object_manager.cc](../src/ray/raylet/local_object_manager.cc)：本地对象 pin/spill 管理；
- [doc/source/ray-core/objects/object-spilling.rst](../doc/source/ray-core/objects/object-spilling.rst)：行为文档。

## 5.11 Lineage reconstruction

若一个 Task 产生的对象副本全部丢失，而生产 Task 的 lineage 仍可用，Ray 可以重新执行 Task 恢复对象。限制包括：

- 生产 Task 必须可重试/可重建；
- 所需上游对象或 lineage 也要可恢复；
- `ray.put` 对象没有可执行生产函数；
- 外部副作用不会自动回滚；
- owner 死亡、配置和重试上限会影响恢复。

因此 ObjectRef 提供的是分布式对象语义，不是永久存储。需要持久化的模型/checkpoint 应写入可靠存储。

## 5.12 内存诊断步骤

1. 用 State API/Dashboard 判断是 Task backlog 还是对象 backlog；
2. 用 `ray memory` 查看 ObjectRef call site 和引用类型；
3. 区分 Worker heap、object store 和 spill disk；
4. 查找 Driver 列表、Actor 字段、闭包、全局缓存是否持有 refs；
5. 检查是否逐个 `ray.get`，或一次 `ray.get` 过多大对象；
6. 用 `ray.wait`、streaming iterator 或 batch 限制在途数据；
7. 最后才考虑扩大 object store，避免用容量掩盖无界生产。

## 5.13 自测题

1. ObjectRef ready 与对象已经在当前节点有何区别？
2. 为什么 `ray.put` 对象通常不能 lineage reconstruction？
3. `fetch_local=False` 的 `ray.wait` 适合什么场景？
4. Outer object 包含 inner ObjectRef 时，为什么删除本地 inner 变量不一定释放 inner？
5. Plasma OOM 与 Worker heap OOM 的诊断路径有何不同？
6. 为什么从远端大对象中只读取一个字段仍可能产生完整网络传输？

