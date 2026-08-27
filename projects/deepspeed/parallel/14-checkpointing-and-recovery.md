# 14. Checkpoint：分片状态、一致性提交与跨并行恢复

分布式 checkpoint 不是在 rank 0 调一次 `torch.save(model.state_dict())`。DeepSpeed 需要保存模型、ZeRO optimizer partitions、scheduler、训练计数、随机状态和并行元数据，并确保所有 rank 对同一个 tag 达成一致。本章从 Engine API 走到 checkpoint engine 和 universal checkpoint。

## 用户 API 的基本形状

训练中常用：

```python
engine.save_checkpoint(
    save_dir="/path/to/checkpoints",
    tag=f"global_step{engine.global_steps}",
    client_state={"epoch": epoch},
)
```

恢复：

```python
load_path, client_state = engine.load_checkpoint(
    load_dir="/path/to/checkpoints",
    tag=None,
    load_optimizer_states=True,
    load_lr_scheduler_states=True,
)
```

`tag=None` 通常根据 `latest` 指针选择。生产任务应明确 checkpoint 目录位于各节点都能按同一语义访问的位置，或正确启用 node-local storage 模式。

## 为什么所有 rank 都必须调用 save

每个 rank 可能拥有独有的：

- ZeRO optimizer partition；
- DP/TP/PP/EP 模型 shard；
- RNG state；
- data/训练进度；
- checkpoint writer 职责。

Engine 内部还有 barrier 和 tag 一致性校验。只有 rank 0 进入 save，其他 rank 继续训练，会导致 barrier 卡住或 checkpoint 缺片。

正确模式是所有 rank 进入同一次 API，由 checkpoint engine 决定哪些 rank 实际写哪些文件。

## 一个逻辑 checkpoint 的组成

不同模式文件名不同，但概念上包括：

```text
tag directory/
├── model state shard(s)
│   ├── module weights / buffers
│   ├── lr scheduler state
│   ├── sparse/MoE/parallel metadata
│   └── client_state / counters / RNG
├── zero optimizer shard(s)
│   ├── FP32 master partitions
│   ├── optimizer moments
│   └── partition/padding metadata
└── latest（通常位于 save_dir，指向 tag）
```

`client_state` 用来保存 DeepSpeed 不知道的上层状态，例如 epoch、sampler offset 或自定义 curriculum。不要在其中塞模型/数据大对象。

## CheckpointEngine 抽象

[`CheckpointEngine`](checkpoint_engine.py) 定义：

- `create(info)`：开始一个 tag 的保存；
- `save(state_dict, path)`；
- `load(path, map_location)`；
- `commit(info)`：所有文件准备好后提交；
- `is_data_parallel_writer(rank)`：选择 writer；
- `is_decoupled()`：是否支持解耦/异步提交；
- `cleanup()`。

TorchCheckpointEngine 是本地文件实现；其他 engine 可以映射到不同存储服务。Engine 只依赖这一协议，不把保存逻辑写死在 `torch.save`。

## Create、write、commit 为什么分开

假设 8 个 rank 中第 7 个写失败，前 7 个文件已经存在。若此时更新 `latest`，恢复端会读到不完整 checkpoint。

两阶段思路是：

```text
create tag
  → ranks 写各自临时/目标 shards
  → 同步并验证
  → commit tag
  → 更新 latest
```

它不自动等价于任意分布式文件系统的强事务，但至少把“文件生成”和“对外宣告可用”分开。

## Tag 一致性

所有 rank 必须给出相同 tag。若某些 rank 用本地时间生成、跨秒不同，可能写到不同目录。DeepSpeed 支持 tag validation mode；严格模式应尽早失败，而不是留下不可恢复快照。

用 `global_steps` 等所有 rank 一致的确定值生成 tag，更安全。

## ZeRO Stage 对保存的影响

### Stage 0

每个 DP rank 模型相同，通常一个 DP writer 保存模型；optimizer state 可按普通方式保存。

### Stage 1/2

模型低精度参数仍完整，但 optimizer/master state 按 rank 分片，每个相关 rank 都要保存自己的 ZeRO shard。

### Stage 3

参数本身也是 partition。普通 module state 不能自然代表完整模型。可以：

- 保存分片 checkpoint，恢复到 DeepSpeed；
- 设置 gather 16-bit weights，在保存时聚合常规模型文件；
- 使用离线工具从 ZeRO shards 重建 FP32 权重。

