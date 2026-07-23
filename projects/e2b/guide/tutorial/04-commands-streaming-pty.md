# 模块 4：命令、事件流与 PTY

命令模块是 E2B 数据面最典型的实现：它把一个远端 Linux 进程抽象成方法、流式事件和可控制句柄。本模块从 `commands.run()` 一直追到 Protobuf。

## 1. 公开 API 的三种执行模式

### 1.1 前台执行

```ts
const result = await sandbox.commands.run('echo hello')
console.log(result.exitCode, result.stdout, result.stderr)
```

调用在命令结束后返回 `CommandResult`。这是最简单模式，但“前台”只是 SDK 等待远端完成；命令仍在 Sandbox 中运行，而不是本地子进程。

### 1.2 后台执行

```ts
const handle = await sandbox.commands.run('sleep 60', {
  background: true,
  timeoutMs: 0,
})

console.log(handle.pid)
await handle.kill()
```

`background: true` 让 `run()` 在收到远端 `start(pid)` 事件后返回 `CommandHandle`，不等待 `end`。

### 1.3 流式回调

```ts
const result = await sandbox.commands.run(
  'for i in 1 2 3; do echo $i; sleep 1; done',
  {
    onStdout: (chunk) => process.stdout.write(`[remote] ${chunk}`),
    onStderr: (chunk) => process.stderr.write(chunk),
  }
)
```

回调收到“数据块”而不是保证按行分割的文本。不要假设一次回调对应一行；若要逐行解析，应自行缓存不完整尾行。

## 2. TypeScript 重载怎样约束返回类型

[`Commands.run`](../../../packages/js-sdk/src/sandbox/commands/index.ts) 声明多个重载：

```ts
run(cmd, { background: true }): Promise<CommandHandle>
run(cmd, { background?: false }): Promise<CommandResult>
```

实现只有一份：

```ts
const proc = await this.start(cmd, opts)
return opts?.background ? proc : proc.wait()
```

这个模式把“启动”与“是否等待”分开。无论前台还是后台，都先得到同一种 `CommandHandle`；前台只是在内部立即调用 `wait()`。

为什么需要精确的字面量 `true/false` 重载？因为若 `background` 是普通 `boolean` 变量，编译器无法知道分支，返回类型就必须是 `CommandHandle | CommandResult`。调用者若传常量 `true`，则能获得精确类型。

## 3. 远端实际运行的命令

`start()` 没有把用户字符串直接设为可执行文件，而是构造：

```text
cmd: /bin/bash
args: ['-l', '-c', userCommand]
```

`-l` 使用 login shell，`-c` 执行字符串。因此 shell 展开、管道、重定向和 `&&` 都可用：

```ts
await sandbox.commands.run('cd /workspace && npm test >test.log 2>&1')
```

风险也很直接：如果把不可信字符串拼进命令，可能发生 shell 注入。SDK 只能隔离 Sandbox 与宿主，不能阻止不可信参数破坏同一个 Sandbox 的文件或窃取它能访问的密钥。

安全拼接应使用项目的 `shellQuote()` 思路，或把数据写入文件/环境变量后让固定命令读取。Git 和 Template 模块内部都专门对参数做 shell quote。

## 4. `Process.Start` 协议

协议在 [`spec/envd/process/process.proto`](../../../spec/envd/process/process.proto)：

```proto
rpc Start(StartRequest) returns (stream StartResponse);
```

`ProcessEvent` 使用 Protobuf `oneof` 表示互斥事件：

- `start`：包含 PID；
- `data`：stdout、stderr、pty 三选一的 bytes；
- `end`：退出码、状态、可选错误；
- `keepalive`：保持流活跃。

服务端流比轮询有两个优势：输出延迟低，而且命令结束自然成为事件序列的一部分。

SDK 在请求 Header 中设置 `Keepalive-Ping-Interval: 50`，让中间网络设备不会把长时间无输出但仍运行的命令误判为空闲连接。

## 5. 启动握手与两种 timeout

`Commands.start()` 调用 [`setupRequestController`](../../../packages/js-sdk/src/connectionConfig.ts)：

1. 创建 `AbortController`；
2. 用 `requestTimeoutMs` 限制收到第一个 start 事件前的握手；
3. 把用户 `AbortSignal` 接到同一控制器；
4. 收到 `start(pid)` 后清除握手 timer；
5. 流最终结束时 cleanup。

