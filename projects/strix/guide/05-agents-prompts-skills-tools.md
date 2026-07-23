# 05. Agent、提示词、技能与工具

本章回答：一个 Strix Agent 到底由哪些部分构成，以及项目如何让不同模型都能调用同一套能力。

## 1. `SandboxAgent` 是装配结果

核心工厂是 [`build_strix_agent()`](../../strix/agents/factory.py)。它最终返回：

```python
SandboxAgent(
    name=name,
    instructions=instructions,
    tools=tools,
    tool_use_behavior=_finish_tool_use_behavior,
    model=None,
    capabilities=[Filesystem(...), Shell(...)],
)
```

逐项理解：

- `name`：图中显示名，不是唯一 ID。
- `instructions`：系统提示词。
- `tools`：显式业务工具；文件系统和 shell 由 capabilities 动态提供。
- `tool_use_behavior`：决定工具结果何时终止当前 Agent 运行周期。
- `model=None`：模型不固定在 Agent 上，由 `RunConfig` 统一注入。
- `Filesystem` / `Shell`：SDK 沙箱能力，命令在容器而非宿主执行。

把模型放在 `RunConfig` 而不是每个 Agent 上，能确保同一扫描的根/子 Agent 共享路由、重试、预算和沙箱配置。

## 2. 提示词如何生成

[`render_system_prompt()`](../../strix/agents/prompt.py) 使用 Jinja：

```text
agents/prompts/system_prompt.jinja
  + 自动技能
  + 用户/子 Agent 请求的技能
  + system_prompt_context
  -> 最终系统提示词字符串
```

Jinja 设置关闭字符串 autoescape，因为输出不是 HTML。模板 loader 同时搜索内置 prompt 目录和注册的 skill 目录。

如果渲染异常，当前实现记录 exception 并返回空字符串。这保证工厂不会因单个技能文件直接崩溃，但空系统提示词对安全扫描质量影响很大；调试时应优先看 `render_system_prompt failed` 日志。

## 3. 技能的自动组合规则

`_resolve_skills()` 按顺序添加：

1. 调用者请求的技能。
2. `scan_modes/<quick|standard|deep>`。
3. `tooling/agent_browser`。
4. `tooling/python`。
5. 根 Agent 增加 `coordination/root_agent`。
6. white-box 增加 `coordination/source_aware_whitebox` 和 `custom/source_aware_sast`。

然后保持首次出现顺序去重。

因此 `skills=[]` 不代表没有技能。扫描模式、浏览器、Python，以及按角色/目标类型选择的技能仍会自动加载。

## 4. 技能文件如何发现

[`strix/skills/__init__.py`](../../strix/skills/__init__.py) 支持：

```text
<skill-root>/<category>/<name>.md
<skill-root>/<name>.md
```

内部类别 `scan_modes`、`coordination` 不出现在可供 Agent 自选的列表里。技能名可以是：

- 裸名：`sql_injection`；仅在不歧义时可用。
- 限定名：`vulnerabilities/sql_injection`。

`register_skill_dir()` 可注册外部技能根。后注册目录优先级更高，可以增加技能或覆盖同一路径的内置技能，而不修改包文件。

加载时会剥离 YAML frontmatter，只把 Markdown 正文注入 prompt。当前 frontmatter 主要供人类和生态元数据使用。

## 5. 预加载技能与临时技能

两种方式不要混淆：

### 创建 Agent 时指定

```python
create_agent(
    name="Auth Specialist",
    task="检查认证和 JWT 生命周期",
    skills=["authentication_jwt"],
)
```

内容长期存在于该 Agent 的系统提示词中，适合核心专业方向。

### 运行中调用 `load_skill`

[`load_skill`](../../strix/tools/load_skill/tool.py) 把内容作为一次工具结果放进对话，不永久修改系统提示词，适合临时查阅准确命令或流程。

两者都限制最多 5 个技能，推荐子 Agent 使用 1～3 个相关技能，减少无关上下文。

## 6. 基础工具集合

`_BASE_TOOLS` 大致分组如下：

| 类型 | 工具 |
| --- | --- |
| 思考/计划 | `think`、todo 工具、notes 工具 |
| 知识 | `load_skill`、`web_search` |
| 报告 | `create_vulnerability_report`、`create_dependency_report` |
| HTTP 代理 | `list_requests`、`view_request`、`repeat_request`、sitemap/scope 工具 |
| 多 Agent | 图、消息、等待、创建、停止 |

生命周期工具按角色追加：

```text
根 Agent  -> finish_scan
子 Agent  -> agent_finish
```

这样子 Agent 根本拿不到 `finish_scan`，根 Agent也拿不到 `agent_finish`，减少模型误用后的运行时纠错。

