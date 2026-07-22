[Yanyan's wiki](/)

 for

  - [操作系统 (2026 春)](/OS/2026/)

# 2026 《操作系统》实验须知

<span class="float-left text-4xl mr-3 mt-2">🖥️</span><span class="font-serif text-lg border-b border-slate-600">**编程**</span>

准备好一个可用的 UNIX 编程环境。这个环境将伴随你完成整个《操作系统》课程。可能的方案有：

  - 物理机直接安装的 Linux 或 macOS 系统 (你可以在 arm64 的 macOS 上运行绝大部分示例代码，并完成大部分实验)
  - Windows Subsystem for Linux (应用商店安装 Ubuntu)，通过 ssh 登陆
  - VirtualBox 安装的 Linux 虚拟机，通过 ssh 登陆
  - 网络上购买的 Linux 虚拟主机，通过 ssh 登陆

在系统中安装必要的软件，包括编译器、git、编辑器、ssh server 等，确保你可以在这个环境中编辑、编译和调试 C/C++ 代码。

## 1\. 获取实验框架代码

本课程所有实验都托管在同一个仓库中。在命令行中执行 (关于本课程的实验环境，我们不做硬性要求)，与 Online Judge 评测环境一致。在命令行中运行

    $ git clone https://git.nju.edu.cn/jyy/os2026.git

获得框架代码，将会克隆 `os-workbench` 到当前目录。首次 clone 后你会得到一个近乎为空的 Git repo：

    .
    ├── .git/
    ├── .shadow/
    ├── testkit/
    ├── oslab.mk
    └── .gitignore

每个实验的指南中都有获取该实验框架代码的说明。请妥善保管这个目录：它保留了你完成作业的证据：以及，默认的 make 命令会自动将你的代码保存到 .shadow 中 (历史记录追踪和评测使用)。如果在多个地点完成作业，请将整个目录移动 (或通过版本控制) 保持 Git 记录的完整。如遇问题请联系老师或助教。

## 2\. 提交实验作业

我们已经为选修课程的同学生成了唯一的秘钥，并以邮件形式发送到你的学号@smail.nju.edu.cn 邮箱，有遗漏的请联系 jyy。配置好 `Makefile` 中的 `TOKEN` 环境变量后，在相应的实验目录中 (而不是项目根目录) 中执行以下命令完成提交：

    $ make submit

如果提交成功，命令行中会看到：

    $ make submit
    [SUCC ✓] Received OS2026-M1 姓名 学号
    Sun Mar 8 2026 21:13:34 GMT+0800 (China Standard Time)

提交成功后，将你收到的秘钥粘贴到网页的左上角 (Logo 旁边有一个输入框)，就可以在具体的实验页面上查看提交结果。注意我们只收取 `os-workbench/.git` 中的程序 (无需提交实验报告)。因此，如果你只是修改了代码而没有执行过 make 或手工的 git commit，这些改动将不会被反映到 Online Judge。

## 3\. 使用 Git 管理源代码

在得到 Git repo 以后，默认处于 `main` 分支。你可以本学期全部在 `main` 分支上工作，但也可以自由创建自己的分支。

<span class="float-left text-4xl mr-3 mt-2">️⚠️</span><span class="font-serif text-lg border-b border-slate-600">**特别注意**</span>

`make` 会自动将你的实验代码保存到 `.shadow` 中 ([为什么？](https://zhuanlan.zhihu.com/p/40568346))。如果你对 Makefile 有修改，请保留 Git 追踪部分，Git 记录将会作为我们筛选、检查提交的参考。如果你因为意外丢失了 Git 记录，只要你遵守学术诚信，就不必担心，Git 记录不参与评分。评分以 `.shadow` 中的代码为准。

## 4\. 学术诚信

我们很遗憾地意识到，《操作系统》系列实验的难度已远远低于 AI 的能力——Coding Agent 可以轻易完成所有实验，并且你完全可以让你的 AI Agent 生成更多的测试用例，因此 Online Judge 也显得毫无意义。

但无论如何，同学们在计算机科学专业学习计算机系统的底层原理，类似为了用好计算器，你依然需要从理解基本的算术 (例如，1 + 1) 开始。因此，虽然 AIGC 无法严格禁止，我们希望同学们在实验的过程中，在 AI 的带领下，理解操作系统为应用程序提供的 API，包括它们如何使用、有哪些注意事项、有什么拓展用途等。

<span class="float-left text-4xl mr-3 mt-2">️⚠️</span><span class="font-serif text-lg border-b border-slate-600">**AIGC Policy**</span>

《操作系统》课程实验，与操作系统无关的部分允许 AI 生成。但涉及到与操作系统交互的接口，你必须询问 AI 有关系统调用的使用方法，并且独立完成调用、调试观察结果，确保你理解程序与操作系统 API 的交互。这些接口将是闭卷期末考试的主要内容。

## 5\. 实验与评分

### 5.1 评分规则

评分规则：在没有抄袭和作弊 (如硬编码答案、故意骗过 Online Judge 而不实现实验要求等) 的前提下：

  - Rejected, 编译错误或没有通过任何测试用例: 10% (诚信分)
  - Accepted, 部分 easy 测试通过 (此时不运行 hard 用例): 60%
  - Accepted, 全部 easy 测试通过、部分 hard 测试通过: 80%
  - Accepted, 通过全部 easy/hard 测试: 100%

<span class="float-left text-4xl mr-3 mt-2">⚠️</span><span class="font-serif text-lg border-b border-slate-600">**按时提交奖励**</span>

每个实验都设有 Soft deadline。Soft deadline 之前提交：成绩 + 5% (如按时提交空项目将得到 15% 诚信分)

  - 实验部分成绩不超过实验总分的 100%。
  - 如果发现问题希望修复 (一旦进行过尝试)，之后的提交将不享受加分；但之前已经获得带按时提交加分的分数不会被消除 (以分数高的计算)。

所有实验在 Hard deadline (通常是期末考试后的一小段时间) 截止。

### 5.2. Online Judge 环境

Mini/OS Lab 都在 Online Judge 评测，评测机配置：Intel i5-12400 (4.4 GHz, 32GB RAM)。程序在容器中编译、运行，并由机器自动判定结果是否正确。你的程序将在以下环境运行：

Ubuntu 22.04 容器 ([Docker](https://www.docker.com/), x86-64)。容器中仅有最小的必要系统工具。使用以下 Dockerfile 配置与在线评测一致的环境；我们开放了容器的 `SYS_PTRACE` 权限；

    FROM ubuntu:22.04
    ENV DEBIAN_FRONTEND=noninteractive
    RUN apt-get update
    RUN apt-get install -y build-essential strace gdb sudo python3
    RUN apt-get upgrade -y

Mini Labs 直接在容器中执行 (non-root user)；容器总内存限制 4GB，超过内存限会导致进程被杀死。超过一定时限未执行完的容器也将被杀死 (每个测试点时限不同，但实验的设计一般而言不需要特殊的性能优化)。容器中的编译器版本：

  - gcc 11.4.0
  - bin utils 2.38
  - GNU make 4.3

如果你遇到了编译错误等，可以在上述环境复现。你可以在 Windows 应用商店中安装 Ubuntu 以得到这样的环境。

Online Judge 的最大特点就是严格。有任何差错 (因为环境/配置等引发的编译错、细小的输出错误) 都将被 Online Judge 捕捉到。这有助于帮助大家摆脱 “糊弄” 的习惯，编写正确的程序。

![](../../img/compile-error.webp)

[Creative Commons License: BY-NC 4.0](http://creativecommons.org/licenses/by-nc/4.0/)
[苏 ICP 备 2020049101 号](https://beian.miit.gov.cn/)
