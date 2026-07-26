# 05 · 软件内省：用证据替代猜测

> 对应官方模块：[Software Introspection](https://pwn.college/computing-101/introspecting/)

## 学习目标

- 按“文件—装载—系统调用—指令—运行状态”选择观察工具。
- 区分静态分析与动态分析。
- 使用 <code>file</code>、<code>readelf</code>、<code>objdump</code>、<code>strace</code> 和 GDB 验证同一个程序。
- 理解调试信息、优化和 ASLR 对观察结果的影响。

## 观察分为五层

| 问题 | 典型工具 | 是否运行程序 |
| --- | --- | --- |
| 这是什么文件 | <code>file</code>、<code>sha256sum</code> | 否 |
| ELF 如何组织 | <code>readelf</code> | 否 |
| 有哪些机器指令 | <code>objdump</code> | 否 |
| 向内核发了什么请求 | <code>strace</code> | 是 |
| 某时刻寄存器和内存是什么 | GDB | 是 |

静态分析覆盖所有可见代码，但不自动告诉你实际走了哪条路径；动态分析给出一次真实执行，却可能漏掉没触发的分支。可靠结论通常来自两者互证。

## 完整观察对象

保存为 <code>inspect_me.c</code>：

~~~c
#include <stdio.h>
#include <stdlib.h>

__attribute__((noinline))
static long triangular(long n) {
    long total = 0;
    for (long current = 1; current <= n; ++current) {
        total += current;
    }
    return total;
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s N\n", argv[0]);
        return 2;
    }

    char *end = NULL;
    long n = strtol(argv[1], &end, 10);
    if (*argv[1] == '\0' || *end != '\0' || n < 0 || n > 1000) {
        fputs("N must be an integer from 0 to 1000\n", stderr);
        return 2;
    }

    printf("triangular(%ld)=%ld\n", n, triangular(n));
    return 0;
}
~~~

构建调试版本：

~~~bash
gcc -std=c17 -Wall -Wextra -O0 -g -fno-omit-frame-pointer -o inspect_me inspect_me.c
./inspect_me 5
~~~

预期输出：

~~~text
triangular(5)=15
~~~

## 静态观察

~~~bash
file inspect_me
readelf -h inspect_me | grep -E 'Class:|Machine:|Entry point'
objdump -d -M intel --disassemble=triangular inspect_me
~~~

输出中的地址会变化，但应观察到：

~~~text
ELF 64-bit ... x86-64 ... with debug_info ...
Class:                             ELF64
Machine:                           Advanced Micro Devices X86-64
...
<triangular>:
...
ret
~~~

反汇编展示指令，不保证还原原始变量名和源码结构。因为我们保留了符号，<code>triangular</code> 名称仍可见；去掉符号后，分析会更依赖控制流和数据流。

## 系统调用观察

~~~bash
strace -e trace=write,exit_group ./inspect_me 5
~~~

典型输出形态：

~~~text
write(1, "triangular(5)=15\n", 17) = 17
triangular(5)=15
exit_group(0) = ?
+++ exited with 0 +++
~~~

<code>printf</code> 是用户态库函数，最终通过 <code>write</code> 把缓冲内容交给内核。具体库可能采用不同缓冲策略，所以 trace 细节允许变化。

## 用 GDB 在函数边界取证

~~~bash
gdb -q -batch -ex 'break triangular' -ex 'run 5' -ex 'print n' -ex 'info registers rdi rsp rip' -ex 'disassemble /m triangular' ./inspect_me
~~~

关键输出应包含：

~~~text
Breakpoint ... triangular (n=5)
$1 = 5
rdi ... 5
~~~

断点停在函数刚进入附近时，第一个整数参数依 ABI 位于 <code>rdi</code>；GDB 也可借调试信息把它显示为 <code>n=5</code>。地址因 PIE、ASLR 和环境不同而变化。

## 建立可重复的观察记录

推荐每次记录：

1. 输入和构建命令；
2. 文件哈希，确认分析对象未变；
3. 观察点，例如函数入口或某系统调用；
4. 事实：寄存器、内存、返回值；
5. 推断以及下一步如何证伪。

不要把“看起来像”直接升级为结论。例如看到一个立即数 60，可先猜它是 <code>exit</code> syscall 号，再用控制流和实际 trace 证明。

## 常见误区

- **只看反编译伪代码。** 伪代码是工具推断，机器指令才是执行依据。
- **把一次动态运行当成所有路径。** 换输入或检查静态控制流。
- **在优化构建中期待变量逐行可见。** 优化会内联、合并和删除变量。
- **把地址差异当成程序变化。** 先考虑 PIE 和 ASLR。
- **对不可信二进制直接动态运行。** 应先静态检查，并在隔离环境中执行。

## 纸面练习

若要判断程序“是否尝试打开某文件”，<code>strings</code>、<code>objdump</code> 和 <code>strace</code> 各能提供什么证据？哪一个能直接证明某次运行真的发起了打开请求？

### 答案

<code>strings</code> 只能说明文件中存在可打印文本；<code>objdump</code> 可显示可能到达的调用或 syscall 指令；<code>strace</code> 能记录该次运行实际发生的 <code>openat</code> 等系统调用，因此对“这一次确实尝试打开”给出最直接证据。但它仍不能证明其他输入下不会打开别的文件。

## 小结

内省不是工具清单，而是证据链：静态信息提出假设，动态状态验证路径，系统调用确认外部效果。每一层都有盲区，组合起来才可靠。

---

[← 上一篇：啃一口数字](./04-nibbling-on-numbers.md) · [下一篇：输出与输入 →](./06-output-and-input.md)