## 7. 为什么生命周期工具特殊

普通工具执行成功后，SDK 应继续让模型工作。只有以下结构化结果能结束本轮：

```text
agent_finish -> {success: true, agent_completed: true}
finish_scan  -> {success: true, scan_completed: true}
```

交互模式下：

```text
wait_for_message -> {success: true, wait_outcome: "waiting"}
```

也可以结束当前 cycle，让 Agent 停在等待态。

[`_finish_tool_use_behavior()`](../../strix/agents/factory.py) 解析工具返回 JSON，而不是只按工具名结束。若工具因校验失败返回 `success: false`，Agent 必须修正后继续，不能误判完成。

## 8. 工具错误为什么返回给模型

许多工具有复杂参数。完全让异常冒出会中止 SDK 流，模型无法自我修正。Factory 包装工具：

- Pydantic `ValidationError` 被压缩为 `tool: invalid arguments — field: reason`。
- `InvalidManifestPathError` 变成明确的 `/workspace` workdir 提示。
- 兼容 Chat Completions 时，其他工具异常也转成字符串结果。

这是“可恢复工具错误”和“系统异常”的边界。不是所有异常都应该吞掉；执行循环仍会对模型/API/transport 异常按模式处理。

## 9. Shell 工具适配

`_wrap_exec_command()` 做两件小但重要的兼容：

1. 参数未指定 shell 时默认 `bash`。
2. 把沙箱外 workdir 错误转换成模型可理解的说明。

`_wrap_write_stdin()` 则解析 `\n`、`\t`、`\uXXXX` 等转义，让 JSON 中的控制字符成为真正写入终端的字符。

注意它只解析受控转义模式，没有使用任意 `unicode_escape` 解码，从而避免把所有反斜杠序列意外改写。

## 10. CustomTool 到 FunctionTool 的转换

Responses API 能表达 SDK custom tool，而许多 Chat Completions provider 只接受 JSON function schema。`_custom_tool_as_function_tool()` 将原始 payload 包在一个字符串字段中：

```json
{
  "input": "完整工具输入"
}
```

`apply_patch` 特例字段名是 `patch`。转换还保留 approval callback 语义，并把异常变成可见结果。

这属于协议适配层：业务工具实现不需要为每个模型维护一份。

## 11. 已验证范围不能被 override 覆盖

`run_strix_scan()` 先用 `build_scope_context()` 创建系统验证的授权范围，再允许嵌入方传 `extra_system_prompt_context`。如果额外 context 试图覆盖内置 key，`_merge_root_prompt_context()` 直接报错。

`root_instructions_override` 也不是直接替换整个 system prompt。`_compose_root_instructions_override()` 先渲染基础系统提示词，再把 override 放进明确的 subordinate 标签，并声明不能扩展或弱化授权目标。

这是非常值得学习的安全设计：可扩展提示词不能拥有覆盖平台信任根的权限。

## 12. 动态注册额外工具

`register_agent_tools(*tools)` 把工具放入 `_EXTRA_TOOLS`。之后构建的所有根/子 Agent 都能获得它们。规则：

- 同一个工具对象重复注册会去重。
- 工具名必须在 base、已注册、新注册、lifecycle 工具之间全局唯一。
- 注册必须发生在第一次 `build_strix_agent()` 之前，已经构建的 Agent 不会被回填。

[`tests/test_agent_tool_registration.py`](../../tests/test_agent_tool_registration.py) 完整演示了顺序和重复名行为。

## 13. 本章实验

### 查看实际 Agent 工具名

```bash
uv run python - <<'PY'
from strix.agents.factory import build_strix_agent

root = build_strix_agent(is_root=True, scan_mode="quick")
child = build_strix_agent(is_root=False, scan_mode="quick")
print("root tail:", [tool.name for tool in root.tools[-5:]])
print("child tail:", [tool.name for tool in child.tools[-5:]])
PY
```

### 查看自动技能选择

```bash
uv run python - <<'PY'
from strix.agents.prompt import _resolve_skills

print(_resolve_skills(
    requested=["xss"],
    scan_mode="standard",
    is_whitebox=True,
    is_root=True,
))
PY
```

### 定向测试

```bash
uv run pytest tests/test_agent_tool_registration.py tests/test_skill_dir_extension.py -q
```

## 14. 自测题

1. 为什么 `skills=[]` 仍会加载多个技能？
2. 为什么根 Agent 和子 Agent 使用不同 lifecycle tool？
3. 工具调用“发生过”为什么不等于 Agent 应终止？
4. CustomTool 转 FunctionTool 解决的是哪一层兼容问题？
5. 为什么 prompt override 不能替换系统验证的 scope context？

