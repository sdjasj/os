# 01. 背景知识：Coding Agent、工具调用、事件流与沙箱

在读 OpenHands 之前，必须先理解它在解决什么系统问题。传统聊天应用的核心是“消息进、文本出”；Coding Agent 的核心则是“目标进、反复观察与行动、工作区发生变化、结果和过程都可追踪”。

## 从一次补丁任务看 Agent 循环

假设用户要求“修复登录页的空指针并添加测试”。一个最小循环是：

```text
用户目标
  -> 模型读取上下文
  -> 选择工具（搜索/读文件/执行测试/编辑）
  -> 环境执行工具
  -> 返回 observation
  -> 模型结合新 observation 再推理
  -> ...
  -> FinishAction
```

这个循环常被称为 ReAct 风格：Reason（推理）与 Act（行动）交替。工程实现不能只保存最后一句回答，因为：

- 工具可能失败，需要把错误反馈给模型；
- 用户需要看到做过哪些动作；
- 系统需要恢复被暂停的会话；
- 评测和审计需要完整轨迹；
- UI 需要实时显示流式文本、命令和文件变化。

因此 OpenHands 把一次会话表示为一系列有类型的事件。

## Action、Observation 与 Message

可以把事件分为三类：

```text
MessageEvent      用户或助手的自然语言消息
ActionEvent       Agent 请求执行某个动作
ObservationEvent  环境返回动作结果，通常关联 action_id
```

前端 `handleEventForUI` 展示了一个很有代表性的规则：当 Observation 到达时，它会查找 `event.action_id` 对应的 Action，并在 UI 数组中用 Observation 替换 Action。原因是卡片最终更需要展示“命令及其结果”，而不是两张重复卡片。

简化后的逻辑如下：

```typescript
if (isObservationEvent(event)) {
  const actionIndex = newUiEvents.findIndex(
    (uiEvent) => uiEvent.id === event.action_id,
  );
  if (actionIndex !== -1) newUiEvents[actionIndex] = event;
  else newUiEvents.push(event);
}
```

注意：这是 UI 投影规则，不会删掉后端的原始事件。`events` 与 `uiEvents` 分开，正是“事实日志”和“显示模型”分离的例子。

## 为什么需要事件溯源思维

事件溯源（event sourcing）的核心不是“用了 Kafka”，而是把发生过的事实按顺序记录，再从事实计算当前状态。OpenHands 不一定在每个模块都采用严格事件溯源，但你用这种思维阅读会更容易：

```text
事实：用户发送消息
事实：Agent 开始运行
事实：调用 Bash 工具
事实：Bash 返回退出码 1
事实：Agent 再次编辑文件
事实：Agent 完成

投影 A：聊天消息列表
投影 B：当前 AgentState
投影 C：总 token/cost 指标
投影 D：可导出的 trajectory
```

同一组事件可以投影出不同 UI。也正因如此，实时增量事件、最终持久事件和指标事件可能交错到达，前端必须排序、去重和合并。

## 流式输出不是最终事实

模型生成一句话时，前端希望逐 token 显示；但持久化通常保存最终 Message 或 Action。于是会出现两条数据路径：

```text
StreamingDeltaEvent  -> 低延迟预览，可能不持久化
最终 Message/Action  -> 稳定事实，可回放和导出
```

如果 UI 简单追加两者，用户会看到重复消息。OpenHands 的 `finalizeStreamingDeltasInPlace` 会尝试把最终文本与已显示的 delta 对齐：能对齐就保留增长中的 delta 作为最终气泡；不能对齐就删除预览并显示最终事件。

这揭示了实时系统的一条通用原则：

> 预览优化延迟，最终事件保证正确性；两者必须有显式 reconciliation（对账）策略。

## 为什么 Agent 必须在 Sandbox 中执行

Coding Agent 需要运行 shell、读写文件、启动服务。让它直接在 App Server 宿主机执行，等于把模型输出变成高权限命令。Sandbox 的目标不是让所有代码“绝对安全”，而是缩小影响范围：

- 文件系统限制在工作区或容器；
- 进程和网络可以独立管理；
- 每个会话或用户可拥有隔离环境；
- 暂停、恢复、销毁不影响 App Server；
- Agent Server 在 Sandbox 内提供受控 API。

当前 `SandboxStatus` 包含：

```python
class SandboxStatus(Enum):
    STARTING = 'STARTING'
    RUNNING = 'RUNNING'
    PAUSED = 'PAUSED'
    ERROR = 'ERROR'
    MISSING = 'MISSING'
```

这里最容易误解的是 `MISSING`：它并非普通“停止”，而是 Sandbox 已不存在，通常意味着会话进入归档只读状态。前端会据此切换为 `ArchivedConversationView`。

## App Server 与 Agent Server 为什么分开

把二者分开可以明确职责和伸缩边界：

| App Server | Agent Server |
| --- | --- |
| 用户身份与设置 | Agent 运行循环 |
| 会话元数据 | Workspace 和工具 |
| 选择/创建 Sandbox | 对话实时事件 |
| Enterprise 组织权限 | LLM/Agent 配置执行 |
| 对外统一 API | Sandbox 内部执行 API |

