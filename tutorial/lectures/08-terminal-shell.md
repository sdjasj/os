# 第 8 讲：终端和 UNIX Shell——从字符流到交互式应用世界

> 原始讲义：[sources/notes/lect08.md](../../sources/notes/lect08.md)  
> 可复用示例：[examples/pipeline.c](../../examples/pipeline.c)  
> 本讲关键词：打字机、电传打字机、VT100、Unicode、行规程、`termios`、PTY、终端模拟器、信号、会话、进程组、job control、Shell、重定向、shebang
> 前一讲：[访问操作系统对象](07-os-objects.md) · 后一讲：[C 标准库和实现（1）](09-libc-1.md)

## 0. 本讲定位：给操作系统对象接上“人”和“语言”

上一讲建立了操作系统对象模型：进程不能直接拿到内核里的对象，只能通过文件描述符引用它们；普通文件、管道、设备都可以暴露 `read/write` 一类共同接口。匿名管道已经证明，只要安排好文件描述符继承，就能把两个进程的字节流接起来。

但还有两件事没有解释：

1. 人敲下键盘后，为什么程序执行一次 `read(0, ...)` 往往要等到回车才返回，甚至还能退格编辑？
2. `a | b > out` 这样短短一行文字，为什么足以创建进程、搬运文件描述符、等待作业，并把结果呈现给人？

本讲的两个主角分别回答它们：

- **终端**把人的按键和程序的字节流连接起来，并在历史兼容层中加入行编辑、回显、控制字符和前台作业等语义；
- **UNIX Shell**把进程、文件描述符、管道和信号包装成一门组合语言。

课程主线在这里完成一次“从对象到生态”的跃迁：

```text
进程与地址空间
  → 操作系统对象、文件描述符、管道
  →【本讲：终端交互 + Shell 组合语言】
  → libc 对机器、系统调用和运行环境的封装
  → 链接、加载与完整应用生态
```

下一讲将追问：本讲代码里看似普通的 `printf`、`open`、`fork`、`execve` 和错误报告究竟从哪里来？C 语言本身并不提供这些能力；把机器和系统调用包装成稳定接口的，是 libc 和 C runtime。

## 1. 学习目标与问题地图

学完本讲，你应该能够：

- 从打字机解释 `Shift`、`Caps Lock`、CR、LF、退格和 Tab 的历史来源；
- 说明电传打字机、Video TTY、VT100、ANSI 转义序列和 Unicode 各解决了什么问题；
- 区分键盘事件、字符编码、终端输入字节、终端控制序列与字体渲染；
- 解释 canonical/raw 模式、回显和特殊字符为何属于终端行规程，而不是 `read()` 或应用自己的固定行为；
- 画出终端模拟器、PTY master、PTY slave、行规程、Shell 和前台程序之间的数据路径；
- 解释 `Ctrl-C` 如何从字节 `0x03` 变成发往**前台进程组**的 `SIGINT`；
- 区分 PID、PGID、SID、控制终端和前台进程组，并用它们解释 `Ctrl-Z`、`fg`、`bg`；
- 把 Shell 的重定向、管道、顺序/条件执行还原成 `open/dup2/pipe/fork/execve/waitpid`；
- 解释 Shell 的文本组合能力、历史包袱、引用规则和跨解释器兼容边界；
- 说明 freestanding shell 与 shebang 怎样证明“系统调用足以长出应用世界”，同时指出 libc 通常仍在什么地方出现。

问题地图：

| 问题 | 最小答案 | 可观察证据 |
| --- | --- | --- |
| `read(0, ...)` 为什么不逐键返回？ | canonical 行规程先缓存和编辑一行 | `stty -a` 与实验一 |
| 终端窗口就是 `/dev/pts/N` 吗？ | 不是；窗口程序持有 PTY master，应用打开 slave | `tty`、`pty.spawn` |
| `Ctrl-C` 是程序读到的普通字符吗？ | 默认不是；行规程把它转成前台进程组的 `SIGINT` | `stty -a`、实验三 |
| 为什么一条管道要有进程组？ | 一项作业可能有多个进程，终端信号应命中整项前台作业 | `ps` 的 PGID/TPGID |
| `>` 是目标程序实现的吗？ | 不是；Shell 在 `execve()` 前替换子进程的 fd | `strace` 与 pipeline 示例 |
| `sudo echo x > file` 为什么仍可能失败？ | 重定向由当前 Shell 先执行，`sudo` 只提升 `echo` | 错误发生在 `exec sudo` 前 |
| `#!` 是注释还是内核协议？ | 对 Shell 可像注释；对 `execve` 是解释器分派标记 | 可执行脚本实验 |

## 2. 从键盘到终端：旧机械留下的新接口

### 2.1 “键盘”的历史比计算机长得多

讲义把键盘的祖先追到公元前 3 世纪的水力管风琴 Hydraulis。这里的重点不是说古代乐器已经是计算机输入设备，而是认识一种持久的交互形式：

```text
人的离散动作（按键） → 机械/电气机构选择一种结果
```

管风琴的键选择音管，16 世纪出现的击奏弦鸣乐器前身则让按键驱动发声机构。后来，打字机让按键选择一个可印刷字符；计算机终端再把结果编码为比特。键盘的外形延续了，但“按下去以后驱动什么”不断改变。

### 2.2 打字机：字符、字车和 QWERTY

机械打字机不是把“字符对象”交给软件，而是让字模打击色带，在纸上留下痕迹。其擒纵机构控制字车每次移动一个字符宽度，按键、弹簧、字锤和字车共同形成一台机械状态机。

19 世纪 60 年代形成的 QWERTY 布局也来自机械约束。讲义用“降低打字速度”概括它；更精确地说，早期布局需要减少容易让相邻机构冲突、卡住的击键组合，而不只是给所有输入统一限速。无论历史细节如何，结论相同：**今天的软件接口里常有旧硬件约束凝固成的惯例。**

### 2.3 Shift、Caps Lock、CR/LF、空格、退格与 Tab

这些名字曾经描述真实机械动作：

- `Shift` 移动承载字模的机构，在同一按键的两套字符之间切换；
- `Caps Lock` 把这种移动锁住；
- CR（Carriage Return，`\r`，十六进制 `0d`）把字车送回行首；
- LF（Line Feed，`\n`，十六进制 `0a`）把纸推进一行；
- Space/Backspace 把位置向前/向后移动一格，退格后再打字符就能覆盖旧字符；
- Tab 前进到下一个预设 tab stop，使多行文字纵向对齐，因而叫“制表符”。

CR 和 LF 原本是两个动作，所以不同系统留下了不同文本约定：传统 UNIX 文本用单个 LF 表示换行，Windows 文本常用 CRLF。需要避免一句常见但不精确的话：**UNIX 文件里的 `\n` 并不同时存着 CR 和 LF 两个字节。** 在交互终端上，输出行规程常开启 `ONLCR`，把程序写出的 LF 映射成 CRLF，于是光标既下移又回到行首；这是终端配置，不是文件字节变了。

先做一个无副作用的小观察：

```bash
printf 'ABCDE\rxy\n'
printf 'ABCDE\rxy\n' | od -An -t x1
```

第一条命令通常看起来像 `xyCDE`：打印 `ABCDE` 后，CR 只让光标回到行首，`xy` 覆盖了前两个显示位置。第二条命令绕过视觉效果，直接证明字节依次包含 `0d` 和 `0a`。这也提醒我们：**字节流的内容**与**终端如何渲染它**是两层状态机。

