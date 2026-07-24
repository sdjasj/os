# 02. 仓库全景：目录、进程、协议与迁移边界

理解 OpenHands 的关键不是记住每个目录，而是知道一次请求跨过哪些进程、每个目录在其中负责什么。本章先从仓库树切入，再建立运行时拓扑。

## 顶层目录怎么分类

当前快照中与主线最相关的目录如下：

```text
OpenHands/
├── openhands/
│   ├── app_server/       # 当前 V1 FastAPI 应用服务
│   ├── server/           # 兼容入口，转发到 app_server
│   ├── analytics/        # 分析事件抽象
│   └── db/               # 数据库辅助代码
├── frontend/             # React 19 + React Router + TanStack Query + Zustand
├── enterprise/           # 企业认证、组织、计费、集成、迁移
├── tests/unit/           # OSS 后端单元测试
├── skills/               # 随包分发的技能内容
├── microagents/          # 公共 microagent 内容
├── containers/           # 构建与运行镜像
├── pyproject.toml        # Python/SDK 版本与工具配置
├── Makefile              # 开发入口
└── Development.md        # 环境与运行说明
```

第一条经验：目录名不等于进程。`openhands/app_server/` 是一个 Python 包；Sandbox 中的 Agent Server 是由依赖包和镜像启动的另一个进程。

## 运行时拓扑

本地 Docker 模式可以抽象成：

```text
Browser
  │ REST: /api/v1/*
  ▼
App Server (FastAPI)
  ├── SQLite/文件存储：用户设置、会话元数据、事件索引
  ├── Docker API：创建/暂停/删除 Sandbox
  └── HTTP：调用 Sandbox 内 Agent Server
             │
             ▼
        Sandbox container
        ├── Agent Server
        ├── Agent/ACP provider
        ├── Workspace
        ├── shell/browser/tools
        └── VS Code 等暴露服务

Browser ── WebSocket ────────────────────► Agent Server 实时事件端点
```

远端部署时 Docker API 可以替换成 Remote Sandbox API，持久化也可替换为云存储或企业数据库，但上层接口尽量保持稳定。

## 两个 HTTP 平面

代码中最容易混淆的是两组 API：

### App Server API

统一以 `/api/v1` 为前缀，由 `v1_router.py` 汇总：

```python
router = APIRouter(prefix='/api/v1')
router.include_router(event_router.router)
router.include_router(app_conversation_router.router)
router.include_router(sandbox_router.router)
router.include_router(settings_router)
router.include_router(secrets_router)
```

它负责用户域、会话元数据、Sandbox 编排和对外统一入口。

### Agent Server API

App Server 从 `SandboxInfo.exposed_urls` 找到 `AGENT_SERVER` 地址，然后调用类似：

```text
POST /api/conversations
POST /api/conversations/{conversation_id}/events
POST /api/conversations/{conversation_id}/run
GET  /alive
```

前端的 `V1ConversationService` 也会根据 `conversation_url` 构造 runtime URL。于是不要仅凭 `/api/conversations` 判断请求属于 App Server 还是 Agent Server，要同时看 base URL。

## 启动入口为何看起来有两份

`openhands/server/listen.py` 当前只是兼容转发：

```python
from openhands.app_server.app import app
```

`openhands/server/app.py` 也声明 deprecated 并重新导出。这种兼容层用于保留已有部署命令和 import path，而实际 FastAPI 组装发生在 `openhands/app_server/app.py`。

阅读原则是：

```text
部署入口名可能保持不变
           ↓
兼容模块重新导出
           ↓
当前实现位于 app_server
```

不要因为 Makefile 仍运行 `openhands.server.listen:app`，就把 `openhands/server/` 当作主要实现。

## App Server 内部怎样分层

以会话为例：

```text
app_conversation_router.py
  负责 HTTP 参数、状态码、依赖声明和薄代理

app_conversation_service.py
  定义抽象接口与领域异常

live_status_app_conversation_service.py
  组合 Sandbox、用户设置、Agent Server、事件回调

sql_app_conversation_info_service.py
  保存会话元数据

sql_app_conversation_start_task_service.py
  保存异步创建任务进度
```

这是一种“router → interface → implementation/adapters”的结构。`config.py` 决定当前环境注入哪个实现。

## 为什么创建会话要有 StartTask

创建 Sandbox、等待健康检查、配置 workspace、加载 skill/plugin、调用 Agent Server 都可能耗时。若 HTTP 请求一直阻塞，连接容易超时且前端无法展示阶段进度。

于是 `POST /api/v1/app-conversations` 先返回一个 `AppConversationStartTask`：

