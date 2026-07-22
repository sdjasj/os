# 并发 Bug 和应对

# Review & Comments

## 本周四 (4.30) 闭卷期中测验

  - 五一有出游计划的同学可以 🐦

## 并发编程

  - 人和物理世界：spawn, join // 入门到放弃
  - 桌子和钥匙：lock, unlock // 互斥
  - 等待全局同步条件：wait, broadcast // 同步 (1)
  - 桌子和多把钥匙：P/V (acquire/release) // 同步 (2)

## 并发编程很难

  - 人类天生就是 “sequential creature”
      - 我们刚开始接触的程序也是**顺序执行**
      - 并发编程时容易产生顺序执行的 “幻觉”
      - “理解所有行为” 是 NP-Hard 的
  - 让我们 “Learn from mistakes”
      - 人类擅长归类总结

## 1\. 死锁

# 死锁 (Deadlock)

## A deadlock is a state in which each member of a group is waiting for another member, including itself, to take action.

  - 在实际中也是可能发生的！

![](../site_html/static/img/deadlock.jpg)

# AA-Deadlock

## 同一个线程，pthread\_mutex\_lock 同一个锁两次，会怎么样？

  - 让 AI 编一个程序就行，不费吹灰之力
  - 观察、思考编程的**过程**很重要：AI 在向你输出信息
      - 库函数的使用
      - 编码的 best practice
      - 使用的命令行工具……

## 看起来很傻，你觉得自己不会犯这错误？

  - 不，你会犯的！
  - 真实系统的复杂性等着你
      - 多层函数调用 (递归)
      - 隐藏的控制流 (callback、信号、中断……)
      - 我们甚至可以考考 AI 现实中有没有这种 AA 型死锁的案例 😊

# ABBA-Deadlock

    void T_philosopher() {
        mutex_lock(&avail[lhs]);
        mutex_lock(&avail[rhs]);
        // ...
    }

  - 做过 lab 就知道了，还是很容易写出死锁的
  - 真实代码中的惨剧更是不计其数

![](../site_html/static/img/dining-philosophers.jpg)

# [死锁演示](/OS/demos/concurrency/deadlock)

包含两种经典的死锁场景：AA 死锁：同一个线程对同一把互斥锁加锁两次。由于 mutex 不可重入，线程在第二次 `mutex_lock` 时永远阻塞。ABBA 死锁：哲学家就餐问题。每个哲学家先拿左手边的叉子、再拿右手边的叉子——当所有人都拿到左手边叉子时，形成循环等待，所有线程永久阻塞。

### 1.1. 死锁产生的必要条件和避免

# 死锁产生的必要条件

## [System deadlocks (1971)](https://dl.acm.org/doi/10.1145/356586.356588): 把锁理解成桌子上有一把钥匙，拿到钥匙的人可以进入

1.  Mutual-exclusion - 一把钥匙只能被一个人拿到，拿到钥匙才能继续
2.  Wait-for - 拿到钥匙的人还想要更多的钥匙
3.  No-preemption - 不能抢别人的钥匙
4.  Circular-chain - 形成循环等待

## “必要条件”？

  - 打破任何一个条件，就不会发生死锁了

# 死锁产生的必要条件 (cont’d)

## [百度百科的 “死锁” 词条](https://baike.baidu.com/item/%E6%AD%BB%E9%94%81/2196938)

  - “理解了死锁的原因，尤其是产生死锁的四个必要条件，就可以最大可能地避免、预防和解除死锁。所以，在系统设计、进程调度等方面注意如何不让这四个必要条件成立，如何确定资源的合理分配算法，避免进程永久占据系统资源。此外，也要防止进程在处于等待状态的情况下占用资源。因此，对资源的分配要给予合理的规划。”

