# 13. 综合练习与源码课题

这些练习按“观察 → 解释 → 修改 → 验证”递进。先完成实验记录，再看提示。不要为了完成练习直接向上游开 PR；本地学习修改不等于有价值的贡献。

## 13.1 练习 1：证明 `.remote()` 是异步提交

### 任务

写一个睡眠 0.5 秒的 remote function，在 1、2、4 个逻辑 CPU 下各提交 8 个任务，分别记录：

- 提交 8 个 ObjectRef 的时间；
- `ray.get` 总时间；
- Worker PID 数；
- TaskID 和 node ID。

### 要回答

1. 提交时间为什么不随 sleep 线性增加？
2. PID 数与 logical CPU 是否必然严格相等？
3. 哪一层决定并发，哪一层决定 Worker 复用？

### 源码锚点

`RemoteFunction._remote`、`CoreWorker::SubmitTask`、`NormalTaskSubmitter::SubmitTask`。

## 13.2 练习 2：按值与按引用的大参数

### 任务

生成一个大 NumPy array，对比：

```python
[consume.remote(array) for _ in range(n)]
```

与：

```python
array_ref = ray.put(array)
[consume.remote(array_ref) for _ in range(n)]
```

观察提交耗时、Driver heap、object store 和 `ray memory`。

### 要回答

- 自动参数 put 与显式 `ray.put` 的语义差异是什么？
- 为什么不应只用总 RSS 判断对象存储？
- 删除哪些 Python 引用后对象才可能释放？

### 源码锚点

`prepare_args_and_increment_put_refs`、`CreateOwnedAndIncrementLocalRef`、`ReferenceCounter`。

## 13.3 练习 3：实现有界 in-flight map

### 任务

只使用 Core API，实现一个 `bounded_map(remote_fn, items, max_in_flight)`：

- 同时 pending 不超过上限；
- 按完成顺序产生结果；
- 一个任务失败时可选择立即抛错或收集错误；
- 不在 Driver 保存所有结果。

### 验收

用一个快慢混合 Task 证明结果不是提交顺序；用 State API/计数 Actor 证明并发上限。

### 延伸

对比 Ray Data StreamingExecutor：你的函数缺少 operator DAG、资源估算、block ownership 和多级背压中的哪些能力？

## 13.4 课题 A：给任务调用链加观测点

### 目标

不改变公共 API，在本地分支为一次普通 Task 的几个阶段添加临时结构化日志：

1. Python `_remote` 完成参数/资源规范化；
2. C++ `CoreWorker::SubmitTask` 建好 TaskSpec；
3. `NormalTaskSubmitter` 请求 lease；
4. 获得 Worker；
5. `TaskReceiver` 开始执行。

日志统一包含 TaskID、function name、resource shape。

### 学习价值

你会遇到一个真实问题：Python 入口处 TaskID 尚未由 C++ 生成，不能假装所有阶段天然有同一字段。应决定在哪一层开始关联，或使用 parent/call site 临时信息。

### 验证

- 目标 C++ unit test 不因日志崩溃；
- 一个本地 Python 复现能按阶段关联；
- debug 关闭时不产生高频 INFO 噪声。

### 不要做

不要把临时学习日志直接提交上游。生产级 observability 需要 metrics/event schema、开销评估、采样与维护者协调。

## 13.5 课题 B：研究一个 lease failure

### 目标

选择 `SCHEDULING_CANCELLED_UNSCHEDULABLE`、runtime env setup failed 或 worker startup failed 之一：

1. 从 `RequestWorkerLeaseReply` proto 找枚举；
2. 找 raylet 在哪里写入；
3. 找 NormalTaskSubmitter 在哪里读取；
4. 找 Python 最终异常类型；
5. 找覆盖该路径的 C++/Python 测试；
6. 画错误传播时序图。

### 交付物

一页 Markdown，必须包含“状态所有者、RPC 边界、是否重试、哪些同 key Task 一起失败、用户看到什么”。

## 13.6 课题 C：Actor checkpoint 恢复

### 目标

实现一个带版本号的 Actor：

- 每次成功更新后持久化 `{version, state, request_ids}`；
- `__init__` 从 checkpoint 恢复；
- 重复 request ID 返回原结果；
- 配置 `max_restarts`；
- 测试 Actor 进程被 kill 后状态不倒退、副作用不重复。

