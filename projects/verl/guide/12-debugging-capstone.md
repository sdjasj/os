# 12. 性能、排错、评测与结课项目

最后一章把问题按数据流分层定位，并给出一个能证明“确实读懂 verl”的结课任务。不要从总 reward
下降直接猜学习率；先找到信号在哪一层失真。

## 分层排错表

| 现象 | 首查位置 | 典型原因 |
| --- | --- | --- |
| 启动即 Hydra error | resolved config | 字段不存在、`+` 缺失、shell 引号错误 |
| Ray worker import error | runtime env/PYTHONPATH | adapter 只在 driver 可见 |
| SGLang OOM | rollout config | KV cache 比例、长 response、并发序列过大 |
| 从不调用工具 | parser/schema/prompt | format 与模型不匹配、schema 过长 |
| 多轮后 token mismatch | chat template | reasoning 被模板删除、turn separator 不一致 |
| reward 全 0 | extra fields/bridge | session ID 未传递、artifact 缺失、HTTP 失败被吞 |
| stage1 有分、后续全跳过 | validator/artifact | patch 未应用、fresh container 契约不一致 |
| 同组 reward 有差异但 advantage 全 0 | uid/mask | uid 被覆盖、response mask 为空 |
| GPU 经常空闲 | reward queue | 容器验证成为关键路径 |
| session 越积越多 | cleanup/TTL | reward 被取消、finally 未执行、delete 非幂等 |

## 先验证数据和形状

每个 step 采样少量统计，不打印完整轨迹：

```python
assert torch.isfinite(batch.batch["rm_scores"]).all()
assert torch.isfinite(batch.batch["old_log_probs"]).all()
assert torch.isfinite(batch.batch["advantages"]).all()
assert (batch.batch["response_mask"].sum(-1) > 0).all()
```

按 uid 汇总：

```text
group size
reward min/max/std
assistant token count
observation token count
workspace calls
```

若 group size 不是 `rollout.n`，先修数据分组；若 mask 全 0，先修工具轨迹；算法调参都应后置。

## reward 全相同

区分两类：

### 所有组都卡在相同 stage

说明任务对当前策略太难、tool call 失败或 bridge 契约错误。先看 artifact valid 与 stage pass 率，使用
mock/patch-only curriculum。

### 每组内部相同，但不同组有差异

标准 GRPO 按组减均值，所以仍几乎没有更新。增加同题采样多样性、检查 SGLang sampling 参数和模型
是否 deterministic。不能把不同任务的绝对难度差当成同题相对优势。

## tokenization mismatch

调试顺序：

1. 保存 token ID 差异位置，不先 decode 整段敏感内容；
2. 确认 `multi_turn.format`；
3. 检查模型 chat template 对历史 reasoning 的处理；
4. 检查 parser 是否重写 tool call；
5. 检查 observation 前后的 turn separator；
6. 仅空白差异才考虑 `ignore_strippable`。

关闭 sanity check 会消除告警，不会消除 off-policy token 错位。

## 容器验证吞吐

记录一条轨迹的时间线：

```text
queue_wait
workspace_setup
agent_tool_time
artifact_export
stage1..stage4
cleanup
```

优化优先级通常是：

- 预拉取并按 digest 固定镜像；
- 复用只读依赖 cache，但不复用可变源码状态；
- 前置门控失败后不启动后续 stage；
- stage 使用 fresh container 但共享安全的镜像层；
- bridge 按镜像/项目限制并发，避免磁盘抖动；
- reward 请求幂等，网络重试不重复计算。

不要为了速度复用已经被 Agent 修改的 workspace 做 final judge。

## SGLang 与 actor 的性能分离

关注四段 wall time：

| 段 | 指标 | 常用调节 |
| --- | --- | --- |
| rollout | tokens/s、KV cache、preemption | TP、max tokens、max seqs、prefix cache |
| tool wait | calls/s、p95 latency | Agent workers、bridge API、输出长度 |
| reward | validation/s、queue depth | reward workers、bridge semaphore、stage gate |
| update | actor MFU、OOM、step time | micro-batch、dynamic bsz、offload、sequence parallel |

总体 step time 近似取决于最长关键路径，不是四段吞吐简单相加。

## 训练稳定性指标

至少绘制：

- reward mean/std 与各 stage pass rate；
- uniform group ratio；
- actor KL、entropy、clip fraction；
- response length、assistant turns、tool calls；
- invalid tool call 与 timeout；
- old/rollout logprob 差异；
- 每 step rollout、reward、update、sync wall time。

