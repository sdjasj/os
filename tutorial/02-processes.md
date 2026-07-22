# 第 2 章：进程——把运行中的程序变成可管理对象

> 对应讲义：[第 5 讲](../sources/notes/lect05.md)，配套实验：[fork_exec.c](../examples/fork_exec.c)

程序是磁盘上的静态描述，进程是它的一次运行。更准确地说，进程是操作系统维护的一组状态：用户地址空间、寄存器上下文、打开的对象、身份、信号状态、统计信息和父子关系。

## 2.1 程序、进程与线程

```text
ELF 程序文件 --exec--> 进程
                       ├── 地址空间：代码、数据、堆、栈、映射
                       ├── 内核状态：PID、凭据、文件描述符、信号
                       └── 执行流：一个或多个线程
```

同一个程序可以同时产生许多进程；一个进程也可以先运行程序 A，再通过 `execve` 换成程序 B。PID 标识的是某段时间内的进程实例，而不是永久身份，退出后会被复用。

线程共享进程的大部分资源，尤其是地址空间和文件描述符表；每个线程仍有自己的寄存器、用户栈、内核栈和调度状态。把进程叫“资源容器”、线程叫“执行流”，是有用但不绝对的近似。

## 2.2 UNIX 进程生命周期

课程用三个动作描述状态机的生命周期：

- `fork()`：复制当前进程，产生一个几乎相同的新状态机；
- `execve()`：用可执行文件描述的初始状态覆盖当前地址空间；
- `exit()` / `_exit()`：终止执行，留下供父进程领取的退出状态；
- `waitpid()`：父进程等待并回收子进程。

典型 Shell 的一次命令执行就是：

```text
shell
  ├─ fork → child ─ 调整重定向 ─ execve("program") ─ exit
  └─ waitpid(child) ←──────────────────────────────────┘
```

编译并运行：

```bash
./examples/fork_exec
strace -f -e trace=process ./examples/fork_exec
```

核心代码是：

```c
pid_t child = fork();
if (child == 0) {
  execl(self, self, "--child", (char *)NULL);
  _exit(127);
}
waitpid(child, &status, 0);
```

`fork()` 在两个进程中都返回：父进程得到子 PID，子进程得到 0。`exec` 成功时不会返回，因为旧地址空间已经消失；失败才会走下一行。`waitpid` 不只是“等一下”，还领取内核保存的退出状态。

## 2.3 fork 真的复制了全部内存吗

语义上，父子刚分开时看见相同内容；实现上，内核通常使用 Copy-on-Write（COW）：

1. 父子页表暂时指向同一批只读物理页；
2. 任一方写入时触发保护性缺页；
3. 内核复制该页，并让写入方映射新副本；
4. 未写的页始终共享。

这让 `fork → exec` 不必复制马上会被丢弃的整个地址空间。复制页表、内核元数据和处理多线程状态仍有成本，所以服务器也会使用线程、`posix_spawn` 或专门的进程池。

## 2.4 文件描述符为何能跨 fork 和 exec

`fork` 复制的是文件描述符表中的引用，父子描述符通常指向同一个“打开文件描述”（包含文件偏移和状态标志）：

```text
父 fd=3 ─┐
         ├── open file description(offset=128) ── inode/device/socket
子 fd=3 ─┘
```

因此一方读文件会推动共同偏移。`exec` 默认保留描述符，Shell 才能在执行新程序前把标准输入输出接到文件或管道；设置 `FD_CLOEXEC` 可要求内核在 `exec` 时关闭敏感描述符。

## 2.5 退出、僵尸与孤儿

子进程退出后，内核释放地址空间等重资源，但必须保留 PID、退出码和少量统计信息，直到父进程 `wait`；这个阶段叫 **zombie**。大量不回收的子进程会耗尽 PID/进程表资源。

父进程先退出时，活着的子进程会被指定的 subreaper（传统上是 PID 1）接管。容器中的 PID 1 也需要正确回收孤儿，这就是很多容器使用 tiny init 的原因。

退出状态不是普通整数：

```c
if (WIFEXITED(status))
  printf("exit=%d\n", WEXITSTATUS(status));
else if (WIFSIGNALED(status))
  printf("signal=%d\n", WTERMSIG(status));
```

Shell 通常把信号终止编码成 `128 + signal`，但这是 Shell 约定，不是 `waitpid` 原始格式。

## 2.6 stdio 缓冲区的 fork 陷阱

下面的输出在终端和重定向到文件时可能次数不同：

```c
printf("hello");
fork();
fork();
```

`printf` 先把字符放进用户态缓冲区，`fork` 连缓冲区一起复制，多个进程最终各自刷新。解决方法是在 `fork` 前 `fflush(NULL)`，或在不需要 stdio 清理的子进程失败路径调用 `_exit`。`exit` 会刷新 stdio 并运行 `atexit` 回调，`_exit` 直接请求内核结束进程。

## 2.7 进程树就是系统的运行结构

常用观察命令：

```bash
ps -eo pid,ppid,stat,comm,args --forest
pstree -ap
ls -l /proc/self/fd
cat /proc/self/status
```

`/proc/PID` 把内核中的进程信息投影成目录树。后续的 MiniLab M2 `pstree` 正是把这些记录解析并重新组织成父子树。

## 2.8 常见误区

- `fork` 之后“从函数开头重新运行”：父子都从 `fork` 的下一条指令继续，只是返回值不同。
- `exec` 创建新进程：它保留 PID 和大量内核属性，只替换当前进程的程序映像。
- `kill` 一定杀死进程：它是“发送信号”；信号可能被捕获、忽略或暂时阻塞，`SIGKILL` 才不可捕获。
- `volatile` 能让进程共享变量：普通匿名内存经 `fork` 后是 COW；跨进程共享需 `MAP_SHARED`、共享内存对象或 IPC。
- 子进程可以在 `fork` 后随意调用所有库函数：多线程进程中，子进程只复制调用线程，其他线程持有的锁可能永远不释放；到 `exec` 前通常只能调用 async-signal-safe 函数。

## 2.9 自测与实验

1. 修改示例，让子进程 `exec` 一个不存在的文件。为什么约定用退出码 127？
2. 在 `fork` 前打开文件，父子各写 100 字节，观察偏移是否共享。
3. 故意删掉 `waitpid`，让父进程睡眠 30 秒；用 `ps` 找到 zombie。
4. 写出一个 Shell 执行后台任务 `cmd &` 时不阻塞主循环、又最终能回收子进程的方案。
5. 为什么多线程程序更偏爱 `posix_spawn`？它仍需要解决哪些文件描述符设置问题？

下一章进入进程最具“魔法感”的组成部分：虚拟地址空间。
