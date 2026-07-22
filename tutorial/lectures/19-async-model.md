# 第 19 讲：异步编程模型——把等待变成可调度的计算图

> 原始讲义：[sources/notes/lect19.md](../../sources/notes/lect19.md)  
> 配套示例：[examples/epoll_timer.c](../../examples/epoll_timer.c)、[examples/mini_malloc.c](../../examples/mini_malloc.c)  
> 本讲关键词：workload、fast/slow path、线程成本、用户态线程、协程、generator、非阻塞 I/O、`epoll`、`timerfd`、goroutine、channel、事件循环、JavaScript、callback、Promise、`async/await`、Serverless

## 0. 本讲定位：并行计算之外，还有大量时间花在“等”

[上一讲](18-parallel-algorithms.md)从计算图出发讨论并行算法和并行数据结构：Mandelbrot 的像素彼此独立，适合静态切分；共享计数器、哈希表等结构则要利用 thread-local、分片和细粒度同步保存局部性。这些方法默认“有一批 CPU 工作要同时做”。

真实应用还有另一类 workload：Web 服务器等网络、GUI 等点击、数据库等磁盘、定时任务等 deadline。它们可能同时维护十万个逻辑任务，但任一时刻只有少量任务真正可运行。如果为每个等待都分配一个昂贵内核线程，资源和调度成本会先把系统拖垮；如果只用一个普通线程执行阻塞调用，一个等待又会冻住所有任务。

本讲比较两条解决路线：

```text
路线一：保留“像线程一样顺序写”的心智模型
        → 用户态线程/协程 → 非阻塞 I/O → goroutine

路线二：直接描述“事件完成后做什么”
        → callback → Promise/Future → async/await
```

二者最终都在做同一件事：**把不可运行的任务状态保存起来，只让 ready 的计算节点占用执行资源。** 前半讲从 malloc 的 fast/slow path 重温“先看 workload 再选抽象”，后半讲借 Web 历史解释事件编程为何成为主流，并把这个思路延伸到全栈与 Serverless。

[下一讲](20-cpu-gpu-simt.md)会继续沿计算图前进：本讲仍然是在 CPU 上安排并发节点；下一讲则追问 CPU 内部如何并行，以及为什么 SIMD/GPU/SIMT 能用更简单的调度执行海量同构节点。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 从 work、span、依赖边和 ready 节点解释并行与异步的共同计算图模型；
- 从 malloc workload 推导 small-object fast path 和 `mmap` slow path，而不是凭抽象复杂度猜性能；
- 列出一个 Linux 线程占用的用户态与内核资源，并正确解读 `VmSize`、RSS 和 `/proc/PID/task`；
- 说明用户态协程为何便宜、协作式切换保存什么，以及 stackful/stackless 的差别；
- 解释一个阻塞 syscall 为什么能停住承载它的全部协程；
- 用 `O_NONBLOCK`、`EAGAIN`、`epoll`、`eventfd` 和 `timerfd` 推导 reactor/event loop；
- 解释编译器怎样把“阻塞式顺序代码”改写成可暂停状态机；
- 准确描述 goroutine 与 OS thread 的 M:N 关系，不把 goroutine 当作魔法线程；
- 用 channel 表达数据流、同步与所有权转移，并读懂 Mandelbrot-Go 的 `done/select/finish` 计算图；
- 从 Web 1.0、XMLHttpRequest 和 jQuery 的历史解释事件编程的需求来源；
- 区分 JavaScript engine、host、event loop、task 和 Promise continuation；
- 解释 callback hell、Promise composition 与 `async/await` 的等价控制流；
- 说明全栈 JavaScript 与 Serverless 如何把本机异步调度扩展到应用生态和分布式资源调度；
- 判断线程、协程、事件循环和异步语法各自解决了什么、没有解决什么。

问题地图：

| 问题 | 最小答案 | 可观察证据 |
| --- | --- | --- |
| 为什么不为每个连接建一个线程？ | 可以，但每线程栈、内核 task 和切换有成本；高并发等待时利用率很低 | `/proc/self/status`、`/proc/self/task` |
| 协程为什么比线程轻？ | 创建、保存和切换主要发生在用户地址空间，可只保存活跃状态 | generator/协程调度实验 |
| 协程调用 `read()` 就自动异步吗？ | 不会；若 fd 是 blocking，承载它的 OS thread 仍会睡眠 | `O_NONBLOCK`、`EAGAIN`、`strace` |
| `epoll` 会替应用读取数据吗？ | 不会；它只报告 readiness，应用仍要 `read/write` 并处理 partial I/O | `epoll_timer` |
| goroutine 是“一 CPU 一线程”吗？ | 不是字面映射；Go runtime 把大量 goroutine 复用到若干 OS threads | runtime 调度与 `GOMAXPROCS` |
| channel 会自动消灭数据竞争吗？ | 只有遵守所有权/通信协议时才会；共享别名仍可被并发访问 | race detector/所有权图 |
| JavaScript “单线程”是否代表浏览器只有一条线程？ | 不代表；同一 agent 的 job run-to-completion，host 可并行做网络、渲染或 worker | Promise/timer 顺序实验 |
| `await` 会阻塞线程吗？ | 它暂停 async function，把后续注册为 continuation；当前 agent 可处理别的 job | Node/浏览器控制台实验 |
| `Promise.all` 是否启动任务？ | 它立即返回聚合 Promise；输入 Promise 对应的操作通常在构造时已启动 | 输出时间与网络面板 |

## 2. Review & Comments：先把“计算图”拿回来

### 2.1 计算图是并行与异步的共同语言

把一次执行画成有向图：节点是计算，边是数据或控制依赖。某节点的前驱全部完成后，它才进入 ready 集合。

```text
read request ─→ parse ─┬→ query A ─┐
                       └→ query B ─┼→ combine → send response
timer ─────────────────────────────┘
```

上一讲主要问：“ready 集合里同时有很多 CPU 节点，怎样分给多个处理器？”本讲主要问：“大多数节点尚未 ready，怎样保存它们，并在 I/O、timer 或前驱完成时高效唤醒？”

几个指标仍然有用：

- **work**：所有计算节点总成本；
- **span/critical path**：依赖图最长路径，决定理想最短完成时间；
- **parallelism**：同一时刻有多少 ready 的 CPU 节点；
- **concurrency**：系统同时维护多少尚未结束的逻辑任务；
- **waiting**：节点因 I/O、timer、channel 或依赖未满足而暂不可运行。

并发不等于并行。单线程 event loop 可以并发维护十万个网络请求，却一次只执行一个 handler；多核数值程序可以并行执行 64 个计算块，却没有复杂 I/O 等待。

### 2.2 并行算法：Mandelbrot 是静态图的理想例子

Mandelbrot 每个像素的迭代只依赖该像素坐标，像素间几乎无边，因此是 embarrassingly parallel。可以预先把图切成行、tile 或连续像素区间，线程只在最终合并或显示进度时通信。

这类静态图适合线程池、OpenMP，下一讲还会映射到 GPU。真正的服务端请求图则常在运行时才知道：数据库结果返回后才决定下一条查询，用户是否点击决定是否出现新节点，错误与取消还会剪掉一整条分支。这正是 Promise 所谓“动态计算图”的背景。

### 2.3 并行数据结构：把计算留在线程本地

上一讲的 sloppy counter、thread-local storage 和 per-bucket lock 都依赖访问局部性：尽量让数据和修改留在一个线程/分片，偶尔再合并。这样既减少锁竞争，也减少缓存行在处理器间来回迁移。

本讲开头重访 malloc，不是在离题复习，而是要抽取同一个设计方法：

```text
观察真实请求分布
  → 识别占多数、可局部完成的 common case
  → 为它建立极短 fast path
  → 把补充资源、全局协调和罕见情况推给 slow path
```

