# 第 9 讲：C 标准库和实现（1）——从机器边界到应用生态的第一层抽象

> 原始讲义：[sources/notes/lect09.md](../../sources/notes/lect09.md)  
> 前置内容：进程、地址空间、文件描述符、终端与 UNIX Shell  
> 本讲关键词：ISO C、POSIX、libc、API、ABI、系统调用、musl、freestanding、inline assembly、`stdarg`、`setjmp`/`longjmp`、`FILE *`、`errno`、环境变量、CRT、`_start`
> 前一讲：[终端和 UNIX Shell](08-terminal-shell.md) · 后一讲：[C 标准库和实现（2）](10-libc-2.md)

## 0. 本讲定位：Shell 会组合程序，谁来支撑这些程序

上一讲把 UNIX Shell 看成一门极简的编程语言。重定向、管道和命令执行最终被翻译为 `open`、`dup2`、`pipe`、`fork`、`execve`、`waitpid` 等动作。这个解释还留着一个空白：写 Shell 以及被 Shell 启动的万千程序时，我们为什么通常可以写 `printf`、`fopen`、`qsort` 和 `exit`，而不用在每种处理器上手工摆放系统调用参数？

答案是 libc。它站在语言、二进制接口和操作系统之间，形成应用生态的“第一级抽象”：

```text
Python / Java / 浏览器 / C++ runtime / 普通 C 程序
                         ↓ 调用稳定的源代码接口
                 C library / POSIX library
            ┌────────────┼───────────────┐
            │            │               │
       纯用户态计算   ABI/ISA 机关     系统调用封装
       strlen/qsort   stdarg/setjmp    open/write/exec
            │            │               ↓
            └────── 机器指令 ───────→ Linux 内核
```

“libc 是系统调用的封装”只说中了右边一列。`strlen()` 通常不需要内核；`setjmp()` 主要保存 ABI 规定的寄存器；`printf()` 在用户态解析格式、维护缓冲，最后才可能调用一次 `write`；程序甚至在进入 `main()` 前就已经执行了 libc 的启动代码。

这也是课程主线从“操作系统给了什么机制”转向“应用如何累积抽象”的位置：

```text
进程与地址空间
  → 文件描述符、终端、Shell
  →【本讲：libc 的接口、三类封装与启动边界】
  → 下一讲：带调试信息深入 musl，并进入 malloc/free
  → 链接加载、应用生态、并发与存储
```

本讲先画完整地图，并用小实验跨过边界。下一讲会真正编译一份可调试的 musl，逐指令跟进 `printf`、变参数和运行时，再把“向内核要大块内存”发展为分配器。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 解释 M2 的 Makefile 如何把本地目标、模块名和课程框架组合起来，并理解 Online Judge 不能替代本地测试；
- 从“寄存器和内存可直接操作，其他能力经系统调用获得”重新描述进程；
- 严格区分 C API、平台 ABI、libc 实现和内核系统调用接口；
- 解释 C 如何借助链接和 inline assembly 越过语言边界，以及 inline asm 的约束为何难写对；
- 说明 ISO C 标准化为何能支撑复用，同时指出 POSIX 与 ISO C 的关系；
- 按“纯计算/ABI 机关/系统调用/运行环境”给常见 libc 功能分类；
- 说明 hosted 与 freestanding 环境的差别，并构造一个没有 libc、直接系统调用的 x86-64 程序；
- 解释 `stddef.h`、`stdint.h`、`inttypes.h`、`limits.h`、`float.h` 与 `stdarg.h` 各自在封装什么；
- 解释 `memcpy`/`memmove`、`atoi`/`strtol`、`qsort` 与 NaN 例子背后的契约，而不把“容易写出”误认为“容易实现正确”；
- 用保存“续延所需机器状态”的模型解释 `setjmp`/`longjmp`，并列出它不能自动完成的清理；
- 从 `FILE *` 的缓冲状态追到文件描述符与 `write`，理解 `vfprintf` 如何避免格式化代码复制；
- 区分 `abort`、`exit`、`_Exit`/`_exit`、`atexit`、`system` 和 `popen` 的语义与边界；
- 正确使用返回值、`errno`、`perror`/`strerror`，知道 `err` 与 `error` 并非同一可移植标准；
- 从 System V 初始进程栈推导 `argc`、`argv`、`envp`、`environ` 和 `_start → main` 的控制流；
- 用 GDB、`readelf`、`nm`、`objdump` 和 `strace` 为“一个小程序到底做了什么”建立证据链。

问题地图如下：

| 表面问题 | 真正跨越的边界 | 最小答案 |
| --- | --- | --- |
| `strlen` 是否调用内核？ | C API → 本机指令 | 通常不调用；它是纯用户态计算，也可能被编译器内建化 |
| `open()` 是否必然执行名为 `open` 的系统调用？ | POSIX API → Linux syscall ABI | 不必然；libc 可用 `openat` 等内核入口兑现同一 API |
| `printf` 为何不立刻出现在文件里？ | 格式化/`FILE` 缓冲 → fd → `write` | 数据可能仍在 libc 用户态缓冲区 |
| `setjmp` 为什么能“返回两次”？ | C 控制流 → 调用约定 | 首次保存恢复点，`longjmp` 恢复栈指针、返回地址和必要寄存器 |
| `main` 是内核调用的吗？ | ELF/ABI → CRT → C API | 不是；内核跳到 ELF 入口 `_start`，CRT 初始化后再调用 `main` |
| `errno` 是内核里的全局变量吗？ | syscall 错误约定 → libc 线程状态 | 不是；内核返回错误，libc 包装通常把它转换为线程局部 `errno` |
| ISO C 程序为何更可移植？ | 标准契约 → 多种实现 | 源代码只依赖标准规定且没有未定义行为时，实现可在不同平台兑现语义 |

## 2. Review & Comments：M2 与进程模型

### 2.1 M2 发布、3 月 30 日更新与 Online Judge

讲义首先提醒 M2 曾在 3 月 30 日更新，并让大家观察 Makefile：

```make
NAME := $(shell basename $(PWD))
export MODULE := M2
all: $(NAME)

include ../oslab.mk
include ../.shadow/oslab.mk
```

这几行已经是“组合、复用、分层”的一个小例子：

- `:=` 是立即展开赋值；读取 Makefile 时便执行 `basename $(PWD)`，把当前目录名记为 `NAME`；
- `export MODULE := M2` 不只定义 Make 变量，还让 Make 启动的子进程或递归 Make 看见模块名；
- `all: $(NAME)` 把默认构建目标依赖到与目录同名的目标上；
- 两条 `include` 把公共构建规则和课程框架规则拼进当前 Makefile，本目录无需复制整套规则。

因此遇到框架更新时，不能只看自己的 `.c` 文件。先用 `git diff`、`make -n` 和 `make -pn` 观察规则究竟来自哪里，再确认更新后的公共 Makefile、隐藏框架与本地代码是否匹配。不要随意修改隐藏框架来“骗过”测试；这只会让本地行为偏离提交环境。

Online Judge 本周开放，但讲义特别指出：完全可以先在本地生成和编写 test cases。OJ 给出的只是有限样例上的反馈，不能证明程序对所有输入都正确；本地测试更适合快速构造边界情况、保存回归用例并配合 GDB/trace 定位状态变化。这个方法也延续了上一讲 Shell 的思想：把小工具与测试数据组合起来，而不是把远端评测当作唯一调试器。

### 2.2 再看操作系统上的进程

对一个汇编、C、Python 或其他语言程序，处理器直接执行的仍然只有指令。用户态指令可以在权限允许的地址空间里读写寄存器和内存；要改变受内核保护的全局状态，就必须经由内核提供的入口：

