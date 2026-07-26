# 13：术语表与源码索引

本章用于快速返回源码。路径对应教程快照；若符号移动，先 `rg -n "符号"`，不要依赖旧行号。

## 1. 核心术语

### Ack

对某一层“已安全接收”的确认。必须带限定词：transport ack、spool ack、callback ack。不是 Agent 完成或用户已读。

### Adapter

把一个 owner 的形态映射到稳定 contract。例如 Telegram Update → `ChannelInboundEventAdapter` facts，或 portable reply → Bot API 参数。

### Admission

在创建昂贵/可变副作用前决定是否接受工作。频道有 `ChannelTurnAdmission`，Gateway 重启/暂停也有 root work admission。

### Agent

由 model、prompt、tools、workspace、session/context policy 等共同定义的执行主体；不等同单次模型请求。

### Attempt

外层 runner 的一次模型/会话执行尝试。可能因 fallback、context overflow、compaction 或恢复再开始新 attempt。

### Capability

组件显式声明能做什么，例如频道支持 edit/draft/media，插件注册 tool/provider，客户端连接声明 caps。避免通过字符串或具体 id 猜能力。

### Compaction

将过长 transcript 的早期部分压缩为 summary，使后续 context 保留关键历史。不是 memory search，也不是简单删除所有旧消息。

### Context

本次模型调用实际看到的 token 输入：system prompt、选入 transcript、工具定义、附件/补充事实等。

### Control plane

配置、manifest、registry、认证、方法权限、生命周期等“决定系统如何运行”的表面。

### Data plane

真实消息、模型 stream、tool call/result 和出站 payload 的流动。

### Delivery receipt

平台接受发送后返回的 native 标识/元数据。通常不代表终端用户已读。

### Dedupe

识别重复事件或操作。与 debounce、lane serialization、idempotency 相关但不同。

### Durable ingress

在 ack 外部 transport 前先把事件写入可恢复队列，使崩溃后可以 replay。

### Event frame

Gateway 主动发送的 `type: "event"` 帧，不由 request id 一对一完成；常用于 Agent stream 和状态变化。

### Gateway

长驻 WebSocket/HTTP 控制中心，拥有连接认证、RPC registry、事件、运行时服务与统一 lifecycle。

### Lane

并发串行域。同一 session/ingress lane 的工作按序执行，不同 lane 可并行。

### Manifest

插件静态控制面声明。可以在不执行插件代码时验证 id、schema、能力和版本要求。

### Materialization

把已验证 source config 加上 runtime defaults、overlay、路径规范化和 registry 事实，形成 runtime config。

### Memory

可跨对话检索的长期知识/文件索引能力。不要与当前 context、session transcript、compaction summary 混用。

### Owner

对策略、状态和不变量最终负责的模块/插件。adapter 可转译，但不应偷偷重新定义 owner policy。

### Pinned snapshot

进程生命周期内复用的一致配置/metadata 事实，避免热路径重复发现和请求内部漂移。

### Plugin SDK

插件可依赖的公开 package subpath 与 contract；不是核心 `src/**` 的别名。

### Registration

插件同步声明 tool/hook/channel/service 等能力的阶段。异步 I/O 属于后续 lifecycle/callback。

### Request/response

Gateway `req` 与 `res` 通过 `id` 配对。response 成功只说明 RPC 处理结果，不一定说明异步 Agent 已结束。

### Route facts

在模型前解析的 agent/account/session/DM scope 等确定事实。

### Runtime config

完成读取、验证、默认值和 materialization 后供当前进程消费的规范形态。

### Session

对话/执行身份及持久 transcript/state 的逻辑边界。不同 DM scope、group、thread 会形成不同 key。

### Source config

尽量对应用户文件表达的规范配置，不包含所有 runtime 默认展开；写回时以此为基础。

### Terminal outcome

一次 Agent run 的最终状态，如完成、失败、取消、超时。由共享 owner 归一化，投影层不重新推导优先级。

### Tombstone

耐久标记某 ingress record 已由后续 owner 接管/完成，防止崩溃恢复时重复执行副作用。

### Tool loop

模型产生 tool use，host 执行工具并返回 result，再调用模型的内层循环；与外层 attempt/fallback loop 不同。

## 2. 按问题找源码

