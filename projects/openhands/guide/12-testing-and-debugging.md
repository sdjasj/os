# 12. 测试与调试：用最小反馈环定位跨进程问题

OpenHands 的完整系统包含浏览器、App Server、Sandbox、Agent Server、LLM 和外部集成。每次都启动全部组件会让调试变慢且不稳定。正确策略是先判断错误属于纯逻辑、service、HTTP contract、实时时序还是真实运行时，再选择最小测试层。

## 测试金字塔在本项目中的形态

```text
                  少量 E2E / staging
             前后端集成 / route 测试
        service + store + hook + component 测试
            大量纯函数与模型单元测试
```

不是越靠上越“高级”。越靠下反馈越快、失败原因越清晰；越靠上覆盖真实装配但成本高。一个功能通常需要多层少量互补测试。

## 后端测试结构

OSS 单元测试主要在 `tests/unit/test_*.py` 和 `tests/unit/app_server/`。常用工具：

- pytest fixture；
- `AsyncMock` 模拟 async service；
- `MagicMock` 模拟复杂对象；
- FastAPI TestClient/AsyncClient 测 route；
- monkeypatch 控制 env、time、sleep；
- SQLite memory 测 store；
- 参数化覆盖状态矩阵。

目标测试：

```bash
poetry run pytest tests/unit/app_server/test_sandbox_service.py
poetry run pytest tests/unit/app_server/test_app_conversation_router.py
```

## 从 `test_sandbox_service.py` 学设计

该测试为抽象类写 `MockSandboxService`，每个 abstract method 委托给 AsyncMock。这样可直接测试基类提供的 concrete method，如 `wait_for_sandbox_running` 和 `pause_old_sandboxes`。

错误脱敏测试同时断言：

```text
应该出现：安全类别、reference sandbox id、可操作建议
不应出现：registry host、secret name、node count、device plugin
```

安全测试不能只断言状态码，必须负向断言敏感内容没有泄漏。

## 时间与轮询如何测试

真实 `asyncio.sleep` 会让测试慢。测试用 monkeypatch：

- fake `time.time()` 推进时钟；
- 把 `asyncio.sleep` 换成 AsyncMock；
- 配置 service 连续返回 STARTING/RUNNING/ERROR；
- 断言调用次数和最终结果。

通用规则：把“时间来源”和“等待函数”视为外部依赖。无需真的等 timeout。

## Route 测试与 Service 测试分工

Route 测试关注：

- 参数解析和 UUID validation；
- dependency 的输入是否正确传给 service；
- HTTP status/detail；
- response model；
- background/streaming 生命周期。

Service 测试关注：

- 业务状态机；
- Sandbox/DB/HTTP 协调；
- fallback 和补偿；
- 权限后的数据过滤；
- 并发/lock 语义。

不要在每条 route 测试里重新覆盖 service 内所有分支。

## AsyncMock 的常见陷阱

- 忘记 `await`，断言拿到 coroutine；
- mock 返回类型与真实 Pydantic model 不同；
- async generator 不能只用普通 AsyncMock return value；
- patch 错 import path：应 patch 被测模块引用的名字；
- DB session mock 没模拟 context/commit/rollback。

对 async generator，可写小 helper：

```python
async def task_updates():
    yield initial_task
    yield ready_task
```

这比深度配置 `__aiter__` 更可读。

## 前端测试层

运行全部：

```bash
cd frontend
npm run test
```

按测试名：

```bash
npm run test -- -t "prefers live websocket execution status"
```

常见组合：

```tsx
renderHook(() => useAgentState())
act(() => store.getState().setExecutionStatus(...))
expect(result.current.curAgentState).toBe(...)
```

hook 测试可以 mock Query hook，再直接操作 Zustand store，精确验证优先级。

## 每个测试都要 reset 全局 store

Zustand store 是模块 singleton。如果测试不在 `beforeEach` reset，后一个测试会继承前一个 execution status/event ids。`use-agent-state.test.tsx` 正确地在每个测试前 reset。

同理要 reset：

- QueryClient cache；
- mock server handlers；
- vi mocks；
- localStorage；
- fake timers；
- global config/env。

测试顺序相关通常就是共享状态未清理。

## WebSocket 测试

MSW 支持 WebSocket mock。测试重点不是模拟真实模型，而是控制时序：

- connect success/error/close；
- replay 与 REST history 乱序；
- duplicate id；
- delta + final；
- route change cleanup；
- reconnect 上限；
- pending message fallback。

