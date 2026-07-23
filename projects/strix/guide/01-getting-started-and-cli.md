# 01. 安装、运行与 CLI 启动链

本章目标是从终端命令一路追到扫描核心，并理解启动阶段为什么要做这么多预检。

## 1. 建立开发环境

项目推荐使用 `uv`：

```bash
uv sync
uv run pytest -q
```

`uv sync` 会依据 [`pyproject.toml`](../../pyproject.toml) 和 `uv.lock` 创建或更新虚拟环境。`make setup-dev` 在此基础上安装 pre-commit hook：

```bash
make setup-dev
```

只阅读和运行单元测试时不需要 LLM Key，也不需要启动完整扫描。运行真实扫描还需要：

```bash
docker info
export STRIX_LLM="openai/gpt-5.4"
export LLM_API_KEY="..."
uv run strix --target ./some-authorized-project
```

不要把真实密钥写进教程、测试或提交记录。

## 2. 命令从哪里进入项目

入口声明：

```toml
[project.scripts]
strix = "strix.interface.main:main"
```

因此第一个应读的函数是 [`strix/interface/main.py`](../../strix/interface/main.py) 中的 `main()`。它的职责可以分成七个阶段：

```text
1. 配置第三方日志
2. 提前分派 `strix view`
3. 解析扫描参数
4. 检查 Docker、拉取镜像、校验并预热 LLM
5. 归一化目标、准备本地源码和 diff scope
6. 选择 run_cli() 或 run_tui()
7. 记录结束原因、清理并显示结果
```

### 为什么 `strix view` 要提前分派

`main()` 在调用扫描参数解析器之前检查 `sys.argv[1] == "view"`。扫描 parser 要求目标，而 Viewer 只需要已有的运行目录。如果不提前分派，`strix view my-run` 会被误判成缺少 `--target`。

这是 CLI 设计中的一个小型“子命令路由器”。如果项目未来有更多子命令，可以考虑迁移到 argparse subparsers；当前实现对单个 `view` 子命令足够直接。

## 3. `parse_arguments()` 不只是解析字符串

[`parse_arguments()`](../../strix/interface/main.py) 同时做语法校验和部分输入归一化。关键参数包括：

| 参数 | 作用 |
| --- | --- |
| `-t/--target` | URL、仓库、本地目录、域名或 IP；可重复 |
| `--target-list` | 从文件批量读取目标 |
| `--mount` | 把大型本地目录只读 bind mount 进沙箱 |
| `--instruction` / `--instruction-file` | 用户附加测试说明，二者互斥 |
| `-n/--non-interactive` | 使用 CLI，不启动 TUI |
| `--scan-mode` | `quick`、`standard`、`deep` |
| `--scope-mode` | `auto`、`diff`、`full` |
| `--max-budget-usd` | LLM 成本上限，必须为正有限数 |
| `--resume` | 恢复已有运行，不能再传新目标 |

新运行的目标会依次经过：

```python
target_type, target_dict = infer_target_type(target)
args.targets_info.append({
    "type": target_type,
    "details": target_dict,
    "original": display_target,
})
```

随后还会：

1. 把 `--mount` 转成 `local_code` 目标。
2. 对本地目标去重。
3. 分配唯一的 `workspace_subdir`。
4. 把 URL 中的 localhost 改写为容器可达的 `host.docker.internal`。
5. 拒绝超过复制阈值的本地目录，提示改用 `--mount`。

这里得到的 `targets_info` 是后续各层共享的标准目标表示。例如本地代码目标大致是：

```json
{
  "type": "local_code",
  "details": {
    "target_path": "/absolute/host/path",
    "workspace_subdir": "my-project"
  },
  "original": "/absolute/host/path"
}
```

## 4. 恢复运行是一条不同的输入路径

传入 `--resume <run>` 时，CLI 不重新解析目标，而是从 `strix_runs/<run>/run.json` 恢复：

- `targets_info`
- 原始 instruction（除非用户本次提供新 instruction）
- `local_sources`
- `diff_scope`
- 先前的 `scan_mode`

并检查 `.state/agents.json` 是否存在。只有 `run.json` 而没有 Agent 快照，说明上次运行尚未真正进入 Agent 阶段，无法恢复对话。

仓库目标还会检查原先 clone 的目录是否仍存在；恢复并不会自动重新 clone，因为那可能对应不同的 commit 和工作树状态。

## 5. 启动预检顺序

`main()` 当前顺序是：

