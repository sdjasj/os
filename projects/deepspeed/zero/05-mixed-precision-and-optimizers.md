# 05. 混合精度与优化器包装：dtype、loss scale 和 master state

DeepSpeed 的“混合精度”不是只把模型 `.half()`。它同时决定模型参数 dtype、梯度累积 dtype、通信 dtype、loss scaling、master weights、optimizer state 和 fused kernel 路径。读源码时必须把这些状态分开，否则很容易把数值问题误判成通信或 ZeRO 问题。

## FP16 与 BF16 的数值差别

| dtype | 指数位 | 尾数位 | 主要特性 |
| --- | ---: | ---: | --- |
| FP32 | 8 | 23 | 范围和精度都高，显存/带宽成本高 |
| FP16 | 5 | 10 | 精度较高但范围窄，容易 underflow/overflow |
| BF16 | 8 | 7 | 范围接近 FP32，精度较低，通常不需要 loss scaling |

反向传播中的小梯度可能低于 FP16 可表示范围而变成 0。loss scaling 将 loss 乘以 (S)，使梯度也乘以 (S)，优化前再除回去：

\[
\nabla(SL)=S\nabla L,
\qquad g=\frac{\nabla(SL)}{S}
\]

只要中间没有 overflow，这个变换不改变数学结果。

## 静态与动态 loss scale

[`runtime/fp16/loss_scaler.py`](loss_scaler.py) 定义缩放器的核心状态。静态 scale 固定 (S)，简单但需要人工选择；动态 scale 根据 overflow 调整：

```text
连续若干步没有 overflow → scale 乘 2
检测到 inf/nan          → 跳过 update，scale 除 2
```

配置示例：

```json
{
  "fp16": {
    "enabled": true,
    "loss_scale": 0,
    "initial_scale_power": 16,
    "loss_scale_window": 1000,
    "hysteresis": 2,
    "min_loss_scale": 1
  }
}
```

`loss_scale=0` 表示动态缩放。`initial_scale_power=16` 对应初始 (2^{16})。window 太短会频繁放大又回退，太长则可能在过小 scale 上停留很久。

## Engine 如何决定 precision wrapper

`DeepSpeedEngine.get_data_types()` 先得出：

- `model_dtype`：由 FP16/BF16 enabled 决定；
- `grad_accum_dtype`：显式 `data_types.grad_accum_dtype`，否则跟随模型 dtype。

随后 `_do_optimizer_sanity_check()` 根据 precision、ZeRO、Pipeline 和 optimizer 类型选择最终包装：

```text
ZeRO enabled        → ZeRO optimizer（内部处理 precision）
Apex AMP            → amp.initialize
FP16                → FP16 optimizer wrapper
BF16 某些路径       → BF16 optimizer wrapper
纯 FP32             → basic optimizer
```

这说明配置顺序不是“先 FP16 wrapper，再随便套 ZeRO”。ZeRO 是顶层 optimizer protocol，内部再处理低精度参数、master partition 和 overflow。

## 参数 dtype、buffer dtype 和通信 dtype

当前 Engine 把参数与 buffer 的转换分开：

- `data_types.param_dtype` 若设置，必须与启用的 FP16/BF16 模式一致；
- `data_types.buffer_dtype` 可以单独控制浮点 buffer；
- `communication_data_type` 可以覆盖梯度 collective 使用的 dtype；
- `grad_accum_dtype` 控制累积精度。

Module buffer（例如 BatchNorm running stats）不参与 ZeRO 参数分片。把模型参数转换为低精度，不应未经选择地改变所有 buffer。

通信 dtype 低于梯度累积 dtype 时，会在 All-Reduce/Reduce-Scatter 前转换、完成后再复制回来。它减少带宽，但引入额外转换和舍入误差。

## 为什么常有 FP32 master weight

假设 FP16 参数 (w_{16}) 的一个更新量小于其当前量级的最小可分辨间隔，直接执行：

\[
w_{16}\leftarrow w_{16}-\eta g
\]

更新可能被舍入掉。常见做法是维护 (w_{32})：

```text
FP16/BF16 参数参与 forward/backward
  → 梯度转/累积到更新路径
  → FP32 master parameter + FP32 moments 执行 optimizer step
  → 更新后的权重复制/转换回低精度参数
```

这正是“模型是 FP16，为何 optimizer state 仍很大”的原因。ZeRO-1 首先分片的主要就是这些 optimizer/master states。

## 优化器构造的两层结构

Engine 中的 `_configure_optimizer()` 先产生 `basic_optimizer`：

