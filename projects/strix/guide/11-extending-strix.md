# 11. 扩展项目：技能、工具与后端

本章从风险最低的技能扩展开始，再介绍工具与运行时后端。所有示例都应先在本地分支和授权目标上验证。

## 1. 选择正确扩展点

先判断需求属于哪一层：

| 需求 | 扩展点 |
| --- | --- |
| 给 Agent 新的测试知识/命令范式 | Skill Markdown |
| 给 Agent 新的可执行能力 | FunctionTool / CustomTool |
| 改变工具在哪执行 | Sandbox backend |
| 增加扫描产物字段/格式 | reporting tool + ReportState/writer |
| 增加显示方式 | TUI renderer / React tool renderer |

能用技能解决时不要先写工具：技能没有宿主代码执行权限、风险低、迭代快。只有需要结构化调用、访问 context 或稳定副作用时才新增工具。

## 2. 添加内置技能

选择类别，例如：

```text
strix/skills/vulnerabilities/header_misconfiguration.md
```

建议结构：

```markdown
---
name: header_misconfiguration
description: Validate security header weaknesses without false positives.
---

# Objective

说明要验证什么，以及授权范围约束。

# Workflow

1. 枚举响应链和最终页面。
2. 区分缺失、配置错误和被中间层覆盖。
3. 用实际影响验证，不仅做 presence check。

# Validation

列出确认条件与常见误报。

# Reporting

说明需要保存的请求、响应和可复现步骤。
```

项目的 skill loader 会剥离 frontmatter，把正文注入系统 prompt。文件名是技能标识。

写完先验证：

```bash
uv run python - <<'PY'
from strix.skills import load_skills, validate_requested_skills

name = "vulnerabilities/header_misconfiguration"
print(validate_requested_skills([name]))
print(load_skills([name]).keys())
PY
```

## 3. 外部技能目录

不想修改包内文件时，可创建：

```text
my-strix-skills/
└── vulnerabilities/
    └── header_misconfiguration.md
```

并在构建 Agent 前注册：

```python
from pathlib import Path
from strix.skills import register_skill_dir

register_skill_dir(Path("my-strix-skills"))
```

最近注册目录优先，同相对路径可覆盖内置技能。覆盖适合 downstream 定制，但升级项目时应定期对比上游技能，避免长期漂移。

至少添加以下测试：

- 新技能能被发现。
- 限定名能加载正文且 frontmatter 被剥离。
- 同名覆盖遵循优先级。
- 裸名歧义时要求使用 category-qualified name。

参考 [`tests/test_skill_dir_extension.py`](../../tests/test_skill_dir_extension.py)。

## 4. 添加 FunctionTool

一个只读 context 工具示例：

```python
from __future__ import annotations

import json
from agents import RunContextWrapper, function_tool


@function_tool(timeout=10)
async def current_agent_identity(ctx: RunContextWrapper) -> str:
    """Return the current agent's addressable identity."""
    inner = ctx.context if isinstance(ctx.context, dict) else {}
    return json.dumps(
        {
            "agent_id": inner.get("agent_id"),
            "parent_id": inner.get("parent_id"),
            "interactive": bool(inner.get("interactive", False)),
        },
        ensure_ascii=False,
    )
```

`@function_tool` 会从 Python 类型提示生成 JSON schema，因此参数和返回语义要明确，import 也必须能在注册时解析 type hints。

## 5. 注册工具

在第一次构建扫描 Agent 前：

```python
from strix.agents.factory import register_agent_tools
from my_package.tools import current_agent_identity

register_agent_tools(current_agent_identity)
```

之后所有根/子 Agent 都会拥有它。若只想给一次工厂调用：

```python
agent = build_strix_agent(
    is_root=True,
    extra_tools=[current_agent_identity],
)
```

工具名必须唯一，不能与 base/lifecycle/其他注册工具冲突。注册时机和名称约束应在测试中固定：

```python
def test_identity_tool_is_registered():
    agent = build_strix_agent(
        is_root=True,
        extra_tools=[current_agent_identity],
    )
    names = [tool.name for tool in agent.tools]
    assert "current_agent_identity" in names
    assert names[-1] == "finish_scan"
```

测试全局注册表时要保存并恢复 `_EXTRA_TOOLS`，避免污染其他测试；参考 [`tests/test_agent_tool_registration.py`](../../tests/test_agent_tool_registration.py)。

## 6. 设计工具参数与结果

好的 Agent 工具应满足：

1. 参数少而清楚，类型足够生成严格 schema。
2. docstring 说明何时使用、何时不使用、副作用和完成条件。
3. 返回 JSON 或稳定的简短文本，错误对模型可理解。
4. timeout 与真实 I/O 上界一致。
5. 幂等或明确说明重复调用影响。
6. 不把密钥、绝对路径、内部 ID 泄漏到客户报告。
7. 有状态操作从 `ctx.context` 获取本扫描依赖，不依赖另一个隐式全局。

工具若需要 sandbox：

```python
inner = ctx.context if isinstance(ctx.context, dict) else {}
session = inner.get("sandbox_session")
```

工具若需要 Agent 图：

```python
from strix.core.agents import coordinator_from_context
coordinator = coordinator_from_context(inner)
```

