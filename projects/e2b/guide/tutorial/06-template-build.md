# 模块 6：Template 构建系统

Template 系统把本地声明、文件上下文和远端构建服务串在一起。本模块讲清 Builder 状态机、Dockerfile 解析、缓存哈希、文件上传、构建触发与日志轮询。

## 1. Template 解决什么问题

假设每个任务启动后都做：

```bash
apt-get update
apt-get install -y git
pip install -r requirements.txt
```

这会让每次 Sandbox 的准备时间、网络可用性和依赖解析结果都进入关键路径。Template 把这些步骤移到预构建阶段：

```text
本地 Template 定义
  → 远端构建一次
  → 得到 template name/tag/id
  → 多次 Sandbox.create(template)
```

Template 不是在当前开发机创建 Docker 容器；Builder 序列化构建指令，文件上传后由 E2B 远端执行构建。

## 2. Builder 的类型状态

[`Template()`](../../../packages/js-sdk/src/template/index.ts) 返回 `TemplateFromImage`，要求先选择来源：

```ts
const template = Template()
  .fromPythonImage('3.12')
  .setWorkdir('/app')
  .runCmd('python --version')
```

类型接口分为：

- `TemplateFromImage`：选择 Docker image、现有 E2B Template、Dockerfile 或私有 registry；
- `TemplateBuilder`：添加 COPY/RUN/ENV/WORKDIR/USER 等步骤；
- `TemplateFinal`：设置 start/ready 后形成最终模板类型。

实际运行时对象始终是 `TemplateBase`，接口返回类型限制链式调用的合法顺序。这是“类型状态模式”：不创建多个运行时类，仅用静态类型表达构建阶段。

## 3. 一份真实的 SDK Template

目录：

```text
my-template/
├── build.ts
├── requirements.txt
└── app.py
```

`build.ts`：

```ts
import { Template, defaultBuildLogger, waitForPort } from 'e2b'

const template = Template({
  fileContextPath: new URL('.', import.meta.url).pathname,
  fileIgnorePatterns: ['**/__pycache__/**'],
})
  .fromPythonImage('3.12')
  .setWorkdir('/app')
  .copy('requirements.txt', '/app/requirements.txt')
  .copy('app.py', '/app/app.py', { mode: 0o644 })
  .runCmd('pip install --no-cache-dir -r /app/requirements.txt', {
    user: 'root',
  })
  .setStartCmd('python /app/app.py', waitForPort(8000))

const info = await Template.build(template, 'python-web:v1', {
  cpuCount: 2,
  memoryMB: 1024,
  onBuildLogs: defaultBuildLogger(),
})

console.log(info)
```

运行构建后：

```ts
const sandbox = await Sandbox.create('python-web:v1')
```

`setStartCmd` 的 ready check 决定新 Sandbox 何时算准备好。服务进程已经启动不等于端口已监听，生产模板应提供可靠 ready 条件。

## 4. 文件上下文与 `copy()`

`fileContextPath` 是 COPY 源文件的根。未显式传入时，JS 通过调用栈推断定义 Template 的文件目录，而不是简单使用进程当前目录。

```ts
Template({ fileContextPath: '/project/template' })
  .fromBaseImage()
  .copy('src/**', '/app/src')
```

源路径必须是 context 内的相对路径。[`validateRelativePath`](../../../packages/js-sdk/src/template/utils.ts) 阻止绝对路径和逃逸 context 的 `../`。这是可复现性和安全约束：构建配方不应意外把 `~/.ssh` 或仓库外机密打包上传。

忽略规则来自两处：

- `TemplateOptions.fileIgnorePatterns`；
- context 根的 `.dockerignore`。

`copy()` 支持 glob、多个源、mode、目标 user、符号链接解析和 gzip。`copyItems()` 让每个项目有独立选项。

## 5. Builder 指令怎样表示

[`Instruction`](../../../packages/js-sdk/src/template/types.ts) 的核心结构：

