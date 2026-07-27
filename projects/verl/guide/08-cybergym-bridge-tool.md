# 08. 实现隔离 bridge 与 workspace 工具

本章给出可落地的接口和 verl 工具骨架。它不实现具体任务装配，也不包含任何漏洞材料；bridge 服务端
需要由你在授权基础设施中实现，并用 CyberGym 的通用 workspace/validator 逻辑做后端。

## Bridge API 契约

### 执行 workspace 操作

```http
POST /v1/workspaces/execute
Content-Type: application/json

{
  "request_id": "per-rollout-random-id",
  "task_id": "demo-project/authorized-task",
  "mode": "e2e",
  "operation": "read",
  "arguments": {"path": "src/example.c"}
}
```

首次请求幂等创建 session，响应只返回安全摘要：

```json
{
  "session_id": "opaque-session-id",
  "ok": true,
  "text": "bounded textual result",
  "exit_code": null,
  "truncated": false,
  "artifact_state": {"poc_present": false, "patch_present": false}
}
```

### 最终验证

```http
POST /v1/rewards/validate

{
  "session_id": "opaque-session-id",
  "task_id": "demo-project/authorized-task",
  "mode": "e2e",
  "idempotency_key": "run-step-uid-rollout"
}
```

响应不返回 hidden artifact 或大段日志：

```json
{
  "artifact_valid": true,
  "stage1": "passed",
  "stage2": "passed",
  "stage3": "passed",
  "stage4": "failed",
  "infra_error": false,
  "durations_s": {"stage1": 12.3, "stage2": 13.0, "stage3": 25.4, "stage4": 11.8}
}
```

### 清理

```http
DELETE /v1/workspaces/{session_id}
```

删除必须幂等；不存在也返回成功。

## 服务端必须验证的条件

bridge 不能信任 rollout 发来的任何字符串：

- `task_id` 在 allowlist 且 mode 允许；
- `request_id` 只能访问自己创建的 session；
- path 解析后仍在 workspace 根内；
- operation 在枚举中；
- command 在隔离容器中执行，且受超时、输出、CPU、内存、进程数限制；
- `write` 只能写 workspace 与 `/output` 允许位置；
- validator 只能读取固定 artifact；
- workspace 默认无外网；
- 日志过滤本机路径、token 和隐藏数据。

## verl 工具骨架

将下列文件放在你的私有运行目录，例如 `/path/to/cybergym-bridge/client/cybergym_tool.py`。它不需要
进入 verl 仓库。

```python
from __future__ import annotations

from typing import Any

import aiohttp

from verl.tools.base_tool import BaseTool
from verl.tools.schemas import ToolResponse


class CyberGymWorkspaceTool(BaseTool):
    """Client for an authorized, isolated CyberGym workspace bridge."""

    async def execute(
        self,
        instance_id: str,
        parameters: dict[str, Any],
        **kwargs: Any,
    ) -> tuple[ToolResponse, float, dict]:
        agent_data = kwargs["agent_data"]
        create_kwargs = agent_data.tools_kwargs[self.name]["create_kwargs"]
        task_id = create_kwargs["task_id"]
        mode = create_kwargs["mode"]

        payload = {
            "request_id": agent_data.request_id,
            "task_id": task_id,
            "mode": mode,
            "operation": parameters["operation"],
            "arguments": {
                key: value
                for key, value in parameters.items()
                if key != "operation" and value is not None
            },
        }

        timeout = aiohttp.ClientTimeout(total=float(self.config.get("timeout_s", 120)))
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{self.config['bridge_url'].rstrip('/')}/v1/workspaces/execute",
                json=payload,
            ) as response:
                response.raise_for_status()
                result = await response.json()

        expected_session = agent_data.extra_fields.get("cybergym_session_id")
        if expected_session is not None and expected_session != result["session_id"]:
            raise RuntimeError("bridge returned a different session for the same rollout")

        calls = int(agent_data.extra_fields.get("workspace_calls", 0)) + 1
        agent_data.extra_fields.update(
            {
                "cybergym_session_id": result["session_id"],
                "cybergym_task_id": task_id,
                "cybergym_mode": mode,
                "workspace_calls": calls,
            }
        )

        summary = {
            "ok": bool(result.get("ok", False)),
            "text": result.get("text", ""),
            "exit_code": result.get("exit_code"),
            "truncated": bool(result.get("truncated", False)),
            "artifact_state": result.get("artifact_state", {}),
        }
        return ToolResponse(text=str(summary)), 0.0, {"workspace_calls": calls}

    async def release(self, instance_id: str, **kwargs: Any) -> None:
        # ToolAgentLoop calls release around each tool call. The remote session must
        # survive until final reward; reward cleanup and bridge TTL own destruction.
        return None
```

生产实现应使用 `json.dumps(summary, ensure_ascii=False)`，并对 `text` 再做本地长度上限。此处用
`str` 是为了突出接口，不应把响应中的任意字段直接透传给模型。

## 工具配置

```yaml
tools:
  - class_name: cybergym_tool.CyberGymWorkspaceTool
    config:
      type: native
      bridge_url: http://bridge.internal:8080
      timeout_s: 120
    tool_schema:
      type: function
      function:
        name: cybergym_workspace
        description: 在分配的授权隔离工作区内进行受限源码操作
        parameters:
          type: object
          properties:
            operation:
              type: string
              enum: [list, read, search, write, run, status]
            path: {type: string}
            query: {type: string}
            content: {type: string}
            command: {type: string}
          required: [operation]
```

bridge URL 不是秘密，但若环境需要认证，应由 Ray runtime env 注入短期凭据，工具从环境变量读取；
不要写进 YAML、Parquet 或日志。

## Bridge 复用 CyberGym 的位置

服务端可参考固定快照中的：

- `scripts/utils.py::start_container`：启动隔离容器；
- `scripts/utils.py::setup_workspace`：装配源码与 build scripts；
- `scripts/utils.py::exec_run`：容器内执行与超时；
- `scripts/utils.py::cleanup_container`：销毁资源；
- `scripts/run_agent.py::run_final_validation`：fresh-container stages；
- `scripts/validate.py::validate_task`：阶段状态结构。

“参考”不等于原样暴露。上游函数面向本地 benchmark runner，bridge 还需鉴权、allowlist、路径校验、
限流、幂等、脱敏和 TTL。

## Mock bridge 先行

真实容器前，实现内存 mock：

- 相同 `request_id + task_id` 返回相同 session；
- `read/search/run` 返回固定短文本；
- `write` 只更新 artifact bool；
- validate 根据预设 fixture 返回 stage；
- delete 记录清理。

单测应覆盖 session 串线、路径穿越、超时、重复 validate、重复 delete 和 worker 取消。

## 本章练习

用两个并发 request ID 调 mock bridge，各执行三次工具调用。断言同一 request 保持 session，不同
request 不共享 session；然后让 reward 分别 validate 并 delete，最终 mock 中活动 session 数为 0。

[上一章](./07-cybergym-e2e-model.md) · [下一章：数据与工具配置](./09-dataset-and-tool-config.md)
