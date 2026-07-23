# E2B 项目总览与使用指南

这份文档先回答两个问题：这个仓库解决什么问题，以及怎样把它真正运行起来。若要继续深入源码，请从[中文源码学习教程](tutorial/README.md)开始。

## 1. 一句话理解 E2B

E2B 为 AI Agent 和 AI 应用提供云端隔离的 Linux Sandbox。应用可以通过 JavaScript/TypeScript 或 Python SDK 创建临时环境，在其中执行不可信代码、操作文件、运行 Git、启动网络服务，并管理环境的生命周期。

典型场景包括：

- 让大模型生成代码后，在与宿主应用隔离的环境中执行；
- 为每个用户或任务创建一次性的 Linux 工作区；
- 在 Sandbox 中克隆仓库、安装依赖、运行测试；
- 启动 Web 服务，并通过 E2B 分配的域名从外部访问；
- 通过自定义 Template 预装系统包、语言运行时和业务依赖；
- 用 Snapshot、Pause、Fork 和 Volume 保存或复制状态。

## 2. 这个仓库包含什么、不包含什么

这是 E2B 的 SDK、CLI、协议描述和模板构建单仓库，主要交付物是：

| 目录                                                       | 交付物                              | 作用                                  |
| ---------------------------------------------------------- | ----------------------------------- | ------------------------------------- |
| [`packages/js-sdk`](../../packages/js-sdk)                 | npm 包 `e2b`                        | JavaScript/TypeScript SDK             |
| [`packages/python-sdk`](../../packages/python-sdk)         | PyPI 包 `e2b`                       | Python 同步与异步 SDK                 |
| [`packages/cli`](../../packages/cli)                       | npm 包 `@e2b/cli`，命令 `e2b`       | 登录、构建模板、管理 Sandbox          |
| [`packages/connect-python`](../../packages/connect-python) | Protobuf 插件/Connect Python 客户端 | 为 Python SDK 生成 Connect RPC 客户端 |
| [`spec`](../../spec)                                       | OpenAPI、JSON Schema、Protobuf      | SDK 生成代码的协议事实来源            |
| [`templates/base`](../../templates/base)                   | 基础 E2B Dockerfile                 | 基础 Sandbox Template                 |

本仓库不包含完整的 E2B 云端控制面、调度器和虚拟化基础设施实现。根目录 README 指向独立的 `e2b-dev/infra` 仓库用于自托管。因此，阅读本仓库时应把远端服务视为已经存在的系统；这里重点研究客户端如何调用它。

## 3. 系统怎样协作

一次普通的命令执行会经过两段不同的通信：

```text
你的应用
  │
  │ ① OpenAPI/HTTP：创建 Sandbox、查询状态
  ▼
E2B 控制面 API
  │
  │ 返回 sandboxId、sandboxDomain、envdVersion、访问令牌
  ▼
SDK 中的 Sandbox 实例
  │
  │ ② Connect RPC：启动进程、接收 stdout/stderr 事件
  ▼
Sandbox 内的 envd 服务
  │
  ▼
/bin/bash -l -c '<用户命令>'
```

三条通信通道各有分工：

- 控制面 OpenAPI/HTTP：创建、连接、暂停、销毁 Sandbox，管理 Template、Snapshot、Volume 和指标；
- envd Connect RPC/Protobuf：进程、PTY、文件元数据和目录监听等结构化/流式操作；
- envd HTTP：传输文件内容以及健康检查。

对应源码入口是 [`Sandbox.create`](../../packages/js-sdk/src/sandbox/index.ts)、[`SandboxApi.createSandbox`](../../packages/js-sdk/src/sandbox/sandboxApi.ts)、[`Commands.run`](../../packages/js-sdk/src/sandbox/commands/index.ts) 和 [`process.proto`](../../spec/envd/process/process.proto)。

## 4. 最快的使用方式

### 4.1 前置条件

你需要：

- 一个 E2B 账号和 API Key；
- JavaScript 路线使用 Node.js，或 Python 路线使用 Python；
- 将密钥放入环境变量 `E2B_API_KEY`，不要写进源码或提交到 Git。

```bash
export E2B_API_KEY='e2b_***'
```

仓库开发约定将本地默认凭据放在根目录 `.env.local` 或 `~/.e2b/config.json`。`.env.local` 不会自动被所有独立脚本加载；运行自己的程序时，应使用 dotenv、shell 导出变量，或显式传入 `apiKey`。

### 4.2 JavaScript/TypeScript

在自己的项目中安装：

```bash
pnpm add e2b
```

创建 `quickstart.ts`：

