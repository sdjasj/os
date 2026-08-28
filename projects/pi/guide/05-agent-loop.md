# 05｜Agent 循环：从模型回复到工具执行

Agent 包把“单次模型完成”升级为“能反复调用工具的任务循环”。主文件是 [`agent-loop.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts)，状态门面是 [`agent.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent.ts)，契约在 [`types.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/types.ts)。

## 1. Agent 与 agentLoop 的分工

`Agent` 是有状态、面向使用者的类：

- 保存 `AgentState`；
- 提供 `prompt`、`continue`、`steer`、`followUp`、`abort`；
- 管理订阅者和待处理消息队列；
- 调用无 UI 假设的 loop 函数；
- 根据事件更新自己的消息和流式状态。

`agentLoop` 是一次运行的控制流程：

- 接收 prompt、上下文、配置、signal 和 `StreamFn`；
- 返回 `EventStream<AgentEvent, AgentMessage[]>`；
- 发出事件；
- 调模型、执行工具，直到应当结束。

把状态门面和循环函数分开，测试可直接驱动 loop，而产品代码可使用更方便的 Agent API。

## 2. StreamFn：Agent 与模型层的窄接口

Agent 不直接依赖某个 Provider。`StreamFn` 接收模型、`Context` 和选项，返回 AI 事件流。

这条边界允许：

- 生产环境注入 `Models.stream`；
- coding-agent 扩展在模型调用前后包裹行为；
- 测试注入确定性流；
- 不改 Agent loop 就切换 Provider。

阅读 [`types.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/types.ts) 中 `StreamFn`，再到 [SDK 工厂](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/sdk.ts) 看它如何被组装。

## 3. 启动阶段的事件顺序

`runAgentLoop` 会复制上下文，加入新 prompt，然后发：

    agent_start
    turn_start
    message_start(user)
    message_end(user)

随后进入 `runLoop`。复制数组很重要：循环可以追加消息，同时避免意外修改调用者传入的外层数组。

`agentLoopContinue` 用于上下文已有用户消息或工具结果的重试/继续。它拒绝空上下文，也拒绝从 assistant 作为最后消息直接继续，因为多数 Provider 要求下一次请求以 user/toolResult 边界结束。

## 4. 双层循环是控制流核心

`runLoop` 有两个循环：

    外层 while:
      负责 agent 本来要停止后到达的 follow-up

      内层 while:
        只要还有 tool call 或 steering 消息就继续
        注入 pending steering
        请求 assistant
        执行工具
        结束本 turn

为什么不能只有一个循环？

- 工具结果必须立即喂回模型，这是当前任务内部的连续推理；
- steering 是用户在运行过程中调整当前任务，应在下次模型调用前插入；
- follow-up 是当前任务结束后排队的新请求，语义上应开启后续工作。

双层结构把“继续当前工作”和“开始排队工作”分开。

## 5. 一个无工具调用的完整时序

    runAgentLoop
      emit agent_start
      emit turn_start
      emit message_start(user)
      emit message_end(user)

      streamAssistantResponse
        emit message_start(partial assistant)
        emit message_update(... text_delta ...)
        emit message_end(final assistant)

      emit turn_end(final assistant, [])
      检查 steering：无
      检查 follow-up：无
      emit agent_end(newMessages)

最终 `EventStream.result()` 得到本次新增消息，而不是整个旧上下文。

## 6. streamAssistantResponse 做了什么

这一函数是模型边界：

1. 可选调用 `transformContext`；
2. 用 `convertToLlm` 把可扩展 `AgentMessage` 转为 AI `Message[]`；
3. 构造 `Context`，附上 system prompt 和工具描述；
4. 调用 `streamFunction`；
5. `for await` 消费 AI 事件；
6. 把 partial assistant 包装为 Agent `message_update`；
7. 在终止时得到完整 assistant；
8. 将它加入当前上下文，并发 `message_end`。

`AgentMessage` 支持 TypeScript declaration merging。上层可定义自有消息类型，但在 LLM 调用前必须通过 `convertToLlm` 映射或过滤。这使 Agent 核心可扩展，又不要求 Provider 理解产品私有消息。

## 7. 工具调用的处理流程

模型回复中可能有多个 `toolCall` 内容块：

    assistant.content
      .filter(content => content.type === "toolCall")

对每个调用：

1. 按名称查找 `AgentTool`；
2. 若工具不存在，生成错误结果；
3. 用 TypeBox Schema 校验 arguments；
4. 发 `tool_execution_start`；
5. 调用工具的 `execute`；
6. `onUpdate` 发 `tool_execution_update`；
7. 完成或捕获异常；
8. 发 `tool_execution_end`；
9. 创建 `ToolResultMessage`；
10. 将结果加入上下文，下一 turn 再交给模型。