| 能力 | 用户态所见的常用 API | 典型内核机制 |
| --- | --- | --- |
| 进程管理 | `fork`、`execve`、`exit`/`_exit` | 复制状态、替换地址空间、终止任务 |
| 地址空间 | `mmap`、`munmap`、`mprotect` | 建立/撤销映射、修改页权限 |
| 访问对象 | `open`、`read`、`write`、`lseek` | 查找对象、经 fd 操作对象 |

这里的 API 名称不一定与内核系统调用一一对应。例如：

- C 的 `exit()` 要先运行用户态清理，最后才请求内核终止；
- Linux 上 libc 的 `open()` 可以内部调用 `openat`；
- `printf()` 可能只写入用户态缓冲，这一次调用根本没有陷入内核；
- 编译器看见 `strlen("abc")`，甚至可能在编译期直接得出 `3`。

所以更精确的模型是：**应用只直接拥有计算状态；libc 用普通指令、ABI 技巧和系统调用的不同组合，兑现更高层接口。**

### 2.3 仅靠这些机制，为什么足以形成应用生态

UNIX 为应用提供少量可组合的对象和命名方法。`/proc/[pid]/maps` 把内核中的地址空间信息伪装成文本文件；伪终端、管道和 procfs 又分别由 `pts(4)`、`pipe(7)`、`proc(5)` 描述。可以自己执行：

```bash
man -P cat 4 pts | less
man -P cat 5 proc | less
man -P cat 7 pipe | less
```

`-P cat` 让 `man` 不启动自己的 pager，把文档作为普通文本流输出；于是后面可以接搜索、摘要或其他程序。上一讲的 Shell 提供组合语言，本讲的 libc 则让每一个组合部件不必重复处理体系结构和系统调用细节。

应用生态由此逐层建立：C 运行库支撑 C/C++ 和许多语言解释器；C++ 运行时又成为 JVM、Node.js 或浏览器组件的一部分。箭头表达的是“实现常常复用下层”，不是说所有 Java 或 Python 语义都由 libc 定义。

## 3. The C Programming Language：不只是 SimpleC

### 3.1 SimpleC 已经覆盖了什么

前面课程中的 SimpleC 把指针、数组、结构体与函数调用还原为寄存器和内存操作：

```text
读取 p->x     → 计算地址 + load
写入 a[i]     → 计算地址 + store
调用 f(x)     → 按约定放参数、保存返回点、跳转
函数返回      → 恢复必要状态、跳回调用者
```

这是理解 C 的重要底座，却不是现实中 C 工具链的“完全体”。真正的 C 程序还要与其他翻译单元、汇编代码、操作系统和运行库相连。

### 3.2 FFI：链接能跨过源语言边界

如果一段汇编导出符号 `foo`，C 文件可以声明 `extern int foo(int);` 并在链接后调用它。链接器只匹配符号和重定位，不理解两边的高级语言类型；“参数放哪里、哪些寄存器由谁保存、返回值怎样表示”由 ABI 保证。

因此有三份不同层次的契约：

| 层次 | 例子 | 违约后果 |
| --- | --- | --- |
| API | `int foo(int)` 的参数、返回值和功能 | 源代码误用、逻辑错误或未定义行为 |
| ABI | x86-64 SysV 用 `%edi` 传首个 `int`，用 `%eax` 返回 | 两个目标文件无法正确协作 |
| ISA | `call`、`ret`、`syscall` 等指令的硬件语义 | CPU 执行另一种状态迁移或产生异常 |

这就是 C 的 Foreign Function Interface 基础。许多语言之所以把 C ABI 当作“公共插座”，不是因为 C 类型足够表达所有语言对象，而是因为平台已经长期稳定地约定了这种二进制接口。

### 3.3 Inline Assembly Demystified

GCC/Clang 的 extended asm 是嵌在 C 语法中的小型 DSL：

```c
__asm__ ("instructions"
         : outputs
         : inputs
         : clobbers
         : goto_labels);
```

讲义中的例子用 `lea` 计算 `a * 5`：

```c
int a = 7, b = 5, result;
__asm__("leal (%1,%1,4), %0"
        : "=r"(result)
        : "r"(a));
printf("%d * %d = %d\n", a, b, result);
```

它恰好打印 `7 * 5 = 35`，但汇编根本没有把 `b` 声明为输入；若把 `b` 改成 6，结果仍是 35。这正好说明 inline asm 为什么难写：编译器只相信约束，不会从汇编字符串猜出你读写了哪些 C 值。

一个真正把两边都作为输入的乘法示例可以写成：

```c
int result = a;
__asm__("imull %[rhs], %[dst]"
        : [dst] "+r"(result)
        : [rhs] "r"(b)
        : "cc");
```

- `+r` 表示 `result` 既是输入又是输出；
- `r` 允许编译器选择通用寄存器；
- `cc` 告诉编译器条件码被修改；
- 若汇编读取或写入约束中没有显式列出的内存，通常还需准确的内存操作数或保守的 `"memory"` clobber；
- 若汇编的存在本身有副作用，可能需要 `volatile`，但 `volatile` 不能补救错误约束。

实际工程里，能让编译器生成的普通算术就应写成 `result = a * b`。inline asm 适合系统调用入口、特殊寄存器、原子/设备指令等 C 无法直接表达的边界。它是编译器扩展，不是可移植 ISO C；指令、寄存器名、约束和 clobber 都依赖架构与编译器。

讲义用“一个设计得很糟的嵌入式 DSL”和课堂研究轶事强调的不是要背语法，而是：**一旦跨过抽象层，正确性责任就回到程序员；机器接口的小遗漏足以让优化器产生完全合法、却不符合作者意图的代码。** AI 可以帮助生成初稿，约束和反汇编仍必须由证据验证。

## 4. 构建应用生态：组合、复用、分层

### 4.1 在抽象层上累积抽象层

讲义用一条带有调侃意味的历史线索描述编程界面：

- 1950 年代，程序主要直接写汇编；
- 1960 年代高级语言已开始普及，1970 年代再只用汇编写大型应用逐渐像“行为艺术”；
- C、Pascal、结构化程序设计和 UNIX 让控制流与模块复用成为常态；
- 到 2010 年代，用 C 手工管理大量应用逻辑常被戏称为“古法编程”，Python、Java、JavaScript 等已在更高层工作；
- 讲义把 2026 年“自然语言也是编程语言”作为新一轮界面上移：人描述意图，工具生成较低层实现。

历史表达可以夸张，但机制没有改变：每一层都要把上层的较稳定语义翻译为下层可执行状态机。自然语言生成代码并不会取消 ISO C、ABI 或系统调用契约；相反，生成物越多，越需要测试、反汇编、trace 和标准文档来验收边界。

### 4.2 标准化的力量与适用边界

ISO C 规定语言和标准库的源代码级契约。例如符合条件的实现都要给出 `memcpy`、`qsort`、`FILE`、整数范围等规定语义。它带来长期稳定和很强的源代码可移植性，但“写的是 C”本身不保证可移植：

- 依赖未定义行为的程序没有标准承诺；
- `int` 宽度、字节序、对齐、浮点特性等实现相关，必须查询相应宏；
- inline asm、对象文件格式和调用约定属于平台扩展/ABI；
- ISO C 承诺的是接口语义，不承诺不同系统上的 libc 二进制 ABI 相同。

POSIX 则在 C 语言接口上规定操作系统能力，例如 `fork`、`open`、`read` 和 `<unistd.h>`。需要特别澄清：**`<unistd.h>` 不是 ISO C 标准库的一部分；POSIX 是在 ISO C 基础上增加的一组接口约定。** Linux 程序还可能继续依赖 `epoll`、`procfs` 等 Linux 专有能力。

可以把依赖逐层增加的圈层画成：

