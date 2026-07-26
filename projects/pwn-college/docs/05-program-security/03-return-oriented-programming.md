# 返回导向编程：把既有代码当作积木

对应官方模块：Return Oriented Programming  
官方页面：https://pwn.college/program-security/return-oriented-programming/

一手规范：[System V AMD64 ABI 项目](https://gitlab.com/x86-psABIs/x86-64-ABI)（寄存器参数、栈对齐与调用边界）。ABI 会更新；精确分析应同时记录架构、编译器和二进制版本。

## 1. 为什么 NX 之后仍要讨论控制流

NX 让栈、堆等数据页不可执行，阻断“把输入字节当新代码运行”的直接路径。但进程地址空间里已经存在大量可执行指令：主程序、共享库、加载器。返回导向编程（Return-Oriented Programming，ROP）研究的是在控制流已被破坏的前提下，如何把这些既有指令片段按新顺序组合。

本章只在符号地址和自建程序上解释机制，不构造针对 pwn.college 或真实软件的利用输入。

学完后你应能：

- 从 ret 的机器语义推导 ROP 链为何放在栈上；
- 解释 gadget、调用约定、栈对齐和副作用；
- 区分 ret2win、ret2libc、栈迁移与完整 ROP；
- 判断 ASLR、PIE、金丝雀、CFI、CET 分别增加什么约束；
- 用“目标状态”规划链，而不是盲目搜索 gadget。

## 2. ret 到底做了什么

在 x86-64 上，可把 ret 简化为：

~~~text
RIP = *(uint64_t *)RSP
RSP = RSP + 8
~~~

也就是从栈顶取出下一条指令地址，并把栈顶向上移动八字节。若攻击者能影响保存的返回地址以及其后的栈内容，栈就可能变成一个“地址队列”。

一个最简单的符号链：

~~~text
RSP -> [gadget_A 地址]
       [gadget_A 消费的数据]
       [gadget_B 地址]
       [最终函数地址]
~~~

每个以 ret 结束的短指令序列称为 gadget。它执行少量状态变换，再从新的栈顶选择下一个 gadget。

## 3. 用普通函数观察调用与返回

~~~c
// calls.c
#include <stdio.h>

__attribute__((noinline))
static long add(long a, long b) {
    return a + b;
}

int main(void) {
    printf("%ld\n", add(20, 22));
    return 0;
}
~~~

~~~bash
cc -O0 -fno-omit-frame-pointer calls.c -o calls
objdump -d -M intel calls | sed -n '/<add>:/,/^$/p'
./calls
# 42
~~~

典型反汇编会含 leave 和 ret，或 pop rbp 后 ret。call 在转移到 add 前把返回地址压栈；ret 再把它取回。ROP 并没有创造一种新指令，它只是让本应成对出现的 call/ret 失去原来的配对关系。

## 4. Gadget 是带副作用的状态变换

设想找到以下片段：

~~~asm
pop rdi
ret
~~~

其语义是：

~~~text
RDI = *(uint64_t *)RSP
RSP = RSP + 8
RIP = *(uint64_t *)RSP
RSP = RSP + 8
~~~

因此符号栈布局为：

~~~text
[pop_rdi_ret]
[argument_1]
[target_function]
~~~

执行完第一个 gadget 后，RDI 被设为 argument_1，接着进入 target_function。System V AMD64 ABI 恰好用 RDI 传第一个整数或指针参数，所以这一 gadget 很常用。

真实 gadget 往往有额外指令：

~~~asm
pop rdi
pop rbp
ret
~~~

此时链中必须额外提供一个占位值给 RBP。忽略副作用会让后续所有栈槽错位。分析 gadget 时应记录：

| 项目 | 要问的问题 |
|---|---|
| 栈消耗 | 除下一地址外还弹出多少字节 |
| 寄存器写入 | 哪些目标值被建立，哪些已有值被破坏 |
| 内存访问 | 地址是否有效、读写是否有副作用 |
| 标志位 | 后续条件指令是否依赖 |
| 结束方式 | ret、jmp reg、call reg 或 syscall |

## 5. 从目标倒推链

不要从“有哪些 gadget”开始堆积。先写目标状态。例如要按 ABI 调用一个三参数函数：

~~~text
RDI = arg1
RSI = arg2
RDX = arg3
RIP = function
RSP 满足 ABI 对齐
~~~

再为每个缺失状态寻找最小变换，并检查变换间的冲突：

~~~text
初始可控栈
 -> 设置 RDI
 -> 设置 RSI
 -> 设置 RDX
 -> 调整对齐
 -> 进入 function
 -> 决定 function 返回到哪里
~~~

这种做法类似寄存器分配和约束求解。若设置 RDX 的 gadget 同时破坏 RSI，就要调整顺序或选择另一片段。

## 6. 栈对齐为何会让“看似正确”的链崩溃

System V AMD64 ABI 对调用边界有栈对齐要求。部分 libc 函数会使用要求 16 字节对齐的 SIMD 指令。正常 call 会额外压入八字节返回地址，而直接 ret 进入函数改变了这一节奏。

症状通常是：

- 参数看起来都正确；
- 控制流确实进入目标函数；
- 却在函数内部的对齐敏感指令崩溃。

诊断方法：

~~~gdb
break target_function
commands
silent
p/x $rsp
p (long)$rsp % 16
continue
end
~~~

修复思路是重新核算每个 pop/ret 的栈消耗；有时插入一个仅含 ret 的片段可改变八字节相位。关键是从 ABI 推导，而不是把“多加一个 ret”当魔法口诀。

## 7. 几类代码复用

### 7.1 ret2win

自建教学程序可能包含一个正常流程不调用的 benign 函数。若只需把返回地址改到该函数，这是最小的控制流重定向，不需要复杂 gadget。它证明 RIP 可控，但未必代表通用计算能力。

### 7.2 ret2libc

复用共享库中的完整函数，而不是短 gadget。这样不需要在数据页执行代码，但通常需要知道库地址并满足函数参数约定。

### 7.3 完整 ROP

用多个 gadget 建立寄存器、读写内存或触发系统调用。链的可靠性取决于可用字节、已知地址、栈空间、调用约定和进程权限。

### 7.4 栈迁移

初始可控区域太小时，可能需要把 RSP 改到更大的已知可写区域。leave; ret 的效果取决于 RBP：

~~~text
leave 等价于：
RSP = RBP
RBP = pop()
随后 ret 再从新栈取 RIP
~~~

栈迁移本质是改变“链解释器”的输入位置。

## 8. 信息泄漏为何经常是第一阶段

PIE 和 ASLR 使代码或库基址变化。ROP 地址必须指向精确指令边界，因此通常需要：

1. 泄漏某个属于目标模块的运行时指针；
2. 减去该符号在模块内的静态偏移，得到基址；
3. 加上所需函数或 gadget 的静态偏移。

符号公式：

~~~text
module_base = leaked_symbol_address - symbol_offset
gadget_runtime = module_base + gadget_offset
~~~

这里最重要的不变量是：同一映像内部的相对偏移在同一版本中固定，而装载基址随机。若本地库版本与目标不同，偏移也会不同，所以“复制一个地址”没有可迁移性。

## 9. 如何在自己的程序里枚举片段

教学上可先用 objdump，不必依赖自动工具：

~~~bash
objdump -d -M intel ./calls | less
objdump -d ./calls | grep -B2 -A1 'ret'
~~~

自动 gadget 工具会从每个可能字节偏移反向解码，因此可能找到编译器从未打算作为指令入口的位置。x86 指令长度可变，跳入一条指令中间可能产生另一串合法指令。这也意味着：

- 工具输出需要人工确认；
- gadget 地址必须在可执行映射内；
- 某些控制流完整性技术会限制非正常入口；
- 重编译就可能改变整个 gadget 集。

## 10. 缓解机制怎样改变问题

| 缓解 | 增加的主要约束 | 不直接解决的事情 |
|---|---|---|
| NX | 不能直接执行常见数据页 | 既有代码复用 |
| 栈金丝雀 | 覆盖返回地址前常需保持秘密值 | 非栈写、泄漏、逻辑错误 |
| PIE/ASLR | 运行时地址未知 | 已知相对偏移、地址泄漏 |
| Full RELRO | GOT 等重定位数据只读 | 其他可写数据和返回地址 |
| CFI | 间接转移目标受集合约束 | 数据流攻击，具体覆盖依实现 |
| CET shadow stack | 普通栈返回地址与影子栈核对 | 非返回型复用，数据破坏 |
| IBT | 间接跳转需进入合法标记点 | 所有逻辑或内存错误 |

缓解是叠加的。安全工程仍应修复导致控制数据可被覆盖的根因。

## 11. 纸面执行一个符号链

假设：

~~~text
G1 = pop rdi; ret
G2 = pop rsi; pop r15; ret
F  = audit_event
~~~

初始栈：

~~~text
RSP -> G1
       0x11
       G2
       0x22
       0xdeadbeef
       F
       CLEAN_EXIT
~~~

逐步推演：

1. 首次 ret 进入 G1；
2. G1 令 RDI=0x11，再 ret 进入 G2；
3. G2 令 RSI=0x22，令 R15=0xdeadbeef，再 ret 进入 F；
4. F 看见前两个参数 0x11 与 0x22；
5. F 正常 ret 时进入 CLEAN_EXIT。

占位值 0xdeadbeef 不参与目标调用，但必须存在以吸收 G2 的副作用。

## 12. 常见失败模式

- **链整体错八字节**：忘了某 gadget 多 pop 了寄存器。
- **进入函数后崩溃**：栈未对齐，或函数返回地址无效。
- **本地成功、换环境失败**：库版本或模块基址不同。
- **地址字节无法输入**：输入协议会截断零字节、换行或编码。
- **泄漏公式错误**：泄漏的是对象地址而非预期符号地址。
- **只考虑 RIP**：控制流到了目标，参数、栈和权限却不成立。

## 13. 练习与答案

### 题目一

gadget 为 pop rax; pop rbx; ret。从进入 gadget 到进入下一 gadget，RSP 总共前进多少字节？

### 答案

三个八字节槽，共 24 字节：两个 pop 各消费 8 字节，ret 再消费一个地址槽。

### 题目二

已知某次运行泄漏 puts 地址 L，符号表中 puts 偏移为 P，目标函数偏移为 T。写出目标运行时地址。

### 答案

基址为 L - P，目标地址为 L - P + T。运算前还要确认 L 确实属于同一份共享库映像。

### 题目三

为什么一个“控制 RIP”的崩溃仍可能无法形成稳定 ROP？

### 答案

可能没有足够的后续可控栈、地址受 ASLR 影响、输入字符受限、金丝雀先终止程序、gadget 副作用无法满足约束、ABI 对齐错误，或进程本身没有目标资源权限。控制 RIP 只是一个原语。

## 14. 小结

ROP 可以看成一个由 ret 驱动的小型状态机：栈提供指令片段地址和立即数据，gadget 负责转换寄存器与内存状态。严谨分析应先写目标状态，再求解 gadget 序列，并逐槽核算 RSP、ABI 和副作用。

---

[上一章：逆向工程](02-reverse-engineering.md) · [分区索引](README.md) · [下一章：动态分配器误用](04-dynamic-allocator-misuse.md)
