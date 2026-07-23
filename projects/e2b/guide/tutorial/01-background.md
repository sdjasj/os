# 模块 1：背景知识——隔离、控制面与数据面

本模块不急着讲类和方法，而是先建立读源码所需的系统背景。理解这些边界后，后续看到 HTTP、Connect RPC、Token、Template 和 Volume 时就不会把它们混成一团。

## 1. 为什么 AI 生成的代码需要 Sandbox

应用直接在自己的服务器进程中执行生成代码，会把不可信输入与生产权限放在同一个安全边界内。风险不只是“代码可能报错”，还包括：

- 读取应用进程能访问的环境变量和凭据；
- 删除或篡改宿主文件；
- 创建无限循环、内存耗尽或大量子进程；
- 对内网服务发起请求；
- 把数据发送到外部网络；
- 安装依赖造成供应链风险；
- 不同用户的任务彼此读取状态。

Sandbox 的核心思想是把执行环境变成一个受控制的远端资源。宿主应用只持有管理它的 API 能力，不与生成代码共享进程、文件系统和默认网络身份。

必须强调：隔离不等于“自动安全”。SDK 允许配置出站网络、公开端口、环境变量和 Volume；权限配置过宽仍会扩大风险。SDK 是安全边界的控制接口，而不是替代威胁建模的魔法层。

## 2. E2B 中的五类资源

### 2.1 Sandbox

Sandbox 是正在运行或暂停的隔离 Linux 环境，有唯一 `sandboxId`、模板来源、生命周期、CPU/内存配置、临时文件系统和网络配置。

SDK 中的 [`Sandbox`](../../../packages/js-sdk/src/sandbox/index.ts) 不是虚拟机本身，而是客户端代理对象。它保存：

- `sandboxId` 与 `sandboxDomain`；
- 控制面连接配置；
- envd 的访问 Token 和版本；
- `files`、`commands`、`pty`、`git` 等子模块。

### 2.2 Template

Template 是创建 Sandbox 的预构建基础。它类似镜像，但用户可以通过 E2B Builder DSL、Dockerfile 或另一 Template 来定义。构建结果包含模板 ID、构建 ID、名称和标签。

它解决的是“启动前准备”：如果每个 Sandbox 启动后都执行 `apt install` 和 `pip install`，启动慢、网络依赖多且结果不稳定；放入 Template 后，准备过程发生在构建阶段。

### 2.3 Snapshot

Snapshot 从某个 Sandbox 的当前状态创建持久版本，然后可以把 `snapshotId` 直接传给 `Sandbox.create()`。它适合“先动态准备一次，再从该状态批量启动”。

Template 更偏声明式构建，Snapshot 更偏运行时状态捕获。二者在服务端都能作为新 Sandbox 的启动来源，但产生方式不同。

### 2.4 Volume

Volume 是独立生命周期的持久文件存储。一个 Sandbox 被 kill 后，它的 Volume 不会自动消失；后续 Sandbox 可以再次挂载。代码入口是 [`Volume`](../../../packages/js-sdk/src/volume/index.ts)。

临时文件系统与 Volume 的选择：

| 需求                              | 选择             |
| --------------------------------- | ---------------- |
| 单次任务的中间文件                | Sandbox 文件系统 |
| 预装依赖和系统工具                | Template         |
| 复制某一运行时状态                | Snapshot/Fork    |
| 跨多个 Sandbox 共享或长期保存文件 | Volume           |

### 2.5 envd

envd 是运行在 Sandbox 内部的服务。SDK 不通过 SSH 执行命令，而是向 envd 调用结构化 API。它提供健康检查、文件内容传输、进程服务、PTY、目录监听等能力。

envd 的端口在 JS `Sandbox` 中默认为 `49983`；SDK 通过 E2B 分配的域名/代理访问它。envd 的服务端实现不在本仓库中，本仓库保存的是它的协议和客户端适配层。

## 3. 控制面与数据面

这是阅读 E2B 最重要的分层。

### 3.1 控制面

控制面负责资源“是什么、在哪里、处于什么状态”：

- 创建、连接、暂停、恢复、终止 Sandbox；
- 列表、详情、指标；
- Snapshot、Template、Volume 管理；
- 返回访问 envd 所需的域名、版本和 Token。

JS 的 [`ApiClient`](../../../packages/js-sdk/src/api/index.ts) 由 OpenAPI 类型约束，默认请求 `https://api.e2b.app`。例如创建 Sandbox 是 `POST /sandboxes`。

### 3.2 数据面

拿到 Sandbox 后，频繁操作发生在 envd：

- `/bin/bash` 中运行命令；
- 流式接收 stdout/stderr；
- 操作文件和目录；
- 建立 PTY；
- 监听目录变化。

这样做有两个好处：高频交互不用每次绕过全局控制面；进程和文件流可以用更适合的长连接协议表示。

### 3.3 为什么 `isRunning()` 调 envd 而 `getInfo()` 调控制面

[`Sandbox.isRunning()`](../../../packages/js-sdk/src/sandbox/index.ts) 访问 envd `/health`，回答“这个具体运行环境现在还能不能响应”；[`Sandbox.getInfo()`](../../../packages/js-sdk/src/sandbox/sandboxApi.ts) 访问控制面，回答“服务端记录的资源元数据是什么”。

二者在网络故障或状态转换瞬间可能观测到不同层面的事实。这也是错误处理代码在 RPC 连接突然断开时额外做健康检查的原因。

## 4. 三种协议为什么同时存在

### 4.1 OpenAPI + HTTP

