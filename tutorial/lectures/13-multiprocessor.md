# 第 13 讲：多处理器编程——从入门到放弃

> 原始讲义：[sources/notes/lect13.md](../../sources/notes/lect13.md)  
> 前一讲：[构建应用生态](12-application-ecosystem.md) · 后一讲：[并发控制：互斥](14-mutual-exclusion.md)  
> 配套示例：[examples/race_counter.c](../../examples/race_counter.c)、[examples/parallel_sum.c](../../examples/parallel_sum.c)  
> 本讲关键词：共享内存、线程、`spawn`/`join`、并发、并行、数据竞争、非确定性、编译优化、C11 原子、宽松内存模型、litmus test

## 0. 本讲定位：应用生态已经运转，多个执行流开始相遇

前几讲沿着启动链走到了一个完整的应用生态：CPU reset 后由 firmware 装入操作系统，内核从 initramfs 启动早期 `init`，再挂载真正的根文件系统、执行 `pivot_root`，最终由 systemd 等 PID 1 进程拉起服务。ELF、链接、加载和 libc 把应用接到 `fork`、`execve`、`mount`、`mmap`、`open` 等系统调用上。

系统调用边界还隔离了应用与指令集。x86-64、AArch64、RISC-V 的陷入指令、参数寄存器和启动 ABI 不同，但这些差异主要由内核、libc、编译器和少量体系结构相关代码承担；上层的 C/Python/Node.js 程序和 PyPI、npm 等供应链因此可以共享绝大部分生态。

到这里，一个程序仿佛只有一条顺序执行线。本讲加入第二条执行线，并立刻遇到三次“放弃”：

```text
顺序应用 + 系统调用
        │
        ├── syscall 会等待；能否让另一个执行流继续？
        └── 机器有多个共享内存的 CPU；能否一起计算？
                         │
                         ▼
                    共享内存线程
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
  调度不确定性      编译器重写程序      CPU 宽松内存顺序
  “1 + 1 不会算”    “源码顺序是幻想”    “先后也未必看得见”
```

下一讲将正面回答本讲留下的问题：怎样用**互斥**阻止危险操作并发发生，把关键片段重新变成可按顺序理解的程序。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 从长时间系统调用和 SMP/NUMA 两个角度解释为什么需要线程；
- 用状态机描述线程，并区分进程、线程、并发和并行；
- 说明教学接口 `spawn(fn)`、`join()` 与 POSIX threads、Linux 内核机制分别处在哪一层；
- 亲手观察线程共享全局/堆内存却拥有不同寄存器、PC 和栈；
- 用交错执行解释支付宝双重支付和计数器丢失更新；
- 说明为什么上述解释只是 SimpleC 教学模型，而含数据竞争的 C/C++ 程序可能直接具有 undefined behavior；
- 区分语言内存模型、编译器优化、ISA 内存模型和 CPU 微体系结构；
- 解释 `while (!flag);` 为什么可能永不重新读内存，以及 `volatile` 为什么不是线程同步；
- 推导 store-buffering litmus test 中 `(0, 0)` 的含义；
- 使用仓库中的 `race_counter` 对比数据竞争、原子操作和互斥锁；
- 理解为什么“缓存一致”不等于“所有线程看见同一个全局指令顺序”。

问题地图：

| 问题 | 最小答案 | 本章证据 |
| --- | --- | --- |
| 一个线程阻塞在 `read`，进程一定完全停住吗？ | 不一定；调度器可运行同进程的其他线程 | §2.1 |
| 并发一定需要两个 CPU 吗？ | 不需要，单核轮流执行也能并发 | §4 |
| 线程的栈是“私有内存”吗？ | 地址范围通常独立，但仍在同一地址空间，可经指针共享 | §5.3、实验 1 |
| `sum++` 是一条原子操作吗？ | C 表达式不是硬件原子性承诺，通常经历读—改—写 | §8 |
| 数据竞争只会让答案偏小吗？ | 不是；在 C/C++ 中通常是 UB，任何单纯交错解释都不完整 | §7.3、§11 |
| `volatile` 能修复等待旗标吗？ | 不能；它既不提供原子性，也不建立 happens-before | §12 |
| cache coherence 是否保证顺序一致性？ | 不保证；它主要约束单个地址，不给所有地址一个总顺序 | §15 |

## 2. 共享内存并发的动机

### 2.1 动机一：系统调用可能执行很久

下面是讲义中的示意代码，不是可直接编译的完整服务器：

```c
void http_server(int fd) {
  while (1) {
    char *buf = alloc_buf();
    ssize_t nread = read(fd, buf, 1024);  // 可能等待网络数据
    handle_request(buf, nread);
  }
}
```

同步 `read` 没有数据时，**调用它的执行流**要等待。若整个服务只有这一条执行流，CPU 此时无法替该程序处理另一个已经到达的请求。最直接的想法是准备多个执行流：一个等待 I/O 时，另一个继续执行 `handle_request`。

线程不是唯一答案。事件循环、非阻塞 I/O、`epoll`、异步运行时和多进程都能隐藏等待。但线程有一个诱人的性质：回调、连接表、缓存和统计信息仍可以用普通指针访问，不需要主动序列化成进程间消息。

这里要分清阻塞层次：

- `read(2)` 是系统调用；阻塞的是调用线程，内核调度器可以选择其他可运行线程；
- libc 的 `fread(3)` 是带缓冲的库接口，它可能先在用户态满足请求，也可能最终调用 `read`；
- 若线程持锁后再做长时间 I/O，其他线程可能因那把锁而间接全部停住；这不是 `read` 自动造成的。

### 2.2 动机二：SMP 已经提供共享内存，不用白不用

