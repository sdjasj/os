# 第 18 讲：并行算法与数据结构

> 原始讲义：[sources/notes/lect18.md](../../sources/notes/lect18.md)  
> 前一讲：[并发 Bug 和应对](17-concurrency-bugs.md)  
> 后一讲：[异步编程模型](19-async-model.md)  
> 配套示例：[parallel_sum.c](../../examples/parallel_sum.c)、[semaphore_dag.c](../../examples/semaphore_dag.c)  
> 本讲关键词：scalability、scale up、scale out、计算图、HPC、embarrassingly parallel、OpenMP、MPI、Mandelbrot、thread-local storage、sloppy counter、细粒度锁

## 0. 本讲定位：从“没有并发 Bug”走向“增加资源就更快”

上一讲研究 deadlock、data race、atomicity violation 和 order violation，回答的是 **并发程序怎样保持正确**。
把所有共享访问塞进一把 mutex，往往确实能消灭一批错误；但它也可能把 128 个线程重新排成单行。

本讲转而追问性能：

```text
正确的并发协议
      │
      ▼
减少共享与同步 ──→ 任务分解 ──→ 单机 scale up / 多机 scale out
      │                                │
      ├── 线程局部计算                 ├── 并行算法：计算图
      └── 缩小共享状态                 └── 并行数据结构：拆锁/原子
```

这里的先后关系不能颠倒。一个算错得更快的程序没有价值；一个偶尔死锁的 benchmark 也不能证明 scalability。
上一讲提供正确性地基，本讲在这块地基上研究怎样让更多 CPU、线程乃至机器真正贡献工作。

下一讲会继续追问：如果任务已经能分解，为什么不能“随时随地”创建海量线程？
线程的创建、切换和阻塞都有代价，于是课程将走向轻量级线程、协程、异步 I/O 和 async/await。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 解释 mutex 保护的 `sum++` 为什么正确却不能随线程数扩展；
- 区分 scale up 与 scale out，并用计算图的 work、depth 和 width 判断潜在并行度；
- 说明 HPC 为什么常能按空间、网格、矩阵块和时间轮次分解；
- 判断一个任务是否 embarrassingly parallel，并识别负载不均衡这一剩余问题；
- 说清 MPI 与 OpenMP 分别对应的通信模型和使用边界；
- 从像素独立性推导 Mandelbrot 的并行实现，而不是只记一个 pragma；
- 在不偷看答案的前提下，为 `gpt.c` 找并行循环、证明独立性并验证优化；
- 用 sloppy counter 解释“精确实时值”与“最终汇总值”的语义交换；
- 解释 TLS 的语言语义、`.tdata/.tbss`、线程 TLS block 与 x86-64 `%fs` 的关系；
- 为 hash table 选择全局锁、per-bucket lock、读写锁或原子方案，并说明 resize 的困难；
- 从 workload、竞争程度和 cache 流量出发评价优化，而不是只数锁的数量。

问题路线是：期中复盘（§2）→ `sum++` 的性能回归（§3–§4）→ 任务与 HPC 分解（§5–§9）→ Mandelbrot 和 `gpt.c`（§10–§11）→ 局部聚合与 TLS（§12–§15）→ 并行数据结构和 workload（§16–§19）。

## 2. 期中测验选讲：AI 时代，考试究竟在测什么？

讲义先保留了一段当堂复盘，而不是直接进入算法。
面对“期中测验选讲”，课堂用“我直接选择逃课”自嘲：启动 Claude Code，然后反问“还要我做什么用？”
这并不是技术方案，而是对课程评价方式的追问。

当次统计收到 49 份署名试卷，交卷率约 50%；讲义说明成绩会做 normalize，同时提醒放弃者在理论上可能吃亏。
这些数字属于当次课程情境，不应被误读为本章新的考核通知。

更重要的是背后的问题：生成式 AI 在训练中已经经历了无数形态的“考试”。
如果考试只要求复现定义、模板和标准代码，那么它恰好奖励 AI 最擅长的模式匹配。
课程真正希望培养的是能驾驭 AI 的“超级个体”：

- 能把模糊目标拆成可以验证的机制问题；
- 能要求工具提供数据、反例和可复现实验；
- 能看出输出混淆了语言、编译器、运行库、内核或硬件哪一层；
- 能为并行化提出正确性不变量，而不只接受一张看似更快的图；
- 能在答案很廉价时，继续追问“证据是什么、边界在哪里”。

因此本讲三个实验都强调预测、控制变量和解释。
运行命令不是终点；能够判断测量是否公平、结果为何偏离理想加速比，才是学习目标。

## 3. 并发编程回到 `sum++`：正确性不等于 scalability

上一讲之后，我们很自然会写：

```c
void T_sum(void) {
  mutex_lock(&lk);
  sum++;
  mutex_unlock(&lk);
}
```

