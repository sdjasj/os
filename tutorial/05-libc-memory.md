# 第 5 章：libc、运行时与动态内存分配

> 对应讲义：[第 9 讲](../sources/notes/lect09.md)、[第 10 讲](../sources/notes/lect10.md)，配套实验：[mini_malloc.c](../examples/mini_malloc.c)

libc 是应用生态的第一层稳定地基：它把体系结构 ABI、系统调用和大量机器细节包装成 C 接口。`printf`、`malloc`、线程局部状态、程序入口乃至错误报告都比表面复杂。

## 5.1 API、ABI 与系统调用

三者不要混淆：

- **API**：源代码层面的函数、类型和语义，例如 `fopen`。
- **ABI**：二进制层面的调用约定、寄存器用途、对象布局、符号与动态链接规则。
- **系统调用接口**：用户态请求内核服务的编号、寄存器和陷入约定。

有些 libc 函数只是本地计算，如 `strlen`；有些包装系统调用，如 `close`；有些在用户态维护复杂状态并偶尔调用内核，如 `malloc`、`stdio`、`pthread_mutex_lock`。

```text
C/C++/Rust/Python runtime
          ↓ API
        libc
   ┌──────┴────────┐
纯用户态算法     系统调用封装
                   ↓ ABI
                  内核
```

## 5.2 main 之前与之后

ELF 入口通常是 `_start`，不是 `main`。启动代码大致完成：

1. 从初始栈取得 `argc`、`argv`、`envp` 和 auxiliary vector；
2. 初始化 libc、线程局部存储、栈保护值和动态链接状态；
3. 运行全局构造器；
4. 调用 `main`；
5. 把返回值交给 `exit`，刷新 stdio、运行析构器，最终 `_exit`。

观察入口与调用链：

```bash
readelf -h ./examples/mini_malloc | rg 'Entry point'
gdb -q ./examples/mini_malloc
(gdb) starti
(gdb) break main
(gdb) continue
```

调试信息把机器地址映射回源文件、行号、变量和类型；它不是执行所必需，`strip` 后程序仍可运行，但调试体验会大幅下降。

## 5.3 stdio 为何不等于 read/write

`FILE *` 在用户态维护缓冲区、错误/EOF 标志、锁、字符编码和底层 fd。缓冲减少系统调用次数：逐字符 `putchar` 不必逐字符陷入内核。

常见策略：

- 终端上的 stdout 常为行缓冲；
- 普通文件/管道常为全缓冲；
- stderr 通常不缓冲或更及时；
- `fflush` 只推动 libc 缓冲到内核，不等于数据已经持久化到设备。

混用 `read(fd, ...)` 和 `fread(FILE*, ...)` 会绕过彼此的缓冲与偏移预测，除非严格同步，否则容易得到意外结果。

## 5.4 错误处理也是抽象的一部分

POSIX 调用通常用返回值表示失败，并设置线程局部的 `errno`：

```c
int fd = open(path, O_RDONLY);
if (fd < 0) {
  fprintf(stderr, "open %s: %s\n", path, strerror(errno));
}
```

只在函数文档说明失败并设置 `errno` 时读取它；成功调用不保证清零。错误检查要靠近调用点，否则随后的库调用可能覆盖它。短读、`EINTR`、`EAGAIN` 往往不是永久失败，而是协议的一部分。

`setjmp/longjmp` 能跨多层调用恢复寄存器和栈位置，但不会自动释放锁、堆对象或 C++ RAII 资源。它适合受控的异常边界，不适合替代清晰的控制流。

## 5.5 malloc 的最小模型

运行：

```bash
./examples/mini_malloc
```

示例把 4096 字节 arena 切成带头部的块：

```text
┌ header(size,next,free) ┬ payload ┬ header ┬ payload ───────┐
└────────────────────────┴─────────┴────────┴────────────────┘
```

核心 first-fit：

```c
for (Block *b = head; b != NULL; b = b->next) {
  if (b->free && b->size >= wanted) {
    split(b, wanted);
    b->free = 0;
    return b + 1;
  }
}
```

它展示了分配器必须处理的基本问题：对齐、元数据、寻找空闲块、切分和复用。示例刻意没有合并相邻空闲块，反复分配释放后会产生外部碎片；也没有锁，多个线程同时调用会破坏链表。

## 5.6 真实分配器为何复杂

真实 libc 通常从 `brk` 或 `mmap` 获得大块虚拟内存，再自行管理。性能来自区分路径：

- **fast path**：线程本地缓存或固定大小 freelist，少量指令完成；
- **slow path**：向中央 arena 请求、合并块、映射新页或归还内核；
- **大对象**：常直接 `mmap`，释放时 `munmap`；
- **小对象**：按 size class 分桶，像 slab 一样减少查找和碎片。

线程本地 arena 减少锁竞争，却可能增加驻留内存；固定大小分类减少外部碎片，却引入内部碎片。没有脱离 workload 的“最佳分配器”。数据库、游戏和内核常为特定生命周期建立对象池。

## 5.7 内存错误为何难查

- 越界写可能先破坏相邻块头部，直到下一次 `free` 才崩溃；
- double free 会让同一块进入空闲结构两次；
- use-after-free 在块尚未复用时看似正常；
- 内存泄漏不立即影响正确性，却逐步耗尽资源；
- 多线程下分配器元数据也会遭遇数据竞争。

推荐工具链：

```bash
cc -g -O1 -fsanitize=address,undefined demo.c -o demo
ASAN_OPTIONS=detect_leaks=1 ./demo
valgrind --leak-check=full ./demo   # 若已安装
gdb ./demo
```

Sanitizer 通过编译插桩和影子内存尽早报告问题；它改变布局与时序，因此“开启后不复现”也不能证明原程序正确。

## 5.8 线程安全、可重入与 async-signal-safe

这三个词不同：

- **线程安全**：多个线程按契约调用不会破坏状态，内部可以使用锁。
- **可重入**：调用尚未结束时再次进入仍安全，通常不依赖可变全局状态和不可重入锁。
- **async-signal-safe**：可从异步信号处理器安全调用，集合非常小。

`malloc` 可以线程安全，却不是 async-signal-safe：信号可能在分配器持锁时到来，handler 再调用 `malloc` 会自锁。信号处理器常只写 self-pipe/eventfd 或设置 `sig_atomic_t` 标志。

## 5.9 常见误区

- libc 等于系统调用列表：大量标准库算法纯用户态运行，系统调用也可能根本没有 libc 标准包装。
- `printf` 一定立刻输出：数据可能还在用户缓冲区。
- `malloc(0)` 一定返回 NULL：标准允许返回 NULL 或一个不可解引用但可 `free` 的唯一指针。
- `realloc(p, n)` 失败后原指针失效：失败返回 NULL 时原块仍有效，直接覆盖变量会泄漏。
- `free` 后把指针设 NULL 就解决 UAF：其他别名仍可能指向旧块。
- 调试优化程序时变量“凭空消失”是 GDB 坏了：编译器可能已删去、合并或移入寄存器。

## 5.10 自测与实验

1. 给 `mini_malloc` 增加相邻空闲块合并，思考如何防止伪造指针破坏元数据。
2. 比较每次写 1 字节直接调用 `write` 与使用 `fputc` 的系统调用次数。
3. 用 ASan 制造 1 字节越界、UAF 和 double free，比较报告。
4. 设计一个固定大小对象池：为什么释放操作可以做到 O(1)？
5. 多线程分配器为什么既需要线程本地 fast path，又需要把部分内存归还全局？

下一章把“运行时如何开始”再向下展开：ELF、链接器和加载器如何共同描述进程初始状态。
