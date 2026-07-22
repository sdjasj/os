# 第 6 讲：进程的地址空间——指针看到的“内存世界”是谁造出来的

> 原始讲义：[sources/notes/lect06.md](../../sources/notes/lect06.md)  
> 配套示例：[examples/mmap_cow.c](../../examples/mmap_cow.c)  
> 本讲关键词：地址空间、虚拟地址、指针、ELF `PT_LOAD`、ABI、MMU、页表、缺页、`mmap`、`munmap`、`mprotect`、COW、`procfs`、`ptrace`、内存扫描
> 前一讲：[程序和进程](05-programs-processes.md) · 后一讲：[操作系统对象](07-os-objects.md)

## 0. 本讲定位：进程这个“封闭世界”里的每个字节从哪里来

上一讲把程序和进程区分开来：程序是状态机的静态描述，进程是它的一次运行实例。UNIX 用三组动作管理这个状态机：

- `fork()` 复制状态；
- `execve()` 用新程序重置状态；
- `_exit()` 删除状态，父进程再用 `waitpid()` 回收退出信息。

但“复制状态”里最庞大的一部分是什么？是进程能通过指针访问的内存。`execve()` 又究竟把哪些字节放进内存、把它们放到哪里？`malloc()` 所返回的新地址从哪里来？为什么调试器还能越过进程边界看到另一个进程？

本讲用一个统一模型回答这些问题：

```text
程序给出地址（指针）
        ↓
进程自己的虚拟地址命名空间
        ↓  MMU 按页表翻译并检查权限
物理页、文件页、设备页，或“当前尚无 backing”
        ↓
合法访问完成；缺页交给内核；非法访问收到故障
```

这正处在课程总主线的第一个关键转折点：

```text
程序/硬件状态机
  → 进程生命周期
  →【本讲：地址空间虚拟化】
  → 操作系统对象与文件描述符
  → libc、链接加载、并发、设备、存储……
```

下一讲会把视线移出这个封闭的内存世界：进程若要访问文件、终端、管道和其他内核对象，就必须握有操作系统发放的“对象引用”。本讲末尾的 `/proc/PID/maps` 恰好会成为桥梁——内核状态也可以伪装成可读的文件对象。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 从 `fork/execve/_exit` 的语义解释地址空间如何被复制、重置和销毁；
- 用 CrazyOS 的 `proc.mem[]` 建立地址空间的最小模型，并指出它与真实系统的差异；
- 解释指针中保存的为什么通常是虚拟地址，而不是内存条上的物理地址；
- 说明代码、只读数据、已初始化数据、`.bss`、堆、栈、共享库和 `mmap` 区域的来源；
- 区分 ELF section 与 `PT_LOAD` segment，并描述 `execve()` 后的初始寄存器和栈；
- 解释 MMU、页表、VMA、TLB 和 page fault 分别承担什么职责；
- 正确使用 `mmap()`、`munmap()` 和 `mprotect()`，理解匿名/文件、私有/共享、权限/可见性这几组互不等价的维度；
- 用 COW 解释“`fork()` 像完整复制，但并不立即复制每个物理页”；
- 区分调试器、`procfs`、`ptrace`、`process_vm_readv/writev` 和主动共享内存的能力边界；
- 解释 Game Genie 与金山游侠分别在哪一层“入侵”地址空间，以及单纯扫描数值为什么会失效；
- 通过至少两个实验直接观察进程映射、页权限、COW 和跨进程调试。

问题地图：

| 问题 | 最小答案 | 可观察证据 |
| --- | --- | --- |
| 同一个指针值在两个进程中指向同一内存吗？ | 不一定；虚拟地址属于各自的命名空间 | `fork()` 后的私有映射实验 |
| 地址空间是连续的一大段 RAM 吗？ | 不是；它通常是稀疏的映射集合 | `/proc/PID/maps` 中的空洞 |
| `execve()` 后的字节是谁规定的？ | ELF program header、ABI 与内核/动态加载器共同规定 | `readelf -l`、`auxv`、映射表 |
| `mmap()` 返回成功等于物理页已经到手吗？ | 不等于；可能只建立 VMA，首次访问才兑现 | 缺页计数与 RSS 变化 |
| `MAP_PRIVATE` 意味着从一开始就复制吗？ | 不意味着；常用 COW 延迟到首次写 | `examples/mmap_cow` |
| 调试器为何能读写别的进程？ | 内核在权限检查后代为访问 | `gdb`、`ptrace`、`process_vm_*` |
| 搜索到经验值就能做通用外挂吗？ | 不能；数值位置不是程序语义 | 重复扫描、对象迁移、派生状态案例 |

## 2. 回顾进程管理：复制、重置、删除的究竟是什么

### 2.1 经典的 `fork`—`execve`—`waitpid` 骨架

上一讲会反复出现下面的结构：

```c
pid_t pid = fork();
if (pid < 0) {
    perror("fork");
    goto fail;
} else if (pid == 0) {
    char *const argv[] = {"echo", "hello", NULL};
    char *const envp[] = {NULL};
    execve("/bin/echo", argv, envp);
    perror("execve");                 // 只有失败才会返回
    _exit(127);                       // 不重复冲刷父进程的 stdio 缓冲
} else {
    int status;
    if (waitpid(pid, &status, 0) < 0) {
        perror("waitpid");
        goto fail;
    }
}
```

从地址空间角度重新解释它：

1. `fork()` 让子进程得到与调用线程当时所见几乎相同的虚拟内存内容；
2. 父子从同一条指令之后继续，栈、全局变量和堆在逻辑上已经彼此独立；
3. `execve()` 丢弃调用者原来的用户地址空间，按新可执行文件建立映射和初始栈；
4. `_exit()` 终止进程后，内核最终撤销它的用户映射并回收引用；
5. `waitpid()` 回收的是子进程的终止状态，不是“释放子进程内存”的用户态函数。

“`fork()` 完整复制地址空间”是**接口语义**。Linux 通常用 COW 实现，并不在系统调用那一刻复制每个物理页。概念与实现必须分开：程序观察到的结果像复制，内核可以用更便宜的机制兑现它。

还要注意一个边界：多线程进程调用 `fork()` 后，子进程只保留调用 `fork()` 的线程；内存快照中却可能留下由其他线程持有的锁。因此子进程在 `execve()` 前能安全调用的函数受到严格限制。这不是本讲重点，却说明“复制状态机”在真实系统里比复制一个数组复杂。

### 2.2 CrazyOS：把抽象压缩成一个 `mem[]`

讲义中的 CrazyOS 用 RISC-V 指令模拟器执行多个程序。它可以把一个进程写成：

```c
#define MEM_SIZE   (1 << 20)
#define MEM_OFFSET 0x80000000u
#define STACK_TOP  (MEM_OFFSET + MEM_SIZE)

struct proc {
    struct CPUState cpu;       // 寄存器、PC 等处理器状态
    uint8_t mem[MEM_SIZE];     // 代码、数据、堆、栈都放在这里

    // pid、系统调用缓冲区等 OS 内部状态……
};
```

调度主循环选择一个 `proc`，让模拟器在它的 `cpu` 与 `mem` 上执行若干指令，再换另一个 `proc`：

```text
pick p → execute p for a while → handle syscall → save p → pick q → ...
```

这个模型已经包含地址空间最重要的性质：

- 每个 `struct proc` 有自己的 `mem[]`，所以相同数值的地址可指向不同数组；
- 指令取值、数据 load/store 和栈访问都落在同一个进程的 `mem[]` 中；
- OS 能创建、复制、清空或删除这份数组；
- 应用不能直接拿另一个 `proc.mem`，除非 OS 特意提供机制。

