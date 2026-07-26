# 03 · x86-64 寄存器与 Linux 系统调用

## 适用范围

本篇描述 **System V AMD64 ABI 下的 Linux x86-64 用户态**。Windows x64、32 位 x86、内核内部调用约定和其他架构均不同。阅读反汇编前先确认文件架构：

```bash
file -- ./program
uname -m
```

典型输出会包含 `ELF 64-bit ... x86-64` 与 `x86_64`。如果输出是 AArch64、PE32+ 或 32-bit，就不能直接套用本表。

## 通用寄存器地图

| 寄存器 | 常见角色 | 函数调用后是否需由被调函数保持 |
| --- | --- | --- |
| `RAX` | 返回值、可变参数向量计数、syscall 号 | 否 |
| `RBX` | 通用 | 是 |
| `RCX` | 第 4 个函数整数参数；`syscall` 会改写 | 否 |
| `RDX` | 第 3 个函数/系统调用参数、部分扩展结果 | 否 |
| `RSI` | 第 2 个整数参数 | 否 |
| `RDI` | 第 1 个整数参数 | 否 |
| `RBP` | 可选帧指针或通用寄存器 | 是 |
| `RSP` | 栈顶指针 | 必须按 ABI 恢复 |
| `R8`、`R9` | 第 5、6 个函数参数；syscall 第 5、6 参数 | 否 |
| `R10` | syscall 第 4 参数 | 否 |
| `R11` | 通用；`syscall` 会改写 | 否 |
| `R12`–`R15` | 通用 | 是 |
| `RIP` | 下一条指令位置 | 由控制流改变 |
| `RFLAGS` | 条件码与控制标志 | 多数算术/控制指令改变 |

“caller-saved”表示调用者若还需要该值，应在 `call` 前自行保存；“callee-saved”表示被调函数使用后必须恢复。它不是安全属性，也不表示寄存器永远保存某类数据。

写 32 位子寄存器通常会把对应 64 位寄存器高 32 位清零，例如写 `eax` 后 `rax` 高半部为零；写 `ax` 或 `al` 不具有同样效果。

## 普通函数调用约定

System V AMD64 中，前六个整数或指针参数依次位于：

```text
RDI, RSI, RDX, RCX, R8, R9
```

更多参数通常放在栈上，整数返回值通常在 `RAX`。调用点需满足 ABI 的栈对齐要求。用户态还有 128 字节 red zone：叶子函数可在特定条件下使用 `RSP` 下方区域，但信号、编译选项和内核代码有不同约束，不能盲目依赖。

以下 C 函数：

```c
long combine(long a, long b, long c) {
    return a + 2 * b + c;
}
```

进入 `combine` 时通常可从 `rdi`、`rsi`、`rdx` 读取 `a`、`b`、`c`，返回前把结果放入 `rax`。优化器可能内联函数，因此实际二进制不一定保留独立 `call`。

## 系统调用约定与函数调用不同

Linux x86-64 执行 `syscall` 时：

```text
RAX = syscall number
RDI, RSI, RDX, R10, R8, R9 = 参数 1..6
RAX = 返回值
RCX, R11 = 被 syscall 指令改写
```

最容易错的是第 4 参数：普通函数放在 `RCX`，系统调用放在 `R10`。libc 包装函数还会把内核的负错误返回转换成 `-1` 并设置线程局部的 `errno`；直接 syscall 看到的是不同层次。

## 安全示例：只写标准输出后退出

保存为 `hello.S`，使用 GNU 汇编器的 AT&T 语法：

```asm
.global _start

.section .rodata
message:
    .ascii "hello from syscall\n"
.set message_len, . - message

.section .text
_start:
    mov $1, %rax              # __NR_write on Linux x86-64
    mov $1, %rdi              # fd = stdout
    lea message(%rip), %rsi   # buffer
    mov $message_len, %rdx    # count
    syscall

    mov $60, %rax             # __NR_exit on Linux x86-64
    xor %rdi, %rdi            # status = 0
    syscall
```

编译并运行自有文件：

```bash
gcc -nostdlib -no-pie -o hello hello.S
./hello
printf 'exit=%d\n' "$?"
```

预期输出：

```text
hello from syscall
exit=0
```

`_start` 不是 C 的 `main`，这里没有 libc 初始化或返回地址，所以用 `exit` syscall 结束。`write` 可能短写；教学示例消息很小，但健壮程序仍应检查返回值并循环处理剩余数据。

## Intel 与 AT&T 语法不要混读

| 项目 | Intel | AT&T |
| --- | --- | --- |
| 操作数顺序 | `dest, src` | `src, dest` |
| 寄存器 | `rax` | `%rax` |
| 立即数 | `1` | `$1` |
| 内存示例 | `[rip+message]` | `message(%rip)` |

GDB 可用 `set disassembly-flavor intel` 切换显示语法；切换只改变显示，不改变机器码。

## 常见误区与注意点

- 系统调用号按架构定义，x86-64 的 `60` 不能套到所有平台。
- 函数第 4 参数在 `RCX`，syscall 第 4 参数在 `R10`。
- 小端描述内存字节排列，不改变汇编文本中寄存器值的书写方向。
- 调试器显示的地址受 ASLR 和 PIE 影响，每次运行可能不同。
- `syscall` 是权限边界入口，不代表请求一定成功；必须检查返回值。
- 不要对未知二进制直接执行；先在隔离环境静态检查架构和来源。

## 官方资料

- [System V x86-64 psABI 项目](https://gitlab.com/x86-psABIs/x86-64-ABI)
- [Linux 内核 x86-64 syscall 表](https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/tree/arch/x86/entry/syscalls/syscall_64.tbl)
- [Linux `syscalls(2)` 手册](https://man7.org/linux/man-pages/man2/syscalls.2.html)

---

[← 上一篇：数值与编码参考](./02-number-encoding-reference.md) · [附录索引](./README.md) · [下一篇：GDB 参考 →](./04-gdb-reference.md)
