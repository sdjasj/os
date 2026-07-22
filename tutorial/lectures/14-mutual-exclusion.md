# 第 14 讲：并发控制——互斥

> 原始讲义：[sources/notes/lect14.md](../../sources/notes/lect14.md)  
> 配套示例：[race_counter.c](../../examples/race_counter.c)、[mutex_transfer.c](../../examples/mutex_transfer.c)  
> 前一讲：[多处理器编程：从入门到放弃](13-multiprocessor.md)  
> 后一讲：[并发控制：同步与条件变量](15-condition-variables.md)  
> 关键词：race、critical section、mutex、Peterson、memory model、atomic RMW、spinlock、futex

## 0. 本讲定位：用局部“不并发”夺回可推理性

上一讲把程序扩展成了多个共享地址空间的线程。`spawn(fn)` 增加状态机，`join()` 等待它们结束；调度器可以任意交错线程，多核还可以真正同时执行指令。代价立刻显现：两个线程各做一次 `sum++`，最终值未必是 2；编译器重排、CPU 乱序执行和缓存可见性又使“按源码轮流走一步”的模型失真。

本讲采取一个看似退让、实则极其有效的策略：**对必须保持整体语义的代码禁止并发执行**。这就是互斥。我们先把它当 API 使用，再追问 API 如何成立：

```text
共享内存 + 任意交错
  → 同一把 mutex 圈出临界区
  → 临界区彼此串行，恢复局部的顺序推理
  → 纯 load/store 协议：理想模型可证明，现实实现却困难
  → 硬件原子读—改—写：制造极短的不可分割步骤
  → 短等待自旋，长等待借 futex 让内核阻塞线程
  → 下一讲：互斥只决定“谁能进”，同步还要表达“何时继续”
```

普通 UNIX 进程在 `fork`/`execve` 模型下默认不共享可写地址空间，但每个进程执行系统调用时都会进入同一个内核。内核还要同时处理多个 CPU、设备中断和共享对象。因此，操作系统本身正是第一个必须被认真对待的大型共享内存并发程序。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 把 `sum++` 展开成 load、add、store，并给出丢失更新的交错；
- 解释互斥、临界区、锁对象和受保护不变量之间的关系；
- 正确使用同一把 POSIX mutex 保护共享状态，理解 acquire/release；
- 说明单核内核为何可用“关中断”制造短暂 stop-the-world，以及它在多核和用户态为何失效；
- 识别不同线程用不同锁、漏解锁、锁粒度过细和生命周期不清等错误；
- 用 Amdahl、work/span 和局部性解释线程为何仍有价值；
- 用厕所、旗子和门牌复述 Peterson 协议，并在顺序一致模型下说明互斥为何成立；
- 区分模型检查的 safety 结论、调度公平性与现实 C/硬件内存模型；
- 区分 `volatile`、compiler barrier、memory fence、C 原子对象和原子 RMW；
- 说明 CAS、LL/SC 等硬件原语怎样实现自旋锁，以及自旋为何浪费处理器；
- 解释常见 `pthread_mutex_t` 的用户态快路径与 futex 内核慢路径；
- 设计固定总工作量、保留原始数据和误差的锁性能实验。

| 问题 | 最小机制 | 边界 |
| --- | --- | --- |
| 两次 `sum++` 为什么不是 2？ | 自增是 load—add—store，多步可交错 | 普通冲突访问在 C 中还可能是 data race/未定义行为 |
| 怎样恢复局部可推理性？ | 同一 mutex 使临界区互斥 | 只保护遵守协议的访问；先后顺序仍不确定 |
| 关中断为何不够？ | 单核上阻止中断驱动的切换 | 只影响本 CPU；用户态无权执行；多核仍并行 |
| Peterson 为何“纸上正确、直接写 C 却错”？ | 理想模型假设原子且按序的 load/store | 编译器、语言和硬件都不承诺这些假设 |
| 硬件应增加什么？ | atomic read-modify-write | 原子只覆盖短操作，不让全机长期停止 |
| 为什么不永远自旋？ | 短等待可省切换 | 长临界区、超额订阅、持有者被换出时浪费巨大 |
| mutex 是否每次 syscall？ | 用户态原子快路径 | 竞争时才用 futex wait/wake 进入内核 |

## 2. Review：从“1 + 1 不会算”到内核并发

### 2.1 最小线程模型已经足以制造错误

上一讲的教学线程库只留下 `spawn(fn)` 和 `join()`。即使不考虑多核，每一步任选一个线程的并发状态机也会产生海量轨迹。设 `sum = 0`，两个线程都执行一次 `sum++`：

```text
T0: r0 = load(sum); r0++; store(sum, r0)
T1: r1 = load(sum); r1++; store(sum, r1)

合法交错：T0 load 0 → T1 load 0 → T0 store 1 → T1 store 1
```

困难不是 CPU 不会加法，而是程序想把三步当成一个不可插入的整体，机器却没有收到这个要求。多核、编译优化和宽松内存模型只会扩大实际行为集合。

### 2.2 为什么操作系统课必须讲并发

典型进程各有私有地址空间，但系统调用会把多个进程带进同一份内核代码和内核数据：

```text
P1: read(fd, buf, size)  ─┐
                          ├→ 同一内核：文件偏移、缓存、inode、设备队列
P2: write(fd, buf, size) ─┘
```

