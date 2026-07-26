# 逆向工程：从字节恢复程序语义

对应官方模块：Reverse Engineering  
官方页面：https://pwn.college/program-security/reverse-engineering/

## 1. 目标与边界

逆向工程不是把反汇编“逐行翻译回 C”。编译会删除变量名、合并表达式、内联函数并重排控制流；多个源码可以生成相同机器码。更准确的目标是建立一个**足以回答问题的行为模型**。

本章完成后，你应能：

- 从 ELF 元数据判断架构、入口、段和动态依赖；
- 用 System V AMD64 ABI 识别参数、返回值和栈帧；
- 从地址计算识别数组、结构体与跳转表；
- 在静态分析与动态验证之间来回迭代；
- 把“观察到的事实”和“尚待验证的假设”分开记录。

只分析自己编译的示例或明确获准研究的程序。

## 2. 三层视图

同一个程序至少有三种互补视图：

| 视图 | 主要问题 | 常见工具 |
|---|---|---|
| 文件视图 | 二进制里有哪些段、符号、重定位和依赖 | file、readelf、nm、objdump |
| 代码视图 | 指令如何读写数据、分支和调用 | objdump、Ghidra、IDA、Binary Ninja |
| 运行视图 | 某次输入下寄存器和内存实际是什么 | gdb、strace、ltrace |

静态分析覆盖所有可见路径，但难以确定运行值；动态分析给出真实状态，却只能观察已经执行的路径。可靠结论通常来自两者交叉验证。

## 3. 建立一个可逆向的样本

~~~c
// classifier.c
#include <stdio.h>
#include <stdlib.h>

struct rule {
    int threshold;
    const char *label;
};

static const struct rule rules[] = {
    {10, "small"},
    {100, "medium"},
    {1000, "large"}
};

static const char *classify(int value) {
    for (size_t i = 0; i < sizeof(rules) / sizeof(rules[0]); i++) {
        if (value < rules[i].threshold) {
            return rules[i].label;
        }
    }
    return "huge";
}

int main(int argc, char **argv) {
    if (argc != 2) {
        fprintf(stderr, "usage: %s NUMBER\n", argv[0]);
        return 2;
    }
    int value = (int)strtol(argv[1], NULL, 10);
    printf("%s\n", classify(value));
    return 0;
}
~~~

生成两个版本：

~~~bash
cc -Wall -Wextra -O0 -g classifier.c -o classifier-debug
cc -Wall -Wextra -O2 -s classifier.c -o classifier-stripped
./classifier-debug 42
# medium
~~~

第一个保留调试信息，适合建立“源码—机器码”对应关系；第二个去除符号并优化，更接近真实逆向场景。对照它们比一开始就啃复杂软件更有效。

## 4. 先读文件，不要先读指令

### 4.1 身份与架构

~~~bash
file classifier-stripped
readelf -h classifier-stripped
~~~

重点字段：

- Class：ELF32 还是 ELF64；
- Data：小端还是大端；
- Machine：指令集；
- Type：EXEC 或 PIE 常见的 DYN；
- Entry point：加载器最初跳转的位置，它通常不是 main。

### 4.2 段与节

程序头描述加载时映射，节头主要服务链接与分析。不要把二者混为一谈。

~~~bash
readelf -W -l classifier-stripped
readelf -W -S classifier-stripped
~~~

常见区域：

- .text：可执行代码；
- .rodata：字符串、常量表；
- .data：已初始化可写全局数据；
- .bss：零初始化数据；
- .got / .plt：动态链接相关入口。

### 4.3 导入与字符串

~~~bash
readelf -Ws classifier-debug | grep -E 'strtol|printf'
readelf -d classifier-stripped | grep NEEDED
strings -a -t x classifier-stripped | grep -E 'small|medium|large|huge'
~~~

字符串只是线索。一个字符串存在，不代表相应路径可达；一个敏感操作没有明显字符串，也不代表不存在。

## 5. 调用约定是逆向的语法

Linux x86-64 常见的 System V ABI 中，前六个整数或指针参数依次放在：

~~~text
RDI, RSI, RDX, RCX, R8, R9
~~~

返回值通常在 RAX。RSP 指向栈顶，RBP 有时作为帧指针，但优化后可能被当作普通寄存器。

看到下面的片段：

~~~asm
mov    $0xa,%edx
xor    %esi,%esi
mov    %rbx,%rdi
call   strtol@plt
~~~

可以提出假设：

- RDI 是字符串指针；
- RSI 为 0，可能是空的 endptr；
- RDX 为 10，可能是进制；
- 调用返回后 RAX 是解析结果。

再用函数原型 strtol(const char *, char **, int) 验证，假设就变成较强结论。

### 为什么写 EAX 会影响 RAX

在 x86-64 中，写 32 位寄存器会把对应 64 位寄存器高 32 位清零。例如写 EAX 后，RAX 高半部为零。写 AX 或 AL 则不会。这一规则经常解释看似缺失的清零指令。

## 6. 恢复函数和栈帧

未优化函数常见序言：

~~~asm
push   rbp
mov    rbp,rsp
sub    rsp,0x20
~~~

但它不是函数边界的充分条件。优化编译可能省略帧指针、使用尾调用，甚至把函数完全内联。更可靠的边界证据包括：

- 直接 call 的目标；
- 符号或异常展开信息；
- 多条控制流汇聚处；
- 对 RSP 的一致维护；
- ret、无条件跳转和尾调用。

绘制控制流图时，把基本块当作节点，把条件跳转、无条件跳转和 fall-through 当作边：

~~~text
          [参数检查]
           /      \
       失败        成功
       |            |
   [打印用法]   [解析数字]
       |            |
    [返回2]      [分类循环]
                     |
                  [打印]
                     |
                  [返回0]
