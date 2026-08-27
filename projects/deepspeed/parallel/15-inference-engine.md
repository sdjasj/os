# 15. DeepSpeed Inference：配置合并、模型注入、TP 与 CUDA Graph

训练 Engine 优化 forward/backward/optimizer；InferenceEngine 面向只读权重、低延迟/高吞吐 forward，关注 dtype 转换、Transformer kernel 注入、Tensor Parallel、量化、checkpoint 加载和 CUDA Graph。两者共享 accelerator、comm 和 module injection，但生命周期不同。

## 公共入口 `init_inference()`

用户可以传配置字典/路径和关键字参数：

```python
engine = deepspeed.init_inference(
    model,
    config={
        "dtype": "fp16",
        "tensor_parallel": {"tp_size": 2},
        "replace_with_kernel_inject": True,
    },
)
```

入口规则是：

1. config 为 `None` 时从空字典开始；
2. 字符串按 JSON 文件读取，字典直接使用；
3. kwargs 与 config 合并；
4. 同一 key 同时出现且值不同则报错，而不是静默覆盖；
5. 构造 `DeepSpeedInferenceConfig`；
6. 返回 `InferenceEngine(model, config)`。

源码注释说 kwargs 优先，但实际冲突值会显式报错；读实现比只记文档摘要更可靠。

## 配置模型的主要维度

[`DeepSpeedInferenceConfig`](config.py) 包括：

| 配置 | 作用 |
| --- | --- |
| `dtype` | FP16、BF16、FP32、INT8 等模型表示 |
| `tensor_parallel.tp_size` | 模型并行规模和可选 group/mpu |
| `replace_with_kernel_inject` | 使用 DeepSpeed Transformer kernel injection |
| `injection_policy` | 用户指定模块到 policy 的映射 |
| `enable_cuda_graph` | capture/replay 固定执行图 |
| `quant` | INT8 MoQ 等量化设置 |
| `keep_module_on_host` | checkpoint 加载/量化前避免直接放设备 |
| `max_out_tokens` / `min_out_tokens` | 上下文/输出容量和内存检查 |
| `checkpoint` / `base_dir` | 权重加载来源 |
| `moe` | 推理 expert parallel 配置 |

Pydantic validator 会把 dtype 字符串转成 `torch.dtype`，并检查 Triton 等可选能力。

## Engine 构造的主路径

[`InferenceEngine.__init__`](engine.py) 的顺序可归纳为：

```text
保存 module/config
  → 接管 generate（若模型提供）
  → 校验 accelerator 支持 dtype
  → 转换模型 dtype
  → 建立 TP/EP process groups
  → 三选一模型替换：
       用户 injection policy
       kernel injection
       tp_size > 1 的 AutoTP
  → 将模型移到当前设备（除非 keep_module_on_host）
  → 同步 TP RNG
  → 加载 checkpoint / 初始化 quantization
```

顺序很重要：TP group 必须在按 group 切 head/权重前存在；keep-on-host 允许加载时先量化或分片，避免完整高精度模型先占 GPU。

## 三种 injection 模式互斥

### 用户 policy

用户把模块类映射到 injection policy/目标 layer name。Engine 验证 layer name 存在，再应用替换。适合自定义架构，但 policy 必须准确描述 QKV、MLP、LayerNorm 和输出边界。

### Kernel injection

`replace_with_kernel_inject=true` 使用 DeepSpeed 已知 Transformer policy，将一组原生层替换为融合 inference implementation。

### AutoTP

未给 policy、未启用 kernel injection、但 `tp_size>1` 时，AutoTP 解析模型并为识别出的 block 生成替换方案。

用户 policy 与 kernel injection 明确不能同时启用。三条路径都会改 module tree，调试时应先记录替换前后 `named_modules()`。

## Kernel injection 做了什么

概念上不是给原模块加一个 hook，而是：

1. 匹配支持的 Transformer block；
2. 读取并变换原权重布局；
3. 按 TP rank 切片；
4. 构造 DeepSpeed attention/MLP/normalization module；
5. 将权重放入融合 kernel 期望的 layout；
6. 替换原 module。

因此 checkpoint 权重命名、QKV 排列、transpose 和量化 scale 都是 policy 契约的一部分。

## 推理 TP 与训练 TP 的共同/差异

共同点：按 head/linear 维切权重，在 TP group 中 collective。差异在于推理没有参数梯度和 optimizer state，可以使用更激进的权重预处理、kernel fusion、KV cache 和 CUDA Graph。

InferenceEngine 可以从用户 MPU 获取既有 group，也能按 `tp_size` 创建 group。实际多副本服务还需在 TP group 之外安排 replica/data parallel；公共 Engine 不自动等价于完整 serving scheduler。

