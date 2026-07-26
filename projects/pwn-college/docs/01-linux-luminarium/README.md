# 01 · Linux Luminarium

Linux 命令行不是一组需要死记的咒语，而是一套组合小工具、观察系统状态并精确传递数据的接口。本部分沿用 [Linux Luminarium](https://pwn.college/linux-luminarium/) 的 module 顺序，以原创示例解释 shell、文件、进程、用户和权限的共同模型。

## 学完后能够

- 区分 shell 解析、路径解析和程序自身的参数处理。
- 用管道、重定向、变量与数据工具构造可解释的数据流。
- 观察并控制普通用户自己的进程和作业。
- 正确理解用户、组、权限、`PATH` 与命令查找。
- 在删除、通配符和命令串联时识别危险边界。

## 章节索引

| 序号 | 教程 | 核心问题 |
| --- | --- | --- |
| 01 | [你好，命令行](./01-hello-hackers.md) | 终端、shell 和程序分别做什么 |
| 02 | [理解路径](./02-pondering-paths.md) | Linux 如何定位文件 |
| 03 | [理解命令](./03-comprehending-commands.md) | 命令名、参数与退出状态 |
| 04 | [阅读文档](./04-digesting-documentation.md) | 如何从手册推导正确用法 |
| 05 | [文件通配](./05-file-globbing.md) | 通配符由谁展开、何时展开 |
| 06 | [管道与重定向](./06-practicing-piping.md) | 标准流如何连接程序 |
| 07 | [Shell 变量](./07-shell-variables.md) | 变量、环境与引用规则 |
| 08 | [数据处理](./08-data-manipulation.md) | 行、字段、字节三种视角 |
| 09 | [进程与作业](./09-processes-and-jobs.md) | 前台、后台、暂停与信号 |
| 10 | [用户与身份](./10-untangling-users.md) | UID、组与有效身份 |
| 11 | [文件权限](./11-perceiving-permissions.md) | 读写执行位如何判定访问 |
| 12 | [命令串联](./12-chaining-commands.md) | 顺序、条件和分组 |
| 13 | [终端复用](./13-terminal-multiplexing.md) | 会话为何能脱离终端存活 |
| 14 | [深入 PATH](./14-pondering-path-env.md) | 命令搜索顺序及其风险 |
| 15 | [Shell 边界现象](./15-silly-shenanigans.md) | 特殊文件名和解析边界 |
| 16 | [谨慎删除](./16-daring-destruction.md) | 删除语义与防御性流程 |
| 17 | [后续学习](./17-further-learning.md) | 如何继续建立 Linux 系统观 |

## 阅读约定

示例默认在 Bash 普通用户环境运行。动态用户名、时间、PID 和临时路径只给出输出形态。每篇均包含无需实际操作的纸面练习及答案；若愿意运行，请只使用自己拥有的本地环境。

---

[← 开始之前](../00-start-here/README.md) · [第一篇：你好，命令行 →](./01-hello-hackers.md)
