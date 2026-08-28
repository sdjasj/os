# 04｜AI 层：消息、模型、Provider 与流式事件

AI 包是所有上层的模型抽象。它解决“如何以同一种方式表达和调用不同模型”，但不负责决定代理何时停止。

源码入口：

- [公共类型](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/types.ts)
- [模型注册与调用](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/models.ts)
- [事件流](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/utils/event-stream.ts)
- [Faux Provider](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/providers/faux.ts)

## 1. 数据模型：不要把回复简化为 string

### 内容块

assistant 内容可以由多种块组成：

    TextContent       { type: "text", text: "..." }
    ThinkingContent   { type: "thinking", thinking: "..." }
    ToolCall          { type: "toolCall", id, name, arguments }
    ImageContent      { type: "image", data, mimeType }

不同 Provider 对 thinking、图片和工具调用的支持不同，统一类型让上层不必理解每家厂商的原始 JSON。

### 三类核心消息

`UserMessage`：

- role 为 `user`；
- content 可以是文本，也可以是多模态块；
- 由用户输入、steering 或上层自定义转换产生。

`AssistantMessage`：

- role 为 `assistant`；
- content 是结构化内容块数组；
- 带 model/provider、usage、stopReason、时间等结果元数据；
- 错误和 abort 也要形成可观察的最终消息状态。

`ToolResultMessage`：

- role 为 `toolResult`；
- 用 `toolCallId` 与 assistant 的调用配对；
- content 可含文本或图片；
- 标记成功/错误，使模型知道工具是否完成。

工具调用和结果之间的稳定关联键是 ID，而不是名称，因为同一个工具可能在一轮中被调用多次。

## 2. Context、Tool 与 Model

发送给 Provider 的 `Context` 核心上包含：

- system prompt；
- 已转换的消息历史；
- 当前可用工具。

`Tool` 定义名称、描述和 TypeBox 参数 Schema。模型看到 Schema 后生成参数；AI 层的 `validateToolArguments` 在运行时验证。

`Model` 描述：

- 模型 ID、Provider、API 类型；
- 上下文窗口、最大输出；
- 支持的输入和能力；
- 成本信息及 Provider 特有配置。

不要把模型 ID 当作全局唯一字符串。准确身份通常需要 Provider/API 与 model ID 共同决定。

## 3. Provider 是什么

[`models.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/models.ts) 定义的 Provider 把某个模型服务接入统一接口。可将它理解为适配器：

    Pi Context + Model
            │
            ▼
       Provider.stream
            │
            ├─ 把统一消息转换为厂商请求
            ├─ 发送认证信息和 Provider 选项
            ├─ 解析厂商流
            └─ 发出 AssistantMessageEvent

新增 Provider 的工作重点不是“发一个 HTTP 请求”，而是保证：

- 所有内容块正确往返；
- 工具调用参数的增量拼接正确；
- stopReason 能映射；
- token usage 和成本信息一致；
- abort 能中止请求；
- 错误也形成合法终止事件；
- 模型能力声明与真实行为匹配。

## 4. Models 是模型注册表与调用门面

`ModelsImpl` 管理 Provider 和模型列表。上层通过它：

- 列举与查找模型；
- 判断模型是否有可用认证；
- 应用 API key/OAuth 等认证；
- 创建对应 Provider；
- 调用 `stream` 或 `complete`；
- 估算/记录用量成本。

`stream` 是主实现；`complete` 本质上消费同一个流并等待最终结果。统一入口避免流式与非流式路径出现两套不一致逻辑。

高层关系：

    Models.stream(model, context, options)
      ├─ 确认 Provider
      ├─ 应用认证
      ├─ 创建或选择 Provider 实例
      └─ provider.stream(...)

具体认证优先级可能随版本变化，排查时直接跟踪 `applyAuth` 和设置加载，不要靠猜测环境变量。

## 5. AssistantMessageEvent 的生命周期

典型文本响应：

    start
      → text_start
      → text_delta ("你")
      → text_delta ("好")
      → text_end ("你好")
      → done

包含 thinking 和工具调用时，各内容块拥有自己的 `contentIndex`，事件可能是：

    thinking_start / thinking_delta / thinking_end
    text_start     / text_delta     / text_end
    toolcall_start / toolcall_delta / toolcall_end

最终只有 `done` 或 `error`。消费者必须用 `type` 分支，不应假设事件总按“只有文本”的简单序列出现。

边界事件的意义：

- `*_start`：创建 partial 内容块；
- `*_delta`：追加字符串或参数片段，适合实时 UI；
- `*_end`：该内容块结构完整，可做最终校验；
- `done/error`：整个 assistant 消息结束，流可关闭。

## 6. EventStream 的核心实现

[`event-stream.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/utils/event-stream.ts) 只有不到百行，却是理解整个项目异步流的好例子。

