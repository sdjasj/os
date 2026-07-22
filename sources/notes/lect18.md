# 并行算法与数据结构

# 期中测验选讲

## 我直接选择逃课

  - Claude Code 启动
  - (还要我做什么用？)

## 统计数据

  - 一共收到了 49 份有名字的试卷 (交卷率约 50%)
  - 我会 normalize 成绩 (放弃的同学理论上说吃亏了)

## 感想

  - AI 在训练阶段经历了无数的 “考试”
  - 我们怎么 “考试”，才能培养出能驾驭 AI 的超级个体？

# 并发编程：回到 sum++

## `sum++` 在并发编程中非常常见

    void T_sum() {
        mutex_lock(&lk);
        sum++;
        mutex_unlock(&lk);
    }

  - `buf[len++] = elem;`
  - `mapping[key] = value;`

## AI 已经帮我们做了定量性能观测

  - 完全的 searializability (release → acquire，且确保可见)
  - 导致了很差的 scalability：性能无法随 CPU/线程/机器增加而增长
      - 如何 scale up (单机) & scale out (多机)

# [使用不同方式求和](/OS/demos/concurrency/sum-experiment)

我们对比使用自旋锁 (手工实现)、互斥锁和原子指令在求和上的性能，做一个基础的控制变量的对比实验：确定总的 sum++ 次数不变，分布在 T = 1, 2, 4, 8, 16 个线程，分别为三种实现实验重复 5 次，统计一次 sum++ 的平均时间。保存原始数据的列表 (csv)，并且在 Jupyter Notebook 里生成带 error bar 的 plot。

## 1\. 并行算法

# Scale Up & Scale Out: 分解问题

    mutex_lock(&lk);
    job = get();
    mutex_unlock(&lk);

    job->run();   // mostly thread-local computation
    job->done();  // enable other jobs

  - `job->run()` 的同步条件：等待所有 predecessors 执行完毕
      - 条件变量：直接等待这个条件
      - 信号量：需要 predecessor 那么多把 🔑

## Scale up & scale out

  - 只要 `job->run()` 的时间 \>\> 互斥的时间，就可以 scale
      - 例子：计算图 (DAG) 的深度 v.s. 宽度
      - 许多问题天生适合这个结构 (例子：LCS)

# (经典) 高性能计算

> “A technology that harnesses the power of supercomputers or computer clusters to solve complex problems requiring massive computation.” (IBM)

## 源自数值密集型科学计算任务

  - 物理系统模拟
      - **大到宇宙小到量子，有模型就能模拟**
      - 核爆炸、有限元……渗透天气预报、航天、制造、能源、制药等一切领域
  - 矿厂 (proof-of-work)
  - AI 推理 (智力)；我们专门花两节课来讲

# CRAY-1 超级计算机

