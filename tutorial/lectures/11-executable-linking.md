# 第 11 讲：可执行文件、链接与加载——把字节兑现成进程

> 原始讲义：[sources/notes/lect11.md](../../sources/notes/lect11.md)  
> 配套示例：[examples/clock_user.c](../../examples/clock_user.c)、[examples/preload_clock.c](../../examples/preload_clock.c)  
> 本讲关键词：可执行文件、ELF、a.out、FLE、链接、加载、`execve`、`PT_LOAD`、`PT_INTERP`、shebang、共享库、动态加载器、`ld.so`、符号、重定位、PIC、GOT、PLT、`LD_PRELOAD`

## 0. 本讲定位：libc 已经写好，它怎样进入每个进程

[第 9–10 讲](10-libc-2.md)沿着 libc 一路向下：标准 I/O 在文件描述符上增加缓冲，`malloc` 在 `mmap` 等机制上实现分配策略，启动代码又把内核建立的初始状态接到 `main`。这留下了一个不能再绕过的问题：

> 编译器分别生成的应用代码、启动代码和 libc，怎样从若干文件变成一个可以执行的整体？`execve` 又怎样把这个整体变成正在运行的进程？

本讲把此前出现过的“程序映像”真正打开。最重要的认识不是背下 ELF 的所有字段，而是抓住一个不变量：**可执行文件是对进程初始状态的描述；链接器补全名字与地址，加载器把描述兑现为地址空间、寄存器和栈。**

课程主线走到这里是：

```text
系统调用提供最小机制
  → libc 封装 ABI、启动过程和常用策略
  →【本讲：链接并加载应用代码与 libc】
  → initramfs、init、服务和应用共同长成完整生态
```

下一讲将把镜头重新拉远：既然一个 ELF 能成为一个进程，那么第一个进程从哪里来，BusyBox、initramfs、systemd 和图形应用又怎样逐级建立整个应用世界？

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 用“进程初始状态的描述”解释可执行文件，而不把它神秘化为“能双击的东西”；
- 说明早期 `a.out` 的最小字段，以及 ELF 为什么随需求增长得复杂；
- 区分 ELF 的 section 与 segment，并判断链接器、加载器各自更关心哪一种视图；
- 解释 Funny Little Executable（FLE）想证明什么，以及人类可读格式付出的代价；
- 沿 Linux `execve → binfmt_elf/binfmt_script` 路径说明 ELF 与 shebang 的分派；
- 画出 `argc/argv/envp/auxv` 初始栈，并说明内核与 libc 启动代码的边界；
- 解释共享库为什么能节省磁盘和物理内存，却不意味着所有进程共用一份可写全局变量；
- 说明动态 ELF 为什么先进入 `ld.so`，再到程序的 `_start` 和 `main`；
- 使用 `readelf`、`objdump`、`/proc/PID/maps`、`LD_DEBUG` 和 `LD_SHOW_AUXV` 获取证据；
- 解释 `LD_PRELOAD` 的符号插入原理、适用范围和安全边界；
- 从“链接时不知道最终地址”推导出符号、重定位、PIC、GOT 和 PLT；
- 解释为什么外部数据比外部函数更难处理，以及 visibility 如何换回直接访问。

问题地图：

| 问题 | 最小答案 | 可观察证据 |
| --- | --- | --- |
| ELF 是代码的容器吗？ | 不只如此；它还描述映射、权限、入口、解释器及动态链接元数据 | `readelf -h/-l/-d` |
| `.text` 会被内核按 section 名加载吗？ | 通常不是；内核主要按 `PT_LOAD` segment 映射 | program header 与 section-to-segment mapping |
| 动态程序第一条执行的是 `_start` 吗？ | 内核先把 PC 交给 `PT_INTERP` 指定的动态加载器入口 | `readelf -l`、GDB `starti` |
| 两个进程把 libc 映射在不同地址，还能共享吗？ | 能；虚拟地址可不同，干净的文件后备物理页仍可共享 | `/proc/PID/maps`、`smaps`/PSS |
| `LD_PRELOAD` 改了内核时间吗？ | 没有；它只改变动态符号解析所到达的用户态函数 | 配套时钟实验与直接 syscall 对照 |
| 为什么函数要 PLT/GOT？ | 调用点编译时不知道最终函数地址，需要一层可重定位的间接跳转 | `readelf -rW`、`objdump -d` |
| 为什么数据更麻烦？ | 数据访问没有“先跳到桩、再访问”的天然控制流 | 外部变量的 GOT 间接访问 |

## 2. 静态链接和加载：先把可执行文件去魅

### 2.1 从“能双击”到“一个可解析的字节序列”

学习操作系统之前，“可执行文件”常被理解成图标：双击它，窗口就出现。这个说法描述了用户体验，却没有解释机制。学过文件、地址空间和进程后，可以逐层改写：

1. 它首先是操作系统中的一个文件对象，有路径、权限和一串字节；
2. 文件内容可以用十六进制编辑器查看和修改，并没有超自然属性；
3. 这些字节遵循一份格式契约，描述应把哪些内容放到哪些虚拟地址、赋予什么权限、从哪里开始执行；
4. 内核加载器接受这份描述，建立新地址空间和初始寄存器状态；
5. 随后的启动代码与 libc 再把机器级入口接到语言世界的 `main(argc, argv)`。

因此更精确的等式是：

```text
可执行文件
  = 文件中的字节
  + 格式/ABI 对这些字节的解释
  + 加载器愿意兑现的契约
```

同一串字节若没有相应加载器，只是普通数据；同一个加载器也可以支持多种格式。Linux 后面会用 binary-format handler 体现这一点。

“描述进程初始状态”也不是说文件保存了进程运行后的完整快照。它通常只提供可复现的初始材料：代码、只读数据、已初始化数据、零填充区、入口和装载元数据。PID、打开文件描述符、随机化后的具体地址、凭据检查结果和内核对象引用，要到 `execve` 时才确定。

### 2.2 真正的早期可执行文件：`a.out`

UNIX 早期常见的 `a.out` 名称来自 assembler output。讲义给出的核心头部十分朴素：

```c
struct exec {
    uint32_t a_midmag;  /* machine ID and magic */
    uint32_t a_text;    /* text bytes */
    uint32_t a_data;    /* initialized data bytes */
    uint32_t a_bss;     /* zero-filled data bytes */
    uint32_t a_syms;    /* symbol-table bytes */
    uint32_t a_entry;   /* initial PC */
    uint32_t a_trsize;  /* text relocation bytes */
    uint32_t a_drsize;  /* data relocation bytes */
};
```

最小加载模型几乎可以直接从字段读出：

```text
检查 magic 和体系结构
  → 读取固定位置的 text/data
  → 为 bss 准备 a_bss 字节并清零
  → 建立栈和参数
  → PC = a_entry
```

有些变体甚至不在头部记录 `.text` 的文件 offset，因为 ABI 已经把它规定成常数。这看起来“原始”，却揭示了关键事实：复杂格式也是人造物，最初只需解决当时的问题。

需求增长后，固定布局很快不够用：

- 不同页面大小和映射权限需要对齐与多个 load region；
- 动态链接需要依赖列表、动态符号和运行时重定位；
- 调试器需要行号、类型和栈展开信息；
- 线程需要 TLS 模板；
- 安全机制需要不可执行栈、RELRO、PIE 等标记；
- 多体系结构、多 ABI、版本和扩展又要共存。

ELF 不是因为设计者喜欢繁琐才出现，而是简单格式在真实生态中持续承载新契约的结果。

### 2.3 ELF 的两种视图：section 用来链接，segment 用来运行

ELF（Executable and Linkable Format）的名字已经提示它同时服务两个阶段。最容易混淆的概念是 section 与 segment：

