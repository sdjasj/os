# 00. 学习路线：从一个训练 step 建立 DeepSpeed 全景

DeepSpeed 很容易被误解成“一份 JSON 加一个 ZeRO 开关”。真正的项目是一套跨越 Python API、分布式进程组、优化器状态、参数生命周期、C++/CUDA 算子和启动器的训练系统。本章先把这些部件放进同一张地图，规定后续读码的主线和实验层级。

## 学完后应能回答什么

完成 20 个模块后，你应能独立回答：

- `deepspeed.initialize()` 为什么返回四个对象，真正接管训练的是谁；
- 全局 batch、每卡 micro-batch、数据并行规模和梯度累积怎样约束彼此；
- 普通数据并行、ZeRO-1、ZeRO-2、ZeRO-3 分别在什么时间保存完整状态；
- 一次 `engine.backward(loss)` 会触发哪些 hook、缩放和 collective；
- Pipeline、Tensor Parallel、Sequence Parallel、Expert Parallel 分割的是哪一个维度；
- checkpoint 为什么不是“只让 rank 0 调一次 `torch.save`”；
- JIT 算子失败、collective 卡住和显存峰值异常分别应从哪一层排查。

## 一张总图：控制面与数据面

把 DeepSpeed 分成控制面与数据面很有帮助：

```text
控制面
  launcher / 环境变量 / rank
          ↓
  deepspeed.initialize()
          ↓
  DeepSpeedConfig → 选择 Engine、优化器包装、并行组和 checkpoint engine

数据面（每个 rank 都执行）
  batch → engine.forward()
        → engine.backward(loss)
        → 梯度 hook + collective
        → engine.step()
        → optimizer / scheduler / monitor / checkpoint
```

[公共入口](deepspeed/__init__.py) 负责把配置和用户模型翻译成具体 Engine；[训练运行时](deepspeed/runtime/engine.py) 负责前向、反向、梯度累积和优化器更新；[通信门面](deepspeed/comm/comm.py) 让其余代码不必直接绑定某个后端；[ZeRO 目录](deepspeed/runtime/zero/) 则改变模型状态的布局和生命周期。

## 先区分四类“并行”

| 并行方式 | 每个 rank 拿到什么 | 主要通信 | 解决的问题 |
| --- | --- | --- | --- |
| 数据并行 DP | 完整模型，不同样本 | 梯度 All-Reduce | 提高吞吐 |
| ZeRO 数据并行 | 模型逻辑相同，训练状态按 stage 分片 | Reduce-Scatter、All-Gather | 降低状态冗余 |
| 张量/序列并行 TP/SP | 同一层的张量或序列维被切开 | All-Reduce、All-Gather、All-to-All | 单层放不下或序列太长 |
| 流水线并行 PP | 连续的层被放到不同 stage | 激活和梯度点对点传输 | 模型深度跨设备 |
| 专家并行 EP | 不同专家位于不同 rank | token All-to-All | 稀疏扩展参数量 |

这些方式能组合，但不能只靠“GPU 数相乘”理解。每种并行都有自己的 process group；一个 rank 可以同时属于 DP、TP、PP、SP、EP 等多个组。

## 最小训练程序：先看边界

下面的程序保留普通 PyTorch 模型和损失，只把训练循环的三个边界交给 Engine：

```python
import torch
import deepspeed


class TinyRegressor(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.net = torch.nn.Sequential(
            torch.nn.Linear(16, 32),
            torch.nn.GELU(),
            torch.nn.Linear(32, 1),
        )

    def forward(self, features, targets):
        predictions = self.net(features)
        return torch.nn.functional.mse_loss(predictions, targets)


config = {
    "train_micro_batch_size_per_gpu": 2,
    "gradient_accumulation_steps": 4,
    "optimizer": {"type": "AdamW", "params": {"lr": 1e-3}},
    "zero_optimization": {"stage": 0},
}

model = TinyRegressor()
engine, optimizer, _, scheduler = deepspeed.initialize(
    model=model,
    model_parameters=model.parameters(),
    config=config,
)

for _ in range(8):
    device = engine.device
    features = torch.randn(2, 16, device=device)
    targets = torch.randn(2, 1, device=device)
    loss = engine(features, targets)
    engine.backward(loss)
    engine.step()
```

这里每次循环是一个 micro-step，不一定是一次参数更新。`gradient_accumulation_steps=4` 时，默认只有每四次 `step()` 中最后一次真正调用优化器。这个事实是后面理解通信时机、loss 缩放、scheduler 步数和日志计数的基准。

## 为什么仍然保留 PyTorch 训练形状

