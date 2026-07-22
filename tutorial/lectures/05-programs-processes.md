# 第 5 讲：程序和进程——把一台物理计算机变成许多“虚拟计算机”

> 原始讲义：[sources/notes/lect05.md](../../sources/notes/lect05.md)  
> 配套示例：[fork_exec.c](../../examples/fork_exec.c)、[mmap_cow.c](../../examples/mmap_cow.c)  
> 本讲关键词：虚拟化、程序、进程、procfs、`fork`、进程树、COW、`execve`、`PATH`、`exit`、`waitpid`
> 前一讲：[Scaling Law 和 Agentic AI](04-scaling-agentic-ai.md) · 后一讲：[进程的地址空间](06-address-space.md)

## 0. 本讲定位：从“状态机”走向“状态机的管理者”

前 3 讲已经从应用和硬件两侧建立了同一个模型：

- 应用程序从 `main(argc, argv)` 附近开始，按语言语义不断执行语句；
- 机器从 CPU Reset 开始，按 ISA 不断执行指令；
- 系统调用是应用状态机请求高特权级软件改变系统状态的入口；
- 从硬件看，操作系统本身也只是一个程序。

第 4 讲 Hacking Day 又补上了一层方法论：面对复杂系统，要先找到稳定的抽象和协议，再让人或 Agent 分工实现、运行并验证。它提出的 “Code is cheap; mechanism is king” 在本讲有一个非常具体的落点：生成一个看似能调用 `fork()` 的程序并不难，难的是准确理解它复制了什么、共享了什么、和其他 API 如何相互作用。

本讲由此进入操作系统课程的“正片”：**如果物理机器只有一份 CPU、内存和设备状态，操作系统怎样让许多程序都觉得自己拥有一台独立计算机？**

第一层答案是进程。我们会把进程理解成“正在进行的状态机实例”，再用三个动作统一 UNIX 进程管理：

```text
fork()     复制当前状态机
execve()   把当前状态机复位为另一个程序的初始状态
_exit()    销毁当前状态机
waitpid()  让父进程领取销毁结果
```

本讲最后仍会留下一个关键问题：`fork()` 声称复制每一个内存字节，操作系统真会立即复制几 GB 内存吗？不同进程中相同的数值地址为什么不会互相覆盖？第 6 讲“进程的地址空间”将沿着 COW、`/proc/PID/maps` 和 `mmap` 继续回答。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 用状态机语言准确区分程序、可执行文件和进程；
- 解释“虚拟化”为什么能让程序产生独占计算机的错觉；
- 读懂 CrazyOS 的最小调度循环，并说明它与真实内核的对应关系；
- 列举进程除代码和数据之外的关键内核状态；
- 用系统调用和 `/proc` 观察 PID、父子关系、调度状态、地址映射和文件描述符；
- 精确推导 `fork()` 后父子进程的控制流、返回值和可见状态；
- 区分“逻辑上完整复制”和“实现上按需 COW”；
- 解释进程树、孤儿进程、僵尸进程、`SIGCHLD` 和 `waitpid()` 的关系；
- 解释 fork bomb、Android Zygote、fork-based DFS 和 checkpoint 的共同机制；
- 推导 `fork` 习题在终端和管道下不同输出的原因；
- 说明 `execve(path, argv, envp)` 重置什么、保留什么；
- 区分 `execve` 与 `execl`、`execvp` 等 libc/POSIX 包装函数；
- 解释 `PATH` 搜索发生在 Shell 或库中，而不是内核中的“魔法”；
- 区分 libc `exit()`、libc `_exit()`、Linux `exit` 与 `exit_group`；
- 写出并观察一条可靠的 `fork → execve → waitpid` 生命周期。

问题地图如下：

| 问题 | 最小模型 | 本讲证据 |
| --- | --- | --- |
| 一台机器怎样同时运行多个程序？ | 轮流推进多个状态机 | CrazyOS、调度交错 |
| 程序与进程有何不同？ | 描述与运行实例 | 同一二进制的多个 PID |
| 进程只有寄存器和内存吗？ | 还有内核维护的元数据和对象引用 | `/proc/self`、进程查询 API |
| UNIX 怎样创建进程？ | 先复制，再按需复位 | `fork`、`execve` |
| `fork` 真复制全部物理内存吗？ | 语义完整，物理页延迟复制 | COW 实验 |
| 父进程怎样知道子进程结束？ | 退出状态暂存，父进程 wait | `SIGCHLD`、zombie、`waitpid` |
| 命令名怎样找到可执行文件？ | 用户态按 `PATH` 逐项尝试 | `strace -f -e execve` |
| `exit()` 为什么不是简单 syscall？ | libc 清理后才终止进程 | `atexit`、stdio 缓冲、`exit_group` |

## 2. 回顾：两个视角，一套数学模型

### 2.1 应用视角：操作系统是“对象 + API”

应用不能直接修改内核的进程表、磁盘控制器或网卡队列。它拿到的是内核公开的抽象对象，并通过 API 操作它们，例如：

- 进程及其 PID；
- 地址空间中的映射；
- 文件描述符引用的文件、终端、管道或 socket；
- 定时器、信号、共享内存等对象。

系统调用是这些 API 的底层入口。应用可以请求 `write(1, buf, n)`，但不能随意把字节写进内核的终端对象；内核检查参数和权限后替它完成状态迁移。

因此从应用侧可以写成：

\[
(S_{app}, S_{os}) \xrightarrow{\text{syscall}} (S'_{app}, S'_{os})
\]

其中 `S_app` 是寄存器和用户地址空间等应用状态，`S_os` 是进程表、文件对象和调度信息等内核状态。

### 2.2 硬件视角：操作系统也是程序

硬件不认识“进程”这个词。CPU 只根据当前 `PC` 取指、译码并执行；陷阱发生时，它按 ISA 规定切换特权状态并跳到内核入口。

从硬件侧看，操作系统就是那个拥有较高权限、能配置中断和页表、能把不同程序状态轮流放上 CPU 的程序。所谓“调度一个进程”，最终一定落实为保存一组状态、恢复另一组状态，然后继续执行指令。

### 2.3 两边为什么都能写成状态机

一段确定的程序可以抽象为：

\[
P = (S_0, T)
\]

- `S0` 是初始状态；
- `T` 是迁移规则，决定执行一条语句或指令后状态怎样变化。

C 程序的 `main`、机器 Reset 后的固件入口，看上去处于不同层次，却都有明确的起点和迁移规则。这一统一模型正是后面理解 `fork` 与 `execve` 的钥匙：一个负责复制当前状态，一个负责重新建立初始状态。

### 2.4 课堂开场的模型说明意味着什么

讲义首先说明了上节课实际使用的模型，并评价它速度快、但经常不听指令。这不是进程 API 的知识点，却延续了第 4 讲的重要学习方法：**生成代码不等于理解代码，模型名也不等于正确性保证。**

本讲的 `proc-info` 等 Demo 可以由 Agent 很快生成，但验收仍必须回到：

1. 它到底调用了哪些 API？
2. 输出来自用户态缓存、procfs，还是直接系统调用？
3. 动态状态是否存在竞态？
4. `strace` 和 `/proc` 能否支持解释？

这也是后文反复出现的“机器永远是对的”：当预测与结果不一致，先补全状态机模型，而不是把差异归咎于“玄学”。

## 3. 虚拟化：一个看似疯狂、其实极朴素的想法

### 3.1 “独占计算机”是一种抽象

操作系统给应用提供的最基础抽象之一是 process。理想化地看，每个进程都像拥有：

- 一颗从某个入口开始执行的 CPU；
- 一套独立寄存器；
- 一片从低地址到高地址的内存；
- 一组可通过系统调用访问的对象。

现实中 CPU 核心、物理内存和设备都要共享。操作系统通过时间复用、空间映射和访问控制制造这种错觉：

```text
物理 CPU 的时间       → 分成时间片交给多个进程
物理内存              → 映射成每个进程自己的地址空间
全局设备/文件对象      → 通过 fd、权限和命名空间受控访问
```

“虚拟”不等于“不真实”。进程确实执行了指令、消耗了 CPU 时间，也确实会改变文件；虚拟化只是把有限、共享、复杂的物理资源包装成更简单的接口。

### 3.2 从非递归汉诺塔得到的启发

递归程序可以被改写成显式栈的解释器：保存“当前执行到哪里、局部变量是什么”，每次取出一个待执行步骤。再推广一步，只要我们保存任意程序的 `PC`、寄存器和内存，就可以在另一个程序里模拟它执行一条指令。

于是产生讲义中的伪代码：

```c
while (1) {
    p = pickup_one();
    p->single_step();
}
```

如果 `p` 是某个程序的完整状态，那么：

1. `pickup_one()` 选择一个状态机；
2. `single_step()` 按该程序规则推进一次；
3. 循环选择其他状态机；
4. 每个状态机都持续前进，于是看起来像“同时”运行。

这已经具备操作系统调度器的核心形状。真实系统通常不会软件解释每条用户指令，而是把进程状态装入真实 CPU，让它直接运行一段时间：

```c
while (1) {
    p = pick_runnable_process();
    p->run_sometime_on_cpu();
}
```

定时器中断或系统调用使控制权回到内核，内核保存当前状态，再选择下一个进程。这里省略了并发、抢占、优先级和多核等大量细节，但“选择一个状态机并推进”这个最小模型没有变。

