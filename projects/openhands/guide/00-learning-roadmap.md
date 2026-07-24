# 00. OpenHands 学习路线：先跑通数据流，再深入模块

OpenHands 不是一个“调用一次大模型就结束”的脚本，而是一套把用户意图、模型推理、工具执行、隔离环境、实时 UI 和企业治理连接起来的工程系统。本章先给你一张学习地图，避免一上来就在数千个文件之间迷路。

## 学完这套教程能做到什么

完成 15 章后，你应该能够：

- 画出浏览器、App Server、Sandbox、Agent Server、SDK、模型供应商之间的进程和信任边界；
- 从 `POST /api/v1/app-conversations` 追踪到 Sandbox 创建和 Agent Server 会话创建；
- 解释事件为何同时存在“持久记录”“实时增量”“UI 投影”三种形态；
- 判断一段前端数据应放在 TanStack Query、Zustand 还是组件局部状态中；
- 为设置、密钥、企业权限和数据库迁移选择正确的扩展点；
- 用小范围 pytest/Vitest 测试和日志定位问题，而不是每次都启动整套系统；
- 独立设计一个跨后端、前端和测试的中等规模功能。

## 先建立四层心智模型

把项目先压缩成四层：

```text
交互层       React UI / 路由 / 查询缓存 / WebSocket
应用层       FastAPI 路由 / 会话编排 / 用户设置 / 事件查询
执行层       Sandbox / Agent Server / SDK Agent / Workspace
外部系统     LLM 提供商 / GitHub 等代码托管 / 数据库 / 对象存储
```

当你读到任何文件，先问三个问题：

1. 它属于哪一层？
2. 它拥有状态，还是只转发状态？
3. 它跨越了哪个信任边界？

这三个问题比记目录名更重要。例如 `app_conversation_router.py` 在应用层，它大多负责校验和编排；真正执行 Agent 的进程位于 Sandbox 内。又如前端的 `useEventStore` 拥有 UI 所需的事件投影，但持久事实仍来自服务端事件。

## 当前版本最重要的事实：架构正在迁移

根 `README.md` 明确指出，Agent 与 Agent Server 的源码已经迁移到 `OpenHands/software-agent-sdk`。与此同时，本仓库的 `pyproject.toml` 固定依赖：

```toml
openhands-agent-server = "1.36.0"
openhands-sdk = "1.36.0"
openhands-tools = "1.36.0"
```

这意味着你会在本仓库看到大量这样的导入：

```python
from openhands.sdk import Event
from openhands.agent_server.models import EventPage
```

但不会再看到旧教程里常说的完整 `openhands/controller/` Agent 循环。学习时必须区分：

- 本仓库实现：Web 应用、App Server 编排、Sandbox 管理、事件存储适配、前端、Enterprise；
- 依赖包实现：Agent 核心循环、工作区抽象、Agent Server 协议和一部分事件模型；
- 跨仓库契约：Pydantic/TypeScript 类型、REST/WebSocket 地址、版本锁定。

## 三阶段学习法

### 阶段一：只读追踪

先不用运行大模型，使用 `rg` 建立调用图：

```bash
rg -n "start_app_conversation" openhands tests
rg -n "POST /api/v1/app-conversations|/api/conversations" openhands frontend
rg -n "SandboxStatus" openhands frontend tests
```

每追踪一个符号，记录“入口—接口—实现—测试”四列：

| 角色 | 例子 |
| --- | --- |
| 入口 | FastAPI 路由 `start_app_conversation` |
| 接口 | `AppConversationService` |
| 实现 | `LiveStatusAppConversationService` |
| 测试 | `tests/unit/app_server/test_app_conversation_router.py` 等 |

这样能防止只读实现、不知道谁调用它，也能防止只读路由、不知道行为在哪里。

### 阶段二：小测试验证

优先运行目标测试，不要一开始运行全仓库：

```bash
poetry run pytest tests/unit/app_server/test_sandbox_service.py
poetry run pytest tests/unit/app_server/test_app_conversation_router.py
cd frontend
npm run test -- -t "prefers live websocket execution status"
```

测试不仅用于验证修改，也是“可执行规格”。fixture 告诉你对象最少需要哪些字段，断言告诉你维护者认为哪些边界不可破坏。

### 阶段三：端到端观察