```text
只依赖 ISO C 定义行为
    → 再依赖 POSIX 接口
        → 再依赖 Linux 特有接口
            → 再依赖某个架构/编译器的 inline asm
```

越靠里，源码可运行的平台通常越多；越靠外，可利用的平台能力通常越具体。工程中的关键不是永远停在最内层，而是清楚标注自己依赖哪一圈。

## 5. The C Standard Library：它究竟封装了什么

### 5.1 不要把 libc 背成函数清单

课堂曾让 AI 生成一个教学用 mini-libc，包含启动、清理、字符串、`printf` 和简单分配器：

![AI 辅助生成教学用 mini-libc；文件树同时出现启动、I/O、字符串和分配器](../../sources/site_html/static/img/minilibc.jpg)

这张图承担的论证不是“几百行就能替代成熟 libc”，而是 libc 可以按边界拆解，最小实现也能暴露完整骨架：

| 类别 | 例子 | 主要依赖 |
| --- | --- | --- |
| 平台常数与类型 | `size_t`、`INT_MAX`、`PRIdPTR` | 编译目标的数据模型 |
| 纯计算/内存操作 | `strlen`、`memmove`、`qsort` | ISA、C 对象语义，通常无 syscall |
| ABI 机关 | `va_list`、`setjmp`、函数入口 | 调用约定、寄存器与栈布局 |
| OS 对象封装 | `stdio`、`open`、`popen` | fd、系统调用以及用户态状态 |
| 进程环境与生命周期 | `environ`、CRT、`exit` | ELF、初始栈、加载器、内核终止机制 |
| 资源策略 | `malloc`、线程运行时 | `mmap`/`brk` 加用户态数据结构与同步 |

一个 AI 生成的 mini-libc 也许能跑一个 demo，但验收时至少要问：入口栈是否按 ABI 对齐？变参数是否支持浮点寄存器？`memmove` 是否处理重叠？短写和 `EINTR` 是否处理？stdio 的缓冲在 `fork`/`exit` 时怎样变化？这些问题恰好就是学习真实实现的理由。

### 5.2 API、ABI、libc 与系统调用的明确边界

四个术语应分别使用：

- **API** 是源码可见的名字、类型、前置条件和结果，例如 `size_t fread(void *, size_t, size_t, FILE *)`；
- **ABI** 是编译后二进制如何协作，包括寄存器传参、栈对齐、符号、重定位和对象布局；
- **libc 实现** 是兑现 API 的用户态代码，可以选择算法、缓冲和具体 syscall；
- **系统调用 ABI** 是用户态进入内核时的编号、寄存器、陷入指令与错误返回约定。

几个代表性调用的路径如下：

| 表达式 | 用户态工作 | 可能的内核交互 |
| --- | --- | --- |
| `strlen(s)` | 扫描字节；可能被 inline/SIMD/常量折叠 | 无 |
| `setjmp(env)` | 按 ABI 保存恢复所需机器状态 | 通常无；保存信号掩码的变体可能涉及线程/信号状态 |
| `fprintf(stdout, ...)` | 解析格式、取变参数、加锁、写 `FILE` 缓冲 | 缓冲满或刷新时 `write`/`writev` |
| `open(path, flags)` | 检查/转换参数，包装错误 | Linux 上可能是 `openat` syscall |
| `getenv("PATH")` | 扫描 libc 维护的环境指针表 | 无 |
| `system(cmd)` | 管理信号、创建进程并等待 | `fork`/`clone`/`spawn`、`execve`、`wait*` 等 |
| `exit(status)` | 运行 handler、刷新/关闭流 | 最终执行进程终止 syscall |

API 与系统调用不一一对应，正是 libc 可以移植和优化的空间。

## 6. 为什么学习 musl，而不是一上来调 glibc

### 6.1 选择教学实现，不是在评判“谁更好”

glibc 是生产系统的关键基础设施，承载兼容性、国际化、动态链接、硬件优化和数十年的历史约束。它当然可以调试，但初学者很容易在符号版本、间接函数选择、宏和优化路径中迷失。

