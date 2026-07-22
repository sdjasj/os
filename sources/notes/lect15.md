# 并发控制：同步与条件变量

# Review & Comments

## 并发编程：入门到放弃

  - thread.h: spawn(fn), join() 实现多线程
  - 结果 1 + 1 都不会实现了

## 互斥：终于可以求 1 + 1 了！

  - 互斥锁 lock/acquire, unlock/release

## 互斥没能完全解决问题

  - 互斥实现了 “不并发”：A → B, 或者 B → A
  - 但没有给我们实现**确定性**的机制：只能 A → B
      - 没错，我们还不会实现 join()
      - T1, T2, … 结束 → join 返回

## 1\. 同步 (Synchronization)

# 并发控制：同步

## 我们人类 (线程) 天生是异步 (asynchronous) 的

  - “各管各的”
  - 例子：点好外卖就不管了，送到了会有通知

## 同步：“两个或两个以上随时间变化的量在变化过程中保持一定的**相对关系**”

  - 同步电机、同步电路……
  - 物理世界有很多方式实现同步
      - 同步电机：磁锁定
      - 同步电路：时钟信号
      - 我们：Wall-clock time 10:10 上课
          - 时钟同步：天体力学周期 (给人用) v.s. 原子振动 (高精度)？
          - 反人类的夏时制 (Daylight Saving Time): 中国也实行过！

# 并发控制：同步 (cont’d)

## 意想不到，无处不在

  - 在现实世界中，我们经常期望 “同时发生”
      - 超过 20-30ms 就能察觉到 “不齐”
      - 对计算机来说，这已经是很长的时间尺度了 (上亿条指令)

![](../site_html/static/img/njuorchestra.jpg)

# 用代码表示直觉的同步

## 同步电路

    while (!posedge(clk)) ;  // await posedge(clk)
    ff_out = ff_in;

## 线程 join

    spawn(T_1); spawn(T_2); ... spawn(T_n);
    while (!all_threads_done()) ;  // await all_threads_done()

## 今晚 23:59:59 大活门口，不见不散！

    study_until(23, 50, 00); goto("大活门口");
    while (!freak_guy_arrived()) ; // await freak_guy_arrived()

# 同步：思考

## 这些案例的共性：实现 “握手”

  - 等到某一个条件发生，然后继续分叉执行
  - 如果现在条件不发生，一定有一个操作使它发生

## 握手的瞬间就有了一个 “全局同步” 的状态 (同步点)

  - 达到同步点，就是达到 “全局意义上容易理解” 的状态
  - 确立 “Happens-before” 关系
      - 上升沿到来 → posedge(clk)
      - 最后一个线程结束 → await all\_threads\_done()
      - 迟到的人到达 → await freak\_guy\_arrived()

# 让我们实现一个同步的乐团吧！

