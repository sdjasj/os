# 程序安全（Program Security）

这一阶段研究一个核心问题：程序把外部字节解释成长度、地址、格式串或控制流目标时，哪里会出现“数据变成权力”的瞬间。学习目的不是背诵某一种 payload，而是建立可迁移的分析方法。

## 先修知识

建议先理解：

- x86-64 寄存器、栈帧、函数调用约定；
- ELF 文件、虚拟内存和动态链接的基本概念；
- C 指针、数组、结构体以及 malloc/free；
- 使用 GDB 做断点、反汇编和内存查看。

## 章节

1. [程序安全基础：注入、内存错误与缓解](01-program-security.md)
2. [逆向工程：从字节恢复程序语义](02-reverse-engineering.md)
3. [返回导向编程：把既有代码当作积木](03-return-oriented-programming.md)
4. [动态分配器误用：堆对象的生命周期](04-dynamic-allocator-misuse.md)
5. [程序利用方法论：从崩溃到可解释的利用链](05-program-exploitation.md)

## 阅读方法

每一章都沿着同一条链路展开：

~~~text
外部输入
  -> 程序如何解析
  -> 哪条不变量被破坏
  -> 产生何种能力（泄漏、写入、控制流）
  -> 现有缓解会挡住什么
  -> 如何从根因修复
~~~

教程只使用原创玩具样例，不给出 pwn.college 挑战的 flag、精确输入或逐关解法。对应官方 dojo：
https://pwn.college/program-security/

---

[返回总目录](../../README.md) · [下一章：程序安全基础](01-program-security.md)
