# 第 8 章：互斥——把危险并发收缩成顺序区间

> 对应讲义：[第 14 讲](../sources/notes/lect14.md)，配套实验：[mutex_transfer.c](../examples/mutex_transfer.c)

互斥的目标不是“保护某一行代码”，而是在共享状态上维护不变量：任一时刻只有持有对应锁的线程可以观察或改变受保护状态。

## 8.1 从不变量开始

银行转账需要保持：

\[
balance_A + balance_B = constant
\]

如果减款和加款之间被其他线程观察，系统暂时违反不变量。锁把这两个动作组成一个临界区：

```c
pthread_mutex_lock(&lock);
from->balance -= amount;
to->balance += amount;
pthread_mutex_unlock(&lock);
```

正确问题不是“这条赋值要不要锁”，而是：

1. 哪组数据共同构成不变量？
2. 哪些访问可能并发？
3. 哪一把锁拥有这组数据？
4. 所有读写是否都遵循同一协议？

锁的所有权最好写在结构旁，而不是散落在调用约定中。

## 8.2 mutex 提供什么

成功 lock 到 unlock 之间最多有一个线程执行；unlock 与之后成功取得同一锁的 lock 还建立 happens-before。因此锁同时解决互斥与可见性。

```c
pthread_mutex_lock(&state->lock);
while (...) { /* 在持锁条件下读写 state */ }
pthread_mutex_unlock(&state->lock);
```

务必检查真实 API 的错误契约。普通 POSIX mutex 不保证递归加锁；解锁不属于当前线程的 mutex 是错误。取消、异常或多出口函数会让“忘记解锁”成为常见事故，C 中可用统一清理标签控制退出。

## 8.3 两个对象需要两把锁时

[mutex_transfer.c](../examples/mutex_transfer.c) 为每个账户设置一把锁，并规定总按账户 id 递增顺序获取：

```c
Account *first  = from->id < to->id ? from : to;
Account *second = from->id < to->id ? to : from;
pthread_mutex_lock(&first->lock);
pthread_mutex_lock(&second->lock);
```

运行：

```bash
./examples/mutex_transfer
```

数十万次双向转账后总额仍为 2000。全局锁顺序不仅保证不变量，还消除了 `A→B` 与 `B→A` 相互等待的 ABBA 环。第 10 章会系统讨论死锁。

## 8.4 从 Peterson 到硬件原子指令

Peterson 算法展示仅用共享读写与严格顺序也能为两个参与者实现互斥；但现代语言/处理器的宽松内存模型使朴素 C 版本不正确，而且算法不可扩展。它的价值在于揭示互斥需要某种不可分割的“决定胜负”步骤。

硬件通常提供 compare-and-swap、test-and-set、exchange 等原子读改写。最小自旋锁概念上是：

```c
while (atomic_exchange_explicit(&locked, true, memory_order_acquire))
  cpu_relax();
/* critical section */
atomic_store_explicit(&locked, false, memory_order_release);
```

等待者持续占 CPU 并争夺缓存行，所以只适合临界区极短、不能睡眠或很可能马上获得锁的场景。用户态 `pthread_mutex` 常走混合路径：无竞争时用原子指令完成；竞争时通过 futex 等内核机制睡眠，解锁再唤醒。

## 8.5 为什么内核不能总“关闭中断”

单核内核在短区间关闭本地中断可以防止当前 CPU 被中断处理器重入，却不能阻止其他 CPU 同时访问。多处理器仍需原子指令和自旋锁。关闭中断时间过长还会提高系统延迟，并可能丢失时序要求。

用户程序更没有权限用关中断实现互斥；即使能关当前核，也不影响其他核。这是理解“局部机制”和“全局并发”区别的好例子。

## 8.6 锁粒度与 Amdahl 定律

一把全局锁容易正确，却把所有临界区串行化。若程序比例 `s` 必须串行，使用 `N` 个执行单元的理论加速上限为：

\[
Speedup(N) \leq \frac{1}{s + (1-s)/N}
\]

但拆成细粒度锁会增加：

- 多锁不变量和死锁风险；
- 获取/释放与缓存一致性开销；
- 生命周期管理难度；
- 代码审查和测试状态空间。

正确策略是先测 workload，再缩小真正竞争的区域。分片、只读快照、线程本地状态、消息传递常比“继续加锁”更有效。

## 8.7 优先级反转与公平性

高优先级线程可能等待低优先级持锁者，而中优先级线程又不断抢占后者，形成优先级反转。实时系统会使用 priority inheritance/ceiling 等协议。

mutex 也未必公平：刚到的线程可能先于等待很久的线程拿锁。强公平减少饥饿，却增加排队和交接开销。API 是否保证公平必须查文档，不能从一次观察推断。

## 8.8 常见误区

- “共享变量各有一把锁”：不变量可能跨多个变量或对象，锁应覆盖不变量。
- “只给写加锁，读不需要”：读与写冲突，同样可能观察中间状态；除非使用明确的 RCU、版本或原子协议。
- “临界区越小越好”：把一个原子事务错误拆开会破坏正确性；先保证语义，再优化。
- “递归锁能修复重复加锁”：它可能掩盖层次设计问题，也不能解决多锁环路。
- “trylock 不阻塞，所以没有死锁”：重试协议仍可能活锁或饥饿。
- “mutex 就是自旋锁”：实现通常结合用户态原子 fast path 与内核睡眠 slow path。

## 8.9 自测与实验

1. 去掉 `mutex_transfer` 的第二把锁，构造总额错误的交错。
2. 把锁顺序改成“先锁 from”，解释为何程序可能挂起，并用超时压力测试观察。
3. 比较一个全局账户锁与每账户锁在 2、4、8 线程下的吞吐；先写 workload 再下结论。
4. 为什么对只读配置使用不可变快照能比读写锁更简单？更新时如何回收旧版本？
5. 解释自旋锁临界区中为何不能执行可能睡眠的系统调用。

互斥限制“谁能同时做”；下一章的同步则回答“谁必须先做”。