| 问题                      | 首选入口                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Node 为什么拒绝启动？     | [`openclaw.mjs`](../../../openclaw.mjs)                                                                                             |
| CLI 入口和快路径？        | [`src/entry.ts`](../../../src/entry.ts)、[`src/cli/run-main.ts`](../../../src/cli/run-main.ts)                                      |
| Gateway 如何启动/关闭？   | [`src/gateway/server.ts`](../../../src/gateway/server.ts)、[`src/gateway/server-start.ts`](../../../src/gateway/server-start.ts)    |
| WebSocket 第一帧？        | [`src/gateway/server/ws-connection/message-handler.ts`](../../../src/gateway/server/ws-connection/message-handler.ts)               |
| RPC 怎样授权/分发？       | [`src/gateway/server-methods.ts`](../../../src/gateway/server-methods.ts)                                                           |
| 帧 schema？               | [`packages/gateway-protocol/src/schema/frames.ts`](../../../packages/gateway-protocol/src/schema/frames.ts)                         |
| 配置怎样加载？            | [`src/config/io.load.ts`](../../../src/config/io.load.ts)                                                                           |
| runtime config/snapshot？ | [`src/config/io.runtime.ts`](../../../src/config/io.runtime.ts)                                                                     |
| 根配置 schema？           | [`src/config/zod-schema.ts`](../../../src/config/zod-schema.ts)                                                                     |
| channel turn 阶段？       | [`src/channels/turn/kernel.ts`](../../../src/channels/turn/kernel.ts)                                                               |
| portable channel facts？  | [`src/channels/turn/types.ts`](../../../src/channels/turn/types.ts)                                                                 |
| durable ingress？         | [`src/channels/message/ingress-drain.ts`](../../../src/channels/message/ingress-drain.ts)                                           |
| reply pipeline？          | [`src/auto-reply/reply/get-reply.ts`](../../../src/auto-reply/reply/get-reply.ts)                                                   |
| Agent 入口？              | [`src/agents/embedded-agent-runner/run-orchestrator.ts`](../../../src/agents/embedded-agent-runner/run-orchestrator.ts)             |
| Agent tools？             | [`src/agents/openclaw-tools.ts`](../../../src/agents/openclaw-tools.ts)                                                             |
| 模型/tool 内层循环？      | [`packages/agent-core/src/agent-loop.ts`](../../../packages/agent-core/src/agent-loop.ts)                                           |
| Agent terminal outcome？  | [`src/agents/agent-run-terminal-outcome.ts`](../../../src/agents/agent-run-terminal-outcome.ts)                                     |
| session key？             | [`src/routing/session-key.ts`](../../../src/routing/session-key.ts)                                                                 |
| 插件 manifest？           | [`src/plugins/manifest.ts`](../../../src/plugins/manifest.ts)                                                                       |
| 插件 discovery？          | [`src/plugins/discovery.ts`](../../../src/plugins/discovery.ts)                                                                     |
| 插件 runtime loader？     | [`src/plugins/loader-runtime-load.ts`](../../../src/plugins/loader-runtime-load.ts)                                                 |
| SDK entrypoints？         | [`src/plugin-sdk/entrypoints.ts`](../../../src/plugin-sdk/entrypoints.ts)                                                           |
| Telegram plugin 入口？    | [`extensions/telegram/index.ts`](../../../extensions/telegram/index.ts)                                                             |
| Telegram transport？      | [`extensions/telegram/src/monitor.ts`](../../../extensions/telegram/src/monitor.ts)                                                 |
| Telegram polling worker？ | [`extensions/telegram/src/telegram-ingress-worker.runtime.ts`](../../../extensions/telegram/src/telegram-ingress-worker.runtime.ts) |
| 共享状态 DB？             | [`src/state/openclaw-state-db.ts`](../../../src/state/openclaw-state-db.ts)                                                         |
| 每 Agent DB？             | [`src/state/openclaw-agent-db.ts`](../../../src/state/openclaw-agent-db.ts)                                                         |
| SQLite transaction？      | [`src/infra/sqlite-transaction.ts`](../../../src/infra/sqlite-transaction.ts)                                                       |

## 3. 测试索引