## 你没看错，可以用程序放音乐

  - 甚至还有专门实现音乐的 DSL: [Strudel](https://strudel.cc/), [Hacklily](https://www.hacklily.org/), …
      - Content as Code: Coding Agent 可以生产世界上的一切

## 实际写程序的时候就要小心了

  - 还记得被 sum++ 支配的恐惧吗？
      - 共享变量的访问一定要用 mutex 保护好
      - acquire/release 保证了共享变量的可见性

    do {
        mutex_lock(&lk);
        can_proceed = check_condition();
        mutex_unlock(&lk);
    } while (!can_proceed);
    assert(can_proceed);

# [实现乐团同步](/OS/demos/concurrency/orchestra)

乐团指挥希望每个成员在听到指挥的信号后，才开始演奏一拍——也就是建立一个 “happens-before” 的关系。在代码中，我们可以通过 happens-after 的一方 “等待” 同步条件达成的方式来实现同步。这个想法形成了条件变量。我们可以对比使用 spin 和条件变量版本的乐团指挥。

# 发明条件变量

## 如果不希望自旋？

    do {
        mutex_lock(&lk);
        cond = check_condition();
        mutex_unlock(&lk);
    } while (!cond);

## 那就让操作系统提供一个 API 来帮忙吧

    mutex_lock(&lk);
    while (!check_condition()) {
        cond_wait(&cv, &lk);
    }
    mutex_unlock(&lk);

  - cond\_wait: 释放锁，同时立即等待 (这两件事瞬间同时完成)
  - cond\_wait 等待的线程，通过 signal(\&cv) 或 broadcast(\&cv) 唤醒

# 万能同步的实现方法

1.  想清楚，同步的条件是什么
2.  记住下面的这段代码 (上好锁)
      - 同步电路、线程 join、不见不散、乐团指挥，都是一样的

    // 线程 1
    mutex_lock(&lk);
    // 修改可能使 sync_cond() 成立的共享状态
    cond_broadcast(&cv);    // 唤醒等待的线程
    mutex_unlock(&lk);  // Release

    // 线程 2
    mutex_lock(&lk);  // Acquire
    while (!sync_cond()) {    // 条件不成立时进入等待
        cond_wait(&cv, &lk);  // 等待并自动释放 lk, 被唤醒时重新获得 lk
    }
    // ... 执行后续操作
    mutex_unlock(&lk);

## 2\. 使用条件变量解决同步问题

# 经典同步问题：生产者-消费者问题

## 学废你就赢了

  - 99% 的实际并发问题都可以用生产者-消费者解决
      - Master-slave (scheduler–worker) 模式

## Producer 和 Consumer 共享一个缓冲区

  - Producer (生产数据)：如果缓冲区有空位，放入；否则等待
  - Consumer (消费数据)：如果缓冲区有数据，取走；否则等待
      - **同步**：同一个 object 的生产必须 happens-before 消费

    void produce(Object obj);
    Object consume();

# 生产者-消费者问题的简化

## 一个等价的描述

    void T_producer() { printf("("); }
    void T_consumer() { printf(")"); }

  - 生产 = 打印左括号 (push into buffer)
  - 消费 = 打印右括号 (pop from buffer)
  - 在 printf 前后增加代码，使得打印的括号序列满足
      - 不能输出错误的括号序列
      - 括号嵌套的深度不超过 n (buffer size)
          - n = 3, ((())())((( ✅
          - n = 3, (((()))), (())) ❌

# 条件变量的正确打开方式

## 想清楚**程序继续执行的条件**，剩下的抄代码模板

  - 什么时候可以 produce，什么时候可以 consume？

    mutex_lock(&lk);
    while (!cond) {  // cond 可以是任意的计算
        cond_wait(&cv, &lk);
    }
    assert(cond);    // 此时 cond 成立且持有锁 lk
    mutex_unlock(&lk);

    mutex_lock(&lk);
    cond = true;
    cond_broadcast(&cv); // 唤醒所有可能继续的线程
    mutex_unlock(&lk);

# 使用条件变量实现同步 (cont’d)

## 生产/消费的条件是什么？

  - 嵌套深度 d \< n 可以生产；d \> 0 可以消费 (然后，**抄代码**)

    void T_producer() {
        mutex_lock(&lk);
        while (!(depth < n)) {
            cond_wait(&cv, &lk);
        }

        assert(depth < n);
        depth++;
        printf("("); // put object to queue

        cond_broadcast(&cv);
        mutex_unlock(&lk);
    }

# [生产者-消费者问题](/OS/demos/concurrency/producer-consumer)

在解决同步问题时，关键在于理解全局同步点上的同步条件是什么。然后各个线程在条件不满足时等待，直到条件满足方可继续。这个思路自然地引出了 “条件变量” 这一同步机制。

# Caveat: 小心并发！

## “看起来正确” 其实很危险

  - Producer 如果唤醒了等待的 producer 就糟了……

    void T_producer() {
        mutex_lock(&lk);
        while (!(depth < n)) {
            cond_wait(&cv, &lk);
        }

        assert(depth < n);
        depth++;
        printf("("); // put object to queue

        cond_signal(&cv);  // ⚠️
        mutex_unlock(&lk);
    }

# 条件变量：万能的同步方法

## 有三种线程

  - T\_a 若干: 死循环打印 `<`
  - T\_b 若干: 死循环打印 `>`
  - T\_c 若干: 死循环打印 `_`

## 任务：

  - 对线程同步，使得屏幕打印出 `<><_` 和 `><>_` 的组合

## 使用条件变量，只要回答三个问题：

  - 打印 “`<`” 的条件？打印 “`>`” 的条件？打印 “`_`” 的条件？

# [奇怪的同步问题](/OS/demos/concurrency/fish)

我们可以构造出 “奇怪” 的同步条件，例如有三种线程，分别死循环打印 `<`、`>`、`_`。如何同步这些线程，使得屏幕上看到的总是 `<><_` 和 `><>_` 的组合？而只要我们能列出同步条件，就可以直接使用条件变量解决。

## 3\. 实现计算图

# 计算图模型

## G(V, E): 有向无环的 Dependency Graph

  - 计算任务在节点上
      - (可以使用 shared memory)
  - 边 (u, v) 表示 v 的计算要用到 u 产生的值
      - (u, v) 就代表一个 happens-before 关系
      - v 开始的时候，必须能看到 u 对共享内存所有的修改

## 这是一个**非常基础的模型**

  - **几乎总是可以用这个视角去理解并行计算**
  - 如果节点 “独立计算时间” 足够长，算法就是可高效并行的
  - 计算图也可以是动态的
      - 一边计算，一边产生新的节点
      - (计算图是共享内存里的数据结构)

# 无处不在的计算图

## 我们会专门有一次课讲各类计算任务的并行方法

  - 神经网络 (Pytorch autograd; fxgraph)
  - Makefile (GNU Make 是可以自动并行化的)
  - ……

![](../site_html/static/img/fxgraph.png)

# 例子：Longest Common Subsequence

## 对于一个计算问题，我们可以有多种**划分**方法

  - Caveat: 如果为每一个 dp\[i\]\[j\] 创建一个线程，就得不偿失了

![](../site_html/static/img/lcs.jpg)

# 例子：电路模拟

## Verilator: 支持 partition 和并行仿真

![](../site_html/static/img/sync-circuit.jpg)

# 同步：实现任意计算图 (1)

## 为每个计算节点设置一个线程和条件变量

    void T_u() {  // u -> v
        ... // u 的计算
        mutex_lock(v->lock);
        v->n_done++;
        cond_signal(v->cv);  // 这里是可以 signal 的
        mutex_unlock(v->lock);
    }

    void T_v() {
        mutex_lock(v->lock);
        while (!(v->n_done == v->n_predecessors)) {
            cond_wait(v->cv, v->lock);
        }
        mutex_unlock(v->lock);
        ... // v 的计算
    }

# 同步：实现任意计算图 (2)

## 实现一个任务的**调度器**

  - 一个生产者 (scheduler)，许多消费者 (workers) 循环：
      - 也叫做 “Executor Pool”

    mutex_lock(&lk);
    while (!(all_done || has_job(tid))) {
        cond_wait(&worker_cv[tid], &lk);
    }
    mutex_unlock(&lk);

    if (all_done) {
        break;
    } else {
        process_job(tid);
    }

    cond_signal(&sched_cv);

# 同步的关键：理解同步条件

## 方法 (1): 为每个计算节点分配线程

  - 对于 u → v
      - T\_u: 完成后为 T\_v 生产一份
      - T\_v: 消费 n\_predecessors 份后才能继续

## 方法 (2): Executor Pool

  - T\_worker: 生产 ready，消费 job
  - T\_scheduler: 消费 ready，生产 job
      - “生产 happens-before 消费”

# [使用互斥锁实现计算图](/OS/demos/concurrency/cgraph-mutex)

为每一条边分配一把互斥锁——对于 u-\>v 的一条边，通过在 main 函数 acquire(lock of u -\> v)，u release -\> v acquire 来实现 happens-before。注意虽然这个程序可以正常运行，但这是 pthread mutex 不允许的 undefined behavior。

# Takeaways

同步是并发控制中除互斥外的另一个基本问题：我们希望控制事件发生的先后顺序。条件变量 (cond\_wait/cond\_signal/cond\_broadcast) 是万能的同步原语，配合互斥锁使用，可以实现任意 happens-before 关系。生产者-消费者是经典的同步问题，99% 的实际并发问题都可以用它来建模和解决。计算图模型是理解并行计算的通用框架——为每个节点设置条件变量，或者用调度器-工作线程模式，都可以实现任意 DAG 上的并行计算。

# 阅读材料

教科书 Operating Systems: Three Easy Pieces:

  - 第 30 章 - Condition Variables
