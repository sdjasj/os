# 模块 3：Sandbox 生命周期与创建调用链

本模块沿着 `Sandbox.create()` 追到控制面请求，再研究连接、超时、暂停、Snapshot、Fork 和销毁。学完后，你应能准确解释每个生命周期 API 保存了什么状态。

## 1. 从公开导出开始

JS 包入口 [`src/index.ts`](../../../packages/js-sdk/src/index.ts) 同时提供命名导出和默认导出：

```ts
export { Sandbox }
import { Sandbox } from './sandbox'
export default Sandbox
```

所以两种导入都可用：

```ts
import Sandbox from 'e2b'
import { Sandbox } from 'e2b'
```

Python 则由 [`e2b/__init__.py`](../../../packages/python-sdk/e2b/__init__.py) 暴露同步 `Sandbox` 与异步 `AsyncSandbox`。

公开导出文件是兼容性边界。新增一个已实现的方法通常不需要额外导出，但新增公共类型或错误类时，要检查 JS `index.ts` 与 Python `__all__`。

## 2. JS 创建流程逐行拆解

核心实现位于 [`sandbox/index.ts`](../../../packages/js-sdk/src/sandbox/index.ts)。调用：

```ts
const sandbox = await Sandbox.create('base', {
  timeoutMs: 300_000,
  metadata: { jobId: '42' },
  envs: { MODE: 'test' },
  secure: true,
})
```

会经过以下阶段。

### 2.1 重载归一化

JS 支持两种形式：

```ts
Sandbox.create({ timeoutMs: 300_000 })
Sandbox.create('my-template', { timeoutMs: 300_000 })
```

实现根据第一个参数是不是字符串，统一得到 `template` 和 `sandboxOpts`。若未指定模板：

- 普通 Sandbox 使用 `base`；
- 配置了 MCP 时使用 `mcp-gateway`。

这种“公开重载 + 单一实现”模式使类型层对用户友好，运行时只维护一条分支。

### 2.2 构造 `ConnectionConfig`

`new ConnectionConfig(sandboxOpts)` 解析显式参数与环境变量，得到 API Key、域名、请求超时、代理、Header、Logger 和 debug 状态。

如果 `debug` 为真，代码跳过控制面创建，直接用固定 `debug_sandbox_id` 和兼容 envd 版本构造本地代理对象。这是本地 envd 联调入口，不表示真实云资源已创建。

### 2.3 `SandboxApi.createSandbox()`

高层类调用父层的受保护静态方法：

```text
Sandbox.create
  → SandboxApi.createSandbox
    → new ApiClient(config)
    → POST /sandboxes
```

[`createSandbox`](../../../packages/js-sdk/src/sandbox/sandboxApi.ts) 把 SDK 风格字段转换为 OpenAPI 请求体。例如：

| SDK                   | 请求体                  |
| --------------------- | ----------------------- |
| `template`            | `templateID`            |
| `envs`                | `envVars`               |
| `timeoutMs`           | `timeout`，并转换为秒   |
| `secure`              | `secure`                |
| `allowInternetAccess` | `allow_internet_access` |
| `volumeMounts`        | `[{ name, path }]`      |
| 生命周期 pause        | `autoPause: true`       |
| `autoResume`          | `{ enabled: boolean }`  |

这一层的价值是隔离命名和兼容性：公开 JS API 保持 camelCase 和毫秒，服务端协议可以有历史命名并使用秒。

### 2.4 生命周期参数校验

`onTimeout` 支持简写与对象形式：

```ts
lifecycle: { onTimeout: 'kill' }
lifecycle: { onTimeout: 'pause', autoResume: true }
lifecycle: { onTimeout: { action: 'pause', keepMemory: false } }
```

类型系统禁止 `{ action: 'kill', keepMemory: ... }`，运行时仍再次校验，因为 JavaScript 用户、`any` 或网络输入可以绕过 TypeScript。

代码还拒绝：

- `autoResume: true` 但 action 不是 pause；
- `keepMemory: false` 与 `autoResume: true` 同时出现。

这是一个值得复用的设计原则：类型错误和运行时错误分别服务于不同调用者，二者不是重复劳动。

### 2.5 响应与 envd 版本门槛

服务端返回至少包含：

- `sandboxID`；
- `domain`；
- `envdVersion`；
- `envdAccessToken`；
- 可选 `trafficAccessToken`。

若 envd 版本小于最低兼容版本，SDK 会先 kill 刚创建的资源，再抛 `TemplateError`，避免把不可用 Sandbox 泄漏在账户中。

### 2.6 构造高层实例

`new this({ ...sandboxInfo, ...config })` 进入 `Sandbox` 构造函数。它完成：

1. 保存 ID、域名、Token；
2. 计算稳定 envd URL 与直连 URL；
3. 准备通用 Sandbox Header；
4. 创建 Connect RPC transport；
5. 创建 envd HTTP client；
6. 注入并暴露 `Filesystem`、`Commands`、`Pty`、`Git`。

这里使用 `new this` 而非写死 `new Sandbox`，让继承 `Sandbox` 的包装 SDK 能得到自己的子类实例。