它也刻意省略了真实系统的复杂性：

- 真实地址空间通常不是固定 1 MiB 连续数组，而是带空洞的映射集合；
- 多个虚拟页可以共享同一个物理页或文件页；
- 每一段有读、写、执行、用户态可访问等权限；
- 未访问的虚拟范围可能还没有物理页；
- 页表与 TLB 让硬件直接完成大部分翻译，不需要内核解释每条 load/store；
- 设备、共享内存、文件页和匿名页可以同时出现在一个地址空间中。

因此，CrazyOS 的 `mem[]` 不是“错误的简化”，而是本讲的**最小可执行模型**。后面每个真实机制，都可以看成给 `mem[]` 增加一种映射、权限、共享或延迟兑现规则。

## 3. 地址空间与指针：先建立精确模型

### 3.1 地址空间不是一根连续的物理内存条

“操作系统为每个进程提供独立、连续的虚拟地址范围”是一个方便入门的说法，但需要两点修正：

1. **连续的是地址编号的想象，不是有效映射。** 进程可用的虚拟地址范围中通常有大量 unmapped holes；访问这些空洞会故障。
2. **独立的是命名空间，不是所有 backing 都独占。** 两个地址空间能把不同虚拟地址映射到同一物理页，也能把相同虚拟地址映射到不同物理页。

可以把进程 `p` 的地址空间写成一个部分函数：

\[
M_p(va) = (backing, offset, permissions)
\]

其中：

- `va` 是程序给出的虚拟地址；
- `backing` 可以是匿名内存、文件、共享内存、设备页等；
- `offset` 指向 backing 中的具体字节；
- `permissions` 决定本次取指、读或写是否合法；
- 若 `M_p(va)` 未定义，该地址当前就是空洞。

地址空间因此同时完成三件事：

- **命名**：程序只需使用自己的虚拟地址；
- **隔离**：默认无法用普通指针命名另一个进程的私有页；
- **受控共享**：内核可让多个映射引用同一 backing。

这也解释了一个反直觉事实：两个进程都打印 `0x7ffd12345000`，并不能说明它们访问同一字节；一个进程中的两个不同地址，也可能是同一物理页的别名。

### 3.2 指针保存什么，类型又在哪里

在本讲的 Linux/POSIX 语境中，一个普通用户态指针的机器表示通常包含虚拟地址。执行：

```c
volatile unsigned char *ptr = input();
unsigned char x = *ptr;   // load
*ptr = 1;                 // store
```

时，编译器生成 load/store，CPU 再让 MMU 翻译地址并检查权限。字节本身不携带“这是 `int`”“这是指令”的标签；类型主要存在于源语言、编译器和调试信息里。相同的四个字节可以被指令解释成整数、浮点数或机器指令，结果取决于访问它们的指令和 ABI。

讲义中的 Quick Quiz 是：为什么示例常把探测指针写成 `volatile`？

因为如果读出的值没有被使用，普通 `*ptr` 可能被编译器认为没有可观察效果而删除；重复的普通读也可能被合并。`volatile` 告诉编译器“每次访问都必须发生”。但它**不**会：

- 把未映射地址变成合法地址；
- 绕过页表的 `r/w/x` 权限；
- 让越界或悬空指针变得符合 C 语言定义；
- 提供线程间原子性或同步顺序；
- 自动完成设备访问所需的架构级内存屏障。

因此，“用指针读取 `main` 的机器码”是一个有价值的 Linux/ABI 实验，却不是完全可移植的 ISO C 技巧：C 抽象机区分函数指针与对象指针，有些架构还可能让代码不可读或使用不同表示。观察真实机器时必须同时标明所依赖的平台约定。

### 3.3 代码、数据、堆、栈为何都能由指针命名

一个典型 Linux 进程可能有如下布局：

```text
高地址  ┌──────────────────────────┐
        │ 栈：argc/argv/envp/auxv │  通常向低地址增长
        │ guard / unmapped hole   │
        │ 共享库、动态加载器、mmap │
        │                         │
        │ heap                    │  program break 可向高地址移动
        │ .bss / .data            │
        │ .rodata / .text         │
低地址  └──────────────────────────┘
```

这只是惯例，不是每个系统都必须遵守的图。ASLR 会随机化主程序（PIE 时）、共享库、堆、栈与匿名映射；线程有各自的栈；链接器脚本能改变布局；内核还可能加入 `[vdso]`、`[vvar]` 等特殊映射。

从 CPU 看，它们最终都只是“某个虚拟地址上的字节”，差别来自来源和权限：

| 区域 | 典型来源 | 典型权限 | 主要内容 |
| --- | --- | --- | --- |
| `.text` | ELF 文件 | `r-x` | 机器指令 |
| `.rodata` | ELF 文件 | `r--` | 字符串、只读常量 |
| `.data` | ELF 文件 | `rw-` | 有非零初值的全局/静态对象 |
| `.bss` | ELF 描述的“内存大于文件”部分 | `rw-` | 启动时清零的对象，不必在文件中存一串零 |
| heap | `brk` 或匿名 `mmap` 背后的分配器区域 | `rw-` | `malloc` 管理的动态对象 |
| stack | 内核建立并可按需增长的匿名映射 | `rw-`，通常不可执行 | 调用帧、局部变量、启动参数 |
| shared libraries | 共享对象文件映射 | 按 segment 分成 `r--/r-x/rw-` | libc、动态链接器等 |
| anonymous map | `mmap(MAP_ANONYMOUS)` | 调用者请求 | 大对象、线程栈、运行时元数据 |

不要把这个表误解成“一个 section 对应一条 `/proc/maps` 记录”。运行时装载的核心单位是 ELF **segment**；若多个 section 需要相同的映射属性，它们可以合并到同一个 `PT_LOAD` segment。

## 4. 关键问题：`execve()` 后每个字节是谁规定的

讲义坚持“计算机世界里没有魔法”：只要某个字节可被程序读到，它的来源和访问规则就一定能追到某份接口约定或状态迁移。

### 4.1 字节“是什么”：ISA 不保存高级语言类型

内存提供字节，ISA 规定指令怎样组合和解释这些字节。例如同一组比特：

- 可被整数 load 解释成补码整数；
- 可被浮点 load 与运算解释成 IEEE 754 值；
- 位于 `PC` 指向的位置时，可被取指单元解释成机器指令；
- 被调试器读取时，可结合 DWARF 类型信息显示成 C 结构体。

“类型”不是 RAM 给出的答案。它来自执行指令和软件约定。调试器之所以能显示变量名，是因为二进制附带符号/调试信息，或用户告诉它按何种类型解释地址。

### 4.2 字节“放哪”：链接器、ELF program header 与加载器

编译器和汇编器先产生 `.text`、`.rodata`、`.data`、`.bss` 等 section；链接器安排它们，并生成 program header。内核执行 `execve()` 时主要读取 `PT_LOAD` 条目：

- `p_offset`：内容在文件中的偏移；
- `p_vaddr`：期望映射的虚拟地址或相对基址；
- `p_filesz`：来自文件的字节数；
- `p_memsz`：内存中需要的字节数；
- `p_flags`：`R/W/X` 权限；
- `p_align`：对齐要求。

若 `p_memsz > p_filesz`，多出的部分要以零出现，这正是 `.bss` 能“占内存但几乎不占文件”的基础。若可执行文件带 `PT_INTERP`，内核还会装入指定的动态加载器；动态加载器继续映射依赖库、完成重定位，最后把控制权交给程序入口。

