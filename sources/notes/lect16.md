# 并发控制：同步与信号量

# Review & Comments

## 同步：达到一个全局 “确定状态” 的瞬间 (同步点)

  - 同步条件被达成，但等待同步条件的线程还未继续
  - 促成了一对 happens-before 关系；“条件达成前” → “条件达成后”
      - `while (!posedge(clk)) ;`
      - `while (!all_threads_done()) ;`
      - `while (!freak_guy_arrived()) ;`
      - `while (!CAN_PRODUCE) ;`

## 于是有了 “条件变量”

  - 等待条件满足：`lock(lk); while (!cond) wait(cv, lk); unlock(lk);`
  - 条件可能满足：`broadcast(cv);`

## 1\. 信号量

# 计算图和一个奇妙的想法

## 任意一个有向无环图

  - u → v 代表 u 的计算 happen-before v 的计算
      - v: `foreach (u → v) while (!u_done) ;`
      - v: `while (pred_done != n_pred) ;`

## 一个奇妙的想法：用互斥锁实现同步

  - Dependency e: u → v 对应一把锁 (但 🔑 被管理员收走)
      - T\_main: `lock(e); spawn_threads();`
      - T\_u: `work(u); unlock(e);` (做完任务放回 🔑)
      - T\_v: `lock(e); work(v);` (需要 🔑 才能开始)
  - Release-Acquire 天然实现了 happens-before
      - (代码实现；注意这是一个 Undefined Behavior hack)

# [使用互斥锁实现计算图](/OS/demos/concurrency/cgraph-mutex)

为每一条边分配一把互斥锁——对于 u-\>v 的一条边，通过在 main 函数 acquire(lock of u -\> v)，u release -\> v acquire 来实现 happens-before。注意虽然这个程序可以正常运行，但这是 pthread mutex 不允许的 undefined behavior。

# 奇妙想法的扩展

## Release-Acquire 天然实现了 happens-before 同步

  - Acquire = 等待信号 (拿走桌上的 🔑) `while (!(k == 1)) ; k = 0;`
  - Release = 发出信号 (在桌上放 🔑) `k = 1;`
      - 信号/🔑 可以理解为现实生活中的 “进入凭证”

## 那为什么不能允许桌上同时有多个钥匙存在呢？

  - Acquire: `while (!(c > 0)) ; c--;`
  - Release: `c++;`
      - 停车场：有空车位可以直接进场，否则排队
      - 游泳馆：有空位获得手环进入更衣室，否则排队
      - 餐厅：有空桌可以直接进入，否则排队

# 祝贺，你发明了信号量 (Semaphore)

## 带一个计数器 count (初始化时指定) 的互斥锁

  - Acquire (Prolaag - try + decrease/down/wait)
      - `while (!(count > 0)) ; count--;`
      - “拿走一把 🔑”、“吃掉一个车位”
  - Release (Verhoog - increase/up/post/signal):
      - `count++;`
      - “放回一把 🔑”、“变出一个车位”
  - Caveat: 信号量只管出入口，停车位还需要其他机制管理

![](../site_html/static/img/parking.jpg)

# 信号量 API

    void P(sem_t *sem) {  // Acquire
        mutex_lock(&sem->lk);
        while (!(sem->count > 0)) {
            cond_wait(&sem->cv, &sem->lk);
        }
        sem->count--;  // 消耗一个 token (信号)
        mutex_unlock(&sem->lk);
    }

    void V(sem_t *sem) {  // Release
        mutex_lock(&sem->lk);
        sem->count++;  // 创建一个 token (信号)
        cond_broadcast(&sem->cv);
        mutex_unlock(&sem->lk);
    }

  - 初始时的 `count` 相当于执行了 `count` 次 release
      - 桌上 🔑 的数量、停车场车位的数量……
  - 每个 `P` (Acquire) 都能找到一个和它配对 (happens-before) 的 `V` (Release)
      - 每个 `P` 返回 (“拿走 🔑”、“吃掉车位”) 时，总能保证 🔑/车位的存在

## 2\. 信号量实现同步