常见解释：

- entropy 快速下降且同组轨迹趋同：探索不足或 KL/学习率不合适；
- reward 上升但 stage4 不升：中间权重被投机；
- tool calls 持续增加但 score 不升：缺少成本或工具反馈不清晰；
- rollout/update logprob 差异变大：权重同步、模板或 off-policy 问题。

## 正确性测试金字塔

### 纯函数测试

- stage status 到 score 的映射；
- mode 权重总和；
- task metadata 交叉检查；
- error/skipped 处理。

### Mock integration

- tool session 幂等；
- extra_fields 进入 reward；
- cleanup 与 TTL；
- 4 rollout 的 GRPO score/advantage。

### 单任务 val-only

- 真实 workspace 操作；
- artifact 导出；
- fresh-container validation；
- 无 actor update。

### 单 step train

- actor update；
- SGLang 权重同步；
- checkpoint 与恢复。

### 小规模对照实验

- terminal-only vs staged reward；
- patch-only curriculum vs 直接 e2e；
- `n=4` vs `n=8` 的收益/成本；
- 标准 GRPO vs Dr. GRPO，仅在主链稳定后比较。

## 评测协议

固定：模型 checkpoint、采样参数、任务 split、镜像 digest、bridge/validator commit、最大轮数、超时和
reward 权重。报告：

```text
pass@1 / pass@k
stage1..4 pass rate
artifact validity
mean tool calls and wall time
infra error rate
per-mode and unseen-family metrics
```

pass@k 与训练 `rollout.n` 不是同一个概念：前者是评测统计，后者还决定 GRPO baseline。

## 结课项目：增加一个第五类“效率指标”，但不破坏标准 GRPO

目标是加入 `validation_seconds` 与 `workspace_calls` 的观测和有界成本，同时保持四阶段正确性优先。

### 任务 1：追踪源码路径

画出字段从 tool `agent_data.extra_fields` 到 reward manager、`non_tensor_batch`、validation metrics 的
路径，并标注每一步对象类型。

### 任务 2：实现成本函数

要求：

- 免费调用额度内不扣分；
- 超额成本上限为 0.05；
- infra timeout 不扣模型分；
- 全通过轨迹的最低分仍高于任何未通过 stage4 的轨迹；
- 返回原始 stage score、cost 和 final score 三个指标。

### 任务 3：写测试

至少覆盖全通过但调用多、stage3 通过但 stage4 失败、模型导致超时、bridge 断连四种情况。

### 任务 4：跑对照

固定 task 和随机种子，比较无成本与有成本设置的 score、stage4、工具调用数和 wall time。若调用下降但
stage4 也显著下降，说明成本过强。

### 任务 5：解释 GRPO 行为

选择一组四条轨迹，手算 final reward 的均值、标准差和相对 advantage，再与
`compute_grpo_outcome_advantage` 输出对照。能解释这一步，才算真正理解“多阶段 reward + GRPO”。

## 最终源码阅读清单

- `verl/trainer/main_ppo.py`：入口、Ray 与 TaskRunner；
- `verl/trainer/ppo/ray_trainer.py`：一次 step 的数据流；
- `verl/trainer/ppo/core_algos.py`：GRPO advantage 与 policy loss；
- `verl/experimental/agent_loop/agent_loop.py`：并发、postprocess、streaming reward；
- `verl/experimental/agent_loop/tool_agent_loop.py`：状态机、工具与 mask；
- `verl/experimental/reward_loop/reward_loop.py`：分布式 reward workers；
- `verl/experimental/reward_loop/reward_manager/naive.py`：custom function 调用契约；
- `verl/workers/rollout/sglang_rollout/async_sglang_server.py`：SGLang adapter；
- `verl/tools/base_tool.py` 与 `tool_registry.py`：工具生命周期与加载；
- `examples/grpo_trainer/run_qwen3_8b_fsdp.sh`：可执行配置基线；
- CyberGym-E2E `scripts/validate.py` 与 `scripts/run_agent.py`：阶段 judge 语义。

读完后，你应能把 CyberGym 替换成代码测试、仿真、搜索、数据库操作或其他长耗时环境，而不改动 GRPO
主干：只需要重新定义 dataset、tool/agent loop 和 reward adapter。这正是本案例要帮助建立的 verl
扩展心智模型。

[上一章](./11-training-launch.md) · [返回教程索引](./README.md)
