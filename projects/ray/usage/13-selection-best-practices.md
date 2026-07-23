# 13. 选型、性能与生产最佳实践

## 1. 从最小抽象开始

Ray 的功能很多，但选型原则可以很简单：选择能完整表达问题的最高层、最小功能集合。

```text
普通 Python/框架已经够用？
  ├─ 是：先不用 Ray
  └─ 否：
       ├─ 表格/文件/批数据流水线 → Data
       ├─ 分布式训练 → Train
       ├─ 参数实验 → Tune
       ├─ 强化学习 → RLlib
       ├─ 在线服务 → Serve
       └─ 自定义并行逻辑 → Core Task/Actor
```

“最高层”指使用已经封装领域模式的库。例如批量模型推理优先 `Data.map_batches(callable_class)`，而不是自己实现 Actor 池；在线推理优先 Serve，而不是手写 HTTP Server + Actor 路由。

## 2. 详细选型边界

### 2.1 本机并发库还是 Ray

继续用 `concurrent.futures`/`multiprocessing`：

- 只在单机运行；
- 任务很简单；
- 不需要 GPU/自定义资源和分布式对象；
- 团队希望最小依赖。

选择 Ray Core：

- 未来可能跨节点；
- 需要 Task 与 Actor 混合；
- 需要 CPU/GPU/自定义资源调度；
- 需要对象依赖图、容错、Dashboard 和 Autoscaler；
- 已使用其他 Ray 库。

### 2.2 Task 还是 Actor

使用 Task：无状态、可重试、输入决定输出。

使用 Actor：复用昂贵初始化、持有状态/连接、要求同一状态所有者串行处理。

不要仅仅因为“类写起来方便”就选择 Actor。Actor 是长期资源占用和生命周期单元。

### 2.3 Core 还是 Data

使用 Core：任务拓扑非数据表式、控制流复杂、每个任务语义独特。

使用 Data：数据集合 + 一系列读/变换/消费，尤其需要批次、shuffle、流式和 Train 集成。

### 2.4 Train 还是 Tune

- Train：一次配置如何用多个 Worker 训练；
- Tune：很多配置怎样搜索和调度；
- 二者经常组合，但彼此不替代。

### 2.5 Data 批推理还是 Serve 在线推理

| 维度 | Data | Serve |
| --- | --- | --- |
| 输入 | 有限/持续数据集 | 独立在线请求 |
| 目标 | 总吞吐、成本 | 延迟、可用性、吞吐 |
| 批处理 | 数据批次 | 动态请求批 |
| 结果 | 文件/数据集 | HTTP/gRPC/Handle 响应 |
| 扩缩信号 | 数据算子资源需求 | 请求队列/Replica 需求 |

### 2.6 Ray Jobs 还是 Ray Client

Notebook/REPL 交互可用 Client，长时、可恢复、可审计的远端程序优先 Jobs。

## 3. 性能原则：先减少工作，再增加机器

### 3.1 放大任务粒度

把小记录组成批次。调度 1,000 个每个 100 ms 的 Task，通常比调度 100 万个每个 0.1 ms 的 Task 更合理。

### 3.2 推迟同步

```python
# 好：先提交
refs = [f.remote(x) for x in xs]
results = ray.get(refs)
```

不要在提交循环中立即 `ray.get`。

### 3.3 保持数据在集群内流动

把 ObjectRef 直接交给下游，不要每一步都经过 Driver；大数据使用 Data 流水线，最终写持久存储。

### 3.4 限制在途数量

Task 用 `ray.wait` 窗口；Data/Serve 使用各自背压和并发配置；Tune 限制 Trial 并发。无界并发不是扩展性。

### 3.5 显式、真实地声明资源

资源声明同时决定并发、放置和扩容。Task 内部 8 线程却声明 0.1 CPU，会让节点过载；模型用 GPU 却不声明 GPU，会让显存争抢失控。

### 3.6 复用昂贵状态

模型、连接、编译器和大缓存放 Actor/callable class/Serve Replica 的初始化中，不要每个 Task 重建。

### 3.7 用 Profile 决策

扩容前回答：