### 2.7 MCP 的额外启动步骤

若 `mcp` 存在，创建基础 Sandbox 后 SDK 生成随机 Token，并以 root 用户运行 `mcp-gateway`。因此 MCP 创建不是单个原子控制面请求；控制面创建成功后，网关命令仍可能失败。

阅读这段代码时应意识到一个潜在的资源管理责任：调用方若捕获 MCP 启动错误，需要确认失败路径是否已清理 Sandbox。设计新功能时，跨多个远端步骤要专门考虑部分成功。

## 3. Python 创建流程的等价性

同步入口在 [`sandbox_sync/main.py`](../../../packages/python-sdk/e2b/sandbox_sync/main.py)，异步入口在 [`sandbox_async/main.py`](../../../packages/python-sdk/e2b/sandbox_async/main.py)。逻辑与 JS 对齐：

```python
sandbox = Sandbox.create(
    template="base",
    timeout=300,
    metadata={"job_id": "42"},
    envs={"MODE": "test"},
)
```

差异：

- Python `timeout` 是秒，JS `timeoutMs` 是毫秒；
- Python 通过 `SandboxVolumeMountAPI` 模型转换挂载；
- Python 同步使用 `httpx.Client`，异步使用 `httpx.AsyncClient`；
- Python MCP 命令用 `shlex.quote(json.dumps(mcp))`，JS 用 `shellQuote()`；
- 异步的所有 I/O 都必须 `await`。

跨语言实现同一功能时，对齐的是行为和协议字段，不是照抄参数名字。

## 4. URL 怎样生成

[`ConnectionConfig.getHost()`](../../../packages/js-sdk/src/connectionConfig.ts) 构造：

```text
<port>-<sandboxId>.<sandboxDomain>
```

例如端口 3000 的用户服务与 envd 49983 使用同一个 Sandbox ID、不同端口前缀。

envd 有两个 URL 概念：

- 稳定 API URL：在支持的生产域名和 Node 环境中可以使用 `https://sandbox.<domain>`，请求通过 Header 指定 Sandbox ID/端口；
- direct URL：始终使用端口与 Sandbox ID 组成的主机名，文件上传下载 URL 使用它。

自定义服务只需：

```ts
await sandbox.commands.run('python3 -m http.server 8000', {
  background: true,
  timeoutMs: 0,
})

console.log(`https://${sandbox.getHost(8000)}`)
```

如果请求失败，按顺序检查：进程是否仍运行、是否监听 `0.0.0.0` 而非仅 localhost、端口是否正确、公开流量配置是否允许。

## 5. Connect 与 Resume

`Sandbox.connect(id)` 对控制面调用 `POST /sandboxes/{sandboxID}/connect`。它的语义是：

- 若 Sandbox 正在运行，返回连接信息；
- 若已暂停，恢复后返回连接信息；
- 可提供 timeout，运行中只在新 timeout 更长时更新；
- 返回一个新的本地 `Sandbox` 代理实例。

实例方法 `sandbox.connect()` 复用已有对象：它只请求控制面连接/恢复，然后返回 `this`。

适用场景：

- 在数据库中只保存 `sandboxId`，后续请求重新连接；
- 一个进程创建 Sandbox，另一个 worker 继续操作；
- 暂停以节省运行资源，收到任务后恢复。

不要把 `connect()` 理解为 TCP 连接句柄。每个 `commands`/`files` 操作仍会建立自己的请求或流。

## 6. Timeout、Pause 与 Kill

### 6.1 Sandbox timeout

创建时 `timeoutMs`（JS）或 `timeout`（Python）表示 Sandbox 生命周期计时。`setTimeout`/`set_timeout` 可以延长或缩短。到时执行 `lifecycle.onTimeout`：默认 kill，也可 pause。

### 6.2 Pause

```ts
await sandbox.pause() // 默认保留内存
await sandbox.pause({ keepMemory: false }) // 只保留文件系统
```

返回 `false` 表示已经暂停，而不是失败。保留内存时可恢复进程状态；文件系统模式恢复时冷启动。

### 6.3 Kill

```ts
const killed = await sandbox.kill()
```

返回 `false` 表示资源找不到。Kill 后不能通过 connect 恢复；若要保留数据，应提前 Snapshot 或写入 Volume。

### 6.4 可靠清理

JS：

```ts
const sandbox = await Sandbox.create()
try {
  // work
} finally {
  await sandbox.kill()
}
```

Python：

```python
with Sandbox.create() as sandbox:
    # work
    pass
```

异步 Python：

```python
async with await AsyncSandbox.create() as sandbox:
    # work
    pass
