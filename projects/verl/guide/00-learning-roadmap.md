# 00. 学习路线：先跑最小闭环，再逐层替换

本章给出整套教程的地图。最终系统不是“启动一个 SGLang 服务再调用它”这么简单，而是一个
训练时不断切换角色的闭环：同一份策略参数被训练后端更新，又被 rollout 后端用于并发采样；
轨迹与隔离环境交互；验证服务产生 outcome reward；GRPO 在同一任务的多条轨迹中计算相对优势。

## 先看最终闭环

```text
Parquet 中的授权 task_id
        |
        v
RLHFDataset --同题复制 n 次--> AgentLoopWorker
                                  |
                                  v
                         SGLang 生成工具调用
                                  |
                                  v
                      隔离 bridge / workspace
                                  |
                                  v
                 CyberGym fresh-container validation
                   stage1 -> stage2 -> stage3 -> stage4
                                  |
                                  v
                门控加权得到一个 scalar reward
                                  |
                                  v
             同 uid 组内归一化 -> GRPO advantage
                                  |
                                  v
                      FSDP actor policy update
                                  |
                                  +----权重同步回 SGLang----+
```

这张图里有三个容易混淆的“并行”：

1. `rollout.n` 为一个 prompt 采样多条轨迹，是 GRPO 的组；
2. `AgentLoopWorker` 用协程并发多个多轮会话；
3. `reward.num_workers` 并发执行昂贵的最终验证。

它们解决的问题不同，不应只靠增大某一个参数来提速。

## 你需要补齐的背景

如果下面任一问题答不上来，请按顺序读 01–06：

- outcome reward 为什么可以只写在 response 的最后一个有效 token 上？
- `rollout.n=8` 与 `data.train_batch_size=8` 为什么会产生 64 条轨迹？
- 为什么工具返回的 observation token 必须在 `response_mask` 中为 0？
- 为什么 SGLang 生成过的 token 还要由 actor 重新计算 `old_log_probs`？
- 为什么 reward 函数返回 `stage1_passed` 不会自动让标准 GRPO分别归一化该维度？
- 为什么每个 validation stage 最好用 fresh container？

## 四个递进实验

### 实验 A：只跑数学 GRPO

先使用仓库现有 `examples/grpo_trainer/run_qwen3_8b_fsdp.sh`，设置
`INFER_BACKEND=sglang`。目的不是得到好模型，而是确认 GPU、Ray、FSDP、SGLang 与 checkpoint
engine 能完成一个 step。

```bash
cd /path/to/verl
INFER_BACKEND=sglang \
MODEL_PATH=/models/tool-capable-model \
TRAIN_BATCH_SIZE=8 ROLLOUT_N=4 TOTAL_EPOCHS=1 \
bash examples/grpo_trainer/run_qwen3_8b_fsdp.sh \
  trainer.total_training_steps=1 \
  trainer.logger=console
```

这里仍使用脚本默认数学数据。先把训练框架与安全环境问题解耦。

### 实验 B：用假的 bridge 跑多轮工具

实现一个 mock bridge，让 `read` 返回固定文本、`run` 返回固定退出码、`validate` 返回预设四阶段
结果。目标是确认 tool schema、工具解析、`response_mask` 和异步 reward，不要一上来拉取大镜像。

### 实验 C：接入少量授权任务

只允许 allowlist 中的 2–8 个任务 ID，限制并发为 1，运行 `val_only=True`。人工核对每条轨迹的
workspace、输出 artifact 和 stage 指标之后，再启用训练。

### 实验 D：扩大训练并做消融

至少比较三组设置：

| 实验 | reward | 目的 |
| --- | --- | --- |
| terminal-only | 仅全通过为 1 | 观察稀疏奖励是否导致全组同分 |
| staged | 四阶段门控加权 | 验证中间进度是否改善学习信号 |
| staged + cost | staged 减去超时/无效调用成本 | 抑制无休止编译和工具滥用 |

## 推荐阅读节奏

每章都用同一组问题收束：输入是什么、输出是什么、状态在哪里、并发在哪里、失败怎样传播。
不要把所有 Hydra 参数一次性背下来。先记住五个关键开关：

```text
algorithm.adv_estimator=grpo
actor_rollout_ref.rollout.name=sglang
actor_rollout_ref.rollout.n=<group size>
actor_rollout_ref.rollout.agent.default_agent_loop=tool_agent
reward.custom_reward_function.path=<async reward adapter>
```

然后再逐层补上 multi-turn、tool config、长度、资源和日志参数。

## 成本预估方法

一个训练 step 的最坏验证次数近似为：

```text
train_batch_size * rollout.n * 每条轨迹实际执行的 stage 数
```

若 batch 为 8、`n=4`、每条都跑 4 个 fresh-container stage，一步最多启动 128 个验证容器。
这解释了为什么教程后面会强调：门控跳过后续 stage、限制 reward 并发、缓存镜像层、先做
patch-only curriculum，以及将 rollout GPU 与 CPU/Docker 验证资源分别监控。

## 本章自测

1. GRPO 的“group”按 task、batch 还是 GPU 划分？
2. 为什么不能直接把 stage1–4 当作四个 token-level reward 填到任意位置？
3. mock bridge 通过后，为什么仍应先用 `val_only` 接真实授权任务？
4. 若一组四条轨迹 reward 都是 0，标准 GRPO 的优势是多少？

答案：同一原始样本的重复 rollout 共享 `uid`；标准实现使用 outcome reward 并在有效 response
token 上广播组内相对优势；真实容器的状态、超时和 artifact 契约仍可能出错；全组同分时优势为 0，
该组不提供有效更新信号。

[下一章：RL、PPO 与 GRPO 背景](./01-rl-grpo-foundations.md)
