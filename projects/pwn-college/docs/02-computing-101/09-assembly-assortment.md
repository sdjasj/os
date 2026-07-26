# 09 · 汇编练习集：位运算、移位与循环

> 对应官方模块：[Assembly Assortment](https://pwn.college/computing-101/assembly-assortment/)

## 学习目标

- 用 AND、OR、XOR 和 mask 选择性修改位。
- 区分逻辑移位与算术移位。
- 阅读按字节遍历字符串的汇编循环。
- 追踪每条指令对寄存器和 flags 的影响。

## 位运算不是“神奇技巧”

对每一位独立计算：

| A | B | A AND B | A OR B | A XOR B |
| --- | --- | --- | --- | --- |
| 0 | 0 | 0 | 0 | 0 |
| 0 | 1 | 0 | 1 | 1 |
| 1 | 0 | 0 | 1 | 1 |
| 1 | 1 | 1 | 1 | 0 |

mask 是一个“哪些位参与”的说明：

- <code>x & 0xff</code> 保留低 8 位；
- <code>x | 0x20</code> 把指定 bit 置 1；
- <code>x ^ 0x20</code> 翻转指定 bit；
- <code>x & ~0x20</code> 清除指定 bit。

对任意文本盲目用 ASCII bit 技巧并不安全，因为标点和 UTF-8 不服从英文字母的简单关系。应先验证字符范围。

## 移位的数值意义

无溢出时，左移 n 位相当于乘 <code>2ⁿ</code>。无符号逻辑右移相当于向下除 <code>2ⁿ</code>。对带符号值：

- <code>shr</code> 从高位补 0；
- <code>sar</code> 复制符号位。

它们对最高位为 1 的位模式给出不同结果。移位量、位宽和语言规则都必须明确。

## 完整示例：汇编遍历并计算大写字符和

下面由 C 提供标准输出，由汇编实现核心循环。保存为 <code>uppercase_sum.s</code>：

~~~asm
.intel_syntax noprefix
.global uppercase_sum
.text

# unsigned long uppercase_sum(const char *text)
uppercase_sum:
    xor eax, eax              # total = 0

.loop:
    movzx edx, byte ptr [rdi] # current = *text
    test dl, dl
    je .done                  # NUL terminates the string

    cmp dl, 'a'
    jb .add
    cmp dl, 'z'
    ja .add
    sub dl, 32                # ASCII lowercase -> uppercase

.add:
    add rax, rdx
    inc rdi
    jmp .loop

.done:
    ret

.section .note.GNU-stack,"",@progbits
~~~

保存驱动为 <code>uppercase_sum_demo.c</code>：

~~~c
#include <stdio.h>

extern unsigned long uppercase_sum(const char *text);

int main(void) {
    const char *text = "Az!";
    printf("text=%s\n", text);
    printf("uppercase_sum=%lu\n", uppercase_sum(text));
    return 0;
}
~~~

构建运行：

~~~bash
gcc -std=c17 -Wall -Wextra -O2 -no-pie -o uppercase_sum_demo uppercase_sum_demo.c uppercase_sum.s
./uppercase_sum_demo
~~~

预期输出：

~~~text
text=Az!
uppercase_sum=188
~~~

推导：A 为 65，z 在验证范围后变成 Z，即 90，感叹号为 33，总和 <code>65+90+33=188</code>。

<code>movzx</code> 把一个字节零扩展到 <code>edx</code>，防止高位残留；写 <code>edx</code> 会把 <code>rdx</code> 高 32 位清零。范围检查确保只对 <code>a..z</code> 减 32。<code>test dl,dl</code> 检查 NUL，<code>je</code> 读取 ZF。

## 如何手工追踪循环

为每轮画表：

| 轮次 | rdi 指向 | dl 读取 | 范围处理 | rax 新值 |
| --- | --- | --- | --- | --- |
| 1 | A | 65 | 不变 | 65 |
| 2 | z | 122 | 减 32 得 90 | 155 |
| 3 | ! | 33 | 不变 | 188 |
| 4 | NUL | 0 | 跳到 done | 188 |

不要只记录“源码变量”，还要记录分支前哪条指令最后更新了 flags。

## 常见误区

- **忘记清理寄存器高位。** 只写 <code>dl</code> 不会清除 <code>rdx</code> 的其余位。
- **把所有字符都减 32。** 会破坏数字、空格和标点。
- **在 <code>cmp</code> 与跳转之间插入改 flags 的算术指令。**
- **混淆 <code>shr</code> 和 <code>sar</code>。**
- **循环忘记推进指针。** 条件永远不变会形成死循环。
- **汇编调用 C 库时忽略 ABI 对齐。** 本例自身不再调用其他函数，避免该问题；下一章会专门推导。

## 纸面练习

初始 <code>rax=0x1234</code>。依次执行 <code>and rax, 0xff</code>、<code>xor rax, 0x20</code>、<code>shl rax, 1</code>，最终十六进制值是多少？

### 答案

AND 后保留低字节得 <code>0x34</code>；XOR <code>0x20</code> 得 <code>0x14</code>；左移一位得 <code>0x28</code>。

## 小结

位运算负责选择和改变位，比较与跳转负责选择路径，指针递增负责遍历。逐条记录输入、输出和 flags，复杂汇编也能拆成机械步骤。

---

[← 上一篇：端序历险](./08-endian-escapades.md) · [下一篇：再访栈 →](./10-the-stack-revisited.md)
