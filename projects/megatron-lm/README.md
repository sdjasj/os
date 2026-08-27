# Megatron-LM 中文源码学习教程

本目录是基于 NVIDIA Megatron-LM 固定提交 `e79cb4c1bae1afd04322d979d08cb63832991ebe` 独立创作的中文教程，不是上游源码镜像，也不声称这些教程文件存在于上游提交。

## 学习轨道

- `foundations/`：5 章背景基础，从 GPT 张量到多维并行拓扑；
- `source/`：14 章源码主线，从 `pretrain_gpt.py` 到 checkpoint 恢复；
- `labs/`：5 章实践，从 dev 容器、mock data 到测试、性能与 SLURM。

建议顺序阅读。每章末尾包含源码定位、实验与自测。教程中的代码只摘录必要的小片段，实际行为以固定提交源码为准。

## 内容边界

本目录只包含教程 Markdown 与原样保留的上游许可证，不复制 Megatron-LM 源码、模型、checkpoint、数据集、日志、缓存、虚拟环境或构建产物。命令中的路径均为占位符或仓库相对路径；运行 GPU/集群命令前，应按本地硬件、调度器和权限进行复核。

`UPSTREAM_LICENSE` 只保留上游源码的许可证与第三方归属边界，不重新授权本教程内容。
