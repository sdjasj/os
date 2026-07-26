# 14 · 深入 PATH

> 对应官方模块：[Pondering PATH](https://pwn.college/linux-luminarium/path/)

## 学习目标

- 理解 shell 如何根据 `PATH` 搜索命令。
- 区分带 `/` 的显式路径与只给命令名的查找。
- 识别可写目录、空路径项和顺序劫持风险。

## PATH 是有顺序的目录列表

`PATH` 通常是以冒号分隔的目录列表。输入不含 `/` 的命令名时，shell 从左到右寻找可执行文件，先找到者胜出。输入 `./tool` 或 `/usr/bin/tool` 时已经包含斜杠，不再进行 PATH 搜索。

不同 shell 可能缓存查找结果；Bash 可用 `hash -r` 清空缓存。别名、函数和内建还可能先于外部 PATH 搜索生效，所以应使用 `type -a name` 观察所有候选。

## 安全示例：在临时目录放置自有命令

```bash
cmd_dir=$(mktemp -d)
printf '%s\n' '#!/bin/sh' 'printf "local demo tool\n"' > "$cmd_dir/demo-tool"
chmod 700 "$cmd_dir/demo-tool"
PATH="$cmd_dir:/usr/bin:/bin" command -v demo-tool
PATH="$cmd_dir:/usr/bin:/bin" demo-tool
rm -r -- "$cmd_dir"
```

预期输出形态：

```text
/tmp/tmp.xxxx/demo-tool
local demo tool
```

这里只为两条命令临时设置 PATH，不修改登录配置。专用目录由当前用户拥有，脚本权限为 `700`；系统目录仍作为后续候选，使脚本内的 `printf` 可被找到。

## 为什么搜索顺序是安全边界

若高权限脚本只调用 `backup` 而不写可信绝对路径，同时 PATH 前部含攻击者可写目录，攻击者可以放置同名程序。空路径项（例如开头冒号 `:/usr/bin`）在某些实现中代表当前目录，也会引入相同风险。

防护包括：在权限敏感代码中设置最小、固定、只含可信目录的 PATH；对关键程序使用经过验证的绝对路径；不要把当前目录默认放在系统目录之前；避免通过 `sudo` 盲目保留调用者环境。

## 常见误区

- **认为当前目录自动搜索。** Linux shell 通常要求显式 `./program`，除非 PATH 包含 `.` 或空项。
- **只用 `which` 判断最终命令。** 它可能不反映别名、函数和内建；优先用 `type -a`。
- **把个人可写目录放在 PATH 最前而不考虑同名命令。** 顺序改变实际执行对象。
- **修改 PATH 时覆盖系统目录。** 可能导致基本工具无法找到。

## 纸面练习

`PATH=/opt/tools:/usr/bin:/bin`，前两个目录都存在名为 `scan` 的可执行文件。输入 `scan` 与 `/usr/bin/scan` 分别运行哪个？

### 答案

`scan` 按 PATH 从左到右，运行 `/opt/tools/scan`；显式的 `/usr/bin/scan` 含斜杠，不进行 PATH 搜索，直接尝试该文件。

## 小结

PATH 把一个短命令名映射到具体可执行文件，顺序就是选择规则。任何进入 PATH 的可写目录都可能改变程序身份，因此权限敏感场景必须固定并验证搜索路径。

---

[← 上一篇：终端复用](./13-terminal-multiplexing.md) · [本节索引](./README.md) · [下一篇：Shell 边界现象 →](./15-silly-shenanigans.md)
