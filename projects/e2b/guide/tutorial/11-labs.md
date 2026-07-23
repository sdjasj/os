# 模块 11：循序渐进的源码实验

下面 8 个实验从“会用”逐步走到“能贡献”。实验默认在独立练习目录中完成，不要求修改仓库源码；第 7、8 个建议在临时 Git 分支进行。运行真实云实验会消耗资源，务必设置合理 timeout 并清理。

## 实验前准备

检查工具版本：

```bash
node --version
pnpm --version
python --version
uv --version
```

检查凭据存在但不要打印值：

```bash
test -n "$E2B_API_KEY" && echo 'E2B_API_KEY is set'
```

创建练习目录：

```bash
mkdir -p /tmp/e2b-learning-labs
cd /tmp/e2b-learning-labs
```

若不希望使用 `/tmp`，可换成明确的个人练习目录。不要在仓库根创建会被误提交的密钥或大文件。

## 实验 1：最小 Sandbox 生命周期

### 目标

验证 create、files、commands、getInfo、kill，并观察控制面信息与 envd 操作的边界。

### TypeScript 实现

```bash
mkdir lab01-js
cd lab01-js
pnpm init
pnpm add e2b
pnpm add -D tsx typescript
```

`main.ts`：

```ts
import { Sandbox } from 'e2b'

const sandbox = await Sandbox.create({
  timeoutMs: 120_000,
  metadata: { tutorial: 'lab01' },
})

console.log('created', sandbox.sandboxId)

try {
  await sandbox.files.write('/tmp/name.txt', 'E2B')
  const result = await sandbox.commands.run(
    'printf "hello "; cat /tmp/name.txt'
  )

  const info = await sandbox.getInfo()
  console.log({
    output: result.stdout,
    state: info.state,
    templateId: info.templateId,
  })
} finally {
  console.log('killed', await sandbox.kill())
}
```

运行：

```bash
pnpm exec tsx main.ts
```

### 观察与回答

1. 哪个操作访问控制面，哪个访问 envd？
2. `result.stdout` 是否包含换行？为什么？
3. 把 `finally` 去掉会留下什么风险？
4. kill 后调用 `isRunning()` 会得到什么？

### Python 等价实现

```bash
cd /tmp/e2b-learning-labs
mkdir lab01-py
cd lab01-py
uv init
uv add e2b
```

```python
from e2b import Sandbox

with Sandbox.create(timeout=120, metadata={"tutorial": "lab01"}) as sandbox:
    sandbox.files.write("/tmp/name.txt", "E2B")
    result = sandbox.commands.run('printf "hello "; cat /tmp/name.txt')
    print(result.stdout)
```

写出 JS/Python 时间参数的换算关系。

## 实验 2：命令事件、stdin 与错误

### 目标

理解 `CommandHandle`，正确发送 EOF，并区分业务退出与传输失败。

```ts
import { CommandExitError, Sandbox } from 'e2b'

const sandbox = await Sandbox.create({ timeoutMs: 120_000 })

try {
  const chunks: string[] = []
  const handle = await sandbox.commands.run('sort', {
    background: true,
    stdin: true,
    timeoutMs: 0,
    onStdout: (chunk) => {
      chunks.push(chunk)
      process.stdout.write(chunk)
    },
  })

  await handle.sendStdin('z\n')
  await handle.sendStdin('a\n')
  await handle.closeStdin()
  const result = await handle.wait()

  console.log({
    pid: handle.pid,
    callbackChunks: chunks.length,
    accumulated: result.stdout,
  })

  try {
    await sandbox.commands.run('echo expected-error >&2; exit 23')
  } catch (error) {
    if (error instanceof CommandExitError) {
      console.log({ code: error.exitCode, stderr: error.stderr })
    } else {
      throw error
    }
  }
} finally {
  await sandbox.kill()
}
```

### 变体

1. 注释掉 `closeStdin()`，观察 `wait()` 为什么不结束，然后安全 kill；
2. 把命令 timeout 设为 1 秒，运行 `sleep 5`；
3. 把 Sandbox timeout 设为 2 秒、命令 timeout 设为 0，比较错误；
4. 输出一个 emoji，设计测试让 UTF-8 bytes 跨 chunk，并阅读 SDK decoder 代码解释为何仍正确。

## 实验 3：PTY 与 Web 服务

### 目标

理解普通命令与终端设备的差异，并用 `getHost()` 暴露服务。

