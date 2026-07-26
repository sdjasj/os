# 02 · 理解路径

> 对应官方模块：[Pondering Paths](https://pwn.college/linux-luminarium/paths/)

## 学习目标

- 区分绝对路径与相对路径。
- 理解当前工作目录、`cd`、`.`、`..` 和家目录展开。
- 解释路径解析为何与文件是否存在是两个问题。

## 路径是一串逐级解析的名字

绝对路径从根目录 `/` 开始，例如 `/usr/bin/id`；相对路径从进程的当前工作目录开始，例如 `notes/today.txt`。内核逐个解析路径分量：目录必须允许“穿越”，中间分量必须是目录，最后分量才是目标。

`.` 表示当前目录，`..` 表示父目录。`~` 不是内核路径语法，而是 shell 在适当位置把它展开成家目录。因此，在引号内写 `"~"` 通常只是一个波浪号字符。

## 安全示例：只做词法规范化

```bash
pwd
realpath -m ./notes/../draft.txt
```

若当前目录是 `/path/to/alice/work`，预期输出为：

```text
/path/to/alice/work
/path/to/alice/work/draft.txt
```

`realpath -m` 允许路径尚不存在，并按词法消去 `.` 和 `..`。这展示“路径表达式可以规范化”，并不证明 `draft.txt` 已存在或当前用户能读取它。可用下面的条件测试区分存在性：

```bash
if test -e ./draft.txt; then
    printf 'exists\n'
else
    printf 'missing\n'
fi
```

在没有该文件时输出 `missing`。

## `cd` 改变的是当前 shell 的工作目录

每个进程都有自己的当前工作目录（current working directory，cwd）。相对路径从该目录开始解析；`pwd` 显示当前 shell 的 cwd，`cd` 则修改它。`cd` 必须由 shell 自己实现：若只启动一个外部程序并让那个子进程改变目录，子进程退出后，父 shell 的 cwd 不会改变。

`cd` 的几个常见入口各自有明确含义：

- `cd /absolute/path`：从根目录开始解析目标；
- `cd relative/path`：从当前 cwd 开始解析目标；
- 不带参数的 `cd`：进入 `HOME` 指定的家目录；
- `cd -`：回到 shell 记录的上一个工作目录 `OLDPWD`，并通常把目标打印出来；
- `cd ..`：进入当前路径解析结果的父目录。

下面只在 `mktemp` 创建的专用目录中移动。圆括号让整段在子 shell 中运行，因此即使示例中多次 `cd`，读者原来的交互式 shell 也不会被留在临时目录里：

```bash
path_lab=$(mktemp -d)
mkdir -p "$path_lab/home-like/projects/demo" "$path_lab/archive"

(
  HOME="$path_lab/home-like"
  export HOME

  cd || exit 1
  printf 'home=%s\n' "$PWD"

  cd projects/demo || exit 1
  printf 'relative=%s\n' "$PWD"

  cd .. || exit 1
  printf 'parent=%s\n' "$PWD"

  cd "$path_lab/archive" || exit 1
  printf 'absolute=%s\n' "$PWD"

  cd - >/dev/null || exit 1
  printf 'back=%s\n' "$PWD"
)

rm -r -- "$path_lab"
```

预期输出形态如下，临时目录后缀会不同：

```text
home=/tmp/tmp.xxxx/home-like
relative=/tmp/tmp.xxxx/home-like/projects/demo
parent=/tmp/tmp.xxxx/home-like/projects
absolute=/tmp/tmp.xxxx/archive
back=/tmp/tmp.xxxx/home-like/projects
```

第一次 `cd` 没有参数，所以读取本例临时设置的 `HOME`。第二次使用相对路径；第三次用 `..`；第四次给出绝对路径。进入 `archive` 前的 cwd 会写入 `OLDPWD`，所以最后的 `cd -` 返回 `projects`。这里把 `cd -` 自己打印的路径重定向到 `/dev/null`，只保留格式统一的 `back=` 行。

`PWD` 是 shell 维护的逻辑路径，可能保留符号链接名字；`pwd -P` 会尽量显示解析符号链接后的物理路径。涉及安全边界时，不能只比较 `PWD` 字符串，还要考虑实际解析到的文件系统对象。

## 安全视角

把不可信文本直接拼成路径可能产生目录穿越，例如用户输入包含 `../`。防护不能只靠删除字符串中的 `..`，还要规定可信根目录、规范化目标，并验证最终路径仍位于允许范围内。符号链接还会让纯字符串前缀检查失效，真实程序应使用合适的目录文件描述符和安全打开方式。

## 常见误区

- **认为相对路径属于 shell。** 每个进程都有工作目录，程序也会解析相对路径。
- **认为 `..` 永远是字符串上一级。** 符号链接、挂载点和根目录边界会影响实际解析。
- **把 `~` 当作普遍语法。** 很多非 shell API 不展开它。
- **规范化成功就等于可访问。** 存在性、类型和权限仍需分别检查。

## 纸面练习

当前目录为 `/srv/app/logs`，相对路径 `../config/./app.ini` 词法规范化后是什么？它的成功规范化能否证明文件存在？

### 答案

结果是 `/srv/app/config/app.ini`。不能证明存在；规范化只计算名字关系，实际访问还受文件是否存在、目录类型、符号链接和权限影响。

## 小结

绝对路径以 `/` 为起点，相对路径以进程工作目录为起点。路径字符串、解析后的对象和访问权限是三个不同层次，安全代码必须分别验证。

---

[← 上一篇：你好，命令行](./01-hello-hackers.md) · [本节索引](./README.md) · [下一篇：理解命令 →](./03-comprehending-commands.md)
