# 07. Sandbox 与 Runtime：生命周期、多后端和安全边界

Sandbox 是 OpenHands 把“模型建议运行命令”变成可管理工程能力的关键。它既是安全隔离，也是资源调度、持久 workspace、服务发现和会话恢复的载体。本章从 `SandboxService` 接口开始，再比较 Docker、Process 和 Remote 实现。

## Sandbox 不等于 Agent Server

Sandbox 是环境，Agent Server 是环境内的服务。`SandboxInfo` 保存：

```python
class SandboxInfo(BaseModel):
    id: str
    created_by_user_id: str | None
    sandbox_spec_id: str
    status: SandboxStatus
    session_api_key: str | None
    exposed_urls: list[ExposedUrl] | None
    status_detail: str | None
```

`exposed_urls` 可包含 `AGENT_SERVER`、`VSCODE` 和 worker 端口。App Server 不假设固定 host/port，而通过名字发现服务。

## `SandboxService` 的稳定接口

接口覆盖：

```text
读：search / get / batch_get / get_by_session_key
生命周期：start / wait_running / pause / resume / delete
归档：archive_conversation_workspace
资源策略：pause_old_sandboxes
```

上层 conversation service 依赖这些语义，而不依赖 Docker API 或 Kubernetes 细节。

## 状态机

可以画成：

```text
             ┌──────────────┐
start ──────►│   STARTING   │
             └──────┬───────┘
                    │ ready
                    ▼
             ┌──────────────┐
       resume│   RUNNING    │pause
          ┌──┤              ├──┐
          │  └──────────────┘  │
          │                    ▼
          │             ┌──────────────┐
          └─────────────┤    PAUSED    │
                        └──────────────┘

任何阶段可能 -> ERROR
运行时资源消失 -> MISSING
```

`MISSING` 往往不能 resume，因为底层资源已无。`PAUSED` 则应保留恢复所需状态。

## 为什么 RUNNING 还不够

容器或 Pod 报 RUNNING 时，Agent Server 可能尚未监听端口。`wait_for_sandbox_running` 可在状态 RUNNING 后继续请求：

```text
GET {agent_server_url}/alive
```

只有 health check 成功才返回。这避免创建会话紧接着得到 connection refused 的启动竞态。

这里有两层 readiness：

- infrastructure readiness：容器已运行；
- application readiness：Agent Server 已响应。

生产系统常需要两者，不能用进程存在代替服务可用。

## 安全错误分类

runtime 原始 `status_detail` 可能包含 registry host、secret/configmap、node taint、label、集群容量等敏感基础设施信息。Sandbox service 会：

1. 在服务端日志记录 raw detail；
2. 匹配安全的错误类别；
3. 向用户返回诸如 image pull、capacity、scheduling、container config 的概括；
4. 附 sandbox id reference，便于运维关联日志。

这是“可操作但不泄漏”的错误设计。切勿直接把 Kubernetes error string 返回浏览器。

## DockerSandboxService

本地默认实现通过 Docker SDK：

- 从 SandboxSpec 选择 image；
- 生成 session key 并注入 `OH_SESSION_API_KEYS_0`；
- 绑定 workspace volume；
- 分配 host port；
- 注入回调 URL 和 CORS origins；
- 创建、启动、暂停/停止容器；
- 根据 container 状态组装 `SandboxInfo`。

Docker Python SDK 多为同步 API，源码明确承认一些调用会阻塞 event loop。对于本地单用户可接受，但在高并发服务端应考虑 thread offload 或异步 runtime API。

## ProcessSandboxService

`RUNTIME=local` 或 `process` 时，Agent Server 作为宿主机进程运行。这对调试方便，但安全边界显著不同：

- workspace 与宿主文件系统更接近；
- agent command 可能拥有当前用户权限；
- 端口/进程清理依赖本机工具；
- 不应把它误当生产级容器隔离。

所以运行前要明确“调试便利”和“隔离强度”的交换。

## RemoteSandboxService

远端实现把生命周期委托给 runtime API，适合云端或集群：

- Sandbox 状态来自远端服务；
- workspace 可能支持 pause 后持久化；
- URL 可能需要反向代理或 host 替换；
- 归档可能是删除前的强制条件；
- session key 映射还要在本地数据库支持权限校验。

Remote 模式把 App Server 从容器细节中解耦，但引入分布式失败：网络超时、远端部分成功、资源孤儿和最终一致性。

## SandboxSpec 与 Sandbox 的区别

- SandboxSpec：模板/规格，如 image、working dir、资源、端口；
- Sandbox：按某个 spec 创建的实例，拥有 id、状态、session key 和 URL。