## 2026 年，依然极度混乱 (AI 都知道内容碎片化、断章取义搬运痕迹严重)

  - 中文语料天崩开局 (会导致直播间立即消失)
      - o200k\_base (10): “微信公众号天天中彩票” 和 “日本毛X免费视频观看”
      - o200k\_harmony (9): “大发展有限公司官网”、“久久免费热在线精品”、“给主人留下些什么吧” (只有这个是正常的)

# 逐条解析

## Mutual-exclusion - NOT(钥匙只能被一个人拿到，拿到钥匙才能继续)

  - 把 “锁” 的定义整个就改掉了
  - 代码设计的彻底重构 (例如，引入 send/receive 向 T\_waiter 发送消息)

## Wait-for - NOT(拿到钥匙的人还想要更多的钥匙)

  - 一把大锁保平安 (性能低)
  - Transaction memory (极难实现)

## No-preemption - NOT(不能抢别人的钥匙)

  - 要能回滚持有锁线程执行过的操作 (又是 transaction memory)

## Circular-chain - NOT(形成循环等待)

  - Lock ordering: 看起来比上面的方案都要 “实用”

# 在实际系统中避免死锁？

## Lock ordering

  - 任意时刻系统中的锁都是有限的
  - 给所有锁编号 (Lock Ordering)
      - 严格按照从小到大的顺序获得锁
      - (这个也容易检查)

## Proof (sketch)

  - 任意时刻，总有一个线程获得**编号最大**的锁，它**总是可以继续运行**
      - 这个证明可以扩展到 “lock group”——总是由一个线程获得 “组号最大” 的锁

# Lock Ordering: 应用

## Linux Kernel: [mm/rmap.c](https://elixir.bootlin.com/linux/latest/source/mm/rmap.c)

![](../site_html/static/img/mm-lockorder.png)

# Lock Ordering: 应用 (cont’d)