| 视图 | 典型条目 | 主要消费者 | 回答的问题 |
| --- | --- | --- | --- |
| section | `.text`、`.rodata`、`.data`、`.bss`、`.symtab`、`.rela.text` | 编译器、静态链接器、调试器、分析工具 | 各类编译产物和元数据在哪里？ |
| segment/program header | `PT_LOAD`、`PT_INTERP`、`PT_DYNAMIC`、`PT_TLS`、`PT_GNU_STACK` | 内核加载器、动态加载器 | 运行时应映射什么、权限如何、还要启动谁？ |

多个 section 可以被打包进同一个 `PT_LOAD`。例如 `.text`、`.plt` 可能进入一个 `R E` segment，`.data`、`.bss` 进入一个 `RW` segment。内核不必理解 `.text` 这个名字；它只需按照 program header 把文件区间映射到虚拟地址。

这也解释了一个反直觉现象：删除不参与运行的 section header、普通符号表或调试信息后，一个 ELF 仍可能执行；但损坏 program header 中的 `PT_LOAD` 或入口，加载便会失败。相反，`.o` 可重定位目标文件有丰富 section 和 relocation，却还没有可直接执行的完整内存布局。

对每个 `PT_LOAD`，加载器关心的核心关系可写成：

```text
文件 [p_offset, p_offset + p_filesz)
    映射到虚拟地址 [base + p_vaddr, base + p_vaddr + p_filesz)

若 p_memsz > p_filesz：
    剩余 [p_filesz, p_memsz) 在内存中补零，常对应 .bss

权限来自 p_flags：R / W / X
对齐约束来自 p_align
```

对于 PIE 和共享库，`base` 是运行时选择的 load bias；文件中的 `p_vaddr` 通常是相对布局。ASLR 改变 base，而模块内部相对关系保持不变。

### 2.4 为什么 CSAPP 和 System V ABI 让人“吐血”

讲义直面学习 ELF 的共同挫败：学生、教师乃至教材都很难在有限篇幅里讲完。System V ABI 的相关材料至少同时覆盖：

- Process Initialization：初始寄存器、栈、`argc/argv/envp` 和 auxiliary vector；
- Object Files：ELF 头、program/section header、symbol table、relocation、dynamic section；
- 调用约定、数据布局、TLS、版本与体系结构专属 relocation。

它难读的根本原因是设计目标不同。机器和工具链偏好紧凑、高效、可随机访问的表示，于是格式大量使用整数枚举、位域、文件 offset、表索引和交叉引用；人更喜欢“信息就在眼前”的平坦叙述。ELF 是给程序快速解析的数据库，不是为线性阅读设计的教程。

所以学习策略不应是把所有常量一次背完，而应沿问题查询：

```text
要知道映射什么       → program headers / PT_LOAD
要知道先运行谁       → ELF entry + PT_INTERP
要知道依赖哪些库     → PT_DYNAMIC / DT_NEEDED
要知道名字在哪里     → symbol table + string table
要知道哪里待修补     → relocation table
要知道初始参数怎样放 → ABI Process Initialization
```

`readelf` 把交叉引用展开成人能读的文本；调试器和 `/proc` 再验证运行时结果。手册、工具和实验共同构成理解，而不是一张需要默写的结构体大图。

## 3. Funny Little Executable：用另一种描述检验理解

### 3.1 一个疯狂但严肃的想法

如果 ELF 本质上只是描述，那么同一语义总可以换一种表示：JSON、Markdown、S-expression，甚至一组普通文本命令。只要满足：

```text
decode(new_format) 产生的初始状态
    ≡ decode(ELF) 产生的初始状态
```

就可以先把 ELF 转成容易读的格式，再为它写一个加载器。这个思路的价值不只是“另造格式”，而是把隐含知识变成可执行检验：若我们真懂加载，便应能说明最少要保留哪些字段，并实现解释器兑现它。

讲义把 AI/Coding Agent 放在这里也有明确方法论。模型可以快速生成解析器、转换器和样板代码，让“实现一个原型”的成本大幅下降；但等价性、权限边界、溢出检查和恶意输入仍需测试与推理。Intelligence is cheap 不等于 correctness is free。

### 3.2 Funny Little Executable 1.0：最小机制证明

课程 FLE 原型自行定义了静态链接和加载格式，并复用 GCC/`ld` 生成机器码与完成部分链接工作。其核心选择极简：

- 文件直接携带一段位置无关代码和相连数据；
- 加载器申请内存，把字节复制或映射进去；
- 为简化原型，区域可读、可写、可执行；
- 加载器确定入口后跳转执行。

它证明了“可执行”不属于 ELF 的专利。一个最小用户态加载器的概念流程是：

```text
解析 FLE 并检查长度/边界
  → mmap 一段足够大的区域
  → 放置代码和数据
  → 处理格式约定的少量 fixup
  → 设置最终权限并清理指令缓存（若体系结构要求）
  → 按调用约定跳到 entry
```

教学原型把同一区域设成 RWX 能缩短代码，但真实系统通常避免“可写且可执行”（W^X），因为攻击者一旦能改写代码页就更容易执行注入内容。简洁原型是机制证明，不是生产安全规范。

FLE 还帮助区分静态链接与加载：GCC/`ld` 已把模块内部大部分符号和 relocation 处理好，FLE 加载器负责安排运行时内存并移交控制。二者可合并在一个玩具程序里，概念职责仍不同。

### 3.3 Funny Little Executable 2.0：让描述首先对人友好

讲义进一步设想 Markdown-based 格式。下面是其精神的缩略版本：

```text
# ELF [class=64 endian=le machine=x86_64 type=ET_DYN entry=_start]
## PT_LOAD [flags=R|X align=0x1000]
### .text [type=PROGBITS align=16]
_start:
    48 c7 c0 01 00 00 00             # write
    48 8d 35 {pcrel32: msg - . - 4}  # 对 msg 的 PC-relative relocation
    0f 05
    ...

## PT_LOAD [flags=R align=0x1000]
### .rodata [type=PROGBITS align=16]
msg:
    48 65 6c 6c 6f 2c 20 4d 44 21 0a
```

层级标题直接表达 ELF、segment 和 section 的包含关系；属性紧挨对象；符号与 `{pcrel32: ...}` 把 relocation 写成人能读的算式。传统 ELF 要从 relocation entry 的 offset、type、symbol index，再跳到 symbol/string table 才能恢复相同信息。

但人类可读并非无代价：

- 文本更大，解析更慢，歧义和规范化问题更多；
- 数值宽度、溢出、字节序和对齐仍不能省略；
- 签名、哈希和可复现构建需要确定的 canonical encoding；
- 调试、TLS、异常展开和版本化等真实需求仍会让格式增长；
- 最终 CPU 只执行字节，文本必须在某处被转换。

因此 FLE 2.0 不是声称 Markdown 必然取代 ELF，而是用不同权衡暴露设计空间：教学和审计优先可读性，发布和装载可能优先紧凑与效率；二者可以通过可靠工具互转。

### 3.4 格式反思：课程应教授关系网，而不只是字段表

讲义从 FLE 转向教学反思：真正可迁移的能力是看到知识之间的关系——需求怎样产生字段，字段由谁消费，若删去它会在哪里失败。学生的工作也随工具变化：

1. 提出一个可检验的问题，例如“内核是否需要 section header”；
2. 找到手册、源码、工具输出和运行轨迹；
3. 让 Agent 帮助转换格式、检索大项目或生成实验；
4. 用不变量、负例和交叉证据确认结论。

讲义用“枚举字典中所有句子并逐个研究”的夸张思想实验提醒我们：有限长度的人类文本原则上可被穷举，但绝大多数候选毫无价值。真正困难的仍是问题排序、证据判断和建立解释。Agent 降低机械劳动成本，反而让“问什么、为何相信”更重要。

## 4. 实验一：把 ELF 的磁盘描述对上运行时映射

依赖：Linux、binutils（`readelf`）、procfs。先选一个普通动态程序；不同发行版的地址、段数量和解释器路径会不同：

```bash
file /bin/true
readelf -h /bin/true
readelf -lW /bin/true
readelf -dW /bin/true | sed -n '1,80p'
```

观察顺序：