同一形状还会出现在 `buf[len++] = elem`、`mapping[key] = value`、引用计数和队列元数据中。
锁让每次更新获得一个全局顺序；unlock 的 release 与后续 lock 的 acquire 还要保证临界区写入对下一位持锁者可见。
这正是正确性所需的 serializability，却把所有线程绑定到同一条串行链。

一次受竞争的更新至少可能包含：

```text
等待锁
  → 取得 cache line 的独占所有权
  → load / add / store
  → release，并唤醒或让出给竞争者
```

增加 CPU 并不会复制 `sum` 所在的 cache line。
所有写者仍争夺同一位置；线程更多时，锁竞争、cache line 迁移、调度和唤醒开销反而可能增加。

若程序中不可并行部分占比为 `s`，即使其余部分在 `P` 个处理器上理想并行，加速比也受下式约束：

```text
speedup(P) <= 1 / (s + (1 - s) / P)
```

这不是说“mutex 很坏”，而是说共享串行路径必须足够少。
保护不变量时仍要锁；性能设计的任务，是不要让每一个微小工作都穿过同一把锁。

## 4. 实验 1：复用 `parallel_sum`，观察分片和最终归并

仓库中的 [examples/parallel_sum.c](../../examples/parallel_sum.c) 没有让每个元素都更新全局计数器。
它把数组等分成区间，每个线程先在寄存器/栈上的 `local` 中累加，结束时只写一次 `job->sum`，主线程在 `join` 后统一归并。

先直接编译到临时目录，不修改仓库中的示例：

```bash
cc -std=c11 -O2 -g -Wall -Wextra -Wpedantic -pthread \
  examples/parallel_sum.c -o /tmp/parallel_sum

/tmp/parallel_sum 1 40000000
/tmp/parallel_sum 2 40000000
/tmp/parallel_sum 4 40000000
/tmp/parallel_sum 8 40000000
```

输入按 `0,1,...,9` 循环；长度 40,000,000 时，四次都应得到 `sum=180000000`。
线程数改变而答案不变，先检查了分片边界和归并正确性。

再做粗略计时：

```bash
for t in 1 2 4 8; do
  echo "threads=$t"
  /usr/bin/time -f 'elapsed=%e s' /tmp/parallel_sum "$t" 40000000 >/dev/null
done
```

不要期待时间严格除以线程数，原因至少有四个：

1. 每次运行都包含串行的内存分配和数组初始化；
2. 创建/回收 pthread 和最终 `join` 不是免费的；
3. 数组扫描最终可能受内存带宽而非算术单元限制；
4. 机器可能同时运行其他进程，CPU 拓扑、频率和 NUMA 位置也会影响结果。

示例里的 `alignas(64)` 让不同 `Job.sum` 尽量独占 cache line，避免多个线程虽写不同字段，却因 false sharing 争抢同一行。
更严谨的 benchmark 应把初始化移出计时区，固定 CPU/输入，总更新数保持不变，每个线程数重复多次并保留原始 CSV，再报告均值、离散程度和 error bar。
原讲义的“不同方式求和”演示正是比较手工自旋锁、pthread mutex 与原子指令，并对 `T=1,2,4,8,16` 各重复五次；它要建立的是控制变量习惯，而不只是宣布某一种原语永远最快。

这个实验也揭示最有效的优化：不是把全局 `sum++` 换成更炫的指令，而是把四千万次共享写变成每线程一次共享写。

## 5. Scale Up 与 Scale Out：先把问题分解成 job

一个通用并行骨架是：

```c
mutex_lock(&lk);
job = get();
mutex_unlock(&lk);

job->run();   // 大部分计算只触碰 job 私有状态
job->done();  // 发布完成，可能使后继任务就绪
```

临界区只负责领取工作；昂贵的 `run()` 留在锁外。
只要运行 job 的时间远大于领取和发布的同步成本，线程就能同时做有用工作。

- **Scale up**：在一台机器中增加 CPU 核、线程、内存通道或加速器；共享内存方便，但 cache coherence 和 NUMA 会成为边界。
- **Scale out**：增加机器；各节点没有天然共享地址空间，任务和数据必须经消息传递，网络延迟、带宽与失败都进入模型。

两者共同的抽象是计算图 DAG：节点是 job，有向边 `A → B` 表示 B 必须等待 A。
若 B 有多个 predecessor，可以用两种已学原语表达：

- 条件变量：在锁保护下等待“所有 predecessor 均完成”这个谓词；
- 信号量：每个 predecessor 完成时归还一个 token，B 收齐所需 token 才运行。

[examples/semaphore_dag.c](../../examples/semaphore_dag.c) 给出了后一种最小实现。
无论用哪一种，`done()` 必须同时发布结果和完成事实；只更新计数却未建立可见性，会重演上一讲的 order violation。

## 6. 计算图为何能扩展：work、depth、width 与粒度

