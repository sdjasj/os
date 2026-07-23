# 0. 学习路线与使用方法

## 0.1 学习目标分层

“学会一个大型项目”至少有四层含义。建议逐层推进，不要一开始就钻入 C++ 调度器。

### 第一层：API 使用者

你能写出 Task、Actor、Dataset 或 Serve 应用，知道 `ray.get` 会阻塞，知道资源要显式声明。验收题：把一个串行 CPU 程序改成并行任务，并解释为什么并行度没有超过逻辑 CPU 数。

### 第二层：系统解释者

你能画出 Driver → CoreWorker → raylet → Worker 的任务路径；能解释 `ObjectRef` 不是对象本身；能区分控制面和数据面。验收题：不看教程，口述 `f.remote(x)` 从 Python 到 C++ 再回到 Python Worker 的过程。

### 第三层：源码修改者

你能找到某个行为的实现位置，写最小测试，判断修改属于 Python、Cython、C++ 还是 protobuf 边界。验收题：给任务选项新增一项只在 Python 生效的校验，并能指出若要传进 C++ 还要修改哪些层。

### 第四层：架构设计者

你能讨论局部调度、分布式引用计数、背压、容错语义的取舍，知道改动会影响性能、可观测性和兼容性的哪些面。验收题：设计一个新调度约束，并列出协议、状态所有权、故障恢复和测试矩阵。

## 0.2 三条建议路线

### 路线 A：Ray Core 与分布式系统（约 4～6 周）

| 周 | 学习内容 | 动手结果 |
|---|---|---|
| 1 | 背景知识、仓库地图、最小 API | 能运行 Task/Actor，记录进程 ID 与节点 ID |
| 2 | `ray.init`、Task 调用链 | 画出启动进程图和普通任务时序图 |
| 3 | ObjectRef、Plasma、引用计数 | 用 `ray memory` 分析一次对象滞留 |
| 4 | Actor、并发、资源 | 比较串行 Actor、async Actor、普通 Task |
| 5 | worker lease、放置、容错 | 阅读一个 C++ 单元测试并修改本地断言 |
| 6 | 测试与小课题 | 完成第 13 章课题 A 或 B |

### 路线 B：分布式机器学习（约 3～5 周）

按 1 → 3 → 5 → 7 → 8 → 9 学习。重点不是记 Trainer 参数，而是理解：

- Dataset block 为什么适合通过 ObjectRef 串联；
- 每个训练 worker 为什么通常是长生命周期 Actor；
- `ScalingConfig` 如何转成资源请求；
- Tune 为什么要把一次训练包装成 Trial；
- checkpoint 为什么既是用户数据，也是故障恢复协议的一部分。

### 路线 C：在线推理与强化学习（约 4～6 周）

按 1 → 3 → 6 → 7 → 10 阅读；若学习 RLlib，再读 8、9、11。Serve 和 RLlib 都大量使用 Actor，但目的不同：Serve 用 Actor 承载稳定在线副本，RLlib 用 Actor 扩展采样与学习吞吐。

## 0.3 每个模块的“四遍阅读法”

### 第一遍：只看公共行为

先运行最小代码，记录返回值类型、进程 ID、耗时和错误。不要急着读实现。

```python
import os
import ray

ray.init()

@ray.remote
def where_am_i(x):
    return {"value": x, "pid": os.getpid()}

ref = where_am_i.remote(42)
print(type(ref))
print(ray.get(ref))
```

观察重点：`.remote()` 立即返回 `ObjectRef`，实际值稍后由 `ray.get()` 取回；返回结果中的 PID 通常不是 Driver PID。

### 第二遍：只追主路径

搜索最关键的符号，不展开异常处理和兼容分支：

```bash
rg -n "class RemoteFunction|def _remote" python/ray/remote_function.py
rg -n "def submit_task" python/ray/_raylet.pyx
rg -n "CoreWorker::SubmitTask" src/ray/core_worker/core_worker.cc
```

先回答“下一跳是谁”，不要试图一次读懂整个类。

### 第三遍：补状态与失败分支

给主路径上的每个对象标注：

- 所有者：Driver、Worker、raylet 还是 GCS；
- 生命周期：一次调用、一个 Job、一个节点或整个集群；
- 失败：进程死掉后状态是否可重建；
- 通信：本地函数、共享内存、IPC、gRPC 或 pub/sub。

### 第四遍：用测试反证理解

不要只读实现，也读测试。测试通常比注释更准确地表达边界条件。例如普通任务提交器的行为可以从
[normal_task_submitter_test.cc](../src/ray/core_worker/task_submission/tests/normal_task_submitter_test.cc) 反推；Actor 顺序与重试可从
[actor_task_submitter_test.cc](../src/ray/core_worker/task_submission/tests/actor_task_submitter_test.cc) 反推。

## 0.4 学习笔记模板

建议每追一个符号都记录下面六项：

```text
符号：RemoteFunction._remote
入口：用户调用 f.remote(*args)
输入：扁平化参数、task options、函数描述符
输出：一个或多个 ObjectRef
下一跳：worker.core_worker.submit_task（Cython）
重要不变量：远程函数定义按 cluster + job 导出；提交本身不等待任务完成
```

## 0.5 常见无效学习方式

1. 从 `src/ray` 第一个文件顺序读到最后一个文件：缺少问题驱动，很快被细节淹没。
2. 只看架构图不运行程序：无法建立“什么时候阻塞、什么时候复制”的直觉。
3. 只看 Python 不看边界：会误以为调度发生在装饰器内。
4. 一上来跑全量测试：Ray 全量测试远超个人机器合理范围，应运行目标测试。
5. 把逻辑资源当容器隔离：Ray 的 CPU resource 主要是调度准入，不自动限制线程数或 CPU 使用量。
6. 用 `ray.get([f.remote(...) ...])` 之外的写法逐个 `ray.get`：可能无意中把并行程序重新串行化。

## 0.6 学习完成的证据

不要用“我读完了多少文件”衡量进度。更可靠的证据是：

- 能从一个公共 API 快速定位到实现和测试；
- 能画出状态所有权和进程边界；
- 能预测一个选项改变后，任务数量、对象数量或资源占用如何变化；
- 能构造一个最小失败案例并用 State API、日志和测试定位；
- 能解释设计取舍，而不只是复述类名。

