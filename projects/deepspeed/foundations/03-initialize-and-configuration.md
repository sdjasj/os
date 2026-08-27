# 03. `initialize()` 与配置系统：从字典到具体 Engine

DeepSpeed 的公共训练入口是 [`deepspeed.initialize()`](__init__.py)。它不只是给模型套一层 wrapper，而是完成分布式初始化、配置规范化、并行网格处理、Engine 选择、优化器和数据加载器构造。理解这一入口，后面看到任何功能分支都知道从哪里接入。

## 函数签名中的四类输入

`initialize()` 的参数可以分成四组：

| 类别 | 代表参数 | 作用 |
| --- | --- | --- |
| 用户计算对象 | `model`、`model_parameters` | 要包装的模块和待优化参数 |
| 可覆盖组件 | `optimizer`、`lr_scheduler` | 实例或 callable，优先于 JSON 中的定义 |
| 数据 | `training_data`、`collate_fn` | 可选地构造 DeepSpeedDataLoader |
| 运行时/拓扑 | `config`、`args`、`mpu`、`mesh_param`、`dist_init_required` | 配置、rank 和并行组 |

返回值固定为：

```python
engine, optimizer, training_dataloader, lr_scheduler
```

其中后三项也能从 `engine` 访问。返回四元组主要是兼容既有训练脚本和显式组件使用方式。

## 入口的实际决策链

当前提交中的主路径可概括为：

```text
initialize(args, model, ..., config)
  1. 暂停可能仍激活的 zero.Init context
  2. 选择 accelerator 的通信 backend
  3. dist.init_distributed(...)
  4. 合并 config / config_params / args.deepspeed_config
  5. 加载配置字典，处理 mesh / AutoTP
  6. DeepSpeedConfig(config, mpu, mesh_device)
  7. 根据模型与配置选择：
       PipelineModule  → PipelineEngine
       hybrid enabled  → DeepSpeedHybridEngine
       其他            → DeepSpeedEngine
  8. 恢复 zero.Init context
  9. 返回 Engine 及其组件
```

这里“先关再恢复 `zero.Init`”是为了防止 Engine 内部构造对象时意外继承用户模型初始化的参数分片上下文。

## 配置来源与优先级

推荐新代码直接给 `config` 传字典或路径。`config_params` 是兼容参数；`args.deepspeed_config` 适合 CLI 集成。源码明确禁止同时通过 `args` 和 `config` 提供两份配置，因为无法安全推断哪份优先。

```python
config = {
    "train_micro_batch_size_per_gpu": 2,
    "gradient_accumulation_steps": 8,
    "bf16": {"enabled": True},
    "optimizer": {
        "type": "AdamW",
        "params": {"lr": 2e-4, "betas": [0.9, 0.95]},
    },
    "zero_optimization": {
        "stage": 2,
        "overlap_comm": True,
        "contiguous_gradients": True,
    },
}
```

不要把 JSON 当作无模式字典。顶层 [`DeepSpeedConfig`](runtime/config.py) 调用多个嵌套配置模型：ZeRO、FP16/BF16、通信、监控、autotuning、pipeline、checkpoint、compile、tensor/expert parallel 等。嵌套模型使用类型、默认值、alias 和 validator 把字符串配置变成运行时契约。

## Batch 三元组如何推导

三个字段是：

- `train_batch_size`；
- `train_micro_batch_size_per_gpu`；
- `gradient_accumulation_steps`。

配置允许只给足够推导的子集。`_set_batch_related_parameters()` 补全缺失值，`_batch_assertion()` 最终强制：

\[
train\_batch = micro\_batch \times grad\_acc \times world\_size
\]

若只给 `train_batch_size`，默认 `gradient_accumulation_steps=1`，micro-batch 是全局 batch 除以 world size。若只给 micro-batch，则全局 batch 为 micro-batch 乘 world size、GAS 为 1。

这里的 `world_size` 会考虑 `mpu`、mesh 和 sequence parallel，而不一定等于全局进程数。配置错误常见的根因就是把不同并行组的 size 混用。

## 一个纯配置实验

[`tests/unit/runtime/test_ds_config_dict.py`](../tests/unit/runtime/test_ds_config_dict.py) 直接构造 `DeepSpeedConfig`，非常适合当作可执行规范。即使没有 GPU，也能阅读它如何测试三元组推导、路径/字典输入、错误组合和 API 兼容。

可以在已具备依赖的环境做最小检查：