### 2.4 电传打字机：键盘打字，远端打印

电传打字机（teletypewriter/teleprinter）把打字机接上电信线路，使发送端按键能让远端打印。20 世纪 20 年代的 Telex 交换网络甚至早于电子计算机；它使用过 Baudot 一类 5-bit 编码，通过 shift 状态在有限码位间切换字母和数字/符号。

Teletype Model 28（1951）体现了关键转变：

```text
本地机械动作 → 编码后的线路信号 → 远端机械动作
```

计算机只需替换“远端发送者或接收者”，便自然得到输入/输出设备。今天系统里的 `/dev/tty`、`stty`、`getty` 和驱动名中的 `tty`，都保留着 teletype 的名字。

### 2.5 Video TTY 与 VT100：纸换成屏幕，协议留下来

Video TTY 用显示器和光标替代纸、字车与打印头。DEC VT100（1978）成为里程碑：

- 最基本输出依然像反复调用 `putchar`，字符到来就显示；
- 它完整实现了一套 ANSI 风格的转义序列，程序能移动光标、清屏、设置显示属性；
- 80 列 × 24 行成为影响深远的标准布局。

普通可打印字符表达“画什么”，ESC 开头的控制序列表达“接下来如何解释”。例如：

```bash
printf '\033[31mred\033[0m normal\n'
printf '\033[2J\033[H'       # 清屏并把光标移到左上；运行前先看懂再执行
```

这里不是 `printf` 会画红字，而是它写出若干字节，终端模拟器识别 `ESC [ 31 m` 后改变渲染状态。若把同样输出重定向到文件，文件只会保存这些字节；`cat` 回终端后，控制效果才可能再次发生。这也意味着输出不可信文件时要警惕“终端转义注入”。

### 2.6 Unicode 带来的表现力，以及它没有解决的问题

ASCII 只有 128 个码位；Unicode 为世界文字和大量符号分配码点，UTF-8 再把码点编码为变长字节序列。终端因此能显示：

```text
▁▂▃▄▅▆▇█▇▆▅▄▃▂▁
 ▐▛███▜▌
▝▜█████▛▘
  ▘▘ ▝▝
```

Powerline 状态栏、toybox 一类终端效果，通常同时依赖 Unicode 字符、字体字形和 ANSI 控制序列。课堂展示这类效果的观察目标不是“记住一组酷炫字符”，而是把数据与控制分开：同一条输出流里，可打印字符提供内容，ESC 序列改变终端状态，终端模拟器再用字体把结果画出来。三者不要混淆：

- Unicode/UTF-8 决定“这些字节代表哪个码点”；
- 字体决定“码点长什么样”；
- ANSI/VT 控制序列决定颜色、光标和屏幕状态。

Unicode 也没有让“一个字符等于一个字节或一个显示格”。一个用户眼中的字符可能由多个码点组成；汉字通常占两个终端列宽；emoji、组合附加符和不同终端的宽度表还会造成错位。TUI 必须处理这些边界，不能简单用 `strlen()` 当屏幕宽度。

## 3. 终端作为输入设备：字节流、行规程与 PTY

### 3.1 键盘事件不等于终端输入字节

现代桌面先产生 key down/key up、扫描码、修饰键等事件，终端模拟器再依据布局和配置把它们编码成字节。单独按 `Shift` 通常不会向终端程序发送字节；`Shift` 与字母共同决定最终字符。方向键等没有单个 ASCII 码的按键，通常发送 ESC 开头的字节序列，例如上方向键常见为 `ESC [ A`，但具体序列取决于终端模式。

非 ASCII 文字通常以 UTF-8 多字节形式进入输入流。因此以下等式都不成立：

```text
一次按键 = 一个字节 = 一个 Unicode 字符 = 一个屏幕单元
```

应用若要精确解释按键，必须知道终端协议、编码和当前模式；终端并不是通用 GUI 键盘事件接口。

### 3.2 为什么 `read()` 能“自带编辑器”：终端行规程

程序执行：

```c
ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
```

若 fd 0 指向普通文件、管道或 socket，语义由相应对象决定；若它指向终端 slave，终端驱动中的**行规程**会介入。典型 canonical（规范）模式下：

1. 驱动接收输入字节；
2. `ECHO` 使驱动把可见反馈写回显示方向；
3. erase/kill 等特殊字符让驱动编辑内核缓冲中的当前行；
4. 收到换行、行结束字符或 EOF 条件后，等待中的 `read()` 才完成。

因此最简单的 `cat` 也像会退格编辑，并不是 `cat` 内置了编辑器。`stty -a` 会打印当前 `termios` 配置，常见项目包括：

- `icanon`：canonical 行缓冲；
- `echo`：输入回显；
- `isig`：把 `intr/quit/susp` 等特殊字符转成信号；
- `intr = ^C`、`eof = ^D`、`susp = ^Z`：当前按键绑定；
- `onlcr`：输出时把 NL 映射为 CR-NL。

raw 模式则通常关闭 canonical、echo、信号字符处理以及若干输入/输出转换，让应用尽可能直接得到字节。编辑器、Shell 的交互行编辑、密码输入、TUI 都会按需配置这些开关。

`Ctrl-D` 尤其容易误解：在默认 canonical 模式下，它通常不是让程序读到字节 `0x04`，而是让行规程立即提交当前缓冲；若缓冲为空，`read()` 返回 0，应用把它解释为 EOF。若当前已有 `abc`，第一次 `Ctrl-D` 可先让 `read()` 得到 `abc`，未必立即结束程序。

### 3.3 实验一：亲手区分 canonical 与 raw 输入

依赖：Linux/POSIX 终端、`stty`、Python 3。请在真实终端窗口中运行，不要从 IDE 的非 TTY 输出窗运行。

先观察 canonical 模式：

```bash
stty -a
python3 -c 'import os; print(repr(os.read(0, 100)))'
```

输入 `ab`，按一次退格，再输入 `c` 和回车。典型结果是：

```text
b'ac\n'
```

退格已经被行规程消费；Python 直到回车后才从 fd 0 得到编辑完成的一行。

再观察 raw 模式。下面的 `trap` 用于异常退出时恢复终端；程序只读五个字节，所以请直接键入五个 ASCII 字符，例如 `abcde`，无需回车：

```bash
saved_tty=$(stty -g) || exit 1
trap 'stty "$saved_tty"' EXIT HUP INT TERM
stty raw -echo
python3 -c 'import os; [print(os.read(0, 1).hex(), flush=True) for _ in range(5)]'
stty "$saved_tty"
trap - EXIT HUP INT TERM
```

预期逐次看到 `61`、`62`、`63`、`64`、`65`。无需回车、没有本地回显，说明交付粒度和回显都是终端状态，不是 `read` 函数签名规定的。raw 模式下 `Ctrl-C` 也可能只是 `03` 而非信号，所以不要依赖它退出；若实验中断导致显示异常，可在当前 Shell 盲打 `stty sane` 回车恢复。

这个实验还揭示三个层次：Python 的 `os.read` 最终请求读取 fd；内核终端对象决定何时返回；终端模拟器负责把输出字节画出来。Python 标准库不是行编辑发生的地方。

### 3.4 “理解终端”课堂 Demo 的观察目标

讲义中的“理解终端”Demo 让 AI 实现终端控制程序，甚至在终端里再实现一个终端模拟器。它不是为了背 ANSI 序列表，而是要建立以下观察：