把协议 event factory 放在 mock helper，避免每个测试手写不完整对象。

## 类型检查和构建不是同一件事

前端命令：

```bash
npm run typecheck  # React Router typegen + tsc
npm run lint       # typecheck + ESLint + Prettier check
npm run build      # i18n generation + production build
```

单元测试通过不代表 route types、lazy import 或 bundler asset 一定正确。生产 build 能发现动态 import、环境变量和静态资源问题。

## 后端 lint

仓库使用 pre-commit 组合：

- 通用文件检查；
- Ruff check/format；
- mypy；
- 其他仓库约束。

修改后端并准备推送前：

```bash
pre-commit run --config ./dev_config/python/.pre-commit-config.yaml
```

pre-commit 默认对 staged files 工作，因此要精确 `git add <file>`。调试时也可用具体 hook/文件缩小反馈环，最终再运行要求的完整命令。

## Enterprise 测试

导入路径需要：

```bash
PYTHONPATH=enterprise poetry run pytest \
  enterprise/tests/unit/server/routes/test_orgs.py
```

完整 enterprise lint 使用它自己的 config 和 tool version。不要用根 Ruff 配置格式化 enterprise 后假设结果一致。

数据库测试优先 SQLite memory 和 mock 外部连接；PostgreSQL 特有约束、migration 和并发不变量仍需专项 integration test。

## 调试日志应带什么

跨进程请求至少需要关联：

```text
user id（必要且允许时）
start task id
conversation id
sandbox id
request/trace id
agent kind / trigger
状态转换与耗时
上游 status code
```

绝不能记录：raw API key、Authorization header、session key、完整 secret payload。错误日志使用 exception stack，但对浏览器 response 另做安全分类。

## 五类常见故障的最短路径

### 创建会话卡住

先查 StartTask 状态，再查 Sandbox status/detail，再查 `/alive`，最后查 Agent Server create request。不要先查 Chat UI。

### UI 重复消息

用固定事件数组单测 `handleEventForUI`；检查 id、timestamp、delta/final 顺序。不要先重启后端。

### 设置刷新后丢失

比较 save payload、后端持久模型、GET response、frontend normalization 和 query invalidation 五段。

### 401/403

按顺序区分：middleware authentication、UserContext、resource ownership、org permission、session capability。不要把 403 当“登录失效”触发 logout。

### 本地成功、CI 失败

检查相同 Python/Node/tool 版本、enterprise config、`--show-diff-on-failure`、生成文件和 case-sensitive path。不要先修改断言以迎合失败。

## 本章实验：用失败写一条诊断树

选择“发送消息返回 502”：

1. route 已找到 conversation 吗？
2. Sandbox 是 RUNNING 吗？
3. exposed URL 有 AGENT_SERVER 吗？
4. Docker hostname rewrite 后可达吗？
5. session header 是否存在？
6. Agent Server 是拒绝请求还是网络异常？
7. 前端是否错误调用了 App Server base URL 的 runtime path？

为每个节点写一个最小测试或只读观测命令。你的目标是让每次判断只排除一类原因。

## 常见误区

- 用完整 E2E 复现所有 bug。
- patch 定义处而不是被测模块的引用处。
- 测 error response 却不做敏感信息负向断言。
- 前端测试不 reset singleton store。
- 只跑 unit test，不跑 typecheck/build。
- 本地 lint 与 CI 使用不同配置或版本。

## 自测

1. 为什么 route 和 service 应分别测试？
2. 轮询 timeout 如何在不 sleep 的情况下测试？
3. WebSocket 最值得测试的是内容还是时序？
4. 为什么测试应断言某些字符串“不出现”？
5. 502 与 503 在 send-message 链中分别指向哪一层？

## 源码定位

- [Sandbox service 测试](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/tests/unit/app_server/test_sandbox_service.py)
- [Conversation router 测试](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/tests/unit/app_server/test_app_conversation_router.py)
- [AgentState hook 测试](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/src/hooks/use-agent-state.test.tsx)
- [前端 scripts](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/frontend/package.json)
- [根 pre-commit 配置](https://github.com/OpenHands/OpenHands/blob/6b04532541bf2b757d4820d31387b6cba6ffcaea/dev_config/python/.pre-commit-config.yaml)

下一章用“新增一个用户设置”演示如何跨层开发且不破坏数据流边界。
