# 04. DeepSpeedEngine：一次 forward、backward、step 的完整生命周期

[`DeepSpeedEngine`](engine.py) 是训练主干。它继承 `torch.nn.Module`，对外仍呈现熟悉的调用方式，对内则协调精度、梯度累积、通信、优化器、scheduler、计时、监控和 checkpoint。本章沿一次普通训练循环逐步解释状态如何变化。

## Engine 构造出的关键对象

构造函数保存并派生几类状态：

| 类别 | 代表字段 | 作用 |
| --- | --- | --- |
| 用户对象 | `module`、`client_optimizer`、`training_data` | 原始模型和可选组件 |
| 拓扑 | `global_rank`、`local_rank`、DP/MP groups | 决定设备和 collective 范围 |
| 配置 | `_config` | 已验证的 DeepSpeedConfig |
| 训练计数 | `micro_steps`、`global_steps`、`global_samples` | 区分 micro-step 与 update |
| 优化 | `basic_optimizer`、`optimizer`、`lr_scheduler` | 原始优化器与最终 wrapper |
| 运行时服务 | `monitor`、`timers`、`checkpoint_engine` | 观察和持久化 |

`basic_optimizer` 与 `optimizer` 不一定相同。例如 basic optimizer 是 AdamW，最终 optimizer 可能是 `DeepSpeedZeroOptimizer`，后者内部持有并驱动 basic optimizer。

## Forward：不仅是调用用户模型

用户执行：

```python
loss = engine(features, labels)
```

因为 Engine 是 Module，最终进入 `forward()`。主线工作包括：

1. 开始 forward timer 和吞吐计时；
2. 必要时启动 flops profiler；
3. 在 torch autocast 配置下进入相应上下文；
4. 调用 `self.module(*inputs, **kwargs)`；
5. 记录 loss/计时并结束 profiler 区间。

ZeRO-3 参数 gather 主要由模块 hook/参数协调器围绕具体子模块触发，不需要 `forward()` 手写每个 layer 的 all-gather。这是“Engine 编排 + module hook 执行参数生命周期”的分工。

## Backward：loss 缩放与梯度处理的入口

推荐调用：

```python
engine.backward(loss)
```

当前实现先验证 optimizer 和标量 loss，再处理两种缩放：

- 梯度累积语义：返回值可按 GAS 缩放；
- 混合精度语义：ZeRO/GradScaler/Apex 对真正反向的 loss 做必要缩放。

主调用近似是：

```text
backward(loss)
  → 记录当前 accumulation boundary
  → precision-specific loss scaling
  → loss.backward()
       → autograd 逐参数产出梯度
       → ZeRO / reduction hooks 处理 ready gradient
  → _backward_epilogue()
```

`_backward_epilogue()` 会在适当模式下完成剩余梯度 reduction、计时和状态清理。ZeRO-2/3 的关键动作可能已经在参数梯度 ready 时发生，epilogue 负责收尾而不是从零开始。

## 新的 PyTorch-style backward 边界

当前提交支持调用方直接 `.backward()`，但混合精度下不能绕过 loss scaling。Engine 为此提供：

```python
scaled_loss = engine.scale(loss)
scaled_loss.backward()
engine.step()
```

若配置要求 scaler，而用户直接 `loss.backward()`，backward post-hook 会给出明确错误。Apex AMP 仍要求使用 `engine.backward(loss)`，因为其 scale context 不能拆开。

初学时坚持 `engine.backward(loss)`；只有需要自定义 autograd 控制时再使用 `engine.scale()` 路径。

## 梯度累积边界

默认 managed 模式的判定是：

\[
(micro\_steps + 1) \bmod GAS = 0
\]

GAS=4 时：

| 循环序号 | `micro_steps` 进入 step 前 | 是否边界 | optimizer update |
| ---: | ---: | --- | --- |
| 1 | 0 | 否 | 否 |
| 2 | 1 | 否 | 否 |
| 3 | 2 | 否 | 否 |
| 4 | 3 | 是 | 是 |
| 5 | 4 | 否 | 否 |

`set_gradient_accumulation_boundary()` 可以手工覆盖，但调用方必须保证最后一次 forward/backward 标为 true，并理解 optimizer hook 也会收到边界状态。它不是普通训练的首选 API。

`managed_gradient_accumulation=false` 时，调用方通过“何时调用 `step()`”拥有边界。Stage 0/1/DDP 可在 step 内 reduction；Stage 2/3 则完成其分片 reduction 的 finalize。

## Step：为什么调用了也可能不更新

`engine.step()` 的主线是：

