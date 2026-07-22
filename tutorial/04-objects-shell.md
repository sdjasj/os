# 第 4 章：文件描述符、管道、终端与 Shell

> 对应讲义：[第 7 讲](../sources/notes/lect07.md)、[第 8 讲](../sources/notes/lect08.md)，配套实验：[pipeline.c](../examples/pipeline.c)

UNIX 最持久的设计不是某个命令，而是用小整数文件描述符统一引用内核对象，再用 `read/write` 和少量控制操作组合它们。Shell 则把进程、描述符和管道变成一门可交互的编程语言。

## 4.1 文件描述符是“进程内的对象指针”

`open` 返回的 3 不是磁盘文件编号，而是当前进程文件描述符表的下标：

```text
进程 fd 表                 内核对象
0 ──────────────────────> terminal input
1 ──────────────────────> terminal output
2 ──────────────────────> terminal output
3 ──> open-file-description(offset, flags) ──> inode
4 ──> socket state ─────────────────────────> TCP connection
```

同一个 fd 数字在不同进程中可以指向完全不同的对象。`dup`/`dup2` 创建新引用，`fork` 复制引用，`close` 删除一个引用；最后一个引用消失时，内核对象才真正结束相应生命周期。

“Everything is a File” 的实质不是所有对象都存放在磁盘，而是尽量给不同对象共同的流式接口：

- 普通文件：读写字节并维护偏移；
- 管道：写端生产、读端消费；
- 终端：接收按键、输出字符，另有行规程；
- socket：在网络连接上收发字节；
- 设备文件：驱动实现 `read/write/mmap/ioctl` 等操作。

## 4.2 read/write 的真实契约

```c
ssize_t n = read(fd, buffer, capacity);
```

返回值只有三类：正数表示本次得到的字节数，0 表示 EOF，-1 表示错误并设置 `errno`。一次读取少于请求长度是正常情况，不等于 EOF。写入也可能 short write，因此可靠代码必须循环：

```c
while (remaining > 0) {
  ssize_t n = write(fd, cursor, remaining);
  if (n > 0) { cursor += n; remaining -= (size_t)n; continue; }
  if (n < 0 && errno == EINTR) continue;
  /* 处理 EPIPE、EAGAIN 或其他错误 */
}
```

阻塞 fd 会让线程睡眠直到条件满足；非阻塞 fd 在暂时不能完成时返回 `EAGAIN`。第 11 章会用事件循环管理大量非阻塞对象。

## 4.3 管道：把两个状态机接起来

`pipe(int fd[2])` 创建一个内核缓冲区以及读、写两个引用。运行：

```bash
./examples/pipeline
strace -f -e trace=process,desc ./examples/pipeline
```

示例实现了 `printf ... | wc -l`：

```c
pipe(channel);

if (fork() == 0) {
  dup2(channel[1], STDOUT_FILENO);
  close(channel[0]); close(channel[1]);
  execlp("printf", "printf", "red\\ngreen\\nblue\\n", NULL);
}

if (fork() == 0) {
  dup2(channel[0], STDIN_FILENO);
  close(channel[0]); close(channel[1]);
  execlp("wc", "wc", "-l", NULL);
}
```

最容易漏掉的是关闭无用端。只有所有写端引用都关闭后，读者才观察到 EOF；父进程若保留写端，`wc` 会永远等下去。反过来，所有读端关闭后继续写会收到 `SIGPIPE` 或 `EPIPE`。

管道提供有界缓冲和背压：消费者跟不上时，阻塞写会暂停生产者。它传输字节流，不保存“消息边界”；短于 `PIPE_BUF` 的单次写入有特殊原子性保证，但不能把整个流想成消息队列。

## 4.4 重定向就是替换 0、1、2

Shell 执行：

```bash
sort < input.txt > output.txt 2> error.log
```

本质是在子进程 `exec` 前做：

```c
int in = open("input.txt", O_RDONLY);
int out = open("output.txt", O_WRONLY | O_CREAT | O_TRUNC, 0644);
dup2(in, STDIN_FILENO);
dup2(out, STDOUT_FILENO);
close(in);
close(out);
execvp(argv[0], argv);
```