现代多核机器通常以 symmetric multiprocessing（SMP）模型呈现：多个处理器都能装载和存储同一个虚拟地址空间中的数据。`fork()` 得到的两个进程最初常通过 copy-on-write 共享物理页，但语义上各自拥有独立地址空间；一方普通写内存后，另一方不能直接用原地址看到变化。进程间共享需要显式使用共享映射、管道、socket 等机制。

线程反过来选择“默认共享”：代码段、全局变量、堆和大部分进程资源属于同一地址空间。这样能以最低表面成本利用多个核，却也把任何普通指针都变成潜在的通信通道。

NUMA 没有推翻这个模型。不同 CPU 访问本地与远端内存的延迟和带宽不相同，但操作系统和硬件仍尽力维持一个共享地址空间。于是共享内存既是历史选择，也是兼容性承诺；大量软件建立其上后，很难再“下车”。

## 3. 实现共享内存的“进程”：给状态机加一维

### 3.1 从 SimpleC 单线程模型出发

此前可以把 C 程序简化为状态机：

```text
初始状态：main(argc, argv, envp) 开始时的寄存器和内存
状态迁移：执行一条语句（进一步可细化为一条指令）
              s' = f(s)
```

现在把状态写成：

```text
S = (M, T0, T1, ..., Tn)
M  = 共享内存
Ti = (PCi, registers_i, stack_i, thread-local state_i)
```

`spawn(fn)` 向状态中加入一个从 `fn` 开始的新 `Ti`。最简单的并发迁移规则是每一步任选一个尚未结束的线程，让它执行一条语句：

```text
S --choose i--> step(Ti, M)
```

只加这一条规则，就已经得到共享内存并发的核心：线程有独立的控制流、寄存器和栈，却通过 `M` 互相影响。

### 3.2 “独立栈”不等于受保护的私有地址空间

每个线程需要独立栈，否则两个函数调用会覆盖彼此的返回地址和局部变量。可是这些栈都映射在同一个进程地址空间中：

- 默认情况下，每个线程只沿自己的栈指针使用自己的栈区；
- 若把局部变量地址发布给另一个线程，另一个线程可以读写它；
- 发布者返回后，指针会悬空，这和单线程栈对象生命周期错误一样危险，只是更难复现；
- 栈大小、guard page 和放置位置是线程库/操作系统实现细节，不应靠猜固定地址。

所以“独立”描述的是正常调用约定与资源分配，不是页表隔离。

### 3.3 最小模型已经够用，也已经打开魔鬼的盒子

任选线程执行一步看似简单，但“任选”使同一初始状态对应许多可能轨迹。真正并行、编译器优化和 CPU 缓存随后还会让“一步”的定义本身失效。本讲后面的三次“放弃”，就是依次拆掉这三个过度理想化的假设。

## 4. 概念辨析：并发不等于并行

**并发（concurrency）**是逻辑上有多个未完成的执行流，它们的生命周期重叠。单核 CPU 可以在它们之间切换，形成交错执行；并发关注的是程序结构和可能的事件次序。

**并行（parallelism）**是真有多个处理器在同一物理时间推进工作。共享内存多处理器可以让两个线程同时执行 load/store；并行关注的是计算资源和速度。

| 情形 | 并发 | 并行 |
| --- | --- | --- |
| 单核上两个线程时间片轮转 | 是 | 否 |
| 两核各运行一个线程 | 是 | 是 |
| 单线程程序由乱序 CPU 同时执行多条微操作 | 源语言层面否 | 指令内部有并行，但通常不称线程并行 |
| 两个进程通过消息交互 | 是 | 可能是；不要求共享内存 |

SimpleC 的“每次选一个线程走一步”能描述并发交错。若粗略表示并行，可以想象每个在核上的线程同时推进一部分指令；但真实指令延迟不同，load 可能等待 cache miss，一条指令也会拆成多个内部阶段。因此“所有线程每拍各执行一条语句”仍然只是教学图景。

并行不是自动出现的。线程可能被调度到同一个核、机器可能只有一个可用 CPU、容器/作业系统可能限制 CPU 配额，锁和 I/O 也可能让任一时刻只有一个线程可运行。观察 CPU affinity、`sched_getcpu()` 或性能计数器，才是在特定一次运行中判断并行的证据。

## 5. 迷你线程库：`spawn` 与 `join`

### 5.1 教学 API 的语义

讲义把 POSIX threads 做了减法，得到只适合理解概念的 `thread.h`：

```c
void spawn(void (*fn)(int tid));  // 创建线程，tid 从 1 编号并立即开始运行
void join(void);                  // 等待已经创建的所有线程结束
```

`spawn(fn)` 的关键不是函数调用，而是“调用者尚未返回，`fn` 已可能在另一个核运行”。`join()` 则建立结束边界：它返回后，目标线程已经结束，加入者可以消费其最终结果。讲义实现还让 `main` 返回时默认等待全部线程，用来减少演示样板代码。

把 `join` 写成下面的循环只是在说明条件，不能当作可靠实现：

```c
// 教学伪代码；不是推荐实现。
while (num_done != num_threads) {
  ;
}
```

它会忙等、浪费 CPU；若变量不是正确的原子对象或没有同步，编译器甚至可以不重复装载它。真实线程库会把等待线程停放，并在目标结束时唤醒它。

### 5.2 API、libc 和内核不要混成一层

`spawn` 不是标准 C/POSIX API，也不是 Linux 系统调用；它是课程封装。实际层次大致是：

```text
课程 thread.h: spawn/join
        ↓ 封装
POSIX libc: pthread_create/pthread_join
        ↓ 常见 Linux 实现
clone/clone3 创建共享地址空间的 task；futex 等机制等待和唤醒
        ↓
内核调度实体、地址空间和 CPU
```

具体使用哪个内核入口是 libc 与内核版本的实现细节。程序应依赖 `pthread_*` 合同，而不是假定每次 `pthread_create` 必然出现某个固定的 `strace` 文本。

