# 模块 5：文件系统、Git 与 Volume

本模块把三类看似相近的能力放在一起：Sandbox 临时文件系统、基于命令实现的 Git 高层 API，以及独立持久化的 Volume。重点是分清协议、生命周期和安全边界。

## 1. 文件操作为什么拆成 HTTP 与 RPC

[`Filesystem`](../../../packages/js-sdk/src/sandbox/filesystem/index.ts) 内部同时持有：

- `rpc`：`stat`、`listDir`、`makeDir`、`move`、`remove`、`watchDir`；
- `envdApi`：`GET /files`、写文件内容。

文件元数据很小且结构稳定，适合 Protobuf；文件内容可能从 0 字节到数 GB，适合 HTTP body 和 `ReadableStream`。同一个公开对象把两种协议隐藏起来。

## 2. 路径与 Linux 用户

相对路径会按操作用户的 home 目录解析。仓库测试验证默认相对文件 `test.txt` 最终位于 `/home/user/test.txt`。

```ts
await sandbox.files.write('a.txt', 'A')
await sandbox.files.write('/tmp/b.txt', 'B')
```

`user` 影响：

- 相对路径的基准目录；
- 新文件/目录的所有者；
- 操作权限。

```ts
await sandbox.files.write('/root/private.txt', 'secret', { user: 'root' })
```

不要把 `user: 'root'` 当作解决权限错误的默认方案。它扩大 Sandbox 内代码权限，也可能造成后续默认用户无法读写的文件。

## 3. 读文件的四种格式

```ts
const text = await sandbox.files.read('/tmp/a.txt')
const bytes = await sandbox.files.read('/tmp/a.bin', { format: 'bytes' })
const blob = await sandbox.files.read('/tmp/a.bin', { format: 'blob' })
const stream = await sandbox.files.read('/tmp/large.bin', {
  format: 'stream',
  streamIdleTimeoutMs: 60_000,
})
```

TypeScript 重载使 `format` 决定返回类型。空文件是一个特别边界：OpenAPI fetch 可能把 0 长度 body 表示为 `undefined`，SDK 主动合成 `''`、空 `Uint8Array` 或空 `Blob`。

### 3.1 流式读取的连接责任

流式读取时，`requestTimeoutMs` 只限制初始响应握手。成功后：

- 用户 AbortSignal 仍可取消整个流；
- `streamIdleTimeoutMs` 限制等待下一个网络块的空闲时间；
- 读完、取消、错误或 idle timeout 都会释放连接。

正确消费：

```ts
const stream = await sandbox.files.read('/tmp/large.bin', {
  format: 'stream',
})

try {
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    // process chunk
  }
} catch (error) {
  // handle stream failure
}
```

若拿到流后不读也不 cancel，连接可能保持占用。SDK 只能管理自己能观察到的生命周期，消费者也必须履行资源关闭责任。

## 4. 写文件：单个、批量与流

```ts
await sandbox.files.write('/tmp/message.txt', 'hello')

await sandbox.files.write([
  { path: '/tmp/a.txt', data: 'A' },
  { path: '/tmp/b.txt', data: 'B' },
])
```

数据可为 `string | ArrayBuffer | Blob | ReadableStream`。写不存在路径时会创建必要目录，写已有文件会覆盖。

### 4.1 multipart 与 octet-stream

SDK 根据运行时、envd 版本和输入选择：

- 普通小数据：`multipart/form-data`；
- 非浏览器 `ReadableStream`：优先 `application/octet-stream`，避免先把全部内容缓冲进内存；
- `gzip: true`：使用 octet-stream 并压缩；
- 老 envd 不支持时：回退到 multipart。

浏览器 fetch 对流式请求 body 的限制不同，所以浏览器保持 multipart 路径。`duplex: 'half'` 是 Node 流式请求所需选项。

### 4.2 文件 metadata

写入时可设置用户 metadata，它被存为 Linux `user.e2b.*` 扩展属性：

```ts
await sandbox.files.write('/tmp/report.csv', '...', {
  metadata: { source: 'agent', run_id: '42' },
})
```

metadata 通过 `X-Metadata-*` Header 传输，因此 key 必须符合 HTTP token，value 必须为可打印 ASCII。代码在发请求前校验并抛 `InvalidArgumentError`。服务端会把 key 转小写，读回时大小写可能变化。

## 5. 文件元数据与目录操作

```ts
const created = await sandbox.files.makeDir('/workspace/src')
const exists = await sandbox.files.exists('/workspace/src')
const info = await sandbox.files.getInfo('/workspace/src')
const entries = await sandbox.files.list('/workspace', { depth: 2 })
await sandbox.files.rename('/workspace/src', '/workspace/lib')
await sandbox.files.remove('/workspace/lib')
```

