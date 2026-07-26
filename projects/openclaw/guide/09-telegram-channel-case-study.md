# 09：Telegram 频道源码案例

Telegram 是理解现代 OpenClaw 频道架构的好案例，因为它同时包含 webhook、long polling、worker、durable ingress、群组/thread、media、流式预览和原生出站 API。

## 1. 入口保持轻量

三个文件分别承担不同控制面职责：

- [`extensions/telegram/openclaw.plugin.json`](../../../extensions/telegram/openclaw.plugin.json)：manifest；
- [`extensions/telegram/package.json`](../../../extensions/telegram/package.json)：包依赖、exports、channel setup metadata；
- [`extensions/telegram/index.ts`](../../../extensions/telegram/index.ts)：bundled lazy entry。

`index.ts` 只声明 plugin、secrets、runtime setter、account inspect sidecar，以及 full 模式才注册的 Mini App。顶层 import 不创建 bot、不请求 Telegram、不读取 token。

这让 host 可以只加载 setup 或 metadata，而不支付 grammY/transport 的完整成本。

## 2. Channel plugin 组合对象

主要 channel 定义在 [`extensions/telegram/src/channel.ts`](../../../extensions/telegram/src/channel.ts)，使用 `createChatChannelPlugin` 组合：

- config schema 和 account resolution；
- allowlist/security；
- bindings、conversation、groups；
- prompt/message normalization；
- message/outbound adapter；
- lifecycle、status 和 Gateway 表面。

`startAccount` 先探测 token/account，再调用 `monitorTelegramProvider`。因此“插件已注册”与“某个 Telegram account transport 已启动”仍是两个阶段。

生产源码只从 `openclaw/plugin-sdk/*` 导入 host contract。频道私有实现留在插件包内。

## 3. `monitorTelegramProvider` 选择 transport

[`extensions/telegram/src/monitor.ts`](../../../extensions/telegram/src/monitor.ts) 根据 account/config 选择：

```text
webhook configured
  -> startTelegramWebhook

otherwise
  -> acquire polling lease
  -> create TelegramPollingSession
  -> isolated worker getUpdates
```

两条路径最后都不直接把 update 丢给 Agent，而是先进入 Telegram durable spool，再请求 drain。

## 4. Webhook：先耐久，后 200

Webhook 的关键顺序在 `extensions/telegram/src/webhook.ts`：

```text
HTTP POST update
  -> validate/parse
  -> writeTelegramSpooledUpdate
  -> durable write succeeds
  -> respond HTTP 200
  -> request drain
```

如果先返回 200，再写队列时进程崩溃，Telegram 会认为投递成功而停止重试，消息永久丢失。因此 transport ack 的条件是“本地已有耐久副本”，不是“模型已经回复”。

写入失败时不能用 200 掩盖问题；让平台重试是 at-least-once 语义的一部分。

## 5. Polling：offset 只在 parent spool ack 后推进

polling worker 不直接拥有 SQLite。它通过 MessagePort 把 update 发给 parent，等待 parent 写 spool 后回传 update id。

