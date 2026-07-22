# 第 17 章：总复习与 MiniLab 实践路线

> 对应讲义：[第 30 讲](../sources/notes/lect30.md)，实验说明：[M1–M9](../sources/notes/labs/README.md)

课程真正希望留下的不是一串术语，而是一种还原方法：任何软件都能继续拆成状态、对象、接口和实现；复杂机制最终可用小程序、trace 和数据结构触摸。

## 17.1 一张总图

```text
应用与 Agent
  │ libc/runtime/语言/数据库
  │
  ├─ 进程与线程 ─ 地址空间 ─ 文件描述符 ─ signal/IPC
  │                  │              │
  ├─ 并发：mutex / condvar / semaphore / event loop / GPU
  │                  │              │
  ├─ 持久化：VFS / filesystem / WAL / block I/O
  │                  │              │
  ├─ 隔离：UID / namespace / cgroup / VM / seccomp
  │
内核：系统调用、异常、中断、调度、页表、驱动
  │
硬件：CPU / MMU / memory / bus / disk / NIC / GPU
```

纵向追踪一次操作，是最有效的复习：

- `printf`：格式化 → stdio buffer → `write` → fd → tty driver → terminal emulator；
- `malloc`：size class → arena → `mmap/brk` → 页表 → 首次触碰缺页 → 物理页；
- 保存文件：用户 buffer → page cache → filesystem metadata/log → block layer → SSD FTL；
- LLM 请求：浏览器 → socket → 负载均衡 → 服务事件循环 → GPU kernel → 流式响应。

## 17.2 四类核心问题

遇到陌生系统，依次追问：

1. **状态是什么**：哪些变量、页、对象和持久记录决定行为？
2. **边界是什么**：API、ABI、系统调用、协议分别承诺什么？
3. **并发在哪里**：哪些事件没有总顺序，happens-before 如何建立？
4. **故障在哪里**：线程取消、进程崩溃、断电、网络分区、恶意输入后怎样恢复？

若还能回答“如何观察”和“代价在哪”，通常就真正理解了机制。

## 17.3 MiniLab 路线

课程实验有明确 AIGC Policy；下面只解释训练目标和建议的验证方法，不提供实验答案。

| 实验 | 核心能力 | 推荐观察/验证 |
|---|---|---|
| M1 `labyrinth` | 状态空间、图搜索、命令行工具协作 | 小地图手算、固定随机种子、路径合法性断言 |
| M2 `pstree` | `/proc`、进程信息、树结构 | 与 `ps/pstree` 交叉比对，注入进程退出竞态 |
| M3 `sperf` | `ptrace`/采样、符号与性能分析 | 对已知热点程序采样，验证地址到符号映射 |
| M4 `crepl` | 编译、动态加载、符号状态 | 从单表达式到多定义，检查编译错误与清理 |
| M5 `mymalloc` | allocator、对齐、碎片和线程安全 | 随机 alloc/free trace、ASan、边界与耗尽测试 |
| M6 `gpt.c` | 多线程计算、同步与性能 | 与单线程参考比对，TSan，线程数扩展曲线 |
| M7 `httpd` | socket、HTTP、并发/事件驱动 | `curl`、畸形请求、慢客户端、并发和资源上限 |
| M8 `fsrecov` | 磁盘格式、目录与恢复 | 手工构造最小镜像、损坏副本、只读验证 |
| M9 `libkvdb` | WAL、崩溃一致性与并发 KV | kill-point、尾部撕裂、重放、线性化历史检查 |

每个实验都先实现“可信参考模型”，再优化。正确性测试最好包含：空输入、最小/最大边界、重复操作、失败系统调用、并发、进程被杀与资源泄漏。

## 17.4 推荐调试工作流

```text
复现 → 缩小 → 写预测 → 选择观测点 → 收集证据 → 修复 → 加回归测试
```

工具按问题选：

