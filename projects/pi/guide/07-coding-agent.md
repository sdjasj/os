# 07｜Coding Agent：CLI、SDK 工厂与 AgentSession

`coding-agent` 是产品层。它不重新实现模型流或 Agent loop，而是把设置、资源、工具、会话、扩展和界面组装成用户实际运行的 `pi`。

核心入口：

- [CLI 入口](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/cli.ts)
- [main](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/main.ts)
- [SDK 工厂](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/sdk.ts)
- [AgentSession](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts)

## 1. 从 cli.ts 到 main

`cli.ts` 刻意很薄：完成少量进程环境准备，再调用 `main`。绝大多数启动逻辑放在可测试的 `main.ts`。

`main` 的宏观阶段：

    解析 CLI 参数与模式
      → 执行必要迁移
      → 创建 SettingsManager
      → 选择/恢复 SessionManager
      → 检查项目资源信任
      → 创建 ResourceLoader 并加载资源
      → 创建模型运行时和模型作用域
      → createAgentSession
      → 启动 interactive / print / RPC 等模式

启动顺序很重要：模型选择依赖设置和认证；Session 恢复又可能指定上次模型；扩展和工具要在 AgentSession 可用前完成绑定。

## 2. createAgentSession 是组合根

“组合根”指应用中集中创建具体实现并把依赖连接起来的位置。[`createAgentSession`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/sdk.ts) 正是如此。

它的主要输入可包括：

- `cwd`、`agentDir`；
- 明确指定的模型、thinking level；
- 自定义 `SessionManager`、`SettingsManager`、`ResourceLoader`；
- 自定义工具或工具白/黑名单；
- 模型运行时；
- 会话启动事件。

默认构造过程：

    cwd / agentDir
      ├─ ModelRuntime
      ├─ SettingsManager
      ├─ SessionManager
      └─ DefaultResourceLoader.reload()

    恢复已有会话的 model / thinking
      或按设置选择初始模型

    确定默认工具：
      read, bash, edit, write

    new Agent(...)
      ├─ convertToLlm
      ├─ streamFn → modelRuntime.streamSimple
      ├─ extension provider hooks
      ├─ transformContext
      └─ steering/follow-up/retry 设置

    new AgentSession(...)

这个函数是理解“配置到底在哪里生效”的首选断点。

## 3. 模型与思考级别的恢复优先级

工厂不能简单地每次使用全局默认，因为恢复会话时用户期待继续使用原模型。

大致决策：

1. options 显式指定的模型；
2. 已有会话记录的模型，且当前仍存在并有认证；
3. 设置中的默认模型或 Provider 默认；
4. 都不可用时保留可展示的 fallback 错误信息。

thinking level 类似：

1. options；
2. 会话中的 change entry；
3. 模型专用设置；
4. 全局默认；
5. 最后按模型能力 clamp。

“恢复配置”本身也属于会话历史，因而 model/thinking change 使用 append-only 条目记录。

## 4. 工具选择不是简单常量

默认是 `read/bash/edit/write`，但最终活跃工具还受：

- `options.tools`；
- `noTools`；
- 设置中的 default tools；
- `excludeTools`；
- 扩展注册工具；
- 运行中 `setActiveTools`；
- plan-mode 一类扩展策略。

区分：

- registered tools：系统知道的全部工具；
- active tools：当前发给模型并允许调用的工具；
- allowed/excluded：SDK 创建时的硬边界。

只隐藏 UI 按钮并不能禁用工具；真正控制点应影响传入 Agent 的 active tool 集合或在 `tool_call` hook 阻止执行。

## 5. Agent 构造时注入了什么

真实代码创建 `Agent` 时的重要依赖：

### convertToLlm

把扩展消息转为 AI 消息，并根据 `blockImages` 设置做防御性图片过滤。设置是动态读取的，所以会话中途改变也可生效。

### streamFn

包装 `modelRuntime.streamSimple`，注入：

- Provider 重试和超时；
- WebSocket 连接超时；
- session/Provider attribution headers；
- `before_provider_headers` hook。

### Provider hooks

`before_provider_request` 可检查或变换请求 payload，`after_provider_response` 可观察状态和 headers。

### transformContext

把每次模型请求前的上下文交给扩展 `context` hook。这与永久修改会话不同：扩展可以只改变本次送给模型的视图。

## 6. AgentSession 的职责

`AgentSession` 是产品编排中心，但不是模型循环本身。它拥有或引用：

- Agent；
- SessionManager；
- SettingsManager；
- ResourceLoader；
- ModelRuntime；
- ExtensionRunner；
- active tools 与工具定义；
- compaction/retry 状态；
- 事件订阅者；
- 待刷新的 bash/custom message；
- 当前 model/thinking/system prompt 相关状态。