# 热身：用信号量实现互斥锁

    sem_t sem = SEM_INIT(1);
    // 只有一个车位的停车场
    // 只有 🔑 x 1 的桌子

    void lock() {
        P(&sem);  // acquire: get 🔑
    }

    void unlock() {
        V(&sem);  // release: put 🔑
    }

  - “互斥锁是信号量的特例”
  - “信号量是互斥锁的扩展”

# 信号量的两种典型应用

## (1) 实现一次临时的 happens-before: A → B

  - s = 0
  - A → release: V(s) → acquire: P(s) → B
      - 这就是最开始的 “用互斥锁实现同步”

## (2) 控制并发数 \<= n (管理计数型资源)

  - 游泳池里的人不能超过 n 个
  - 停车场只有 n 个车位
  - 餐厅只有 n 桌
      - “计数” 是个很有用的特性

# 实现计算图的两种方式

## 考虑线程 join

  - 为每条边计数
      - worker\_t: V(done\_t)
      - main: P(done\_1); P(done\_2); … P(done\_n)
  - 为每个节点计数
      - worker\_t: V(done) // 释放一个手环
      - main: P(done); P(done); … P(done) // 收齐手环，关闭游泳馆

## 推广到任意计算图

  - 为每条边 e: u → v 计数
      - T\_u: work(u); V(e); (做完任务放回 🔑)
      - T\_v: P(e); work(v); (需要 🔑 才能开始)
  - 为每个节点计数
      - T\_u: P(u); P(u); … work(u)
      - T\_v: P(v); P(v); … work(v)

# [使用信号量实现线程 join](/OS/demos/concurrency/join-sem)

我们既可以用一个信号量实现一次临时的 happens-before，也可以用一个计数型信号量等待数量正确的线程结束。

# [使用信号量实现计算图](/OS/demos/concurrency/cgraph-sem)

使用信号量 “计数” 的特征，我们可以为每个节点分配信号量，当获得和入边数量相同的钥匙时，就可以进入该节点并开始计算。

# 例子：优雅地实现生产者-消费者

    sem_t empty = SEM_INIT(depth);
    sem_t fill = SEM_INIT(0);

    void T_produce() { P(&empty); printf("("); V(&fill); }
    void T_consume() { P(&fill); printf(")"); V(&empty); }

## 这次 “停车场” 的比方就不太好了

  - 从 empty 桌子上拿 🔑 → produce → 往 fill 桌子上放 🔑
  - 从 fill 桌子上拿 🔑 → consume → 往 empty 桌子上放 🔑
  - Caveat: produce/consume 是并行的
      - printf 是线程安全的，但你自己实现的数据结构还需要互斥

## 全局的 invariant

  - empty + fill + P\_hold + C\_hold = depth
  - 通过 V → P 实现拿/放的配对

# [使用信号量实现生产者-消费者问题](/OS/demos/concurrency/pc-sem)

信号量给了生产者-消费者问题一个非常精巧的实验，生产者把球从 empty 口袋取走，push 之后把球放入 filled 口袋；消费者则恰好相反。整个系统满足 empty + filled + 正在打印的线程 = 缓冲区大小的全局约束。

## 3\. 信号量、条件变量与同步

# 信号量 v.s. 条件变量

## 信号量

  - 干净、优雅，完美地解决了生产者-消费者问题
  - 但 “count” 不总是能很好地代表同步条件

## 条件变量

  - 万能：适用于任何同步条件
  - 丑陋：代码总感里有什么脏东西 (spin loop)

    lock(&lk);
    while (!cond) {
        wait(&cv, &lk);
    }
    unlock(&lk):

# 实现更复杂的同步问题

## 上次课的同步问题

  - 三类线程分别死循环打印 `<`, `>` 和 `_`
  - 同步这些线程，使得屏幕打印出 `<><_` 和 `><>_` 的组合
      - 同步的条件：“现在可以打印这个字符”
      - 例如：打印了 `_` 之后，就可以打印 `<` **或** `>`

## “或” 这个条件是单个信号量无法表达的

  - 当然也不是不行
      - 每个线程等待字符可以打印的信号量
      - 打印完 `_` 之后，抛一个硬币，然后唤醒 `<` 还是 `>`
  - 信号量必须等待 “一个计数器”
  - 条件变量可以是 “任意全局状态的条件”

