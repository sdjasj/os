# 02 · Computing 101

计算机安全最终要落到“程序实际让 CPU 做了什么”。本部分沿用 [Computing 101](https://pwn.college/computing-101/) 的当前模块顺序，从寄存器、内存和系统调用出发，逐步建立汇编、调用约定、调试与网络服务的统一模型。

## 学完后能够

- 解释源代码、汇编、机器码、进程和操作系统之间的关系。
- 用地址、指针、字节序和栈帧推导数据在内存中的真实布局。
- 阅读小型 x86-64 汇编程序，并写出只依赖 Linux 系统调用的程序。
- 使用 GDB、反汇编器和系统调用跟踪工具验证假设。
- 从 socket 系统调用一直推导到一个仅监听 localhost 的 HTTP 服务。

## 环境与安全约定

示例面向 Linux x86-64，默认使用普通用户。C 示例建议用 GCC，汇编示例使用 GNU assembler 的 Intel 语法。涉及地址的输出受 ASLR 影响，只给出结构和形态，不要求地址完全相同。网络示例只绑定 <code>127.0.0.1</code>，不会对局域网或互联网开放。

## 章节索引

| 序号 | 教程 | 核心问题 |
| --- | --- | --- |
| 01 | [第一个程序](./01-your-first-program.md) | CPU、寄存器和系统调用如何组成程序 |
| 02 | [计算机内存](./02-computer-memory.md) | 地址、指针和解引用分别是什么 |
| 03 | [栈](./03-the-stack.md) | 栈为何适合保存临时状态 |
| 04 | [啃一口数字](./04-nibbling-on-numbers.md) | 位模式怎样表示无符号数和负数 |
| 05 | [软件内省](./05-software-introspection.md) | 如何用工具观察程序而不是猜测 |
| 06 | [输出与输入](./06-output-and-input.md) | 系统调用怎样把进程连接到外部世界 |
| 07 | [控制流](./07-control-flow.md) | 条件、循环和函数如何落到指令 |
| 08 | [端序历险](./08-endian-escapades.md) | 多字节值在内存中按什么顺序排列 |
| 09 | [汇编练习集](./09-assembly-assortment.md) | 位运算、移位和循环怎样组合 |
| 10 | [再访栈](./10-the-stack-revisited.md) | 栈帧、调用约定和对齐如何协作 |
| 11 | [字符串形式的数字](./11-numbers-as-strings.md) | 文本数字如何解析和格式化 |
| 12 | [调试复习](./12-debugging-refresher.md) | 怎样建立可重复的 GDB 调试流程 |
| 13 | [构建 Web 服务器](./13-building-a-web-server.md) | socket、HTTP 与并发如何连成系统 |

## 推荐学习方法

每篇先给出可推导的模型，再给出完整原创示例。即使没有时间运行，也应在纸上预测寄存器、内存或输出的变化，再对照预期输出。遇到地址或 PID 等动态值时，比较关系而不是死记数值。

本教程不复刻 pwn.college challenge，不包含 flag、关卡答案或精确利用 payload。示例只用于理解公开概念。

---

[← Linux Luminarium](../01-linux-luminarium/README.md) · [第一篇：第一个程序 →](./01-your-first-program.md)