```

注意：Pause 是业务状态转换，不是清理替代品。测试若只 pause，会留下可恢复资源。

## 7. Snapshot

创建：

```ts
await sandbox.files.write('/workspace/state.json', '{"ready":true}')
const snapshot = await sandbox.createSnapshot({ name: 'prepared' })
```

响应：

```ts
type SnapshotInfo = {
  snapshotId: string
  names: string[]
}
```

使用：

```ts
const restored = await Sandbox.create(snapshot.snapshotId)
```

列表使用分页器：

```ts
const paginator = Sandbox.listSnapshots({ name: 'prepared', limit: 50 })
while (paginator.hasNext) {
  const page = await paginator.nextItems()
  console.log(page)
}
```

实例的 `listSnapshots()` 自动加入源 `sandboxId` 过滤。删除 Snapshot 在底层复用模板删除端点，因为服务端把 Snapshot 表示为可启动的模板资源。

## 8. Fork

Fork 对运行中的源 Sandbox 做一次完整内存快照，然后从同一快照启动 `count` 个副本：

```ts
const results = await sandbox.fork({ count: 3, timeoutMs: 120_000 })

for (const result of results) {
  if (result instanceof Sandbox) {
    console.log('fork:', result.sandboxId)
  } else {
    console.error('failed:', result)
  }
}
```

两个层级的失败必须区分：

- 整个 HTTP 请求失败：方法直接抛异常，例如源 Sandbox 不存在；
- 某个副本启动失败：数组相应元素是 `Error`，其他副本仍可能成功。

这类似 `Promise.allSettled`。代码将每项错误码映射为 SDK 错误类型，404 对某个 Fork 表示依赖资源缺失，不应误报成“源 Sandbox 不存在”。

Python 对应返回 `List[Union[Sandbox, Exception]]`，也必须逐项检查。

## 9. List 与 Paginator

`Sandbox.list()` 不直接返回数组，而返回 [`SandboxPaginator`](../../../packages/js-sdk/src/sandbox/sandboxApi.ts)：

```ts
const paginator = Sandbox.list({
  query: {
    state: ['running', 'paused'],
    metadata: { jobId: '42' },
  },
  limit: 100,
})

while (paginator.hasNext) {
  const items = await paginator.nextItems()
  for (const info of items) {
    console.log(info.sandboxId, info.state)
  }
}
```

分页器从响应 Header 更新 `nextToken`。调用者设置的 `limit` 是每页上限，不一定是最终总数上限；CLI 自己额外实现总数截断。

不指定 state 时 SDK 默认获得 running 与 paused；CLI `sandbox list` 为了命令行体验，默认只传 running。SDK 默认与 CLI 默认不同，应从各自入口确认。

## 10. Network 配置

创建时可以限制出站流量并注入 Header：

```ts
const sandbox = await Sandbox.create({
  network: {
    rules: {
      'api.example.com': [
        {
          transform: {
            headers: { Authorization: 'Bearer injected-at-egress' },
          },
        },
      ],
    },
    allowOut: ({ rules }) => [...rules.keys()],
    allowPublicTraffic: false,
  },
})
```

关键点：出站 `rules` 只描述转换，不自动允许该主机；它仍需出现在 `allowOut` 中。回调形式拿到 `allTraffic` 和 rules 的 Map，SDK 在发请求前把函数解析为普通数组。

运行中 `updateNetwork()` 是原子替换，不是 patch：省略的出站字段会被服务端清空。调用者必须传入希望保留的完整配置。

安全建议：把外部 API 密钥通过 egress Header 注入，优于直接把密钥放进 Sandbox 环境变量，因为 Sandbox 内代码不必看到原始值。但仍应限制目标域名，并确认服务端转换行为符合威胁模型。

## 11. 信息与指标

`getInfo()` 返回控制面元数据，包括模板、状态、资源配置、生命周期、网络和挂载；`getMetrics()` 返回按时间采样的 CPU、内存和磁盘指标。

SDK 在读取指标前检查 envd 版本：太旧则抛模板升级错误，某些版本仅警告磁盘指标不支持。这说明“SDK 版本新”不代表已有 Template 内的 envd 自动变新；需要重建 Template 才能获得新 envd 能力。

## 12. 调试一条失败的创建请求

按以下顺序缩小范围：

1. `ConnectionConfig` 是否取得 API Key，格式验证是否通过；
2. `template` 名称/ID 是否正确；
3. 生命周期组合是否在客户端就被拒绝；
4. 控制面 HTTP 状态是否映射为 `AuthenticationError`、`RateLimitError` 等；
5. 是否创建成功但 envd 版本太旧；
6. 是否是 MCP 启动等创建后的附加步骤失败；
7. 失败后是否留下需手动 kill 的 Sandbox。

可传 Logger 观察请求/响应，但日志中仍不应记录敏感 Token。

## 13. 本模块练习

1. 写一个 JS 脚本：创建 Sandbox，写入文件，pause，按 ID connect，读取文件，最后 kill。
2. 分别用 `keepMemory: true/false` 启动后台 `sleep`，暂停恢复后比较进程是否存在。
3. 创建两个 Fork，安全处理逐项错误，并确保所有成功副本被清理。
4. 给 Sandbox 加 metadata，用 `Sandbox.list()` 的分页器过滤出来。
5. 对照 Python sync/async 创建 API，列出所有时间参数的单位。

下一步阅读[模块 4：命令、事件流与 PTY](04-commands-streaming-pty.md)。