~~~

先恢复块与边，再为变量命名，比从第一条指令顺着读到最后更稳。

## 7. 从地址计算恢复数据结构

x86-64 内存操作数常形如：

~~~text
base + index * scale + displacement
~~~

scale 常为 1、2、4 或 8。若观察到索引乘 16，可以通过左移或多条地址计算实现，常暗示结构体大小为 16。

示例结构体在 64 位平台上通常布局为：

~~~text
offset 0: int threshold      4 bytes
offset 4: padding            4 bytes
offset 8: char *label        8 bytes
total:                       16 bytes
~~~

如果循环每次把表指针增加 16，并分别读取 offset 0 和 offset 8，这与 struct rule 的假设吻合。要用多个访问点验证，而不是看到一次偏移就武断命名。

数组、结构体和指针链的常见迹象：

- 固定步长索引：数组；
- 同一基址的多个固定偏移：结构体；
- 先加载地址，再以新地址继续访问：指针或链表；
- 经过边界检查的间接跳转：switch 跳转表。

## 8. 动态验证：一次只验证一个假设

对调试版本：

~~~bash
gdb -q ./classifier-debug
~~~

建议会话：

~~~gdb
set disassembly-flavor intel
break classify
run 42
info args
info registers rdi rax rsp rbp
disassemble /m classify
x/6gx rules
next
finish
p $rax
~~~

预期：进入 classify 时第一个整数参数值为 42；函数返回时 RAX 是指向 "medium" 的地址。可以用下面的命令把地址解释为 C 字符串：

~~~gdb
x/s $rax
~~~

动态观察时必须记录输入。寄存器值属于“这一次执行”，不能自动推广到所有路径。

### 没有符号怎么办

可以从 main 的调用者链、导入函数和字符串交叉引用入手。Linux 启动代码通常把 main 地址交给 libc 启动例程；工具也常能自动识别。调试时可：

~~~gdb
starti
info files
info proc mappings
~~~

PIE 开启时，反汇编里的相对偏移与运行时绝对地址不同。应计算“模块基址 + 相对虚拟地址”，不要硬抄某次运行的绝对地址。

## 9. 系统调用与库函数

库函数调用经过 ABI 和动态链接；系统调用直接跨越用户态—内核态边界。在 x86-64 Linux 上，syscall 编号通常放 RAX，参数使用 RDI、RSI、RDX、R10、R8、R9。

用 strace 观察自己的样本：

~~~bash
strace -o trace.txt ./classifier-stripped 42
tail -n 8 trace.txt
~~~

你会看到 write、exit_group 等行为，但不一定看到 printf，因为 strace 观察系统调用，printf 是用户态库函数，最终可能缓冲并合并为 write。

## 10. 编译器优化会制造哪些错觉

- **内联**：源码函数不再有独立入口；
- **常量折叠**：计算在编译期完成；
- **循环展开或向量化**：一个源码循环变成多个块或 SIMD 指令；
- **尾调用**：call/ret 组合变成 jmp；
- **死代码删除**：不可达源码不进入二进制；
- **寄存器复用**：一个寄存器在不同时间代表不同变量。

因此反编译器给出的变量名、类型和伪 C 代码是推断，不是原始源码。最有价值的是交叉引用、控制流和数据流；漂亮的伪代码只是界面。

## 11. 一套可重复的工作流

1. 记录文件哈希，保证分析对象没有变化；
2. 用 file/readelf 确认架构、格式、PIE 和依赖；
3. 枚举导入、导出、字符串和关键节；
4. 以输入点、比较点、危险操作、输出点为锚点；
5. 画控制流图，给函数和变量起“假设性名字”；
6. 追踪外部输入的数据流；
7. 用断点验证一个最小假设；
8. 把新事实反馈到静态模型；
9. 分别记录可达性、可控性和影响。

笔记推荐使用三列：

| 地址/位置 | 已观察事实 | 推断与待验证项 |
|---|---|---|
| call 前 | RDX=10 | 可能是 strtol 的 base |
| 循环体 | 指针每轮 +16 | 元素大小可能为 16 |
| 返回前 | RAX 指向 rodata | 返回值可能是字符串 |

## 12. 常见误区

- **把反编译结果当源码**：类型和变量名可能错。
- **只看 strings**：会漏掉编码、动态构造或无字符串的行为。
- **只跑一个输入**：分支覆盖不足。
- **忽略 ABI**：参数含义和寄存器生命周期会被误读。
- **把十六进制地址当永久标识**：PIE、ASLR 和重新编译都会改变它。
- **先重命名再取证**：一个过早的好听名字会让后续证据都被强行解释。

## 13. 纸面推演

### 题目一

call 前 RDI 指向可打印字符串，RSI 为 0，RDX 为 16，目标为 strtoul@plt。最合理的解释是什么？

### 答案

程序大概率调用 strtoul(text, NULL, 16)，按十六进制解析字符串。仍应检查返回值的后续使用以及实际函数原型；仅凭三个寄存器不能证明输入验证正确。

### 题目二

一个循环用 [rbx + rax*8] 读取指针，RAX 从 0 增至 4。你能确定这是 5 个字符串吗？

### 答案

只能较强地判断它访问了 5 个八字节元素，元素看起来像指针。是否指向字符串要检查被指向区域及后续用法，例如是否传给 puts 或逐字节寻找零终止符。

## 14. 小结

逆向的可靠性来自证据链：文件元数据提供边界，ABI 提供语法，控制流和数据流提供结构，动态执行提供验证。最重要的习惯是明确标注“事实”和“推断”，并让每次调试只回答一个问题。

---

[上一章：程序安全基础](01-program-security.md) · [分区索引](README.md) · [下一章：返回导向编程](03-return-oriented-programming.md)
