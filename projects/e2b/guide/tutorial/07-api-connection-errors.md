# 模块 7：API、连接配置、超时与错误

E2B SDK 的公共方法很简洁，但其可靠性主要来自连接层：配置优先级、鉴权 Header、代理、取消、长流清理、错误映射和 envd 版本兼容。本模块集中解释这些横切逻辑。

## 1. `ConnectionConfig` 是什么

[`ConnectionConfig`](../../../packages/js-sdk/src/connectionConfig.ts) 把分散的用户选项和环境变量解析为不可变的连接配置。主要字段：

- `apiKey`、`accessToken`、`apiHeaders`；
- `domain`、`apiUrl`、`sandboxUrl`；
- `debug`；
- `requestTimeoutMs`；
- `logger`；
- `proxy`；
- `User-Agent`。

典型使用：

```ts
const sandbox = await Sandbox.create({
  apiKey: process.env.MY_E2B_KEY,
  domain: 'e2b.app',
  requestTimeoutMs: 30_000,
  proxy: 'http://127.0.0.1:8080',
  logger: console,
})
```

显式参数通常优先于环境变量，未传时再读 `E2B_*`。类的静态 getter 在构造时读取环境，不是模块加载时把所有值永久缓存。

## 2. API Key 校验与鉴权 Header

[`ApiClient`](../../../packages/js-sdk/src/api/index.ts) 默认要求 API Key，并用正则检查：

```text
e2b_ + 十六进制字符
```

不符合格式时在发网络请求前抛 `AuthenticationError`。自托管部署若使用不同格式，可显式 `validateApiKey: false` 或设置 `E2B_VALIDATE_API_KEY=false`。

控制面 Header：

```text
X-API-KEY: <apiKey>
Authorization: Bearer <accessToken>   # 账户/团队类调用
User-Agent: e2b-js-sdk/<version> ...
```

CLI 查询团队时构造 `ApiClient(..., { requireApiKey: false })`，因为该端点用 Access Token。普通 Sandbox 管理则要求 API Key。

`headers` 已废弃，`apiHeaders` 是新的扩展入口。自定义 Header 最后合并，使用时要避免覆盖 SDK 必需的鉴权 Header，除非明确知道用途。

## 3. envd 鉴权与用户身份

Sandbox 构造时，控制面返回的 `envdAccessToken` 被加到 envd HTTP 和 RPC fetch：

```text
X-Access-Token: <sandbox-scoped-token>
E2b-Sandbox-Id: <sandboxId>
E2b-Sandbox-Port: 49983
```

进程/文件操作的 `user` 另外编码为 Basic Auth：

```text
Authorization: Basic base64("username:")
```

这不是 API 密码认证，而是 envd 协议用 Header 传递目标 Linux 用户的方式。旧 envd 没有“模板默认用户”能力时，SDK 自动回退 `user`。

## 4. OpenAPI 客户端怎样工作

JS 使用 `openapi-fetch` 和生成的 [`schema.gen.ts`](../../../packages/js-sdk/src/api/schema.gen.ts)：

```ts
const res = await client.api.POST('/sandboxes', {
  body,
  signal,
})
```

路径字符串、body 与响应都受 `paths` 类型约束。`ApiClient` 统一设置 base URL、fetch、Header、数组 query 序列化和 logger middleware。

Python 的 `e2b/api/client` 由 OpenAPI 生成，但高层 sync/async `SandboxApi` 会把生成模型映射成 SDK dataclass/TypedDict，避免用户直接依赖生成器的命名细节。

## 5. Connect RPC 客户端怎样工作

JS 在 `Sandbox` 构造器中创建 Connect transport，然后 `Commands`、`Filesystem`、`Pty` 各用生成 Service 描述创建 typed client。

```text
*.proto
  → *_pb.ts / *_connect.ts
  → createConnectTransport
  → createClient(ProcessService, transport)
  → rpc.start()/rpc.stat()/...
```

RPC 的状态码不同于 HTTP：例如 `Code.NotFound`、`Code.Unavailable`、`Code.Canceled`、`Code.DeadlineExceeded`。[`envd/rpc.ts`](../../../packages/js-sdk/src/envd/rpc.ts) 负责映射为公共 SDK 错误。

## 6. 四类时间限制

这是最容易出错的知识点。

### 6.1 Sandbox 生命周期 timeout

```ts
Sandbox.create({ timeoutMs: 300_000 })
```

限制云资源存活时间。到期执行 kill 或 pause。Python 对应 `timeout=300` 秒。

### 6.2 普通 API request timeout

