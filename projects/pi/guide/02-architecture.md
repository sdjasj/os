# 02｜总体架构：从包依赖到一次完整请求

## 1. 先看全局，而不是先看 CLI

Pi 的核心设计是把“可复用机制”与“具体产品”分开。当前源码快照比早期文档中的四包结构更丰富：

    @earendil-works/pi-telemetry
                  │
                  ▼
         @earendil-works/pi-ai
                  │
                  ▼
    @earendil-works/pi-agent-core
             │               │
             │               └──── sqlite session backend
             ▼
    @earendil-works/pi-coding-agent ◀──── @earendil-works/pi-tui
             │
             ├──── @earendil-works/pi-protocol
             └──── @earendil-works/pi-client

    @earendil-works/pi-server ──── ai + protocol

图中省略了少量开发依赖。协议、客户端和服务端属于较新的实验性远程栈，阅读时不要误以为它们是本地 CLI 主路径的必经层。

## 2. 各包的职责与边界

### telemetry：只定义可观测性语言

目录：[`packages/telemetry`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/telemetry)

提供 span、属性、事件和内存/空实现。它不绑定某个可观测平台，使底层包可记录行为但不强迫使用者安装特定后端。

### ai：统一模型世界

目录：[`packages/ai`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai)

职责：

- 定义消息、内容块、模型、用量、停止原因；
- 定义流式事件；
- 统一不同厂商 Provider；
- 处理模型发现、认证和成本信息；
- 提供可确定测试的 Faux Provider。

它不决定何时再次请求模型，也不执行工具。

### agent：模型之上的控制循环

目录：[`packages/agent`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent)

职责：

- 保存当前 Agent 状态；
- 接受 prompt、steer、follow-up；
- 调用注入的 `StreamFn`；
- 校验并执行工具；
- 发出生命周期和工具事件；
- 传播 abort。

它不关心终端、会话文件或扩展目录。

### tui：与业务无关的终端 UI

目录：[`packages/tui`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui)

组件只需按宽度渲染字符串行，并可选地处理输入。该包负责焦点、光标、覆盖层、差量重绘、备用屏幕、滚动和布局。

### coding-agent：产品编排层

目录：[`packages/coding-agent`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent)

这是 `pi` 命令的主要实现：

- 解析 CLI 参数和运行模式；
- 加载设置、模型、项目上下文和扩展；
- 创建内置工具；
- 管理会话、分支、压缩与自动重试；
- 把 AgentEvent 交给 interactive、print、JSON 或 RPC 模式。

若你只从这里开始读，会觉得代码非常多；先掌握 ai 和 agent 后，它会变成“组合已有机制”。

### protocol/client/server：实验性远程控制面

目录：

- [`packages/protocol`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/protocol)
- [`packages/client`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/client)
- [`packages/server`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/server)

它们用长度前缀 + CBOR 定义远程会话命令、响应、事件和权威状态快照。当前 README 明确标记为实验性，不应将其 API 稳定性等同于核心本地路径。

### session backend：可替换的持久化

[`packages/session-backends/sqlite-node`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/session-backends/sqlite-node) 提供 Node SQLite 会话实现，展示产品可以把会话接口映射到不同存储，而不改变 Agent loop。

## 3. 一条 prompt 的端到端调用链

核心路径如下：

    packages/coding-agent/src/cli.ts
      └─ main()
          ├─ 解析参数、设置、信任和资源
          ├─ createAgentSession()
          │   ├─ 创建 ModelRuntime / SessionManager / ResourceLoader
          │   ├─ 创建内置工具
          │   ├─ new Agent(...)
          │   └─ new AgentSession(...)
          └─ 根据模式启动 interactive / print / json / rpc

    AgentSession.prompt(input)
      ├─ 处理扩展命令与 input hook
      ├─ 展开 skill / prompt template
      ├─ 检查模型和认证
      ├─ 必要时执行 compaction
      ├─ 注入下一轮上下文和 system prompt
      └─ Agent.prompt(message)

    Agent
      └─ agentLoop(...)
          ├─ streamAssistantResponse()
          │   └─ Models.stream()
          │       └─ Provider.stream()
          ├─ 累积 text/thinking/toolcall delta
          ├─ executeToolCalls()
          └─ 根据结果继续下一 turn 或结束

    AgentEvent
      └─ AgentSession._handleAgentEvent()
          ├─ 先交给 extension runner
          ├─ 再通知 UI / JSON / RPC 监听器
          └─ 在 message_end 等边界写入 SessionManager

这是整套教程最重要的一张图。后续每章都只是在放大其中一个框。

## 4. 为什么有三层“状态”