1. 应用只向一个 fd 写字节，终端模拟器却维护光标、颜色、滚动区等内部状态；
2. 输入方向也只是字节协议，配置 `termios` 后同一按键能导致不同 `read` 结果；
3. “终端里的终端”并不神秘：外层程序读取内层 PTY master 的输出，解释并绘制，再把外层按键送回 master；
4. OS 提供的是对象与 API，视觉界面和交互策略主要由用户态程序完成。

复现时可以逐步增加功能：先只转发普通字符，再支持 CR/LF 和退格，最后支持少量 CSI 控制序列。每一步都打印收到的十六进制字节，能避免把“屏幕上看到的效果”误当作原始数据。

### 3.5 PTY：给软件制造一台“终端”

物理串口终端数量有限，但远程登录、终端窗口、tmux 和自动化测试都希望按需创建终端。伪终端（pseudo terminal, PTY）是一对相连的内核端点：

```text
键盘/GUI
    ↕
终端模拟器、sshd、tmux、script       用户态管理者
    ↕ read/write
PTY master  ═════ 内核 PTY ═════  PTY slave + 行规程
                                      ↕ fd 0/1/2
                                  Shell / 前台作业
```

把 PTY 简化成“一对双向管道”有助入门，但并不完整。slave 具有真正终端的 `termios`、窗口大小、前台进程组和特殊字符语义；普通管道没有这些 `ioctl` 状态。master 一侧通常由终端模拟器持有，slave 一侧看起来像 `/dev/pts/0`、`/dev/pts/1` 等终端设备。

Linux 上创建 PTY 的典型路径是：

1. 打开 `/dev/ptmx` 得到 master；
2. 调用 `grantpt()`、`unlockpt()`；
3. 用 `ptsname()` 得到 slave 名字并打开它；
4. 子进程建立会话、取得控制终端，把 slave `dup2` 到 0/1/2，再 `execve()` Shell 或应用；
5. 父进程在 master 与窗口、网络或文件之间转发数据。

实际程序通常使用 `posix_openpt()`、`openpty()` 或 `forkpty()` 封装细节。是否自动建立 session/controlling tty 要以所用 API 和手册为准，不能仅凭“有了 slave fd”推断。

### 3.6 实验二：在一个终端里生成另一个 PTY

依赖：Python 3 的标准库与支持 PTY 的 UNIX 系统。

先在外层 Shell 记录终端名，然后用 `pty.spawn` 创建一个连接到新 PTY 的 `/bin/sh`：

```bash
tty
python3 -c 'import pty; raise SystemExit(pty.spawn(["/bin/sh"]))'
```

进入内层 Shell 后执行：

```bash
tty
ps -o pid,ppid,sid,pgid,tpgid,stat,tty,comm -p $$
stty -a
exit
```

典型观察是内外 `tty` 名不同；内层 Shell 的 fd 0/1/2 连接新 slave，Python 父进程在 master 与外层终端之间转发。`SID/PGID/TPGID` 列则为后面的会话与作业控制埋下证据：`TPGID` 是该终端当前前台进程组，而不是“当前某个 PID”。

若环境没有真正的 TTY（例如某些 CI），`tty` 会报告 `not a tty`，交互实验无法说明行规程；这不是 Python 出错，而是实验前提不存在。

### 3.7 `ttyrec/ttyplay`：记录协议，而不是录屏像素

终端模拟器已经能看到从 PTY 流出的所有字节。给每段输出加时间戳并保存，就得到 ttyrec；按原时间间隔把字节重新喂给终端，就得到 ttyplay。

课堂 Demo 希望观察的是：字符终端的界面由**确定的字节事件流 + 时间**重建，不必录制每一帧像素。这种记录体积小、可搜索，却也有边界：

- 结果依赖回放终端对控制序列、Unicode 宽度和字体的实现；
- 若同时记录输入，密码等秘密可能进入日志；
- 全屏程序可能依赖窗口大小变化，严谨格式还要记录 resize 事件。

### 3.8 字符终端不够时：Sixel、图形协议与 WebView

DEC 在 VT200 时代就设计了 Sixel：一个数据单元编码一列中的六个像素开关，颜色由调色板等状态控制。现代 Kitty、Windows Terminal 等终端又支持各自或兼容的图像协议。它们沿用同一个思想：在字节流中嵌入一种双方约定的绘图语言。

讲义进一步提到在终端中内嵌 WebView，以及 2025 年 12 月出现的 Google A2UI。这不是说传统 PTY 已经自动支持任意 GUI，而是在追问边界：如果双方都能协商更丰富的结构化 UI 协议，字符流可以继续扩展；但安全、兼容、布局、输入路由和能力协商也随之复杂。终端之所以长寿，正因为最小字符协议足够稳定；每个“更丰富”的扩展都要付出新的生态成本。

## 4. 终端与操作系统：从登录到多进程 TUI

### 4.1 终端是人机交互的入口

传统本地登录大致经历：

```text
kernel → init/service manager → getty → login → user's shell
```

`getty` 准备终端、显示登录提示并启动 `login`。远程 SSH 则大致是：

```text
sshd → fork/openpty → authentication/session setup → user's shell or command
```

最终，登录 Shell 的 stdin/stdout/stderr 通常都指向终端 slave。建立者还会安排 session 和 controlling terminal，使终端知道哪一组进程在前台。

讲义引用 `login` 手册说它“建立一个新 session”，随后特别提醒：不要只按自然语言误判系统调用层面的事实。在常见实现中，session 往往由 `getty`、`sshd` 或 PAM/登录路径中更早的步骤建立，`login` 继承已有关系并完成身份、环境和 Shell 启动。要判断“谁调用了 `setsid`”，应查看具体实现或用追踪工具观察，不能仅从程序名推断。

### 4.2 TUI：终端状态机之上的用户态界面

默认 `read()` 的行编辑来自内核，但 Vim、less、top、Python Textual 等 TUI 通常会切换 raw/cbreak 模式，自己解析按键并发送控制序列重绘屏幕。常见机制包括：

- 关闭 canonical 与 echo，逐字节接收输入；
- 查询窗口尺寸，处理 `SIGWINCH`；
- 使用 alternate screen，退出时恢复原屏幕；
- 隐藏/移动光标、设置颜色、只重绘变化部分；
- 正确处理 UTF-8、组合字符和显示宽度。

可尝试课程所示的 `python3 -m textual`；具体是否可运行取决于是否安装 Textual 以及其版本。Demo 的目标不是某个 doge 界面，而是观察“漂亮 UI”仍可落到终端输入字节与输出控制序列。

### 4.3 “TUI 是多进程的”是什么意思

从用户视角，一个终端窗口里会依次或并行存在终端模拟器、Shell、管道各阶段、编辑器启动的编译器、后台任务等多个进程。一个前台作业本身也可能是：

```bash
producer | filter | pager
```

三个进程都在同一屏幕语境中工作。终端若像 GUI 窗口管理器一样支持“关闭当前应用”，就不能只记住某个 PID：管道中的所有前台进程都属于当前作业，而后台任务不能被误伤。这正是信号、进程组与会话登场的需求。

## 5. `Ctrl-C` 到底发生了什么：字符、信号和接收者

### 5.1 从 `0x03` 到 `SIGINT`

在 ASCII 中：