```python
check_docker_installed()
pull_docker_image()
validate_environment()
asyncio.run(warm_up_llm(...))
persist_current()
```

理解各步骤的边界：

- `check_docker_installed()` 只看 CLI 是否在 `PATH`。
- `pull_docker_image()` 通过 Docker daemon 检查/拉取镜像。
- `validate_environment()` 要求模型名，API Key 对某些本地或云身份方案是可选的。
- `warm_up_llm()` 发送一个最小模型请求，尽早发现模型名、凭证或可选依赖问题。
- `persist_current()` 把当前相关环境变量保存到 `~/.strix/cli-config.json`，并尝试设为 `0600`。

预热的价值是“在创建容器和复杂状态前失败”。代价是每次新进程都会产生一次真实模型请求。

## 6. 本地源码与 diff scope 的准备

对 repository 目标，`main()` 先 clone 到运行相关目录，再调用 `collect_local_sources()`。本地目录与 clone 后的仓库会被统一成：

```text
source_path       宿主机绝对路径
workspace_subdir  容器 /workspace 下的子目录
mount             是否只读 bind mount
```

然后 `resolve_diff_scope_context()` 可能生成 PR 差异说明。这段说明会被拼接进用户 instruction，同时结构化 metadata 也会进入 `scan_config`。第 4 章会详细解释。

## 7. CLI 如何构造 `scan_config`

非交互模式进入 [`strix/interface/cli.py`](../../strix/interface/cli.py) 的 `run_cli(args)`。它先创建 `ReportState`，然后构造：

```python
scan_config = {
    "scan_id": args.run_name,
    "targets": args.targets_info,
    "user_instructions": args.instruction or "",
    "run_name": args.run_name,
    "diff_scope": args.diff_scope,
    "scan_mode": scan_mode,
    "non_interactive": args.non_interactive,
    "local_sources": args.local_sources,
    "scope_mode": args.scope_mode,
    "diff_base": args.diff_base,
    "resume_instruction": args.user_explicit_instruction or "",
}
```

随后：

```python
report_state = ReportState(args.run_name)
report_state.hydrate_from_run_dir()
report_state.set_scan_config(scan_config)
set_global_report_state(report_state)
```

这里有两个重要动作：

1. 恢复已有报告，避免恢复扫描后从 `vuln-0001` 重新编号并覆盖旧文件。
2. 设置全局 `ReportState`，让工具在 SDK context 之外也能写产品报告。

最后 `run_cli()` 调用 `run_strix_scan(...)`。TUI 也会调用同一个核心，只是多传一个 `event_sink` 来接收流式事件。

## 8. 一次命令的最小调用链

以 `uv run strix -n -t ./demo --scan-mode quick` 为例：

```text
pyproject script
└─ main()
   ├─ parse_arguments()
   │  ├─ infer_target_type("./demo")
   │  ├─ assign_workspace_subdirs(...)
   │  └─ resolve_diff_scope_context(...)
   ├─ Docker 与 LLM 预检
   ├─ _persist_run_record(...)
   └─ asyncio.run(run_cli(args))
      ├─ ReportState(...)
      ├─ scan_config = {...}
      └─ run_strix_scan(...)
```

注意：完整错误处理、telemetry 和最终 UI 输出让 `main.py` 较长，但核心业务入口仍然只有 `run_strix_scan()`。

## 9. 本章实验

### 实验 A：查看 parser 帮助而不启动扫描

```bash
uv run strix --help
```

把帮助中的参数与 `parse_arguments()` 的 `add_argument()` 一一对应。

### 实验 B：观察目标分类

只对本地/IP/明确 URL 做实验，避免 `_is_http_git_repo()` 发起网络探测：

```bash
uv run python - <<'PY'
from strix.interface.utils import infer_target_type

for value in ["127.0.0.1", "https://example.com?a=1", "."]:
    print(value, "=>", infer_target_type(value))
PY
```

### 实验 C：运行 CLI 目标列表测试

```bash
uv run pytest tests/test_cli_target_list.py -q
uv run pytest tests/test_inputs.py -q
```

## 10. 自测题

1. 为什么 `--resume` 不能和 `--target` 同时使用？
2. `args.targets_info` 和 `scan_config["targets"]` 的关系是什么？
3. 为什么要在扫描开始前预热 LLM？
4. 为什么 CLI 与 TUI 应共享 `run_strix_scan()`，而不各自实现扫描逻辑？
5. 本地 `localhost` 对容器来说指向哪里？项目如何解决这个问题？

