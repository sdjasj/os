# 00. 背景知识与阅读准备

这一章补足理解 Strix 所需的最小背景。重点不是把每个技术学到专家水平，而是建立一套能读懂项目代码的词汇和心智模型。

## 1. Python 包、入口点与依赖

[`pyproject.toml`](../../pyproject.toml) 同时承担包元数据、依赖、命令入口和工具配置。最关键的一行是：

```toml
[project.scripts]
strix = "strix.interface.main:main"
```

它表示安装项目后，终端里的 `strix` 命令最终调用 `strix/interface/main.py` 中的 `main()`。冒号左边是模块，右边是函数。

项目要求 Python 3.12+，主要依赖可以分成几组：

- `openai-agents`、`openai`、`litellm`：Agent 运行、模型调用和多提供商路由。
- `pydantic`、`pydantic-settings`：类型化配置和环境变量解析。
- `docker`：创建和管理隔离扫描容器。
- `rich`、`textual`：非交互 CLI 与交互式 TUI。
- `caido-sdk-client`：查询和重放经过代理的 HTTP 请求。
- `reportlab`、`pypdf`：Viewer 的 PDF 报告能力。

阅读依赖时不要只问“这个库做什么”，还要问“Strix 把哪个责任交给了这个库”。例如，SDK 负责模型与工具循环，`ReportState` 只负责 Strix 自己的产品产物；两者边界在 [`strix/report/state.py`](../../strix/report/state.py) 的类注释中写得很明确。

## 2. 同步、异步、任务与事件

Strix 的扫描核心是异步的。你至少要理解下面四个概念。

### 2.1 协程

`async def` 定义协程函数，调用后必须 `await` 才真正等待结果：

```python
async def create_or_reuse(...):
    client, session = await backend(...)
    caido_endpoint = await session.resolve_exposed_port(48080)
```

这里等待容器和网络 I/O 时，事件循环仍能执行其他 Agent 的任务。

### 2.2 事件循环

同步入口用 `asyncio.run(...)` 创建事件循环。主入口根据模式执行：

```python
if args.non_interactive:
    asyncio.run(run_cli(args))
else:
    asyncio.run(run_tui(args))
```

这也是为什么不要在已经运行的异步函数里再次调用 `asyncio.run()`。

### 2.3 Task

[`strix/core/execution.py`](../../strix/core/execution.py) 中的 `_start_child_runner()` 使用：

```python
task_handle = asyncio.create_task(
    _child_loop(),
    name=f"agent-{name}-{child_id}",
)
```

`create_task()` 让子 Agent 与父 Agent 并发推进。这里的“并发”通常是多个 I/O 任务交替执行，不等同于多个 CPU 线程并行计算。

### 2.4 Event 与 Lock

`AgentCoordinator` 使用 `asyncio.Event` 唤醒等待消息的 Agent，使用 `asyncio.Lock` 保护共享拓扑。可以把它们理解为：

- `Event`：一个可等待的“门铃”；消息到达或预算停止时按铃。
- `Lock`：同一时刻只允许一个协程修改共享字典。

[`strix/core/sessions.py`](../../strix/core/sessions.py) 还为每个 SDK Session 建立写锁，避免普通模型循环和外部消息同时改写会话。

## 3. 数据类、Pydantic 与普通字典

项目同时使用三种数据表达方式，各有用途：

1. `@dataclass(slots=True)`：内部运行时对象，例如 `AgentRuntime`，字段固定、开销小。
2. Pydantic `BaseSettings`：从环境变量读取并校验配置，例如 `LlmSettings`。
3. `dict[str, Any]`：跨模块传递的扫描上下文和 JSON 产物，例如 `scan_config`。

为什么 `scan_config` 不做成 Pydantic 模型？从当前代码看，它需要被 CLI、TUI、Runner、ReportState 和磁盘 JSON 灵活共享，字典降低了跨层耦合；代价是字段名错误只能在运行时发现。阅读时建议手工列出它的字段：

```text
scan_id, targets, user_instructions, run_name, diff_scope,
scan_mode, non_interactive, local_sources, scope_mode,
diff_base, resume_instruction
```

## 4. 依赖注入、闭包与运行上下文

Strix 没有使用大型依赖注入框架，但大量使用“把依赖作为参数传入”的方式。

例如 `run_strix_scan()` 创建 `context`：

```python
context = {
    "coordinator": coordinator,
    "sandbox_session": bundle["session"],
    "caido_client": bundle["caido_client"],
    "agent_id": root_id,
    "parent_id": None,
    "interactive": interactive,
    "spawn_child_agent": spawn_child_agent,
}
```

