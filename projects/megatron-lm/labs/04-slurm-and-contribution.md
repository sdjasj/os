# 04. SLURM、多节点排错与继续贡献路线

多节点训练并没有改变前面的模型数学，却增加了 scheduler、共享文件系统、rendezvous、容器和逐 rank 日志。可靠脚本要明确每节点只有一个 `srun` task，再由它启动本节点 GPU workers，所有节点共同组成一个 `torch.distributed.run` worker group。

## 提交前提

- worktree、数据、checkpoint 和日志路径对所有节点可见；
- 使用匹配仓库的容器/环境，且运行前已准备好 venv；
- 分区、账户、GPU 数和运行时长已确认；
- 先用 1 node 验证命令，再扩大节点数；
- 不在脚本里写 token、密码或私有 registry 凭据。

## 最小 sbatch 骨架

```bash
#!/bin/bash
#SBATCH --job-name=megatron-study
#SBATCH --account=<SLURM_ACCOUNT>
#SBATCH --partition=<SLURM_PARTITION>
#SBATCH --nodes=<NODES>
#SBATCH --ntasks-per-node=1
#SBATCH --gpus-per-node=<GPUS_PER_NODE>
#SBATCH --time=<HH:MM:SS>
#SBATCH --output=logs/%x-%j.out
#SBATCH --error=logs/%x-%j.err

set -euo pipefail
cd <SHARED_MEGATRON_WORKTREE>

export MASTER_ADDR=$(scontrol show hostnames "$SLURM_JOB_NODELIST" | head -n1)
export MASTER_PORT=${MASTER_PORT:-29500}
export NNODES=${SLURM_NNODES}
export GPUS_PER_NODE=<GPUS_PER_NODE>
export WORLD_SIZE=$((NNODES * GPUS_PER_NODE))

srun --ntasks=${NNODES} --ntasks-per-node=1 bash -c '
  NODE_RANK=${SLURM_NODEID}
  uv run python -m torch.distributed.run \
    --nnodes='"${NNODES}"' \
    --nproc-per-node='"${GPUS_PER_NODE}"' \
    --node-rank=${NODE_RANK} \
    --master-addr='"${MASTER_ADDR}"' \
    --master-port='"${MASTER_PORT}"' \
    pretrain_gpt.py <MEGATRON_ARGS>
'
```

要点：一个 `srun` task 对应一个节点，`SLURM_NODEID` 成为 node rank；不要启动多个彼此独立的单节点 torchrun。

## `CUDA_DEVICE_MAX_CONNECTIONS` 决策表

不能无条件设置：

| 条件 | 处理 |
| --- | --- |
| Hopper/Ampere，TP>1 或 CP>1，非 FSDP | 设为 `1` |
| Blackwell/GB200 | 通常无需设置 |
| Torch-FSDP2 或 Megatron-FSDP | 不得为 `1`，保持 unset 或 >1 |
| `overlap_moe_expert_parallel_comm` | 设为 `32` |

硬件和模式同时满足多个条件时，以具体功能约束与当前源码断言为准，不沿用旧作业脚本。

## 提交与监控

```bash
mkdir -p logs
JOB_ID=$(sbatch --parsable run_megatron.slurm)
squeue -j "$JOB_ID" -o "%.10i %.8T %.10M %.6D %R"
sacct -j "$JOB_ID" --format=JobID,State,ExitCode,Elapsed
```

只在明确需要时取消：

```bash
scancel "$JOB_ID"
```

若训练会产出 rank-0 JSON 或 checkpoint marker，应监控真实 artifact，而不只看 `squeue`。Scheduler 标记完成前，有效结果可能已产生；反之，job 结束也不代表 checkpoint 可恢复。

## 多节点故障分类

### Import/路径

确认每节点 `cd` 到相同共享 worktree，容器内 mount path 一致，venv 可见。node-local 路径会让其他节点找不到代码或 checkpoint。

### Rendezvous

确认 `MASTER_ADDR` 是 allocation 第一节点且所有节点可解析，端口未冲突，`NNODES`、node rank、`nproc-per-node` 一致。

### Shape/整除

验证：

```text
WORLD_SIZE = TP * PP * CP * DP
num_attention_heads % TP == 0
experts % EP == 0
```

### NCCL

先找所有 rank 中最早 Python/CUDA traceback；无上游异常时，再检查 allocation、网卡、端口、命令一致性与 collective 顺序。

## 从学习到贡献

完成教程后，按兴趣继续：

| 方向 | 下一入口 |
| --- | --- |
| 新架构/Hybrid | `pretrain_hybrid.py`、Hybrid migration guide |
| MoE | `transformer/moe/` 与 MoE functional recipes |
| 推理 | `megatron/core/inference/`、`examples/inference/` |
| 后训练 | `megatron/post_training/` |
| RL | `megatron/rl/` 与 `examples/rl/` |
| 多模态 | `examples/multimodal/` |
| Checkpoint | `core/dist_checkpointing/` |
| 测试/CI | `tests/test_utils/recipes/` |

## 贡献前检查清单

1. 阅读 `docs/developer/contribute.md`；
2. 保持改动小而有测试，先运行最精确测试再扩大；
3. 修改 Python imports 后对文件运行 `uv run isort <files>`；
4. Core 生产代码优先传 `ProcessGroupCollection`/显式 PG，不新增深层全局 group 读取；
5. Commit 同时使用 `-s` 和 `-S`；
6. 分支只能推到个人 fork，不直接推 NVIDIA 上游；
7. PR 必须创建为 draft；
8. 合并前检查以该 PR 的 `pull-request/<number>` 为 base 的依赖 PR，并先 retarget 到 `main`。

本教程没有替你 commit、push、创建 PR 或提交集群作业；这些都是需要明确目标与权限的后续动作。

## 毕业练习：解释一个真实 recipe

选择 `tests/functional_tests/test_cases/gpt/` 下一个 TP+PP+CP case：

1. 从 recipe 找环境、节点和 scope；
2. 从 `model_config.yaml` 提取模型、并行、batch、数据、checkpoint 参数；
3. 验算 world 与 global batch；
4. 画 rank 坐标和 pipeline 时间线；
5. 预测显存大头和通信大头；
6. 找对应 golden values 与 resume 断言；
7. 写一页“失败时看哪些 rank/指标”的 runbook。

能独立完成这七步，就已经从“会运行脚本”进入“能评审训练系统配置”的阶段。

## 自测

1. 为什么 `srun` 只启动每节点一个 task？
2. 多节点必须共享哪些路径？
3. `CUDA_DEVICE_MAX_CONNECTIONS=1` 为什么不能写成全局默认？
4. 贡献 Core PG 接口时应遵守什么方向？
5. Draft PR、个人 fork、`-s -S` 分别保护什么流程？

## 源码与规范

- [训练示例](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/docs/user-guide/training-examples.md)
- [SLURM/FSDP 示例](https://github.com/NVIDIA/Megatron-LM/tree/e79cb4c1bae1afd04322d979d08cb63832991ebe/examples/megatron_fsdp)
- [贡献指南](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/docs/developer/contribute.md)
- [测试目录](https://github.com/NVIDIA/Megatron-LM/tree/e79cb4c1bae1afd04322d979d08cb63832991ebe/tests)

至此，教程从公式、源码、运行、测试、性能到集群和贡献形成完整闭环。