与此同时，Connect 调用的 `timeoutMs` 限制整个命令连接：

| 参数                | 默认值 | 限制范围                  |
| ------------------- | ------ | ------------------------- |
| `requestTimeoutMs`  | 60 秒  | 请求建立并收到 start 事件 |
| `timeoutMs`         | 60 秒  | 命令/流可以保持多久       |
| Sandbox `timeoutMs` | 5 分钟 | 整个 Sandbox 生命周期     |

长任务通常需要：

```ts
await sandbox.commands.run('long-job', {
  timeoutMs: 0,
})
```

但 Sandbox 自身仍可能在生命周期 timeout 到达时被 kill。把命令连接设为无限并不会延长 Sandbox；需要同时合理设置 `Sandbox.create({ timeoutMs })` 或调用 `setTimeout()`。

Python 同样分 `request_timeout` 与 `timeout`，单位都是秒。

## 6. `CommandHandle` 的内部状态

[`CommandHandle`](../../../packages/js-sdk/src/sandbox/commands/commandHandle.ts) 保存：

- PID；
- stdout/stderr 累积字符串；
- 两个增量 `TextDecoder`；
- 最终 `CommandResult`；
- 事件迭代错误；
- 是否已 disconnect；
- 构造时立即启动的 `_wait = handleEvents()` Promise。

构造时就开始消费事件非常关键。如果后台命令返回句柄后用户迟迟不调用 `wait()`，SDK 仍然会接收事件，避免服务端输出流无人读取造成阻塞。调用 `wait()` 只是等待已经运行的消费任务完成。

### 6.1 数据事件

stdout/stderr bytes 使用流式 `TextDecoder`：

```ts
decoder.decode(bytes, { stream: true })
```

文本追加到累积结果后，再 yield 给回调。PTY 保持 `Uint8Array`，因为终端输出可能包含控制序列，不应提前解释为普通文本。

### 6.2 End 事件

收到 end 时，代码先 flush decoder，再记录结果。顺序经过专门设计：即使消费者在第一个 flush 块后停止迭代，退出码也已经被保存。

### 6.3 `wait()`

`wait()` 的决策：

```text
等待事件循环结束
  ├─ 有迭代错误 → 抛映射后的错误
  ├─ 没有 end 结果 → SandboxError
  ├─ exitCode != 0 → CommandExitError
  └─ exitCode == 0 → 返回 CommandResult
```

非零退出码是远端命令的正常失败模式，不是传输失败。`CommandExitError` 实现 `CommandResult` 的字段，所以可直接读取 stdout、stderr 和 exitCode：

```ts
import { CommandExitError } from 'e2b'

try {
  await sandbox.commands.run('exit 7')
} catch (error) {
  if (error instanceof CommandExitError) {
    console.error(error.exitCode, error.stderr)
  } else {
    throw error
  }
}
```

## 7. Stdin 与 EOF

交互式非 PTY 命令必须显式 `stdin: true`：

```ts
const handle = await sandbox.commands.run('wc -c', {
  background: true,
  stdin: true,
  timeoutMs: 0,
})

await handle.sendStdin('hello')
await handle.closeStdin()
console.log((await handle.wait()).stdout) // 5
```

`closeStdin()` 发送 EOF。只发送数据但不关闭 stdin，像 `cat`、`wc`、`grep` 这样的程序会继续等待，`wait()` 永远不返回。

envd 的老版本没有 CloseStdin RPC。SDK 用版本常量检查能力，不支持时抛出升级 Template 的错误。CLI `sandbox exec` 也会先检查 `supportsStdinClose`，不能支持时忽略管道 stdin 并发出警告。

## 8. Disconnect 与 Kill 的区别

```ts
await handle.disconnect()
```

只停止 SDK 接收事件，不杀远端进程。之后可：

```ts
const processes = await sandbox.commands.list()
const same = await sandbox.commands.connect(handle.pid)
```

`disconnect()` 适合 CLI 的 `--background`：命令继续运行，CLI 返回 PID 并退出。

```ts
await handle.kill()
```

通过 `SendSignal(SIGKILL)` 终止远端进程。SIGKILL 不能被进程捕获来做优雅清理；若业务需要优雅结束，可以让应用监听自己的控制输入，或执行合适的 shutdown 命令。