App Server 通过 Sandbox 的 `exposed_urls` 找到名为 `AGENT_SERVER` 的地址，并用 `X-Session-API-Key` 调用它。浏览器在得到经过授权的会话信息后，也会连接对应的实时端点。

## LLM、Agent、Tool、Workspace 的区别

这几个词很容易混用：

- LLM：把消息和工具描述转换成文本或工具调用的模型客户端。
- Agent：决定如何组织上下文、何时调用模型、如何解释输出和何时结束。
- Tool：Agent 可调用的能力，如 shell、文件编辑、浏览器或 MCP 工具。
- Workspace：工具作用的工作目录及文件/命令接口。
- Agent Server：承载 Agent、Workspace 与实时协议的服务进程。
- Sandbox：承载 Agent Server 及其工作负载的隔离环境。

层次关系可以近似画成：

```text
Sandbox
└── Agent Server
    └── Conversation
        ├── Agent
        │   └── LLM
        ├── Tools
        ├── Workspace
        └── Events
```

真实实现会因 ACP Agent、子 Agent、MCP 和共享 Sandbox 策略而更复杂，但这张图足够支撑前几章。

## ACP 是什么，为什么代码里有两条路径

ACP（Agent Client Protocol）让 OpenHands 连接 Claude Code、Codex、Gemini CLI 等外部 Agent。普通 OpenHands Agent 路径由 SDK LLM 和工具驱动；ACP 路径更像启动并管理一个外部 Agent provider。

在 `live_status_app_conversation_service.py` 中，两条路径最终都会构造 `StartConversationRequest`，但：

- OpenHands Agent 使用用户解析后的 LLM 配置；
- ACP Agent 清理不应泄漏给子进程的 LLM proxy 字段；
- ACP 的 secret 必须适配子进程环境；
- 两者仍共享 conversation settings、workspace、plugin、观测元数据等概念。

学习时先掌握普通路径，再把 ACP 视为同一会话协议下的另一种 Agent 实现。

## MCP、Skill 与 Plugin 的位置

三者也不是同一个东西：

- MCP Server：通过标准协议提供工具或资源的服务。
- Skill：给 Agent 的领域流程和操作说明，可能按关键词或任务触发。
- Plugin：可组合的能力包，可能包含 Skill、MCP 配置和其他资源。

会话启动服务会读取用户设置、workspace、marketplace 和请求参数，将适用的配置装入 Agent 启动请求。它们最终影响 Agent 能看到什么工具和指令，但所有权和加载时机不同。

## 安全不是一个开关，而是多层约束

至少包括：

```text
身份层     用户 cookie/Bearer/API key
会话层     conversation 所有权和组织权限
Sandbox层  X-Session-API-Key 与 Sandbox owner 校验
密钥层     SecretSource、掩码、按需解析
执行层     容器/远端 runtime 隔离
展示层     错误和日志脱敏
```

例如 `SandboxService.wait_for_sandbox_running` 会记录原始 runtime `status_detail` 供运维排查，但只向用户返回分类后的安全消息，避免暴露 registry host、secret 名、node label 等基础设施细节。

## 本章实验：把一个工具调用投影成 UI

假设事件依次到达：

```text
1. User Message(id=u1)
2. StreamingDelta(id=d1, content="我先检查")
3. Action(id=a1, kind=CmdRun, thought="我先检查")
4. Observation(id=o1, action_id=a1, exit_code=0)
5. FinishAction(id=f1, message="修复完成")
```

请分别写出：

1. 原始事实数组 `events` 应保留哪些事件；
2. `uiEvents` 在第 3、4、5 步后大致显示什么；
3. 如果第 2 步比第 4 步更晚到达，为什么应把它视为 stale delta。

第 09 章会用真实前端代码回答。

## 常见误区

- 认为 Agent 等于 LLM。Agent 还包含循环、上下文、工具、结束条件和恢复逻辑。
- 认为 Sandbox 能替代所有权限校验。Sandbox 隔离执行，但请求仍需身份与所有权校验。
- 认为流式 delta 就是最终消息。它只是低延迟预览。
- 认为 UI 中 Action 被 Observation 替换意味着后端删除了 Action。
- 把 MCP、Skill、Plugin 都称为“工具”，从而看不清加载和配置边界。

## 自测

1. 为什么一个 Coding Agent 需要 Observation？
2. 为什么 `MISSING` 不应和 `PAUSED` 使用同一个 UI？
3. 流式预览与最终事件发生冲突时，谁应成为权威？
4. App Server 为什么不直接在自己的进程里执行 shell？
5. ACP 路径与普通 Agent 路径的共同协议是什么？

## 源码定位

- [Sandbox 状态模型](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/sandbox/sandbox_models.py)
- [前端事件投影](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/utils/handle-event-for-ui.ts)
- [事件 Store](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/stores/use-event-store.ts)
- [会话启动实现](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/app_conversation/live_status_app_conversation_service.py)

下一章把这些概念放回仓库目录和真实进程拓扑中。
