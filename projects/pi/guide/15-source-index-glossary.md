# 15｜源码索引、术语表与官方资料

本章用于日常反查。路径对应提交 `4e49492`；版本变化后用符号名搜索。

## 1. 按问题找源码

| 我想知道…… | 首选源码 |
| --- | --- |
| 消息、内容块、usage、stopReason 长什么样 | [AI types](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/types.ts) |
| 流事件如何同时支持 for-await 和最终 result | [EventStream](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/utils/event-stream.ts) |
| 模型和 Provider 如何注册、认证、调用 | [models.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/models.ts) |
| 如何无网络模拟模型 | [faux.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/providers/faux.ts) |
| AgentTool、AgentEvent、StreamFn 契约 | [Agent types](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/types.ts) |
| 为什么会多次调用模型 | [agent-loop.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts) |
| prompt/steer/followUp/abort 的状态门面 | [agent.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent.ts) |
| 组件最小接口、invalidate 和调度 | [tui.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/tui.ts) |
| 普通屏幕怎样差量重绘 | [tui-main-screen.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/tui-main-screen.ts) |
| 全屏、滚动、选择如何实现 | [tui-alt-screen.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/tui-alt-screen.ts) |
| VStack/HStack/ScrollView 布局 | [layout.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/layout.ts) |
| CLI 从哪里开始 | [cli.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/cli.ts) |
| 启动怎样选择模式和构建服务 | [main.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/main.ts) |
| 所有依赖在哪里组装 | [sdk.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/sdk.ts) |
| 一条 prompt 的产品流水线 | [agent-session.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts) |
| 会话条目和树 | [session-manager.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/session-manager.ts) |
| 压缩阈值、切点、摘要 | [compaction.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/compaction/compaction.ts) |
| 项目上下文、技能、扩展怎样发现 | [resource-loader.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/resource-loader.ts) |
| 扩展有哪些 hook 与返回值 | [extension types](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/extensions/types.ts) |
| read 文本/图片/截断 | [read.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools/read.ts) |
| write 和取消 | [write.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools/write.ts) |
| 精确替换、BOM、换行、diff | [edit.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools/edit.ts) |
| bash 子进程、timeout、输出 | [bash.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools/bash.ts) |
| 同文件修改为何串行 | [file-mutation-queue.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools/file-mutation-queue.ts) |
| telemetry 契约 | [telemetry package](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/telemetry) |
| SQLite session repository | [sqlite-node](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/session-backends/sqlite-node) |
| 二进制协议 Schema | [protocol schemas](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/protocol/src/schemas.ts) |
| 长度前缀如何解码 | [framing.ts](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/protocol/src/framing.ts) |
| 远程 client lease | [client README](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/client/README.md) |
| server service/transport 边界 | [server README](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/server/README.md) |

## 2. 按调用链找断点

### CLI 主路径

    coding-agent/src/cli.ts
      → main.ts: main
      → core/sdk.ts: createAgentSession
      → core/agent-session.ts: constructor

### Prompt 主路径

    AgentSession.prompt
      → Agent.prompt
      → agentLoop / runAgentLoop
      → runLoop
      → streamAssistantResponse
      → StreamFn
      → ModelRuntime / Models.stream
      → Provider.stream

### 工具主路径

    assistant ToolCall
      → executeToolCalls
      → validateToolArguments
      → extension tool_call hook/wrapper
      → AgentTool.execute
      → onUpdate
      → ToolResultMessage
      → next model turn

### 持久化主路径

    AgentEvent message_end
      → AgentSession._handleAgentEvent
      → SessionManager.appendMessage
      → append-only JSONL / backend
      → buildSessionPath
      → buildContextEntries
      → buildSessionContext

### TUI 主路径

    AgentSessionEvent
      → interactive component state
      → invalidate
      → requestRender
      → doRender
      → old/new line diff or LayoutFrame
      → synchronized ANSI output

## 3. 重要不变量清单

阅读或修改代码时用它做评审：

- 一个模型流最终必须有 done/error；
- delta 驱动展示，完整消息进入历史；
- ToolResult 的 ID 必须匹配原 ToolCall；
- length 截断的工具参数不执行；
- abort signal 一路传播到实际边界；
- 工具异常转换为模型可见的错误结果；
- 同文件 mutation 不并发，锁持有到实际 I/O settled；
- session 旧条目不可变，当前上下文由 leaf 路径构造；
- custom entry 不进入模型，custom message 才进入；
- compaction 不删除原始历史，只改变模型视图；
- telemetry 失败不改变业务结果；
- progress event 不覆盖权威 snapshot；
- transport 认证在协议字节前完成；
- TUI cell 宽度不能用 string.length；
- 无 UI 的扩展不能假设 confirm 存在；
- dispose 后不再接收资源/会话事件。

## 4. 术语表

### Agent

持有模型、消息、工具和运行状态的代理门面；调用 agent loop 并向订阅者发事件。

### Agent loop

反复执行“请求模型—发现工具—执行工具—回填结果”的控制循环。

### AgentMessage

Agent 层可扩展的消息联合。送入 Provider 前通过 `convertToLlm` 转成 AI `Message`。

### AssistantMessageEvent

模型流的细粒度事件，包括 text/thinking/toolcall start/delta/end 与 done/error。