DeepSpeedEngine 继承 `torch.nn.Module`，所以 `engine(...)` 仍然走模块调用协议。用户模型计算 loss，DeepSpeed 在周围插入计时、混合精度上下文、梯度处理和状态管理。这个设计让迁移成本低，但也带来一个重要约束：

> “代码看起来像普通 PyTorch”不表示底层参数始终是完整张量，也不表示 `.backward()` 与 `.step()` 没有额外协议。

ZeRO-3 下，参数可能在算子执行前才被 gather，算子结束后又被 partition；混合精度下，优化器更新的可能是 FP32 master weights；PipelineEngine 下，用户甚至应调用 `train_batch()` 而非自己循环每个 stage。

## 四遍读码法

### 第一遍：只找入口与返回值

```bash
cd <project-root>
rg -n '^def initialize|^def init_inference' deepspeed/__init__.py
rg -n '^class (DeepSpeedEngine|PipelineEngine|InferenceEngine)' deepspeed
```

先回答谁构造谁，不追内部算法。

### 第二遍：只追一次普通训练

```text
initialize
  → DeepSpeedConfig
  → DeepSpeedEngine.__init__
  → _configure_optimizer
  → forward
  → backward
  → step
  → _take_model_step
```

在纸上为每一跳写“输入对象、输出对象、是否 collective、是否改变持久状态”。

### 第三遍：把 stage 从 0 改成 2

观察 `_configure_zero_optimizer` 如何替换普通优化器；再观察 backward 的梯度 hook 为什么能在反向尚未完全结束时开始 reduction。不要一开始钻进每个 bucket 的下标计算。

### 第四遍：加入失败路径

依次考虑 loss overflow、unused parameter、rank 掉线、checkpoint 中断、JIT 编译失败。系统代码的边界通常在失败路径里最清楚。

## 三档实验环境

### A 档：静态阅读，无 GPU

只需 Git、Python 和 `rg`：

```bash
git rev-parse HEAD
rg -n 'train_batch_size ==|micro_batch \* grad_acc' deepspeed/runtime/config.py
rg -n 'is_gradient_accumulation_boundary' deepspeed/runtime/engine.py
```

本教程所有章节都能在 A 档完成源码定位和大部分自测。

### B 档：单设备、最小运行

先运行环境报告，再使用小模型、stage 0 或 stage 1。第一次触发某个 fused op 可能发生 JIT 编译，不要把编译时间误认为训练卡死。

```bash
ds_report
deepspeed --num_gpus=1 train.py
```

### C 档：两卡或多机

通信和 ZeRO 的关键性质必须在 `world_size > 1` 才能观察。先两卡验证 rank、group 和 collective 次序，再扩展到多机；不要同时引入 hostfile、NVMe 和复杂模型。

## 建立个人读码记录

每研究一个功能，维护下面六格：

| 证据 | 要记录的内容 |
| --- | --- |
| 用户入口 | Python API、CLI 或 JSON 字段 |
| 配置对象 | 默认值、校验、互斥关系 |
| 运行时对象 | Engine、optimizer wrapper、coordinator |
| 数据布局 | 每个 rank 拥有哪些张量及 dtype |
| 通信/副作用 | collective、文件、进程、设备拷贝 |
| 测试 | 最小 world size、断言和失败条件 |

这张表比按目录写摘要更有用，因为 DeepSpeed 的一个功能经常横跨配置、Engine、optimizer 和测试。

## 本章实验：画出自己的 step 卡片

1. 在 `deepspeed/__init__.py` 找到 `initialize()` 的四个返回值。
2. 在 `deepspeed/runtime/engine.py` 找到 `backward()`、`is_gradient_accumulation_boundary()`、`step()`。
3. 用 `gradient_accumulation_steps=4`，手算前 8 个 micro-step 中哪两个执行参数更新。
4. 把 stage 改成 2，只记录构造出的优化器类发生了什么变化。
5. 找一个对应的 `tests/unit/runtime/zero/` 测试，记录它要求的 `world_size`。

## 自测

1. 为什么 `engine.step()` 被调用不等于优化器一定更新？
2. ZeRO 与 Tensor Parallel 都会“切参数”，二者的语义差别是什么？
3. 为什么单卡能验证 API，却不能证明 Reduce-Scatter 正确？
4. 为什么读系统项目应同时看实现和测试？

答案要点：更新受梯度累积边界和 overflow 控制；ZeRO 保持数据并行计算语义并切训练状态，TP 切同一算子的计算；单卡 collective 退化为本地操作；测试给出隐含契约、进程数和失败条件。
