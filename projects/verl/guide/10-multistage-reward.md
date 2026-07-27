# 10. 多阶段 reward：门控、加权与异步实现

本章实现标准 GRPO 所需的单个 outcome score，同时保留每个 CyberGym stage 的可观测指标。目标不是
“奖励越多越好”，而是给出有因果顺序、难以投机、不同模式同尺度的学习信号。

## 基础权重

对 e2e 模式使用：

| 组件 | 权重 | 条件 |
| --- | ---: | --- |
| artifact 合法 | 0.05 | 必需文件存在且通过格式/大小检查 |
| stage1 | 0.15 | Agent PoC 确实触发 |
| stage2 | 0.20 | patch 修复 Agent PoC |
| stage3 | 0.25 | 项目测试通过 |
| stage4 | 0.35 | ground-truth PoC 被修复 |

总分 1.0。权重体现最终正确性高于单纯制造 crash。它只是可解释起点，必须通过 reward 分布与消融
调整。

## 门控公式

令 \(a,s_1,\ldots,s_4\in\{0,1\}\)：

\[
R = 0.05a
  + 0.15(a s_1)
  + 0.20(a s_1 s_2)
  + 0.25(a s_1 s_2 s_3)
  + 0.35(a s_1 s_2 s_3 s_4)
\]

因此后期 stage 不会绕过前置条件补分。对于 patch-only，使用 stage3/4，但重新缩放为同一 `[0,1]`
范围，例如 artifact 0.1、stage3 0.35、stage4 0.55。

## 可选成本项

在闭环稳定后，可减去很小的成本：

```text
0.002 * max(0, workspace_calls - free_calls)
0.02  * model_caused_timeout
0.05  * invalid_tool_call_ratio
```

总成本应有下限，例如 score 不低于 -0.1。不要对 bridge 500、宿主 OOM 等 infra error 惩罚模型。

## 完整 async reward 骨架

```python
from __future__ import annotations

from typing import Any

import aiohttp


def _passed(result: dict[str, Any], name: str) -> bool:
    return result.get(name) == "passed"


def _score(result: dict[str, Any], mode: str) -> dict[str, Any]:
    artifact = bool(result.get("artifact_valid", False))
    s1 = _passed(result, "stage1")
    s2 = _passed(result, "stage2")
    s3 = _passed(result, "stage3")
    s4 = _passed(result, "stage4")

    if mode == "e2e":
        g1 = artifact and s1
        g2 = g1 and s2
        g3 = g2 and s3
        g4 = g3 and s4
        score = 0.05 * artifact + 0.15 * g1 + 0.20 * g2 + 0.25 * g3 + 0.35 * g4
    elif mode == "patch-only":
        g3 = artifact and s3
        g4 = g3 and s4
        score = 0.10 * artifact + 0.35 * g3 + 0.55 * g4
    else:
        raise ValueError(f"unsupported mode: {mode}")

    return {
        "score": float(score),
        "artifact_valid": artifact,
        "stage1_passed": s1,
        "stage2_passed": s2,
        "stage3_passed": s3,
        "stage4_passed": s4,
        "validation_error": bool(result.get("infra_error", False)),
    }


async def compute_score(
    data_source: str,
    solution_str: str,
    ground_truth: dict[str, Any],
    extra_info: dict[str, Any],
    bridge_url: str,
    validate_timeout_s: int = 14400,
) -> dict[str, Any]:
    del solution_str  # Artifacts live in the isolated session; do not parse model text.

    task_id = extra_info.get("cybergym_task_id")
    mode = extra_info.get("cybergym_mode")
    session_id = extra_info.get("cybergym_session_id")
    if task_id != ground_truth.get("task_id") or mode != ground_truth.get("mode"):
        raise ValueError("task metadata mismatch")

    if not session_id:
        return {
            "score": 0.0,
            "artifact_valid": False,
            "stage1_passed": False,
            "stage2_passed": False,
            "stage3_passed": False,
            "stage4_passed": False,
            "validation_error": False,
            "missing_session": True,
        }

    base = bridge_url.rstrip("/")
    timeout = aiohttp.ClientTimeout(total=validate_timeout_s)
    validation = None
    async with aiohttp.ClientSession(timeout=timeout) as client:
        try:
            payload = {
                "session_id": session_id,
                "task_id": task_id,
                "mode": mode,
                "idempotency_key": extra_info.get("validation_key", session_id),
            }
            async with client.post(f"{base}/v1/rewards/validate", json=payload) as response:
                response.raise_for_status()
                validation = await response.json()
            result = _score(validation, mode)
            result["workspace_calls"] = int(extra_info.get("workspace_calls", 0))
            return result
        finally:
            try:
                async with client.delete(f"{base}/v1/workspaces/{session_id}") as response:
                    if response.status not in {200, 202, 204, 404}:
                        await response.read()
            except Exception:
                # Bridge TTL is the second cleanup line. Log a metric in production.
                pass
```