线程创建和回收也不仅管理生命周期，还提供同步边界：创建前正确发布的数据应能被新线程看到；成功 join 后，结束线程在同步规则内完成的写入应能被加入者看到。不要用一个普通共享布尔量自行仿造这些边界。

### 5.3 “证明共享内存”的演示及其边界

讲义用两个线程分别递增全局 `x`、`y`，主线程不断打印它们。屏幕上的变化直观表明三个控制流指向同一组全局地址；不同递增频率也让线程更易分辨。

但从现代 C 语义看，这段程序只能算**故意错误的课堂反例**：多个线程无同步地读写普通 `int` 构成 data race，行为未定义；`x++` 本身也不是原子操作。它能帮助形成“地址空间共享”的直觉，却不是形式证明，更不能复制进生产代码。

真实线程还共享堆、映射和文件描述符表等进程资源；线程各自拥有 PC、通用寄存器、栈、线程局部存储和部分调度/信号状态。哪些属性共享由 POSIX 和具体系统定义，不能用“线程共享一切”一言以蔽之。

### 5.4 用 GDB 回答线程问题

GDB 常用命令：

```gdb
info threads
thread 3
bt
thread apply all bt
thread apply all p/x $sp
set scheduler-locking step
```

`info threads` 列出调试器看到的线程；`thread apply all p/x $sp` 可比较各自栈指针；`set scheduler-locking step` 在单步时尽量只让当前线程推进，便于观察局部轨迹。它不会把程序变成顺序程序，也不会消除真实竞争；断点、日志和调试器本身还会改变时序，经典的“加日志后 bug 消失”正由此而来。

### 实验 1：运行 `race_counter`，再查看线程和栈

仓库已有完整例子 [examples/race_counter.c](../../examples/race_counter.c)。在仓库根目录运行：

```bash
make -C examples race_counter

for mode in race atomic mutex; do
  for run in 1 2 3; do
    ./examples/race_counter "$mode"
  done
done
```

每次共有 4 个线程、每线程递增 200000 次，所以目标值是 800000。

- `race` 模式把计数器声明为 `volatile`，并故意把递增拆成 load—yield—store；它通常小于目标值且每次不同。这里的 `volatile` 只是让实验更容易看见访存，**没有修复 C 数据竞争**，整个模式仍是明确的反例；不能把某个输出当成标准保证。
- `atomic` 使用 `_Atomic` 与 `atomic_fetch_add_explicit(..., memory_order_relaxed)`；每个递增不可分割，因此结果应为 800000。`relaxed` 不给其他数据排序，但足够保护这个独立计数器。
- `mutex` 把读—改—写放进互斥区，结果也应为 800000。它为下一讲提供目标行为，本章暂不实现锁。

再用 GDB 查看执行实体：

```bash
gdb -q ./examples/race_counter
(gdb) break run_racy
(gdb) run race
(gdb) info threads
(gdb) thread apply all p/x $sp
(gdb) thread apply all bt
```

预期能看见多个线程和不同的 `$sp`。有些线程可能还未到断点，具体停在哪一行也会变化，这正是调度不确定性的现场证据。若编译器优化使局部变量难以观察，可临时用 `make -C examples clean` 后以 `CFLAGS='-std=c11 -O0 -g -Wall -Wextra -Wpedantic -D_GNU_SOURCE' make -C examples race_counter` 重建；清理会删除 examples 的构建产物，请勿在有需保留产物时照抄。

## 6. 放弃之一：状态迁移不再唯一

### 6.1 数学与顺序程序中的确定性

数学函数 `f: X → Y` 对同一个输入给出唯一输出。SimpleC 或 NEMU 的单步迁移也可写成确定函数：

```text
s' = f(s)
```

给定完整初始状态，顺序程序会经过同一条状态轨迹。这种可复现性给人“可控”的感觉，也是纯函数和 functional programming 易于局部推理的重要原因。

现实程序的输入状态本来就不完全固定：`argv`、`envp`、auxv 会变，`read`、`getpid` 等系统调用依赖外部世界，`rdrand`、`rdtsc` 等特殊指令也带入环境或时间。但在固定这些输入后，普通算术和访存仍容易想象成一条确定轨迹。

### 6.2 共享内存把迁移变成“关系”

有多个线程后，下一状态取决于调度器选择谁：

```text
Next(S) = { step(Ti, M) | Ti 当前可运行 }
```

同一初始状态不再只有一个后继。线程速度没有语义保证：一次 load 之前，另一个线程的 store 可能已经发生，也可能还没有。并行机器上还可能真在同一时间推进。程序语义更像“允许的执行集合”，而不是唯一轨迹。

这里还埋着重要限定：上述集合是教学状态机的集合。C/C++ 对普通对象的数据竞争通常定义为 undefined behavior，编译器无需保留我们脑中的所有交错。只有使用原子对象和同步原语建立合同后，讨论“允许哪些执行”才是语言层面可靠的。

## 7. 支付宝例子：检查与修改之间藏着另一条执行流

### 7.1 单线程看似正确的代码

```c
// 反例：balance 被多个线程无同步访问时具有数据竞争。
unsigned int balance = 100;

int alipay_withdraw(unsigned int amount) {
  if (balance >= amount) {
    balance -= amount;
    return SUCCESS;
  }
  return FAIL;
}
```

顺序执行两次 `withdraw(100)`，第一次成功并把余额改成 0，第二次失败。这一推理暗中假定了“检查余额”和“扣款”组成不可被插入的整体。

### 7.2 两个线程都成功的交错

把代码展开为教学模型中的 load/check/store：

| 时刻 | 线程 A | 线程 B | `balance` |
| --- | --- | --- | ---: |
| 1 | 读到 100，检查通过 |  | 100 |
| 2 |  | 读到 100，检查通过 | 100 |
| 3 | 写回 `100 - 100 = 0`，返回成功 |  | 0 |
| 4 |  | 根据旧快照写回 0，返回成功 | 0 |

