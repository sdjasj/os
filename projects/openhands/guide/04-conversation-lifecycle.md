# 04. 会话生命周期：从创建任务到发送消息与归档

Conversation 是 OpenHands 的核心业务对象，但它不是孤立的一行数据库记录。它同时关联用户、Sandbox、Agent Server 会话、事件、workspace、start task 和可选子会话。本章沿 HTTP API 追踪它的生命周期。

## 先区分四个标识符

| 标识 | 含义 | 何时产生 |
| --- | --- | --- |
| start task id | 异步创建工作的 id | App Server 接到创建请求时 |
| conversation id | Agent 对话及元数据 id | 创建 Agent Server 会话前/时 |
| sandbox id | 执行环境 id | 复用或创建 Sandbox 时 |
| session API key | Sandbox 访问凭据 | runtime 创建 Sandbox 时 |

前端创建后可能先导航到带 task id 的临时页面，再轮询获得 conversation id。把这些 id 混用会造成很隐蔽的 404。

## 创建请求模型承载什么

`AppConversationStartRequest` 不只包含首条消息，还可以包含：

- repository、branch、git provider；
- trigger（GUI、resolver、Slack、automation 等）；
- parent conversation；
- Agent type 或 ACP 配置；
- plugin、skill/profile 选择；
- Sandbox 复用 id；
- LLM model override；
- callback processor 和 tags。

这说明“创建会话”实际上是一次执行环境和 Agent 配置的编译过程。

## HTTP endpoint 为什么只消费第一个 yield

路由：

```python
async_iter = app_conversation_service.start_app_conversation(start_request)
result = await anext(async_iter)
asyncio.create_task(_consume_remaining(async_iter, db_session, httpx_client))
return result
```

Service 的 async generator 每经过一个阶段就 yield 更新后的 StartTask。路由先返回初始 task，让客户端尽快得到 id；后台继续推进并持久化每个阶段。

这是“异步状态机 + 可观察进度”的组合：

```text
HTTP request
  -> yield initial task -> HTTP response
  -> background generator continues
       -> WAITING_FOR_SANDBOX
       -> STARTING_CONVERSATION
       -> READY/ERROR
```

`stream-start` endpoint 则把所有 yield 作为 JSON 数组流式返回，适合不想轮询的客户端。

## `_start_app_conversation` 主链

核心步骤可以压缩为：

```text
1. 解析 user id / parent inheritance / suggested task
2. 创建并 yield StartTask
3. 选择、创建或恢复 Sandbox
4. 等待 Sandbox 与 Agent Server 健康
5. 同步 LLM profiles
6. 计算会话 workspace 目录
7. 运行 setup scripts、clone/init repository、配置 git
8. 读取用户设置、secrets、skills、plugins、MCP
9. 构造 SDK StartConversationRequest
10. POST Agent Server /api/conversations
11. 保存 AppConversationInfo 与 callback processors
12. task -> READY
13. 处理等待期间排队的消息
```

这条主链是阅读数千行 service 的骨架。每个高级功能都应该能挂到某一步，而不是改变整个心智模型。

## Sandbox 选择与 workspace 分组

如果请求没有 `sandbox_id`，service 会先尝试寻找当前用户可复用的运行中 Sandbox，否则创建。随后根据 `SandboxGroupingStrategy` 计算工作目录。

为什么需要分组策略？一个 Sandbox 可能只承载一个 conversation，也可能按用户共享。共享可以降低启动成本，但必须保证 workspace 路径、会话删除和归档不会互相覆盖。

创建时会把实际 workspace path 写入 conversation tags 的 `archiveworkspacepath`。删除时直接使用这个固定值，而不是根据“当前设置”重新推导，避免用户后来改变 grouping 策略后归档错误目录。

这是一个通用设计原则：

> 对需要在未来重放的决策，持久化当时的解析结果，而不只保存可变化的输入配置。

## 构造 StartConversationRequest

Service 会将多来源配置合并：

```text
系统默认
  + 组织/用户 settings
  + active agent profile
  + 单次请求 override
  + repository/workspace 上下文
  + secrets / provider token
  + skill / plugin / MCP
  -> SDK StartConversationRequest
```

合并顺序决定优先级。例如 API 显式 secret 可能覆盖同名用户 secret，因此代码会记录 warning。理解配置 bug 时，不要只找字段定义，要追踪解析优先级。

## 调用 Agent Server

App Server 将 request 用 `context={'expose_secrets': True}` 序列化，再通过 Sandbox 专用 header 发送：

```python
headers = (
    {'X-Session-API-Key': sandbox.session_api_key}
    if sandbox.session_api_key else {}
)
response = await self.httpx_client.post(
    f'{agent_server_url}/api/conversations',
    json=body_json,
    headers=headers,
)
```

这里“expose secrets”不代表把 secret 返回浏览器；这是 App Server 到受控 Agent Server 的内部传输边界。是否使用 raw value、StaticSecret 或 LookupSecret 还取决于 OSS/SaaS 与 Agent 类型，第 10 章详解。

## 会话元数据与实时状态分离

Agent Server 创建成功后，App Server 保存 `AppConversationInfo`：title、sandbox id、repository、trigger、LLM model、parent、tags 等。