所以 `execve()` 不是简单地“把整个文件复制进 RAM”。它依据描述建立多个映射，其中一些按需从文件读取，一些清零，一些由动态加载器后续补齐。

### 4.3 字节“初始怎样”：ABI 规定寄存器与初始栈

System V ABI 的 Process Initialization 约定了程序入口看到的初始状态。具体寄存器因架构不同，但概念上包括：

- `PC` 指向入口点；
- `SP` 指向按 ABI 对齐的初始栈；
- 栈中可找到 `argc`；
- 随后是 `argv[]` 指针数组和参数字符串；
- 再后是 `envp[]` 与环境变量字符串；
- auxiliary vector（`auxv`）提供页大小、program header 位置、入口点、随机数据、vDSO 等加载信息。

`main(argc, argv, envp)` 不是内核直接调用的第一个 C 函数。入口通常先运行 `_start`，由启动代码解析初始栈、初始化运行库，再调用 `main`；`main` 返回后，运行库处理正常退出。

此处必须区分四层：

```text
ELF/ABI       规定装载格式与入口初始状态
内核 execve   校验文件、建立用户映射和初始栈
动态加载器    映射共享库、重定位、解析符号
libc 启动代码 初始化运行时并调用 main
```

### 4.4 从 `minimal.S` 开始：地址空间里真的“什么也没有”吗

第 2 讲的 `minimal.S` 不链接 libc，只从 `_start` 发起系统调用。它没有 C 运行库替你提供 `malloc()`、`printf()` 和线程支持，但其地址空间并非字面意义的零映射：至少要有承载指令的可执行 segment、初始栈，以及内核/ABI 所需的特殊映射。

讲义所说“什么也没有”的准确含义是：

- ELF 只要求映射少量 `PT_LOAD` segment；
- 没有动态链接器和共享库带来的大量映射；
- 没有分配器预先管理好的 arena；
- 想获得新的可访问范围，程序必须最终借助内存管理系统调用。

早期 UNIX 常让进程用 `brk/sbrk` 移动 `.bss` 末端的 program break，从而扩展一段连续 heap。现代程序通常不应直接调用 `sbrk()`：libc 分配器会混合使用 `brk` 和 `mmap`，线程、地址空洞和大对象也使“只有一个连续堆”不够灵活。

### 4.5 实验 1：把符号地址、映射表与 ELF segment 对起来

依赖：Linux、GCC、binutils。将下面程序保存为 `/tmp/layout.c`：

```c
#define _GNU_SOURCE
#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <unistd.h>

static const char read_only[] = "I usually live in a read-only mapping";
static int initialized = 42;
static int zero_initialized;

int main(void) {
    int on_stack = 7;
    void *on_heap = malloc(4096);
    if (on_heap == NULL) {
        perror("malloc");
        return EXIT_FAILURE;
    }

    void *anon = mmap(NULL, 4096, PROT_READ | PROT_WRITE,
                      MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (anon == MAP_FAILED) {
        perror("mmap");
        free(on_heap);
        return EXIT_FAILURE;
    }

    /* 函数指针转整数是平台相关的；本实验明确面向常见 Linux ABI。 */
    printf("pid=%ld\n", (long)getpid());
    printf("main       = 0x%" PRIxPTR "\n", (uintptr_t)&main);
    printf("rodata     = %p\n", (const void *)read_only);
    printf("data       = %p\n", (void *)&initialized);
    printf("bss        = %p\n", (void *)&zero_initialized);
    printf("heap       = %p\n", on_heap);
    printf("anon mmap  = %p\n", anon);
    printf("stack      = %p\n\n", (void *)&on_stack);

    FILE *maps = fopen("/proc/self/maps", "r");
    if (maps == NULL) {
        perror("fopen /proc/self/maps");
        if (munmap(anon, 4096) < 0) perror("munmap");
        free(on_heap);
        return EXIT_FAILURE;
    }
    char line[4096];
    while (fgets(line, sizeof(line), maps) != NULL) {
        if (fputs(line, stdout) == EOF) {
            perror("fputs");
            fclose(maps);
            munmap(anon, 4096);
            free(on_heap);
            return EXIT_FAILURE;
        }
    }
    if (ferror(maps)) {
        perror("fgets /proc/self/maps");
    }
    if (fclose(maps) != 0) {
        perror("fclose");
    }
    if (munmap(anon, 4096) < 0) {
        perror("munmap");
        free(on_heap);
        return EXIT_FAILURE;
    }
    free(on_heap);
    return EXIT_SUCCESS;
}
```

编译并观察：

```bash
gcc -std=gnu11 -Wall -Wextra -O0 -g -fPIE -pie /tmp/layout.c -o /tmp/layout
/tmp/layout
readelf -W -l /tmp/layout
objdump -d /tmp/layout | sed -n '/<main>:/,+12p'
```

预期现象：

1. `main` 落在 `/tmp/layout` 的 `r-xp` 区域；
2. `read_only` 通常落在 `r--p` 区域；
3. 两个全局变量落在可写映射，尽管一个初值来自文件、另一个启动时清零；
4. `on_stack` 落在 `[stack]`，小块 `malloc` 通常落在 `[heap]`，但分配器实现可以选择 `mmap`；
5. 匿名 `mmap` 落在没有文件路径的 `rw-p` 区域；
6. `readelf` 的 `LOAD` segment 权限和进程映射大体对应，虚拟地址因 PIE/ASLR 加上了随机基址；
7. 每次运行绝对地址可能变化，但同一映像内的相对布局有规律。

可继续观察初始辅助向量：

```bash
cat /proc/self/auxv | od -An -tx8
getconf PAGESIZE
```

这里 `cat /proc/self/auxv` 中的 `self` 指运行 `cat` 的进程，而不是交互 shell。若要看某个已知进程，应使用 `/proc/PID/auxv`，并接受内核权限策略的检查。

## 5. 从 `mem[]` 到虚拟内存：映射是怎样兑现的

### 5.1 MMU 像操作系统强制戴上的“VR 眼镜”

程序发出的地址不是任意直达物理总线。用户态运行时，CPU 的 MMU 根据当前进程页表把虚拟页号翻译为物理页号，并保留页内偏移：

```text
虚拟地址 VA = [ Virtual Page Number | page offset ]
                         │
                    TLB / page table
                         ↓
物理地址 PA = [ Physical Page Number | same offset ]
```

页表项通常还包含 present/valid、user、read/write/execute、accessed、dirty 等状态。具体位和权限组合由 ISA 定义；“页面一定同时有独立 R/W/X 三个位”并非所有架构的通用事实。

切换进程时，内核会切换页表上下文。于是同一个 `0x400000` 在进程 A 和 B 中可翻译到完全不同的物理页。应用没有一条普通指令能摘掉这副眼镜；修改页表、切换页表根和配置相关控制寄存器需要内核特权。

TLB 缓存近期翻译，避免每次 load 都遍历多级页表。更改映射或权限后，内核可能需要使相关 TLB 项失效；多核上还可能触发 TLB shootdown。这是频繁 `mmap/munmap/mprotect` 的隐藏成本之一。

### 5.2 VMA 与页表项不是一回事

Linux 内核通常先用虚拟内存区域（VMA）记录一整段地址的高层语义，例如：

```text
[start, end) → readable, writable, private, anonymous
[start, end) → executable, private, backed by file X at offset Y
```

