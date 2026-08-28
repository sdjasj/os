# 12｜SDK、RPC 与实验性远程协议：如何集成 Pi

Pi 提供多层集成方式。选错层会增加不必要的进程、协议或兼容成本。

## 1. 决策表

| 需求 | 推荐方式 | 原因 |
| --- | --- | --- |
| 同一 Node/TS 进程嵌入 | SDK / AgentSession | 类型完整、无序列化和子进程 |
| 非 Node 程序控制本机 pi | RPC 模式 | JSONL stdin/stdout，语言无关 |
| IDE 用独立进程隔离 Pi | RPC 模式 | 生命周期和 stdout 协议清晰 |
| 多客户端、网络/Unix socket | 实验性 protocol/client/server | 二进制 framing、租约、权威快照 |
| 只复用模型 Provider | pi-ai | 不引入 AgentSession 产品层 |
| 自建代理循环 | pi-agent-core | 注入 StreamFn 与工具 |

默认从最低复杂度方案开始：同进程 TypeScript 优先 SDK。

## 2. SDK：直接创建 AgentSession

官方 [SDK 文档](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/sdk.md) 的典型结构：

    const modelRuntime = await ModelRuntime.create();
    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      modelRuntime,
      tools: ["read"],
    });

    const unsubscribe = session.subscribe(handleEvent);
    try {
      await session.prompt("Inspect this directory");
    } finally {
      unsubscribe();
      session.dispose();
    }

SDK 的优点：

- 共享 TypeScript 类型；
- 可注入模型、资源加载器、会话和工具；
- 事件没有 JSON 编解码损失；
- 可直接使用内存 session；
- 易于单元测试。

代价是应用与 Pi 包运行在同一进程，崩溃、依赖版本、全局环境和资源使用更紧密。

## 3. AgentSessionRuntime：会话替换

单个 `AgentSession` 支持 prompt、模型切换、树导航和 compaction。新建/恢复/fork/import 等“替换当前 session”的能力属于 `AgentSessionRuntime`。

关键语义：

- `runtime.session` 在替换后变成新对象；
- 老 session 的事件订阅不会自动迁移；
- 使用 extensions 时，新 session 要重新绑定相应运行时资源；
- 创建或替换失败会抛错，由调用者决定回退 UI；
- cwd 变化可能要求重建 cwd-bound services。

典型处理：

    let session = runtime.session;
    let unsubscribe = session.subscribe(handle);

    await runtime.newSession();

    unsubscribe();
    session = runtime.session;
    unsubscribe = session.subscribe(handle);

把订阅永久绑在首次 session 是常见 bug。

## 4. RPC：子进程上的 JSONL

启动：

    pi --mode rpc

父进程向 stdin 写一行一个 JSON command；Pi 在 stdout 输出 response 和异步 event。

    {"id":"req-1","type":"prompt","message":"Hello"}
    {"id":"req-1","type":"response","command":"prompt","success":true}
    {"type":"message_update", ...}

request ID 用于关联命令 response，事件可在之后继续到达。`success: true` 表示 prompt 已接受、排队或立即处理，不表示整个 Agent 最终成功。

## 5. RPC framing 的细节

RPC 使用严格 JSONL：

- 只以 LF（`\n`）作为记录边界；
- 输入可接受 CRLF，但应去掉尾部 CR；
- JSON 字符串中的 Unicode U+2028/U+2029 不是协议换行；
- 每行必须是完整 JSON。

官方文档特别提醒 Node `readline` 会把 U+2028/U+2029 也当分隔符，因此不符合该 RPC framing。客户端应按字节/字符串缓冲，明确只找 `\n`。

stdout 是协议通道。调试日志必须写 stderr，否则一行普通日志就会破坏 JSONL 解码。

## 6. RPC 生命周期

常见命令：

- prompt / steer / follow_up / abort；
- clear_queue；
- get_state / get_messages；
- set/cycle model；
- new/resume/fork session；
- compact；
- bash 等产品命令。

注意：

- streaming 时 prompt 需指定 steer/followUp；
- extension command 可立即执行；
- clear_queue 与 abort 是两个动作；
- response 和 event 是两类 envelope；
- 客户端退出时要处理子进程和未完成 request；
- Pi 进程异常退出时，所有 in-flight request 都应失败。

## 7. Protocol：二进制远程会话协议

[`packages/protocol`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/protocol) 当前明确是实验性版本 1，wire format：

    [4-byte unsigned big-endian payload length]
    [one definite-length CBOR value]

第一条 client message 必须是：

    {
      type: "hello",
      version: PROTOCOL_VERSION
    }

之后使用带关联 ID 的 request/response envelope 与 server event envelope。

与 RPC 的区别：

- 二进制 CBOR 而非 JSONL；
- transport-neutral，可运行在 Unix socket/WebSocket 等；
- 协议内建远程 session acquire/lease 与快照语义；
- 包含更严格的 runtime Schema 和大小限制；
- 当前兼容性不保证。

