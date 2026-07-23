# 09. CLI/TUI 与本地 Web Viewer

Strix 有三种主要交互方式：headless CLI、Textual TUI、本地 Web Viewer。它们共享扫描核心和磁盘产物，但对实时事件和用户输入的处理不同。

## 1. 三种界面的责任边界

| 界面 | 入口 | 是否驱动扫描 | 实时数据来源 | 能否发消息 |
| --- | --- | --- | --- | --- |
| 非交互 CLI | `run_cli()` | 是 | ReportState + Rich Live | 否 |
| Textual TUI | `run_tui()` / `StrixTUIApp` | 是 | event sink + Coordinator | 是 |
| standalone Viewer | `strix view` | 否 | 每次从 run 目录读取 | 否 |
| TUI 启动的 Viewer | TUI `action_open_viewer()` | 间接共享活扫描 | 磁盘轮询 + steer callback | 是 |

Viewer 能否 steering 不由前端猜测，而由 `/api/capabilities` 返回 `can_steer`，只有 server 构造时传入 `steer_handler` 才为 true。

## 2. 非交互 CLI

[`run_cli()`](../../strix/interface/cli.py) 的主要 UI 行为：

1. 输出 target 和 run 目录启动面板。
2. 创建 `ReportState` 与 vulnerability callback。
3. 用 `signal`/`atexit` 确保中断时保存状态。
4. 启动 Rich `Live` 面板。
5. 单独 daemon thread 每 2 秒刷新模型、漏洞、token、cost。
6. 当前协程 `await run_strix_scan()`。
7. 停止刷新线程、再次 best-effort cleanup。
8. 若有最终结果，打印报告面板。

刷新 thread 只读 ReportState 并更新终端，不执行扫描逻辑。扫描仍在 asyncio event loop 中。

`run_strix_scan()` 和 `run_cli()` 都调用 cleanup，依赖 `session_manager.cleanup()` 幂等：第一次 pop cache 并删除容器，第二次看不到 bundle 直接返回。

## 3. Textual TUI 为什么需要独立线程

Textual 自己管理事件循环和 UI thread。TUI 的 `_start_scan_thread()` 创建 daemon thread，再在线程内创建专用 asyncio loop：

```python
loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
loop.run_until_complete(run_strix_scan(...))
```

这样模型/容器 I/O 不阻塞 Textual UI。`event_sink=self._capture_sdk_event` 从扫描 thread 接收事件，再通过 `call_from_thread()` 切回 UI thread 更新 `TuiLiveView`。

线程边界必须谨慎：不能从 UI thread 直接 `await` 扫描 loop 中的 coroutine。发送消息时使用 `asyncio.run_coroutine_threadsafe(..., self._scan_loop)`。

## 4. `TuiLiveView` 是展示投影

[`TuiLiveView`](../../strix/interface/tui/live_view.py) 保存：

```text
agents: agent_id -> UI 字段
events: chat/tool 事件列表
open assistant event: 流式文本聚合
tool event by call_id: 调用与输出配对
```

它消费两种输入：

- live SDK events：`raw_response_event` 文本 delta、tool call/output items。
- 磁盘 Session history：恢复/Viewer 时从 agents.db 读取。

工具调用和结果通过 `call_id` 关联；输出到达时更新同一个 event 的 `status/result/version`。流式 assistant delta 也更新同一个 open event，最终消息到达后关闭 streaming 标志。

这不是业务真相源。Agent 真正状态仍属于 Coordinator，历史仍属于 SQLite；`TuiLiveView` 是可重建的 UI projection。

## 5. 历史数据库读取

[`load_session_history()`](../../strix/interface/tui/history.py) 以 SQLite URI：

```text
file:<agents.db>?mode=ro
```

只读打开，不使用 `immutable=1`，因为 live scan 的 WAL 仍在增长，Viewer 必须看到最新已提交内容。WAL 允许 reader 与 writer 并发。

它按 `agent_messages.id` 排序，过滤目标 session IDs，解析 `message_data` JSON，并把 SQLite timestamp 转成 UTC ISO。

## 6. `strix view` 的命令路由

[`run_view()`](../../strix/viewer/cli.py)：

1. 检查预构建 SPA 是否存在。
2. 选择指定 run 或 `run.json` mtime 最新的 run。
3. 启动 `serve()`，默认 host `127.0.0.1`、port `0`（自动空闲端口）。
4. 打开带授权 token 的 URL。
5. 当前进程 sleep loop 直到 Ctrl-C，然后 shutdown server。

它不要求 Docker、模型或目标参数，因此在主扫描 parser 之前分派。

## 7. Python Viewer Server

[`strix/viewer/server.py`](../../strix/viewer/server.py) 使用标准库 `ThreadingHTTPServer`。选择同步线程服务器的原因是负载很简单：静态文件 + 小型 JSON 磁盘读取，没必要增加 async web 框架依赖。

主要 GET API：

| Endpoint | 数据 |
| --- | --- |
| `/api/run` | `run.json` + computed `finished` |
| `/api/vulnerabilities` | `vulnerabilities.json` |
| `/api/report` | 最终 Markdown |
| `/api/transcript` | Agent 图 + Session 投影事件 |
| `/api/capabilities` | 是否可 steering |
| `/api/runs` | 历史 run 摘要（有门禁） |
| `/api/auth/status` | 本地验证状态（有 capability 限制） |

主要 POST API：event telemetry、OTP start/verify/forget、加密报告发送、Agent steering。

## 8. 为什么每次请求都读磁盘

`read_run_summary()`、`read_vulnerabilities()`、`build_run_state()` 不保留长生命周期 cache。收益：

