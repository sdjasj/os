# 第 9 章：同步——条件变量、信号量与计算图

> 对应讲义：[第 15 讲](../sources/notes/lect15.md)、[第 16 讲](../sources/notes/lect16.md)。配套实验：[bounded_buffer.c](../examples/bounded_buffer.c)、[semaphore_dag.c](../examples/semaphore_dag.c)

互斥排除同时进入，同步建立事件先后：消费者必须等到有数据、主线程必须等工作完成、计算图节点必须等所有前驱完成。

## 9.1 条件变量不是“事件盒子”

条件变量总与一个由 mutex 保护的**谓词**配合：

```c
pthread_mutex_lock(&lock);
while (!predicate())
  pthread_cond_wait(&condition, &lock);
consume_state();
pthread_mutex_unlock(&lock);
```

`pthread_cond_wait` 原子地释放锁并睡眠；醒来后先重新获取锁再返回。这个原子交接避免“检查条件为假后、真正睡下前恰好错过通知”。

必须用 `while`，不能用 `if`：

- 条件变量允许 spurious wakeup；
- 被唤醒到重新拿锁之间，其他线程可能消耗资源；
- broadcast 会唤醒多个竞争者，但只有部分能满足条件。

通知不是状态本身。若没有等待者，`signal` 通常不会为未来保存一个“票”；真正持久的是受锁保护的谓词。

## 9.2 生产者—消费者

[bounded_buffer.c](../examples/bounded_buffer.c) 维护固定容量环形队列：

```c
while (queue.count == CAPACITY)
  pthread_cond_wait(&queue.not_full, &queue.lock);
/* enqueue */
pthread_cond_signal(&queue.not_empty);
```

消费者对称地等待 `count > 0`。运行：

```bash
./examples/bounded_buffer
```

队列的两个谓词是：

- `not_empty := count > 0`
- `not_full := count < CAPACITY`

修改 `count` 与检查谓词必须持同一把锁，否则会产生 lost wakeup。通常在持锁状态更新后 signal，再释放锁；某些实现可在解锁后 signal，但更难审查谓词与生命周期，除非有清晰证明不要炫技。

## 9.3 signal 还是 broadcast

- `signal` 至少唤醒一个等待者，适合一次状态变化只让一个线程取得资源。
- `broadcast` 唤醒所有等待者，适合全局状态改变、关闭队列或不同等待者拥有不同谓词。

broadcast 可能造成 thundering herd：许多线程醒来争锁，发现条件仍假再睡。优化前先保证唤醒覆盖所有可能从假变真的谓词。

关闭队列时常把状态写成：

```c
closed = true;
pthread_cond_broadcast(&not_empty);
pthread_cond_broadcast(&not_full);
```

等待循环检查 `closed`，让所有线程都能退出，而不是靠发送若干“毒丸”猜消费者数量。

## 9.4 信号量：把许可计数成整数

信号量维护非负计数：

- `sem_wait`：有许可则减一，否则睡眠；
- `sem_post`：增加许可，并可能唤醒等待者。

它很像停车场车位、游泳馆手环或袋中的球。初值 1 可实现互斥，初值 `N` 可限制最多 N 个并发访问者，初值 0 可表达尚未发生的事件。

[semaphore_dag.c](../examples/semaphore_dag.c) 把一次请求拆成计算图：

```text
              ┌→ compress ─┐
parse request ┤             ├→ package
              └→ encrypt ──┘
```

`package` 对两个完成信号各 `sem_wait` 一次，确保所有前驱结束：

```bash
./examples/semaphore_dag
```

这展示了同步的本质：为计算图的边建立 happens-before，而不是要求整张图按固定总顺序执行。

## 9.5 条件变量与信号量怎么选

| 问题形状 | 更自然的工具 |
|---|---|
| 等待共享状态满足任意布尔谓词 | mutex + condition variable |
| 管理相同资源的 N 个许可 | semaphore |
| 单个简单计数事件 | semaphore/eventfd |
| 一次性线程完成 | `pthread_join` / future |
| 数据本身就是同步载体 | blocking queue/channel |

信号量把通知保存为计数，条件变量把状态放在外部受锁数据中。二者理论上可互相构造，但“能实现”不代表“最容易证明正确”。优先选与问题语义同形的原语。

## 9.6 哲学家问题在教什么

五个哲学家各拿左右两把叉子，若所有人先拿左叉再等右叉，就形成资源等待环。它不是一道背模板的题，而是在提醒：

- 局部合理策略可能导致全局死锁；
- 限制同时尝试人数、统一资源顺序或引入服务员都可打破环；
- “某次测试都吃到了”不证明没有死锁或饥饿；
- 解决安全性后还要考虑公平和进展。

信号量初值设为 4 可阻止 5 人同时各占一把，但不自动提供公平；统一叉子编号加锁则给出可证明的无环顺序。

## 9.7 从线程到计算图

很多现代框架让程序员描述依赖，运行时决定调度：构建系统、数据流引擎、GPU kernel、Promise、深度学习图都是同一思路。

对 DAG 中每个节点维护未完成前驱计数：前驱完成后原子减一，变为零就把节点放入 ready queue。固定工作线程从队列取任务，避免“每个节点创建一个线程”的巨大成本。

```text
dependency counter + ready queue + worker pool
       数据结构           调度机制
```

这也是从手写条件变量走向任务运行时的自然演化。

## 9.8 常见误区

- `cond_wait` 返回就说明条件为真：必须重新检查谓词。
- signal 可以不配合共享状态：通知可能早于等待而丢失。
- 信号量值代表等待线程数：它代表未消费许可，内部等待者是另一回事。
- 把 mutex 当信号量跨线程解锁：mutex 有所有者语义，通常必须由加锁者解锁。
- 多 post 一次没关系：许可泄漏可能长期突破资源上限。
- 同步越多越安全：过度约束会丢失并行性，还可能引入环形等待。

## 9.9 自测与实验

1. 把有界队列的两个 `while` 改成 `if`，增加消费者数量并压力测试；列出错误交错。
2. 为队列增加 `close`，让任意数量生产者和消费者都能正常退出。
3. 用一个计数信号量和一把 mutex 重新实现有界队列，分别表示空槽与已有元素。
4. 扩展 DAG 为 6 个节点，画出每次 `post/wait` 对应的边。
5. 如果任务可能失败或取消，计算图的后继怎样避免永久等待？

下一章讨论即使使用了这些原语，现实系统为何仍会出现死锁、数据竞争和性能崩塌。
