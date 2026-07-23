# 08. 训练工程与 SGLang

## 1. 启动阶段对象

`train_agent.py:415-460` 创建：

```text
policy model       full_sft 权重，可训练
reference model    同一 full_sft 权重，eval + requires_grad_(False)
reward model       外部 InternLM reward model，冻结
rollout engine     torch 或 sglang
AgentRLDataset
AdamW + CosineAnnealingLR
```

即使工具轨迹分支不使用 RM，当前 main 仍无条件加载 `LMForRewardModel`。如果只训练纯可验证 tool 任务并想省显存，需要增加禁用 RM 的参数，而不是只传空路径。

## 2. 关键参数表

| 参数 | 默认 | 作用与风险 |
|---|---:|---|
| `batch_size` | 2 | 原始 prompt 数，不含 generation 扩张 |
| `num_generations` | 4 | 每 prompt 轨迹数；实际轨迹为 `B*G` |
| `max_gen_len` | 768 | 每一轮最多生成 token，不是整轨迹上限 |
| `max_total_len` | 2500 | 打包训练时整轨迹上限，超出左截断 |
| `thinking_ratio` | 0.1 | 每条轨迹开启 thinking 的概率 |
| `learning_rate` | `3e-7` | policy 学习率 |
| `beta` | 0.1 | reference KL 系数 |
| `loss_type` | `cispo` | `grpo` 或 `cispo` |
| `epsilon` | 0.2 | GRPO 对称 ratio clip |
| `epsilon_high` | 5.0 | CISPO ratio 上界 |
| `save_interval` | 10 | 保存与 SGLang 权重同步间隔 |

一次 batch 最坏生成量近似：

$$B\times G\times max\_turns\times max\_gen\_len$$

默认即 `2*4*3*768=18432` 个新 token 的上界，且多轮当前串行。因此训练 step 可能远慢于 SFT。

## 3. Config 长度细节

main 创建：

```python
MiniMindConfig(
    hidden_size=...,
    num_hidden_layers=...,
    max_seq_len=max_seq_len + max_gen_len,
    use_moe=...,
)
```

模型真正预计算 RoPE 的字段是 `max_position_embeddings`，不是 `max_seq_len`。`max_seq_len` 会由 `PretrainedConfig` 保留成额外属性供 Dataset 使用，但不会替代 `max_position_embeddings`。需要超过默认 32768 时，应显式传正确字段并验证 RoPE buffer。

## 4. 显存构成

同设备默认同时存在：

- policy 参数、梯度、AdamW 状态；
- reference 参数；
- 外部 reward model；
- rollout 生成 KV Cache；
- policy/ref 的整轨迹 logits/logp；
- `[B*G,L,V]` logits 临时量。

虽然训练代码用 autocast，policy/ref/RM 多模型仍显著吃显存。OOM 优先调整：

1. `max_gen_len` 和 `max_total_len`；
2. `batch_size`；
3. `num_generations`，但不能降到 1；
4. 关闭 thinking 或缩短工具输出；
5. 将 rollout/RM 放到独立进程或设备；
6. 再考虑 gradient checkpointing/ZeRO 等当前脚本未集成方案。

## 5. 训练前检查

```bash
cd /path/to/minimind
conda activate deepspeed

test -f out/full_sft_768.pth
test -f dataset/agent_rl.jsonl
test -d ../internlm2-1_8b-reward

python -m pip check
python -m compileall -q model dataset trainer
```

再单独执行：Dataset 渲染、工具解析执行、奖励单元测试、假 rollout mask 测试。不要把这些问题留到昂贵的正式 rollout 中发现。

## 6. 本地 Torch 训练

从 `trainer/` 目录运行，因为默认相对路径按这里设计：

```bash
(cd trainer && python train_agent.py \
  --data_path ../dataset/agent_rl.jsonl \
  --from_weight full_sft \
  --reward_model_path ../../internlm2-1_8b-reward \
  --rollout_engine torch \
  --debug_mode \
  --debug_interval 1)
```

第一次运行建议临时设置更小的 `max_gen_len`、少量数据和较频繁日志。当前脚本没有 `max_steps` 参数，可准备一个只含几条样本的 JSONL 做 smoke test。

## 7. DDP

```bash
(cd trainer && torchrun --nproc_per_node 2 train_agent.py \
  --data_path ../dataset/agent_rl.jsonl \
  --rollout_engine torch)
```

`DistributedSampler` 将原始 prompt 分片。每个 rank 各自 rollout、执行工具和计算 reward。按标准 DDP 用法，可训练前向应经过 DDP wrapper，由 reducer 在 backward 时同步 policy 梯度。

当前 `rl_train_epoch` 在策略前向前显式执行：

```python
model_unwrapped = model.module if isinstance(
    model, DistributedDataParallel
) else model
res = model_unwrapped(input_ids, attention_mask=full_mask)
```

