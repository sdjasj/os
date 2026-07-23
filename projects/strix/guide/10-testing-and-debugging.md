# 10. 测试体系与调试方法

Strix 连接模型、Docker、SQLite、Git、HTTP server 和 React。高效调试的关键是先定位故障层，再运行最小测试集合，而不是每次都启动完整扫描。

## 1. 质量工具概览

项目配置集中在 [`pyproject.toml`](../../pyproject.toml)：

- pytest + pytest-asyncio，`asyncio_mode = "auto"`。
- mypy strict。
- pyright strict。
- Ruff target Python 3.12、行宽 100、启用大量规则集。
- Bandit 做 Python 安全检查。
- pre-commit 还包含 whitespace、TOML、冲突标记、大文件、debug statement、pyupgrade 等。

常用只读检查：

```bash
uv run pytest -q
uv run ruff check strix tests
uv run ruff format --check strix tests
uv run mypy strix/
uv run pyright strix/
uv run bandit -r strix/ -c pyproject.toml
```

注意 `make lint` 使用 `ruff check . --fix`，`make format` 也会改文件；要先诊断时优先使用上面的非修改命令。

### 当前代码快照的测试基线

在本教程对应的 2026-07-22 快照上，首次执行全量测试得到 `314 passed, 2 failed`。两项失败是：

```text
tests/test_runner_root_prompt.py::test_root_prompt_options_flow_into_root_agent
tests/test_runner_root_prompt.py::test_root_prompt_options_default_to_none
```

失败原因是该文件的 `_patch_engine_scaffold()` 把 `load_settings()` mock 成只有 `llm` 字段的 `SimpleNamespace`，而当前 [`run_strix_scan()`](../../strix/core/runner.py) 还会读取 `settings.runtime.max_context_images`。因此出现：

```text
AttributeError: 'types.SimpleNamespace' object has no attribute 'runtime'
```

这是现有测试 fixture 与 Runner 配置契约不同步，不是教程 Markdown 引起的运行代码回归。学习时可以先运行其他定向测试；修复项目基线时，应让 fixture 提供与真实 `Settings` 一致的最小 `runtime.max_context_images`，而不是从 Runner 删除该功能。

## 2. 测试按依赖层次分类

### 纯函数测试

不需要网络、Docker、真实模型：

- 目标分类、目标列表、diff 输出解析。
- 配置 JSON 与 alias。
- Markdown/SARIF 渲染。
- severity/cost 辅助计算。

这类测试最快，应当是改代码后的第一道反馈。

### 临时文件/SQLite/Git 测试

使用 `tmp_path` 创建隔离目录：

- ReportState 与 writer。
- local source staging。
- Viewer run directory。
- Git provenance 和 diff scope。

它们验证真实文件语义，但不污染仓库和用户 home。

### 异步状态测试

使用 `@pytest.mark.asyncio` 或自动 asyncio mode：

- Coordinator wait/wake/budget stop。
- Session manager/backend interactions。
- tool async behavior。

### mock 外部 SDK 测试

使用 `MagicMock`、`AsyncMock`、`monkeypatch` 隔离 Docker、模型、relay。例如 [`tests/test_docker_client_delete.py`](../../tests/test_docker_client_delete.py) 不需要真的创建容器。

### 本地 HTTP 集成测试

[`tests/test_viewer.py`](../../tests/test_viewer.py) 真正启动 ephemeral `ThreadingHTTPServer`，通过 urllib 请求 API/静态文件，但 bundle、run 目录和外部 relay 都是本地 fixture。

## 3. `tmp_path`：文件系统测试的默认选择

报告 writer 测试的典型结构：

```python
def test_write_and_read_run_record_round_trip(tmp_path: Path) -> None:
    payload = {"scan_id": "scan-abc", "status": "completed"}
    write_run_record(tmp_path, payload)
    assert read_run_record(tmp_path) == payload
```

好处：