页表项则更接近硬件，通常以页为粒度记录当前翻译。一次成功的巨大匿名 `mmap()` 可以先建立 VMA，而不为范围中每一页分配物理页和最终页表项。两层数据结构回答不同问题：

- VMA 回答“若访问这个地址，内核承诺怎样处理”；
- 页表/TLB 回答“这次访问能否立即翻译到哪一页”。

把两者混成“页表里已经有了一大段 RAM”会误解 demand paging。

### 5.3 page fault 是延迟兑现机制，不等于程序错误

MMU 无法完成访问时会触发 page fault，CPU 转入内核。内核查 VMA 后可能：

- 首次读匿名页：映射共享只读零页，或准备清零页；
- 首次写匿名页：分配清零的物理页；
- 首次访问文件页：从 page cache 取得，必要时发起 I/O；
- 写 COW 页：复制物理页并把当前映射改为可写；
- 访问已换出的页：从 swap 恢复；
- 自动扩展满足规则的栈映射；
- 判断地址不存在或权限不符，向进程发送 `SIGSEGV`；
- 文件映射访问到已截短文件等无法兑现的 backing，可能发送 `SIGBUS`。

因此，“发生缺页”与“程序段错误”不等价。前者是硬件陷入内核的事件，后者是内核无法合法兑现访问后给进程的结果之一。

### 5.4 权限：读、写、执行是映射属性

`r/w/x` 不是注释。MMU 会按当前特权级和页表权限检查：

- 从不可读页 load 会故障；
- 向只读页 store 会故障，除非它恰好是内核可处理的 COW；
- 从不可执行页取指会故障（硬件支持 NX/XN 时）；
- 内核页即使存在，普通用户态也不能随意访问。

现代系统常追求 W^X：一页可写时不执行，生成完代码后由 JIT 用 `mprotect()` 改成只读可执行。它缩小“把输入写进内存再直接跳过去执行”的攻击面，但不是万能防护；JIT 仍需正确校验代码生成过程。

## 6. 地址空间管理 API：`mmap`、`munmap` 与 `mprotect`

### 6.1 把系统调用理解为“编辑映射表”

POSIX/Linux 的核心接口为：

```c
#include <sys/mman.h>

void *mmap(void *addr, size_t length, int prot, int flags,
           int fd, off_t offset);
int munmap(void *addr, size_t length);
int mprotect(void *addr, size_t length, int prot);
```

最有用的心智模型不是“`mmap` 分配 RAM”，而是：

- `mmap`：在地址空间中增加一段映射规则；
- `munmap`：删除覆盖指定范围的映射规则；
- `mprotect`：修改已有映射的访问权限。

一个基本的匿名映射：

```c
size_t len = 1u << 20;
void *p = mmap(NULL, len, PROT_READ | PROT_WRITE,
               MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
if (p == MAP_FAILED) {
    perror("mmap");
    return EXIT_FAILURE;
}

/* p[0..len) 可按映射语义访问。 */

if (munmap(p, len) < 0) {
    perror("munmap");
    return EXIT_FAILURE;
}
p = NULL;  /* 防止自己继续误用；内核不会替你改掉所有别名。 */
```

不要检查 `p == NULL` 判断失败；`mmap()` 的失败值是 `MAP_FAILED`。

### 6.2 六个参数分别控制什么

`addr`：

- `NULL` 表示让内核选择页对齐地址，通常是首选；
- 非空且没有 `MAP_FIXED` 时通常只是 hint，返回地址可能不同；
- `MAP_FIXED` 会强制替换目标范围内的已有映射，地址算错可立即破坏进程；
- Linux 的 `MAP_FIXED_NOREPLACE` 可在冲突时失败，适合确需固定地址又不愿覆盖的场景。

`length`：

- 必须大于 0；
- 内核按页覆盖范围，最后不足一页的部分也占映射页；
- 程序仍应只在自己定义的对象边界内访问，不能因页面被向上取整就把越界写当成合法 C。

`prot`：

- `PROT_NONE`：暂不可访问，适合 reservation 或 guard page；
- `PROT_READ`、`PROT_WRITE`、`PROT_EXEC`：请求对应权限；
- 权限还受文件打开方式、挂载选项、安全策略和硬件能力限制。

`flags` 至少要在两种可见性中选一种：

- `MAP_PRIVATE`：写入对当前映射私有，通常由 COW 实现；
- `MAP_SHARED`：修改对映射同一 backing 的参与者可见，文件映射的脏页可被回写。

`flags` 还决定来源：

- `MAP_ANONYMOUS`：没有文件内容，初始观察为零；此时常用 `fd=-1, offset=0`；
- 否则由 `fd` 指向的对象支撑映射。

`fd` 与 `offset`：

- 文件映射的 `offset` 通常必须按页大小对齐；
- 映射成功后可以关闭 `fd`，映射仍持有对 backing 的内核引用；
- `mmap` 不是把整个文件立刻复制到进程，而是把文件偏移区间接入虚拟地址；
- 访问文件当前末尾之外的整页可能得到 `SIGBUS`，不能用映射长度凭空扩展文件；应先用 `ftruncate()` 正确设置文件大小。

### 6.3 `MAP_PRIVATE`、`MAP_SHARED` 与 COW

这三个词常被错误地混为一谈：

- **private/shared** 是修改的可见性语义；
- **COW** 是实现 private 语义的一种延迟复制机制；
- **anonymous/file-backed** 是初始内容的来源。

对于 `fork()` 前建立的匿名私有映射，父子初始页表可共同指向同一物理页，并暂时移除写权限：

```text
fork 刚完成：
parent VA ─┐
           ├──> physical page P（只读/COW 标记）
child  VA ─┘

child 第一次写：
parent VA ───> physical page P
child  VA ───> copied page P'（写入发生在 P'）
```

子进程的 store 触发保护性 page fault；内核确认它是合法 COW 写，复制该页、调整页表，再重试指令。程序看到的是普通写入，而父进程仍看到旧值。

`MAP_SHARED` 则让父子继续指向共同 backing。它只提供**共享可见性**，并不提供锁、原子性、消息边界或崩溃一致性；多个进程并发更新结构体仍需同步协议。

### 6.4 实验 2：亲眼看见私有 COW 与共享页

仓库已提供完整示例 [mmap_cow.c](../../examples/mmap_cow.c)：

```bash
make -C examples mmap_cow
./examples/mmap_cow
```

典型输出形如：

```text
before fork: private=0x...:10 shared=0x...:10
child:      private=0x...:99 shared=0x...:77
parent:     private=0x...:10 shared=0x...:77
```

逐行解释：

1. 父进程分别建立匿名 `MAP_PRIVATE` 与 `MAP_SHARED` 页，并都写入 10；
2. `fork()` 后，子进程中的两个**虚拟地址数值**通常与父进程相同；
3. 子进程向 private 页写 99，触发 COW，父进程继续读到 10；
4. 子进程向 shared 页写 77，父进程等待子进程结束后读到 77；
5. `waitpid()` 提供这里所需的进程执行顺序；若去掉等待，父进程何时读到共享值就会有竞态；
6. `munmap()` 删除映射，之后任何旧指针都是悬空地址，不能继续解引用。

可用系统调用跟踪确认程序确实调用了这些 API：

```bash
strace -f -e trace=mmap,munmap,fork,clone,wait4 ./examples/mmap_cow
```

不同架构/版本可能用 `clone` 实现 libc 的 `fork` 包装，也可能展示额外的运行库映射。`strace` 看到的是系统调用边界，不会显示每次普通 load/store 或 COW 页复制；要观察缺页统计，可比较 `perf stat -e page-faults`（若系统权限允许）。

