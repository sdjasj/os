# 第 10 讲：C 标准库和实现（2）——把 libc 拆开，再把 malloc 拼起来

> 原始讲义：[sources/notes/lect10.md](../../sources/notes/lect10.md)  
> 配套示例：[examples/mini_malloc.c](../../examples/mini_malloc.c)  
> 相关实验：[M5：并行内存分配器](../../sources/notes/labs/M5.md)（本章只建立分析方法，不给出实现答案）  
> 本讲关键词：musl、freestanding、DWARF、source map、`crt1.o`、initial process stack、`FILE`、`va_list`、`setjmp`/`longjmp`、vDSO、`malloc`/`free`、workload、fast/slow path、segregated list、slab
> 前一讲：[C 标准库和实现（1）](09-libc-1.md) · 后一讲：[可执行文件与链接](11-executable-linking.md)

## 0. 本讲定位：上一讲搭好抽象，这一讲打开抽象

上一讲建立了 libc 的位置：C 语言能直接操纵寄存器和内存，也能通过 ABI、外部汇编和 inline assembly 越过语言边界；libc 再把机器常数、调用约定、系统调用和常用算法封装成稳定、可移植的接口。我们还知道，程序真正从 `_start` 而非 `main` 开始，`FILE *` 也不等于文件描述符。

但“libc 是一层抽象”仍然太像一个黑盒。本讲要把它打开：

```text
最初的进程状态
  │  内核设置 PC、SP 和 initial process stack
  ▼
crt1.o 中的 _start
  │  解析 argc/argv/envp/auxv，初始化运行库
  ▼
main 和 libc API
  ├── printf        → 格式解析、FILE 缓冲、write
  ├── va_args       → 体系结构 ABI
  ├── setjmp        → 保存/恢复机器执行环境
  ├── gettimeofday  → vDSO 或系统调用
  └── malloc        → 用户态数据结构，偶尔向内核要页
```

这两条线最终汇合：一条线说明 libc 如何遮住 ISA 与 ABI 的差异；另一条线以 `malloc/free` 为例，说明一个极简 API 如何把实现者推向 workload、并发、局部性和碎片等现实问题。

下一讲将继续追问本讲已经暴露出的对象：`crt1.o` 从哪里来？为什么源文件、目标文件和库能组成一个可执行文件？调试段为何能与代码段共处？内核又怎样按 ELF 描述装入程序？因此，本讲也是进入 ELF、链接与加载的入口。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 解释为什么控制 `_start`、FFI/inline assembly 和系统调用后，原则上可以在 freestanding 环境重建一套 libc；
- 编译一份带调试信息、低优化的 musl，并验证产物而不是相信自动化工具的口头报告；
- 区分机器码、符号表、DWARF 调试信息、unwind 信息和 JavaScript source map；
- 说明调试器如何从 PC、寄存器和内存重构栈帧、源码行和变量；
- 从 initial process stack 推导 `crt1.o` 的职责，并解释为什么入口不是 `main`；
- 跟踪 `printf` 从格式串、`va_list`、`FILE` 缓冲到 `write` 的路径；
- 解释旧式“在 `&n` 后面找变参数”的 hack 为何不是可移植 C，在现代 ABI 上又为何必然失效；
- 用机器状态模型解释 `setjmp/longjmp`，并列出它不负责恢复的资源状态；
- 解释 `gettimeofday` 为什么可能成功返回、却不在 `strace` 中出现系统调用；
- 从“内核只给大块虚拟内存”推导出 `malloc` 必须在用户态维护数据结构；
- 用 `mini_malloc` 观察对齐、块头、切分、first-fit 与复用，并指出它缺失的真实约束；
- 说明为什么分配器优化必须以 workload 为前提，以及 fast/slow path、size class、slab 和线程本地状态各自交换了什么；
- 把 AI 用在设计空间探索、测量和反例生成上，同时保留正确性 oracle 和机制边界。

问题地图：

| 问题 | 最小答案 | 可观察证据 |
| --- | --- | --- |
| 去掉 debug info，程序还能运行吗？ | 通常能；调试信息不是执行语义的一部分 | `strip --strip-debug` 前后运行并比较 |
| DWARF 只是“地址到行号”表吗？ | 不是；它还能描述类型、作用域、变量位置和栈展开规则 | `readelf --debug-dump=*`、GDB |
| `main` 的三个参数是谁传的？ | libc 启动代码从内核构造的初始栈解析后调用 `main` | `starti`、`x` 查看入口栈 |
| `printf` 是否等于一次 `write`？ | 不等于；格式化和缓冲在用户态，`write` 的次数由缓冲状态决定 | `strace -e write` |
| `va_list` 是普通指针吗？ | 标准不保证；它是 ABI 相关类型 | GDB `ptype va_list`、编译器头文件 |
| `longjmp` 会“撤销”中间函数做过的事吗？ | 不会；它恢复一部分执行环境，不回滚堆、文件、锁或外部世界 | 可执行长跳转实验 |
| 时间函数没出现在 `strace`，是否没用内核数据？ | 不是；它可能在 vDSO 中读内核维护的共享时间数据 | auxv、`[vdso]` 映射、单步执行 |
| `malloc(24)` 是否让内核分配 24 字节？ | 通常不是；分配器先取得较大区域，再自行切分 | `mini_malloc` 与 `mmap/brk` 跟踪 |
| 平衡树能否解决 allocator？ | 能表达区间，但未必适合最热的小对象路径 | workload、锁竞争与复杂度测量 |

## 2. 使用自己的 libc：控制 `_start` 后，地基也是可以重建的

### 2.1 从 freestanding 结论继续推导

freestanding 环境不是“不能写 C”，而是不能假设 host 环境已经替你提供完整运行库。编译器仍可把算术、访存和控制流翻译为指令；体系结构相关头文件仍可描述整数宽度、对齐等事实。缺少的是启动、I/O、内存来源、线程和退出等 hosted services。

如果我们能做到三件事：

1. 提供链接器认可的入口 `_start`；
2. 按目标平台 ABI 与汇编代码互调，必要时发出 inline assembly；
3. 按系统调用 ABI 把编号和参数放入规定寄存器并执行陷入指令；

那么 `exit`、`write`、`mmap` 等最底层能力就能自行实现。在它们之上继续写字符串函数、stdio、启动代码和分配器，最终就能形成一套 libc。这里的“什么都能实现”是原则上的完备性，不等于工程上简单：信号、线程局部存储、浮点环境、区域设置、动态链接与各架构 ABI 都会迅速增加复杂度。

因此，自有 libc 的价值不是重复造轮子，而是得到一个可控实验对象：编译选项、源代码和二进制一一对应，断点能落到实现内部，机器状态不再被发行版 glibc 的优化和历史兼容层淹没。

### 2.2 为什么选 musl

glibc 当然可以调试，但它服务了漫长历史中的大量 ABI、性能和兼容性要求。对第一次阅读运行库的学生，复杂的宏、符号版本、IFUNC 和多套优化路径很容易遮住主线。musl 的目标和代码组织更适合建立最小模型；“更适合学习”不表示它是玩具，更不表示它没有优化或平台相关代码。

一个典型的本地构建过程如下。它需要 Git、C 编译工具链和网络；路径可以自行调整：

```bash
git clone --depth=1 https://git.musl-libc.org/cgit/musl
cd musl
CFLAGS='-Og -ggdb3 -fno-omit-frame-pointer' \
  ./configure --enable-debug --prefix="$PWD/../musl-debug"
make -j"$(nproc)"
make install
```

然后用生成的 wrapper 编译一个静态小程序：

```bash
../musl-debug/bin/musl-gcc -static -Og -ggdb3 hello.c -o hello-musl
readelf -h hello-musl | rg 'Class|Machine|Entry point'
readelf -S hello-musl | rg '\.debug_|\.symtab'
file hello-musl
```

这里最重要的不是把命令交给 Agent 后等待一句“搞定了”，而是建立验收链：

- 配置日志中实际采用了什么编译器和 `CFLAGS`？
- 目标文件里是否真的存在 `.debug_info`、`.debug_line` 等 section？
- 最终程序是否真由目标 musl 链接，是否真为预期的静态/动态形式？
- GDB 的源码路径是否指向刚才编译的那份源树？
- `disassemble /m` 是否能把指令与源代码对应起来？

