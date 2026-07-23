# Ray 源码学习教程

这套教程面向希望从“会用 Ray”进阶到“能沿源码解释 Ray 为什么这样工作”的读者。内容以当前仓库检出版本为准：

- Git 提交：`6623e6b1e7`
- Python 包版本：`3.0.0.dev0`
- 教程语言：中文
- 源码链接：均使用本仓库相对路径，可直接在编辑器中跳转

Ray 的代码量很大。有效的阅读顺序不是逐目录扫描，而是先建立运行时心智模型，再追一条端到端调用链，最后进入自己关心的上层库。

## 模块导航

| 顺序 | 模块 | 学完后应能回答的问题 |
|---|---|---|
| 0 | [学习路线与使用方法](00_learning_path.md) | 应该按什么顺序学，如何验证自己真的懂了？ |
| 1 | [分布式系统背景知识](01_background.md) | Future、Actor、RPC、共享内存、调度分别是什么？ |
| 2 | [仓库地图与开发环境](02_repository_and_environment.md) | Python、Cython、C++、文档和测试分别在哪里？ |
| 3 | [Ray Core 总体架构](03_core_architecture.md) | Driver、Worker、raylet、GCS、对象存储如何协作？ |
| 4 | [远程任务完整调用链](04_task_call_chain.md) | `f.remote()` 如何变成另一进程中的函数执行？ |
| 5 | [ObjectRef、序列化与内存](05_objects_and_memory.md) | 对象在哪里、何时传输、何时释放、为什么会 OOM？ |
| 6 | [Actor、状态与并发](06_actors_and_concurrency.md) | Actor 与 Task 的语义和提交路径有何不同？ |
| 7 | [资源调度、放置与容错](07_scheduling_and_fault_tolerance.md) | logical resource、worker lease、重试与重建如何工作？ |
| 8 | [Ray Data 数据流水线](08_ray_data.md) | Dataset 的惰性 DAG 如何变成流式执行？ |
| 9 | [Ray Train 与 Ray Tune](09_train_and_tune.md) | 数据并行训练与超参搜索如何复用 Ray Core？ |
| 10 | [Ray Serve 在线服务](10_ray_serve.md) | Deployment、Controller、Replica、Handle 如何组成服务？ |
| 11 | [RLlib 强化学习系统](11_rllib.md) | EnvRunner、RLModule、Learner、Algorithm 各自负责什么？ |
| 12 | [测试、调试与贡献工作流](12_testing_debugging_contributing.md) | 如何最小成本验证修改并定位分布式故障？ |
| 13 | [综合练习与源码课题](13_capstone_exercises.md) | 如何把知识变成可验证的源码研究成果？ |
| 附录 | [术语表](glossary.md) | 同名词在 Ray 中究竟指什么？ |

## 推荐起点

- 第一次接触分布式系统：按 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 阅读，再选上层库。
- 已经熟悉 Ray API：先读 3 和 4，用调试器验证一次调用链，再阅读目标库。
- 只关心数据/训练：读 1 中的 DAG、对象存储和背压，再读 3、5、8、9。
- 只关心推理服务：读 1 中的 Actor、RPC 和背压，再读 3、6、7、10。
- 想贡献 C++ Core：完整阅读 1～7 和 12，并完成 13 的课题 A、B。

## 教程的代码阅读约定

源码会持续演进，所以教程优先引用“文件 + 符号名”，不依赖容易漂移的行号。例如：

```text
python/ray/remote_function.py::RemoteFunction._remote
src/ray/core_worker/core_worker.cc::CoreWorker::SubmitTask
```

用下面的命令可以在当前版本重新定位：

```bash
rg -n "def _remote" python/ray/remote_function.py
rg -n "CoreWorker::SubmitTask" src/ray/core_worker/core_worker.cc
```

教程中的代码分为三类：

1. **用户侧最小例子**：可以复制到虚拟环境中运行。
2. **源码摘取**：保留关键分支、略去日志和兼容逻辑，用于解释设计，不应直接替换原文件。
3. **伪代码**：明确标为伪代码，只用于表达控制流。

## 一个贯穿全教程的总问题

阅读每个模块时都反复问：

> 这份状态由谁拥有？调用是本地还是跨进程？数据是按值复制还是用引用传递？失败后谁负责恢复？

能稳定回答这四个问题，就已经抓住了 Ray 大部分复杂性的来源。

