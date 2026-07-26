# 07 · 控制流：比较、跳转、循环与函数

> 对应官方模块：[Control Flow](https://pwn.college/computing-101/control-flow/)

## 学习目标

- 从 <code>if</code> 和循环推导 compare、flags 与条件跳转。
- 区分有符号和无符号比较。
- 理解 <code>call</code>、<code>ret</code> 与函数指针。
- 说明 caller-saved 和 callee-saved 寄存器为何存在。

## CPU 不执行“if”，只改变下一条指令地址

正常执行时，指令指针 <code>rip</code> 前进到下一条指令。跳转把它改为别处。常见结构：

~~~asm
cmp rdi, rsi
jge greater_or_equal
~~~

<code>cmp</code> 内部做减法但不保存结果，只更新 ZF、SF、CF、OF 等标志位；<code>jge</code> 根据有符号比较规则读取标志。无符号的“大于等于”通常使用 <code>jae</code>。相同位模式若解释不同，就必须选不同跳转。

## 从条件到循环

高级结构：

~~~c
for (size_t i = 0; i < length; ++i) {
    total += values[i];
}
~~~

可推导为：

~~~text
i = 0
loop:
    比较 i 与 length
    若 i >= length，跳到 done
    加 values[i]
    i = i + 1
    无条件跳到 loop
done:
~~~

循环并非特殊机器机制，只是后向跳转与退出条件。

## 完整示例：分类并累加

保存为 <code>control_flow.c</code>：

~~~c
#include <stddef.h>
#include <stdio.h>

static const char *classify(long value) {
    if (value < 0) {
        return "negative";
    }
    if (value == 0) {
        return "zero";
    }
    return "positive";
}

static long sum_positive(const long *values, size_t length) {
    long total = 0;
    for (size_t index = 0; index < length; ++index) {
        if (values[index] > 0) {
            total += values[index];
        }
    }
    return total;
}

int main(void) {
    const long values[] = {-4, 0, 7, 3, -1};
    const size_t length = sizeof values / sizeof values[0];

    for (size_t index = 0; index < length; ++index) {
        printf("%ld:%s\n", values[index], classify(values[index]));
    }
    printf("sum_positive=%ld\n", sum_positive(values, length));
    return 0;
}
~~~

构建与运行：

~~~bash
gcc -std=c17 -Wall -Wextra -O1 -o control_flow control_flow.c
./control_flow
objdump -d -M intel --disassemble=sum_positive control_flow
~~~

预期程序输出：

~~~text
-4:negative
0:zero
7:positive
3:positive
-1:negative
sum_positive=10
~~~

反汇编形状受编译器和优化影响。优化器可能使用条件移动、向量指令或重新组织循环，因此不要期待源码一行对应固定指令序列。

## 函数调用与寄存器保存

System V AMD64 ABI 中，前六个整数/指针参数通常使用 <code>rdi</code>、<code>rsi</code>、<code>rdx</code>、<code>rcx</code>、<code>r8</code>、<code>r9</code>，返回值使用 <code>rax</code>。

寄存器分工解决嵌套调用：

- caller-saved：调用者若还需要原值，应在调用前保存；
- callee-saved：被调用函数若要修改，必须先保存并在返回前恢复。

例如 <code>rbx</code> 是常见 callee-saved 寄存器，<code>rax</code>、<code>rcx</code>、<code>rdx</code> 常由调用者承担保存责任。ABI 让分别编译的函数仍能合作。

## 函数指针是受约束的间接控制流

函数指针保存可调用代码地址。合法用途包括回调和策略表，但输入不应直接成为未经验证的代码地址。安全设计通常从固定表中选择：

~~~c
typedef long (*operation)(long, long);
~~~

调用 <code>chosen(2, 3)</code> 在机器层可能成为间接 <code>call</code>。控制流完整性保护和只读函数表都在约束这种间接目标。

## 常见误区

- **有符号/无符号比较混用。** <code>-1</code> 按无符号解释会成为很大的正数。
- **在跳转前插入会改 flags 的指令。** 条件跳转读取最近相关标志状态。
- **默认编译器一定生成某种跳转。** 优化器可改用 branchless 形式。
- **函数修改了 caller-saved 寄存器就认为违反 ABI。** 调用者本就不能假设它们保持不变。
- **把函数指针当普通数据而不验证来源。** 它会影响执行位置。

## 纸面练习

8 位位模式 <code>0xFF</code> 与 <code>0x01</code> 比较。有符号和无符号解释下，哪一个更大？为什么同一次 <code>cmp</code> 后需要不同条件跳转？

### 答案

有符号 8 位下 <code>0xFF=-1</code>，所以 <code>0x01</code> 更大；无符号下 <code>0xFF=255</code>，所以 <code>0xFF</code> 更大。<code>cmp</code> 产生多种标志，有符号跳转主要组合 SF/OF/ZF，无符号跳转主要看 CF/ZF；解释规则不同，读取的标志条件也不同。

## 小结

控制流可还原为“计算条件—更新标志—选择下一地址”。循环是回跳，函数是遵守 ABI 的跳转，函数指针是间接跳转。先识别比较解释，再追踪目标，就能系统阅读控制流。

---

[← 上一篇：输出与输入](./06-output-and-input.md) · [下一篇：端序历险 →](./08-endian-escapades.md)