设所有节点总计算量为 `W`，最长依赖链为 `D`。
即使有无限处理器，完成时间也不可能短于 `D`；在 `P` 个处理器上，也不可能短于 `W/P`。
因此可以把理想下界记作：

```text
T_P >= max(W / P, D)
```

图的 **宽度** 表示某个阶段可同时就绪的任务数量，**深度** 则构成关键路径。
宽而浅的图潜在并行度高；长链上的节点再多也只能依次执行。

粒度同样关键。把一个 1 微秒工作拆成一千个 1 纳秒 job，调度、同步和 cache miss 会淹没计算。
反过来只切成两个巨型 job，128 个核中的大多数会闲置。
实用分解要在“足够多的并行度”和“足够低的管理成本”之间取平衡。

最长公共子序列（LCS）的动态规划表提供了直观例子。
单元格依赖左、上和左上邻居，不能任意同时计算；但同一条反对角线上的许多单元格已经满足依赖，可以并行。
问题不是“循环能不能加 pragma”，而是先画出依赖边，再找到同时就绪的波前。

## 7. 经典高性能计算：数值模型天然给出分解结构

讲义把 HPC 概括为：利用超级计算机或计算集群，解决需要海量计算的复杂问题。
它源于数值密集型科学计算，但已经渗透到更多领域：

- 从宇宙尺度到量子尺度的物理系统模拟；
- 核爆炸、天气预报、有限元、航天、制造、能源和制药；
- proof-of-work 矿场，把大量独立尝试换成概率上的成功；
- AI 推理与训练，课程之后还会专门展开。

共同点不是“用了昂贵机器”，而是存在一个计算量足够大、可以暴露并行结构的模型。
当 `job->run()` 足够重，领取任务、交换边界和按轮 barrier 的成本才可能被摊薄。

## 8. CRAY-1：超级计算机是一个不断移动的参照系

1976 年的 CRAY-1 因环形座椅外观被称为“世界上最昂贵的 loveseat”，讲义给出的指标是 138 MFLOPS、功耗约 115 kW。

![CRAY-1](../../sources/site_html/static/img/cray-1.jpg)

讲义又列出 Apple M4 iPad Pro 约 3.8 TFLOPS、Taalas 约 300 TOPS 和 HPC-China 100，并用“约两百万台 CRAY-1”表达数量级变化。
这个比较的意义是建立历史尺度，而不是做严格同构的跑分：FLOPS 与 TOPS、精度、指令、内存系统、实际 workload 和峰值/持续性能并不相同。

硬件峰值不断增长，分解原则却没有过时。
如果程序有一条全局 `sum++` 串行路径，再多峰值算力也会在锁前排队。

## 9. HPC 程序的特点：空间局部性、分块和按轮同步

物理世界通常具有空间局部性：某个网格点在一个很短时间步内，主要受附近点影响。
把空间划成网格块后，块内部可以独立计算；每轮只需交换边界，再进入下一个 `Δt`。

```text
交换第 k 轮边界
      → 各块并行计算内部与新边界
      → barrier / 发布完成
      → 交换第 k+1 轮边界
```

Linpack 基准求解稠密线性系统 `Ax=b`，矩阵可以按块组织计算与通信。
有限元中的 Newton 方法又会把非线性系统逐步转成稀疏线性系统；稀疏结构和网格邻接关系继续暴露局部性。

但“可以分块”不等于“自动很快”。边界与体积之比、负载是否均匀、数据布局、通信是否能与计算重叠，都会决定实际效率。

### 9.1 Embarrassingly parallel：几乎没有同步仍要调度

若任务之间完全不共享中间状态，只需分发输入和收集输出，就称为 **embarrassingly parallel**。
典型例子包括：

- tree search 中可独立探索的子树（例如 fork-based DFS）；
- Monte Carlo 中使用独立随机流的多次模拟；
- 视频的逐帧转换；
- Mandelbrot 图像中每个像素的轨迹判定。

“Embarrassing” 不是贬低问题，而是说并行化简单得令人不好意思。
它消除了大部分同步，却没有消除负载均衡：某些搜索子树巨大，某些 Monte Carlo 样本很快结束，Mandelbrot 边界附近的像素也常需要更多迭代。

### 9.2 高性能计算中的并行编程：MPI 与 OpenMP

HPC 的计算图通常能做“机器—线程”两级切分：

- **MPI** 面向进程/节点间显式消息传递，适合没有共享地址空间的 scale out；
- **OpenMP** 用编译指令、运行库和环境变量表达共享内存并行，适合单节点 scale up，常用于 C/C++/Fortran。

最常见的 OpenMP 形状是：

```c
#pragma omp parallel for
for (int i = 0; i < 1024; i++) {
  work(i);
}
```

编译器和 OpenMP runtime 共同创建/复用线程、分配迭代，并在循环末尾默认 barrier。
pragma 本身不是系统调用；MPI 也不等于“网络硬件自动替程序通信”。
语言、编译器、用户态运行库、内核线程和机器互连是不同层次。

