# 06. Reward Loop：异步验证、extra info 与 outcome score

CyberGym 验证可能持续数分钟，必须把 reward 看成独立的分布式服务阶段，而不是在 trainer driver 中
串行执行 Docker 命令。verl 的 Reward Loop 正好提供这个扩展点。

## 默认调用链

```text
AgentLoopOutput
  -> AgentLoopWorker._compute_score
  -> RewardLoopWorker.compute_score
  -> NaiveRewardManager.run_single
  -> custom async compute_score(...)
  -> {score, stage metrics...}
  -> rm_scores + non_tensor reward fields
```

当 Agent Loop 自己没有设置 `reward_score` 且 manager 拿到 reward worker handles 时，轨迹完成后可立即
流式评分。

## custom reward 函数签名

默认 manager 调用：

```python
async def compute_score(
    data_source: str,
    solution_str: str,
    ground_truth,
    extra_info: dict,
    bridge_url: str,
) -> dict:
    ...
```

- `solution_str` 是完整 response token 解码后的文本，可能包含工具 observation；
- `ground_truth` 来自 `reward_model.ground_truth`；
- `extra_info` 已合并 `tool_extra_fields`，可取得 session ID；
- `bridge_url` 来自配置的 `reward_kwargs`。

CyberGym 评分不应从 `solution_str` 解析 patch。artifact 应已在隔离 workspace 中，文本只用于日志摘要。

## 为什么必须是 async

同步函数会被放进 executor，能工作但不利于大量长 I/O。异步函数可以在等待 bridge HTTP 时释放
event loop：

```python
async with aiohttp.ClientSession(timeout=timeout) as session:
    async with session.post(url, json=payload) as response:
        result = await response.json()
```

bridge 仍需要独立限流。`reward.num_workers=8` 表示多个 Ray reward worker，不代表后端能安全同时启动
无限容器。

## 返回 dict 的语义

默认 `NaiveRewardManager` 要求 dict 至少有 `score`：

```python
return {
    "score": 0.55,
    "artifact_valid": True,
    "stage1_passed": True,
    "stage2_passed": True,
    "stage3_passed": True,
    "stage4_passed": False,
    "validation_error": False,
}
```

`score` 进入 `reward_score`；其余键进入 reward extra info，可用于 validation metrics、rollout dump 和
排错。标准 GRPO 只消费 score。如果使用 GDPO，才会按配置将多个组件分别组内归一化；本教程保持
`algorithm.adv_estimator=grpo`。

## 最后 token 与 reward tensor

reward worker 返回标量后，Agent Loop postprocess 创建：

```python
rm_scores = torch.zeros_like(response_mask, dtype=torch.float32)
rm_scores[last_valid_response_position] = score
```

trainer 把它复制为 `token_level_scores`；若关闭 in-reward KL，则也直接成为
`token_level_rewards`。GRPO 再沿 token 求和，恢复 trajectory score。

## 业务失败与基础设施失败

必须分开：

| 类型 | 例子 | 建议处理 |
| --- | --- | --- |
| 模型失败 | artifact 缺失、测试失败 | 返回低 score，正常训练 |
| 环境可判定失败 | 命令超时且确由轨迹触发 | 小惩罚并记录 timeout |
| 基础设施失败 | bridge 断连、镜像损坏、宿主磁盘满 | 标记 infra error，重试或丢弃，不当作模型能力 |
| 数据错误 | task 不在 allowlist、mode 不一致 | fail closed，停止该样本并告警 |

如果把所有 HTTP 500 都记作 0，模型会为平台故障背锅；如果把所有超时都重试无限次，训练又无法结束。

## cleanup 必须在 finally

reward 是最后知道 session 已完成的组件。无论验证成功、失败还是解析异常，都要尝试清理：

```python
try:
    result = await validate(session_id)
    return score(result)
finally:
    await delete_workspace(session_id)
```

bridge 还应有 TTL janitor，处理 worker 被 kill、Ray 重启或 reward 函数根本没执行的孤儿 session。

## 并发与去重

同一 reward 请求可能因网络重试重复到达。bridge 的 validate API 应接受幂等键：

```text
validation_key = run_id / global_step / uid / rollout_index
```

重复请求返回同一结构化结果或等待正在执行的 job，而不是再启动四个容器。不要只以 task ID 去重，
因为同题不同 rollout 的 artifact 不同。

## reward 日志的最小集合

每个 step 至少记录：

- `score` 均值、标准差、直方图；
- artifact valid 比例；
- stage1–4 pass 比例；
- skipped/error/timeout 比例；
- 验证 wall time 的 p50/p95；
- uniform reward group 比例；
- 每个 mode 的样本数；
- session cleanup 成功率。

只看 `critic/score` 或总 reward 均值无法判断卡在 PoC、补丁、回归测试还是基础设施。

## RewardManager 何时需要自定义

`NaiveRewardManager` 已支持 async custom function 和 extra info，足够完成本文方案。只有以下情况才值得
继承 `RewardManagerBase`：

- 一条 trajectory 包含多个 output，需要联合评分；
- 要在 manager 层做跨样本批量验证；
- 需要自定义重试、路由或 cache；
- 要把 infra error 样本从训练 batch 中移除，而不是简单给分。

先用默认 manager 跑通，避免同时引入两个扩展层。

## 本章练习

写一个 mock async reward：根据 `extra_info["mock_stage"]` 返回 0.05、0.2、0.55 或 1.0，并附带四个
stage bool。用 `rollout.n=4` 构造同组不同 stage，检查 `rm_scores.sum(-1)` 与预期 score 相等，且
reward extra info 出现在 validation dump 中。

[上一章](./05-agent-loop-tools.md) · [下一章：CyberGym-E2E 评测模型](./07-cybergym-e2e-model.md)