`EntryInfo` 包含类型、大小、mode、权限字符串、owner、group、修改时间、符号链接目标和 metadata。

`exists()` 专门把 RPC NotFound 转成 `false`，其他错误继续抛出。这与 `getInfo()` 的契约不同；不要用 catch 所有错误后返回 false，否则会把权限、网络和 Sandbox 失效误报为“不存在”。

## 6. 目录监听

```ts
const handle = await sandbox.files.watchDir(
  '/workspace',
  (event) => {
    console.log(event.type, event.name, event.entry)
  },
  {
    recursive: true,
    includeEntry: true,
    timeoutMs: 0,
  }
)

// 不再监听时
await handle.stop()
```

[`filesystem.proto`](../../../spec/envd/filesystem/filesystem.proto) 的事件类型包括 create、write、remove、rename、chmod。`includeEntry` 是 best-effort：删除或 rename-away 后路径已经不存在，event.entry 可为空。

SDK 根据 envd 版本检查：递归监听、entry info、网络挂载监听。模板里的 envd 太旧时抛 `TemplateError`，解决办法是重建 Template，而不是升级本地 npm 包就结束。

网络文件系统的 watch 事件可能不可靠，所以 `allowNetworkMounts` 默认 false。需要它时，业务还应有轮询或最终一致性补偿。

## 7. 文件上传/下载 URL 与签名

`sandbox.uploadUrl()` 和 `downloadUrl()` 适合让第三方直接向 Sandbox 传文件，避免内容经过你的应用服务器。

```ts
const url = await sandbox.downloadUrl('/tmp/report.csv', {
  useSignatureExpiration: 300,
})
```

安全 Sandbox 有 `envdAccessToken`，SDK 用 [`getSignature`](../../../packages/js-sdk/src/sandbox/signature.ts) 为 path、operation、user 和过期时间签名，把结果放入 URL query。

签名 URL 是 bearer capability：拿到 URL 的人可在有效期内执行特定操作。应使用短有效期、HTTPS，避免写入日志或分析系统。

## 8. Git 模块的设计：高层语义 + Commands

[`Git`](../../../packages/js-sdk/src/sandbox/git/index.ts) 没有新增远端协议，而是组合 `Commands` 运行 Sandbox 内的 `git` CLI。

好处：

- 复用成熟 Git 行为；
- 不需要 envd 专门实现 Git RPC；
- 与 Template 中安装的 Git 版本一致。

代价：

- 必须安全引用 shell 参数；
- 需要解析 Git 文本输出；
- 不同 Git 版本和 locale 可能影响输出；
- 认证失败要从 stderr 识别。

辅助代码 [`git/utils.ts`](../../../packages/js-sdk/src/sandbox/git/utils.ts) 负责 `shellQuote`、构建命令、解析 porcelain status、分支、认证错误和 upstream 错误。

## 9. Git 常见操作

```ts
await sandbox.git.clone('https://github.com/org/repo.git', {
  path: '/workspace/repo',
  branch: 'main',
  depth: 1,
})

const status = await sandbox.git.status('/workspace/repo')
console.log(status.currentBranch, status.fileStatus)

await sandbox.git.add('/workspace/repo', { files: ['README.md'] })
await sandbox.git.commit('/workspace/repo', 'update readme', {
  authorName: 'Agent',
  authorEmail: 'agent@example.com',
})
```

具体签名应以 `Git` 类型为准；建议从测试学习边界：[`tests/sandbox/git`](../../../packages/js-sdk/tests/sandbox/git)。这些测试会在 Sandbox 内创建仓库和 git daemon，覆盖真实命令行为。

## 10. Git 凭据安全

HTTP(S) clone/push/pull 可以临时把 username/password 注入 URL。工具函数会：

- 只允许 HTTP/HTTPS 做这种注入；
- 命令执行后从可见 URL 中剥离凭据；
- 默认设置 `GIT_TERMINAL_PROMPT=0`，避免后台永远等交互式密码；
- 把已知 stderr 映射为 `GitAuthError`。

`dangerouslyStoreCredentials` 或危险认证方法顾名思义会持久化凭据，只应在隔离、短寿命、无不可信代码的 Sandbox 中使用。更安全的方案是短期 Token，并尽快销毁 Sandbox。

切勿把凭据作为命令字符串写入会被日志、进程列表或 shell history 捕获的位置。

## 11. Volume 的两层 API

Volume 同样分控制面与内容面：