```ts
type Instruction = {
  type: 'COPY' | 'ENV' | 'RUN' | 'WORKDIR' | 'USER'
  args: string[]
  force: boolean
  filesHash?: string
  forceUpload?: true
  resolveSymlinks?: boolean
  gzip?: boolean
}
```

Builder 方法大多只是向 `instructions` 数组追加数据：

- `runCmd(['a', 'b'])` 把命令合成 `a && b`；
- `aptInstall()` 转成 `apt-get update && apt-get install ...` 的 RUN；
- `makeDir()`、`remove()`、`rename()` 也是安全引用参数后的 RUN；
- `setEnvs()` 追加 ENV；
- `copy()` 追加 COPY，并在构建前计算文件哈希。

这种设计把“易用方法”归一化为少数远端指令类型，减小服务端协议面积。

## 6. 起始来源

### 6.1 公共 Docker image

```ts
Template().fromImage('ubuntu:24.04')
Template().fromPythonImage('3.12')
Template().fromNodeImage('22')
Template().fromBaseImage()
```

语言辅助方法只是拼出常见 image 名称。

### 6.2 现有 E2B Template

```ts
Template().fromTemplate('team-base:v2')
```

可以建立团队的分层模板，但它不能转换回标准 Dockerfile，因为 E2B Template 可能包含 Dockerfile 无法表达的特性。

### 6.3 私有 registry

`fromImage()` 支持基本用户名/密码，另有 AWS ECR 与 GCP service account 方法。凭据进入远端构建请求，必须使用短期、最小权限账户，并避免把明文写入仓库。

### 6.4 Dockerfile

```ts
Template({ fileContextPath: process.cwd() }).fromDockerfile('e2b.Dockerfile')
```

[`parseDockerfile`](../../../packages/js-sdk/src/template/dockerfileParser.ts) 先判断参数是内容还是文件路径，再解析指令并调用 Builder。当前明确拒绝：

- 没有 `FROM`；
- 多个 `FROM`，即多阶段构建。

支持范围应以解析器 switch/handler 为准。复杂 Dockerfile 在迁移前要写解析测试，不应假设 Docker 全语法都被远端照搬。

## 7. Start 与 Ready

```ts
template.setStartCmd('node server.js', waitForPort(3000))
```

Start command 在 Sandbox 启动时运行，ready command 被反复检查，退出 0 表示准备完成。

内置 [`ReadyCmd`](../../../packages/js-sdk/src/template/readycmd.ts)：

```ts
waitForPort(3000)
waitForURL('http://localhost:3000/health', 200)
waitForProcess('server')
waitForFile('/tmp/ready')
waitForTimeout(1_000)
```

优先选择语义最接近真实可用性的条件：

1. HTTP 服务有 health endpoint：`waitForURL`；
2. 只需确认监听：`waitForPort`；
3. 后台初始化会创建标记：`waitForFile`；
4. 固定等待时间只适合作为无法观测时的退路。

仅检查进程存在可能漏掉“进程还在但初始化失败”；仅等待固定秒数会在慢机器上不够、快机器上浪费时间。

## 8. 构建调用链总览

`Template.build(template, name, options)`：

```text
normalizeBuildArguments
  → requestBuild(POST /v3/templates)
  → instructionsWithHashes()
  → 每个 COPY: getFileUploadLink()
  → 需要时并行 uploadFile()
  → triggerBuild(POST /v2/templates/{id}/builds/{id})
  → waitForBuildFinish() 轮询状态与日志
  → ready 返回 BuildInfo / error 抛 BuildError
```

静态 `Template.build` 委托到 `TemplateBase.build` 私有实现；构建过程位于 [`template/index.ts`](../../../packages/js-sdk/src/template/index.ts)，网络步骤拆在 [`buildApi.ts`](../../../packages/js-sdk/src/template/buildApi.ts)。

## 9. 请求构建

第一步 `POST /v3/templates` 发送名称、tags、CPU 和内存。默认：

- 2 CPU；
- 1024 MB；
- 没有额外 tags。