### 要解释

- Ray 自动恢复的是 Actor 身份/进程还是业务状态？
- Actor task reply 丢失后为何可能重试？
- checkpoint 写入与业务更新之间如何保持原子性？

## 13.7 课题 D：Ray Data 计划与背压

### 目标

构造 `range -> map_batches(fast) -> map_batches(slow) -> iter_batches(slow consumer)`：

- 调整 block 数、batch size、TaskPool concurrency；
- 记录执行计划、stats、object store 峰值和吞吐；
- 找到吞吐不再增长而内存继续增长的配置；
- 解释 StreamingExecutor 如何抑制上游。

### 源码锚点

`get_execution_plan`、`StreamingExecutor.execute`、`streaming_executor_state.select_operator_to_run`、backpressure policies。

## 13.8 课题 E：Train 资源展开

### 目标

设计一个实验矩阵：2 个 Tune Trial，每 Trial 是 4-worker TorchTrainer，每 worker 1 GPU、2 CPU。画出：

- Trial placement group bundles；
- Train controller/coordinator 资源；
- worker Actor；
- 集群最小单节点 shape 与总资源；
- 只有 6 GPU 时 Trial 状态；
- PG PACK/SPREAD 对节点要求的影响。

### 验收

你的解释必须区分总集群资源和单节点/bundle 可满足性。

## 13.9 课题 F：Serve 延迟拆解

### 目标

部署一个可控 sleep 的 Serve Deployment，改变：

- replicas；
- `max_ongoing_requests`；
- `max_queued_requests`；
- 客户端并发；
- batch size/wait timeout（可选）。

记录 p50/p95/p99、吞吐、rejection。把延迟拆为：客户端 → Proxy/Router queue → Replica queue → handler。

### 源码锚点

`DeploymentHandle.remote`、`Router.assign_request`、`ReplicaActor.handle_request_with_rejection`、Serve metrics。

## 13.10 课题 G：RLlib 采样/学习平衡

### 目标

在短 PPO run 中只改变一个维度：

- EnvRunner 数；
- 每 runner env 数；
- Learner 数/GPU；
- train batch/minibatch。

记录 env steps/s、sampling timer、learner update timer、weight sync timer 和训练 return。

### 要回答

- 系统瓶颈从哪一段转移到哪一段？
- 吞吐变化是否改变样本效率？
- 哪些变化增加了 policy lag 或同步成本？

## 13.11 练习报告模板

```markdown
# 问题

## 预期不变量

## 最小复现

## 进程/Actor/对象拓扑

## 观测数据
- 命令：
- 版本/commit：
- CPU/GPU/内存：
- 日志/metrics：

## 源码调用链
1. file::symbol
2. file::symbol

## 结论

## 未证实假设

## 最小测试建议
```

把“观察到的事实”和“推断”分开。比如“Task state 是 PENDING_NODE_ASSIGNMENT”是事实，“因为 label selector 不匹配”需要资源/日志进一步证明。

## 13.12 30 天计划

| 天数 | 内容 | 产物 |
|---|---|---|
| 1～3 | 模块 0～2 | 仓库地图与术语卡片 |
| 4～7 | 模块 3～4 | Task 时序图 + 练习 1 |
| 8～11 | 模块 5 | 内存图 + 练习 2/3 |
| 12～15 | 模块 6～7 | Actor/lease 故障图 |
| 16～19 | 模块 8 | Data 计划和背压实验 |
| 20～22 | 模块 9 | Train/Tune 资源拓扑 |
| 23～25 | 模块 10 或 11 | Serve 或 RLlib 实验 |
| 26～28 | 模块 12 | 运行目标测试、调试一次故障 |
| 29～30 | 一个课题 | 完整源码研究报告 |

## 13.13 是否已经具备贡献能力

满足以下条件再考虑上游贡献：

- 能复现真实问题并说明用户影响；
- 已检查 issue 和开放 PR，没有重复；
- 改动不是孤立机械 busywork；
- 能解释每个修改文件为何必要；
- 有失败前、成功后的目标测试；
- 能运行并人工 review 所有相关改动；
- 理解 DCO、pre-commit 和 AI assistance 声明。

完成教程的目的不是尽快开 PR，而是能对系统和维护者负责。

