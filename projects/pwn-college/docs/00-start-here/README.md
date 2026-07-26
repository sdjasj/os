# 00 · 开始之前

这一部分不是挑战攻略，而是整套教程的使用说明。pwn.college 把知识组织成 dojo、module 和 challenge；本教程保留它的知识顺序，但把重心改为“原理—例子—推演—复习”。即使暂时不做实验，也应能从命令、预期输出和纸面练习理解核心机制。

## 本节目标

- 看懂教程与 pwn.college 课程结构之间的对应关系。
- 知道代码示例的适用边界，不把教学命令用于未授权系统。
- 准备一个最小权限、本地运行、便于清理的学习环境。
- 学会用“输入、状态、转换、输出”四个问题阅读后续示例。

## 阅读顺序

| 序号 | 教程 | 你会学到什么 |
| --- | --- | --- |
| 01 | [平台结构与学习方法](./01-platform-and-learning-path.md) | 如何把挑战式课程转换成可复习的知识地图 |
| 02 | [伦理边界与安全环境](./02-ethics-and-safe-environment.md) | 授权原则、最小权限和本地临时目录 |

完成后进入 [Linux Luminarium](../01-linux-luminarium/README.md)。命令行是后续汇编、逆向、Web 与二进制安全的共同工具层。

## 示例约定

教程默认使用 Bash，提示符 `$` 表示普通用户命令，`#` 只用于展示注释，不表示要求使用 root。代码块后的“预期输出”用于解释现象；时间、用户名、进程号等动态值可能不同。

所有示例都以本地文本、临时目录或回环地址为对象。出现删除、权限、进程或网络操作时，会先说明影响范围。教程不包含 flag、挑战专用输入、关卡程序逆向结果或逐关 walkthrough。

## 官方入口

- [Start Here dojo](https://pwn.college/welcome/)
- [Using the Dojo 模块](https://pwn.college/welcome/welcome/)
- [Joining the Discord 模块](https://pwn.college/welcome/discord/)

---

[返回本节顶部](#00--开始之前) · [下一篇：平台结构与学习方法 →](./01-platform-and-learning-path.md)
