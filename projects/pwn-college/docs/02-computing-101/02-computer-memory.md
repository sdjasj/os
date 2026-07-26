# 02 · 计算机内存：地址、指针与解引用

> 对应官方模块：[Computer Memory](https://pwn.college/computing-101/memory/)

## 学习目标

- 区分地址、地址处的字节与高级语言中的指针类型。
- 从元素大小推导指针偏移，而不是把偏移一律理解为字节。
- 理解一级和多级解引用。
- 识别越界、悬空指针和未对齐访问的风险。

## 内存是一张按字节编号的表

把一个进程的虚拟内存想成很大的字节数组。每个字节都有编号，这个编号就是地址：

~~~text
地址       0x1000  0x1001  0x1002  0x1003
内容          34      12      00      00
~~~

“读取地址 0x1000”还不完整：读取几个字节？按什么顺序组合？解释为无符号整数、带符号整数还是字符？CPU 指令的宽度和程序类型共同回答这些问题。

指针是“被程序约定为地址的整数位模式”。C 的 <code>uint32_t *</code> 还携带目标类型信息，因此 <code>pointer + 1</code> 跨过的是一个 <code>uint32_t</code>，通常为 4 字节，而不是 1 字节。

## 三层概念必须分开

给定：

~~~c
uint32_t value = 900;
uint32_t *pointer = &value;
~~~

- <code>value</code> 是数值 900；
- <code>&value</code> 是对象所在地址；
- <code>pointer</code> 保存这个地址；
- <code>*pointer</code> 到该地址读取一个 <code>uint32_t</code>，结果是 900；
- <code>&pointer</code> 是“保存地址的变量”自身的地址。

若另有 <code>uint32_t **double_pointer = &pointer</code>，则 <code>**double_pointer</code> 才回到 900。

## 完整安全示例：观察偏移与二级指针

保存为 <code>memory_walk.c</code>：

~~~c
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

int main(void) {
    uint32_t numbers[] = {10, 20, 30, 40};
    uint32_t *cursor = numbers;
    uint32_t **holder = &cursor;

    printf("first=%u\n", *cursor);
    printf("third=%u\n", *(cursor + 2));
    printf("double=%u\n", **holder);
    printf("element_distance=%td\n", &numbers[3] - &numbers[0]);
    printf("byte_distance=%td\n",
           (unsigned char *)&numbers[3] -
           (unsigned char *)&numbers[0]);

    for (size_t index = 0; index < 4; ++index) {
        printf("numbers[%zu]=%u\n", index, cursor[index]);
    }
    return 0;
}
~~~

构建并运行：

~~~bash
gcc -std=c17 -Wall -Wextra -Wpedantic -O2 -o memory_walk memory_walk.c
./memory_walk
~~~

预期输出：

~~~text
first=10
third=30
double=10
element_distance=3
byte_distance=12
numbers[0]=10
numbers[1]=20
numbers[2]=30
numbers[3]=40
~~~

两个距离揭示了 C 指针运算的尺度。相同两地址按 <code>uint32_t *</code> 相减得到 3 个元素，转换为 <code>unsigned char *</code> 后相减得到 12 个字节。标准保证 <code>sizeof(unsigned char)==1</code>。

## 地址本身为什么不是权限

进程使用虚拟地址。页表把虚拟页映射到物理页，并附带可读、可写、可执行等权限。知道某地址不意味着能够读取它：

- 地址可能尚未映射；
- 页可能不可读；
- 地址可能属于另一个进程的独立地址空间；
- 对象生命周期可能已经结束。

因此“我有一个数值看起来像地址”与“我持有有效指针”不是一回事。

## 边界与对象生命周期

上例只访问 <code>numbers[0]</code> 到 <code>numbers[3]</code>。C 允许形成“尾后一位”指针 <code>&numbers[4]</code> 用于比较，但不能解引用。访问数组之外会产生未定义行为，程序可能崩溃，也可能暂时看似正常。

局部变量在其作用域和生命周期结束后失效；<code>free</code> 后的堆指针也不再指向可合法访问的对象。地址数值没有变化，并不能延长对象寿命。

## 常见误区

- **认为指针加一总是地址加一。** 实际增量是目标类型大小。
- **把打印出来的地址当固定答案。** ASLR、编译器和运行环境都会改变它。
- **觉得未崩溃就没有越界。** 未定义行为不承诺立即失败。
- **随意把任意字节指针强转成大类型再读取。** 可能违反对齐、边界或有效类型规则；解析二进制数据时优先使用 <code>memcpy</code>。
- **混淆 <code>pointer</code> 与 <code>*pointer</code>。** 前者是地址，后者是地址处的值。

## 纸面练习

一个 <code>uint16_t words[5]</code> 从字节地址 <code>0x2000</code> 开始。假设元素连续、每个 <code>uint16_t</code> 为 2 字节，<code>&words[3]</code> 的字节地址是多少？表达式 <code>&words[4] - &words[1]</code> 的结果是多少？

### 答案

第 3 个下标之前有 3 个元素，故地址是 <code>0x2000 + 3×2 = 0x2006</code>。两个同数组指针相减按元素计数，结果是 <code>4-1=3</code>，不是 6。

## 小结

内存推理始终回答四个问题：地址是什么、访问宽度多大、如何解释位模式、对象是否仍然有效。把这四项写清楚，复杂指针和后续栈帧就会变得可计算。

---

[← 上一篇：第一个程序](./01-your-first-program.md) · [下一篇：栈 →](./03-the-stack.md)
