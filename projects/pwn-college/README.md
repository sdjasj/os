# pwn.college 中文原理教程

这是一套可离线阅读的非官方中文教程，按 pwn.college 当前官方主学习路径编排。全书覆盖 **8 个 dojo、59 个 module**：从终端与 Linux 开始，依次进入汇编、内存、网络、Web、密码学、逆向、二进制、程序安全、系统安全和高级软件利用。

> 课程结构核对日期：**2026-07-26（Asia/Shanghai）**。正文是独立原创讲解和自建玩具示例，不包含 pwn.college 的 flag、关卡 payload、solver、精确答案或逐关 walkthrough。详细归属和许可边界见 [NOTICE](NOTICE.md)。

## 这套教程适合怎样读

你不必完成站内实验才能理解正文。每篇都尽量给出：

- 概念为什么产生，而不只给定义；
- 数据流、内存布局或控制流的逐步推导；
- 可在普通 Linux、本机临时目录或 127.0.0.1 上运行的原创示例；
- 编译/运行命令与预期输出；
- 攻击面、约束和防御机制；
- 常见误区；
- 不开电脑也能完成的纸面练习及答案；
- 对应官方 module 链接和前后导航。

时间很少时，可以用“三遍法”：

1. **第一遍（约 10 分钟/章）**：只读学习目标、图示、常见误区和小结；
2. **第二遍**：手工推演代码和纸面练习，再对照答案；
3. **第三遍**：只挑不理解的示例在隔离环境运行，并回到官方 lecture 补充。

代码仍值得读：即使不执行，也请沿着“输入是什么—状态怎样改变—输出为什么如此”逐行推演。安全技术很难靠结论清单真正掌握。

## 完整学习路线

| 阶段 | 官方模块数 | 你会建立的能力 | 教程入口 |
|---|---:|---|---|
| Start Here | 2 | 使用平台、安排学习、建立伦理与实验边界 | [开始这里](docs/00-start-here/README.md) |
| Linux Luminarium | 17 | Shell、路径、命令、管道、权限、进程与脚本 | [Linux 基础](docs/01-linux-luminarium/README.md) |
| Computing 101 | 13 | x86-64、内存、栈、I/O、控制流、调试与 socket | [计算机底层基础](docs/02-computing-101/README.md) |
| Playing With Programs | 4 | 编码、HTTP、程序能力边界与 SQL | [程序交互](docs/03-playing-with-programs/README.md) |
| Intro to Cybersecurity | 7 | Web、网络、密码、访问控制、逆向与二进制综合 | [网络安全导论](docs/04-intro-to-cybersecurity/README.md) |
| Program Security | 5 | 内存错误、逆向、ROP、堆生命周期与利用方法论 | [程序安全](docs/05-program-security/README.md) |
| System Security | 6 | 沙箱、竞态、内核、微体系结构与跨层系统分析 | [系统安全](docs/06-system-security/README.md) |
| Software Exploitation | 5 | 格式串、FILE、利用原语、高级堆与内核堆 | [软件利用](docs/07-software-exploitation/README.md) |

推荐严格按表中顺序阅读。官方课程也按先修关系组织；后面的章节默认你已掌握前面内容。

## 附录与扩展

- [附录总索引](docs/99-appendices/README.md)
  - [Linux 命令速查](docs/99-appendices/01-linux-command-reference.md)
  - [数字、进制与编码速查](docs/99-appendices/02-number-encoding-reference.md)
  - [x86-64 寄存器与系统调用](docs/99-appendices/03-x86-64-registers-and-syscalls.md)
  - [GDB 调试参考](docs/99-appendices/04-gdb-reference.md)
  - [pwntools 本地交互参考](docs/99-appendices/05-pwntools-reference.md)
  - [本地隔离实验环境](docs/99-appendices/06-local-lab-setup.md)
  - [术语表](docs/99-appendices/07-glossary.md)
- [Community Material 完整索引](docs/90-community/00-community-materials.md)：记录快照时官网的 49 个社区 dojo，并给出主线之后的选学顺序。

## 建议环境

大部分命令和示例面向 x86-64 Linux。只阅读不需要安装任何东西；实际运行时建议准备：

- 普通非 root 用户；
- GCC/Clang、binutils、Python 3、GDB、strace；
- 专用临时目录；
- 只监听 127.0.0.1 的网络示例；
- 对内核、破坏性命令和不可信二进制使用可回滚虚拟机。

完整建议和清理方法见[本地隔离实验环境](docs/99-appendices/06-local-lab-setup.md)。不要在工作机、生产系统、学校服务器或未获明确授权的目标上尝试漏洞代码。

## 范围说明

本版完整覆盖官方主路径的 module 级知识结构。它有意不做以下事情：

- 不逐题改写挑战；
- 不提供可提交的课程答案；
- 不复制官方题面、视频、幻灯片或闭源材料；
- 不把历年课程重组内容再重复写一套；
- 不把数百个 CTF/社区挑战混入基础主线。

社区 dojo 数量大、维护状态和许可不同，因此单独建立[分类索引](docs/90-community/00-community-materials.md)，适合完成主线后按 ARM、Windows/XNU、密码利用、Fuzzing 等方向扩展。

## 官方入口

- [pwn.college 官网与规则](https://pwn.college/)
- [当前 Dojo 总目录](https://pwn.college/dojos)
- [pwn.college GitHub 组织](https://github.com/pwncollege)
- [课程挑战 monorepo](https://github.com/pwncollege/challenges)
- [官方 YouTube 频道](https://www.youtube.com/pwncollege)

在线课程会继续变化。本书以 module 名称和知识依赖为稳定骨架，不把挑战数量写成永久事实；发现目录或链接变化时，请以官网为准。

## 从哪里开始

第一次接触 Linux，请从[平台、路线与学习边界](docs/00-start-here/README.md)开始。已经熟悉终端但不了解汇编，可以从[Computing 101](docs/02-computing-101/README.md)开始，但遇到权限、管道或脚本问题时回补 Linux Luminarium。已经做过基础 pwn，也建议先浏览前四阶段的纸面练习，再进入 Program Security。