### 6.5 `munmap()`：删除的是规则，不是 C 变量

`munmap(addr, length)` 要求起始地址满足页对齐规则，并删除覆盖区间的映射。它可能把一个 VMA 切成左右两段。成功后：

- 指向该范围的所有 C 指针仍保留原来的数值，但已成为无效引用；
- 物理页只有在没有其他映射/缓存引用时才真正可回收；
- 文件仍然存在，共享页的持久化语义也不能仅由 `munmap` 推断；
- 另一个线程若同时访问该范围，可能立即收到故障。

这说明“释放内存”至少跨三层：分配器把对象归还 arena，进程撤销虚拟映射，内核回收物理 backing。`free()` 不保证调用 `munmap()`；它常把小块留在进程内复用。

### 6.6 `mprotect()`：JIT、guard page 与 W^X

`mprotect()` 改变已有页的权限。Linux 上起始地址必须页对齐；调用还可能拆分 VMA、更新页表并使 TLB 失效。

一个 JIT 的安全顺序通常是：

```text
mmap RW（不可执行）
  → 写入并校验生成的机器码
  → mprotect R-X
  → 按架构要求同步 instruction cache
  → 调用代码
```

而不是从一开始映射 `RWX`。有些系统要求通过专用 API 或安全授权切换 JIT 权限。

Guard page 则使用 `PROT_NONE`：在线程栈、特殊缓冲区或 arena 边界放一页不可访问映射，使越界尽早转成明确故障。但它只能捕捉跨到该页的越界，不能发现所有对象内部的短距离越界。

### 6.7 实验 3：大映射“瞬间成功”与首次触碰

下面的程序映射 1 GiB，但只按页写入指定数量的页面。保存为 `/tmp/lazy-map.c`：

```c
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>

static void report(const char *stage) {
    struct rusage u;
    if (getrusage(RUSAGE_SELF, &u) < 0) {
        perror("getrusage");
        exit(EXIT_FAILURE);
    }
    printf("%-12s minor_faults=%ld maxrss_kib=%ld\n",
           stage, u.ru_minflt, u.ru_maxrss);
}

int main(void) {
    const size_t length = 1UL << 30;
    long page = sysconf(_SC_PAGESIZE);
    if (page <= 0) {
        perror("sysconf");
        return EXIT_FAILURE;
    }
    unsigned char *p = mmap(NULL, length, PROT_READ | PROT_WRITE,
                            MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (p == MAP_FAILED) {
        perror("mmap");
        return EXIT_FAILURE;
    }
    report("after mmap");

    for (size_t off = 0; off < (64UL << 20); off += (size_t)page) {
        p[off] = (unsigned char)(off / (size_t)page);
    }
    report("after 64MiB");

    if (munmap(p, length) < 0) {
        perror("munmap");
        return EXIT_FAILURE;
    }
    return EXIT_SUCCESS;
}
```

运行：

```bash
gcc -std=gnu11 -Wall -Wextra -O2 /tmp/lazy-map.c -o /tmp/lazy-map
/usr/bin/time -v /tmp/lazy-map
```

通常 `mmap` 后 RSS 不会立刻增长 1 GiB；逐页写前 64 MiB 后，minor faults 和最大 RSS 明显增长。这里不能把具体数值写死：透明大页、内核版本、容器记账、已有页表和 overcommit 策略都会影响结果。

更重要的边界是：虚拟映射成功不保证未来每次写都能获得物理内存。Linux 允许一定程度的 overcommit；压力下可能在首次触碰时失败并触发 OOM 处理。高可靠程序还需理解资源限制、cgroup、锁页与内核 overcommit 策略，不能把一次非 `MAP_FAILED` 当成无限承诺。

## 7. `mmap` 为什么像内存功能的“总接口”

### 7.1 `malloc/free` 的下层机制

`malloc()` 是 libc API，不是系统调用。分配器通常：

1. 用 `brk` 或匿名 `mmap` 向内核取得较大区域；
2. 在用户态用 size class、空闲链表、arena 等结构切分；
3. 把小对象交给调用者；
4. `free()` 时先归还给分配器，合适时才用 `munmap` 或收缩 program break 还给内核。

讲义说“`brk/sbrk` 被保留，操作系统内用 `mmap` 实现”，应理解为它们在现代内核中共享虚拟内存区域管理、页表和缺页机制；不必假设 `brk` 系统调用的源码内部真的再次发起一个 `mmap` 系统调用。

可用：

```bash
strace -e trace=brk,mmap,munmap ./examples/mini_malloc
```

观察运行库和示例向内核取得大块地址范围。不同 libc、对象大小和环境变量会改变选择，实验结果才是当前机器的事实。

### 7.2 文件映射：不是把大文件全部搬进 RAM

文件映射让：

```text
virtual address + offset
       ↕
file descriptor 所引用对象 + file offset
```

建立对应关系。程序可以映射一个很大的稀疏文件，只访问头部 512 字节；未访问页通常无需读入。首次访问可能从 page cache 命中，也可能触发存储 I/O。

讲义用 `/dev/sda` 展示“Everything is a file”，但不要在日常机器上照抄写盘或盲目映射 128 GiB：块设备需要权限，容量可能不足，误写会破坏文件系统。可用普通临时文件做安全实验：

```bash
python3 - <<'PY'
import mmap
import os
import tempfile

with tempfile.NamedTemporaryFile() as f:
    f.write(b"OS mmap demo\n" + bytes(4096))
    f.flush()
    with mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ) as mm:
        print("mapped bytes:", len(mm))
        print("prefix:", mm[:13])
PY
```

`MAP_PRIVATE` 文件映射的写入进入私有 COW 页，不应回写原文件；`MAP_SHARED` 写入可进入共同 page cache 并最终回写。但“另一个进程已经看见修改”“`msync()` 已完成”“断电后文件系统元数据与数据都一致”是不同保证。持久化问题会在存储、文件系统和数据库章节继续展开。

### 7.3 共享内存

`shm_open()` 返回一个文件描述符，`ftruncate()` 设定大小，再由多个进程用 `MAP_SHARED` 映射，就能让不同虚拟地址引用同一 backing。Linux 的 `memfd_create()`、普通文件或继承的匿名共享映射也能承担相似角色。

映射只解决“能看见同一批字节”，不解决：

- 谁先写、谁后读；
- 多字节更新是否原子；
- CPU 缓存与编译器重排下的同步；
- 参与者崩溃时数据结构是否仍一致；
- 谁负责关闭、截断和删除共享对象。

因此共享内存会自然引向后续并发控制章节。

### 7.4 Memory-mapped I/O

设备驱动可把设备寄存器或 DMA 缓冲区映射给进程。例如开发板上的 `/dev/gpiomem` 允许受控访问一部分 GPIO 相关物理范围。普通 load/store 看起来像访问内存，背后却可能到达设备。

这类映射不等同于普通 RAM：

- 读写可能有副作用；
- 访问宽度、顺序和对齐由设备协议规定；
- 缓存属性与内存屏障很重要；
- 内核必须校验可映射范围和权限；
- `volatile` 只约束编译器，不能代替完整的设备访问 API。

### 7.5 JIT、AddressSanitizer 与运行时系统

JIT 用匿名映射承载生成代码，再通过权限切换执行。AddressSanitizer 则需要一大片 shadow address space，用少量 shadow 字节记录应用内存是否可访问；它可以预留巨大虚拟范围，却不必立刻占用同等物理内存。

