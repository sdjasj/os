# 01. 必要背景：PyTorch 与自回归语言模型

## 1. 从文本预测到分类问题

自回归语言模型把“生成一段文本”拆成重复的多分类问题。给定 token 序列

$$x_0, x_1, \ldots, x_{T-1}$$

模型学习：

$$P(x_1,\ldots,x_{T-1}\mid x_0)=\prod_{t=0}^{T-2}P(x_{t+1}\mid x_{\le t})$$

每个位置输出一个长度为 `V` 的向量 `logits[t]`，代表下一个 token 的未归一化分数。`softmax` 将它变成概率。

MiniMind 在 `model/model_minimind.py:245-253` 中直接实现了因果语言模型损失：

```python
logits = self.lm_head(hidden_states)
x = logits[..., :-1, :].contiguous()
y = labels[..., 1:].contiguous()
loss = F.cross_entropy(
    x.view(-1, x.size(-1)),
    y.view(-1),
    ignore_index=-100,
)
```

为什么位移？位置 `t` 的隐藏状态只看见 `x_0...x_t`，所以应预测 `x_{t+1}`。

示例：

```text
input_ids: [BOS, 我, 爱, 编程, EOS]
模型位置:    0   1   2    3
预测目标:    我  爱  编程  EOS
```

最后一个 logits 没有序列内的下一个目标，因此 `logits[..., :-1, :]` 被丢弃；第一个 label 是当前输入而非下一个目标，因此 `labels[..., 1:]` 被丢弃。

## 2. 必须熟悉的张量操作

### 2.1 `view`、`reshape` 与 `contiguous`

Attention 先把投影结果从 `[B,T,H*d]` 变成 `[B,T,H,d]`：

```python
xq = self.q_proj(x)
xq = xq.view(bsz, seq_len, self.n_local_heads, self.head_dim)
```

`transpose` 只改变视图的步长，结果可能不连续。项目在合并 head 时使用：

```python
output = output.transpose(1, 2).reshape(bsz, seq_len, -1)
```

loss 前显式 `.contiguous()`，保证后面的 `.view()` 可以按连续内存解释。

### 2.2 广播

RMSNorm 中：

```python
x.pow(2).mean(-1, keepdim=True)  # [B,T,1]
self.weight                       # [D]
```

二者都可与 `[B,T,D]` 广播。保留最后一维是为了让归一化系数应用到每个 hidden feature。

### 2.3 `gather`

DPO 需要从 `[B,T,V]` 的所有 token 概率中，取出真实标签对应的一项：

```python
log_probs = F.log_softmax(logits, dim=2)
selected = torch.gather(
    log_probs,
    dim=2,
    index=labels.unsqueeze(2),
).squeeze(-1)  # [B,T]
```

可以把 `gather` 理解为：每个 `(batch, time)` 坐标都拿 `labels[b,t]` 指定的词表下标。

### 2.4 mask

本项目至少有四种 mask，不能混为一谈：

| mask | 典型值 | 作用 |
|---|---|---|
| causal mask | 上三角 `-inf` | 禁止注意未来 token |
| attention mask | 真实 token=1，padding=0 | 禁止读取 padding |
| label mask | 不训练位置=`-100` | 交叉熵忽略 prompt/padding |
| policy/completion mask | 策略动作=1，其余=0 | RL 只更新模型产生的动作 |

## 3. 参数、梯度与优化器

一个最小训练 step：

```python
optimizer.zero_grad()
outputs = model(input_ids, labels=labels)
loss = outputs.loss
loss.backward()
optimizer.step()
```

反向传播计算 `d(loss)/d(parameter)`，`optimizer.step()` 再修改参数。

MiniMind 的 LoRA 训练通过 `requires_grad` 冻结基座：

```python
for name, param in model.named_parameters():
    if 'lora' in name:
        param.requires_grad = True
        lora_params.append(param)
    else:
        param.requires_grad = False
optimizer = optim.AdamW(lora_params, lr=args.learning_rate)
```

冻结的意义不只是优化器不更新；它还避免为这些参数存储梯度，降低内存开销。

## 4. 交叉熵、困惑度和日志

单个位置的负对数似然：

$$\mathcal L_t=-\log P(y_t\mid x_{\le t})$$

交叉熵是有效位置上的平均值。困惑度：

$$\mathrm{PPL}=e^{\mathcal L}$$