缺少依赖时返回结构化失败，不要 `assert` 崩整个扫描。

## 7. 生命周期工具不要随意扩展

普通工具放在 lifecycle tool 之前。不要让新工具返回 `scan_completed`/`agent_completed`，也不要改 `_finish_tool_use_behavior()` 让任意成功工具终止 Agent。

若确实新增 lifecycle，必须同时考虑：

- root/child 权限边界；
- Coordinator 状态转换；
- interactive/non-interactive 行为；
- resume 后的状态；
- 报告是否已经原子落盘；
- active child gate；
- 现有纯文本恢复机制。

这属于高风险核心修改，应有状态机测试和端到端测试。

## 8. 新增 Sandbox backend

后端契约可概括为：

```python
async def my_backend(
    *,
    image: str,
    manifest,
    exposed_ports: tuple[int, ...],
    bind_mounts: list[dict] | None = None,
):
    client = ...
    session = ...
    await session.start()  # 若该后端 create 不会自动应用 manifest
    return client, session
```

注册：

```python
from strix.runtime.backends import register_backend

register_backend("my-runtime", my_backend)
```

再设置：

```bash
export STRIX_RUNTIME_BACKEND=my-runtime
```

自定义 backend 必须满足 `session_manager` 后续使用的行为：

- manifest local entries/environment 被应用。
- 能解析暴露的 Caido 48080 端口。
- session 支持 `exec()`。
- client 支持 `delete(session)`。
- bind mounts 要么实现同等语义，要么明确拒绝。
- cleanup 可重复调用或安全处理 already deleted。

不要用“返回两个 mock 对象就能启动”的表面兼容；真正契约由 `create_or_reuse()`、`bootstrap_caido()` 和 SDK `SandboxRunConfig` 的调用共同定义。

## 9. 后端测试策略

分三层：

### 注册表纯测试

```python
register_backend("fake", fake_backend)
assert get_backend("fake") is fake_backend
assert "fake" in supported_backends()
```

保存并恢复全局 `_BACKENDS`，避免测试污染。

### 合约 mock 测试

用 AsyncMock 验证：

- manifest/exposed ports/bind mounts 被传递。
- session.start 在正确时机调用。
- Caido bootstrap 失败时资源关闭。
- cleanup 调用 delete/aclose。

### 真实后端 smoke test

在独立可控环境中验证 `/workspace`、env、exec、port、cleanup。不要把必须访问云资源的测试放进默认快速单元测试套件。

## 10. 扩展报告字段

假设增加 `confidence` 字段，至少要检查：

```text
tools/reporting/tool.py
  -> 参数 schema、校验、candidate dedupe
report/state.py
  -> add_vulnerability_report 持久化
report/writer.py
  -> Markdown/CSV/JSON 是否显示
report/sarif.py
  -> 是否应上传、是否敏感
viewer/frontend/src/types/issues.ts
  -> 类型
viewer/frontend/src/lib/local-run-parser.ts
  -> 解析
对应 React 组件
tests/test_reporting_fields.py / test_sarif.py / Viewer tests
```

JSON 产物通常自然带上字段，但 Markdown、SARIF、TypeScript 类型不会自动更新。还要考虑旧 run 没有该字段时的向后兼容。

## 11. 新增 Viewer 工具 renderer

新工具即使没有专门 renderer，也会走 fallback。要改善显示：

1. 在 `components/live/tool-renderers/` 添加组件。
2. 在该目录 `index.ts` 的 dispatch 中按 tool name 路由。
3. 对 args/result 做 defensive parsing；历史数据可能缺字段或是旧格式。
4. 保留 collapse/unknown/error 状态。
5. `npm run build` 并提交 static bundle。

不要让 renderer 执行工具结果中的任意 HTML/脚本。Markdown 渲染也要使用现有受控组件。

## 12. 一个完整扩展的验收清单

- [ ] 扩展点选择合理，没有跨层复制逻辑。
- [ ] 参数、返回、失败和 timeout 有清楚 docstring。
- [ ] 不扩大系统验证 target scope。
- [ ] 不泄漏 key、宿主路径、PoC 到外部产物。
- [ ] fresh run 和 resume 都有定义。
- [ ] root/child/interactive/non-interactive 差异已考虑。
- [ ] 有最小单元测试和至少一个失败路径。
- [ ] Ruff、mypy、pyright、Bandit 通过。
- [ ] 若改前端，source 与 static 同步。
- [ ] 若改 SDK override，已与固定 SDK 版本源代码重新比对。

## 13. 推荐的三个渐进扩展练习

1. **低风险**：外部 skill 目录 + loader 测试。
2. **中风险**：只读 context FunctionTool + factory 注册测试 + fallback renderer 验证。
3. **高风险**：fake sandbox backend 合约测试，不先接真实云环境。

完成每一步再进入下一步，不要把技能、工具、后端和 UI 一次性混在一个首个改动里。

## 14. 自测题

1. 什么需求应优先用 Skill 而不是 Tool？
2. 为什么注册工具必须发生在 build Agent 之前？
3. 后端返回 `(client, session)` 之外还有哪些行为契约？
4. 新报告字段为什么需要同时考虑旧 run？
5. 新工具没有 renderer 时为什么 Viewer 仍应可用？

