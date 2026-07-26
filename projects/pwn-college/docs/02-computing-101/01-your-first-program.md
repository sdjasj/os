# 01 · 第一个程序：寄存器、指令与系统调用

> 对应官方模块：[Your First Program](https://pwn.college/computing-101/your-first-program/)

## 学习目标

- 说清源代码、汇编、机器码和进程之间的关系。
- 理解寄存器是 CPU 当前计算状态的一部分，而不是“很快的变量名”。
- 按 Linux x86-64 ABI 准备参数并发起系统调用。
- 独立构建一个不依赖 C 标准库的最小程序。

## 从文本到正在运行的进程

处理器不会直接执行 C 或 Python。以本章的汇编程序为例，路径是：

~~~text
汇编文本 .s
   ↓ assembler
目标文件 .o：机器码 + 符号 + 重定位信息
   ↓ linker
ELF 可执行文件：代码段、数据段、入口地址
   ↓ execve 与内核装载器
进程：虚拟地址空间 + 寄存器初值 + 文件描述符
~~~

汇编指令是机器指令的可读表示。不同 CPU 架构有不同指令集；本教程使用 x86-64。操作系统又在指令集之上规定 ABI：参数放在哪些寄存器、系统调用号是什么、哪些寄存器由调用者保存等。只知道指令而忽略 ABI，程序仍无法正确和 Linux 对话。

## 寄存器与数据移动

x86-64 的通用寄存器大多宽 64 位。<code>rax</code>、<code>rdi</code> 等名字指向 CPU 中的固定存储位置。指令：

~~~asm
mov rdi, 7
mov rax, rdi
~~~

先把整数 7 写入 <code>rdi</code>，再复制到 <code>rax</code>。第二条指令不会清空 <code>rdi</code>；普通 <code>mov</code> 是复制，不是高级语言所谓“移动所有权”。

寄存器的位模式本身没有类型。同一个 <code>0x41</code>，可按整数 65、ASCII 字符 A 或地址的一部分解释。类型来自当前指令和程序约定。

## Linux x86-64 系统调用约定

执行 <code>syscall</code> 前，常见寄存器含义如下：

| 位置 | 含义 |
| --- | --- |
| <code>rax</code> | 系统调用号 |
| <code>rdi</code> | 第 1 个参数 |
| <code>rsi</code> | 第 2 个参数 |
| <code>rdx</code> | 第 3 个参数 |
| <code>r10</code>、<code>r8</code>、<code>r9</code> | 第 4～6 个参数 |
| 返回后的 <code>rax</code> | 返回值；负值常表示 <code>-errno</code> |

这与普通 C 函数调用相似但不完全相同，尤其是第 4 个参数。不能把两套约定混用。

## 完整示例：直接调用 write 与 exit

保存为 <code>hello_syscall.s</code>：

~~~asm
.intel_syntax noprefix
.global _start

.section .rodata
message:
    .ascii "registers + syscalls\n"
message_end:

.section .text
_start:
    # write(1, message, message_end - message)
    mov rax, 1
    mov rdi, 1
    lea rsi, [rip + message]
    mov rdx, message_end - message
    syscall

    # exit(7)
    mov rax, 60
    mov rdi, 7
    syscall
~~~

构建并运行：

~~~bash
gcc -nostdlib -no-pie -Wl,--build-id=none -o hello_syscall hello_syscall.s
./hello_syscall
printf 'exit=%d\n' "$?"
~~~

预期输出：

~~~text
registers + syscalls
exit=7
~~~

<code>_start</code> 是链接器写入 ELF 的入口，不是 C 的 <code>main</code>。没有 C 运行时替我们返回，所以必须显式调用 <code>exit</code>。<code>lea rsi, [rip + message]</code> 计算消息的运行时地址；标签相减由汇编器算出字节长度，避免手数。

可用下面两条命令从不同层观察它：

~~~bash
readelf -h hello_syscall | grep 'Entry point'
objdump -d -M intel hello_syscall
~~~

入口地址会因工具链而异，但反汇编中应能看到两条 <code>syscall</code>。

## 常见误区

- **认为汇编一行必然对应一个机器码字节。** x86 指令是变长编码。
- **把寄存器当成有固定类型的变量。** 位模式如何解释取决于指令。
- **把普通函数 ABI 与 syscall ABI 混为一谈。** 两者参数寄存器不完全相同。
- **从 <code>_start</code> 使用 <code>ret</code> 退出。** 内核没有像普通调用者那样为入口准备可返回的函数地址。
- **使用管理员权限构建。** 编译和运行这个程序不需要 root。

## 纸面练习

若执行 <code>write(2, buffer, 5)</code>，系统调用前 <code>rax</code>、<code>rdi</code>、<code>rsi</code>、<code>rdx</code> 分别应表达什么？这里的 2 是什么？

### 答案

<code>rax=1</code> 表示 x86-64 Linux 的 <code>write</code>；<code>rdi=2</code> 是第一个参数，即标准错误文件描述符；<code>rsi</code> 保存 <code>buffer</code> 首字节的地址；<code>rdx=5</code> 是最多写出的字节数。数字 2 不是“错误码”，而是进程约定俗成的 stderr 描述符。

## 小结

最小程序已经包含完整计算模型：指令改变寄存器，地址连接代码与数据，ABI 让用户态把请求交给内核。后续内存、栈和控制流只是把这个状态模型展开得更细。

---

[← 本节索引](./README.md) · [下一篇：计算机内存 →](./02-computer-memory.md)
