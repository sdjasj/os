# 13. Checkpoint 与恢复：模型、优化器、RNG 和数据位置

一个可恢复训练 checkpoint 远不止权重。若只恢复 model tensor，却丢失 optimizer、scheduler、RNG、iteration 或 data position，程序能继续运行，但不再是同一条训练轨迹。

## 完整状态清单

典型 checkpoint 包含：

```text
model parameters and buffers
optimizer states / master parameters
LR scheduler state
iteration and consumed samples/tokens
RNG states for relevant ranks/trackers
arguments/config metadata
rerun state machine state
optional dataloader state
distributed sharding metadata
```

是否保存 optimizer/RNG 可由参数控制；finetune 与 resume 的预期也不同。

## Legacy 与 distributed checkpoint

当前代码支持多种格式，包括 legacy torch、`torch_dist`、`torch_dcp`、`fsdp_dtensor` 等。核心区别是状态如何分片、metadata 是否支持跨并行拓扑重组，以及异步保存能力。

不要只按文件扩展名判断格式。`load_checkpoint` 会读取 metadata/类型并在 auto-detect 时归一化实际格式。

## Sharded state dict 是关键接口

普通 `state_dict` 只有 key→tensor；distributed checkpoint 还要知道：

- tensor 的全局形状；
- 本 rank shard 的 offset/axis；
- replica/group 关系；
- layer offset 与 PP ownership；
- TP/EP/DP 变化时怎样重建。

TP Linear、TransformerLayer、GPTModel 都提供 `sharded_state_dict`，逐层组合出全模型分片描述。

## 保存路径

简化：

```text
train loop reaches save condition
  -> save_checkpoint_and_time()
     -> gather current iteration/RNG/rerun/data state
     -> model.sharded_state_dict()
     -> optimizer/scheduler state
     -> backend save
     -> tracker/latest marker
```

Legacy 格式可能按 TP/PP/EP rank 生成独立文件；distributed backend 则用统一目录与 metadata 协调 shard。

## 异步保存的生命周期

异步 save 让训练尽快继续，但并非“调用后不管”：

1. 构造 save request；
2. 保证参与 tensor 在后台使用期间不被非法修改/释放；
3. 在下一次保存或退出前 finalize request；
4. 只有完整完成后更新可恢复标记。

训练结束前若未 finalize，目录可能存在却不可完整恢复。

## 加载路径

```text
resolve load directory and checkpoint type
read metadata / args
build target sharded state description
load model shards (possibly reshard)
load optimizer and scheduler if allowed
restore RNG / rerun / iteration
restore or advance data position
synchronize parameters as required
```

目标模型必须先构造，才能提供“我要哪些 shard”的描述。

## Resume 与 finetune

- **resume**：尽量恢复完整轨迹，包括 optimizer、scheduler、RNG、iteration 和数据位置；
- **finetune**：通常只把权重当初始化，重置 iteration/optimizer/scheduler/RNG；
- `--no-load-optim`、`--no-load-rng` 等是有意识破坏轨迹连续性的开关，应在实验记录中注明。

## 跨 TP/PP 与模型迁移

支持 reshard 不等于任何格式都能任意迁移。加载会比较 checkpoint 与运行时 TP/PP、world/DP，并决定 RNG 或 optimizer 是否可复用。当前快照还包含 GPT→Hybrid 的 layer mapping；只有支持 model-space 重分片的 optimizer 格式才能安全重定向状态，否则必须新建 optimizer。

## Checkpoint 正确性的四个层次

1. **结构**：文件/metadata 完整；
2. **可加载**：新进程能构造并 load；
3. **数值连续**：恢复后的下一步与不中断运行匹配；
4. **拓扑可移植**：改变 TP/PP/DP 后仍按声明支持。

只验证“目录生成了”远远不够。功能测试通常比较 resume 前后 golden metrics 或参数/梯度。

## 故障保护

- checkpoint 写共享、持久存储；
- 不把临时目录当最终可恢复点；
- 保存前后记录 iteration 与格式；
- 定期做实际 restore smoke test；
- 异步保存退出前 finalize；
- 保留最近多个已验证 checkpoint；
- 先复制到新目录再做格式转换，避免覆盖唯一副本。

## 实验：设计一次连续性验证

设计两条 10-step 小训练：

```text
A: 连续运行 step 1..10
B: 运行 1..5，保存，重启加载，运行 6..10
```

比较：step 6 输入样本、LR、loss、参数 hash、optimizer step、RNG/dropout 结果。指出只比较 step 10 checkpoint 文件数为何不足。

```bash
rg -n "^def (save_checkpoint|load_checkpoint)" \
  megatron/training/checkpointing.py
rg -n "sharded_state_dict" \
  megatron/core/models/gpt megatron/core/transformer \
  megatron/core/tensor_parallel
```

## 自测

1. 为什么权重可加载不等于训练轨迹连续？
2. Sharded state dict 比普通 state dict 多哪些信息？
3. 异步保存为何必须 finalize？
4. Resume 与 finetune 的状态语义有何区别？
5. 跨拓扑加载为什么依赖 checkpoint 格式？

## 源码定位

- [checkpointing.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/training/checkpointing.py)
- [distributed checkpointing](https://github.com/NVIDIA/Megatron-LM/tree/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/dist_checkpointing)
- [GPT-Hybrid conversion guide](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/docs/user-guide/hybrid-model-migration.md)

源码主线到此闭环。实践轨道将把这些概念变成可执行的 mock-data、测试、性能与集群练习。