新程序完全不需要理解文件名；它照常从 fd 0 读、向 fd 1 写。这正是“机制与策略分离”：程序决定处理什么，Shell 决定数据从哪里来、到哪里去。

注意重定向顺序：`cmd >all.log 2>&1` 让 2 复制已经指向文件的 1；`cmd 2>&1 >out.log` 则先让 2 指向终端，随后只替换 1，结果不同。

## 4.5 终端不是窗口

终端继承自打字机和电传打字机。今天常见的终端模拟器一端显示 GUI，另一端通过伪终端（PTY）和 Shell 通信：

```text
键盘/窗口 ↔ terminal emulator ↔ PTY master | PTY slave ↔ shell/程序
                                           ↑
                                    line discipline
```

终端驱动可在 canonical 模式中编辑一整行后再交给程序，也可在 raw 模式中逐字节交付；回显、特殊字符和流控都是可配置状态。`stty -a` 能看到这些历史遗产。

Ctrl-C 通常不是把字节 `0x03` 交给程序。行规程识别控制字符，向终端前台进程组发送 `SIGINT`。这带来三个层级：

- **session**：一次登录/终端会话；
- **process group**：一条前台或后台作业中的相关进程；
- **controlling terminal**：决定哪个进程组接收终端产生的信号。

Shell 用 `setpgid`、`tcsetpgrp`、`SIGTSTP`、`SIGCONT` 实现 `Ctrl-Z`、`fg`、`bg`。若只向管道中的一个 PID 发信号，其他阶段可能继续运行，所以作业控制针对进程组。

## 4.6 Shell 是一门组合语言

最小 Shell 循环只有四步：读取、解析、创建进程、等待。但真正 Shell 还要处理：

- 引号、转义、变量展开、通配符；
- 管道、重定向、逻辑连接和子 Shell；
- 作业控制、信号与终端所有权；
- 内建命令，例如 `cd` 必须改变 Shell 自己的工作目录；
- 退出码和 `set -e` 等复杂语义。

Shebang 把脚本接入可执行文件生态：

```text
#!/usr/bin/env python3
```

内核或用户态加载逻辑识别首行，用解释器和脚本路径重新组织参数。`/usr/bin/env` 提高环境可移植性，也让实际解释器依赖 `PATH`，安全敏感场景要谨慎。

## 4.7 UNIX 哲学的边界

“每个程序只做好一件事、文本作为通用接口、程序输出可作为另一程序输入”带来极强组合能力：

```bash
find . -name '*.c' -print0 |
  xargs -0 rg -n 'TODO' |
  sort
```

但文本会丢失类型与结构，文件名又可能含换行。生产系统会使用 NUL 分隔、JSON、协议缓冲或专门 IPC。哲学的重点是稳定边界和可组合性，而不是强迫一切都用脆弱的空格分隔文本。

## 4.8 常见误区

- `close(fd)` 会删除文件：它只释放当前引用；删除目录项要 `unlink`。
- `dup2(a, b)` 让两个 fd 各自维护偏移：它们引用同一个打开文件描述，偏移通常共享。
- 管道是无限的：缓冲区有限，设计不当会形成环形等待。
- Ctrl-C 总能退出：程序可捕获或阻塞 `SIGINT`，也可能不是前台进程组成员。
- 用字符串拼接命令再 `system()`：不可信输入会变成 Shell 注入；优先构造 `argv` 并直接 `execve`。
- 成功 `exec` 后 fd 自动关闭：只有设置 `O_CLOEXEC`/`FD_CLOEXEC` 的描述符会关闭。

## 4.9 自测与实验

1. 把示例扩展成三段管道 `printf | grep green | wc -l`，列出每个子进程必须关闭的 fd。
2. 比较 `echo hi >x 2>&1` 与 `echo hi 2>&1 >x` 的描述符变化顺序。
3. 用 `isatty(1)` 观察程序输出到终端和管道时的差异；为什么很多程序会改变颜色或缓冲策略？
4. 写一个程序在收到 `SIGINT` 时只设置原子标志，然后让主循环安全退出。为什么不应在 handler 中随便调用 `printf`？
5. 解释为什么 `cd /tmp` 不能简单作为普通子进程执行。

下一章向上走一层：系统调用之上，C 标准库和运行时如何支撑可移植应用。