构造时，它订阅 Agent 事件、安装扩展工具 hook 和“下一 turn 刷新”逻辑，并构建运行时资源。

## 7. prompt 方法的真实流水线

[`AgentSession.prompt`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts) 是产品行为最集中的路径：

    输入 text/images
      │
      ├─ 若是扩展命令，立即执行并返回
      ├─ compaction 进行中则拒绝
      ├─ 发 input hook：handled / transform / continue
      ├─ 展开 /skill:name 与 prompt template
      │
      ├─ 若 Agent 正在 streaming：
      │    ├─ streamingBehavior=steer → 当前任务下一轮
      │    └─ streamingBehavior=followUp → 当前任务后排队
      │
      ├─ flush pending bash/custom messages
      ├─ 检查 model
      ├─ 检查认证，给出 /login 提示
      ├─ 判断是否需要 compaction
      ├─ 构造 user message
      ├─ 注入 next-turn message
      ├─ 发 before_agent_start hook
      │    ├─ 可增加 message
      │    └─ 可调整 system prompt
      └─ agent.prompt(...)

扩展命令必须先处理，因为它们可能在 streaming 时自己决定如何交互。skill/template 展开在 input hook 之后，使扩展能看到用户原始输入并选择改写。

## 8. Agent 事件如何回流

构造函数订阅 Agent，事件进入 `_handleAgentEvent`。其处理顺序大致是：

1. 让 ExtensionRunner 观察相应事件；
2. 向 UI、JSON 或 SDK 订阅者发产品事件；
3. 在 `message_end` 边界持久化 user/assistant/toolResult/custom message；
4. 记录最后 assistant，用于 retry/usage/compaction；
5. 在 `turn_end` 后刷新暂存的 custom message；
6. 更新产品层运行状态。

“先扩展、再外部订阅者、再按边界持久化”的具体细节应以当前函数为准，但核心不变量是：delta 驱动实时展示，完整消息才落盘。

## 9. 运行模式共享同一个 Session

### interactive

创建 TUI，订阅事件并接收键盘输入。它拥有最丰富的 UI 上下文，扩展可 confirm、select、notify、setWidget。

### print

提交 prompt，将主要文本输出到 stdout 后退出，适合 shell 管道和自动化。

### 结构化事件/JSON

输出机器可读事件，适合另一个进程消费。不要把终端 ANSI 输出与结构化 stdout 混用。

### RPC

Pi 作为子进程，通过 JSON 行命令和事件由父进程控制。第 12 章会与实验性网络协议区分。

所有模式复用 AgentSession，因此会话、工具和模型语义应一致；差异主要在输入来源和事件呈现。

## 10. SDK 最小示例

仓库示例 [`examples/sdk/01-minimal.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/examples/sdk/01-minimal.ts) 的核心：

    const { session } = await createAgentSession();

    try {
      session.subscribe((event) => {
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta"
        ) {
          process.stdout.write(event.assistantMessageEvent.delta);
        }
      });

      await session.prompt("What files are in the current directory?");
    } finally {
      session.dispose();
    }

`dispose` 不是装饰：它负责解除订阅、释放扩展/资源和运行时相关资源。嵌入长期进程时必须明确对象所有权和释放时机。

## 11. 常见扩展点放在哪里

| 需求 | 首选扩展点 |
| --- | --- |
| 改写用户输入 | `input` hook |
| 添加每轮临时上下文 | `before_agent_start` |
| 过滤发送给模型的历史 | `context` hook |
| 检查危险工具 | `tool_call` hook |
| 自定义工具 | `registerTool` |
| 自定义斜杠命令 | `registerCommand` |
| 观察 Provider 请求 | provider hooks |
| 自定义状态显示 | UI status/widget |
| 持久化扩展状态 | `appendEntry` |

能用扩展解决的用户策略，通常不必修改 Agent 核心。

## 12. 动手练习

### 练习 A：追踪一条 prompt

在六个位置设断点：

1. `main`；
2. `createAgentSession`；
3. `AgentSession.prompt`；
4. `Agent.prompt`；
5. `runLoop`；
6. `Models.stream`。

运行无工具 prompt，记录每个对象当时拥有的状态。

### 练习 B：工具白名单

通过 SDK 创建仅含 read 的 session，验证：

- 模型 Context 中没有 bash/edit/write；
- 扩展无法绕过 options 的硬排除重新激活禁止工具；
- UI 展示与真实 active tools 一致。

### 练习 C：两个输入时机

在流式回复中分别提交 steer 与 follow-up，记录 message 和 turn 事件顺序，解释它们为什么进入不同循环。
