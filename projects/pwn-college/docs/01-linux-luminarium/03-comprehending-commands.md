# 03 · 理解命令

> 对应官方模块：[Comprehending Commands](https://pwn.college/linux-luminarium/commands/)

## 学习目标

- 理解命令名、选项、位置参数和退出状态。
- 区分 shell 解析错误与程序报告的用法错误。
- 使用 `command -V` 和 `$?` 观察命令行为。

## 从文本到参数数组

外部程序通常接收一个参数数组 `argv`。例如 `wc -w note.txt` 可抽象为：

```text
argv[0] = "wc"
argv[1] = "-w"
argv[2] = "note.txt"
```

空格一般分隔单词，引号让含空格的文本保持为一个参数。选项常以 `-` 或 `--` 开头，但这是程序约定，不是内核强制规则。`--` 常被程序解释为“后面即使以短横线开头也是位置参数”。

## 安全示例：参数与退出状态

```bash
printf '%s\n' 'red apple' 'pear' | wc -l
status=$?
printf 'exit=%d\n' "$status"
```

预期输出：

```text
2
exit=0
```

引号使 `red apple` 成为 `printf` 的一个参数；格式串被复用，为两个值各输出一行。`wc -l` 读取两行。约定上，退出状态 `0` 表示成功，非零表示某种失败；具体非零值含义由程序定义。

观察命令解析来源：

```bash
command -V wc
command -V cd
```

前者通常显示可执行文件路径，后者显示 shell builtin。相比盲猜，先观察命令来源能解释别名、函数和内建带来的差异。

## 文件与目录命令不是一组咒语

可以按对象生命周期理解常见命令：

| 意图 | 常用命令 | 关键问题 |
|---|---|---|
| 观察目录 | <code>ls</code> | 是否包含隐藏名字、需要哪种排序 |
| 观察内容 | <code>cat</code>、<code>grep</code>、<code>diff</code> | 是文本还是二进制、结果从哪条流输出 |
| 创建 | <code>touch</code>、<code>mkdir</code> | 模式、父目录和已存在对象 |
| 复制/移动 | <code>cp</code>、<code>mv</code> | 是否覆盖、是否跨文件系统、是否保留元数据 |
| 删除 | <code>rm</code>、<code>rmdir</code> | 精确范围、父目录权限、能否恢复 |
| 搜索 | <code>find</code> | 起点、匹配条件和动作 |
| 建立引用 | <code>ln -s</code> | 链接保存什么路径、最终解析到哪里 |

下面只操作新建的临时目录，展示完整生命周期：

~~~bash
workspace=$(mktemp -d)
mkdir "$workspace/inbox" "$workspace/archive"
printf 'alpha\nbeta\n' > "$workspace/inbox/notes.txt"
touch "$workspace/inbox/.reviewed"

cp -- "$workspace/inbox/notes.txt" "$workspace/archive/notes.copy"
mv -- "$workspace/archive/notes.copy" "$workspace/archive/notes.final"
ln -s ../inbox/notes.txt "$workspace/archive/current"

find "$workspace" -maxdepth 2 -printf '%y %P -> %l\n' | LC_ALL=C sort
diff -u "$workspace/inbox/notes.txt" "$workspace/archive/notes.final"
~~~

预期 <code>find</code> 输出中：

- <code>d</code> 表示目录；
- <code>f</code> 表示普通文件；
- <code>l</code> 表示符号链接；
- 隐藏文件 <code>.reviewed</code> 也会出现；
- <code>current</code> 的链接文本为 <code>../inbox/notes.txt</code>。

两个文本完全相同，因此 <code>diff</code> 不输出内容并返回 0。若不同，统一 diff 会用减号和加号表示变化；返回 1 表示“发现差异”，不是工具故障，返回大于 1 才常表示用法或 I/O 错误。这里先保留临时目录，供本章后面的 <code>find</code> 与链接实验继续使用。

### ls 与隐藏名字

名字以点开头只是显示约定，不是加密或访问控制。普通 <code>ls</code> 默认省略它们，<code>ls -a</code> 显示包括 <code>.</code> 和 <code>..</code> 的全部名字，<code>ls -A</code> 省略这两个特殊目录项。

显示格式也不是稳定的机器接口：颜色、列宽、区域设置和不可见字符会改变输出。脚本需要枚举文件时，优先使用 <code>find -print0</code>、语言目录 API 或明确格式，而不是解析人类可读的 <code>ls</code>。

### cat、grep 与 diff

<code>cat</code> 连接字节流，不理解“行”的业务含义。把任意二进制输出到终端可能包含控制序列；先用 <code>file</code>、<code>od</code> 或 <code>xxd</code> 判断类型。

<code>grep</code> 的退出状态有三类：

~~~text
0：至少匹配一行
1：正常完成，但没有匹配
2 或其他：发生错误
~~~

<code>grep -F</code> 把模式当固定字符串，<code>grep -E</code> 使用扩展正则。若用户只是查找字面文本，使用 <code>-F -- "$pattern"</code> 可避免把正则元字符误当语法；<code>--</code> 防止前导短横线变成选项。

### cp 与 mv 的覆盖语义

复制创建一个新的目录项和通常独立的数据；移动在同一文件系统内常可原子重命名，跨文件系统则可能退化成复制再删除。以下问题必须显式决定：

- 目标已存在时覆盖、拒绝还是备份；
- 是否跟随符号链接；
- 是否递归；
- 权限、时间、ACL、扩展属性是否保留；
- 部分失败后源和目标处于什么状态。

交互式 <code>-i</code> 适合人工提醒，不适合无人值守脚本的安全保证。自动化应使用不会意外覆盖的 API 或先写临时文件、同步后原子 rename。

### find 从哪里开始

<code>find</code> 的第一个路径是搜索起点，后面是表达式。条件默认以 AND 组合；<code>-o</code> 的优先级和动作可能令人意外，复杂表达式要加括号并先只打印。

安全的两阶段思路：

~~~bash
find "$workspace" -type f -name '*.tmp' -print
# 人工或程序验证清单后，才在精确受控目录执行动作
~~~

不要把网上的 <code>find / ... -delete</code> 直接用于真实系统。先限定根、文件系统、深度、类型和所有者，并用测试 fixture 验证。

### 符号链接保存的是路径文本

~~~bash
readlink "$workspace/archive/current"
readlink -f "$workspace/archive/current"
rm -r -- "$workspace"
~~~

第一条显示链接内保存的相对文本；第二条尝试解析最终绝对对象。最后一条才清理本章由 <code>mktemp</code> 创建的专用目录。链接可以悬空，目标也可在检查后被替换。安全程序不应只做字符串前缀检查，而应从可信目录 fd 通过安全打开 API 解析。

## 常见误区

- **认为引号会被传给程序。** 多数情况下，引号由 shell 消耗，只影响参数边界。
- **把所有非零状态都当成同一种错误。** 应查程序文档并查看标准错误。
- **在下一条命令之后才读取 `$?`。** `$?` 总是最近一个前台管道的状态，会被覆盖。
- **把以 `-` 开头的文件名当普通参数。** 支持时使用 `--`，如 `cat -- -notes`。

## 纸面练习

比较 `printf '%s\n' red apple` 和 `printf '%s\n' 'red apple'` 的输出行数，并解释原因。

### 答案

第一条输出两行，因为 `red`、`apple` 是两个值参数；第二条输出一行，因为引号保留空格并形成一个参数 `red apple`。引号本身不会出现在输出中。

## 小结

命令不是一整段神秘文本，而是 shell 解析后得到的命令来源、参数数组、标准流和退出状态。把这四项观察清楚，复杂命令也能逐层拆解。

---

[← 上一篇：理解路径](./02-pondering-paths.md) · [本节索引](./README.md) · [下一篇：阅读文档 →](./04-digesting-documentation.md)
