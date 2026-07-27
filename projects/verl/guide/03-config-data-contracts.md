# 03. 配置、数据与 DataProto：先把契约对齐

Agentic RL 最常见的失败不是算法公式，而是数据字段在 Parquet、Dataset、Agent Loop 和 Reward
Loop 之间丢失。本章从 Hydra 配置与单条样本出发，建立可检查的契约。

## Hydra 配置不是普通字典

`ppo_trainer.yaml` 通过 defaults 组合多个 dataclass-backed config。命令行覆盖时遵循 OmegaConf：

- 已存在字段直接写 `a.b=value`；
- 新增到结构化配置外的字段通常用 `+a.b=value`；
- list、dict 和字符串要注意 shell 引号；
- 最终以程序打印的 resolved config 为准。

例如 reward adapter 的固定参数由 `get_custom_reward_fn` 从 `reward_kwargs` 合并进每次调用：

```bash
reward.custom_reward_function.path=/path/to/cybergym_reward.py \
reward.custom_reward_function.name=compute_score \
+reward.custom_reward_function.reward_kwargs.bridge_url=http://bridge.internal:8080
```

`bridge_url` 不应放进每行数据，更不应把凭据写入 Parquet。

## 一条 Agentic RL 样本

verl 的 `RLHFDataset.__getitem__` 会保留普通字段，并额外构造 `raw_prompt`、`index`、
`tools_kwargs` 与 `interaction_kwargs`。适合本案例的行结构是：

```python
row = {
    "data_source": "cybergym-e2e/e2e",
    "agent_name": "tool_agent",
    "prompt": [
        {"role": "system", "content": "只在分配的隔离 workspace 中工作……"},
        {"role": "user", "content": "分析授权任务并生成要求的验证产物。"},
    ],
    "reward_model": {
        "style": "rule",
        "ground_truth": {"task_id": "demo-project/authorized-task", "mode": "e2e"},
    },
    "extra_info": {
        "index": 0,
        "task_id": "demo-project/authorized-task",
        "mode": "e2e",
        "need_tools_kwargs": True,
        "tools_kwargs": {
            "cybergym_workspace": {
                "create_kwargs": {
                    "task_id": "demo-project/authorized-task",
                    "mode": "e2e",
                }
            }
        },
    },
}
```

这里刻意只保存 task ID，不保存源码压缩包、PoC、crash log 或补丁。bridge 在服务器侧根据 allowlist
解析 ID，并从受控存储装配 workspace。

## 字段怎样流动

| 字段 | 消费者 | 用途 |
| --- | --- | --- |
| `prompt` | `RLHFDataset` | 构造 `raw_prompt`，由 Agent Loop 应用 chat template |
| `agent_name` | `AgentLoopWorker` | 从 registry 选择 `tool_agent` 或自定义 loop |
| `data_source` | RewardManager | 选择或分流 reward 逻辑 |
| `reward_model.ground_truth` | reward 函数 | 携带 task ID 和模式，不代表文本答案 |
| `extra_info.index` | tracing/分组观测 | 原始样本索引，不是 GRPO uid |
| `tools_kwargs` | stateful tool | 将 task ID 注入工具，而不暴露给模型参数 |
| tool `extra_fields` | reward 函数 | 传递 session ID、调用计数等运行时状态 |

注意 `uid` 由 trainer 在每个 step 为原始样本生成，再在 repeat 时复制。不要用 task ID 自己替代它，
否则同一 task 在 batch 中重复出现时可能错误地合并跨样本组。

## Prompt 应该告诉模型什么

一个有效 system prompt 至少描述：

1. 这是明确授权且隔离的 workspace；
2. 只能通过给定工具访问文件和运行命令；
3. 需要在固定输出位置生成 artifact；
4. 不得访问网络、宿主机或其他 session；
5. 不要在最终回答中粘贴二进制内容；
6. 遇到资源限制时应停止并总结，而不是无限重试。

不要在 prompt 中泄露 stage4 的 ground-truth PoC、真实补丁或隐藏测试。这不仅破坏评测，也会形成
reward leakage。

## Prompt 长度与工具 schema

`RLHFDataset` 会加载与 AgentLoopWorker 相同的工具配置，以便过滤 prompt 时把 tool schema 的 token
也算进去。相关映射来自 data 配置：

```yaml
tool_config_path: ${oc.select:actor_rollout_ref.rollout.multi_turn.tool_config_path, null}
function_tool_path: ${oc.select:actor_rollout_ref.rollout.multi_turn.function_tool_path, null}
```

因此 schema 越臃肿，真正留给任务描述的 prompt budget 越少。推荐单个 workspace 工具使用枚举动作，
而不是暴露十几个重复的 shell 工具。

## DataProto 的职责

DataLoader 输出经过 `collate_fn` 后分为两类：

- tensor 字段进入 `DataProto.batch`；
- Python 对象、字符串和嵌套 dict 进入 `DataProto.non_tensor_batch` 的 object array。

`DataProto` 使 rollout、reward、actor worker 共享同一批数据，但它不会替你校验业务 schema。训练前
应写一个只读检查脚本，对 Parquet 的每行验证：

```python
required = {"data_source", "agent_name", "prompt", "reward_model", "extra_info"}
assert required <= row.keys()
assert row["extra_info"]["task_id"] in authorized_task_ids
assert row["reward_model"]["ground_truth"]["task_id"] == row["extra_info"]["task_id"]
assert row["agent_name"] == "tool_agent"
```

## `ground_truth` 在这里不是答案

默认 `NaiveRewardManager` 固定读取：

```python
ground_truth = data_item.non_tensor_batch["reward_model"]["ground_truth"]
```

所以字段必须存在，即使评分完全依赖 bridge。把结构化 metadata 放在这里是兼容现有接口的做法；
reward adapter 仍要交叉检查 `ground_truth.task_id`、`extra_info.task_id` 和 session 所属 task 一致，
防止串 session。

## 两种模式的同一数据契约

CyberGym 有 `patch-only` 与 `e2e`。不要维护两套完全不同的 trainer。用 `mode` 分流：

```text
patch-only: agent 可见受控 crash 信息，产出 fix.patch，执行 stage3/4
e2e:        agent 只从源码开始，产出 poc.bin + fix.patch，执行 stage1–4
```

推荐 curriculum 先 patch-only 后 e2e，但同一 batch 中混合模式会让 reward 分布不同。若要混合，分别
记录模式指标，并确保分段 reward 的满分尺度一致。

## 数据安全检查

训练前至少检查：

- task ID 全部在 allowlist；
- Parquet 不含源码、PoC、patch、crash log、token 或主机路径；
- system prompt 不包含 hidden validator 信息；
- bridge URL 由运行配置注入；
- train/val 按 task ID 划分，避免同一任务跨集合；
- 每条记录有稳定 index，但不把 index 当权限凭据。

## 本章练习

构造 2 条 mock 数据：一条 patch-only，一条 e2e。加载 `RLHFDataset` 后打印字段名而不打印内容，
确认存在 `raw_prompt`、`tools_kwargs`、`reward_model` 和 `data_source`。再故意删除
`reward_model.ground_truth`，观察 reward 路径在哪一步失败。

[上一章](./02-verl-architecture.md) · [下一章：SGLang rollout](./04-sglang-rollout.md)
