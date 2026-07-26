# 08 · 数据处理

> 对应官方模块：[Data Manipulation](https://pwn.college/linux-luminarium/data/)

## 学习目标

- 从行、字段和字节三个层次理解数据。
- 组合 `sort`、`uniq`、`cut`、`awk`、`tr` 等工具。
- 识别分隔符、区域设置和二进制数据造成的歧义。

## 先定义数据模型

传统 Unix 文本工具常把输入视为由换行分隔的记录。每个工具再选择自己的字段规则：`cut -d,` 使用单字符分隔符，`awk` 默认把连续空白视为字段间隔，`sort` 默认受区域设置影响。若不先说明格式，同一段字节可能被不同工具解释成不同结构。

处理任意二进制数据时，应使用 `od`、`xxd` 或明确支持 NUL 的接口，而不是假定字节都能显示成文本。

## 安全示例：聚合虚构日志

```bash
printf '%s\n' \
  'alice,read,4' \
  'bob,write,7' \
  'alice,write,3' \
| awk -F, '{ total[$1] += $3 } END { for (u in total) print u, total[u] }' \
| LC_ALL=C sort
```

预期输出：

```text
alice 7
bob 7
```

`-F,` 指定逗号为字段分隔符；关联数组 `total` 以用户名为键累加第三列；`END` 在输入结束后输出结果；`LC_ALL=C sort` 使用稳定的字节排序，减少不同语言环境带来的次序差异。

观察不可见字节：

```bash
printf 'A\tB\n' | od -An -t x1
```

预期输出包含 `41 09 42 0a`，分别是 `A`、制表符、`B`、换行的十六进制字节值。

## tr：按字符集合转换或删除

<code>tr</code> 逐字节/字符集合变换标准输入，不接受文件名作为普通输入参数：

~~~bash
printf '%s\n' 'Alpha  42' \
  | tr '[:upper:]' '[:lower:]' \
  | tr -s ' '
~~~

预期：

~~~text
alpha 42
~~~

第一步把大写集合映射到小写，第二步用 <code>-s</code> 压缩连续空格。行为会受 locale 影响；需要稳定 ASCII 语义时显式使用 <code>LC_ALL=C</code>。

<code>tr -d</code> 删除集合中的字符。删除换行会把记录拼接，可能让原本两条日志变成一条，因此不能只把它当视觉格式化。

## head、tail 与“只看一部分”

<code>head -n N</code> 取前 N 行，<code>tail -n N</code> 取后 N 行。按字节可使用 <code>-c</code>，但字节边界可能切开 UTF-8 字符。

~~~bash
printf '%s\n' one two three four | head -n 3 | tail -n 1
~~~

预期输出 <code>three</code>：先得到前三行，再取其中最后一行。对无限流使用 head 时，下游在满足数量后会关闭管道，生产者可能收到 SIGPIPE，这是正常控制流。

## cut：字段与字符不是完整解析器

~~~bash
printf '%s\n' 'alice:1001:developer' 'bob:1002:operator' \
  | cut -d: -f1,3
~~~

预期：

~~~text
alice:developer
bob:operator
~~~

<code>-d:</code> 指定单字符分隔符，<code>-f1,3</code> 选择字段。若字段本身可包含转义后的冒号，cut 不理解转义规则；JSON、CSV、URL 等要用对应解析器。

## sort：排序键、数值和去重

默认排序按 locale 的文本规则。数字字符串若按文本排序，<code>10</code> 可能排在 <code>2</code> 前；<code>sort -n</code> 才按数值解释。指定字段键：

~~~bash
printf '%s\n' 'bob 10' 'alice 2' 'chen 10' \
  | LC_ALL=C sort -k2,2n -k1,1
~~~

预期：

~~~text
alice 2
bob 10
chen 10
~~~

第一键是第二字段的数值，第二键是第一字段文本。<code>sort -u</code> 按所定义的比较键去重；若键不包含整行，可能丢掉同键但其他字段不同的记录。

## 用中间结果验证长管道

长管道出现意外结果时，可在每一段后插入 <code>tee</code> 写入专用临时目录，或逐段运行并记录：

~~~text
输入行数
 -> 过滤后行数
 -> 提取字段数
 -> 转换失败数
 -> 排序/聚合结果
~~~

这比只盯最终数字更容易发现分隔符、空行、编码和错误流问题。

## 安全视角

日志和 CSV 不是天然可信的。字段可能包含逗号、换行、控制字符或公式前缀；简单按字符切割会产生错误结论。面向正式 CSV、JSON 或协议数据时，应使用理解该格式转义规则的解析器。

## 常见误区

- **把“列看起来对齐”当成结构化格式。** 多个空格、制表符和宽字符会破坏视觉判断。
- **对未排序数据直接 `uniq`。** `uniq` 只合并相邻重复行。
- **假定 `sort` 在所有机器顺序相同。** 需要可复现结果时显式设定区域环境。
- **用文本命令处理任意二进制数据。** NUL 和非法编码可能截断或改变语义。

## 纸面练习

输入依次为 `b`、`a`、`b` 三行。为什么直接运行 `uniq -c` 会得到三组，而 `sort | uniq -c` 得到两组？

### 答案

`uniq` 只比较相邻行，两个 `b` 被 `a` 隔开，所以各自计数 1。排序后输入成为 `a,b,b`，两个 `b` 相邻，于是得到 `1 a` 与 `2 b`。

## 小结

数据处理前先定义记录、字段、编码和排序规则。小工具的组合能力来自清晰接口；接口假设不清，简短管道也会稳定地产生错误结果。

---

[← 上一篇：Shell 变量](./07-shell-variables.md) · [本节索引](./README.md) · [下一篇：进程与作业 →](./09-processes-and-jobs.md)
