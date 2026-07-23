# MiniMind 源码学习教程

这套教程面向“会 Python，但尚未完整训练过语言模型”的读者。目标不是只跑通命令，而是能够沿着真实源码回答下面这些问题：

- 文本如何变成 token，聊天模板又如何变成训练标签？
- 一个 token 如何经过 Embedding、Attention、MLP，最终变成下一个 token 的概率？
- Pretrain 与 SFT 为什么都用交叉熵，却能学出不同能力？
- LoRA、知识蒸馏、DPO、PPO、GRPO/CISPO 分别在优化什么？
- Tool Calling 为什么既是模板问题，也是数据、推理循环和奖励设计问题？
- 单卡训练、DDP、混合精度、梯度累积和断点续训在代码里如何衔接？

教程基于当前仓库代码编写。代码行号用于帮助第一次定位；如果项目以后更新，应以类名、函数名和实际实现为准。

## 推荐顺序

| 阶段 | 模块 | 学完后应能做到 |
|---|---|---|
| 0 | [学习路线与项目地图](00-learning-path.md) | 说清项目完整数据流，搭建可阅读源码的环境 |
| 1 | [必要背景：PyTorch 与自回归语言模型](01-foundations.md) | 看懂张量形状、梯度、交叉熵和训练循环 |
| 2 | [Tokenizer、Chat Template 与数据集](02-tokenizer-and-data.md) | 手工检查 token、模板文本和 loss mask |
| 3 | [Dense Transformer 模型](03-transformer-model.md) | 从输入追踪到 logits，理解 GQA、RoPE、KV Cache |
| 4 | [MoE 模型](04-moe.md) | 理解路由、Top-K 专家和负载均衡辅助损失 |
| 5 | [预训练、SFT 与训练工程](05-pretrain-sft.md) | 跑通最小训练，解释训练脚本每个关键步骤 |
| 6 | [LoRA、蒸馏与 DPO](06-efficient-and-preference.md) | 比较三种后训练方法的目标、数据和资源开销 |
| 7 | [PPO、GRPO 与 CISPO](07-policy-optimization.md) | 看懂 rollout、reward、advantage、KL 和策略损失 |
| 8 | [Tool Calling 与 Agentic RL](08-agent-and-tools.md) / [Agentic RL 专题](agentic-rl/README.md) | 追踪一次多轮工具轨迹及其 mask、reward、更新过程 |
| 9 | [生成、评测、转换与服务](09-inference-and-serving.md) | 理解采样和缓存，使用 CLI/API 并转换模型格式 |
| 10 | [实验手册与排错](10-experiments-and-debugging.md) | 用低成本实验验证理解，系统定位常见错误 |
| 附录 | [公式与术语速查](11-glossary.md) | 快速查阅符号、形状和方法对比 |

## 两条学习路径

**理解优先（推荐）**：`00 -> 01 -> 02 -> 03 -> 05 -> 04 -> 06 -> 07 -> 08 -> 09 -> 10`。

**实践优先**：先读 `00` 和 `02`，用公开权重完成 `09` 的推理实验，再回到 `01 -> 03 -> 05`。这种方式反馈更快，但不要跳过标签 mask 和因果位移两个知识点。

## 使用约定

1. 所有 shell 命令默认从仓库根目录 `/path/to/minimind` 开始。
2. 本机运行教程命令前先执行 `conda activate deepspeed`；本教程已在该环境的 Python 3.10、PyTorch 2.5.1、Transformers 4.57.3 和 CUDA 设备上完成核心运行时验证。
3. 训练脚本的默认相对路径按 `trainer/` 作为工作目录设计，所以教程使用 `(cd trainer && python ...)`，避免当前目录混乱。
4. 下载数据和权重不是阅读源码的前提。没有 GPU 时仍可完成 tokenizer、数据样本、模型前向和大部分静态实验。
5. 真正训练前先用 mini 数据、短序列、小模型和少量 step 验证链路，不要一开始就运行完整配置。
6. `tokenizer_config.json` 宣称的 `model_max_length=131072` 不等于模型已经通过训练获得 131072 token 的有效长上下文能力。

## 建议的学习记录

每个模块都建一页笔记，并固定记录四项：

- **输入/输出**：函数接收和返回什么，张量形状是什么。
- **可训练参数**：哪些参数参与反向传播。
- **目标函数**：loss 在鼓励什么、约束什么。
- **验证实验**：如何用打印、断言或极小样本证明自己的理解。

不要把“脚本成功退出”当作理解完成。能预测某行代码修改后 loss、显存、速度或输出会怎样变化，才算真正掌握。