讲义中“上次让模型搞定、结果模型幻觉完成”的课堂插曲，指向的正是系统实验的基本纪律：**生成过程可以自动化，完成状态必须由产物和行为证明。**

### 2.3 一个可复用的 musl 调试协议

假设程序由带调试信息的 musl 静态链接：

```bash
gdb -q ./hello-musl
(gdb) set pagination off
(gdb) info files
(gdb) starti
(gdb) x/12i $pc
(gdb) info registers
(gdb) break main
(gdb) continue
```

`starti` 停在 ELF 入口；`info files` 给出入口与 section 范围；随后可在 `_start`、libc startup、`printf` 等符号处设断点。每次追踪都同时保留三种证据：

```text
GDB：当前 PC、调用栈、变量和指令
strace：真正越过用户/内核边界的系统调用
readelf/objdump：文件中静态存在的入口、符号、段和反汇编
```

三者回答的问题不同，互相对照才能避免把 PLT 跳转、用户态 wrapper 或 vDSO 误认为内核陷入。

## 3. Aside：Debug Info 如何把机器状态重新解释成“程序意义”

### 3.1 二进制文件不只有要执行的指令和数据

处理器只需要装入的代码、数据和描述其映射方式的信息。调试器却希望回答更高级的问题：

- PC 对应哪一个源文件、哪一行？
- 当前调用栈有哪些函数？
- 某个局部变量是什么类型，现在存在哪里？
- 一个值是保存在寄存器、栈槽，还是已被优化掉？
- 怎样从当前栈帧恢复调用者的 PC 和栈指针？

符号表 `.symtab` 能把部分地址关联到函数或对象名，是最粗略的“恢复意义”。但只有函数起始地址仍不足以精确得到源码行、词法作用域、类型和变量位置。传统 GCC 也曾支持 STABS（如 `.stab`）一类格式；现代 Linux 工具链的主角是 DWARF。

### 3.2 DWARF 不是一张静态对照表

常见 DWARF section 各有职责：

| section（名称可能带压缩/拆分变体） | 典型内容 |
| --- | --- |
| `.debug_info` | 编译单元、函数、变量、类型和作用域 |
| `.debug_abbrev` | `.debug_info` 使用的紧凑描述格式 |
| `.debug_line` | 指令地址与源文件/行列的状态机映射 |
| `.debug_str` | 调试字符串池 |
| `.debug_loclists` | 不同 PC 范围内变量的位置表达式 |
| `.debug_ranges` / `.debug_rnglists` | 对象或作用域覆盖的地址范围 |
| `.debug_frame` | 调试用的调用帧展开规则 |
| `.eh_frame` | 运行时常保留的展开信息，常供异常处理与 backtrace 使用 |

DWARF expression 是一套小型栈式字节码。它可以表达“变量在寄存器 r 中”“变量位于 frame base 减去某偏移”“值由若干寄存器和内存组合计算”等规则；location list 又允许规则随 PC 区间改变。于是优化后，一个源语言变量可能先在寄存器，后来在栈上，某些区间根本没有可恢复的值。

这也解释了 GDB 的 `<optimized out>`：不是调试器偷懒，而是编译器已经删除、合并或重排了该值，现存机器状态不足以唯一恢复源语言对象。`-Og -ggdb3` 只是让观察更友好，不会把优化后的程序变回逐句解释器。

### 3.3 调试信息、展开信息和执行语义要分开

几个容易混淆的结论：

- 删除 `.debug_*` 后，正常程序通常仍能运行，因为 CPU 不执行这些 section；
- 删除全部静态符号后，动态链接仍可能需要的 `.dynsym` 不能随意消失；
- C++ 异常和部分 backtrace 依赖的 unwind tables 可能在 release binary 中保留，即使完整调试信息已被剥离；
- frame pointer 可以帮助展开栈，但 DWARF CFI 也能描述无 frame pointer 的栈帧；优化、尾调用、手写汇编或栈损坏仍可能让回溯不完整；
- debug info 描述的是“怎样解释机器状态”，不会让本来错误的程序变正确。

### 3.4 JavaScript source map 泄漏案例：映射文件也可能就是源代码

压缩或 bundle 后的 JavaScript 很难阅读，因此工具链常生成 `.map` 文件，把生成代码位置映射回原始文件、名字和位置。source map 是 JSON，关键字段可抽象为：

```json
{
  "version": 3,
  "file": "bundle.js",
  "sources": ["src/index.js"],
  "names": ["map", "callbackFn"],
  "mappings": "AAAA,...",
  "sourcesContent": ["const x = 1; /* ... */"]
}
```

`mappings` 已能泄露结构和原始名字；若 `sourcesContent` 存在，原始源码文本会直接随 map 发布。讲义以 Claude Code 的 `cli.js.map` 外泄及随后出现可运行逆向版本为案例。这里不应把问题误解为“调试格式不安全”：调试产物忠实完成了它的职责，错误在发布边界没有把内部产物与公开产物分开。

可落实为 CI 检查：

- 发布包是否含 `.map`、`.debug`、未预期的 `.pdb` 或独立 debug file？
- source map 是否嵌入 `sourcesContent`、内部绝对路径、私有模块名或密钥样例？
- 容器镜像、npm 包、release archive 和 Web 静态目录是否执行了同一套审计？
- 若线上确实需要 source map，是否将它存放在受控的错误监控服务，而不是公开静态路径？

“strip 一下”也不是秘密管理方案。机器码本身仍可逆向；调试信息只是在无意中把恢复成本大幅降低。密钥更绝不能依赖删符号来保护。

### 3.5 Debug Info 的作用：重构程序意义

一旦能把低级状态映射回函数、代码行和变量，许多工具就建立在同一能力上：

- stack unwinding 与 backtrace；
- `perf`、Perfetto、采样 profiler 和 flame graph；
- core dump 的离线诊断；
- AddressSanitizer/UndefinedBehaviorSanitizer 报告中的符号化；
- 崩溃收集平台的版本匹配和源码定位；
- C++ 异常处理中基于调用帧信息的栈展开。

![火焰图把采样到的机器地址重新聚合为调用栈](../../sources/site_html/static/img/flame-graph.svg)

火焰图的横向宽度通常代表样本占比而非时间轴；纵向表示调用栈层级。若缺少符号或展开失败，图上就会出现裸地址、`[unknown]` 或错误栈。这正是“程序意义”无法完整恢复的可视化结果。

### 3.6 实验 1：亲手删除 debug info，再比较可观察性

以下命令可在仓库根目录执行，依赖 GCC/Clang、binutils 和 GDB：

```bash
dbgdir=$(mktemp -d) || exit 1
[ -n "$dbgdir" ] && [ -d "$dbgdir" ] || exit 1
cat >"$dbgdir/dwarf-demo.c" <<'EOF'
#include <stdio.h>
#include <stdlib.h>

static int twice(int value) {
  int result = value * 2;
  return result;
}

int main(void) {
  int answer = twice(21);
  if (printf("answer=%d\n", answer) < 0) {
    return EXIT_FAILURE;
  }
  return EXIT_SUCCESS;
}
EOF

cc -Og -ggdb3 -fno-omit-frame-pointer \
  "$dbgdir/dwarf-demo.c" -o "$dbgdir/dwarf-demo"
readelf -S "$dbgdir/dwarf-demo" | rg '\.debug_|\.symtab'
readelf --debug-dump=decodedline "$dbgdir/dwarf-demo" | sed -n '1,30p'
gdb -q -batch \
  -ex 'break twice' -ex run -ex 'info locals' -ex backtrace \
  "$dbgdir/dwarf-demo"

cp "$dbgdir/dwarf-demo" "$dbgdir/dwarf-demo.stripped"
strip --strip-debug "$dbgdir/dwarf-demo.stripped"
readelf -S "$dbgdir/dwarf-demo.stripped" | rg '\.debug_' || true
"$dbgdir/dwarf-demo.stripped"
```

预期现象：原文件能列出 `.debug_*`，GDB 在 `twice` 中知道源码与 `result`；剥离调试信息后程序仍打印 `answer=42`，但源码行和局部变量信息消失或明显退化。若只使用 `--strip-debug`，部分普通符号可能仍在；想观察更激进的符号剥离，可以在副本上另试 `strip --strip-all`，不要对唯一产物操作。

这个实验同时区分了两个命题：“程序能执行”和“人能从机器状态恢复其意义”。二者所需的信息集合并不相同。