真正的大型 HPC 还要处理网络通信、功耗、稳定性、容错以及软件工具链。
本讲不展开这些工程，但它们解释了为什么“循环可并行”只是起点。

## 10. Mandelbrot：从像素独立性推导静态并行

对复平面上的点 `c`，从 `z_0=0` 开始反复计算：

```text
z_(n+1) = z_n² + c
```

在给定最大迭代次数内，若 `|z|` 超过阈值，就把它视为已经逃逸；逃逸迭代数可映射为颜色。
一个像素只读自己的坐标和全局参数，只写自己的输出位置，所以不同像素之间没有依赖。

![Mandelbrot set](../../sources/site_html/static/img/mandelbrot.jpg)

课堂演示混合了 OpenMP 和课程线程库：OpenMP 负责像素计算，线程库只是隔一段时间显示当前结果，并在所有工作结束后输出图像。
这两个职责应当区分：monitor 读取进度属于并发协调，像素轨迹才是 embarrassingly parallel 的计算主体。

### 10.1 实验 2：用 OpenMP 生成 Mandelbrot 灰度图

将下列独立示例保存为 `/tmp/mandelbrot-omp.c`：

```c
#include <omp.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>

enum { W = 1200, H = 800, MAX_ITER = 1000 };

static int escape(double cx, double cy) {
  double x = 0.0, y = 0.0;
  for (int i = 0; i < MAX_ITER; i++) {
    double next_x = x * x - y * y + cx;
    y = 2.0 * x * y + cy;
    x = next_x;
    if (x * x + y * y > 4.0) return i;
  }
  return MAX_ITER;
}

int main(void) {
  size_t size = (size_t)W * H;
  uint8_t *pixels = malloc(size);
  if (pixels == NULL) {
    fputs("malloc failed\n", stderr);
    return EXIT_FAILURE;
  }

  double begin = omp_get_wtime();
  #pragma omp parallel for schedule(dynamic, 4)
  for (int row = 0; row < H; row++) {
    for (int col = 0; col < W; col++) {
      double cx = -2.0 + 3.0 * col / (W - 1.0);
      double cy = -1.0 + 2.0 * row / (H - 1.0);
      int it = escape(cx, cy);
      pixels[(size_t)row * W + col] =
        (uint8_t)(it == MAX_ITER ? 0 : 1 + 254 * it / MAX_ITER);
    }
  }
  double elapsed = omp_get_wtime() - begin;

  FILE *out = fopen("/tmp/mandelbrot.pgm", "wb");
  if (out == NULL) {
    perror("fopen");
    free(pixels);
    return EXIT_FAILURE;
  }
  int write_failed = fprintf(out, "P5\n%d %d\n255\n", W, H) < 0;
  if (!write_failed && fwrite(pixels, 1, size, out) != size) write_failed = 1;
  if (fclose(out) != 0) write_failed = 1;
  if (write_failed) {
    fputs("writing image failed\n", stderr);
    free(pixels);
    return EXIT_FAILURE;
  }
  printf("threads=%d compute=%.3f s output=/tmp/mandelbrot.pgm\n",
         omp_get_max_threads(), elapsed);
  free(pixels);
  return EXIT_SUCCESS;
}
```

编译并比较线程数：

```bash
cc -std=c11 -O3 -Wall -Wextra -Wpedantic -fopenmp \
  /tmp/mandelbrot-omp.c -o /tmp/mandelbrot-omp

OMP_NUM_THREADS=1 /tmp/mandelbrot-omp
OMP_NUM_THREADS=4 /tmp/mandelbrot-omp
file /tmp/mandelbrot.pgm
```

两次运行应生成相同尺寸的 PGM，第二次通常更快，但加速比取决于 CPU 与调度。
这里按行切任务，并用 `dynamic,4` 动态领取四行，缓解不同区域迭代次数差异；如果改成 `schedule(static)`，调度开销较低，却可能让碰到复杂边界的线程收尾更久。

实验要观察三件事：像素写入是否互不重叠，串行/并行输出是否一致，以及调度策略如何改变尾部负载。
不要用“图像看起来差不多”代替一致性检查；真实数值代码还应固定参数并比较输出 hash 或允许范围内的浮点误差。

## 11. `gpt.c` 通关提示：只给机制，不给实验答案

讲义明确要求不要偷看 `llm.c/train_gpt2.c` 的实现答案。
可以知道的机制边界是：源文件可能用

```c
#ifdef OMP
#include <omp.h>
#endif
```

以及少量 `#pragma omp parallel for`、`#pragma omp parallel for collapse(2)`。
`collapse(2)` 把规则嵌套的两层迭代空间合并后分配；它没有自动证明两层循环独立。
若编译时没有启用 OpenMP（例如 GCC/Clang 的 `-fopenmp`），相关 pragma 通常被忽略，程序仍按串行循环运行。

为了不泄露 MiniLab/实验答案，可以按以下问题自行推进：

