# 第 7 讲：访问操作系统对象——文件描述符是进程手里的“对象指针”

> 原始讲义：[sources/notes/lect07.md](../../sources/notes/lect07.md)  
> 配套示例：[examples/pipeline.c](../../examples/pipeline.c)  
> 本讲关键词：操作系统对象、文件描述符、open file description、`open`、`read`、`write`、`lseek`、`dup`、`close`、`fork`、`execve`、`O_CLOEXEC`、handle、`/proc`、`/dev`、匿名管道、TestKit
> 前一讲：[进程的地址空间](06-address-space.md) · 后一讲：[终端和 UNIX Shell](08-terminal-shell.md)

## 0. 本讲定位：地址空间之外，还有谁属于进程

上一讲把进程描述为一个封闭的地址空间：普通指针只能命名本进程映射中的字节，越过边界必须请求内核。可是一个有用的程序不能只在自己的内存里计算。编辑器要保存文件，浏览器要读取网络连接，Shell 要连接多个程序，测试框架还要启动、观察并终止子进程。

因此，进程的完整状态不只有寄存器和地址空间：

```text
进程
├── CPU 执行状态：PC、通用寄存器、控制状态……
├── 用户地址空间：代码、数据、堆、栈、映射……
└── 内核授权的对象引用：文件、管道、终端、socket、设备……
```

本讲研究最后一项。核心问题是：**应用不能直接解引用内核指针，那么内核如何安全、稳定地把对象交给应用使用？** UNIX 的答案是每进程一张文件描述符表；表中的非负小整数是由内核解释的对象引用。

课程主线由此继续向前：

```text
程序/硬件状态机
  → 进程与地址空间虚拟化
  →【本讲：操作系统对象、文件描述符与管道】
  → 终端和 Shell 对这些机制的组合
  → libc、链接加载与完整应用生态
```

下一讲将看到，终端只是另一类可访问对象，而 Shell 的重定向与管道语法，本质上是在 `fork` 和 `execve` 之间重新布置文件描述符。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 解释为什么进程访问地址空间外的资源必须经过系统调用；
- 从程序员与操作系统设计者两个视角理解“对象 + API”；
- 准确解释 UNIX “Everything is a File”的能力和边界；
- 区分文件描述符、打开文件描述（open file description）和底层文件/设备对象；
- 预测 `open`、`dup`、`close`、`fork` 和 `execve` 后引用与文件偏移的变化；
- 说明 `FD_CLOEXEC`/`O_CLOEXEC` 要解决的泄漏与竞态；
- 比较 UNIX 文件描述符与 Windows handle 的继承和使用方式；
- 用 `/proc/PID/fd` 观察进程正在持有的对象；
- 解释 `/proc`、`/dev` 为什么能用文件 API 访问，却不等于普通磁盘文件；
- 用匿名管道构造生产者—消费者，并判断何时出现 EOF、阻塞或 `SIGPIPE`；
- 从 TestKit 案例说明进程、文件描述符、管道和等待如何组成系统测试框架。

问题地图：

| 问题 | 最小答案 | 本机证据 |
| --- | --- | --- |
| fd `3` 是某个全局文件的编号吗？ | 不是；它只是当前进程 fd 表的下标 | 比较两个进程的 `/proc/PID/fd/3` |
| `dup(fd)` 后两个描述符各有一个偏移吗？ | 通常没有；二者指向同一打开文件描述，共享偏移 | 实验 2 先后读出 `ab`、`cd` |
| `fork()` 会重新 `open` 每个文件吗？ | 不会；父子获得指向同一打开文件描述的引用 | 共享偏移与管道 EOF 行为 |
| `/proc/123/status` 在磁盘上吗？ | 通常不在；内核读取时生成内容 | `stat`、`readlink /proc/PID/fd/*` |
| 管道何时返回 EOF？ | 缓冲区已空，且所有写端引用都已关闭 | `pipeline.c` 和保留写端反例 |
| “一切皆文件”是否表示只有 `read/write`？ | 不是；统一数据面之外仍有 `ioctl`、`mmap` 等对象特有控制 | 终端、设备和 socket API |

## 2. Review & Comments：先处理实验更新，再回到模型

### 2.1 “怎么都过不了”的测试，可能不是你的程序错了

讲义先记录了一次真实课程事故：3 月 22 日中午主分支更新了框架，但旧版 TestKit 仍按原来的 `SystemTest` 参数调用，于是接口两端版本不匹配，测试无论如何都无法通过。

这件事和本讲主题高度相关。API 不只是函数名；参数、返回值、错误、时序和版本共同组成协议。诊断这类问题时，应先固定证据：

1. 记录当前提交、框架提交和测试工具版本；
2. 找到第一个失败的提交，比较接口签名和调用点；
3. 在同一版本组合上复现，区分“实现错误”和“测试基础设施错误”；
4. 再选择回退、同步升级或增加兼容层。

AI Agent 可以帮助遍历提交历史、把 `main` 临时移到旧提交、再同步到新接口，也可以生成测试和解释差异。这正是讲义所说的“放大自主性”：不会时不必停在原地，但最终仍要用提交号、编译错误和运行轨迹验证结论。让 Agent 直接“把实验做完”若没有版本和行为证据，只是把不确定性藏了起来。

### 2.2 复习：进程是一个封闭世界

一个进程加载并运行一个程序。程序能直接操纵的是自己的寄存器和被映射的内存；其他资源都由内核维护，只能通过系统调用请求：

- 进程管理：`spawn`、`fork`、`execve`、`exit`、`waitpid`；
- 地址空间管理：`mmap`、`munmap`、`mprotect`；
- 本讲的对象访问：`open`、`read`、`write`、`lseek`、`close`、`pipe` 等。

系统调用不是普通函数换了一个名字。普通函数通常只改变调用进程可直接访问的状态；系统调用会陷入内核，由内核根据调用进程的身份、权限和参数，查找并修改受保护的全局状态。

上一讲的 `mmap(fd, ...)` 已经泄露了线索：映射文件时，`fd` 不是地址空间中的普通指针，却能让内核定位某个 backing object。现在要把这个“对象引用”讲清楚。

## 3. 操作系统对象和 API

### 3.1 程序员脑中是“帮我做事”