```text
Volume.create/list/getInfo/destroy
  → 主控制面 API，使用 E2B API Key

volume.readFile/writeFile/list/makeDir/...
  → Volume Content API，使用 volume token
```

`Volume.create()` 返回包含 `volumeId`、`name`、`token` 的本地对象。Token 是内容 API 的凭据，不能公开。

```ts
const volume = await Volume.create('agent-cache')
try {
  await volume.makeDir('/packages', { force: true })
  await volume.writeFile('/packages/index.txt', 'cached')
  console.log(await volume.readFile('/packages/index.txt'))
} finally {
  await Volume.destroy(volume.volumeId)
}
```

与 Sandbox Filesystem 的命名差异：Volume 使用 `readFile/writeFile`，并提供 uid/gid/mode/force 等持久存储元数据选项。

## 12. Volume 与 Sandbox 挂载

```ts
const volume = await Volume.create('shared')
const first = await Sandbox.create({
  volumeMounts: { '/mnt/shared': volume },
})

await first.commands.run('echo from-first > /mnt/shared/data.txt')
await first.kill()

const second = await Sandbox.create({
  volumeMounts: { '/mnt/shared': 'shared' },
})

console.log((await second.commands.run('cat /mnt/shared/data.txt')).stdout)
```

挂载值可以是 `Volume` 实例或名称。SDK 最终只把 `name` 和 mount path 发给创建 API，不把 Volume token 放进 Sandbox 创建 body。

注意并发语义：多个 Sandbox 同时写同一路径时，SDK 不提供事务或锁。业务需要通过不同路径、文件锁、原子 rename 或外部协调避免覆盖。

## 13. 两种文件 API 的差异

| 维度       | `sandbox.files`           | `Volume` 内容 API            |
| ---------- | ------------------------- | ---------------------------- |
| 生命周期   | 跟随 Sandbox              | 独立持久                     |
| 相对路径   | 按 Sandbox 用户 home      | Volume 根路径语义            |
| 鉴权       | envd Token/签名           | Volume token                 |
| metadata   | `user.e2b.*` xattr 字符串 | uid/gid/mode                 |
| watch      | 支持                      | 当前高层 API 不提供          |
| 多文件写   | 支持                      | 当前以单文件 API 为主        |
| 挂载后访问 | Sandbox 内普通文件路径    | 可通过 Volume API 或挂载路径 |

不要因为两者都能 `read/write` 就把它们当成可互换对象。

## 14. Python 对应接口

```python
from e2b import Sandbox, Volume

volume = Volume.create("shared")
try:
    volume.write_file("/seed.txt", "hello")
    with Sandbox.create(volume_mounts={"/mnt/shared": volume}) as sandbox:
        print(sandbox.files.read("/mnt/shared/seed.txt"))
finally:
    Volume.destroy(volume.volume_id)
```

异步版本使用 `AsyncVolume` 和 `AsyncSandbox`，所有 I/O `await`。修改 Volume 功能时需要同步维护 [`volume_sync.py`](../../../packages/python-sdk/e2b/volume/volume_sync.py) 与 [`volume_async.py`](../../../packages/python-sdk/e2b/volume/volume_async.py)。

## 15. 测试如何证明行为

- [`files/write.test.ts`](../../../packages/js-sdk/tests/sandbox/files/write.test.ts)：单文件、批量、覆盖、自动创建父目录；
- [`files/watch.test.ts`](../../../packages/js-sdk/tests/sandbox/files/watch.test.ts)：递归、entry info、事件类型；
- [`git/clone.test.ts`](../../../packages/js-sdk/tests/sandbox/git/clone.test.ts)：真实 Git daemon 的 clone/push；
- [`volume/volume.test.ts`](../../../packages/js-sdk/tests/volume/volume.test.ts)：MSW 控制面 mock、错误与代理；
- [`volume/file.test.ts`](../../../packages/js-sdk/tests/volume/file.test.ts)：真实 Volume 文件格式、元数据和 force。

测试展示了一种分层策略：控制面字段转换可 mock，文件/Git 的真实环境语义用集成测试。

## 16. 本模块练习

1. 写一个 10 MB `ReadableStream` 到 Sandbox，流式读取并计算哈希，确保不整体缓存。
2. 监听目录并依次 create/write/rename/remove，记录实际事件序列。
3. 在 Sandbox 中初始化 Git 仓库，制造 staged、unstaged、untracked 三种状态，检查解析结果。
4. 创建 Volume，先通过 Volume API 写入，再挂载到两个 Sandbox 验证持久性。
5. 比较缺失路径在 `exists()`、`getInfo()`、`read()` 中的返回/错误契约。

下一步阅读[模块 6：Template 构建系统](06-template-build.md)。