### 3.3 CrazyOS：把抽象变成 100 行左右的程序

课堂 [CrazyOS Demo](https://jyywiki.cn/OS/demos/virtualization/crazy-os/) 使用 `mini-rv32ima.h` 解释 RISC-V RV32IMA 指令。每个客体进程大致有：

```c
struct proc {
    struct CPUState cpu;  // PC、通用寄存器、CSR 等
    uint8_t mem[1 << 20]; // 该进程自己的 1 MiB 内存

    // 不在客体程序内存里的“OS 状态”
    char buf[256];
    int buf_len;
};
```

这段结构已经揭示了两层状态：

- `cpu + mem` 是被模拟程序眼中的机器状态；
- `buf + buf_len` 是 CrazyOS 为该进程维护、客体代码不能直接寻址的状态。

初始化时，Demo 把命令行给出的 raw binary 读入每个进程的 `mem`，把：

- 客体内存基址设为 `0x80000000`；
- `PC` 设为该基址；
- 栈指针 `SP` 设为 1 MiB 内存顶端；
- 其他寄存器和 CSR 清零。

主循环每次只执行一条客体指令，然后轮到下一个进程：

```c
int cur = 0;
while (1) {
    struct proc *p = &procs[cur];
    rv32ima_step(&p->cpu, 1);
    if (p->cpu.csrs[MCAUSE] == 8)
        handle_ecall(p);
    cur = (cur + 1) % n;
}
```

两个示例程序分别不断输出：

```text
P1: x = 10, 20, 30, ...
P2: x = 1, 2, 3, ...
```

即使它们各自都写着 `while (1)`，谁也不能霸占宿主：CrazyOS 每次只替它执行一条指令。输出会交错，直接显示两个状态机都在前进。

### 3.4 syscall 在 CrazyOS 里是什么

客体程序用 `ecall` 请求服务。模拟器观察到 `MCAUSE == 8` 后：

1. 从约定寄存器 `a7` 读取 syscall 号；
2. 从 `a0` 读取参数；
3. 例如 syscall 42 把一个字符送进该进程的输出缓冲；
4. 把返回值写回 `a0`；
5. 恢复必要状态，让 `PC` 从 `ecall` 的下一条指令继续。

这与真实系统调用的形状一致：应用只按 ABI 放好编号和参数，特权软件解释请求并返回。CrazyOS 中的字符缓冲还有一个教学作用：不同客体逐指令交错，但各进程先攒出完整一行再交给宿主 `stdout`，输出更容易阅读。

### 3.5 CrazyOS 没有展示什么

不要把教学模型误当成完整内核：

- 它靠解释器隔离客体，而真实 OS 主要靠 CPU 特权级和页表；
- 每个进程直接拥有固定大小数组，没有按需分页；
- 调度策略只是严格轮转一条指令，没有阻塞、优先级和多核；
- syscall 只有极少数手写分支；
- 示例加载器省略了完整 ELF 加载、权限和错误处理；
- 它没有进程创建、退出、信号、文件系统等完整生命周期。

恰恰因为删掉这些细节，主循环才清楚显示了操作系统最小职责：**保存多个状态机，决定推进哪一个，并处理它们不能自行完成的特权操作。**

## 4. 程序与进程：描述和“正在发生的事情”

### 4.1 程序是静态语义描述

讲义用下面的程序建立直觉：

```c
#include <unistd.h>

int main(void) {
    while (1) {
        write(1, "Hello, World!\n", 13);
    }
}
```

这是讲义用于定义概念的最小片段，故意省略了 `write` 失败和短写处理；真实程序必须检查返回值，并处理信号中断或部分写入。还要注意一个逐字节细节：`"Hello, World!\n"` 一共有 14 字节，这里的长度 13 只写到 `!`，不会写出换行。若想让长度随字面量自动保持正确，可写 `sizeof "Hello, World!\n" - 1`。

源代码描述了初始状态和迁移规则；编译后的可执行文件用机器能够加载的格式保存代码、只读数据、初始化数据和入口等信息。它们本身都不会“随时间变化”。磁盘上的同一个 ELF 文件今天和明天可以被执行许多次。

严格区分三个词会更清楚：

- **源程序**：用 C、Rust、汇编等语言表达的规则；
- **可执行文件/程序映像**：加载器可以据此建立初始机器状态的静态字节；
- **进程**：某次执行在时刻 `t` 的具体状态 `S_t`，以及内核为它维护的资源关系。

### 4.2 进程是状态机实例

当程序被加载并开始执行，静态描述成为一个不断演进的实例：

\[
S_0 \rightarrow S_1 \rightarrow S_2 \rightarrow \cdots
\]

这就是“process”一词中“进行中”的含义。同一个程序可以产生多个进程：

```bash
sleep 60 &
sleep 60 &
jobs -l
```

两个 `sleep` 来自同一可执行文件，却有不同 PID、寄存器现场、地址空间和生命周期。反过来，同一个进程可以先运行 Shell 的子进程代码，再经 `execve()` 变成 `sleep`；PID 可以保持不变，而其中的程序映像彻底更换。

所以以下等式都是错的：

```text
程序 = 磁盘文件
程序 = PID
进程 = 某个永久不变的代码映像
```

更好的说法是：**可执行文件描述一种初始状态；进程承载某次执行；PID 只是在某段时间内标识这个实例。** 进程退出后 PID 可以复用，因此长期保存一个裸 PID 并不能永久标识同一主体。

### 4.3 仅有寄存器和用户内存还不够

若要暂停并恢复上述无限输出程序，至少要保存：

- `PC`：下次从哪条指令继续；
- 通用寄存器和标志；
- 用户地址空间中的代码、栈、堆和全局变量。

但真实进程还与大量内核状态相连。课堂 `proc-info` Demo 所探索的内容包括：

| 状态类别 | 典型内容 | 观察入口 |
| --- | --- | --- |
| 身份关系 | PID、PPID、线程 ID、进程组、会话 | `getpid()`、`getppid()`、`getpgrp()`、`getsid()` |
| 凭据 | UID/EUID、GID/EGID、附加组、capability | `getuid()`、`getgroups()`、`/proc/self/status` |
| 程序入口信息 | 命令行、环境、可执行文件 | `cmdline`、`environ`、`exe` |
| 文件系统视图 | 当前目录、根目录、umask、mount namespace | `cwd`、`root`、`mountinfo`、`umask()` |
| 打开的对象 | fd 表及每个 fd 的目标 | `/proc/self/fd/` |
| 地址空间 | 代码、库、堆、栈等映射 | `/proc/self/maps` |
| 调度状态 | 运行状态、策略、优先级、CPU affinity | `stat`、`sched_getscheduler()`、`sched_getaffinity()` |
| 资源控制 | rlimit、cgroup、I/O 统计 | `limits`、`cgroup`、`io` |
| 隔离视图 | PID、mount、user、network 等 namespace | `/proc/self/ns/` |
| 异步状态 | 信号屏蔽/待决集合、处置、interval timer | `sigprocmask()`、`sigpending()`、`getitimer()` |
| 安全属性 | seccomp、dumpable、no-new-privs | `prctl()`、`status` |
| 使用统计 | 用户/内核 CPU 时间、缺页、上下文切换 | `getrusage()` |

这些状态不一定都存放在一块名为 `struct process` 的结构里。Linux 会把进程、线程、内存描述、文件表、凭据、namespace 等拆成多个结构，并通过引用关联。这里说“进程包含这些状态”，指的是从语义和生命周期上它们共同决定进程行为。

### 4.4 “进程自身不可见”应怎样理解

讲义说这些是进程自身不直接可见的 OS 状态，并不意味着程序永远不能查询它们。区别在于：

- 普通变量可用一条用户态 load 直接读取；
- PID、调度策略、凭据等由内核掌握，必须通过系统调用或 procfs 请求；
- 内核可以做权限检查，也可以在两次读取之间改变状态。

例如程序可以调用 `getpid()` 获得 PID，却不能通过修改某个用户变量把自己变成 PID 1。程序能读取 `/proc/self/status`，却不能把写入这个文本文件当作任意修改调度状态的方法。

## 5. 查询进程状态：系统调用与 procfs

### 5.1 一组看似零散、其实属于不同子系统的 API

Linux/POSIX 提供许多查询函数：

```c
pid_t getpid(void);
pid_t getppid(void);
pid_t getpgrp(void);
pid_t getsid(pid_t pid);
uid_t getuid(void);
uid_t geteuid(void);
gid_t getgid(void);
gid_t getegid(void);
```

它们之所以没有被合并成一个巨大的 `get_everything_about_process()`，是因为这些状态属于不同抽象、权限和演化路径：身份、作业控制、会话、用户凭据、调度和安全不是同一件事。后续讲到 Shell、文件权限、信号和容器时会逐一看到它们的用途。

这些名字首先是程序调用的 API；libc 负责按目标系统 ABI 实现它们。“API 名字”和“内核中必然出现同名 syscall”不能仅凭拼写机械画等号。判断具体系统上的行为，应使用 `strace` 或查看对应 libc 与内核 ABI。

### 5.2 `/proc/PID`：把动态内核状态投影成目录树

procfs 是内核生成的伪文件系统。Linux 通常把它挂载在 `/proc`：

```text
/proc/1234/status     人类较易读的身份、状态、内存和信号摘要
/proc/1234/stat       适合程序解析的紧凑字段
/proc/1234/maps       地址映射
/proc/1234/fd/        文件描述符符号链接
/proc/1234/cmdline    NUL 分隔的 argv
/proc/1234/environ    NUL 分隔的环境变量
/proc/1234/exe        指向可执行文件的符号链接
/proc/1234/cwd        指向当前目录的符号链接
/proc/1234/task/      该进程的各线程
```

`/proc/self` 是一个特殊入口：读取它的进程会看到自己的 PID，因此工具不必先调用 `getpid()` 再拼路径。

从编程接口看，它仍然使用熟悉的文件 API：

- `opendir/readdir` 枚举目录；
- `open/read/close` 读取文本或二进制样式的数据；
- `readlink` 读取 `exe`、`cwd` 和 `fd/N` 等符号链接目标。

这就是 UNIX “把对象呈现成文件”思想的一个预告。第 7 讲将把这种对象访问模式扩展到文件描述符和其他设备。

### 5.3 procfs 不是普通磁盘快照

使用 `/proc` 时要记住四个边界：

1. **内容动态生成。** 两次读取之间进程可能运行、阻塞、`exec` 或退出。
2. **跨文件不保证原子快照。** 先读 `status` 再读 `fd`，二者可能对应不同瞬间。
3. **权限和系统配置会限制可见性。** 其他用户的 `environ`、`maps` 或 fd 可能不可读；容器看到的 `/proc` 也可能只含某个 PID namespace。
4. **PID 会复用。** 枚举到数字目录后，原进程可能退出，同一数字后来指向另一个实例。

因此一个健壮的观察工具必须接受 `open/readlink` 失败，而不是把“刚才列出来了”当作“现在必然还存在”。这也是课堂 `proc-info` 逐项检查失败并继续展示的原因。

### 5.4 Linux 进程状态字母不是完整生命周期

在 `/proc/PID/status` 的 `State` 或 `ps` 输出中，常见状态包括：

- `R`：正在运行或可运行；
- `S`：可中断睡眠，通常在等待事件；
- `D`：不可中断睡眠，常见于某些内核 I/O 等待；
- `T`/`t`：被作业控制信号停止，或被调试器跟踪停止；
- `Z`：僵尸，已结束执行但尚未被父进程领取；
- `I`：某些 Linux 内核空闲线程。

这些字母是 Linux 对调度/等待状态的摘要，不是“程序、进程、线程”的定义。一个进程在一次 `cat /proc/PID/status` 之后就可能从 `R` 变为 `S`；看到 `S` 也不意味着它已经退出。

### 5.5 实验一：观察一个进程的内核侧状态

依赖：Linux、`bash` 和常见 procfs；不需要 root。下面只观察我们自己启动的 `sleep`：

```bash
sleep 30 &
demo_pid=$!

printf 'shell=%s child=%s\n' "$$" "$demo_pid"
grep -E '^(Name|State|Pid|PPid|Uid|Gid|Threads):' "/proc/$demo_pid/status"
readlink "/proc/$demo_pid/exe"
readlink "/proc/$demo_pid/cwd"
ls -l "/proc/$demo_pid/fd"
sed -n '1,8p' "/proc/$demo_pid/maps"

kill "$demo_pid"
wait "$demo_pid" 2>/dev/null || true
```

逐项解读：

- `$!` 是 Shell 记录的最近后台作业 PID；
- `PPid` 通常是当前 Shell PID `$$`，说明 Shell 创建了它；
- `State` 多半为 `S`，因为 `sleep` 正等待定时事件而不是一直占用 CPU；
- `exe` 指向实际加载的可执行文件；
- `cwd` 通常继承自 Shell；
- fd 0、1、2 指向终端、管道或重定向对象，具体取决于运行环境；
- `maps` 显示可执行文件、动态库、堆栈等虚拟内存区域；
- `kill` 默认发送 `SIGTERM`，`wait` 领取这个测试子进程的结束结果。

在另一个终端重复读取 `State`，结果可能变化。这不是 procfs 不可靠，而是你正在观察一个继续演进的状态机。

本节只训练 procfs 的观察方法，不给出课程 MiniLab 的数据结构、遍历方案或实现答案。

## 6. 进程管理：把内核看成状态机管理者

### 6.1 一个直观接口：spawn 与 terminate

既然进程是状态机，最直观的管理接口似乎是：

```text
spawn(path, argv)  按可执行文件创建新状态机
terminate(status)  销毁当前状态机
```

Windows 的 `CreateProcess` 在概念上接近这种设计：一次调用指定程序、命令行、继承属性和初始 I/O 等信息，创建一个新进程。

UNIX 选择了一个更奇特、也更具组合性的分解：

```text
fork()     复制已有状态机
execve()   把一个已有状态机复位为指定程序
_exit()    终止状态机
```

这样，Shell 可以在 `fork` 后、`execve` 前让子进程修改文件描述符、当前目录、凭据和信号状态，再启动程序。重定向和管道因此能用少数正交 API 组合出来。代价是 `fork` 与线程、锁、fd 和大量内存的交互都需要认真定义。

现代系统也提供 `posix_spawn` 等更接近“一步创建”的接口，但它们仍处在 UNIX 进程语义的生态中。

## 7. `fork()`：复制正在运行的状态机

### 7.1 接口和最重要的控制流事实

```c
#include <sys/types.h>
#include <unistd.h>

pid_t fork(void);
```

成功时，一次调用产生两个继续执行的进程：

```c
pid_t pid = fork();
if (pid < 0) {
    /* 只有父进程走到这里：创建失败，errno 给出原因 */
} else if (pid == 0) {
    /* 子进程 */
} else {
    /* 父进程；pid 是新子进程的 PID */
}
```

关键点不是“子进程从 `main` 重跑”，而是：

> 父子进程都从 `fork()` 返回之后的逻辑位置继续；它们通过不同返回值走向不同分支。

从状态机角度，内核复制当前用户态现场，再有意改写两个现场中的 syscall 返回值：父进程看到子 PID，子进程看到 0。新子进程有自己的 PID，其 PPID 指向调用者。

失败时没有子进程，调用者得到 `-1`。常见原因可能是用户/系统进程数限制、cgroup PID 限制或内存不足；代码必须检查，不能假定永远成功。

### 7.2 “完整复制”是一条语义承诺

讲义说 `fork` 复制寄存器和每一个内存字节。这句话描述的是**可观察语义**：在 `fork` 返回的一刻，子进程看到与父进程相同的用户内存内容、代码位置和大部分进程属性；此后普通私有内存的修改互不影响。

但“进程状态”不只一种，因此必须逐项问复制规则：

| 状态 | `fork` 后的典型语义 |
| --- | --- |
| PID | 子进程获得新 PID |
| PPID | 子进程的 PPID 是调用者 PID |
| PC/栈/堆/全局变量 | 初始内容相同，之后私有变化 |
| syscall 返回寄存器 | 父为子 PID，子为 0 |
| fd 表 | 表项被复制，但通常引用相同 open file description |
| 文件偏移/部分状态标志 | 因引用同一 open file description 而共享 |
| 当前目录、根、umask | 继承一份相同设置，之后可各自改变 |
| 凭据、进程组、会话 | 按规范继承相应关系；PID/PPID 例外 |
| 信号处置与屏蔽字 | 大体继承；子进程的 pending signals 为空 |
| 调度/资源限制 | 多数继承，但统计和若干属性有专门规则 |
| 内存映射 | 私有映射呈现快照语义，共享映射仍共享 |
| 线程 | 子进程只保留调用 `fork` 的那一个线程 |

这张表不是 `fork(2)` 的完整替代品。真正写系统软件时，应针对会用到的每种状态查手册，而不是背一句“全部复制”。

### 7.3 为什么文件描述符是著名 caveat

假设父进程的 fd 3 指向某个打开文件：

```text
父 fd 表[3] ─┐
              ├─→ 内核 open file description → 文件对象
子 fd 表[3] ─┘                         └→ 当前 offset
```

`fork` 复制 fd 表中的引用，不是重新 `open` 一次文件。因此父子通常共享该打开实例的文件偏移。父进程 `read(fd, ..., 100)` 后，子进程再读，往往从后 100 字节继续。

与此同时，父子可以各自 `close(3)`；关闭一个表项只减少一个引用，另一个进程的 fd 仍然有效。第 7、8 讲会利用这条规则构造管道和重定向。

### 7.4 多线程进程中的 `fork` 更棘手

若一个拥有 8 个线程的进程由其中 1 个线程调用 `fork`，子进程只存在这个调用线程，但整份用户内存都被复制。于是可能出现：

1. 另一个线程在父进程中持有 libc 或应用 mutex；
2. 锁的“已持有”状态出现在子进程快照里；
3. 持锁线程没有被复制到子进程；
4. 子进程若再次调用需要该锁的函数，可能永久死锁。

POSIX 因此严格限制多线程程序在 `fork` 后到 `exec` 前能安全调用的函数，通常只应使用 async-signal-safe 操作。`pthread_atfork` 可以安排锁的准备和恢复，但很难替整个第三方库生态兜底。这也是现代大型程序偏好 `posix_spawn`、进程池或专门 fork server 的原因之一。

### 7.5 父子谁先运行没有保证

`fork` 成功后，父子都是可运行状态。以下顺序都可能发生：

```text
父先打印 → 子打印
子先打印 → 父打印
父继续很久 → 子才首次获得 CPU
不同 CPU 核上真实并行
```

除非用 `waitpid`、管道、信号或其他同步机制建立顺序，否则不能把一次实验恰好看到的排列当作 API 保证。

### 7.6 实验二：观察完整的 `fork → exec → wait`

仓库已经提供了检查错误的完整示例：

```bash
make -C examples fork_exec
./examples/fork_exec
strace -f -e trace=process ./examples/fork_exec
```

典型普通输出形如：

```text
parent before fork: pid=41000
child after exec: pid=41001 ppid=41000
parent reaped child=41001, exit=7
```

精确 PID 每次不同，子进程的调度时机也不固定，但应观察到：

1. 父进程在 `fork` 前主动 `fflush(stdout)`，避免用户态缓冲被复制；
2. `fork` 后子进程调用 `execl`，成功后执行同一文件的 `--child` 分支；
3. 子进程在 `exec` 前后 PID 不变，说明 `exec` 没有创建新进程；
4. 子进程 `return 7`，最终产生退出状态 7；
5. 父进程的 `waitpid` 阻塞到指定子进程结束，并用 `WIFEXITED/WEXITSTATUS` 解码状态；
6. `strace -f` 会同时追踪父子，否则容易漏掉子进程的 `execve` 和退出。

如果 `exec` 失败，示例打印错误并调用 `_exit(127)`。这一失败路径很重要：成功的 `exec` 永不返回；只有失败时才会执行下一行。

## 8. 进程树、退出通知与重新收养

### 8.1 创建关系自然形成树

每次 `fork` 都建立一条父子关系。若 A 创建 B、B 创建 C：

```text
A
└── B
    └── C
```

`getppid()` 让进程查询当前父进程。Shell、服务管理器和容器运行时都利用父子关系组织作业与回收结果。

但“树”是动态的：节点会退出、被停止、`exec` 成另一个程序，也会继续创建孩子。一次 `pstree` 输出只是一个瞬间的观察。

### 8.2 B 退出后，C 的 PPID 不是简单“往上提”

直觉可能认为 C 自动成为 A 的直接子进程。真实 UNIX/Linux 必须考虑退出通知和回收责任：

- 子进程终止时，内核通常向其当前父进程产生 `SIGCHLD`；
- 父进程通过 `wait/waitpid` 领取退出状态；
- 如果任意祖先都能自动接手，通知和等待对象会变得含混。

在 Linux 上，活着的孤儿后代通常会被重新收养给：

1. 最近的、标记为 child subreaper 的祖先；
2. 若没有，则是所在 PID namespace 的 init/reaper 进程。

因此 A 只有在恰好承担 subreaper 等角色时才一定接手 C；普通情况下不能笼统回答“PPID 往上一级”。服务管理器和容器运行时会使用 subreaper 机制，正是为了可靠回收更深层后代。

### 8.3 孤儿与僵尸是两件相反的事

- **孤儿进程**：自己还活着，但父进程先退出；它会被新的 reaper 收养。
- **僵尸进程**：自己已经结束执行，但父进程尚未 `wait`；内核保留少量退出记录。

僵尸没有继续运行的用户地址空间，不能靠再发 `SIGKILL` “杀掉”；解决办法是让父进程领取状态，或让失职父进程退出后由 reaper 接管回收。

内核暂存僵尸至少是为了保存：

- PID 和父子关系；
- 正常退出码或致命信号；
- 一些资源使用统计。

如果完全不保存，父进程晚一点调用 `waitpid` 就会丢失结果。

### 8.4 `SIGCHLD` 是通知，`waitpid` 才是领取

子进程停止、继续或终止时，父进程可能收到 `SIGCHLD`。信号告诉父进程“状态发生了变化”，但一个信号不等于一个完整退出记录，普通信号还可能合并。

健壮的信号处理通常在合适位置循环执行非阻塞 `waitpid(-1, &status, WNOHANG)`，直到没有更多已终止孩子。没有安装 handler 的简单程序也可以在主流程中直接阻塞 `waitpid`。

这里要区分：

```text
SIGCHLD              异步通知机制
子进程 zombie 记录   内核保存的结果
waitpid              查询并领取结果的 API
```

### 8.5 课堂五层进程树 Demo 在观察什么

[创建进程子树 Demo](https://jyywiki.cn/OS/demos/virtualization/pstree/) 递归到 5 层，每个非叶节点创建两个孩子。每个子进程在退出前：

1. 打印一次 `getppid() --> getpid()`；
2. 睡眠一秒；
3. 从 `/dev/urandom` 取随机数，约一半直接提前退出；
4. 没提前退出的再睡一秒，第二次打印父子关系；
5. 退出。

这个 Demo 的重点不在得到一棵每次相同的漂亮树，而在比较同一进程前后两次打印：

- 其父进程可能仍存在，PPID 不变；
- 其父进程可能已随机退出，PPID 变成 subreaper/init；
- 输出顺序由调度决定，不等于创建顺序；
- 一些节点只有第一次输出，因为它们随机提前终止；
- 父进程若不等待所有后代，深层进程可能在祖先退出后继续运行。

Demo 还用 Mermaid 边的格式输出 PID 关系，方便把动态结果可视化。不要把输出文本顺序当成树的先序遍历；每一行中的 PID 关系才是证据。

本教程只解释课堂 Demo 的行为与验证方法，不提供 M2 的实现方案或答案。

## 9. `fork()` 的能力、代价与危险

### 9.1 fork bomb：指数增长不是“快一点”，而是完全不同的量级

如果每个现有进程都再 `fork` 一次，理想化的进程数满足：

\[
N_{k+1}=2N_k,\qquad N_k=2^k
\]

从 1 个进程开始：

```text
k = 10   → 1,024
k = 20   → 1,048,576
k = 30   → 1,073,741,824
```

系统远在第三行之前就会耗尽 PID、进程表、内存、调度时间或用户限制。即使 Linux 有 OOM killer，也不能保证系统体验良好：fork bomb 可能先耗尽 PID/cgroup 额度，使终端连新命令都无法创建。

现代系统常用多层限制：

- `RLIMIT_NPROC`/`ulimit -u` 限制用户可拥有的进程数；
- cgroup v2 `pids.max` 限制一组任务；
- systemd `TasksMax`、容器配额和服务监督限制影响范围；
- 内核全局 PID 上限和内存回收提供最后边界。

**不要在课程机器、宿主机或共享服务器上运行 fork bomb。** 安全地感受增长只需计算数字：

```bash
python3 - <<'PY'
for generation in range(0, 21, 5):
    print(f"after {generation:2d} rounds: {2 ** generation:,} processes")
PY
```

这保留了算法结论，却不真的消耗进程资源。

### 9.2 为什么“全量快照”有实际价值

`fork` 的强大之处是：程序不必把当前状态序列化成复杂参数，子进程天然拥有一个一致的逻辑快照。

#### 用途一：先预处理，再分段工作

父进程可以先构造代价昂贵、之后只读的 `prime_table`，再创建多个子进程处理不同区间。只读页在 COW 下可以继续共享物理内存：

```text
父：加载运行时 + 构造大表
  ├─ fork → 子 1 读取同一份表，处理区间 A
  ├─ fork → 子 2 读取同一份表，处理区间 B
  └─ fork → 子 3 读取同一份表，处理区间 C
```

如果某个子进程写表中一页，那一页才分裂成私有副本。

#### 用途二：Android Zygote 降低冷启动成本

Android 的 Zygote 进程预先加载虚拟机和常用框架资源，然后通过 `fork` 派生应用进程。新应用继承已准备好的运行时状态，许多只读物理页可共享，避免每个应用从零重复加载。

这不是“所有状态都安全共享”：派生后仍要设置应用身份、权限、调度和专属资源；写入页面会触发 COW。Zygote 展示的是 fork 快照的工程化使用，而不是免费复制整台机器。

#### 用途三：并行搜索

深度优先搜索通常显式传递“当前地图、已走路径、步数”。[fork-based DFS Demo](https://jyywiki.cn/OS/demos/virtualization/fork-dfs/) 换了一种表示：每到一个节点，就为四个方向分别 `fork`。

在每个子进程中：

1. `map` 初始是父进程当前路径的快照；
2. 子进程在自己的 `map[x][y]` 写入方向箭头；
3. 若下一格可走，就递归搜索；
4. 到达终点后一次构造并写出完整路径；
5. 父进程等待本层创建的所有孩子。

由于普通全局数组是私有/COW 映射，一个分支写箭头不会污染兄弟分支。这里 `fork` 相当于自动保存整个搜索现场。源码在每层先 `sleep(1)`，让搜索展开更容易被肉眼观察；它先启动本层各方向的孩子，之后统一 `wait`，所以分支可以并行推进。若在每次 `fork` 后立刻 `waitpid`，搜索就会被串行化。找到目标时，Demo 先把整幅路径拼到一个缓冲区，再用一次 `write` 输出，以减少多个解的字符互相穿插。

代价同样明显：Demo 甚至先为四个方向创建进程，再在子进程里检查是否合法，会产生大量短命进程；搜索树稍大就会遇到指数爆炸。实际并行搜索通常用任务队列、线程池、剪枝和共享结果，避免“一节点一进程”。

#### 用途四：隔离执行与 checkpoint 思想

父进程可以保留一个已初始化状态，让子进程执行不可信或容易崩溃的任务。子进程崩溃不会直接抹掉父进程的私有内存，父进程可继续派生下一次尝试。模糊测试中的 fork server 就利用类似思路减少重复初始化。

但 `fork` 不是全系统时间倒流：

- 已经发到网络的包不会撤回；
- 父子共享的 open file description 可能共享偏移；
- `MAP_SHARED` 内存和外部数据库写入不会自动回滚；
- 多线程锁与设备状态有额外问题。

所以它提供的是**进程私有状态快照**，不是所有外部副作用的事务。

### 9.3 COW：语义完整复制，实现延迟复制

如果父进程有 8 GiB 地址空间，而子进程马上 `execve`，立即复制 8 GiB 显然浪费。现代系统通常采用 Copy-on-Write：

```text
fork 刚返回：
父页表 ─┐
         ├─→ 同一个物理页（暂时只读/COW）
子页表 ─┘

子进程首次写该页：
           ┌─→ 原物理页（父继续看到旧内容）
父页表 ────┘
子页表 ─────→ 新复制的物理页（包含子的新内容）
```

典型过程是：

1. `fork` 复制或共享页表层级和映射元数据；
2. 父子私有可写页暂时都以不可直接写的方式映射同一物理页；
3. 任一方写入触发页故障；
4. 内核确认这是合法 COW 写，而不是越权访问；
5. 分配新页、复制内容、更新写入方页表并重试指令。

因此：

- `fork` 返回很快不等于完全没有成本，页表、内核对象和 TLB 相关工作仍存在；
- 父子读取大量相同数据时，物理页可共享；
- 双方大量写入时，最终仍会付出复制和内存成本；
- `MAP_SHARED` 映射故意保持共享，不采用“写后互相隔离”的语义。

### 9.4 实验三：同一虚拟地址，私有页和共享页表现不同

仓库的 `mmap_cow.c` 同时创建一个 `MAP_PRIVATE` 页和一个 `MAP_SHARED` 页：

```bash
make -C examples mmap_cow
./examples/mmap_cow
```

典型输出：

```text
before fork: private=0x...:10 shared=0x...:10
child:      private=0x...:99 shared=0x...:77
parent:     private=0x...:10 shared=0x...:77
```

应关注的不是随机化后的具体地址，而是三件事：

1. 父子打印的虚拟地址数值通常相同；
2. 子写私有页后，父仍读到 10，说明语义上已经分离；
3. 子写共享页后，父读到 77，说明 `MAP_SHARED` 映射指向共同状态。

“地址相同”不等于“物理对象相同”。这一反直觉现象正是第 6 讲地址空间的入口。

## 10. 认真推导 `fork` 习题：状态中不能漏掉 libc 缓冲

### 10.1 程序与不考虑缓冲时的计数

课堂程序是：

```c
#include <stdio.h>
#include <unistd.h>

int main(void) {
    for (int i = 0; i < 2; i++) {
        fork();
        printf("Hello\n");
    }
}
```

这是为了推导输出而保留的**课堂反例**：它没有检查 `fork` 是否失败。实际代码必须处理 `fork() == -1`。下面先假设两次 `fork` 都成功，并把每次 `printf` 当作立即可见的事件：

- 第 1 轮：1 个进程变成 2 个，执行 2 次 `printf`；
- 第 2 轮：2 个进程各自复制，变成 4 个，执行 4 次 `printf`；
- 合计执行 6 次 `printf`。

进程数与打印调用数可以分别写成：

\[
N_i=2^{i+1},\qquad Prints=2+4=6
\]

打印的先后顺序没有保证，但只有同一个字符串时看不出调度差别。

### 10.2 为什么直接运行常见是 6 行

当 `stdout` 连接终端时，常见 libc 会把它设为行缓冲。`printf("Hello\n")` 中的换行触发 flush，于是在下一次 `fork` 前，那一行通常已经通过 `write` 交给内核，用户态缓冲为空。

第二次 `fork` 复制空缓冲，最终恰好看到 6 行。这是常见实现行为，不应被误写成 C 语言对所有输出目标的绝对承诺。

### 10.3 为什么 `./a.out | wc -l` 常见是 8 行

管道不是终端，常见 libc 对 `stdout` 使用全缓冲。第一轮的两个进程各自执行 `printf` 后，字符串可能只留在各自用户态 `FILE` 缓冲中：

```text
第一次 fork 后：
进程 A 的 stdout buffer = "Hello\n"
进程 B 的 stdout buffer = "Hello\n"
```

第二次 `fork` 不认识“这只是输出缓存”；它忠实复制每个进程的整个用户内存。于是两个已有缓冲各自被复制：

```text
A、A' 都带着第一行
B、B' 都带着第一行
```

四个进程随后各追加第二轮的一行，并在从 `main` 正常返回时由 libc `exit` 路径刷新。因此每个最终进程刷出 2 行，总计常见为 8 行。

多出的不是多执行了两次 `printf`，而是**两份尚未送入内核的旧缓冲被 `fork` 复制后各刷新一次**。

### 10.4 如何用证据区分假设

把课堂程序保存为 `/tmp/fork-demo.c` 后，可以比较：

```bash
cc -O0 -Wall -Wextra /tmp/fork-demo.c -o /tmp/fork-demo

/tmp/fork-demo
/tmp/fork-demo | wc -l
stdbuf -o0 /tmp/fork-demo | wc -l
strace -f -e write /tmp/fork-demo 2>&1 | sed -n '1,40p'
strace -f -e write /tmp/fork-demo 2>&1 >/dev/null | sed -n '1,40p'
```

解读思路：

- `stdbuf -o0` 请求关闭 stdout 缓冲，管道下应回到每次 `printf` 对应一次及时写出的直觉；
- `strace -f` 展示各进程实际发出的 `write`，可以区分“调用了几次 printf”和“内核看到了几次/多少字节 write”；
- 在第二次 `fork` 前加 `fflush(NULL)`，也会阻止旧缓冲被复制；
- 在 `main` 一开始调用 `setbuf(stdout, NULL)` 可直接关闭该流的缓冲。

命令中的重定向本身也会改变 stdout 去向，做对照时应先画清楚每个 fd 最终指向终端、管道还是 `/dev/null`。

### 10.5 model checker 为什么适合这个例子

并发执行顺序很多，靠脑中模拟容易漏分支。一个最小模型检查器可以把每个进程表示为：

```text
(PC, i, fork返回值, stdout用户缓冲, 退出状态)
```

每一步任选一个可运行进程推进，枚举所有调度交错。只要模型里包含 libc 缓冲状态，就能解释管道结果；若只保存 C 局部变量而漏掉 `FILE` 对象，就会得出错误预测。

这个案例的真正 Takeaway 不是背“6 和 8”，而是：

> `fork` 复制的是实际状态机，而实际状态机包含你暂时没想到的库状态。实验差异是在提醒模型不完整。

## 11. `execve()`：把当前状态机复位为新程序

### 11.1 API 与“成功不返回”

```c
#include <unistd.h>

int execve(const char *filename,
           char *const argv[],
           char *const envp[]);
```

`execve` 不创建新进程。它让内核用 `filename` 描述的新程序映像替换当前进程的用户态执行环境。

成功时：

- 旧代码已经不存在；
- 旧调用栈已经不存在；
- 新程序从其入口开始；
- 因而原调用点不可能得到“成功返回值”。

失败时才返回 `-1` 并设置 `errno`。所以正确结构是：

```c
execve(path, argv, envp);
perror("execve");       // 只有失败才到达
_exit(127);
```

把 `printf("exec success")` 写在 `execve` 后面是常见反例：它只能证明 exec 失败。

### 11.2 什么被重置，什么被保留

“复位状态机”不等于“销毁旧进程再创建新 PID”。可以先用下面的近似表建立模型：

| 状态 | 成功 `execve` 后 |
| --- | --- |
| PID、PPID | 保留 |
| 进程组、会话 | 保留 |
| 当前目录、根目录、umask | 保留 |
| 多数资源限制 | 保留 |
| 打开的 fd | 默认保留；设置 close-on-exec 的关闭 |
| open file description/偏移 | 对保留 fd 继续有效 |
| 用户地址空间 | 由新程序映像重建 |
| PC、SP、普通寄存器 | 设置为新程序入口所需初始状态 |
| argv、envp | 由调用者给出的字符串重建到新地址空间 |
| 其他线程 | 消失，只留下调用 exec 的线程作为新程序执行流 |
| 已捕获信号的 handler | 通常复位为默认；被忽略信号通常继续忽略 |
| 信号屏蔽字、pending signals | 按 exec 规则保留，而非简单全部清零 |
| `atexit` 回调、stdio 用户缓冲 | 属于旧用户态运行时，不会作为新程序状态继续存在 |

真实规则还包括 set-user-ID、capabilities、dumpable、共享内存、POSIX timer 等安全和兼容细节。结论仍然是：**地址空间被复位，许多进程身份与内核对象关系保持。**

### 11.3 为什么需要 `O_CLOEXEC`

UNIX 默认让 fd 跨 `exec` 保留，这正是 Shell 能把重定向后的 stdin/stdout 交给新程序的基础。但默认继承也可能泄漏敏感资源：

1. 服务器打开数据库或密钥文件；
2. 它创建子进程并执行外部工具；
3. 若忘记关闭 fd，外部工具继承访问能力；
4. 即使路径权限不允许，该 fd 仍是已授权的对象引用。

因此可在创建 fd 时原子设置 close-on-exec：

```c
int fd = open(path, O_RDONLY | O_CLOEXEC);
if (fd < 0) {
    perror("open");
    /* 进入调用者自己的错误处理路径 */
}
```

用 `fcntl(fd, F_SETFD, FD_CLOEXEC)` 事后设置，在多线程程序中可能出现 `open` 与 `fcntl` 之间另一个线程恰好 `fork/exec` 的竞态。`O_CLOEXEC`、`pipe2(O_CLOEXEC)`、`dup3(..., O_CLOEXEC)` 等接口把“创建”和“不可继承”合成一个原子动作。

### 11.4 `argc/argv/envp` 从哪里来

讲义把多年疑问落到 `execve` 的参数：

- `argv` 是以空指针结束的字符串指针数组；
- `argv[0]` 按惯例是程序名，但内核不会替你验证它必须等于 `filename`；
- `envp` 是以空指针结束的 `NAME=value` 字符串数组。

加载器把参数和环境内容复制进新地址空间，并建立新程序的初始栈。真正首先执行的通常是 ELF 入口 `_start`，运行时初始化后才调用：

```c
int main(int argc, char **argv);
```

所以“`main` 参数由 execve 给出”在语义上正确，但中间还有内核 ELF 加载、动态链接器和 C 运行时启动代码。

环境变量不是内核里的全局配置数据库。对进程而言，它们是新地址空间中的字符串。Shell 中：

```bash
local_only=abc
export inherited=xyz
```

普通 Shell 变量 `local_only` 不一定传给外部命令；`export` 表示之后创建/执行子程序时把该名字放入环境。子进程修改自己的环境不会反向改变父 Shell。

### 11.5 课堂 execve Demo 的精确观察

[execve Demo](https://jyywiki.cn/OS/demos/virtualization/execve-demo/) 构造：

```c
char *const argv[] = { "/bin/bash", "-c", "env", NULL };
char *const envp[] = { "HELLO=WORLD", NULL };
execve(argv[0], argv, envp);
printf("Hello, World!\n");  // 仅失败时执行
```

它把当前进程复位成 `/bin/bash -c env`，并且**显式传入一份新的环境**，没有直接复用调用者的 `environ`。输出中应能找到 `HELLO=WORLD`；Bash 自己也可能补充 `PWD`、`SHLVL`、`_` 等变量，因此不要误断言输出只能有一行。

最后的 `printf` 正是错误路径探针：正常执行时看不到它。生产代码还必须检查错误并向 stderr 报告，随后 `_exit` 一个约定失败码。

### 11.6 exec 函数族：字母在说明参数形式和搜索行为

POSIX/libc 提供一组便利函数，名字可以拆读：

| 字母 | 含义 |
| --- | --- |
| `l` | 参数以变长列表逐个给出，例如 `execl(path, arg0, arg1, NULL)` |
| `v` | 参数以 `argv` 向量给出 |
| `p` | 若文件名不含 `/`，按 `PATH` 搜索 |
| `e` | 调用者显式给出 `envp` |

常见函数包括 `execl`、`execlp`、`execle`、`execv`、`execvp`、`execvpe`。它们不是六种不同的“进程复位机制”，而是用户态参数整理和路径搜索包装，最终调用 `execve`，或在现代 Linux 的某些实现中使用语义相近的 `execveat`。

讲义把 `execve` 称为唯一能“执行程序”的系统调用，重点是区分内核原语和 libc 包装；现代 Linux 还存在 `execveat` 这一扩展原语，但不会改变本讲的 fork/exec 模型。

### 11.7 实验四：只给新程序传一个自定义环境

下面的独立最小例子不涉及课程 MiniLab。依赖 Linux/POSIX C 环境；若系统的 `env` 不在 `/usr/bin/env`，用 `command -v env` 查出后替换路径。

```c
// 保存为 /tmp/exec-env.c
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

int main(void) {
    char *const argv[] = { "/usr/bin/env", NULL };
    char *const envp[] = { "HELLO=WORLD", "ANSWER=42", NULL };

    execve(argv[0], argv, envp);
    fprintf(stderr, "execve: %s\n", strerror(errno));
    _exit(127);
}
```

编译和观察：

```bash
cc -O2 -Wall -Wextra /tmp/exec-env.c -o /tmp/exec-env
/tmp/exec-env
strace -e execve /tmp/exec-env
```

预期 `env` 只看到显式传入的两项，而不会自动继承 Shell 的整个环境。`strace` 会显示两次相关 exec 事件：跟踪器启动 `/tmp/exec-env`，随后它用同一 PID 的执行流切换到 `/usr/bin/env`。

## 12. `PATH`：搜索发生在用户态，内核只接收路径

### 12.1 为什么 `execve("ls", ...)` 通常不会帮你找 `/usr/bin/ls`

`execve` 的第一个参数是路径。内核负责沿该路径查找文件、检查执行权限并加载，却不会读取调用者的 `PATH` 后逐项猜测。

当你在 Shell 中输入：

```bash
ls -l
```

通常是 Shell 或 `execvp` 一类库函数完成：

1. 读取环境中的 `PATH`，例如 `/usr/local/bin:/usr/bin:/bin`；
2. 依次构造 `/usr/local/bin/ls`、`/usr/bin/ls`、`/bin/ls`；
3. 查询或尝试执行；
4. 找到可执行目标后调用底层 exec。

若命令名含 `/`，如 `./tool` 或 `/bin/ls`，通常不做 PATH 搜索。

### 12.2 gcc 寻找汇编器的课堂案例

`gcc` 是编译驱动，它会启动预处理器、编译器、汇编器 `as` 和链接器。`strace -f` 可能观察到它按 PATH 尝试：

```text
execve("/usr/local/sbin/as", ...)
execve("/usr/local/bin/as", ...)
execve("/usr/sbin/as", ...)
execve("/usr/bin/as", ...)
```

前几个返回 `ENOENT`，直到找到真实文件。若把 PATH 置空，即使 `/usr/bin/as` 确实存在，驱动用 `execvp` 类接口也可能报告找不到 `as`：

```bash
PATH="" /usr/bin/gcc a.c
# gcc: error trying to exec 'as': execvp: No such file or directory
```

恢复包含汇编器目录的 PATH 后即可继续：

```bash
PATH="/usr/bin:/bin" /usr/bin/gcc a.c
```

这里没有“gcc 突然坏掉”：文件仍在磁盘上，只是用户态搜索列表不再包含它。

### 12.3 用 `strace` 看见 Shell 的搜索和进程链

可以运行：

```bash
strace -f -e execve sh -c 'printf hello | wc -c'
```

根据 Shell 实现，`printf` 可能是内建命令，不一定产生 exec；`wc` 通常是外部程序，会出现某个具体路径的 `execve`。这正是一个有用观察：Shell 语法中的“命令”并不必然等于一个新进程或一个 `execve`。

还应注意讲义中“一切进程 strace 的第一个系统调用是 execve”的观察语境：当 `strace program` 从外部启动程序时，输出首先显示把跟踪子进程切换成 `program` 的 `execve`；新程序自己的 `_start` 尚未来得及运行。若用 `strace -p PID` 附加到已经运行的进程，就不会凭空看到它过去的 exec。

## 13. 销毁状态机：`_exit`、`exit` 与 `wait`

### 13.1 最小终止语义

POSIX 向应用提供：

```c
#include <unistd.h>

void _exit(int status);
```

它终止当前进程，不返回调用者，并把状态的低位信息留给父进程。内核回收用户地址空间等大部分资源、关闭该进程的 fd 引用，但保留供父进程等待的最小记录。

“立即”指不执行 libc 的 stdio 刷新和 `atexit` 回调，不表示内核关闭所有 fd 一定毫无工作，也不表示父进程已经同步完成回收。

### 13.2 libc `exit()` 不是 Linux `exit` syscall

这几个相似名字属于不同层：

| 名称 | 层次 | 主要语义 |
| --- | --- | --- |
| `return` from `main` | C 语言/运行时 | 等价地进入正常 `exit(status)` 路径 |
| `exit(status)` | libc | 刷新/关闭 stdio，运行 `atexit` 回调，再终止 |
| `_Exit(status)` | C 标准库 | 不做正常 stdio/atexit 清理，立即终止 |
| `_exit(status)` | POSIX libc API | 与 `_Exit` 类似的立即终止接口 |
| Linux `SYS_exit` | 内核 syscall | 终止调用线程 |
| Linux `SYS_exit_group` | 内核 syscall | 终止整个线程组，即通常意义的进程 |

单线程程序里，`SYS_exit` 与 `SYS_exit_group` 的外观差异不明显。有了线程以后，区别才关键：Linux 原始 `exit` syscall 只结束调用线程；glibc 的 `_exit()` 包装在现代 Linux 上通常使用 `exit_group`，以实现 POSIX “终止进程”的语义。

这也说明 API、libc 包装和内核 syscall 不能只凭同名判断。

### 13.3 课堂 exit Demo 在观察什么

[exit Demo](https://jyywiki.cn/OS/demos/virtualization/exit-demo/) 先注册：

```c
void func(void) {
    printf("Goodbye, Cruel OS World!\n");
}

atexit(func);
```

再根据参数分别执行 libc `exit(0)`、libc `_exit(0)` 或 `syscall(SYS_exit, 0)`。

预期差异：

- `exit` 会运行 `atexit(func)`，因此看到告别信息；
- 从 `main` `return EXIT_FAILURE` 也走正常退出路径，已注册回调会运行；
- `_exit` 不运行回调，也不刷新旧 stdio 用户缓冲；
- 单线程下原始 `SYS_exit` 同样不会执行 libc 清理；
- `strace` 能显示 libc 最终选择 `exit_group` 还是原始 `exit`。

可自行写一个同形小程序后观察：

```bash
strace -e trace=write,exit,exit_group /tmp/exit-demo exit
strace -e trace=write,exit,exit_group /tmp/exit-demo _exit
```

若把告别字符串改成不带换行并重定向 stdout，缓冲差异会更明显。任何结论都要同时标注“这是 libc 行为”还是“这是内核 syscall 行为”。

### 13.4 为什么 fork 后 exec 失败常用 `_exit(127)`

考虑父进程在 `fork` 前已经：

- 向 stdout 缓存了一些数据；
- 注册了修改临时文件的 `atexit` 回调；
- 初始化了复杂库状态。

子进程继承了这些用户态状态。如果 `execve` 失败后调用普通 `exit`，它可能再次刷新父进程缓冲、再次运行本应只由父进程运行的清理逻辑。使用 `_exit(127)` 可避开这些正常运行时清理。

状态码 127 是 Shell 生态常用于“命令无法执行/未找到”的约定；内核并不强制所有 exec 失败都必须用这个数字。

### 13.5 `waitpid`：等待并领取退出结果

```c
#include <sys/types.h>
#include <sys/wait.h>

pid_t waitpid(pid_t pid, int *status, int options);
```

常见用法：

```c
int status;
pid_t got = waitpid(child, &status, 0);
if (got < 0) {
    perror("waitpid");
} else if (WIFEXITED(status)) {
    printf("exit=%d\n", WEXITSTATUS(status));
} else if (WIFSIGNALED(status)) {
    printf("signal=%d\n", WTERMSIG(status));
}
```

不能直接把 `status` 当退出码打印，因为它编码了多种结果：

- 是否正常退出；
- 正常退出码；
- 是否被信号终止及信号编号；
- 在相应选项下，是否停止或继续。

宏 `WIFEXITED`、`WEXITSTATUS`、`WIFSIGNALED`、`WTERMSIG` 等负责解码。

`waitpid(child, ..., 0)` 指定等待某一个孩子；`wait(NULL)` 等价于等待任一合适孩子的简化形式。`WNOHANG` 允许“如果现在没有结果就立即返回”，常用于事件循环或 `SIGCHLD` 处理。

生产代码还要处理：

- `EINTR`：等待被信号中断，可能需要重试；
- `ECHILD`：指定对象不是未领取的子进程；
- 多个子进程同时结束：需要逐个领取；
- PID 复用：只在明确父子生命周期中保存并等待 PID。

### 13.6 从运行到 zombie，再到彻底消失

一个简化状态序列是：

```text
可运行/运行中
      ↕ 调度、阻塞、唤醒
睡眠/停止
      ↓ exit 或致命信号
zombie（只留退出记录）
      ↓ 父进程 waitpid
退出记录释放，PID 将来可复用
```

若父进程先退出，活着的孩子被 reaper 收养；若孩子已经成为 zombie，也需要新的 reaper 最终 `wait`。这使每个终止结果都有明确领取者。

## 14. UNIX 进程的完整生命周期

### 14.1 `spawn = fork + execve`

把本讲三个动作组合起来：

```text
已有父进程
    │
    ├─ fork 失败 ───────────────→ 父进程处理 errno
    │
    ├─ 父分支：得到 child PID ──→ 继续工作或 waitpid
    │                                ↑
    └─ 子分支：返回 0               │ 领取退出结果
          │                          │
          ├─ 调整 fd/cwd/信号等      │
          ├─ execve 成功             │
          │     ↓                    │
          │   新程序入口             │
          │     ↓                    │
          │   运行、系统调用         │
          │     ↓                    │
          │   exit/致命信号 ─→ zombie
          │
          └─ execve 失败 → 报错 → _exit(127)
```

一段可靠的单线程教学骨架是：

```c
pid_t pid = fork();
if (pid < 0) {
    perror("fork");
    return EXIT_FAILURE;
}

if (pid == 0) {
    char *const argv[] = { "/bin/echo", "hello", NULL };
    char *const envp[] = { "PATH=/usr/bin:/bin", NULL };
    execve(argv[0], argv, envp);
    perror("execve");
    _exit(127);
}

int status;
if (waitpid(pid, &status, 0) < 0) {
    perror("waitpid");
    return EXIT_FAILURE;
}

if (WIFEXITED(status))
    printf("child exit %d\n", WEXITSTATUS(status));
else if (WIFSIGNALED(status))
    printf("child signal %d\n", WTERMSIG(status));
```

这里的 `envp` 故意很小，实际应用常传递经过筛选的当前环境。多线程程序还必须遵守 fork 后的 async-signal-safe 限制；上面的 `perror` 适合帮助理解的单线程例子，不应不加分析地移入任意多线程服务。

### 14.2 为什么 UNIX 要拆成两步

Shell 要执行：

```bash
producer | consumer >result.txt
```

它可以先创建管道和输出文件，然后：

- `fork` 第一个孩子，把 stdout 改到管道写端，再 `execve(producer)`；
- `fork` 第二个孩子，把 stdin 改到管道读端、stdout 改到文件，再 `execve(consumer)`；
- 父 Shell 关闭自己不需要的 fd 并等待。

新程序不必知道自己连着终端、管道还是文件；它照常读 fd 0、写 fd 1。这种组合能力将在第 7、8 讲展开。

拆分的代价也应正视：继承状态很多，必须正确关闭 fd、处理错误和信号；多线程 fork 尤其复杂。系统设计没有魔法，优雅抽象也会把复杂性转移到接口交互处。

### 14.3 Windows 对照的意义

讲义用 Windows 的 `CreateProcess`/`TerminateProcess` 对照，并不是要判断哪套 API“绝对更好”。`CreateProcess` 更接近一次建立新执行映像，`TerminateProcess` 则提供显式终止操作；两套系统选择了不同复杂性分配：

- UNIX 用少量正交原语，让调用者在 fork 与 exec 之间自由组合；
- Windows 的创建接口显式接收较多启动配置，默认继承策略也不同；
- 现代 UNIX 又增加 `posix_spawn` 和 `O_CLOEXEC`，缓解 fork 继承与并发的风险。

理解 API 时，应问“它允许什么组合、默认继承什么、错误发生在哪个阶段”，而不只记函数名。

## 15. 概念辨析与常见误区

### 15.1 一张分层表

| 说法/机制 | 所在层次 | 容易混淆之处 |
| --- | --- | --- |
| C 程序从 `main` 执行 | 语言/运行时近似 | 真正机器入口通常是 `_start` |
| `printf` | libc API | 不等于每次立即 `write` syscall |
| `fork()` | POSIX/libc API + 内核实现 | 语义复制完整状态，实现可用 COW |
| `execl/execvp` | libc/POSIX 包装 | 参数整理/PATH 搜索，不是新内核机制 |
| `execve` | 系统调用语义 | 成功不返回，不创建新 PID |
| `exit()` | libc | 会运行清理，不能等同 `SYS_exit` |
| `_exit()` | POSIX libc API | Linux libc 通常用 `exit_group` 实现 |
| `/proc/PID/*` | Linux procfs ABI | 动态、受权限限制、非跨文件原子快照 |
| COW | VM 实现机制 | 不等于父子普通内存可相互写见 |

### 15.2 常见误区逐条纠正

**误区一：进程就是可执行文件。**  
可执行文件是静态输入；进程还包括某一时刻的执行现场和内核状态。同一文件能对应多个进程，一个进程也能 exec 成另一个文件。

**误区二：`fork` 后子进程从 `main` 开始。**  
父子都从 `fork` 之后继续，只是返回值不同。

**误区三：`fork` 返回两次，所以同一个进程得到两个返回值。**  
是两个进程各得到一次返回；调用者的状态已经分叉。

**误区四：父进程一定先运行。**  
没有同步就没有顺序保证，子进程可以先打印或在另一核并行。

**误区五：COW 说明 `fork` 没有复制内存。**  
可观察语义是快照复制；COW 只是把物理复制延迟到写时。

**误区六：父子变量地址相同，所以能用普通全局变量通信。**  
相同是各自虚拟地址；私有映射写后分离。进程通信要用共享映射、管道、socket 等机制。

**误区七：`execve` 创建一个新进程。**  
它替换当前进程映像，PID 通常不变。新进程一般由之前的 `fork` 创建。

**误区八：`execve` 自动搜索 `PATH`。**  
它接受路径；`execvp` 或 Shell 做搜索。

**误区九：`argv[0]` 必然由内核设置为真实路径。**  
调用者提供整个 argv；`argv[0]` 只是惯例，程序不应把它当安全身份凭据。

**误区十：`exec` 会关闭所有 fd。**  
默认保留，只有 close-on-exec fd 自动关闭。这既支持重定向，也可能造成能力泄漏。

**误区十一：`exit()` 就是一条 syscall。**  
它先执行 libc 清理；最后才通过立即终止接口进入内核。

**误区十二：子进程一退出就完全不存在。**  
父进程领取结果前通常留下 zombie 记录。

**误区十三：`SIGCHLD` 自带每个孩子的完整退出队列。**  
信号是通知，结果由 `waitpid` 查询和领取；多个退出可能要求循环 wait。

**误区十四：读一次 `/proc` 就得到全系统一致快照。**  
进程在继续运行，目录和文件可能在观察过程中改变。

**误区十五：有 OOM killer 就可以安全尝试 fork bomb。**  
进程数、PID 和调度资源可能先耗尽；共享环境绝不能尝试。

## 16. 把所有课堂 Demo 串成一条证据链

本讲的 Demo 不是七个互不相关的小程序，而是逐步扩充同一个状态机模型：

```text
CrazyOS
  证明：保存多个 CPU/memory 状态并轮流推进，就有了进程虚拟化雏形
      ↓
proc-info
  补充：真实进程还有 PID、fd、调度、凭据、namespace 等内核状态
      ↓
create-tree
  观察：fork 建立动态父子关系，退出会触发重新收养
      ↓
fork-based DFS
  应用：复制当前内存快照可以自然表示搜索分支
      ↓
fork-demo
  反例：若漏掉 libc 缓冲，便无法预测真实输出
      ↓
execve-demo
  证明：同一 PID 可被新程序映像和显式环境彻底复位
      ↓
exit-demo
  分层：libc 正常退出、立即退出和内核线程/线程组终止并不相同
```

这条链也体现第 4 讲的方法论：先用 CrazyOS 建最小机制，再让观察工具补全状态，最后通过反直觉实验修正模型。

## 17. 本讲小结

本讲最重要的统一视角是：

> 程序是状态机的静态描述；进程是状态机的一次运行实例；操作系统是这些状态机及其资源关系的管理者。

由此可以把 UNIX 进程 API 记成有意义的动作，而不是四个孤立函数：

- `fork`：复制当前状态，父子从同一逻辑位置分叉；
- `execve`：保留进程身份和部分 OS 状态，重建用户程序初始状态；
- `_exit`/`exit_group`：结束执行并留下可领取结果；
- `waitpid`：父进程同步并回收退出记录。

同时必须保留四个“没有魔法”的意识：

1. `fork` 的完整快照语义由 COW 等机制高效实现，但不是零成本；
2. 继承规则逐项不同，特别是 fd、信号和多线程锁；
3. `printf`、`execvp`、`exit` 等 libc 行为不能与 syscall 混为一谈；
4. `/proc` 和 `strace` 是检验模型的证据，不是静态世界的照片。

## 18. 思考题与复现实验建议

以下问题只要求解释机制和设计观察，不涉及 MiniLab 答案：

1. 若 `fork` 后父子分别把同一个普通全局变量加一，为什么彼此通常看不到新值？若该变量位于 `MAP_SHARED` 映射又怎样？
2. `fork-demo` 在第一次 `printf` 后显式 `fflush(stdout)`，终端和管道下各应看到多少行？用 `strace -f -e write` 验证。
3. 父进程在 `fork` 前 `open` 一个文件，父子各 `read` 10 字节。为什么它们的读取区间可能首尾相接，而不是都从 0 开始？
4. 为什么 `execve` 保留 stdout fd，却不保留旧程序的 `FILE *stdout` 用户态对象？
5. 若一个敏感 fd 忘记设置 `O_CLOEXEC`，子程序即使不知道原文件路径，为什么仍可能读取它？
6. 让子进程返回 7、调用 `_exit(7)`、被 `SIGTERM` 终止，父进程的 `status` 应分别用哪些宏判断？
7. B 是 A 的孩子，C 是 B 的孩子。设计只用 `getppid`、延时和 `ps` 的观察步骤，怎样判断 B 退出后谁收养了 C？不要假设一定是 A。
8. fork-based DFS 若找到一个解，怎样通知其他搜索分支停止？思考管道、共享内存和信号各自的状态与竞态，不必实现完整搜索器。
9. `PATH` 中先后放两个同名程序，会执行哪个？若第一个存在但无执行权限，`execvp` 最终错误如何理解？查手册并用临时目录验证。
10. 为什么一个已经进入 `Z` 状态的进程几乎不消耗 CPU，却仍可能耗尽系统可创建进程的能力？
11. 多线程父进程中另一个线程持有 malloc 内部锁时 `fork`，子进程为什么不适合随意调用 `printf`？
12. CrazyOS 每次推进一条指令；若某个 syscall 在宿主上长时间阻塞，会怎样影响其他客体？真实内核用什么思路避免整个系统一起停住？

## 19. 下一讲：从“内存快照”进入地址空间

本讲多次使用了还未完全解释的事实：

- 父子进程可以拥有相同数值的指针，却看到不同内容；
- COW 能让两个页表暂时指向同一物理页；
- `execve` 能一次性撤销旧映射、建立代码、数据、堆、栈和动态链接器映射；
- `/proc/PID/maps` 能把这些区域展示出来；
- `MAP_PRIVATE` 与 `MAP_SHARED` 改变了写入可见性。

这些事实共同指向“地址空间”：操作系统给每个进程提供的一套虚拟地址到对象/物理内存的映射。第 6 讲将介绍 `mmap`、`munmap`、`mprotect`，并进一步讨论调试器、进程间内存访问和地址空间的有趣应用。

## 20. 阅读材料

原讲义建议配合 *Operating Systems: Three Easy Pieces*：

- 第 3 章 Dialogue；
- 第 4 章 Processes；
- 第 5 章 Process API。

阅读时建议始终带着四列笔记：某个 API 为什么需要、最小语义是什么、Linux 如何观察、它与其他状态的交互边界是什么。

## 21. PPT 内容覆盖表

| 原讲义标题/内容 | 本章对应位置 | 覆盖要点 |
| --- | --- | --- |
| Review & Comments / Clarifications | §2.4 | 上节所用模型说明、Agent 输出必须验证 |
| 内容回顾：应用视角的操作系统 | §2.1 | 对象 + API、系统调用状态迁移 |
| 内容回顾：硬件视角的操作系统 | §2.2 | OS 也是程序、特权与调度 |
| 两边明确的数学模型 | §2.3 | `P=(S0,T)`、`main` 与 Reset |
| 《操作系统》正片开始 | §0、§3.1 | 进程虚拟化、独占计算机错觉 |
| 进入“每一讲都实现一点什么”模式 | §0、§16 | 以 Demo 建立并检验机制 |
| 虚拟化：一个疯狂的想法 | §3.2 | 非递归汉诺塔启发、选择状态机并单步 |
| CrazyOS | §3.3–§3.5 | RISC-V 状态、轮转、ecall、两个客体和模型边界 |
| 程序 v.s. 进程 | §4.1–§4.2 | 静态描述、运行实例、同程序多进程 |
| 操作系统上的进程 | §4.3–§4.4 | 用户状态与额外内核状态 |
| 展示进程信息 Demo | §4.3、§5.3 | 身份、fd、映射、调度、namespace、安全等 |
| \[OS API\] 查询进程状态 | §5.1–§5.5 | `/proc/PID`、`readdir/open/read`、查询 API、动态竞态 |
| 进程管理系统调用 / 状态机管理 | §6 | spawn 直觉与 UNIX 分解 |
| \[OS API\] 创建状态机 | §7.1–§7.2 | `fork` API、返回值、复制现场、失败 |
| `fork()` 的行为 | §7.2–§7.5 | 哪些复制/共享、fd caveat、调度、多线程边界 |
| 进程树 | §8.1–§8.4 | 父子关系、`SIGCHLD`、重新收养、孤儿与 zombie |
| 创建一棵进程子树 Demo | §8.5 | 五层二叉子树、随机退出、前后 PPID 观察 |
| Fork Bomb | §9.1 | 指数增长、资源耗尽、现代限制和安全警告 |
| fork() 的全量内存快照：应用 | §9.2 | 预处理共享、Zygote、并行搜索、隔离/checkpoint |
| fork-based DFS | §9.2 | 每分支状态快照、等待、输出与进程爆炸代价 |
| fork 快照的实现 | §9.3–§9.4 | COW 推导、私有/共享映射实验 |
| 理解 fork：习题 | §10.1–§10.5 | 6/8 行推导、stdio 缓冲、`strace`、model checker |
| \[OS API\] 复位状态机 | §11.1–§11.3 | `execve` 成功不返回、重置与保留、`O_CLOEXEC` |
| execve() 设置了进程的初始状态 | §11.4 | argc/argv、envp、加载入口与运行时 |
| 理解 execve Demo | §11.5–§11.7 | `/bin/bash -c env`、exec 函数族、自定义环境实验 |
| 例子：PATH 环境变量 | §12 | 用户态搜索、gcc 找 `as`、strace 观察 |
| \[OS API\] 销毁状态机 | §13.1–§13.2 | `_exit` 返回状态、libc/API/syscall 分层、线程组 |
| UNIX 进程的生存周期 | §13.5–§14.2 | fork + execve、waitpid、zombie、Shell 组合 |
| 理解 exit Demo | §13.3–§13.4 | `atexit`、stdio、`exit/_exit/SYS_exit` 对照 |
| Takeaways | §17 | 进程抽象、资源分配单位、管理 API 总结 |
| 阅读材料 | §20 | OSTEP 第 3–5 章 |