```text
JSON / 用户实例 / callable
  → FusedAdam、DeepSpeedCPUAdam、DeepSpeedCPULion、Muon、torch optimizer...
```

再根据 precision/ZeRO 得到最终 `self.optimizer`。所以调试状态字典时要问：

- 参数组属于 basic optimizer 还是 wrapper；
- wrapper 是否 flatten/partition 了参数；
- state 是按原参数名、flat group 还是 partition 保存；
- `optimizer.step()` 最终在哪一层被调用。

## FusedAdam 与 CPUAdam 的定位

### FusedAdam

融合多个逐 tensor/逐元素更新，减少 Python 调用和 kernel launch。它仍在 accelerator 上更新；是否可用取决于本地 op 构建。

### DeepSpeedCPUAdam

面向 ZeRO-Offload，在 CPU 上更新 optimizer state，并优化主机端向量计算与参数拷贝。Engine 检测到 optimizer offload 时会优先选择 CPUAdam；用户强行传普通 optimizer 可能被拒绝或收到性能警告。

### Torch optimizer

配置中可选择 torch Adam 路径，减少扩展依赖，适合功能验证。性能、内存布局和某些 offload 能力不一定等价于 fused 实现。

选择原则是先匹配状态位置和硬件，再谈单 kernel 速度。

## BF16 为什么仍可能有数值问题

BF16 的指数范围大，通常无需 loss scaling，但只有 7 位尾数：

- 小更新可能在参数量级上被舍入；
- 大量 micro-batch 直接用 BF16 梯度累积会积累误差；
- optimizer moments 的 dtype 会影响长期动态；
- reduction 顺序变化会产生不可结合的浮点差异。

因此“BF16 不 overflow”不等于“BF16 所有状态都足够准确”。`grad_accum_dtype`、master weights 和 optimizer state dtype 仍要根据收敛证据选择。

## Autocast 与原生低精度模式

两条思路不要混淆：

1. FP16/BF16 enabled：模型参数和 optimizer wrapper 按 DeepSpeed 低精度路径组织；
2. `torch_autocast`：在算子级根据 autocast policy 选择计算 dtype，并用 GradScaler 协调 stage 0 路径。

Engine 的 backward 和 step 对 `torch_autocast_z0_gradscaler` 有专门分支：step 前 unscale 以便 clipping，调用 scaler.step/update，再检查实际是否应用。

## 一个配置对照实验

准备三个最小配置，只改 precision：

```json
{"train_batch_size": 2}
```

```json
{"train_batch_size": 2, "fp16": {"enabled": true, "loss_scale": 0}}
```

```json
{"train_batch_size": 2, "bf16": {"enabled": true}}
```

在支持相应 dtype 的设备上记录：

- `next(engine.module.parameters()).dtype`；
- `type(engine.basic_optimizer)` 与 `type(engine.optimizer)`；
- 是否存在 loss scale；
- 一次 step 后 `skipped_steps`；
- 峰值显存。

不要在不支持 BF16 的硬件上硬跑；先用 `get_accelerator().supported_dtypes()` 检查。

## 源码实验：追踪 overflow

```bash
rg -n 'class (LossScaler|DynamicLossScaler)' deepspeed/runtime/fp16
rg -n 'overflow|cur_scale|loss_scale' \
  deepspeed/runtime/fp16 deepspeed/runtime/zero deepspeed/runtime/engine.py
rg -n '_configure_fp16_optimizer|_configure_bf16_optimizer' \
  deepspeed/runtime/engine.py
```

画出：检测 inf/nan → 标记 overflow → 跳过 basic optimizer update → 降低 scale → 不推进 scheduler 的链路。

## 常见误区

- 只检查模型参数 dtype，不检查 master/optimizer/gradient dtype。
- 把 BF16 当作“和 FP32 一样稳定且一样精确”。
- overflow 后仍按 micro-step 推进外部 scheduler。
- 开启低精度通信后，认为只有速度变化没有数值变化。
- 为了避免 JIT 随意换普通 optimizer，却仍期待 CPU offload 性能。
- 同时启用互斥的 FP16、BF16 或 AMP 路径。

## 自测

1. loss scaling 为什么能缓解 underflow，却不能挽救已经 overflow 的 step？
2. 模型权重只有 2 字节/元素时，为什么 Adam 仍可能需要约 16 字节/参数的总状态？
3. `basic_optimizer` 与最终 `optimizer` 的职责有何不同？
4. BF16 通常不用 loss scaling，为什么仍值得使用 FP32 累积或 master state？