## 4. 探索 libc 实现：重新调试那个“最简单”的 C 程序

### 4.1 小程序不小，只是复杂性被分层藏起来了

一段 `printf("hello\n")` 看起来只有一行，实际路径可能包含：

```text
execve
  → ELF 装入/动态加载（若有）
  → _start
  → libc 初始化
  → main
  → printf/vfprintf
  → stdout 的 FILE 状态与缓冲
  → write 或内部 syscall stub
  → 内核文件描述符 1
  → 终端/管道/普通文件对象
  → exit、flush、析构与 _exit
```

这正是课程 musl demo 的目的：不是再学一次 `printf` 的用法，而是沿着每条指令把程序、ABI、libc 与内核接起来。调试时最好从一个无输入、输出固定的程序开始；复杂业务逻辑只会给追踪增加噪声。

### 4.2 `crt1.o`：从 initial process stack 反推初始化代码

对一个静态 ELF，内核完成 `execve` 后会把 PC 设置为 ELF entry，并构造初始用户栈。System V ABI 下可用下面的最小模型理解（具体对齐和辅助数据由 ABI 规定）：

```text
初始 SP ──> argc
            argv[0]
            argv[1]
            ...
            argv[argc - 1]
            NULL
            envp[0]
            envp[1]
            ...
            NULL
            auxv[0].a_type, auxv[0].a_val
            auxv[1].a_type, auxv[1].a_val
            ...
            AT_NULL, 0
            参数/环境字符串、随机字节等辅助数据
```

内核并不知道 C 的 `main` 函数语义，也不会替 libc 给全局变量 `environ` 赋值。`crt1.o` 提供入口 `_start`，把初始 SP 交给 libc startup；后者解析 `argc/argv/envp/auxv`，完成实现所需的 TLS、栈保护、构造器和运行库状态初始化，最后调用 `main`。`main` 返回后，启动代码再走正常退出路径。

这个过程允许我们“从代码反推初始栈”：若 `_start` 先从 SP 读一个机器字作为计数，随后按指针数组寻找两个 `NULL` 分隔符，再按键值对读取 auxiliary vector，就能反推出上图。反过来，在入口断住并按图解释内存，也能验证 ABI。

动态链接程序要多一层：内核根据 ELF 的 interpreter 信息先把控制权交给动态加载器，加载器完成依赖装入和重定位后，再抵达程序入口。无论静态还是动态，程序仍需要某种启动代码把裸入口状态转换成 C 运行环境；`crt1.o` 因而也会成为下一讲链接过程的重要证物。

### 4.3 从第一条指令观察入口栈

以自己编译的静态 musl 小程序为例：

```bash
gdb -q ./hello-musl
(gdb) starti
(gdb) info files
(gdb) info registers
(gdb) x/24gx $sp
(gdb) x/12i $pc
(gdb) info auxv
```

x86-64 的栈寄存器名是 `$rsp`，AArch64 通常是 `$sp`；GDB 的 `$sp` 别名更便于写跨架构笔记。先用 `x/gx $sp` 读 `argc`，再把后续机器字解释为指针，并用 `x/s ADDRESS` 检查 `argv`/`envp` 字符串。不要把示例中的固定偏移背成规则：参数数量和环境数量改变后，auxv 的位置也会改变，正确算法必须扫描分隔 `NULL`。

用 `strace` 跟踪一个几乎不做事的静态 dummy 程序时，系统调用序列可能非常短；这不是“程序没有初始化”，而是大量初始化只读写用户态内存，不需要陷入内核。动态程序的装载相关活动则可能主要发生在 `execve` 内部和动态加载器中。

## 5. 调试 `printf` 和 `va_args`：一行输出横跨 API、ABI 与内核

### 5.1 `printf` 的主体并不是系统调用

`printf` 至少要做这些工作：

1. 解析普通字符、标志、宽度、精度、长度修饰和转换说明；
2. 根据格式从 `va_list` 中以正确类型取值；
3. 把整数、浮点数、指针或字符串转换为字符；
4. 更新 `stdout` 对应的 `FILE` 状态；
5. 写入用户态缓冲，必要时 flush；
6. 最终通过 fd 1 发出 `write` 或等价底层操作。

因此 `printf` 不是 `write` 的别名，一次 `printf` 也不承诺恰好一次系统调用。许多小输出可以合并为一次 `write`；一个很大的格式化结果也可能拆成多次写。终端、普通文件和管道还可能触发不同缓冲策略。

`stdout` 是 libc 暴露的对象引用，而 `struct FILE` 的具体字段属于实现内部。调试 musl 时可以观察读写指针、缓冲区边界、底层 fd 和锁等状态；换到 glibc，字段名和组织方式会不同。应用只能依赖标准 API，不能把某份 musl 的 `FILE` 布局当成 C 标准。

### 5.2 为什么 `vfprintf` 是消除重复的关键

`printf`、`fprintf`、`snprintf` 等函数的目标不同，但格式解析逻辑高度相似。标准库用接收 `va_list` 的 `vprintf`/`vfprintf`/`vsnprintf` 家族共享主体：普通变参数 wrapper 建立 `va_list`，再转给统一实现。

这也是理解库设计的一条一般原则：把“参数如何抵达”与“格式化策略”分离。前者由 ABI 和 `stdarg.h` 解决，后者由可复用的格式化核心解决。

### 5.3 旧 cdecl hack 为什么失效

课堂给出的反例是：

```c
/* 反例：标准 C 中行为未定义，不要这样访问变参数。 */
void foo(int n, ...) {
  intptr_t *vargs = (intptr_t *)&n;
  /* 误以为 vargs[1]、vargs[2]……就是后续实参。 */
}
```

在某些旧式 32-bit、纯栈传参、类型布局恰好匹配的 cdecl 场景，它可能“看起来能用”；但从 C 语言层面它一直没有保证。现代 ABI 更直接地粉碎了这个假设：

- x86-64 System V 把一部分整数/指针参数放通用寄存器，把浮点参数放向量寄存器，超出部分才上栈；`va_list` 通常还需记录 GP/FP offset、寄存器保存区和 overflow area；
- AArch64 同样区分通用与 SIMD/浮点参数寄存器，并规定寄存器保存区；
- RISC-V 也优先使用参数寄存器，只有放不下的参数进入栈；
- 默认参数提升会把 `float` 提升为 `double`，把部分窄整数提升为 `int`；格式与真实类型不匹配是未定义行为。

唯一可移植方式是 `va_start`、`va_arg`、`va_copy` 和 `va_end`。甚至 `va_list` 自身可能是数组或结构体，不能擅自假定它可按普通指针复制。

### 5.4 实验 2：同时观察 `va_list`、stdio 缓冲与 `write`

```bash
cat >/tmp/printf-va.c <<'EOF'
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

static int show_pairs(int count, ...) {
  va_list ap;
  va_start(ap, count);
  for (int i = 0; i < count; i++) {
    const char *name = va_arg(ap, const char *);
    int value = va_arg(ap, int);
    if (printf("%s=%d ", name, value) < 0) {
      va_end(ap);
      return -1;
    }
  }
  va_end(ap);
  return 0;
}

int main(void) {
  if (show_pairs(3, "alpha", 1, "beta", 2, "gamma", 3) < 0) {
    return EXIT_FAILURE;
  }
  if (putchar('\n') == EOF || fflush(stdout) == EOF) {
    return EXIT_FAILURE;
  }
  return EXIT_SUCCESS;
}
EOF

cc -Og -ggdb3 /tmp/printf-va.c -o /tmp/printf-va
/tmp/printf-va
strace -e trace=write /tmp/printf-va
gdb -q /tmp/printf-va
```

在 GDB 中可尝试：

```text
(gdb) break show_pairs
(gdb) run
(gdb) ptype va_list
(gdb) next
(gdb) p ap
(gdb) break vfprintf
(gdb) continue
```

预期输出是 `alpha=1 beta=2 gamma=3`。`strace` 通常会看到输出被缓冲后合成少量 `write`，但确切次数是实现和输出目标的性质，不是 C 标准契约。把输出重定向到普通文件再比较，可以观察缓冲策略的变化；不要用一次机器上的次数推导“所有 libc 必须如此”。