JS `disconnect()` 设置标志并 abort 底层流，保证调用返回后不再触发新回调。它不保证 `wait()` 还能得到 end 结果，因为主动断流可能没有最终 end 事件。

## 9. `Commands.list()` 与 Reconnect

```ts
const running = await sandbox.commands.list()
for (const process of running) {
  console.log(process.pid, process.cmd, process.args, process.cwd)
}
```

列表包含命令、PTY 和模板 start command。`ProcessInfo.tag` 可标识特殊进程。

Reconnect 只能继续接收连接之后产生的事件，不应假定服务端重放全部历史 stdout。若业务必须保存输出，应在初次回调中写入外部日志系统或 Sandbox 文件。

## 10. PTY 与普通命令的差异

PTY（伪终端）模拟人类终端设备。很多程序检测到 TTY 后会改变行为：

- 启用颜色和光标控制序列；
- 显示交互提示；
- 按字符而不是按缓冲行读取；
- 响应窗口尺寸变化；
- shell job control 可用。

创建：

```ts
const decoder = new TextDecoder()
const terminal = await sandbox.pty.create({
  cols: 80,
  rows: 24,
  envs: { TERM: 'xterm-256color' },
  onData: (data) => process.stdout.write(decoder.decode(data)),
  timeoutMs: 0,
})

await sandbox.pty.sendInput(
  terminal.pid,
  new TextEncoder().encode('echo hello\n')
)
await sandbox.pty.resize(terminal.pid, { cols: 120, rows: 40 })
```

[`Pty.create`](../../../packages/js-sdk/src/sandbox/commands/pty.ts) 实际启动 `/bin/bash -i -l`，并默认补充 `TERM`、`LANG`、`LC_ALL`。输入走 Protobuf `pty` bytes，不是 stdin 字段。

PTY 没有 `closeStdin()` 语义；协议注释要求发送 Ctrl+D（`0x04`）表示终端 EOF。常见结束方式是发送 `exit\n`。

## 11. Python 的事件消费方式

同步 [`CommandHandle`](../../../packages/python-sdk/e2b/sandbox_sync/commands/command_handle.py) 本身可迭代，`wait()` 遍历生成器并调用回调；异步句柄使用异步迭代/等待。

```python
handle = sandbox.commands.run(
    "cat",
    background=True,
    stdin=True,
    timeout=0,
)
handle.send_stdin("hello\n")
handle.close_stdin()
result = handle.wait(on_stdout=lambda chunk: print(chunk, end=""))
```

Python 同样用 incremental UTF-8 decoder，并在流结束时 flush。同步与异步实现必须在：非零退出、断流、半个 UTF-8 字符、关闭 stdin、健康检查等边界保持一致。

## 12. 错误诊断

| 现象                           | 优先检查                                                    |
| ------------------------------ | ----------------------------------------------------------- |
| 命令 60 秒后失败               | `timeoutMs`/Python `timeout` 是否仍为默认 60 秒             |
| `wait()` 一直不返回            | 程序是否等待 stdin，是否调用 `closeStdin()`                 |
| stdout 中文乱码                | 是否在业务回调里对每个 bytes 块独立解码；PTY 应复用 decoder |
| Sandbox 中命令还在但本地没输出 | 是否调用过 `disconnect()`，网络流是否中断                   |
| 立即 `Unavailable`             | Sandbox 是否已超时/kill，envd 健康检查结果                  |
| 非零退出被当成 SDK 故障        | 应捕获 `CommandExitError`/`CommandExitException`            |
| 交互程序不显示提示             | 应使用 PTY，不是普通 command stdin                          |

## 13. 本模块练习

1. 启动每秒输出一行的后台命令，在第 3 行 disconnect，再通过 PID connect。
2. 用 `wc -l` 接收三行 stdin，关闭 stdin 后验证输出。
3. 故意执行 `sh -c 'echo err >&2; exit 9'`，读取错误对象的所有字段。
4. 创建 PTY，执行 `stty size`，resize 后再次执行并比较。
5. 写一个按行聚合器，正确处理一行被拆成多个 stdout chunk 的情况。

下一步阅读[模块 5：文件系统、Git 与 Volume](05-files-git-volume.md)。
