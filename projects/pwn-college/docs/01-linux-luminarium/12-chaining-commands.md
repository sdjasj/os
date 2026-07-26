# 12 · 命令串联

> 对应官方模块：[Chaining Commands](https://pwn.college/linux-luminarium/chaining/)

## 学习目标

- 区分无条件顺序、成功后执行和失败后执行。
- 理解短路求值与退出状态传播。
- 识别将不可信文本拼入命令串的注入风险。

## 控制关系由操作符决定

- `A ; B`：A 结束后总是执行 B。
- `A && B`：A 状态为 0 才执行 B。
- `A || B`：A 状态非 0 才执行 B。
- `A &`：A 在后台执行，shell 可立即处理后续命令。
- `( list )`：在子 shell 环境执行。
- `{ list; }`：在当前 shell 分组，结尾分号不可随意省略。

`&&` 与 `||` 是短路控制操作符，不只是英文“并且/或者”。它们判断的是命令退出状态，而非命令打印的文字。

## 安全示例：显式处理成功与失败

```bash
test 4 -gt 2 \
  && printf 'comparison succeeded\n' \
  || printf 'comparison failed\n'

test -e /definitely-not-a-real-tutorial-file \
  && printf 'file exists\n' \
  || printf 'file missing\n'
```

预期输出：

```text
comparison succeeded
file missing
```

第一条 `test` 返回 0，因此执行成功分支并跳过失败分支。第二条返回非零，跳过 `&&` 后第一条命令，执行 `||` 分支。

需要注意 `A && B || C` 并不严格等于某些语言的 if/else：若 A 成功但 B 失败，C 也会执行。复杂逻辑应写成明确的 `if ...; then ...; else ...; fi`。

## 分组与状态隔离

```bash
place=outside
( place=inside; printf 'subshell=%s\n' "$place" )
printf 'parent=%s\n' "$place"
```

预期输出为 `subshell=inside`、`parent=outside`，因为圆括号内赋值发生在子 shell 副本中。

## 从命令列表到脚本文件

脚本把控制流保存下来，需要同时理解三个入口：

1. shebang 选择解释器；
2. 文件执行位决定能否用路径直接执行；
3. 位置参数把调用者数据传入脚本。

一个完整的只读示例：

~~~bash
#!/usr/bin/env bash

if (( $# != 1 )); then
    printf 'usage: %s FILE\n' "$0" >&2
    exit 2
fi

input=$1
case $input in
    *.txt) ;;
    *)
        printf 'expected a .txt file\n' >&2
        exit 2
        ;;
esac

if [[ ! -f $input || ! -r $input ]]; then
    printf 'not a readable regular file: %s\n' "$input" >&2
    exit 1
fi

if lines=$(wc -l < "$input"); then
    printf 'lines=%s file=%s\n' "$lines" "$input"
else
    printf 'count failed\n' >&2
    exit 1
fi
~~~

假设保存为 <code>summarize.sh</code>：

~~~bash
chmod 700 summarize.sh
sample_dir=$(mktemp -d)
printf 'one\ntwo\n' > "$sample_dir/input.txt"
./summarize.sh "$sample_dir/input.txt"
rm -r -- "$sample_dir"
~~~

预期：

~~~text
lines=2 file=/tmp/tmp.xxxx/input.txt
~~~

逐步解释：

- <code>$#</code> 是参数数量，错误用法返回 2；
- <code>$0</code> 是脚本被调用的名字；
- <code>$1</code> 保存第一个参数，赋值时不发生分词；
- <code>case</code> 只做扩展名分类，不把扩展名当安全证明；
- <code>[[ ... ]]</code> 是 Bash 条件语法；
- 重定向 <code>&gt;&amp;2</code> 把诊断送标准错误；
- if 直接检查 wc 的退出状态；
- 所有路径展开都保持参数边界。

<code>#!/usr/bin/env bash</code> 便于在 PATH 中寻找 Bash，但继承 PATH 本身是信任选择；权限敏感脚本应使用系统确认的固定解释器路径和最小环境。

## if、case 与 test

<code>if command; then ...</code> 判断 command 的退出状态。方括号 <code>[ ... ]</code> 实际是 test 风格命令，参数之间必须有空格：

~~~bash
value=7
if [ "$value" -gt 5 ]; then
    printf 'large\n'
else
    printf 'small\n'
fi
~~~

预期输出 <code>large</code>。数字比较用 <code>-gt</code>，字符串比较和文件测试有不同操作符；混用可能得到语法错误或错误判断。

<code>case</code> 适合有限模式集合：

~~~bash
case $action in
    start|stop|status) printf 'known action\n' ;;
    *) printf 'unknown action\n' >&2; exit 2 ;;
