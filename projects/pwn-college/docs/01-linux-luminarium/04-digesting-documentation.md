# 04 · 阅读文档

> 对应官方模块：[Digesting Documentation](https://pwn.college/linux-luminarium/man/)

## 学习目标

- 识别 `man`、`--help`、shell `help` 等文档入口。
- 看懂 synopsis 中的可选项、互斥项和重复参数。
- 从需求反推选项，而不是复制不明命令。

## 先确认“你在查哪个命令”

同一个名字可能是别名、函数、shell 内建或外部程序。先执行 `type name`，再选择文档入口：外部程序常支持 `man name` 或 `name --help`；Bash 内建使用 `help name`；系统调用和库函数可用手册章节区分，如 `man 2 open` 与 `man 3 printf`。

手册 synopsis 常用这些符号：

- `[OPTION]`：可选。
- `FILE...`：可重复零次或多次，具体下限看文字说明。
- `A | B`：二选一。
- 粗体或普通文本：通常是必须原样输入的字面量。

这些符号描述语法，通常不需要把方括号本身输入命令。

## 安全示例：从帮助中验证假设

```bash
type printf
help printf | sed -n '1,4p'
```

在 Bash 中，预期输出形态为：

```text
printf is a shell builtin
printf: printf [-v var] format [arguments]
    Formats and prints ARGUMENTS under control of the FORMAT.
...
```

由 synopsis 可推导：`format` 必需，`arguments` 可有多个，`-v var` 可选。于是下面命令将结果写进变量而非标准输出：

```bash
printf -v message 'count=%d' 3
printf '%s\n' "$message"
```

预期输出为 `count=3`。

## 搜索策略

长手册不必从头背诵。在 `man` 中用 `/pattern` 向后搜索、`n` 跳到下一处、`q` 退出。先用关键词定位需求，如 “recursive”“delimiter”“exit status”，然后阅读命中位置上下文和边界条件。

## 常见误区

- **直接搜索网络并执行第一条命令。** 版本、平台和上下文可能不同，应回到本机文档验证。
- **把 synopsis 的 `[]` 原样输入。** 它通常表示可选语法。
- **忽略手册章节。** 同名命令、系统调用和库函数可能有不同页面。
- **只看选项，不看退出状态和副作用。** 自动化脚本尤其依赖这些约定。

## 纸面练习

若 synopsis 为 `tool [-q] (-f FILE | -s TEXT) [ITEM...]`，哪些内容必选？`-f` 和 `-s` 能否同时使用？

### 答案

必须在 `-f FILE` 与 `-s TEXT` 中选择一组；圆括号表示组合，竖线表示二选一。`-q` 可选，`ITEM` 可出现多个。按该 synopsis，`-f` 与 `-s` 不能同时使用。

## 小结

有效的文档阅读从确认命令来源开始，再解析 synopsis、搜索需求关键词，并核对退出状态与副作用。文档不是最后求助的地方，而是建立可靠命令模型的第一手依据。

---

[← 上一篇：理解命令](./03-comprehending-commands.md) · [本节索引](./README.md) · [下一篇：文件通配 →](./05-file-globbing.md)