| Invariant                      | 测试入口                                                              |
| ------------------------------ | --------------------------------------------------------------------- |
| CLI Gateway fast path          | `src/cli/run-main.test.ts`                                            |
| WebSocket listen/upgrade 顺序  | `src/gateway/server.startup-websocket-race.test.ts`                   |
| 协议 frame validator           | `packages/gateway-protocol/src/index.test.ts`、`frame-guards.test.ts` |
| JSON5 配置 parse               | `src/config/io.parse.test.ts`                                         |
| plugin-aware config validation | `src/config/validation.channel-metadata.test.ts`                      |
| plugin discovery/冲突          | `src/plugins/discovery.test.ts`、`manifest-registry.test.ts`          |
| channel registration mode      | `src/plugin-sdk/channel-entry-contract.test.ts`                       |
| channel kernel 阶段短路        | `src/channels/turn/kernel.test.ts`                                    |
| durable ingress adoption       | `src/channels/message/ingress-drain.test.ts`                          |
| Telegram spool/offset          | `extensions/telegram/src/telegram-ingress-worker.runtime.test.ts`     |
| Telegram 崩溃窗口              | `extensions/telegram/src/polling-session.test.ts`                     |
| Telegram receipt/capability    | `extensions/telegram/src/channel.message-adapter.test.ts`             |
| SQLite sync transaction        | 搜索 `sqlite-transaction*.test.ts`                                    |
| Agent attempt/terminal         | 搜索 `embedded-agent-runner` 与 `terminal-outcome` tests              |

## 4. 官方文档索引

| 概念           | 官方文档                                                        |
| -------------- | --------------------------------------------------------------- |
| 整体架构       | [Architecture](https://docs.openclaw.ai/concepts/architecture)  |
| Agent 生命周期 | [Agent Loop](https://docs.openclaw.ai/concepts/agent-loop)      |
| 消息模型       | [Messages](https://docs.openclaw.ai/concepts/messages)          |
| Session        | [Session Management](https://docs.openclaw.ai/concepts/session) |
| Context        | [Context](https://docs.openclaw.ai/concepts/context)            |
| Compaction     | [Compaction](https://docs.openclaw.ai/concepts/compaction)      |
| Memory         | [Memory](https://docs.openclaw.ai/concepts/memory)              |
| Gateway        | [Gateway](https://docs.openclaw.ai/gateway)                     |
| Plugin         | [Plugins](https://docs.openclaw.ai/plugins)                     |
| Telegram       | [Telegram](https://docs.openclaw.ai/channels/telegram)          |
| Tests          | [Tests](https://docs.openclaw.ai/reference/test)                |

## 5. `rg` 搜索配方

### 找定义和调用

```bash
rg -n "export (async )?function runEmbeddedAgent|runEmbeddedAgent\(" src packages
```

### 找测试

```bash
rg -n "onAdopted|handler-timeout" src extensions --glob '*.test.ts'
```

### 找公开导出

```bash
rg -n 'plugin-sdk/.+"|"\./plugin-sdk/' package.json src/plugin-sdk
```

### 找配置字段全生命周期

```bash
rg -n "gateway\.auth|gateway.*auth" src docs extensions --glob '*.{ts,json,md}'
```

### 找 owner guide

```bash
find . -name AGENTS.md -not -path './node_modules/*' -print
```

### 找 sibling 实现

```bash
rg -n "defineBundledChannelEntry" extensions/*/index.ts
rg -n "createChatChannelPlugin" extensions/*/src
```

## 6. Evidence map 快速表

每次做结论前填：

| Cell                          | Evidence |
| ----------------------------- | -------- |
| changed/observed surface      |          |
| entry point                   |          |
| owner boundary                |          |
| caller                        |          |
| callee                        |          |
| sibling                       |          |
| existing tests                |          |
| current main behavior         |          |
| shipped behavior（若相关）    |          |
| dependency contract（若相关） |          |

有空格就写 gap，不要把未读部分补成猜测。

## 7. 最终复习题

1. 为什么 `connect` 的“第一帧”约束不能只由 schema 表达？
2. 为什么 source config 与 runtime config 必须同时保留？
3. 为什么 durable ingress 在 adoption 而非 reply settle 时 tombstone？
4. 为什么 plugin register 必须同步，但 plugin runtime 可以异步？
5. 为什么 `req(ok)` 和 Agent terminal outcome 是两个状态机？
6. 为什么 session、context、compaction、memory 不可合并成一个概念？
7. 为什么 SQLite transaction 内不允许 `await`？
8. 为什么公开 SDK 改动需要代表性插件 consumer proof？
9. 为什么 Telegram mock 测试不能替代真实 Telegram 用户行为证明？
10. 为什么测试选择必须先判断 source trust？

能用源码符号和测试回答这十题，就可以独立进入大部分 OpenClaw 子系统继续深挖。