1. 哪些循环占据主要时间？先用 `sperf`/课程性能实验的方法得到证据；
2. 任意两次迭代会不会写同一元素，或存在前一迭代产生、后一迭代消费的依赖？
3. 累加是每迭代私有、reduction，还是对共享数组的冲突更新？
4. 两层循环的边界是否规则，`collapse(2)` 后索引映射是否仍保持独立？
5. 线程数从 1 增加时，正确性、数值误差、耗时和 cache 行为分别怎样变化？
6. 慢在算术、内存带宽、false sharing，还是 OpenMP 调度开销？

AI Agent 可以提出 patch 和调参组合，但你仍应要求它逐条回答这些问题，并用串行基线、测试输入和 profiler 验证。
本节到此为止，不标出应修改的具体循环，也不提供通关代码。

## 12. 并行数据结构：当 workload 就是大量 `sum++`

HPC 往往让每个 job 做很久，少量领取/发布不是瓶颈。
但操作系统内核、数据库、网络游戏服务器和高频交易系统的核心 workload，可能恰好就是大量短小的共享数据结构操作。

第一种办法是放宽语义。
若读者不要求每一时刻都看到绝对精确计数，而只要求值不太旧并最终一致，可以使用 sloppy counter：

```c
int sum_local[MAX_TID];

void T_sum(int tid) {
  if (++sum_local[tid] == 100) {
    mutex_lock(&lk);
    sum += sum_local[tid];
    mutex_unlock(&lk);
    sum_local[tid] = 0;
  }
}
```

每 100 次才触碰一次全局锁，把共享写频率降低两个数量级。
代价是全局 `sum` 最多漏掉每个活跃线程尚未 flush 的 99 次更新；线程退出前也必须 flush，否则“最终”都不会一致。

还要先定义读取合同：

- 近似查询只读全局值，便宜但滞后；
- 精确查询必须安全聚合所有 local，可能暂停更新或引入额外同步；
- 直接无同步读取别的线程正在写的普通 `int`，在 C/C++ 中仍是 data race，不能拿“允许旧值”当豁免。

因此 eventual consistency 是 API 语义，不是对内存模型的逃票。

## 13. Thread-local Storage：让每个线程自动拥有一份状态

显式 `sum_local[MAX_TID]` 有几个问题：tid 如何分配和回收，数组多大，第三方库怎样找到自己的槽位，以及多个槽位是否 false sharing。
语言和运行时因此提供 TLS。

```c
thread_local int sum_local;  // C23 或 C++11

void T_sum(void) {
  sum_local++;               // 每个线程访问自己的对象
}
```

C11 中对应的拼写是 `_Thread_local`。
对同一个 TLS 名字，不同线程求地址必须得到不同结果；同一线程内多次访问则保持同一对象身份。

原讲义把函数内 `thread_local int t;` 标作编译错误，这要结合语言解释：

- C 的块作用域 TLS 声明必须再带 `static` 或 `extern`；单独写 `thread_local`/`_Thread_local` 不合法；
- C++ 允许块作用域 `thread_local`，其初始化在该线程首次控制流经过声明时发生。

这正说明不能只记关键词；C23 与 C++11 的语法和初始化规则并非完全相同。
TLS 可以是结构体等任意完整对象，也可以带初值，但它不自动解决不同 TLS 副本的最终归并。

## 14. 实验 3：观察 TLS 地址与普通全局变量地址

下面用 C11 `_Thread_local` 避免依赖编译器对 C23 关键词的支持。
每个 worker 只写自己的 TLS，并把观察结果交给主线程在 `join` 后打印，因此没有交错输出或共享写竞争。

将代码保存为 `/tmp/tls-address.c`：

```c
#define _POSIX_C_SOURCE 200809L
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static _Thread_local int local_counter = 7;
static int global_counter = 7;

typedef struct {
  int id;
  int before;
  int after;
  const void *local_address;
  const void *global_address;
} Result;

static void check(int error, const char *operation) {
  if (error != 0) {
    fprintf(stderr, "%s: %s\n", operation, strerror(error));
    exit(EXIT_FAILURE);
  }
}

static void *worker(void *argument) {
  Result *result = argument;
  result->before = local_counter;
  local_counter += result->id + 1;
  result->after = local_counter;
  result->local_address = &local_counter;
  result->global_address = &global_counter;
  return NULL;
}

int main(void) {
  enum { N = 3 };
  pthread_t threads[N];
  Result results[N];

  for (int i = 0; i < N; i++) {
    results[i] = (Result){ .id = i };
    check(pthread_create(&threads[i], NULL, worker, &results[i]),
          "pthread_create");
  }
  for (int i = 0; i < N; i++) {
    check(pthread_join(threads[i], NULL), "pthread_join");
  }
  printf("main: tls=%p value=%d global=%p\n",
         (void *)&local_counter, local_counter, (void *)&global_counter);
  for (int i = 0; i < N; i++) {
    printf("T%d: tls=%p %d->%d global=%p\n", results[i].id,
           results[i].local_address, results[i].before, results[i].after,
           results[i].global_address);
  }
  return EXIT_SUCCESS;
}
```