可尝试：

```bash
printf 'int main(void){return 0;}\n' > /tmp/asan.c
gcc -fsanitize=address -g /tmp/asan.c -o /tmp/asan
strace -e trace=mmap,mprotect,munmap /tmp/asan
```

输出会随编译器和 ASan 运行时变化。要寻找的是“大范围映射与权限操作”，而不是死记某个地址。

## 8. Hacking Address Spaces：隔离为何允许“合法开门”

### 8.1 调试器并没有用普通指针穿墙

若地址空间隔离有效，`gdb` 怎么读写被调试进程？答案不是 MMU 失效，而是调试器请求更高权限的内核代办：

```text
debugger process
   │ ptrace/process_vm_readv/open /proc/PID/mem
   ▼
kernel performs permission check
   │ stop target / copy bytes / change registers / install breakpoint
   ▼
target address space
```

Linux 常见接口包括：

- `/proc/PID/maps`：映射范围、权限、偏移和 backing 名称；
- `/proc/PID/mem`：在满足检查后按虚拟地址读写目标内存；
- `ptrace()`：停止/继续、读写寄存器与内存、观察系统调用和信号；
- `process_vm_readv/writev()`：为进程间批量复制内存提供接口；
- core dump：在策略允许时保存某一时刻的进程映像；
- 共享内存：参与者主动把同一 backing 映射进各自地址空间。

“一个进程可以访问其他进程地址空间”不能省略条件。内核会综合检查 UID、目标是否 dumpable、ptrace relationship、capability、用户命名空间、LSM/Yama 策略和 `/proc` 挂载选项。容器内的 root 也不必然拥有宿主机任意进程的能力。

硬件 debug registers 可以实现断点/观察点；Intel Processor Trace 主要记录压缩的控制流信息，便于还原执行轨迹。它们是受控观测机制，不等于自动获得目标所有数据，更不等于可以绕过内核策略任意修改。

### 8.2 实验 4：只调试自己创建的“金币进程”

下面实验只针对你自己启动、明确用于调试的进程。不要把这些操作用于未获授权的软件或他人进程。

保存为 `/tmp/coins.c`：

```c
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

volatile int coins = 4950;

int main(void) {
    if (setvbuf(stdout, NULL, _IONBF, 0) != 0) {
        perror("setvbuf");
        return EXIT_FAILURE;
    }
    printf("pid=%ld, coins@%p, value=%d\n",
           (long)getpid(), (void *)&coins, coins);
    puts("Press Enter to print the value again...");
    if (getchar() == EOF && ferror(stdin)) {
        perror("getchar");
        return EXIT_FAILURE;
    }
    printf("coins=%d\n", coins);
    return EXIT_SUCCESS;
}
```

终端 A：

```bash
gcc -std=c11 -Wall -Wextra -O0 -g -fno-pie -no-pie /tmp/coins.c -o /tmp/coins
/tmp/coins
```

终端 B，把 `PID` 换成程序打印的数字：

```bash
gdb -q -p PID
```

在 GDB 中：

```gdb
p coins
set variable coins = 1000000
p coins
detach
quit
```

回到终端 A 按 Enter，应看到新值。这里使用 `-no-pie` 只是让教学符号定位更直观；有调试信息时，GDB 即使面对 PIE/ASLR 也能解析变量。

若 attach 报 `Operation not permitted`，先确认目标属于当前用户且是自己启动的实验程序。某些发行版启用 Yama `ptrace_scope`，只允许父进程调试子进程等更严格关系。不要为了一个演示长期关闭全局安全策略；可改用 `gdb /tmp/coins` 后在 GDB 内 `run`，此时调试器创建被调试子进程。

这个实验展示的是**内核授权的调试能力**：GDB 不是凭普通 `int *` 直接跨进程写入，它通过调试 API 请求内核修改目标。

## 9. 物理入侵：Game Genie 在地址转换之外动手

### 9.1 卡带与文件映射的类比

老式卡带主机把 ROM 接到 CPU 总线的一段地址。讲义用下面的现代伪代码建立直觉：

```c
mmap(NULL, rom_size, PROT_READ | PROT_EXEC,
     MAP_PRIVATE, rom_fd, 0);
```

这不是说老主机真的运行 POSIX `mmap()`；它表达的是同一种抽象效果：把 ROM 中的字节接到处理器可取指/读取的地址范围。老硬件通过地址译码和电气连接完成，现代 OS 则通过文件对象、页表和加载器完成。

![Game Genie 插在主机与卡带之间](../../sources/site_html/static/img/game-genie.jpg)

### 9.2 Game Genie 是总线上的 Look-up Table

Game Genie 位于主机与游戏卡带之间，可以把作弊码理解成查找规则：

```text
if CPU reads address a and cartridge would return x:
    return y
else:
    return original value
```

其中“旧值必须是 `x`”可避免同一地址在不同游戏版本中误匹配。它不必擦写 ROM；只需在读事务经过时替换数据，就能让 CPU 取到被修改的常量或指令。

![Game Genie 的地址/数据匹配思路](../../sources/site_html/static/img/game-genie-lut.jpg)

设备还要有类似 firmware/boot loader 的初始化阶段：先显示菜单、解析用户输入的代码、配置 LUT，再把控制权交给卡带程序。

![先配置替换规则，再进入游戏](../../sources/site_html/static/img/game-genie-init.jpg)

这个案例揭示了隔离的边界：页表保护的是 CPU 按正常路径发起的虚拟内存访问；若物理总线或内存控制路径本身不可信，攻击者可以在更低一层改变 CPU 实际读到的比特。

## 10. 金山游侠：从“搜索数值”到理解程序语义

### 10.1 为什么一次搜索几乎总有太多候选

假设画面显示经验值 4,950。扫描所有可读写映射寻找整数 4,950，会命中许多无关位置：缓存、字符串转换结果、历史状态、UI 对象、网络缓冲甚至恰巧相同的比特。

经典工具 Game Wizard 32、Cheat Engine、金山游侠采用重复过滤：

1. 初始搜索 `value == 4950`；
2. 打一个怪，经验变为 5100；
3. 在旧候选中保留 `value == 5100` 或“值增加”的地址；
4. 再触发几次可控变化，重复过滤；
5. 修改少量候选并观察真正语义效果。

还可以搜索“未知初值但变大/变小/不变”，或尝试 8/16/32/64 位整数、浮点数、大小端和缩放编码。工具做的是差分实验：**主动改变外部状态，再用内存变化缩小因果候选集。**

修改为 1,000,000 后，下一次游戏逻辑可能用新值升级；“锁血”则往往是工具反复写回一个值，以对抗游戏循环的扣血 store。

### 10.2 为什么地址扫描不等于理解语义

讲义给出一种失效模式：

```text
state_new = new State(state);
state_new.update(exp);
state = state_new;
```

每次更新都分配新对象，再让 `state` 指向它。上次找到的经验值地址很快变成旧对象或被释放空间；即使把旧地址锁成 1,000,000，游戏也可能再不读取它。

更多局限包括：

- 值是从等级、战斗记录等状态即时派生的，并没有单一权威变量；
- 同一状态有多个副本，修改 UI 缓存不会改变逻辑；
- 对象经常搬迁，ASLR 与分配器让跨运行绝对地址失效；
- 数据被编码、压缩、校验或拆成多个字段；
- 游戏逻辑在脚本 VM、GPU 或另一进程中；
- 联机游戏由服务器保存权威状态，本地修改只改变画面；
- 完整性检查、反调试和签名会发现代码/数据变化。

