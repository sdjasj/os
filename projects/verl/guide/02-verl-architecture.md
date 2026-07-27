# 02. verl 架构：沿一次训练 step 追踪数据

本章不按目录逐个介绍文件，而是沿 `python -m verl.trainer.main_ppo` 的真实执行链追踪一次 step。
读源码时始终问：当前对象在 driver、Ray actor、训练 GPU 还是 rollout server 中？

## 五层心智模型

```text
Hydra entrypoint        verl/trainer/main_ppo.py
        |
Ray orchestration       TaskRunnerV1 / RayPPOTrainer
        |
rollout + agent         LLMServerManager / AgentLoopManager
        |
reward                  RewardLoopManager / RewardManager
        |
optimization            compute_advantage / actor update / checkpoint sync
```

### 第一层：Hydra 组合配置

`main_ppo.py` 读取 `verl/trainer/config/ppo_trainer.yaml`，后者再通过 defaults 组合 actor、rollout、
data、reward、algorithm 等子配置。命令行中的点号参数是 OmegaConf override，不是随意的 Python
属性。

入口完成三件事：

1. 校验和打印最终配置；
2. 初始化 Ray runtime environment；
3. 启动远程 `TaskRunnerV1.run(config)`。

所以遇到“本机能 import，Ray worker 不能 import”的问题，应检查 runtime env、工作目录和模块路径，
而不只是当前 shell。

### 第二层：资源与角色

训练器为不同角色分配 resource pool。GRPO 不需要 critic，但通常仍有：

- ActorRollout：训练 actor，并提供/托管 rollout 权重；
- RefPolicy：当 actor loss 使用 KL 时计算参考 log probability；
- RewardModel：只有启用 DisRM/GenRM 时需要 GPU；
- RewardLoop worker：执行 rule-based 或外部验证 reward，通常主要消耗 CPU、网络和 Docker。

CyberGym 最终验证很重，但不需要占用 actor GPU。把验证并发与 GPU 数绑死会造成 GPU 等容器、容器
又争抢主机资源的反压。

## 一次 step 的实际顺序

`RayPPOTrainer.fit` 的主路径可概括为：

1. dataloader 取 `train_batch_size` 个原始任务；
2. 为每个样本生成一个 `uid`；
3. `repeat(repeat_times=rollout.n, interleave=True)` 形成 GRPO 组；
4. Agent Loop 通过 SGLang 生成多轮轨迹；
5. reward loop 对完成的轨迹做异步或 colocated 评分；
6. 合并 prompt、response、mask、`rm_scores` 与 extra info；
7. actor 重新计算 `old_log_probs`，必要时计算 ref log probs；
8. 将 `rm_scores` 写为 `token_level_scores`；
9. 计算 GRPO advantage；
10. actor 执行若干 mini-batch update；
11. checkpoint engine 把新参数同步给 rollout replicas；
12. 进入下一 step。

## 为什么 SGLang 生成后还要重算概率

rollout engine 的职责是高吞吐采样，它可能使用不同 kernel、batching 和调度。actor update 需要一个
稳定的 proximal anchor，并确保 log probability 的计算与训练模型实现一致。默认路径因此重新计算
`old_log_probs`。若启用特定 rollout correction/bypass 模式，行为会改变；初次接入不要同时打开。

## 数据张量的形状

设 prompt padding 长度为 \(P\)，response padding 长度为 \(T\)，trajectory batch 为 \(B\)：

| 字段 | 形状 | 含义 |
| --- | --- | --- |
| `prompts` | `[B, P]` | 左 padding 的初始 prompt |
| `responses` | `[B, T]` | 模型 token + 工具 observation + 右 padding |
| `attention_mask` | `[B, P+T]` | 真实 token 为 1 |
| `response_mask` | `[B, T]` | 仅模型生成 token 为 1 |
| `rm_scores` | `[B, T]` | outcome score 通常只写在最后有效位置 |
| `old_log_probs` | `[B, T]` | actor 对 rollout 动作的 log probability |
| `advantages` | `[B, T]` | GRPO 标量优势广播后再乘 response mask |