### AgentState：正在运行的模型状态

包含模型、system prompt、工具、消息、流式状态、错误和运行标志。它需要支持 UI 实时订阅。

### AgentSession：产品级编排状态

除 AgentState 外，还知道：

- 当前持久化会话；
- 设置与模型注册表；
- 扩展、技能和资源；
- compaction/retry；
- 等待下一 turn 注入的消息；
- UI 需要的产品事件。

### SessionManager：持久化树状态

知道所有 JSONL 条目、`id → entry` 索引和当前 `leafId`。它不应负责调用模型。

分层避免一个“万能 Session”同时处理网络、模型、磁盘、UI 和扩展。

## 5. 消息与事件的双通道

一次流式响应同时产生两类输出：

    Provider 增量事件
       │
       ├─ 更新内存中的 partial AssistantMessage
       └─ 转换为 AgentEvent，驱动 UI

    Provider done/error
       │
       ├─ 得到最终 AssistantMessage
       ├─ 加入 Agent 消息历史
       └─ 在 message_end 时由 AgentSession 持久化

“事件先用于观察，最终消息再用于记忆”是一个关键不变量。如果 UI 直接把每个 delta 当成会话消息，恢复会话时将无法得到干净结构。

## 6. 正常路径、工具路径和错误路径

### 无工具调用

    user message
      → assistant text streaming
      → stopReason = stop
      → turn_end
      → agent_end

### 有工具调用

    user message
      → assistant toolCall
      → schema validation
      → tool_execution_start/update/end
      → tool result message
      → 再次请求模型
      → assistant final text

工具调用会令同一用户请求产生多个 turn。

### 模型或工具失败

- Provider 错误会产生 `error` 终止事件和带错误信息的 assistant 状态；
- 工具参数无效时不会调用工具实现，而是生成失败的 tool result；
- 工具抛错也转换为 tool result，使模型有机会解释或修正；
- abort 应停止当前流和可取消的工具，并走一致的清理路径；
- coding-agent 还可根据设置处理重试和上下文溢出。

## 7. 设计原则如何体现在代码中

### 小核心

Agent loop 不内置特定工作流。plan mode、确认策略或任务列表可以通过扩展实现。

### 可替换边界

模型通过 Provider/StreamFn，文件通过 Operations，远程通信通过 Transport，可观测性通过 TelemetryContext 注入。

### 结构化数据优先

模型消息、工具参数、事件、会话条目和协议帧都有明确类型，避免依赖无法验证的自由文本约定。

### 事件驱动

慢操作发增量事件，UI 和上层应用可以观察，而核心循环仍只关注状态转移。

### append-only 历史

会话的旧条目不变，分支和摘要作为新条目加入，因此恢复与调试更可解释。

## 8. 建议的第一次源码漫游

按下列顺序打开文件，每个文件只回答一个问题：

1. [AI 类型](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/types.ts)：模型层到底传递什么？
2. [事件流](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/utils/event-stream.ts)：增量与最终结果怎样共存？
3. [Agent 类型](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/types.ts)：工具和 AgentEvent 的契约是什么？
4. [Agent loop](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts)：哪些条件会再次请求模型？
5. [SDK 工厂](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/sdk.ts)：各个对象在哪里组装？
6. [AgentSession](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts)：产品逻辑在哪些事件边界介入？
7. [SessionManager](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/session-manager.ts)：消息如何落盘与恢复？
8. [TUI](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/tui.ts)：业务状态最终如何成为终端行？

第一次不要深入每个 Provider 和每个 TUI 组件；先确保主链条不断。

## 9. 架构练习

### 练习 A：给代码找归属

判断以下能力应主要放在哪一层，并解释原因：

1. 新增一个模型厂商；
2. 实现“危险 bash 命令必须确认”；
3. 改进终端宽字符截断；
4. 把会话存入 PostgreSQL；
5. 新增 `tool_execution_update` 事件；
6. 实现网页客户端的断线重连。

参考思路：优先放在拥有该抽象的最低层；用户偏好的策略通常做成扩展，而非塞入 Agent 核心。

### 练习 B：画三条时序图

分别为以下情况画出对象交互：

- 模型只返回文本；
- 模型调用两个可并行工具；
- 用户在工具执行中 abort。

每张图至少包含 `AgentSession`、`Agent`、`Provider`、tool 和一个事件订阅者。

### 练习 C：验证当前包图

查看各包 `package.json`：

    rg '"@earendil-works/pi-' packages/*/package.json packages/session-backends/*/package.json

将运行时依赖和开发依赖分开，检查本章的简化依赖图省略了哪些边。