响应给出 `templateID`、`buildID` 和服务端确认的 tags。此时只是获得构建槽位，并未上传上下文或开始执行。

名称可带 tag：

```ts
await Template.build(template, 'python-web:v1')
```

也可额外传 tags。标签指向具体 build，后续可以通过 `assignTags`、`removeTags` 和 `getTags` 管理。

## 10. COPY 哈希与缓存

构建前 `instructionsWithHashes()` 对每个 COPY 计算 SHA-256。哈希不只包含文件内容，还考虑路径、元数据、目标与符号链接策略，使缓存键能反映构建输入。

SDK 向服务端询问该 hash 是否已存在：

- `present: true`：跳过上传，复用已有内容；
- `present: false` 且有预签名 URL：打包并上传；
- `forceUpload`：即使存在也按服务端 URL 再传。

所有 COPY 上传用 `Promise.all` 并行执行，减少多个独立上下文的总等待时间。

### 10.1 `skipCache()` 的两个粒度

Builder 上调用 `skipCache()` 会让后续层标记 force；构建选项 `skipCache: true` 会强制整个模板重建。

```ts
Template()
  .fromBaseImage()
  .runCmd('stable-step')
  .skipCache()
  .runCmd('always-rebuild-this-and-following')
```

缓存失效是性能与正确性的权衡。依赖浮动外部状态、但指令字符串不变时可能需要 force；更理想的是把版本或 lockfile 纳入输入，让哈希自然变化。

## 11. 文件打包与上传

[`uploadFile`](../../../packages/js-sdk/src/template/buildApi.ts) 不把整个 tar 放进内存：

1. 根据 glob 与 ignore 规则收集文件；
2. 在临时目录生成 tar/gzip 文件；
3. 从磁盘创建 stream；
4. 用预签名 URL PUT；
5. 显式发送 `Content-Length`，避免 S3 拒绝 chunked transfer；
6. 流关闭后删除临时文件；
7. 请求提前失败时 destroy stream 触发清理。

普通 API 默认请求超时 60 秒，但大上下文上传默认允许 1 小时。若用户显式传 `requestTimeoutMs`，它会控制上传；否则不会错误地给数百 MB 上传套用 60 秒。

这再次展示“同名 timeout 不能机械复用”的设计：控制面小请求和大文件上传有不同合理默认值。

## 12. 触发远端构建

文件就绪后，SDK 把序列化结果发送给构建端点：

```ts
{
  fromImage?: string,
  fromTemplate?: string,
  fromImageRegistry?: RegistryConfig,
  startCmd?: string,
  readyCmd?: string,
  steps: Instruction[],
  force: boolean,
}
```

只会设置一个来源。Builder 方法在切换来源时清除另一个字段，避免同时传 image 和 template。

## 13. 状态轮询与日志

构建状态为 `building | waiting | ready | error`。`waitForBuildFinish()`：

1. 用 `logsOffset` 获取增量日志；
2. 把每个日志交给 `onBuildLogs`；
3. waiting/building 时短暂等待再轮询；
4. terminal 状态后继续拉取，直到剩余日志清空；
5. ready 返回；error 根据 reason 构造 `BuildError`。

为什么 terminal 后还要继续拉？状态接口每次最多返回有限条日志，terminal 响应可能还有尾部日志未取完。先 drain 能保证用户看到完整失败上下文。

`defaultBuildLogger()` 提供带计时和级别颜色的终端输出，也可传自定义 logger 写入 CI：

```ts
onBuildLogs: (entry) => {
  console.log(
    JSON.stringify({
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
    })
  )
}
```

## 14. 调用栈与远端错误定位

Builder 每添加一条指令时记录调用栈，并保持它与 build step 索引对齐。远端构建失败返回 step 后，SDK 用 [`getBuildStepIndex`](../../../packages/js-sdk/src/template/utils.ts) 找到本地栈，把 `BuildError.stack` 指向用户定义该步骤的位置。