```bash
# 编译与二进制
cc -Wall -Wextra -g ...
readelf -a program
objdump -dr program

# 用户态状态
gdb --args ./program ...

# 内核边界
strace -ff -o /tmp/trace ./program

# 内存与并发
cc -fsanitize=address,undefined ...
cc -fsanitize=thread -pthread ...

# 性能
perf stat ./program
perf record -g ./program && perf report
```

先用最小输入固定问题，再增加随机和压力。日志应包含足够的身份（PID/TID、请求 ID、事务 ID）和顺序信息，但不要泄漏密钥或无限增长。

## 17.5 一条 8 周学习路线

| 周 | 主题 | 必做示例 |
|---:|---|---|
| 1 | 状态机、启动、进程 | `state_machine`、`fork_exec` |
| 2 | 地址空间、fd、管道、Shell | `mmap_cow`、`pipeline` |
| 3 | libc、malloc、ELF、动态链接 | `mini_malloc`、`LD_PRELOAD` |
| 4 | 线程、内存模型、互斥 | `race_counter`、`mutex_transfer` |
| 5 | 条件变量、信号量、并发 Bug | `bounded_buffer`、`semaphore_dag` |
| 6 | 并行、异步、GPU | `parallel_sum`、`epoll_timer` |
| 7 | 设备、存储、文件系统 | `device_file`、`atomic_replace` |
| 8 | 数据库、安全、虚拟化 | `wal_kv`、`constant_time_compare`、`namespace_info` |

每周至少做一次“不看教程，自己预测输出”的实验。能解释反常结果，比一次把代码写对更有学习价值。

## 17.6 综合项目：可恢复的并发任务执行器

若想把全课串起来，可设计一个小型本地任务服务：

1. Shell/HTTP 接收命令，解析为任务；
2. 有界队列提供背压，线程池执行；
3. 子进程通过 `fork/exec` 隔离任务，管道收集输出；
4. `epoll` 同时管理多个输出 fd 与超时；
5. WAL 先记录 `SUBMIT/START/DONE`，崩溃后恢复未完成任务；
6. 用 UID、rlimit、namespace/seccomp 降低不可信任务权限；
7. 指标记录队列长度、吞吐、p99 和失败原因。

不要一步写完。先做单线程纯内存模型，再加入持久化，再加入并发，最后才做隔离和优化。每层都保留可独立测试的接口。

## 17.7 终局自测

1. 为什么“程序是状态机”同时适用于解释器、编译后程序与 CPU？
2. `fork`、`exec`、`wait` 分别改变和保留哪些状态？
3. 相同虚拟地址为何能对应不同物理页？COW 的缺页路径是什么？
4. Shell 管道中为何每个进程都必须关闭无用端？
5. libc 的 API 与内核系统调用接口有什么不同？
6. ELF relocation、GOT 和 PLT 分别解决什么阶段的问题？
7. data race 为什么不仅是“结果偶尔不对”，而是 C/C++ UB？
8. mutex 应保护代码还是不变量？多对象锁如何避免 ABBA？
9. 条件变量为何必须在 `while` 中等待？
10. semaphore 计数与条件变量谓词有什么区别？
11. 死锁、活锁与饥饿各自是否有系统整体进展？
12. false sharing 为什么发生在逻辑不共享的变量上？
13. 事件循环怎样把调用栈隐式状态变成显式状态机？
14. SIMD 与 SIMT 的执行/控制流差异是什么？
15. DMA 为什么需要 IOMMU 和内存顺序？
16. SSD 为何需要 FTL，写放大从何而来？
17. `rename` 原子为何不等于 `fsync` 持久？
18. WAL 恢复为何需要长度、校验与 commit 边界？
19. namespace 与 cgroup 分别隔离什么？容器与 VM 的内核边界有何不同？
20. 面对新系统，怎样用 trace、最小模型和故障注入把它“还原”？

如果这些问题能用自己的实验回答，你掌握的就不只是某个 Linux 版本的 API，而是一套迁移到数据库、分布式系统、编译器和 AI 基础设施的系统思维。
