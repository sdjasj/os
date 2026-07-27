# 11. 完整启动：verl + SGLang + GRPO + 多阶段 reward

本章把前面的组件组合成一个可执行模板。CyberGym-E2E 在这里只是“长耗时、多轮工具、分阶段可验证”
的代表环境；真正要学习的是 verl 如何协调 rollout、reward 与 actor update。

## 先准备 verl 环境

按项目约定使用 Python 3.12 和 `uv`：

```bash
cd /path/to/verl
uv venv --python 3.12
source .venv/bin/activate
uv pip install -e ".[sglang]"
uv pip install pre-commit hydra-core aiohttp
pre-commit install
```

当前源码快照的 `setup.py` 将 SGLang extra 固定到项目测试过的版本组合。若使用项目 Docker 镜像，
仍应从容器内执行一次 import 和单 step smoke test，不要只看镜像能启动。

```bash
python - <<'PY'
import ray, sglang, torch, verl
print("torch", torch.__version__)
print("ray", ray.__version__)
print("sglang", sglang.__version__)
print("verl", verl.__file__)
PY
```

## 先启动 mock 或受控 bridge

bridge 是环境适配层，不占用 rollout GPU。启动后检查：

```bash
curl -fsS http://bridge.internal:8080/healthz
```

健康检查只返回版本、队列深度和允许的 API 版本，不返回任务列表或运行材料。首次实验把 bridge 的
全局 validation 并发设为 1。

## 运行脚本模板

下面的 batch 和长度是“验证配置完整性”的起点，不是性能最优值。将文件放在私有运行目录，逐项替换
占位路径：

```bash
#!/usr/bin/env bash
set -xeuo pipefail

VERL_ROOT=/path/to/verl
ADAPTER_ROOT=/path/to/cybergym-bridge
MODEL_PATH=/models/tool-capable-model
TRAIN_FILE=${ADAPTER_ROOT}/data/train.parquet
VAL_FILE=${ADAPTER_ROOT}/data/val.parquet
TOOL_CONFIG=${ADAPTER_ROOT}/client/tool_config.yaml
REWARD_FILE=${ADAPTER_ROOT}/client/cybergym_reward.py
BRIDGE_URL=http://bridge.internal:8080

export PYTHONPATH=${ADAPTER_ROOT}/client:${VERL_ROOT}

cd "${VERL_ROOT}"
python3 -m verl.trainer.main_ppo \
  algorithm.adv_estimator=grpo \
  algorithm.norm_adv_by_std_in_grpo=True \
  algorithm.use_kl_in_reward=False \
  data.train_files="${TRAIN_FILE}" \
  data.val_files="${VAL_FILE}" \
  data.return_raw_chat=True \
  data.train_batch_size=8 \
  data.max_prompt_length=4096 \
  data.max_response_length=16384 \
  data.filter_overlong_prompts=True \
  data.truncation=error \
  actor_rollout_ref.model.path="${MODEL_PATH}" \
  actor_rollout_ref.model.use_remove_padding=True \
  actor_rollout_ref.model.enable_gradient_checkpointing=True \
  actor_rollout_ref.actor.optim.lr=1e-6 \
  actor_rollout_ref.actor.ppo_mini_batch_size=16 \
  actor_rollout_ref.actor.ppo_micro_batch_size_per_gpu=1 \
  actor_rollout_ref.actor.ppo_epochs=1 \
  actor_rollout_ref.actor.use_dynamic_bsz=True \
  actor_rollout_ref.actor.ppo_max_token_len_per_gpu=32768 \
  actor_rollout_ref.actor.use_kl_loss=True \
  actor_rollout_ref.actor.kl_loss_coef=0.001 \
  actor_rollout_ref.actor.kl_loss_type=low_var_kl \
  actor_rollout_ref.actor.fsdp_config.param_offload=True \
  actor_rollout_ref.actor.fsdp_config.optimizer_offload=True \
  actor_rollout_ref.rollout.name=sglang \
  actor_rollout_ref.rollout.mode=async \
  actor_rollout_ref.rollout.n=4 \
  actor_rollout_ref.rollout.temperature=0.7 \
  actor_rollout_ref.rollout.top_p=0.95 \
  actor_rollout_ref.rollout.tensor_model_parallel_size=2 \
  actor_rollout_ref.rollout.gpu_memory_utilization=0.45 \
  actor_rollout_ref.rollout.max_num_seqs=32 \
  actor_rollout_ref.rollout.enable_prefix_caching=True \
  actor_rollout_ref.rollout.free_cache_engine=True \
  actor_rollout_ref.rollout.log_prob_micro_batch_size_per_gpu=1 \
  actor_rollout_ref.rollout.log_prob_use_dynamic_bsz=True \
  actor_rollout_ref.rollout.log_prob_max_token_len_per_gpu=32768 \
  actor_rollout_ref.rollout.agent.default_agent_loop=tool_agent \
  actor_rollout_ref.rollout.agent.num_workers=8 \
  actor_rollout_ref.rollout.multi_turn.enable=True \
  actor_rollout_ref.rollout.multi_turn.tool_config_path="${TOOL_CONFIG}" \
  actor_rollout_ref.rollout.multi_turn.format=qwen3_coder \
  actor_rollout_ref.rollout.multi_turn.max_assistant_turns=16 \
  actor_rollout_ref.rollout.multi_turn.max_user_turns=16 \
  actor_rollout_ref.rollout.multi_turn.max_parallel_calls=1 \
  actor_rollout_ref.rollout.multi_turn.max_tool_response_length=1024 \
  actor_rollout_ref.rollout.multi_turn.tool_response_truncate_side=middle \
  actor_rollout_ref.rollout.multi_turn.tokenization_sanity_check_mode=strict \
  actor_rollout_ref.ref.log_prob_micro_batch_size_per_gpu=1 \
  actor_rollout_ref.ref.log_prob_use_dynamic_bsz=True \
  actor_rollout_ref.ref.log_prob_max_token_len_per_gpu=32768 \
  actor_rollout_ref.ref.fsdp_config.param_offload=True \
  reward.custom_reward_function.path="${REWARD_FILE}" \
  reward.custom_reward_function.name=compute_score \
  +reward.custom_reward_function.reward_kwargs.bridge_url="${BRIDGE_URL}" \
  +reward.custom_reward_function.reward_kwargs.validate_timeout_s=14400 \
  reward.reward_manager.name=naive \
  reward.num_workers=8 \
  trainer.use_v1=True \
  trainer.balance_batch=True \
  trainer.n_gpus_per_node=8 \
  trainer.nnodes=1 \
  trainer.logger=console \
  trainer.project_name=verl_cybergym_learning \
  trainer.experiment_name=sglang_grpo_staged_reward_smoke \
  trainer.val_before_train=True \
  trainer.log_val_generations=4 \
  trainer.test_freq=5 \
  trainer.save_freq=20 \
  trainer.total_training_steps=10 \
  trainer.resume_mode=disable
```

