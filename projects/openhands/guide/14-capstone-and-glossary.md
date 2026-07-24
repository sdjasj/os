# 14. 综合实践：四周源码计划、排障剧本与术语表

前 14 个模块已经覆盖从浏览器到 Sandbox 的主链。最后一章把知识转成可提交的练习：每个练习都有输入、交付物、验收标准和进阶问题。你不必一次做完，可按四周推进。

## 四周学习计划

### 第一周：建立可验证架构图

阅读：`00`—`04`。

每天任务：

1. D1：运行 `rg` 清单，画顶层目录地图。
2. D2：从 `app.py` 画启动与 router 图。
3. D3：从 `config.py` 画 Injector 图。
4. D4：追踪创建会话的主链。
5. D5：追踪发送消息、pause/resume/delete。
6. D6：用单元测试验证一个状态码分支。
7. D7：重画一张不超过 20 个节点的总图。

交付物：一张进程图、一张 sequence diagram、一张状态所有权表。

验收：能在不看笔记时解释 App Server、Agent Server、Sandbox、SDK 的区别。

### 第二周：实时事件与前端

阅读：`05`—`09`。

任务：

1. 列出 SDK public contract。
2. 为 Action→Observation 写事件序列。
3. 为 delta→final 写三个时序测试。
4. 给 conversation route 每个 Provider 标职责。
5. 追踪一次 send 与 receive。
6. 模拟 history/replay duplicate。
7. 解释 archived page 的数据来源。

交付物：一组纯函数测试或测试设计文档，以及 UI 状态来源表。

验收：能定位“重复消息”应先检查哪几个函数，而不是笼统怀疑 WebSocket。

### 第三周：安全、Enterprise 与测试

阅读：`10`—`12`。

任务：

1. 画 LLM secret 从保存到 Sandbox 的流向。
2. 比较 JWS/JWE/SecretStr/SecretSource。
3. 审计一个 org route 的身份和权限。
4. 审计最后 superadmin 不变量。
5. 为 Sandbox raw error 写负向泄漏断言。
6. 用 SQLite/Mock 设计 store test。
7. 运行最小 lint/typecheck。

交付物：一份 threat model 和一份测试矩阵。

验收：能说明浏览器、App Server、Sandbox 三个安全域中分别允许出现哪些凭据。

### 第四周：完整功能

阅读：`13`，并选择一个小功能真正实现。

候选：

- 新增非敏感 UI preference；
- 给一个事件投影补边界处理；
- 改善一个 Sandbox 错误分类；
- 为某个 settings 字段补 round-trip 测试；
- 为 archived conversation 补只读 guard。

交付物：设计说明、代码、目标测试、lint/build 结果。

验收：变更矩阵完整，测试覆盖业务语义，diff 不包含 secret/无关文件。

## 综合练习 A：只读追踪创建会话

### 输入

用户在 Launch 页选择 repository 和 model，输入首条消息，点击创建。

### 交付物

写一份 sequence diagram，至少包含：

```text
LaunchRoute
useCreateConversation
V1ConversationService
app_conversation_router
LiveStatusAppConversationService
SandboxService
AsyncRemoteWorkspace
Agent Server
StartTaskService
conversation route
WebSocket provider
```

每条边标 HTTP/函数/数据库/WebSocket，并写主要 request/response type。

### 验收

- task id 与 conversation id 不混淆；
- 明确 Sandbox health check；
- 明确 App Server→Agent Server session header；
- 明确 READY 后前端如何跳转；
- 至少列 5 个失败点及用户可见状态。

## 综合练习 B：修复乱序 delta

### 场景

页面 reload 时，WebSocket replay 的 final message 先到，REST history 中更旧的 delta 后到，UI 多出半句气泡。

### 实施步骤

1. 用最小事件数组复现，不启动后端。
2. 确认 durable watermark 选择。
3. 写失败测试。
4. 修改 `handleEventForUI` 或相关排序逻辑。
5. 加入 metrics interleaving 和无 timestamp case。
6. 运行目标 Vitest、typecheck 和 build。

### 验收