- 测试自动获得唯一空目录。
- pytest 负责生命周期。
- 不依赖当前工作目录。
- 失败时 pytest 可保留最近临时目录供检查。

测试运行目录函数时，配合 `monkeypatch.chdir(tmp_path)`，因为 `run_dir_for()` 明确基于 `Path.cwd()`。

## 4. `monkeypatch`：控制全局和环境

配置 loader 有 `_cached` 与 `_override`，测试用 autouse fixture 重置：

```python
@pytest.fixture(autouse=True)
def _reset_loader_state(monkeypatch):
    monkeypatch.setattr(loader, "_cached", None)
    monkeypatch.setattr(loader, "_override", None)
```

它还用 `setenv/delenv` 验证配置优先级。

推荐原则：patch“被测模块实际查找的名字”，而不是最初定义位置。例如 server 内通过 `bundle_dir()` 查资源，测试 patch `strix.viewer.server.bundle_dir`，不是 patch `pathlib.Path`。

## 5. 异步测试要验证状态转换

[`tests/test_execution.py`](../../tests/test_execution.py) 中预算停止测试：

```python
waiter = asyncio.create_task(coordinator.wait_for_message("parent"))
await asyncio.sleep(0)
assert not waiter.done()

await coordinator.trigger_budget_stop()
await asyncio.wait_for(waiter, timeout=1.0)
```

`await asyncio.sleep(0)` 不是人为等待一秒，而是让出一次事件循环，使 waiter 真正进入 park。最后加 `wait_for(..., timeout=1)` 防止测试 bug 导致测试套件永久挂起。

并发代码不要只断言最终 dict；还要断言等待者是否被唤醒、Task 是否结束、状态是否按预期转换。

## 6. 测试安全不变量

项目中值得模仿的安全测试包括：

- out-of-tree symlink 必须丢弃。
- Viewer asset/run path traversal 必须拒绝。
- 没有 token 的客户端不能获得 capability 或 steering。
- 报告 relay payload 不得包含 PDF 密码。
- SARIF 不得包含 PoC script。
- LLM/目标控制的反引号不能逃出 Markdown fence。
- 配置文件权限应为 `0600`。
- 恢复时损坏 JSON 不得静默覆盖旧数据。

安全代码不仅测试成功路径，还要把“绝不能发生什么”写成回归测试。

## 7. 如何为改动选择最小测试集合

| 修改区域 | 优先测试 |
| --- | --- |
| `config/`、模型 helper | `test_config_loader.py`、`test_models.py`、`test_provider_hints.py` |
| target/diff | `test_inputs.py`、`test_local_sources.py`、`test_cli_target_list.py` |
| Agent factory/skills | `test_agent_factory_shell.py`、`test_agent_tool_registration.py`、`test_skill_dir_extension.py` |
| Coordinator/execution | `test_execution.py`、`test_runner_*`、`test_session_entries.py` |
| runtime | `test_local_dir_staging.py`、`test_docker_client_delete.py` |
| report | `test_report_writer.py`、`test_reporting_fields.py`、`test_sarif*.py`、`test_cost_tracking.py` |
| Viewer | `test_viewer*.py`、`test_report_pdf.py` |

推荐循环：

```text
单个失败用例
 -> 对应测试文件
 -> 相关模块测试组
 -> 全量 pytest
 -> lint/format/type/security
```

## 8. 测试命名本身是规格

测试名常比实现注释更直接。例如：

```text
test_wait_for_message_returns_immediately_after_budget_stop
test_write_sarif_never_embeds_poc_script
test_capability_issued_only_for_tokened_bootstrap
test_out_of_tree_symlink_is_dropped
```

学习模块时可先执行：

```bash
rg '^def test_|^async def test_' tests/test_sarif.py
```

先从测试名建立行为清单，再读实现和 fixtures，最后回源码验证。

## 9. 前端验证

当前 `package.json` 没有独立 test/lint script，最低门槛是 TypeScript/Vite build：