- Driver、调度、数据、Worker 计算、网络还是外部存储最慢？
- CPU/GPU 是否真的忙？
- 对象 store 是否 spill？
- Task 粒度和依赖是否允许并行？
- 资源请求是否让 Worker 能被调度？

## 4. 可靠性原则

### 4.1 幂等

Ray 重试是“重新执行”，不是数据库事务。外部写入使用业务键、upsert、临时文件 + 原子提交或两阶段协议。

### 4.2 Checkpoint

Train、Tune、RLlib、长时 Actor 的关键状态要定期写共享持久存储。检查点必须经过实际恢复演练，不是“文件存在”就算有效。

### 4.3 失败分类

- 瞬时系统错误：有限重试 + 退避；
- 永久输入错误：记录并隔离，不重复消耗资源；
- 资源不足：调整配置/集群，而不是重试；
- 外部系统限流：降低并发、批处理和退避；
- 代码 bug：快速失败，保存复现输入。

### 4.4 取消和超时

Driver 超时不等于远端工作已停止。设计 Task 取消、Job stop、Serve 请求超时和下游请求超时，并确认中断后的外部副作用。

### 4.5 节点本地数据不是唯一副本

节点可能失败、缩容或重建。重要输入、输出、模型和检查点使用共享持久存储。

## 5. 可维护性原则

### 5.1 明确 Driver 与 Worker 边界

模块 import 不应产生不可控副作用。模型/连接在 Worker 初始化，集群级编排在 Driver。Task/Actor 参数保持可序列化。

### 5.2 配置版本化

记录：

- Git commit；
- Ray/Python/框架版本；
- Runtime Environment 或镜像 digest；
- 数据和模型版本；
- 资源配置；
- 随机种子；
- Job/Experiment ID。

### 5.3 命名

使用 Task `.options(name=...)`、命名 Actor、Job metadata、Tune experiment name、Serve application/deployment name，让 Dashboard 和日志能映射到业务概念。

### 5.4 分层测试

1. 普通 Python 单元测试业务函数；
2. 本机 Ray 小规模集成测试；
3. 单节点资源/故障测试；
4. 小型多节点测试；
5. 生产规模压测和恢复演练。

不要每个单元测试都启动完整 Ray 集群，也不要只靠 mock 验证分布式语义。

## 6. 安全原则

- Ray 集群和控制端口放在受信任网络；
- Job 提交权限等同远程代码执行权限；
- Dashboard、Jobs、Client、Serve 入口分别鉴权；
- 使用 TLS/网关/网络策略；
- 密钥通过平台 Secret/IAM 注入，不写源码和 Runtime Environment JSON；
- 依赖锁定、镜像扫描、限制不受信任包；
- 不同租户/信任级别使用更强的集群或 Kubernetes 隔离；
- 审计 Job 提交人、代码版本和资源变更。

Ray 的资源调度不是安全沙箱。不要把互不信任的任意代码仅靠 `num_cpus` 或 namespace 放在同一信任域。

## 7. 成本原则

- Head 节点保持稳定但不过度昂贵；
- 节点类型匹配 bundle，减少装箱碎片；
- Tune 限制无效 Trial，使用提前停止；
- Serve 按 SLO 设置最小 Replica，避免冷启动和闲置极端；
- 批任务完成后释放独立 RayJob 集群；
- Spot/抢占节点只承载可恢复工作，Checkpoint 足够频繁；
- 监控每 Job/团队的 CPU/GPU 小时、存储和网络；
- 设置 Autoscaler 最大节点数和云预算告警。

## 8. 版本与升级

Ray 开发活跃，上层库 API 会演进。升级流程：

1. 阅读目标版本发布说明和弃用提示；
2. 固定当前环境并保留可回滚镜像；
3. 运行单元/本机集成测试；
4. 恢复旧 Checkpoint 验证兼容性；
5. 小集群跑代表性负载；
6. 对 Serve 做兼容/滚动升级计划；
7. 集群内所有节点和 Client 版本一致；
8. 用指标比较性能和资源变化。

不要混用旧教程的 RLlib rollout API、新 API stack 和不同版本配置；不要假设开发分支 `3.0.0.dev0` 示例能直接在任意稳定版运行。

## 9. 其他值得知道的能力

### 9.1 Compiled Graph

