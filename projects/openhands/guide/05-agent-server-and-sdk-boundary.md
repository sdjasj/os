# 05. Agent Server 与 SDK 边界：本仓库编排什么，依赖包执行什么

如果你按照旧版 OpenHands 教程搜索 `AgentController`、完整的 Agent loop 或 runtime action 实现，当前快照会让你困惑：这些核心已经迁移到 `OpenHands/software-agent-sdk`。本章教你把“缺失的源码”理解成明确的跨仓库契约，而不是把依赖内部细节脑补进本仓库。

## 从依赖版本开始

`pyproject.toml` 同时固定三个相同版本：

```toml
openhands-agent-server = "1.36.0"
openhands-sdk = "1.36.0"
openhands-tools = "1.36.0"
```

三个包分别可理解为：

- `openhands-sdk`：Agent、Conversation、Event、LLM、Workspace、SecretSource 等核心抽象；
- `openhands-agent-server`：把 SDK Conversation 暴露为 HTTP/WebSocket 服务；
- `openhands-tools`：Agent 可使用的一组工具实现。

锁成同版本减少协议漂移。App Server 在创建自定义 Sandbox image 失败时甚至会给出“检查 openhands-sdk 版本匹配”的提示，说明版本一致性是运行时契约的一部分。

## 用 import 建立契约清单

不要先进入 site-packages 漫游。先在本仓库统计从 SDK 使用了什么：

```bash
rg -n "from openhands\.(sdk|agent_server)|import openhands\.(sdk|agent_server)" \
  openhands frontend tests
```

把结果按概念分组：

```text
模型契约     Event, ConversationInfo, EventPage, StartConversationRequest
执行契约     AsyncRemoteWorkspace, LocalWorkspace
配置契约     LLM, AgentSettings, ConversationSettings
安全契约     SecretSource, StaticSecret, LookupSecret
扩展契约     Skill, PluginSource, MCPServer
协议契约     Agent Server URL、REST 路径、WebSocket 事件
```

这样即使 SDK 内部重构，只要这些 public contract 保持，你仍能理解本仓库。

## App Server 是控制面

App Server 的会话启动 service 做的是“组装和下发”：

```text
读取用户/组织配置
  -> 解析 Agent Profile
  -> 选择 Sandbox 与 workspace
  -> 组装 LLM、SecretSource、Skill、Plugin、MCP
  -> 构造 StartConversationRequest
  -> POST Agent Server
  -> 保存控制面元数据
```

它不自己执行每一轮模型调用，也不自己解释每个 tool call。换句话说，它决定“运行什么、在哪里运行、以谁的权限运行”，Agent Server/SDK 决定“如何运行每一轮”。

## Agent Server 是数据面

Agent Server 位于 Sandbox 内，拥有：

- conversation 的运行状态；
- Agent loop 和 tool execution；
- workspace 访问；
- 实时 WebSocket 事件；
- run/interrupt/switch model 等执行端点；
- VS Code、git diff、文件等 runtime 能力。

App Server 保存会话业务元数据，但实时执行状态常需向 Agent Server 查询。这是控制面/数据面分离：控制面生命周期更长、权限更集中；数据面可以按 Sandbox 创建、暂停和销毁。

## `StartConversationRequest` 是最重要的边界对象

`_build_start_conversation_request_for_user` 最终返回 SDK 请求模型。你可以把它理解为“编译后的执行清单”，包含：

```text
conversation_id
agent（OpenHands 或 ACP）
workspace
initial_message
conversation settings（max iterations 等）
secrets
plugins / skills / MCP
observability metadata
```

App Server 先在自己的安全域中解析用户与组织配置，再把运行所需的最小信息发送到用户拥有的 Sandbox。

## 普通 OpenHands Agent 路径

普通路径大致做：

1. `UserContext.get_user_info(resolve_agent_profile=True)` 得到已合并设置；
2. 解析 LLM model、base URL、API key、reasoning 等字段；
3. 强制打开 streaming，以支持实时 UI；
4. 创建 workspace 和 conversation settings；
5. 合并 secrets、MCP、skills 和 plugins；
6. `ConversationSettings.create_request(...)` 构造 SDK 模型。

注意 `create_request` 的价值：它让 SDK 定义的字段默认值和校验成为唯一来源，App Server 不手工复制整份 schema。

## ACP Agent 路径

ACP 路径仍产出同一种启动请求，但 agent 是外部 provider。源码中有几个值得学习的边界处理：

```python
settings_update = {
    'acp_isolate_data_dir': True,
    'llm': acp_settings.llm.model_copy(
        update={'api_key': None, 'base_url': None}
    ),
}
```

为什么清空 LLM key/base URL？ACP CLI 自己处理模型调用，App Server 的 proxy 设置不应无意泄漏进子进程环境。