[musl](https://musl.libc.org/) 的实现更紧凑，目录和调用链通常更适合从原理出发阅读。选择 musl 是为了降低学习时的无关复杂度，不等于宣称它在所有兼容性、功能或性能维度都优于 glibc。

讲义的“总有办法”是一种调试方法论：

1. 先问一个可证伪的小问题，例如“这一句 `printf` 到底触发几次 `write`”；
2. 选择源码可读、能加入调试信息的实现；
3. 用 `-g3` 保存源级信息，用 `-O1` 或 `-Og` 保留一定真实代码形态；
4. 同时收集 GDB 单步、反汇编和 syscall trace；
5. 不接受“已经编译好”的口头结论，用 `file`、`readelf`、`nm` 和实际断点确认。

若自行构建 musl，一个典型流程是把安装目录留在源码树旁，而不是替换系统 libc：

```bash
git clone https://git.musl-libc.org/git/musl
cd musl
CFLAGS='-g3 -O1 -fno-omit-frame-pointer' ./configure --prefix="$PWD/install"
make -j"$(getconf _NPROCESSORS_ONLN)"
make install
./install/bin/musl-gcc -g3 -O1 hello.c -o hello-musl
```

构建选项随 musl 版本和实验目标可能调整；关键是随后检查 `hello-musl` 实际使用的解释器/依赖和符号，而不是只看命令退出码。安装到系统目录、覆盖系统 libc 既无必要也有风险。

### 6.2 “调试小程序”课堂 Demo 要观察什么

重新调试初学 C 时的 hello world，这次问题不再是“它打印了什么”，而是：

```text
ELF 入口的第一条指令
  → 初始栈中的 argc/argv/envp/auxv
  → CRT/libc 初始化
  → main
  → printf 的格式解析和 FILE 缓冲
  → syscall wrapper
  → syscall 指令
  → 内核中的 fd 对象
```

有调试版 musl 后，可用下面的观察组合：

```bash
readelf -hW ./hello-musl | grep 'Entry point'
readelf -lW ./hello-musl
nm -an ./hello-musl | grep -E '(_start| main$|printf|write)'
strace -f -o /tmp/hello.trace ./hello-musl
gdb -q ./hello-musl
```

在 GDB 中使用 `starti` 从首条指令停下，用 `display/i $pc` 与 `si` 看机器状态；再对 `_start`、`main`、`printf` 或实现内部写路径设断点。`catch syscall write` 可以把用户态最后一步与 `strace` 对上。动态链接、静态链接和优化级别会改变具体栈帧，**应该比较语义路径，不要死记某一版函数名或固定地址。**

## 7. 探索 libc（一）：指令集体系结构与计算的封装

### 7.1 Freestanding 与 hosted 环境

在 C 标准的术语里，hosted implementation 面向有完整运行环境的普通应用，提供完整标准库并按约定调用 `main`；freestanding implementation 面向内核、bootloader、固件等场景，不假定存在宿主 OS 或完整 I/O/进程设施。

“C 会直接翻译成机器指令”并不等于任意 C 代码都无需运行库：

- `putchar` 要把字符送到某种外部对象，普通 Linux 程序最终需要系统调用；
- `exit` 涉及进程生命周期，freestanding 环境可能根本没有“进程”；
- 编译器可以把结构体复制、除法或栈保护翻译为辅助函数调用；
- 即使源码没写 `memcpy`，某些优化/目标也可能生成对它的引用；
- `-ffreestanding` 限制编译器关于宿主库的假设，但不会自动给你启动代码、链接脚本或设备驱动。

因此 freestanding 的最小模型是：你拥有编译器能生成的指令和平台入口，缺失的能力由自己依据 ISA/ABI/硬件或宿主接口补上。

### 7.2 实验一：不用 libc，从 `_start` 直接 `write` 和 `exit`

下面实验只适用于 **Linux x86-64 + GCC/Clang 风格汇编**。文件级汇编提供真正的 ELF 入口并对齐栈，C 函数内的 extended asm 按 Linux syscall ABI 放参数：

```c
// raw-start.c
typedef unsigned long usize;

static long raw_write(long fd, const void *buf, usize size) {
    long ret;
    __asm__ volatile(
        "syscall"
        : "=a"(ret)
        : "0"(1L), "D"(fd), "S"(buf), "d"(size)
        : "rcx", "r11", "memory");
    return ret;
}

__attribute__((noreturn))
static void raw_exit(long status) {
    __asm__ volatile(
        "syscall"
        :
        : "a"(60L), "D"(status)
        : "rcx", "r11", "memory");
    __builtin_unreachable();
}

__attribute__((noreturn, used))
void c_start(void) {
    static const char msg[] = "hello without libc\n";
    long n = raw_write(1, msg, sizeof(msg) - 1);
    raw_exit(n == (long)(sizeof(msg) - 1) ? 0 : 1);
}

__asm__(
    ".global _start\n"
    ".type _start,@function\n"
    "_start:\n"
    "xor %ebp,%ebp\n"
    "andq $-16,%rsp\n"
    "call c_start\n");
```

编译并观察：

```bash
cc -O2 -nostdlib -static -fno-stack-protector -fno-pie -no-pie \
  raw-start.c -o raw-start
./raw-start
printf 'status=%d\n' "$?"
readelf -hW ./raw-start | grep 'Entry point'
nm -u ./raw-start
objdump -d ./raw-start | less
strace -e trace=write,exit ./raw-start
```

预期看到一行 `hello without libc`，退出状态为 0；`nm -u` 不应列出未解析的 libc 符号；trace 的核心只有 `write(1, ..., 19)` 和 `exit(0)`。若 `write` 没有完整写出，代码以状态 1 退出。这里 raw syscall 失败时返回负的 `-errno`，并没有 libc 替你设置 `errno`。

几个选项的含义也要分清：

- `-nostdlib` 不链接标准启动文件和标准库；
- `-static` 避免动态加载器成为另一层依赖；
- `-fno-stack-protector` 防止编译器插入 `__stack_chk_fail`；
- `_start` 遵守的是进程入口 ABI，不是“由另一个 C 函数调用”的普通函数 ABI；这里用汇编入口调整栈后才 `call c_start`；
- syscall 编号和参数寄存器完全是 Linux x86-64 特定的，换到 AArch64/RISC-V 必须重写。

这个实验把边界压到最薄：C 只负责能独立翻译的计算，inline asm 连接 syscall ABI，内核负责 fd 1 与进程退出。它不是要鼓励业务代码绕开 libc，而是证明 libc 下面没有魔法。

### 7.3 机器/平台相关的常数与定义

标准头文件把平台差异变成可查询的名字：

| 头文件 | 典型内容 | 回答的问题 |
| --- | --- | --- |
| `<stddef.h>` | `size_t`、`ptrdiff_t`、`NULL`、`offsetof` | 对象大小/指针差用什么类型，成员布局如何查询 |
| `<limits.h>` | `CHAR_BIT`、`INT_MIN`、`LONG_MAX` | 整数基本类型在此实现中的范围 |
| `<float.h>` | `FLT_MANT_DIG`、`DBL_MAX`、舍入特征 | 浮点格式和运算能力 |
| `<stdint.h>` | `int32_t`、`uint64_t`、`intptr_t` 等 | 需要精确宽度或能承载指针的整数类型时用什么 |
| `<inttypes.h>` | `PRId64`、`PRIuPTR`、扫描宏 | 如何给这些整数类型选择可移植格式串 |

`offsetof(T, member)` 给出成员相对结构体起始地址的字节偏移。它由实现处理 padding 和对齐；不能凭“前面字段大小相加”猜布局，也不能对 bit-field 求可寻址偏移。

可以观察格式宏经预处理后的结果：

```c
// format-macro.c
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>

int main(void) {
    intptr_t x = (intptr_t)123;
    printf("x=%" PRIdPTR "\n", x);
    return 0;
}
```

```bash
cc -E -P format-macro.c | tail -n 20
cc -Wall -Wextra -Wpedantic format-macro.c -o format-macro
./format-macro
```

在 LP64 Linux 上，`PRIdPTR` 常展开成与 `long` 对应的片段；别的平台可能不同。源码中的相邻字符串字面量会在编译阶段拼接，因此 `"%" PRIdPTR` 最终形成正确格式串。这比假定指针整数永远用 `%ld` 或 `%lld` 更可靠。

### 7.4 `stdarg.h`：看似是指针移动，实际是调用约定

`printf(const char *fmt, ...)` 必须在运行时按格式串取出未命名参数。接口只有四个常见操作：`va_list`、`va_start`、`va_arg`、`va_end`（以及复制用的 `va_copy`），实现却强烈依赖 ABI。

老式 32 位栈传参环境中，`va_list` 很像沿栈移动的指针；在 x86-64 System V ABI 中，整数/指针与浮点参数优先进入不同寄存器组，函数序言还可能建立 register save area。`va_list` 需要同时记录通用寄存器偏移、浮点寄存器偏移和溢出到栈上的位置。AArch64、RISC-V 又有自己的规则。

因此下面这种“把最后一个命名参数地址当成数组”的写法是反例：

```c
// 反例：在现代寄存器传参 ABI 上没有这种保证
void bad(int n, ...) {
    long *args = (long *)&n;
    /* args[1] 不一定是第一个可变参数 */
}
```

只能用 `stdarg.h` 宏访问，而且同一个 `va_list` 若要走两遍必须 `va_copy`。这也是下一讲调试 `printf` 时值得追踪的“机器级角落”。

### 7.5 一些“随手可以实现”的函数，契约并不随手

`<string.h>` 中的函数看起来只是循环：

- `memcpy(dst, src, n)` 假定两段不重叠；重叠时行为未定义；
- `memmove(dst, src, n)` 必须让重叠复制也像先经过临时数组；
- `strcpy` 依赖源串存在 `\0` 且目标空间足够，接口自身无法检查容量；
- 高性能实现还会处理对齐、向量指令、页边界和不同微架构。

`<stdlib.h>` 里的“小函数”也包含策略和边界：

- `rand()` 是普通伪随机接口，不应用于密钥或安全令牌；
- `atoi()` 无法可靠报告错误，解析外部输入通常应使用能检查 end pointer 和范围的 `strtol()`；
- `qsort()` 必须在不知道元素类型的情况下，根据调用者给出的大小与比较函数排列任意数组。

`qsort` 的声明展示了 C 通过 `void *` 与函数指针实现通用算法：

```c
void qsort(void *base, size_t nmemb, size_t size,
           int (*compar)(const void *, const void *));
```

比较函数只需返回负、零、正，不能用 `return *(int *)a - *(int *)b;`，因为减法可能有符号溢出。安全写法是：

```c
static int intcmp(const void *pa, const void *pb) {
    int a = *(const int *)pa;
    int b = *(const int *)pb;
    return (a > b) - (a < b);
}
```

这些函数可以作为独立练习实现朴素版本，但成熟标准库还要兑现全部标准语义、适配 ABI、承受恶意边界并优化常见 workload。“C 是高级汇编”不等于写一个正确 libc 很容易。

### 7.6 `<math.h>` 与 NaN 小测验

讲义问：什么数 `a` 满足

```c
!(a > a || a < a || a == a)
```

答案是 NaN（not a number）：与 NaN 的有序比较为假，相等比较也为假。实际代码应使用 `isnan(a)` 表意，而不是把比较性质当作检测技巧。还要注意优化选项：允许破坏严格 IEEE 语义的 fast-math 优化可能让编译器假定没有 NaN。

讲义继续指向 FP8 E4M3/E5M2 和量化，是为了说明“一个浮点数如何比较、溢出和舍入”也不是 C 源码凭空决定的；数据格式、ISA 支持、编译器和库共同兑现语义。位宽越小，范围、精度和特殊值之间的取舍越明显。

## 8. `setjmp`/`longjmp`：把控制流保存成数据

### 8.1 从 SimpleC 形式语义推导

SimpleC 模拟器可以把函数返回描述为：

```text
pc = stack[-1].PC
stack[-1].PC.next()
inst[pc].execute()
```

普通 `return` 只回到当前调用者。`setjmp(jmp_buf)` 则在栈上做一个“恢复标记”：保存以后继续执行所需的程序计数位置、栈指针和 ABI 规定的 callee-saved 寄存器等状态，首次返回 0。`longjmp(buf, x)` 抛弃标记之后的活动调用帧，恢复该状态，让原先的 `setjmp` 像再次返回一样得到非零值；若传入 0，标准规定它返回 1。

讲义中的抽象执行规则可以写成：

```text
call setjmp:
    buf.depth = len(stack)
    buf.pc = current continuation
    retval = 0

call longjmp(buf, x):
    discard frames newer than buf.depth
    restore continuation and saved machine state
    retval = (x != 0 ? x : 1)
```

真实 `jmp_buf` 是实现私有的机器状态容器，不能复制猜测字段，也不能跨线程使用。

### 8.2 实验二：观察“同一次调用返回两次”

```c
// jump.c
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>

static jmp_buf checkpoint;

static void deep_call(void) {
    puts("inside deep_call: jumping with value 0");
    longjmp(checkpoint, 0);
}

int main(void) {
    volatile int changed = 10;
    int code = setjmp(checkpoint);

    if (code == 0) {
        changed = 20;
        puts("first return from setjmp");
        deep_call();
        abort();                    // 不可达；若到达说明假设失效
    }

    printf("after longjmp: code=%d, changed=%d\n", code, changed);
    return code == 1 && changed == 20 ? EXIT_SUCCESS : EXIT_FAILURE;
}
```

```bash
cc -g -O2 -Wall -Wextra -Wpedantic jump.c -o jump
./jump
printf 'status=%d\n' "$?"
gdb -q ./jump
```

预期依次出现首次返回、深层跳转和 `code=1, changed=20`，退出状态为 0。GDB 中可在 `deep_call` 和 `setjmp` 之后的 `printf` 处断住，比较 backtrace：`deep_call` 的帧在恢复后已经不存在。

这里把 `changed` 声明为 `volatile` 不是装饰。若自动变量位于包含 `setjmp` 的函数、在 `setjmp` 后被修改且不是 volatile-qualified，那么 `longjmp` 后它的值不确定。优化构建特别容易暴露这一点。

### 8.3 长跳转没有替你做什么

`longjmp` 只恢复控制流所需状态，不会像结构化返回那样逐层运行清理：

- 不会自动 `free` 中间帧负责的堆对象；
- 不会关闭这些帧打开的文件或释放互斥锁；
- 不会执行 C++ 析构器，因此从 C++ 自动对象上跨过通常是灾难；
- 不能跳回已经正常返回的函数所留下的失效 `jmp_buf`；
- 不能把一个线程保存的环境拿到另一个线程恢复；
- 异步信号场景还要考虑 `sigsetjmp`/`siglongjmp` 是否保存信号掩码，以及能调用的 async-signal-safe 函数集合。

它适合在明确的、受控的错误边界中使用，例如解释器从深层解析失败回到顶层；它不是通用异常系统。下一讲通过先后改写寄存器再执行 `setjmp`/`longjmp`，还可以反推出哪些寄存器属于 callee-saved。

## 9. 探索 libc（二）：系统调用的封装

### 9.1 文件描述符之上的 `FILE *`

前两讲已经建立文件描述符模型：fd 是进程 fd table 中的整数索引，指向内核 open file description 或其他对象。C 标准 I/O 再在用户态加一层 stream 状态：

```text
程序的 fprintf/fread/fseek
          ↓
FILE 对象：缓冲区、读写位置预测、EOF/error 标志、锁、方向/编码状态……
          ↓  缓冲需要填充或排空
POSIX fd：0, 1, 2, ...
          ↓
read/write/lseek 等系统调用
          ↓
内核对象及其 offset
```

讲义说“`FILE *` 背后其实是文件描述符”，在 Linux/POSIX 的普通文件、终端和管道 stream 上是很好的实现直觉，但不是 ISO C 的等式：

- `FILE` 是不透明类型，应用不能访问内部字段；
- POSIX 的 `fileno(stream)` 可查询相关 fd，ISO C 本身没有这个承诺；
- `fmemopen` 等内存 stream 未必对应普通 fd；
- glibc 与 musl 的 `FILE` 布局不同，GDB 里看到的字段只是当前实现，不是公共 ABI。

`fseek`、`fgetpos`、`ftell`、`feof` 等并非机械转发一个 syscall。库要协调自己的预读/待写缓冲与内核 offset；`feof` 只有在一次读取尝试到达文件尾后才置位，并不是“下一次是否会读到 EOF”的预测器；`fflush` 把用户态输出推给内核，却不等于 `fsync` 所承诺的持久化。

### 9.2 实验三：亲眼看到 stdio 与 fd 的先后次序

下面程序先把 `A` 放进强制全缓冲的 `stdout` stream，再绕过该 stream 直接向 fd 1 写 `B`，最后刷新：

```c
// stdio-fd.c
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(void) {
    static char buffer[16];
    if (setvbuf(stdout, buffer, _IOFBF, sizeof(buffer)) != 0) {
        fputs("setvbuf failed\n", stderr);
        return EXIT_FAILURE;
    }
    if (fputc('A', stdout) == EOF) {
        perror("fputc");
        return EXIT_FAILURE;
    }

    ssize_t n;
    do {
        n = write(STDOUT_FILENO, "B", 1);
    } while (n < 0 && errno == EINTR);
    if (n < 0) {
        perror("write");
        return EXIT_FAILURE;
    }
    if (n != 1) {
        fputs("short write\n", stderr);
        return EXIT_FAILURE;
    }
    if (fflush(stdout) == EOF) {
        perror("fflush");
        return EXIT_FAILURE;
    }
    return EXIT_SUCCESS;
}
```

```bash
cc -Wall -Wextra -Wpedantic stdio-fd.c -o stdio-fd
./stdio-fd > /tmp/stdio-fd.out
od -An -tc /tmp/stdio-fd.out
strace -e trace=write ./stdio-fd >/dev/null
```

预期文件里的字符顺序是 `B A`，trace 也先看到 `write(1, "B", 1)`，后看到刷新 `A` 的写。`fputs` 成功并不意味着内核已经见到 A；直接 `write` 不知道 `FILE` 缓冲中还有数据。

这说明随意混用 `stdio` 与同一 fd 上的 `read`/`write` 会造成顺序和 offset 问题。若必须混用，应严格遵守标准/POSIX 对更新流、刷新和定位的同步要求。它也解释了 `fork` 的经典现象：尚未刷新的一份用户态缓冲会随地址空间复制，父子若都走 `exit`，内容可能被冲刷两次。

### 9.3 `printf` family：核心应收敛到 `vfprintf`

格式化函数有许多外壳：`printf`、`fprintf`、`sprintf`、`snprintf` 以及对应的 `v*` 版本。若每个函数都复制一遍格式解析器，就会产生难以修复的 code clones。典型结构是：

```c
int printf(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int ret = vfprintf(stdout, fmt, ap);
    va_end(ap);
    return ret;
}
```

真正复杂的逻辑收敛到：

```c
int vfprintf(FILE *stream, const char *format, va_list ap);
```

这样“目标 stream”与“已经初始化的参数游标”都成为显式参数。其他包装只负责选择 stream/缓冲目标和构造 `va_list`。这里同时连接三层：格式 API、变参数 ABI 和 `FILE`/fd 的 OS 对象封装。

### 9.4 进程退出管理：`abort`、`exit`、`atexit`

几种“结束程序”不能混为一谈：

| 接口 | 用户态清理 | 主要语义 |
| --- | --- | --- |
| 从 `main` 返回 | 按正常终止处理 | 效果相当于把返回值交给 `exit` |
| `exit(status)` | 调用 `atexit` handlers、刷新并关闭 C streams | 正常终止，然后请求内核结束进程 |
| `_Exit(status)` | 不运行 `atexit`，不刷新 C streams | ISO C 的立即正常终止接口 |
| `_exit(status)` | 与上项相近的 POSIX 接口 | `fork` 后 `exec` 失败的子进程常用它，避免重复刷新父进程缓冲 |
| `abort()` | 不承诺正常退出清理 | 产生 `SIGABRT` 异常终止；系统配置允许时常生成 core dump |

`atexit(fn)` 注册的函数只在正常终止路径运行，通常按注册的逆序调用；被信号杀死、调用 `_exit` 或进程崩溃时不能指望它。关键资源仍应在正常控制流里明确管理，而不是把 `atexit` 当作万能事务。

还要区分“用户态 stream 清理”与“内核释放进程资源”：即使 `_exit` 不调用 `fclose`，内核在进程结束时仍撤销它持有的 fd；区别在于 libc 缓冲里的字节可能永远没有交给内核。

### 9.5 与其他进程协同：`system`、`popen`、`pclose`

`system(command)` 让 libc 启动 Shell 解释字符串，概念上接近 `/bin/sh -c command` 再等待。它复用了上一讲的 Shell 语言，因此也继承了 quoting、环境、信号和命令注入风险。不要把不可信字符串直接拼成命令；能用参数数组直接 `exec`/`posix_spawn` 时，边界更清楚。

`popen(command, "r")` 或 `popen(command, "w")` 在 Shell 命令与当前进程之间接一条 pipe，并返回 `FILE *`；`pclose` 既关闭 stream 又等待子进程、返回终止状态。历史 API 的显著限制是 pipe 天生单向，因此标准 `type` 只能选择读或写，不能在同一个 stream 上双向通信。需要全双工协议时，通常显式创建两条 pipe、使用 `socketpair`，并自行管理进程生命周期。

这些函数不是一个 syscall：libc 在用户态组合 pipe、fork/spawn、fd 重定向、exec 和 wait 等机制，向上提供更方便但也更有策略的 API。

## 10. `err`、`error`、`perror`：失败路径也是接口

### 10.1 从内核错误码到人类文本

所有涉及外部状态的 API 都可能失败。`gcc nonexist.c` 打印：

```text
gcc: error: nonexist.c: No such file or directory
```

反复出现的 `No such file or directory` 不是巧合。典型链路是：

```text
内核查找路径失败
  → syscall ABI 返回 ENOENT 对应的错误
  → libc wrapper 返回 -1，并把 errno 设为 ENOENT
  → 程序用 strerror/perror 得到本地化文本
  → 再加上工具名、操作和路径上下文
```

在 Linux raw syscall 层，错误通常编码为寄存器中的负值；用户看到的 `-1 + errno` 是 libc API 的转换。`errno` 通常是一个能展开为线程局部存储的宏，不是所有线程共享的普通全局整数。

正确模式是先检查该 API 文档规定的失败返回，再尽快保存 `errno`：

```c
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int fd = open("nonexist", O_RDONLY);
if (fd < 0) {
    int saved = errno;
    errno = saved;
    perror("open nonexist");
    fprintf(stderr, "open nonexist: errno=%d (%s)\n",
            saved, strerror(saved));
} else if (close(fd) < 0) {
    perror("close");
}
```

不要在成功后根据 `errno != 0` 判断失败：成功调用通常不负责清零旧值。也不是所有库 API 都使用 `errno`；例如一些 pthread 接口直接返回错误编号，`getaddrinfo` 使用自己的 `EAI_*` 空间，stdio 还维护 stream error flag。必须先读具体契约。

### 10.2 三组名字的可移植性

| 接口 | 来源/常见头文件 | 行为 |
| --- | --- | --- |
| `perror(prefix)` | ISO C/POSIX，`<stdio.h>` | 根据当前 `errno` 向 `stderr` 输出说明，不退出 |
| `strerror(errnum)` | ISO C/POSIX，`<string.h>` | 把指定错误号转为文本；返回存储与线程细节看接口版本 |
| `warn`/`err` family | BSD 风格，常见 `<err.h>` | 加上下文；`err` 版本通常随后退出，不是 ISO C |
| GNU `error` | GNU 扩展，`<error.h>` | 格式化错误并可按参数退出，不是 POSIX 通用接口 |

所以讲义标题把 `err, error, perror` 并列，是在展示不同生态怎样复用相同错误文本，不表示它们是同一个标准里的同义函数。可移植程序可自己围绕 `fprintf`、`strerror` 和保存的错误码封装统一报告函数。

错误文本可能受 locale 影响。讲义建议尝试：

```bash
LANGUAGE=zh_CN ls nonexist
```

若系统安装了相应翻译并且该程序使用对应国际化机制，消息可能变成中文；没有 locale 数据时仍显示默认语言。脚本不应解析本地化的人类错误句子，应检查退出状态或机器可读输出。

## 11. 探索 libc（三）：进程运行环境的封装

### 11.1 `envp` 如何影响应用行为

UNIX 用 `NAME=value` 字符串数组表达进程环境。创建新进程映像时，`execve(path, argv, envp)` 显式接收环境数组；更方便的 `exec*` 包装常默认沿用调用者的 `environ`，于是形成“子进程默认继承环境”的体验。

常见环境变量会改变：

- `PATH`：Shell/`execvp` 到哪里搜索命令；
- `LANG`、`LC_*`、`LANGUAGE`：locale、排序和消息语言；
- `HOME`、`TMPDIR`：应用采用的默认路径；
- 动态加载相关变量：在普通进程中影响装载行为，但安全执行模式会限制危险变量。

环境不是保密仓库，也不是内核强类型配置。它会被复制给后代、可能通过 procfs/调试接口暴露，并且所有值都只是字符串。涉及权限边界的程序必须谨慎对待继承的环境。

许多 UNIX C 实现允许第三种 `main` 形式：

```c
int main(int argc, char *argv[], char *envp[]);
```

严格 ISO C 只标准化无参数形式和 `argc/argv` 形式；`envp` 参数与全局 `environ` 是 UNIX/POSIX 生态约定。可移植标准接口是 `getenv`，修改环境的 `setenv`/`unsetenv` 属于 POSIX。

### 11.2 `environ` 是谁赋值的

`environ` 是 libc 导出的一个变量（更准确地说，是一个可链接的符号所代表的指针变量），最终指向环境指针数组。内核在 `execve` 后建立初始用户栈；System V ABI 的概念布局是：

```text
初始 SP → argc
          argv[0] ... argv[argc-1]
          NULL
          envp[0] ... envp[n-1]
          NULL
          auxv: (type, value) ... AT_NULL
          参数/环境字符串、随机数据等
```

由于 ASLR，每次运行的栈地址可能不同，链接时不可能把 `environ` 固定为某个绝对地址。启动代码从入口栈解析 `argc` 和 `argv`，由 `argv + argc + 1` 找到环境数组，再让 libc 的 `environ` 指向它。以后 `setenv` 可能分配一张新数组并更新 `environ`，所以“最初来自栈”也不代表它永远留在原位置。

这正适合用 watchpoint 求证：对自己构建、带符号的 musl 程序从 `starti` 开始，在 libc 初始化写 `environ` 前设置硬件写监视点，然后继续执行。具体内部符号和写入位置取决于 libc/链接方式，不应照抄某次运行的地址。

### 11.3 C Runtime：程序从 `_start` 而不是 `main` 开始

ELF header 记录入口地址，内核/动态加载器最终把 PC 交给 `_start`。典型控制流是：

```text
execve
  → 内核映射 ELF，构造 initial process stack
  → 若动态链接：解释器完成依赖装载和重定位
  → ELF entry: _start（来自 crt1.o/Scrt1.o 等）
  → 解析 argc/argv/envp/auxv，准备运行库
  → __libc_start_main 一类 libc 启动函数
  → 初始化 TLS、libc 状态，运行 constructors
  → main(argc, argv, envp)
  → exit(main 的返回值)
  → atexit handlers / destructors / stdio flush
  → 最终终止 syscall
```

链接普通 C 程序时，编译器 driver 会按模式加入若干 CRT 对象：

- `crt1.o` 或 PIE 对应变体通常提供入口；
- `crti.o`、`crtn.o` 参与初始化/终止段的边界结构；
- `crtbegin.o`、`crtend.o` 等来自编译器运行时，协助构造器、析构器和异常展开元数据；
- 具体文件集合、顺序和职责随工具链、架构、静态/动态链接而变化。

`crt` 是 C runtime 的历史名称，不等同于整个 libc，但启动对象通常随 libc/工具链一起提供。`-nostartfiles` 只省略启动对象，`-nostdlib` 还省略标准库与编译器运行库；二者不要混用。

### 11.4 实验四：从入口栈走到 `main` 与 `environ`

先编译一个只观察指针关系的小程序：

```c
// env-start.c
#include <stdio.h>
#include <stdlib.h>

extern char **environ;

int main(int argc, char **argv, char **envp) {
    printf("argc=%d argv0=%s\n", argc,
           argc > 0 && argv[0] != NULL ? argv[0] : "(none)");
    printf("envp=%p environ=%p same=%s\n",
           (void *)envp, (void *)environ,
           envp == environ ? "yes" : "no");
    printf("LAB_MARK=%s\n",
           getenv("LAB_MARK") != NULL ? getenv("LAB_MARK") : "(unset)");
    return EXIT_SUCCESS;
}
```

```bash
cc -g3 -O0 -Wall -Wextra -Wpedantic env-start.c -o env-start
LAB_MARK=from-parent ./env-start arg1
readelf -hW ./env-start | grep 'Entry point'
cc -### env-start.c -o /tmp/env-start-link 2>&1 \
  | grep -oE '[^ ]*(crt1|crti|crtbegin|crtend|crtn)[^ ]*'
gdb -q ./env-start
```

预期 `argc` 为 2，`LAB_MARK=from-parent`；在程序尚未调用 `setenv` 时，常见 UNIX 实现中 `envp` 与 `environ` 指向同一数组。每次运行的地址可能因 ASLR 改变，这正说明它们必须在启动时被发现。

在 GDB 中继续：

```text
(gdb) set environment LAB_MARK from-gdb
(gdb) starti
(gdb) display/i $pc
(gdb) x/24gx $sp
(gdb) break main
(gdb) continue
(gdb) print argc
(gdb) print argv[0]
(gdb) print envp
(gdb) print environ
(gdb) info proc mappings
```

`starti` 的停点可能位于程序 `_start`，也可能先位于动态加载器入口，取决于链接方式；这是观察结果，不是错误。`x/24gx $sp` 只显示未解释的机器字，先识别 `argc` 和指针数组，再结合 ABI 文档解释，不能把固定下标套到所有架构。若换成自编译的调试版 musl，可在启动函数处单步并对 `environ` 设 watchpoint，直接看到赋值指令。

## 12. 一次调用的四层剖面：避免概念串台

把本讲最容易混淆的说法汇总如下：

| 说法 | 判断 | 更准确的表述 |
| --- | --- | --- |
| “C 就是可移植汇编” | 错 | C 是带抽象机和未定义行为规则的高级语言；实现可强力优化，并不逐句对应指令 |
| “libc 就是所有系统调用” | 错 | libc 还包含纯计算、ABI 适配、缓冲、启动和资源策略；Linux 也有 libc 未包装的 syscall |
| “一个 libc API 对应一个同名 syscall” | 错 | 可以是零个、一个或多个 syscall，名称也可不同 |
| “POSIX 就是 ISO C 标准库” | 错 | POSIX 建立在 C 上并增加 OS 接口；`unistd.h` 不是 ISO C 头文件 |
| “freestanding 就不能用任何头文件” | 错 | 它不承诺完整 hosted library/OS；许多编译期类型和宏仍可用，具体看标准版本和实现 |
| “`FILE *` 是 fd 的指针写法” | 过度简化 | POSIX stream 常关联 fd，但 `FILE` 还含用户态状态且是不透明实现类型 |
| “`fflush` 已把数据写到磁盘” | 错 | 它主要排空 libc 缓冲到 OS；持久化是另一层协议 |
| “只要 `errno` 非零，上一步就失败” | 错 | 先看 API 的失败返回；成功通常不会清除旧 `errno` |
| “`longjmp` 像逐层 return” | 错 | 它恢复机器上下文并丢弃帧，不自动执行中间清理 |
| “内核直接调用 `main`” | 错 | 内核/加载器交给 ELF entry，CRT/libc 再调用 `main` |
| “环境变量就是内核全局配置” | 错 | 它是每个进程的一组用户态字符串，由 `execve` 传入并通常被后代继承 |
| “换 libc 不影响程序” | 有条件 | 标准 API 源码可保持，但扩展、ABI、动态链接和实现可见行为可能不同 |

一个实用诊断顺序是：

1. 先查 API 文档，确定返回值、错误和缓冲语义；
2. 再查目标平台 ABI，确定参数、栈、寄存器和入口状态；
3. 进入 libc 源码，确认这一实现选择了什么算法/状态；
4. 用反汇编确认编译器实际生成什么；
5. 用 syscall trace 确认何时真正进入内核；
6. 最后才讨论内核怎样实现对象与资源。

这样就不会把 GDB 中看到的 musl 私有字段误写成 C 标准，也不会把 `strace` 没出现某函数名误判为“函数没执行”。

## 13. Takeaways：libc 是应用世界的第一块稳定地基

本讲从进程模型出发，得到一条完整推导：

1. 用户态程序直接拥有的是指令可操作的寄存器和地址空间；
2. 访问进程外的操作系统状态必须使用受控入口；
3. C 的链接能力与 inline asm 可以连接任意符合 ABI 的机器代码；
4. libc 把纯计算、平台常数、ABI 机关、系统调用和启动环境统一成较稳定 API；
5. ISO C 与 POSIX 的标准化让上层无需在每种机器上重写第一层抽象；
6. `FILE`、错误报告、进程协同和 CRT 说明“包装”常常含有重要用户态状态与策略；
7. 最终仍可从 `_start`、寄存器和 syscall trace 追到每一次真实交互。

这套抽象之上才长出 C++、语言运行时、浏览器和各种应用框架。C 在现代应用开发中有内存安全、未定义行为和接口表达力等明显缺陷，但它仍是研究“第一层可移植抽象”非常好的样本。讲义给出的两篇延伸文章——[C Is Not a Low-level Language](https://dl.acm.org/doi/pdf/10.1145/3209212) 与 [C Isn't a Programming Language Anymore](https://gankra.github.io/blah/c-isnt-a-language/)——分别提醒我们：C 抽象机不等于真实硬件，以及现实中的“C”常是标准、编译器扩展、ABI、平台头文件和构建约定组成的一族方言。

下一讲将沿着本讲的 musl 调试路线继续：用 DWARF 把寄存器/内存重构为源码变量与栈帧，进入 `crt1.o`、`printf`、`va_args`、`setjmp` 和 vDSO；随后追问 `malloc` 的内存从哪里来，把 `mmap` 提供的大区间发展为高效 allocator。

## 14. 思考题与课后观察

1. 若 `strlen` 在 `strace` 中完全不可见，怎样分别证明它被调用后在用户态执行、被 inline，或被常量折叠了？
2. 为什么 libc 可以用 `openat` 实现 `open`，而不破坏调用者看到的 POSIX API？哪些错误和 flag 语义必须保持？
3. 把实验一移植到 AArch64 时，需要替换哪四类约定：入口、syscall 编号、参数寄存器、陷入指令？
4. `memcpy` 的重叠前置条件为什么能给实现更多优化空间？若库偷偷按 `memmove` 实现，调用者的错误是否就变得合法？
5. `setjmp` 最少要保存哪些状态，为什么 caller-saved 寄存器通常无需像 callee-saved 那样恢复？可设计什么寄存器染色实验验证？
6. 在 `printf("x")` 后连续 `fork()` 三次且不刷新，所有进程正常 `exit` 时可能看到几个 `x`？换成 `_exit` 又如何？先画每个地址空间中的 `FILE` 缓冲再回答。
7. 为什么 `feof(fp)` 不能用作“还有数据就继续”的先验条件？应如何依据 `fread`/`fgetc` 返回值写循环？
8. `system("cmd " + user_input)` 的危险来自 libc、Shell 语法还是内核？若改用 `execve` 参数数组，消除了哪些解析层？
9. `environ` 最初指向入口栈，为什么 `setenv` 后不能继续假定环境数组地址和每个字符串地址不变？
10. 下一讲 allocator 会同时依赖哪几层：ISO C API、libc 策略、线程 ABI、`mmap` syscall 与虚拟内存？

阅读练习：选择 musl 中一个感兴趣的短函数，先写下“预计是纯计算、ABI 机关还是 syscall wrapper”，再用源码、反汇编和 trace 三份证据修正预测。目标不是让 AI 代替观察，而是让它帮助提出更精确、可验证的问题。

## 15. PPT 内容覆盖表

| 原讲义标题/内容 | 本章对应小节 |
| --- | --- |
| Review & Comments；M2 发布 | §2.1 |
| 3.30 更新过一次；观察 Makefile | §2.1（逐行解释 `NAME`、`MODULE`、`include`） |
| Online Judge 本周开放；可自行生成 test cases | §2.1 |
| 复习：操作系统上的进程 | §2.2 |
| 汇编/C/Python 程序；寄存器、内存与系统调用 | §2.2 |
| 进程/内存/对象管理 API | §2.2、§5.2 |
| 用这些 API 构建应用生态；UNIX 对象 | §2.3 |
| `proc`/`pts`/`pipe` 手册与文本工具组合 | §2.3 |
| C → C++/Python；更高层运行时 | §2.3、§13 |
| The C Programming Language；SimpleC 回顾 | §3.1 |
| FFI；C 与汇编链接（ABI） | §3.2 |
| C 使用 inline assembly；`_start`/`exit` syscall | §3.3、§7.2 |
| Aside: Inline Assembly Demystified | §3.3 |
| Instructions : Outputs : Inputs : Clobbers : GotoLabels | §3.3 |
| `lea` 计算例子与 inline asm 难写 | §3.3 |
| 构建应用生态：组合、复用、分层 | §4.1 |
| 1950s/1970s/2010s/2026 的抽象层历史 | §4.1 |
| 标准化的力量；ISO C | §4.2 |
| POSIX C、`unistd.h` 与平台圈层 | §4.2（并澄清 POSIX 扩展关系） |
| The C Standard Library；AI 老师/mini-libc 图 | §5.1 |
| 学习已有 libc 的实现 | §6.1（为何不直接调 glibc、为何选择 musl） |
| 基本原则“总有办法”；选择 musl | §6.1 |
| `-g3 -O1` 编译 musl-gcc 与验证 | §6.1 |
| 调试“小程序”课堂 Demo | §6.2 |
| 从汇编指令、系统调用观察全部交互 | §6.2、§7.2、§11.4 |
| 探索 libc：指令集体系结构和计算的封装 | §7 |
| Freestanding 环境；不依赖 Host OS syscall | §7.1、§7.2 |
| 依赖 OS 的 `putchar`、`exit` | §7.1 |
| 机器/平台常数：`stddef.h`、`float.h`、`limits.h`、`inttypes.h`、`stdint.h` | §7.3 |
| `offsetof(T, m)` | §7.3 |
| `PRIdPTR`/`PRIuPTR` 的 `gcc -E` 结果 | §7.3 |
| 指令语义与 ABI 参数解析；`stdarg.h` | §7.4 |
| 寄存器传参让 `va_list` 复杂 | §7.4 |
| “随手可以实现”的函数：`string.h` | §7.5 |
| `stdlib.h`：`rand`、`atoi`、`qsort` | §7.5 |
| `qsort` 函数指针声明 | §7.5 |
| `math.h`；NaN 比较题 | §7.6 |
| FP8 E4M3/E5M2、Quantization | §7.6 |
| `setjmp`/`longjmp`：长跳转 | §8 |
| SimpleC 模拟器形式语义 | §8.1 |
| 栈上的标记与长跳转伪代码 | §8.1 |
| `setjmp`/`longjmp` 可操作 Demo | §8.2、§8.3 |
| 探索 libc：系统调用的封装 | §9 |
| 文件描述符；Standard I/O、`stdio.h` | §9.1 |
| `FILE *` 与 fd；GDB 查看 `stdout` | §6.2、§9.1 |
| `fseek`、`fgetpos`、`ftell`、`feof` | §9.1 |
| `FILE` 缓冲与 fd 直接写实验 | §9.2 |
| The `printf()` family；避免 code clones | §9.3 |
| `vfprintf(FILE *, ..., va_list)` | §9.3 |
| 进程管理：退出管理 | §9.4 |
| `abort`、`exit`、`atexit` | §9.4 |
| 与其他进程协同：`system` | §9.5 |
| `popen`/`pclose` 与单向 pipe 缺陷 | §9.5 |
| `err`、`error`、`perror` | §10 |
| 所有 API 都可能失败；manpage ERRORS | §10.1 |
| `No such file or directory` 的共同来源 | §10.1 |
| `LANGUAGE=zh_CN ls nonexist` | §10.2 |
| 进程的运行环境 | §11 |
| 环境 `envp` 影响应用；默认子进程继承 | §11.1 |
| `main(argc, argv, envp)` 与 `man 7 environ` | §11.1、§11.2 |
| `environ` 是变量；谁为它赋值 | §11.2 |
| ASLR 与 watchpoint | §11.2、§11.4 |
| System V ABI Initial Process Stack | §11.2 |
| C Runtime；程序从 `_start` 开始 | §11.3 |
| `crt1.o`、`__libc_start_main` | §11.3 |
| `crtbegin.o`、`crtend.o`、`crtn.o` | §11.3、§11.4 |
| 从第一条指令调试 musl libc | §6.2、§11.4 |
| Takeaways：libc 是跨平台应用的第一级抽象 | §13 |
| C is not a low-level language；C isn't a programming language any more | §13 |
| 阅读材料：借助 AI 调试 musl 中感兴趣的函数 | §14 |
