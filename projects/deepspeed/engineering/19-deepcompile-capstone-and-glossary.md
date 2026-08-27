# 19. DeepCompile、综合练习与术语表：从 eager runtime 走向图变换

前 19 章描述的多数优化由 Engine、hook 和 optimizer 在 eager 执行中编排。DeepCompile 进一步取得 PyTorch FX/AOTAutograd 的前向与反向图，把 ZeRO collective、预取、activation/parameter/optimizer offload 等能力变成显式图节点和 pass。本章建立其入口模型，并用一个综合项目串起整套教程。

## 为什么要把 runtime 逻辑放进图

Eager ZeRO 的 hook 在参数/梯度事件发生时动态调度，灵活但存在：

- Python/hook 开销；
- 局部事件难以看到整图复用距离；
- collective 与 compute 的全局排程有限；
- compiler 看不见隐藏在 hook 里的通信/释放；
- activation 与参数内存预算难统一规划。

图模式把计算、通信、fetch/release/offload 表成可分析节点，pass 能在全图 shape/liveness 之上选择位置。

## 配置入口

[`CompileConfig`](config.py) 的核心字段包括：

```json
{
  "compile": {
    "deepcompile": true,
    "passes": ["z3"],
    "free_activation": true,
    "debug_log": false
  }
}
```

当前可组合 pass 名的顶层类型包括 `z1`、`z3`、`autosp`、`autotp`；Engine 还根据 offload/optimization 设置注册和调度更细的内部 passes。

其他字段控制 activation offload、optimizer state offload、parameter offload、double buffer、symmetric memory、同步调试点和真实 input storage。

## Backend 的位置

[`make_backend()`](backend.py) 返回给 `torch.compile`/Dynamo 的 backend function：

```text
Python model
  → TorchDynamo 捕获 FX graph
  → AOTAutograd 产生 joint/forward/backward graphs
  → DeepCompile backend
       → 参数映射 DSGraphParamManager
       → profile node time / tensor memory
       → run registered passes
       → graph.lint + recompile
       → eager boxed func 或 Inductor compile
```

Backend 支持 eager 和 inductor 两类下游：eager 便于验证 graph transformation，inductor 再做 kernel/code generation。

## 为什么要分别处理 forward 与 backward 图

ZeRO/offload 的关键动作跨越两图：

- forward gather 的参数可能在 backward 再用；
- forward activation 可以 offload，backward 前必须 reload；
- gradient reduction 只能在 backward gradient ready 后插入；
- optimizer state 可在 forward/backward 期间移出，step 前恢复。

Backend 用 `GraphOrder` 记录 graph/frame 顺序，用 AOT partitioner 判断是否需要 backward，并为真实参数建立 forward/backward 节点映射。

## 真实输入、FakeTensor 与 SymInt

Compiler 常用 FakeTensor 做 shape propagation，避免执行真实计算；但 DeepCompile 的 memory profile、参数 `ds_id`、整数 token/shape 和动态维可能需要真实值或 hint。

`set_example_values_to_symints()` 将 fake tensor 的 shape/stride 用 SymInt hint 实例化为 dummy tensor，并在参数位置恢复 `Parameter` 与 `ds_id`。`InputStorage` 决定保留整数输入或全部真实输入。

这是一个重要边界：编译时样例不能意外进入训练状态，也不能丢失 pass 所需的 shape/参数身份。

## Pass 注册与 contract

Engine 初始化时注册 pass 名、函数和可选 contract，例如：

```text
z1/z2 gradient reduce
z3 gather/release
prefetch
selective gather
parameter offload
Adam state offload
activation offload
```

`register_compile_pass()` 把 callable 和 contract 绑定在同一名字。Contract 描述 pass 需要/保证的图性质，帮助组合时验证顺序和边界，而不是让任意 graph rewrite 靠约定碰运气。

## Pass 执行后的验证

`run_opt_passes()` 对每个 pass：

1. 调用 pass，允许原地修改或返回新 GraphModule；
2. `graph.lint()` 检查拓扑/引用合法性；
3. `recompile()` 生成可执行 forward；
4. 用 `MemoryProfilingInterpreter` 运行样例；
5. 在 ranks 间同步 profile 是否完整；
6. 保存 node time、tensor size 和 memory records。

Graph lint 通过只说明结构合法，不证明数学正确；仍需要 eager reference、gradient 和多步训练比较。

## 按 global step 启动 pass

`init_schedule()` 保存 `(step, passes)` 队列，`launch_compile_passes(global_steps)` 到目标 step 时：

- reset Dynamo/DeepCompile handle；
- 清理旧 graph order、profile、parameter manager 和 compiled backward state；
- 设置下一轮 passes；
- 触发重新 capture/compile。

这允许先 profile/warm up，再基于信息应用 pass。但重新编译是有成本的，状态清理也必须完整，否则旧 frame 输入/patch 泄漏到新图。

## Activation offload 的预算思想

配置说明明确：只考虑固定 shape 且至少一定大小的 activation，按 memory budget 选择 offload；forward 复制到 pinned host，backward 读取前恢复。

它与 parameter/optimizer offload 的 buffer 和带宽竞争，因此某些模式互斥。Graph pass 能根据 forward/backward liveness 判断“offload 后能释放多久”，而不是只看 tensor 大小。

## DeepCompile 与 eager ZeRO 的阅读对照

| Eager 概念 | 图模式对应 |
| --- | --- |
| module pre-forward hook fetch | forward graph gather node/pass |
| coordinator trace/prefetch | graph order + prefetch pass |
| gradient hook reduce | backward graph reduce node |
| post-forward release | liveness-guided release/free node |
| runtime memory logging | graph memory interpreter/profile |
| optimizer wrapper state | graph param manager + step integration |