- live/finished run 使用相同 API。
- Viewer 可以在独立进程启动。
- 不需要跨进程 event bus。
- 短轮询在电脑休眠/网络闪断后自然恢复。

代价是 live transcript 每次需要读取 agents.json/SQLite。当前是本地单用户 viewer，数据量和 500ms 轮询下可接受；规模增长时才需要增量 endpoint 或 server cache。

## 9. `finished` 的定义

Viewer 不是只看 status：

```python
finished = (
    status in {"completed", "stopped", "failed", "interrupted"}
    and bool(end_time)
)
```

有终态但还没写 end_time 的瞬间仍当 live，防止前端过早停止轮询而错过最后产物。

## 10. Viewer 的本地 capability 模型

server 启动时生成 32-byte URL-safe `session_token`。授权流程：

```text
serve() 返回 token
 -> CLI/TUI 打印或打开 /?token=<token>
 -> server 用 compare_digest 验证
 -> 只在 index response 设置 HttpOnly; SameSite=Strict cookie
 -> 后续敏感 API 用 cookie 与 session_token 比较
```

只访问裸 `/` 的网络客户端拿不到 cookie。静态资源也不会发 cookie。tokened URL 本身是 capability，分享它等于授权对方访问敏感功能。

默认只绑定 `127.0.0.1`，但代码仍做 request-level capability 校验，因为用户可通过隐藏 `--host` 暴露端口，或者本地有其他不可信进程。

## 11. 当前 run 与历史 run 的不同门禁

启动 Viewer 时选择的 run 始终可查看，这是命令的核心用途。其他历史 run 要求：

1. 当前请求持有 session capability；
2. 本地 email verification 未过期。

`resolve_run_dir()` 只允许 runs base 的直接子目录，并要求存在 `run.json`，防止 `?run=../../...` 路径穿越。

静态资源 `_resolve_asset()` 也对 resolve 后的 Path 检查是否仍在 bundle root 内。

## 12. Email auth 与报告发送

[`strix/viewer/auth.py`](../../strix/viewer/auth.py) 把 token 保存在：

```text
~/.strix/viewer-auth.json
```

并尝试设 `0600`。expiry 可解析 ISO 8601 或 epoch，缺失/不可解析一律 fail closed。

本地 server 代理 OTP/报告请求到 Strix relay，浏览器不直接联系 relay。发送报告时：

1. 只允许 finished run。
2. 本地生成加密 PDF、随机密码。
3. relay 只收到加密 PDF，不收到密码。
4. 密码只返回本地浏览器。

这减少 relay 能读取报告明文的机会，但 tokened Viewer URL 和本地返回密码仍需谨慎保护。

## 13. Steering 的线程桥接

standalone `strix view` 没有 Coordinator 和扫描 event loop，因此 steering unavailable。

TUI 的 `action_open_viewer()` 传入 `_viewer_steer(agent_id, message)`，内部复用 TUI 的 `send_user_message_to_agent()`：

```text
HTTP handler thread
 -> steer_handler
 -> run_coroutine_threadsafe(..., scan_loop)
 -> coordinator.send()
 -> 目标 Agent Session + wake/cancel stream
```

消息长度限制 4000，必须有非空 agent ID 与 session capability。HTTP handler 不直接操作 async Coordinator。

## 14. React 数据层与轮询

前端入口在 [`strix/viewer/frontend/src/App.tsx`](../../strix/viewer/frontend/src/App.tsx)，数据接口集中在 [`serverSource.ts`](../../strix/viewer/frontend/src/data/serverSource.ts)。

首次加载 `fetchAll()` 并发请求 run、vulnerabilities、report、transcript。live run 之后每 500ms：

1. 拉 run summary。
2. 如果首次发现 finished，再完整 fetch 一次并停止轮询。
3. 否则并发拉 transcript 和 vulnerabilities。
4. 报告 Markdown 沿用上次值，因为 live scan 通常还没有最终报告。

轮询 effect 在 active run 改变时 cleanup timer 并重新开始，`cancelled` 标志阻止旧请求回写新选择的 state。

## 15. 前端组件结构

核心层次：

```text
App.tsx
├─ Sidebar / RunSwitcher / PastRunsView
├─ Overview / RunDetails / severity summary
├─ VulnerabilityDetail
├─ AgentGraph
│  ├─ AgentNode
│  └─ AgentDetailModal / AgentTranscript
│     └─ tool-renderers/*
├─ ScanPromptComposer
└─ EmailReportView
```

工具 renderer 按工具类型把通用 transcript event 转成专门 UI，例如 terminal、proxy、todo、vuln report。未知工具走 fallback renderer，因此新增工具不会让整个 transcript 无法展示。

## 16. 构建与发布前端

源码不直接随 wheel 发布，构建产物 `strix/viewer/static/` 才随包发布。修改 frontend 后必须：

```bash
make viewer
```

或：

```bash
cd strix/viewer/frontend
npm ci
npm run build
```

然后同时提交 source 和重新生成的 static bundle。`pyproject.toml` 明确在 wheel 中 exclude frontend source，保留 static。

## 17. 本章实验

```bash
uv run pytest \
  tests/test_viewer.py \
  tests/test_viewer_auth.py \
  tests/test_viewer_runs_gating.py -q
```

前端类型/构建验证：

```bash
cd strix/viewer/frontend
npm ci
npm run build
```

## 18. 自测题

1. TuiLiveView 为什么不是 Agent 状态真相源？
2. Viewer 为什么不用 SSE/WebSocket，而使用短轮询？
3. status 已 terminal 时为什么还检查 end_time？
4. 为什么裸 `/` 请求不能得到 session cookie？
5. standalone Viewer 和 TUI Viewer 的 steering 能力为什么不同？