- `Ctrl-C` 通常产生 ETX，字节 `0x03`；
- `Ctrl-D` 通常产生 EOT，字节 `0x04`；
- `Ctrl-Z` 通常产生 SUB，字节 `0x1a`。

终端模拟器主要负责传递字节。若 slave 的行规程启用了 `ISIG`，且 `intr = ^C`，内核识别 `0x03` 后不会把它当普通输入交给前台程序，而是向该终端的前台进程组发送 `SIGINT`。因此完整路径是：

```text
按键 Ctrl-C
  → 终端模拟器写 0x03 到 PTY master
  → slave 行规程检查 ISIG/intr
  → 内核查 controlling tty 的 foreground PGID
  → 向该进程组的每个成员生成 SIGINT
  → 各进程按 mask/disposition 处理
```

关闭 `ISIG` 或重新绑定 `intr` 后，路径会改变。把 stdin 换成普通管道也不会凭空产生终端信号。

### 5.2 信号：异步改变进程控制流

进程可以用 `sigaction()` 为可捕获信号安装 disposition。信号到达且未被屏蔽时，内核安排用户态执行 handler；handler 返回后通常回到被中断的位置，或者系统调用以 `EINTR` 失败/按 `SA_RESTART` 规则重启。

现代代码应优先用 `sigaction`，因为它能明确设置 mask、flags 和 handler。handler 在异步时刻插入执行，不能安全调用任意库函数；常用策略是只设置 `volatile sig_atomic_t` 标志，或向预先建立的 pipe 写一个字节，再让主循环完成清理。

“终止信号也能执行清理代码”必须带边界：`SIGTERM`、`SIGINT` 等可以捕获；`SIGKILL` 和 `SIGSTOP` 不能捕获、阻塞或忽略。段错误等同步故障即使可安装 handler，也不能假定返回后程序仍可安全继续。

课堂“信号处理”Demo 的观察目标是：

1. 安装 `SIGINT` handler 后，`Ctrl-C` 的默认终止动作被替换，所以程序可以不退出；
2. 信号不是一次普通函数调用，而是由内核异步插入控制流；
3. 正确程序应让 handler 做最少工作，再由正常控制流清理退出；
4. `kill` 这个名字具有误导性：`kill(pid, sig)` 是“发送信号”，信号不一定杀死进程。

### 5.3 更难的问题：信号发给谁

`fork()` 形成进程树，但父子关系不等价于交互作业：

- 某个进程可再派生很多辅助进程；
- 后台作业和前台作业可能同为 Shell 的子孙；
- 进程会退出、被托孤或改变父进程；
- 一个用户可同时使用多个终端；
- 一条管道的多个兄弟进程应一起收到前台终端信号。

因此“沿进程树找当前进程”既含糊又容易误伤。UNIX 引入进程组表示一项作业，再由终端保存“当前前台进程组”的 PGID。

### 5.4 实验三：`Ctrl-C` 命中整条前台管道

依赖：交互式、启用 job control 的 UNIX Shell 与 Python 3。在终端中运行：

```bash
python3 -c 'import os,signal,sys,time; signal.signal(signal.SIGINT, lambda s,f: (print(f"left  pid={os.getpid()} pgid={os.getpgrp()}", file=sys.stderr), sys.exit(130))); time.sleep(999)' |
python3 -c 'import os,signal,sys,time; signal.signal(signal.SIGINT, lambda s,f: (print(f"right pid={os.getpid()} pgid={os.getpgrp()}", file=sys.stderr), sys.exit(130))); time.sleep(999)'
```

按一次 `Ctrl-C`。典型结果是左右两个进程都打印消息并退出，而且显示相同 PGID。它们的 PID 不同，也没有依赖管道传递 `0x03`；内核根据终端前台 PGID 向整组发送 `SIGINT`。

若在不支持 job control 的非交互 Shell、容器入口或 IDE 中运行，分组可能不同。可另开终端，在命令运行时查看：

```bash
ps -o pid,ppid,sid,pgid,tpgid,stat,tty,comm -t "$(tty | sed 's#/dev/##')"
```

`PGID` 表示进程所属组；同一终端行里 `TPGID` 通常相同，表示终端当前承认的前台组。两列相等的成员才是当前前台作业。

## 6. UNIX 会话、进程组与 Job Control

### 6.1 最小关系模型

除了 PID，相关进程还带两个分组编号：

```text
Session (SID)：一次登录/终端活动的大分组
└── Process Group (PGID)：一项作业
    ├── process A (PID)
    ├── process B (PID)
    └── process C (PID)
```

关键不变量和惯例是：

- 子进程通过 `fork()` 继承父进程的 SID 和 PGID；
- Shell 为一条 pipeline 中的所有进程设置同一个新 PGID；
- 一个 session 最多关联一个 controlling terminal；
- 一个终端在任一时刻记录至多一个 foreground PGID；
- 行规程产生的 `SIGINT`、`SIGQUIT`、`SIGTSTP` 发给前台进程组；
- 后台组若直接读取控制终端，通常收到 `SIGTTIN`；在相应配置下写控制终端可收到 `SIGTTOU`。

讲义用“session leader 退出时全体收到 SIGHUP”帮助建立直觉，但真实规则更细：控制终端 hangup、会话首进程终止、终端关闭以及孤儿进程组停止等场景有各自的 `SIGHUP`/`SIGCONT` 规则，不能把它当成对 session 所有成员无条件广播。可依赖的核心语义是：`SIGHUP` 表示终端/会话联系断开，守护进程常选择捕获它以重新加载配置。

### 6.2 API 为什么看起来“不优雅”

POSIX 暴露了多组相互约束的 API：

- `setsid()/getsid()`：创建新 session、查询 SID；成功的 `setsid()` 调用者成为 session leader 和新进程组 leader，并脱离原控制终端；已有进程组 leader 不能直接成功调用它；
- `setpgid()/getpgid()`：建立/查询进程组；交互 Shell 和子进程需在 `exec` 竞态前后谨慎配合；
- `tcsetpgrp()/tcgetpgrp()`：设置/查询某个终端的前台进程组；调用者必须满足会话与控制终端约束；
- `tcgetattr()/tcsetattr()`：读取/修改 `termios` 行规程状态。

这些 API 之所以迷惑，是因为它们在进程创建、终端所有权、异步信号和历史兼容之间维持不变量。用“编号图 + 当前终端状态”推理，比背函数名有效。

讲义还顺带提到 real/effective/saved UID，以及论文 *Setuid Demystified*。它们不是终端 job control 的组成部分，却体现相同现象：为了兼容权限切换、登录和既有应用，UNIX 接口不断累积状态与例外。软件一旦进入标准和生态，就很难重新设计成一张白纸。

### 6.3 Shell 怎样实现 `Ctrl-Z`、`fg` 和 `bg`

交互 Shell 启动作业的大致算法如下：

1. 为 pipeline 创建所有 pipe；
2. `fork()` 各阶段，并用 `setpgid` 把它们放入同一新进程组；
3. 前台作业用 `tcsetpgrp` 把终端前台 PGID 交给该组；
4. Shell 等待整个组退出或停止，常用 `waitpid(..., WUNTRACED | WCONTINUED)`；
5. 用户按 `Ctrl-Z` 时，终端向前台组发 `SIGTSTP`，默认动作是停止；
6. Shell 重新取得终端，记录作业状态并显示 jobs 信息；
7. `bg` 给停止组发 `SIGCONT`，但不转交终端；`fg` 则先转交终端，再发 `SIGCONT` 并等待；
8. 作业结束/再次停止后，Shell 用 `tcsetpgrp` 取回终端。