## “[The world’s most expensive love-seat](https://dl.acm.org/doi/10.1145/359327.359336)” (1976), 138 MFLOPS @ 115kW

  - 对比：(Apple M4 iPad Pro: 3.8 TFLOPS; [Taalas](https://chatjimmy.ai/): \~300 TOPS; [HPC-China 100](https://hpc100.top/top100/24/))
      - \~2,000,000 台 CRAY-1 的计算能力

![](../site_html/static/img/cray-1.jpg)

# 高性能计算程序：特点

## 可以大规模并行

  - 物理世界具有的 “空间局部性”
      - 划分网格，除去边界都可以独立计算
  - 留意细节：HPC-China 100 使用的测试基准是 Linpack
      - 求解稠密矩阵的 Ax = b
      - 同样，这也是一个可以分块计算的任务
  - Newton’s Method 把非线性系统转为稀疏线性系统求解 (FEM)

## 甚至是 “Embarrassingly parallel” (几乎不需要同步/通信)

  - Tree search (fork-based dfs)
  - Monte Carlo 模拟
  - 视频逐帧处理……

# Embarrassingly Parallel: 例子

## 计算 [Mandelbrot set](https://cn.mathigon.org/course/fractals/mandelbrot)

  - 每一个像素的计算都是完全独立的
  - (这就是为什么我觉得大学要完蛋了)

![](../site_html/static/img/mandelbrot.jpg)

# 高性能计算中的并行编程

## 通常计算图容易静态切分 (机器-线程两级任务分解)

  - 生产者-消费者就能实现 “按轮同步” (每次计算一个 Δt)
      - [MPI](https://hpc-tutorials.llnl.gov/mpi/): “message passing libraries”
      - [OpenMP](https://www.openmp.org/): “multi-platform shared-memory parallel programming” (C/C++ and Fortran)

    #pragma omp parallel num_threads(128)
    for (int i = 0; i < 1024; i++) {
    }

## 真正困难的地方

  - 网络通信、功耗管理、稳定性和容错、软件和工具链 (很遗憾，无法在课堂上展开)
  - 但大家完全可以去试试

# [绘制 Mandelbrot Set](/OS/demos/concurrency/mandelbrot)

Mandelbrot set 描绘了函数 f(z) = z^2 + c 的轨迹是否有界。对于复平面上每一个点，求值都是完全独立的，因此对计算图的静态划分也是显然的。我们混用了 OpenMP 和我们的线程库。我们的线程库仅限于隔一段时间将当前渲染的结果显示在屏幕上，并在所有线程结束后输出渲染图。

# 实验 (gpt.c) 通关密码

## 大家不要偷看 [llm.c](https://github.com/karpathy/llm.c/blob/master/train_gpt2.c)

  - 但可以看一下头

    #ifdef OMP
    #include <omp.h>
    #endif

  - 整个代码和并行计算相关的就只有 5 行
      - 如果没有 -fopenmp 编译选项，\#pragma 会被直接忽略

    #pragma omp parallel for
    #pragma omp parallel for collapse(2)

  - 曾经：这个机制对非计算机专业的人实在太友好了
  - 现在：直接交给 AI Agent 做并行化 & 性能调优就行
      - sperf 实验的意义：让大家理解性能调优的底层逻辑

## 2\. 并行数据结构

# 再次回到 sum++

## “高性能计算” 的场景

  - 问题规模大、`sum++` 相对足够少，不成为瓶颈

## 但如果就是有很多的并行数据结构操作 (`sum++`) 呢？

  - 例子：操作系统内核、数据库、网络游戏服务器、HFT、……
  - 对于 `sum++`，我们可以不需要完全严格的顺序执行
      - 允许 load 看到 “不太离谱” 的旧值，但仍然保持 “最终一致性”

    int sum_local[MAX_TID];
    void T_sum(int tid) {
        if (++sum_local[tid] == 100) {
            mutex_lock(&lk);
            sum += sum_local[tid];  // “Sloppy” counter
            mutex_unlock(&lk);
            sum_local[tid] = 0;
        }
    }

### 2.1. Aside: thread\_local

# Thread-local Storage

## 我们都不喜欢 `int sum_local[]`

  - 语言机制的设计者也不喜欢
  - 于是我们有了 `thread_local` keyword (C++11/C23)
      - 每个线程会 “自动” 得到一份拷贝
      - 允许是任何类型 (也可以赋初值)

    thread_local int sum_local;

    void T_sum() {
        thread_local int t;  // Compile error
        sum_local++;  // 每个线程有自己的 sum_local
    }

# Thread-local Storage: 实现

    int x;  // x(%rip)

    void foo() {
        int y;  // y(%rsp)
    }

    thread_local int z;  // z(%fs)

## 编译 thread-local 访问

  - 不同的线程 \&sum\_local 必须得到**不同的地址**
  - 让 AI 解释一下编译器是如何实现它的吧
      - “.tdata, .tbss” 段 (thread-local 的大小是编译时确定的)
      - x86-64: 用 fs 段寄存器做 TLS base
  - thread\_local 的初始化更复杂
      - `thread_local int x = 42;` 必须在**每次线程创建**时赋值

# [Thread-local Storage](/OS/demos/concurrency/tls)

C/C++ 支持声明 “线程局部” 的变量，在编译器的配合下，会生成 “每个线程独立” 的拷贝，从而避免维护全局 `map<tid,thread_local_storage>` 映射的开销。

# 并行数据结构

## 数据结构 (Abstract Data Type)

  - array, list, tree, graph, …
  - 天生是 “分散” 存储的
  - 于是又有访问的**局部性**了
      - 读写数据结构的一部分**未必需要锁住整个数据结构**

## Key Idea: 锁的拆分

  - 能用原子指令就不用锁
      - (mymalloc 的 Online Judge 就是这么逃课的)
  - Reader/writer lock (pthread\_rwlock\_t)
  - Segment/element-wise lock

# 例子：Hash Table

## 一种高效的 key-value 数据结构

  - hash(key) 将转化为数组下标
  - 在该位置存储对应的 value
      - O(1) 插入、删除、查找
      - 而且我们可以做 per-bucket lock (甚至是读写锁)

## Open Addressing 带来的麻烦

  - 并发的查找、删除、遍历
      - Tombstone 管理会更麻烦
  - Resize: 会 “摧毁” 已有的数组
      - 简单处理方法：阻止 resize 和任何并发访问 (resize 相当于持有 write lock)
          - 每个操作都需要获得 bucket lock 和 resize lock (知道为什么会死锁了吧)
      - 复杂处理方法：\!*(@\#^*@&%^\!(*\#&(\!@*&\#
  - (请大家对库函数保持敬畏之心)

# Takeaways

并发编程不仅要正确，更要高效。互斥锁保证了正确性，但完全的 serializability 限制了 scalability——性能无法随 CPU/线程数增长。提升并行性能的关键是减少不必要的同步：利用问题的空间局部性实现大规模并行、用线程本地存储消除共享、用细粒度锁和原子指令缩小临界区。同时，脱离 workload 做优化就是耍流氓——理解真实负载的特征才是性能优化的第一步。