只有当你已经知道要观察什么，再启动完整应用。开发文档给出的标准入口是：

```bash
make build
make run
```

本地调试可以拆成：

```bash
make start-backend
make start-frontend
```

启动后不要只“点一遍 UI”。打开浏览器 Network 面板，同时观察：

- 创建会话的 `/api/v1/app-conversations` 请求和 start task 轮询；
- Sandbox 状态从 `STARTING` 到 `RUNNING`；
- 指向 Agent Server 的 WebSocket；
- 历史事件和实时事件如何合并；
- 暂停或归档后 UI 如何变化。

## 环境准备与成本控制

本提交要求 Python `>=3.12,<3.14`、Node `>=22.12.0`，并使用 Poetry 和 npm。完整构建很重，因此按目标选择：

| 目标 | 最小动作 |
| --- | --- |
| 只读源码 | `rg`、编辑器、Git 即可 |
| 后端单测 | Poetry 安装 dev/test 依赖 |
| 前端单测 | `cd frontend && npm install` |
| 本地 Sandbox | 还需要 Docker 或 process runtime |
| 完整应用 | `make build` 后 `make run` |

LLM 调用会产生外部费用。前端可优先使用 mock 模式，后端可用单元测试替代真实服务。切勿把真实密钥写进测试、Markdown、终端历史或提交。

## 如何阅读一个大文件

`live_status_app_conversation_service.py` 有数千行。顺序阅读会很痛苦，建议采用“骨架优先”：

```bash
rg -n "^class |^    async def |^    def " \
  openhands/app_server/app_conversation/live_status_app_conversation_service.py
```

然后只读一条主链：

```text
start_app_conversation
  -> _start_app_conversation
  -> _wait_for_sandbox_start
  -> _build_start_conversation_request_for_user
  -> POST agent-server /api/conversations
  -> save_app_conversation_info
```

读完主链再回头看 profile、skill、plugin、MCP、Git 等分支。先抓控制流，再补数据结构。

## 建议维护一份“状态所有权表”

OpenHands 最难的地方通常不是算法，而是同一概念在多个进程中的投影。建议边学边维护：

| 状态 | 权威来源 | 临时投影 |
| --- | --- | --- |
| 用户设置 | SettingsStore/企业数据库 | TanStack Query cache |
| Sandbox 生命周期 | SandboxService/运行时 | `AppConversation.sandbox_status` |
| Agent 执行状态 | Agent Server 实时事件 | `useAgentState` |
| 对话事件 | EventService/Agent Server | Zustand `useEventStore` |
| 创建进度 | StartTaskService | 前端 task polling |

一旦出现“UI 显示运行中但 Sandbox 已归档”一类问题，就检查哪个投影过期、哪个来源应优先。

## 本章实验：制作自己的请求链卡片

不运行代码，完成下面的静态实验：

1. 打开 `openhands/app_server/v1_router.py`，列出所有一级 router。
2. 打开 `frontend/src/routes.ts`，列出用户创建会话后进入的路由。
3. 在前后端分别搜索 `app-conversations`。
4. 写出浏览器创建会话至少经过的 5 个函数或类。

参考答案会在第 04、08 章逐步展开。此时重点不是完全正确，而是形成“提出假设—用搜索验证”的习惯。

## 常见误区

- 把根 README 中的 Agent Canvas 产品架构和本仓库 V1 App Server 的内部链路混为一谈。
- 依据旧博客寻找已经迁出的 controller/runtime 目录。
- 只看 API 路由，不看注入的 service 实现。
- 把 WebSocket 增量事件当作唯一持久记录。
- 为理解一个小函数先运行完整 Docker 栈，导致反馈周期过长。
- 在源码链接里使用 `main`，几周后教程与代码不再匹配。

## 自测

1. 为什么本教程必须固定 commit，而不只写仓库 URL？
2. App Server 和 Agent Server 分别承担什么责任？
3. “状态权威来源”和“UI 投影”有什么区别？
4. 为什么测试是理解架构的一部分，而不仅是修改后的验收？

## 源码定位

- [项目说明](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/README.md)
- [Python 依赖与版本](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/pyproject.toml)
- [开发指南](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/Development.md)
- [V1 router 汇总](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/openhands/app_server/v1_router.py)

下一章补足 Coding Agent、工具调用、事件溯源和隔离执行的背景知识。