```ts
import { Sandbox } from 'e2b'

const sandbox = await Sandbox.create({
  timeoutMs: 5 * 60_000,
  metadata: { purpose: 'quickstart' },
})

try {
  await sandbox.files.write('/tmp/input.txt', 'hello E2B')

  const result = await sandbox.commands.run('tr a-z A-Z < /tmp/input.txt', {
    onStdout: (chunk) => process.stdout.write(chunk),
  })

  console.log({ exitCode: result.exitCode, output: result.stdout })
} finally {
  await sandbox.kill()
}
```

运行：

```bash
pnpm dlx tsx quickstart.ts
```

这里的 `timeoutMs` 是 Sandbox 最长存活时间，单位为毫秒；`finally` 中的 `kill()` 是必要的资源清理习惯。

### 4.3 Python 同步 API

在自己的项目中安装：

```bash
uv add e2b
```

创建 `quickstart.py`：

```python
from e2b import Sandbox

with Sandbox.create(
    timeout=300,
    metadata={"purpose": "quickstart"},
) as sandbox:
    sandbox.files.write("/tmp/input.txt", "hello E2B")

    result = sandbox.commands.run(
        "tr a-z A-Z < /tmp/input.txt",
        on_stdout=lambda chunk: print(chunk, end=""),
    )

    print({"exit_code": result.exit_code, "output": result.stdout})
```

运行：

```bash
uv run python quickstart.py
```

Python 的 `timeout` 单位为秒。同步 `Sandbox` 实现了上下文管理器，离开 `with` 时会调用 `kill()`。

### 4.4 Python 异步 API

```python
import asyncio
from e2b import AsyncSandbox


async def main() -> None:
    async with await AsyncSandbox.create(timeout=300) as sandbox:
        await sandbox.files.write("/tmp/input.txt", "hello E2B")
        result = await sandbox.commands.run(
            "tr a-z A-Z < /tmp/input.txt"
        )
        print(result.stdout)


asyncio.run(main())
```

选择原则：已有 `asyncio` 服务使用 `AsyncSandbox`；简单脚本、同步 Web 框架或教学实验可使用 `Sandbox`。

## 5. 常用能力

### 5.1 后台命令和标准输入

```ts
const handle = await sandbox.commands.run('cat', {
  background: true,
  stdin: true,
  timeoutMs: 0,
  onStdout: (chunk) => process.stdout.write(chunk),
})

await handle.sendStdin('first line\n')
await handle.sendStdin('second line\n')
await handle.closeStdin()
const result = await handle.wait()
```

`background: true` 返回 `CommandHandle`。`disconnect()` 只断开事件流而不杀死进程，`kill()` 才发送 `SIGKILL`。

### 5.2 启动并暴露 HTTP 服务

```ts
const server = await sandbox.commands.run('python3 -m http.server 3000', {
  background: true,
  timeoutMs: 0,
})

const url = `https://${sandbox.getHost(3000)}`
console.log(url)

// 使用完毕后
await server.kill()
```

`getHost()` 只构造主机名，不负责启动服务。若 Sandbox 禁止公开流量，外部请求还需要相应的访问凭据。

### 5.3 生命周期：连接、暂停、快照与分叉

```ts
const id = sandbox.sandboxId

await sandbox.pause()
const resumed = await Sandbox.connect(id)

const snapshot = await resumed.createSnapshot({ name: 'prepared-workspace' })
const clonedFromDisk = await Sandbox.create(snapshot.snapshotId)

const forks = await resumed.fork({ count: 2 })
for (const fork of forks) {
  if (fork instanceof Sandbox) {
    await fork.kill()
  } else {
    console.error('one fork failed', fork)
  }
}
```

概念区别：

- `connect`：拿已有 ID 重新连接；暂停状态会恢复；
- `pause`：保存环境以便后续恢复；`keepMemory: false` 只保存文件系统；
- `createSnapshot`：创建可长期复用的持久镜像；
- `fork`：对运行中的 Sandbox 做一次内存快照，并并行创建一个或多个副本；每个副本独立成功或失败；
- `kill`：结束 Sandbox；它不是可恢复的暂停。

### 5.4 持久 Volume

```ts
import { Sandbox, Volume } from 'e2b'

const volume = await Volume.create('shared-cache')
await volume.writeFile('/seed.txt', 'persisted outside one sandbox')

const sandbox = await Sandbox.create({
  volumeMounts: {
    '/mnt/shared': volume,
  },
})