再加上多核同时陷入内核、时钟和设备中断异步到达，内核必须处理真实并发。更新引用计数、空闲页链表或就绪队列时丢一次写，后果可能是内存破坏、数据丢失或系统崩溃。应用只想得到可靠的 `lock/unlock`；内核与运行库必须用中断控制、硬件原子操作、等待队列和调度兑现承诺。

## 3. 互斥：概念、API 与“1 + 1”

### 3.1 我们真正想向机器声明什么

理想语法可以写成：

```c
long sum = 0;
void T_sum(void) {
    make_it_work { sum++; }
}
```

要求是两个 `make_it_work` 块不能重叠；外界观察起来，每一块都像在某个瞬间完整发生。若语言允许把一段共享内存读写声明为事务，并保证成功提交时整体生效，我们实际上发明了 transactional memory。Intel TSX 的 `xbegin`/`xend` 是硬件事务内存的一种尝试；事务可能因冲突、容量、中断等原因 abort，真实程序还必须有重试或锁式 fallback。

本讲选择更普遍的 API：

```c
lock(&lk);
// critical section，例如 sum++
unlock(&lk);
```

互斥承诺：对于**同一个锁对象** `lk`，任一时刻至多一个线程已成功 `lock` 而尚未执行匹配的 `unlock`。这段区间称为临界区；成功获取锁的时刻可作为操作的线性化点之一。

### 3.2 包厢与桌上的钥匙

宿舍厕所包厢的门锁提供第一个类比：`lock/acquire` 是进入并锁门，别人进不来但持有者继续行动；`unlock/release` 是离开并开门。桌上一把钥匙提供第二个类比：有钥匙就拿走，没有就等待，释放时放回。

类比必须补三条计算机语义：

1. `unlock` 必须按 API 规则由持有者执行；
2. 锁不知道自己保护哪个变量，关联来自程序协议；
3. mutex 通常不承诺哪个等待者下次成功，互斥不等于公平。

### 3.3 多把钥匙：锁的身份决定是否互斥

```c
mutex_t lock_a = MUTEX_INIT();
mutex_t lock_b = MUTEX_INIT();

mutex_lock(&lock_a); x++; mutex_unlock(&lock_a);
mutex_lock(&lock_b); y++; mutex_unlock(&lock_b);
```

这允许独立的 `x`、`y` 并行。但若两个线程更新同一个 `sum`，它们必须拿同一把锁。锁不是源码花括号的装饰；判断临界区是否互斥的是锁对象身份，而不是函数名或代码外观。

```c
// 反例：两段代码没有被同一把锁保护。
T0: mutex_lock(&l); sum++; mutex_unlock(&l);
T1: mutex_lock(&I); sum++; mutex_unlock(&I);  // 大写 I，不是小写 l
```

两把锁都“正常工作”，race 仍存在。现实中它可能是几十把锁分布在十几个文件，一个新路径绕开既定协议。

### 3.4 “等价于 stop-the-world”的准确范围

假设所有冲突访问都拿同一把锁、释放前恢复完整不变量、没有释放后访问，且锁具有同步语义，那么分析临界区时，可想象其他会碰这份状态的线程暂时停止。临界区效果可按某个串行顺序解释。

但整个程序没有停止：无关代码、受不同锁保护的独立数据仍可并发；哪个临界区先执行也不确定；锁外的错误访问不会被锁感知。更精确地说，同一 mutex 上的 release/acquire 建立同步关系，使下一持有者看见上一临界区的内存效果。

## 4. 内核的最初办法：关中断

### 4.1 单处理器上的短暂 stop-the-world

在只有一个处理器、切换依赖可屏蔽中断的简化内核里：

```c
disable_interrupt();
sum++;
enable_interrupt();
```

关中断后，当前 CPU 不响应普通可屏蔽中断；若调度依赖时钟中断，当前代码就不会被线程抢占。代价同样直白：若关中断后进入 `while (1)`，时钟、键盘、磁盘和网络都可能长期得不到服务，只剩 watchdog、NMI 或 reset 等模型外路径。

![关中断失控时，reset 可能成为最后手段](../../sources/site_html/static/img/reset-button.jpg)

### 4.2 为什么应用不能靠 `cli`，多核也不能只靠本地开关

x86 的 `cli`/`sti` 受特权级控制。普通 Linux 进程执行 `cli` 通常触发 general-protection fault，最终被信号终止，而不是获得独占 CPU。课堂[尝试关闭中断 Demo](/OS/demos/concurrency/cli)展示的正是权限边界。不要在真实内核环境尝试“关中断死循环”；用户态失败已经足以验证 ISA 能力与进程权限的区别。

中断开关又是 per-CPU 状态。CPU 0 关中断时，CPU 1 仍可访问 `sum`。即使各 CPU 分别关本地中断，也没有自动建立“只有一核进入”的协议。现代内核会组合本地中断/抢占控制、原子指令、自旋锁和可睡眠 mutex；关中断只是单核概念起点。

## 5. 实验一：race、原子自增和 mutex 回答“1 + 1”

[race_counter.c](../../examples/race_counter.c) 提供三种模式：故意错误的普通 load/store、C11 原子加法和 pthread mutex。

```sh
gcc -std=c11 -O2 -Wall -Wextra -pthread \
  examples/race_counter.c -o /tmp/lect14-race

for mode in race race race atomic mutex; do
  /tmp/lect14-race "$mode"
done
```

一次典型观察是：