```bash
cd strix/viewer/frontend
npm ci
npm run build
```

这会重建 `strix/viewer/static/`。如果只是学习、无意修改 bundle，构建后先看 `git status`，不要误把机械 bundle 变化混入其他改动。

前端数据协议的后端测试集中在 Viewer pytest；修改字段时要同步检查：

```text
viewer/transcript.py 或 server.py
frontend/src/data/serverSource.ts
frontend/src/types/*
消费该字段的组件
```

## 10. 分层排障树

### 命令在 parser 前失败

检查 Python/uv/安装入口：

```bash
uv run python -c "import strix; print(strix.__file__)"
uv run strix --version
```

### 参数或目标失败

直接调用 `infer_target_type()`，运行 target tests；不要先启动 Docker。

### 配置/模型预热失败

打印非敏感字段：模型名、base URL 是否设置、provider prefix；不要打印 key。运行 model tests，检查可选 extra。

### 容器创建/Caido 失败

检查 `docker info`、镜像、`strix.log`、容器 logs、entrypoint/Caido readiness。确认 SDK 固定版本没有被改变。

### Agent 不结束

检查 `agents.json` statuses、`strix.log` 中 lifecycle tool、non-interactive recovery warning，以及是否有 waiting child。

### 恢复失败

同时检查 `.state/agents.json` 和 `.state/agents.db`，再检查原 clone 路径。不要手工用空文件“修复”数据库。

### 报告缺失

检查 `run.json.status/scan_results`、`vulnerabilities.json`、是否调用 `finish_scan`，以及 `ReportState` 是否已全局设置。

### Viewer 数据不更新

分别请求 `/api/run`、`/api/transcript`，确认 end_time/finished；再看浏览器 network 和 React effect。先区分“后端没读到”还是“前端没渲染”。

## 11. 日志系统

每个 run 创建：

```text
strix_runs/<run>/strix.log
```

文件始终收 DEBUG，stderr 默认只显示 ERROR；设置：

```bash
export STRIX_DEBUG=1
```

可让 stderr 显示 DEBUG。日志格式包含 scan ID、agent ID、logger name。它使用 `ContextVar`，异步 Task 会继承创建时上下文，比进程全局字符串更适合多 Agent。

LiteLLM/httpx 等 noisy logger 被限制到 WARNING，避免淹没业务日志。

常用查询：

```bash
rg 'ERROR|failed|crashed|BudgetExceeded|rate limit' strix_runs/<run>/strix.log
rg 'agent.register|agent.status|respawn' strix_runs/<run>/strix.log
rg 'finish_scan|vulnerability report' strix_runs/<run>/strix.log
```

## 12. 写一个好回归测试

假设修复“budget stop 没唤醒等待 Agent”：

1. 先写能稳定复现的 async test。
2. 用 Event/timeout，不用真实 sleep 秒级等待。
3. 断言修复前失败的核心行为，而不是日志文案。
4. 修实现。
5. 跑 `test_execution.py`。
6. 跑全量测试和类型检查。

避免只测试私有实现步骤。如果业务契约是“预算停止后 waiter 返回”，就断言 waiter 返回；不要过度绑定 `_budget_stopped` 内部赋值顺序。

## 13. 本章练习

1. 选择一个纯函数，为边界值补一个测试，但先不改源码。
2. 为一个 async Coordinator 场景画 Given/When/Then。
3. 阅读 Viewer path traversal 测试，指出 server 的两层路径防护。
4. 故意给本地临时 `run.json` 写非法 JSON，调用 `read_run_record()`，观察异常类型。

## 14. 自测题

1. 为什么 async waiter 测试需要 `sleep(0)` 和 timeout？
2. 为什么 patch 应发生在被测模块查找的位置？
3. `make lint` 为什么不适合纯诊断阶段？
4. 如何判断 Viewer bug 在磁盘协议、Python API 还是 React state？
5. 哪些测试表达了项目的安全不变量？