这很像只有一个可见窗口的窗口管理器：

- `Ctrl-Z` 是“暂停/最小化”；
- `fg` 是切到前台；
- `bg` 是在不可读取终端输入的后台继续；
- 前台进程组是当前获得键盘与终端信号路由的“窗口”。

需要注意，`SIGTSTP` 可被捕获或忽略，`SIGSTOP` 则不可；Shell 自己还要调整对 `SIGINT/SIGTSTP/SIGTTOU` 等信号的处理，避免它在转交终端时把自己停掉。

### 6.4 实验四：观察一个后台作业的 SID、PGID 和 TPGID

在交互式 Bash/Zsh 中运行：

```bash
sleep 300 | sleep 300 &
jobs -l
ps -o pid,ppid,sid,pgid,tpgid,stat,tty,comm -t "$(tty | sed 's#/dev/##')"
fg
```

`jobs -l` 会显示 pipeline 中的进程；`ps` 通常显示它们共享 PGID，但后台组的 PGID 不等于终端的 TPGID。执行 `fg` 后再从另一终端运行同一条 `ps`，可看到 TPGID 切换到该作业。回到原终端按 `Ctrl-Z`，Shell 取回前台权并报告 stopped；最后执行：

```bash
jobs
fg
# 作业重新占据前台后，按 Ctrl-C 结束两个 sleep
```

这会让作业重新占据前台，再由终端把 `SIGINT` 发给整组并完成清理。作业编号 `%1` 一类名字是 Shell 自己维护的，不是 PID、PGID 或内核通用句柄。

### 6.5 历史包袱与现代替代思路

session/PGID/controlling tty 是 POSIX 的一部分，今天必须理解和兼容；但它们并非交互管理的唯一可能设计。PTY 出现并普及后，用户态管理者可以给每个应用单独分配 PTY，再选择性地把某个 PTY 的画面和输入呈现出来：

- tmux/Sway/桌面 window manager 管理多个“窗口”和应用生命周期；
- 关窗口时可按进程组、cgroup 或更强的容器边界清理整项应用；
- Android 常用不同 UID 隔离不同 app，按 UID 管理能力与生命周期；
- Snap 等沙箱再叠加 AppArmor、seccomp、namespaces 等限制。

讲义称传统 job control 为“历史的糟粕”，重点不是否认它仍然有效，而是训练设计判断：早期没有 PTY、容器和现代 GUI 时，把进程直接绑定到控制终端是合理机制；新需求出现后，用户态模拟和更强隔离对象往往更容易组合。任何人都很难预见软件接口几十年后的全部用途。

## 7. UNIX Shell：把系统调用变成一门编程语言

### 7.1 UNIX 哲学为什么需要语言支撑

UNIX 哲学常被概括为：

- 做一件事并做好；
- 小工具协同工作；
- 用文本流作为通用接口。

但有 `grep`、`sort`、`wc` 并不自动产生组合能力。Shell 提供语法，把它们组装为新的程序：

```bash
find sources/notes -name 'lect*.md' -print0 |
  xargs -0 rg -n '^# Takeaways' |
  sort
```

这个 pipeline 可直接复用：`find` 用 NUL 分隔避免空格灾难，`xargs -0` 恢复参数边界，`rg` 产生文本记录，`sort` 再排序。它体现“稳定小接口 + 组合语言”，也诚实暴露文本协议需要显式处理边界。

Shell 常被称为“只有字符串的语言”。这是很好的最小模型：命令名、参数、变量和替换结果最终都要形成字符串/字节序列与 fd 连接。现代 Shell 也有整数算术、数组等扩展，POSIX Shell 也有算术展开；讲义用 `expr 1 + 2` 调侃的是其核心数据模型和历史限制，而不是断言所有实现绝无数字功能。

### 7.2 一行 Shell 如何变成系统调用

以：

```bash
producer < input | filter 2>/dev/null > output &
```

为例，Shell 大致经历：词法/语法解析 → 各类展开 → 建 pipe → fork 子进程 → 安排 PGID → 打开重定向文件 → `dup2` 文件描述符 → `execve` → 前台则等待、后台则返回提示符。

常见语法和机制的对应关系是：

| Shell 构造 | 主要机制 | 关键语义 |
| --- | --- | --- |
| `$(cmd)` | pipe/fork/exec/read/wait | 捕获命令标准输出，作为文本参与展开 |
| `<(cmd)` | pipe 或 `/dev/fd` + fork | 进程替换；常见于 Bash/Zsh，但不是 POSIX `sh` |
| `cmd >f`、`cmd <f` | `open` + `dup2` | 在执行命令前替换 fd 1 或 0 |
| `2>/dev/null` | `open` + `dup2` | 单独替换标准错误 fd 2 |
| `a ; b` | 顺序执行 | 不论 `a` 状态如何，随后执行 `b` |
| `a && b` | `wait` + 检查退出状态 | `a` 成功（状态 0）才执行 `b` |
| `a || b` | `wait` + 检查退出状态 | `a` 非 0 才执行 `b` |
| `a | b` | `pipe` + 多次 fork/exec | 连接 `a` 的 stdout 与 `b` 的 stdin |
| `cmd &` | 不同步等待 + job table | 后台启动，并在交互 Shell 中管理其作业状态 |

“命令翻译成系统调用”是机制模型，不是说每种语法恰好对应一次调用。真实 Shell 还要处理引号、变量、通配符、here-document、内建命令、错误恢复、信号竞态和优化；外部命令通常经 libc wrapper 进入内核。

### 7.3 展开、分词与引用：文本替换为何既强大又危险

考虑：

```bash
name='two words'
printf '<%s>\n' $name
printf '<%s>\n' "$name"
```

第一条未引用展开在许多 Shell 语境中经历字段分割，得到两个参数；第二条保留一个参数。通配符还可能把 `*` 展开为若干路径名。Shell 的真正难点不在 `fork()`，而在“哪些字符何时仍是语法，何时已经是数据”。

因此：

- 变量展开通常写成 `"$var"`；
- 处理任意文件名优先用 NUL 分隔或数组，不要用 `for f in $(find ...)`；
- 不可信输入不要拼接进 `sh -c`/`eval`，应构造参数数组并直接 `execve`；
- Shell 变量不是带 schema 的结构化对象，跨程序文本格式必须自己定义转义和错误处理。

### 7.4 重定向的最小实现

讲义利用“子进程继承文件描述符”实现重定向。下面给出补全错误检查后的骨架；它不是完整 Shell，只展示 `child < in > out`：

```c
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

static void die(const char *s) {
    perror(s);
    exit(EXIT_FAILURE);
}

int main(void) {
    int fd_in = open("input.txt", O_RDONLY | O_CLOEXEC);
    if (fd_in < 0) die("open input.txt");

    int fd_out = open("output.txt",
                      O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
    if (fd_out < 0) die("open output.txt");

    pid_t pid = fork();
    if (pid < 0) die("fork");
    if (pid == 0) {
        if (dup2(fd_in, STDIN_FILENO) < 0) {
            perror("dup2 stdin");
            _exit(126);
        }
        if (dup2(fd_out, STDOUT_FILENO) < 0) {
            perror("dup2 stdout");
            _exit(126);
        }
        if (close(fd_in) < 0) {
            perror("close input in child");
            _exit(126);
        }
        if (close(fd_out) < 0) {
            perror("close output in child");
            _exit(126);
        }

        char *const argv[] = {"cat", NULL};
        execvp(argv[0], argv);
        int saved_errno = errno;
        perror("execvp cat");
        _exit(saved_errno == ENOENT ? 127 : 126);
    }

    if (close(fd_in) < 0) die("close input");
    if (close(fd_out) < 0) die("close output");

    int status;
    while (waitpid(pid, &status, 0) < 0) {
        if (errno != EINTR) die("waitpid");
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
```