也就是绕过了 DDP wrapper 的 `forward`。DDP 虽在构造时给参数注册 hook，但 wrapper forward 还负责 reducer 的每轮准备；因此不能仅凭模型已包装就假定这一训练路径正确同步。多卡使用前应做参数一致性测试，并优先让可训练前向调用 `model(...)`，只在保存、生成或访问自定义属性时 unwrap。

需要注意：

- 外部有副作用的工具会在各 rank 独立调用；
- 每个 rank 的 reward model 占一份显存；
- rank 之间轨迹长度不同可能造成 step 等待；
- 所有 rank 必须走相同数量的 DDP forward/backward；
- 只有 rank 0 保存文件和写实验日志。
- 每个 optimizer step 后应检查不同 rank 的同一参数是否一致，防止 unwrapped forward 静默绕过同步。

## 8. SGLang 服务

先准备 Transformers 格式模型并启动：

```bash
conda activate deepspeed
python -m sglang.launch_server \
  --model-path ./minimind-3 \
  --attention-backend triton \
  --host 0.0.0.0 \
  --port 8998
```

另一个终端训练：

```bash
cd /path/to/minimind
conda activate deepspeed
(cd trainer && python train_agent.py \
  --rollout_engine sglang \
  --sglang_base_url http://localhost:8998 \
  --sglang_model_path ../model \
  --sglang_shared_path ./sglang_ckpt_agent \
  --data_path ../dataset/agent_rl_math.jsonl \
  --reward_model_path ../../internlm2-1_8b-reward)
```

`sglang_model_path` 在 `SGLangRolloutEngine` 中用于加载 tokenizer；服务真正初始模型由 launch server 的 `--model-path` 决定。两者必须 tokenizer/结构一致。

## 9. 共享目录与权重同步

训练侧把最新 policy 保存到 `sglang_shared_path` 的绝对路径，然后请求：

```text
POST /update_weights_from_disk
{"model_path":"/absolute/shared/path"}
```

若服务在容器、另一节点或不同挂载命名空间，训练侧绝对路径对服务可能不存在。共享目录必须对两边可见且路径语义一致。

初始化时会同步一次；训练中只在 `save_interval` 或最后一步同步。调试 SGLang 时应记录：当前 train step、远端权重版本、同步耗时和失败次数。

## 10. 当前 `use_sglang` 参数

`rl_train_epoch(..., use_sglang=False)` 接收并传入该布尔值，但函数体当前没有基于它分支。实际后端差异全部封装在 `rollout_engine`。阅读时不要寻找不存在的训练侧 SGLang loss 路径。

## 11. Checkpoint

保存两份：

```text
out/agent_768.pth
checkpoints/agent_768_resume.pth
```

resume 文件包含 model、optimizer、scheduler、epoch、step、world size、实验 id。恢复：

```bash
(cd trainer && python train_agent.py --from_resume 1 ...)
```

恢复后仍会初始化 base policy/ref/RM，再将 policy/optimizer/scheduler 状态覆盖。reference 保持从 `from_weight` 加载，不从 agent checkpoint 更新，这是 KL 锚点的预期行为。

## 12. 日志解释

当前日志：

```text
Reward       batch 平均轨迹奖励
KL           (ref_logp-new_logp) 的 action-token 平均，非代码中非负 KL estimator
GrpStd       每个 prompt 的组内 reward std 平均
AdvStd/Mean  扁平 advantage 统计
Loss         policy+aux 的累积还原值
AvgLen       action mask token 数，不含 observation
LR           当前 AdamW learning rate
```

日志中的 `KL` 可能为负，因为它打印简单 logp 差平均；loss 使用的是 `exp(delta)-delta-1` 非负 estimator。不要把两者误认为同一量。

## 13. `debug_mode`

调试输出包括 GT、完整 context、prompt_len、seq_len、截断后的 completion decode 和 reward。它能发现明显模板/截断问题，但不能显示 token 来源 mask 和 reward 分项；专题前几章的逐 token 工具应作为补充。

## 14. 训练健康信号

健康趋势通常是：

- 工具 JSON parse rate 上升；
- execution success 和 GT success 上升；
- group std 不长期归零；
- reward 提升同时 held-out task success 提升；
- KL 受控；
- action 长度不过度膨胀；
- 工具调用数接近任务实际需要，而非机械匹配奖励。

只看总 reward 不足以判断训练成功。

## 15. 本章检查题

1. 为什么 `batch_size=2,num_generations=4` 最终有 8 条轨迹？
2. `max_gen_len` 是单轮还是整轨迹上限？
3. 为什么日志 KL 可能为负，而 loss 中 KL estimator 非负？
4. SGLang 共享路径在容器中最常见的失败原因是什么？