[`extensions/telegram/src/telegram-ingress-worker.runtime.ts`](../../../extensions/telegram/src/telegram-ingress-worker.runtime.ts#L241-L275) 的核心循环：

```ts
const offset = lastUpdateId === null ? null : lastUpdateId + 1;
const result = await fetchJson(/* getUpdates */);

for (const update of result) {
  const updateId = await requestSpoolUpdate({ update, queued: result.length });
  lastUpdateId = Math.max(lastUpdateId ?? updateId, updateId);
  port.postMessage({ type: "spooled", updateId });
}
```

`await requestSpoolUpdate` 是关键。如果 worker 收到 update 就立即推进 offset，parent 落盘前崩溃会造成 Telegram 不再返回该 update。

worker 隔离还让 long polling 的 fetch/abort 与 host 主线程生命周期更清楚。parent 拥有 durable state，worker 拥有 transport loop。

## 6. Spool record、event id 与 lane

`extensions/telegram/src/telegram-ingress-spool.ts` 把原生 update 编码成通用 ingress queue record。至少需要：

- 稳定 event id，用于 transport update 去重；
- payload/metadata；
- lane key，用于同一对话/顺序域串行；
- claim/retry/tombstone 所需时间字段。

Telegram 的 `update_id` 去重与 `chat_id:message_id` 逻辑消息去重不是同一问题：前者防止 transport replay，后者处理不同 update envelope 指向同一消息语义等场景。

## 7. Drain：从 SQLite replay 到 grammY

`extensions/telegram/src/telegram-ingress-drain-factory.ts` 为每个 transport 建 monitor。`extensions/telegram/src/telegram-ingress-drain.ts` 提供 Telegram codec、lane 和 terminal outcome 映射，最终在 spooled replay 上下文调用：

```text
bot.handleUpdate(spooledUpdate)
```

因此 grammY middleware 接收到的是可靠队列取出的 update，而不是未经持久化的 HTTP/worker 临时对象。

通用 `src/channels/message/ingress-drain.ts` 拥有 claim refresh、stall watchdog、adopt/defer/abandon 和 retry；Telegram 只提供平台编码与 dispatch。

## 8. Adoption 是恢复所有权转移

三类崩溃窗口：

| 窗口                      | 恢复行为                                                           |
| ------------------------- | ------------------------------------------------------------------ |
| durable write 前          | webhook 不 ack / polling 不推进 offset，平台重发                   |
| 已入队但 turn adoption 前 | queue claim 可释放或过期，之后 replay                              |
| adoption 后、Agent 仍运行 | ingress tombstone，不 replay 原生 update；Agent/session owner 接管 |

测试集中在 `extensions/telegram/src/polling-session.test.ts`，覆盖 adoption 完成但 Agent 仍运行、adoption 前崩溃、adoption 后崩溃和 dispatch 失败。

这解释了为什么 queue complete 早于模型完成，却不是丢消息。

## 9. grammY 到频道 kernel

代表性链路：

```text
bot.handleUpdate
  -> createTelegramBotCore middleware
  -> registerTelegramMessageHandlers
  -> handleInboundMessageLike
  -> processInboundMessage
  -> processMessageWithReplyChain
  -> createTelegramMessageProcessor
  -> buildTelegramMessageContext
  -> dispatchTelegramMessage
  -> runTelegramDispatchTurn
  -> runChannelInboundEvent
```

对应源码分布：

- `extensions/telegram/src/bot-core.ts`：bot、middleware、update tracker、handler 注册；
- `extensions/telegram/src/bot-handlers.*.ts`：消息事件、media、debounce、reply chain；
- `extensions/telegram/src/bot-message-context.ts`：native facts → portable context；
- `extensions/telegram/src/bot-message-dispatch*.ts`：controller、turn adapter、reply；
- `src/channels/turn/kernel.ts`：通用阶段编排。

文件很多，但职责是逐层缩窄，而不是随机拆分。

## 10. Context 构建：平台事实到 portable facts

`buildTelegramMessageContext` 处理：

- bot/account identity；
- sender id、username、display label；
- direct/group/channel；
- forum topic/thread；
- reply-to message；
- mention 与 command 文本；
- media/attachment；
- allowlist 和授权结果；
- routing/session facts。

这里应保留必要原生 id 供出站使用，但核心 Agent prompt 不应依赖整个 Telegram Update 结构。

## 11. 通用 kernel 到 Agent

Telegram 的 turn adapter 在 `extensions/telegram/src/bot-message-dispatch-turn.ts` 映射 ingest、preflight、route、delivery，并声明 provider-owned delivery。

之后进入与其他现代频道共享的链：

```text
runChannelInboundEvent
  -> routed channel dispatcher
  -> dispatchReplyFromConfig
  -> getReplyFromConfig
  -> runPreparedReply
  -> model fallback candidate
  -> runEmbeddedAgent
```

平台授权和目标在 Agent 前确定；模型只看到已装配上下文，不决定 token、chat id 或 transport。

## 12. 回复控制器与流式状态

`extensions/telegram/src/bot-message-dispatch-reply.ts` 处理 final/streaming reply。可能涉及：

- typing；
- draft/live preview；
- 发送初始消息后 edit；
- progress 与 final 的切换；
- media/text 拆分；
- suppression 和 visible reply 观察；
- cleanup/finalizer。

不要假设每个 assistant delta 都调用一次 `sendMessage`。Telegram 的限速和用户体验通常要求合并、编辑或只展示 final。

## 13. 两条出站路径

Telegram 入站回复并不全部直接调用同一个 `sendMessageTelegram` 函数。存在两条相关路径。

### 13.1 Durable final / shared adapter

`bot-message-dispatch-delivery.ts` 可以把最终 payload 交给共享 message-send context，使用 channel 上注册的 message/outbound adapter。

通用 adapter 见：

- `extensions/telegram/src/channel.ts`；
- `extensions/telegram/src/outbound-adapter.ts`；
- `extensions/telegram/src/send-message.ts`。

它解析 account、target、thread、reply-to，返回 native receipt。

### 13.2 当前 bot instance 直接回复

reply controller 也可调用 `deliverReplies`，经过 `bot/delivery.replies.ts` 做 payload normalization、hook、chunk/media 分支，再在 `bot/delivery.send.ts` 调用 `bot.api.sendMessage` 或 edit API。

两条路径共享 channel contract、格式化和 native 语义，但不能伪装成完全同一函数调用链。

## 14. Native send 的关注点

最终调用 Bot API 前，插件必须处理：

- `chat_id` 与 thread/topic；
- reply parameters；
- HTML/Markdown 格式和 escaping；
- chunk size；
- media upload/URL；
- silent/notification 选项；
- Telegram error 分类与 retry；
- 返回 message id 形成 receipt。

这些都属于 Telegram owner。核心只应表达 portable payload/capability，不应知道 `parse_mode` 或 Telegram callback data 长度。

## 15. Account 生命周期与安全

频道 plugin 的 account lifecycle 通常是：

```text
resolve configured account
  -> resolve secret/token
  -> probe identity
  -> start monitor
  -> expose status
  -> abort/stop monitor
  -> release polling lease / close webhook
```

安全审查至少覆盖：

- token 不进入日志或 prompt；
- allowlist/authorization 在 Agent 前；
- bot/self 消息避免循环；
- webhook secret/path 与网络暴露；
- callback query 的及时原生 ack；
- media 下载的大小、类型与 URL 边界；
- polling worker 停止时 abort 和 pending request 清理。

## 16. 测试证据地图

| 行为                                 | 测试                                                              |
| ------------------------------------ | ----------------------------------------------------------------- |
| registration modes                   | `src/plugin-sdk/channel-entry-contract.test.ts`                   |
| durable ingress complete-at-adoption | `src/channels/message/ingress-drain.test.ts`                      |
| Telegram retry/tombstone             | `extensions/telegram/src/telegram-ingress-drain.test.ts`          |
| worker 等 spool ack                  | `extensions/telegram/src/telegram-ingress-worker.runtime.test.ts` |
| adoption 崩溃窗口                    | `extensions/telegram/src/polling-session.test.ts`                 |
| message receipt/capabilities         | `extensions/telegram/src/channel.message-adapter.test.ts`         |

Telegram 用户可见行为若可行，还需要真实 Telegram E2E/录屏证明；mock 能证明编排，不能证明 Bot API、客户端渲染和网络条件。

## 17. 本章实验

### 实验 A：阻塞 spool ack

阅读 worker runtime test，预测 parent 永不 ack 时：offset 是否推进、下一轮 getUpdates 是否发出、stop 如何中断。

验收：由 MessagePort request/response 和断言证明。

### 实验 B：崩溃窗口

对四个时刻注入失败：durable write 前、claim 后、adoption 前、adoption 后。写出期望 replay 次数和 lane 状态。

验收：无“应该大概”描述；每个期望对应测试或 lifecycle 分支。

### 实验 C：追踪一条群组 thread 回复

从原生 update 找 chat/thread/reply id，沿 context、route、reply plan、delivery controller 到 Bot API。

验收：指出 thread id 在何处成为 portable fact，何处重新编码为 Telegram 参数。

### 实验 D：比较两条出站路径

分别从 shared outbound adapter 和 inbound reply controller 追踪文本发送。

验收：列出共同 contract、不同入口和最终 native call，不能画成虚假的单链。

## 18. 不要过度推广

Telegram 是现代 inbound kernel 的完整实现，但不能据此声称所有频道都已迁移到相同路径。比较 sibling 前要读它们自己的 scoped guide、entry、adapter 和测试。共享 invariant 应进入核心；迁移状态差异应明确记录，而不是用 Telegram 强行推断。
