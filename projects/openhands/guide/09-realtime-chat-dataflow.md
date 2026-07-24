# 09. 实时聊天链路：WebSocket、历史回放、乐观消息与恢复

聊天页面不是“打开一个 socket 然后 append message”。它需要处理 Sandbox 未就绪、连接重试、REST history、WebSocket replay、流式 delta、消息排队、乐观 UI、归档只读和子会话订阅。本章沿一条消息从输入框走到屏幕。

## 先看两条方向相反的数据流

发送：

```text
Chat input
  -> useChatSubmission
  -> useSendMessage
  -> ConversationWebSocketContext.sendMessage
  -> WebSocket JSON（连接正常）
     或 PendingMessageService REST（未连接）
  -> Agent Server / App Server queue
```

接收：

```text
REST history + WebSocket replay/live
  -> websocket context parser
  -> event handler
  -> useEventStore.addEvent
  -> handleEventForUI
  -> Chat messages/actions/observations
```

发送成功的 HTTP/WebSocket ack 不等于助手已完成；完成由后续事件表示。

## WebSocket URL 如何构造

`buildWebSocketUrl` 从 conversation URL 解析 scheme/host/path prefix，输出：

```text
ws://host[:port][/prefix]/sockets/events/{conversationId}
```

如果页面是 HTTPS，必须使用 `wss`。部署在反向代理 path prefix 下时不能丢前缀。不要用字符串 replace `http -> ws` 后手拼路径，URL parser 更可靠。

session API key 等 query 参数由 hook options 添加，URL builder 保持路径职责单一。

## `useWebSocket` 的生命周期

通用 hook 管理：

- 创建 `new WebSocket(wsUrl)`；
- onopen/onmessage/onerror/onclose；
- 可配置重连延迟和次数；
- 保存最近消息；
- `sendMessage` 前检查 `OPEN`；
- URL 改变或 unmount 时禁止旧实例重连并 close。

它使用 `WeakSet<WebSocket>` 标记哪些实例允许重连，解决一个常见竞态：组件 cleanup 主动关闭旧 socket 后，旧 socket 的 `onclose` 仍触发并错误重连。

通用原则：重连资格属于“某个具体连接实例”，不能只用一个全局 boolean。

## Provider 何时连接

`ConversationWebSocketProvider` 需要：

- conversation id；
- conversation metadata 中的 URL；
- session API key；
- Sandbox 可用状态；
- planning agent 的可选子连接。

因此 route 会尽早 mount Provider，但 Provider 内部等待输入有效再连接。这样避免 loading → ready 时整棵 UI provider remount，减少事件和 store 被重置两次。

## 历史加载与 live connection

Provider 需要给 UI 一个统一 loading 状态：

```text
连接 WebSocket
  + 获取历史事件
  + 处理 replay
  -> isLoadingHistory=false
```

归档会话可能没有可连接 Sandbox，但仍可通过 App Server/共享事件服务读取历史。UI 不能把“socket 不可用”误判成“历史为空”。

## 消息格式

发送请求不是裸字符串，而是带 role/content/run 的结构：

```json
{
  "role": "user",
  "content": [
    {"type": "text", "text": "请运行目标测试"}
  ],
  "run": true
}
```

content 是多模态 block 数组，未来可包含 image 等类型。前端 input string 只是 UI 便利层，协议不要退化成只支持字符串。

## 未连接时为何进入 PendingMessage

Provider 的 `sendMessage` 检查当前 socket：

```text
OPEN -> 立即通过 WebSocket 发送
非 OPEN -> 调 App Server queue API
```

这处理 Sandbox resume 和连接建立的空窗。App Server 在会话就绪后转发 pending messages。

但 queue 成功不代表消息已经被 Agent Server 消费。UI 可以提示排队状态，不能假装已经开始运行。

## 乐观用户消息

用户点击发送后，如果等 WebSocket 回显才显示输入，会感觉延迟。`optimistic-user-message-store` 临时保存文本，让 Chat 立即显示。

正确 reconciliation：

1. 仅在消息真正立即发送时显示 optimistic；
2. 收到对应 durable user MessageEvent 后移除 optimistic；
3. 发送失败要恢复输入或展示错误；
4. conversation 切换要清除；
5. queued message 的 UI 语义要和 immediate send 区分。

没有 client-generated id 时，只凭文本匹配可能误删重复消息。协议演进可考虑显式 correlation id。

## 事件到 UI 的完整处理

WebSocket 收到 JSON 后：