### AgentEvent

Agent 运行事件，包括 agent/turn/message/tool 生命周期。

### Provider

把某个模型服务的请求、流、认证和结果转换为 Pi 统一 AI 类型的适配器。

### ModelRuntime / Models

发现模型、认证并调用 Provider 的运行时/门面。

### StreamFn

Agent 与模型层之间的窄函数接口，便于包装与测试替换。

### Tool / AgentTool / ToolDefinition

从模型 Schema，到 Agent execute 契约，再到 coding-agent UI/prompt 元数据的逐层工具定义。

### turn

一次模型响应和相关工具处理边界。一个用户请求可能有多个 turn。

### steering

Agent 运行中加入、在当前任务下一次模型调用前交付的指导消息。

### follow-up

当前任务已准备停止后再开始处理的排队消息。

### AgentSession

产品编排对象，组合 Agent、模型、工具、扩展、会话、压缩和事件。

### AgentSessionRuntime

拥有可替换的 AgentSession，用于 new/resume/fork/import 和 cwd-bound runtime 重建。

### SessionManager

维护 append-only 会话条目、ID 索引、当前 leaf 和上下文重建。

### leaf

当前分支最末条目。沿 parentId 回溯得到当前会话路径。

### JSONL

一行一个 JSON 值的记录格式。Pi RPC 与 session 都用 JSONL，但 schema 和 framing 规则不同。

### compaction

将较旧上下文总结并保留最近原文，以控制模型 token 占用。

### branch summary

分支导航/分叉时对被离开工作生成的摘要。

### ResourceLoader

发现并加载上下文文件、扩展、技能、模板、主题和 packages 的产品服务。

### Extension

可执行模块，通过 ExtensionAPI 注册工具、命令、快捷键、事件和 UI。

### Skill

按任务需要加载的一组流程知识与相关资源，通常由 `SKILL.md` 作为入口。

### Prompt template

可参数化展开的提示文本。

### project trust

是否允许项目提供的 Pi 资源尤其是可执行扩展被加载；不是操作系统沙箱。

### Component

TUI 中按宽度返回字符串行、可选处理输入并支持 invalidate 的渲染单元。

### alternate screen

终端备用全屏缓冲，退出后恢复原主屏幕。

### cell width

文本在终端网格中占用的列数，与 JavaScript 字符串长度不同。

### TelemetryContext / Span

显式传播的诊断上下文和有生命周期的操作记录。

### CBOR

紧凑二进制对象编码。实验性远程协议使用严格 definite-length 子集。

### frame

四字节大端长度加 CBOR payload 的一个协议记录。

### authoritative snapshot

服务端发布的权威状态；客户端应替换本地缓存，而不是从 progress 猜测。

### lease

远程 client 对 session 的 shared/exclusive 使用权对象，释放最后一个 lease 后 detach。

## 5. 官方文档导航

- [Latest 文档首页](https://pi.dev/docs/latest/)
- [Quickstart](https://pi.dev/docs/latest/quickstart)
- [Usage](https://pi.dev/docs/latest/usage)
- [Development](https://pi.dev/docs/latest/development)
- [SDK](https://pi.dev/docs/latest/sdk)
- [RPC](https://pi.dev/docs/latest/rpc)
- [Extensions](https://pi.dev/docs/latest/extensions)
- [Packages](https://pi.dev/docs/latest/packages)
- [Session format](https://pi.dev/docs/latest/session-format)
- [Compaction](https://pi.dev/docs/latest/compaction)
- [Environment variables](https://pi.dev/docs/latest/environment-variables)
- [Security](https://pi.dev/docs/latest/security)
- [GitHub 仓库](https://github.com/earendil-works/pi)

## 6. 仓库自带资料

- [根 README](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/README.md)
- [开发约定 AGENTS.md](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/AGENTS.md)
- [Coding Agent README](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/README.md)
- [SDK 文档](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/sdk.md)
- [RPC 文档](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/docs/rpc.md)
- [扩展示例](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/examples/extensions)
- [SDK 示例](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/examples/sdk)
- [TUI README](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/README.md)
- [Protocol README](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/protocol/README.md)

## 7. 版本漂移检查

更新源码后运行：

    git log -1 --format='%H %cI %s'
    rg 'CURRENT_SESSION_VERSION|PROTOCOL_VERSION' packages
    rg '"version"' packages/*/package.json
    rg 'defaultActiveToolNames' packages/coding-agent/src
    rg 'DEFAULT_COMPACTION_SETTINGS' packages/coding-agent/src

重点检查：

- 包是否新增/改名；
- 默认工具变化；
- AgentEvent/AssistantMessageEvent 新分支；
- session/protocol version；
- compaction 默认值；
- CLI 模式；
- experimental 标记；
- extension hook 返回类型。

教程与新版本冲突时，以类型、测试和当前官方文档为准。

## 8. 闭卷自测

不用教程，在白纸上画：

1. 一条 prompt 的完整调用链；
2. 有一个工具调用时的事件时序；
3. 一个含两个分支和 compaction 的 session 树；
4. SDK、RPC、remote protocol 的选择表；
5. 项目信任、工具 hook、OS 权限和沙箱的边界。

然后用本章索引在源码中逐项验证。能快速找到证据，比背住实现细节更重要。