若用带源码的 musl 静态链接版本，断点能继续进入格式解析和内部 `FILE` 写路径；最后把看到的底层调用与 `strace` 对齐，就得到从高级 API 到内核边界的完整证据链。

## 6. 调试 `setjmp/longjmp`：保存的是执行环境，不是世界快照

### 6.1 用状态机理解长跳转

普通函数调用把返回位置和必须保存的机器状态按 ABI 放入栈或寄存器。`setjmp(env)` 记录一个足以恢复当前调用环境的实现相关表示，第一次返回 0。之后 `longjmp(env, value)` 恢复该环境，让原来的 `setjmp` 像“再次返回”一样得到 `value`；若传入 0，标准规定它看到 1。

最小抽象模型可以写成：

```text
setjmp:
  env ← {恢复点 PC、SP、ABI 要求保存的寄存器、实现元数据……}
  return 0

longjmp(env, x):
  恢复 env 中的执行环境
  让 setjmp 返回 (x == 0 ? 1 : x)
```

讲义提出一个很有启发性的机器级 trick：在 `setjmp` 前把一组寄存器设为可识别图案，保存后再改写这些寄存器，执行 `longjmp` 后比较哪些值恢复。恢复的集合能帮助逆向 callee-saved 寄存器，没恢复的则是 caller-saved（更直观地说 call-clobbered）寄存器。对 AArch64 等架构，这是一种从实现反推 calling convention 的实验方法。

不过可靠执行它需要受控汇编函数，避免编译器把实验寄存器拿去做别的事；不能把一段随意 inline assembly 当成跨架构答案。更稳妥的学习顺序是先看 ABI 文档和 musl 汇编实现，再用 GDB 在 `setjmp/longjmp` 两侧保存 `info registers` 输出进行验证。

### 6.2 它明确不做什么

`longjmp` 不是事务回滚：

- 不会 `free` 中间路径申请的堆内存；
- 不会自动关闭 fd、撤销 `write` 或恢复文件偏移；
- 不会释放 mutex，持锁后跳走可能永久死锁；
- 不执行被跨过的普通 C 清理逻辑；
- 不能跳回已经返回的函数栈帧；那里的环境已失效；
- 被 `setjmp` 所在函数中，在 `setjmp` 后修改、又非 `volatile` 的自动变量，长跳后其值可能不确定；
- `setjmp` 不承诺保存信号 mask；需要相应语义时应研究 `sigsetjmp/siglongjmp`。

在 C++ 中跨过本应执行的析构尤其危险；RAII 与任意长跳不自然兼容。长跳适合非常受控的错误边界、解释器或底层运行库机制，不应成为日常控制流的替代品。

### 6.3 实验 3：观察“一处返回两次”

```bash
cat >/tmp/jump-demo.c <<'EOF'
#include <setjmp.h>
#include <stdio.h>
#include <stdlib.h>

static jmp_buf checkpoint;

static void deeper(void) {
  longjmp(checkpoint, 7);
}

int main(void) {
  volatile int changed = 1;
  int result = setjmp(checkpoint);
  if (result == 0) {
    changed = 2;
    deeper();
  }
  if (printf("setjmp returned %d, changed=%d\n", result, changed) < 0) {
    return EXIT_FAILURE;
  }
  return result == 7 && changed == 2 ? EXIT_SUCCESS : EXIT_FAILURE;
}
EOF

cc -Og -ggdb3 /tmp/jump-demo.c -o /tmp/jump-demo
/tmp/jump-demo
gdb -q /tmp/jump-demo
```

GDB 中在 `deeper`、`longjmp` 和 `main` 的 `setjmp` 后一行设断点，观察 backtrace 与 `info registers`。预期最终只打印 `setjmp returned 7, changed=2`：第一次返回 0 后进入 `deeper`，第二次控制流直接回到保存点，不会从 `deeper` 正常返回。变量声明为 `volatile` 是为了让长跳后的值有标准保证；删去它后“这次仍打印 2”也不能证明程序可移植。

## 7. 调试 `gettimeofday`：没有出现在 `strace` 里，不等于没有内核参与

### 7.1 为什么时间读取值得特殊优化

如果每次读时间都执行传统系统调用，就要经历用户态/内核态边界。内核可以把一小段受控代码以 vDSO（virtual dynamic shared object）映射进每个进程，并把必要的只读/受协议保护数据暴露给这段代码。libc 在用户态调用 `__vdso_gettimeofday` 或相关符号，就可能在不执行陷入指令的情况下计算结果；必要时仍可回退到真正系统调用。

这不表示用户程序凭空知道时间。时间基准和校正数据仍由内核维护，vDSO 只是把常见只读路径搬到用户态。实现还必须处理数据更新期间的一致性，具体协议属于内核与 vDSO 的 ABI。

程序怎样找到 vDSO？initial process stack 中的 auxiliary vector 提供 `AT_SYSINFO_EHDR` 等信息，指出 vDSO ELF 映像的位置。musl 启动时记录 auxv，时间函数路径再查找相应版本化符号。于是本节正好把 `crt1.o`、auxv、ELF 符号和 libc wrapper 串起来。

### 7.2 `strace` 的能力边界

`strace` 主要观察系统调用进入/退出。若 `gettimeofday` 完全在 vDSO 执行，程序能打印时间而跟踪中没有 `gettimeofday`，这是预期现象。它能支持“本次执行未观察到相应系统调用”，却不能单独证明调用了哪一个 vDSO 符号；还需结合映射、auxv 和指令轨迹。

此外，墙上时间可能因校时而向前或向后跳。计算耗时时通常应选择 `clock_gettime(CLOCK_MONOTONIC, ...)` 一类单调时钟，而不是因为 `gettimeofday` 快就把它当持续时间计时器。API 的语义与实现路径是两个问题。

### 7.3 实验 4：让 `strace` 的“空白”成为证据，而不是结论

```bash
cat >/tmp/vdso-time.c <<'EOF'
#include <stdio.h>
#include <stdlib.h>
#include <sys/time.h>

int main(void) {
  struct timeval tv;
  if (gettimeofday(&tv, NULL) == -1) {
    perror("gettimeofday");
    return EXIT_FAILURE;
  }
  if (printf("%lld.%06ld\n", (long long)tv.tv_sec, (long)tv.tv_usec) < 0) {
    return EXIT_FAILURE;
  }
  return EXIT_SUCCESS;
}
EOF

cc -Og -ggdb3 /tmp/vdso-time.c -o /tmp/vdso-time
strace -e trace=gettimeofday,clock_gettime /tmp/vdso-time
grep '\[vdso\]' /proc/self/maps
gdb -q /tmp/vdso-time
```

在 GDB 中：

```text
(gdb) start
(gdb) info auxv
(gdb) info proc mappings
(gdb) break gettimeofday
(gdb) continue
(gdb) disassemble gettimeofday
(gdb) stepi
```

常见结果是程序输出时间，而 `strace` 除退出摘要外看不到所筛选的时间系统调用，同时映射中存在 `[vdso]`。不同 libc、内核、架构、虚拟化环境或调试方式可能触发 fallback；若真的看到系统调用，同样是有效结果。进一步使用自己带源码的 musl 单步，才能看清获取实际入口地址、间接调用和回退的具体实现。

## 8. 动态内存分配：一个简单 API，背后是一整个用户态内存管理系统

### 8.1 `malloc/free` 给调用者的最小模型

最常见的接口只有：

```c
void *pointer = malloc(size);
/* 在契约允许的范围内使用从 pointer 开始的 size 个字节 */
free(pointer);
```

它让链表、树和可变数组不必预先知道对象数量。成功的 `malloc(n)` 返回满足基本对齐要求、与其他活动分配不重叠的空间；失败返回 `NULL`。`free(NULL)` 是无操作，但释放非分配起点、重复释放，或释放后继续访问都违反契约。

边界语义也不能凭直觉：`malloc(0)` 可以返回 `NULL`，也可以返回一个之后可传给 `free`、但不可解引用的指针；`realloc` 可能移动对象；`calloc(count, size)` 还要正确处理乘法溢出。API 很短，不代表证明义务很少。

### 8.2 内核通常不提供“给我 24 字节”

内核地址空间接口面向页和映射区域。用户态分配器通常通过 `mmap(MAP_ANONYMOUS, ...)` 或进程 break 相关机制取得较大虚拟内存，再在其中维护小块。`sbrk` 是历史悠久的 libc 接口；现代实现可以混用不同来源和策略，不应把某个阈值当标准。