```text
parse discriminator
  -> 标记是否 planning agent
  -> addEvent
     -> event id 去重
     -> raw events 合并/sort
     -> handleEventForUI
        -> delta 合并
        -> final 对账
        -> action/observation 替换
        -> ACP tool call 更新
  -> React selector 触发最小重渲染
```

如果每层都做一次无规则“去重”，可能误删合法状态更新。去重 key 必须按事件类型定义：普通 event 用 id，ACP tool lifecycle 用 tool_call_id，optimistic message 用单独 reconciliation。

## AgentState 如何驱动输入按钮

`useAgentState` 返回 `curAgentState` 和 `isArchived`。Chat input/actions 再决定：

- running 时显示 stop；
- awaiting input 时可 send；
- loading/recovering 时禁用或排队；
- archived 时完全换成 banner/只读视图。

WebSocket connection state 与 Agent execution state 不相同：

```text
socket OPEN + agent IDLE
socket OPEN + agent RUNNING
socket CLOSED + sandbox RUNNING（网络故障）
socket CLOSED + sandbox PAUSED（预期）
```

因此不能用 `socket.connected` 直接代表 Agent 是否运行。

## Sandbox recovery

`useSandboxRecovery` 处理已停止/暂停但可恢复的会话。重要行为是：普通 WebSocket 断开不会自动 resume Sandbox。否则短暂网络抖动可能启动昂贵资源或与用户 pause 意图冲突。

恢复应基于明确 Sandbox status 和用户/页面动作，而不是仅凭 transport disconnect。

## 子会话订阅

`ConversationSubscriptionsProvider` 可为多个 conversation 建立 Socket.IO subscription，并在 unmount 时逐个：

```text
off handler
removeAllListeners
disconnect
remove from state
```

这是 planner/多 Agent UI 的需要。主 V1 conversation 使用 native WebSocket，而部分订阅能力仍有 Socket.IO 迁移痕迹，所以阅读时要标注连接类型和 endpoint，不能把二者 API 混用。

## 为什么 StrictMode 容易暴露 socket bug

开发环境 StrictMode 会 mount/effect/cleanup/re-run，以检查副作用。若 hook：

- 忘记 close；
- cleanup 后仍允许 reconnect；
- handler identity 不稳定无法 `off`；
- 使用闭包中的旧 conversation id；

就会看到双连接、重复 event 或旧会话复活。正确修复是让 effect 幂等和 cleanup 完整，不是关闭 StrictMode。

## 一套实用诊断表

| 症状 | 优先检查 |
| --- | --- |
| 一直 Connecting | URL、TLS、proxy Upgrade、Sandbox `/alive` |
| 重复用户消息 | optimistic reconciliation + replay 去重 |
| 重复助手消息 | delta/final 对账 |
| Action 卡片重复 | action id / observation replacement |
| 切换会话仍收到旧消息 | Provider cleanup、旧 socket reconnect |
| archived 页面空白 | history path 是否错误依赖 live socket |
| socket 断开后意外启动资源 | recovery 条件是否只看 disconnect |

## 本章实验：用 mock 验证时序

前端已使用 MSW WebSocket handler。设计一个测试：

1. history 延迟返回；
2. WebSocket 先 replay 一个 durable message；
3. history 又包含同 id；
4. live 发送两个 delta 和 final；
5. 断开后 route 切换；
6. 旧 socket 尝试触发 onclose。

断言：durable message 只显示一次；delta/final 只形成一个气泡；旧 socket 不重连；新会话 store 已清理。

## 常见误区

- 用 socket 状态代表 Agent 状态。
- URL 变化时只创建新 socket，不关闭旧 socket。
- 对 history 和 replay 简单 concat。
- pending queue 成功就显示为 Agent 已开始执行。
- archived history 依赖 live Sandbox。
- 为绕过 StrictMode 双连接而关闭 StrictMode。

## 自测

1. 为什么重连资格要绑定 WebSocket 实例？
2. history 和 live event 可能发生哪些竞态？
3. optimistic message 何时应移除？
4. WebSocket CLOSED 为什么不能自动等价 Sandbox PAUSED？
5. native WebSocket 与 Socket.IO 为什么不能混用 client API？

## 源码定位

- [WebSocket URL 构造](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/utils/websocket-url.ts)
- [通用 WebSocket hook](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/hooks/use-websocket.ts)
- [Conversation WebSocket Context](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/contexts/conversation-websocket-context.tsx)
- [事件 UI 处理](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/utils/handle-event-for-ui.ts)
- [Sandbox recovery](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/hooks/use-sandbox-recovery.ts)
- [子会话订阅 Provider](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/context/conversation-subscriptions-provider.tsx)

下一章集中处理设置、密钥、用户身份与 Sandbox capability 的安全关系。