编译、运行并查看目标文件：

```bash
cc -std=c11 -O2 -Wall -Wextra -Wpedantic -pthread \
  /tmp/tls-address.c -o /tmp/tls-address
/tmp/tls-address

readelf -SW /tmp/tls-address | rg '\.tdata|\.tbss'
objdump -dr /tmp/tls-address | rg 'fs:|tpoff|local_counter'
```

预期每个线程的 `before` 都是 7，TLS 地址各不相同；普通全局变量地址在所有结果中相同。
主线程的 TLS 仍是自己的初始值 7，不会看到 worker 的加法。

反汇编的具体形式取决于架构、链接方式和 TLS model，所以搜索不到某个字符串不等于没有 TLS。
关键证据是“每线程对象身份不同”与 ELF TLS 段，而不是死记一条汇编模板。

## 15. TLS 的实现：从编译期布局到每线程 `%fs` base

普通对象的典型寻址可以粗略画成：

```text
全局 int x          → 相对指令指针寻址，例如 x(%rip)
函数栈上 int y      → 相对栈/帧指针寻址，例如 y(%rsp)
线程局部 int z      → TLS base + 编译期/链接期确定的偏移
```

ELF 通常把带非零初值的 TLS 模板放在 `.tdata`，零初始化部分描述在 `.tbss`。
TLS 总布局在装载/链接阶段确定；创建线程时，pthread runtime 为新线程分配 TLS block，复制 `.tdata` 模板、清零 `.tbss`，再设置该线程的 TLS base。

在常见 x86-64 Linux ABI 中，用户态常借 `%fs` 段基址访问线程控制块和 TLS。
因此汇编可能表现为 `%fs` 加某个偏移；不同线程执行同一条指令，因为 `%fs` base 不同，最终得到不同地址。

这是一条跨层链：

```text
C/C++ storage-duration 语义
  → 编译器产生 TLS relocation/访问序列
  → 链接器布局 TLS 模板
  → loader 与 pthread runtime 创建每线程副本
  → 内核/硬件保存和使用每线程 TLS base
```

`thread_local int x = 42` 不能只在进程启动时初始化一次；每个新线程都必须获得自己的 42。
若初值需要执行构造函数，C++ 还要记录每线程初始化和析构状态，动态库的 TLS 又可能使用更通用、成本更高的访问模型。

TLS 消除了“每次访问全局 `map<tid,...>`”的查找和锁，却不是无限资源：副本会增加每线程内存，线程间汇总仍要同步，错误地缓存另一个线程 TLS 对象的地址也会破坏所有权假设。

## 16. 并行数据结构：利用 ADT 内部的访问局部性

数组、链表、树、图和 hash table 天生分散存储。
两个操作若访问不相交的部分，未必需要锁住整个 ADT。
并行数据结构的核心不是“锁越多越高级”，而是把同步范围和真正的不变量范围对齐。

常见选择包括：

- 原子 load/store/RMW：适合单个机器字可表达的状态转移；
- reader/writer lock（如 `pthread_rwlock_t`）：读多写少时允许读者并行；
- segment/striped lock：多个桶或区间共享一把锁，控制锁数量；
- element-wise/per-bucket lock：冲突精确，但元数据、cache 和锁序成本更高；
- thread-local fast path + 全局 slow path：像 sloppy counter，只在批量移交时同步。

“能用原子就不用锁”是讲义强调的性能直觉，例如 mymalloc Online Judge 可以用原子逃开某些锁路径；但它不是普遍定理。
跨多个字段的不变量、内存回收和复合操作通常不能靠把每个字段单独改成 atomic 自动成立。

## 17. Hash Table：per-bucket lock 很自然，resize 很不自然

Hash table 用 `hash(key)` 选择桶，并在桶中插入、删除或查找 value。
在散列质量和负载因子合理的常见 workload 下，操作期望成本接近 `O(1)`；碰撞严重或对抗输入下不能把它说成无条件保证。

若使用 separate chaining，最直接的并行方案是：

```text
hash(key) → bucket i → lock[i] → 搜索/修改桶 i → unlock[i]
```

访问不同桶的线程可以并行；读多写少时，每桶还可使用 rwlock。
锁条带化则让若干桶映射到同一把锁，以较少元数据换取较高的偶然冲突。

Open addressing 更麻烦，因为一次查找可能跨越多个槽位：

- 插入与查找沿 probe sequence 访问多个位置；
- 删除通常留下 tombstone，槽位状态变化会影响后续查找；
- 遍历要定义看到哪个时刻的集合；
- 多槽位加锁引入锁序和重试问题。

