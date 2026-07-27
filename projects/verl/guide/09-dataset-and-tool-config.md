# 09. 构造训练数据与工具配置

本章把授权 task allowlist 转成 verl 可读 Parquet，并把工具配置、Python 模块路径和 Ray worker
环境对齐。示例只使用占位 ID。

## 目录建议

不要修改 verl 源码即可完成适配：

```text
/path/to/cybergym-bridge/
├── client/
│   ├── cybergym_tool.py
│   ├── cybergym_reward.py
│   └── tool_config.yaml
├── config/
│   └── authorized_tasks.json
├── data/
│   ├── train.parquet
│   └── val.parquet
└── scripts/
    ├── prepare_dataset.py
    └── run_verl.sh
```

模型、原始任务数据、Docker layer 与训练输出放在受控存储，不进入此目录的版本控制。

## 输入 allowlist 只含元数据

```json
[
  {"task_id": "demo-project/authorized-task-a", "mode": "patch-only", "split": "train"},
  {"task_id": "demo-project/authorized-task-b", "mode": "e2e", "split": "val"}
]
```

数据准备脚本要检查重复 ID、合法 mode、split 泄漏和 bridge allowlist 一致性。

## 完整行构造函数

```python
def build_row(item: dict, index: int) -> dict:
    task_id = item["task_id"]
    mode = item["mode"]
    mode_instruction = (
        "环境提供了受控的失败信息；请生成修复 artifact。"
        if mode == "patch-only"
        else "请从受控源码开始分析，并生成验证所需的两个 artifact。"
    )
    return {
        "data_source": f"cybergym-e2e/{mode}",
        "agent_name": "tool_agent",
        "prompt": [
            {
                "role": "system",
                "content": (
                    "你在明确授权的隔离 workspace 中工作。只能使用 cybergym_workspace 工具；"
                    "不得访问宿主机、外部网络或其他 session；不要在回答中输出二进制内容。"
                    "检查源码、迭代修改，并把最终 artifact 写到工具约定的位置。"
                ),
            },
            {"role": "user", "content": mode_instruction},
        ],
        "reward_model": {
            "style": "rule",
            "ground_truth": {"task_id": task_id, "mode": mode},
        },
        "extra_info": {
            "index": index,
            "task_id": task_id,
            "mode": mode,
            "need_tools_kwargs": True,
            "tools_kwargs": {
                "cybergym_workspace": {
                    "create_kwargs": {"task_id": task_id, "mode": mode}
                }
            },
        },
    }
```

Prompt 不含 task ID 也可以，因为工具从不可由模型修改的 `tools_kwargs` 取得它。若希望模型看到一个
人类可读标签，只显示无权限含义的别名，bridge 仍以注入 metadata 为准。

## 写 Parquet

```python
import json
from pathlib import Path

from datasets import Dataset

items = json.loads(Path("config/authorized_tasks.json").read_text())
for split in ("train", "val"):
    selected = [item for item in items if item["split"] == split]
    rows = [build_row(item, index) for index, item in enumerate(selected)]
    Dataset.from_list(rows).to_parquet(f"data/{split}.parquet")
```

生成后只打印行数、字段名和 task ID 的哈希摘要，不打印 prompt 内可能后来加入的受控内容。

## 训练/验证拆分断言

```python
train_ids = {item["task_id"] for item in items if item["split"] == "train"}
val_ids = {item["task_id"] for item in items if item["split"] == "val"}
assert train_ids.isdisjoint(val_ids)
assert all(item["mode"] in {"patch-only", "e2e"} for item in items)
assert len(train_ids | val_ids) == len(items)
```

若一个缺陷存在多个近重复任务，需在 allowlist 增加 `family_id`，按 family 拆分而不是只按 task ID。

## Python import 路径

YAML 中 `class_name: cybergym_tool.CyberGymWorkspaceTool` 要求 Ray worker 能 import
`cybergym_tool`。最直接的方式是在启动前：

```bash
export PYTHONPATH=/path/to/cybergym-bridge/client:/path/to/verl
```

verl 的 Ray runtime env 会传播相关环境，但集群多节点仍要求每个节点有相同路径，或通过经过审查的
runtime package 分发。不要依赖只存在于 driver 的相对路径。

## Tool config 与 Dataset 的双重加载

设置：

```text
actor_rollout_ref.rollout.multi_turn.tool_config_path=/path/to/.../tool_config.yaml
```

rollout worker 加载实际工具，Dataset 也加载 schema 以准确计算 prompt 长度。若工具模块在 Dataset
初始化时 import 失败，可能只得到 warning，长度过滤退化；因此 smoke test 要显式实例化
`RLHFDataset` 并确认 schema 加载成功。

## 先做静态数据审计

对生成的 Parquet 运行以下检查：

```text
[ ] 只包含允许字段
[ ] task ID 属于授权清单
[ ] train/val 无 task 或 family 重叠
[ ] 没有绝对本机路径
[ ] 没有 token、key、cookie 或 bridge credential
[ ] 没有源码、PoC、patch、crash log、隐藏验证结果
[ ] 每条都有 agent_name=tool_agent
[ ] tools_kwargs 中 tool 名与 YAML schema 一致
```

## val-only 集成检查

不要立即更新模型：

```bash
python3 -m verl.trainer.main_ppo \
  data.train_files=/path/to/data/train.parquet \
  data.val_files=/path/to/data/val.parquet \
  actor_rollout_ref.model.path=/models/tool-capable-model \
  actor_rollout_ref.rollout.name=sglang \
  actor_rollout_ref.rollout.agent.default_agent_loop=tool_agent \
  actor_rollout_ref.rollout.multi_turn.enable=True \
  actor_rollout_ref.rollout.multi_turn.tool_config_path=/path/to/tool_config.yaml \
  trainer.val_only=True trainer.logger=console
```

完整长度、TP 和 reward 参数见第 11 章。这里的目标只是验证数据到工具的通路。

## 本章练习

创建两条 mock task 数据，启动 mock bridge，以 `val_only` 跑完。检查 bridge 收到的 task ID 来自
`tools_kwargs`，而不是模型参数；检查 val dump 不含 task 原始材料；检查所有 session 被删除。

[上一章](./08-cybergym-bridge-tool.md) · [下一章：多阶段 reward](./10-multistage-reward.md)