同时 `acp_isolate_data_dir=True` 把 provider 的会话数据放入 durable workspace，使 pause/resume 后可恢复。这是“第三方 Agent 适配”中典型的状态与凭据边界。

## Agent Profile 的解析时机

用户可以有 active profile，创建请求也可以给一次性 `agent_profile_id` override。Service 用：

```python
get_user_info(
    resolve_agent_profile=True,
    override_agent_profile_id=agent_profile_id,
)
```

并把最终 profile id/revision 写入 conversation tags。这使未来审计能知道“当时实际启动了哪一版配置”，而不是只看到用户现在的 active profile。

通用原则：配置引用会变化，执行记录应保存解析后的 provenance。

## Workspace 为什么既有 Local 又有 Remote

App Server 需要在 Agent Server 创建会话前执行 clone、setup script、skill discovery 等操作，但文件实际位于 Sandbox。因此使用 `AsyncRemoteWorkspace` 通过 Agent Server 访问；最终给 Agent 的配置可使用描述执行目录的 `LocalWorkspace`，因为从 Sandbox 内部看它是本地路径。

同一个路径在不同进程视角下含义不同：

```text
App Server 视角：远端 workspace，需要 HTTP
Agent Server 视角：本地 workspace，可直接访问文件系统
Browser 视角：受 API 和权限保护的资源
```

读路径相关代码时一定标注“谁的文件系统”。

## 为什么 App Server 还保存 EventService

实时事件来自 Agent Server，但 App Server 仍提供 event query/export/callback 能力，原因包括：

- Sandbox 销毁后仍要查看归档历史；
- Enterprise 共享会话要过滤事件；
- webhook callback 需要持久事件；
- 对话列表和导出不应依赖运行中的 Sandbox；
- 云部署可把事件写到 S3/GCS/数据库。

这不是重复 Agent Server，而是把短生命周期执行数据投影到长生命周期应用域。

## 协议的认证方式

App Server 调 Agent Server 时通常携带：

```http
X-Session-API-Key: <sandbox-scoped value>
```

这个 key 不是用户登录 cookie，也不是 LLM API key。它证明调用者被允许访问特定 Sandbox。浏览器收到 session key 必须受用户权限保护；后端提供按 session key 反查 Sandbox owner 的方法。

不要建立“一个 API key 解决全部认证”的设计。用户身份、Sandbox capability、第三方 provider token 和 LLM key 各自保护不同资源。

## 版本升级时应检查什么

更新 SDK 不只是改 `pyproject.toml`。至少检查：

1. 三个相关包是否保持兼容版本；
2. `StartConversationRequest` schema 是否变化；
3. Agent Server endpoint、事件 discriminator 是否变化；
4. Sandbox image 中实际安装版本是否一致；
5. TypeScript 手写/生成类型是否同步；
6. enterprise lockfile 是否更新；
7. 自定义 image 和 remote runtime 是否支持新版本。

本仓库甚至有临时兼容逻辑：当当前 pinned SDK 尚未公开 `user_id` 字段时，App Server 直接向 JSON body 注入它。这样的注释是升级时最值得搜索的“删除条件”。

```bash
rg -n "pinned|SDK version|Remove this once|backward compatibility" openhands enterprise
```

## 本章实验：建立跨仓库 API 表

从以下文件提取 App Server 实际调用的 Agent Server 路径：

```bash
rg -n "agent_server_url|conversation_url|/api/conversations|/alive" \
  openhands/app_server frontend/src/api frontend/src/contexts
```

为每个 endpoint 写：调用方、base URL 来源、认证 header、请求模型、响应模型、Sandbox 必须处于什么状态。这样你会得到一份比“看 SDK 内部所有代码”更有价值的契约表。

## 常见误区

- 看到 SDK import 就认为本仓库一定包含对应源文件。
- 把 App Server 到 Agent Server 的 secret 传输误认为浏览器公开 secret。
- 把 LocalWorkspace 理解成 App Server 宿主机路径。
- 升级 Python dependency，却忘了 Sandbox image 内的版本。
- 在 App Server 重新实现 Agent loop，破坏清晰边界。

## 自测

1. `StartConversationRequest` 为什么是重要的编译边界？
2. App Server 和 Agent Server 的状态生命周期有何不同？
3. ACP 路径为什么清理普通 LLM proxy 字段？
4. 为什么要持久化 launched profile revision？
5. 同一个 workspace 路径在三个进程中分别如何访问？

## 源码定位

- [SDK 版本锁定](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/pyproject.toml)
- [会话请求组装与下发](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/app_conversation/live_status_app_conversation_service.py)
- [Sandbox Agent Server URL 抽象](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/sandbox/sandbox_service.py)
- [前端 runtime API client](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/api/conversation-service/v1-conversation-service.api.ts)

下一章深入 EventService、流式 delta、状态投影和最终一致性。