Resize 又会替换整个数组、重新计算元素位置，等于“摧毁”旧桶布局。
简单方案是用全表 resize rwlock：普通操作先持读锁再持 bucket lock，resize 持写锁并等待所有普通操作离开。
若有路径先拿 bucket lock 再请求 resize lock，就可能与相反顺序形成上一讲的 ABBA deadlock；必须规定并验证全局锁序。

复杂方案会渐进迁移桶、给表加 generation/version，并处理仍在访问旧表的线程和安全内存回收。
讲义用一串乱码省略这部分，表达的态度很明确：成熟并发容器背后有大量协议，请对库函数保持敬畏，不要把“加一把桶锁”误当完整实现。

## 18. Workload 决定方案：脱离负载谈优化没有结论

优化前至少要回答：

- 读、写、删除和遍历各占多少？
- key 是否均匀，还是少数 hot key 承担大多数访问？
- 表大小是否稳定，resize 多久发生一次？
- 操作本身很重，还是同步成本比有效工作还大？
- 要平均吞吐、单次延迟、尾延迟、公平性，还是严格实时精确值？
- 对手能否控制输入，制造碰撞或拒绝服务？

低竞争时，一把简单 mutex 可能更快、更容易证明；高竞争且访问分散时，per-bucket/striped lock 才能显出价值。
读几乎占全部时，rwlock 或不可变快照可能合适；更新单个独立计数器时，原子 RMW 可能足够；需要复合事务时，锁仍可能是最清楚的表达。

细粒度锁的成本包括更多元数据、更复杂锁序、较差 cache locality 和更难测试。
原子操作也会争夺 cache line，且 memory order 过强会增加约束，过弱则可能发布不完整状态。
选择它们不是从“高级技术排行榜”取第一名，而是让协议适配真实访问分布。

## 19. 概念辨析与常见误区

| 误区 | 辨析 |
| --- | --- |
| 程序线程越多就越快 | 加速受串行比例、计算图深度、粒度、带宽和调度限制；过量线程还会增加开销。 |
| mutex 正确，所以性能也合理 | mutex 提供互斥与可见性；热点锁仍会把执行完全串行化。 |
| scale out 就是把 pthread 放到更多机器 | 多机没有天然共享地址空间；要显式划分数据、传消息并面对网络与失败。 |
| Embarrassingly parallel 不需要任何工程 | 输入分发、结果收集、负载均衡、失败重试和资源限制仍然存在。 |
| OpenMP pragma 自动证明循环可并行 | 编译器按程序员声明执行；依赖、冲突写和数值语义仍由程序员负责验证。 |
| `-fopenmp` 只影响链接 | 它还使编译器识别 OpenMP 语义并生成 runtime 调用；不启用时 pragma 通常被忽略。 |
| TLS 就是一个隐藏的全局数组 | 抽象上是每线程对象；实现常用 TLS block 与 base-relative 寻址，不必每次查 `tid` map。 |
| 允许旧值就可以 data race | 一致性语义和语言内存模型是两层；无同步冲突访问普通对象仍可能是 UB。 |
| Hash table 操作永远 `O(1)` | 这是合理散列与负载下的期望；碰撞、resize 和对抗输入会改变成本。 |
| per-bucket lock 一定优于全局锁 | 只有 workload 的并行访问足以抵消锁元数据、cache 和协议复杂度时才成立。 |
| atomic 一定比 mutex 快 | 热点 atomic 同样触发 cache line 争用；多字段不变量和回收也未必能由单个原子表达。 |
| 最终一致等于最终会自己正确 | 必须有 flush、发布和线程退出协议；漏掉本地增量不会凭空恢复。 |

## 20. Takeaways：减少同步的最好办法通常是减少共享

本讲有两条互补路线：

1. **并行算法**：把大问题画成 DAG，让 `job->run()` 大部分在线程/节点本地完成，只在依赖边、边界交换和轮次切换时同步；
2. **并行数据结构**：利用访问局部性，把全局热点变成 TLS/local aggregation、原子状态或分桶细粒度协议。

完全 serializable 的一把大锁容易理解，却限制 scalability。
真正的性能来自减少不必要的共享、选择合适粒度，并以真实 workload 验证；所有优化仍必须保留上一讲建立的 happens-before、原子区、锁序和生命周期合同。

## 21. 思考题与下一讲衔接

1. `parallel_sum` 为何让 worker 只在最后写一次 `job->sum`？若改成每次 atomic add，哪条 cache line 会发生什么？
2. 一个 DAG 有大量节点但只有一条很长关键路径。增加 CPU 为什么无法突破 `D`？
3. LCS 表按行并行为什么错误？按反对角线并行需要在哪些位置同步？
4. Mandelbrot 的像素互相独立，为何 static 与 dynamic schedule 仍可能有明显差异？
5. MPI 与 OpenMP 各自把哪些通信成本显式交给程序员？两级混合分解时边界在哪里？
6. sloppy counter 有 16 个线程、阈值 100。只读全局值时最大可能滞后多少？线程退出还需什么协议？
7. 为什么 `%fs` 不是“TLS 变量本身”？同一条 TLS load 怎样在不同线程得到不同对象？
8. 一个 hash 操作需要 resize read lock 与 bucket lock。给出不会形成 ABBA 的统一锁序。
9. hot key 占 95% 请求时，增加 bucket 数为何可能几乎没有帮助？还可以怎样改变数据表示或语义？
10. 为 `gpt.c` 的候选循环写出“可并行”的最小证明义务；为什么只比较一次运行时间不够？