[`spec/openapi.yml`](../../../spec/openapi.yml) 描述控制面 REST API。生成器把路径、请求体和响应体转换成 JS 类型与 Python 客户端模型。

适合它的操作：资源 CRUD、查询、构建状态等普通请求/响应。

### 4.2 Connect RPC + Protobuf

[`process.proto`](../../../spec/envd/process/process.proto) 和 [`filesystem.proto`](../../../spec/envd/filesystem/filesystem.proto) 描述 envd RPC。Connect 协议让浏览器/Node/Python 能使用 Protobuf 服务定义，并支持服务端流。

`Process.Start` 返回 `stream StartResponse`，因为一次命令不是单个响应，而是一串事件：

```text
start(pid)
data(stdout bytes)
data(stderr bytes)
keepalive
...
end(exit_code, error)
```

### 4.3 普通 HTTP 文件内容流

文件内容可能很大，用 Protobuf 消息包装会增加内存和编码成本。因此 `files.read/write` 通过 envd `/files` HTTP 路由传输内容，而 `stat/list/move/watch` 等元数据操作走 RPC。

这是一种很实用的协议选择：控制信息用强类型 RPC，大块字节用 HTTP body。

## 5. RPC、流与背压的基础知识

普通 Promise 只产生一个最终结果；异步迭代器/Stream 可以逐块产生数据。命令执行时间未知，输出可能很大，因此 SDK 必须边收边处理。

JS `Commands.start()` 获得 `AsyncIterable`，[`CommandHandle`](../../../packages/js-sdk/src/sandbox/commands/commandHandle.ts) 在后台遍历它：

1. `TextDecoder` 增量解码 stdout/stderr 字节；
2. 把内容追加到累积结果；
3. 调用用户提供的回调；
4. 收到 `end` 后记录退出码；
5. `wait()` 返回结果或在非零退出时抛错。

“增量解码”很重要。UTF-8 的一个字符可能跨两个网络数据块；直接对每块调用非流式解码会损坏字符。代码用 `{ stream: true }` 保存半个字符的状态，并在流结束时 flush。

文件 `ReadableStream` 还涉及背压：只有消费者请求下一块时，底层 `pull()` 才读取网络。SDK 的 idle timeout 只在等待网络数据时计时，而不是惩罚一个处理数据较慢的消费者。

## 6. 生命周期与状态机

可以把常见状态简化为：

```text
              pause
  create ──▶ running ─────▶ paused
                │             │
                │ kill        │ connect/resume
                ▼             └────▶ running
              ended
```

注意实际服务端还包含创建中、失败、超时处理等内部状态，但 SDK 面向列表暴露的主要状态类型是 `running | paused`。

超时到达时默认 kill，也可以配置 pause。若 pause 保存内存，运行中的进程和内存状态可恢复；若 `keepMemory: false`，只保存文件系统，恢复相当于冷启动，进程和连接丢失。

`autoResume` 需要内存快照，因为入站流量唤醒环境后，请求希望命中已经在监听的进程。仅有文件系统时没有可以立即恢复的监听进程，所以代码明确禁止 `autoResume + keepMemory: false`。

## 7. 身份与 Token 的边界

本仓库中容易出现四种“凭据”：

| 凭据                 | 典型用途                     | 典型传输位置                |
| -------------------- | ---------------------------- | --------------------------- |
| `E2B_API_KEY`        | 团队范围的 Sandbox/API 操作  | `X-API-KEY`                 |
| `E2B_ACCESS_TOKEN`   | CLI 账户/团队相关操作        | `Authorization: Bearer ...` |
| `envdAccessToken`    | 访问某个安全 Sandbox 的 envd | `X-Access-Token`/文件签名   |
| `trafficAccessToken` | 访问受限的公开 Sandbox 服务  | Sandbox 流量鉴权            |

API Key 证明“你能创建/管理哪些资源”，envd Token 证明“你能操作这个具体 Sandbox”。SDK 构造 `Sandbox` 时把控制面返回的 envd Token 保存在实例中，后续自动加到数据面请求。

此外，文件操作里的 `user` 不是 E2B 账户身份，而是 Sandbox 内的 Linux 用户。SDK 对 RPC 用 Basic Auth 形式编码用户名，用它影响路径解析和文件属主。

## 8. Template、镜像和 Dockerfile 的关系

Docker 镜像是文件系统层和元数据的分发格式；Dockerfile 是构建镜像的指令文件；E2B Template Builder 是一套更高层的构建 DSL。

[`TemplateBase.fromDockerfile()`](../../../packages/js-sdk/src/template/index.ts) 并不是在本地直接运行 Docker。它调用 [`parseDockerfile`](../../../packages/js-sdk/src/template/dockerfileParser.ts)，把受支持的 `FROM/RUN/COPY/WORKDIR/USER/ENV/CMD/ENTRYPOINT` 等指令转换为 E2B Template 步骤，再发往远端构建服务。

因此 Dockerfile 兼容性取决于解析器支持的语义；遇到复杂多阶段构建时要查看解析器限制。当前代码会拒绝多个 `FROM`。

## 9. 本模块检查题

1. 为什么 `Sandbox` 对象不是 Sandbox 本身？
2. 创建资源和执行命令分别经过哪个服务？
3. 为什么文件 `stat` 和文件内容读取使用不同协议？
4. `pause(keepMemory=false)` 与 Snapshot/Volume 分别保存什么？
5. 为什么命令输出要使用增量 UTF-8 解码？
6. API Key 与 envd Access Token 的权限边界有什么不同？

如果能不用看文档回答这些问题，就可以进入[模块 2：仓库结构与开发工具链](02-repository-and-toolchain.md)。
