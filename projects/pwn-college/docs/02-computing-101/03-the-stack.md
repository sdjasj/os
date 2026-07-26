# 03 · 栈：临时状态与调用边界

> 对应官方模块：[The Stack](https://pwn.college/computing-101/the-stack/)

## 学习目标

- 用 LIFO 模型解释 push、pop 和栈指针。
- 理解 x86-64 栈通常向低地址增长。
- 区分“抽象栈数据结构”和“进程调用栈”。
- 说明参数、返回地址、局部变量为何可能出现在栈中。

## LIFO 只是起点

栈的抽象规则是后进先出：

~~~text
push 10  → [10]
push 20  → [10, 20]
pop      → 20，剩余 [10]
~~~

x86-64 的 <code>rsp</code> 保存当前栈顶地址。执行 <code>push rax</code> 时，处理器通常先让 <code>rsp</code> 减 8，再写入 8 字节；<code>pop rbx</code> 先读取，再让 <code>rsp</code> 加 8。因此“压栈”会向更低地址移动。

真实调用栈不只是 push/pop 容器。<code>call</code> 会保存返回地址并跳转；函数可能保存旧帧指针、被调用者保存寄存器、局部变量和临时溢出值。优化器也可能让某些变量始终留在寄存器中，所以源码中的“局部变量”不保证一定有栈槽。

## 完整示例：参数、局部值与返回

保存为 <code>stack_demo.c</code>：

~~~c
#include <stdio.h>

__attribute__((noinline))
long combine(long left, long right) {
    long sum = left + right;
    long scaled = sum * 3;
    return scaled;
}

int main(int argc, char **argv) {
    long result = combine(4, 5);
    printf("argc=%d\n", argc);
    printf("program=%s\n", argv[0]);
    printf("result=%ld\n", result);
    return 0;
}
~~~

构建、运行并生成汇编：

~~~bash
gcc -std=c17 -Wall -Wextra -O0 -fno-omit-frame-pointer -o stack_demo stack_demo.c
./stack_demo
gcc -std=c17 -O0 -fno-omit-frame-pointer -S -masm=intel -o stack_demo.s stack_demo.c
sed -n '/combine:/,/ret/p' stack_demo.s
~~~

程序的预期稳定输出为：

~~~text
argc=1
program=./stack_demo
result=27
~~~

汇编细节会因 GCC 版本不同，但未优化版本通常能看到类似结构：

~~~asm
push rbp
mov rbp, rsp
...
leave
ret
~~~

根据 System V AMD64 ABI，前两个整数参数通常先在 <code>rdi</code>、<code>rsi</code> 中，而不是由调用者直接压栈。未优化代码可能把它们复制到栈槽，便于调试。<code>ret</code> 从栈顶取回由 <code>call</code> 保存的返回地址。

## 初始栈与 argc/argv

内核启动新 ELF 时，会在初始用户栈放置参数数量、参数字符串地址、环境变量地址和辅助向量。C 运行时读取这些结构，再调用 <code>main(argc, argv)</code>。可以把 <code>argv</code> 看成指针数组：

~~~text
argv ──→ [地址0][地址1]...[NULL]
           │      │
           ▼      ▼
       "./程序\0" "参数\0"
~~~

运行 <code>./stack_demo extra</code> 时，<code>argc</code> 变为 2，<code>argv[1]</code> 指向字符串 <code>extra</code>。注意：字符串字节与指向它们的指针是两类不同对象。

## 栈地址与偏移

若一个函数建立固定帧，可以用“基址加偏移”描述槽位，例如 <code>[rbp-8]</code>。负偏移常用于局部数据，正偏移可能访问调用者一侧的内容，但具体布局取决于 ABI、编译选项和优化，不能把某张示意图当作所有程序的固定模板。

栈也是普通内存，边界并不会因“它是栈”而自动安全。数组写越界可能覆盖相邻状态。因此应使用长度检查和编译器保护；本章只做布局推导，不构造覆盖 payload。

## 常见误区

- **认为栈必然向低地址增长。** 这是 x86-64 等架构的常见约定，不是所有抽象机器的普遍定律。
- **认为所有函数参数都在栈上。** x86-64 ABI 优先用寄存器传参。
- **把 <code>rbp</code> 当成永远存在的帧指针。** 优化器可省略它。
- **通过不同局部变量的地址相减推断布局。** C 标准并不保证独立局部对象的相对顺序。
- **把返回值和进程退出码混淆。** 函数返回值通常在 <code>rax</code>；进程退出码还需交给运行时或 <code>exit</code>。

## 纸面练习

假设 <code>rsp=0x1000</code>，依次执行两次 64 位 <code>push</code>，再执行一次 64 位 <code>pop</code>。忽略异常，最终 <code>rsp</code> 是多少？被 pop 的是哪次压入的值？

### 答案

第一次 push 后为 <code>0x0ff8</code>，第二次后为 <code>0x0ff0</code>，pop 后回到 <code>0x0ff8</code>。取出的是第二次压入的值，体现 LIFO。

## 小结

调用栈是 ABI 对普通内存的一套纪律：<code>rsp</code> 指向边界，<code>call/ret</code> 管理返回路径，函数按约定保存状态。理解纪律比死记某个编译器生成的偏移更可靠。

---

[← 上一篇：计算机内存](./02-computer-memory.md) · [下一篇：啃一口数字 →](./04-nibbling-on-numbers.md)
