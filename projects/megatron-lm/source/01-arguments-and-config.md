# 01. 参数与配置：从 CLI Namespace 到 `PretrainConfigContainer`

Megatron 的参数数量很大，但不应把 `arguments.py` 当作需要逐行背诵的字典。更好的理解方式是追踪四次转换：CLI 字符串 → Namespace → 派生/校验值 → 按职责拆分的 dataclass config。

## 第一层：解析输入

`parse_args()` 创建 parser，添加项目参数，再允许任务通过 `extra_args_provider` 扩展。随后读取：

```python
args.rank = int(os.getenv('RANK', '0'))
args.world_size = int(os.getenv('WORLD_SIZE', '1'))
```

rank/world 来自 launcher，而非普通 CLI；这避免用户手工给每个进程传不同参数。

若使用 YAML，解析结果会被 YAML 配置替换/补充，因此调试参数来源时要同时检查命令行和 `--yaml-cfg`。

## 第二层：校验与派生

`validate_args()` 不只是 `assert`，还计算大量派生量：

- DP size 与并行整除关系；
- virtual pipeline 与 layer layout；
- precision 和 dtype；
- batch size 与 microbatch calculator；
- attention heads、query groups、hidden/head dimension；
- MoE/EP/expert TP 兼容性；
- distributed optimizer、overlap 和 FSDP 限制。

所以最终 `args` 不是用户输入原样，而是“用户意图 + 环境事实 + 派生决策”。打印配置时应区分原始与派生字段。

## 第三层：Transformer 与模型配置

`gpt_config_from_args(args)` 先构造 `TransformerConfig`，再组合 `GPTModelConfig`。前者描述层内计算和并行策略，后者增加词表、序列长度、位置编码、embedding 共享等 GPT 外壳信息。

简化关系：

```text
Namespace
  -> TransformerConfig
  -> GPTModelConfig(transformer=..., vocab_size=..., ...)
```

它不是把所有 CLI 字段复制一遍，而是只保留模型构造真正需要的部分。

## 第四层：训练容器

`pretrain_cfg_container_from_args()` 把一大包 Namespace 拆成：

```text
PretrainConfigContainer
  ├─ train / validation
  ├─ model
  ├─ optimizer / scheduler
  ├─ ddp / dist / rng
  ├─ logger / profiling
  ├─ checkpoint / tokenizer
  └─ rerun / straggler
```

这种分层让 model builder 不必依赖 checkpoint 参数，让 checkpoint 代码也不必知道 attention 细节。

## Config 与运行时状态的区别

Config 应尽量是可验证、可序列化的意图；process group、CUDA stream、model instance、iterator 是运行时对象。`ProcessGroupCollection` 会在初始化后进入模型，不应假装成普通 CLI 字段。

## 全局 `get_args()` 的现实

旧训练路径大量使用 `get_args()` 读取全局 Namespace，例如 `pretrain_gpt.get_batch`。新结构化 config 正在减少这种耦合，但迁移是渐进的。阅读时区分：

- 任务/训练兼容层读取 global args；
- Core 生产模块优先接收 config 与显式 process group；
- 新代码不应无理由把全局依赖继续下沉。

## 参数分组法

面对启动脚本，可把参数分为：

1. launcher：节点、进程、master address；
2. 模型：layers、hidden、heads、FFN、position；
3. 并行：TP/PP/CP/EP/SP；
4. batch/优化：micro/global batch、LR、optimizer、precision；
5. 数据：tokenizer、data path、split、sequence；
6. 生命周期：train iters、eval、save/load；
7. 性能/诊断：overlap、recompute、profile、NaN checks。

先验算每组，再研究组间约束。

## 实验：追踪三个参数

选择：

```text
--tensor-model-parallel-size
--bf16
--global-batch-size
```

```bash
rg -n "tensor_model_parallel_size|global_batch_size|bf16" \
  megatron/training/arguments.py \
  megatron/training/argument_utils.py \
  megatron/core/model_parallel_config.py
```

对每个参数记录：parser 默认值、校验、派生字段、最终 config、首个运行时消费者。

## 自测

1. 为什么 rank/world 不作为普通模型参数传入？
2. `validate_args` 为什么会改变某些字段？
3. `TransformerConfig` 与 `GPTModelConfig` 的边界是什么？
4. `PretrainConfigContainer` 为什么按职责拆分？
5. global args 兼容层与 Core 新接口应怎样区分？

## 源码定位

- [arguments.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/training/arguments.py)
- [argument_utils.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/training/argument_utils.py)
- [TransformerConfig](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/transformer_config.py)
- [配置容器](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/training/config/container.py)

下一章进入初始化：设备、默认 group、模型并行 group 与随机数状态怎样建立。