```text
mode=race expected=800000 actual=287508
mode=race expected=800000 actual=217504
mode=race expected=800000 actual=311958
mode=atomic expected=800000 actual=800000
mode=mutex expected=800000 actual=800000
```

race 数字会变，偶尔等于期望也不能证明正确。严格地说，普通并发冲突访问在 C 层构成 data race，行为未定义；`volatile` 只保留相应访问，不把自增变成原子操作，也不建立 happens-before。

`atomic` 的 `memory_order_relaxed` 足以保证这个单一计数器的修改原子性，但不替其他变量排序。mutex 可保护跨多个变量的不变量，通常成本更高。在 x86-64 上还可观察编译器选择的 locked instruction：

```sh
objdump -dr /tmp/lect14-race | grep -E 'lock|cmpxchg|xadd'
```

具体助记符取决于 ISA、编译器和优化；实验意在区分 C 原子语义、编译器代码生成与硬件执行三个层次。

## 6. 使用 mutex：API 很小，协议责任很大

### 6.1 POSIX API、退出路径与一把大锁

POSIX 常用 `PTHREAD_MUTEX_INITIALIZER`，或动态调用 `pthread_mutex_init/destroy`。`pthread_mutex_lock/unlock` 返回错误号本身，不应只读 `errno`。在 C 中，`return`、`goto`、错误分支和线程取消都可能绕过 `unlock`；C++ 常用 RAII，C 则应统一 cleanup 路径。

锁粒度是一组权衡：大锁协议集中、容易说明不变量，但会串行无关操作；每对象/每节点一锁提高潜在并行度，却增加锁序、生命周期和缓存开销。课程建议先用“一把大锁保平安”得到正确并经过压力测试的版本，再由测量驱动拆锁。“Premature optimization is the root of all evil”要求的是证据，不是禁止优化。

### 6.2 链表为何迅速变难

```c
struct node {
    lock_t lock;
    struct node *prev, *next;
};
```

遍历要回答读取 `next` 时谁保证它仍存活；先锁 next 再解 current 是否与反向遍历形成锁序环；插入/删除可能同时要 `prev/current/next` 三把锁。删除后“摘链”不等于无人持有指针，只有确认最后引用消失后才能回收，否则仍会 use-after-free。互斥保护访问区间，对象回收还要证明区间外没有悬空引用。

### 6.3 锁保护不变量，不只是某行写

账户转账的不变量是 `A.balance + B.balance == total`，应把“一个减、另一个加”整体保护。最好把协议写成可审计规则：

```text
所有 balance 读写持有对应 account.lock；
涉及多个账户时总按 account.id 递增顺序加锁；
总额守恒恢复后才释放最后一把锁。
```

“数据由哪把锁保护”“多锁按什么顺序拿”“对象何时仍存活”都应成为契约，而不是只在作者记忆里。

## 7. 实验二：转账不变量、两把锁与全局锁序

[mutex_transfer.c](../../examples/mutex_transfer.c) 创建两个账户和四个线程。每次随机转移 1–5 单位，并按账户 id 递增顺序取得两把锁：

```sh
gcc -std=c11 -O2 -Wall -Wextra -pthread \
  examples/mutex_transfer.c -o /tmp/lect14-transfer

for trial in 1 2 3 4 5; do
  /tmp/lect14-transfer
done
```

输出类似：

```text
A=1425 B=575 total=2000
A=731 B=1269 total=2000
```

余额分布不是 API 保证，调度使它变化；`total=2000` 才是规格。正确并发程序不必有唯一最终状态，但每个允许状态都要满足不变量。全局锁序消除了 ABBA 环：不论转账方向，线程都先拿 id 小的锁。若按 `from` 后 `to` 加锁，相反方向的转账可能各持一把、互等另一把；证明依赖所有路径始终服从同一严格顺序。

## 8. FAQ：临界区不并发，为什么还需要线程

### 8.1 Amdahl 的悲观上界

设单处理器总时间为 `T1`，不可并行部分占比 `s = 1/k`。忽略额外开销：

```text
Tp ≥ s·T1 + (1-s)·T1/p
T∞ ≥ s·T1 = T1/k
speedup∞ ≤ k
```

若 10% 工作必须串行，固定工作负载不可能单靠加核获得超过约 10 倍加速；锁竞争、缓存一致性和调度只会更差。大锁若包住 90% 工作，的确让线程失去大部分意义。

### 8.2 乐观面：work、span 与 Gustafson 的直觉

把程序看成有依赖边的工作图：`T1` 是全部工作量，`T∞` 是无限处理器下仍必须串行的最长路径（span）。对合适的贪心调度，可得到讲义公式的更精确形式：

```text
max(T1/p, T∞) ≤ Tp ≤ T∞ + (T1 - T∞)/p < T∞ + T1/p
```

只要任务分解使 `T∞ << T1`，少量临界区不会抹掉大量可并行工作。讲义将此与 Gustafson 的乐观视角相连：现实常随资源增加而处理更大数据集，让可并行部分增长，而不是固定一个小问题无限加核。

### 8.3 局部性与 embarrassingly parallel