要继续前进，就不能只问“哪个地址等于 4950”，还要问：

- 谁写入这个地址？
- 写入值从哪些输入计算而来？
- 谁在下一帧读取它？
- 对象的身份如何跨分配保持？
- 最终决策发生在本地还是服务器？

调试器的 watchpoint、执行断点、反汇编、调用栈和数据流跟踪会把“比特匹配”提升为“执行语义分析”。针对具体游戏的外挂，本质上常像一份定制 GDB 脚本：在特定状态迁移发生时观测或修改它。

### 10.3 “变速齿轮”为何也需要理解边界

一种思路是拦截 `sleep`、`alarm` 或取时接口，让程序感到时间走得更快。但“把所有和时间相关的系统调用 patch 掉”只是直觉模型：

- `sleep()` 是 libc API，底层可能使用其他系统调用；
- `clock_gettime()` 可能通过 vDSO 完成，不一定每次陷入内核；
- 游戏可能按显示帧、音频时钟或硬件计数器推进；
- 多线程有多个计时来源；
- 联机服务器的时间与状态不会随本地 hook 一起加速。

因此 hook 某个函数能否生效，取决于程序真正依赖的时间语义。这再次验证“地址与 API 名称只是入口，语义才决定结果”。

## 11. 汉诺塔为什么会出现在外挂这一讲

汉诺塔的递归程序不仅计算一个数学答案，还按顺序打印移动步骤：

```c
void hanoi(int n, char from, char via, char to) {
    if (n == 0) return;
    hanoi(n - 1, from, to, via);
    printf("%c -> %c\n", from, to);
    hanoi(n - 1, via, from, to);
}
```

Fibonacci 若被当作纯数学函数，两个递归结果最后只做加法，交换求值先后不改变数值：

```c
int x = f(n - 1);
int y = f(n - 2);
return x + y;       // 换成 y + x，结果相同
```

汉诺塔不同：`printf` 改变进程外部可见的输出流，调用先后就是程序语义的一部分。C 表达式 `f(n - 1) + f(n - 2)` 也不保证操作数按从左到右求值，所以带副作用时不能靠“我看起来先写了左边”推断轨迹。

把汉诺塔当作一款小型游戏，“外挂”可以：

- 观察递归栈，推断当前盘与目标柱；
- 在 `printf` 或 move 函数处设断点，截获每一次状态迁移；
- 改写程序状态，让它跳过动画或自动执行答案；
- 不改内部内存，只读取输出并由外部程序重渲染。

这个例子把本讲拉回课程最早的状态机模型：只扫描某个瞬间的内存快照，未必足以理解程序；**执行顺序、I/O 副作用和状态迁移规则**同样是语义。真正强大的调试/分析工具会把地址空间快照和时间轴结合起来。

## 12. 畅想：从 Retro 游戏到“虚假的内存控制器”

### 12.1 Intelligence is cheap，但证据链仍不能省

讲义提出几种软硬融合方向：

- Retro 老游戏：逆向状态，把低分辨率画面重新渲染，再把输入/状态反馈回原进程；
- AI 游戏辅助：采集画面和操作轨迹，识别失误并给训练建议；
- 自动生成调试器插件：根据符号、反汇编和动态观测生成结构化状态视图；
- 把摄像头、控制器、进程内存和物理执行器组合成课程 Project。

AI 能降低编写扫描器、可视化器和适配脚本的成本，却不能让错误假设自动变真。可靠工作流仍然是：提出状态语义假设，设计可区分候选的输入，观测映射/执行证据，再逐步验证。

### 12.2 终极“外挂”：在内存控制路径上做镜像

讲义最后设想一个虚假的内存控制器：让写事务 double-write 到另一份镜像，外部观察者就能看到主机状态。这一思路不只用于游戏；内存镜像、容错、取证和调试都可能需要类似数据路径。

![从外设/内存总线观察主机内存](../../sources/site_html/static/img/pcileech.jpg)

需要严格区分概念畅想与现成保证：CXL 提供缓存一致性、内存扩展等协议能力，但“任意透明 double-write”不是看到 CXL 名字就自动成立；它需要具体控制器、拓扑、firmware 与安全配置支持。PCILeech 一类工具则说明，若外设能 DMA 且 IOMMU 没有正确限制，它可能绕过进程页表直接观察物理内存。

现代系统会用 IOMMU/VT-d、设备认证、端口安全、内存加密与总线链路保护缩小风险。这里的核心结论是：

```text
进程页表建立的是一层安全边界；
内核调试权限、DMA、内存控制器和物理接触位于边界之外。
```

任何此类实验都只能在自有或明确授权设备上进行。

## 13. 概念辨析：最容易混淆的边界

### 13.1 虚拟内存不等于 swap

虚拟内存首先是地址命名、映射、隔离和权限机制。换页只是 backing 管理的一种可能策略；没有 swap 的系统仍然有虚拟地址空间。

### 13.2 地址空间不等于已占用物理内存

VMA 可以存在而物理页尚未分配；文件页可由 page cache 共享；匿名页可映射共同零页；COW 页可被多个进程暂时共享。虚拟大小、RSS、PSS 与实际系统内存压力不是同一个指标。

### 13.3 指针不等于物理地址

用户指针通常是本进程的虚拟地址。DMA 地址、总线地址、内核虚拟地址和物理地址是其他命名空间，不能随意互换。即使数值偶然相同，语义也不同。

### 13.4 ELF section 不等于运行时 mapping

section 主要服务编译、链接和调试；`execve()` 装载主要看 program header 中的 segment。一个 `PT_LOAD` 可包含多个 section，一个 mapping 也会因页对齐、RELRO 或权限调整呈现出不同边界。

### 13.5 `mmap()` 不等于 `malloc()`

`mmap` 编辑页粒度映射；`malloc` 在进程内提供满足 C 对齐和对象大小要求的分配器接口。每个小对象都单独 `mmap` 会有系统调用、VMA、页表和碎片成本。

### 13.6 `MAP_SHARED` 不等于并发安全

共享只定义 backing 的可见性。没有原子操作、内存顺序和锁，两个执行流仍会数据竞争、看到中间状态或覆盖更新。

### 13.7 `MAP_PRIVATE` 不等于“与文件永久快照隔绝”

它保证写入不回写到原 backing，常用 COW 实现。外部同时修改或截短底层文件时的可见性和故障边界需要查具体标准与系统语义，不能把它当数据库快照。

### 13.8 `mprotect()` 不等于 C 语言对象安全

页权限粒度通常是页，无法区分同页中的两个小对象；它能阻止硬件访问，却不能检查数组逻辑边界、生命周期或类型规则。AddressSanitizer 之类工具才用 shadow metadata 补充更细粒度检查。

### 13.9 `volatile` 不等于同步原语

它主要约束编译器保留访问。跨线程/进程同步应使用 C 原子、锁、信号量或明确协议；设备 I/O 应使用平台 API 和屏障。

### 13.10 `/proc/PID/mem` 存在不等于人人可读写

`procfs` 只是把内核对象暴露成文件式接口。打开和访问时仍有 ptrace 类权限检查、安全模块和命名空间限制。默认隔离与受控调试并不矛盾。

## 14. 本讲小结：把“内存”改写成“映射关系”

本讲最重要的不是背下一个典型地址布局，而是完成一次观念替换：

```text
旧直觉：指针 → 一根内存条上的绝对位置

新模型：指针给出虚拟地址
          → 当前进程的映射规则
          → 权限检查
          → 匿名页、文件页、共享页、设备页或缺页处理
```