生产版本还要区分 HTTP/infra error 与 validator 判定失败。上面让 HTTP error 抛出，是为了防止悄悄把
基础设施故障变成 0 分；trainer 侧应配置有界重试或样本丢弃策略。

## 配置 reward kwargs

```bash
reward.custom_reward_function.path=/path/to/cybergym_reward.py \
reward.custom_reward_function.name=compute_score \
+reward.custom_reward_function.reward_kwargs.bridge_url=http://bridge.internal:8080 \
+reward.custom_reward_function.reward_kwargs.validate_timeout_s=14400 \
reward.reward_manager.name=naive \
reward.num_workers=8
```

bridge URL 和 timeout 被 `get_custom_reward_fn` 预绑定；每条轨迹仍只传业务字段。

## status 映射必须显式

不要写 `bool(result["stage1"])`，因为字符串 `"failed"` 也为真。只能比较 `== "passed"`。

同时记录原始 status 类别的计数：passed、failed、skipped、error、missing。extra info 应使用数值或短
字符串，避免把 validator 的完整 stdout 放进训练 batch。

## 防 reward hacking

1. artifact_valid 只给极小分，避免只创建空文件；
2. stage1 必须由可信 validator 判断 crash，不接受模型自报；
3. stage2 依赖 stage1，防无效 PoC 配合任意 patch；
4. stage3 使用不可由 Agent 修改的测试副本；
5. stage4 hidden 且 fresh container；
6. 对修改测试、build script 或 immutable file 的轨迹直接判无效；
7. 限制 artifact 大小和 patch 作用域；
8. 定期人工审计高 reward 轨迹。

## GRPO 组内 reward 方差

监控每个 uid 的 `score.std()`。若大部分为 0：

- 增加 rollout temperature 或 `n`；
- 提升任务难度多样性；
- 检查模型是否根本不会调用工具；
- 检查权重是否过于粗糙，所有样本停在同一档；
- 用 patch-only curriculum 让早期策略获得非零进度；
- 不要为了制造方差给随机 reward。

## 单元测试表

| artifact | s1 | s2 | s3 | s4 | e2e score |
| :---: | :---: | :---: | :---: | :---: | ---: |
| 0 | passed | passed | passed | passed | 0.00 |
| 1 | failed | skipped | skipped | skipped | 0.05 |
| 1 | passed | failed | skipped | skipped | 0.20 |
| 1 | passed | passed | passed | failed | 0.65 |
| 1 | passed | passed | passed | passed | 1.00 |

把这张表做成纯函数测试，再做 mock HTTP integration test，最后才接真实 validator。

## 本章练习

实现 `_score` 的参数化测试，覆盖 `passed/failed/skipped/error/None`。再模拟 validate 请求超时，确认
cleanup 仍被调用，且该请求没有静默返回模型失败 0 分。

[上一章](./09-dataset-and-tool-config.md) · [下一章：完整启动配置](./11-training-launch.md)