应用开发者通常从意图出发：

- 读取网络请求；
- 把结果写入文件；
- 查询进程内存映射；
- 向终端显示字符；
- 与另一个进程交换数据。

不同平台可以给同一意图完全不同的外观。例如查询进程内存，可能表现为：

```python
Path("/proc/1234/maps").read_text()
```

也可能表现为 `GetMemoryMap(pid)`，或先取得进程 handle，再调用 `VirtualQueryEx`、`ReadProcessMemory` 一类专用 API。对应用来说，它们都是“请 OS 访问我无权直接解引用的对象”。

### 3.2 设计者脑中是“怎样提供长期稳定的抽象层”

内核设计者希望接口满足几件互相牵制的事：

- **简单**：少量概念足以完成常见工作；
- **稳定**：应用二进制不应随内核内部结构变化而重写；
- **通用**：新设备、新协议能接入既有工具；
- **可授权**：拿到引用的进程只能做被允许的操作；
- **可回收**：进程退出或引用关闭后，资源生命周期可确定结束；
- **可组合**：一个程序的输出能成为另一个程序的输入。

UNIX 倾向于用路径、文件描述符和 `read/write` 形成窄腰；Windows 更常把能力显式展开为 `CreateFileW`、`WriteFile`、`SetFilePointerEx`、`OpenProcess`、`ReadProcessMemory` 等对象相关 API。两者并非“一个只有通用 API、另一个毫无抽象”：UNIX 也有 `ioctl`、`socket`、`epoll` 等专用接口，Windows 的 `CreateFileW` 也能打开文件、设备和命名管道。真正的差异是抽象风格与历史兼容性的取舍。

### 3.3 什么算“操作系统对象”

本讲把由内核维护、应用必须经由 API 访问的状态统称为操作系统对象，例如：

- 普通文件的打开实例；
- 目录遍历状态；
- 管道缓冲区及其读写端；
- 终端及行规程；
- socket 连接状态；
- 设备驱动暴露的实例；
- 进程、线程、事件、共享内存等。

“对象”是建模词，不保证内核里真有同名的 C++ class。关键是它具有身份、状态、操作、权限和生命周期。

## 4. UNIX：Everything is a File

### 4.1 先问：什么是文件

小学电脑课式的文件模型已经相当强大：

```text
文件 = 一个有名字的字节序列
操作 = 打开、按当前位置读写、移动当前位置、关闭
目录 = 从名字到对象的组织结构
```

它隐藏了磁盘块、缓存、驱动和网络协议。程序只需知道名字和字节，不必知道一个字节来自 NVMe、内存还是远端服务器。

不过要立即补两条边界：

1. 普通文件近似可随机访问数组；管道、终端和网络连接通常是只能顺序消费的数据流，`lseek` 会失败并报告 `ESPIPE`。
2. “有名字”也不是绝对条件。匿名管道没有文件系统路径，打开后被 `unlink` 的文件仍可通过 fd 使用。

因此，更准确的口号是：**UNIX 尽量让不同资源通过文件描述符和一组文件式操作被访问。**

### 4.2 为什么这个抽象如此普适

只要对象能提供或接收字节，它就能接入相似接口：

| 对象 | `read` 的含义 | `write` 的含义 | 是否通常可 `lseek` |
| --- | --- | --- | --- |
| 普通文件 | 从当前偏移取字节 | 在当前偏移放字节 | 是 |
| 管道 | 取走生产者写入的字节 | 放入有界缓冲区 | 否 |
| 终端 | 从行规程取得输入 | 显示字符/控制序列 | 否 |
| TCP socket | 从接收流取字节 | 向发送流追加字节 | 否 |
| `/dev/null` | 立即 EOF | 丢弃所有字节 | 语义特殊 |
| `/dev/urandom` | 生成随机字节 | 平台定义，通常无需写 | 否 |

打印机、显卡、锁或事件也可以“假装成文件”，但并非都只靠字节流就够用。对象特有控制常通过 `ioctl`、`fcntl`、`mmap` 或专用系统调用补足。这个逃生口降低了统一性，却避免把所有控制语义硬编码进 `read/write`。

### 4.3 用目录管理名字：从 `dict[Path, bytes]` 到 FHS

最小教学 OS 甚至可以把文件系统想成：

```text
dictionary[path] = byte_sequence
```

真实系统还需要目录层级、权限、硬链接、符号链接、挂载点、持久化、一致性、缓存和并发控制。但“用路径命名对象”依然是用户看到的稳定表面。

