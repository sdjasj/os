# CPU、GPU 和 SIMT 编程模型

# Review & Comments

## 计算图

  - 理解并行计算的关键
  - (这是一个非常核心的概念)

## 轻量化线程

  - Generators/coroutine
  - Non-blocking I/O
  - 借助编译器的 trick 实现能并行执行的 “线程”: goroutine

## 异步编程

  - Event-based concurrency
  - Promise API 描述动态计算图
  - async/await 语法糖

## 这些都是 CPU 上的并行/并发模型

  - 是时候推翻 CPU 的统治了！

## 1\. CPU 内部的并行编程

# 回顾：什么是 CPU？

### 无情的执行指令的机器

  - rv32ima\_step, “顺序执行”
  - 但顺序执行只是一个精心维护的假象
      - “每个程序都是并行程序！”

### 现代处理器和 Instruction-level Parallelism

  - “逻辑门” 天然是并行的
  - “逻辑门” 可以实现的功能
      - 在一个周期中译码两条指令
      - 分析两条指令是否有数据依赖
      - 如果没有数据依赖，如果我们有 dual port register file 就能同时执行两条指令啦！
  - 完全可以在 CPU 里内置动态数据流分析，实现乱序发射、按序提交
      - 例子：BogoMips (/proc/cpuinfo)，每秒执行 `while (loops--) cpu_relax();` 的次数
      - 可以看看平时用的程序的 IPC 是多少？

# [RISC-V 处理器模拟器](/OS/demos/intro/mini-rv32ima)