```python
from deepspeed.runtime.config import DeepSpeedConfig

config = DeepSpeedConfig({
    "train_micro_batch_size_per_gpu": 3,
    "gradient_accumulation_steps": 5,
})

print(config.train_batch_size)
print(config.train_micro_batch_size_per_gpu)
print(config.gradient_accumulation_steps)
```

单进程时预期全局 batch 为 15；分布式初始化后的 world size 会改变结果。

## 顶层解析与嵌套模型的分工

`DeepSpeedConfig._initialize_params()` 是一张功能索引：

```text
param_dict
  ├─ get_zero_config                  → DeepSpeedZeroConfig
  ├─ get_float16_config               → precision settings
  ├─ DeepSpeedCommsConfig             → comm logging
  ├─ get_monitor_config               → tensorboard/wandb/csv/comet
  ├─ get_pipeline_config              → pipeline knobs
  ├─ get_checkpoint_config            → checkpoint behavior
  ├─ CompileConfig                    → DeepCompile passes
  └─ get_tensor/expert_parallel_config
```

读某个配置项时按三步走：

1. 找字段定义、默认值和 alias；
2. 找 Engine 中读取该属性的方法；
3. 找测试覆盖的合法和非法组合。

只搜索 JSON 字符串容易漏掉 alias；只看 Engine 又会漏掉 validator 已经保证的前置条件。

## Engine 选择不是运行时随意切换

`PipelineModule` 会直接选择 `PipelineEngine`，并要求 `mpu` 由模块自身提供；普通模型才根据 `hybrid_engine.enabled` 选择 Hybrid 或普通 Engine。也就是说，Pipeline 并不是普通 Engine 上一个晚期布尔开关，它有不同的训练入口和调度语义。

AutoTP/mesh 也在 Engine 构造前处理。配置中的 `sequence_parallel_size` 和 `data_parallel_size` 可以建立命名 mesh 维度，后续 `DeepSpeedConfig` 用相应 group 得到数据并行 world size。

## 优化器的三种提供方式

### JSON 定义

Engine 根据 `optimizer.type` 和 params 创建 FusedAdam、CPUAdam、Muon 等实现，再按 precision/ZeRO 包装。

### 传实例

```python
optimizer = torch.optim.AdamW(model.parameters(), lr=1e-4)
engine, *_ = deepspeed.initialize(
    model=model,
    optimizer=optimizer,
    config=config,
)
```

实例覆盖 JSON optimizer 定义，但 ZeRO-Offload 可能要求特定 CPU optimizer，否则性能差或按配置报错。

### 传 callable

callable 接收 `model_parameters`，适合必须在 DeepSpeed 确定参数组后再构造的优化器。阅读 `_configure_optimizer()` 时要分清 instance 与 callable 两条路径。

## 配置校验应尽早失败

典型互斥/约束包括：

- FP16 与 BF16 不能同时启用；
- batch 三元组必须一致且为正；
- ZeRO stage 不能超过最大 stage；
- 某些 gradient reduce op 不支持 ZeRO-3、ZenFlow 或特定 compile pass；
- offload parameter 只适用于 ZeRO-3；
- Pipeline、precision、optimizer wrapper 的组合有额外限制。

尽早校验的意义是让所有 rank 在进入 collective 前以相同原因失败。若只有某个 rank 进入下一步，其他 rank 很可能表现为“通信卡死”。

## 本章实验：为一个字段画垂直切片

选择 `managed_gradient_accumulation`：

```bash
rg -n 'managed_gradient_accumulation' deepspeed tests
```

记录：

1. 配置默认值在哪里定义；
2. `DeepSpeedConfig` 保存到哪个属性；
3. Engine 的 boundary 判定如何分支；
4. `backward()` 和 `step()` 谁负责 reduction；
5. 哪些测试覆盖 managed/unmanaged 模式。

再对 `zero_optimization.stage` 重复一次。完成后你会得到两张可复用的源码导航图。

## 常见误区

- 同时从 `args` 和 `config` 传配置，期待某种隐式覆盖。
- 把顶层 world size 当成 batch 公式里的 DP size。
- 认为 JSON 里的 optimizer 一定是最终 optimizer；它还会被 precision/ZeRO wrapper 包装。
- 看到默认值就忽略 validator；动态默认值可能依赖 stage。
- 用 PipelineModule 却继续套普通的 forward/backward/step 循环。

## 自测

1. `config_params` 为什么存在，推荐新代码用哪个参数？
2. 为什么 `initialize()` 要在 Engine 构造前建立分布式和 mesh？
3. 只给 micro-batch 时，GAS 和全局 batch 如何取值？
4. 用户传入 optimizer 实例后，DeepSpeed 是否完全不再包装它？
