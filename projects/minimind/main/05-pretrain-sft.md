# 05. 预训练、SFT 与训练工程

## 1. Pretrain 和 SFT 的共同骨架

`train_pretrain.py` 与 `train_full_sft.py` 的训练循环几乎相同：

```python
for step, (input_ids, labels) in enumerate(loader):
    lr = get_lr(...)
    with autocast_ctx:
        res = model(input_ids, labels=labels)
        loss = (res.loss + res.aux_loss) / accumulation_steps
    scaler.scale(loss).backward()
    if step % accumulation_steps == 0:
        scaler.unscale_(optimizer)
        clip_grad_norm_(model.parameters(), grad_clip)
        scaler.step(optimizer)
        scaler.update()
        optimizer.zero_grad(set_to_none=True)
```

两者都在做 next-token cross entropy。能力差异主要来自数据分布和 label mask：

| 项目 | Pretrain | SFT |
|---|---|---|
| 数据 | 普通文本 `text` | 结构化 `conversations` |
| 模板 | BOS + 文本 + EOS | Chat Template |
| 监督位置 | 全部正文 token | assistant token |
| 初始权重 | 默认从随机初始化 | 默认加载 pretrain |
| 默认学习率 | `5e-4` | `1e-5` |
| 目标能力 | 语言与知识基座 | 指令跟随和角色协议 |

## 2. 预训练为何能学知识

模型没有显式知识库。大量上下文条件预测迫使参数压缩统计规律：语法、实体关系、常见事实、文体和推理模式。训练样本中的每个有效 token 都成为目标，所以 token 利用率高。

但 next-token loss 低不保证事实可靠：它优化的是训练分布上的概率，不是事实数据库的一致性。

## 3. SFT 为何能学会回答

SFT 把对话前缀作为条件，只惩罚 assistant 输出。目标可写为：

$$\mathcal L_{SFT}=-\sum_{t\in assistant}\log P_\theta(y_t\mid prompt,y_{<t})$$

模型由此学习：

- 在 assistant 起始标记之后才回答；
- 遵循 system/user 指令；
- 生成结束标记；
- 根据模板输出 think/tool 等协议；
- 模仿数据中的风格和任务行为。

SFT 仍可能引入新知识，但小规模垂直数据也可能造成灾难性遗忘，所以需混入通用数据并做回归评测。

## 4. 入口脚本的九个阶段

两个主训练脚本都清晰分为：

1. 初始化 DDP 与随机种子；
2. 构建 config，检查 resume checkpoint；
3. 配置 autocast 和 GradScaler；
4. 初始化 SwanLab（代码中变量沿用 `wandb`）；
5. 加载模型、tokenizer、dataset、optimizer；
6. 恢复模型/优化器/scaler/epoch/step；
7. 可选 `torch.compile`，再包 DDP；
8. 构建 loader 并训练；
9. barrier 后销毁进程组。

读其他训练脚本时也可用这个框架定位差异。

## 5. 模型初始化与权重命名

`trainer_utils.init_model`：

```python
model = MiniMindForCausalLM(lm_config)
if from_weight != 'none':
    weight_path = f'{save_dir}/{from_weight}_{hidden_size}{moe_suffix}.pth'
    weights = torch.load(weight_path, map_location=device)
    model.load_state_dict(weights, strict=False)
```

典型文件：

```text
out/pretrain_768.pth
out/full_sft_768.pth
out/full_sft_768_moe.pth
```

`strict=False` 允许缺失或多余 key，但不能解决相同 key 的 shape 不匹配，也不保证缺失权重具有正确语义。加载后应检查日志和评测结果。

## 6. Checkpoint 有两种用途

项目同时保存：

1. `out/<weight>_<dim>.pth`：轻量模型 state dict，适合推理或作为下一阶段初始权重；
2. `checkpoints/<weight>_<dim>_resume.pth`：模型、optimizer、scaler/scheduler、epoch、step、world size、实验 id，适合续训。

`lm_checkpoint` 用临时文件加 `os.replace`：

```python
torch.save(data, path + '.tmp')
os.replace(path + '.tmp', path)
```

这比直接覆盖更能避免进程中断留下半个 checkpoint。

GPU 数量改变时，代码按 `saved_world_size/current_world_size` 调整 step。它保持近似已消费样本量，但如果 batch size 或数据顺序也改变，不能视为逐样本完全一致的恢复。

## 7. `SkipBatchSampler` 如何续到中间 step

恢复到 epoch 中部时，不能只恢复 step 计数而从头读取数据。`SkipBatchSampler` 先构造相同顺序的 batch，再跳过前 `skip_batches` 批。

