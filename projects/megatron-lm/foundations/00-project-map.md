# 00. 项目全景与学习路线：先追踪一次迭代

Megatron-LM 的难点不在某个 Transformer 公式，而在于同一份计算会同时被数据、张量、流水线、上下文和专家等维度切开。若按目录逐个文件阅读，很容易记住大量类名，却不知道一个 batch 怎样穿过系统。本教程采用一条稳定主线：先追踪一次 GPT 预训练迭代，再逐次打开数据、模型、通信和工程黑盒。

## 两个层次

根 README 把项目分为：

- **Megatron-LM**：参考训练框架，负责参数、初始化、数据、循环、checkpoint 和可启动脚本；
- **Megatron Core**：可组合库，负责模型层、并行算子、分布式封装、优化器、数据集和推理组件。

所以 `pretrain_gpt.py` 不是 GPT 模型主体，而是把训练框架与 Core 粘合起来的任务入口。模型在 `megatron/core/models/` 与 `megatron/core/transformer/`，训练编排主要在 `megatron/training/`。

## 固定学习快照

```text
repository: https://github.com/NVIDIA/Megatron-LM
commit:     e79cb4c1bae1afd04322d979d08cb63832991ebe
date:       2026-08-27
subject:    Gtp refit support (#6133)
```

固定提交能避免源码链接随 `main` 漂移。当前快照中的 `GPTModel` 已发出弃用警告并推荐 `HybridModel`；不过 `pretrain_gpt.py` 仍是一条成熟、完整、适合教学的训练主链。教程先讲清这条主链，再说明如何把心智模型迁移到 hybrid 入口。

## 一次迭代的最小地图

```text
torch.distributed.run
  -> pretrain_gpt.py::__main__
     -> parse_and_validate_args()
     -> PretrainConfigContainer
     -> training.pretrain()
        -> initialize_megatron()
        -> setup_model_and_optimizer()
        -> build data iterators
        -> train()
           -> train_step()
              -> pipeline schedule
                 -> pretrain_gpt.forward_step()
                    -> get_batch()
                    -> GPTModel.forward()
                       -> embedding
                       -> TransformerBlock / TransformerLayer
                       -> output projection + vocab-parallel loss
              -> finalize gradients
              -> optimizer.step()
           -> log / evaluate / checkpoint
```

读任何文件时，都问它位于图中哪条边。无法放入主链的功能先标为“扩展路径”，不要立即深挖。

## 三条轨道与 24 章

1. **背景基础（5 章）**：GPT 形状、PyTorch 分布式、GPU 性能、并行拓扑。
2. **源码主线（14 章）**：入口、配置、初始化、数据、模型、层规格、Attention、MoE、TP、PP、CP、DDP、训练循环、checkpoint。
3. **动手实践（5 章）**：容器与 mock-data、rank/shape 推演、测试、性能诊断、SLURM 与贡献路线。

## 目录职责与首读文件

| 区域 | 职责 | 首读文件 |
| --- | --- | --- |
| 根脚本 | 组装训练任务 | `pretrain_gpt.py` |
| `megatron/training/` | 初始化、循环、参数、checkpoint | `training.py` |
| `megatron/core/models/` | 模型外壳 | `models/gpt/gpt_model.py` |
| `megatron/core/transformer/` | Layer、Attention、MLP、MoE、规格 | `transformer_layer.py` |
| `tensor_parallel/` | 列/行并行和可微通信 | `layers.py`、`mappings.py` |
| `pipeline_parallel/` | microbatch 调度、P2P | `schedules.py` |
| `distributed/` | DDP/FSDP、梯度 buffer | `distributed_data_parallel.py` |
| `datasets/` | indexed dataset、混合、索引 | `gpt_dataset.py` |
| `tests/` | 单元、功能、性能、CI recipe | `test_utils/recipes/` |

## 四遍读码法

### 第一遍：只画控制流

```bash
rg -n "^def (forward_step|train_valid_test_datasets_provider)" pretrain_gpt.py
rg -n "^def (pretrain|train|train_step)" megatron/training/training.py
rg -n "^    def forward" megatron/core/models/gpt/gpt_model.py
```

目标是用十个箭头复述一次迭代，不展开 CUDA 细节。

### 第二遍：标张量形状

```text
tokens / labels       [batch, sequence]
hidden_states         [sequence, batch, hidden]
q, k, v               [sequence, batch, heads, head_dim]
losses                [batch, sequence]
```

每次变化写清“哪一维、为什么、是否通信”。

### 第三遍：标 collective 与 group

同一个 `all_reduce` 用 TP group 和 DP group 时语义完全不同。统一记录：

```text
collective + process group + tensor shape + forward/backward phase
```

### 第四遍：加入失败与性能

最后研究 OOM、NCCL timeout、梯度同步重叠、重计算、异步 checkpoint。它们都应回落到前三遍的控制流、形状和 group。

## 三个贯穿账本

- **形状账本**：全局形状与本 rank 局部形状；
- **所有权账本**：参数、激活、梯度、优化器状态由谁完整或分片持有；
- **通信账本**：collective 的组、字节量、时机和依赖。

三张表闭合后，“为什么结果错”“为什么 OOM”“为什么扩展效率低”才有可检验答案。

## 实验：制作调用链卡片

```bash
rg -n "if __name__ == .__main__." pretrain_gpt.py
rg -n "^def pretrain|^def train_step|^def train\(" megatron/training/training.py
rg -n "^def get_forward_backward_func" megatron/core/pipeline_parallel/schedules.py
```

为每个节点只写输入、输出、是否通信。暂时不进入实现。

## 自测

1. Megatron-LM 与 Megatron Core 的职责差异是什么？
2. 为什么 `pretrain_gpt.py` 不是模型主体？
3. 三个账本分别解决什么问题？
4. 为什么当前仍值得从 GPT 主链学习，又不能忽略 Hybrid 迁移？

## 源码定位

- [项目 README](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/README.md)
- [GPT 训练入口](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/pretrain_gpt.py)
- [训练编排](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/training/training.py)
- [Hybrid 迁移指南](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/docs/user-guide/hybrid-model-migration.md)

下一章从 token、因果语言模型损失和形状开始。