工具错误通常被转换为结果，而不是直接摧毁整个 agent loop。这样模型可看到错误并选择修正参数、换工具或向用户解释。

## 8. 并行与顺序执行

配置和工具都能影响执行模式：

- 若批次允许并行，多个独立工具可 `Promise.all` 式执行；
- 若全局配置要求顺序，按模型给出的顺序执行；
- 只要批次中某个工具声明需要 sequential，整个相关批次需避免危险并发。

为什么文件工具需要额外谨慎？

- 两次 edit 可能基于同一旧内容；
- write 与 read 的顺序会改变结果；
- bash 可能与文件操作竞争；
- 进度事件的到达顺序不等于工具调用数组顺序。

并行只提升独立工作的吞吐，不应破坏可观察语义。

## 9. length 是一个安全敏感停止原因

若模型因输出 token 上限停止，工具参数可能只生成了一半。源码选择：

    stopReason === "length"
      → 当前消息内所有 toolCall 都标记失败
      → 不执行任何可能被截断的参数

不能只尝试 JSON.parse 成功的调用，因为“语法完整”不代表语义未被截断。例如命令字符串可能恰好闭合，却缺少模型原本要追加的限制参数。

## 10. steering 与 follow-up

### steering

用户在 Agent 正忙时发来的指导，例如“先不要修改文件，只分析”。它在下一次 assistant 请求前注入当前内层循环。

### follow-up

当前工作本可结束时才取出的后续请求，例如“分析完成后再生成测试”。它使外层循环开始新的 turn。

两者由 `PendingMessageQueue` 和配置回调提供，并且可配置消息队列模式。阅读 [`agent.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent.ts) 时关注队列何时读取、何时清空。

## 11. abort 的传播

`Agent.abort()` 触发当前 `AbortController`。signal 传给：

- StreamFn/Provider 请求；
- 每个工具 `execute`；
- bash 子进程或其他底层可取消操作。

预期结果不是“程序突然消失”，而是：

- 当前 assistant 的 `stopReason` 体现 aborted；
- 发出 `turn_end`；
- 发出 `agent_end`；
- UI 的运行状态归零；
- 监听器和子进程得到清理。

测试 abort 时应覆盖三个时间点：模型首 token 前、文本流中、工具执行中。

## 12. AgentEvent 分类

生命周期：

    agent_start / agent_end
    turn_start / turn_end

消息：

    message_start / message_update / message_end

工具：

    tool_execution_start
    tool_execution_update
    tool_execution_end

观察者不应从零散事件自行猜测全局状态；`agent_end` 中的 messages 和 AgentState 是权威完成状态。

## 13. 终止条件

循环会在这些情况下结束或转移：

- assistant error/aborted：立即结束；
- 工具批次要求 terminate：结束工具连续循环；
- 没有工具调用且没有 steering：当前任务可停止；
- 有 steering：继续内层；
- 有 follow-up：继续外层；
- 无 follow-up：发 agent_end。

coding-agent 还可能在更上层执行重试、压缩或扩展 hook，因此“Agent loop 结束”不总等于整个 UI session 销毁。

## 14. 动手练习

### 练习 A：事件真值表

为下列场景列出精确事件顺序：

1. 纯文本；
2. 一个成功工具；
3. 工具 Schema 校验失败；
4. stopReason 为 length 且含两个工具；
5. 文本流中 abort。

再用自定义 StreamFn 运行并断言顺序。

### 练习 B：内存工具

实现 `add_note`：

- 参数为 `text: string`；
- 将内容追加到内存数组，不访问磁盘；
- update 报告当前笔记数；
- signal aborted 时返回或抛出一致错误；
- 使用 Faux Provider 先调用工具，再输出笔记列表。

### 练习 C：并发验证

创建两个带可控 Promise 的工具：

- 并行模式下，两者都应在任一 resolve 前启动；
- sequential 模式下，第二个只能在第一个结束后启动；
- 断言最终 tool result 的关联 ID 没有错位。

## 15. 读完本章应能解释

- 为什么 agent loop 接受 StreamFn 而不是直接接受 Provider；
- 为什么一次 prompt 会有多个 turn；
- 为什么工具错误通常成为消息而不是未捕获异常；
- steering 和 follow-up 的语义差异；
- 为什么 length 下所有工具调用都拒绝执行；
- abort 如何形成一致的最终事件，而不是只停止网络请求。