```ts
import { Sandbox } from 'e2b'

const sandbox = await Sandbox.create({ timeoutMs: 180_000 })

try {
  const decoder = new TextDecoder()
  const output: string[] = []
  const terminal = await sandbox.pty.create({
    cols: 80,
    rows: 24,
    timeoutMs: 0,
    onData: (bytes) => {
      const text = decoder.decode(bytes, { stream: true })
      output.push(text)
      process.stdout.write(text)
    },
  })

  await sandbox.pty.sendInput(
    terminal.pid,
    new TextEncoder().encode('stty size\nexit\n')
  )
  await terminal.wait()

  const server = await sandbox.commands.run(
    'python3 -m http.server 8000 --directory /tmp',
    { background: true, timeoutMs: 0 }
  )
  await sandbox.files.write('/tmp/index.html', 'hello from service')

  const url = `https://${sandbox.getHost(8000)}`
  console.log('open:', url)

  await server.kill()
} finally {
  await sandbox.kill()
}
```

### 观察与回答

1. PTY 输出为什么包含命令回显和控制字符？
2. `getHost()` 为什么不能证明服务已经 ready？
3. 如果浏览器访问失败，应该检查哪四层？
4. 为服务加入 `/health` 后，Template 应使用哪个 ReadyCmd？

## 实验 4：流式文件与目录监听

### 目标

实践流消费、取消与 watch 生命周期。

```ts
import { createHash } from 'node:crypto'
import { Sandbox } from 'e2b'

const sandbox = await Sandbox.create({ timeoutMs: 180_000 })

try {
  await sandbox.files.makeDir('/workspace/events')

  const watch = await sandbox.files.watchDir(
    '/workspace/events',
    (event) => console.log('event', event.type, event.name),
    { recursive: true, includeEntry: true, timeoutMs: 0 }
  )

  await sandbox.files.write('/workspace/events/a.txt', 'A')
  await sandbox.files.rename(
    '/workspace/events/a.txt',
    '/workspace/events/b.txt'
  )

  const large = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 1024; i++) {
        controller.enqueue(new Uint8Array(1024).fill(i % 251))
      }
      controller.close()
    },
  })

  await sandbox.files.write('/workspace/events/large.bin', large)

  const download = await sandbox.files.read('/workspace/events/large.bin', {
    format: 'stream',
  })
  const hash = createHash('sha256')
  for await (const chunk of download as unknown as AsyncIterable<Uint8Array>) {
    hash.update(chunk)
  }
  console.log(hash.digest('hex'))

  await watch.stop()
} finally {
  await sandbox.kill()
}
```

### 验证点

- watch 一定被 stop；可把它也放进内层 finally；
- 上传和下载没有把完整文件显式组装成一个大 Buffer；
- `includeEntry` 在 rename/remove 事件中允许为空；
- 把 download 提前 `cancel()`，确认程序可正常退出。

## 实验 5：Template 缓存与 Ready

### 目标

观察 Builder 序列化、COPY hash、远端构建日志和基于可用性的 ready check。

创建：

```text
lab05-template/
├── build.ts
├── requirements.txt
└── server.py
```

`requirements.txt`：

```text
flask==3.1.1
```

`server.py`：

```python
from flask import Flask

app = Flask(__name__)


@app.get("/health")
def health():
    return {"ok": True}


app.run(host="0.0.0.0", port=8000)
```

`build.ts`：

```ts
import { Template, defaultBuildLogger, waitForURL } from 'e2b'

const template = Template({ fileContextPath: process.cwd() })
  .fromPythonImage('3.12')
  .setWorkdir('/app')
  .copy('requirements.txt', '/app/requirements.txt')
  .copy('server.py', '/app/server.py')
  .runCmd('pip install --no-cache-dir -r /app/requirements.txt', {
    user: 'root',
  })
  .setStartCmd(
    'python /app/server.py',
    waitForURL('http://localhost:8000/health', 200)
  )

console.log(await Template.toJSON(template))

await Template.build(template, 'tutorial-flask:v1', {
  cpuCount: 1,
  memoryMB: 1024,
  onBuildLogs: defaultBuildLogger(),
})
```

### 步骤

1. 首次构建，记录上传日志和总耗时；
2. 不改文件再次构建新 tag，观察 COPY 是否复用；
3. 修改 `server.py` 再构建，观察哪个 hash 改变；
4. 加入 `.dockerignore` 忽略一个大文件；
5. 把 ready URL 改错，观察失败 reason 和本地调用栈；
6. 用 `Sandbox.create('tutorial-flask:v1')` 验证服务。

完成后按 CLI/SDK 当前能力删除不再需要的持久 Template，避免污染团队命名空间。

## 实验 6：Pause、Snapshot、Fork 与 Volume

### 目标

比较四种状态保存机制。

### 步骤 A：Pause

1. 创建 Sandbox；
2. 写 `/workspace/state.txt`；
3. 启动长时间进程；
4. `pause()` 后 `connect()`；
5. 检查文件和进程。

重复一次但使用 `{ keepMemory: false }`，比较进程。

### 步骤 B：Snapshot

```ts
const snapshot = await sandbox.createSnapshot({
  name: 'tutorial-prepared',
})
const fromSnapshot = await Sandbox.create(snapshot.snapshotId)
```

验证文件状态，并分别清理 Sandbox 与 Snapshot。

### 步骤 C：Fork

```ts
const forks = await sandbox.fork({ count: 3 })
const alive: Sandbox[] = []