并行分解还留下一个现实限制：job 不能无限小，因为创建、调度、切换和阻塞内核线程都比普通函数调用昂贵。
下一讲将从线程资源成本出发，研究协程/goroutine 的轻量化，以及用 Promise/Future、channel、event loop 和 async/await 直接描述计算图。
本讲的 `get → run → done` 会在那里变成任务队列；Mandelbrot 也会换成 goroutine 与 channel，展示“并行计算”和“异步协调”怎样接上。

## 22. PPT 内容覆盖表

| 原讲义标题/内容 | 本章对应位置 |
| --- | --- |
| 期中测验选讲；“我直接选择逃课”；Claude Code | §2 |
| 49 份署名试卷、约 50% 交卷率、normalize | §2 |
| AI 经历无数考试；怎样培养驾驭 AI 的超级个体 | §2 |
| 并发编程回到 `sum++`；`buf[len++]`、`mapping[key]` | §3 |
| serializability、release/acquire 与差的 scalability | §3 |
| scale up 与 scale out | §3、§5 |
| [使用不同方式求和](/OS/demos/concurrency/sum-experiment)：自旋锁、mutex、atomic；固定总次数、五次重复、CSV/error bar | 实验 1（§4） |
| Scale Up & Scale Out: 分解问题：锁内 `get()`、锁外 `job->run()`、`job->done()` | §5 |
| predecessor；条件变量与信号量 token | §5 |
| `run` 时间远大于互斥时间；DAG 深度/宽度；LCS | §5–§6 |
| 经典高性能计算定义；科学模拟、核爆、有限元、天气、航天、制造、能源、制药 | §7 |
| proof-of-work 矿场与 AI 推理 | §7 |
| CRAY-1：1976、love-seat、138 MFLOPS、115 kW | §8 |
| M4、Taalas、HPC-China 100 与约两百万台 CRAY-1 的比较 | §8 |
| 高性能计算程序：特点——可大规模并行；空间局部性与网格边界 | §9 |
| Linpack、稠密 `Ax=b`、Newton method、FEM 稀疏线性系统 | §9 |
| Embarrassingly Parallel: 例子——fork-based DFS、Monte Carlo、逐帧视频 | §9.1 |
| Mandelbrot 每像素独立与图片 | §9.1、§10 |
| 机器—线程两级任务分解；生产者—消费者按轮同步 | §9、§9.2 |
| MPI message passing；OpenMP shared-memory programming | §9.2 |
| OpenMP parallel loop 与默认同步 | §9.2 |
| HPC 难点：网络、功耗、稳定性、容错、软件工具链 | §9.2 |
| [绘制 Mandelbrot Set](/OS/demos/concurrency/mandelbrot)：`z²+c`；OpenMP 与课程线程库的职责 | §10、实验 2（§10.1） |
| 实验 (gpt.c) 通关密码；不要偷看 `llm.c` | §11 |
| `#ifdef OMP`、`parallel for`、`collapse(2)`、无 `-fopenmp` 时忽略 pragma | §11 |
| AI Agent 并行化/调优；`sperf` 的底层逻辑 | §11 |
| 再次回到 `sum++`；HPC 同步少与数据结构操作多的场景 | §12 |
| 内核、数据库、游戏服务器、HFT | §12 |
| sloppy counter；旧值与最终一致性 | §12 |
| Thread-local Storage；C++11/C23 `thread_local` | §13 |
| 每线程副本、任意类型、初值与块作用域声明 | §13 |
| Thread-local Storage: 实现——普通全局/栈/TLS 寻址；`.tdata/.tbss`；`%fs` | §14–§15 |
| 每次创建线程的 TLS 初始化 | §15 |
| 并行数据结构 ADT；分散存储与访问局部性 | §16 |
| 锁拆分；原子、reader/writer lock、segment/element-wise lock | §16 |
| 例子：Hash Table——hash 到数组下标、期望 `O(1)`、per-bucket/rwlock | §17 |
| Open addressing；查找、删除、遍历、tombstone | §17 |
| Resize 摧毁旧数组；resize lock + bucket lock；死锁风险 | §17 |
| 复杂方案被省略；敬畏库函数 | §17 |
| Takeaways：正确且高效；少同步、TLS、细粒度锁和原子 | §18–§20 |
| 脱离 workload 做优化没有意义 | §18、§20 |