先理解左列，才能审查右列是否保持状态机。

## 综合练习：解释一个 13B 训练方案

目标：为 8×80 GB 单节点、13B Transformer 写一份可验证方案，不要求真正训练 13B。

### 第一步：写显存账本

按 16 字节/参数估算普通 DP 模型状态约 208 GB/rank，再分别估算 ZeRO-1/2/3。另列 activation、communication bucket、临时 gather 和 allocator 余量。

### 第二步：选 baseline

用缩小 1000 倍的同结构模型，stage 0、BF16、单卡运行，确认 loss 能下降。记录固定 seed/input 的 output、gradient 和一步参数。

### 第三步：两卡 Stage 2

验证 batch 公式、partition gradient 和 step 后参数一致。开启 comm logger 的短窗口，记录 Reduce-Scatter/All-Gather。

### 第四步：Stage 3

用 `zero.Init` 构造，记录一个 Parameter 的 `ds_shape/ds_tensor/status`；分别调 persistence/prefetch，测峰值与重复 gather。

### 第五步：选择是否 offload

只有聚合 GPU 内存仍不足才加入 CPU offload。用 PCIe/CPU 带宽下界证明预期 step time，再决定是否 NVMe。

### 第六步：Checkpoint

所有 ranks 保存，重新构造 Engine 后恢复；比较下一 update 与无中断参考。记录 client data progress。

### 第七步：性能剖析

将 step 分成 forward、backward compute、reduce、optimizer、gather/offload，报告 warm steady-state tokens/s 与最慢 rank。

### 第八步：可选 DeepCompile

在 eager 正确性稳定后，启用最小 pass，与 reference 比较 forward、gradient、update 和内存。一次只增加一个 pass。

最终报告必须包含假设、配置、源代码入口、正确性证据、性能证据、失败回滚条件，而不是只贴一份 JSON。

## 扩展练习：设计一个新 compile pass

不必先写代码，完成设计审查：

1. 目标图 pattern 是什么；
2. pass 依赖哪些 shape/dtype/parameter metadata；
3. 插入/替换哪些节点；
4. forward 与 backward 怎样配对；
5. process group 在哪里获得；
6. async work 的依赖怎样表达；
7. 与哪些 passes 互斥或有顺序；
8. contract 的 pre/post conditions；
9. reference test、distributed test、memory/perf test；
10. graph break、dynamic shape、recompile 和失败 fallback。

能回答这十项，才进入实现阶段。

## 术语表

| 术语 | 本教程中的精确定义 |
| --- | --- |
| rank | 某 process group 内进程编号；未注明时通常指 global rank |
| local rank | 节点内进程/可见设备编号 |
| world size | 指定 process group 的进程数，不总是全局进程数 |
| DP | 相同模型逻辑处理不同数据，梯度同步 |
| ZeRO | 在 DP ranks 间分片 optimizer/gradient/parameter state |
| TP | 切分单层权重和计算轴 |
| PP | 按连续层切成 pipeline stages |
| SP | 按 sequence/token 轴切 activation/计算 |
| EP | 按专家切 MoE 参数与 token dispatch |
| micro-batch | 每个 DP rank 一次 forward/backward 的样本 |
| GAS | 一个 optimizer update 累积的 micro-steps |
| partition | 某状态由当前 rank 持有的等长/近等长片 |
| shard | 更泛化的分片，可能由 TP/PP/EP/ZeRO 产生 |
| bucket | 为减少消息数/碎片而合并的一批 tensor 数据 |
| master weight | 常用于稳定 optimizer update 的高精度参数副本/片 |
| owner | 负责保存/更新某 partition 的 rank |
| All-Reduce | 所有 ranks 求和/规约且每个 rank 得到结果 |
| Reduce-Scatter | 规约后每 rank 只得到一个结果片 |
| All-Gather | 每 rank 提供一片，所有 rank 得到拼接结果 |
| All-to-All | 每 rank 给每个目标发送不同片，用于重排 |
| offload | 把状态迁到 CPU/NVMe，并在需要时换入 |
| hook | 围绕 module/autograd 事件执行的运行时回调 |
| FX graph | PyTorch 操作的可分析/变换图表示 |
| graph break | Dynamo 无法继续捕获而分成多个 graph/frame |
| AOTAutograd | 提前生成/划分 forward 和 backward 图的机制 |
| pass | 对 GraphModule 的分析或语义保持变换 |

## 源码回顾命令

```bash
rg -n '^def (make_backend|register_compile_pass|run_opt_passes)' \
  deepspeed/compile/backend.py
rg -n '^class CompileConfig|PassName' deepspeed/compile/config.py
rg -n 'register_compile_pass' deepspeed/runtime/engine.py deepspeed/compile
find deepspeed/compile/passes -maxdepth 1 -type f -name '*.py' | sort
```

## 最终自测

1. DeepCompile 为什么需要真实参数身份和 forward/backward graph mapping？
2. 图结构 lint 通过后，为什么仍必须和 eager reference 比较？
3. Activation offload pass 为什么要考虑 tensor liveness，而不只考虑大小？
4. 一个 3D/4D 并行配置中，为什么必须为每个 collective 标出 process group？
5. 你能否从用户 JSON 字段一路追到配置模型、Engine 分支、runtime/pass、collective、测试？

若第五题能对至少一个功能完整画出链路，你已经不再只是“会用 DeepSpeed”，而是具备继续维护和扩展它的读码框架。
