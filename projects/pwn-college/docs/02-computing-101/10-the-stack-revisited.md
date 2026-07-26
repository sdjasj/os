# 10 · 再访栈：栈帧、调用约定与对齐

> 对应官方模块：[The Stack, Revisited](https://pwn.college/computing-101/the-stack-revisited/)

## 学习目标

- 按 System V AMD64 ABI 推导函数参数和返回值。
- 解释函数序言、栈帧和尾声的作用。
- 正确保存 callee-saved 寄存器。
- 理解 16 字节对齐、环境变量和调试器为何会影响栈地址。

## ABI 是二进制模块之间的合同

C 调用者和汇编被调用者可以分别编译，是因为双方同意：

- 整数/指针参数依次放入 <code>rdi</code>、<code>rsi</code>、<code>rdx</code>、<code>rcx</code>、<code>r8</code>、<code>r9</code>；
- 返回整数放在 <code>rax</code>；
- <code>rbx</code>、<code>rbp</code>、<code>r12</code>～<code>r15</code> 等由被调用者保持；
- 在普通函数调用边界遵守栈对齐；
- <code>call</code> 压入返回地址，<code>ret</code> 取回。

合同不规定源码变量名，也不要求每个函数都建立 <code>rbp</code> 帧。

## 典型栈帧

~~~asm
push rbp
mov rbp, rsp
sub rsp, 32
    ... function body ...
leave
ret
~~~

<code>push rbp</code> 保存调用者帧指针，<code>mov</code> 建立稳定基准，<code>sub</code> 预留局部空间。<code>leave</code> 等价于恢复 <code>rsp</code> 并弹出旧 <code>rbp</code>。优化构建可能完全省略这一形状。

## 完整示例：C 调用手写汇编函数

保存为 <code>weighted_sum.s</code>：

~~~asm
.intel_syntax noprefix
.global weighted_sum
.text

# long weighted_sum(long a, long b, long c)
# 计算 (a + b) * c，并用栈槽保存中间值。
weighted_sum:
    push rbp
    mov rbp, rsp
    sub rsp, 16

    mov qword ptr [rbp - 8], rdi
    add qword ptr [rbp - 8], rsi
    mov rax, qword ptr [rbp - 8]
    imul rax, rdx

    leave
    ret

.section .note.GNU-stack,"",@progbits
~~~

保存 <code>weighted_sum_demo.c</code>：

~~~c
#include <stdio.h>

extern long weighted_sum(long a, long b, long c);

int main(void) {
    printf("weighted_sum=%ld\n", weighted_sum(4, 5, 3));
    return 0;
}
~~~

构建并运行：

~~~bash
gcc -std=c17 -Wall -Wextra -O2 -no-pie -o weighted_sum_demo weighted_sum_demo.c weighted_sum.s
./weighted_sum_demo
~~~

预期输出：

~~~text
weighted_sum=27
~~~

三个参数分别来自 <code>rdi=4</code>、<code>rsi=5</code>、<code>rdx=3</code>。中间和存到 <code>[rbp-8]</code>，结果放到 <code>rax</code>。函数没有修改需要额外保存的 callee-saved 通用寄存器。

## 16 字节对齐如何推导

System V AMD64 要求调用者在执行 <code>call</code> 前使栈满足调用约定。<code>call</code> 又压入 8 字节返回地址，所以被调用函数刚进入时，<code>rsp</code> 相对 16 字节边界偏 8。执行一次 <code>push rbp</code> 后重新对齐；再减 16 仍保持对齐。

本例函数不调用别的函数，但仍采用常规对齐布局。若要从汇编中调用可能使用 SIMD 的库函数，错误对齐可能导致崩溃或 ABI 违规。

## 陈旧栈数据与对象寿命

函数返回时通常只移动 <code>rsp</code>，不会把旧字节全部清零。因此后来复用同一区域时可能看到“陈旧数据”。这不表示旧局部变量仍然活着；读取超出当前对象范围依然无效。安全代码应初始化数据，秘密材料还要使用不会被优化器删除的专用清理 API。

## argv、环境变量与地址变化

进程初始栈包含 argv、环境变量和辅助向量。增加一个环境变量会改变初始布局，随后地址也可能变化；GDB 启动程序时的环境与直接运行也可能不同。再叠加 ASLR，绝不能把一次观察到的绝对栈地址写死。

可靠推理关注相对关系、符号和运行时泄露，而不是假定固定地址。本教程只讨论布局，不提供利用 payload。

## 常见误区

- **修改 <code>rbx</code> 后不恢复。** 会破坏调用者依赖的 callee-saved 值。
- **认为 <code>push rbp</code> 是每个函数强制指令。** 它是常见策略，不是唯一合法形式。
- **忽略调用前栈对齐。**
- **认为释放栈槽会自动擦除字节。**
- **在 GDB 中看到固定地址就硬编码。** 环境和 ASLR 会改变它。
- **用 <code>pop</code> 恢复与压栈顺序不对称。** 会让 <code>ret</code> 取错位置。

## 纸面练习

函数刚进入时 <code>rsp mod 16 = 8</code>。执行 <code>push rbp</code>、<code>sub rsp, 24</code> 后，<code>rsp mod 16</code> 是多少？此时若直接 <code>call</code> 另一个函数，是否满足通常要求的调用前 16 字节对齐？

### 答案

push 减 8，使余数变为 0；再减 24，相当于减去 8 模 16，余数变为 8。因此调用前未对齐。可把局部空间调整为 16 或 32 等合适大小，结合已保存寄存器重新计算。

## 小结

栈帧不是固定模板，而是 ABI 合同的一种实现。每次都从入口余数、保存项和局部空间重新计算，才能同时保证正确返回、寄存器保持和调用对齐。

---

[← 上一篇：汇编练习集](./09-assembly-assortment.md) · [下一篇：字符串形式的数字 →](./11-numbers-as-strings.md)