当客户端查询 `AppConversation` 时，`LiveStatusAppConversationService` 会把持久 metadata 与 Sandbox/Agent Server 的 live info 合并。于是：

```text
AppConversation = persisted AppConversationInfo + live status projection
```

这解释了为什么会话列表能显示 sandbox status 和 execution status，而数据库记录本身不一定频繁更新每次实时变化。

## 发消息为什么是薄代理

`POST /{conversation_id}/send-message` 的流程：

1. 查询 conversation；
2. 查询 sandbox；
3. 按 SandboxStatus 返回明确错误；
4. 找到 Agent Server URL；
5. `POST /api/conversations/{id}/events`；
6. 返回 success 和 sandbox status。

状态码有语义：

| 情况 | 状态码 | 含义 |
| --- | ---: | --- |
| conversation/sandbox 不存在 | 404 | 资源不可见或不存在 |
| Sandbox `MISSING` | 410 | 已归档，不可能原地恢复 |
| `PAUSED`/`STARTING` 等 | 409 | 当前状态冲突，可先 resume/等待 |
| Sandbox `ERROR` | 503 | 执行服务不可用 |
| Agent Server 返回错误 | 502 | 上游执行服务失败 |

endpoint 特意不做消息变换或副作用；自定义处理应通过 callback/webhook 完成，保证直接调用 Agent Server 和通过 App Server proxy 的语义一致。

## 暂停、恢复与归档的区别

- pause：停止计算但保留可恢复环境/状态；
- resume：重新启动 Sandbox，并让 Agent Server/会话继续；
- delete conversation：删除元数据和事件前，需要处理 workspace archive 与 Sandbox 共享；
- `MISSING`：runtime 已不存在，UI 只能展示历史只读内容。

删除尤其不能简单 `delete_sandbox`：若多个 conversation 共享 Sandbox，删除一个会话不应破坏其他会话；远端环境还可能要求先归档 workspace。代码把 conversation-scoped archive 与 sandbox-scoped delete 分开。

## Parent 与 Sub-conversation

父会话允许继承 repository、branch、LLM 等配置，并在元数据中维护 parent/sub ids。常见用途包括 planner 创建子任务或多 Agent 协作。

需要注意：

- 权限检查不能因知道 child id 就绕过 parent owner；
- 删除 parent 时要决定如何处理 children；
- 会话列表默认可能排除 sub-conversation；
- 前端和统计查询要明确是否包含 children。

## Pending message 解决什么竞态

用户可能在 Sandbox 恢复或 WebSocket 尚未连上时发送消息。直接失败会损害体验，直接丢弃更糟。前端可通过 App Server 的 pending-message API 排队；创建/恢复完成后 service 调 `_process_pending_messages` 发送给 Agent Server。

这是典型的“控制面已接受意图，数据面稍后可用”的缓冲设计。

## 错误处理与脱敏

创建链中任一步出错，task 进入 ERROR，并对 exception detail 做 API key 和文本 secret redaction。客户端通过轮询看到安全错误，而服务端日志保留更完整上下文。

设计错误信息时要同时满足：

- 用户能采取行动；
- 不泄漏 secret、内部 host、cluster 元数据；
- 日志有 task id/sandbox id/conversation id 可关联；
- 长任务最终一定落入 READY 或 ERROR，不能永久悬挂。

## 本章实验：从 endpoint 追到 HTTP 上游

执行：

```bash
rg -n "start_app_conversation|_wait_for_sandbox_start|_build_start_conversation_request_for_user" \
  openhands/app_server/app_conversation
rg -n "send-message|/events" \
  openhands/app_server/app_conversation frontend/src/api
```

画出两个 sequence：创建会话和发送 follow-up。每一步标注对象 id、调用协议和失败状态码。再思考：如果 Agent Server 创建成功但保存 `AppConversationInfo` 失败，系统可能留下什么孤儿资源？生产系统应如何补偿？

## 常见误区

- 把 StartTask 的初始响应当成会话已经可用。
- 在 Sandbox PAUSED 时直接向旧 URL 发消息。
- 删除 conversation 时无条件删除共享 Sandbox。
- 重新根据当前 grouping settings 推导旧 workspace。
- 在 thin proxy 里增加只有部分调用路径才执行的业务逻辑。

## 自测

1. 创建 endpoint 为什么返回 async generator 的第一个值？
2. 为什么 `MISSING` 使用 410，而 PAUSED 使用 409？
3. `AppConversationInfo` 与 `AppConversation` 有何不同？
4. pending message 处理了哪个时序窗口？
5. 为什么归档是 conversation scope，而删除 Sandbox 是 sandbox scope？

## 源码定位

- [会话路由](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/app_conversation/app_conversation_router.py)
- [会话模型](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/app_conversation/app_conversation_models.py)
- [实时会话服务](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/app_conversation/live_status_app_conversation_service.py)
- [StartTask SQL 服务](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/app_conversation/sql_app_conversation_start_task_service.py)
- [前端 V1 conversation API](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/api/conversation-service/v1-conversation-service.api.ts)

下一章专门解释 Agent Server/SDK 边界，以及真正 Agent 循环为何不在当前仓库内。