## 8. 为什么需要长度前缀

TCP/WebSocket adapter 给出的 chunk 不等于应用消息：

- 一个 frame 可被拆成多个 chunk；
- 多个 frame 可合并在一个 chunk；
- header 自身也可被拆开。

[`FrameDecoder`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/protocol/src/framing.ts) 增量维护：

- 已收 header 字节；
- 期望 payload 长度；
- payload blocks 与当前长度；
- open/ended/failed 状态。

当读取完整四字节长度后，它先检查 max frame length，再分配/累积 payload。`end()` 时还有半帧会报 truncated frame。

测试必须覆盖：

    [header][payload]                  一次到达
    [h1][h2 h3][h4 payload-part...]   任意碎片
    [frame1 frame2 frame3]            合并到达
    [完整 frame][半个 frame] + end    截断错误

默认上限是 16 MiB，但生产 transport 应根据用途配置匹配限制。

## 9. CBOR 子集与运行时验证

协议使用严格 RFC 8949 子集：

- definite-length array/map/string；
- 安全范围整数和有限数；
- UTF-8 字符串、Uint8Array；
- plain object 且 key 唯一；
- 拒绝 tag、indefinite length、NaN/Infinity、尾随数据、过深嵌套等。

TypeBox Schema 拒绝未知属性。解码成功不代表消息合法，还必须通过 client/server message Schema。

安全限制应在分配大量内存前尽早检查；frame length、CBOR container 数量和 nesting 都是拒绝服务边界。

## 10. 权威快照与 transient progress

协议定义：

- server/session snapshots 是权威状态；
- progress event 只是临时 UI 提示；
- 客户端不能把 progress 自行归并为新的权威 snapshot。

原因：事件可能丢失、重连或乱于本地 UI 调度；若客户端乐观地从所有 progress 推导状态，最终会与服务端分叉。

正确模式：

    progress → 临时动画/文本
    snapshot → 替换缓存的权威状态

## 11. PiClient 与 session lease

[`packages/client`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/client) 的 `PiClient` 不含 Node 特有依赖，通过 `ByteTransport` 注入 socket/WebSocket。

重要语义：

- transport factory 每次连接创建新 transport；
- transport 认证在 factory resolve 前完成；
- send 保持顺序并处理 backpressure；
- 不自动重连，调用方显式 `reconnect()`；
- 一个连接可 attach 多个 session；
- request 以 ID 关联；
- successful response/snapshot 更新权威缓存。

租约：

- exclusive：生命周期或变更协调者独占；
- shared：多个底层消费者明确共享；
- 有任何 shared 时不能再 acquire exclusive；
- 有 exclusive 时不能 acquire shared；
- 最后一个 lease 释放后才向服务端 detach。

租约对象一开始释放就拒绝新命令，防止“正在 detach 又发 prompt”的竞态。

## 12. PiServer 的边界

[`packages/server`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/server) 也明确标记为实验性。它提供 `PiServer` 和 listener 接口，但：

- 不提供 standalone CLI；
- 不替应用实现 coding-agent service；
- 应用必须提供 `PiServerService`；
- listener 在把连接交给 PiServer 前完成认证/授权；
- Unix listener 可依赖 socket 文件权限；
- WebSocket 可在 HTTP upgrade 验证凭据。

核心 service：

    listSessions()
    listModels()
    createSession(options)
    openSession(sessionId)

server 还拥有 pi-ai 领域对象到 protocol DTO 的桥接，验证 tool call/result 关联并清洗诊断细节。领域类型与 wire DTO 分开，使协议演进必须显式评审。

## 13. 威胁模型

远程开放 Pi 不只是“把 socket 暴露出来”：

- transport 连接前认证和授权；
- Unix socket 权限；
- 网络加密；
- frame/container 限制；
- session ID 枚举防护；
- exclusive/shared 所有权；
- cwd 与文件工具的租户隔离；
- diagnostic 清洗；
- 不在 protocol error 回显原始敏感 payload；
- 断连时释放 lease 和运行资源。

Protocol 自身的 Schema 不能代替应用级身份和工作区隔离。

## 14. 动手练习

### 练习 A：SDK 或 RPC

分别为“VS Code 扩展”和“Python 自动化脚本”选集成方式。说明进程边界、类型、部署、日志通道和升级成本。

### 练习 B：RPC 客户端

实现最小客户端：

- spawn `pi --mode rpc`；
- 只按 LF 切 frame；
- request ID 关联 Promise；
- events 单独广播；
- stderr 单独采集；
- 子进程退出时拒绝全部 pending；
- 测试 JSON 字符串包含 U+2028。

### 练习 C：FrameDecoder

把多个 frame 拼成字节数组，以每一种 chunk size（1 到总长度）切分送入 decoder，断言输出相同。再测试超限、零长度和 end 时半帧。

### 练习 D：权威状态

模拟 progress 显示“正在运行”，随后收到 snapshot 表示 idle。客户端应立即以 snapshot 为准，并清理旧 progress UI。
