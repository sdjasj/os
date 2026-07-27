# verl 源码学习与 CyberGym-E2E Agentic RL 教程

这是一套面向“先读懂，再改造，最后跑通实验”的中文教程。它以 verl 提交
`983cb0f24443f87b3d161fad318445130a620b07` 为源码语境，以 CyberGym-E2E 提交
`b861317f11641b14ab6ba08b5179d0b044601057` 为隔离评测环境语境，重点回答：

- verl 怎样把数据、SGLang rollout、reward、GRPO 优势和 FSDP actor 更新串起来；
- 多轮工具轨迹中，哪些 token 真正参与策略梯度；
- CyberGym-E2E 的四阶段验证怎样变成抗 reward hacking 的标量奖励；
- 怎样在不把真实漏洞材料写入训练仓库的前提下接入授权沙箱；
- 训练慢、reward 全相同、容器泄漏和 tokenization mismatch 时如何定位。

## 学习顺序

| 阶段 | 章节 | 目标 |
| --- | --- | --- |
| 建立数学与系统地图 | 00–02 | 理解 GRPO、Ray/FSDP/SGLang 分工和一次训练 step |
| 读懂 verl 扩展点 | 03–06 | 掌握数据契约、SGLang、Agent Loop、Reward Loop |
| 接入 CyberGym-E2E | 07–10 | 设计授权沙箱桥、工具、数据和四阶段 reward |
| 跑通并验证 | 11–12 | 启动训练、观测指标、排错并完成课程项目 |

建议按编号阅读。已经熟悉 PPO/GRPO 的读者可以先看 00 的自测，再跳到 02；已经跑过
verl 数学任务但没做过 Agentic RL 的读者可以从 04 开始。

## 两条必须记住的边界

第一，CyberGym 的四个 validation stage 是一次轨迹结束后的四个可观测结果，不等于四次
policy update。本文先把它们门控、加权成单个 outcome reward，再交给标准 GRPO。

第二，教程只描述获授权、隔离环境中的接口和训练工程。示例使用
`demo-project/authorized-task` 这样的占位任务，不携带漏洞语料、PoC、补丁、flag、真实目标地址或
数据集内容。你需要自行准备有权使用的任务 allowlist 和镜像。

## 运行环境约定

命令中的路径统一使用以下占位符：

```text
/path/to/verl                 # 本教程对应的 verl checkout
/path/to/cybergym-e2e        # CyberGym-E2E checkout
/path/to/cybergym-bridge     # 你实现的隔离桥接服务
/models/tool-capable-model   # 支持目标工具格式的本地模型
```

教程不会要求把模型、数据、容器输出或凭据放入本站仓库。

## 快速导航

- [00 学习路线与最小闭环](./00-learning-roadmap.md)
- [01 RL、PPO 与 GRPO 背景](./01-rl-grpo-foundations.md)
- [02 verl 架构与一次训练 step](./02-verl-architecture.md)
- [03 配置、数据与 DataProto](./03-config-data-contracts.md)
- [04 SGLang rollout 与权重同步](./04-sglang-rollout.md)
- [05 Agent Loop、工具和 token mask](./05-agent-loop-tools.md)
- [06 Reward Loop 与自定义评分](./06-reward-loop.md)
- [07 CyberGym-E2E 四阶段评测](./07-cybergym-e2e-model.md)
- [08 隔离桥与 workspace 工具](./08-cybergym-bridge-tool.md)
- [09 训练数据与工具配置](./09-dataset-and-tool-config.md)
- [10 多阶段 reward 实现](./10-multistage-reward.md)
- [11 完整 GRPO + SGLang 启动配置](./11-training-launch.md)
- [12 性能、排错、评测与结课项目](./12-debugging-capstone.md)

## 源码与许可说明

正文是基于固定源码快照独立编写的学习材料，不声称这些教程文件存在于两个上游提交。
verl 与 CyberGym-E2E 的上游源码均声明 Apache License 2.0；教程中的路径用于源码定位，
不重新授权上游代码或用户自行准备的任务数据。