`O_CLOEXEC` 防止原始 `fd_in/fd_out` 意外泄漏到新程序；`dup2` 得到的 fd 0/1 按所需语义继续跨越 `exec`。父子都关闭不再需要的引用。管道实现还要更严格地关闭每个阶段不用的端，否则读者可能永远看不到 EOF。

### 7.5 实验五：复用 `pipeline.c` 看见 Shell 的骨架

仓库的 [examples/pipeline.c](../../examples/pipeline.c) 实现了等价于：

```bash
printf 'red\ngreen\nblue\n' | wc -l
```

编译运行：

```bash
make -C examples pipeline
./examples/pipeline
```

预期输出 `3`。源码创建 pipe，fork producer 和 consumer；producer 把 pipe 写端 `dup2` 到 1，consumer 把读端 `dup2` 到 0，然后分别 `exec`。父进程关闭两端并 `waitpid` 两个孩子。

Linux 上若安装了 `strace`，继续观察：

```bash
strace -f \
  -e trace=clone,fork,vfork,execve,pipe,pipe2,dup2,close,wait4 \
  ./examples/pipeline
```

不同 libc/内核可能用 `clone` 实现 `fork`、用 `pipe2` 实现 pipe，所以跟踪同时列出这些名字。观察目标不是逐行背 trace，而是确认：

1. pipe 必须在 fork 前创建，孩子才能继承其 fd；
2. `dup2` 发生在 `execve` 前，新程序只看到已安排好的 0/1；
3. 每个进程都关闭无用端；父进程若保留写端，`wc` 就等不到 EOF；
4. `execve` 后 PID/PGID 没有因“换程序”自动变化，只是地址空间被替换。

把该示例扩展成三段 pipeline 时，需要两个 pipe、三个孩子；每个孩子只保留自己的输入/输出端。这是很好的独立练习，但不涉及课程 MiniLab 的直接答案。

### 7.6 重定向和管道的优先级：`ls > a.txt | cat`

按 POSIX/Bash 常见语义，pipeline 先把 `ls` 的 stdout 指向 pipe，随后 `ls` 自身的 `> a.txt` 重定向覆盖 fd 1，所以 `cat` 收到 EOF，内容进入文件：

```bash
rm -f /tmp/lect08-a.txt
printf 'hello\n' > /tmp/lect08-a.txt | wc -c
wc -c < /tmp/lect08-a.txt
```

典型输出先是 `0`，再是 `6`。不过 Zsh 默认的 `MULTIOS` 等扩展可能把多个输出目标做成类似 tee 的效果，正是讲义所说 Bash/Zsh 行为可能不同。写脚本时：

- shebang 明确解释器；
- 若写 `#!/bin/sh`，只依赖 POSIX `sh` 语义，不要混入 Bash/Zsh 扩展；
- 若确实需要 Bash 数组、`<(...)` 等，就写 `#!/bin/bash` 并承认依赖。

即使同叫 `sh`，不同系统也可能链接到 dash、bash 或其他兼容实现；“可执行”不等于“跨 Shell 可移植”。

### 7.7 重定向顺序与 `sudo` 三明治

描述符复制是有顺序的：

```bash
sh -c 'printf "out\n"; printf "err\n" >&2' > /tmp/all.log 2>&1
sh -c 'printf "out\n"; printf "err\n" >&2' 2>&1 > /tmp/out.log
```

第一条先让 fd 1 指向文件，再让 fd 2 复制 fd 1，所以都进 `all.log`。第二条先让 fd 2 复制当时仍指向终端的 fd 1，再单独改 fd 1，所以 `err` 仍显示在终端。

同理：

```bash
sudo echo hello > /etc/a.txt
```

当前 Shell 必须先以当前用户权限打开 `/etc/a.txt`，成功后才可能执行 `sudo echo`；因此仍会 `Permission denied`，错误甚至发生在 `sudo` 启动前。常见写法是让有权限的进程执行打开：

```bash
printf '%s\n' hello | sudo tee /etc/a.txt >/dev/null
# 或明确让提升权限后的 shell 执行重定向：
sudo sh -c 'printf "%s\n" hello > /etc/a.txt'
```

这些命令会修改系统文件，不应为练习直接照抄运行。关键观察是：**Shell 语法属于谁，系统调用就由谁执行。** `sudo` 不会追溯性地提升父 Shell 已经做出的 `open()`。

### 7.8 读手册：先建立概念，再让 AI 帮助遍历

`man sh` 对 Shell 的定义非常朴素：它从文件或终端读命令，解释并通常执行其他命令；登录后运行的 Shell 也只是一个程序。可按层次阅读：

```bash
man 1 dash       # 用户命令/语言实现
man 1 sh         # 本机 sh 手册入口
man 2 open       # 系统调用接口
man 2 dup2
man 2 execve
man 3 execvp     # libc 函数
man 3 termios    # Linux/POSIX 终端配置接口（系统章节可能不同）
man 7 signal
```

手册节号非常重要：`printf(1)` 可能是外部命令，`printf(3)` 是 libc 函数；Shell 还可能有自己的 builtin `printf`。同名不代表同一层实现。

AI 时代仍要遍历手册，因为手册提供本机实现的参数、失败条件、标准归属和交叉引用，帮助建立正确概念。讲义示例 `man -P cat ls | claude 'Make a comprehensive summary'` 展示“先取得权威文本，再让模型整理”；使用任何联网模型前还应确认输入不含私密的本机配置。模型摘要不能替代对关键 precondition、error 和版本差异的核查。

## 8. Shell 的优点、代价与最小实现

### 8.1 1970 年代约束下的惊人成功

Shell 的优势很适合交互和“胶水”任务：

- 启动外部工具就是函数调用般自然；
- 文件、pipe 和 fd 让组合边界稳定；
- 每一步都能单独在终端试验；
- 文本便于人读、记录、版本管理和临时检查；
- 极少语法就能表达并行 pipeline、条件和重定向。

它的代价也来自相同选择：

- 变量与命令输出主要是文本，缺少可靠静态类型和 schema；
- 引用、分词、glob 和多阶段展开容易制造边界错误；
- 错误传播依赖退出状态，pipeline/`set -e` 语义有大量细节；
- 每个小工具常对应新进程，大规模细粒度计算效率不佳；
- 不同 Shell 的扩展和历史兼容会造成语义差异。

PowerShell 选择传递结构化对象，解决了一部分文本类型问题，却要付出另一套生态、对象模型与兼容成本。不存在脱离历史和生态的“免费重写”。对于复杂业务逻辑，及时换用 Python、Go、Rust 等语言；对于短小、可审计的系统组合，Shell 仍非常强大。

### 8.2 Zero-dependency UNIX Shell 的机制证明

讲义展示来自 xv6 思路的 zero-dependency shell：只依靠系统调用，支持：

- `ls > a.txt` 一类重定向；
- `ls | wc -l` 一类管道；
- `ls &` 后台执行；
- `(echo a ; echo b) | wc -l` 命令组合。

