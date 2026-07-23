# 03. 配置系统与模型适配

Strix 既要支持 OpenAI 原生接口，也要支持 Anthropic、Gemini、Bedrock、本地模型等多种提供商。本章解释配置如何解析，以及模型差异如何被压缩到少数适配点。

## 1. 配置对象的分组

[`strix/config/settings.py`](../../strix/config/settings.py) 使用 Pydantic Settings 定义五组配置：

```text
Settings
├─ llm: LlmSettings
├─ runtime: RuntimeSettings
├─ telemetry: TelemetrySettings
├─ integrations: IntegrationSettings
└─ viewer: ViewerSettings
```

常用字段：

| 字段 | 环境变量 | 默认值/含义 |
| --- | --- | --- |
| `llm.model` | `STRIX_LLM` | 无默认值，扫描必需 |
| `llm.api_key` | `LLM_API_KEY` 或 `OPENAI_API_KEY` | 某些 provider 可不需要 |
| `llm.api_base` | 多个 Base URL 别名 | 自定义 OpenAI 兼容端点 |
| `llm.reasoning_effort` | `STRIX_REASONING_EFFORT` | `high` |
| `llm.force_required_tool_choice` | `STRIX_FORCE_REQUIRED_TOOL_CHOICE` | `false` |
| `llm.timeout` | `LLM_TIMEOUT` | 300 秒 |
| `runtime.image` | `STRIX_IMAGE` | 官方 sandbox 镜像 |
| `runtime.backend` | `STRIX_RUNTIME_BACKEND` | `docker` |
| `runtime.max_local_copy_mb` | `STRIX_MAX_LOCAL_COPY_MB` | 1024 MB |
| `runtime.max_context_images` | `STRIX_MAX_CONTEXT_IMAGES` | 每 Agent 3 张 |
| `telemetry.enabled` | `STRIX_TELEMETRY` | `true` |
| `viewer.app_url` | `STRIX_APP_URL` | Strix relay 地址 |

`SettingsConfigDict(case_sensitive=False, populate_by_name=True, extra="ignore")` 表示环境变量大小写不敏感，可通过字段名/alias 填充，未知字段忽略。

## 2. 配置优先级

[`load_settings()`](../../strix/config/loader.py) 的明确规则是：

```text
环境变量 > JSON 配置文件 > 字段默认值
```

默认 JSON 文件是：

```text
~/.strix/cli-config.json
```

格式不是嵌套 Pydantic 结构，而是环境变量块：

```json
{
  "env": {
    "STRIX_LLM": "openai/gpt-5.4",
    "LLM_TIMEOUT": "300"
  }
}
```

`_read_json_overrides()` 会：

1. 读取并大写所有 JSON key。
2. 收集每个 Pydantic 字段的 alias/validation aliases。
3. 如果任意 alias 已出现在真实环境中，跳过 JSON 中该字段。
4. 把剩余数据重组为 `{"llm": {...}, "runtime": {...}}` 后交给 `Settings`。

为什么要在进入 Pydantic 前跳过？Pydantic 构造参数通常比环境源优先；如果直接把 JSON 值作为构造参数传入，反而会错误地覆盖环境变量。

## 3. AliasChoices 解决兼容性

API Key 支持：

```python
api_key: str | None = Field(
    default=None,
    validation_alias=AliasChoices("LLM_API_KEY", "OPENAI_API_KEY"),
)
```

Base URL 还支持 `OPENAI_API_BASE`、`OPENAI_BASE_URL`、`LITELLM_BASE_URL`、`OLLAMA_API_BASE`。这样旧环境和不同生态的习惯都可以工作，而项目内部始终访问统一的 `settings.llm.api_base`。

对应测试在 [`tests/test_config_loader.py`](../../tests/test_config_loader.py)，尤其值得看“环境通过另一个 alias 覆盖 JSON”的用例。

## 4. 缓存与覆盖文件

`load_settings()` 用模块变量 `_cached` memoize 结果。同一进程中重复调用返回同一个 `Settings` 对象，避免每次工具调用都读磁盘和环境。

```python
def apply_config_override(path: Path) -> None:
    global _override, _cached
    _override = path
    _cached = None
```

`--config` 会调用这个函数。清空缓存非常关键，否则 parser 之后再访问配置仍会得到默认文件解析出的旧对象。

测试里会用 `monkeypatch` 重置 `_cached` 和 `_override`，否则测试之间会互相污染。

## 5. `persist_current()` 的行为和安全边界

预检成功后，主入口调用 `persist_current()`：它只保存当前进程中显式存在的相关环境变量，不会把所有默认值写出。文件权限尝试设为 `0600`。

这让后续运行不用重复 export，但意味着 API Key 可能落盘到用户私有配置。应当：

- 确保 `~/.strix` 不被同步到公共位置。
- 不把自定义 `--config` 文件提交到仓库。
- 在共享机器上确认文件权限。

## 6. `StrixProvider` 如何路由模型