[Filesystem Hierarchy Standard](http://refspecs.linuxfoundation.org/FHS_3.0/fhs/index.html) 进一步约定常见路径的角色，使软件和用户能预测配置、可执行文件、库与可变数据大致放在哪里。它约束的是生态的布局，不代表每个 UNIX 系统完全一致，也不代表 `/proc` 中的内容存到了磁盘。

### 4.4 文件系统可以构建信息系统，但不是免费数据库

讲义用课程网站举例：提交保存到 `/var/www/filerecv`，评测后生成 `.result` 文件，刷新页面时遍历目录树。这个实现的魅力在于，状态可以用 `find`、`cp`、编辑器和备份工具直接观察；文件系统本身就是一个容易执行和调试的模型。

“为什么不用数据库？”要根据需求回答：

- 单机、低并发、状态较小的原型，文件往往足够简单可靠；
- 复杂查询、事务、唯一约束、高并发更新和跨节点一致性，数据库通常更合适；
- 直接“写最终文件名”可能让读者看到半成品，常见修正是先写临时文件、同步，再原子 `rename`；
- 两个工作进程同时评测同一提交时，还需要锁、幂等键或事务协议。

讲义提出的 BlockFlow/Agentic AI 畅想是：先用文件和小工具表达清楚语义，再让 LLM 翻译成数据库或 serverless 实现。它是很好的工程方向，但“自动证明幂等性和语义等价”仍要求明确的状态机、失败模型和可检查规格；自然语言意图本身不能代替证明。

## 5. UNIX Philosophy：组合比巨型接口更重要

### 5.1 三条原则

讲义把 UNIX Philosophy 概括为：

1. Do one thing and do it well；
2. 小工具应能一起工作；
3. 文本流是一种通用接口。

它们和 “Everything is a File” 互相支撑：文件描述符统一承载数据流，Shell 用管道连接工具，文本让人和程序都能临时解释内容。

例如讲义中的命令：

```bash
grep -s VmRSS /proc/*[0-9]/status |
  awk '{sum += $2} END {print sum " kB"}'
```

`grep` 不需要“进程对象 API”，因为内核已经把状态导出为文本文件；`awk` 不需要认识 `/proc`，只处理上一阶段的文本。这就是组合带来的复用。

### 5.2 文本是平衡点，不是完美类型系统

文本适合 quick & dirty：可查看、可搜索、可用任意语言产生和消费。但它也广受批评：

- 空格、换行和区域设置可能改变解析；
- 类型、单位、schema 和错误信息常靠约定；
- 二进制数据编码后会膨胀；
- 大数据量反复解析成本高；
- 文件名本身可以包含空格甚至换行。

因此现代系统会按场景选 NUL 分隔、JSON、数据库、Protocol Buffers 或类型化 RPC。UNIX 哲学最值得保留的是**小而稳定的边界和可组合性**，不是强迫所有对象永远输出脆弱的空格分隔文本。

### 5.3 “Intelligence is Cheap”之后，验证仍然昂贵

Agent 可以把“统计所有进程 RSS”“解释所有 fd 指向什么”这样的自然语言快速翻译为命令和程序。人的瓶颈更像是提出有价值的观察、定义正确性并识别危险操作。例如扫描 `/proc/*/fd` 会遇到权限和进程退出竞态；读取块设备可能暴露敏感数据。想象可以枚举，结果必须在真实权限和失败条件下验证。

## 6. 文件描述符：访问内核对象的“指针”

### 6.1 CrazyOS 的最小模型

讲义先在 CrazyOS 中写一个极简对象：

```c
struct FILE {                 // 教学模型，不是 libc 的 FILE
    char *data;
    size_t offset;
};
```

若只有一个全局 buffer，把它扩展成多个 `struct FILE` 就能表达多个打开对象：

- `open`：分配并初始化一个 `struct FILE`；
- `read/write`：从 `data + offset` 传送字节，并推进 `offset`；
- `lseek`：修改 `offset`；
- `dup`：再建立一个指向同一对象的引用；
- `close`：删除一个引用，最后一个引用消失时回收对象。

CrazyOS 用 `mini-rv32ima.h` 单步模拟 RISC-V 程序，并在 guest 发起 syscall 时转入宿主实现。这个环境特别适合看清边界：guest 程序的地址只属于 guest `mem[]`，不能直接拿宿主/内核里的 `struct FILE *`。

### 6.2 为什么不能把真正的内核指针返回给应用

直接暴露内核地址会造成至少四个问题：

- 应用可能伪造、越界或在释放后继续使用指针；
- 内核地址布局和内部结构会泄露，破坏隔离与兼容性；
- 32/64 位、重启和对象迁移会使裸地址失效；
- 内核无法在每次普通 load/store 时插入权限和生命周期检查。

所以应用持有的是一个由内核解释的“小整数指针”：

```text
用户传入 fd = 3
       ↓ 系统调用边界
内核检查：3 是否在当前进程 fd 表中？请求的操作是否允许？
       ↓
取得对象引用，调用该对象对应的 read/write/... 实现
```

fd 不是 C 指针，猜中一个整数也不能跨进程访问对象。它更像进程局部、可复制、可关闭的 capability-like reference；真正授权仍结合打开模式、进程凭据和对象规则。

### 6.3 fd 是另一种地址空间

文件描述符表可以看作另一张命名空间：

```text
fd number:  0      1       2       3       4      ...
entry:     stdin  stdout  stderr  objectA objectB  ...
```

约定上，进程启动时：

- `0` 是标准输入 `STDIN_FILENO`；
- `1` 是标准输出 `STDOUT_FILENO`；
- `2` 是标准错误 `STDERR_FILENO`。

这只是约定，不是不可变规则。服务进程可以关闭 0–2，Shell 可以让 1 指向文件、让 2 指向 1，测试框架也可以把它们接到管道。若 0 已关闭，下一次 `open()` 就可能返回 0，而不是 3。

`open()` 成功时返回当前进程中最小的未使用描述符。因此通常第一个新对象是 3；关闭 3 后，下次打开往往复用 3。正因为编号会复用，多线程程序不能在一个线程 `close(fd)` 后假定另一个线程手里的同值整数仍代表旧对象。

### 6.4 精确模型：fd 不直接等于磁盘文件

必须区分三层：

```text
进程 A 的 fd 表                   系统级打开状态                 底层对象
  3 ───────────────┐
                    ├──> open file description ───────> inode / device
  8 ───────────────┘       offset = 4
                            status flags = O_APPEND ...

进程 B 的 fd 表
  5 ───────────────────> 另一个 open file description ─> 同一个 inode
                            offset = 0
```

- **文件描述符（fd）**：某个进程表中的整数下标；条目还带 `FD_CLOEXEC` 这样的 descriptor flag。
- **打开文件描述（open file description）**：一次打开产生的内核状态，保存当前偏移和 `O_APPEND`、`O_NONBLOCK` 等 file status flags。
- **底层对象**：inode、管道缓冲、socket、设备实例等；多个打开描述可以指向它。

`dup` 和 `fork` 复制的是第一层引用，所以通常共享第二层的偏移与状态标志。对同一路径重新调用 `open`，会创建新的打开文件描述，因此偏移彼此独立。这个区分是理解后续 Shell、并发 I/O 和文件锁的地基。

### 6.5 常见操作到底改哪一层

| 操作 | 主要效果 |
| --- | --- |
| `open(path, flags, mode)` | 路径解析与权限检查；创建打开文件描述；把引用装入最低空闲 fd |
| `read(fd, buf, n)` | 从对象传送最多 `n` 字节；普通文件通常推进共享偏移 |
| `write(fd, buf, n)` | 向对象传送字节；可能短写、阻塞或失败 |
| `lseek(fd, off, whence)` | 修改打开文件描述中的偏移；流对象可能报 `ESPIPE` |
| `dup(fd)` | 新 fd 引用同一打开文件描述，返回最低空闲编号 |
| `dup2(old, new)` | 让指定编号 `new` 原子地改指向 `old` 的打开描述 |
| `close(fd)` | 删除当前 fd 表条目；最后一个引用消失后才释放打开状态 |
| `unlink(path)` | 删除目录项；已打开对象仍可活到最后一个引用关闭 |

`read` 返回正数表示实际字节数，返回 0 表示 EOF，返回 -1 并设置 `errno` 表示错误。少读或少写并不等于错误，健壮程序必须按对象语义循环处理。`close` 也可能暴露延迟写错误；而在 Linux 多线程程序中盲目重试失败的 `close` 又可能误关已复用的编号，所以必须查目标平台契约。

## 7. API 相互影响：真正的系统复杂性

### 7.1 `fork()` 以后，offset 会发生什么

假设父进程在 fd 3 对应的普通文件上读了两个字节，再 `fork()`。父子 fd 3 通常都指向同一个打开文件描述；任何一方继续顺序读取都会推进同一个 offset。

这既有用又危险：

- 有用：父子可自然继承终端、日志文件和管道端点；
- 危险：没有协议的并发读写会互相影响位置，输出可能交错；
- 微妙：`pread/pwrite` 使用显式位置，不改变共享 offset，常能减少这种耦合；
- 仍不充分：一次 `write` 的原子性、`O_APPEND` 和文件系统语义还要另行判断。

这正说明软件系统的复杂性往往不在单个 API，而在 API 的笛卡尔积：`open × dup × fork × exec × threads × signals × errors` 的每个组合都可能有边界条件。

### 7.2 `execve()` 不会自动清空全部 fd

`execve()` 替换用户地址空间，却默认保留没有设置 close-on-exec 的文件描述符。这样，新程序能自然继承标准输入输出，Shell 才能先重定向再执行命令。

但无意继承会导致：

- 子进程持有敏感文件或 socket，权限边界被扩大；
- 某个管道写端意外存活，读者永远等不到 EOF；
- 文件、挂载点或网络连接因额外引用而无法及时释放。

`FD_CLOEXEC` 表示成功 `execve()` 时关闭该 fd。优先在创建时使用 `open(..., O_CLOEXEC)`、`pipe2(..., O_CLOEXEC)` 等原子接口；若先 `open` 再 `fcntl(F_SETFD)`，多线程程序可能恰在两步之间由另一线程 fork/exec，形成泄漏竞态。

### 7.3 Windows handle：相同问题，另一种接口风格

Windows 的 handle 也是由操作系统解释的对象引用，“把手/把柄”这个名字很形象：应用握住它来操作文件、进程、线程、事件等对象，但不能据此看见内核结构。

和 UNIX 教学模型相比：

| 维度 | UNIX fd | Windows handle |
| --- | --- | --- |
| 用户可见表示 | 通常是非负小整数 | 不透明的 `HANDLE` 值 |
| 常见对象 | 文件、管道、socket、终端、设备 | 文件、进程、线程、事件、管道等 |
| 数据操作 | 强调 `read/write` 窄接口 | 常按对象使用 `ReadFile`、`ReadProcessMemory` 等 API |
| 子进程继承 | `fork` 默认复制 fd 引用 | handle 必须标记可继承，创建进程时也要允许继承 |
| 新程序标准流 | fd 0/1/2；`dup2` 后 `execve` | `STARTUPINFO`/扩展属性配置标准 handles |
| 防止跨程序继承 | `FD_CLOEXEC`/`O_CLOEXEC` | 默认不继承，或显式 handle list |

Windows 经典 `CreateProcess` 路径需要对象本身可继承，并设置 `bInheritHandles`；标准输入输出还要正确配置启动信息。现代代码可使用更精确的显式 handle 列表。它体现“最小权限原则”，代价是创建子进程时配置更显式。

讲义中的“句柄乌龙”和汽车门把手图片是在提醒：名字再形象，也不能代替契约。一个 `HANDLE` 可能以 `NULL` 或 `INVALID_HANDLE_VALUE` 表示失败，具体取决于 API；一个 UNIX fd 的失败通常是 `-1`。必须读对应函数文档，不能凭“它像指针”猜错误值、继承或关闭方式。

### 7.4 复杂性不是 UNIX 或 Windows 独有

UNIX 的默认继承让 Shell 组合简洁，却带来泄漏和共享状态；Windows 默认不继承更保守，却要求调用者显式传递启动配置。任何一边一旦加入线程、异步 I/O、安全令牌和兼容性，都会复杂。设计评估不应停在 API 数量，而要问：默认是否安全、组合是否可预测、错误是否可恢复、状态由谁拥有。

## 8. 特殊文件：`/proc`、`/dev` 和“假装”的边界

### 8.1 `/proc`：把内核状态投影成目录树

Linux 的 procfs 是伪文件系统。`/proc/PID/status`、`maps`、`fd/` 等内容通常由内核在访问时生成，并非磁盘上已有一份文本副本：

- `/proc/PID/status` 暴露进程的文本状态；
- `/proc/PID/maps` 暴露地址空间映射；
- `/proc/PID/fd/N` 是符号链接式视图，显示 fd `N` 指向的对象；
- 管道常显示为 `pipe:[inode-number]`，socket 常显示为 `socket:[...]`；
- 进程可能在遍历期间退出，所以 `ENOENT` 是正常竞态。

“看得见路径”不代表有权限。其他用户进程、容器或安全策略可能限制读取；对 `/proc` 的访问仍要经过内核权限检查。

### 8.2 `/dev`：名字背后是驱动

设备节点把路径和驱动操作关联起来：

- `/dev/tty`：当前进程的控制终端；
- `/dev/sda` 等：真实块设备的接口，直接访问通常需要高权限且很危险；
- `/dev/null`：写入数据全部丢弃，读取立即 EOF；
- `/dev/urandom`：读取由内核随机数子系统生成的字节；
- `/dev/ptmx`：创建伪终端 master 的入口，下一讲会继续使用。

称 `/dev/null` 为“虚假设备”强调它没有一块对应的物理硬件；称它为“设备文件”强调它仍由驱动式操作实现。它不是普通磁盘字节数组，但可以被重定向和组合，这才是统一抽象的价值。

### 8.3 观察全系统 fd 时要接受不完整结果

讲义建议查看：

```bash
ls -l /proc/*/fd/* 2>/dev/null |
  awk '{print $(NF-2), $(NF-1), $NF}'
```

这能快速看到终端、管道、socket 和文件，但它不是可靠解析 API：`ls` 输出受文件名和区域设置影响，`2>/dev/null` 还隐藏了权限拒绝与进程退出。探索时这样做很高效；写监控工具时应逐项读取目录、保留错误类别，并考虑 PID 复用和权限模型。

## 9. 实验 1：用 `/proc` 看见自己的描述符表

依赖：Linux、POSIX Shell。请在交互式 Shell 中执行；不同终端和重定向环境的输出会不同。

```bash
printf 'shell pid = %s\n' "$$"
ls -l "/proc/$$/fd"

# 让当前 Shell 打开 /etc/hostname，并把引用固定到 fd 3。
exec 3</etc/hostname
readlink "/proc/$$/fd/3"
IFS= read -r first_line <&3
printf 'read from fd 3: %s\n' "$first_line"

# 关闭引用；对应目录项随即消失。
exec 3<&-
test ! -e "/proc/$$/fd/3" && echo 'fd 3 is closed'

printf 'discarded\n' >/dev/null
head -c 8 /dev/urandom | od -An -tx1
```

预期观察：

1. 0、1、2 多半指向 `/dev/pts/N`，但在 IDE、容器或管道中也可能指向 pipe 或文件；
2. `exec 3</etc/hostname` 是 Shell 自身执行 `open`，`/proc/$$/fd/3` 随之出现；
3. `read` 推进 fd 3 对应打开文件描述的 offset；
4. 关闭后表项消失，之后同一编号可以被复用；
5. `/dev/null` 和 `/dev/urandom` 不是普通持久文件，却能参加相同的重定向和管道。

若 fd 3 原本已被当前 Shell 使用，请改用 9，并同步替换命令中的编号。这也说明“第一个新 fd 总是 3”依赖当前表中 0–2 之外没有占用项。

## 10. 实验 2：亲手区分 fd、打开文件描述和底层文件

把下面程序保存为 `/tmp/fd-model.c`：

```c
#define _XOPEN_SOURCE 700
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void die(const char *what) {
    perror(what);
    exit(EXIT_FAILURE);
}

static void write_all(int fd, const char *s, size_t n) {
    while (n > 0) {
        ssize_t k = write(fd, s, n);
        if (k < 0 && errno == EINTR) continue;
        if (k < 0) die("write");
        if (k == 0) {
            fprintf(stderr, "write made no progress\n");
            exit(EXIT_FAILURE);
        }
        s += (size_t)k;
        n -= (size_t)k;
    }
}

static void read_two(int fd, const char *label) {
    char buf[3] = {0};
    size_t done = 0;
    while (done < 2) {
        ssize_t k = read(fd, buf + done, 2 - done);
        if (k < 0 && errno == EINTR) continue;
        if (k < 0) die("read");
        if (k == 0) {
            fprintf(stderr, "unexpected EOF\n");
            exit(EXIT_FAILURE);
        }
        done += (size_t)k;
    }
    printf("%s read %s\n", label, buf);
}

int main(void) {
    char path[] = "/tmp/fd-model-XXXXXX";
    int a = mkstemp(path);                    // 新 open file description
    if (a < 0) die("mkstemp");
    write_all(a, "abcdef", 6);
    if (lseek(a, 0, SEEK_SET) < 0) die("lseek a");

    int c = open(path, O_RDONLY);             // 同一文件，独立 offset
    if (c < 0) die("open c");
    if (unlink(path) < 0) die("unlink");      // 名字消失，对象仍被引用

    int b = dup(a);                           // 和 a 共享 offset
    if (b < 0) die("dup");
    printf("a=%d, b=%d (dup a), c=%d (open again)\n", a, b, c);

    read_two(a, "a");                        // offset: 0 -> 2
    read_two(b, "b");                        // 共享 offset: 2 -> 4
    read_two(c, "c");                        // 独立 offset: 0 -> 2

    int freed = b;
    if (close(b) < 0) die("close b");
    int d = open("/dev/null", O_RDONLY);
    if (d < 0) die("open /dev/null");
    printf("closed fd %d; next open returned %d\n", freed, d);

    if (close(a) < 0) die("close a");
    if (close(c) < 0) die("close c");
    if (close(d) < 0) die("close d");
    return 0;
}
```

编译运行：

```bash
cc -std=c11 -Wall -Wextra -O2 /tmp/fd-model.c -o /tmp/fd-model
/tmp/fd-model
```

典型输出的关键部分是：

```text
a read ab
b read cd
c read ab
```

解释：`a` 和 `b` 是两个 fd 表项，却引用同一个打开文件描述，所以 `b` 接着 `a` 的位置读取；`c` 来自第二次 `open`，只和它们共享底层 inode，不共享 offset。`unlink` 删除名字后三个 fd 仍可读取，说明目录项、打开状态和文件内容对象的生命周期并不相同。关闭 `b` 后，在没有并发打开的这个单线程程序中，`/dev/null` 通常复用它的编号。

## 11. 实验 3：软限制不是“内核里写死的最大编号”

先查看 Shell 的软、硬限制：

```bash
ulimit -Sn
ulimit -Hn
```

Linux 上也可查看 `/proc/$$/limits`。为了避免在课程机器上真的打开几十万项，下面程序配合一个临时降低的软限制运行：

```c
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <unistd.h>

int main(void) {
    struct rlimit lim;
    if (getrlimit(RLIMIT_NOFILE, &lim) < 0) {
        perror("getrlimit");
        return EXIT_FAILURE;
    }
    printf("soft limit = %llu\n", (unsigned long long)lim.rlim_cur);

    int fds[256];
    size_t n = 0;
    int stop_errno = 0;
    while (n < sizeof(fds) / sizeof(fds[0])) {
        int fd = open("/dev/null", O_RDONLY);
        if (fd < 0) {
            stop_errno = errno;
            if (stop_errno != EMFILE) perror("open");
            break;
        }
        fds[n++] = fd;
    }
    if (stop_errno != 0) {
        printf("opened %zu extra descriptors; errno = %d (%s)\n",
               n, stop_errno, strerror(stop_errno));
    } else {
        printf("opened %zu extra descriptors; array capacity reached\n", n);
    }
    while (n > 0) {
        if (close(fds[--n]) < 0) perror("close");
    }
    return 0;
}
```

保存为 `/tmp/fd-limit.c` 后，用下面的命令验证；`-Werror` 还能避免把缺失声明等警告带进实验结果：

```bash
cc -std=c11 -Wall -Wextra -Werror /tmp/fd-limit.c -o /tmp/fd-limit
(ulimit -n 64; /tmp/fd-limit)
```

在 0、1、2 均已打开且没有其他持久 fd 时，通常还能新开约 61 个，随后 `open` 返回 `EMFILE`。限制属于进程资源策略，不是“文件系统最多只有这么多文件”；硬限制、系统级资源、内存和内核配置还会形成其他边界。

## 12. 匿名管道：没有路径也能成为文件对象

### 12.1 `pipe` 创建什么

```c
int pipe(int pipefd[2]);
```

成功后：

- `pipefd[0]` 是读端；
- `pipefd[1]` 是写端；
- 内核创建有界字节缓冲区；
- 两个 fd 只在持有它们的进程中可见，没有普通文件系统路径。

同一进程既持有读端又持有写端似乎没有意义；关键是 `fork()` 会复制两端的引用。父进程在 fork 前创建管道，随后让一个子进程只留写端、另一个只留读端，就得到进程间单向数据流。

### 12.2 引用计数决定 EOF，而不是某个 PID 的意愿

管道读端的行为是：

- 缓冲区有数据：返回当前可取得的字节；
- 缓冲区空但仍有写端：阻塞，或非阻塞时返回 `EAGAIN`；
- 缓冲区空且所有写端都关闭：返回 0，即 EOF。

写端则是：

- 有空间：写入部分或全部数据；
- 缓冲区满：阻塞，或非阻塞时返回 `EAGAIN`；
- 所有读端都关闭：进程通常收到 `SIGPIPE`，若信号被忽略/处理，`write` 返回 `EPIPE`。

所以“父进程不用这个写端”不够；它必须 `close`。只要任何进程还保留一个写端引用，消费者就不能断定未来不会再有数据。

### 12.3 实验 4：运行仓库里的 `pipeline.c`

仓库已提供完整、检查关键错误的示例：[examples/pipeline.c](../../examples/pipeline.c)。从仓库根目录执行：

```bash
cc -std=c11 -Wall -Wextra -O2 examples/pipeline.c -o /tmp/pipeline
/tmp/pipeline
```

预期输出：

```text
3
```

它实现的对象图是：

```text
producer child                         consumer child
fd 1 ──> pipe write end → [buffer] → pipe read end ──> fd 0
 exec printf                                              exec wc -l

parent: 创建后曾持有两端，但在等待前把两端都 close
```

程序的关键顺序：

1. 父进程 `pipe(channel)`；
2. producer 子进程用 `dup2(channel[1], 1)` 让标准输出指向管道写端；
3. consumer 子进程用 `dup2(channel[0], 0)` 让标准输入指向管道读端；
4. 每个进程关闭所有不再需要的原始 fd；
5. 两个子进程分别 `exec` `printf` 与 `wc -l`；
6. 父进程关闭自己的两端，再 `waitpid`。

若安装了 `strace`，可以直接观察对象布局被系统调用改变：

```bash
strace -f -e trace=process,desc /tmp/pipeline
```

重点找 `pipe`/`pipe2`、`clone`/`fork`、`dup2`、`close`、`execve`、`read`、`write` 和 `wait4`。不同 libc 或内核可能选择不同但等价的具体系统调用。

一个安全的反事实实验是复制示例到 `/tmp`，只注释父进程的 `close(channel[1])`，再运行：

```bash
timeout 2 /tmp/pipeline-keeps-writer
printf 'exit status = %d\n' "$?"
```

此时 `wc` 通常打印不出最终结果并等待；父进程又在 `waitpid` 等它，形成停滞。`timeout` 返回 124 表明超时。原因不是数据没写完，而是父进程额外持有的写端让 EOF 条件永远不成立。

### 12.4 管道不是消息队列

管道传输字节流，不保存应用定义的“第几条消息”。一次 `write(100)` 不保证读端一次 `read` 恰好得到 100 字节。POSIX 对不超过 `PIPE_BUF` 的单次写入提供与其他写者不交错的保证，但读者仍需自己设计分帧协议。管道缓冲有限，因此天然形成背压；这既保护内存，也可能在环状管道或“先等退出、后读输出”的测试框架中造成死锁。

## 13. 综合案例：TestKit 如何把这些机制组合起来

### 13.1 它想解决什么

讲义中的 TestKit 是同学们接触的第一个 C 测试框架：测试用例写在代码附近，可直接调用内部函数；单元测试和系统测试自动注册，并在隔离的子进程中运行。按讲义呈现的接口效果，程序正常结束后进入统一的测试运行阶段；这不是“进程已被内核销毁后又复活”，而是退出流程或 runner 包装仍掌握控制权。测试子进程即使 `abort`、段错误或直接 `exit`，父 runner 仍有机会报告失败并继续其他用例。

“随时调用内部函数”和“允许直接 crash”看似两种无关能力，其实都来自进程模型：链接时让测试代码看见内部函数，运行时用 `fork` 得到隔离地址空间，再由父进程用 `waitpid` 观察终止状态。

### 13.2 一个最小 TestKit runner 的对象图

具体版本实现可能不同，但讲义案例可用下面的机制图理解：

```text
test runner
  ├─ registry：已注册的 test function / SystemTest 描述
  ├─ pipe for stdout
  ├─ pipe for stderr/result
  └─ fork
       ├─ child
       │    dup2(pipe_out, 1/2)
       │    close unused ends
       │    call test function 或 exec 被测程序
       │    exit / crash
       └─ parent
            close unused ends
            drain output pipes
            waitpid / timeout
            classify exit status and compare output
```

这里复用了本讲几乎所有概念：

- **对象**：子进程、管道、输出文件、计时器；
- **fd 继承**：fork 后父子一开始都持有管道两端；
- **重定向**：`dup2` 把被测程序的 1/2 接到捕获管道；
- **生命周期**：关闭无用端才能得到 EOF；
- **进程隔离**：子进程写坏内存不会直接破坏 runner 地址空间；
- **状态观察**：`waitpid` 区分正常退出、信号终止和退出码；
- **exec 继承边界**：只把需要的 fd 留给被测程序，其余使用 close-on-exec。

### 13.3 “全部放进子进程”不是自动万无一失

一个可靠测试框架仍要处理：

- 子进程无限循环，需要 timeout 后终止并回收；
- 子进程或孙进程继续持有写端，父进程读输出永远等不到 EOF；
- 输出超过管道容量，若父进程先 `waitpid`、后读取，子进程可能堵在 `write`，形成死锁；
- `fork` 后复制的 stdio buffer 可能被父子重复冲刷，应明确使用 `_exit` 和刷新策略；
- 多线程进程 fork 后只有调用线程存活，锁状态可能不一致；
- 比较文本时要定义尾随换行、编码、stderr 和输出顺序；
- 测试注册、框架头文件和 runner 必须来自兼容版本。

因此父进程通常要一边排空 stdout/stderr，一边监控超时和退出；复杂实现会用 `poll`/`select` 或非阻塞 fd。后续课程会继续讨论并发与事件等待。

### 13.4 正确使用 AI 生成测试

讲义建议让 LLM 帮忙生成测试，“用魔法打败魔法”。合适的分工是：

1. 人先给出接口版本、前置条件和可观察语义；
2. Agent 枚举正常、边界、错误和资源泄漏路径；
3. TestKit 在子进程中执行，保留 stdout/stderr、退出状态和超时证据；
4. 人和 Agent 根据失败轨迹缩小问题，而不是只看红绿结果；
5. 若所有测试同时以相同签名错误失败，优先检查框架—TestKit 版本协议。

AI 降低了写 test case 的成本，却没有消除 oracle problem：若预期结果写错，自动化只会更快地确认错误规格。

## 14. 分层辨析与常见误区

### 14.1 `FILE *`、fd 和内核对象不是一回事

讲义的 `struct FILE` 是 CrazyOS 教学模型。真实 C 标准库中的 `FILE *` 是用户态 stdio 对象，包含缓冲、EOF/error 状态和锁等，通常在底层封装一个 fd；fd 又只是进入内核对象图的索引。`fread` 可能只读 libc buffer，并不保证每次都发生 `read` 系统调用。

### 14.2 系统调用、libc wrapper 与 Shell 语法不是一层

- C 中的 `open()` 通常是 libc 提供的 wrapper，最终请求内核；
- `fopen()` 是更高层的 stdio API，返回 `FILE *`；
- Shell 的 `>` 是语言语法，Shell 自己调用 `open`、`dup2` 和 `close`；
- Python 的 `Path.read_text()` 又在这些层之上处理编码与异常。

看到同一意图时，要问错误和缓冲发生在哪层。

### 14.3 fd 不是全局编号，也不是永久身份

同一个数字在不同进程中无关；关闭后会迅速复用。若要向另一个进程传递 fd，不能只发送整数文本，需要继承，或通过 UNIX domain socket 的 `SCM_RIGHTS` 让内核复制引用。

### 14.4 `close` 不等于删除，`unlink` 不等于立刻销毁

`close` 删除一个 fd 引用；`unlink` 删除一个目录项。同一对象还被其他 fd 或硬链接引用时，数据仍然存在。实验 2 已直接观察这一点。

### 14.5 `dup` 不会复制 offset

`dup` 复制引用而不是克隆打开文件描述。要独立当前位置，通常重新 `open`，或改用显式偏移的 `pread/pwrite`。即便重新打开同一路径，两个实例仍可能共享底层文件内容。

### 14.6 `fork` 继承与 `exec` 继承不要混为一谈

`fork` 创建新进程并复制 fd 表引用；`execve` 不创建进程，只替换当前进程的用户态程序映像，并按 close-on-exec 标志决定哪些 fd 保留。Windows `CreateProcess` 又是另一套继承协议。

### 14.7 Everything is a File 不是“所有对象都有普通文件语义”

管道不能 seek，目录不能当任意字节流写，设备可能要求 `ioctl`，socket 还需要地址和连接管理。统一的是引用和部分操作，不是所有语义。

### 14.8 `/proc` 的文本不是稳定快照

读取多个 procfs 文件期间系统仍在变化；同一进程也可能退出或 exec。调试观察可以接受近似，安全检查或计费逻辑必须考虑竞态，并使用更合适的内核接口。

## 15. 本讲小结：从整数恢复出对象图

本讲最重要的观念替换是：

```text
错误直觉：fd 3 就是“第三个文件”

正确模型：当前进程中的整数 3
            → fd 表中的一个引用
            → 打开文件描述（offset、status flags）
            → inode、管道、socket、终端或设备对象
```

由此可以串起整讲：

1. 进程是封闭世界，地址空间外的对象只能经系统调用访问；
2. UNIX 用文件式接口形成稳定窄腰，用目录组织名字；
3. fd 是进程局部的对象引用，不是裸内核指针；
4. `dup` 和 `fork` 共享打开文件描述，因此也共享 offset 等状态；
5. `execve` 默认保留 fd，close-on-exec 控制能力泄漏；
6. `/proc` 和 `/dev` 证明“文件”可以是动态内核状态或设备接口；
7. 匿名管道把两个 fd 和一个缓冲区组合成 IPC；
8. TestKit 再把 `fork`、管道、重定向、等待和退出状态组合成测试框架；
9. Windows handle 处理相同的对象引用问题，只是 API 与默认继承策略不同。

Takeaway 可以浓缩成一句话：**操作系统必须给应用访问内核对象的机制；在 UNIX 中，文件描述符就是这种受保护、可组合的“对象指针”。**

## 16. 思考题与延伸实验

1. 父进程和子进程的 fd 3 都指向同一打开文件描述；若父读 10 字节、子读 10 字节，能否保证各自读到哪一段？还缺哪些调度与同步条件？
2. 为什么 `dup2(oldfd, STDOUT_FILENO)` 比 `close(1); dup(oldfd)` 更适合重定向？考虑两步之间的信号处理程序或其他线程。
3. 一个服务把监听 socket 忘记设为 close-on-exec。它启动的辅助程序会获得什么能力？为什么这既是资源泄漏也是安全问题？
4. 为什么管道所有写者都关闭后，读者还可能先读到数据、再得到 EOF？
5. 把 `pipeline.c` 扩展成 `printf | grep green | wc -l`。画出每个进程在 exec 前应该保留和关闭的所有 fd。
6. 若 TestKit 父进程先 `waitpid`，子进程向 stdout 写入超过管道容量的数据，怎样形成死锁？用哪两类设计可以解决？
7. `/proc/PID/fd/N` 显示 `socket:[12345]` 时，为什么不能像普通文件那样直接从该路径“重新打开”并接管连接？
8. 比较 `open` 两次、`dup` 一次和 `fork` 一次对 offset 的影响。若使用 `O_APPEND`，哪些状态仍然共享？
9. 文件系统原型要做到“评测结果要么完整出现、要么不存在”，可以如何利用临时文件、`fsync` 与 `rename`？崩溃模型还留下哪些空隙？
10. 在实验 1 中把 stdout 重定向到文件再运行 `ls -l /proc/$$/fd`。为什么观察工具自己的输出位置也会改变？

建议阅读 Operating Systems: Three Easy Pieces 第 39 章 Files and Directories，并结合本机 `man 2 open`、`man 2 dup`、`man 2 fork`、`man 2 pipe`、`man 5 proc` 和 `man 7 pipe` 核对平台细节。

## 17. 下一讲衔接：终端与 Shell 是对象组合器

本讲已经知道标准输入、标准输出和标准错误只是在约定位置 0、1、2 上的对象引用。下一讲会追问：当 0 指向终端时，为什么 `read` 可能等一整行？Ctrl-C 为什么不是普通字符？Shell 又怎样把：

```text
cmd1 < input | cmd2 > output 2>&1
```

翻译成 `open → pipe → fork → dup2 → close → execve → waitpid`？答案不需要新的魔法，只需在本讲对象图上加入终端的行规程、会话、进程组和一门组合语言。

## 18. PPT 内容覆盖表

| 原讲义标题/内容 | 本章对应位置 | 覆盖要点 |
| --- | --- | --- |
| Review & Comments；关于实验的更新 | §2.1 | 框架与旧 TestKit 的 `SystemTest` 参数不兼容、版本证据与复现 |
| 不太会，怎么办？ | §2.1、§13.4 | Agent 回退/同步提交、生成测试、放大自主性但保留验证 |
| 复习：程序和进程；进程是封闭世界 | §0、§2.2 | 程序加载、寄存器/内存、进程与内存管理系统调用 |
| 操作系统里肯定还有其他对象 | §2.2–§3.3 | 文件、管道、终端、socket、设备及对象管理 API |
| 操作系统对象和 API | §3.1–§3.2 | 程序员意图、设计者的简单稳定抽象、UNIX/Windows 风格 |
| UNIX: Everything is a File | §4.1–§4.2 | 有名字的字节序列、数据流/数组、统一操作与 seek 边界 |
| Everything is a File：目录与信息系统 | §4.3–§4.4 | `dict[Path,bytes]`、课程网站、文件原型与数据库取舍 |
| Build Everything with BlockFlow | §4.4 | 文件系统作为可执行模型、LLM 翻译、幂等与等价验证边界 |
| Filesystem Hierarchy Standard | §4.3 | 可预测目录布局、跨系统差异、与伪文件系统的区别 |
| UNIX Philosophy | §5 | KISS、小工具协作、文本流、组合示例与历史批评 |
| `/proc`、`/dev`、真实/虚假设备 | §8、实验 1 | procfs 动态状态、设备节点、`tty/sda/null/urandom/ptmx` |
| 文件描述符：访问操作系统对象的 “指针” | §6.1–§6.5 | CrazyOS `struct FILE`、内核索引、fd 命名空间与操作 |
| CrazyOS Demo | §6.1–§6.2 | RISC-V 单步模拟、guest syscall、为何不能暴露内核指针 |
| 文件描述符：另一个地址空间 | §6.3、实验 1 | 0/1/2、最低空闲编号、关闭后复用、每进程局部性 |
| Windows Handle | §7.3–§7.4 | 不透明对象引用、继承默认、启动标准流与错误值契约 |
| 文件描述符 Demo | §6.4–§6.5、实验 2–3 | fd/OFD/inode 三层、共享偏移、独立 open、资源限制 |
| “句柄”乌龙 | §7.3 | 形象名字不能替代 API 契约与错误检查 |
| 操作系统的真正复杂性 | §7.1–§7.4 | API 交互、fork 后 offset、线程竞态与设计取舍 |
| Windows Handle API | §7.3 | `bInheritHandles`、可继承属性、启动信息、最小权限 |
| Linux `O_CLOEXEC` | §7.2 | exec 继承、fd 泄漏与原子 close-on-exec |
| 看看系统里到底有什么文件吧！ | §8.3、实验 1 | 遍历 `/proc/*/fd`、权限/退出竞态、可靠解析边界 |
| Intelligence is Cheap | §5.3、§13.4 | 自然语言到工具、想象力与验证责任 |
| 匿名管道 | §12.1–§12.2 | `pipefd[0/1]`、fork 继承、EOF/阻塞/EPIPE |
| UNIX 管道 Demo | §12.3–§12.4 | 复用 `pipeline.c`、`dup2`、close、exec、strace、背压 |
| 综合例子：TestKit | §13.1–§13.3 | 单元/系统测试、自动注册、子进程隔离、输出捕获与超时 |
| TestKit 正确打开方式 | §13.4 | LLM 生成案例、版本协议、oracle 与运行证据 |
| [TestKit 测试框架](/OS/demos/virtualization/testkit) | §13.2 | runner/child 对象图、管道重定向、wait 状态分类 |
| Takeaways | §15 | OS 对象访问机制；UNIX fd 与 Windows handle 的统一总结 |
| 阅读材料：OSTEP 第 39 章 | §16 末 | Files and Directories 与相关 man pages |