- final 只显示一次；
- 当前正在生成的新 delta 不被误删；
- Action thought 和 reasoning-only delta 行为不回归；
- 测试不依赖真实时间或网络。

## 综合练习 C：设计 Sandbox 启动可观测性

### 目标

用户只看到“启动失败”，运维却要快速定位 image pull、capacity、health check 或 SDK mismatch。

### 设计

为每个阶段定义：

| 阶段 | 安全日志字段 | 用户信息 | 指标 |
| --- | --- | --- | --- |
| create runtime | sandbox/task id、backend | 创建失败类别 | latency/failure count |
| wait status | status transition | 正在等待 | time in STARTING |
| Agent `/alive` | safe URL category、status | 服务未就绪 | readiness retries |
| create conversation | status code、SDK version | image compatibility hint | upstream errors |

不得记录 session key、raw runtime detail、secret 或完整内部 URL。

### 验收

给一个 task id，能在日志中关联 Sandbox 与上游失败；浏览器 response 不泄漏内部基础设施。

## 综合练习 D：多租户权限审计

选择一个 `enterprise/server/routes/` endpoint，回答：

1. authentication 来源；
2. permission；
3. effective org；
4. path/header mismatch 防护；
5. store query 是否带 org/user filter；
6. resource not found 是否会泄漏存在性；
7. 并发不变量；
8. 日志和 analytics 字段；
9. 测试的 allow/deny 矩阵；
10. shared/public 模式是否改变规则。

验收：至少包含跨组织访问、普通 member、org admin、superadmin 和未认证五类 case。

## 排障剧本一：会话创建永久等待

```text
StartTask 查不到
  -> POST response/task persistence 问题

StartTask=PENDING
  -> background generator 是否启动、依赖是否过早关闭

WAITING_FOR_SANDBOX
  -> Sandbox status/detail、runtime API、capacity/image

Sandbox RUNNING 但不推进
  -> exposed AGENT_SERVER URL、/alive、网络/CORS（服务端侧先查可达性）

STARTING_CONVERSATION
  -> request build、SDK schema、secret serialization、Agent Server status

READY 但页面不工作
  -> conversation metadata、URL、session key、前端 task polling/navigation
```

每一步先确认状态事实，再进入下一层。

## 排障剧本二：设置保存但新会话不用

```text
UI local state 是否改变？
  -> save payload 是否包含字段？
  -> backend response 是否保存？
  -> GET normalization 是否恢复？
  -> UserContext effective settings 是否含字段？
  -> active profile 是否覆盖？
  -> StartConversationRequest 是否下发？
  -> Agent variant 是否支持？
  -> 该字段是否只对新会话生效？
```

在每个边界记录一个可比较的非敏感值，避免把整个 settings/secret dump 到日志。

## 排障剧本三：只有 Enterprise 失败

检查：

```text
OPENHANDS_CONFIG_CLS 是否在 import base app 前设置
enterprise 是否在 PYTHONPATH
SaaS router 是否在静态 frontend mount 前注册
UserAuth/SettingsStore injector 是否替换
effective org 是否存在
数据库 migration head 是否最新
feature flag 是否同时识别 true/1
根与 enterprise lint/tool version 是否混用
```

## 如何做源码笔记

推荐每个主题使用同一模板：

```markdown
## 问题
这个模块解决什么？

## 权威状态
谁持久化，谁只是投影？

## 入口与出口
函数/API/事件/类型是什么？

## 主链
最多 10 步。

## 失败与安全
状态码、重试、脱敏、权限。

## 测试
哪些测试是可执行规格？

## 未决问题
注释、兼容层、迁移 TODO。
```

不要大段复制源码；记录路径、符号、关键不变量和你自己的解释。

## 核心术语表

### ACP

Agent Client Protocol。让 OpenHands 接入外部 Agent provider；与普通 SDK Agent 共享会话协议，但配置、凭据和进程生命周期不同。

### Agent

围绕 LLM 组织上下文、工具、循环、恢复与结束条件的执行策略，不等于 LLM 本身。

### Agent Profile

可版本化、可激活的 Agent 配置集合。会话记录实际启动 profile 的 id/revision 以保留 provenance。