```ts
Sandbox.create({ requestTimeoutMs: 60_000 })
```

限制一个普通 HTTP/RPC 请求等待时间。它不是 Sandbox 生命周期，也不是远端命令运行时间。

### 6.3 长连接/命令 timeout

```ts
sandbox.commands.run('job', { timeoutMs: 0 })
```

限制 command、PTY、watch 等长连接总时长。0 表示禁用该限制。Python 使用 `timeout=0`。

### 6.4 Stream idle timeout

```ts
sandbox.files.read(path, {
  format: 'stream',
  streamIdleTimeoutMs: 30_000,
})
```

握手后只限制“正在等服务端下一块数据”的空闲时间，不限制消费者处理上一块所花时间。

### 6.5 对照表

| 目标                | JS                    | Python                | 典型单位           |
| ------------------- | --------------------- | --------------------- | ------------------ |
| Sandbox 生命周期    | `timeoutMs`           | `timeout`             | JS 毫秒，Python 秒 |
| API 请求            | `requestTimeoutMs`    | `request_timeout`     | JS 毫秒，Python 秒 |
| 命令/watch/PTY 连接 | `timeoutMs`           | `timeout`             | JS 毫秒，Python 秒 |
| 文件流 idle         | `streamIdleTimeoutMs` | `stream_idle_timeout` | JS 毫秒，Python 秒 |

迁移代码时不要只做 snake_case/camelCase 替换，必须换算时间。

## 7. AbortSignal 的组合

普通请求使用 [`buildRequestSignal`](../../../packages/js-sdk/src/connectionConfig.ts)：

```ts
const signal = AbortSignal.any([
  AbortSignal.timeout(requestTimeoutMs),
  userSignal,
])
```

如果 timeout 为 0 或 undefined，则不创建 timeout signal。用户取消与 SDK timeout 谁先发生，谁终止 fetch。

调用示例：

```ts
const controller = new AbortController()

const work = Sandbox.create({
  signal: controller.signal,
  requestTimeoutMs: 60_000,
})

controller.abort(new Error('request canceled by caller'))
await work
```

取消是协作式的：它终止当前客户端请求，但已经到达服务端并完成的资源创建可能仍发生。对有副作用的操作，取消后应通过业务幂等键、列表查询或资源 ID 进行补偿确认。

## 8. 长流为何需要独立 Controller

命令或文件流不能让 60 秒请求 timer 覆盖整个消费过程。`setupRequestController()` 分两阶段：

```text
阶段 1：等待握手
  request timeout 开启

收到 start/HTTP response
  clearStartTimeout()

阶段 2：消费长流
  用户 AbortSignal 仍有效
  文件流可启用 idle timeout

结束/取消/错误
  cleanup() 移除监听并 abort 底层连接
```

`cleanup()` 幂等，因为结束、错误、cancel 和 finally 可能竞争调用它。设计资源清理函数时，幂等能显著降低多分支泄漏和重复关闭问题。

## 9. HTTP 错误映射

控制面 [`handleApiError`](../../../packages/js-sdk/src/api/index.ts) 首先检查 `response.ok`，而不是只检查 `response.error`。原因是 `openapi-fetch` 遇到非 2xx 且空 body 时，`error` 可能是 undefined。

核心映射：

| HTTP | 错误                                |
| ---- | ----------------------------------- |
| 401  | `AuthenticationError`               |
| 429  | `RateLimitError`                    |
| 其他 | 调用方指定的错误类或 `SandboxError` |

envd HTTP 有更细映射：400 invalid argument、404 not found、429 rate limit、502 Sandbox timeout、507 disk space。

特定调用还覆写 404：文件 API 映射 `FileNotFoundError`，Sandbox info 映射 `SandboxNotFoundError`，Volume 映射 `NotFoundError`。同一个 HTTP 状态需要调用上下文才能成为最有用的公共错误。

## 10. RPC 错误映射

[`handleRpcError`](../../../packages/js-sdk/src/envd/rpc.ts)：

| Connect Code        | SDK 错误与含义                                    |
| ------------------- | ------------------------------------------------- |
| `InvalidArgument`   | `InvalidArgumentError`                            |
| `Unauthenticated`   | `AuthenticationError`                             |
| `NotFound`          | `NotFoundError`，文件可覆写为 `FileNotFoundError` |
| `ResourceExhausted` | `RateLimitError`                                  |
| `Unavailable`       | 带 Sandbox timeout 提示的 `TimeoutError`          |
| `Canceled`          | request timeout/abort 相关 `TimeoutError`         |
| `DeadlineExceeded`  | 长连接 `timeoutMs` 相关 `TimeoutError`            |