若模型不是 Qwen3-Coder 工具格式，必须替换 `multi_turn.format`。不要为了“先跑起来”让 parser 与
模型模板错配。

## 数量关系检查

上面每 step：

```text
原始 prompt 数 = 8
每 prompt rollout = 4
trajectory 数 = 32
actor mini-batch = 16
每 step 有 2 个 actor mini-batch（ppo_epochs=1）
```

`ppo_mini_batch_size` 必须能合理切分 trajectory batch。多 GPU 下 micro-batch 与 dynamic batching
还受有效 token 数约束；首个 smoke test 若 OOM，先降 response length、batch 或 max sequences，
不要先关闭所有正确性检查。

## 分三次启动

### 第一次：只解析配置

保留程序打印 resolved config，确认：

- `adv_estimator` 是 grpo；
- rollout name 是 sglang；
- tool config 与 reward path 是绝对占位替换后的真实路径；
- data 中自动引用同一个 tool config；
- critic 未因其他参数意外启用；
- reward model GPU 未启用。

### 第二次：`val_only`

在命令末尾加：

```text
trainer.val_only=True
data.val_max_samples=2
```

检查两条完整轨迹、stage 指标与 session cleanup。

### 第三次：单 step

改为：

```text
trainer.val_before_train=False
trainer.total_training_steps=1
trainer.save_freq=-1
trainer.test_freq=-1
```

确认 actor update 和 SGLang 权重同步完成，再恢复正式设置。

## Patch-only curriculum

对尚不会稳定使用工具的模型，可分三段：

1. mock bridge + 格式 reward：学习工具调用协议；
2. patch-only + stage3/4：学习源码修改与回归验证；
3. e2e + stage1–4：学习更长的完整轨迹。

每段都可从上段 checkpoint 恢复，但数据分布变化时要重新查看 KL、长度和 reward 直方图。不要把
patch-only 与 e2e 的 score 权重设成不同满分，否则混合 batch 的相对优势会偏向某种 mode。

## 资源扩展顺序

吞吐不足时依次测量：

1. bridge validation queue 是否占主导；
2. Agent Loop 是否大量等待 tool；
3. SGLang GPU 利用率与 KV cache；
4. actor update 时间；
5. 权重同步时间。

再针对瓶颈增加 reward worker、bridge worker、rollout replica 或训练并行。盲目把 8 个参数一起翻倍，
通常只会把瓶颈移到磁盘或容器启动。

## 输出目录与恢复

checkpoint 默认写到：

```text
checkpoints/${trainer.project_name}/${trainer.experiment_name}
```

训练轨迹可能包含受控源码片段和命令输出，不要默认上传公共 logger。先使用 console；需要持久化时设置
私有 `rollout_data_dir`、访问控制和保留期限，并确认不会记录隐藏验证材料。

## 本章验收

一次成功 smoke run 应满足：

- SGLang 启动并完成多轮 token-in/token-out；
- 同一 uid 有 4 条 rollout；
- 工具 observation mask 为 0；
- reward 返回 score 与 stage extra info；
- `rm_scores.sum(-1)` 有限且不全相同；
- GRPO advantages 有正有负；
- actor 完成 update；
- checkpoint engine 更新 rollout 权重；
- bridge 活动 session 最终归零。

[上一章](./10-multistage-reward.md) · [下一章：排错与结课项目](./12-debugging-capstone.md)
