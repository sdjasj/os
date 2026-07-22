# 操作系统主题版教程：从状态机到云上容器

这套主题版教程沿用课程“从应用理解操作系统”的主线：先把程序看成状态机，再观察操作系统提供的对象和 API，随后进入并发、持久化、安全和虚拟化。它将相邻讲次重组成 17 个知识主题，适合快速建立框架。若要按每份 PPT 的原始顺序学习全部内容，请使用[30 讲逐讲详解](lectures/README.md)。

默认环境是 64 位 Linux、GCC/Clang、POSIX 线程。建议先执行：

```bash
make -C examples -j
```

## 章节

1. [建立世界观：状态机、抽象与系统启动](01-foundations.md)（讲义 1–4）
2. [进程：把运行中的程序变成可管理对象](02-processes.md)（讲义 5）
3. [地址空间：每个进程都以为自己独占内存](03-address-spaces.md)（讲义 6）
4. [文件描述符、管道、终端与 Shell](04-objects-shell.md)（讲义 7–8）
5. [libc、运行时与动态内存分配](05-libc-memory.md)（讲义 9–10）
6. [ELF、链接、加载与应用生态](06-linking-ecosystem.md)（讲义 11–12）
7. [共享内存并发与内存模型](07-concurrency-model.md)（讲义 13）
8. [互斥：把危险并发收缩成顺序区间](08-mutual-exclusion.md)（讲义 14）
9. [同步：条件变量、信号量与计算图](09-synchronization.md)（讲义 15–16）
10. [并发 Bug、检测工具与可扩展性](10-bugs-scalability.md)（讲义 17–18）
11. [异步、事件循环、GPU 与数据中心](11-async-gpu-datacenter.md)（讲义 19–21）
12. [设备、驱动与存储介质](12-devices-storage.md)（讲义 22–23）
13. [文件系统：API、数据结构与崩溃一致性](13-filesystems.md)（讲义 24–26）
14. [数据库：从 WAL 到 ACID](14-databases.md)（讲义 27）
15. [系统安全：身份、权限、漏洞与供应链](15-security.md)（讲义 28）
16. [虚拟机与容器：隔离一台“假的计算机”](16-vm-containers.md)（讲义 29）
17. [总复习与 MiniLab 实践路线](17-review-labs.md)（讲义 30、M1–M9）

## 推荐学习节奏

每章分三轮：第一轮只读“核心模型”；第二轮亲手编译、跟踪示例；第三轮不看答案完成章末自测。遇到系统调用时先读 `man 2 NAME`，遇到库函数读 `man 3 NAME`。建议经常使用：

```bash
strace -f ./examples/fork_exec
gdb --args ./examples/mmap_cow
perf stat ./examples/parallel_sum 4 10000000
```

`strace` 看“程序向操作系统请求了什么”，`gdb` 看“用户态状态怎样变化”，`perf` 看“代价花在哪里”。这三种视角贯穿整套教程。
