# 07 · Shell 变量

> 对应官方模块：[Shell Variables](https://pwn.college/linux-luminarium/variables/)

## 学习目标

- 区分 shell 变量与导出的环境变量。
- 理解赋值、参数展开和单/双引号的差别。
- 避免由未引用展开引起的分词和通配符问题。

## 变量存在于哪一层

`name=value` 在当前 shell 创建变量，等号两侧不能有分隔空格。`export name` 把它标记为环境变量，使之后启动的子进程得到一份副本。子进程修改自己的副本不会反向改变父 shell。

变量展开先产生文本，未引用的展开还可能经历字段分割和通配。稳健的默认写法是 `"$name"`。单引号完全抑制展开，双引号允许 `$name`、命令替换等有限展开。

## 安全示例：观察继承

```bash
unset topic
topic='Linux basics'
printf 'parent: <%s>\n' "$topic"
bash -c 'printf "child before export: <%s>\n" "$topic"'
export topic
bash -c 'printf "child after export: <%s>\n" "$topic"'
```

预期输出：

```text
parent: <Linux basics>
child before export: <>
child after export: <Linux basics>
```

先执行 `unset`，是为了排除调用者环境里恰好已经导出同名变量的影响。第一个子 Bash 没收到普通 shell 变量；导出后，新启动的子 Bash 从环境取得值。这里用尖括号显示边界，可以看出空值和含空格值仍是一个参数。

常用的带默认值展开：

```bash
unset label
printf '%s\n' "${label:-unnamed}"
```

预期输出 `unnamed`。`${...}` 明确变量名边界，`:-` 在变量未设置或为空时提供默认值，并不修改变量本身。

## 命令替换：捕获的是文本，不是退出状态

<code>result=$(command)</code> 捕获 command 的标准输出，并删除一个或多个末尾换行。标准错误默认仍去原来的 fd 2；命令状态可在紧接着的 <code>$?</code> 中取得。

~~~bash
line_count=$(printf '%s\n' alpha beta | wc -l)
capture_status=$?
printf 'count=<%s> status=%d\n' "$line_count" "$capture_status"
~~~

预期：

~~~text
count=<2> status=0
~~~

不要写成 <code>local value=$(command)</code> 后再读 <code>$?</code> 并假设它一定是 command 的状态；声明型 builtin 可能覆盖状态。更清楚的方式是分成赋值、保存状态、判断三步。

命令替换不适合保存任意二进制数据：shell 变量不能包含 NUL，末尾换行也会被删除。二进制应留在文件描述符、文件或支持 bytes 的语言对象中。

## read：从输入流建立变量边界

<code>read</code> 默认解释反斜杠并按 IFS 分字段。稳健读取一整行通常使用 <code>IFS= read -r line</code>：

~~~bash
printf '%s\n' 'alice,7' 'bob,11' \
  | while IFS=, read -r name score; do
      printf 'name=<%s> score=<%s>\n' "$name" "$score"
    done
~~~

预期：

~~~text
name=<alice> score=<7>
name=<bob> score=<11>
~~~

这里明确把逗号设为字段边界。真实 CSV 允许引号、嵌入逗号和换行，不能靠 IFS 正确解析，需使用 CSV 库。读取任意文件名则应使用 NUL 分隔和 <code>read -d ''</code>。

从交互终端读取时，<code>read -s</code> 仅关闭显示回显，不会让秘密脱离进程、终端或调试观察面。

## 特殊参数说明进程上下文

| 参数 | 含义 |
|---|---|
| <code>$?</code> | 最近前台管道的退出状态 |
| <code>$$</code> | 当前 shell 的进程号 |
| <code>$!</code> | 最近后台管道的进程号 |
| <code>$#</code> | 脚本/函数的位置参数个数 |
| <code>$1</code>、<code>$2</code> | 第一个、第二个位置参数 |
| <code>"$@"</code> | 保持每个位置参数独立，适合转发 |
| <code>"$*"</code> | 在双引号中合并成一个字符串，通常不适合转发 |

转发参数时：

~~~bash
show_arguments() {
    printf 'count=%d\n' "$#"
    for value in "$@"; do
        printf '<%s>\n' "$value"
    done
}
show_arguments 'red blue' green
~~~

预期 count 为 2，随后两行分别保留 <code>red blue</code> 和 <code>green</code> 的边界。

## 数组保存多个参数

一个空格分隔字符串无法表示“一个含空格的参数”和“两个参数”的差别。Bash 数组为每个元素保存独立边界。引用数组全部元素时应使用双引号包围的 at 展开；未引用会再次分词和通配。

数组是 Bash 特性，不属于最小 POSIX sh。若脚本声明 <code>#!/bin/sh</code>，就不应悄悄依赖 Bash 数组。

## 环境变量是进程接口

exec 时，父进程把导出的键值对复制给新程序。常见安全敏感项包括 PATH、动态链接相关变量、代理设置、语言环境、HOME 和配置搜索路径。

跨权限边界的程序应：

- 建立最小环境，而不是盲目继承；
- 为 PATH 使用可信绝对目录；
- 明确语言环境，避免解析随 locale 改变；
- 删除影响加载器、解释器和插件搜索的危险变量；
- 不把长期秘密当普通环境配置；
- 记录变量名称与来源，但不要记录敏感值。

## 安全视角

环境变量会影响程序行为，例如语言、动态链接、代理和命令搜索路径。跨权限边界的程序不能盲目信任继承环境。脚本也不应把秘密放在命令行或随意导出的变量中；它们可能被子进程或诊断工具看到。

## 常见误区

- **写成 `name = value`。** shell 会把 `name` 当命令，而不是赋值。
- **认为所有变量自动传给子进程。** 只有导出的变量进入环境。
- **使用 `$file` 而不加引号。** 空格、星号和空值会改变参数个数。
- **认为单引号内会展开。** `'$topic'` 输出字面文本 `$topic`。

## 纸面练习

令 `item='red blue'`。`printf '<%s>\n' $item` 与 `printf '<%s>\n' "$item"` 各输出几行？

### 答案

默认 Bash 下，未引用的 `$item` 被字段分割成 `red`、`blue` 两个参数，输出两行；双引号保留一个参数，输出一行 `<red blue>`。这也是变量展开应默认加引号的原因。

## 小结

shell 变量属于当前解释器，导出后才会复制到子进程环境。引用规则决定展开结果是一个参数还是多个参数，是可靠脚本最关键的基础之一。

---

[← 上一篇：管道与重定向](./06-practicing-piping.md) · [本节索引](./README.md) · [下一篇：数据处理 →](./08-data-manipulation.md)