### Agent Server

Sandbox 内承载 SDK Conversation、Agent、Workspace、工具和实时协议的服务。

### App Conversation

App Server 视角的会话资源：持久元数据加 Sandbox/Agent Server live status 投影。

### App Server

面向用户和前端的控制面，负责认证、设置、会话编排、Sandbox、事件查询和企业扩展。

### Action / Observation

Agent 请求执行的动作，以及环境返回的结果；Observation 通过 `action_id` 与 Action 关联。

### Async generator

可多次 `yield` 的异步迭代器。会话创建用它逐阶段产出 StartTask 更新。

### Capability token

持有即获得特定能力的 token。session API key 是访问特定 Sandbox 的 capability，但仍应结合 owner 校验。

### ConversationSettings

控制一次 Conversation 行为的 SDK 配置，如 confirmation、iteration 等，与 UI-only preference 不同。

### Durable event

可持久化和回放的最终事实，与只用于低延迟预览的 streaming delta 相对。

### Effective settings

系统、组织、用户、profile、单次 override 合并后的实际执行配置。

### Event projection

从事实事件计算出的某种视图，如 chat cards、AgentState 或 metrics。

### Injector

项目的异步依赖注入抽象，可同时服务 FastAPI Depends 与显式 async context。

### JWS / JWE

JWS 提供签名/完整性；JWE 提供加密/保密。JWT 不天然意味着加密。

### LookupSecret / StaticSecret

前者传递按需取值引用，后者直接携带值。选择取决于信任边界和执行协议能力。

### MCP

Model Context Protocol。为 Agent 提供标准化工具/资源连接；不同于只提供工作说明的 Skill。

### Pending message

在 Sandbox/WebSocket 尚不可用时由 App Server 暂存、稍后转发的用户意图。

### Sandbox

运行 Agent Server 和工作负载的隔离环境，可由 Docker、宿主进程或远端 runtime 提供。

### SandboxSpec

创建 Sandbox 的模板/规格；Sandbox 是实例。

### StartTask

长耗时会话创建工作的可查询资源，状态最终为 READY 或 ERROR；它的 id 不是 conversation id。

### Streaming delta

模型流式生成的低延迟增量预览。最终 durable message/action 到达时需要 reconciliation。

### TanStack Query

前端服务端状态缓存。负责 query key、loading/error、失效和 refetch，不适合高频 token 事件投影。

### UserContext

业务层访问用户身份、effective settings、provider token 和 secrets 的统一 facade。

### Workspace

Agent 工具操作的工作目录。对 App Server 可能是 RemoteWorkspace，对 Sandbox 内 Agent Server 是本地路径。

### Zustand

轻量客户端 store，用于事件、Agent 状态和终端等跨组件实时状态。

## 最终自测

不看前文，尝试回答：

1. 用户点击发送后，消息经过哪些函数和进程？
2. Sandbox RUNNING 为什么仍可能无法创建 conversation？
3. 为什么 events、uiEvents 和 AgentState 是三个不同投影？
4. App Server 如何在不知道 Docker 细节的情况下管理 Remote Sandbox？
5. raw LLM key 为什么不应返回普通 Settings query？
6. Enterprise 如何复用 OSS FastAPI app？
7. 一个设置何时属于 SDK schema，何时属于 UI preference？
8. 重复助手消息应优先写哪种最小测试？
9. 最后 superadmin 不变量为什么不能只在 route 检查？
10. SDK 升级为什么还要检查 Sandbox image？

若能用源码路径和具体类型回答，你已经具备独立继续学习这个项目的能力。

## 源码定位

- [项目 README](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/README.md)
- [开发指南](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/Development.md)
- [App Server 总览](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/README.md)
- [Frontend API 规范](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/api/README.md)
- [OSS tests](https://github.com/OpenHands/OpenHands/tree/6b04532541bf2b757d4820d31387b6cba6ffcaea/tests/unit)
- [Enterprise tests](https://github.com/OpenHands/OpenHands/tree/6b04532541bf2b757d4820d31387b6cba6ffcaea/enterprise/tests/unit)