> [Unreliable Guide to Locking](https://www.kernel.org/doc/html/latest/kernel-hacking/locking.html): Textbooks will tell you that if you always lock in the same order, you will never get this kind of deadlock. **Practice will tell you that this approach doesn’t scale**: when I create a new lock, I don’t understand enough of the kernel to figure out where in the 5000 lock hierarchy it will fit.
>
> The best locks are encapsulated: they **never get exposed in headers**, and are **never held around calls to non-trivial functions outside the same file**. You can read through this code and see that it will never deadlock, because it never tries to grab another lock while it has that one. People using your code don’t even need to know you are using a lock.

## [LockDoc](https://dl.acm.org/doi/10.1145/3302424.3303948) (EuroSys‘19)

  - “Only 53 percent of the variables with a documented locking rule are actually consistently accessed with the required locks held.” (今天不会再发生了)

# 软件工程的本质：Harness Engineering

## 做最坏的假设，最防御性的编程

  - 例子：项目规定必须使用 RAII (C++ 和 Rust 的核心范式)
  - 例子：项目规定必须明确 lock ordering

## 还要做更坏的假设：没有任何程序员是信得过的

  - 不如每次 acquire/release 都用 printf 打一个日志
      - 如果任何线程既有 A → B 且 B → A，直接报错
      - 理论上说可能错杀一些正确的情况，例如 A → B → spawn → B → A，但这是程序员巨大的**心智负担**，必须避免
  - `LD_PRELOAD=./locktrace.so ./a.out | python3 check.py`
      - (我们当然也可以直接一边 trace 一边检查)

# [lockdep](/OS/demos/concurrency/lockdep)

通过 `LD_PRELOAD` 拦截 `pthread_mutex_lock` / `pthread_mutex_unlock`，在运行时构建锁的依赖图（邻接矩阵）来检测潜在的 ABBA 死锁：每次加锁时记录 “已持有锁 → 新获取锁” 的有向边，加边前检查是否形成环，发现环则报告潜在死锁。

## 2\. 不上锁不就不会死锁了吗？

# 数据竞争 (Data Race)

## 不同的线程同时访问同一内存，且至少有一个是写

  - T\_alipay: `if (balance >= amount) { balance -= amount; }`
  - T\_sum: `sum++;`
  - Peterson’s protocol (举旗子、看旗子、贴名字、看名字)……

## Race 的快慢会导致截然不同的运行结果

  - C/C++: data race 是 **undefined behavior**，用就是你错
  - Java Memory Model：试图 “定义” race 的可能行为

![](../site_html/static/img/marathon-2h.jpg)

# 数据竞争：例子

## 以下代码概括了你们遇到数据竞争的大部分情况

  - 不要笑，你们的 bug 几乎都是这两种情况的变种

## Case 1: 上错了锁

    void T_1() { mutex_lock(&A); sum++; mutex_unlock(&A); }
    void T_2() { mutex_lock(&B); sum++; mutex_unlock(&B); }

## Case 2: 忘记上锁

    void T_1() { mutex_lock(&A); sum++; mutex_unlock(&A); }
    void T_2() { sum++; }

# 数据竞争：例子 (cont’d)

## 不要笑？

  - 实际系统面临更复杂的情况

## “内存” 可以是地址空间中的任何内存

  - 可以是全部变量
  - 可以是堆区分配的变量
  - 可以是栈

## “访问” 可以是任何代码

  - 可能发生在你的代码里
  - 可以发生在别人写的代码里
  - 可能是一行你没有读到过的汇编代码
  - 甚至可能是一条 ret 指令
      - 曾经《操作系统》课埋下最高光的 bug，直接带你发明 Read-Copy-Update 机制

# 软件工程的本质：Harness Engineering

## 再一次，做最坏的假设，最防御性的编程

  - Data race 比 lock 要复杂很多
      - 在两次 sum++ 离得很远的时候就可以报警了
      - 记录 lock/unlock 和所有 load/store
          - 我们就可以检测 “happens-before” race

## Intelligence is Cheap

  - 我拍脑袋了有了个想法：QEMU User trace memory
      - 把程序当分析对象，曾经是极少数人掌握的看家本领
      - 现在家都被抄了 😭
  - 曾经一砖一瓦加入到大型系统里的东西，Agent Swarm 上就行了

# [ThreadSanitizer](/OS/demos/concurrency/tsan)

通过寻找是否存在没有 happens-before 关系的不同线程、同一变量、至少一个是写的内存访问 (数据竞争)。这也称为 happens-before race。同时，TSAN 也不是万能的：触发 happens-before race 依然可能需要特定的线程调度。

### 2.1. Aside: 伤人性命的并发 Bug

# “Killed by a Machine”

## Therac-25 Incident (1985-1987)

  - 事件驱动导致的并发 bug，导致至少 6 人死亡

![](../site_html/static/img/therac-25.jpg)

# The Therac-25

    assert mode in [Electron(Low), XRay(High)]
    assert beam_flattener in [On, Off]
    assert not (mode == XRay(High) and beam_flattener == Off)

![](../site_html/static/img/therac-25-bug.png)

# The Killer Software Bug in History

## “支付宝” 的案例再现

  - 在 Electron (Low) Mode 下选择 X-Ray (High) Mode
      - 机器开始**移动** beam flattener，大约需要 8s 完成…
      - **切换**到 Electron (Low) Mode (OK)
      - 再**迅速切换**到 X-Ray (High) Mode
      - 此时触发 **Assertion fail** (Malfunction 54)
          - 操作员下意识地按下 Continue……

## “软件定义” 带来的悲剧后果

  - 在更早的产品 (Therac-20) 中，assert 由电路互锁 (interlock) 强制实现，直接停机 (需要手工重启)

# [Therac-25 模拟器](/OS/demos/concurrency/therac-25)

完全的 vibe coding，没有任何古法编程——在 Content-as-Code 的时代，编程前所未有地简单，我们也可以随时随地生成任何辅助的工具——从教具到 3D 打印的工具。

# 这甚至不是 Therac-25 的最后一个杀人 Bug

## 问题修复后……

  - If the operator sent a command at the exact moment the counter overflowed, the machine would skip setting up some of the beam accessories

## 最终解决方法

  - 独立的硬件安全方案，检测到大计量照射时直接停机

## “软件定义” 时代的安全问题

  - 自动驾驶、具身智能的 “底线安全” 越来越难
  - (AI：到底该不该主动刹车呢？)

## 3\. 都上锁不就没有数据竞争了吗？

# 伤人性命的并发 Bug：思考

## 我们编程时，太容易做 “顺序执行” 的假设了

  - 人类本质上是 sequential creature
      - 函数返回是天然**同步**的
      - 函数自带 “all or nothing” 的原子性
  - Therac-25: 如果模式切换瞬间完成，就没有任何问题了
      - 但模式切换需要时间，“在未来才生效”，但我们已经形成了 “立即生效” 的肌肉记忆
          - 没有副作用 (pure functions)，就没有并发问题

## “后果自负” 的并发控制机制

  - [Threads cannot be implemented as a library](https://dl.acm.org/doi/10.1145/1065010.1065042)
  - 互斥锁 (lock/unlock) 实现原子性
      - 忘记上锁——原子性违反 (Atomicity Violation, AV)
  - 条件变量/信号量 (wait/signal) 实现同步
      - 忘记同步——顺序违反 (Order Violation, OV)

# 那么，程序员到底用得对不对呢？

## “Empirical study” 实证研究

  - 收集了 105 个真实系统的并发 bugs
      - MySQL (14/9), Apache (13/4), Mozilla (41/16), OpenOffice (6/2)
      - 观察是否存在有意义的结论

## 97% 的非死锁并发 bug 都是原子性或顺序错误

  - “人类的确是 sequential creature”
  - [Learning from mistakes - A comprehensive study on real world concurrency bug characteristics](https://dl.acm.org/doi/10.1145/1346281.1346323) (ASPLOS‘08, Most Influential Paper Award)

# 原子性违反 (Atomicity Violation)

## “ABA”: 代码被别人 “强势插入”

  - 即便分别上锁 (消除数据竞争)，依然是 AV
      - Diablo I 里复制物品的例子
      - Therac-25 中 “移动 Mirror + 设置状态”

![](../site_html/static/img/av-bug.png)

# 原子性违反 (cont’d)

## 操作系统的状态也是共享状态

  - 没想到吧！哈哈 ([TOCTTOU study](https://www.usenix.org/legacy/events/fast05/tech/full_papers/wei/wei.pdf))

![](../site_html/static/img/tocttou.png)

# 顺序违反 (Order Violation)

## “BA”: 事件未按预定的顺序发生

  - 例子：concurrent use-after-free
  - 甚至没有 UAF 的时候，speculative execution 带来的 [GhostRace](https://www.vusec.net/projects/ghostrace/)

![](../site_html/static/img/ov-bug.png)

# 软件工程的本质：Harness Engineering

## 加强版的 LockDep

  - 把整个程序执行对齐到时间轴上，为每个函数调用都标注 “做了什么”
  - Query AI 寻找疑似不该被打断/顺序错误的事件

## Agentic AI 时代

  - 让程序的 trace “可审计” 是非常重要的
      - 每个函数在调用的时候都可以输出自己 “做什么” (可以是 embedding space)
      - 返回的时候可以审计这段时间系统做了什么
  - “Informal semantics”

# Takeaways

人类本质上是 sequential creature，因此总是通过 “块的顺序执行” 这一简化模型去理解并发程序，也因此带来了数据竞争、Atomicity violation (本应原子完成不被打断的代码被打断)、Order violation (本应按某个顺序完成的未能被正确同步) 等问题。数据竞争非常危险，我们在编程时要尽力避免。

# 阅读材料

教科书 Operating Systems: Three Easy Pieces:

  - 第 32 章 - Concurrency Bugs