创建会话保存 `sandbox_spec_id`，查询时若旧 spec 已不存在，当前代码有 fallback 到 default spec 的兼容逻辑。注释指出这是未保留历史 spec version 的临时方案。

更稳健的设计通常会版本化 spec，保证旧实例可以准确解释。

## Session API Key 是 capability

`X-Session-API-Key` 赋予调用者访问某个 Sandbox 内 Agent Server 的能力。后端支持：

- `get_sandbox_by_session_api_key`：需要 live data 时；
- `get_sandbox_record_by_session_api_key`：仅认证/所有权时，避免昂贵 runtime round trip；
- `validate_session_key_ownership`：同时验证已登录用户与 Sandbox owner。

把 key 视为 capability token：持有者有特定能力，因此必须限制暴露、日志和作用域。

## Sandbox-scoped secret endpoint

Sandbox 内的 SDK 可能需要用户 secret，但 raw value 不应经普通浏览器 API 暴露。App Server 提供：

```text
GET /sandboxes/{id}/settings/secrets
GET /sandboxes/{id}/settings/secrets/{name}
```

调用方必须给 session key；服务端校验 key 对应的 Sandbox id 和 owner。list 只返回 name/description，不返回 value；单个 value endpoint 才按需解析。

这是最小暴露原则：先列元数据，需要时才取一个值。

## Volume mount 的风险

DockerSandboxService 允许 host/container/mode mount。配置错误可能：

- 把过宽宿主目录以 `rw` 暴露给 Agent；
- 让多个用户共享同一写目录；
- 通过符号链接越过预期 workspace；
- 把 Docker socket 或 credential directory 暴露进去。

安全审查应检查精确 host path、只读需求、owner、路径规范化和 symlink。不要使用宽泛根目录 mount。

## CORS 与 URL 重写

浏览器需要直连 Sandbox 暴露的 Agent Server，因此 URL、TLS 和 CORS 必须匹配部署拓扑。`replace_localhost_hostname_for_docker` 处理“App Server 在容器里时 localhost 指向自己”的问题。

调试 WebSocket 失败时分别确认：

```text
浏览器看到的 URL 是否可达？
App Server 容器看到的 URL 是否可达？
Agent Server 是否允许前端 origin？
反向代理是否转发 Upgrade？
session key 是否作为 query/header 正确传递？
```

“curl 在宿主机成功”不能证明浏览器和 App Server 容器都能访问。

## 共享 Sandbox 的资源策略

`pause_old_sandboxes(max_num_sandboxes)`：

1. 分页列出所有 Sandbox；
2. 过滤 RUNNING；
3. 按创建时间排序；
4. 暂停最旧的超额实例；
5. 单个失败不阻止继续处理其他实例。

这是简单的资源上限策略。真正云部署还会考虑最近活动、活跃会话、成本、组织 quota 和归档是否完成。

## 本章实验：诊断 STARTING 卡住

按层排查：

1. App Server 是否成功创建 Sandbox record？
2. Docker/remote runtime 是否真的创建实例？
3. `status_detail` 在服务端日志中是什么类别？
4. exposed URL 是否包含 `AGENT_SERVER`？
5. `/alive` 从 App Server 网络命名空间是否成功？
6. image 中 SDK/Agent Server 版本是否匹配？
7. session key 是否被正确注入？

不要先修改前端 loading UI；它只是投影后端状态。

## 常见误区

- 把容器 RUNNING 当成 Agent Server ready。
- 直接向用户返回 runtime raw error。
- 把 process runtime 当成强隔离 Sandbox。
- 用 session key 替代用户所有权校验。
- 在共享 Sandbox 中删除一个 conversation 时无条件删除实例。
- 只测试宿主机 URL，不测试浏览器和容器视角。

## 自测

1. `SandboxInfo.exposed_urls` 为什么用 name，而不是固定数组位置？
2. infrastructure readiness 和 application readiness 有何不同？
3. `get_sandbox_record_by_session_api_key` 为什么能减少认证成本？
4. SandboxSpec 为什么最好版本化？
5. Remote Sandbox 带来了哪些分布式失败模式？

## 源码定位

- [Sandbox 模型](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/sandbox/sandbox_models.py)
- [SandboxService 接口与等待逻辑](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/sandbox/sandbox_service.py)
- [Docker 实现](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/sandbox/docker_sandbox_service.py)
- [Process 实现](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/sandbox/process_sandbox_service.py)
- [Remote 实现](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/sandbox/remote_sandbox_service.py)
- [Sandbox secret 路由](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/sandbox/sandbox_router.py)

下一章转向浏览器，解释 React Router、Query cache、Zustand 与组件的分工。