```text
应用：malloc(24), malloc(80), free(...)
             │
             ▼
用户态 allocator：元数据、空闲集合、切分、合并、缓存、并发控制
             │ 偶尔申请/归还大区域
             ▼
内核：brk / mmap / munmap，管理页表与虚拟地址区域
             │ 首次访问时可能缺页
             ▼
物理页、交换、文件或零页
```

成功映射很大的虚拟范围不等于相同数量物理内存已经立即分配。按需分页、overcommit 和零页会让“地址空间看起来够大”；真正逐页写入时才可能触发分配，并在资源不足时遭遇失败或被 OOM 机制处理。这承接了地址空间一讲的实验。

### 8.3 allocator 是“在内存上实现数据结构”

拿到一个 region 后，分配器至少要回答：

- 哪些区间正在使用，哪些空闲？
- 请求大小怎样对齐？
- 从哪一块满足请求，剩余空间是否切分？
- `free(pointer)` 怎样找回大小和归属？
- 相邻空闲块是否、何时合并？
- 元数据放在哪里，怎样避免被越界写破坏？
- 多线程同时分配/回收时，线性化点在哪里？
- 何时把页还给内核，何时留在缓存以服务下一次请求？

所以 `malloc` 不是系统调用薄 wrapper；它是一个长寿命、并发、性能敏感的数据结构系统。

## 9. 用 `mini_malloc` 建立最小分配器模型

### 9.1 代码布局

仓库中的 [mini_malloc.c](../../examples/mini_malloc.c) 刻意只保留教学主线。它在静态的 4096 字节 `arena` 上组织块：

```text
arena
┌──────── Block header ────────┬──── payload ────┬── next header ──┬── ... ──┐
│ size | next | free           │ 返回给调用者     │ size|next|free  │         │
└──────────────────────────────┴──────────────────┴─────────────────┴─────────┘
^ block                         ^ block + 1
```

初始化时只有一个大空闲块。`toy_alloc` 先把大小向 16 字节对齐，再从链表头开始找第一个足够大的空闲块：

```c
for (Block *block = head; block != NULL; block = block->next) {
  if (block->free && block->size >= size) {
    split(block, size);
    block->free = 0;
    return block + 1;
  }
}
```

`split` 仅在剩余空间还能容纳一个块头和最小 payload 时创建尾块；`toy_free` 则由 payload 指针退回一个块头并标记为空闲。示例先分配 `a`、`b`，释放 `a` 后再申请更小的 `c`，于是 first-fit 复用 `a` 的位置。

### 9.2 它展示了什么，又故意缺少什么

它已经展示：

- 对齐不是可选优化，而是返回指针的 ABI 契约；
- 管理信息会占空间，payload 前后的算术必须避免溢出和越界；
- 切分把一个空闲区间替换为“已用前段 + 空闲尾段”；
- `free` 后的地址可被下一个请求复用，旧指针因此立即成为危险别名；
- first-fit 的运行时间和链表长度有关。

它故意没有实现：

- 相邻空闲块合并，因此会产生外部碎片；
- arena 扩展和向内核归还页；
- 非法指针、double free 和元数据破坏检测；
- 大小加法与对齐中的完备溢出处理；
- `calloc`、`realloc` 和完整 `malloc` 标准边界；
- 多线程同步、线程本地缓存和跨线程回收；
- 安全加固、统计、采样与 sanitizer hooks。

所以它是可观察的最小模型，不是生产 allocator，也不是 M5 答案。

### 9.3 实验 5：复用 `mini_malloc` 观察切分、复用和系统调用边界

从仓库根目录执行：

```bash
cc -std=c11 -O0 -g -Wall -Wextra -Wpedantic \
  examples/mini_malloc.c -o /tmp/mini_malloc
/tmp/mini_malloc
nm -S /tmp/mini_malloc | rg ' arena| head|toy_alloc|toy_free'
strace -e trace=brk,mmap,munmap /tmp/mini_malloc
gdb -q /tmp/mini_malloc
```

GDB 中依次观察三次分配：

```text
(gdb) break toy_alloc
(gdb) run
(gdb) p size
(gdb) p head
(gdb) next
(gdb) p *head
(gdb) continue
(gdb) p *head
(gdb) continue
(gdb) p *head
(gdb) x/16gx arena
```

预期输出中的 `c` 与 `a` 相对 `arena` 的偏移相同，证明释放块被 first-fit 复用；具体数字取决于 ABI 下 `Block` 的大小和布局，不应硬编码。`nm` 会显示 `arena` 是程序静态对象。`strace` 仍可能看到动态加载器或宿主 libc 为启动、stdio 所做的 `mmap/brk`，但 `toy_alloc` 本身不会为每次请求调用它们——它只切静态数组。

这个“看见系统调用，却不能归因给 toy allocator”的细节很重要。若要建立因果关系，应在 `toy_alloc` 断点附近对齐时间顺序，或把输出路径也改成最小 syscall 实现，而不能只凭整段 `strace` 猜测。

可以继续做但本章不直接实现的练习：设计一组分配/释放序列，让空闲总量足够、却因不合并而无法满足较大请求；先画块布局并写下不变量，再在 `/tmp` 副本上实验。

## 10. Aside：`malloc/free` 这个接口把什么难题交给了人

### 10.1 “最小完备”不等于“容易正确使用”

讲义借 Tony Hoare 对空引用的著名反思，引出接口设计问题。这里要注意：空引用与 `malloc/free` 不是同一个错误；引用它是为了强调，一个极小、极方便的抽象选择可能把巨大的长期证明成本散布给整个生态。

`open/write` 之上可以再包一层 `Pathlib`，在许多场景中只是改善组合和错误处理。手工堆管理更棘手：每一条可能控制路径都要保证所有权最终被正确释放，释放前无人越界写，释放后所有别名都不再访问，并发线程也没有正在使用它。局部看只有两次函数调用，全程序看却是生命周期证明。

失败模式包括：

- memory leak：失去最后一个可达引用，资源却仍占用；
- use-after-free：块已归还或复用，旧指针仍被读写；
- double free / invalid free：破坏 allocator 内部结构；
- concurrent use-after-free：一个线程判断对象仍活着时，另一个线程回收；
- 越界写：先破坏相邻 payload 或元数据，许久后才在不相关 `malloc/free` 处爆炸。

### 10.2 语言和运行时提出了不同回答

- managed runtime 用可达性、追踪 GC 等机制自动回收，减少显式释放证明，但仍可能因错误保留引用而逻辑泄漏，并带来停顿、吞吐和内存占用策略；
- C++ RAII 把释放绑定到对象生命周期和作用域，异常路径更容易正确，但别名与并发仍需设计；
- Rust ownership/borrowing 把大量生命周期约束移到类型系统，unsafe/FFI 和共享并发边界仍要人工证明；
- arena/region 把一组对象绑定到共同生命周期，用更粗的释放粒度换简洁；
- 引用计数让回收时机局部化，但循环引用、原子计数和并发销毁仍有代价。

这说明机制与策略分离的两面：统一 `malloc/free` 让应用无需关心页来源和放置策略，却也要求通用 allocator 猜测极其多样的 workload；自动运行时减少调用者策略，又必须承担更复杂的机制和性能取舍。

## 11. 从课堂问题到 M5：先写规格、观测和不变量，不给实现答案

讲义对 allocator 作业给出一条直觉：大请求可以直接从大区域机制取得；小请求则需要在 region 中管理不相交的小区间，支持查找与删除。若只从抽象数据结构题出发，很容易立刻想到平衡树。

平衡树并非逻辑上错误。它能维护有序区间，也可能出现在真实分配器的某些 slow path 或大 extent 管理中。幻灯片上的叉号针对的是未经 workload 分析就把全局 `O(log n)` 查找、指针追逐和共享锁放进每次小对象分配的思路：表达能力正确，不代表热路径合适。

对 M5，应先从公开规格建立验证问题：

- 正确性：活动区间是否始终互不重叠、满足大小和对齐，释放后状态怎样变化？
- 并发：每个操作在哪一刻生效，哪些元数据可能被两个处理器同时访问？
- 空间：元数据、内部碎片、外部碎片和缓存滞留怎样计量？
- 进度：耗尽、竞争和跨线程释放时能否返回或继续前进？
- 环境：freestanding 条件下哪些 libc/pthread 假设不可用，框架实际提供什么？
- 测试：怎样生成有 oracle 的随机 trace、并发压力和边界案例，怎样减小失败输入？
- 测量：吞吐、尾延迟、映射次数、锁竞争和峰值内存分别如何采样？