最终账面余额仍是 0，却发出了两份价值 100 的支付结果。错误不是一个整数“变负”，而是跨变量、跨外部动作的不变量被破坏：余额扣减与“成功”效果没有原子地提交。

真实支付系统还涉及数据库事务、幂等键、日志、跨服务消息和故障恢复；一把进程内 mutex 也无法独自解决跨机器一致性。讲义借 Mt. Gox 650,000 BTC 的损失规模和 Diablo I 物品复制 bug 强调：漏洞不会因为代码短而手下留情。这里应把它们理解为风险尺度与同类“重复效果”案例，不应据此断言某一历史事件的唯一根因就是这几行代码。

### 7.3 两种语义必须同时记住

- **SimpleC 交错模型**解释了 check-then-act 为什么从算法上不原子；
- **C/C++ 语言模型**进一步说，无同步地并发访问普通 `balance` 且至少一次写入是 data race，程序具有 UB；
- **正确版本**需要语言认可的同步，并且保护完整业务不变量，而不只是把单次 load/store 换成原子指令。

这三层不能互相替代。原子地读取余额后再原子地写回，也未必让“检查并扣款”整体原子；这是下一讲互斥要解决的最小问题。

## 8. 于是，`1 + 1` 都不会算了

### 8.1 `sum++` 不是不可分割的数学加法

讲义中的求和程序让两个线程各执行 `N` 次 `sum++`，希望结果是 `2N`。在 SimpleC 模型中，一次递增至少可拆成：

```text
t = load(sum)
t = t + 1
store(sum, t)
```

若 A、B 都读到 0，随后都写 1，两次递增只留下 1。这叫 lost update。即使目标 ISA 恰好有一条内存加法指令，普通 C 的 `sum++` 也没有因此自动获得跨线程原子合同；编译器可选择其他指令序列，硬件指令本身也未必带原子锁定语义。

课程迷你库提供 `mutex_lock`/`mutex_unlock` 后，可以把递增围住，使同一时刻只有一个线程执行读—改—写。那是下一讲的主题。另一条窄路是对独立计数器使用 `_Atomic` 的 fetch-add；但原子计数器并不自动保护更大的复合不变量。

### 8.2 三个线程各加三次，最小值是多少？

先严格限定为讲义的玩具模型：每次 load 和 store 原子，局部计算不影响共享内存，且忽略 C 数据竞争 UB。三个线程各做三次，最终值的最小值是 **2**，不是 1。

下界理由：最后一次共享事件必是某线程第三轮的 store。第三轮 load 发生前，该线程已经完成前两轮 store；所有 store 写入的值至少为 1，初值 0 此后不会再被写回。因此第三轮 load 至少读到 1，最后 store 至少写 2。

`2` 也可达到。用 A1 表示 A 的第一轮：

```text
A1: load 0，暂不 store
B1: load 0，暂不 store
C1: load 0, store 1
C2: load 1, store 2
A1: store 1                 # 用旧值把结果拉低
C3: load 1，暂不 store 2
A2, A3 完成
B1: store 1；B2, B3 完成
C3: 最后 store 2
```

