# 系统安全（System Security）

程序安全关注单个进程内部；系统安全关注多个组件、权限域和共享资源之间的缝隙。一个局部正确的组件，放进复杂系统后仍可能因竞态、错误隔离或内核接口而失去安全性。

## 先修

- Linux 进程、用户、权限和文件描述符；
- 虚拟内存、系统调用与基本并发；
- C 指针和 x86-64 基础；
- 前一阶段的内存错误与漏洞原语。

## 章节

1. [导论：资产、主体、边界与不变量](00-introduction.md)
2. [沙箱：chroot、namespace、capability 与 seccomp](01-sandboxing.md)
3. [竞态条件：时间也是输入](02-race-conditions.md)
4. [内核安全：最高权限代码的边界](03-kernel-security.md)
5. [微体系结构利用：抽象层下的侧信道](04-microarchitecture-exploitation.md)
6. [系统利用：组合边界失效与纵深防御](05-system-exploitation.md)

示例限于本机低权限、临时目录或抽象模型，不包含 pwn.college 关卡答案。

官方 dojo：https://pwn.college/system-security/

---

[上一分区：程序安全](../05-program-security/README.md) · [返回总目录](../../README.md) · [下一章：导论](00-introduction.md)