错误文案有意指出应该修改哪个参数。一个只写“timeout”的错误会让用户不断延长错误的 timeout。

## 11. 连接中途断开与健康探测

Sandbox 在请求进行中被 kill，Node、Bun、Deno 会给出不同底层文案。代码识别已知“连接中断”片段，然后调用 envd `/health`：

- health 确认 Sandbox 不在：转换为 `TimeoutError`，说明生命周期结束；
- health 仍在或无法确认：保留原传输错误，避免把临时负载均衡故障误报成 Sandbox 已死。

这是一种谨慎的诊断增强：只有补充证据确认时才改变错误语义。

健康检查本身只等待 5 秒，并吞掉自身失败返回 unknown，避免错误处理再次长时间阻塞或覆盖原始错误。

## 12. 错误层级与调用方策略

```ts
try {
  await sandbox.commands.run('task')
} catch (error) {
  if (error instanceof CommandExitError) {
    // 业务命令失败：通常不应自动按网络故障重试
  } else if (error instanceof RateLimitError) {
    // 带退避和抖动重试
  } else if (error instanceof AuthenticationError) {
    // 修复凭据，不要重试风暴
  } else if (error instanceof TimeoutError) {
    // 先判断是哪类 timeout，再决定 reconnect/recreate
  } else {
    throw error
  }
}
```

重试应考虑幂等性：

- GET/list/info 通常可安全重试；
- kill 对不存在返回 false，天然接近幂等；
- create/template build 可能已产生资源，盲目重试会重复创建；
- write 覆盖文件可重复，但追加语义的 shell 命令不可随意重复。

## 13. 代理与多运行时

`proxy` 会传给控制面 fetch 和返回 Sandbox 的 envd 请求。Volume 创建后也把 proxy 保存在实例上，让内容 API 继续复用；单次 Volume 调用可覆盖实例 proxy。

JS SDK 支持 Node、Bun、Deno、浏览器，因此代码包含多运行时差异：

- base64 编码方式；
- fetch/HTTP2/undici；
- 浏览器不能使用本地文件系统做 Template copy；
- 浏览器流式 request body 限制；
- dropped connection 错误文案。

新增底层能力不能只在 Node 测通。仓库有 `tests/runtimes/browser`、`bun`、`deno` 专门验证入口。

## 14. User-Agent 与集成标识

`ConnectionConfig.setIntegration('wrapper/version')` 会把包装层标识追加到 SDK User-Agent。例如 CLI 在创建任何配置前设置 `e2b-cli/<version>`。

这样服务端可区分直接 SDK 与上层集成，同时保留 SDK 版本。显式传入非 SDK 格式的 User-Agent 会优先；从旧 config 展开过来的 SDK User-Agent 会被重新构建，避免丢失最新 integration。

## 15. envd 版本兼容

SDK 与 Sandbox 内 envd 分别发布，因此会出现“新 SDK 连接旧 Template”。[`envd/versions.ts`](../../../packages/js-sdk/src/envd/versions.ts) 集中定义功能门槛，例如：

- 默认用户；
- 命令 stdin/close stdin；
- 文件 metadata；
- 递归 watch；
- 网络挂载 watch；
- octet-stream upload。

兼容策略有三种：

1. 旧版本可等价回退：自动使用旧行为；
2. 功能可降级：警告或切换 multipart；
3. 无法正确实现：抛 `TemplateError` 要求重建。

新增 envd 功能时，JS、Python sync、Python async 必须使用同一语义门槛。

## 16. 日志与敏感信息

传 `logger` 可记录请求/响应，便于调试。但日志设计必须默认避开：

- `X-API-KEY`；
- Bearer Token；
- envd/traffic Token；
- Volume token；
- 带 Git 凭据的 URL；
- 文件签名 URL。

调试代理同样能看到流量，只应使用受信代理。凭据一旦进入日志，短期 Sandbox 隔离也无法撤回已泄露的长期 Token。

## 17. 本模块练习

1. 用一个短 `requestTimeoutMs` 和长命令 `timeoutMs`，观察哪个阶段失败；再反过来。
2. 对文件 stream 使用用户 AbortController，读到一定字节后 abort，确认连接释放。
3. 阅读一个 404 在 Sandbox、文件和 Volume 三个调用点的不同映射。
4. 模拟空 body 的 500 响应，解释为什么必须检查 HTTP status。
5. 选择一个 envd 版本门槛，追踪 JS、Python sync、Python async 的检查位置。

下一步阅读[模块 8：Python 同步/异步双实现](08-python-sync-async.md)。