Ray Compiled Graph 面向重复执行、拓扑固定、低延迟/高吞吐的 Task/Actor DAG，可优化通信和调度路径。适合在普通 Ray DAG 已正确、profiling 证明调用开销是瓶颈后评估。它的约束和 API 与普通动态 Task 不同，不是入门默认选择。

入口：[`../doc/source/ray-core/compiled-graph/quickstart.rst`](../doc/source/ray-core/compiled-graph/quickstart.rst)。

### 9.2 Ray LLM

仓库包含面向 LLM 批处理和服务的专门能力：

- Data LLM：大模型离线批量推理；
- Serve LLM：vLLM/SGLang 等引擎、数据并行、Prefill/Decode、LoRA、路由和可观测性。

LLM 功能对 GPU、CUDA、引擎版本和模型许可非常敏感，应从当前文档开始，而不是把普通小模型示例直接放大。入口：[`../doc/source/serve/llm/index.md`](../doc/source/serve/llm/index.md) 和 [`../doc/source/data/working-with-llms.rst`](../doc/source/data/working-with-llms.rst)。

### 9.3 兼容层集成

Ray 提供与 Python multiprocessing、joblib、Dask 等生态的集成，适合低改动迁移已有代码：

- [`../doc/source/ray-more-libs/multiprocessing.rst`](../doc/source/ray-more-libs/multiprocessing.rst)
- [`../doc/source/ray-more-libs/joblib.rst`](../doc/source/ray-more-libs/joblib.rst)
- [`../doc/source/ray-more-libs/dask-on-ray.rst`](../doc/source/ray-more-libs/dask-on-ray.rst)

兼容层可能无法表达 Ray 的全部资源、Actor 和数据依赖能力。新系统通常更适合使用原生 Ray API。

### 9.4 Workflow 与 DAG

仓库仍包含 `ray.workflow` 和 `ray.dag` 相关代码。它们解决持久工作流或图表达的特定问题，但功能状态、兼容性和推荐程度应以目标版本公开文档为准。不要仅因源码目录存在就假设所有 API 都是稳定生产接口。

## 10. 反模式速查

| 反模式 | 结果 | 改进 |
| --- | --- | --- |
| 循环中立刻 `ray.get` | 串行化 | 先提交后收集 |
| 百万微小 Task | 调度开销 | 批处理/Data |
| 无界 ObjectRef 列表 | 内存增长 | `ray.wait` 窗口 |
| 大对象反复闭包捕获 | 序列化/复制 | `ray.put` 或 Actor |
| Actor 不声明 CPU | 资源行为意外 | 显式 `num_cpus` |
| GPU 代码不声明 GPU | 显存争抢 | `num_gpus` |
| `take_all()` 大数据 | Driver OOM | 流式/写出 |
| Checkpoint 写本地盘 | 节点失败丢失 | 共享持久存储 |
| 盲目无限重试 | 重试风暴/重复副作用 | 分类错误、有限重试 |
| Dashboard 暴露公网 | 高安全风险 | 私网、鉴权、网关 |
| 只看平均延迟 | 忽略尾延迟 | P95/P99、队列指标 |
| 先扩机器再 profiling | 成本高、问题仍在 | 定位瓶颈后扩展 |

## 11. 上线前最终检查表

### 正确性

- 本机和小集群结果一致；
- 顺序、随机性、重复执行语义明确；
- 外部副作用幂等；
- Checkpoint 可恢复；
- 失败输入可追踪。

### 性能

- Task/Block/batch 粒度经过基准测试；
- 并发有上限和背压；
- CPU/GPU/内存声明真实；
- 没有不必要的 Driver 数据往返；
- 已观察 P95/P99 和 spill/网络。

### 集群

- 节点类型能容纳最大 bundle；
- Head 控制面资源受保护；
- Autoscaler 上下限合理；
- 数据、模型和依赖对 Worker 可见；
- 节点失败和缩容已演练。

### 运维与安全

- Job、Task、Actor、Deployment 有业务名称；
- 日志、指标、告警、Dashboard 可用；
- 控制端口不公开；
- 凭证最小权限且不进源码；
- 有版本、回滚、清理和成本策略。

完成这份清单，比“代码能在 100 台机器启动”更接近真正可用的分布式系统。
