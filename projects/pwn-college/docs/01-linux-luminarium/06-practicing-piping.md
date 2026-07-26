# 06 · 管道与重定向

> 对应官方模块：[Practicing Piping](https://pwn.college/linux-luminarium/piping/)

## 学习目标

- 理解标准输入、标准输出和标准错误三个流。
- 区分管道与文件重定向，解释它们的连接时机。
- 看懂重定向顺序，避免意外覆盖文件或丢失错误信息。

## 文件描述符是进程的连接表

程序启动时通常拥有三个文件描述符：`0` 是标准输入，`1` 是标准输出，`2` 是标准错误。它们可以连接终端、普通文件、管道或其他内核对象。程序只按编号读写，不必知道另一端是什么。

```text
producer 的 fd 1 ──管道──> consumer 的 fd 0
producer 的 fd 2 ─────────> 原终端（除非另行重定向）
```

`A | B` 只把 A 的标准输出接到 B 的标准输入。`>` 覆盖目标文件，`>>` 追加，`<` 从文件提供输入。重定向由 shell 在程序运行前建立。

## 安全示例：组合而不落盘

```bash
printf '%s\n' 'WARN cache' 'INFO ready' 'WARN disk' \
  | grep '^WARN' \
  | wc -l
```

预期输出：

```text
2
```

第一步产生三行；`grep` 只保留以 `WARN` 开头的两行；`wc -l` 统计行数。每个程序只完成一种转换，因此容易替换、测试和推演。

标准错误不会自动进入管道。下面用一个不存在的路径说明分流：

```bash
ls /definitely-not-a-real-tutorial-path 2>/dev/null | wc -l
```

预期输出为 `0`，错误被重定向到 `/dev/null`，而 `wc` 只看到空的标准输出。真实排错时不应随意丢弃错误；可以重定向到专用日志。

## 顺序为什么重要

`cmd >all.log 2>&1` 先让 fd 1 指向文件，再让 fd 2 复制 fd 1，所以两者都进文件。`cmd 2>&1 >out.log` 先让 fd 2 指向当时的终端，再改变 fd 1，因此错误仍在终端。重定向按从左到右处理。

## tee：既观察又继续传递

普通重定向把输出送走后，终端不再显示。<code>tee</code> 同时写文件和标准输出：

~~~bash
tee_dir=$(mktemp -d)
printf '%s\n' alpha beta beta \
  | tee "$tee_dir/raw.txt" \
  | sort -u \
  | tee "$tee_dir/unique.txt"
printf 'raw=%s unique=%s\n' \
  "$(wc -l < "$tee_dir/raw.txt")" \
  "$(wc -l < "$tee_dir/unique.txt")"
rm -r -- "$tee_dir"
~~~

预期：

~~~text
alpha
beta
raw=3 unique=2
~~~

默认 <code>tee file</code> 覆盖文件，<code>tee -a file</code> 才追加。它以当前用户权限打开路径，所以目标路径同样需要经过范围和符号链接审计。

## sed 与排除过滤

<code>grep -v</code> 保留不匹配行；<code>sed</code> 按脚本转换文本。例如对虚构配置做显示用脱敏：

~~~bash
printf '%s\n' 'user=alice' 'token=DEMO-123' \
  | sed 's/^token=.*/token=[redacted]/'
~~~

预期：

~~~text
user=alice
token=[redacted]
~~~

这个正则只适合明确的逐行玩具格式。正式配置可能含转义、多行值或重复键，应使用该格式的解析器；脱敏后也要考虑长度、错误消息和元数据侧信道。

## 进程替换与命令替换不同

命令替换 <code>$(command)</code> 捕获标准输出为一个字符串，并删除末尾换行；进程替换 <code>&lt;(command)</code> 给出一个类似文件名的入口，让另一个程序边读边处理。

比较两份排序结果：

~~~bash
diff -u \
  <(printf '%s\n' beta alpha | sort) \
  <(printf '%s\n' alpha beta)
printf 'diff exit=%d\n' "$?"
~~~

预期 <code>diff</code> 无正文输出，退出状态为 0。进程替换是 Bash 等 shell 的扩展，不是所有 <code>/bin/sh</code> 都支持；它背后可能使用 <code>/dev/fd</code> 或命名管道，消费者必须把参数当可读路径。

## FIFO：文件系统中的管道名字

匿名管道只由创建它的进程树持有；FIFO 通过文件系统路径让独立进程会合。打开 FIFO 的读端或写端可能阻塞，直到另一端出现。

安全示例：

~~~bash
fifo_dir=$(mktemp -d)
mkfifo "$fifo_dir/events"
printf 'one\ntwo\n' > "$fifo_dir/events" &
writer=$!
wc -l < "$fifo_dir/events"
wait "$writer"
rm -r -- "$fifo_dir"
~~~

预期输出为 <code>2</code>。FIFO 自身不永久保存两行数据；它只提供内核缓冲和同步通道。共享目录里的 FIFO 还涉及所有者、权限、阻塞与冒名替换，因此应放在私有目录。

## 管道中的并发、缓冲与 SIGPIPE

管道两端通常并发运行。内核管道缓冲有限：

- 消费者慢时，生产者的 write 会阻塞；
- 消费者提前退出时，生产者可能收到 SIGPIPE 或 write 返回 EPIPE；
- stdio 连接终端时可能按行缓冲，连接管道时可能改为全缓冲；
- 一条管道“暂时没输出”不一定是死锁，也可能在等待缓冲刷新。

若只需前几行，<code>producer | head -n 1</code> 可能让 producer 因下游关闭而得到 SIGPIPE，这是正常的背压结果。脚本启用 <code>set -o pipefail</code> 后，管道状态会考虑失败的前段；仍应按具体命令解释哪些非零状态可接受。

## 输出覆盖的安全策略

<code>&gt;</code> 在命令真正运行前由 shell 打开并截断文件，即使命令随后失败，原内容也可能已丢失。重要输出应：

1. 写入同目录的专用临时文件；
2. 检查生成、权限、大小和内容；
3. 必要时 fsync；
4. 用原子 rename 替换目标；
5. 保留版本化备份或回滚。

## 常见误区

- **认为 `|` 同时传递标准错误。** 普通管道只连接 fd 1。
- **把 `>` 当作追加。** 它会在执行前截断已有文件；追加使用 `>>`。
- **忽略管道各段的退出状态。** Bash 默认 `$?` 主要反映最后一段；严格脚本需理解 `pipefail`。
- **用文本管道传任意文件名。** 文件名可含换行，应使用 NUL 分隔接口。

## 纸面练习

命令 `producer 2>errors.log | consumer >result.txt` 中，三个流分别去哪里？

### 答案

`producer` 的标准输出进入 `consumer` 的标准输入；`producer` 的标准错误写入 `errors.log`；`consumer` 的标准输出写入 `result.txt`。`consumer` 的标准错误没有重定向，仍连接原终端。

## 小结

管道和重定向本质上是在进程启动前改接文件描述符。只要逐个标出 fd 0、1、2 的去向，复杂数据流和错误流也能准确解释。

---

[← 上一篇：文件通配](./05-file-globbing.md) · [本节索引](./README.md) · [下一篇：Shell 变量 →](./07-shell-variables.md)