```text
step()
  → 检查 no_sync / optimizer
  → unmanaged 模式完成 reduction/finalize
  → 判断 accumulation boundary
      否：只更新计时和 micro_steps
      是：
        → checkpoint decoupled commit（若启用）
        → gradient clipping
        → optimizer.step()
        → overflow? 跳过 scheduler : scheduler.step()
        → zero_grad()
        → 更新 global_steps/global_samples
  → monitor / profiler / timer
  → micro_steps += 1
```

即使到达边界，FP16 overflow 也可能让权重更新被跳过，并增加 `skipped_steps`。scheduler 只应在实际 update 后推进，否则学习率与权重更新次数会错位。

## `_take_model_step()` 的顺序为何重要

简化后的顺序是：

1. 需要时先 unscale，再做 gradient clipping；
2. 调用 GradScaler 或 optimizer 的 `step()`；
3. 读取 global grad norm；
4. 清理梯度；
5. 检查 overflow；
6. 未 overflow 才推进 compression scheduler 和 LR scheduler；
7. 更新 step/sample 计数。

若在 scaled gradient 上直接 clipping，阈值语义会错误；若 overflow 后仍推进 scheduler，训练时间轴会错误；若先清空再读取 grad norm，监控会丢失。源码中的顺序就是这些数值契约的落点。

## 普通梯度 reduction 路径

非 ZeRO 或 fallback 路径会：

1. 按 dtype 和 sparse/dense 分类梯度；
2. flatten 成 bucket；
3. 必要时转成配置的通信 dtype；
4. 在 DP group 上 All-Reduce；
5. 按 average/predivide 规则缩放；
6. unflatten 并复制回每个梯度。

Engine 还单独处理 expert parameter group：普通参数在常规 DP group reduction，专家参数在 expert data-parallel group reduction。collective 的 group 与 op 同样重要。

## `no_sync` 为什么有边界

`engine.no_sync()` 禁用 backward 中的梯度 reduction，但源码明确限制：

- 与 ZeRO-2/3 的梯度分片不兼容；
- context 内禁止 `engine.step()`；
- context 内不推进正常的 accumulation tracking；
- 不支持嵌套。

原因不是保守限制，而是 Stage 2/3 将 reduction 作为最终梯度布局的一部分。跳过它后，optimizer 不再拥有预期 partition。

当前实现另有 `coalesce_grad_reduction()`，用于 ZeRO-1/2/3 在一个 block 内本地累积多次 backward，退出时集中完成一次 reduction。它有严格限制，不应与普通 GAS、Pipeline 或其他 optimizer wrapper 随意组合。

## 计数器应怎样解释

- `micro_steps`：每次 Engine step 调用后的 micro-step 计数；
- `global_steps`：真正进入模型更新边界的次数；
- `global_samples`：按 managed/unmanaged 语义累计的样本；
- `skipped_steps`：因 overflow 等原因没有应用 update 的次数；
- `_step_applied`：本次 step 是否实际应用。

记录性能和收敛曲线时应明确横轴是哪一个。把 micro-step 当 global step 会把 warmup、吞吐和 loss 曲线全部解释错。

## 本章实验：打印八个 micro-step

在最小训练程序中加入：

```python
for index in range(8):
    loss = engine(features, targets)
    engine.backward(loss)
    print(
        index,
        engine.micro_steps,
        engine.is_gradient_accumulation_boundary(),
        engine.global_steps,
    )
    engine.step()
```

用 `GAS=4` 预测每行，再运行验证。然后把 scheduler 加入配置，确认它只在 update 边界推进。

静态环境可直接检查：

```bash
rg -n '^    def (forward|backward|step|_take_model_step|is_gradient_accumulation_boundary)' \
  deepspeed/runtime/engine.py
rg -n 'skipped_steps|global_steps|micro_steps|global_samples' \
  deepspeed/runtime/engine.py
```

## 常见误区

- 每个循环都调用 `step()`，就认为每次都更新权重。
- 在混合精度下直接 `loss.backward()`，忽略 Engine scaler 协议。
- 把 basic optimizer 当成最终 optimizer 调试。
- 在 ZeRO-2/3 上照搬 DDP 的 `no_sync` 用法。
- scheduler 按 dataloader batch 推进，而训练按 accumulation boundary 更新。
- 只记录 `nvidia-smi`，不按 forward/backward/step 阶段定位峰值。

## 自测

1. `basic_optimizer` 和 `optimizer` 为什么要同时存在？
2. overflow 时哪些计数或组件应推进，哪些不应推进？
3. ZeRO-3 的参数 gather 为什么主要不写在 Engine.forward 的逐层循环里？
4. managed 与 unmanaged accumulation 的边界所有权有何区别？