1. `-h` 中通常可见 `ELF64`、体系结构、类型和 entry；现代发行版的 `/bin/true` 常是 `ET_DYN`，即 PIE，但也可能是 `ET_EXEC`；
2. `-lW` 中找 `PT_LOAD` 的 offset、virtual address、file/memory size 和 `R/W/E`；
3. 找 `PT_INTERP`，它通常指向 `ld-linux-*.so.*`；静态 ELF 没有这一项；
4. 最后的 section-to-segment mapping 显示多个 section 怎样装入一个 segment；
5. `-dW` 中的 `DT_NEEDED` 列出直接动态依赖，通常会看到 libc。

再把文件描述与进程地址空间对上：

```bash
sleep 60 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true' EXIT HUP INT TERM

readlink "/proc/$pid/exe"
sed -n '1,120p' "/proc/$pid/maps"

kill "$pid"
wait "$pid" 2>/dev/null || true
trap - EXIT HUP INT TERM
```

`maps` 中同一路径常出现多行，分别具有 `r--p`、`r-xp`、`rw-p` 等权限和不同文件 offset；它们应能与 `PT_LOAD` 大体对应。由于 ELF segment 必须按页面边界映射，文件 offset、虚拟地址和 `maps` 边界不一定逐字相等，要考虑页对齐。

几个结果需要谨慎解读：

- `.bss` 的 `p_memsz - p_filesz` 没有对应文件字节，运行时由零页或匿名页面补足；
- `maps` 里的 `p` 表示 private mapping，不表示文件代码页一定已有一份私有物理拷贝；未修改的 file-backed clean page 仍可由页缓存共享；
- 文件被映射后，不必一直保留一个普通 fd，所以只看 `/proc/PID/fd` 会漏掉映射；`lsof` 还会检查 `maps`、cwd、root 等来源；
- `readelf` 展示静态布局，`maps` 展示加入 ASLR load bias 后的某次实例。

这个实验完成了本讲最重要的一次闭环：program header 不是抽象名词，它最终变成 `/proc/PID/maps` 中真实的虚拟内存区域。

## 5. Linux 内核里的加载器：`execve` 如何兑现描述

### 5.1 `execve` 不是创建进程，而是更换程序映像

调用：

```c
execve(path, argv, envp);
```

成功时不会回到原调用点。当前进程保留 PID 等身份和未标记 close-on-exec 的文件描述符，但原用户地址空间被新映像替换；调用线程之外的线程消失，捕获的信号处置等若干进程属性按手册重置。`fork`/`clone` 负责得到新执行上下文，`execve` 负责让一个现有进程成为另一个程序，这两件事不要混淆。

内核在这条路径上大致完成：

```text
按 path 打开并检查可执行权限/凭据
  → 读取文件开头，选择 binary-format handler
  → ELF: 校验 header，处理 PT_LOAD/PT_INTERP 等
  → script: 解析 #! 并改由解释器执行
  → 建立新 mm、栈、参数、环境与 auxv
  → 提交新映像；设置初始 PC/SP
```

