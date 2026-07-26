# 13 · 终端复用

> 对应官方模块：[Terminal Multiplexing](https://pwn.college/linux-luminarium/terminal-multiplexing/)

## 学习目标

- 理解伪终端、会话、窗口和 pane 的关系。
- 知道终端复用器为何能在客户端断开后保留工作。
- 安全创建、检查和清理一个临时 tmux 会话。

## 复用器增加了一个持久中间层

普通交互中，shell 的控制终端直接属于当前终端窗口。tmux 或 screen 启动一个长期运行的服务器，为内部程序分配伪终端；客户端只是把键盘和画面连接到服务器。客户端断开不等于服务器或内部进程退出。

```text
本地终端客户端 ⇄ tmux 服务器 ⇄ 伪终端 ⇄ shell/程序
                         ├──── 窗口 1
                         └──── 窗口 2（可再分 pane）
```

这适合长时间编译、日志观察和远程会话，但不是备份机制；机器关机、服务器进程退出或内存故障仍会丢失未保存状态。

## 安全示例：短暂的分离会话

```bash
if command -v tmux >/dev/null 2>&1; then
    session="tutorial_demo_$$"
    tmux new-session -d -s "$session" 'sleep 30'
    tmux has-session -t "$session" 2>/dev/null && printf 'session created\n'
    tmux kill-session -t "$session"
    tmux has-session -t "$session" 2>/dev/null || printf 'session removed\n'
else
    printf 'tmux is not installed; example skipped\n'
fi
```

安装 tmux 时预期输出：

```text
session created
session removed
```

`-d` 表示创建后不附着，`-s` 指定会话名。名称包含当前 shell PID，降低与既有会话冲突的概率。示例只运行 `sleep` 并立即清理，不接触其他会话。

实际交互常用 `tmux attach -t NAME` 附着；默认前缀 `Ctrl-b` 后按 `d` 只分离客户端。应先用 `tmux list-sessions` 确认目标，再删除会话。

## GNU Screen 的对应概念

Screen 也用“持久会话 + 客户端附着”模型，但快捷键和命令不同：

| 操作 | tmux | GNU Screen |
|---|---|---|
| 新建命名会话 | <code>tmux new -s NAME</code> | <code>screen -S NAME</code> |
| 列出会话 | <code>tmux list-sessions</code> | <code>screen -ls</code> |
| 重新附着 | <code>tmux attach -t NAME</code> | <code>screen -r NAME</code> |
| 默认分离键 | <code>Ctrl-b d</code> | <code>Ctrl-a d</code> |
| 终止指定会话 | <code>tmux kill-session -t NAME</code> | <code>screen -S NAME -X quit</code> |

快捷键由“前缀键 + 命令键”组成，不是同时长按全部键。配置可改变前缀，进入陌生环境应先查询帮助，不要盲按终止组合。

## 会话、窗口与 pane

~~~text
服务器
  +-- session: project-a
  |     +-- window 0: editor
  |     +-- window 1: tests
  |           +-- pane left
  |           +-- pane right
  +-- session: monitoring
~~~

tmux 原生强调 pane；Screen 主要以 window 为基本单元，也可提供分区能力。window/pane 关闭通常意味着其中前台 shell/程序退出；detach 只断开显示客户端。

远程连接断开后任务是否继续，还取决于：

- 程序是否真的在复用器内部启动；
- 复用器服务器是否仍活着；
- 系统是否在用户登出时清理进程；
- cgroup/systemd 会话策略；
- 程序是否因网络 fd 断开而自行退出。

长任务应把结果持续写入明确文件，并保留可重启点；复用器只保留进程，不提供作业重试或数据持久性。

## 多客户端与权限

一个会话可被多个客户端附着，这适合结对排障，也意味着共享键盘和屏幕能力。不要通过宽权限 socket 或共享 Unix 账号随意开放会话。协作时明确：

- 谁能输入，谁只观察；
- 是否会显示凭据、客户数据或剪贴板；
- 命令和时间怎样审计；
- 会话结束后由谁清理；
- 是否应该改用有权限控制和录制的正式运维工具。

## 安全视角

复用器会保留屏幕历史、环境和正在运行的命令。共享账户或宽松 socket 权限可能暴露敏感信息。不要在命令行中输入长期秘密；锁定离开的工作站，并妥善管理会话服务器权限。

## 常见误区

- **把 detach 当作退出。** 分离只断开客户端，内部进程继续运行。
- **把关闭 pane 当作最小化。** 最后一个程序退出通常会关闭 pane。
- **认为 tmux 能跨重启保留进程。** 它依赖当前系统和服务器进程。
- **按模糊名字删除会话。** 应列出并精确指定目标。

## 纸面练习

SSH 连接中启动 tmux，再在其中运行编译；随后网络断开。为什么编译通常能继续？哪些事件仍会让它停止？

### 答案

编译进程连接 tmux 创建的伪终端，tmux 服务器仍在远端运行，SSH 客户端断开不直接销毁内部终端。远端重启、tmux 服务器被杀、会话被显式删除、资源耗尽或编译程序自身失败仍会使其停止。

## 小结

终端复用器用持久服务器把程序生命周期与显示客户端解耦。理解 attach、detach 和 kill 的差异，才能既保留任务又避免遗留无用会话。

---

[← 上一篇：命令串联](./12-chaining-commands.md) · [本节索引](./README.md) · [下一篇：深入 PATH →](./14-pondering-path-env.md)
