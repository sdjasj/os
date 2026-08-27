# 05. ModuleSpec 与 TransformerLayer：架构骨架如何注入实现

Megatron Core 不把 TransformerLayer 写死为某组类，而用 `ModuleSpec` 描述“这里是什么模块、构造参数是什么、子模块由谁实现”。这使本地 PyTorch、Transformer Engine、inference-optimized、MoE 和实验 attention 能共享同一层级骨架。

## `ModuleSpec` 的核心思想

概念上：

```text
ModuleSpec
  module: 要实例化的类或工厂
  params: 额外构造参数
  submodules: 继续向下的子模块规格
```

`build_module(spec, *args, **kwargs)` 合并调用方参数和 spec params，再实例化 module。若传入本身就是 module class，也可直接构造。这让上层 block 不必知道某个 Linear 来自 TE 还是本地实现。

## Layer submodules 是结构化插槽

`TransformerLayerSubmodules` 包含类似：

```text
input_layernorm
self_attention
self_attn_bda
pre_mlp_layernorm
mlp
mlp_bda
```

规格 provider 把这些插槽填为 local、TE、Kitchen 或 inference backend。架构顺序由 `TransformerLayer` 掌握，算子实现由 spec 提供。

## 一个 Pre-LN layer 的数据流

忽略可选分支，可压缩成：

```text
residual = hidden_states
x = input_layernorm(hidden_states)
attn_out, attn_bias = self_attention(x)
hidden_states = bias_dropout_add(attn_out, attn_bias, residual)

residual = hidden_states
x = pre_mlp_layernorm(hidden_states)
mlp_out, mlp_bias = mlp(x)
hidden_states = bias_dropout_add(mlp_out, mlp_bias, residual)
```

输入输出均为 `[S,B,H]`。Attention/MLP 内部可分片，但 residual 边界必须恢复该层约定的布局。

## 为什么模块返回 `(output, bias)`

Linear 可设置 `skip_bias_add=True`，把 bias 留给上层。随后 bias、dropout、residual add 可融合为一个 kernel：

```text
output + bias -> dropout -> + residual
```

这就是 BDA（bias-dropout-add）插槽存在的原因。接口多返回一个 bias，不是数学需要，而是为融合保留机会。

## Layer number 不只是日志编号

PP/VPP 下每个 rank 只构造局部层。`get_transformer_layer_offset` 与 pipeline layout 计算全局 layer number，它会影响：

- checkpoint key/分片映射；
- MoE router auxiliary loss 记录；
- per-layer 日志与重计算策略；
- 异构 layer pattern。

因此修改 layout 后出现 checkpoint key 对不上，常与 layer offset 有关。

## Block 与 Layer 的边界

`TransformerBlock` 负责一组层：决定本 rank 构造多少层、循环 forward、activation checkpoint/CUDA graph 等 block 级策略。`TransformerLayer` 负责单层 residual 结构。Layer spec 可是单个 layer，也可能是包含多种 layer 的 block spec。

## 自定义 spec 的安全步骤

1. 从 local 或 TE spec 复制“结构”，不要复制整个实现；
2. 只替换目标插槽；
3. 保持输入输出 shape、bias contract 与 PG contract；
4. 实现 `sharded_state_dict` 或确认默认实现适用；
5. 写单层单元测试，再跑小模型端到端测试；
6. 检查 TP/PP 不同 size 下 checkpoint 可加载。

## 实验：比较 local 与 TE spec

```bash
rg -n "def get_gpt_layer_(local|with_transformer_engine)_spec" \
  megatron/core/models/gpt/gpt_layer_specs.py
rg -n "class TransformerLayerSubmodules|class TransformerLayer" \
  megatron/core/transformer/transformer_layer.py
rg -n "def build_module" megatron/core/transformer/spec_utils.py
```

列出两种 spec 中 input norm、QKV linear、core attention、MLP linear 分别由哪个类提供，并指出结构相同处。

## 自测

1. ModuleSpec 解耦了哪两类变化？
2. 为什么 Linear 把 bias 返回给上层？
3. TransformerBlock 与 TransformerLayer 各拥有什么职责？
4. 全局 layer number 为什么影响 checkpoint？
5. 自定义子模块必须保持哪些契约？

## 源码定位

- [spec_utils.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/spec_utils.py)
- [gpt_layer_specs.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/models/gpt/gpt_layer_specs.py)
- [transformer_layer.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/transformer_layer.py)
- [transformer_block.py](https://github.com/NVIDIA/Megatron-LM/blob/e79cb4c1bae1afd04322d979d08cb63832991ebe/megatron/core/transformer/transformer_block.py)

下一章沿 SelfAttention 拆解 QKV、RoPE、core attention 与输出投影。
