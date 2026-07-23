# 附录：Ray 源码术语表

## A

**Actor**：有身份和可变进程内状态的长期 Worker。方法被包装成 Actor Tasks，固定发送到对应 Actor Worker。

**ActorHandle**：调用 Actor 的分布式句柄，不是本地 Actor 实例。其引用参与 Actor 生命周期管理。

**Attempt**：同一逻辑 Task 的某次执行尝试。重试会产生新 attempt，但逻辑 Task/返回对象身份保持关联。

## B

**Backpressure（背压）**：消费者或资源不足时抑制上游继续生产，防止无界队列和 OOM。

**Block**：Ray Data 的数据存储与并行基本单位，通常由对象存储中的 ObjectRef 指代。

**Borrower**：持有他人 owned ObjectRef 的 Worker/CoreWorker。需向 owner 传播引用状态。

**Bundle**：Placement Group 中的一组资源，如 `{"CPU": 4, "GPU": 1}`。

## C

**Checkpoint**：可持久化的运行状态。只有恢复代码实际读取并应用它，才形成恢复能力。

**ConnectorV2**：RLlib 中环境/episode、RLModule、Learner 数据协议之间的变换组件。

**Control plane（控制面）**：管理身份、位置、资源和状态等元数据；GCS、raylet 调度属于其核心部分。

**CoreWorker**：嵌入 Driver/Worker 进程的 C++ 本地运行时，负责任务、Actor、对象与引用。不是独立 raylet 进程。

## D

**DAG**：有向无环图。动态 Task 依赖和 Ray Data 显式 operator plan 都可形成 DAG，但抽象层不同。

**Data plane（数据面）**：搬运实际参数/结果 bytes 的路径，如 CoreWorker RPC、Plasma、ObjectManager。

**Deployment**：Serve 中用户 callable 加部署配置的声明单位。

**Driver**：执行用户入口、提交工作并持有引用的进程。Driver 不一定在 head node。

## E

**EnvRunner**：RLlib 中与环境交互、调用推理 module 并产生 episode 的组件，可本地或远程运行。

## F

**Fallback strategy**：调度首选条件不可满足时尝试的一组软约束。

**Future**：未来结果的抽象；Ray 的 ObjectRef 承担类似角色，同时带分布式对象身份和 owner 语义。

## G

**GCS**：Global Control Service，管理 Job、node、Actor、Placement Group 等集群控制面状态与服务。

## I

**Infeasible/unschedulable**：资源形状或约束在允许的节点上无法满足，不只是资源当前繁忙。

**IPC**：同节点进程间通信；与跨网络 RPC 相对，但都跨地址空间。

## L

**Lease**：提交方从 raylet 获得特定资源/Worker 的租约，用来运行普通 Task。

**Learner**：RLlib 中拥有训练态 module、loss、optimizer 并执行参数更新的组件。

**Lineage**：对象由哪些 Task/输入产生的计算血缘；在满足条件时可用于对象重建。

**Logical resource**：Ray 调度准入用的 CPU/GPU/custom resource 数量，不等于完整的 OS 物理隔离。

## O

**ObjectID**：Ray 远程对象的逻辑身份。Task 返回 ObjectID 可由 TaskID 与返回 index 派生。

**ObjectManager**：节点级对象传输组件，负责 pull/push 与远端对象数据流。

**ObjectRef**：远程/未来对象引用，包含逻辑 ID 和 owner 等信息，不是裸内存地址。

**Operator**：Ray Data 逻辑或物理计划节点，如 Read、Map、Shuffle。

**Owner**：创建并管理某 ObjectRef 分布式引用与状态的 CoreWorker。

## P

**Pending Task**：已提交但尚未完成的 Task，可能等待调度、Worker、依赖、执行或结果。

**Physical plan**：Ray Data planner/optimizer 生成的可执行 operator DAG。

**Placement Group**：原子预留多个 resource bundles 的机制，用于 gang scheduling 和拓扑放置。

**Plasma**：Ray 使用的节点级共享内存不可变对象存储实现。

**Proxy**：Serve 的 HTTP/gRPC 入口组件，将外部请求转换并路由到应用 Deployment。

## R

**raylet**：每节点系统进程，包含 NodeManager、Worker pool、resource/lease scheduling 与对象管理集成。

**RefBundle**：Ray Data physical operator 间传递的一组 block refs 与 metadata。

**Replica**：Serve Deployment 的一个实际 Ray Actor 实例。

**RLModule**：RLlib 框架原生模型接口，分别支持 inference、exploration、train forward。

**RPC**：跨进程/网络请求响应。Ray 大量使用 gRPC 和 protobuf。

**Runtime environment**：远程 Task/Actor 的依赖环境，包括 working dir、pip/conda、env vars 等。

## S

**SchedulingKey**：NormalTaskSubmitter 用于把资源/函数/runtime env/策略相容的 Task 归组，以复用 lease/Worker 的键。

**Seal**：Plasma 对象创建并写完后变成不可变、可读取状态。

**Spilling**：把对象存储中的可淘汰对象写到磁盘/外部存储，以释放共享内存。

**SPMD**：Single Program, Multiple Data；Train 在多个 worker 上运行同一训练函数、处理不同 shard。

**StreamingExecutor**：Ray Data 的流式 physical plan 执行器，负责 operator 调度、资源与背压。

## T

**Task**：无状态远程函数的一次异步执行；Actor method 也以特殊 Actor Task 表示。

**TaskSpec**：protobuf 任务规格，包含函数、参数、资源、调用者、返回、runtime env、调度策略等。

**Trial**：Tune 中一组具体 config 的一次训练/评估实例，带资源、状态、结果和 checkpoint。

## W

**Worker**：实际执行 Task 或承载 Actor 的语言进程。Worker 内嵌 CoreWorker。

**WorkerGroup**：Train 中一组协同执行同一训练函数的长期 Worker Actors。

**Worker lease**：普通 Task 提交方从 raylet 获取可执行 Worker 与资源映射的协议。