工具 observation 同时满足 `attention_mask=1` 与 `response_mask=0`：模型下一轮要看见它，但不能把它
当作自己选择的动作训练。

## Agent Loop 和 Reward Loop 的流式组合

`AgentLoopWorker._compute_score` 检查两件事：

- 自定义 Agent Loop 是否已经设置 `output.reward_score`；
- 是否有可用的 reward loop worker handle。

如果前者为空且后者存在，轨迹一结束就可送往 reward worker，而不必等整个 rollout batch 完成。
这对 CyberGym 特别重要：四阶段验证远慢于一次普通数学字符串匹配，流式执行能减少尾部等待。

但流式不等于无限并发。reward 函数仍应在 bridge 侧设置全局 semaphore、每任务超时和容器配额。

## SGLang 在哪里

`LLMServerManager` 根据 `actor_rollout_ref.rollout.name` 创建 rollout replica。SGLang 路径落在
`verl/workers/rollout/sglang_rollout/async_sglang_server.py`，它负责把 verl 的 token-in/token-out
请求翻译成 SGLang engine 请求，并处理 HTTP server、采样参数和 logprob 结果。

Agent Loop 不直接依赖 SGLang 私有 API，而依赖 `LLMServerClient.generate`。这个边界让相同的 Agent
Loop 能切换 rollout backend；本教程固定 SGLang 是为了利用其异步、多轮和权重管理路径。

## 权重如何回到 rollout

训练后的 actor 参数与 SGLang 中正在服务的参数必须一致。verl 的 checkpoint engine 协调：

```text
sleep rollout replicas
  -> actor update
  -> checkpoint_manager.update_weights()
  -> wake rollout replicas
```

`free_cache_engine=True` 可在训练阶段释放 KV cache；`multi_stage_wake_up` 是 SGLang 特有的峰值内存
优化。它们影响内存与切换时间，不改变 GRPO 数学。

## 阅读源码的推荐断点

先在以下位置打日志或断点，不要从 CUDA kernel 开始：

1. `TaskRunnerV1.run`：配置和 manager 初始化；
2. `RayPPOTrainer.fit` 中 `gen_batch.repeat`：GRPO 分组；
3. `AgentLoopWorker.generate_sequences`：每个样本怎样启动协程；
4. `AgentLoopWorker._compute_score`：extra fields 怎样进入 reward；
5. `extract_reward`：训练器取到了哪些 reward；
6. `compute_grpo_outcome_advantage`：按哪个 `uid` 分组；
7. `_update_actor` 前：mask、advantage 和 old log probs 是否有限值。

## 一个小型形状检查

假设 `train_batch_size=2`、`rollout.n=4`，则 rollout 后 \(B=8\)。调试时至少断言：

```python
assert len(batch.non_tensor_batch["uid"]) == 8
assert batch.batch["responses"].shape[0] == 8
assert batch.batch["rm_scores"].shape == batch.batch["response_mask"].shape
assert batch.batch["advantages"].shape == batch.batch["response_mask"].shape
```

再按 `uid` 统计每组数量，必须各为 4。若 balance batch 改变了顺序没有关系，因为 GRPO 按 uid
聚合而不是依赖相邻位置。

## 本章自测

1. `train_batch_size` 与 trajectory batch size 有什么关系？
2. reward extra info 在算法更新中一定会被使用吗？
3. SGLang 与 FSDP actor 是否是两个永远独立的模型？
4. 工具 observation 为什么既在 attention mask 中，又不在 response mask 中？

答案：trajectory 数还要乘 `rollout.n`；extra info 默认主要用于日志，只有特定算法或自定义逻辑才
消费；两者是同一策略的训练/推理表示，需要持续同步；observation 是后续上下文但不是策略动作。

[上一章](./01-rl-grpo-foundations.md) · [下一章：配置与数据契约](./03-config-data-contracts.md)