本章不会给出 size class 参数、完整元数据布局、同步协议、可提交伪代码或任何 M5 实现。`mini_malloc` 只能帮助理解单线程切分与复用；直接扩写它并不能自动满足 M5 的并发、空间和环境约束。课程真正希望训练的是：从规格建立不变量，用 workload 和证据逐步选择设计。

## 12. 现实复杂性：allocator 不是一棵“正确的数据结构”

### 12.1 1995 年的综述为何仍值得读

讲义引用 1995 年的 [Dynamic Storage Allocation: A Survey and Critical Review](http://jyywiki.cn/OS/manuals/malloc-survey.pdf)，并提醒 segregated free lists 早在 1964 年已经提出。历史线索不是为了打击新设计，而是提醒我们：许多看似新鲜的 first-fit/best-fit、边界标记、分桶、切分和合并组合，已经被几十年的理论与实证反复研究。

综述的核心方法论可以概括为：在建立内存管理理论前，先真正理解程序行为，辨认哪些 workload 特征重要，再决定形式化模型和工程设计。脱离行为分布只研究漂亮的最坏复杂度，容易优化一个现实中并不存在的问题。

因此“停止无意义科研实践”的积极解释是：

1. 先做文献调查，避免重新发明早已充分比较的机制；
2. 找到旧工作的假设，确认新硬件、新语言或新 workload 是否真的打破它；
3. 建立可复现实验，而不是只展示一个有利微基准；
4. 报告时间、空间、并发和安全之间的完整交换。

### 12.2 真实 allocator 必须同时面对的轴

一个实现往往同时处理：

- 请求大小从数个字节跨到 GB；
- 对齐、零初始化、`realloc` 和异常边界；
- 短命临时对象与进程级长命对象混合；
- 多核线程本地访问、跨线程 free、NUMA 和 false sharing；
- 内部/外部碎片与把空闲页还给 OS 的时机；
- fork、信号、崩溃诊断、heap profiler 和 sanitizer 接入；
- 随机化、隔离、canary、quarantine 等安全加固；
- 与现有二进制 ABI 和应用古怪用法兼容。

这就是课堂所说“年轻的你们对现实的恐怖一无所知”：难点不在写出一次成功返回的 `malloc`，而在所有轴交叉后仍正确、快、可诊断。

## 13. 实现高效 `malloc/free`：先定义 workload，再谈优化

### 13.1 “过早优化”真正警告什么

Knuth 的警告不是“永远不要优化”，而是不要在正确性、瓶颈和目标尚未确定时，凭审美把复杂性加入系统。对 allocator，“性能好”至少要补全：

- 关注单线程吞吐还是多核扩展性？
- 请求大小和生命周期分布是什么？
- 关注平均延迟还是 p99/p999？
- 峰值 RSS、碎片率和归还内存速度有何约束？
- 对象通常由分配线程回收，还是跨线程回收？
- 是否面对不可信输入和 adversarial allocation trace？
- 基准是否代表真实应用，还是只在缓存热、无竞争的小循环中测量？

没有这些条件，“A 比 B 快 20%”没有可迁移意义。

### 13.2 去哪里找 workload

最可靠的来源包括应用 trace、生产 profiling、公开 benchmark 套件和论文。讲义给出 [mimalloc 技术报告](https://www.microsoft.com/en-us/research/uploads/prod/2019/06/mimalloc-tr-v1.pdf)，用它说明研究者怎样从 free-list sharding 等机制、真实工作负载和定量比较建立论证；也链接了[持续演进的 allocator 研究](https://dl.acm.org/doi/10.1145/3620666.3651350)，提醒今天的工作依然离不开 workload 驱动调优。

阅读 allocator 论文时，不要只抄方案图。至少提取：

| 维度 | 应追问的问题 |
| --- | --- |
| workload | 来自真实应用、trace 还是合成循环？大小/生命周期/线程分布如何？ |
| baseline | 比了哪些 allocator，版本和配置是否公平？ |
| 指标 | 吞吐、尾延迟、RSS、碎片、页归还、CPU time 是否同时报告？ |
| 机制 | 改变了元数据、分桶、sharding、同步还是页来源？ |
| 环境 | CPU、NUMA、内核、编译器和线程数是否可复现？ |
| 代价 | 最坏情况、安全性、内存放大和维护复杂度是什么？ |

先获得 workload，往往也顺便获得一组可比较方案；这比从空白画一棵自认为优雅的树更接近研究。

## 14. 理论 vs. 实践：正常分布、最坏情况与攻击者

### 14.1 平均世界为什么有用

实际应用通常不是刻意构造的最坏输入。若常见请求集中在少量尺寸、线程倾向于释放自己创建的对象、生命周期呈现阶段性，allocator 就能用 size class、缓存和局部性获得远胜通用搜索的性能。理论最坏 `O(n)` 并不自动否定一个在现实分布上几乎常数的 fast path。

工程上合理的近似包括：用统计规律优化多数请求，把罕见复杂情况下沉到 slow path；允许少量内部碎片换取更少元数据和分支；把暂时空闲页留在缓存，减少下一轮系统调用。

### 14.2 但“正常”假设会成为安全边界

一旦输入者能影响分配大小、顺序或并发，“平均很好”的结构可能被推入最坏路径，形成 CPU、锁竞争或内存放大型 Denial of Service。讲义链接的 [cross-container attack](https://dl.acm.org/doi/abs/10.5555/3620237.3620571) 提醒：共享底层资源时，一个租户的分配行为还可能影响另一个租户。

所以理论与实践不是二选一：

```text
先用真实分布优化常见路径
        +
识别哪些输入跨越信任边界
        +
为资源消耗设置上限、隔离、退化策略和监控
```

“不考虑 adversarial worst case”只能是明确威胁模型后的选择，不能是默认免责条款。

## 15. 观察 `malloc`：对象越小，分配路径越热

### 15.1 大对象应有足够工作来摊销成本

讲义用一个挑衅性的经验观察：申请 16 MiB、只扫一遍就释放，常常意味着性能设计值得重审。其推导是，大对象分配可能触发映射管理、页表建立、缺页、清零和缓存污染；若对象上的有效工作还不够摊销这些成本，整体也许应改为 streaming、复用 buffer、分块处理或避免物化中间结果。

这是一条 workload heuristic，不是语义定律。一次扫描可能正是文件解压、校验、网络接收或图像处理的必要工作。正确做法是测量分配、缺页、内存带宽和后续计算占比，再判断它是 bug 还是合理算法。

### 15.2 小、中、大对象呈现不同热点

课堂给出的分类是：

- 小对象：字符串、节点、临时包装对象，数量多，生命周期可长可短；
- 中对象：容器和复杂对象，通常更少，生命周期可能更长；
- 大对象：巨大容器、buffer，数量少，常有较长生命周期或明显阶段性。

若大对象没有足够用途，本身就应被优化掉；留下来的合理大对象通常分配频率较低。反过来，小对象单位工作少、创建次数多，于是 allocator 的每条指令、每次 cache miss 和每次共享锁都被放大。

在 oslabs 的目标 workload 下，可以把重点放在小对象分配/回收的 scalability；这不是对数据库、实时系统、GPU 内存或所有生产负载的普遍结论。课程限定语境非常重要。

### 15.3 为什么全局 first-fit 容易成为瓶颈

所有处理器都可能频繁分配小对象。若每次都：

1. 获取同一把全局锁；
2. 从链表头遍历到第一个合适块；
3. 修改共享指针和块头；
4. 释放锁；

那么问题不仅是渐进复杂度。锁所在 cache line 会在处理器间来回转移，指针追逐难以预取，临界区随碎片增加而变长，最终吞吐可能随核数增加反而下降。平衡树把搜索改成 `O(log n)`，却仍可能保留共享写与 cache miss，并没有命中真正瓶颈。

## 16. `malloc`, Fast and Slow：把常态做成几条指令

### 16.1 两套系统

课堂借 *Thinking, Fast and Slow* 的比喻，把系统路径分为：

- **fast path / System I**：覆盖绝大多数常见请求，状态已准备好，极少分支，最好只访问线程本地 cache；允许偶尔失败；
- **slow path / System II**：处理补货、新建 region、合并、跨线程协调、回收页和异常尺寸；可以更复杂，但必须把困难情况做完整；
- fast path 失败时 fall back，而不是返回错误或破坏不变量。

最小状态机是：

```text
请求 n
  │
  ├─ 本地可立即满足？ ──是──> fast path：取一个对象并返回
  │
  └─ 否
      ▼
    slow path：补充本地资源/处理特殊请求/向更下层申请
      │
      └──────────────> 回到可满足状态或规范地失败
```

cache、页表 TLB、系统调用常用路径、网络协议和数据库索引都有类似设计。fast path 的价值来自出现概率，而不是代码名字；必须用 profile 证明它确实覆盖多数请求。

### 16.2 快路径的代价不会消失，只会被移动

线程本地 freelist 可以避免共享锁，却会引入：

- 每线程缓存造成的内存放大；
- 某线程囤积空闲对象，另一线程却需要新页；
- 跨线程 free 的归属与同步问题；
- 线程退出时怎样交还缓存；
- NUMA 放置和对象实际使用线程不一致；
- 更多状态使统计、fork 和诊断复杂。

因此 fast/slow path 是成本重排：把常见操作的成本预付或延后给罕见路径，并用额外空间保存“已准备好”的状态。

## 17. 人类的智慧：用空间换取简洁——Segregated Lists 与 Slab

### 17.1 同尺寸对象让分配退化成 O(1) 操作

若一个 slab 中每个槽位大小相同，便不再需要对每个请求执行通用区间搜索：

```text
size class 16: [slab: 16|16|16|16|...]
size class 32: [slab: 32|32|32|32|...]
size class 64: [slab: 64|64|64|64|...]
```

空闲槽可以串成 freelist，或由 bitmap 记录。分配是弹出一个空闲槽，回收是压回一个槽或设置一个 bit；在已知所属 slab 和 size class 的前提下，局部操作可做到 O(1)。每个线程持有常用 size class 的局部资源时，fast path 还能避开全局锁；本地耗尽才走 slow path，从中央状态补充 slab，必要时再调用 `mmap`。

讲义把这一思想概括为 segregated lists/slab。术语在不同系统中有细节差异：内核 slab allocator 常为某类内核对象保留构造和缓存语义，通用用户态 allocator 则按 size class 分桶。共同核心是把异尺寸的困难问题分解为若干同尺寸简单问题。

![同尺寸 slab 用额外空间和分类换取简单分配](../../sources/site_html/static/img/slabs.jpg)

### 17.2 “O(1) free”依赖哪些隐藏前提

回收能常数时间完成，通常因为实现能从指针快速确定：

- 它属于哪个 slab/region；
- 对应哪个 size class；
- 槽位索引或块头在哪里；
- 应归还本线程、原属线程还是中央队列；
- 当前操作不会与另一个线程同时破坏同一元数据。

这些信息必须存储或从地址布局推导，都会占空间并约束 region 对齐。所谓“空间换简洁”，交换项包括：

- size class 向上取整造成内部碎片；
- 未满 slab 留有无法给其他尺寸使用的空槽；
- 每线程每尺寸缓存放大驻留内存；
- metadata、bitmap 和对齐浪费；
- 换来的则是短路径、少搜索、好局部性与较少锁竞争。

不存在免费的 O(1)。只是在目标 workload 下，这笔空间成本往往比全局搜索和同步更值得。

## 18. AI 时代：Policy 可以学习，Mechanism 必须可靠

### 18.1 “Heuristics is dead...”应怎样理解

讲义改写 Jim Gray 的名句，提出：

> Heuristics is dead, Policy is Heuristics, LLM is Policy, Mechanism is King.

它不是说所有启发式突然消失，而是说策略生成方式可以变化：过去由工程师手调 size class、缓存上限和回收阈值，未来 Agent 可以在明确设计空间中生成候选、运行 benchmark、分析 trace，甚至提出新的组合。Scaling law 与 bitter lesson 提醒我们，通用搜索/学习系统有机会超过大量手工特例。

但 Agent 需要“舞台”：

```text
可靠机制：申请/归还区域、原子操作、统计、隔离、回滚
      +
设计空间：分类、放置、缓存、合并、sharding、归还策略
      +
目标函数：吞吐、尾延迟、内存放大、安全和公平性
      +
workload：真实 trace、压力场景、对抗输入
      +
oracle：不重叠、不越界、不泄漏关键资源、并发语义正确
```

若没有 oracle，Agent 可能通过少释放内存、跳过同步或只适配 benchmark 来“优化”分数。机制边界、资源上限和正确性检查因此比策略是谁写的更重要。

### 18.2 为什么训练学生做综述

综述的产物不只是一串论文摘要，而是对 design space 的提取能力。对 `malloc/free`，可以用问题而非答案来组织空间：

- 内存从哪里获得，何时归还？
- 大小怎样分类，请求怎样放入可用块？
- 空闲块怎样表示，何时切分或合并？
- 状态按线程、CPU、arena、NUMA node 怎样分片？
- 跨所有权回收怎样转交？
- 快路径保存多少备用资源，慢路径负责哪些不变量？
- 需要抵抗哪些错误、攻击和观测开销？
- 哪些参数可由 trace 自适应，变化时如何保持稳定？

这些问题定义了 Agent 可以探索的坐标轴，却没有替 M5 选择具体布局与协议。学习者仍要把规格、不变量、测试和测量连起来。

## 19. 分层辨析与常见误区

### 19.1 libc 不是系统调用清单

`strlen`、格式解析和许多数学/字符串操作可完全在用户态；`malloc` 大多数请求也只改用户态元数据；`gettimeofday` 可能走 vDSO；`write` wrapper 才通常直接跨入内核。同一个 libc API 内部还可以混合纯计算、共享映射和系统调用。

### 19.2 C 标准、POSIX、ABI 和某个 libc 实现不是一层

- C 标准规定 `malloc`、`printf`、`setjmp` 等源代码接口与语义边界；
- POSIX 增加 `gettimeofday`、`mmap` 等环境接口；
- ABI 决定参数寄存器、栈布局、ELF 约定和 `va_list` 实现基础；
- musl/glibc 决定具体数据结构、缓存、符号和优化路径；
- 内核决定系统调用与 vDSO 实现。

看到一段源码时，先问它是哪一层的契约，才能判断哪些行为可以跨平台依赖。

### 19.3 debug info 不是“源码的无害附件”

它不参与一般执行，却可能泄露源码路径、类型、内部符号甚至嵌入源码。release 构建应把调试产物当敏感发布物管理；另一方面，可靠 crash diagnosis 又需要保存与 build ID 精确匹配的独立符号文件。正确策略通常是分离并受控保存，而非彻底丢弃。

### 19.4 `strace` 没显示不等于函数没执行

它只说明过滤范围内未观察到系统调用。stdio buffer、allocator fast path、vDSO、普通指令和用户态锁都可能完全绕开系统调用。GDB、perf、uprobes、反汇编与源码分别补充不同证据。

### 19.5 `setjmp/longjmp` 不是异常安全和资源管理

它恢复控制状态，不理解堆对象、fd、锁或业务事务。把它包装成“C 的 exception”若不同时规定清理协议，会把资源泄漏和死锁藏在非局部控制流里。

### 19.6 `free` 不会把所有旧数据立即清零

`free` 只是把块交回 allocator。内容可能暂时保留，也可能立刻被 freelist 元数据覆盖、被别的线程复用或最终解除映射。读取它始终是 use-after-free，不能以“这次值还在”辩护。

### 19.7 虚拟地址可用不等于物理内存已就绪

`mmap` 成功、`malloc` 返回非空和每一页未来都能写入是不同命题。lazy allocation 与 overcommit 把成本推迟到触碰页时；性能测量要决定是否包含首次缺页与清零成本。

### 19.8 Slab、pool 与通用 allocator 不能只看大 O

O(1) 分配可能用更多驻留内存，线程本地缓存可能造成不公平，size class 可能产生内部碎片。性能结论必须带 workload、空间指标和并发条件。

### 19.9 AI 生成实现不等于完成系统实验

Agent 可以读源码、生成 trace、比较 benchmark 和提出设计；但“编译成功”不证明并发线性化，“跑得快”不证明未泄漏或重叠，“测试通过”也取决于 oracle。必须保留可重复命令、失败输入和状态不变量。

## 20. 本讲小结：libc 是机器细节的封装，也是策略的集中地

本讲从一份可调试 musl 出发，沿原讲义完成了两次“降层”：

第一次，从 C API 降到机器状态：

1. DWARF 把 PC、寄存器和内存重新解释成源码行、变量与栈帧；
2. source map 案例说明这种解释能力也是发布边界上的信息资产；
3. `crt1.o` 从 initial process stack 建立 C 运行环境；
4. `printf` 的 `FILE` 和 `va_list` 分别封装 I/O 状态与 ABI；
5. `setjmp/longjmp` 直接保存/恢复调用环境；
6. `gettimeofday` 通过 auxv 找到 vDSO，说明 libc 不只是 syscall wrapper。

第二次，从 `malloc` API 降到内存管理策略：

1. 内核提供大块虚拟地址机制，allocator 在用户态管理小块；
2. `mini_malloc` 展示块头、对齐、切分、first-fit 和复用；
3. 简单接口把生命周期正确性成本交给所有调用者；
4. 平衡树式“抽象正确”不代表适合真实热路径；
5. workload 决定优化目标，小对象并发通常是 oslabs 的重点；
6. fast/slow path 把常见操作变成本地短路径；
7. segregated list/slab 用内部碎片和缓存空间换 O(1) 操作与 scalability；
8. AI 可以搜索 policy，但 mechanism、oracle 和设计空间仍需人建立。

本讲 Takeaway 可以浓缩为：**libc 屏蔽了几乎所有 ISA 与 ABI 差异，但它的实现绝不只是系统调用包装；机器级 hacking 与 workload 驱动的策略共同撑起了可移植应用生态。**

## 21. 思考题与延伸阅读

1. 同一程序用 `-O0 -g3` 与 `-O2 -g3` 编译，比较 `.debug_loclists`、GDB 局部变量和 backtrace；哪些“源码变量”已无法恢复？
2. 为什么线上服务常把 debug file 独立保存，并用 build ID 与剥离后的二进制匹配？若符号版本错一位，会怎样误导 crash diagnosis？
3. 改变命令行参数和环境变量数量，在 `_start` 处重新解释 initial stack。怎样只依赖 `NULL` 哨兵找到 auxv？
4. 把实验 2 的 stdout 重定向到文件，去掉显式 `fflush`，再正常返回或调用 `_exit`。输出和 `write` 轨迹有何差别？为什么？
5. `longjmp` 跨过一个持锁函数会怎样？请画出“机器控制流已恢复、资源状态未恢复”的两层状态机。
6. 实验 4 中若 `strace` 出现真正的时间系统调用，可能有哪些环境或 fallback 原因？还需要哪些证据定位？
7. 为 `mini_malloc` 画出一个导致外部碎片的 trace，只写请求序列、块布局和预期性质，不实现 M5。
8. 比较 allocator 的“平均吞吐更高”和“p99 延迟更低”：fast path 命中率相同是否足以同时保证二者？
9. 每线程缓存若按 CPU 数和 size class 数线性增长，会怎样影响短命线程和高核机器？可以测哪些指标？
10. 选择 musl 中一个感兴趣的函数，在 AI 帮助下生成调试假设；必须用断点、反汇编和系统调用轨迹分别验证哪些部分？

推荐按以下顺序阅读：

- [本讲原始讲义](../../sources/notes/lect10.md)，对照课堂标题复盘；
- [DWARF Debugging Standard](https://dwarfstd.org/)，先看整体结构，再按工具输出追具体 section；
- [musl libc](https://musl.libc.org/)，从短小函数和目标架构启动/汇编代码读起；
- [1995 allocator survey](http://jyywiki.cn/OS/manuals/malloc-survey.pdf)，重点提取 workload 假设和 design space；
- [mimalloc 技术报告](https://www.microsoft.com/en-us/research/uploads/prod/2019/06/mimalloc-tr-v1.pdf)，练习把机制、指标和 workload 对齐。

## 22. 下一讲衔接：从 `crt1.o` 和 debug section 走向 ELF

到这里，已经有几个问题不能再由“libc 内部实现”回答：

- `_start` 为什么成为入口，链接器把它放在哪里？
- `crt1.o`、用户 `.o` 和 `libc.a` 如何解析彼此的符号？
- `.text`、`.data`、`.bss`、`.debug_info` 和 `.eh_frame` 为什么能共处一个文件，却有不同装入命运？
- 静态 musl 程序为什么可直接运行，动态程序为何先进入 interpreter？
- 地址尚未确定时，函数调用和全局变量引用怎样被重定位？

下一讲将把可执行文件视为一个描述初始进程映像的数据结构，进入 ELF、静态链接、动态链接与加载。第 9 讲建立 libc 抽象，第 10 讲沿抽象向下追到入口和机器状态；第 11 讲则解释这些代码与数据怎样在构建和 `execve` 时真正聚合成进程。

## 23. PPT 内容覆盖表

| 原讲义顺序与主要标题 | 本章对应小节 | 覆盖要点 |
| --- | --- | --- |
| 编译 musl libc / 使用自己的 libc / 原理 | §2.1–§2.2 | freestanding、控制 `_start`、FFI/inline assembly、系统调用与自有运行库 |
| 实例：musl-libc | §2.2–§2.3 | `-Og/-ggdb` 构建、musl-gcc、产物验收、GDB/strace/readelf 证据链 |
| Aside: Debug Info | §3.1–§3.3 | 符号表、STABS 历史、DWARF section、表达式、优化变量、unwind |
| 热评：Claude Code 源代码泄漏 | §3.4 | JavaScript source map、`sourcesContent`、发布与 CI 边界 |
| Debug Info 的作用 | §3.5–§3.6 | backtrace、profiler、flame graph、crash dump、ASan、可操作实验 |
| 探索 libc 实现 / 调试“小程序” | §4.1 | 从一行 C 展开到启动、stdio、系统调用和退出 |
| `crt1.o` 和程序初始化 | §4.2–§4.3 | initial process stack、`argc/argv/envp/auxv`、`_start`、静态/动态差异 |
| 调试 `printf` 和 `va_args` | §5 | `FILE` 内部、stdout、缓冲、`vfprintf`、现代 ABI、cdecl 反例、实验 |
| 调试 `setjmp/longjmp` | §6 | 保存/恢复机器环境、寄存器 trick、callee/caller-saved、资源边界、实验 |
| 调试 `gettimeofday` | §7 | vDSO、auxv、入口解析、syscall fallback、`strace` 能力边界、实验 |
| 动态内存分配 / `malloc` 和 `free` | §8 | API 语义、用户态 allocator、内核不分配任意小块 |
| `mmap/sbrk` | §8.2 | 大区域、匿名映射、按需分页与 overcommit 辨析 |
| Aside: `malloc/free` 犯下的“错误” | §10 | 最小完备性、生命周期证明、UAF/leak、GC/RAII/ownership |
| 作业：实现 malloc | §9、§11 | 大小请求问题、区间模型、平衡树直觉的局限、M5 方法边界；无答案 |
| 年轻的你们对现实的恐怖一无所知 | §12 | 1964 segregated lists、1995 survey、真实行为先于理论 |
| 实现高效的 `malloc/free` | §13 | premature optimization、workload、mimalloc 与论文阅读维度 |
| 理论 v.s. 实践 | §14 | 正常 workload、adversarial worst case、DoS 与隔离 |
| `malloc()` 的观察（两页） | §15 | 大对象摊销、小/中/大对象、小对象频繁、scalability |
| `malloc`, Fast and Slow | §16 | System I/II、fast/slow path、fallback 与成本转移 |
| 人类的智慧：空间换简洁 | §17 | segregated lists/slab、线程本地、O(1) 回收、内部碎片 |
| AI 时代？ | §18 | policy、mechanism、design space、scaling/bitter lesson、综述能力 |
| Takeaways | §20 | libc 的 ISA/ABI 抽象、机器级角落、可移植应用生态 |
| 阅读材料 | §21 | 用 AI 辅助并以机器证据验证 musl 调试 |
| 向 ELF/链接加载衔接 | §22 | `crt1.o`、section、符号、重定位、静态/动态加载 |