这个小问题已经需要同时满足每个线程的程序顺序和所有读写约束。一般的 trace recovery——从部分观测恢复可行并发轨迹——在相应模型中可达 NP-complete；[论文链接](https://epubs.siam.org/doi/10.1137/S0097539794279614)说明这不是“多想一会儿”就能稳定解决的问题。讲义记录的 2025/2026 模型答题榜和 [vibe code 游戏](https://jyywiki.cn/OS/2026/vsc.html)是课堂时代注脚：模型能力会变，组合爆炸本身不会消失。

## 9. 丧失确定性的系统性后果

### 9.1 早期软件互斥并不容易

1960 年代的研究者尝试只靠共享变量实现互斥，许多直觉方案都在某种交错下失败。Dekker 算法是著名的两线程软件互斥方案；即使在它适用的顺序一致性假设下，证明也远比代码长度复杂，而且只直接处理两个线程。Peterson 算法等后续方案同样提醒我们：短代码不等于容易验证，放到宽松内存机器上还需额外的原子与排序保证。

![Peterson 相关课堂插图](../../sources/site_html/static/img/peterson.jpg)

这段历史的结论不是要求业务程序手搓 Dekker，而是相反：使用语言和线程库提供的原子、mutex、condition variable 等受支持原语，并明确其内存序合同。

### 9.2 libc 也被并发改变

`printf` 有用户态 `FILE` 缓冲。若两个线程真的裸执行 `buf[pos++] = ch`，缓冲位置和内容都会损坏。因此线程出现后，libc 必须重新审视几乎所有带状态的 API：

- stdio 实现通常给 `FILE` 加内部锁，使单次库调用不会破坏自身结构；
- 这不保证多个 `printf` 调用构成一个不可插入的“事务”，输出仍可能按调用粒度交错；
- `errno` 通常成为 thread-local 状态，否则一个线程会覆盖另一个线程的错误码；
- 一些旧 API 使用静态内部缓冲区，因而出现 `_r` 变体或新的重入接口；
- `malloc/free`、动态加载器和 locale 等全局设施也需要并发控制。

可用 `man 3 printf` 与 `man 7 attributes` 查看具体 libc 对线程安全属性的承诺。不要从“某次运行输出没乱”推导出 API 天然线程安全，也不要给一个本来已有内部锁的函数再虚构实现细节。

## 10. 放弃之二：源码顺序只是 SimpleC 的幻想

### 10.1 一个解释器可以忠实，生产编译器必须激进

原则上可以写一个 fully functional 的 SimpleC 解释器，用 FFI 承接系统调用和外部库，然后严格按源码语句推进任何程序。它会很适合展示语义，却很难给出现代系统追求的极致性能。

编译器的任务并非逐句翻译，而是在语言允许的可观察行为范围内重写程序：inline、constant propagation、common-subexpression elimination、loop transformation、dead-code elimination 等都会改变指令数量和次序。Frances Allen 因编译器优化领域的奠基贡献获得 2006 年图灵奖；这条历史线说明，源码与机器执行之间巨大的优化空间正是计算机性能的重要来源。

所谓“语义等价”从来不是“保留程序员脑中的每次中间访存”。它相对于**语言标准定义的可观察行为**成立。若程序通过普通数据竞争试图观察另一个线程的中间写入，C/C++ 已不再承诺那种行为，优化器无需迎合这种私下协议。

### 10.2 一个聪明但错误的等待

```c
// 反例：另一个线程写普通 flag 会形成 data race。
while (!flag) {
  ;
}
```

程序员想的是“每轮都从共享内存读 `flag`”。对单线程语义，循环体不修改 `flag`，也没有可见调用；编译器可能只装载一次：若为 0 就跳进永久循环。即使碰巧每轮都生成 load，多核 CPU 也没有因普通 load 自动建立跨线程同步。

这是一种 ad hoc synchronization：拿普通变量、时间延迟或“机器一般会这样”当同步协议。[Ad hoc synchronization considered harmful](https://www.usenix.org/conference/osdi10/ad-hoc-synchronization-considered-harmful)指出了这类模式的普遍风险。

正确的低级表达至少要让旗标成为 `_Atomic`，写方用 release、读方用 acquire 等匹配内存序；若等待可能较久，mutex + condition variable 通常比持续自旋更合适。选择哪一种取决于协议和性能测量，不能靠给变量随手加 `volatile`。

### 10.3 求和再次出现：`-O1` 和 `-O2` 为何能像两个程序

对单线程，循环：

```c
for (int i = 0; i < N; i++) {
  sum++;
}
```

可以合法改写为近似的 `sum += N`。若两个线程竞争普通 `sum`，原程序已经 UB；某个工具链/版本上，讲义观察到 `-O1` 常得到 `N`、`-O2` 常得到 `2N`。一种直观解释是：优化后每个线程只剩一次大更新，两个大更新是覆盖还是先后接力，取决于生成代码和调度。

这些数字是**一次编译与运行的观察，不是优化级别的规范**。换编译器、版本、ISA 或时序，结果都可不同。唯一稳固的结论是：不能用含数据竞争的程序反推编译器必须保留哪条源码级交错。

### 实验 2：让汇编暴露 plain、`volatile` 和 `_Atomic` 的差别

这个实验只检查编译结果，不运行有数据竞争的 plain/volatile 版本：

```bash
optdir=$(mktemp -d) || exit 1
[ -n "$optdir" ] && [ -d "$optdir" ] || exit 1
cat >"$optdir/spin.c" <<'EOF'
#include <stdatomic.h>

int plain_flag;
volatile int volatile_flag;
_Atomic int atomic_flag_value;

void wait_plain(void) {
  while (!plain_flag) { }
}

void wait_volatile(void) {
  while (!volatile_flag) { }
}

void wait_atomic(void) {
  while (!atomic_load_explicit(&atomic_flag_value, memory_order_acquire)) { }
}
EOF

cc -std=c11 -O2 -S -fverbose-asm "$optdir/spin.c" -o "$optdir/spin.s"
sed -n '/wait_plain:/,/^\s*\.size\s*wait_plain/p' "$optdir/spin.s"
sed -n '/wait_volatile:/,/^\s*\.size\s*wait_volatile/p' "$optdir/spin.s"
sed -n '/wait_atomic:/,/^\s*\.size\s*wait_atomic/p' "$optdir/spin.s"
```

不同编译器的汇编格式会变；若 `sed` 范围没有匹配，可直接运行 `less "$optdir/spin.s"` 搜索函数名。典型现象是：

- `wait_plain` 把 load 提到循环外，循环内部不再读内存；
- `wait_volatile` 保留重复 load，但仍没有原子性或跨线程 happens-before；
- `wait_atomic` 也保留语言要求的原子 load，并带 acquire 语义。

在 x86-64 上，acquire atomic load 可能仍只是普通 `mov`，因为 ISA 已为该方向提供足够顺序；在 AArch64 上可能看到带 acquire 语义的加载指令。**指令看起来普通不等于源语言没有合同**：编译器禁止的重排和 ISA 本身保证也属于实现的一部分。

## 11. 控制优化的两个“土办法”为何不够

讲义列出两个常见尝试：

```c
// 方法 1：GCC/Clang 扩展的 compiler barrier
while (!flag) {
  __asm__ volatile ("" ::: "memory");
}

// 方法 2：volatile
volatile int flag;
while (!flag) {
  ;
}
```

空 asm 加 `"memory"` clobber 会限制编译器把内存操作越过该点移动，但它通常不发出 CPU fence，不使普通访问原子化，也不替 C 数据竞争定义语义。`volatile` 要求实现保留相应的 volatile 访问，适用于设备寄存器、与信号处理器交互的受限情形等；它同样不是互斥、原子或线程间发布协议。

因此课程建议“Don’t play with shared memory”不是说永远不能共享，而是不要用未写进语言/库合同的技巧猜测编译器和 CPU。先用 mutex、condition variable、channel、任务图等高层机制建立清晰边界；只有在 critical path 确有需要且能验证时，才选择合适的原子内存序。

## 12. 放弃之三：CPU 也在做第二层“编译”

### 12.1 第一层：`.c → .s`

编译器根据语言内存模型进行静态重写：删除死代码、合并循环、缓存变量、调整独立语句的先后。同步原语和原子内存序会限制这种自由；数据竞争程序则主动放弃了标准保护。

### 12.2 第二层：`.s → CPU 内部状态`

现代处理器不会等上一条指令从取指一直完成写回才开始下一条。它会取入多条指令，重命名寄存器，分析依赖，把微操作发送到不同执行单元，推测分支，并让长延迟 cache miss 与其他工作重叠。可以把它比作一个 on-the-fly 的动态“编译器”。

这个比喻需要边界：CPU 不能任意破坏 ISA 对**单线程架构状态**的承诺，异常和最终提交也受精确定义约束。但另一个核何时看见 store、一个 load 是否先于更早 store 对外生效，由 ISA memory model 规定；微体系结构可用 store buffer、invalidate queue、cache 等机制实现允许的范围。

![SimpleC 的单步幻想](../../sources/site_html/static/img/sc.jpg)

所以两层合同应分开审计：

```text
C/C++ 源程序
  │  语言内存模型：data race、atomic、happens-before
  ▼
编译器生成的 ISA 指令
  │  ISA 内存模型：x86 TSO、Arm/RISC-V 的较弱顺序等
  ▼
CPU 微体系结构
     store buffer、cache coherence、乱序执行、推测
```

不能用 CPU fence 修复源语言 UB，也不能因源码用了 `_Atomic` 就假定每个 ISA 都生成同一条指令。

## 13. 宽松内存模型：缓存一致仍可观测到无序

### 13.1 一切为了性能

若每次 store 都必须等所有处理器立刻确认、每次 load 都必须等所有旧 store 全局可见，CPU 会频繁停顿。实现通常先把 store 放进本核的 store buffer/cache 层次，再通过一致性协议传播；load 在模型允许时可先读取当前可获得的值。

![宽松内存模型示意](../../sources/site_html/static/img/wmo.jpg)

“local memory”是帮助入门的说法，不应误解成每个核有互不一致的永久副本。cache coherence 通常保证对**同一 cache line/地址**的写最终传播，并为该地址建立一致次序；memory consistency 还要回答**不同地址**的操作怎样排序。前者成立，后者仍可比 sequential consistency 宽松。

### 13.2 Store-buffering litmus test

初始 `x = y = 0`，两个线程分别执行：

```text
T1: Store(x, 1); r1 = Load(y)
T2: Store(y, 1); r2 = Load(x)
```

若存在一个所有线程共同遵守、且保持各线程程序顺序的全局序列（sequential consistency），结果可以是：

| `r1` | `r2` | 一种解释 |
| ---: | ---: | --- |
| 0 | 1 | T1 的 load 早于 T2 的 store，T2 后来看见 x=1 |
| 1 | 0 | 对称情形 |
| 1 | 1 | 两个 store 都先全局可见 |
| 0 | 0 | **SC 下不可能**：会要求两个 load 都排在对方 store 前，与各自 store→load 顺序成环 |

在允许 store→load 被其他核观测为重排的模型中，两个 store 可以都暂留在各自 store buffer；随后两个 load 都从一致性系统读到对方地址的旧值 0，得到 `(0, 0)`。x86 的 TSO 已比许多 Arm/RISC-V 模型强，却仍允许这个经典结果；它既没有强到让普通共享内存像 SimpleC 一样好写，又为实现和跨 ISA 模拟带来约束。讲义以 Rosetta 2 和 Apple Silicon 的 TSO 能力为例，并链接了 [TSOEnabler](https://github.com/saagarjha/TSOEnabler)。

若把上面的 `x/y` 直接写成普通 C `int` 并跨线程读写，程序先在语言层触发 UB，实验就不能干净地证明硬件模型。硬件 litmus 应使用汇编或语言原子；下一实验选择 C11 relaxed atomics，让编译器保留操作而不额外要求一个全局顺序。

### 实验 3：用 C11 relaxed atomics 搜索 `(0, 0)`

依赖 Linux/POSIX threads 和支持 C11 atomics 的编译器：

```bash
litmusdir=$(mktemp -d) || exit 1
[ -n "$litmusdir" ] && [ -d "$litmusdir" ] || exit 1
cat >"$litmusdir/store-buffering.c" <<'EOF'
#define _XOPEN_SOURCE 700
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum { ITERS = 1000000 };

static _Atomic int x;
static _Atomic int y;
static int r1;
static int r2;
static pthread_barrier_t start_barrier;
static pthread_barrier_t finish_barrier;

static void barrier_wait_checked(pthread_barrier_t *barrier) {
  int rc = pthread_barrier_wait(barrier);
  if (rc != 0 && rc != PTHREAD_BARRIER_SERIAL_THREAD) {
    fprintf(stderr, "pthread_barrier_wait: %s\n", strerror(rc));
    abort();
  }
}

static void *thread_1(void *unused) {
  (void)unused;
  for (int i = 0; i < ITERS; i++) {
    barrier_wait_checked(&start_barrier);
    atomic_store_explicit(&x, 1, memory_order_relaxed);
    r1 = atomic_load_explicit(&y, memory_order_relaxed);
    barrier_wait_checked(&finish_barrier);
  }
  return NULL;
}

static void *thread_2(void *unused) {
  (void)unused;
  for (int i = 0; i < ITERS; i++) {
    barrier_wait_checked(&start_barrier);
    atomic_store_explicit(&y, 1, memory_order_relaxed);
    r2 = atomic_load_explicit(&x, memory_order_relaxed);
    barrier_wait_checked(&finish_barrier);
  }
  return NULL;
}

static void check_pthread(int rc, const char *what) {
  if (rc != 0) {
    fprintf(stderr, "%s: %s\n", what, strerror(rc));
    exit(EXIT_FAILURE);
  }
}

int main(void) {
  pthread_t t1;
  pthread_t t2;
  check_pthread(pthread_barrier_init(&start_barrier, NULL, 3),
                "pthread_barrier_init(start)");
  check_pthread(pthread_barrier_init(&finish_barrier, NULL, 3),
                "pthread_barrier_init(finish)");
  check_pthread(pthread_create(&t1, NULL, thread_1, NULL),
                "pthread_create(t1)");
  check_pthread(pthread_create(&t2, NULL, thread_2, NULL),
                "pthread_create(t2)");

  unsigned long both_zero = 0;
  for (int i = 0; i < ITERS; i++) {
    atomic_store_explicit(&x, 0, memory_order_relaxed);
    atomic_store_explicit(&y, 0, memory_order_relaxed);
    barrier_wait_checked(&start_barrier);
    barrier_wait_checked(&finish_barrier);
    if (r1 == 0 && r2 == 0) {
      both_zero++;
    }
  }

  check_pthread(pthread_join(t1, NULL), "pthread_join(t1)");
  check_pthread(pthread_join(t2, NULL), "pthread_join(t2)");
  check_pthread(pthread_barrier_destroy(&start_barrier),
                "pthread_barrier_destroy(start)");
  check_pthread(pthread_barrier_destroy(&finish_barrier),
                "pthread_barrier_destroy(finish)");
  printf("iterations=%d, observed (0,0)=%lu\n", ITERS, both_zero);
  return EXIT_SUCCESS;
}
EOF

cc -std=c11 -O2 -pthread "$litmusdir/store-buffering.c" \
  -o "$litmusdir/store-buffering"
"$litmusdir/store-buffering"
```

在有至少两个可并行 CPU 的许多 x86/Arm 机器上，重复足够多次可能观察到非零计数；虚拟机、单核配额、调度和具体 CPU 都会影响频率。**一次没有看到 `(0, 0)` 并不能证明它不允许**：测试只能发现执行，不能穷尽模型。屏障只负责把每一轮实验与主线程分隔开；被测试的 store/load 仍使用 `memory_order_relaxed`。

若把操作改为 `memory_order_seq_cst`，C11 要求这些原子操作进入单一的顺序一致次序，`(0, 0)` 应被排除。可以自行改动后重跑并查看汇编；不同 ISA 为满足合同会选择不同指令或 fence。

这类很短的程序称为 litmus test。系统研究者可以批量运行它们，观察哪些结果出现，从而验证或逆向推断平台内存模型；课程的[宽松内存模型演示](/OS/demos/concurrency/mem-model)承担的正是这个论证。

## 14. 三层语义的统一读法

遇到并发 bug 时，按下面顺序提问，能避免把所有怪现象都含糊称为“CPU 乱序”：

| 层次 | 应问的问题 | 典型错误 |
| --- | --- | --- |
| 算法/协议 | 哪些事件必须不可分割？谁必须先于谁？ | 支付检查与扣款分离、lost update |
| 语言/库 | 对象是否 atomic？是否有 data race？什么建立 happens-before？ | 用 plain/`volatile` 变量通信 |
| 编译器 | 在语言合同内可删除、合并或移动哪些操作？ | 假定源码每一轮都对应一次 load |
| ISA | 目标架构允许其他核观察到哪些顺序？需要何种 fence/原子指令？ | 把 x86 偶然经验搬到 Arm |
| 微体系结构 | store buffer、cache、推测怎样实现允许行为？ | 把 coherence 当 sequential consistency |

调度非确定性、编译器重写与硬件宽松顺序可以同时存在。正确同步的价值，是跨这些层建立一份可组合合同；它不要求程序员逐个预测调度器和 cache 的每一种内部状态。

## 15. 常见误区

### 15.1 “加了 `sleep`，先后顺序就固定了”

`sleep` 只让当前线程在一段时间内不运行，不建立所需的语言级 happens-before；唤醒延迟也没有精确保证。它可以放大或缩小竞态窗口，不能当同步。

### 15.2 “一个机器字的 load/store 天然线程安全”

硬件可能保证某些对齐访问不撕裂，但 C 对象仍需满足语言规则；不撕裂也只说明单次值完整，不会让 check-then-act 或 read-modify-write 原子。

### 15.3 “`volatile` 就是每次从内存读，所以够了”

即使实现真的每次发出 load，它也不提供线程间顺序、不保证原子读改写，且数据竞争仍可能 UB。正确工具是 `_Atomic` 或同步库。

### 15.4 “加一个 compiler barrier 就同时约束了 CPU”

空 asm 的 memory clobber 主要约束编译器；硬件 fence 是 ISA 指令，语言原子又是更高层合同。三者可能由编译器组合使用，但不能互相冒充。

### 15.5 “共享内存一定比消息传递快”

共享指针省掉显式序列化，却会引入 cache line 迁移、false sharing、锁竞争和复杂验证。性能由 workload 和访问模式决定；[parallel_sum](../../examples/parallel_sum.c) 用线程局部累加、最后归并，并用 cache-line 对齐减少 false sharing，正是“少共享”往往比“细粒度共享计数器”更好的例子。

### 15.6 “原子变量让整个业务自动正确”

原子只保证对那个原子对象及所选 memory order 的合同。支付宝的不变量跨检查、余额和外部支付效果；单个 atomic load/store 仍可能组合错误。

### 15.7 “一次压力测试没复现，所以程序正确”

调度、优化与硬件结果集合巨大。测试善于找到反例，不善于证明不存在反例；还需要 data-race detector、模型检查、代码审查和清晰同步设计。反过来，ThreadSanitizer 等工具的报告也要按其支持的语言/库模型解释。

## 16. “把刀递给程序员”的代价，以及 AI 时代的取舍

共享内存像 `malloc/free`、`open/close` 一样方便：能力直接、组合自由、critical path 可以做到很快。但自由也把配对、生命周期和并发协议交给程序员：

- 共享线程让 `1 + 1` 出错；
- 宽松内存让跨地址的 `1, 2, 3` 次序也难以直接观察；
- `malloc/free` 带来 use-after-free、double free 和并发回收问题；
- `open/close` 带来泄漏、复用和错误路径清理问题。

现代语言和框架常选择“没收一部分刀”：所有权类型、结构化并发、channel、任务图、RAII、垃圾回收和受控 executor，都在缩小非法程序空间。它们不是免费午餐，却把默认路径从“任意共享、自己证明”改成“先表达协议，必要时再逃生到底层”。

讲义对 AI 时代的判断是：AI 像“核动力牛马”，可以承担更多繁琐机械工作，因此接口未必还要为了少写几行而过度开放；只需保留 critical path 上获取极限性能的能力。无论代码由人还是 Agent 生成，验收标准不变：明确语言合同、跑反例实验、检查生成汇编，并用同步原语把允许行为压缩到可以理解的范围。

## 17. 小结：三次“放弃”，一个正确方向

本讲从应用生态自然走到线程：系统调用会等待，SMP/NUMA 又已经提供共享地址空间；把程序状态扩展成多个控制流，加上 `spawn` 和 `join`，就能表达并发并利用并行硬件。

困难来自三个逐层暴露的事实：

1. 调度选择使同一初始状态拥有多条执行轨迹；
2. 编译器只保持语言规定的语义，不保持数据竞争程序想象中的源码访存；
3. CPU 为性能实现宽松内存顺序，其他核的观察不必等于 SimpleC 的全局逐步顺序。

因此，可用的原则不是“背下所有交错”，而是先消灭未受约束的交错：让共享状态的数据竞争消失，用同步建立 happens-before，用少共享/局部归并降低协议复杂度。下一讲将从最基本的并发控制机制——互斥——开始，把危险代码段退回到一次只由一个线程执行的顺序世界。

## 18. 思考题

1. 单核机器上的两个线程为什么仍可能触发 lost update？画出最短交错。
2. 线程栈位于同一地址空间带来哪些用途和风险？将局部变量指针传给线程时，`join` 应放在哪里？
3. 在支付宝例子中，只把 `balance` 改成 `_Atomic unsigned`，但仍分别 load、判断、store，为什么不够？可以怎样定义真正需要的原子业务动作？
4. 三线程各递增三次的玩具模型中，找出一个最终值为 3、4 或 9 的轨迹；哪些结果可达？
5. 为什么 `memory_order_relaxed` 足够实现“最终准确的独立计数器”，却不够发布“计数器对应的数组内容已经准备好”？
6. 在实验 2 的目标 ISA 上，acquire load 生成了什么指令？这个结果由语言、编译器还是 ISA 的哪一层决定？
7. store-buffering 实验没有观察到 `(0, 0)` 时，你还需要什么证据才能声称该平台禁止它？
8. `parallel_sum` 为什么让每个线程先算局部结果再归并？比较它与每个元素都 atomic-add 到同一个计数器的 cache 流量。

## 19. 阅读材料

- *Operating Systems: Three Easy Pieces* 第 25 章：Dialogue on Concurrency；
- 第 26 章：Concurrency and Threads；
- 第 27 章：Thread API；
- Russ Cox, [Memory Models](https://research.swtch.com/mm)；
- GDB 手册：[Debugging Programs with Multiple Threads](https://sourceware.org/gdb/onlinedocs/gdb/Threads.html)。

## 20. PPT 内容覆盖表

| 原讲义标题/内容 | 本章对应位置 |
| --- | --- |
| Review: 从系统调用到应用生态 | §0 |
| 基于 OS API 的 libc、底层库、语言供应链和应用生态 | §0 |
| 系统调用隔离应用与 x86/AArch64/RISC-V | §0 |
| 共享内存的并发编程：动机 | §2.1–§2.2 |
| 共享内存动机 2：SMP、fork 隔离、NUMA | §2.2 |
| 实现共享内存“进程”、SimpleC 状态机扩展 | §3.1–§3.3 |
| 并发 vs. 并行及其概念模型 | §4 |
| 迷你线程库、`spawn(fn)`、`join()` | §5.1–§5.2 |
| “证明共享内存并发”的 `x/y` 演示 | §5.3 |
| 更多的问题 | §4、§5.3–§5.4 |
| [通过线程库理解线程行为](/OS/demos/concurrency/thread-examples) | §5.3–§5.4、实验 1 |
| 不确定性 (Non-determinism) 的魔鬼 | §6.1–§6.2 |
| 初始状态、系统调用、特殊指令与共享内存非确定性 | §6.1–§6.2 |
| 确定性的丧失：例子 | §7 |
| [山寨支付宝](/OS/demos/concurrency/alipay) | §7 |
| 于是，你发现 1 + 1 都不会求了…… | §8.1、实验 1 |
| [使用 mutex API 实现互斥](/OS/demos/concurrency/sum-mutexapi) | §8.1、实验 1（作为下一讲入口） |
| 失去确定性的后果 | §8.2 |
| 确定性的丧失：后果 | §9.1–§9.2 |
| 并发影响 libc 与 `printf` 缓冲 | §9.2 |
| SimpleC：幻想 v.s. 现实 | §10.1 |
| rewriting-based optimization 与确定性假设 | §10.1 |
| 一个聪明的例子 | §10.2、实验 2 |
| 求和在 `-O1/-O2` 下的不同观察 | §10.3 |
| 控制编译器优化的行为 | §11 |
| 放弃 (3)：`.c → .s` 与 `.s → CPU 内部状态` 两层编译 | §12 |
| SimpleC 并发模型的边界、Russ Cox Memory Models | §12、§19 |
| 宽松内存模型 (Relaxed Memory Model) | §13.1 |
| 观测 “无序” 带来的后果 | §13.2、实验 3 |
| 总结：“图方便，把刀直接递给程序员” 的过度开放机制 | §16 |
| Takeaways 与后续并发控制方向 | §17 |
| OSTEP 与延伸阅读 | §19 |
