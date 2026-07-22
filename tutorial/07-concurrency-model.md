# 第 7 章：共享内存并发与内存模型

> 对应讲义：[第 13 讲](../sources/notes/lect13.md)，配套实验：[race_counter.c](../examples/race_counter.c)

单线程程序可以按一条时间线推理；共享内存并发把多个状态机放到同一内存上，调度器每次选择谁前进一步。真正困难的是：语言编译器和处理器并不承诺按源码逐行形成一个全局交错。

## 7.1 并发不等于并行

- **并发（concurrency）**：多个任务的生命周期重叠，重点是组合和响应。
- **并行（parallelism）**：同一时刻在多个执行资源上工作，重点是吞吐和加速。

单核可并发但不能真正同时执行两条普通指令；多核能并行。并发是程序结构，平行执行是运行时现象。

线程创建/等待的基本形状：

```c
pthread_t thread;
pthread_create(&thread, NULL, worker, argument); // spawn
pthread_join(thread, NULL);                      // join
```

`pthread_create` 之前的初始化对新线程可见，线程结束前的写入在成功 `join` 后对等待者可见。这些是明确的 happens-before 边。

## 7.2 `counter++` 为什么会丢

`counter++` 通常至少包含 load、add、store。两个线程可能这样交错：

```text
初值 0
T1 load 0
T2 load 0
T1 store 1
T2 store 1    ← 两次增加只留下 1
```

运行三种实现：

```bash
./examples/race_counter race
./examples/race_counter atomic
./examples/race_counter mutex
```

`race` 模式故意扩大交错窗口，实际值通常小于期望。更严格地说，普通 C 对象被多个线程并发访问且至少一方写、又没有同步时，形成 **data race**；C 语言规定这是未定义行为。程序不是“只会偶尔少加几次”，编译器可在不存在 data race 的前提下优化，任何结果都不能依赖。

## 7.3 volatile 不提供线程同步

`volatile` 告诉编译器每次访问都具有可观察意义，常用于内存映射 I/O 或信号场景；它不保证：

- 复合操作原子；
- 跨核缓存同步的语言语义；
- 与周围普通访问的同步顺序；
- 线程间 happens-before。

示例中的 `volatile racy_counter` 只是让错误更容易在机器上显现，绝不是修复。修复要使用互斥锁或 C11 `_Atomic`。

## 7.4 原子性、可见性与顺序

这三个问题相关但不同：

- **原子性**：其他线程不会看见操作执行到一半；
- **可见性**：一个线程的写何时能被另一个线程观察；
- **顺序**：多个访问被其他线程以何种先后观察。

原子加法：

```c
_Atomic uint64_t counter;
atomic_fetch_add_explicit(&counter, 1, memory_order_relaxed);
```

`relaxed` 保证对 `counter` 的读改写不可分割，但不为其他对象建立顺序。这对“只需要最终计数”的统计量足够；若计数值用于宣布另一块数据已经准备好，就需要 release/acquire 或锁。

经典消息发布：

```c
// producer
payload = 42;
atomic_store_explicit(&ready, true, memory_order_release);

// consumer
if (atomic_load_explicit(&ready, memory_order_acquire))
  assert(payload == 42);
```

release 之前的写与观察到该值的 acquire 之后的读建立 happens-before。默认 `memory_order_seq_cst` 还提供所有顺序一致原子操作的单一全局次序，较易推理但可能限制优化。

## 7.5 两层“编译”

课程把复杂性概括为两层编译：

1. 语言编译器在不改变单线程可观察行为的前提下删除、合并和重排；
2. 处理器把指令动态调度到流水线和缓存层次，只在架构承诺处维持外部行为。

缓存一致性协议保证各核最终对单个缓存行达成一致，并不自动给所有内存操作一个符合源码顺序的全局时间线。store buffer、乱序执行和编译器优化都会打破“逐行交错”直觉。

因此不要靠 `sleep`、“在我机器上没出错”或查看反汇编猜同步。应依赖语言内存模型定义的锁、原子变量和线程生命周期关系。

## 7.6 happens-before 是推理骨架

可以把并发正确性画成偏序图：

```text
线程 A: 初始化数据 ── release ─┐
                               ├─ synchronizes-with ─ acquire ── 使用数据 :线程 B
线程内: sequenced-before ──────┘
```

若两个冲突访问之间没有 happens-before，且不是恰当原子访问，就很可能是 data race。锁的 unlock 对随后成功 lock 建立同步；条件变量和信号量也通过各自协议建立事件顺序。

## 7.7 用工具而不是运气

ThreadSanitizer 可动态发现许多数据竞争：

```bash
cc -g -O1 -fsanitize=thread -pthread \
  examples/race_counter.c -o /tmp/race-tsan
/tmp/race-tsan race
```

它只能发现本次执行走到的路径，也会显著改变时序；零报告不等于证明正确。模型检查、压力测试、故障注入和代码审查应互相补充。

## 7.8 常见误区

- “单条 C 语句就是原子操作”：语言语句和机器原子性无直接一一对应。
- “64 位对齐写不会撕裂，所以线程安全”：即便机器写原子，没有同步的数据竞争在 C 中仍是 UB。
- “加 `volatile` 就能通知另一个线程”：缺少原子与 happens-before。
- “x86 比较强，所以可以不管内存模型”：编译器仍按语言规则优化，可移植性与未来维护也会受损。
- “原子变量能自动保护相关结构”：单个字段原子不保证跨字段不变量。
- “输出正确说明程序正确”：错误交错可能尚未被本次调度触发。

## 7.9 自测与实验

1. 为什么 `atomic_load` 后 `atomic_store(old + 1)` 仍可能丢更新？改成 RMW。
2. 给 TSan 版本去掉示例中的 `volatile`，比较报告与实际输出。
3. 举出一个只需 relaxed counter 的场景和一个必须 release/acquire 的场景。
4. `pthread_join` 为什么能让主线程安全读取工作线程写入的普通变量？
5. 画出“双重检查初始化”中的访问关系，解释缺少 acquire/release 时的问题。

下一章学习最常用的控制手段：让某些区间不再并发。