event loop、goroutine scheduler 乃至 Serverless 平台也会反复使用这个结构。

## 3. 例子：实现 `malloc/free`——workload 先于优化

### 3.1 “Premature optimization”不是拒绝测量

Knuth 的提醒常被误读成“先随便写，永远不要考虑性能”。讲义强调的恰好相反：**在优化前，先明确真实 workload 和要优化的指标。**

allocator 可能关心：

- 小对象吞吐、平均延迟和 p99 延迟；
- 多线程扩展性与缓存行迁移；
- 内部/外部碎片和峰值 RSS；
- 大对象归还操作系统的速度；
- 安全加固、调试信息和 use-after-free 检测；
- 正常分布与 adversarial 请求下的最坏行为。

“实际系统通常不按算法题式 adversarial worst case 优化”不等于可以无视攻击者。哈希碰撞、分配耗尽和碎片操纵都可能变成拒绝服务。工程上常为正常路径优化，同时为恶意输入设置配额、超时和退化上界。

### 3.2 从对象大小与生命周期推导请求分布

讲义给出一个经验观察：若申请 16 MiB，只顺序扫一遍就立刻释放，分配、缺页和清零成本可能与有效计算同量级，常提示 performance bug。大对象通常会被使用足够久、读写足够多次，才能摊薄管理成本。

由此推导：越小的对象通常越频繁创建和回收。

| 类别 | 典型对象 | 常见生命周期 | 设计关注点 |
| --- | --- | --- | --- |
| 小 | 字符串、AST 节点、临时消息 | 极短到很长都有 | 高频、线程局部、低锁开销 |
| 中 | 容器、请求状态、复杂对象 | 较长 | size class、碎片、缓存复用 |
| 大 | 大数组、arena、模型缓冲 | 通常更长 | page mapping、NUMA、归还 OS |

这不是 C 标准或 `malloc(3)` 的语义保证，而是需要用 production trace、benchmark 和 profiler 验证的 workload 假设。某些程序会大量短命大分配，allocator 或应用就要另做设计。

### 3.3 实现 `malloc/free: 观察`——为什么先管好小对象

对小对象，每次都 `mmap` 至少要进入内核、维护 VMA，并按页面粒度管理，远大于一次指针递增。高性能 allocator 因而批量向 OS 申请 page/span，再在用户态切成固定大小对象。

多线程下，小对象操作若都争一个全局 free list，会像所有线程执行 `sum++`：即便临界区很短，缓存行和锁仍成为扩展瓶颈。自然选择是：

```text
每线程/每 CPU cache
  ├─ size class 16 B → 若干 free objects
  ├─ size class 32 B → 若干 free objects
  ├─ ...
  └─ size class 4 KiB → 若干 free objects
```

多数 allocate/free 在本地完成；本地 slab 空或过满时，才和中央结构交换一批对象。大请求则可绕过小对象路径，直接使用 `mmap` 一类机制。glibc 的具体阈值和 arena 策略会随版本、配置和历史变化，不应把“所有大对象都直接 mmap”当作 API 契约。

### 3.4 区分 Fast/Slow Paths：用空间换短路径

Segregated free list/slab 为每个 size class 管理等大小槽位：

```text
fast allocate: 从线程本地 free list 弹出一个槽       O(1)
fast free:     把槽插回合适链表                     O(1)
slow refill:   从中央池取一批，必要时向 OS 申请页面
slow drain:    本地缓存过多时归还中央池/OS
```

这和 sloppy counter 很像，甚至没有“全局读者”：每次请求只看线程本地元数据，偶尔批量同步。代价是更多预留空间、内部碎片、跨线程 free 的 remote queue、缓存失衡和更复杂的回收策略。

所谓 O(1) 回收只描述定位 size class、链接空闲槽等局部操作；它不代表整个 allocator 没有锁、缺页、合并、清零、安全检查或 cache miss。

可以运行仓库中的最小机制示例：

```bash
make -C examples mini_malloc
./examples/mini_malloc
```

它会显示释放 `a` 后，较小的 `c` 复用 `a` 的 first-fit 空间。这个例子能观察块头、切分和复用，却**不能**证明 first-fit 适合真实 malloc workload，也没有实现 per-thread slab；它恰好是“机制能工作”和“策略够高效”之间的基线。

### 3.5 “年轻的你们对现实的恐怖一无所知”：先观察真实程序