[`strix/config/models.py`](../../strix/config/models.py) 的 `StrixProvider` 继承 SDK `MultiProvider`：

- `openai/...`、`litellm/...`、`any-llm/...` 交回父类。
- `ollama/foo` 改写为 LiteLLM 的 `ollama_chat/foo`。
- 其他带 provider 前缀的名字保持原样，通过 LiteLLM fallback provider 路由。

因此用户可以写：

```text
anthropic/claude-...
gemini/gemini-...
openrouter/...
ollama/qwen...
```

而不需要手工再加 `litellm/` 前缀。

裸模型名需要谨慎：已知 OpenAI 模型可以直接使用，未知裸名字会在 `warm_up_llm()` 前被拒绝并提示使用 `<provider>/<model>`。

## 7. SDK 全局默认配置

`configure_sdk_model_defaults(settings)` 做了几件事：

1. 关闭 SDK tracing，避免敏感扫描数据进入外部 trace。
2. 配置 LiteLLM 丢弃不支持参数、关闭消息日志、注册成本 callback。
3. 设置 OpenAI 与 LiteLLM 的 API Key/Base URL。
4. 尝试把通用 `LLM_API_KEY` 映射到当前 provider 所需的 `*_API_KEY` 环境变量。
5. 有自定义 API Base 时用 Chat Completions API，否则默认 Responses API。

OpenRouter 还会得到项目归因 headers；当模型切换离开 OpenRouter 时，这些 headers 会被移除，避免污染其他 provider 请求。

## 8. 重试策略

`DEFAULT_MODEL_RETRY` 最多重试 5 次，退避参数：

```text
初始 2 秒，最大 90 秒，乘数 2，无 jitter
```

重试条件是以下任一：

- provider 建议重试；
- 网络错误；
- HTTP 429/500/502/503/504；
- 没有状态码且不是明确 abort 的 provider 错误。

明确用户取消或不可重试错误不应被盲目重试。顶层 Runner 还单独捕获持续的 `RateLimitError`，把扫描留在可恢复状态。

## 9. `ModelSettings` 的构建

[`make_model_settings()`](../../strix/core/inputs.py) 设置：

```python
ModelSettings(
    parallel_tool_calls=False,
    retry=DEFAULT_MODEL_RETRY,
    include_usage=True,
    extra_args={"timeout": request_timeout},
)
```

关键设计：

- `parallel_tool_calls=False`：单个 Agent 的工具调用串行，降低多个有副作用工具同时执行的复杂度。多 Agent 仍然可以并发。
- `include_usage=True`：每次响应保留 token usage，供报告与预算使用。
- reasoning effort 只在 LiteLLM 元数据确认模型支持 reasoning 时设置。
- `tool_choice="required"` 只对接受该语义的 OpenAI 路由启用。

这里体现了“能力探测后再配置”，而不是向所有 provider 强塞同一参数。

## 10. 工具 schema 的兼容分支

`uses_chat_completions_tool_schema()` 判断 provider 是否只能接收 JSON function tools：

- 非 OpenAI provider 通常返回 `True`。
- 配置了自定义 API Base 返回 `True`。
- 不支持 reasoning 的模型也走兼容 function schema。

Agent factory 据此把 SDK `CustomTool` 包装为 `FunctionTool`，并把工具异常转换为模型可见字符串。这让模型能修正参数后继续，而不是整个扫描直接崩溃。

## 11. 模型预热

`warm_up_llm()` 创建 `StrixProvider().get_model(raw_model)`，发送只要求回复 `OK` 的请求，并禁用 tracing。它会给 Bedrock 缺少 `boto3`、Vertex 缺少 `google-auth` 等情况输出更具体的安装提示。

非交互模式会显示非推荐模型警告，交互模式可减少启动噪声。推荐列表是产品策略，不等同于路由支持列表：一个模型可能能路由，但不一定适合高质量安全扫描。

## 12. 本章实验

### 验证优先级

```bash
uv run pytest tests/test_config_loader.py -q
```

然后读这三个测试：

- `test_read_json_overrides_maps_to_nested_settings`
- `test_read_json_overrides_env_wins_across_field_aliases`
- `test_apply_config_override_invalidates_cache`

### 观察模型设置

该实验会导入 LiteLLM 元数据，但不发请求：

```bash
uv run python - <<'PY'
from strix.core.inputs import make_model_settings

settings = make_model_settings(
    "high",
    model_name="openai/gpt-5.4",
    request_timeout=123,
)
print(settings)
PY
```

## 13. 自测题

1. 为什么 JSON 配置要先去掉环境中已存在字段？
2. `apply_config_override()` 为什么必须清空缓存？
3. 模型路由、模型参数和工具 schema 兼容分别由哪些函数负责？
4. 为什么单 Agent 禁用 parallel tool calls，但项目仍然叫多 Agent 系统？
5. 模型“支持路由”和“被推荐”为什么是两个概念？

