# 00. 从启动命令到 `pretrain()`：入口脚本的真正职责

`pretrain_gpt.py` 是理解项目的最佳入口，因为它没有重写训练框架，而是提供四类 GPT 特定回调：batch、loss、forward step、dataset provider。通用生命周期交给 `megatron.training.training.pretrain`。

## 启动器做了什么

单机多卡通常形如：

```bash
uv run python -m torch.distributed.run \
  --nproc-per-node 8 \
  pretrain_gpt.py \
  --mock-data \
  --num-layers 4 \
  --hidden-size 256 \
  --num-attention-heads 4 \
  --seq-length 128 \
  --max-position-embeddings 128 \
  --micro-batch-size 2 \
  --global-batch-size 16 \
  --train-iters 20 \
  --bf16
```

`torch.distributed.run` 创建进程并设置 rank/world 环境；它不理解 Megatron 的 TP/PP/CP。那些维度由脚本参数与初始化逻辑解释。

## 导入前为何记录时间

入口文件在重依赖导入前记录 `_PROGRAM_START_TIME`。CUDA、PyTorch 和扩展导入本身可能很慢；若在 import 后计时，就无法量化真实启动成本。多 rank warning 抑制也在重依赖之前完成，避免日志被每个 rank 重复刷屏。

## `__main__` 的六步

当前快照的尾部可以压缩为：

```python
args = parse_and_validate_args(...)
model_cfg = gpt_config_from_args(args)
full_config = pretrain_cfg_container_from_args(args, model_cfg)
pretrain(
    full_config,
    train_valid_test_datasets_provider,
    ModelType.encoder_or_decoder,
    forward_step,
    get_embedding_ranks=get_embedding_ranks,
)
```

完整逻辑还包括：

1. 打印 PyTorch/MCore/Transformer Engine 版本；
2. 注册启动时间戳；
3. 标记 dataset provider 为 distributed-aware；
4. 可选包装 in-process restart；
5. 解析、校验并转成结构化 config；
6. 把 task-specific 回调交给通用 `pretrain()`。

## 回调协议是扩展边界

### Dataset provider

```text
requested train/valid/test sample counts
  -> (train_dataset, valid_dataset, test_dataset)
```

它决定用 real、mock、FIM 还是 SFT dataset，并声明哪些 rank 真正构建数据。

### Forward step

```text
(data_iterator, model)
  -> (model_output, loss_closure)
```

schedule 不需要知道 GPT batch 字段或 loss 细节，只负责在正确 microbatch、stage 和方向调用它。

### Embedding ranks

PP 下输入 embedding 与输出权重可能共享。`get_embedding_ranks` 告诉框架哪些 PP ranks 需要同步这类参数，还会考虑 MTP ranks。

## 为什么返回 loss closure

`forward_step` 不立即把输出压成 scalar，而是返回：

```python
return output_tensor, partial(loss_func, loss_mask, model=model)
```

这样 pipeline schedule 可以先完成 stage 间 forward，再只在负责 loss 的位置调用 closure；它还可在 evaluation 中收集非 loss 输出。调度与模型任务因此解耦。

## `ModelType.encoder_or_decoder`

调度需要知道模型是否是单栈 decoder/encoder，还是 encoder-decoder 双栈，因为 P2P tensor 形状与 stage 边界不同。GPT 选择 `encoder_or_decoder`，不是在说它是 encoder，而是选择“单栈”调度类别。

## 控制反转

这里采用 framework 调用 task callback 的结构：

```text
task script supplies policy
training framework owns lifecycle
core library owns implementation primitives
```

这也解释了为什么 GPT、BERT、T5 入口能共享大量训练代码。

## 实验：只读调用链

```bash
sed -n '500,560p' pretrain_gpt.py
rg -n "^def (get_batch|loss_func|forward_step|train_valid_test_datasets_provider)" \
  pretrain_gpt.py
rg -n "^def pretrain" megatron/training/training.py
```

为四个回调写出输入/输出，并说明哪个组件调用它。

## 自测

1. 启动器与 Megatron 初始化分别负责什么？
2. 为什么入口在 heavy import 前记录时间？
3. `forward_step` 为什么返回 loss closure？
4. Dataset provider 的 distributed-aware 含义是什么？
5. task script、training framework、Core library 如何分工？

## 源码定位

- [pretrain_gpt.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/pretrain_gpt.py)
- [training.pretrain](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/training/training.py)
- [简单 MCore 训练循环](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/examples/run_simple_mcore_train_loop.py)

下一章拆解 CLI Namespace 如何逐步成为可验证的配置对象。
