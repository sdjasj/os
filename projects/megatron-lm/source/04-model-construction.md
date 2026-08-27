# 04. 模型构造：`model_provider`、`gpt_builder` 与 `GPTModel`

模型构造链分三层：训练框架决定当前 pipeline stage 需要怎样的 model chunk；`model_provider` 处理任务级包装；`gpt_builder` 选择具体 layer spec 并实例化 `GPTModel`。这三层不要混为一个“model factory”。

## 调用链

```text
training.build_model(...)
  -> model config / builder
  -> model_provider(model_builder=...,
                    pre_process=...,
                    post_process=...,
                    vp_stage=...,
                    pg_collection=...)
     -> gpt_builder(...)
        -> choose Transformer layer/block spec
        -> GPTModel(...)
```

`pre_process` 与 `post_process` 由 PP 位置决定：首 stage 需要 embedding，末 stage 需要 output projection 和 loss，中间 stage 两者通常都不需要。

## `model_provider` 很薄但有任务钩子

它主要：

- 从全局 args 读取任务开关；
- 可选开启 CUDA memory history 与 OOM snapshot；
- ModelOpt 启用时替换 builder；
- 把 `config`、`vp_stage`、`pg_collection` 原样传下去。

这种薄包装允许训练框架不知道 GPT/Hybrid/ModelOpt 的具体选择。

## `gpt_builder` 怎样选择 layer spec

选择顺序大致为：

1. `--spec`：加载用户自定义模块规格；
2. experimental attention variant：构造实验 block；
3. `num_experts`：构造可能混合 dense/MoE 的 decoder block spec；
4. heterogeneous config：按层异构；
5. 默认：根据 `transformer_impl` 选 TE、本地或 inference-optimized spec。

这说明“GPT 架构”与“某个具体 Linear/Norm/Attention 实现”被有意分离。

## `GPTModel` 的四块

### Embedding

仅 `pre_process` stage（或特定 MTP stage）构造 `LanguageModelEmbedding`。它处理 token/position embedding，并可把输出 scatter 到 sequence-parallel region。

### Position representation

根据配置创建 RoPE、YaRN、M-RoPE 或无位置编码所需对象。RoPE tensor 在 `_preprocess` 中按序列长度产生并传入 decoder。

### Decoder

```python
self.decoder = TransformerBlock(
    config=self.config,
    spec=transformer_layer_spec,
    ...
)
```

`TransformerBlock` 按 PP/VPP layout 构造本 rank 拥有的 layer，而不是所有 rank 都持有完整 decoder。

### Output layer

仅 `post_process` stage 构造词表投影，通常是 `ColumnParallelLinear(H,V)`。`parallel_output=True` 时保留 vocab shard，直接交给 vocab-parallel loss。

## Embedding 与输出权重共享

当 `share_embeddings_and_output_weights=True`，首尾 PP stage 需要一致权重。若首尾不是同一 rank，训练框架用 embedding group 同步。输出层还可 `skip_weight_param_allocation`，运行时使用共享 embedding 权重，避免重复参数。

## Forward 的三个阶段

`GPTModel.forward()` 很适合作为模型黑盒边界：

```text
_preprocess()
  input ids -> embeddings / pipeline input
  build rotary tensors

decoder(...)
  TransformerBlock stack

_postprocess()
  optional MTP
  output projection
  logits or language-model loss
```

在 inference mode 下还会处理 cache、decode offset、CUDA graph 和强制 gather logits；学习训练主链时先忽略这些分支。

## `pg_collection` 从构造时进入叶子模块

GPTModel 将 TP/CP 等 group 传给 embedding、RoPE、decoder 和 output layer。这样同一 Python 类可在不同拓扑中实例化，也避免叶子层自己猜 group。

## 当前快照的 GPT/Hybrid 边界

`GPTModel.__init__` 明确发出弃用警告：只接受关键 bug fix，新功能转向 `HybridModel`。但这里的 embedding→stack→output、pre/post process、spec 注入、PG 传递等模式仍是理解 Hybrid 的基础。

## 实验：列出当前配置会选哪条 spec

对下列三种配置分别推导分支：

```text
A. transformer_impl=transformer_engine, no experts
B. transformer_impl=local, num_experts=8
C. --spec my_package.custom_spec
```

```bash
sed -n '1,220p' gpt_builders.py
rg -n "self.embedding|self.decoder|self.output_layer" \
  megatron/core/models/gpt/gpt_model.py
```

## 自测

1. `pre_process/post_process` 为什么属于 PP 语义？
2. `model_provider` 与 `gpt_builder` 分别负责什么？
3. `parallel_output=True` 为什么节省词表 gather？
4. shared embedding 在 PP 下为何需要专门 group？
5. GPTModel 被弃用后，本章哪些设计仍通用？

## 源码定位

- [model_provider.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/model_provider.py)
- [gpt_builders.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/gpt_builders.py)
- [GPTModel](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/models/gpt/gpt_model.py)
- [HybridModel](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/models/hybrid/hybrid_model.py)

下一章进入 ModuleSpec 与单层 residual 数据流。