```text
PENDING
  -> WAITING_FOR_SANDBOX
  -> STARTING_CONVERSATION
  -> READY 或 ERROR
```

前端拿到 task id 后轮询，READY 时再跳转到真实 conversation id。这是“长任务资源化”的常见 Web 设计：把后台工作本身建模为可查询资源。

## 前端目录的职责

前端不是按单一 MVC 分层，而是组合多种状态工具：

```text
src/routes/              URL 与页面边界
src/components/          可复用 UI 和 feature 组件
src/api/                 HTTP 数据访问层
src/hooks/query/         TanStack Query 读取封装
src/hooks/mutation/      TanStack Query 写入封装
src/contexts/            WebSocket 等生命周期上下文
src/stores/              Zustand 客户端状态
src/types/               API/事件/UI 类型
src/utils/               事件投影、URL、格式化等纯逻辑
```

项目明确要求：UI 组件不能直接调用 `src/api`，必须经 TanStack Query hook。这样缓存 key、失效、错误和 loading 状态不散落在组件中。

## 三种前端状态不要混用

| 状态类型 | 合适工具 | 例子 |
| --- | --- | --- |
| 服务端可重新获取的数据 | TanStack Query | settings、conversation metadata |
| 跨组件的客户端/实时投影 | Zustand/Context | event list、terminal buffer、socket status |
| 单组件短生命周期状态 | `useState` | modal 是否打开、输入框内容 |

如果把 settings 复制到 Zustand，会产生两份缓存；如果把逐 token 事件都塞进 Query cache，更新模型又过重。工具选择反映状态所有权。

## Enterprise 是扩展，不是另一个完全独立应用

`enterprise/saas_server.py` 先设置 SaaS 配置，再导入 OSS `base_app`：

```python
from openhands.app_server.app import app as base_app
```

随后追加认证、组织、计费、共享会话和集成路由，增加中间件，最后挂载前端。这是一种“复用核心应用 + 组合企业能力”的结构。

导入顺序非常重要：它先设置 `SERVE_FRONTEND=false`，防止 OSS 在 import 时就把 `/` 静态站点挂载起来，遮蔽后添加的企业路由；企业路由注册完成后才最后 mount 前端。

## 许可证也是架构边界

根 `LICENSE` 说明：

- `enterprise/` 下内容使用 `enterprise/LICENSE`；
- 其他内容使用 MIT License。

因此学习和引用 enterprise 代码时，应把它当作不同许可边界。教程可以解释接口和少量代码，但不能因根 MIT 许可证就假定 enterprise 也被 MIT 授权。

## 一次创建请求的宏观链路

先记住这条主线，后续章节会逐层展开：

```text
Launch UI
  -> useCreateConversation mutation
  -> V1ConversationService.createConversation
  -> POST /api/v1/app-conversations
  -> AppConversationService.start_app_conversation
  -> SandboxService.start_sandbox / wait_for_sandbox_running
  -> build StartConversationRequest
  -> POST Agent Server /api/conversations
  -> save AppConversationInfo
  -> StartTask READY
  -> 前端跳到 /conversations/{id}
  -> WebSocketProvider 连接 Agent Server
  -> history + live events -> Zustand -> Chat UI
```

## 本章实验：给请求标注进程边界

复制上面的链路，在每个箭头上标注：

- 函数调用；
- App Server HTTP；
- Agent Server HTTP；
- WebSocket；
- 数据库/文件持久化。

再回答：如果创建任务已经 READY，但浏览器 WebSocket 连不上，问题更可能位于哪一段？如果 Sandbox 一直 STARTING，前端事件合并逻辑是否是优先排查对象？

## 常见误区

- 看到两个 `/api/conversations` 就认为重复实现；它们可能位于不同 host。
- 认为 `server/` 和 `app_server/` 是两套同时运行的后端。
- 把 start task id 当作 conversation id。
- 把 Enterprise 看成 fork，从而忽略它复用同一个 FastAPI app 和 service 抽象。
- 忽略静态文件 mount 顺序对路由可达性的影响。

## 自测

1. 为什么兼容入口可以 deprecated，但部署命令暂时不变？
2. StartTask 解决了什么协议问题？
3. `conversation_url` 指向哪个进程？
4. 哪类状态应该放 TanStack Query，哪类适合 Zustand？
5. Enterprise 为什么要延迟挂载前端？

## 源码定位

- [当前 FastAPI 应用](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/app.py)
- [兼容入口](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/server/listen.py)
- [V1 路由组合](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/v1_router.py)
- [前端路由](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/routes.ts)
- [Enterprise 应用组合](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/enterprise/saas_server.py)

下一章从 `app.py` 进入 FastAPI 启动、lifespan 与依赖注入。
