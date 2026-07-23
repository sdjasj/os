# MiniMind Agentic RL 专题教程

本目录专门拆解 MiniMind 的多轮 Tool-Use Agentic RL。目标不是只会运行 `train_agent.py`，而是能从一条 JSONL 样本开始，逐 token 解释轨迹怎样生成、哪些 token 产生梯度、奖励如何构成、GRPO/CISPO 如何更新策略，以及本地 PyTorch 与 SGLang rollout 如何切换。

## 学习顺序

| 顺序 | 模块 | 核心问题 |
|---|---|---|
| 0 | [全局心智模型](00-mental-model.md) | Agentic RL 比普通 SFT/GRPO 多了什么？ |
| 1 | [数据与 Chat Template](01-data-and-template.md) | `messages/tools/gt` 如何变成模型状态？ |
| 2 | [工具协议与执行环境](02-tools-and-environment.md) | 调用怎样解析、校验、执行和回填？ |
| 3 | [Rollout Engine](03-rollout-engine.md) | 生成结果和 old log-prob 从哪里来？ |
| 4 | [多轮轨迹展开](04-multi-turn-rollout.md) | `rollout_single` 如何形成 action/observation 序列？ |
| 5 | [奖励函数](05-reward-design.md) | 格式、工具、GT、RM 和惩罚如何组合？ |
| 6 | [Token 对齐与 Mask](06-token-alignment.md) | 为什么最容易出错的是 `L` 与 `L-1` 对齐？ |
| 7 | [GRPO/CISPO 策略更新](07-policy-loss.md) | reward 如何变成每个 action token 的梯度？ |
| 8 | [训练工程与 SGLang](08-training-and-sglang.md) | 如何启动、同步、续训和监控？ |
| 9 | [调试、评测与扩展](09-debugging-and-extension.md) | 如何发现 reward hacking、错位和无效训练？ |
| 10 | [实践练习](10-exercises.md) | 如何由小实验逐步改造成自己的 Agent？ |

## 对应源码

| 职责 | 文件 |
|---|---|
| 数据读取 | `dataset/lm_dataset.py:226-252` |
| 工具、rollout、reward、policy update | `trainer/train_agent.py` |
| 本地/SGLang rollout 后端 | `trainer/rollout_engine.py` |
| Chat Template | `model/tokenizer_config.json` |
| 推理期多轮 Tool Call | `scripts/eval_toolcall.py:177-199` |
| 模型与 token loss | `model/model_minimind.py` |

## 环境约定

```bash
cd /path/to/minimind
conda activate deepspeed
```

当前专题中的静态模板、Dataset、假 rollout、reward、token mask、DPO/GRPO 数值和 CUDA 模型实验均按该环境设计。正式 Agent RL 还需要：

- 与结构一致的 `out/full_sft_768.pth`；
- `dataset/agent_rl.jsonl` 或自定义数据；
- 默认配置下的外部 Reward Model；
- 足够显存；使用 SGLang 时还需要独立服务和共享模型目录。

## 学习方法

每读一个函数都画出四条并行时间线：

```text
文本:    prompt | model action | tool observation | model action
token:   p...p  | a...a        | o...o            | a...a
mask:    0...0  | 1...1        | 0...0            | 1...1
old_logp:   -   | lp...lp      | 0...0            | lp...lp
```

如果这四条线无法逐位置对齐，不要开始训练。Agentic RL 中大量“loss 能下降但能力没提升”的问题，本质是轨迹或奖励语义错位。

## 与主教程的关系

建议先读主教程的 [Tokenizer 与数据](../02-tokenizer-and-data.md)、[策略优化](../07-policy-optimization.md) 和 [Agent 概览](../08-agent-and-tools.md)。本专题不重复完整 Transformer 原理，而是深挖 Agentic RL 实现。