Linux 源码中的 `fs/binfmt_elf.c` 是 ELF handler；它不是一个只会 `memcpy` 的十行函数，因为还必须处理越界与溢出、页对齐、凭据、PIE 随机化、`PT_GNU_STACK`、TLS/core dump 等真实契约。讲义以 [CVE-2024-46826](https://cvefeed.io/vuln/detail/CVE-2024-46826) 提醒：解析攻击者可控的复杂二进制格式属于内核安全边界，有代码就可能有 bug。

阅读大型内核源码时可以从概念关键字切入：先搜 `PT_LOAD`，沿数据流追踪 `p_offset/p_vaddr/p_filesz/p_memsz`；再找建立初始栈和 auxiliary vector 的代码。Coding Agent 很适合帮助建立调用图、解释结构体和搜同类用法，因为内核项目保持了较强的一致性；最终仍应回到具体版本的源码和运行实验核对。

### 5.2 初始栈：把 `argv`、环境和内核事实交给用户态

在常见 System V ABI 模型中，新程序开始时栈大致包含：

```text
高地址
┌──────────────────────────────┐
│ 参数/环境字符串、随机字节等 │
├──────────────────────────────┤
│ auxiliary vector: type,value │
│ ...                          │
│ AT_NULL, 0                   │
├──────────────────────────────┤
│ envp[0], envp[1], ..., NULL  │
├──────────────────────────────┤
│ argv[0], argv[1], ..., NULL  │
├──────────────────────────────┤
│ argc                         │ ← 初始 SP（具体对齐按 ABI）
└──────────────────────────────┘
低地址
```

`argv[i]` 和 `envp[i]` 是指针，实际字符串在栈的其他位置。auxv 则是内核向加载器/libc 提供的键值对，常见项包括：

- `AT_PHDR/AT_PHNUM/AT_PHENT`：主程序 program header 的位置和规格；
- `AT_ENTRY`：主程序自己的 ELF entry；
- `AT_BASE`：动态加载器的 load base；
- `AT_PAGESZ`：页面大小；
- `AT_RANDOM`：随机字节位置，供栈保护等机制使用；
- `AT_SYSINFO_EHDR`：vDSO ELF 头地址；
- `AT_EXECFN`：执行文件名；
- `AT_SECURE`：是否进入 secure-execution mode。

这正好承接 libc 讲的 `_start`：C 语言没有规定“内核调用 `main`”。内核只按 ABI 建好机器状态；启动文件中的 `_start` 解包它，动态加载器先完成必要工作，libc 再调用初始化函数和 `main`。

### 5.3 内核与用户态动态加载器的责任边界

内核必须理解足够多的 ELF 才能安全建立映射，但它不负责实现完整的 glibc 符号解析。对于动态 ELF，职责分工是：

| 内核 | `ld.so`/`ld-linux.so` |
| --- | --- |
| 校验格式和权限 | 读取 `PT_DYNAMIC`、`DT_NEEDED` |
| 映射主程序 `PT_LOAD` | 搜索并 `mmap` 共享库 |
| 映射 `PT_INTERP` 指定的解释器 | 建立 link map 和符号查找 scope |
| 建初始栈、auxv、PC、SP | 处理动态 relocation、TLS、构造函数 |
| 把 PC 交给解释器入口 | 最终跳到主程序 `AT_ENTRY` |

静态 ELF 没有 `PT_INTERP`，内核可直接从它的 ELF entry 开始。动态 ELF 则体现“计算机世界没有魔法”：在 libc 尚未可用时，动态加载器必须用自身已能执行的代码和直接系统调用完成自举。

## 6. Shebang：把脚本文本接入 `execve`

### 6.1 `#!` 是加载协议，不只是注释

脚本没有 ELF header 和机器指令，为什么 `./tool.py` 仍可执行？Linux 的 `fs/binfmt_script.c` 会检查文件头：

```c
if (buf[0] != '#' || buf[1] != '!')
    return -ENOEXEC;  /* 不是本 handler 的格式 */
```

若首行是 shebang，内核取出解释器路径和至多一个可选参数，重新组织参数并执行解释器。很多脚本语言又把 `#` 当注释，因此解释器随后读取脚本时可自然忽略首行。这是一次巧妙的协议复用，也带着历史兼容的“滥用”味道。

在 Linux 上，若文件 `S` 的首行概念上是：

```text
#!A B C
```

执行 `S x y` 时，解释器通常观察到：

```text
argv[0] = A
argv[1] = "B C"   # 整段是一个可选参数，不按空格继续切分
argv[2] = S
argv[3] = x
argv[4] = y
```

这不是 POSIX 统一规定的可移植细节；BSD/macOS 等系统的参数切分可能不同。`/usr/bin/env -S` 是一些系统上显式切分多个参数的办法，但使用前应核对本机 `env` 和目标平台。

### 6.2 实验二：让解释器亲口报告 shebang 的 `argv`

依赖：Linux、C 编译器。实验创建 `/tmp/lect11-shebang`，不会改动仓库：

```bash
work=/tmp/lect11-shebang
mkdir -p "$work" || exit 1

cat >"$work/showargv.c" <<'EOF'
#include <stdio.h>

int main(int argc, char *argv[]) {
  for (int i = 0; i < argc; i++) {
    if (printf("argv[%d]=<%s>\n", i, argv[i]) < 0) {
      perror("printf");
      return 1;
    }
  }
  return 0;
}
EOF

cc -std=c11 -Wall -Wextra -Wpedantic \
  "$work/showargv.c" -o "$work/showargv" || exit 1

printf '#!%s A B\npayload-not-read-by-this-interpreter\n' \
  "$work/showargv" >"$work/S" || exit 1
chmod +x "$work/S" || exit 1
"$work/S" x y
```

Linux 上的典型输出是：

```text
argv[0]=</tmp/lect11-shebang/showargv>
argv[1]=<A B>
argv[2]=</tmp/lect11-shebang/S>
argv[3]=<x>
argv[4]=<y>
```

把首行改为不存在的解释器，再执行：

```bash
printf '%s\n' '#!/definitely/missing' >"$work/bad"
chmod +x "$work/bad"
"$work/bad"
```

错误可能显示“No such file or directory”，即使 `bad` 明明存在；缺失的是加载链中的解释器。`strace -f -e trace=execve "$work/bad"` 可看到原始 `execve` 以 `ENOENT` 失败，但内核内部打开解释器不是用户态发起的第二次系统调用，不能期待 trace 中必然出现第二行 `execve`。

还要区分两个行为：

- 内核看到 `#!` 后的解释器分派，是 executable format 机制；
- 某些 Shell 遇到 `ENOEXEC` 后尝试把无 shebang 文本交给 `/bin/sh`，是 Shell 的兼容策略。

脚本需有执行权限；解释器也必须可执行。setuid 脚本、递归 shebang、首行长度和路径中的特殊字符都有安全或可移植边界，不应从这个最小模型外推成无限递归的通用规则。

## 7. 为什么需要动态链接：把应用拆开

### 7.1 静态链接世界的简单与浪费

纯静态链接把所需库代码复制进每个最终可执行文件。它有很强的自包含性：运行时不需要在系统中寻找匹配 `.so`，部署和故障模型较直接。但如果一千个程序都使用同一份大型运行库，代价也明显：

- 磁盘和发布包重复保存相同代码；
- 相同只读代码难以天然以同一文件后备页共享；
- 库修复后，每个应用都要重新链接和发布；
- 大项目无法在运行时按组件组合或插件化。

讲义用游戏各自复制一份 `d3dx9_xxx.dll` 的直觉例子说明：把平台库塞进每个应用并不总是好主意。

### 7.2 我们想要的拆分

动态链接把应用和运行库变成独立文件：

```text
app ─┬─ needs libc.so
     ├─ needs libm.so
     └─ needs project_plugin.so

另一 app ── needs 同一 libc.so
```

收益包括：

- 系统只需保存一份特定版本的库文件，干净代码页可跨进程共享；
- 库可在保持 ABI 兼容时独立安全升级；
- JVM 的 `libjvm.so`、Android 的 `libart.so` 等大型组件可分别构建；
- `dlopen` 允许按需加载插件，模块可独立演进；
- 教学项目中也可把 CPU、设备和运行时像“插到主板上”一样组合。

但“整个系统只有一个 glibc 副本”是一种教学简写，不是字面保证。容器、兼容运行时和应用私有目录可以同时存在多个版本；库升级时，已运行进程还可能继续映射旧 inode。可写数据、TLS、堆和 relocation 后的私有页也必须按进程隔离。真正共享的通常是同一文件的干净 file-backed 页面。

动态链接还引入 dependency hell：库名能找到不代表 ABI 匹配，ABI 兼容也不保证行为完全兼容。SONAME、符号版本、语义化版本和包管理器都在管理这个新问题。拆分减少复制，却把一部分确定性推迟到了加载时。

## 8. 探索共享库行为：共享的是物理页，不是虚拟地址

### 8.1 课堂 bloat 实验的推理

讲义提出一个可证伪实验：构造包含约 10 MB `nop` 的 `bloat()`，编进 `libbloat.so`；再启动 1,000 个进程动态加载并调用它。如果每个进程都占一份独立物理代码，额外内存应接近 10 GB；若代码页来自同一只读文件映射，物理占用应远小于这个数。

这里要选择正确指标：

- **VIRT**：每个进程的虚拟地址范围，重复相加必然很大，不能代表独占物理内存；
- **RSS**：驻留页计数，共享页会在每个进程的 RSS 中重复出现；
- **PSS**：共享页按共享者数量分摊，更接近每个进程应承担的物理成本；
- **Private/Shared Clean/Dirty**：可从 `/proc/PID/smaps` 看文件页是否共享、是否被写脏。

还要先触碰代码页，否则 demand paging 可能根本没把 10 MB 全部读入物理内存。课堂让进程执行 `bloat()`，正是为了避免“只是保留虚拟地址”的假阳性。

### 8.2 实验三：两个独立进程、两个虚拟地址、一份文件后备

不必真的启动 1,000 个进程，也能观察机制。下面启动两个独立的 `sleep`：

```bash
sleep 90 & p1=$!
sleep 90 & p2=$!
trap 'kill "$p1" "$p2" 2>/dev/null || true' EXIT HUP INT TERM

for p in "$p1" "$p2"; do
  echo "=== pid=$p ==="
  awk '$6 ~ /(sleep|libc\.so|ld-linux)/ {print}' "/proc/$p/maps"
done

for p in "$p1" "$p2"; do
  echo "=== rollup pid=$p ==="
  awk '/^(Rss|Pss|Shared_Clean|Private_Dirty):/' \
    "/proc/$p/smaps_rollup"
done

kill "$p1" "$p2"
wait "$p1" "$p2" 2>/dev/null || true
trap - EXIT HUP INT TERM
```

预期看到两个进程都映射同一个 `sleep`、`libc.so` 和 `ld-linux` 路径。由于 ASLR，各模块的起始虚拟地址通常不同；这不妨碍相同文件 offset 对应的干净物理页由页缓存共享。PIC 让机器码主要使用 PC-relative 或经 GOT 的寻址方式，不依赖一个写死的绝对装载地址。

PSS 是整个进程的汇总，且系统当时的共享者数量会变化，所以数值不能当作严格的“libc 大小”。若要重做 bloat 实验，应比较一批进程启动前后的系统级 PSS，并分别统计目标 VMA。

讲义还建议运行 `lsof libbloat.so`，再用 `strace` 观察 `lsof`。关键发现通常是：`lsof` 不只遍历 `/proc/PID/fd`，还读取 `/proc/PID/maps` 或相关 procfs 信息。动态加载器在 `mmap` 成功后可以关闭库 fd，映射依然存在；“打开的描述符”与“仍被地址空间映射的文件”是两种引用。

## 9. 动态链接程序怎样启动：先有鸡还是先有蛋

### 9.1 `_start` 仍在主程序里，但第一条指令先属于解释器

上一讲看到静态程序中的 `_start` 通常来自 `crt1.o`，再调用 `__libc_start_main`。动态链接并没有取消这个入口：启动目标文件仍被链接进主程序，ELF header 的 `e_entry` 仍指向主程序 `_start`。

反直觉之处在于，内核并不立刻把 PC 设为这个 `e_entry`。若存在 `PT_INTERP`：

1. 内核映射主程序的 `PT_LOAD`；
2. 内核打开并映射 `PT_INTERP` 指定的动态加载器；
3. auxv 中的 `AT_ENTRY` 记录主程序 entry；
4. 初始 PC 指向动态加载器自己的 entry；
5. 加载器准备好依赖和 relocation 后，跳转到 `AT_ENTRY`；
6. 主程序 `_start` 再进入 libc 启动流程，最终调用 `main`。

所以“动态 ELF 的第一条指令不是程序 `_start`”与“主程序必须含 `_start`”可以同时成立。

### 9.2 用工具观察自举链

先取得本机解释器路径：

```bash
readelf -lW /bin/true |
  sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p'
```

x86-64 glibc 系统常见 `/lib64/ld-linux-x86-64.so.2`，musl 和其他体系结构路径不同。将结果保存后可让加载器列出依赖：

```bash
interp=$(readelf -lW /bin/true |
  sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
"$interp" --list /bin/true
```

在 GDB 中可以进一步观察：

```text
gdb /bin/true
(gdb) starti
(gdb) x/i $pc
(gdb) info proc mappings
(gdb) break _start
(gdb) continue
```

`starti` 处的 PC 常落在 `ld-linux`；到 `_start` 断点时，libc 等依赖已经出现在 mappings 中。GDB、PIE 和调试符号的具体表现随版本而异，但“先解释器、后主程序 entry”的控制流不变。

直接修改 `PT_INTERP` 也能验证它不是注释：改成不存在或不兼容的路径，`execve` 会失败。不要拿系统二进制原地试验；复制到 `/tmp` 并使用 `patchelf --set-interpreter` 等工具，同时注意新字符串长度和工具是否正确重写 ELF。

## 10. `ld.so` 手册：动态世界的操作面板

### 10.1 为什么 `man 8 ld.so` 值得逐项实验

动态加载行为存在平台和版本细节，最可靠入口是本机手册：

```bash
man 8 ld.so
man 3 dlopen
man 3 dlsym
```

讲义挑出的几个环境变量正好覆盖依赖搜索、诊断、绑定时机和内核—用户态交接：

| 功能 | 观察命令 | 说明 |
| --- | --- | --- |
| 库搜索路径 | `LD_LIBRARY_PATH=/path program` | 类似 `PATH`，但搜索对象是共享库；与 RPATH/RUNPATH 的优先级有细节 |
| 搜索诊断 | `LD_DEBUG=libs /bin/true` | 打印查找目录、命中库、初始化和控制转移 |
| 依赖列表 | `ldd /bin/ls` | 展示解析结果；不可信 ELF 更宜先用 `readelf`，避免实现差异带来的执行风险 |
| 立即绑定 | `LD_BIND_NOW=1 program` | 启动时处理函数 relocation，便于更早暴露缺失符号 |
| auxv | `LD_SHOW_AUXV=1 /bin/true` | 展示 `AT_ENTRY`、`AT_BASE`、`AT_RANDOM`、`AT_SYSINFO_EHDR` 等 |

可直接运行：

```bash
LD_DEBUG=libs /bin/true 2>&1 | sed -n '1,80p'
LD_SHOW_AUXV=1 /bin/true | sed -n '1,80p'
```

若看到 `AT_SYSINFO_EHDR`，它指向内核映射给进程的 vDSO。某些原本需要系统调用的操作可通过这段内核提供、用户态执行的代码加速；它仍有 ELF 头、符号和映射来源，再次印证“没有魔法，只有协议”。

共享库搜索顺序不能简单记成“先 `LD_LIBRARY_PATH` 再系统目录”：`DT_RPATH`/`DT_RUNPATH`、是否有 slash、`/etc/ld.so.cache`、硬件能力目录、secure-execution mode 和加载器实现都会影响结果。遇到部署问题时，让 `LD_DEBUG=libs` 给本机证据，再对照手册。

### 10.2 lazy binding 与 `LD_BIND_NOW`

函数调用可采用 lazy binding：启动时先把 GOT 项指向解析器，第一次调用才查找符号并回填地址。好处是没调用的函数不必解析，坏处是错误推迟、首调有延迟，且可写跳转表扩大攻击面。

设置 `LD_BIND_NOW=1` 要求加载器尽早完成相应 relocation。现代发行版也可能在链接时启用 `-z now`，使 ELF 自带 `BIND_NOW`；因此打开某个 `/bin/true` 未必能观察到 lazy path。先用：

```bash
readelf -dW /bin/true | grep -E 'BIND_NOW|FLAGS'
```

确认目标的实际策略。结合 RELRO，立即绑定还允许加载器完成 relocation 后把更多 GOT 区域改成只读。

## 11. `LD_PRELOAD`：利用符号解析做非侵入式插桩

### 11.1 “谁先满足未定义符号”

动态加载器为一个进程建立符号查找 scope。默认可见、可插入的未定义符号会按 scope 顺序寻找定义；`LD_PRELOAD` 指定的库被提前放入全局查找范围，因此它有机会先提供同名函数。概念上：

```text
app 调用 time
  → app 的 time@plt
  → GOT[time]
  → 原本解析到 libc.so:time

LD_PRELOAD=libfakeclock.so 后：
  GOT[time] → libfakeclock.so:time
```

“第一个定义胜出”是很有用的最小模型，但真实规则还受依赖 scope、符号版本、weak/strong、visibility、`RTLD_LOCAL/RTLD_GLOBAL`、`-Bsymbolic` 和加载器实现影响。

### 11.2 实验四：复用 `preload_clock` 把应用时钟拨快一小时

仓库已经提供完整示例：[clock_user.c](../../examples/clock_user.c) 调用 `time()`，[preload_clock.c](../../examples/preload_clock.c) 定义同名函数。构建并对比：

```bash
make -C examples clock_user libfakeclock.so

./examples/clock_user
LD_PRELOAD="$PWD/examples/libfakeclock.so" ./examples/clock_user
```

两行应使用相同时区，第二行比第一行约晚一小时；执行两条命令的自然耗时可能造成几秒内差异。hook 的关键逻辑是：

```c
time_t time(time_t *result) {
  static time_function real_time;
  if (real_time == NULL) {
    *(void **)(&real_time) = dlsym(RTLD_NEXT, "time");
    if (real_time == NULL)
      return (time_t)-1;
  }
  time_t shifted = real_time(NULL) + 3600;
  if (result != NULL)
    *result = shifted;
  return shifted;
}
```

若 hook 内直接再调用 `time()`，会递归回自己；`dlsym(RTLD_NEXT, "time")` 从当前对象之后继续查找，取得被遮蔽的真实实现。示例检查了解析失败，并维护 `time(time_t *)` 的“返回值与可选输出参数一致”契约。

可用加载器调试输出确认绑定：

```bash
LD_DEBUG=libs,bindings \
LD_PRELOAD="$PWD/examples/libfakeclock.so" \
  ./examples/clock_user 2>&1 | grep -E 'libfakeclock|symbol.*time'
```

不同 glibc 版本的文字格式可能不同；重点是预加载库先被装入，并为应用的 `time` 引用提供定义。

### 11.3 从一小时偏移到“变速齿轮”

课堂 Wheel Demo 不只加常数，而是维护虚拟时间：启动时记录真实基准，之后返回：

```text
virtual_now = virtual_base
            + speed × (real_now - real_base)
```

若 `speed = 10`，应用观察到时间以十倍流逝。但想让游戏或模拟器表现一致，不能只 hook `time`：

- wall clock：`time`、`gettimeofday`、`clock_gettime(CLOCK_REALTIME)`；
- monotonic clock：`clock_gettime(CLOCK_MONOTONIC)`；
- 阻塞/计时器：`sleep/usleep/nanosleep`、`alarm`、timer API；
- 条件等待、事件循环和直接 syscall/vDSO 还可能绕过 wrapper。

虚拟“当前时间”加速后，等待时间应怎样缩放也要统一，否则应用会看到自相矛盾的时钟。线程安全、溢出、不同 clock id 和信号语义使完整实现远比单函数 hook 复杂。

同一机制还可用于 malloc/free trace、非侵入日志、故障注入、替换 `rand()`，也能被用于图形函数劫持等作弊行为。机制本身中性，使用者仍受安全、授权与伦理边界约束。

### 11.4 `LD_PRELOAD` 不是什么

- 它只作用于使用相应动态加载器的程序；静态链接程序没有可插入的动态符号路径。
- 它不会改内核系统调用；程序直接执行 syscall、使用 vDSO 私有入口或内部隐藏符号时可能绕过 hook。
- 编译器内联、符号 visibility、版本绑定和库内部优化都可能让调用不经过公开 PLT。
- setuid/setgid 等 secure-execution 场景会忽略或限制危险环境变量，不能把 `LD_PRELOAD` 当成跨权限边界的通用注入器。
- 已经运行的进程不会因为另一个 Shell 设置环境变量而自动改变；环境只在启动链中继承。

## 12. 实现链接：从不知道地址推导 GOT/PLT

### 12.1 链接器真正解决的是名字和空洞

编译单个源文件时，编译器可以确定局部指令布局，却不知道其他模块中 `printf`、`x` 或 `_start` 最终在哪里。目标文件因此保存三类东西：

```text
内容：各 section 中已经生成的机器码和数据
符号：名字、定义/未定义、类型、binding、visibility、所在 section
重定位：哪个 offset 要按哪条公式，用哪个符号和 addend 修补
```

静态链接器合并 section、选择符号定义、安排最终地址，再计算 relocation。一个常见抽象公式是：

```text
absolute relocation:  S + A
PC-relative relocation: S + A - P
```

其中 `S` 是符号地址，`A` 是 addend，`P` 是待修补位置。具体位宽、右移和溢出规则由体系结构 relocation type 规定，不能只套公式。

静态链接时若所有地址已知，链接器可把结果一次写死。动态链接时，共享库 load base、依赖版本甚至哪个定义胜出都要到运行时才知道；一部分 relocation 只能留给 `ld.so`。

### 12.2 为什么不能让所有 `call` 直接跳到 `printf`

主程序和 `libwheel.so` 都可调用动态加载的 `printf`。编译时不知道 libc 的最终地址，而且分支指令本身有范围限制：

- AArch64 `bl` 常用 26 位立即数乘 4，范围约 ±128 MiB；
- x86-64 近 `call rel32` 使用 32 位位移，范围约 ±2 GiB。

即使分支范围足够，若把共享代码里的每个 call site 都改写为绝对运行时地址，会产生大量 text relocation：加载器必须修改本应只读、可共享的代码页，使其变脏并破坏跨进程共享，还与 W^X 冲突。

Butler Lampson 那句经典经验在这里非常具体：再加一层间接寻址。

### 12.3 PLT 是跳板，GOT 是可重定位的地址表

对模块内已确定且不可被替换的函数，链接器可以生成直接相对调用。对外部或可插入函数，典型 x86-64 路径是：

```text
call printf@PLT
       │
       ▼
PLT[printf]: jmp *GOT[printf](%rip)
                         │
          ┌──────────────┴──────────────┐
          │ 已绑定：libc printf 地址   │
          │ 未绑定：动态解析器入口     │
          └─────────────────────────────┘
```

- **PLT（Procedure Linkage Table）** 是靠近调用者的一组短 trampoline，解决分支范围和统一调用入口；
- **GOT（Global Offset Table）** 保存运行时地址，加载器只需重定位表项，而不必改每个代码调用点；
- lazy binding 时，第一次调用经解析器查找符号并回填 GOT；
- immediate binding 时，加载器启动阶段直接填写相应项。

PIC 通过 PC-relative 指令找到本模块的 GOT；模块整体搬家时，代码字节可以保持不变。每个进程仍有自己的 GOT 状态，因此写 GOT 通常落在私有页；大量只读 `.text` 页则继续共享。

### 12.4 实验五：从 `time@plt` 追到 `R_X86_64_JUMP_SLOT`

仍复用配套程序：

```bash
make -C examples clock_user

readelf -Ws examples/clock_user |
  grep -E ' UND | time@|puts@|localtime'

readelf -rW examples/clock_user

objdump -d examples/clock_user |
  grep -A8 -B2 -E '<time@plt>|<puts@plt>'
```

典型 x86-64 输出包含：

```text
... UND time@GLIBC_2.2.5
... R_X86_64_JUMP_SLOT ... time@GLIBC_2.2.5
<time@plt>:
    jmp *disp32(%rip)   # 指向某个 GOT slot
...
    call <time@plt>
```

这三份证据分别回答：

1. 主程序没有定义 `time`，只保留带版本需求的未定义动态符号；
2. `.rela.plt` 要求加载器把对应 slot 重定位成最终定义；
3. 调用点先到本模块 PLT，PLT 再间接读取 GOT。

AArch64、RISC-V 及启用不同链接优化的 x86-64 输出会使用不同 relocation 名称和指令；`-fno-plt`、链接器 relaxation、LTO、PIE 与 `-z now` 也会改变外形。应抓住“符号 + 待修补位置 + 间接地址槽”的不变量，不要把某段反汇编当作 ELF 的唯一实现。

### 12.5 符号解析不只是字符串匹配

动态符号条目至少还携带：

- name：经字符串表索引得到；
- value/size：相对模块的值和对象大小；
- type：函数、对象、TLS 等；
- binding：local、global、weak；
- visibility：default、hidden、protected 等；
- version：glibc 等库用符号版本表达 ABI 世代。

加载器按对象的依赖图和 scope 搜索。默认可见全局符号可能被更早对象 interpose，这给 `LD_PRELOAD` 能力，却也限制编译器优化：即使某 DSO 自己定义了 `foo`，默认语义下内部 `foo()` 调用也可能被外部同名定义替换。`hidden` 告诉工具链该符号不参与外部解析，便可直接绑定并省掉间接层。

weak symbol 允许“有更强定义就用，没有也可接受”的可选协议，但静态与动态链接的冲突/选择规则有细节。遇到真实问题，应同时查看 `.symtab`、`.dynsym`、版本表和加载 scope，而不是仅凭函数名猜测。

## 13. PLT 没能解决的数据问题

### 13.1 函数有控制流，数据访问没有天然跳板

考虑：

```c
extern int x;

void set_x(void) {
  x = 1;
}
```

如果链接器知道 `x` 在本模块、不可被 interpose，可以生成 PC-relative 直接写：

```text
movl $1, x(%rip)
```

若 `x` 最终由另一个 DSO 提供，编译时不知道它与当前 PC 的距离，也不能像函数那样“跳到 `x@PLT` 再回来继续一次内存写”。典型 PIC 必须先从 GOT 取地址，再访问目标：

```text
mov GOT[x](%rip), %rdi
movl $1, (%rdi)
```

代码多一次加载，GOT 项还占空间并需要 relocation。更深的问题是 C 允许取 `&x`：整个进程应对同一可见定义得到一致地址，仅仅在每个模块放一份数据副本会破坏指针身份和共享状态。

### 13.2 `-fPIC` 的保守选择和 visibility 优化

对 default-visibility 的外部数据，编译器通常必须假设它可能被其他模块定义或插入，因此生成 GOT 间接访问。即使源码中定义就在同一 `.so`，语义插入也可能阻止直接绑定。

若接口明确不需要替换，可以：

```c
__attribute__((visibility("hidden"))) int x;
```

hidden visibility 让 `x` 只在当前 shared object 内解析，编译器/链接器便更有机会使用直接 PC-relative 访问。也有 `-Bsymbolic`、protected visibility、`-fno-semantic-interposition` 等选项，但它们会改变符号覆盖契约，不能只当“免费加速开关”。

历史工具链还可能用 **copy relocation** 处理主程序对 DSO 数据的直接访问：在主程序预留副本，并让其他引用解析到它。这能兼容非 PIC 代码，却让大小、地址身份、只读性和 ABI 演化更棘手。现代 PIE/PIC 越来越倾向 GOT 路径，但具体结果要看体系结构与链接选项。

讲义以 `stdout` 说明这种不对称：主程序在某些代码模型下可能高效直接访问，位置无关共享库则需经 GOT。这里的 `stdout` 是 libc 导出的 `FILE *` 数据符号，不是内核 fd 1；再次提醒不要混层。

TLS 又增加一种数据地址公式：每线程都要得到不同实例，加载器不仅解析模块，还要建立 TLS layout 和访问模型。这正是早期 `a.out` 没有、现代 ELF 必须承载的需求之一。

## 14. 从最小模型到真实系统：收益、代价与边界

### 14.1 静态与动态链接不是“先进/落后”二选一

| 维度 | 静态链接 | 动态链接 |
| --- | --- | --- |
| 部署 | 单文件、自包含性强 | 依赖库搜索与 ABI 匹配 |
| 磁盘/内存共享 | 多程序可能重复代码 | 同一库的 clean page 易共享 |
| 升级 | 应用需重链/重发 | 兼容库可独立升级，也可能引入行为变化 |
| 启动 | 无运行时库解析 | 要装载依赖并做 relocation；可 lazy/now 权衡 |
| 插件/插桩 | 能力有限 | `dlopen`、`LD_PRELOAD` 灵活 |
| 可复现性 | 依赖版本通常冻结 | 运行环境参与最终组合 |
| 攻击面 | 格式仍需解析，但运行时组合较少 | 搜索路径、interposition、可写 relocation 增加边界 |

容器镜像、Go/Rust 部署、嵌入式系统、glibc/musl 和桌面插件生态会做不同选择。应先明确升级模型、体积、ABI、启动性能和安全边界，再选策略。

### 14.2 ELF 复杂性来自多方共享一份契约

把各字段按消费者分类，复杂性就不再是一团：

```text
编译器/汇编器 → sections, symbols, relocations
静态链接器     → 合并布局、解析符号、生成 segments/dynamic metadata
内核           → ELF header, PT_LOAD, PT_INTERP, stack/auxv
动态加载器     → PT_DYNAMIC, DT_NEEDED, dynsym, relocation, TLS
libc/crt        → 初始 ABI、构造/析构、main
调试器/分析器  → debug sections, unwind, symbols, core metadata
安全机制       → permissions, GNU_STACK, RELRO, PIE, signatures outside/around ELF
```

机器效率要求这些表紧凑、可索引；生态兼容要求旧字段继续可用；扩展又不断加入。学习时应维护“谁写、谁读、何时生效”这张图。

### 14.3 安全边界随推迟决策而移动

动态链接把“最终调用谁”推迟到启动甚至第一次调用，换来共享和灵活性，也带来：

- 搜索路径劫持和环境变量注入；
- 恶意 ELF/DSO 解析面；
- GOT 等运行时写入目标；
- 构造函数在 `main` 前执行；
- ABI 替换造成的供应链和兼容风险。

对应缓解包括可信搜索路径、secure-execution、RELRO、`-z now`、PIE/ASLR、符号 visibility、签名与包管理。每项缓解都针对具体数据流，不能把“开了 ASLR”当成万能安全证明。

## 15. 分层辨析与常见误区

### 15.1 五个角色不要混为一个“编译器”

| 角色 | 本讲职责 | 典型产物/证据 |
| --- | --- | --- |
| 编译器/汇编器 | 为单个翻译单元生成代码、符号和 relocation | `.o`、`readelf -SW/-Ws/-r` |
| 静态链接器 | 合并目标文件，决定静态布局，生成 ELF | program headers、entry、`DT_NEEDED` |
| 内核 ELF/script loader | 实现 `execve`，映射主程序/解释器，建初始状态 | `binfmt_elf.c`、`binfmt_script.c`、`maps` |
| 动态加载器 `ld.so` | 加载 DSO、解析符号和动态 relocation | `LD_DEBUG`、link map、GOT |
| libc/crt | 从 `_start` 建立语言运行环境并调用 `main` | `crt1.o`、`__libc_start_main` |

### 15.2 高频误区

- **“可执行文件就是机器指令。”** 它还含映射、数据、入口、解释器和元数据；部分字节甚至不进入运行时内存。
- **“内核按 `.text/.data` 名字加载。”** Linux ELF loader 主要消费 program headers 和 `PT_LOAD`；section 是链接/分析视图。
- **“ELF header 保存最终绝对地址，所以 PIE 不能随机化。”** PIE/DSO 使用相对布局加运行时 load bias，relocation/PIC 处理剩余地址。
- **“`execve` 新建一个进程。”** 它替换当前进程映像；常见 Shell 是先 `fork` 再在孩子中 `execve`。
- **“内核调用 `main`。”** 内核设置 PC/SP；动态加载器、`_start` 和 libc 启动代码最后才调用 `main`。
- **“动态程序没有自己的 `_start`。”** 有；只是初始控制先进入 `PT_INTERP` 的 entry。
- **“共享库映射到不同地址就没有共享。”** 共享的是 file-backed physical page；每个进程的虚拟地址可以不同。
- **“一千个 10 MB 映射等于 10 GB RAM。”** VIRT/RSS 会重复计数；应触碰页面并看 PSS、shared/private 状态。
- **“映射库一定能在 `/proc/PID/fd` 找到。”** `mmap` 后 fd 可关闭；应查看 `maps`/`map_files`。
- **“shebang 是 Shell 解析的注释。”** 直接 `execve` 时由内核 script handler 识别；Shell 只是可能另有 fallback。
- **“shebang 后可以可移植地写任意多个参数。”** Linux 通常把解释器后剩余文本当一个参数，其他 UNIX 可能切分不同。
- **“`LD_PRELOAD` 能覆盖任何调用。”** 静态链接、直接 syscall、隐藏/版本化符号、内联和 secure-execution 都可能阻止它。
- **“GOT 和 PLT 是同一个表。”** PLT 是代码跳板；GOT 是存地址的数据表，二者配合但职责不同。
- **“PIC 表示所有地址都不需 relocation。”** PIC 尽量保持代码页不改写，GOT、数据、TLS 等仍需运行时 relocation。
- **“`stdout` 就是 fd 1。”** C 的 `stdout` 是 libc 中的 `FILE *` 对象；它通常封装 fd 1，但不是同一层对象。
- **“动态库独立升级永远安全。”** 只有 ABI/行为契约兼容时才成立；否则就是 dependency hell。

## 16. 本讲小结：一切都只是描述、查表和移交控制

本讲从最朴素的 `a.out` 走到 ELF、内核和动态加载器，主线可以压缩为：

```text
源文件
  → 编译为内容 + 符号 + relocation
  → 静态链接器合并并生成 ELF 布局
  → execve 让内核映射 PT_LOAD、建立栈和 auxv
  → 若有 PT_INTERP，先运行 ld.so
  → ld.so 映射依赖、解析符号、修补 GOT/其他 relocation
  → 跳到主程序 _start
  → libc 启动代码调用 main
```

几个 Takeaway：

1. **可执行文件是进程初始状态的描述。** ELF 强大却不适合人线性阅读，FLE 用等价描述证明格式可以重做。
2. **链接解决名字到地址，加载把布局变成状态。** section、segment、symbol 和 relocation 分别服务不同阶段。
3. **Linux 没有魔法。** `binfmt_elf`/`binfmt_script`、初始栈和 auxv 都能在源码与 `/proc` 中找到。
4. **动态链接用运行时组合换共享、升级和模块化。** 代价是搜索、relocation、启动开销、ABI 依赖和更大的安全边界。
5. **PLT/GOT 是“再加一层间接”的具体实现。** 函数可经跳板，数据则往往必须显式多一次取址。
6. **`LD_PRELOAD` 是符号解析策略的可编程后果。** 它适合观测和插桩，却不是内核 hook 或权限绕过。

一句话总结：**磁盘上没有“正在运行的程序”，只有一份约定好的描述；内核、动态加载器和 libc 按顺序解释它，进程才从字节中诞生。**

## 17. 思考题与延伸实验

1. 若一个 ELF 没有 section header，但 program headers、动态表和所需字符串仍完整，它为什么可能继续执行？哪些工具功能会丢失？
2. 对某个 `PT_LOAD`，若 `p_filesz > p_memsz` 或 `p_offset/p_vaddr` 的页内偏移不一致，加载器为什么应拒绝？这些检查属于功能还是安全？
3. 画出动态 PIE 从 `execve` 到 `main` 的控制流，并标出内核、`ld.so`、crt 和 libc 各自第一次获得控制的位置。
4. `AT_ENTRY` 与初始 PC 在动态 ELF 上为什么不同？`AT_BASE` 又帮助加载器恢复了什么事实？
5. 两个进程映射同一 libc：`.text`、GOT、普通全局数据和 TLS 中，哪些页通常可共享，哪些必须私有？发生 relocation/COW 后怎样变化？
6. 设计一个更严谨的 bloat 实验：如何排除未触页、RSS 重复计数、其他进程共享、透明大页和库被回收等干扰？
7. 为什么 `#! /usr/bin/env python3`（注意 `#!` 后空格）在一些系统可用，但 `python3 -I` 的多个参数又可能不可移植？应怎样做跨平台测试？
8. 配套 `preload_clock` 为什么要用 `RTLD_NEXT`？若真实 `time` 也间接调用某个被你 hook 的函数，怎样出现递归或不一致？
9. 将 `clock_user` 静态链接后再设置 `LD_PRELOAD`，预测结果并用 `readelf -l/-d` 解释。
10. lazy binding 节省了什么工作？为什么 full RELRO 往往与 immediate binding 配合？
11. 对 `extern int x`，为什么简单地给每个 DSO 复制一份 `x` 会破坏 `&x`、共享状态和 interposition 语义？
12. 编译一个含外部函数和外部数据的 `.o`，比较 `-fPIC` 前后的 `objdump -dr` 与 `readelf -r`。哪些 relocation 进入最终 DSO，哪些被静态链接器消解？
13. 若恶意目录被放在 `LD_LIBRARY_PATH` 最前，加载器可能执行哪类攻击者代码？为什么 secure-execution 要过滤环境变量？
14. FLE 2.0 若要支持签名验证，怎样定义空白、注释、数值表示和字段顺序的 canonical form？

建议结合本机 `man 2 execve`、`man 5 elf`、`man 8 ld.so`、`man 3 dlopen`，以及 System V ABI 的 Process Initialization 与 Object Files 两部分阅读。先带着实验问题查字段，比从第一页线性背表有效得多。

## 18. 下一讲衔接：从一个进程到整个应用生态

前两讲交付了 libc，本讲又解释了应用、libc 与加载器怎样组成一个可启动进程。现在可以把 `execve` 看成可靠的“生命繁殖接口”：一个已经运行的程序准备文件描述符和参数，再启动下一个程序；新程序又加载更多库、读配置、创建服务。

但系统刚启动时还没有 Shell，谁执行第一次 `execve`？[下一讲《构建应用程序生态》](12-application-ecosystem.md)会从 UNIX/Linux 历史和最小系统继续：固件加载内核，内核挂载 initramfs 并尝试 `/init` 或 `/sbin/init`，第一个用户进程再借助 BusyBox、设备节点、根文件系统和 systemd 逐级点亮服务与桌面。

这也完成从机制到生态的转折：

```text
本讲：ELF + loader + libc → 一个能运行的应用
下一讲：init + 文件系统 + 服务管理 → 一个能生长应用的世界
```

## 19. PPT 内容覆盖表

| 原讲义标题/内容（按出现顺序） | 本章对应位置 | 覆盖要点 |
| --- | --- | --- |
| 可执行文件；静态链接和加载 | §0、§2 | 本讲主线，静态描述、链接与装载职责 |
| 复习：什么是可执行文件？ | §2.1 | 从“双击对象”到文件字节和进程初始状态描述 |
| 真正的可执行文件；UNIX `a.out` | §2.2 | `struct exec`、固定布局、text/data/bss/entry/relocation |
| 被《计算机系统基础》支配的恐惧？；System V ABI | §2.3–§2.4、§5.2 | Process Initialization、Object Files、section/segment |
| 和 ELF 搏斗的每一年；为什么复杂 | §2.4 | 学生/教师共同困难、机器效率、位域/offset/交叉引用 |
| 一个疯狂的想法 | §3.1 | ELF 是描述，等价表示、转换器与加载器 |
| Funny Little Executable | §3.2 | 自定义静态格式、复用 GCC/ld、PIC 代码/数据映射与跳转 |
| Funny Little Executable 2.0 | §3.3 | Markdown 层级、可读 relocation、可读性与效率权衡 |
| 反思；我们应该怎么教课程 | §3.4 | 知识网络、案例/动机、提问和证据验证 |
| “我是人奸”/知识枚举思想实验 | §3.4 | 穷举文本不等于研究，问题排序与验证仍关键 |
| 加载器是内核实现的一部分 | §5 | `execve`、`binfmt_elf.c`、`PT_LOAD`、源码阅读与安全边界 |
| Initial Process Stack / Auxiliary Vector | §5.2 | `argc/argv/envp/auxv` 布局、`AT_*` 项与 crt 接口 |
| Coding Agent 打开 Linux Kernel | §5.1、§3.4 | 利用项目一致性建立调用图，并以版本源码/实验核验 |
| Shebang 运行程序 | §6.1 | `binfmt_script.c`、`#!` magic、解释器分派 |
| Shebang Demo | §6.2 | Linux 参数重写、`B C` 单参数、平台差异、解释器缺失实验 |
| 动态链接和加载；为什么需要动态链接 | §7 | 静态复制、库/应用分离、独立升级与 dependency hell |
| 拆解应用程序；大型项目分解 | §7.2 | glibc、`libjvm.so`、`libart.so`、插件/组件组合 |
| 探索动态链接的行为 | §8 | bloat 可证伪设计、1,000 进程、指标选择 |
| 观察系统内存；ASLR；PIC | §8.1–§8.2 | VIRT/RSS/PSS、同文件不同虚拟地址、干净页共享 |
| `/proc/[pid]/fd`；`lsof`/`strace` | §4、§8.2 | fd 与映射引用区别、`maps`/procfs 实现线索 |
| 动态链接库是进程间共享的吗？Demo | §8 | 10 MB `nop` 的实验逻辑、触页与物理共享解读 |
| 动态链接程序的加载；先有鸡还是蛋 | §9.1 | crt1 `_start` 仍存在，初始 PC 先到解释器 |
| `ld-linux.so` 写在 INTERP 段 | §5.3、§9.2 | 内核映射解释器、auxv、加载 DSO、转交 `AT_ENTRY` |
| musl-gcc/GDB/pmap 调试 | §9.2 | `starti`、`info proc mappings`、`_start` 断点 |
| Aside：阅读 `ld.so` 手册 | §10.1 | 本机 man page、搜索/绑定/诊断操作面 |
| `LD_LIBRARY_PATH`、`LD_DEBUG`、`ldd` | §10.1 | 依赖搜索、加载轨迹、不可信 ELF 边界 |
| `LD_BIND_NOW` | §10.2 | lazy/immediate binding、`BIND_NOW` 与 RELRO |
| `LD_SHOW_AUXV`；`AT_SYSINFO_EHDR` | §5.2、§10.1 | auxv 实验、vDSO 并非魔法 |
| `LD_PRELOAD` | §11.1、§11.4 | 提前加载、符号 scope、适用范围、安全限制 |
| 变速齿轮 | §11.2–§11.3 | 复用 `preload_clock`、`RTLD_NEXT`、虚拟时间公式和完整 API 边界 |
| `glXSwapBuffers`、`rand`、malloc/free trace | §11.3 | hook 的调试、插桩和滥用场景 |
| Aside：实现动态链接 | §12 | 未知地址、分支范围、符号与动态 relocation |
| another level of indirection | §12.2–§12.3 | same-binary 直接跳转、外部函数经 trampoline |
| PLT / GOT | §12.3–§12.4 | 跳板、地址表、lazy binding、`JUMP_SLOT` 实验 |
| PLT: 没能解决数据的问题 | §13.1 | 外部 `x` 的直接/间接访问、地址身份 |
| `-fPIC` 与 visibility | §13.2 | 默认 extern 数据经 GOT，hidden 恢复本地绑定 |
| Takeaways；阅读材料 | §16–§18 | 初始状态描述、代码/符号/重定位、实验与下一讲生态衔接 |