这项设计让远端错误看起来像本地 DSL 行报错，而不是只显示 SDK 内部轮询函数。实现新复合 Builder 方法时要小心：内部可能添加多条指令，但每个 step 的 stack 仍需正确对齐。

## 15. 后台构建

```ts
const info = await Template.buildInBackground(template, 'python-web:v2')

let status = await Template.getBuildStatus(info)
while (status.status === 'building' || status.status === 'waiting') {
  // 保存 logsOffset，避免重复日志
  status = await Template.getBuildStatus(info, {
    logsOffset: status.logEntries.length,
  })
}
```

`buildInBackground` 仍会请求构建、计算/上传文件并触发构建，只是不等待远端完成。业务需要持久化 `templateId/buildId` 并负责轮询、错误和日志 offset。

## 16. Python 对应 Builder

```python
from e2b import Template, default_build_logger, wait_for_port

template = (
    Template(file_context_path=".")
    .from_python_image("3.12")
    .set_workdir("/app")
    .copy("requirements.txt", "/app/requirements.txt")
    .run_cmd("pip install -r /app/requirements.txt", user="root")
    .set_start_cmd("python /app/app.py", wait_for_port(8000))
)

Template.build(
    template,
    "python-web:v1",
    cpu_count=2,
    memory_mb=1024,
    on_build_logs=default_build_logger(),
)
```

异步构建使用 `AsyncTemplate.build()`。共享 Builder 在 [`e2b/template/main.py`](../../../packages/python-sdk/e2b/template/main.py)，同步/异步上传和轮询分别在 `template_sync`、`template_async`，变更 I/O 行为时都要修改。

## 17. CLI 如何复用 Template 系统

当前 [`e2b template create`](../../../packages/cli/src/commands/template/create.ts)：

1. 定位 `e2b.Dockerfile` 或 Dockerfile；
2. 用 `Template({ fileContextPath: root }).fromDockerfile(content)`；
3. 根据 CLI 参数设置 start/ready；
4. 用 `Template.build()` 构建；
5. 输出 JS/Python 使用示例。

CLI 并没有独立实现远端构建。旧 `template build` 命令直接显示废弃提示，防止用户继续使用 v1 构建系统。

## 18. 常见失败与诊断

| 失败                               | 可能原因                                         |
| ---------------------------------- | ------------------------------------------------ |
| COPY 找不到文件                    | `fileContextPath`、glob 或 ignore 规则错误       |
| 相对路径被拒绝                     | 源路径为绝对路径或逃逸 context                   |
| 上传超时                           | 显式 `requestTimeoutMs` 太短、代理慢、上下文过大 |
| 构建总是缓存旧结果                 | 外部依赖未锁版本，输入 hash 未变化               |
| ready 一直失败                     | 服务未监听、端口错误、命令依赖环境变量缺失       |
| 本地栈指错步骤                     | 复合方法添加的指令与 stack trace 未对齐          |
| Dockerfile 解析失败                | 多阶段构建或未支持指令语义                       |
| Template 可构建但新 SDK 功能不可用 | 需要重建以更新模板内 envd                        |

减小构建上下文是第一优化手段：正确写 `.dockerignore`，只 COPY lockfile 和必要源码，不上传 `.git`、虚拟环境、node_modules、日志和密钥。

## 19. 本模块练习

1. 用 Builder 创建 Python Template，并用 `Template.toJSON()` 查看序列化步骤。
2. 修改一个 COPY 文件，比较 JSON 中 `filesHash`；再只修改被 ignore 的文件观察结果。
3. 使用 `Template.toDockerfile()` 转换 image-based Template；对 `fromTemplate()` 调用并解释错误。
4. 写一个故意失败的 RUN，观察 `BuildError.stack` 是否指向 Builder 调用处。
5. 用 `buildInBackground()` 自己实现增量日志轮询，正确维护 offset。
6. 准备一个多阶段 Dockerfile，阅读解析器并解释为什么当前实现拒绝。

下一步阅读[模块 7：API、连接配置、超时与错误](07-api-connection-errors.md)。
