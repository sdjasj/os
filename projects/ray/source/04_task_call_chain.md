# 4. 远程任务完整调用链

本章回答：`ref = f.remote(1)` 到底执行了什么？建议打开源码并按本章的小节逐跳阅读。

## 4.1 第 0 步：装饰器没有执行函数

```python
@ray.remote(num_cpus=2)
def add(a, b):
    return a + b
```

`ray.remote` 定义在 [worker.py](../python/ray/_private/worker.py)。对函数应用后，得到的不是原函数，而是
[remote_function.py](../python/ray/remote_function.py) 中的 `RemoteFunction`。其构造函数保存原函数、默认选项、函数名等，并把实例的 `remote` 属性绑定到一个代理：

```python
# 根据 RemoteFunction.__init__ 简化
def _remote_proxy(*args, **kwargs):
    return self._remote(
        args=args,
        kwargs=kwargs,
        **self._default_options,
    )

self.remote = _remote_proxy
```

因此：

- `add(1, 2)` 被 `RemoteFunction.__call__` 拒绝；
- `add.remote(1, 2)` 进入提交路径；
- `add.options(num_cpus=1).remote(...)` 先复制/覆盖选项，再进入同一个 `_remote`。

## 4.2 第 1 步：`RemoteFunction._remote`

关键符号：`python/ray/remote_function.py::RemoteFunction._remote`。

它的主路径可以压缩为：

```text
检查/自动初始化
  -> 首次调用时提取函数签名、注入 tracing
  -> 为当前 cluster + job 序列化并导出函数
  -> 填充和校验 task options
  -> 计算资源与 scheduling strategy
  -> flatten_args(args, kwargs)
  -> worker.core_worker.submit_task(...)
  -> 将返回列表包装成 ObjectRef / list / ObjectRefGenerator
```

### 为什么函数在第一次调用时导出

源码用 `last_export_cluster_and_job` 判断定义是否已对当前集群和 Job 导出。函数通过 `pickle_dumps` 序列化，再由 `FunctionActorManager` 发布。Worker 收到 TaskSpec 中的函数描述符后，用它查找已导出的代码。

函数描述符与函数字节不是一回事：描述符用于稳定查找，pickled function 是可执行定义。跨 Job 重用同一个 Python `RemoteFunction` 对象时仍可能需要重新导出。

### 为什么参数要扁平化

`ray._common.signature.flatten_args` 把位置参数和关键字参数按函数签名编码成统一序列，远端再恢复。这样 RPC 层不必维护 Python `args/kwargs` 两套动态规则。

### 选项在哪里变成资源

`resources_from_ray_options` 将 `num_cpus`、`num_gpus`、`memory`、custom resources 等合并为资源映射。Placement Group 兼容逻辑也在这一层把旧选项规范化成 scheduling strategy。

## 4.3 第 2 步：Cython 桥 `CoreWorker.submit_task`

Python 的 `worker.core_worker` 是 [python/ray/_raylet.pyx](../python/ray/_raylet.pyx) 暴露的扩展对象。`submit_task` 做四类转换：

1. `resources/labels/fallback_strategy` → C++ 容器；
2. Python function descriptor → `CRayFunction`；
3. Python 参数 → `vector<unique_ptr<TaskArg>>`；
4. Python 选项 → C++ `TaskOptions` 与 `SchedulingStrategy`。

核心调用形态：

```cython
return_refs = CCoreWorkerProcess.GetCoreWorker().SubmitTask(
    ray_function,
    args_vector,
    task_options,
    max_retries,
    retry_exceptions,
    c_scheduling_strategy,
    ...,
)
```

### 参数按值还是按引用

`prepare_args_and_increment_put_refs` 检查每个参数：

- 已经是 `ObjectRef`：编码引用和 owner 信息；
- 普通小对象：可能直接内联到 Task RPC；
- 不适合内联的对象：序列化并放入对象存储，再把 ObjectRef 作为任务依赖。

阈值来自 Ray 配置（如 `task_rpc_inlined_bytes_limit`），不要在理解中假设一个永远固定的字节数。

若提交阶段临时 `put` 了参数，Cython 先增加本地引用，C++ 将其纳入 submitted task reference 后再释放临时引用，避免参数在 TaskSpec 建立完成前被回收。

## 4.4 第 3 步：`CoreWorker::SubmitTask`

关键符号：`src/ray/core_worker/core_worker.cc::CoreWorker::SubmitTask`。

这里开始是 C++ 主路径：