一个最小实现通常把语法解析成几类节点：

```text
EXEC(argv)          运行外部程序
REDIR(cmd, fd, ...) 打开文件并替换描述符，再执行 cmd
PIPE(left, right)   建 pipe，分别执行两棵子树
LIST(left, right)   等左边后执行右边
BACK(cmd)           fork 后不在当前路径同步等待
```

递归执行这棵树，最终只需要 `read/write/open/close/dup/pipe/fork/exec/exit/wait` 等精简接口。这是 Demo 的核心观察：**内核不需要内置“管道命令”或“重定向语法”；稳定的进程和 fd API 足以让用户态长出 Shell，Shell 又让更多应用互相组合。** 应用需求反过来推动 PTY、job control、`poll` 等 OS 功能，二者螺旋生长。

“zero dependency”还要精确定义。`-ffreestanding` 只告诉 C 编译器不能假定完整 hosted 环境；它本身不会自动消除 libc、编译器 helper 或启动文件。Linux 上真正不依赖 libc 往往还需：

- 自己提供 `_start` 和系统调用汇编桩；
- 使用 `-nostdlib` 等合适的编译/链接选项；
- 避免触发隐式 `memcpy`、除法 helper、栈保护等未提供符号；
- 按架构 ABI 传参并直接执行 syscall；
- 自己实现字符串、分配、错误格式化等所需功能。

xv6 的用户环境和 Linux ABI 也不同，不能把 xv6 shell 源码直接当作 Linux 的二进制接口。这个例子是“系统调用可构建应用世界”的最小证明，不是说日常软件应拒绝 libc。恰恰相反，下一讲会解释为什么把这些重复细节沉淀到 libc 更合理。

### 8.3 Shebang：把文本解释器接入 `execve`

创建一个独立实验脚本：

```bash
script_path=/tmp/lect08-shebang
printf '%s\n' '#!/bin/sh' 'printf "argv0=%s arg1=%s\n" "$0" "$1"' > "$script_path"
chmod +x "$script_path"
"$script_path" hello
```

预期输出中，`$0` 是脚本路径，`$1` 是 `hello`。执行权限和首行都不可少。

当 `execve()` 发现文件以 `#!` 开头时，系统把首行指定的解释器（以及可选参数）用于重新发起执行，并把脚本路径和原参数交给解释器。概念上类似：

```text
execve("./tool", ["./tool", "hello"], env)
  ⇒ execve("/bin/sh", ["/bin/sh", "./tool", "hello"], env)
```

具体 `argv[0]`、可选参数切分和长度限制存在系统差异，应查本机 `execve(2)`。几个重要边界是：

- shebang 是可执行文件加载协议，不是 Shell 独有语法；解释器可以是 Python、Perl 或自制程序；
- `#` 恰好又是很多脚本语言的注释，所以解释器读到首行通常能忽略它；
- `/usr/bin/env python3` 可按 `PATH` 找解释器，但引入环境依赖；多个参数常需 `env -S`，其可移植性要单独核查；
- 没有 shebang 的文本文件被某些 Shell“兜底解释”是 Shell 行为，不应冒充内核保证；
- setuid 脚本通常因竞态与安全问题不按普通 setuid 可执行文件处理。

课堂 Shebang Demo 的观察目标是：先用 `strace -f -e execve ./script` 看脚本如何进入解释器，再故意改错解释器路径观察 `ENOENT`。即使脚本文本存在，shebang 指定的解释器不存在时，执行也会报告“文件不存在”一类错误；错误指的是加载链缺失，不一定是脚本本身消失。

## 9. 分层辨析与常见误区

### 9.1 五个层次不要混为一谈

| 层次 | 本讲实例 | 不负责什么 |
| --- | --- | --- |
| 硬件/窗口系统 | 键盘事件、GUI 绘制 | 不直接规定 canonical `read` |
| 终端模拟器 | ANSI/Unicode 渲染，连接 PTY master | 不实现被启动程序的业务逻辑 |
| 内核终端/进程机制 | PTY slave、行规程、信号、PGID/SID、fd | 不解析 Shell 的 `|` 和 `>` 语法 |
| Shell 语言/实现 | 展开、pipeline、重定向、job table | 不改变 `execve` 后目标程序的源码语义 |
| libc/语言运行时 | `printf`、`open` wrapper、`sigaction` wrapper、启动代码 | 不是 C 语言语法，也不等于内核实现 |

### 9.2 高频误区

- **“终端就是黑色窗口。”** 窗口是终端模拟器 UI；程序通常连接 PTY slave，二者是不同进程/对象。
- **“按一个键，`read` 就得到一个字符。”** 输入可能被行规程缓存，也可能是多字节 UTF-8 或 ESC 序列。
- **“`Ctrl-C` 就是 `kill -9`。”** 默认是前台组的 `SIGINT`，可捕获；`SIGKILL` 不可捕获，且不是终端默认产生的信号。
- **“`Ctrl-D` 发送永久 EOF。”** canonical 模式下它提交当前缓冲；空缓冲才让该次 `read` 返回 0。
- **“父子关系足以实现 job control。”** 一项 pipeline 常由兄弟进程组成，且树关系会变化；交互作业用 PGID。
- **“session leader 一退出，session 所有成员总会 SIGHUP。”** 实际 hangup 与孤儿组规则更细，应查 `setsid(2)`、`termios(3/7)`、`exit(3)` 等本机手册。
- **“信号 handler 里可以随便 `printf`。”** 多数 libc 函数不是 async-signal-safe；让 handler 只设标志或写 self-pipe。
- **“重定向由命令自己完成。”** Shell 在 `execve` 前 `open/dup2`；因此 `sudo echo > file` 提升错了执行者。
- **“Shell 管道传递一行行字符串。”** pipe 是字节流，不保留行或消息边界；“行”是应用协议。
- **“`#!/bin/sh` 等于 Bash。”** 它选择本机 `/bin/sh`，脚本应遵守相应兼容语义。
- **“`-ffreestanding` 就是零依赖。”** 仍可能链接启动文件、libc 或编译器 helper；需检查最终 ELF 和未定义符号。
- **“C 代码直接调用了内核的 `open` 函数。”** 日常程序通常调用 libc wrapper，再按 ABI 进入 syscall；下一讲专门拆解这一层。

## 10. 本讲小结

本讲从打字机的字车一路走到可编程 Shell，核心不是怀旧，而是看清历史如何沉积成接口：

1. CR/LF、退格、Tab、TTY 名称和 80×24 布局都带着机械设备的影子；
2. 终端把输入输出表现为字节流，行规程在 slave 一侧加入编辑、回显和特殊字符；
3. PTY 把终端虚拟化，使终端模拟器、SSH、tmux、录制和自动化测试成为普通用户态程序；
4. `Ctrl-C` 经行规程变成发往前台进程组的 `SIGINT`，SID/PGID/controlling tty 共同支撑多进程 job control；
5. Shell 是一门把 `open/dup/pipe/fork/execve/waitpid` 组合起来的文本语言；
6. 文本组合和历史兼容让 Shell 极其普及，也带来引用、类型、错误传播和跨实现差异；
7. freestanding shell 与 shebang 证明稳定的 OS API 能生长出应用世界，而这种世界要工程化，就需要 libc 的封装与复用。

一句话总结：**终端把人变成字节与信号，Shell 把字节、进程和操作系统对象变成程序。**

## 11. 思考题

