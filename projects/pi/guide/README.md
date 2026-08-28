# Pi 项目源码学习教程

这套教程用于系统学习 [Pi](https://pi.dev/docs/latest/)：一个以“小内核 + 可扩展机制”为核心的终端编程代理。教程不只讲如何使用 Pi，还会沿着真实源码解释一次提示词如何经过模型、代理循环、工具、会话存储和终端界面。

## 教程对应的源码快照

- 本地源码：`../pi-mono/`
- 上游仓库：[earendil-works/pi](https://github.com/earendil-works/pi)
- 教程基线提交：`4e494929998d6bc4fccf75e0a233f727db4b70ee`（短哈希 `4e49492`）
- 提交时间：2026-08-27
- npm 包版本：`0.84.3`
- 文档入口：[pi.dev/docs/latest](https://pi.dev/docs/latest/)

源码仍在持续演进。本文中的文件链接和行号以这个提交为准；如果你拉取了更新版本，优先按函数名和类型名搜索。

## 你最终会理解什么

完成教程后，你应该能够回答下面这些问题：

1. Pi 为什么把模型适配、代理循环、TUI 和产品层拆成不同包？
2. 一条用户消息如何从 CLI 进入 `AgentSession`，再进入 `agentLoop`？
3. 模型流式事件如何被还原为完整 `AssistantMessage`？
4. 工具参数为何既要有 TypeScript 类型，又要有运行时 Schema？
5. 工具调用如何校验、并行执行、流式汇报进度，并响应取消？
6. 会话为何使用 append-only JSONL，分支为什么只需移动叶子指针？
7. 压缩如何在上下文窗口耗尽前保留“过去的摘要”和“最近的原文”？
8. 普通 TUI 为什么可以只重绘变化的行？全屏 TUI 又为何需要布局树？
9. 扩展、技能、提示模板、主题和包分别解决哪一层定制问题？
10. SDK、RPC 和实验性的 CBOR 协议各适合什么集成场景？

## 推荐学习顺序

第一次阅读请按顺序进行。每个模块都包含背景知识、源码入口、调用链、代码解读和练习。

| 阶段 | 模块 | 目标 |
| --- | --- | --- |
| 导航 | [00 学习指南](./00-study-guide.md) | 建立学习节奏、准备环境、掌握源码阅读方法 |
| 基础 | [01 背景知识](./01-background.md) | 补足 ESM、异步迭代器、TypeBox、事件流、终端渲染等前置知识 |
| 全局 | [02 总体架构](./02-architecture.md) | 看懂包依赖图和一条提示词的端到端路径 |
| 工程 | [03 开发环境](./03-development.md) | 安装、构建、运行、调试与安全地做实验 |
| 模型层 | [04 AI 层](./04-ai-layer.md) | 理解消息、模型、Provider、认证和流式事件 |
| 循环层 | [05 Agent 循环](./05-agent-loop.md) | 理解 turn、工具调用、steering、follow-up 与取消 |
| 界面层 | [06 TUI](./06-tui.md) | 理解组件、差量重绘、全屏布局与输入 |
| 产品层 | [07 Coding Agent](./07-coding-agent.md) | 理解 CLI、SDK 工厂、AgentSession 和运行模式 |
| 工具层 | [08 内置工具](./08-tools.md) | 深入 read/write/edit/bash 与文件并发控制 |
| 定制层 | [09 资源与扩展](./09-resources-extensions.md) | 理解资源发现、项目信任、扩展事件与自定义工具 |
| 记忆层 | [10 会话与压缩](./10-sessions-compaction.md) | 理解 JSONL 树、分支、上下文重建和 compaction |
| 运维层 | [11 可观测性与存储](./11-observability-storage.md) | 理解 telemetry 抽象与 SQLite 会话后端 |
| 集成层 | [12 SDK、RPC 与协议](./12-sdk-rpc-protocol.md) | 选择嵌入、进程通信或远程客户端方案 |
| 质量层 | [13 测试与调试](./13-testing-debugging.md) | 用 Faux Provider、事件断言和分层测试定位问题 |
| 实战 | [14 渐进式项目](./14-learning-projects.md) | 完成四个由小到大的源码实践 |
| 查询 | [15 源码索引与术语表](./15-source-index-glossary.md) | 按问题快速找到文件、类型和官方文档 |

## 两种使用方式

### 快速理解

如果你只有半天：

1. 阅读 01、02；
2. 精读 04 中的事件流；
3. 精读 05 中的双层循环；
4. 阅读 07 中的 `createAgentSession → AgentSession.prompt`；
5. 用 15 的索引在源码中跳转。

### 深入掌握

如果目标是为项目贡献代码：

1. 按 00 的四周路线完成所有模块；
2. 每读一章就在本地设置断点或增加临时日志验证调用链；
3. 至少完成 14 中前两个项目；
4. 修改前阅读 [`pi-mono/AGENTS.md`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/AGENTS.md)，遵循仓库自己的开发约定；
5. 提交前运行与改动范围相称的检查和测试。

## 阅读代码时的统一记号

- “消息”是进入模型上下文的数据，例如 `UserMessage`、`AssistantMessage`。
- “事件”是运行过程中供观察者消费的瞬时通知，例如 `text_delta`、`tool_execution_update`。
- “turn” 是一次模型响应及其工具执行；一个用户请求可能包含多个 turn。
- “session” 是可持久化、可分支的一段长期交互。
- “核心路径”指 `CLI → createAgentSession → AgentSession → Agent → agentLoop → Models/Provider`。

## 安全提醒

Pi 的内置 bash、write 和 edit 工具以当前用户权限运行。项目信任机制决定是否加载项目内的扩展和配置，但它不是操作系统级沙箱。学习时建议使用单独的练习目录、测试仓库或容器，不要让实验命令接触重要文件和凭据。