# 哲 ♂ 学家吃饭问题

## E. W. Dijkstra, 1960

  - 哲学家 (线程) 有时思考，有时吃饭
  - 吃饭需要同时得到左手和右手的叉子

![](../site_html/static/img/dining-philosophers.jpg)

# [哲学家吃饭问题](/OS/demos/concurrency/philosophers)

通过一个额外的信号量，我们限制上桌吃饭的人数不超过 4 人。上桌的 4 人之中至少有一人可以获得左右手的叉子，然后释放后退出临界区。这个协议的正确性并不是显然的：我们必须非常小心地对待任何并发问题。

# 尝试

## 条件变量

  - 同步条件：`avail[lhs] && avail[rhs]`
  - 背模板即可
      - (期末考试 100% 会考，这就是通关密码)

## 信号量

  - `P(&sem[lhs]) && P(&sem[rhs])`
  - 看起来没什么问题？
      - 当互斥锁用就行了

# 成功的尝试：信号量

## 如果 5 个哲学家同时举起左手的叉子……

  - 我们需要禁止这件事发生

## Workaround 1: 从桌子上赶走一个人

  - 直观理解：大家先从桌上退出
      - 想吃饭，先得拿到桌上的 🔑
      - 吃完饭，把 🔑 还回去
      - 实现最多只有 4 个人可以上桌，就不会循环等待了

## Workaround 2: Lock Ordering

  - 给叉子编号，总是先拿编号小的

# 不！这不 “成功”

## 信号量不总是 “优雅”

  - Systems 要的是 absolutely correct 的方案
  - 数值型资源不总是能很好地代表同步条件

![](../site_html/static/img/cv-generalize.png)

# 加强版生产者/消费者问题

## 同步四类线程

  - put(x) - P(\&empty) → put(x) → V(\&fill)
  - get() - P(\&fill) → get() → V(\&empty)
  - close() - ???
  - open() - ???

## 条件变量就容易了

  - broadcast → all\_closed → can\_reopen = 1
      - 无论 “条件” 多复杂，总是一个 “全局状态的计算结果”
      - put/get 时可以根据是否有 pending close 做出不同判断
  - 但信号量实现起来就很麻烦了

# 用信号量实现条件变量

> Implementing condition variables out of a simple primitive like semaphores is surprisingly tricky. (from a [2003 report](http://birrell.org/andrew/papers/ImplementingCVs.pdf))

    void wait(cond_t *cv, mutex_t *mutex) {
        cv->nwait++;
        mutex_unlock(mutex);
        P(&cv->sleep);
        mutex_lock(mutex);
    }

    void broadcast(cond_t *cv) {
        mutex_lock(&cv->lock);
        for (int i = 0; i < cv->nwait; i++)
            V(&cv->sleep);
        cv->nwait = 0;
        mutex_unlock(&cv->lock);
    }

  - **唤醒丢失**: 一个 “早就 wait 但没有 P” 的线程会抢走唤醒
  - Release-wait 必须实现成 “不可分割的原子操作”
      - 解决不了，就问操作系统吧 (实际实现靠得是 futex)

# 用信号量实现条件变量 (cont’d)

## 引入一个 “调度线程”

  - 就像在哲学家吃饭问题里引入一个**发叉子的服务员**
      - 根据全局状态，决定谁可以继续
      - 最好的方式：把条件一起送给 T\_waiter，由 T\_waiter 决定谁可以继续

    void T_philosopher(int tid) {
        while (1) {
            send_message_to_waiter();
            P(&can_proceed[tid]);
        }
    }

  - 看起来性能低，但 “调度” 的时间几乎是 O(1) 的
  - 只要任务分解得当，对性能的损失就可以忽略不计

# Takeaways

信号量可以看做是互斥锁的一个 “推广”，可以理解成游泳馆的手环、停车场的车位、餐厅的桌子和袋子里的球，通过计数的方式实现同步——在符合这个抽象时，使用信号量能够带来优雅的代码。但信号量不是万能的——理解线程同步的条件才是真正至关重要的。

# 阅读材料

教科书 Operating Systems: Three Easy Pieces:

  - 第 31 章 - Semaphores
