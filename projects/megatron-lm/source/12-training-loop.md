# 12. 训练循环：`pretrain`、`train` 与 `train_step`

前面各章解释了局部组件，本章把它们拼回生命周期。三个函数层级分别拥有不同时间尺度：`pretrain` 管一次进程运行，`train` 管多次 iteration，`train_step` 管一个 global batch 的 forward/backward/update。

## `pretrain()`：进程级生命周期

简化顺序：

```text
initialize Megatron and global services
build ProcessGroupCollection
setup model + DDP/FSDP + optimizer + scheduler
load checkpoint if requested
build train/valid/test iterators
optional initial evaluation
train loop
final evaluation / checkpoint / cleanup
```

它还处理启动时间、rerun state machine、straggler detector、telemetry、in-process restart 等工程功能。初读时先跟踪主线，再按需要展开这些钩子。

## `setup_model_and_optimizer()`

此函数连接：

1. builder/model config 构造一个或多个 model chunks；
2. FP16/BF16 wrapper；
3. DDP、Megatron-FSDP 或 Torch-FSDP；
4. optimizer 与 distributed optimizer；
5. LR scheduler；
6. checkpoint load 与参数同步。

构造顺序有依赖：optimizer 需要模型参数，DistOpt 需要 DDP buffer layout，load 又可能恢复 model/optimizer/scheduler 与 RNG。

## `train()`：iteration 状态机

外层循环大致：

```text
while iteration < train_iters:
  update num microbatches / sequence length
  loss_dict, skipped, grad_norm, zeros = train_step(...)
  iteration += 1
  logging / timers / memory / throughput
  maybe evaluate
  maybe save checkpoint
  maybe exit on signal, duration, interval
```

真实代码还处理动态 batch、data iterator 状态、rerun、determinism、profile window、MoE/MTP metrics 和弹性恢复。

## `train_step()` 的核心阶段

### 1. 清梯度和通信状态

```text
optimizer.zero_grad()
model_chunk.zero_grad_buffer()
reset overlap dispatch state
```

### 2. 选择并运行 schedule

```python
forward_backward_func = get_forward_backward_func(...)
losses_reduced = forward_backward_func(
    forward_step_func=forward_step,
    data_iterator=data_iterator,
    model=model,
    num_microbatches=get_num_microbatches(),
    ...
)
```

schedule 完成一个 global batch 内所有 microbatch 的 F/B，并返回用于日志的 loss data 与 token 数。

### 3. Finalize 全局梯度

等待/完成 DP reduction，处理 SP、shared embedding、token scaling 等额外规约。此处之后 optimizer 才能相信梯度语义完整。

### 4. Optimizer step

mixed-precision optimizer 可能因 overflow 返回 `update_successful=False`。成功时还会得到 grad norm、zero count 等诊断。

### 5. Scheduler step

学习率进度通常按本次成功处理的样本或 token 推进，而不是无条件 `+1`。若 overflow 跳过参数更新，scheduler 也要遵守项目语义。

### 6. 参数同步

DistOpt/FSDP 可能需要 all-gather 新参数，且可与后续计算重叠。生命周期必须确保下次 forward 使用前完成。

## Loss 的两种用途

用于 backward 的 loss 要按 global token/batch 语义正确缩放；用于日志的 loss 需要跨 DP 汇总并转换为人类可读平均值。二者不能随意共用一个“已经 mean 的 scalar”。`loss_func` 返回总和、token 数和 report dict，framework 再完成后续语义。

## `skipped_iter` 不等于程序失败

FP16 overflow、rerun 检测或特定策略可能跳过一次 optimizer update。日志要区分：

```text
iteration number advanced?
optimizer update happened?
scheduler advanced?
data iterator advanced?
checkpoint stores which state?
```

只有明确这几个状态，恢复后才不会重复或跳过数据。

## Evaluation 与 training 的 schedule 复用

Evaluation 仍用 forward/backward schedule 接口，但设置 `forward_only=True`，不构造 backward。模型进入 eval mode、关闭 dropout，并按 eval interval/iters 汇总 loss 或 non-loss data。

## 性能日志从哪里来

训练循环拥有真实端到端 iteration 时间和 token 数，因此可以计算 throughput、FLOPs、MFU、straggler 与通信 overlap 指标。单个 layer profiler 只能解释局部，不能替代 train-loop 指标。

## 实验：给 `train_step` 标注状态

```bash
sed -n '2980,3230p' megatron/training/training.py
rg -n "^def train\(|^def pretrain\(" megatron/training/training.py
```

制作表：

| 阶段 | 读哪些状态 | 写哪些状态 | 可能通信 |
| --- | --- | --- | --- |
| zero grad | old buffers | cleared buffers | 无 |
| schedule | model/data | grads/loss data | TP/PP/CP/EP |
| finalize | partial grads | global-correct grads | DP/SP/embedding |
| optimizer | grads/state | params/state | DistOpt AG |
| scheduler | samples/tokens | LR state | 通常无 |

## 自测

1. `pretrain`、`train`、`train_step` 各拥有哪种时间尺度？
2. 为什么 optimizer 必须在 finalize 之后？
3. `update_successful=False` 时哪些状态可能不推进？
4. 日志 loss 与 backward loss 为什么不是同一简单 scalar？
5. Evaluation 怎样复用 schedule？

## 源码定位

- [training.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/training/training.py)
- [microbatch calculator](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/num_microbatches_calculator.py)
- [optimizer package](https://github.com/NVIDIA/Megatron-LM/tree/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/optimizer)

下一章以 checkpoint 完成状态闭环：保存哪些事实，怎样跨拓扑恢复。