讲义回到 [1995 年 allocator survey](http://jyywiki.cn/OS/manuals/malloc-survey.pdf)，并指出 segregated free lists 在 1964 年已被提出。历史线索的用意不是崇古，而是提醒：漂亮的新数据结构未必胜过几十年围绕真实分布打磨的简单机制。

研究与工程在这里需要同一步：先描述程序究竟分配什么、活多久、由谁释放、怎样并发，再决定理论模型和优化目标。脱离 workload 比较平衡树、链表或 slab，只是在比较没有落地条件的符号。

这段复习给本讲后续立下标准：协程和异步也不能只说“创建快”。还要问任务是在算还是在等、调用的 I/O 能否非阻塞、handler 多长、取消怎样传播，以及过载时队列会不会无限增长。

## 4. 线程的代价：内核执行流不是函数调用

### 4.1 一个 Linux 线程占用什么

POSIX 线程共享进程地址空间和多数资源，但每条执行流仍需要：

- 用户栈及 guard page；默认栈常预留很大虚拟地址，未触页部分不占等量 RSS；
- TLS、线程控制块和 libc/pthread 元数据；
- 内核 task 结构、调度状态、内核栈、信号/凭据相关引用；
- 一个 TID，在 PID namespace 的编号空间中分配并最终复用；
- 保存寄存器、统计量和 `/proc/PID/task/TID` 等可观察状态；
- 创建、退出、join 和调度时的同步与缓存代价。

Linux 内核把每个 thread 当作 schedulable task。进程的 PID 通常指 thread-group leader，其他线程有各自 TID；因此“线程也占一个 pid”是有用直觉，但 API 中 PID/TID/thread-group ID 仍要精确区分。

上下文切换也不只是保存几个寄存器。进入调度器、修改运行队列、切换地址空间或 TLS 状态、破坏 cache/branch predictor 局部性都可能产生成本。数值依赖 CPU、内核、工作集和切换原因，不能背一个固定纳秒数。

### 4.2 实验一：用 `/proc` 测线程资源，而不是猜一个常数

依赖：Linux procfs、Python 3。Python 的 `threading.Thread` 在常规 CPython/Linux 上对应原生线程；GIL 会限制 Python bytecode 并行，却不妨碍我们观察线程资源。

```bash
python3 - <<'PY'
import os
import threading

def snapshot(label):
    keys = {
        "Threads", "VmSize", "VmRSS",
        "voluntary_ctxt_switches", "nonvoluntary_ctxt_switches",
    }
    values = {}
    with open("/proc/self/status", encoding="ascii") as status:
        for line in status:
            key, _, value = line.partition(":")
            if key in keys:
                values[key] = value.strip()
    tasks = len(os.listdir("/proc/self/task"))
    print(label, "tasks=", tasks, values)

gate = threading.Event()
snapshot("before")
threads = [threading.Thread(target=gate.wait) for _ in range(64)]
for thread in threads:
    thread.start()
snapshot("during")
gate.set()
for thread in threads:
    thread.join()
snapshot("after")
PY
```

典型现象：

- `Threads` 和 `/proc/self/task` 从 1 增到 65，再回到 1；
- `VmSize` 可能增加数 GiB，因为默认栈、guard、allocator arena 等保留了地址范围；
- `VmRSS` 通常只增加少量，因为等待线程没有触碰完整栈；
- join 后 `VmSize` 未必回到原值，运行库可能缓存栈或 arena；
- context-switch 计数会变化，但这个短实验不适合换算单次成本。

输出强烈依赖 Python/libc 默认栈、地址空间、容器限制和线程数。实验目标不是得出“一个线程恰好 N MiB”，而是学会选取可计数资源、改变一个变量、重复测量并解释虚拟内存与物理驻留的差别。

若要继续，可把线程数改为 1、8、32、128，读取每个 `/proc/self/task/TID/status`，并用 `/usr/bin/time -v` 记录峰值 RSS。不要在共享机器上无上限创建线程：TID、内存和 cgroup `pids.max` 都是有限资源。

### 4.3 为什么我们想要“随时随地”的并行计算

理想 API 像函数调用：

```text
t1 = spawn(f); t2 = spawn(g); t3 = spawn(h);
join(t1);      join(t2);      join(t3);
```

若 spawn/join 足够便宜，程序员可以直接把计算图分叉写出来，而不必手工维护固定线程池。但内核线程的创建与调度远大于普通 call/return，细粒度任务会让管理成本超过计算。

讲义提出两种办法：

1. **轻量化执行流**：让大量逻辑线程映射到少量内核线程，保留 spawn/join 的顺序心智模型；
2. **异步计算图**：用 job、Future/Promise 和 callback 显式描述依赖，执行器只调度 ready 节点。

二者并不互斥。现代 runtime 常让 `async` task 在线程池上运行，也可在 goroutine 内用 Future；差别在抽象的状态放在哪里、谁负责挂起与恢复。

## 5. 方案一：在用户空间实现“线程”

### 5.1 放弃中断驱动切换，改在 `yield` 处合作

内核线程可在时钟中断、缺页、阻塞或更高优先级任务出现时被抢占。最小用户态线程则只在显式 `yield` 或 runtime 知道的 suspension point 切换：

```text
running coroutine
  → 保存 continuation/寄存器/栈位置
  → 放回 runnable queue
  → 选择另一 coroutine
  → 恢复其状态并继续
```

切换不必进入内核，也不必为每个执行流维护完整内核 task，因而可以创建远多于 OS threads 的逻辑任务。调度器像一个运行在进程里的“小操作系统”：维护 runnable、waiting、finished 状态和 join 关系。

### 5.2 stackful 与 stackless：状态保存在哪里

两类常见实现是：

- **stackful coroutine/fiber**：每个协程有自己的栈；切换保存栈指针、callee-saved registers 等。普通嵌套函数都能自然挂起，但栈预留、增长和扫描更复杂；
- **stackless coroutine/generator**：编译器把函数拆成状态机，把跨 suspension point 仍活跃的局部变量放进 frame/closure。每任务更紧凑，但挂起必须沿语法允许的位置传播。

Python generator 的 `yield`、C++20 coroutine 和许多 `async fn` 属于后一种思想。讲义特别指出 nested yield 麻烦：如果深层 `h()` 想挂起，而 `g()`、`f()` 都是普通函数，那么 continuation 不只在 `h`；语言要么要求整条调用链都标记/传播 coroutine，要么提供 stackful 保存。

### 5.3 “一百万 generator”的小 OS 模型

讲义用如下伪代码表达机制：

```python
threads = [T_worker(i) for i in range(1_000_000)]
while True:
    random.choice(threads).send(None)
```

每个 generator 保存自己的程序计数位置和活跃局部变量，`.send(None)` 恢复它直到下个 `yield`。真实 scheduler 不会每次随机扫描一百万任务，而会维护 ready queue、timer heap、I/O wait map 和完成队列；只有 runnable task 应进入调度候选。

用户态切换便宜，不等于用户态任务可以无限创建。每个 task 仍有 frame、引用、队列节点和业务状态；一百万个等待请求也可能耗尽堆。并发上限、背压和取消仍不可少。

### 5.4 实验二：一个 blocking call 冻住整个协作调度器

下面用 generator 写最小 round-robin scheduler。依赖 Python 3：

```bash
python3 - <<'PY'
import collections
import time

start = time.monotonic()

def stamp(message):
    print(f"{time.monotonic() - start:5.3f}s {message}")

def heartbeat():
    for i in range(3):
        stamp(f"heartbeat {i}")
        yield

def blocker():
    stamp("blocking sleep begins")
    time.sleep(0.6)       # 真正阻塞承载 scheduler 的 OS thread
    stamp("blocking sleep ends")
    yield

ready = collections.deque([heartbeat(), blocker()])
while ready:
    task = ready.popleft()
    try:
        next(task)
        ready.append(task)
    except StopIteration:
        pass
PY
```

预期 `heartbeat 0` 后立刻进入 `blocking sleep begins`，接下来约 0.6 秒没有任何 heartbeat；直到 `sleep` 返回，调度器才能再次取得控制。generator 数量再多也无济于事，因为内核只看到承载 scheduler 的那一条执行流。

这也解释讲义的“一个协程等待，1,000,000 个都等待”。类似地，若 coroutine A 持有用户态 mutex 后 yield，coroutine B 却调用会把唯一 OS thread 睡眠的 blocking `mutex_lock`，A 再也没有机会运行并解锁，便形成同类自锁/AA 型死局。

协作调度还有公平性问题：一个从不 `yield` 的 CPU 死循环会饿死其他任务。现代 runtime 可插入抢占检查或利用信号/安全点改善，但这又增加了编译器和 runtime 复杂度。

## 6. 协程的缺陷与解决：异步 I/O + readiness

### 6.1 `O_NONBLOCK` 把“等待完成”从 syscall 中拆出来

blocking fd 上的 `read(fd, buf, n)` 在暂时无数据时让调用线程睡眠。对 nonblocking fd，同样情况立即失败并设置 `errno = EAGAIN`/`EWOULDBLOCK`；应用保存任务状态，转去执行其他 ready task。

```c
ssize_t count = read(fd, buf, size);
if (count > 0) {
  /* 消费 count 字节；一次 read 不保证填满 size */
} else if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
  /* 当前不可读：把任务登记到 fd 的 readable waiters，然后 yield */
} else if (count == 0) {
  /* EOF */
} else {
  /* 真实错误 */
}
```

“非阻塞”不是 I/O 瞬间完成，而是 syscall 不再与设备完成同步。应用还需要一个高效问题：“成千上万个 fd 中，哪些现在 ready？”逐个轮询会空耗 CPU，Linux 用 `epoll` 回答；BSD/macOS 有 kqueue，其他系统有各自机制。

### 6.2 `epoll` 主循环：只为 ready 节点恢复协程

一个 reactor 的最小状态机是：

```text
提交任务
  → 尝试非阻塞 I/O
  → EAGAIN: task 进入 waiters[fd]
  → epoll_wait 睡眠，直到若干 fd ready
  → 将对应 task 放回 ready queue
  → task 从 suspension point 继续
```

`epoll` 报的是 readiness，不替应用传输数据，也不保证一次 `read/write` 完成全部请求。edge-triggered 模式通常要一直读到 `EAGAIN`；level-triggered 则在条件仍成立时继续报告。连接关闭、半关闭、error/hangup 与 fd 复用都要纳入状态机。

Linux 还把多种事件源包装成 fd：

- `eventfd`：计数器式通知，可让线程/协程向 event loop 投递事件；
- `timerfd`：deadline 到期后可读，统一 timer 与 I/O 等待；
- `signalfd`：在合适屏蔽协议下把信号变成可读事件；
- pipe/socket：天然进入 readiness 模型；
- `io_uring`：更偏 completion 模型，提交操作后收完成项，不等同于 `epoll` 的 readiness。

“设计成 fd 就可被 `epoll` 监听”体现 UNIX 对象抽象的组合性：事件循环无需为 timer、线程通知和 socket 各维护一套完全独立的等待 API。

### 6.3 实验三：复用 `epoll_timer` 观察单线程多事件源

依赖：Linux、C 编译器。构建并运行仓库示例：

```bash
make -C examples epoll_timer
./examples/epoll_timer
```

典型输出为：

```text
event loop: timer=fast expirations=1
event loop: timer=slow expirations=1
event loop: timer=fast expirations=1
event loop: timer=fast expirations=1
event loop: timer=slow expirations=1
event loop: timer=fast expirations=1
```

源码建立 120 ms 与 200 ms 两个周期 `timerfd`，都注册进同一个 `epoll` instance。进程只有一个主线程，却能按 readiness 交错响应两个逻辑时间源：

1. `timerfd_create(CLOCK_MONOTONIC, TFD_CLOEXEC)` 创建 fd；
2. `timerfd_settime` 安排周期；
3. `epoll_ctl(ADD)` 订阅 `EPOLLIN`；
4. `epoll_wait` 在没有 ready 事件时让唯一线程睡眠；
5. `read(timerfd)` 取出 64-bit expiration count，并重新等待。

若 handler 故意忙很久，`expirations` 可能大于 1：timerfd 用计数合并多次到期，event queue 不必为每个 tick 无限堆节点。这正是过载时“事件语义”必须明确的例子。

有权限使用 `ptrace` 时，可观察系统调用：

```bash
strace -e trace=epoll_create1,epoll_ctl,epoll_wait,\
timerfd_create,timerfd_settime,read,close \
  ./examples/epoll_timer
```

容器或受限实验环境可能禁止 `strace`；程序本身仍可运行。trace 应显示两个 timer fd 被加入 epoll，随后 `epoll_wait → read` 反复交替。把 timerfd 换成 nonblocking socket，主循环结构不变，只是 handler 要处理 partial read/write、EOF 和错误。

## 7. 一个 Programming-Language Trick：让同步写法生成异步状态机

### 7.1 程序员想写的是等待条件，不是 `EAGAIN` plumbing

最自然的顺序代码是：

```c
sleep(1);            /* wait_until(now >= deadline) */
read(fd, buf, size); /* wait_until(fd has data) */
```

手写协程会把它展开：

```c
register_timer(deadline);
save_continuation_and_yield();

while ((n = read_nonblock(fd, buf, size)) < 0 && errno == EAGAIN) {
  register_read_interest(fd);
  save_continuation_and_yield();
}
```

真实 runtime 不应在 runnable queue 中忙等 `EAGAIN`；它会把 task 停放在 timer heap 或 fd waiter map，事件就绪后再恢复。编译器负责把 suspension point 之后的代码变成另一个状态，把仍活跃的局部变量提升进 coroutine frame。

概念改写如下：

```text
source:
  x = await read(fd)
  use(x)

generated state machine:
  state 0: submit/register read; state = 1; return Pending
  state 1: x = completed_result; use(x); return Ready
```

这就是“同步的写法表达异步的流程”。语法让顺序依赖重新聚在一起，底层仍是计算图、事件登记和 continuation。

### 7.2 goroutine：轻量执行流 + runtime 调度 + I/O 集成

讲义用“恭喜你发明了 goroutine”概括这条路线。更精确地说，Go runtime 将大量 goroutine 复用到多个 OS threads；goroutine 栈从较小规模开始并按需增长，runtime scheduler、network poller 和 syscall 处理共同避免一个普通网络等待冻住全部任务。

不能把实现机械理解为“每个 CPU 永久对应恰好一个 worker thread”。`GOMAXPROCS` 控制可同时执行 Go 代码的处理器资源，runtime 可维护、停放或增加 OS threads；阻塞 syscall、cgo 和垃圾回收都影响映射。Go 官方 [Effective Go](https://go.dev/doc/effective_go#goroutines) 将 goroutine 描述为复用在多个 OS threads 上的轻量执行流，而调度具体顺序并不是语言契约。

goroutine 的优点是 blocking-style API 易读，runtime 替程序员完成大量 parking/resume 工作。它仍没有消除：

- CPU-bound goroutine 对核心的竞争；
- 共享内存 data race；
- goroutine leak 和无界队列；
- deadline、取消和错误传播；
- 某些不可由 runtime 接管的阻塞外部调用；
- 调度、公平、GC 和 stack growth 的 runtime 成本。

抽象降低 common case 的认知成本，不会让资源守恒失效。

## 8. Go 语言中的同步与通信：让边同时携带数据

### 8.1 channel 把同步点与数据传递合并

共享内存并非“万恶之源”——mutex 保护一个计数器可能正是最清楚的方案。讲义的强调在于：信号量/条件变量只表达“现在可继续”，业务数据还放在另一个共享对象里；若锁和数据协议脱节，就会出现竞态。

channel 让计算图的边同时携带值：

```text
producer -- value --> channel -- value --> consumer
             发送/接收还定义同步关系
```

无缓冲 channel 是 rendezvous：send 与 receive 配对才完成；有缓冲 channel 则允许有限队列，满时发送者阻塞、空时接收者阻塞。容量于是既是性能参数，也是 backpressure 边界。

[Effective Go 的原话与示例](https://go.dev/doc/effective_go#sharing)把理念概括为“不要通过共享内存通信；通过通信来共享内存”。官方 [Share Memory by Communicating Codewalk](https://go.dev/doc/codewalk/sharemem/)进一步用 channel 转移对象引用的所有权：只要协议保证同一时刻只有接收方访问，就无需为该对象再加锁。

但 channel 发送一个 pointer 并不会在语言层自动销毁发送方别名。若两边继续读写同一对象，data race 仍存在；正确性来自所有权约定和 Go memory model，而不是 `chan` 三个字母。

### 8.2 UNIX pipeline 是同一思想的祖先

```bash
(cat ./*.txt; cat ./*.cpp) | wc -l
```

左侧生产字节，pipe 提供有界缓冲和阻塞同步，右侧消费并归约。Go channel 可看作类型化、进程内、first-class 的通信边；`select` 又能同时等待多条边。

Go 与 UNIX 的联系并非只来自 Rob Pike、Ken Thompson、Russ Cox 的经历，更在设计方法：小执行单元通过明确通道组合，比所有参与者随意修改一大片共享状态更容易形成局部推理。

也不能把二者完全等同：UNIX pipe 是内核字节流，没有消息边界和静态类型；Go channel 传递类型化值、具有 close 和 buffer 语义，作用于同一 Go runtime。跨进程、崩溃隔离和权限边界也不同。

### 8.3 Mandelbrot-Go：计算、进度与完成组成动态计算图

课堂 Demo 的结构是：

```text
main
  ├─ spawn row/chunk workers ──计算 Mandelbrot──┐
  │                                             ├→ done channel
  └─ spawn monitor ── select(done, timer) ──────┘
                           │
                           ├→ 定时预览当前图像
                           └→ 全部完成后发送 finish

main ←────────────── receive finish ────────────┘
```

多个 goroutine 按行分块计算，完成后经 `done` 汇报；monitor 用 `select` 同时等待完成信号与 timer tick，因此既能统计进度，也能定期渲染中间结果；最后通过 `finish` 通知主 goroutine 退出。

这里有三层值得分开：

- Mandelbrot 像素的数学独立性提供 parallelism；
- goroutine/runtime 把 ready 计算映射到 CPU；
- channel 形成 completion edge，timer channel 形成外部事件 edge。

按行切分虽简单，但不同区域逃逸迭代次数不同，行的计算量并不完全均匀。动态 task queue 或更细 tile 可改善 load balance；粒度太细又会让 channel、调度和预览同步开销盖过计算。仍然必须回到 workload。

若每个 worker 直接并发写终端或 GUI，输出会争用并破坏显示状态；让 monitor 单独拥有渲染对象，是“通过通信转移所有权”的具体应用。

## 9. 方案二：描述计算图——JavaScript 的平行世界线

### 9.1 1995 年、Netscape 与十天诞生的语言

讲义转向另一条历史路径。1995 年 Brendan Eich 加入 Netscape，为网页设计脚本语言；短时间内糅合 C 风格语法、Java 式外观、Scheme 的 first-class function/closure 和 Self 的 prototype 思想。

历史偶然决定了今天数十亿设备上的默认脚本语言。函数可以作为值与闭包捕获环境，后来恰好非常适合“事件完成后调用这个函数”的 callback 模型；早期兼容包袱也长期保留。

### 9.2 `this` 的意外提醒：语言语义要看调用形式

JavaScript 的普通函数 `this` 主要由调用方式决定，不等同于 C++/Java 的固定 receiver，也不等同于 Python 显式 `self`：

```javascript
const obj = {
  value: 42,
  show() { console.log(this.value); }
};

obj.show();       // method call: this 通常是 obj
const f = obj.show;
f();              // strict mode 下 this 是 undefined；访问会失败
```

箭头函数又采用 lexical `this`。这页“JavaScript Trinity”笑话承担的论证是：Web 生态不是从一套完美语言设计展开，而是在历史兼容、意外语义和不断增加的抽象上成长。学习异步 API 时同样要看精确语义，不能只凭“像线程”或“像顺序代码”的外观。

## 10. 互联网时代的序幕：Web 1.0 与事件编程

### 10.1 从 PC 时代到网页文档

1990 年代，Amazon 和 Yahoo（1994）、eBay（1995）、Google（1998）等服务相继出现，中国的新浪、搜狐、网易也进入早期互联网。Web 的基础最初很朴素：HTTP 传输文档，HTML 描述内容，CSS 尚未成为成熟布局工具。

可以直接观察协议表面：

```bash
curl -i https://example.com/
```

输出先是状态行和 headers，空行后是 HTML body。现代命令还涉及 TLS、HTTP/2/3、代理等层，`curl -i` 展示的是 curl 统一后的 HTTP 语义，不一定是网线上逐字的 HTTP/1 文本。

早期页面大量使用 `<font>`、`<table>` 和切图完成视觉布局。交互主要是点击链接、提交表单、整页刷新；浏览器依然天然是事件系统：网络数据到达、定时器到期、鼠标键盘输入后，host 把相应 handler 排入执行队列。

### 10.2 Web 和事件编程 Demo：外观重写，事件骨架保留

课堂从充满 `setInterval`、DOM 操作和动画的 `shopper.html` 出发，再用 `modernize.js` 把页面快速改造成现代风格。Demo 不只是“旧网页变漂亮”，而是在展示分层：

```text
HTML/DOM         保存界面结构与状态
CSS              决定表现
JavaScript       注册事件、定时更新、变换 DOM
browser host     产生 timer/input/network 事件并调度 callback
```

只要事件与状态接口仍在，就可以替换表现层而保留大部分交互图。反过来，随意把状态变化散落在许多 timer/callback 中，也会迅速形成难以追踪的动态依赖。

## 11. 从 Web 1.0 到 Web 2.0：后台请求让页面成为应用

### 11.1 XMLHttpRequest：I/O 完成后再更新 DOM

约 1999 年出现的 XMLHttpRequest（后来由 AJAX 这一名字推广）允许页面不整页跳转便发出请求。`X` 指 XML 并不奇怪：当时 Java 后端和企业系统广泛使用 XML；JSON 后来才成为 Web API 常见格式。

控制流变成：

```text
用户输入
  → 发起异步 HTTP request，立即返回 event loop
  → 网络在 host/OS 中推进
  → response ready，callback 入队
  → callback 更新 DOM subtree
```

页面于是能后台刷新、增量更新和维持客户端状态。数据 model、DOM view 和请求/事件 controller 的分离，让浏览器从“文档阅读器”走向通用应用平台。

### 11.2 jQuery `$`：DOM query 与跨浏览器抽象

2006 年的 jQuery 用 `$` 提供短小的 selector、事件、DOM 更新和 AJAX API：

```javascript
$(document).ready(function () {
  $("#myElement").text("新内容").css("color", "red");
});
```

今天 `document.querySelector()`/`querySelectorAll()` 覆盖了核心选择能力，标准 DOM、`fetch` 和现代浏览器也消除了许多兼容痛点；但 `$` 并不字面等于 `querySelector`，jQuery 对象还提供集合操作、链式 API、事件与动画等语义。

这段历史再次说明抽象来自 workload：当主要痛点是浏览器差异、DOM 查询冗长和异步请求样板时，一个 query-language-like API 就能改变生态。

### 11.3 从此“任何事”都可在浏览器里做

HTML + CSS 的声明式界面、URL/HTTP 分发和无需安装的运行环境，让 Web UI 的开发与部署成本常低于 GTK、Qt、MFC 等传统 GUI。在线文档等应用证明网页可以承担复杂交互；ChromeOS 把“浏览器即平台”推到操作系统产品层，微信小程序等平台也继承了受控 Web runtime + 应用分发的思路。

讲义以“ChromeOS/Chromebook 没能成功”作戏谑式评价，重点不应落在某一时点的市场输赢，而是这条技术路线留下的生态：浏览器已经成为操作系统之上的另一个应用 ABI，Web 技术还能被打包回桌面、移动端和命令行。

## 12. JavaScript 并发编程：同一 agent 内禁止节点并行

### 12.1 为什么不给每个网页默认共享内存线程

如果任意 DOM handler 都可在多个抢占式线程中同时运行，初学者立即要面对 data race、atomicity violation、DOM 锁和 callback 重入。浏览器选择更简单的默认模型：同一 JavaScript agent 一次执行一个 job，每个 job **run to completion**，完成后才取下一个。

这带来局部原子性：一个普通 handler 执行期间，另一个同 agent handler 不会在任意指令处插入并修改同一对象。代价是长计算会冻结点击、滚动和重绘；“单线程”不是性能保证，而是可推理性选择。

精确边界是：

- ECMAScript engine 执行语言和 job；
- browser/Node host 提供 timer、DOM、network、filesystem 等 API；
- host 与 OS 可在其他线程/进程推进 I/O、渲染和编译；
- Web Worker/worker thread 是其他 agent；`SharedArrayBuffer` 等机制重新引入共享内存并发；
- 同一 agent 的 callback 仍按队列与优先级规则串行运行。

[MDN 的 JavaScript execution model](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Execution_model)将其描述为 stack、heap 与 job queue 的协作，并明确每个 job run-to-completion。它是心智模型；浏览器可在不改变可观察语义的前提下内部优化。

### 12.2 “没有 Blocking I/O”的真正含义

网页脚本通常不能调用一个同步 `read(socket)` 把 agent 挂起。它发起 `fetch` 或注册 timer，API 很快返回；操作完成后，host 把新的 event/callback job 加入队列。

```text
job A: issue request ──return──┐
                              │ event loop 可执行 click/timer 等 job
host/OS: network progresses ──┤
                              └→ enqueue continuation job B
job B: consume response
```

“没有任何 Blocking I/O”是讲义的设计模型，不是说 JavaScript 世界绝无同步 host API；历史上同步 XHR、`alert`，Node 的 `readFileSync` 等都能阻塞当前 agent。它们会破坏响应性，所以 UI 和高并发路径通常避免。

事件循环也没有让 CPU 工作自动并行。一个 2 秒纯 JavaScript 循环仍占住 agent 2 秒；应切块、交给 Worker，或使用后续课程中的并行计算机制。

## 13. 事件编程、计算图与回调

### 13.1 callback 动态创建后继节点

异步函数发起工作时注册 success/error callback；完成事件发生后，callback 被排队。每次回调又可发起新操作，于是运行时动态扩展计算图：

```text
fetch user
  ├─ success(user) → fetch friends
  │                    ├─ success(friends) → fetch first friend
  │                    └─ error
  └─ error
```

callback 本身不是“另一个线程”。它只是将来某个 job 的函数；具体何时排队、在哪个 agent 执行由 host/API 规定。

### 13.2 Callback hell：顺序逻辑被空间结构撕开

若 A 的结果决定 B，B 再决定 C，嵌套 callback 会把本来线性的控制流变成右向金字塔：

```javascript
getUser(
  user => getFriends(
    user.id,
    friends => getFriend(
      friends[0].id,
      friend => show(friend),
      err => showError(err)
    ),
    err => showError(err)
  ),
  err => showError(err)
);
```

问题不只是缩进：错误在每层重复，超时和取消难传播，资源清理分散，多个并行分支的 join 更难表达，callback 还可能被错误地调用零次或多次。A → B → C 的逻辑顺序被拆成相隔很远的 closure。

命名函数、统一 error-first convention 和控制流库可以缓解，但更根本的抽象是让“未来结果”本身成为可组合对象。

## 14. 回归“描述计算图”：Promise 是未来节点的 handle

### 14.1 Promise 的最小状态机

Promise 表示一个未来值：

```text
pending ──fulfill(value)──→ fulfilled
        └─reject(error)───→ rejected
```

settle 后状态不再改变。`.then(onFulfilled, onRejected)` 不会原地修改原 Promise，而是立即返回一个**新的 Promise**；callback 的返回值、抛出的异常或返回的另一个 Promise 决定新节点结果。于是链式写法直接表达 A → B → C：

```javascript
fetch("/api/user")
  .then(response => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  })
  .then(user => fetch(`/api/user/${user.id}/friends`))
  .then(response => response.json())
  .then(friends => show(friends))
  .catch(error => showError(error));
```

错误沿 Promise 链传播到合适 rejection handler，顺序边不再靠层层缩进表达。

### 14.2 `Promise.all` 表达 fork/join

```javascript
const all = Promise.all([
  fetch("/api/a").then(r => r.json()),
  fetch("/api/b").then(r => r.json()),
]);

all.then(([a, b]) => combine(a, b))
   .catch(error => showError(error));
```

`Promise.all()` 立即返回一个 aggregate Promise；输入全部 fulfill 后它按输入顺序给出结果，其中一个 reject 时 aggregate reject。这里要辨析：

- `Promise.all` 通常不负责“启动”传入操作；`fetch(...)` 在构造输入 Promise 时已经发起；
- aggregate reject 不会自动取消其他 fetch；取消需 `AbortController` 等显式协议；
- Promise 表示一次结果，不等同于线程、任务队列或可重复事件流；
- `fetch` 在 HTTP 404/500 时通常仍 fulfill，应用需检查 `response.ok`；网络层失败才 reject。

Promise 让动态计算图可组合，但没有自动给出并发上限、背压、deadline 或资源所有权。

### 14.3 React `useEffect` 例子的生命周期边界

讲义中的模式：

```javascript
useEffect(() => {
  fetch(`/api/localhost/?action=demo&path=${path}`)
    .then(response => response.json())
    .then(fetchedData => setData(fetchedData));
}, []);
```

表达“组件挂载后发请求，完成后更新 state”。但依赖数组 `[]` 表示 effect 不随 `path` 变化重跑；若 `path` 来自可变外部状态，这可能得到旧值。组件卸载、请求晚到、多个响应乱序也需要 cleanup/cancellation 或版本检查。

这说明 event loop 没有共享内存 data race，不等于没有**逻辑竞态**：两个请求的完成顺序可以与发起顺序不同，后到的旧结果可能覆盖新状态。计算图还必须编码生命周期。

## 15. Async/Await 语法糖：用顺序源码表达 Promise 图

### 15.1 `await` 暂停函数，不阻塞 agent

Promise chain 已比嵌套 callback 平坦，但每个 `.then` 仍把顺序代码切成 closure。`async/await` 让编译器/runtime 做 continuation 变换：

```javascript
async function fetchData(token) {
  const response = await fetch(
    `/api/submissions/?token=${encodeURIComponent(token)}`
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

const results = await Promise.all([
  fetchData("1234"),
  fetchData("5678"),
]);
```

语义上：

- 调用 `async function` 立即得到 Promise；普通 return 成为 fulfillment，throw 成为 rejection；
- `await x` 先按 Promise 语义吸收 `x`，若尚未完成就保存当前 async frame 并把控制还给调用者/event loop；
- Promise settle 后，函数剩余部分作为 continuation job 恢复；
- `try/catch/finally` 可重新表达跨异步边的错误与清理。

讲义的简写：

```text
async function f()  ≈ function f() { return new Promise(...) }
await f()           ≈ 暂停当前 async frame，并用 .then(...) 注册后继
```

只是在帮助建立直觉，完整规范还涉及 thenable assimilation、job queue、异常、`finally` 和 async function promise capability。

### 15.2 顺序 `await` 与并行 fork/join

下面写法建立串行边：

```javascript
const a = await fetchA();
const b = await fetchB();  // B 要等 A 完成后才开始
```

若 A、B 独立，应先发起再 join：

```javascript
const [a, b] = await Promise.all([fetchA(), fetchB()]);
```

`async/await` 改善局部可读性，却可能让不必要的串行依赖看起来很自然。代码审查仍要画计算图，判断哪些边是真依赖。

### 15.3 实验四：同步 job、Promise continuation 与 timer 的顺序

依赖：Node.js，或把代码粘贴进现代浏览器开发者控制台：

```bash
node - <<'JS'
console.log("A");

setTimeout(() => console.log("timer"), 0);

Promise.resolve().then(() => console.log("promise"));

(async () => {
  console.log("async-before");
  await 0;
  console.log("async-after");
})();

console.log("B");
JS
```

典型输出：

```text
A
async-before
B
promise
async-after
timer
```

解释：当前 script job 先 run-to-completion，所以 `A`、`async-before`、`B` 连续出现；`.then` 与 `await` 后半段排入 Promise job/microtask queue，当前栈清空后依注册顺序运行；timer callback 属于后续 task，因此在其后。

不要把“0 ms”理解为立即抢占。它表示最早到期时间，callback 仍要等 host 排队和 agent 空闲。浏览器与 Node 的完整 event-loop phases 不同，但这个例子的核心 Promise-before-timer 顺序在常规实现中可观察。

把一段 2 秒 busy loop 放在 `console.log("B")` 后，所有 continuation 和 timer 都会延迟，证明 `await`/Promise 没有另开 CPU 执行普通 JavaScript handler。

## 16. 从前端到全栈：浏览器之上长出新应用生态

### 16.1 ECMAScript 2015 与共同语言底座

早期 JavaScript 生态由大量第三方模块模式、兼容库和构建约定拼接。ECMAScript 2015（ES6）带来更统一的语言基础，模块、class/arrow/iterator 等能力与 Promise 时代的工具链一起推动开源生态扩张。

讲义列出的版图体现“同一计算/组件模型跨界复用”：

- 前端与样式：Angular、React、Vue、Bootstrap、Tailwind CSS；
- 服务端/全栈：Express、Next、Nest；
- 桌面：Electron 与 VS Code；
- 命令行 UI：Ink 与 Claude Code 一类 React-style TUI；
- 移动端：React Native；
- 低级计算载体：asm.js，继而 WebAssembly；
- 可视化与计算：Mermaid、TensorFlow.js、Three.js 等。

这些框架不是操作系统内核，却构成“OS 上的另一个应用生态”：浏览器/JS runtime 提供事件、网络、存储、渲染和沙箱的窄腰，上层用组件、Promise 和包管理继续组合。

### 16.2 前端模型为什么能走向服务器

服务器也拥有大量短计算 + 长 I/O 等待：接收请求、查缓存/数据库、调用下游、合并响应。event loop 能让少量线程维护大量连接；Promise/`async` 让请求计算图可读。于是同一种语言和异步抽象延伸到 API、SSR、构建工具与桌面壳。

但服务端不能只讲“nonblocking”：

- CPU-heavy handler 会堵住 event loop；
- 无界接收请求会撑爆内存和下游；
- thread pool、DNS、文件 I/O 和 native addon 可能成为隐藏资源池；
- 每个请求需要 deadline、取消、错误边界和 observability；
- 分布式调用还会部分失败、重试和重复执行。

全栈统一减少语言切换，却没有消除系统边界。

### 16.3 从本机 job queue 到 Serverless

当单机不够，平台可以把“事件到来 → 运行一个 handler”扩展到集群：HTTP 请求、消息、对象存储变化或 timer 触发函数；平台选择机器/容器、扩缩实例、回收空闲资源。开发者提交计算节点和触发边，基础设施负责部分调度，这就是理解 Serverless 的计算图视角。

```text
local event loop:
  event → enqueue callback → run on one process

serverless platform:
  event → durable queue/router → choose/create worker → run handler
```

它延续本讲的 workload 原则：突发、短时、长时间空闲的函数不值得永久占一台服务器；按需调度可提高资源利用率。代价也从本地切换成本升级为：

- cold start 与依赖加载延迟；
- 状态需外置，跨调用局部性变弱；
- timeout、quota、并发上限和成本模型；
- 消息可能重试，handler 要幂等或去重；
- 分布式 tracing、取消与 backpressure 更困难；
- 平台 API 与部署环境形成新的依赖。

Serverless 不是“没有服务器”，而是服务器生命周期与调度策略从应用代码移交给平台。它和协程/Promise 一样，用更高层抽象隐藏 common-case plumbing，同时保留必须显式管理的边界。

## 17. 统一比较：状态放在哪里，谁决定恢复

| 模型 | 每任务状态 | 等待方式 | 调度者 | 优点 | 主要边界 |
| --- | --- | --- | --- | --- | --- |
| OS thread | 内核 task + 用户栈/TLS | blocking syscall/内核 wait queue | 内核 scheduler | 顺序代码、抢占、多核直接 | 栈/内核资源、切换成本 |
| stackful coroutine/goroutine | 独立可增长栈/上下文 | runtime parking | 语言 runtime | 嵌套调用自然、任务轻 | runtime 集成、泄漏、共享竞态 |
| stackless coroutine/async task | 编译器生成 frame/state | await/register event | executor/event loop | 状态紧凑、无隐式栈 | async 传播、pin/lifetime 等复杂性 |
| callback/Promise | closure + future node | completion enqueue | host + job queue | 动态图组合、适合 I/O | callback 生命周期、取消/背压 |
| Serverless function | 外置事件 + 临时实例状态 | 平台队列/触发器 | 集群平台 | 弹性、按需资源 | cold start、分布式失败、外置状态 |

没有一种模型在所有 workload 上最优：

- 少量长寿命 CPU worker：OS threads/线程池很合适；
- 海量逻辑连接、顺序业务代码：goroutine/virtual thread 可能清楚；
- GUI 与网络 reactor：event loop + Promise/async 很自然；
- 大量同构数值节点：线程调度仍可能太贵，下一讲的 SIMD/GPU 更适合；
- 突发、无状态、事件触发的分布式任务：Serverless 才有吸引力。

共同原则是让调度粒度与 workload 匹配，并把 slow path、过载和失败当作设计的一部分。

## 18. 分层辨析与常见误区

### 18.1 语言语法、runtime、libc、内核与硬件

| 层次 | 本讲实例 | 不负责什么 |
| --- | --- | --- |
| 语言/编译器 | generator、`go`、channel、Promise、`async/await` | 不直接保证内核 I/O 非阻塞或多核并行 |
| runtime/host | goroutine scheduler、JS event loop、Promise job queue | 不能让阻塞 native call 或 CPU 死循环凭空消失 |
| libc/系统调用 wrapper | `read`、`fcntl`、pthread API | `O_NONBLOCK` readiness 语义最终由内核对象实现 |
| 内核 | thread scheduler、wait queue、`epoll`、timerfd、socket | 不理解业务 Promise 链或 React component |
| 硬件 | CPU core、cache、interrupt、DMA | 不直接执行“channel”或“Promise”这种语言抽象 |

### 18.2 高频误区

- **“并发就是并行。”** event loop 可并发而不并行；多核计算可并行但几乎不等待 I/O。
- **“一个 pthread 永远占完整默认栈的物理内存。”** 大量空间只是虚拟预留；触页后才进入 RSS，仍有 guard 和元数据成本。
- **“协程切换永远不进内核。”** 纯用户态 yield 可不进；缺页、timer、I/O、抢占和系统调用仍会进入内核。
- **“协程调用普通阻塞 I/O 也不会阻塞。”** 若 runtime 没有拦截/迁移，承载 OS thread 会睡眠。
- **“nonblocking read 保证马上读满。”** 它可能读部分、返回 EOF，或以 `EAGAIN` 表示现在没有数据。
- **“`epoll` 是异步读取 API。”** 它主要报告 readiness；数据仍由应用 syscall 传输。
- **“edge-triggered 只读一次即可。”** 通常要 drain 到 `EAGAIN`，否则可能错过后续边沿。
- **“goroutine 就是一 CPU 一个线程。”** 它是 runtime 管理的逻辑执行流，M:N 映射和调度不是语言固定比例。
- **“用了 channel 就没有共享内存。”** channel 可传 pointer；若所有权协议失守，仍会 data race。
- **“JavaScript 单线程，所以浏览器没有并行。”** network、render、worker 和其他 agent 可并行；run-to-completion 只约束相应 agent job。
- **“0 ms timer 立即执行。”** callback 至少要等当前 job 和更高优先级 microtask 完成。
- **“Promise 是后台线程。”** 它是未来结果和 continuation 的组合对象；CPU 代码仍在执行它的 agent/worker 上运行。
- **“`await` 会阻塞 event loop。”** 正常 Promise await 会挂起 async function；但 await 前后的 CPU 死循环或同步 API 仍会阻塞。
- **“没有 data race 就没有 race condition。”** 异步响应乱序、取消与生命周期仍会造成逻辑竞态。
- **“`Promise.all` 自动取消失败后的其他操作。”** 它聚合结果；取消要另有协议。
- **“async/await 自动提供并行。”** 连续 await 可能把独立工作串行化；要显式先发起再 join。
- **“Serverless 没有服务器和运维。”** 平台管理服务器，但应用仍要处理配额、冷启动、状态、重试和观测。

## 19. 本讲小结：保存等待，调度 ready

本讲从 malloc 一直走到 Serverless，表面跨度很大，底层结构却一致：

1. 先看 workload。allocator 的高频小对象与服务器的海量等待任务，需要不同于大对象/CPU-heavy job 的路径；
2. 建 fast/slow path。线程本地 slab 让 common allocation 不碰全局；event loop 只恢复 ready task，资源补充和阻塞交给 slow path；
3. OS thread 提供自然顺序语义和抢占，但栈、内核 task、TID 与切换都不是免费；
4. 用户态协程让 spawn/yield 变轻，却必须与 nonblocking I/O、timer 和 runtime scheduler 集成；
5. `epoll`、eventfd、timerfd 把不同等待源接进统一事件循环；
6. Go 用 goroutine 隐藏大量 continuation plumbing，用 channel 把数据和同步边结合；
7. Web 的历史把 event-based concurrency 推到大众应用：callback 表达动态节点，Promise 表达未来值与组合，`async/await` 恢复顺序源码；
8. 同一模式从前端进入全栈，并在 Serverless 中把事件调度扩展到集群；
9. 所有抽象都没有消除资源上限、取消、背压、错误、共享状态或 CPU 工作本身。

一句话总结：**异步不是“更快的线程”，而是承认等待节点暂时不能运行，把它的 continuation 保存起来，让有限执行资源只服务 ready 的计算图。**

## 20. 思考题与延伸实验

1. 实验一中 `VmSize` 增长远大于 `VmRSS`，这对“最多能创建多少线程”分别意味着什么？还会先碰到哪些 cgroup/内核上限？
2. 设计一组实验，把线程创建成本拆成 stack reservation、首次触页、内核 task 和 context switch；每组应控制哪些变量？
3. 一个 stackless coroutine 从 `f → g → h` 调用，只有 `h` 需要 await。语言为什么常要求 async 标记沿调用链传播？stackful 模型怎样不同？
4. 在实验二中把 `time.sleep` 改成“记录 deadline 后 yield”。scheduler 需要增加什么数据结构，才能不忙等又按时恢复？
5. 给 `epoll_timer` 增加 `eventfd`，由另一个 pthread 写入六次；event loop 如何区分 timer 与跨线程消息？注意检查 `write` 和 close 路径。
6. 若 epoll 报可读后，另一个线程先读走数据，本线程再 `read` 会怎样？为什么 nonblocking 仍是正确 event-loop 的必要条件？
7. Mandelbrot-Go 若每个像素发送一次 channel 消息，会发生什么？怎样用 tile、buffer 和单 owner renderer 调整粒度？
8. 无缓冲 channel 为什么同时表达通信与同步？有缓冲 channel 的容量从 0 改为 1，会改变哪些合法执行顺序？
9. 普通 goroutine 把同一个 slice pointer 发给两个 worker 后自己继续写，channel 是否保证安全？画出所有权别名。
10. callback API 若可能同步调用 callback，又可能异步调用，会给调用者状态机制造什么重入问题？Promise 为什么通常要求 reaction 异步排队？
11. 在实验四中交换 Promise `.then` 和 async IIFE 的注册顺序，预测输出；再加入嵌套 microtask，画出队列变化。
12. 两个搜索请求先后发出，旧请求最后返回。即使 JavaScript 没有 ordinary-memory data race，怎样覆盖新结果？请用 sequence number 或 AbortController 设计修复。
13. 比较 `await fetchA(); await fetchB();` 与 `await Promise.all(...)` 的计算图、错误传播和取消需求。
14. 一个 async server 每个请求都启动 100 个下游 Promise，为什么 event loop 仍可能过载？背压应加在哪些边？
15. Serverless 消息被至少一次投递时，扣款函数怎样做到重试不重复扣款？需要哪些持久状态与原子协议？
16. 为什么 Mandelbrot 的 next step 不是“再创建一百万个 OS threads”，而可能是 SIMD/GPU？比较调度开销、控制流一致性和数据局部性。

建议阅读本机 `man 2 open`、`man 7 epoll`、`man 2 eventfd`、`man 2 timerfd_create`，并结合本章实验核对。语言侧可阅读 [Go 的通信式并发 Codewalk](https://go.dev/doc/codewalk/sharemem/)与 [MDN JavaScript execution model](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Execution_model)。

## 21. 下一讲衔接：计算图已经 ready，CPU/GPU 怎样更便宜地执行

到这里，我们已经能管理两类图：线程/协程/Promise 处理动态 ready 节点，channel 和 join 表达依赖。但只要节点真正开始做 CPU 计算，它仍消耗指令调度、cache 和功耗。

下一讲《CPU、GPU 和 SIMT 编程模型》将先揭开单线程“顺序执行”的假象：现代 CPU 内部做乱序、超标量和指令级并行；再从功耗墙推导 SIMD 和更多简单处理器，最终解释 GPU 为什么适合把 Mandelbrot 这类同构节点批量调度。

```text
第 18 讲：怎样切分并行计算与数据结构
第 19 讲：怎样保存等待，只调度 ready 节点
第 20 讲：怎样摊薄每个 ready 节点的指令调度成本
```

异步提高的是执行资源利用率，不会自动提高单个 CPU-bound 节点的吞吐；GPU 提高海量同构计算吞吐，也不会自动替你处理 Web 请求的取消和错误。这两种扩展方向将在计算图上会合。

## 22. PPT 内容覆盖表

下表第一列按原讲义一级标题顺序列出；重复的 `cont’d` 合并但明确保留标题字样。

| 原讲义一级标题（按出现顺序） | 本章对应位置 | 覆盖要点 |
| --- | --- | --- |
| 异步编程模型 | §0–§1、§19 | 本讲问题、两条路线与统一计算图模型 |
| Review & Comments | §2 | 计算图、并行算法、并行数据结构与局部性 |
| 例子：实现 malloc/free | §3.1–§3.2 | workload、指标、大对象摊销与小对象频率 |
| 实现 malloc/free: 观察 | §3.3 | 小对象 scalability、线程本地、glibc 大对象边界 |
| 区分 Fast/Slow Paths | §3.4 | segregated list/slab、本地 fast path、`mmap`/refill slow path、O(1) 回收 |
| 年轻的你们对现实的恐怖一无所知 | §3.5 | 1964/1995 历史线索、先理解真实 program behavior |
| 线程的代价 | §4.1 | 栈、TLS、内核 task、TID、调度与 cache 成本 |
| `[线程的代价](/OS/demos/concurrency/thread-cost)` | §4.2 | 创建 64 线程并测 `/proc`、VmSize/RSS/task 数与实验方法 |
| 我们想要 “随时随地” 的并行计算 | §4.3 | spawn/join 粒度；轻量线程与异步计算图两条方案 |
| 在用户空间实现 “线程” | §5.1–§5.3 | cooperative yield、小 OS scheduler、stackful/stackless、百万 generator |
| `[轻量级线程的实现](/OS/demos/concurrency/coroutine)` | §5.1–§5.4 | 用户态状态保存、栈切换思路、blocking 实验 |
| 协程：缺陷与解决方法 | §5.4、§6 | 一个阻塞全体阻塞、mutex 自锁、`O_NONBLOCK/EAGAIN`、epoll/eventfd/timerfd/io_uring |
| 一个 Programming-Language Trick | §7 | blocking-style 语法到异步状态机，goroutine M:N runtime |
| Go 语言中的同步与通信 | §8.1–§8.2 | 共享内存问题、channel、UNIX pipe、CSP/所有权与边界 |
| `[Mandelbrot-Go](/OS/demos/concurrency/mandelbrot-go)` | §8.3 | 行分块 goroutine、`done`、monitor `select`、timer、`finish` |
| 另一条平行的世界线 / 另一条平行的世界线 (cont’d) | §9 | Brendan Eich、1995 Netscape、C/Java/Scheme/Self、动态 `this` |
| 互联网时代的序幕：Web 1.0 | §10.1 | 1990s 互联网、HTTP/HTML、`font/table`、`curl -i` |
| `[Web 和事件编程](/OS/demos/concurrency/web)` | §10.2 | `shopper.html`、`setInterval`、DOM、`modernize.js` 与分层 |
| 从 Web 1.0 到 Web 2.0 | §11 | XMLHttpRequest/XML、后台刷新、MVC、jQuery `$`、DOM query |
| 从此，做 “任何事” 都只要浏览器就行 | §11.3 | HTML/CSS 应用、ChromeOS、传统 GUI、微信小程序与浏览器平台 |
| JavaScript 并发编程 | §12 | 禁止同 agent 节点并行、run-to-completion、host 异步 I/O |
| 事件编程、计算图与回调 | §13 | success/error 动态节点、callback hell、错误/取消/清理分散 |
| 回归 “描述计算图” | §14 | Promise 状态、`.then` 新节点、React effect、`Promise.all` fork/join |
| Async/Await 语法糖 | §15 | async 返回 Promise、await continuation、顺序语法与并行 join |
| 从前端到全栈 | §16 | ES2015；Angular/React/Vue 等前端、服务端、桌面、移动、Wasm 与可视化生态 |
| Takeaways | §16.3、§17、§19–§21 | workload→合适抽象；slab/协程/计算图；单机到 Serverless；引向 CPU/GPU |
