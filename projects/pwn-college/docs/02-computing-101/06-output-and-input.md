# 06 · 输出与输入：文件描述符和系统调用

> 对应官方模块：[Output and Input](https://pwn.college/computing-101/hello-hackers/)

## 学习目标

- 理解文件描述符是进程内的整数句柄。
- 解释 <code>read</code> 和 <code>write</code> 为何可能短读、短写。
- 写出正确处理 EOF、EINTR 和部分写入的复制程序。
- 理解 <code>openat</code> 与“相对哪个目录”之间的关系。

## 统一 I/O 模型

Linux 把终端、普通文件、管道和 socket 都暴露为文件描述符。进程启动时通常已有：

| 描述符 | 约定 |
| --- | --- |
| 0 | stdin，标准输入 |
| 1 | stdout，标准输出 |
| 2 | stderr，标准错误 |

描述符只是进程表中的下标，不是全局对象 ID。两个进程都拥有 fd 3，不代表它们指向同一资源。

<code>read(fd, buffer, count)</code> 返回实际读到的字节数。返回 0 表示 EOF；返回 -1 并设置 <code>errno</code> 表示错误。它可以在还没填满 <code>count</code> 时成功返回。<code>write</code> 同样可以只写出一部分。

## 完整示例：可靠复制 stdin 到 stdout

保存为 <code>copy_stream.c</code>：

~~~c
#include <errno.h>
#include <stdio.h>
#include <unistd.h>

static int write_all(int fd, const unsigned char *data, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t written = write(fd, data + offset, length - offset);
        if (written > 0) {
            offset += (size_t)written;
            continue;
        }
        if (written < 0 && errno == EINTR) {
            continue;
        }
        return -1;
    }
    return 0;
}

int main(void) {
    unsigned char buffer[4096];
    size_t total = 0;

    for (;;) {
        ssize_t received = read(STDIN_FILENO, buffer, sizeof buffer);
        if (received > 0) {
            if (write_all(STDOUT_FILENO, buffer, (size_t)received) < 0) {
                perror("write");
                return 1;
            }
            total += (size_t)received;
            continue;
        }
        if (received == 0) {
            break;
        }
        if (errno == EINTR) {
            continue;
        }
        perror("read");
        return 1;
    }

    dprintf(STDERR_FILENO, "copied=%zu bytes\n", total);
    return 0;
}
~~~

构建并运行：

~~~bash
gcc -std=c17 -D_POSIX_C_SOURCE=200809L -Wall -Wextra -O2 -o copy_stream copy_stream.c
printf 'alpha\nbeta\n' | ./copy_stream > copied.txt
cat copied.txt
~~~

预期终端输出：

~~~text
copied=11 bytes
alpha
beta
~~~

统计信息走 stderr，所以即使 stdout 被重定向到文件，状态仍显示在终端。<code>write_all</code> 循环处理部分写入，<code>EINTR</code> 表示调用在完成前被信号中断，可安全重试。

## 从汇编看系统调用 ABI

上面的 C 函数最终通过 libc 包装进入内核。在 Linux x86-64 上，<code>syscall</code> 指令使用另一套固定接口：系统调用号放在 <code>RAX</code>，前六个参数依次放在 <code>RDI、RSI、RDX、R10、R8、R9</code>，返回值仍在 <code>RAX</code>。第四个参数是 <code>R10</code>，不是普通 System V 函数调用约定中的 <code>RCX</code>；执行指令还会破坏 <code>RCX</code> 与 <code>R11</code>。

下表只适用于 Linux x86-64。其他架构的编号和寄存器约定不同，代码应以目标系统的头文件、ABI 和手册为准。

| 调用 | RAX | 参数摘要 |
| --- | ---: | --- |
| <code>read</code> | 0 | fd, buffer, count |
| <code>write</code> | 1 | fd, buffer, count |
| <code>close</code> | 3 | fd |
| <code>exit</code> | 60 | status |
| <code>openat</code> | 257 | directory fd, path, flags, mode |

原始系统调用失败时，<code>RAX</code> 通常是 <code>-errno</code> 范围内的负数；libc 包装器才把它转换成 <code>-1</code> 并设置线程局部的 <code>errno</code>。所以手写汇编不能照搬 C 的错误判断。

下面的完整程序只向标准输出写一条固定消息。它循环处理短写，并在 <code>EINTR</code>（Linux 错误号 4）时重试。保存为 <code>io_syscall.S</code>：

~~~asm
.intel_syntax noprefix
.global _start

.section .rodata
message:
    .ascii "hello from syscall\n"
.set message_length, . - message

.section .text
_start:
    lea rbx, [rip + message]       # 当前尚未写出的地址
    mov r12d, message_length       # 当前尚未写出的长度

