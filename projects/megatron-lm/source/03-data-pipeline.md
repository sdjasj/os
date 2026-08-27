# 03. 数据管线：从 indexed dataset 到 rank-local batch

数据路径不仅“读文件”。它要把文档拼成固定长度样本、确定 train/valid/test、混合多个语料、生成可复现索引，并只让必要 rank 构建和加载数据，最后按 TP/PP/CP 语义分发 tensor。

## 三层 dataset

`BlendedMegatronDatasetBuilder` 的文档给出三层抽象：

```text
LowLevelDataset
  -> MegatronDataset (mid-level sample/index semantics)
  -> BlendedDataset (top-level multi-source mixing)
```

低层保存 tokenized documents；`GPTDataset` 用 document/sample/shuffle indices 把文档映射为训练样本；`BlendedDataset` 按权重或数据量组合多个来源。

## 为何需要三种索引

直观上：

- document index 决定某个 epoch 的文档次序；
- sample index 指出一个长度 `S+1` 的样本跨哪些文档边界；
- shuffle index 打乱可见样本顺序。

它们把昂贵预处理变成可缓存数组，并让多 rank 对样本边界有一致认识。

## `GPTDataset.__getitem__`

核心步骤：

1. 根据索引查询 `S+1` 个 token 与文档长度；
2. `tokens=text[:-1]`、`labels=text[1:]`；
3. 生成或复用 attention mask、loss mask、position ids；
4. padding 位置 loss mask 置零；
5. 必要时生成文档级 `cu_seqlens` 并重置 position ids。

当 mask 设置不依赖样本时，代码缓存 mask/position ids，避免每个样本重复构造。

## Builder 如何选择路径

`train_valid_test_datasets_provider` 根据参数选择：

```text
--mock-data -> MockGPTDataset
--fim-data  -> GPTFIMDataset
--sft       -> SFTDataset
otherwise   -> GPTDataset
```

再把目标样本数、rank predicate 和 `GPTDatasetConfig` 交给 `BlendedMegatronDatasetBuilder.build()`。

## 不是所有 rank 都读数据

`is_dataset_built_on_rank()` 通常只允许 TP rank 0，并结合 PP 首/尾 stage 与 MTP 位置判断。原因是：

- TP ranks 需要相同 token，不必每人独立读盘；
- PP 中间 stage 通常只消费上游 hidden state；
- 首 stage 需要 tokens/position，末 stage 需要 labels/loss mask；
- packed/MTP 情况会增加中间 stage 所需元数据。

## `get_batch()` 的两次分发

第一步，TP rank 0 从 iterator 取 dict 并搬到 CUDA，然后：

```text
get_batch_on_this_tp_rank(...)
```

它按 PP stage 广播所需字段。首 stage 可不拿 labels，末 stage 可不拿 tokens，中间 stage 甚至只需 THD metadata。

第二步：

```text
get_batch_on_this_cp_rank(...)
```

它按 CP 策略切 sequence，可能使用 per-sequence zigzag、per-document balancing、hybrid CP 或 contiguous layout。

## 固定 `BATCH_KEYS` 的意义

入口定义有序 schema：

```text
attention_mask, cu_seqlens, cu_seqlens_padded,
hybrid_cp_group, labels, local_cp_size, loss_mask,
max_seqlen, position_ids, tokens
```

返回顺序不依赖 dataset wrapper 是否额外加入 provenance 字段，避免调用者用 `sorted(batch.keys())` 时被新 key 破坏。这是“数据 dict 灵活、回调协议稳定”的边界。

## Packed sequence 与 THD

多个变长样本可打包为一条 token 流，`cu_seqlens` 记录各序列起止偏移。`forward_step` 构造 `PackedSeqParams(qkv_format='thd', ...)`，让 Transformer Engine 知道真实边界，不让不同文档互相 attention。

`cu_seqlens_padded` 处理 CP 对齐 padding；性能统计则应使用真实 `cu_seqlens`，否则会把 padding 当有效 FLOPs。

## 数据问题的诊断表

| 现象 | 优先检查 |
| --- | --- |
| loss 错一位 | `S+1`、tokens/labels shift |
| rank 间 batch 不一致 | TP source rank 与 broadcast group |
| PP 中间 rank 收到 None 后崩溃 | stage 所需字段判断 |
| packed attention 串文档 | `cu_seqlens`、mask、position reset |
| resume 后数据重复 | sample/shuffle index 与 iterator state |

## 实验：跟踪一个样本

```bash
rg -n "def __getitem__|add_extra_token_to_sequence" \
  megatron/core/datasets/gpt_dataset.py
rg -n "def get_batch|BATCH_KEYS" pretrain_gpt.py
rg -n "def get_batch_on_this_(tp|cp)_rank" megatron/core/utils.py
```

在纸上记录 `[B,S]` batch 从 CPU 到 TP broadcast、再到 CP local sequence 的形状变化。

## 自测

1. document/sample/shuffle index 分别解决什么？
2. 为什么只让部分 rank 构建 dataset？
3. PP 首尾 stage 需要的 batch 字段有何差异？
4. `BATCH_KEYS` 为什么是稳定协议？
5. `cu_seqlens` 与 `cu_seqlens_padded` 分别表达什么？

## 源码定位

- [GPTDataset](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/datasets/gpt_dataset.py)
- [Blended builder](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/datasets/blended_megatron_dataset_builder.py)
- [GPT batch callback](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/pretrain_gpt.py)
- [TP/CP batch utilities](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/utils.py)

下一章从 `model_provider` 进入 builder、layer spec 与 `GPTModel` 构造。