esac
~~~

模式使用 shell pattern，不是正则表达式。把外部输入映射到固定动作比拼接成命令字符串安全。

## 脚本参数的边界

<code>"$@"</code> 会让每个位置参数继续保持独立，适合包装程序：

~~~bash
run_printer() {
    printf 'argument count=%d\n' "$#"
    printf '<%s>\n' "$@"
}
run_printer 'red blue' green
~~~

预期 count 为 2，并输出两个参数。未引用的 <code>$@</code> 会再次字段分割/通配；双引号中的 <code>$*</code> 则把全部参数合并成一个字符串。

包装高权限程序时，即使 argv 边界正确，也必须防止选项注入。若数据可用前导短横线，应在工具支持时加入 <code>--</code>，并白名单允许的选项。

## 退出状态传播

脚本若不显式 exit，状态通常来自最后执行的命令。一次成功的 printf 可能覆盖前面失败状态：

~~~bash
if important_step; then
    printf 'important step succeeded\n'
else
    status=$?
    printf 'important step failed: status=%d\n' "$status" >&2
    exit "$status"
fi
~~~

如果改用 <code>if ! important_step</code>，感叹号会反转状态，分支中的 <code>$?</code> 不再是原始失败值。大多数脚本只需区分成功/失败，不应依赖每个命令非标准化的具体数值。

## set -e、set -u 与 pipefail

常见“严格模式”：

~~~bash
set -u
set -o pipefail
~~~

- <code>set -u</code> 在展开未设置变量时报错，但默认值语法和空数组仍需理解；
- <code>pipefail</code> 让管道考虑前段失败；
- <code>set -e</code> 的退出规则受 if、while、<code>!</code>、<code>&amp;&amp;</code>、子 shell 和命令替换上下文影响，不能代替显式错误处理。

关键资源创建、复制和权限变更应直接检查状态，并在失败时给出上下文。

## 清理与 trap

脚本中断时也要清理临时对象。必须先成功创建、验证专用目录，再注册 trap：

~~~bash
work=$(mktemp -d) || exit 1
cleanup() {
    test -n "$work" && test -d "$work" && rm -r -- "$work"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
~~~

cleanup 应幂等、目标精确且不依赖已经损坏的外部状态。信号处理器转为常见的 128+信号编号状态，随后 EXIT trap 统一清理；更复杂程序还需考虑子进程组、重复信号和不可中断步骤。

## 安全视角

不要把不可信输入拼入 `eval`、`bash -c` 或完整命令字符串。分号、重定向、命令替换等会被重新解释为语法。应直接使用参数数组或固定命令加引用参数，让数据保持为数据。

## 常见误区

- **用 `;` 连接有依赖的步骤。** 前一步失败后，后一步仍会运行。
- **认为有输出就是成功。** 应检查退出状态。
- **把 `A && B || C` 无条件当 if/else。** B 失败时也会走 C。
- **为了方便使用 `eval`。** 二次解析会扩大注入和引用错误。

## 纸面练习

若 A 成功、B 失败，命令串 `A && B || C` 会执行哪些命令？最终状态通常由谁决定？

### 答案

A 执行并成功，所以 B 执行；B 失败使 `A && B` 整体失败，于是 C 执行。整个列表的最终状态通常是 C 的退出状态。因此它不总等价于简单 if/else。

## 小结

命令串是一个由退出状态驱动的控制流图。明确区分 `;`、`&&`、`||`、后台和分组，并让不可信数据停留在参数边界内，脚本才可预测。

---

[← 上一篇：文件权限](./11-perceiving-permissions.md) · [本节索引](./README.md) · [下一篇：终端复用 →](./13-terminal-multiplexing.md)