.write_more:
    mov eax, 1                     # SYS_write
    mov edi, 1                     # stdout
    mov rsi, rbx
    mov rdx, r12
    syscall

    cmp rax, 0
    jg .made_progress
    cmp rax, -4                    # -EINTR
    je .write_more
    mov edi, 1                     # 0 或其他负数均作为失败
    jmp .finish

.made_progress:
    add rbx, rax
    sub r12, rax
    jne .write_more
    xor edi, edi                   # status = 0

.finish:
    mov eax, 60                    # SYS_exit
    syscall
~~~

构建和观察：

~~~bash
cc -nostdlib -no-pie -Wl,--build-id=none io_syscall.S -o io_syscall
./io_syscall
strace -e trace=write,exit ./io_syscall
~~~

第一条运行的预期输出是：

~~~text
hello from syscall
~~~

<code>strace</code> 还会显示一次成功的 <code>write(1, ..., 19)</code> 和 <code>exit(0)</code>；跟踪器的诊断在 stderr，故可能与程序输出交错。程序使用 <code>lea ... [rip + message]</code> 按“当前指令地址 + 相对偏移”求数据地址，不把链接时绝对地址硬编码进指令，这也是位置无关代码的基本技巧。

## 路径不是长度字符串

内核路径参数以 NUL 结尾。汇编中的 <code>.ascii "note.txt"</code> 不会自动追加 NUL，而 <code>.asciz "note.txt"</code> 会；若忘记终止，内核会继续读取相邻内存，直到偶然遇到零字节或访问失败。相反，<code>read</code>/<code>write</code> 的缓冲区由显式长度定界，内容可以合法包含 NUL。

以 x86-64 的 <code>openat</code> 为例，只读打开相对路径时的寄存器状态在概念上是：

~~~text
RAX = 257                 SYS_openat
RDI = -100                AT_FDCWD，以当前工作目录为基准
RSI = &"note.txt\0"       NUL 结尾路径
RDX = 0                   O_RDONLY
R10 = 0                   未创建文件，mode 不参与
~~~

成功时返回新的非负 fd；失败时返回负错误码。随后程序必须用实际 <code>read</code> 返回值决定可处理字节数，并最终 <code>close</code>。把路径终止规则、buffer 长度规则和返回值规则混成一个“字符串模型”，是汇编 I/O 中常见的根因。

## “读取恰好 N 字节”需要循环

协议常要求固定长度头部。单次 <code>read(fd, header, 8)</code> 不能保证得到 8 字节；正确逻辑应累计到：

- 已得到 N 字节；
- 遇到 EOF；
- 遇到不可恢复错误。

同时要定义“中途 EOF”是合法短消息还是协议错误。系统调用只提供事实，协议层决定含义。

## open、openat 与路径基准

<code>open("note.txt", ...)</code> 按进程当前工作目录解析相对路径。<code>openat(directory_fd, "note.txt", ...)</code> 可以显式选择目录描述符作为基准，从而减少 cwd 变化引起的歧义。若使用特殊值 <code>AT_FDCWD</code>，行为又退回当前工作目录。

安全程序还要考虑：

- 是否允许符号链接；
- 是否会跟随到预期目录之外；
- 打开和检查之间是否存在竞态；
- 新文件的 mode 如何受 umask 影响。

这里只建立 I/O 模型；更复杂的路径安全应使用适合平台的高层 API 和原子标志。

## 常见误区

- **认为 read 成功就填满缓冲区。** 返回值才是有效字节数。
- **用字符串函数处理任意 read 数据。** <code>read</code> 不自动添加 NUL。
- **忽略 write 的返回值。** 管道、socket 和信号下短写很正常。
- **把 stderr 也重定向到了同一处却不知道。** <code>></code> 与 <code>2></code> 控制不同描述符。
- **把 EOF 当错误。** 流式读取中返回 0 通常是正常结束。

## 纸面练习

程序需要读 8 字节头部。前三次 <code>read</code> 分别返回 3、2、3。每次下一次调用应把目标指针和最大长度调整为什么？

### 答案

第一次后已读 3 字节，下一次从 <code>buffer+3</code> 开始、最多读 5；第二次累计 5，从 <code>buffer+5</code> 开始、最多读 3；第三次累计 8，完成。不能每次都写到 <code>buffer</code> 开头，否则会覆盖先前数据。

## 小结

文件描述符统一了外部资源，返回值刻画每次真实进度。正确 I/O 的核心不是“调用一次函数”，而是根据短读、短写、EOF 和错误维护状态。

---

[← 上一篇：软件内省](./05-software-introspection.md) · [下一篇：控制流 →](./07-control-flow.md)