1. 用当前 Job、父任务 ID 和 task index 生成 `TaskID`；
2. 把 Placement Group 约束加入资源；
3. 用 `TaskSpecBuilder::BuildCommonTaskSpec` 写入函数、参数、资源、调用者、runtime env、标签、返回数等；
4. 用 `SetNormalTaskSpec` 写普通任务特有的重试和调度策略；
5. `task_manager_->AddPendingTask(...)` 登记 pending task，并立即得到返回引用；
6. 把 `normal_task_submitter_->SubmitTask(task_spec)` post 到 CoreWorker 的 IO service。

源码的关键设计是“先登记返回引用，再异步调度”：

```cpp
returned_refs = task_manager_->AddPendingTask(...);

io_service_.post([this, task_spec = std::move(task_spec)]() mutable {
  normal_task_submitter_->SubmitTask(std::move(task_spec));
});

return returned_refs;
```

这就是 `.remote()` 能快速返回的根本原因。它等待的是本地提交数据结构建立，不等待远端执行。

## 4.5 TaskID、ObjectID 与确定性

TaskID 由 Job、父任务/当前内部任务和递增 index 派生；普通任务返回 ObjectID 又由 TaskID 与 return index 派生。好处包括：

- 提交方可以立刻构造返回 ObjectRef；
- 重试同一逻辑 Task 时仍对应同一组逻辑返回；
- lineage 和依赖图可通过 ID 关联。

具体编码规范可参考 [src/ray/design_docs/id_specification.md](../src/ray/design_docs/id_specification.md) 和
[src/ray/common/id.h](../src/ray/common/id.h)。不要把 ID 当随机日志字符串；它们承载了系统语义。

## 4.6 第 4 步：`NormalTaskSubmitter`

关键文件：[normal_task_submitter.cc](../src/ray/core_worker/task_submission/normal_task_submitter.cc)。

`SubmitTask` 不会为每个任务盲目启动一个进程。它先根据资源、函数/runtime env、调度策略等构造 `SchedulingKey`，把可共享 worker lease 的任务归组排队。随后 `RequestNewWorkerIfNeeded`：

1. 若该 key 有空闲 leased Worker，直接分配；
2. 若 Task 数没有超过已有 pending lease 请求数，不重复请求；
3. 用 lease policy 选一个候选 raylet；
4. 发送 `RequestWorkerLeaseRequest`；
5. 处理 granted、redirected、rejected、canceled、RPC failure 等结果。

协议定义在 [node_manager.proto](../src/ray/protobuf/node_manager.proto)。lease reply 可能：

- 返回具体 Worker address：获得租约；
- 返回 `retry_at_raylet_address`：去另一节点重试；
- rejected：候选节点资源视图可能过期，重新选择；
- canceled：runtime env 失败、placement group 被移除、不可调度、Worker 启动失败等；
- 本地 raylet RPC 失败：Driver 任务失败，Worker 通常退出以便上游恢复。

这条路径体现了 Ray 的分布式调度：提交方保有任务队列，raylet 管节点资源和 Worker，二者用 lease 协议协作。

## 4.7 第 5 步：raylet 处理 lease

入口是 [node_manager.cc](../src/ray/raylet/node_manager.cc) 的 `NodeManager::HandleRequestWorkerLease`。当前实现把请求交给 cluster/local lease manager：

- 集群层判断本节点还是其他节点更合适；
- 本地层检查资源可用性、依赖、runtime env 和 Worker pool；
- Worker 未就绪时可能先启动；
- 资源分配随 lease 关联，完成/归还 Worker 时释放。

调度实现集中在 [src/ray/raylet/scheduling](../src/ray/raylet/scheduling)：

- `cluster_resource_scheduler.*`：节点选择；
- `cluster_lease_manager.*`：集群 lease 队列/调度；
- `local_lease_manager.*`：本地资源、依赖与 Worker dispatch；
- `cluster_resource_manager.*`：集群资源视图。

代码正在使用 “lease” 术语表达过去常说的 “task scheduling”。阅读旧文章时，`ClusterTaskManager` 等旧名可能已经迁移，应该以当前源码为准。

## 4.8 第 6 步：把 Task 推给 Worker

获得 Worker 后，`NormalTaskSubmitter::PushNormalTask`：

1. 构造 `PushTaskRequest`；
2. 复制 `TaskSpec` 和 assigned resource mapping；
3. 在 TaskManager 中标记等待执行；
4. 通过目标 Worker 的 `CoreWorkerClient` 发送 `PushNormalTask`。