为了可复现，主循环每个 epoch 固定：

```python
setup_seed(42 + epoch)
indices = torch.randperm(len(train_ds)).tolist()
```

但 `SFTDataset` 自身还包含随机添加 system/think 的增强；worker 数、调用顺序改变时，逐样本增强结果未必完全一致。这里的断点续训更偏工程恢复而非严格数值复现。

## 8. 数据吞吐与显存

Transformer 训练显存主要来自：

- 模型参数；
- 梯度；
- AdamW 的一阶/二阶状态；
- 每层激活；
- attention 中间量；
- batch 和临时 logits `[B,T,V]`。

降低显存的优先顺序通常是：

1. 减少 `max_seq_len`；attention 显式实现部分随 `T^2` 增长；
2. 减少 micro batch，增加 accumulation；
3. 使用 BF16/FP16；
4. 减小 hidden size 或层数；
5. 使用参数高效微调；
6. 再考虑 checkpointing、ZeRO 等项目当前未直接实现的优化。

## 9. 单卡与多卡命令

训练脚本的默认数据路径以 `trainer/` 为当前目录：

```bash
(cd trainer && python train_pretrain.py)
(cd trainer && python train_full_sft.py)
```

单机两卡：

```bash
(cd trainer && torchrun --nproc_per_node 2 train_pretrain.py)
```

教程推荐括号子 shell，命令结束后仍回到仓库根目录。

## 10. 先做 smoke test

不要直接用默认大配置验证自定义链路。准备几条数据后，缩小模型和序列：

```bash
(cd trainer && python train_pretrain.py \
  --hidden_size 64 \
  --num_hidden_layers 2 \
  --max_seq_len 64 \
  --batch_size 2 \
  --accumulation_steps 1 \
  --num_workers 0 \
  --epochs 1 \
  --log_interval 1 \
  --save_interval 2 \
  --data_path ../dataset/your_tiny_pretrain.jsonl \
  --save_dir ../out-smoke)
```

注意：后续 SFT 的 config 必须与此权重一致，并把 `--save_dir`、基础权重路径约定对齐。当前 `init_model` 默认固定从 `../out` 加载基础权重，若使用自定义目录，需要相应调整代码或把 smoke 权重放到预期位置。

## 11. 训练指标如何读

日志拆分：

```text
loss = logits_loss + aux_loss
```

Dense 模型 aux 为 0。观察：

- loss 是否总体下降；
- 是否出现 NaN/Inf；
- 学习率是否按预期变化；
- token/s 与 GPU 利用率；
- 训练样本渲染是否正确；
- 固定验证 prompt 是否逐渐改善，而非只看训练 loss。

SFT loss 很低也可能只是回答模板过于重复。应保留未训练验证集，至少比较 held-out loss 和任务输出。

## 12. 常见故障定位

### `FileNotFoundError: ../model`

通常是从仓库根目录直接运行训练脚本，默认相对路径错位。使用 `(cd trainer && python ...)`。

### CUDA OOM

先减 `max_seq_len`，再减 `batch_size` 并增大 `accumulation_steps`。OOM 后重启进程比在碎片化显存上反复试更可靠。

### loss 为 NaN

检查：是否出现全 `-100` labels、FP16 溢出、学习率过高、数据异常、除零、无有效 completion mask。

### SFT 只复述用户问题

打印真实 `labels`。常见原因是 assistant 起止 token 没匹配上，或错误地监督了 user 区间。

### 权重加载 shape mismatch

核对 hidden size、层数、Dense/MoE、词表大小、attention head 配置。文件名只编码了 hidden size 和 MoE，不编码其他结构字段。

## 13. 建议实验

1. 固定数据与种子，分别令 accumulation 为 1/4，比较单次 optimizer step 前的梯度范数。
2. 对同一批 SFT 样本，比较 assistant-only loss 与全 token loss 的变化。
3. 记录 `T=64/128/256` 的峰值显存和 step 时间，观察序列长度影响。
4. 故意停止训练后用 `--from_resume 1` 恢复，核对 epoch/step、学习率和权重文件。

## 14. 本章检查题

1. 为什么 SFT 学习率默认远低于从零预训练？
2. 只有模型 `.pth` 时为什么不能严格恢复 AdamW 训练？
3. DDP 两卡、micro batch 8、accumulation 4 时有效 batch 约是多少？
4. `optimizer.zero_grad()` 为什么只在 optimizer step 后执行，而不是每个 micro-batch 后执行？