由此，整讲内容可以串成一条因果链：

1. CrazyOS 用每进程一个 `mem[]` 表示封闭世界；
2. 真实系统把它推广成稀疏、分页、有权限、可共享的地址空间；
3. `execve()` 按 ELF 和 ABI 建立初始映射、寄存器与栈；
4. `mmap/munmap/mprotect` 让进程请求编辑映射；
5. MMU、页表、TLB 和 page fault 高效兑现这些规则；
6. COW 让 `fork()` 保持复制语义而延迟物理复制；
7. 调试接口在内核授权下打开受控通道，Game Genie/DMA 则提醒我们物理边界更低；
8. 内存扫描能找到比特，只有结合执行轨迹才能理解语义。

下一讲会问：地址空间之外的文件、终端、管道、设备和 `/proc` 条目如何统一管理？UNIX 的答案是“对象 + 文件描述符 + 一组简单 API”。从本讲的 `mmap(fd, ...)` 已经能看见这个答案的轮廓：**映射的 backing 也要由某种内核对象来命名和授权。**

## 15. 思考题与延伸实验

1. 父子进程中某个指针数值完全相同，为何不能据此判断物理页相同？怎样用 COW 行为间接取证？
2. 为什么实现 COW 时通常要暂时撤掉写权限？若只在内核数据结构里记 `cow=true`，CPU 的普通 store 会怎样？
3. `execve()` 为什么保留 PID 和一部分文件描述符，却替换用户地址空间？`O_CLOEXEC` 解决了什么泄漏问题？
4. 比较 `readelf -S` 和 `readelf -l`。哪些 section 被合并进同一个 `LOAD` segment？为什么装载器更关心后者？
5. 把实验 3 的循环从“写每页”改为“读每页”，RSS 与缺页数量可能有何不同？Linux 的共享零页会怎样影响解释？
6. 给 `mmap_cow.c` 加一个文件映射，分别使用 `MAP_PRIVATE` 和 `MAP_SHARED`。修改后重新 `pread()` 文件，哪些变化可见？何时还需要 `msync/fsync`？
7. 用 `mprotect()` 把一页改为 `PROT_NONE` 再读取，在 GDB 中观察 `SIGSEGV` 的 fault address。为什么这只能保护整页？
8. 一个内存扫描器反复找到同一数值的五个副本。设计三次游戏操作，使候选集尽快缩小，并说明每次操作区分了什么假设。
9. 若权威金币数在服务器，本地把 UI 缓存改成一百万会发生什么？这说明系统边界在哪里？
10. `/proc/PID/maps` 是文本文件，但磁盘上并不存在它。下一讲的“Everything is a File”应怎样解释这一点？

建议阅读 Operating Systems: Three Easy Pieces：第 12 章 Dialogue、第 13 章 Address Spaces、第 14 章 Memory API；再结合本机 `man 2 mmap`、`man 2 mprotect`、`man 5 proc_pid_maps` 和 `man 2 ptrace` 核对平台细节。

## 16. PPT 内容覆盖表

| 原讲义标题/内容 | 本章对应位置 | 覆盖要点 |
| --- | --- | --- |
| Review & Comments；进程管理 API | §2.1 | `fork/execve/_exit/waitpid` 与地址空间的复制、重置、删除 |
| 观察 CrazyOS；进程是有“内存”的 | §2.2 | `CPUState + mem[]`、代码/数据/堆/栈、真实系统扩展 |
| Crazy OS Demo | §2.2 | 多进程模拟、单步执行、系统调用和最小地址空间模型 |
| 进程的地址空间 (Address Space) | §3.1 | 命名、隔离、保护、受控共享；纠正“物理连续”误解 |
| 地址空间和指针；volatile Quick Quiz | §3.2 | 虚拟地址、load/store、字节无类型、`volatile` 的作用与边界 |
| 重新理解指针 Demo | §3.2–§3.3、实验 1 | 代码、只读数据、全局数据、堆、栈与映射权限 |
| 问出今天这节课的关键问题 | §4.1–§4.3 | 每个字节怎么来：ISA 解释、链接布局、ELF、OS 加载、ABI 初始状态 |
| execve 后的地址空间；System V ABI | §4.2–§4.3 | `PT_LOAD`、`p_filesz/p_memsz`、PC/SP、argc/argv/envp/auxv |
| [探索进程地址空间](/OS/demos/virtualization/addr-space) | 实验 1、§5 | `/proc/self/maps`、`readelf`、VMA/页表/MMU 的对应与差异 |
| 如果我们从 minimal.S 开始？ | §4.4、§7.1 | 最小映像、`malloc` 来源、program break、`brk/sbrk`、libc 分配器 |
| MMU 是强制戴上的 VR 眼镜 | §5.1–§5.4 | 虚实地址翻译、TLB、权限、page fault、COW |
| \[OS API\] Memory Map 系统调用 | §6.1–§6.2 | `mmap/munmap/mprotect` 原型、参数、错误、对齐与边界 |
| 使用 mmap Example 1：大量空间 | §5.2–§5.3、实验 3 | demand paging、VMA、首次触碰、RSS/缺页、overcommit |
| 使用 mmap Example 2：Everything is a file | §7.2 | 文件映射、page cache、安全临时文件实验、`/dev/sda` 风险 |
| mmap Demo；ASan shadow memory | §7.5 | 巨大虚拟预留、`strace` 观察、权限操作 |
| 所有内存功能底层几乎都是 mmap | §7.1–§7.5 | malloc、文件、MMIO、共享内存、JIT、ASan |
| Hacking Address Spaces；gdb | §8 | 内核授权访问、`procfs/ptrace/process_vm_*` 与策略边界 |
| code is cheap / content-as-code | §12.1 | AI 降低工具生成成本，仍需实验验证语义 |
| 案例：物理入侵进程地址空间 | §9.1 | 金手指、卡带总线地址译码与文件映射类比，物理信任边界 |
| 物理入侵进程地址空间 (cont’) | §9.2 | Game Genie 的 LUT 与 Firmware 初始化、地址/旧值匹配和读替换 |
| Game Genie LUT | §9.2 | `(address, old value) → new value` 的读替换规则 |
| Game Genie as Firmware | §9.2 | 菜单、配置 LUT、加载卡带程序，类比 boot loader |
| 能做一个对任何游戏都生效的金手指吗？ | §10.1 | 需要程序语义：多轮差分扫描、数值表示、候选过滤 |
| Game Wizard 32、Cheat Engine、金山游侠 | §10.1–§10.2、实验 4 | 自有金币进程、GDB 改值、能力和授权边界 |
| 扫描内存：对有些游戏是不生效的 | §10.2 | 不可变/迁移对象、派生状态、多副本、服务器权威 |
| 定制 gdb 脚本；变速齿轮 | §10.2–§10.3 | watchpoint/数据流、hook 时间接口及 vDSO/服务器局限 |
| 汉诺塔 Demo | §11 | 副作用、调用顺序、C 求值顺序、执行轨迹与“外挂” |
| 畅想的空间；Retro 与 AI 辅助 | §12.1 | 状态逆向、重渲染、画面分析、软硬融合 Project |
| 例子：“外挂” 的终极手段 | §12.2 | 虚假内存控制器、CXL 镜像畅想、DMA/PCILeech、IOMMU 和物理防线 |
| Takeaways | §14 | 独立地址空间、映射管理、受控跨进程访问的完整归纳 |
| 阅读材料 | §15 末 | OSTEP 12–14 与 Linux man pages |