目标进程在 `CoreWorker::HandlePushTask` 接收，并交给
[task_receiver.cc](../src/ray/core_worker/task_execution/task_receiver.cc) 中的 `TaskReceiver`。`TaskReceiver` 负责队列、参数获取、取消和实际执行时机。

## 4.9 第 7 步：回到 Python 执行函数

C++ CoreWorker 在创建时注册 Python task execution callback。入口位于
[python/ray/_raylet.pyx](../python/ray/_raylet.pyx)：

```text
task_execution_handler
  -> execute_task_with_cancellation_handler
  -> FunctionActorManager.get_execution_info
  -> execute_task
  -> 调用用户 Python function
  -> 序列化返回值/异常
```

[function_manager.py](../python/ray/_private/function_manager.py) 的 `get_execution_info` 根据 function descriptor 找执行信息。若定义尚未就绪，它需要等待或产生加载错误。

执行不仅是 `function(*args)`；前后还包含参数反序列化、runtime context、日志/tracing、异常包装、返回值序列化、流式 generator、Actor 分支和取消处理。

## 4.10 第 8 步：结果完成与 `ray.get`

Worker 将结果作为直接返回或对象存储对象报告给提交方。提交方 TaskManager 完成 pending task、将结果写入 memory store/记录 Plasma 引用，并唤醒等待者。

`ray.get(ref)` 的 Python 入口在 [worker.py](../python/ray/_private/worker.py)：

```text
ray.get
  -> global_worker.get_objects
  -> core_worker.get_objects (Cython)
  -> CoreWorker::Get (C++)
  -> memory store；必要时 fetch/get Plasma
  -> 返回 SerializedRayObject
  -> Python 反序列化
  -> 若是 RayError，则转成对应异常抛出
```

如果对象在远端节点，`get` 可能触发对象拉取，所以“只取一个小字段”仍可能需要传输整个序列化对象。

## 4.11 异常如何返回

用户异常不会作为普通 RPC failure 丢失。Worker 将它序列化成 Ray error object；调用方 `ray.get` 看到 `RayTaskError` 后，用 `as_instanceof_cause()` 让异常既保留 Ray 上下文又表现得像原始异常类型。

区分三层错误：

- 提交前：参数/选项/序列化失败，`.remote()` 本地抛错；
- 任务内：用户函数异常，通常到 `ray.get` 才抛；
- 系统层：Worker/节点/runtime env/调度失败，按重试配置恢复或返回系统错误。

## 4.12 用实验验证调用链

```python
import os
import time
import ray

ray.init(num_cpus=2)

@ray.remote
def inspect_task(x):
    ctx = ray.get_runtime_context()
    time.sleep(0.2)
    return {
        "x": x,
        "pid": os.getpid(),
        "task_id": ctx.get_task_id(),
        "node_id": ctx.get_node_id(),
    }

start = time.perf_counter()
refs = [inspect_task.remote(i) for i in range(4)]
submit_elapsed = time.perf_counter() - start
results = ray.get(refs)
total_elapsed = time.perf_counter() - start

print("submit:", submit_elapsed)
print("total:", total_elapsed)
print(results)
```

预期观察：提交耗时远小于总耗时；两个逻辑 CPU 使四个睡眠任务分批执行；每个结果有 TaskID；Worker PID 与 Driver 不同。具体耗时和 Worker 复用不能写死为断言。

## 4.13 调用链速查

```text
ray.remote
  RemoteFunction
    RemoteFunction._remote
      Cython CoreWorker.submit_task
        C++ CoreWorker::SubmitTask
          TaskManager::AddPendingTask
          NormalTaskSubmitter::SubmitTask
            RequestWorkerLease
              NodeManager::HandleRequestWorkerLease
                cluster/local lease managers
            PushNormalTask
              remote CoreWorker::HandlePushTask
                TaskReceiver
                  Python task_execution_handler
                    user function
```

## 4.14 自测题

1. 为什么 `f.remote()` 可以在结果产生前返回 ObjectRef？
2. 函数 descriptor 和 pickled function 各有什么用途？
3. 一个大型普通参数何时变成 ObjectRef 依赖？
4. SchedulingKey 为什么能减少 lease 开销？
5. Worker 已获得 Task 后，Python 用户函数之前还有哪些步骤？
6. 哪类错误在 `.remote()` 抛，哪类通常在 `ray.get()` 抛？

