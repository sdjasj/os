# Strix 项目源码学习教程

> 适用代码快照：`strix-agent 1.2.0`（仓库 `pyproject.toml`），教程编写于 2026-07-22。
> 如果后续代码发生变化，请先以函数名搜索源码，再对照教程中的路径阅读。

这是一套“沿一次扫描的真实数据流学习 Strix”的中文教程。它不是对目录树的简单翻译，而是从用户执行 `strix --target ...` 开始，跟踪目标如何变成 `scan_config`，如何创建模型和 Agent，如何进入 Docker 沙箱执行工具，如何组织多 Agent，以及最终怎样落盘为 Markdown、JSON、CSV 和 SARIF 报告。

Strix 是自动化安全测试工具。阅读和实验时，只能测试自己拥有或明确获准测试的目标。教程中的安全概念用于理解项目设计，不代表对任意第三方目标的测试授权。

## 学完后应当能做什么

完成全部模块后，你应该能够：

1. 从 `pyproject.toml` 找到 CLI 入口，并完整讲清一次扫描的调用链。
2. 区分配置状态、扫描状态、Agent 会话状态和 UI 投影状态。
3. 解释根 Agent、子 Agent、工具、技能和系统提示词如何组合。
4. 解释为什么项目同时使用 `agents.json` 与 `agents.db`，以及恢复扫描如何工作。
5. 解释本地源码如何安全地进入 Docker、为什么需要 Caido sidecar，以及 HTTP 流量如何被代理。
6. 从漏洞工具调用跟踪到 `vulnerabilities.json`、单项 Markdown、CSV 和 SARIF。
7. 能够运行定向测试、定位常见故障，并添加一个技能、工具或沙箱后端。

## 推荐学习顺序

| 顺序 | 模块 | 重点 | 建议时间 |
| --- | --- | --- | --- |
| 0 | [00-背景知识与阅读准备](00-background.md) | Python 异步、Pydantic、Agent、Docker、代理 | 1～2 小时 |
| 1 | [01-安装、运行与 CLI 启动链](01-getting-started-and-cli.md) | 从 `strix` 命令追到 `run_cli` / `run_tui` | 2 小时 |
| 2 | [02-总体架构与一次扫描的数据流](02-architecture.md) | 分层、核心对象、时序、持久化边界 | 2～3 小时 |
| 3 | [03-配置系统与模型适配](03-configuration-and-models.md) | 配置优先级、模型路由、重试、推理参数 | 2 小时 |
| 4 | [04-目标解析与 PR Diff Scope](04-targets-and-diff-scope.md) | 目标归一化、本地源码、Git 差异范围 | 2 小时 |
| 5 | [05-Agent、提示词、技能与工具](05-agents-prompts-skills-tools.md) | `SandboxAgent` 的构建材料 | 3 小时 |
| 6 | [06-多 Agent 编排、会话与恢复](06-multi-agent-sessions-resume.md) | 状态机、消息、并发、SQLite、恢复 | 3～4 小时 |
| 7 | [07-沙箱运行时、Docker 与 Caido](07-sandbox-docker-caido.md) | 隔离、源码装载、容器定制、HTTP 代理 | 3 小时 |
| 8 | [08-漏洞报告、去重、SARIF 与成本](08-reporting-sarif-usage.md) | 产物管线、原子写、CI 集成、预算 | 3 小时 |
| 9 | [09-CLI/TUI 与本地 Web Viewer](09-interfaces-and-viewer.md) | 同一核心的三种界面、React 轮询、安全门禁 | 3 小时 |
| 10 | [10-测试体系与调试方法](10-testing-and-debugging.md) | pytest、异步测试、mock、分层排障 | 2～3 小时 |
| 11 | [11-扩展项目：技能、工具与后端](11-extending-strix.md) | 从最小扩展到集成测试 | 3～5 小时 |
| 12 | [12-循序渐进的练习与源码阅读清单](12-exercises-and-roadmap.md) | 练习题、验收标准、二次阅读路线 | 持续进行 |

如果你已经熟悉 Python 异步和 Docker，可以从第 1 章开始；如果目标是贡献代码，至少先读完第 1、2、5、6、10、11 章。

## 一条主线先记住

```text
pyproject.toml: strix 命令
  -> strix.interface.main.main()
  -> 参数/目标/配置预检
  -> run_cli() 或 run_tui()
  -> run_strix_scan()
  -> 创建沙箱 + ReportState + AgentCoordinator + 根 Agent
  -> run_agent_loop() / Runner.run_streamed()
  -> 工具调用、子 Agent、消息与漏洞报告
  -> strix_runs/<run>/ 下的运行记录和报告
  -> strix view 读取落盘文件并展示
```

学习任何局部模块时，都问自己三个问题：

1. 它接收什么数据？
2. 它修改的是内存状态、SDK 会话、容器状态，还是磁盘产物？
3. 它的结果由谁消费？

这三个问题能避免把同名的“状态”“会话”“报告”混在一起。

## 推荐的实践方式

每一章都按“读—跑—改—测”进行：

1. **读**：先阅读章内列出的 2～4 个核心函数，不要一开始通读大文件。
2. **跑**：执行定向测试或纯函数实验，观察真实输入输出。
3. **改**：只做一个很小、可撤销的实验，例如增加日志或添加一个测试用例。
4. **测**：先跑最接近改动的测试文件，再跑完整测试。

常用命令：

```bash
uv sync
uv run pytest -q
uv run pytest tests/test_execution.py -q
uv run ruff check strix tests
uv run mypy strix/
uv run pyright strix/
```

完整扫描还需要正在运行的 Docker 和 LLM 配置；大部分源码学习不需要真的发起安全扫描，纯函数与测试已经覆盖了大量关键行为。

## 教程中的路径约定

- `项目根目录` 指当前仓库根目录。
- `/workspace` 指沙箱容器内部的工作目录，不是宿主机仓库路径。
- `strix_runs/<run-name>` 指运行时从当前工作目录创建的扫描产物目录。
- `.state/agents.json` 是 Agent 拓扑快照；`.state/agents.db` 是 SDK 对话会话数据库。

教程只新增此目录下的文档，不修改项目运行逻辑。
