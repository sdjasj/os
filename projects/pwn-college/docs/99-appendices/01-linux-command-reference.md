# 01 · Linux 命令参考：从任务到数据流

## 先建立命令模型

一条命令的行为不只由名字决定，还取决于参数数组、当前目录、环境变量、文件描述符、进程身份和退出状态：

```text
命令来源 + argv + cwd + env + fd(0/1/2) + UID/GID → 输出、副作用、退出状态
```

排错时逐项确认，比反复更换选项有效。先用 `type -a NAME` 确认命令究竟是别名、函数、内建还是外部文件，再用 `help`、`man` 或 `--help` 查对应实现。

## 按任务选择工具

| 任务 | 首选工具 | 关键语义 |
| --- | --- | --- |
| 查看路径和元数据 | `pwd`、`realpath`、`stat`、`file` | 路径、对象、权限是不同层次 |
| 枚举文件 | `find` | 直接遍历目录，不解析 `ls` 文本 |
| 阅读文本 | `sed -n`、`head`、`tail`、`less` | 明确行范围；大文件避免一次全读 |
| 查找内容 | `rg` 或 `grep` | 区分正则与字面量，注意二进制和编码 |
| 字段与聚合 | `cut`、`sort`、`uniq`、`awk` | 先定义记录、字段与区域设置 |
| 比较文件 | `cmp`、`diff`、`sha256sum` | 哈希相同可验证内容相同，不证明来源可信 |
| 观察进程 | `ps`、`pgrep`、`jobs`、`wait` | PID、进程组和 shell 作业号不同 |
| 查看身份权限 | `id`、`namei`、`stat`、`getfacl` | 路径每一级目录都参与访问判断 |
| 查看磁盘 | `df`、`du` | `df` 看文件系统，`du` 遍历可见目录树 |
| 打包与压缩 | `tar`、`gzip`、`xz` | 归档路径可能穿越，解包外来文件要隔离 |

并非每台机器都预装 `rg`、`getfacl` 等工具；脚本应检查可用性或选择标准替代品。

## 示例一：先观察，再读取

下面只操作刚创建的临时目录：

```bash
ref_dir=$(mktemp -d)
printf '%s\n' 'alpha:3' 'beta:7' 'alpha:2' > "$ref_dir/data.txt"

stat -c 'mode=%A size=%s path=%n' -- "$ref_dir/data.txt"
file -- "$ref_dir/data.txt"
sed -n '1,2p' -- "$ref_dir/data.txt"

rm -r -- "$ref_dir"
```

预期输出形态：

```text
mode=-rw-r--r-- size=23 path=/tmp/tmp.xxxx/data.txt
/tmp/tmp.xxxx/data.txt: ASCII text
alpha:3
beta:7
```

模式受 `umask` 影响，`file` 的描述也可能略有差异。`--` 结束选项解析，引用保持路径为一个参数；`sed -n` 只打印明确范围。

## 示例二：从记录到汇总

```bash
printf '%s\n' 'alpha:3' 'beta:7' 'alpha:2' \
| awk -F: '{ sum[$1] += $2 } END { for (key in sum) print key, sum[key] }' \
| LC_ALL=C sort
```

预期输出：

```text
alpha 5
beta 7
```

这里输入模型是“一行一条记录、冒号分隔两个字段”。`awk` 聚合后，关联数组遍历顺序没有保证，因此最后显式排序。真实 CSV 或 JSON 有自己的转义语法，不应靠单字符切割代替解析器。

## 示例三：可靠传递文件名

文件名可以包含空格和换行。不要写 `for f in $(find ...)`，而应让边界保持为 NUL：

```bash
find "$ref_dir" -type f -print0 \
| while IFS= read -r -d '' path; do
    printf 'path=%q\n' "$path"
  done
```

`%q` 输出的是 shell 转义显示，不是文件名实际多了反斜杠。若只是对每个文件运行固定程序，`find ... -exec command -- {} +` 往往更直接。

## 标准流与退出状态

| 编号 | 默认名字 | 常用重定向 |
| --- | --- | --- |
| 0 | stdin | `<input` |
| 1 | stdout | `>output`、`>>output` |
| 2 | stderr | `2>error.log` |

`A | B` 默认只连接 A 的 fd 1 到 B 的 fd 0。`cmd >all.log 2>&1` 与 `cmd 2>&1 >out.log` 不等价，因为重定向从左到右生效。

```bash
if test -r /etc/hosts; then
    printf 'readable\n'
else
    printf 'not readable\n' >&2
fi
```

常见系统输出 `readable`，但脚本正确性不应依赖该文件一定存在。退出状态 0 通常表示成功，非零含义需查具体程序手册；要立刻保存状态，因为下一条命令会覆盖 `$?`。

## 进程与空间的常用观察

```bash
ps -o pid,ppid,stat,comm -p "$$"
df -h --output=source,size,used,avail,target .
du -sh -- "$PWD"
```

`ps` 查看当前 shell；`df` 报当前目录所在文件系统的整体使用量；`du` 遍历当前目录可见内容。二者不同并不矛盾：已删除但仍打开的文件、权限、稀疏文件和快照都会造成差异。

## 破坏性操作前的准则

1. 拒绝空变量、根目录、家目录和未解析通配符。
2. 用 `find`、`stat` 等只读命令预览精确目标。
3. 支持时先移动到隔离区，保留恢复窗口。
4. 对精确路径使用引号和 `--`。
5. 检查退出状态和删除后的剩余对象。

不要把 `rm -rf`、`chmod -R`、`chown -R` 当作通用修复。递归命令的风险来自目标范围，而不是命令本身是否常见。

## 常见误判

- `ls` 显示的是面向人的文本，不是安全的文件名协议。
- `grep` 找不到内容可能是编码、二进制检测、权限或正则问题，不只代表不存在。
- `kill` 默认发送信号，不保证进程立即消失；`kill -9` 也不给清理机会。
- `sha256sum` 验证的是字节一致性；只有与可信来源的预期值比较才有来源意义。
- `sudo` 会改变身份、环境和文件所有权，不是解决权限问题的默认前缀。

## 进一步查阅

- [GNU Coreutils 官方手册](https://www.gnu.org/software/coreutils/manual/coreutils.html)
- [GNU Bash 官方手册](https://www.gnu.org/software/bash/manual/bash.html)
- 本教程的 [Linux Luminarium 索引](../01-linux-luminarium/README.md)

---

[← 附录索引](./README.md) · [下一篇：数值与编码参考 →](./02-number-encoding-reference.md)
