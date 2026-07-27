# 04. SGLang rollout：采样、sticky session 与权重同步

SGLang 在本方案中是策略的高吞吐推理后端。它不负责 CyberGym 容器，也不计算 GRPO；它接收 token
序列和采样参数，为多个 Agent Loop 生成下一段 assistant token。

## 最小启用参数

仓库的标准 GRPO 脚本已经支持通过环境变量切换：

```bash
INFER_BACKEND=sglang \
MODEL_PATH=/models/tool-capable-model \
bash examples/grpo_trainer/run_qwen3_8b_fsdp.sh
```

等价的关键 override 是：

```text
actor_rollout_ref.rollout.name=sglang
actor_rollout_ref.rollout.mode=async
algorithm.adv_estimator=grpo
actor_rollout_ref.rollout.n=4
```

当前配置只支持 async rollout；多轮 Agent Loop 也依赖异步 server manager。

## 从 Agent Loop 到 SGLang

`ToolAgentLoop._handle_generating_state` 调用：

```python
output = await self.server_manager.generate(
    request_id=agent_data.request_id,
    prompt_ids=agent_data.prompt_ids,
    sampling_params=sampling_params,
    ...,
)
```

`LLMServerClient` 在第一轮选择较空闲的 replica，并对后续轮次保持 sticky session。同一轨迹的工具
观察因此继续送往相同 server；不同轨迹可以分散到多个 replica。

`request_id` 也很适合做 bridge session 的幂等键，但不要把它当作跨训练重启的永久 ID。

## token-in/token-out 为什么重要

许多 Agent 框架每轮把 messages 重新渲染成字符串，再调用 OpenAI chat API。训练需要精确知道哪些
token 来自当前 policy。反复 decode、修改 tool call、再 encode 可能使最终 token 序列偏离真实采样。

verl 的 Agent Loop 以 token 为主线：

1. 初始 messages 应用 chat template；
2. SGLang 返回真实生成 token IDs；
3. tool parser 从这些 token 中识别调用；
4. observation 被编码并追加，但 mask 为 0；
5. 下一轮继续在累计 token IDs 上生成。

这样 actor 重算 log prob 时看到的动作 token 与 rollout 更一致。

## 工具格式必须与模型匹配

`ToolParser` 当前注册了 `hermes`、`gpt-oss`、`qwen3_coder`、`glm`、`seed`、`minimax`、
`kimi` 和 `gemma4` 等格式。配置名不是“喜欢哪个就选哪个”，必须匹配模型 chat template 和训练分布。

```text
actor_rollout_ref.rollout.multi_turn.format=qwen3_coder
```

若模型产生看似正确的 JSON 但 parser 始终找不到 tool call，先检查格式与 special token，不要立即改
reward。首次训练前用 10 条 prompt 做纯 rollout，并逐 token 检查工具边界。

## 关键容量参数

| 参数 | 影响 | 常见误区 |
| --- | --- | --- |
| `tensor_model_parallel_size` | 单个 replica 使用的 GPU 数 | TP 大不等于请求并发高 |
| `gpu_memory_utilization` | KV cache 可用显存比例 | 与 FSDP 共卡时设太高会 OOM |
| `max_num_batched_tokens` | 调度批次 token 上限 | 长多轮轨迹需要更大，但占显存 |
| `max_num_seqs` | 同时调度序列数 | bridge 很慢时大量会话会挂起 |
| `enable_prefix_caching` | 相同前缀复用 | 同一任务 n 条 rollout 通常受益 |
| `free_cache_engine` | 训练阶段释放 cache | 减内存但增加切换成本 |
| `response_length` | 整条多轮 response budget | 包括模型 token 和 observation token |

CyberGym 工具输出可能很长。不要只增大 `max_response_length`；先在 bridge 侧返回结构化摘要、限制文件
读取窗口，再设置 `max_tool_response_length` 和截断方向。

## 权重同步阶段

SGLang 不能一直使用 step 0 的权重。trainer 在 actor update 后通过 checkpoint engine 更新 replica。
配置中的：

```text
actor_rollout_ref.rollout.checkpoint_engine.backend=naive
actor_rollout_ref.rollout.checkpoint_engine.update_weights_bucket_megabytes=2048
```

控制更新方式与传输桶。先用默认 `naive` 验证正确性；只有权重同步成为瓶颈时，再评估 NCCL、NIXL 或
SGLang 专用 delta backend。一次接入同时改变 reward、backend 和 off-policy 模式会失去可诊断性。

## rollout 参数与 GRPO 探索

训练 rollout 默认 `temperature=1.0`、`top_p=1`、`top_k=-1`。CyberGym 的轨迹成本高，温度太高会
制造大量无效格式，太低则同组轨迹高度相同、reward 无方差。推荐先用：

```text
temperature=0.7
top_p=0.95
rollout.n=4
```

这只是起点，应以以下观测调整：工具调用解析率、每组唯一 action 序列数、uniform reward group 比例、
平均工具轮数和最终 stage 分布。

验证集通常使用 greedy 参数：`val_kwargs.temperature=0`、`do_sample=False`、`n=1`。训练和验证采样
语义不同是有意的。

## 显存与 CPU/Docker 的双重反压

长轨迹挂在等待 bridge 时，会占用 server 侧会话状态和 KV cache；验证容器又消耗 CPU、磁盘和内存。
建议分别设置：

- SGLang `max_num_seqs` 与 GPU memory 上限；
- Agent Loop `num_workers`；
- Reward Loop `num_workers`；
- bridge 全局与每镜像 semaphore；
- 单工具调用、单 session 和单 validation stage 超时。

吞吐以完成并成功评分的 trajectory/小时衡量，不要只看 SGLang tokens/s。

## 最小 smoke test

在接 bridge 前做三步：

1. `trainer.total_training_steps=1` 跑普通 GRPO；
2. 开启 tool_agent 但连接 mock bridge；
3. `trainer.val_only=True` 接 1 个授权 task。

每步只增加一个变量。若步骤 1 失败，问题与 CyberGym 无关；步骤 2 失败，多半在 schema/parser/mask；
步骤 3 失败，再查容器和 validator。

## 本章自测

1. sticky session 保证了什么，不保证什么？
2. `response_length` 是否只计算 assistant 自然语言？
3. SGLang tokens/s 提升后，总训练吞吐为什么可能不变？
4. parser 不识别 tool call 时，为什么 reward 往往全部为 0？

[上一章](./03-config-data-contracts.md) · [下一章：Agent Loop 与工具](./05-agent-loop-tools.md)