try {
  console.log((await sandbox.commands.run('cat /mnt/shared/seed.txt')).stdout)
} finally {
  await sandbox.kill()
  // 仅在确认不再需要持久数据时销毁：
  // await Volume.destroy(volume.volumeId)
}
```

Sandbox 自带文件系统跟随 Sandbox 生命周期；Volume 是单独管理、可跨 Sandbox 挂载的持久资源。

## 6. 自定义 Template

Template 相当于预构建的 Sandbox 镜像。把频繁执行的安装步骤放进 Template，可以减少每次启动后的准备时间。

### 6.1 使用 CLI 从 Dockerfile 构建

安装并登录：

```bash
pnpm add -g @e2b/cli
e2b auth login
```

准备 `e2b.Dockerfile`：

```dockerfile
FROM python:3.12
RUN pip install --no-cache-dir pytest
WORKDIR /workspace
```

构建并使用：

```bash
e2b template create python-test-env
e2b sandbox create python-test-env --detach
e2b sandbox list
```

当前 CLI 的 `template create` 会读取 `e2b.Dockerfile`，交给 SDK 的 Dockerfile 解析器转换为 Template 指令，再发起构建。旧的 `e2b template build` 已被标记为废弃。

### 6.2 使用 SDK 构建

```ts
import { Template, defaultBuildLogger, waitForTimeout } from 'e2b'

const template = Template({ fileContextPath: process.cwd() })
  .fromPythonImage('3.12')
  .copy('requirements.txt', '/app/requirements.txt')
  .runCmd('pip install -r /app/requirements.txt', { user: 'root' })
  .setWorkdir('/app')
  .setStartCmd('python -m http.server 8000', waitForTimeout(1_000))

await Template.build(template, 'python-app:v1', {
  cpuCount: 2,
  memoryMB: 1024,
  onBuildLogs: defaultBuildLogger(),
})
```

随后用 `Sandbox.create('python-app:v1')` 启动。`fileContextPath` 决定 `copy()` 的本地根目录；复制源路径必须是该目录内的相对路径。

## 7. CLI 管理速查

```bash
# 认证
e2b auth login
e2b auth info

# Sandbox
e2b sandbox create base --detach
e2b sandbox list --state running,paused
e2b sandbox info <sandbox-id> --format json
e2b sandbox exec <sandbox-id> -- pwd
printf 'hello\n' | e2b sandbox exec <sandbox-id> -- wc -c
e2b sandbox metrics <sandbox-id> --follow
e2b sandbox logs <sandbox-id> --follow
e2b sandbox pause <sandbox-id>
e2b sandbox resume <sandbox-id>
e2b sandbox kill <sandbox-id>

# Template
e2b template init
e2b template create <template-name>
e2b template list
```

API Key 与 Access Token 不应混淆：SDK 创建 Sandbox 通常用团队 API Key；CLI 的账户/团队管理流程还会使用个人 Access Token。CLI 登录信息保存在 `~/.e2b/config.json`，源码会以 `0700` 创建目录、以 `0600` 创建配置文件。

## 8. 在本仓库中开发

仓库固定使用 pnpm 和 uv。推荐版本见 [`.tool-versions`](../../.tool-versions)：Node.js 22.18.0、pnpm 9.15.5、Python 3.10、uv 0.10.0。

```bash
# 根目录安装 Node workspace 依赖
pnpm install

# Python SDK 依赖
cd packages/python-sdk
uv sync
cd ../..

# 常用检查
pnpm run format
pnpm run lint
pnpm run typecheck
pnpm run test
```

注意：完整 SDK 集成测试会创建真实云资源，需要有效凭据；JS SDK 的 `pretest` 还会安装 Playwright Chromium。修改时先运行针对性的本地单元测试，再在凭据和环境齐全时运行完整测试。

若改动协议：

```bash
make codegen
```

这会通过 Docker 从 `spec/` 重新生成 JS 与 Python 客户端。修改 `packages/cli`、`packages/js-sdk` 或 `packages/python-sdk` 时还要在根目录执行 `pnpm changeset`，并保证 JS、Python 同步和 Python 异步实现的行为一致。

## 9. 最重要的使用注意事项

1. JS 的时间参数大多是毫秒，Python 对应参数大多是秒；跨语言移植代码时必须换算。
2. Sandbox 生命周期超时、单次 API 请求超时、命令/流连接超时是不同概念，不能用一个参数替代另一个。
3. 前台 `commands.run()` 在非零退出码时抛出 `CommandExitError`/`CommandExitException`；需要读取其中的退出码和 stderr。
4. 长时间后台命令应把命令连接超时设为 `0`，并自行 `wait()`、`disconnect()` 或 `kill()`。
5. 流式文件读取必须读完或取消，否则会长期占用连接。
6. `pause({ keepMemory: false })` 只保存文件系统，恢复时会冷启动，进程和连接都会丢失。
7. `fork()` 返回逐项成功/失败的数组，不应假定每个元素都是 Sandbox。
8. 不要把 API Key、Volume token 或 Git 凭据写入仓库。Git SDK 默认不持久化 HTTP 凭据，只有显式危险选项才会这样做。
9. 运行集成测试和示例会产生真实云资源；始终使用 `finally`、上下文管理器或测试 fixture 清理。

## 10. 下一步

如果目标是使用 E2B，先实践本文件第 4～7 节；如果目标是读懂或贡献源码，继续阅读[教程导读与学习路线](tutorial/README.md)。