经典物理中，一个区域影响远处需要传播时间；尽管[贝尔定理提醒我们这不是终极经典图景](https://plato.stanford.edu/entries/bell-theorem/)，局部相互作用仍是工程模拟的好近似。空间切块后，每个线程大部分时间处理本地粒子/网格，只在边界交换信息。

讲义给出的例子都体现独立工作远多于协调：图书馆与分布式数据存储、大脑与深度神经网络、NP-hard 搜索树的独立分支（包括前面见过的 fork-based DFS）。线程的价值不在每一行都并行，而在大部分工作并行，只把维护共享不变量的短路径串行化。

## 9. 纯软件互斥：从 Dekker 到 Peterson

### 9.1 先定义“正确”

双线程互斥协议至少要分别讨论：

- **Mutual exclusion（安全性）**：绝不同时处于临界区；
- **Progress（系统活性）**：有人请求且临界区空闲时，不会永远无人进入；
- **Bounded waiting / starvation freedom（个体活性）**：某线程请求后不会永远被插队；
- **假设**：load/store 是否原子、是否顺序一致、调度是否公平、线程会否崩溃。

一次运行没看到双入只说明暂未发现 safety bug，不证明未来没有，也不回答 starvation。

### 9.2 Dekker：旗子之外还要冲突裁决

Dekker 算法是最早的双线程纯软件互斥方案之一，讲义标注 1965。其[绕口令式描述](https://series1.github.io/blog/dekkers-algorithm/)是：对方不想进时自己可进；双方都想进时还要依据 `turn` 退让和重试。

只有两个 `want[]` 旗子不够：“先看对方没举旗，再举自己”会让双方同时看见空闲；“先举自己，再等对方放下”会让双方同时举旗后永久互等。`turn` 为同时请求提供破局规则。Dekker 的价值不是让人背代码，而是揭示协议需要“意愿”和“冲突裁决”两类状态。

1981 年，Gary Peterson 在 *[Myths about the Mutual Exclusion Problem](https://zoo.cs.yale.edu/classes/cs323/doc/Peterson.pdf)* 中给出更简洁的算法。它只面向两个参与者，却把协议压缩到两面旗和一个 `turn`。

### 9.3 Peterson 协议：手、旗子和厕所门牌

令 `me` 是自己，`other = 1 - me`。在顺序一致、原子 load/store 的理想模型中：

```c
want[me] = true;                  // 举起自己的旗子
turn = other;                     // 门上贴“对方优先”
while (want[other] && turn == other) {
    ;                             // 持续观察
}
critical_section();
want[me] = false;                 // 离开后放下旗子
```

拟人协议完整对应为：想进厕所先举旗；再贴写有对方名字的字条；反复看对方是否举旗、门上写谁；对方没举旗或门牌不再让对方优先时进入，否则继续观察；离开后放旗，不必清门牌。

![Peterson 协议把变量变成可推演的人、旗子和门牌](../../sources/site_html/static/img/bathroom-nju.jpg)

只有一人举旗时可直接进入。两人同时举旗时，最后写门牌的人让对方优先，自己等待；先写者看到门牌被覆盖成自己优先，因而进入。讲义的“手快有、手慢无”说的正是最后写 `turn` 的线程暂时失去进入权。

若 A 看见 B 没举旗，B 此刻不在临界区。B 也许下一步就请求，但会先举旗、再写 `turn=A`；只要 A 仍举旗，B 就等待。若 A 看见 B 已举旗，只能推知 B 已执行第一步，不能断定 B 已在厕所；所以还必须看 `turn`。旧门牌无需清除，因为 `want=false` 已表示退出竞争。

### 9.4 顺序一致模型下的互斥直观证明

反证两线程同时在临界区。它们自己的 `want` 均为 true，离开前不会清零。T0 在看到 T1 旗为 true 时通过，要求 `turn != 1`，即 `turn == 0`；对称地 T1 通过要求 `turn == 1`。同一个顺序一致状态的 `turn` 不可能同时为 0 和 1。

若某线程因看见对方旗为 false 而通过，对方随后请求时会先置旗，再把优先权让给已在竞争者，因而等待。论证依赖 load/store 不可分割且所有线程看到与程序序一致的全局次序；稍后会撤销这些假设。

活性还需要公平调度。若调度器永远不运行某线程，任何协议都不能让它前进。不能从 safety 证明偷换出公平性。

## 10. 模型检查：让电脑穷举，而不是凭字面猜

### 10.1 有限状态空间与可执行实验

教学模型可写成有限元组 `(want0, want1, turn, pc0, pc1, local-observations)`。每次选择一个线程执行下一原子动作，就得到一条状态边；遍历全部可达状态并检查 `pc0 == CS && pc1 == CS`，就是最小 safety model checker。2007 年图灵奖授予模型检查的奠基者 Edmund Clarke、E. Allen Emerson 和 Joseph Sifakis；课堂 [Mosaic](/OS/demos/mosaic) 用同一种“声明状态机—遍历空间”的方法澄清并发、虚拟化和持久化概念。

下面把两次 load 分成独立动作。`swapped=True` 交换“举旗”和“写门牌”的顺序：

```sh
python3 - <<'PY'
from collections import deque

def successors(s, swapped=False):
    flags, turn = list(s[0:2]), s[2]
    pcs = list(s[3:5])
    seen_flag, seen_turn = list(s[5:7]), list(s[7:9])
    for me in range(2):
        other = 1 - me
        f, pc = flags.copy(), pcs.copy()
        sf, st, t = seen_flag.copy(), seen_turn.copy(), turn
        if pc[me] == 0:
            if swapped: t = other
            else:       f[me] = True
            pc[me] = 1
        elif pc[me] == 1:
            if swapped: f[me] = True
            else:       t = other
            pc[me] = 2
        elif pc[me] == 2:
            sf[me] = f[other]
            pc[me] = 3
        elif pc[me] == 3:
            if not sf[me]: pc[me] = 5
            else:
                st[me] = t
                pc[me] = 4
        elif pc[me] == 4:
            pc[me] = 2 if st[me] == other else 5
        elif pc[me] == 5:
            f[me] = False
            pc[me] = 6
        else:
            continue
        yield tuple(f) + (t,) + tuple(pc) + tuple(sf) + tuple(st), me

def check(swapped=False):
    initial = (False, False, 0, 0, 0, False, False, 0, 0)
    todo, previous = deque([initial]), {initial: None}
    while todo:
        state = todo.popleft()
        if state[3] == state[4] == 5:
            trace = []
            while previous[state] is not None:
                old, who = previous[state]
                trace.append((who, state)); state = old
            return len(previous), list(reversed(trace))
        for nxt, who in successors(state, swapped):
            if nxt not in previous:
                previous[nxt] = (state, who)
                todo.append(nxt)
    return len(previous), None

for swapped in (False, True):
    count, trace = check(swapped)
    print(f"swapped={swapped}: states={count}, violation={trace is not None}")
    if trace:
        for who, state in trace: print(f"  T{who}: {state}")
PY
```

预期摘要：

```text
swapped=False: states=139, violation=False
swapped=True: states=125, violation=True
```

交换后，T1 可在 T0 举旗前看见 false 并进入；随后 T0 举旗，但门牌又使 T0 通过，最终双入。电脑不必“理解厕所”，只需忠实枚举规则。

### 10.2 证明范围、变体和“叛逆”的方法

搜索只覆盖两个线程、每个进入一次、顺序一致、每个建模动作瞬间完成。它证明模型内无 safety 反例，不是现实 C 程序万能证书。讲义提出的变体都可转成参数：先贴标签再举旗、离开前后清门牌、交换观察次序；“两人是否都不能进入”要查无进展环，“是否对一方不公平”还要定义公平调度并查 liveness。

归纳证明适用于无限状态空间，它通过不变量划分状态；本质仍在说明哪些状态可达、迁移是否保持性质。一般并发程序会状态爆炸，讲义以“n 个线程循环 m 次后，sum 最小究竟是 1、2 还是 3”强调字面猜测不可靠，相关轨迹/可达性问题可能 NP-complete 或更难；具体复杂度依程序、界限和内存模型而定，不能说所有并发问题都是 NP-complete。

所谓 Computer Science 的“叛逆”，不是拒绝严谨，而是把机械枚举交给模型检查器、SAT/SMT 和 AI，把人的精力放在更重要的问题：状态漏了什么？动作粒度是什么？检查 safety 还是 liveness？若把两次 load 错合成一次原子 guard，工具只会高速证明错误模型。正确流程是“提出可证伪性质—声明假设—自动搜索—把反例映射回实现—用真实实验校准”。

## 11. 模型不等于现实：正确 Peterson 与内存模型

### 11.1 理想证明的两项现实缺口

模型假设每个 load/store 瞬间完成且立即生效，并按源码顺序执行。编译器会删改、合并和重排普通访问；CPU 会使用 store buffer、缓存和乱序执行。更根本的是，C/C++ 规定普通对象上未同步的冲突访问是 data race，行为未定义。不能写出有 data race 的程序，再指望汇编 fence 修复语言层语义。

### 11.2 四种常混淆的机制

| 机制 | 承诺 | 不承诺 |
| --- | --- | --- |
| `volatile` | 相应访问是可观察动作，常用于 MMIO/特定 signal 场景 | 不使 `++` 原子，不建立线程同步 |
| `asm volatile("" ::: "memory")` | 阻止编译器把普通内存访问跨此点重排 | 通常不发硬件指令，不刷新缓存，不修复 data race |
| memory fence | 约束某些硬件内存操作的排序/可见性 | 不把 load+compute+store 合并成原子 RMW |
| C11 `_Atomic` + memory order | 对象原子性及指定语言级顺序 | 只作用于相应对象，复杂不变量仍需协议 |

讲义列出的 `__sync_synchronize()` 是 GCC 旧式全屏障 builtin，编译器可在 x86 发 `mfence`、ARM 发 `dmb ish`、RISC-V 发 `fence rw,rw` 或等效序列。必须修正一个易误读的速记：**屏障负责排序，不能凭空“实现单次 load/store 的原子性”**；宽度、对齐、原子类型和 ISA 共同决定原子性。`volatile` 也不是完整 compiler barrier。

### 11.3 用顺序一致 C 原子实现教学算法

```c
#include <stdatomic.h>
#include <stdbool.h>
static _Atomic bool want[2];
static _Atomic int turn;

static void peterson_lock(int me) {
    int other = 1 - me;
    atomic_store_explicit(&want[me], true, memory_order_seq_cst);
    atomic_store_explicit(&turn, other, memory_order_seq_cst);
    while (atomic_load_explicit(&want[other], memory_order_seq_cst) &&
           atomic_load_explicit(&turn, memory_order_seq_cst) == other) {
        /* busy wait；可加入体系结构 pause/yield hint */
    }
}
static void peterson_unlock(int me) {
    atomic_store_explicit(&want[me], false, memory_order_seq_cst);
}
```

正确范围仍是恰好两个 id 唯一的线程、都遵守协议、不在临界区崩溃，并按 C 原子语义编译。更弱的 memory order 必须重新证明。即使正确，它也只支持两线程、持续占 CPU、反复读共享缓存行，并需多个强序原子操作。课堂 [Peterson Demo](/OS/demos/concurrency/peterson) 的结论不是手写它替代 pthread mutex，而是普通 load/store 造工程锁既低效又难以正确。

### 11.4 算法路线为何转弯

Dekker/Peterson 是极好的模型、性质和证明训练，但系统需要跨多核、编译器和 ISA 复用的 “absolutely correct” 基座。机器规则由人制造；若普通 load/store 难以拼成互斥，可以修改 ISA，直接增加适合并发控制的原子操作。

## 12. 硬件原子指令：极短的不可分割窗口

### 12.1 从错误 `can_go` 推出所需指令

```c
// 反例：检查与修改之间可被插入。
void lock(void) {
retry:
    if (can_go == true) {
        can_go = false;
        return;
    }
    goto retry;
}
void unlock(void) { can_go = true; }
```

两个线程可同时读 true。我们只需让“读旧值—比较—有条件写新值”成为不可分割 RMW：`atomic_compare_exchange(can_go, true, false)`。只有一个线程成功，成功 CAS 是获取锁的线性化点；失败者重试，释放用 release 语义发布临界区写。

### 12.2 atomos 与各 ISA

希腊语 `atomos` 意为 indivisible：

- x86：`lock cmpxchg`、`xchg`、`lock add`；
- RISC-V A 扩展：LR/SC 与 AMO；
- MIPS：Load-Linked/Store-Conditional；
- ARM：`ldxr/stxr`，以及较新 LSE 的 `stadd` 等。

讲义称它“一小段时间 stop-the-world”，适合建立原子性直觉，却非现代实现的逐字描述。常见 x86 原子操作通过一致性协议独占目标缓存行；特殊未对齐、跨缓存行或特定内存类型才可能触发更重 bus lock。其他处理器仍能做不冲突工作。

```asm
movl $1, %eax
movl $0, %edx
lock cmpxchgl %edx, (can_go)
```

GCC `__atomic_compare_exchange_n` 可跨 ISA 选择实现；应用通常应优先用 C11 atomics 或验证过的库。ARMv8.1 等新增原子指令后，正确编译选项可自动使用更优实现。

![硬件原子指令让多处理器上的“1 + 1”重新成立](../../sources/site_html/static/img/80486-arch.jpg)

若只需独立计数器，`lock addq $1,(sum)` 或 `atomic_fetch_add` 可直接自增。但原子变量不是事务：账户转账、链表更新涉及多个位置，逐个原子修改仍可能暴露中间状态。

## 13. 自旋锁：最小实现与性能边界

### 13.1 教学用 C11 自旋锁

```c
#include <stdatomic.h>
typedef struct { atomic_flag held; } spinlock_t;
#define SPINLOCK_INIT { ATOMIC_FLAG_INIT }

static void spin_lock(spinlock_t *lk) {
    while (atomic_flag_test_and_set_explicit(&lk->held,
                                             memory_order_acquire)) {
        /* 可用平台 pause hint；仍占用 CPU。 */
    }
}
static void spin_unlock(spinlock_t *lk) {
    atomic_flag_clear_explicit(&lk->held, memory_order_release);
}
```

acquire 防止临界区访问跑到加锁前，release 保证写对下一持有者可见。课堂[硬件原子指令实现互斥 Demo](/OS/demos/concurrency/sum-spinlock)用 inline assembly/builtin 展示同一机制。上述实现没有公平、退避、NUMA 优化或调试支持，只适合教学。

### 13.2 “一核有难，八核围观”与持有者被换出

持锁线程执行时，其他核空转并争抢同一缓存行。短自旋仍可能有价值：若几百纳秒内释放，阻塞/唤醒可能更贵；关键是等待分布，不是“自旋一定坏”。

更糟的是应用持锁线程可能被换出。单核上 T0 持锁被抢占，T1 随后会用完整时间片自旋，等待当前无法运行的 T0；线程数超过 CPU 数时，多核也会放大浪费。应用无权关中断。内核自旋锁通常只保护非常短、不能睡眠的路径，并配合本地中断/抢占规则；内核能关中断不等于可无限持锁。

## 14. 线程等不动，就让操作系统帮忙

### 14.1 从“锁系统调用”到混合路径

可以想象两个系统调用：

```c
syscall(SYSCALL_acquire, &lk);  // 失败则阻塞并切换线程
syscall(SYSCALL_release, &lk);  // 释放并唤醒等待者
```

内核能把“检查失败—加入等待队列—阻塞”组织起来，并在释放时唤醒；内部仍用关本地中断、原子操作和短自旋保护调度队列。但若无竞争加锁也陷入内核，常见短临界区会承担不必要开销。绝大多数空闲锁可由用户态一条原子指令取得，只有竞争才需要调度。

### 14.2 futex：用户态快路径、内核慢路径

Linux futex（fast userspace mutex）让用户态在一个对齐整数上做原子状态转换，必要时才请求内核按该地址等待/唤醒。一种仅用于理解、并非固定 ABI 的编码是：

```text
0: unlocked
1: locked, no known waiters
2: locked, possibly has waiters
```

```text
lock:
  atomic 0→1 成功 ─────────────→ 直接进入（无 syscall）
        │失败
        ▼
  标记竞争 → futex(WAIT, expected) → 阻塞 → 唤醒后重试

unlock:
  release store/exchange
        │若可能有等待者
        ▼
  futex(WAKE, 1)
```

`FUTEX_WAIT` 的 expected-value 检查防止 lost wakeup：若释放恰好发生在用户检查与睡眠之间，内核发现 futex word 已改变，就不会睡下。唤醒也不等于直接转交所有权；线程通常还要重新竞争。

讲义说“实际上由一个系统调用实现”，应理解为 Linux 的 `futex(2)` 是多操作入口，并非每次 mutex lock 恰好执行一次 syscall。`pthread_mutex_lock` 是 libc/pthreads API，具体状态编码、自旋策略和 futex 使用属于实现细节。可继续读 `man 2 futex`、`man 7 futex`、LWN 的 [A futex overview and update](https://lwn.net/Articles/360699/) 和 Ulrich Drepper 的 [Futexes Are Tricky](https://cis.temple.edu/~giorgio/cis307/readings/futex.pdf)。

### 14.3 可选观察：追踪 futex 慢路径

在允许 `ptrace` 的 Linux 环境：

```sh
strace -f -e trace=futex /tmp/lect14-race mutex 2>&1 | head -n 30
strace -f -c -e trace=futex /tmp/lect14-race mutex
```

竞争足够强时通常能看到 `FUTEX_WAIT_PRIVATE`、`FUTEX_WAKE_PRIVATE`；线程创建/join 本身也可能使用 futex，不能把每行都归因于计数锁。无竞争锁可能全走用户态，所以没有 syscall 也是预期结果。容器若禁止 `ptrace`，`Operation not permitted` 只说明观察权限不足，不说明程序没用 futex。

## 15. 定量研究：锁到底有没有提升性能

### 15.1 控制变量，而不是只贴一次秒表

讲义建议固定总 `sum++` 数量 `N`，分到 `T = 1, 2, 4, 8, 16` 个线程，对自旋锁、pthread mutex 和原子加法各重复 5 次，记录每次操作平均时间：

```text
method,threads,trial,total_ops,elapsed_ns,ns_per_op,correct
atomic,1,1,64000000,...,...,true
mutex,1,1,64000000,...,...,true
spin,1,1,64000000,...,...,true
```

`correct` 必须先于性能。racy 版本即使快，也没完成相同语义；原子加法只维护单计数器，若任务需要多变量事务，它与 mutex 也不功能等价。

较可信的测量至少要：

1. 固定总操作数和临界区内容；
2. 记录 CPU、核/SMT/NUMA、内核、libc、编译器和优化参数；
3. 预热，随机化各组运行顺序，控制后台负载；
4. 视问题决定是否绑定 CPU，并记录是否跨 NUMA node；
5. 保存原始 CSV，报告中位数或均值及误差棒；
6. 同时看 wall time、CPU time、吞吐和尾延迟；
7. 改变临界区长度与竞争度，不只测单一极端；
8. 不任意删除异常值。

讲义的[不同方式求和 Demo](/OS/demos/concurrency/sum-experiment)保存 CSV，并在 Jupyter Notebook 画 error bar。可能的曲线也必须谨慎解释：单线程仍有原子/锁开销；同一计数器在多核间成为串行缓存行；短等待、线程不超核数时自旋可能占优，超额订阅或长临界区时 mutex 睡眠通常节省 CPU；SMT、NUMA 和公平策略会改变拐点。

一次基准不能证明“mutex 总比 spinlock 慢”或相反。Gernot Heiser 的 [Systems Benchmarking Crimes](https://gernot-heiser.org/benchmarking-crimes.html) 警告的正是选择性报告、负载不等价、缺原始数据和误差分析。

## 16. 概念辨析与常见误区

### 16.1 五个层次不能按名字等同

```text
C/C++：data race、atomic、happens-before
  ↓ 编译器
ISA：lock cmpxchg / LR-SC / AMO / ldxr-stxr / fence
  ↓ 用户态运行库
pthread mutex：原子快路径 + 竞争状态
  ↓ 必要时
futex syscall：等待队列、阻塞、唤醒
  ↓ 内核内部
关本地中断、原子操作、短自旋、调度
```

`pthread_mutex_lock` 不是 CPU 指令，也不保证每次 syscall；futex 不是完整 pthread mutex 语义；atomic RMW 不等于 fence，fence 不等于 mutex；硬件某个对齐 store 不撕裂，也不能使有 C data race 的源码合法。

### 16.2 四个高频误区

- **`volatile` 能同步线程。** 它不保证原子性、可见顺序或 happens-before。
- **mutex 让最终结果唯一。** 它只保证同锁临界区不重叠；转账总额固定、余额分布变化仍是正确行为。
- **大锁很丢人。** 大锁是可验证基线；测量发现竞争后再拆锁，才有收益与复杂度的证据。
- **自旋更底层所以总更快。** 结果取决于等待长度、线程/核比、缓存拓扑和调度。

互斥、安全性、公平性和无死锁也不可混为一谈。协议可以绝不双入，却让两人永等；也可保证系统总有人进入，却让某一线程饿死。必须逐项写规格、逐项给证据。

## 17. Takeaways

1. `sum++` 是可交错的多步状态迁移；同一 mutex 通过禁止临界区重叠，恢复局部串行推理。
2. 内核是大型并发程序。单核关中断只能排除部分本地并发，多核还要原子指令和锁；用户态无权随意关中断。
3. 锁不认识数据。程序员必须统一保护锁、锁序、生命周期与不变量；先用大锁建立正确基线通常最稳妥。
4. 串行临界区限制加速，但只要 span 远小于总工作，独立部分仍能大规模并行。
5. Dekker/Peterson 展示“意愿 + 冲突裁决”，以及状态机、反证和模型检查怎样建立 safety 证据。
6. 理想模型不是现实 C；`volatile`、compiler barrier、fence 和 atomic object 语义不同。
7. 硬件原子 RMW 提供短暂不可分割窗口，可实现自旋锁/原子加法，却不自动保护多变量事务。
8. 短等待可自旋，长等待应让出处理器；pthread mutex 常用用户态快路径与 futex 内核慢路径。
9. 性能结论必须来自功能等价、固定工作量、重复测量、原始数据和误差分析。

## 18. 思考题与下一讲衔接

1. 两个线程加锁写 `x`，第三个线程无锁读 `x`，为何仍违反协议？
2. 为什么“关中断”与“禁止内核抢占”不总是完全同义？NMI 在模型外意味着什么？
3. Peterson 的 `turn = other` 改为 `turn = me` 会怎样？先建模，再找反例。
4. 为什么空 `asm ... "memory"` 影响编译，却可能不产生任何机器指令？
5. `atomic_fetch_add(relaxed)` 为何能计数，却不足以发布另一个普通缓冲区？
6. futex wait 为什么必须带 expected value？画出 unlock 恰在准备睡眠时发生的时间线。
7. 账户 id 锁序为何排除 ABBA？如果 id 可动态修改，证明哪里失效？
8. 固定 `N` 次操作时，为什么“每线程各做 N 次”会混淆加速与工作量增长？
9. mutex 允许 `T0→T1` 或 `T1→T0`。若消费者必须等生产者放入数据，仅有互斥还缺什么？

最后一题就是[下一讲：同步与条件变量](15-condition-variables.md)的入口。互斥回答“谁能进入”，却不能单独表达“等某个状态成立才继续”。下一讲将从 `join` 和条件等待出发，建立同步点、happens-before、条件变量与生产者—消费者协议。

## 19. 阅读材料

- *Operating Systems: Three Easy Pieces*，第 29 章 “Locked Data Structures”；
- Peterson, *[Myths about the Mutual Exclusion Problem](https://zoo.cs.yale.edu/classes/cs323/doc/Peterson.pdf)*；
- 本机 `man 3 pthread_mutex_lock`、`man 2 futex`、`man 7 futex`；
- LWN, *[A futex overview and update](https://lwn.net/Articles/360699/)*；
- Ulrich Drepper, *[Futexes Are Tricky](https://cis.temple.edu/~giorgio/cis307/readings/futex.pdf)*；
- Gernot Heiser, *[Systems Benchmarking Crimes](https://gernot-heiser.org/benchmarking-crimes.html)*。

## 20. PPT 内容覆盖表

| 原讲义标题/内容 | 本章对应小节 |
| --- | --- |
| 并发控制：互斥 | §0–§1、§17 |
| Review & Comments | §0、§2 |
| 上节课没解决的问题：1 + 1 | §2.1、§3.1 |
| 在操作系统内核实现互斥 | §4 |
| [尝试关闭中断](/OS/demos/concurrency/cli) | §4、实验 1（§5） |
| 互斥：API | §3 |
| [使用 mutex API 实现互斥](/OS/demos/concurrency/sum-mutexapi) | §3、实验 1（§5） |
| 互斥锁的使用方法 | §3.4、§6 |
| 你高兴得太早了 | §6.1–§6.3 |
| FAQ: 都不并发了，我们还要线程吗？ | §8 |
| Dekker’s Algorithm (1965) | §9.2 |
| Peterson’s Algorithm (1981) | §9.2 |
| 回到我们 “拟人” 的视角理解并发 | §9.3 |
| Peterson’s Protocol | §9.3 |
| 直观解释 | §9.3–§9.4 |
| 如何理解 Peterson 算法？ | §9.4、§10 |
| [操作系统模型和检查器](/OS/demos/mosaic) | §10、实验 2（§10.1） |
| Computer Science 的 “叛逆” 本质 | §10.2 |
| 回到刚才的 “模型” | §10.2、§11.1 |
| 实现正确的 Peterson 算法 | §11.2–§11.3 |
| [Peterson 算法](/OS/demos/concurrency/peterson) | §11.3 |
| 而且……上厕所的问题并没有解决…… | §11.4 |
| Peterson 算法的路线错误 | §11.4 |
| 实现线程互斥：分析 | §12.1 |
| 硬件：只要提供一小段时间的 stop-the-world 就可以 | §12 |
| 终于可以实现 1 + 1 了 😂 | §12.2 |
| [使用硬件原子指令实现互斥](/OS/demos/concurrency/sum-spinlock) | §13.1 |
| 自旋锁：严重的性能问题 | §13.2 |
| 线程自己解决不了，就让操作系统来帮忙 | §14 |
| 定量研究方法 | §15 |
| [使用不同方式求和](/OS/demos/concurrency/sum-experiment) | §15、实验 3 |