聚合会产生显存/内存峰值，应纳入资源预算。

## Load 的顺序

概念顺序是：

1. 解析 tag/`latest`；
2. 读取模型/并行 metadata；
3. 按 strict/custom load 规则恢复 module；
4. 若启用，恢复 optimizer partitions；
5. 若启用，恢复 LR scheduler；
6. 恢复 step/sample 等 Engine 状态；
7. 返回 `client_state` 给上层。

`load_module_strict=False` 能容忍缺失/多余 key，但不能自动证明新模型语义兼容旧 optimizer state。微调、增删 head、LoRA/frozen 参数等场景要明确哪些状态可复用。

## Stage 3 的常见恢复陷阱

在同一个已 partition 并更新过的 Engine 上保存后立刻 load，可能不符合 load 期望的“可加载模型”状态。官方常见做法是重新构造模型和 Engine，再加载 checkpoint。原因是 Stage 3 的 module parameters 已被 partition/placeholder 化，普通 state load 与生命周期 hook 相互影响。

测试和当前 API 是最终依据；不要把 Stage 0 的“原对象原地 load”经验直接套到 Stage 3。

## Frozen parameters 和参数组变化

`exclude_frozen_parameters` 能减少保存冻结权重/optimizer state，但恢复端必须能从基础模型或其他来源得到这些参数。若参数组顺序、requires_grad 或 optimizer 类型变化：

- optimizer partition mapping 可能不匹配；
- scheduler state 可能不再适用；
- 仅加载 module、跳过 optimizer/scheduler 更安全。

Checkpoint 兼容不是只比较 state dict key，还要比较参数布局和训练语义。

## Universal Checkpoint 的目标

普通分片 checkpoint 与写入时的 DP/TP/PP 拓扑耦合。Universal Checkpoint 记录可重组的参数片和 metadata，使恢复端能在不同并行度下 reshape/merge/split。

概念流程：

```text
原并行 checkpoint shards
  → 统一参数语义 + slice metadata
  → universal representation
  → 目标 TP/PP/DP 拓扑重新分片
```

它不是凭空解决所有模型改动。参数命名、shape、特殊 QKV/embedding 规则和 optimizer state 类型仍需转换逻辑。

## Checkpoint 与数据进度

只保存模型 step 不足以严格恢复训练：dataloader shuffle、sampler epoch/offset、数据流 RNG、gradient accumulation 中间状态都影响后续样本。安全边界通常是在 optimizer update 后保存，而不是 accumulation 中间。

上层应在 `client_state` 或专门 data-state 机制中保存：

- epoch / consumed samples；
- sampler state；
- 数据预处理随机种子；
- 课程学习状态；
- 评估/最佳指标。

## 本章实验：设计故障矩阵

为最小两 rank 训练设计下列测试：

| 场景 | 预期 |
| --- | --- |
| 两 rank 同 tag 保存 | 成功，可恢复相同参数 |
| rank 0/1 不同 tag | 校验失败或不可提交 |
| 只加载 module | 权重恢复，optimizer/scheduler 保持新状态 |
| 完整恢复 | 下一 update 与参考运行接近/一致 |
| 修改模型 head 后 strict load | 明确失败 |
| strict=false | 只接受预期 missing/unexpected keys |

源码导航：

```bash
rg -n '^    def (save_checkpoint|load_checkpoint|save_16bit_model)' \
  deepspeed/runtime/engine.py
rg -n 'class .*CheckpointEngine|def create_checkpoint_engine' \
  deepspeed/runtime/checkpoint_engine
rg -n 'universal|tag_validation|client_state' tests/unit/checkpoint deepspeed/checkpoint
```

## 常见误区

- 只有 rank 0 调 save。
- 用每个 rank 的本地时间生成 tag。
- 看到目录存在就认为 checkpoint 已 commit。
- Stage 3 下直接把 module state 当完整模型。
- 改了模型/optimizer 参数组仍强行加载旧 optimizer state。
- 只保存训练 step，不保存 sampler/数据进度。
- 在 accumulation 中间保存，却期待 bitwise continuation。

## 自测

1. CheckpointEngine 为什么需要 `commit()` 而不只有 `save()`？
2. Stage 2 模型参数完整，为什么仍要求多个 rank 参与 checkpoint？
3. Universal Checkpoint 能改变并行度，为什么仍不能随意改变模型结构？
4. `client_state` 最适合保存什么，不适合保存什么？