C 语言实现的 single-header RISC-V32IMA 系统模拟器 (项目源自[mini-rv32ima](https://github.com/cnlohr/mini-rv32ima))。因为有 M-Mode，这个模拟器可以运行几乎 “任意复杂” 的程序——甚至是没有 MMU 的 Linux。我们稍稍修改了这份代码，更好地体现《操作系统》课程的教学目标。

# [指令级并行 (ILP)](/OS/demos/concurrency/cpu-ilp)

在树莓派 2 (Cortex-A7, 顺序双发射) 上用内联汇编构造不同数据依赖关系的指令序列（依赖链、独立整数、VFP 浮点、NEON SIMD、整数+浮点混合、独立乘法），通过 `perf stat` 测量每种模式下的 IPC (Instructions Per Cycle)，直观感受处理器如何利用指令级并行提升性能。

# Instruction-level Parallelism 意味着什么？

### 在单线程能效和性能之间，CPU 选择了后者

  - 跑得越快，浪费得越多
      - 每一个门电路的翻转都会产生**热量**
      - CPU 里的 “编译器” (指令调度) 会消耗巨量的能量
          - 这些能量使计算 “尽快完成”
          - 但并不等同于 “单位时间完成尽可能多的计算”

### 直到进入 Dark Silicon “暗硅时代”

  - P (热功耗) = C V² f
      - “功耗墙”：纵使有更大的电路，热功耗限制了性能上限
          - \~1995-2005，先进制程不断突破功耗墙，实现单核性能持续增长
      - 墙 = 极限：频率墙、内存墙、I/O 墙……
      - 税 = overhead：存储税、网络税、计算税……

# 面对功耗墙

### 单位面积上能反转的逻辑门是有限的！

  - 如何压榨出更多的 performance/watt？

### Approach I: 让一条指令能处理更多的数据

  - SIMD (Single Instruction, Multiple Data)
      - “调度一条指令” 浪费的能量大致是定数
          - 做一次加法消耗的能量甚至远不如调度 (队列操作、数据流分析、renaming、……)
          - 如果让一条指令能**多做一些事**，调度的代价就被分摊了

### Approach II: 用更多更简单的处理器

  - 多处理器系统、异构多处理器
      - 同等面积，处理器越简单，数量越多
      - ARM big.LITTLE (2011); Intel P-cores/E-cores

### 1.1. 分摊指令调度的开销

# Single Instruction, Multiple Data (SIMD)

## 把一个大操作数分成几个小操作数

  - 例子：把 64-bit 当成 4 个 integers，做 pairwise 乘法
  - Intel MMX: MultiMedia eXtension (很有年代感的名字)
      - 甚至为了展示 MMX 技术，随 CPU 附赠了[游戏](https://www.bilibili.com/video/BV1sKszezEDi/)

![](../site_html/static/img/mmx-cpu.jpg)

# Aside: 编程中的 “SIMD”

## Bitset

  - `(arr[x / 8] >> (x % 8)) & 1`
  - lowbit: `(x & -x) == (x & (~x + 1))`

## popcount()

    inline int popcount(uint32_t x){
        x = (x & 0x55555555) + ((x & 0xaaaaaaaa) >> 1);
        x = (x & 0x33333333) + ((x & 0xcccccccc) >> 2);
        x = (x & 0x0f0f0f0f) + ((x & 0xf0f0f0f0) >> 4);
        x = (x & 0x00ff00ff) + ((x & 0xff00ff00) >> 8);
        x = (x & 0x0000ffff) + (x >> 16);
        return x;
    }

# 引入 Packed Registers

### 增加一些 “超大” 的寄存器

  - 64-bit “mm” 寄存器
  - 57 条指令实现 “packed register” 操作 ([手册](https://jyywiki.cn/OS/manuals/mmx.pdf))

![](../site_html/static/img/mmx-registers.jpg)

# 寄存器越长，调度代价就被摊薄得越多

## MMX → SSE → AVX → AVX-512

  - `%mm` (64-bit) → `%xmm` → `%ymm` → `%zmm` (512-bit, AVX-512)
  - 直到碰上内存墙/功耗墙 (AVX-512 已经达到热密度极限)

## 支持更多的数据类型

  - int8/16/32 → float32 → float64

## 支持更多运算 (三操作数模式)

  - Shuffle: `c[i] = a[b[i]]`
  - FMA: `a * b + c`，一条指令完成

# SIMD: 没能完全解决问题

### SIMD 指令依然是在 CPU 里调度的

  - 参与到缓存和动态流水线中，和其他类型的指令格格不入
  - 抢缓存 (这也是动态调度)、抢功耗

### 能让指令调度的代价近乎归零吗？

  - 失败的尝试：Very Long Instruction Word (VLIW)
      - 完全消灭动态流水线，编译器扛下所有，生成静态指令调度
      - 但 LLM 时代，它可能又要复活了
  - 成功的尝试：简化指令调度，改成横向扩展
      - 单个大 CPU → 多个并行小 CPU
      - 还可以更小吗？

## 2\. 改变人类命运的另一条时间线

# Magnavox Odyssey (1972)

## 一次极为大胆的尝试

  - 没有声音，画面都只是光点 (Ping Pong)

![](../site_html/static/img/magnavox-odyssey.jpg)

# 游戏机遇到的性能问题

## CPU 无法根据 “图形场景描述” 完成图形绘制

    for (int y = 0; y < H; ++y) {
        for (int x = 0; x < W; ++x)
            putchar(f(x, y) ? '*' : ' ');
        putchar('\n');
    }

  - 对 f(i, j) 的计算是 embarrassingly parallel 的 (例如 Mandelbrot Set)

## 时间回到 1983 年

  - Nintendo Entertainment System (NES)
      - MOS 6502 @ 1.79Mhz; IPC ≈ 0.43
      - 屏幕共有 256 x 240 = 61K 像素 (64 色)
      - 60FPS → 10K 条指令完成 61K 像素的渲染
  - Legend of Zelda (1986)

# NES 的图形描述

## “场景描述”：数据结构

  - 以 8 x 8 的 “贴块” (tile) 为绘制的基本单位
  - Tile ROM + Tile Map (Name Tables) + Attribute Tables
  - 背景卷轴 + 动态前景 (sprites)，和无数的编程 tricks

![](../site_html/static/img/nes-ppu.png)

# NES 动态前景渲染

## Sprite = (x, y, tile, attr), 256-byte Sprite RAM (64 个)

    76543210
    ||||||||
    ||||||++- Palette
    |||+++--- Unimplemented
    ||+------ Priority
    |+------- Flip horizontally
    +-------- Flip vertically

![](../site_html/static/img/nes-sprite.png)

# PPU 中的静态渲染管线

## 我们对每一个像素做的事情是一样的

  - 依次计算出背景像素、Sprite 像素的颜色，然后合成
      - 这些概念一直用到今天 (z-buffer)
  - 这就是早期的 “fixed-function pipeline GPU”
  - 每个 GPU “线程” 都在做完全相同的动作

    // 逐行扫描
    for (int row = 0; row < lines; row++) {

        // 我们可以作弊 😊
        #pragma omp parallel for
        for (int i = 0; i < 64; i++) {
            struct sprite *s = &SPRAM[i];
            if (s->y <= row && row < s->y + 8) {
                // 绘制 sprite
            }
        }

        display_row(row);
    }

# 从 PPU 到 2D 图形渲染管线

## 扩展 “场景描述” 的数据结构

  - 2D 图形：动态拼凑图片 (texture) 实现场景的绘制
      - 依然是 “固定循环”，执行完全相同的逻辑
  - Game Boy Advance 的 [V-Rally 3](https://www.bilibili.com/video/BV1bT4y1g75x/)

![](../site_html/static/img/v-rally.png)

# 从 2D 到 3D

## 继续扩展 “场景描述” 的数据结构

  - Vertex, Face, Texture, Material, Light, Camera
      - 三角剖分定理，因此你看到的一切都是三角形
      - 3D 空间中的各种变换 (translation, camera projection, …)，在 4D 齐次坐标下是线性的

![](../site_html/static/img/camera-projection.png)

# 一些早期的 3D 游戏

## 只要能画线，就可以有 3D 游戏！

![](../site_html/static/img/battlezone.png)

# 从 2D 到 3D (cont’d)

## 引入 3D 需要修正许多问题

  - 例子：2D 贴图失真
      - 2D 引擎模拟 3D，顶点是正确的，但因为缺少深度信息，affine 贴图是 “视觉错误” 的

![](../site_html/static/img/weirdtextures.jpg)

# 从数据结构到编程语言

## 可编程的 “着色器” (shader)

  - Vertext shader: 可以编程修改几何形状
      - Killer application: 实现 “扭曲”，例如水面的波纹、毛发的摆动
  - Fragment (Pixel) shader: 可以编程修改颜色
      - Normal mapping (法线贴图)：远距离观察时 “骗过” 光照计算

![](../site_html/static/img/normal-mapping.png)

# [OpenGL Shader](/OS/demos/concurrency/gl-shader)

我们可以用 “套娃” 的方式在程序中嵌入一个 GLSL 的 shader program。这会经历一个完整的编译流程，并最终作用到对应的像素上。

## 3\. GPGPU 与 CUDA

# Hacking “可编程” Shader

  - “[Fast matrix multiplies using graphics hardware](https://dl.acm.org/doi/pdf/10.1145/582034.582089)” (SC‘01)
      - 外积分解: AB = ∑ A\_{*,k} B\_{k,*}
      - 试图把各种计算问题转换为 “图像” 的计算 (物理模拟、天气预报……)

![](../site_html/static/img/gpu-hack.jpg)

# 什么是 Shader Program？

## 为一大堆东西 (vertex, pixel, …)，执行同一段代码

  - 绕了一圈，又回到《操作系统》讲并发的第一课了

    __device__ int *screen;

    void T_kernel(int row, int col) {
        int color = f(row, col);  // 任意 C/C++ 代码
        screen[row * 1920 + col] = color;
    }

    for (int row = 0; row < 1080; ++row) {
        for (int col = 0; col < 1920; ++col) {
            spawn(T_kernel, row, col);
        }
    }

  - 在 GPU 上启动 2,073,600 个线程
      - 并行执行，允许访问 shared memory
      - 恭喜！你发明了 CUDA (的 programming model)

# 改变人类命运的时间线：复盘

## 这个 “程序” 有什么特别的地方？

  - 如果它在多处理器系统上执行
      - CPU = rv32ima\_step 里的完整取指令、译码、执行单元
      - 这样每个 CPU 就可以执行完全不同的程序
  - 但这**不是我们的需求**！
      - 有没有可能为 CPU 只保留寄存器和运算器 (并行执行的必要条件)
      - 由同一个取指令/译码单元控制，总是执行相同的指令，实现**极致的节省**？

## 这就是 SIMT 模型

  - Single Instruction, Multiple Threads
  - 可以让一个 “CPU” 管理若干 T\_kernel，并且只有一个 Program Counter

# 唯一的麻烦

### Shared-memory CPU 很难实现

  - GeForce 8800 (首个 CUDA GPU, G80 2006, 65nm)
      - 128 cores, v.s. Intel 桌面 CPU: 2C4T
      - The first GPU to support C
      - The first GPU to utilize a scalar thread processor, eliminating the need for programmers to manually manage vector registers
          - [Fermi whitepaper](https://www.nvidia.com/content/PDF/fermi_white_papers/NVIDIA_Fermi_Compute_Architecture_Whitepaper.pdf)
  - RTX 5080: 10,752 CUDA Cores
      - 这是怎么做到的？
      - 它们也 (可以) 是 shared memory 啊！

# 让我们尝试 “单步执行” SIMT 程序

## 一个 PC (program counter) 管多个线程

  - 假设 (3, 0), (3, 1), … (3, 31) 都被分配到了同一个 core 上
      - “Thread warp” 线程束

    screen[3 * 1920 + 0] = color_0;
    screen[3 * 1920 + 1] = color_1;
    screen[3 * 1920 + 2] = color_2;
    ...

  - row, col, color 都在独立的寄存器里
  - Memory coalescing 就神奇地发生了！
      - 这个 “thread warp” 好像做了一个 128-byte 的 store
      - 实际上，一个 Nvidia Stream Multiprocessor 可以保存多个 (32) warps，load/store stall 可以换另一个 😊

# 当然，这也意味着 CUDA 程序很难写

    map[row * 1920 + col] = t;
    map[row + col * 1080] = t; // 等价的写法，可能导致性能大幅下降

![](../site_html/static/img/simt.jpg)

# 难写，意味着有收益

### 渲染 25600 x 25600 的 Mandelbrot Set

  - Ryzen 5 9600X: 25.1s @ 65Watt
  - RTX 4060Ti (16GB): 6.1s @ 42Watt
      - 这已经是对 CUDA “不太友好” 的程序了
          - 不确定的 while 循环，最慢的那个会拖慢整个 thread warp

### 我们甚至可以直接阅读 GPU 上的代码

  - 经过编译器优化，比大家想象得要短 😊
  - (GPU 并不擅长执行数据中心中的业务逻辑)

# [CUDA 实现的 Mandelbrot Set](/OS/demos/concurrency/mandelbrot-cu)

和 “原版” C 代码对比，实际计算的 mandelbrot 函数完全没有任何修改，只是增加了 “**kernel**” 的修饰。此外，worker 线程被 mandelbrot\_kernel 函数取代，这个函数在 GPU 上运行，通过 blockIdx, blockDim 和 threadIdx 计算出线程对应的像素坐标。没错，CUDA 是另一种 “启动百千万个轻量级线程” 的机制。

# Takeaways

人类世界的需求一直是驱动技术革新的原动力。回头看历史，波澜壮阔的旅程又是显得那么理所应当——从 CPU 到领域加速器，再变得 “通用” 一点，就是 GPGPU。也许有些出乎 Nvidia 意料的是，CUDA 没有在大家看好的科学计算领域掀起革命，却引领了人工智能的时代。回望历史、展望未来，同学们将在人类历史上找到自己的位置。