## CUDA Graph 的收益与限制

CUDA Graph capture 一次固定 kernel launch/内存图，后续 replay 减少 Python 和 launch overhead：

```text
第一次：capture → instantiate → replay
之后：更新静态 input buffer → replay
```

要求 shape、内存地址和控制流稳定。动态 batch/sequence、首次分配、随机控制流、某些 collective 都会增加限制。当前经典 InferenceEngine 还明确不支持 TP>1 与其全局 CUDA graph 组合。

`forward()` 在 graph 已创建时 replay，否则 capture；未启用则直接 `self.module(*inputs, **kwargs)`。

## `generate` 接管

若原模型有 `generate`，Engine 将自己的 `_generate` 暴露为 `generate`：

- 开始时重置支持的 KV cache；
- 检查 beam search（当前不支持 `num_beams>1`）；
- 检查 input length 不超过 `max_out_tokens`；
- 调回 module.generate。

这说明 Engine 不实现完整文本生成算法，而是在模型生成入口周围增加 runtime 约束和 cache 生命周期。

## Token 容量为什么是内存配置

`max_out_tokens` 包含输入和输出 token 上限，会影响 KV cache 和 workspace 预算。设层数 (L)、KV heads (H_{kv})、head dim (D)、token capacity (T)、dtype bytes (b)，单序列 KV cache 近似：

\[
2\times L\times T\times H_{kv}\times D\times b
\]

前面的 2 对应 K 与 V。并发 batch、TP 切分、padding 和 allocator 会进一步改变实际占用。

`min_out_tokens` 让 runtime 能在容量不足时提前给出可解释错误，而不是深处 kernel 失败。

## 量化边界

经典配置中 INT8 MoQ 通过 `dtype` 和 `quant` 控制 group 数、额外 MLP grouping 等。量化包括：

- 权重如何分组求 scale；
- checkpoint 是预量化还是加载后量化；
- TP 前量化还是分片后量化；
- 激活保持何种 dtype；
- kernel 是否支持该 layout。

`keep_module_on_host` 对大模型特别重要：先在 host 做量化/分片，再移动目标 shard，避免完整 FP16 权重先进入单卡。

## 经典 Engine 与 Inference v2

仓库还包含 `deepspeed/inference/v2/`：独立 engine factory、ragged sequence manager、blocked KV allocator、module registry、模型 policy 和 kernel。它面向连续 batching/ragged requests 等不同架构目标。

学习时不要混合两套对象：公共 `deepspeed.init_inference()` 在当前提交返回经典 `InferenceEngine`；v2 有自己的 config、factory 和模型实现边界。先读清调用入口再追目录。

## 本章实验：观察 module replacement

选择一个受支持的小模型，在单卡依次比较：

```python
before = {name: type(module).__name__ for name, module in model.named_modules()}
engine = deepspeed.init_inference(model, dtype="fp16")
after = {name: type(module).__name__ for name, module in engine.module.named_modules()}

for name in sorted(set(before) | set(after)):
    if before.get(name) != after.get(name):
        print(name, before.get(name), "->", after.get(name))
```

分别启用 kernel injection 和 TP，记录替换差异、参数 shape、输出误差和 latency。先 warm up，再计时；不要把 JIT/权重转换计入稳态 forward。

源码导航：

```bash
rg -n '^def init_inference|^class InferenceEngine|^class DeepSpeedInferenceConfig' \
  deepspeed/__init__.py deepspeed/inference
rg -n 'replace_with_kernel_inject|injection_policy|AutoTP' \
  deepspeed/inference deepspeed/module_inject
find deepspeed/inference/v2 -maxdepth 2 -type f | sort
```

## 常见误区

- 同一配置 key 在 config 和 kwargs 中给不同值，期待 kwargs 静默覆盖。
- 同时启用用户 injection policy 与 kernel injection。
- 认为 `init_inference` 本身就是完整的动态 batching 服务。
- 开 CUDA Graph 后仍随意改变 shape/控制流。
- 把 `max_out_tokens` 当只限制输出，不包含输入。
- 混用经典 InferenceEngine 和 v2 的配置/API。
- 计时未 warm up，把权重转换/JIT 当稳态延迟。

## 自测

1. 为什么模型注入前需要先建立 TP group？
2. `keep_module_on_host` 对大模型量化/分片有何内存价值？
3. CUDA Graph 为什么适合固定 shape，却不天然适合动态 batching？
4. 经典 InferenceEngine 的 `_generate` 做了哪些运行时工作，哪些仍由原模型负责？