工具通过 `RunContextWrapper.context` 获取这些能力，因此工具不需要导入 Runner 的内部实现。

`make_child_factory()` 则用闭包捕获扫描级参数：

```python
def make_child_factory(...):
    def _factory(*, name: str, skills: list[str]):
        return build_strix_agent(
            name=name,
            skills=skills,
            scan_mode=scan_mode,
            ...
        )
    return _factory
```

闭包让 `create_agent` 工具只关心“名称、任务、技能”，不需要知道模型 schema、扫描模式等 Runner 细节。

## 5. Agent、模型、工具、技能与会话

这五个词很容易混淆：

- **模型（model）**：产生下一步文本或工具调用的 LLM。
- **Agent**：模型加系统指令、工具集合和终止规则的运行单元。
- **工具（tool）**：Agent 可调用的有类型能力，例如执行命令、查询代理、创建漏洞报告。
- **技能（skill）**：Markdown 形式的领域知识，注入系统提示词或临时加载到对话；它不是可执行代码。
- **会话（session）**：模型输入、输出和工具调用的持久化历史。Strix 使用 SQLite Session。

一个简化公式是：

```text
Agent = 系统提示词(基础规则 + 技能 + 已验证范围)
      + 工具集合(通用工具 + 生命周期工具)
      + 模型配置
      + 会话历史
```

## 6. 状态机与生命周期工具

Agent 状态定义在 [`strix/core/agents.py`](../../strix/core/agents.py)：

```python
Status = Literal[
    "running", "waiting", "completed",
    "stopped", "crashed", "failed",
]
```

不要把“模型给出一段最终文本”自动理解为扫描完成。Strix 要求生命周期工具给出结构化成功结果：

- 根 Agent 调用 `finish_scan`。
- 子 Agent 调用 `agent_finish`。
- 交互模式中 `wait_for_message` 可以让本轮结束并进入等待。

这是一个重要的 Agent 工程原则：把业务完成条件编码成可验证的状态转换，而不是仅依赖自然语言。

## 7. Docker 沙箱与 HTTP 代理

Agent 会运行 shell、浏览器和安全测试工具，不能直接在宿主进程中无限制执行。Strix 创建 Docker 容器，并把本地源码复制或只读挂载到容器的 `/workspace/<subdir>`。

容器中还运行 Caido：

```text
Agent 命令/浏览器
    -> http_proxy / https_proxy
    -> 容器内 Caido :48080
    -> 目标站点
```

Caido 既转发流量，也保存请求，让 `list_requests`、`view_request`、`repeat_request` 等工具能检查和重放历史流量。为了解密 HTTPS，容器会安装专用测试 CA；这套 CA 只应存在于扫描容器中。

## 8. HTTP Viewer 与 React SPA

本地 Viewer 是一个典型的前后端分离结构，但部署很轻量：

- Python 标准库 `ThreadingHTTPServer` 提供静态文件和 JSON API。
- React/Vite 源码在 `strix/viewer/frontend/`。
- 构建产物提交在 `strix/viewer/static/`，随 Python wheel 发布。
- 浏览器轮询磁盘状态；完成后停止轮询。

“SPA”表示主要页面由前端 JavaScript 渲染，未知非 API 路径回退到 `index.html`。

## 9. SARIF、CVSS、CWE 与 CVE

- **CVSS**：用攻击向量、复杂度、权限、影响等指标计算漏洞严重度。
- **CWE**：弱点类别，例如输入验证或访问控制问题。
- **CVE**：公开披露的具体漏洞编号，常用于依赖组件漏洞。
- **SARIF**：静态分析结果交换格式，GitHub Code Scanning 等平台可消费。

Strix 的动态漏洞和依赖 CVE 有不同报告入口，但最终都归一为漏洞记录，再转换为 Markdown、JSON、CSV 与 SARIF。

## 10. 开始前的小实验

先运行三个不需要 Docker 或 API Key 的实验：

```bash
uv run python -c "from strix.core.paths import run_dir_for; print(run_dir_for('demo'))"
uv run python -c "from strix.interface.utils import infer_target_type; print(infer_target_type('127.0.0.1'))"
uv run pytest tests/test_config_loader.py -q
```

回答下面的问题再进入下一章：

1. `asyncio.create_task()` 与直接 `await` 子协程有什么行为差异？
2. 技能为什么不是工具？
3. 为什么 Strix 需要显式的 `finish_scan`，不能把普通文本输出当成完成？
4. `scan_config` 与 `RunContextWrapper.context` 各由谁创建、给谁使用？