try {
  for (const item of forks) {
    if (item instanceof Sandbox) alive.push(item)
    else console.error(item)
  }
} finally {
  await Promise.allSettled(alive.map((item) => item.kill()))
}
```

不要用 `Promise.all` 做清理：一个 kill reject 会让你过早离开而忽略其余结果。

### 步骤 D：Volume

1. 创建 Volume 并写数据；
2. 挂载到 Sandbox A，修改数据后 kill A；
3. 挂载到 Sandbox B，验证数据；
4. kill B；
5. 最后明确 destroy Volume。

### 总结表

自己填写：

| 机制                  | 保存文件 | 保存内存/进程 | 独立持久资源 | 典型用途 |
| --------------------- | -------- | ------------- | ------------ | -------- |
| pause memory          |          |               |              |          |
| pause filesystem-only |          |               |              |          |
| snapshot              |          |               |              |          |
| fork                  |          |               |              |          |
| volume                |          |               |              |          |

## 实验 7：读测试并写一个无云单元测试

### 目标

学会从测试理解契约，并选择最便宜的测试层。

### 阅读顺序

1. [`tests/paginator.test.ts`](../../../packages/js-sdk/tests/paginator.test.ts)；
2. [`tests/api/handleApiError.test.ts`](../../../packages/js-sdk/tests/api/handleApiError.test.ts)；
3. [`tests/sandbox/commands/commandHandle.test.ts`](../../../packages/js-sdk/tests/sandbox/commands/commandHandle.test.ts)；
4. [`tests/volume/volume.test.ts`](../../../packages/js-sdk/tests/volume/volume.test.ts)；
5. [`tests/setup.ts`](../../../packages/js-sdk/tests/setup.ts)。

### 任务

在临时分支中为一个现有纯 helper 补充边界测试，例如：

- shell quote 特殊字符；
- Git URL 派生目录名；
- Paginator 没有下一页时错误；
- API 空 body 500；
- network selector callback。

要求：

- 不使用真实凭据；
- 不创建 Sandbox；
- 测试名称表达行为；
- 至少包含正常、边界、错误三个案例；
- 只运行目标测试文件；
- 最后运行对应包 lint/typecheck。

## 实验 8：模拟一次跨语言功能设计

### 目标

不一定真正实现，而是写出可执行的改动方案，证明你能覆盖完整仓库边界。

### 假想需求

“进程列表返回进程启动时间 `startedAt/started_at`。”

### 调研清单

1. 在 [`process.proto`](../../../spec/envd/process/process.proto) 找 `ProcessInfo`；
2. 选择一个未使用 field number，决定是否 optional；
3. 找 JS `ProcessInfo` 和 `Commands.list()` 映射；
4. 找 Python 共享 `ProcessInfo`；
5. 找 sync/async `Commands.list()`；
6. 找 JS/Python 生成文件位置；
7. 找 envd 版本常量和 fallback 模式；
8. 找相关测试。

### 输出一份设计说明

应包含：

```text
协议变化
兼容策略（旧 envd 返回空时怎么办）
JS 公共 API 与实现
Python sync/async 公共 API 与实现
生成命令
测试矩阵
文档/示例
changeset 包与版本级别
风险和回滚
```

### 可选实现

若真正修改：

1. 创建临时分支；
2. 修改 proto；
3. `make codegen`；
4. 完成三套 SDK 适配和测试；
5. `pnpm run format`、`lint`、`typecheck`、`test`；
6. `pnpm changeset`；
7. 审查生成 diff与凭据；
8. PR 描述提供 JS、Python sync、Python async 示例。

注意：客户端仓库的协议修改需要服务端 envd 实际实现才能端到端生效。未经项目维护者确认，不应把只改客户端协议当作完整功能。

## 最终自测

完成 8 个实验后，尝试在白纸上画出：

```text
Sandbox.create
  → ConnectionConfig
  → ApiClient/OpenAPI
  → control plane
  → Sandbox constructor
  → envd HTTP + Connect transport
  → Commands/Filesystem/Pty/Git
```

然后回答：

1. 哪些操作是控制面，哪些是数据面？
2. 四种 timeout 分别限制什么？
3. 为什么命令需要 start/data/end 事件？
4. 为什么文件内容不用 Protobuf？
5. Template COPY 缓存键如何产生？
6. 新 envd 功能怎样兼容旧 Template？
7. 为什么 JS 改动经常要求 Python sync/async 同步修改？
8. 哪些测试可以 mock，哪些必须真实 Sandbox？
9. 何时运行 `make codegen` 和 `pnpm changeset`？
10. 每类持久/临时资源怎样清理？

能完整回答，就已经具备独立阅读和贡献这个仓库的基础。回到[教程目录](README.md)按薄弱模块复习，或直接选择一个小 issue，从测试与公开 API 开始实践。