例如 loss 为 `2.0` 时 PPL 约为 `7.39`。它可理解为模型在每一步平均像是在约 7.39 个等可能候选中选择，但这种解释只是直觉。跨 tokenizer、数据集或 mask 策略直接比较 PPL 往往不公平。

## 5. AdamW、学习率和梯度裁剪

训练脚本使用 `AdamW`。它为参数维护一阶/二阶动量，所以断点续训必须保存 optimizer state，仅保存模型权重不能做到严格续训。

`trainer/trainer_utils.py:40-41` 的学习率是余弦下降：

```python
def get_lr(current_step, total_steps, lr):
    return lr * (0.1 + 0.45 * (
        1 + math.cos(math.pi * current_step / total_steps)
    ))
```

开始约为 `lr`，结束约为 `0.1*lr`。这里没有 warmup；在大模型训练中 warmup 很常见，但该项目选择保持实现简洁。

梯度裁剪：

```python
torch.nn.utils.clip_grad_norm_(model.parameters(), args.grad_clip)
```

它按全局范数缩放过大的梯度，主要用于降低突发梯度导致训练发散的风险。

## 6. 梯度累积

显存放不下大 batch 时，把多个 micro-batch 的梯度相加：

```python
loss = loss / args.accumulation_steps
scaler.scale(loss).backward()
if step % args.accumulation_steps == 0:
    scaler.step(optimizer)
    optimizer.zero_grad(set_to_none=True)
```

单卡有效 batch size 近似：

$$B_{effective}=B_{micro}\times N_{accumulation}$$

DDP 下再乘 GPU 数量。loss 必须除以累积步数，否则梯度规模会随累积次数线性增大。

## 7. 混合精度

训练脚本区分：

```python
dtype = torch.bfloat16 if args.dtype == 'bfloat16' else torch.float16
autocast_ctx = nullcontext() if device_type == 'cpu' \
    else torch.cuda.amp.autocast(dtype=dtype)
scaler = torch.cuda.amp.GradScaler(enabled=(args.dtype == 'float16'))
```

- FP32：范围和精度较好，显存最大。
- FP16：范围较小，通常需要 GradScaler 防止梯度下溢。
- BF16：指数范围接近 FP32，一般更稳定；需要硬件支持。

模型内部的 RMSNorm 和 attention softmax 主动转到 float：

```python
self.norm(x.float()).type_as(x)
F.softmax(scores.float(), dim=-1).type_as(xq)
```

这是典型数值稳定性处理：敏感运算用 FP32，结果再转回低精度。

## 8. DDP 的基本心智模型

`torchrun` 为每张 GPU 启动一个进程。每个进程：

1. 持有一份完整模型；
2. 读取不同数据分片；
3. backward 时通过 collective communication 同步梯度；
4. 每个进程执行相同 optimizer step，因此参数保持一致。

项目的初始化在 `trainer/trainer_utils.py:44-51`：

```python
dist.init_process_group(backend='nccl')
local_rank = int(os.environ['LOCAL_RANK'])
torch.cuda.set_device(local_rank)
```

只有 rank 0 打印和保存，避免多个进程互相覆盖文件。`DistributedSampler.set_epoch(epoch)` 则保证各 epoch 的分片随机顺序正确变化。

## 9. 动手验证

在仓库根目录运行一个不依赖数据集的形状实验：

```bash
python - <<'PY'
import torch
from model.model_minimind import MiniMindConfig, MiniMindForCausalLM

cfg = MiniMindConfig(hidden_size=64, num_hidden_layers=2,
                     num_attention_heads=4, num_key_value_heads=2,
                     vocab_size=100, max_position_embeddings=128,
                     flash_attn=False)
model = MiniMindForCausalLM(cfg)
x = torch.randint(0, 100, (2, 12))
labels = x.clone()
labels[:, :4] = -100
out = model(x, labels=labels)
print('logits:', tuple(out.logits.shape))  # (2, 12, 100)
print('loss:', float(out.loss))
out.loss.backward()
print('embedding grad:', model.model.embed_tokens.weight.grad.norm().item())
PY
```

思考题：

1. 把全部 `labels` 设为 `-100` 会发生什么？为什么训练数据必须至少保留一个有效目标？
2. 把 `flash_attn=False` 改成 `True`，相同随机种子下训练模式的结果是否必然逐位相同？
3. 有效 batch size 增大四倍后，学习率是否一定也应增大四倍？为什么这只能是经验起点而非定律？