它的 `push` 逻辑可概括为：

    push(event):
      if 已结束: 忽略
      if event 是终止事件:
        标记 done
        解析并 resolve 最终结果
      if 有正在等待的消费者:
        直接交给最早 waiter
      else:
        放入 queue

异步迭代器逻辑：

    next:
      if queue 非空: 取出最早事件
      else if done: 返回
      else: 创建 Promise，把 resolver 放入 waiting

这同时正确处理两种时序：

1. 生产者快：事件先进入 queue，消费者稍后读取；
2. 消费者快：消费者先挂起，下一次 push 直接唤醒它。

`AssistantMessageEventStream` 只需告诉泛型基类：

- `done/error` 是完成条件；
- 如何从终止事件取得最终 `AssistantMessage`。

因此调用方既可实时消费，也可：

    const finalMessage = await stream.result();

## 7. 流如何重建最终消息

Provider 不应只发 delta 而没有完整最终状态。通常过程是：

1. 创建一个 partial `AssistantMessage`；
2. 收到 `text_start` 时添加文本块；
3. 每个 `text_delta` 追加内容，同时把 partial 状态发给上层；
4. 工具参数 delta 同样按 call/index 累积；
5. 收到 token usage、stop reason；
6. 发出 `done`，携带完整 message。

上层 UI 依赖 delta 获得低延迟；Agent 历史和 session 持久化依赖最终 message 获得一致结构。

## 8. Faux Provider：不用 API 也能验证事件语义

[`faux.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/providers/faux.ts) 提供确定性假 Provider。它可构造：

- 文本回复；
- thinking；
- 工具调用；
- 完整 assistant message；
- 与真实流相同的 start/delta/end/done 序列；
- abort 场景。

测试时使用 Faux 的价值：

- 无网络与费用；
- 不依赖真实模型是否“听话”；
- 事件序列完全可预测；
- 可精确制造 length、error、tool call 和 abort。

阅读 `streamWithDeltas`，对每类内容块列出事件，然后与 `AssistantMessageEvent` 联合类型逐一核对。

## 9. 一个事件消费者

coding-agent 的真实 SDK 示例 [`01-minimal.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/examples/sdk/01-minimal.ts) 中使用：

    session.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
    });

注意这里有两层事件：

1. coding-agent 的 `message_update`；
2. 内部携带的 AI `AssistantMessageEvent`。

这正是分层的体现：AI 包不知道 Session，而 Session 复用模型层的细粒度事件。

## 10. 常见误区

### 收到 text_end 就认为整个回复结束

错误。后面可能还有另一个内容块或工具调用；只有 done/error 终止整个流。

### 直接 JSON.stringify 厂商响应并向上传

这会让上层依赖某一 Provider。应在边界转成统一内容块、用量和 stopReason。

### 忽略 toolcall_delta

模型可能分片发送 JSON 参数。必须累积到完整结构后再验证和执行。

### 把 error 当作抛异常的唯一形式

流式系统常需发出可观察的 error 终止事件，以便 UI 得到最后状态并完成清理。

### 用真实模型写核心循环单元测试

真实模型不确定、慢且有费用。用 Faux 或自定义 `StreamFn` 驱动精确场景。

## 11. 动手练习

### 练习 A：手工实现最小事件流

不复制源码，自己实现一个 `EventStream<number, number>`：

- push 1、2、3；
- 3 是完成事件；
- `for await` 应看到三个值；
- `result()` 应得到 3；
- 分别测试“先 push”与“先 next”。

### 练习 B：追踪内容块

用 Faux 构造“thinking + text + 两个 toolCall”，记录所有事件。验证：

- 每个 contentIndex 是否稳定；
- start/end 是否成对；
- done 中完整 message 是否等于增量重建结果。

### 练习 C：Provider 设计评审

选择一个现有 Provider，回答：

1. 认证在哪里应用？
2. 厂商消息在哪里转成统一消息？
3. abort 传到了哪一层？
4. token usage 如何映射？
5. 不支持的内容类型如何处理？

先回答这些问题，再尝试新增 Provider。