1. 若关闭 `ISIG` 但保留 canonical 模式，按 `Ctrl-C` 时 `read()` 最终可能看到什么？还需什么条件才会返回？
2. 为什么窗口大小变化通常用 `SIGWINCH` 通知，而字符输出本身不足以表达窗口变窄？
3. 一条三段 pipeline 应有几个 pipe？每个孩子和父进程分别要关闭哪些端，才能保证 EOF 正确到达？
4. 为什么后台进程读取控制终端会收到 `SIGTTIN`？如果没有这条规则，会破坏什么交互抽象？
5. `cmd >f 2>&1` 与 `cmd 2>&1 >f` 的 fd 图分别是什么？请在每一步画出 1、2 指向的对象。
6. 一个 Shell 为什么必须把 `cd` 实现为 builtin，而不能总是 fork 子进程执行 `/bin/cd`？
7. 若脚本首行是 `#!/missing/interpreter`，为何有时错误看起来像“脚本不存在”？用 `strace` 如何定位加载链中的真正缺口？
8. 设计 ttyrec 格式时，除了输出字节与时间戳，还应记录哪些状态才能尽量稳定地重放 TUI？
9. PowerShell 的结构化对象管道解决了哪些文本问题？它又牺牲了哪些跨语言、跨机器或透明调试属性？
10. 如果不用 libc 写 Linux shell，哪些看似普通的 C 表达式可能让编译器偷偷引入外部 helper？如何用 `readelf -Ws` 或 `nm -u` 验证？

## 12. 下一讲衔接：Shell 之下为何总能看到 libc

本讲为了说明机制，多次把命令写成 `open → dup2 → execvp`。但这条箭头中藏着重要分层：`open()`、`execvp()`、`perror()` 是用户态 API；内核只按系统调用 ABI 接收编号和寄存器参数；`execvp` 还会搜索 `PATH`，`perror` 要读取线程局部的 `errno` 并格式化消息。这些都不是 C 语法凭空提供的。

下一讲《C 标准库和实现》将从 freestanding/hosted 环境出发，解释 libc 如何：

- 封装 ISA、ABI 和系统调用；
- 提供字符串、内存、数学与控制流工具；
- 在 fd 之上实现带缓冲的 stdio；
- 管理错误、进程退出和环境变量；
- 用 `_start`、初始化与最终清理把 `execve` 建立的进程接到 `main`。

本讲的 zero-dependency shell 是很好的基线：先看“没有 libc 仍能做到什么”，才能理解 libc 不是魔法，也不是内核，而是应用生态在稳定系统调用之上累积出的关键抽象层。

## 13. PPT 内容覆盖表

| 原讲义标题/内容（按出现顺序） | 本章对应位置 | 覆盖要点 |
| --- | --- | --- |
| 从键盘到终端 | §2 | 从机械键盘到字符协议的总线索 |
| “键盘”的老祖宗 / 历史比想象长 | §2.1 | Hydraulis、管风琴、击奏弦鸣机构 |
| 打字机（Typewriter） | §2.2 | 字模、色带、擒纵机构、QWERTY 的机械约束 |
| 打字机时代的遗产 | §2.3 | Shift/Caps Lock、CR/LF、Space/Backspace/Tab |
| 进入电气化时代 / 电传打字机 | §2.4 | Telex、Baudot 5-bit、Model 28、远端打印 |
| Video Teletypwriter | §2.5 | VT100、`putchar`、ANSI escape、80×24 |
| Aside：感谢 Unicode | §2.6 | Unicode 图形、Powerline、字体与列宽边界 |
| 终端：作为输入设备 | §3.1–§3.2 | 输入字节、Shift、ASCII/UTF-8、ESC、echo 配置 |
| 理解终端 Demo | §3.4 | 控制序列、raw/canonical、终端中的终端及观察目标 |
| 伪终端和终端模拟器 | §3.5–§3.6 | master/slave、`/dev/ptmx`、`/dev/pts/N`、创建与实验 |
| `ttyrec/ttyplay` | §3.7 | 记录 PTY 输出与时间戳、回放边界 |
| 不满足于字符终端 / Sixel | §3.8 | VT200 Sixel、现代图形终端协议 |
| 去年的 flag：内嵌 WebView / A2UI | §3.8 | 丰富 UI 协议及兼容、安全成本 |
| 终端与操作系统 | §4–§6 | 登录、行规程、TUI、信号和 job control 总体机制 |
| 终端：人机交互的第一个设备 | §4.1 | kernel/init/getty/login、sshd/openpty、fd 0/1/2、session 继承 |
| 终端：进入人机交互的世界 | §3.2、§4.2 | `read` 延迟、内核行编辑、Textual/TUI |
| 等一等！TUI 是“多进程”的 | §4.3 | pipeline/辅助进程与“当前作业”问题 |
| Ctrl-C、Ctrl-D 与 `stty -a` | §3.2、§5.1 | ETX/EOT、特殊字符绑定、字符到信号 |
| 多进程的 TUI…… | §5.2–§5.3 | `sigaction`、`kill`、handler、发送对象问题 |
| 信号处理 Demo | §5.2、§5.4 | handler 改写默认动作、async 边界、整组实验 |
| UNIX 会话 (Session) 和进程组 (Process Group) | §6.1 | SID、PGID、controlling tty、foreground PGID |
| 会话和进程组：机制 | §6.1 | 继承、前台组广播、SIGHUP 的精确边界 |
| 会话和进程组：API | §6.2 | `setsid/getsid`、`setpgid/getpgid`、`tcsetpgrp/tcgetpgrp` |
| uid/effective uid/saved uid / Setuid Demystified | §6.2 | 历史状态累积与接口复杂性 |
| 实现类似窗口管理器的 Job Control | §6.3–§6.4 | `Ctrl-Z`/`SIGTSTP`、`SIGCONT`、`fg/bg`、状态实验 |
| 是的，历史的糟粕 | §6.5 | POSIX 兼容、tmux/WM、Android UID、Snap 沙箱 |
| UNIX Shell：一门编程语言 | §7 | Shell 作为 OS 对象的组合语言 |
| UNIX 哲学背后的编程语言 | §7.1–§7.3 | KISS、文本流、字符串模型、展开与组合 |
| 命令翻译成系统调用 | §7.2 | `$()`、`<()`、重定向、顺序、条件、管道与 syscall 映射 |
| 例子：实现重定向 | §7.4 | `open/O_CLOEXEC`、`fork`、`dup2`、`execvp`、`waitpid` |
| 读一下手册吧 | §7.8 | `man sh/dash`、手册分节、AI 辅助阅读 |
| UNIX Shell：有优点就有缺点 | §7.3、§7.6、§8.1 | 1970s 约束、文本责任、Bash/Zsh 差异 |
| 操作“优先级”：`ls > a.txt \| cat` | §7.6 | pipeline 与命令重定向、Zsh MULTIOS、shebang 兼容 |
| 另一个有趣的例子 | §7.7 | `sudo echo hello > /etc/a.txt`：父 Shell 先重定向、`tee`/特权 Shell 的机制 |
| A Zero-dependency UNIX Shell | §8.2 | xv6 思路、freestanding、AST、系统调用、零依赖边界 |
| Shebang Demo | §8.3 | `#!` 执行分派、argv、权限、解释器缺失与可移植性 |
| Takeaways | §10、§12 | OS API 与应用互相成就；精简 UNIX 接口到 libc 生态 |
