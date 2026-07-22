# 2026 OS 课程逐讲详解

本目录严格对应课程的 30 份讲义，一讲一章。每章按原幻灯片顺序解释全部主题，并补充可复现实验、代码推导、常见误区、思考题和前后讲连接。若只想先建立知识框架，可回到[主题版教程](../README.md)；逐讲版适合跟课、复习和查漏补缺。

当前版本共 32,640 行 Markdown，逐项覆盖原讲义 779 个非重复一级标题。每讲由独立的子代理讲次任务起草，并经过按 PPT 标题、案例、实验、前后导航和本地链接的二次审计。外部扩展资料优先引用标准、官方文档、论文或项目源码；课程观点、扩展解释与时效性判断在正文中分开说明。

## 绪论与观察方法

1. [操作系统概述](01-os-overview.md)
2. [应用视角的操作系统](02-application-view.md)
3. [硬件视角的操作系统](03-hardware-view.md)
4. [Scaling Law 和 Agentic AI](04-scaling-agentic-ai.md)

## 虚拟化与应用生态

5. [程序和进程](05-programs-processes.md)
6. [进程的地址空间](06-address-space.md)
7. [访问操作系统对象](07-os-objects.md)
8. [终端和 UNIX Shell](08-terminal-shell.md)
9. [C 标准库和实现（1）](09-libc-1.md)
10. [C 标准库和实现（2）](10-libc-2.md)
11. [可执行文件、链接与加载](11-executable-linking.md)
12. [构建应用程序生态](12-application-ecosystem.md)

## 并发、并行与异步

13. [多处理器编程](13-multiprocessor.md)
14. [并发控制：互斥](14-mutual-exclusion.md)
15. [并发控制：条件变量](15-condition-variables.md)
16. [并发控制：信号量](16-semaphores.md)
17. [并发 Bug 和应对](17-concurrency-bugs.md)
18. [并行算法与数据结构](18-parallel-algorithms.md)
19. [异步编程模型](19-async-model.md)
20. [CPU、GPU 和 SIMT](20-cpu-gpu-simt.md)
21. [一个 Token 的旅程](21-token-journey.md)

## 持久化、数据库与系统边界

22. [输入/输出设备原理](22-io-devices.md)
23. [存储设备的抽象](23-storage.md)
24. [文件系统 API（1）](24-filesystem-api-1.md)
25. [文件系统 API（2）](25-filesystem-api-2.md)
26. [文件系统实现](26-filesystem-implementation.md)
27. [数据库系统](27-databases.md)
28. [计算机安全简介](28-security.md)
29. [虚拟机和容器](29-vm-containers.md)
30. [课程总结](30-course-summary.md)

## 使用建议

每讲建议分三步：先阅读“本讲定位”和问题地图；再亲手运行代码/命令实验；最后用 PPT 覆盖表对照[抽取后的原讲义](../../sources/README.md)。所有 MiniLab 仍遵守课程 AIGC Policy，本教程只解释所需机制与调试方法，不提供实验答案。
