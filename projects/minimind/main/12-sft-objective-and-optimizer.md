# 12. SFT 优化目标与 AdamW 参数更新详解

本章基于 MiniMind 当前源码，完整拆解监督微调（Supervised Fine-Tuning，SFT）的优化过程。这里的“优化函数”包含两个不同层次：

1. **目标函数（loss function）**：只监督 assistant 输出 token 的自回归交叉熵。
2. **参数优化器（optimizer）**：使用 AdamW 根据梯度更新模型参数。

MiniMind 的完整 SFT 调用链为：

```text
对话数据
  -> Chat Template
  -> input_ids
  -> assistant-only labels
  -> 模型 logits
  -> 因果位移
  -> Cross Entropy
  -> 可选的 MoE auxiliary loss
  -> backward
  -> AdamW 更新参数
```

## 1. SFT 在优化什么

设用户输入和其他上下文为 $x$，assistant 的标准回答为：

$$
y=(y_1,y_2,\ldots,y_T)
$$

SFT 最小化负对数似然：

$$
\mathcal L_{\mathrm{SFT}}
=
-\frac{1}{T}\sum_{t=1}^{T}
\log P_\theta(y_t\mid x,y_{<t})
$$

这表示模型需要在看到问题和答案前缀后，提高标准答案下一个 token 的概率。

例如有一条对话：

```text
user: 中国的首都是哪里？
assistant: 北京。
```

训练任务可展开为：

```text
看到“用户问题 + assistant:”        -> 预测“北”
看到“用户问题 + assistant: 北”     -> 预测“京”
看到“用户问题 + assistant: 北京”   -> 预测“。”
看到“用户问题 + assistant: 北京。” -> 预测 EOS
```

SFT 使用 teacher forcing：训练时标准答案的历史 token 已经放入输入，模型不需要在训练阶段重新采样整段回答。

## 2. 训练入口

SFT 训练入口是 `trainer/train_full_sft.py`。训练循环从 DataLoader 取得 `input_ids` 和 `labels`：

```python
# trainer/train_full_sft.py:24-38
def train_epoch(epoch, loader, iters, start_step=0, wandb=None):
    for step, (input_ids, labels) in enumerate(loader, start=start_step + 1):
        input_ids = input_ids.to(args.device)
        labels = labels.to(args.device)

        with autocast_ctx:
            res = model(input_ids, labels=labels)
            loss = res.loss + res.aux_loss
            loss = loss / args.accumulation_steps
```

其中：

- `input_ids` 是完整的 system、user、assistant 和 tool 对话序列。
- `labels` 决定哪些位置参与交叉熵。
- `res.loss` 是 assistant token 的交叉熵。
- `res.aux_loss` 是可选的 MoE 专家负载均衡损失。

## 3. 对话如何变成 input_ids

数据集定义在 `dataset/lm_dataset.py:58-119`：

```python
class SFTDataset(Dataset):
    def create_chat_prompt(self, conversations):
        messages = []
        tools = None

        for message in conversations:
            message = dict(message)
            if message.get("role") == "system" and message.get("tools"):
                tools = json.loads(message["tools"]) \
                    if isinstance(message["tools"], str) else message["tools"]
            if message.get("tool_calls") and isinstance(message["tool_calls"], str):
                message["tool_calls"] = json.loads(message["tool_calls"])
            messages.append(message)

        return self.tokenizer.apply_chat_template(
            messages,
            tokenize=False,
            add_generation_prompt=False,
            tools=tools
        )
```

Chat Template 的作用是把结构化消息转换成模型实际看到的角色协议文本。随后进行 tokenizer、截断和右侧 padding：

```python
# dataset/lm_dataset.py:106-113
sample = self.samples[index]
conversations = pre_processing_chat(sample['conversations'])
prompt = self.create_chat_prompt(conversations)
prompt = post_processing_chat(prompt)

input_ids = self.tokenizer(prompt).input_ids[:self.max_length]
input_ids += [self.tokenizer.pad_token_id] * (
    self.max_length - len(input_ids)
)

labels = self.generate_labels(input_ids)
```

概念上，一条序列可能是：

```text
<system> 你是一个助手 <EOS>
<user> 中国的首都是哪里？ <EOS>
<assistant> 北京。 <EOS>
<PAD> <PAD> ...
```

模型需要看到整个上下文，但不是所有 token 都应当成为监督目标。

## 4. assistant-only labels

MiniMind 先把全部 label 设置成 `-100`，再找出每一段 assistant 内容：

```python
# dataset/lm_dataset.py:88-104
def generate_labels(self, input_ids):
    labels = [-100] * len(input_ids)
    i = 0

    while i < len(input_ids):
        if input_ids[i:i + len(self.bos_id)] == self.bos_id:
            start = i + len(self.bos_id)
            end = start

            while end < len(input_ids):
                if input_ids[end:end + len(self.eos_id)] == self.eos_id:
                    break
                end += 1

            for j in range(
                start,
                min(end + len(self.eos_id), self.max_length)
            ):
                labels[j] = input_ids[j]

            i = end + len(self.eos_id) if end < len(input_ids) else len(input_ids)
        else:
            i += 1

    return labels
```

标签大致如下：

| token 类型 | `input_ids` | `labels` | 是否参与 loss |
|---|---:|---:|---|
| system 角色和内容 | 实际 token id | `-100` | 否 |
| user 角色和内容 | 实际 token id | `-100` | 否 |
| assistant 角色前缀 | 实际 token id | `-100` | 否 |
| assistant 回答内容 | 实际 token id | 同 `input_ids` | 是 |
| assistant 结束标记 | 实际 token id | 同 `input_ids` | 是 |
| padding | pad token id | `-100` | 否 |

PyTorch 的 `F.cross_entropy(..., ignore_index=-100)` 会完全跳过 `-100` 位置。因此 user 和 system 虽然作为条件输入模型，却不会被当作需要模型复述的目标。

多轮对话中，`generate_labels` 会扫描所有 assistant 区间，所以每一轮 assistant 内容都会参与训练。

## 5. 从 hidden state 到 logits

模型前向位于 `model/model_minimind.py:245-253`：

```python
def forward(
    self,
    input_ids,
    attention_mask=None,
    past_key_values=None,
    use_cache=False,
    logits_to_keep=0,
    labels=None,
    **kwargs
):
    hidden_states, past_key_values, aux_loss = self.model(
        input_ids,
        attention_mask,
        past_key_values,
        use_cache,
        **kwargs
    )

    slice_indices = slice(-logits_to_keep, None) \
        if isinstance(logits_to_keep, int) else logits_to_keep
    logits = self.lm_head(hidden_states[:, slice_indices, :])
```

设：

```text
B = batch size
L = sequence length
H = hidden size
V = vocabulary size
```

张量形状为：

```text
input_ids      [B, L]
hidden_states  [B, L, H]
lm_head.weight [V, H]
logits         [B, L, V]
```

`logits[b, t]` 表示模型在位置 `t` 得到的词表预测分数。

## 6. 因果位移

模型不能用位置 `t` 的输出预测位置 `t` 自己，而是用前面的上下文预测下一个 token。源码进行了一位因果位移：

```python
# model/model_minimind.py:249-252
if labels is not None:
    x = logits[..., :-1, :].contiguous()
    y = labels[..., 1:].contiguous()

    loss = F.cross_entropy(
        x.view(-1, x.size(-1)),
        y.view(-1),
        ignore_index=-100
    )
```

假设：

```python
input_ids = [10, 20, 30, 40, 50]
```

预测对应关系是：

```text
logits[0] -> 预测 input_ids[1]，即 token 20
logits[1] -> 预测 input_ids[2]，即 token 30
logits[2] -> 预测 input_ids[3]，即 token 40
logits[3] -> 预测 input_ids[4]，即 token 50
```

所以需要：

```python
x = logits[:, :-1, :]
y = labels[:, 1:]
```

如果标准回答第一个 token 位于 `input_ids[p]`，真正预测它的是 `logits[p-1]`。

## 7. 交叉熵的具体含义

对某个有效 assistant 位置，模型产生整个词表上的 logits。假设目标 token 是“北京”，softmax 后得到：

```text
P(北京) = 0.82
P(上海) = 0.11
P(中国) = 0.04
其他候选概率之和 = 0.03
```

该 token 的负对数似然是：

$$
-\log P(北京)=-\log 0.82\approx0.198
$$

如果模型只给标准 token `0.01` 的概率：

$$
-\log 0.01\approx4.605
$$

所以标准 token 概率越高，交叉熵越低；标准 token 概率越低，惩罚越大。

`F.cross_entropy` 默认使用 `reduction="mean"`。设 batch 内因果位移后共有 $N$ 个非 `-100` 标签，则：

$$
\mathcal L_{\mathrm{SFT}}
=
-\frac{1}{N}
\sum_{i:y_i\ne-100}
\log P_\theta(y_i\mid y_{<i})
$$

这是按有效 token 求平均，不是先按样本分别平均。因此较长回答包含更多有效 token，对一个 batch 的总监督贡献也更多。

## 8. 为什么 user token 不算 loss 仍然有作用

虽然 user 和 system 的标签是 `-100`，它们仍然存在于 `input_ids` 中，并通过注意力影响 assistant 位置的 hidden state：

```text
user/system token
    -> 作为上下文进入 Transformer
    -> 改变 assistant 位置的 hidden state
    -> 改变 assistant token 的 logits
    -> 影响 assistant-only cross entropy
```

也就是说，`-100` 只表示“不直接要求模型预测这个位置”，不表示“这个 token 从输入中删除”。

## 9. Dense 与 MoE 的总损失

训练脚本使用：

```python
res = model(input_ids, labels=labels)
loss = res.loss + res.aux_loss
```

Dense 模型中 `aux_loss=0`：

$$
\mathcal L_{\mathrm{total}}=\mathcal L_{\mathrm{SFT}}
$$

启用 `--use_moe 1` 后，模型还会计算专家负载均衡辅助损失。代码位于 `model/model_minimind.py:171-175`：

```python
load = F.one_hot(
    topk_idx,
    self.config.num_experts
).float().mean(0)

self.aux_loss = (
    load * scores.mean(0)
).sum() * self.config.num_experts \
    * self.config.router_aux_loss_coef
```

总目标变为：

$$
\mathcal L_{\mathrm{total}}
=
\mathcal L_{\mathrm{SFT}}
+
\mathcal L_{\mathrm{MoE\ aux}}
$$

这个辅助项约束路由器不要把绝大多数 token 都送进少数专家。

## 10. AdamW 优化器

优化器在 `trainer/train_full_sft.py:134-139` 初始化：

```python
model, tokenizer = init_model(
    lm_config,
    args.from_weight,
    device=args.device
)

optimizer = optim.AdamW(
    model.parameters(),
    lr=args.learning_rate
)
```

传入 `model.parameters()` 表示所有可训练模型参数都会被更新，因此脚本叫 `full_sft`。这与只训练低秩矩阵的 LoRA 不同。

当前 `deepspeed` 环境使用 PyTorch 2.5.1。由于源码只显式传入学习率，AdamW 的其他参数使用 PyTorch 默认值：

```text
learning_rate = 1e-5       # train_full_sft.py 默认配置
betas         = (0.9, 0.999)
eps           = 1e-8
weight_decay  = 0.01
amsgrad       = False
```

对当前梯度 $g_t$，AdamW 首先维护一阶矩和二阶矩：

$$
m_t=\beta_1m_{t-1}+(1-\beta_1)g_t
$$

$$
v_t=\beta_2v_{t-1}+(1-\beta_2)g_t^2
$$

经过偏差修正后：

$$
\hat m_t=\frac{m_t}{1-\beta_1^t},\qquad
\hat v_t=\frac{v_t}{1-\beta_2^t}
$$

参数更新可以概念化为：

$$
\theta_t
\leftarrow
\theta_{t-1}
-\eta\frac{\hat m_t}{\sqrt{\hat v_t}+\epsilon}
-\eta\lambda\theta_{t-1}
$$

其中：

- 一阶矩估计梯度的平滑方向。
- 二阶矩估计梯度尺度，使不同参数获得自适应步长。
- `weight_decay` 与梯度更新解耦，直接对权重做衰减。
- `eps` 防止分母接近零。

## 11. 学习率调度

MiniMind 没有使用 PyTorch scheduler，而是在每个 batch 手工设置学习率：

```python
# trainer/train_full_sft.py:31-33
lr = get_lr(
    epoch * iters + step,
    args.epochs * iters,
    args.learning_rate
)

for param_group in optimizer.param_groups:
    param_group['lr'] = lr
```

`get_lr` 位于 `trainer/trainer_utils.py:40-41`：

```python
def get_lr(current_step, total_steps, lr):
    return lr * (
        0.1
        + 0.45 * (
            1 + math.cos(
                math.pi * current_step / total_steps
            )
        )
    )
```

训练初期约为基础学习率的 `1.0` 倍，训练末期约为 `0.1` 倍：

```text
训练开始：lr ≈ 1.0 × learning_rate
训练结束：lr ≈ 0.1 × learning_rate
```

这是没有 warmup 的 cosine decay。

## 12. 混合精度与 GradScaler

训练脚本根据 `dtype` 创建自动混合精度上下文：

```python
device_type = "cuda" if "cuda" in args.device else "cpu"
dtype = torch.bfloat16 if args.dtype == "bfloat16" else torch.float16
autocast_ctx = nullcontext() if device_type == "cpu" \
    else torch.cuda.amp.autocast(dtype=dtype)
```

只有 float16 开启 GradScaler：

```python
scaler = torch.cuda.amp.GradScaler(
    enabled=(args.dtype == 'float16')
)
```

原因是 float16 的动态范围较小，小梯度可能下溢为零。GradScaler 先放大 loss 和梯度，更新前再恢复原尺度：

```python
scaler.scale(loss).backward()
scaler.unscale_(optimizer)
scaler.step(optimizer)
scaler.update()
```

bfloat16 具有与 float32 相同数量级的指数范围，通常不需要 loss scaling。

## 13. 梯度累积

源码先缩放每个 micro-batch 的 loss：

```python
loss = loss / args.accumulation_steps
scaler.scale(loss).backward()
```

达到累积步数后才更新：

```python
if step % args.accumulation_steps == 0:
    scaler.unscale_(optimizer)
    torch.nn.utils.clip_grad_norm_(
        model.parameters(),
        args.grad_clip
    )
    scaler.step(optimizer)
    scaler.update()
    optimizer.zero_grad(set_to_none=True)
```

单进程下的有效 batch size 近似为：

$$
B_{\mathrm{effective}}
=
B_{\mathrm{micro}}
\times
N_{\mathrm{accumulation}}
$$

DDP 下还需乘以进程数：

$$
B_{\mathrm{effective}}
=
B_{\mathrm{micro}}
\times
N_{\mathrm{accumulation}}
\times
N_{\mathrm{world}}
$$

例如：

```text
batch_size=4
accumulation_steps=8
world_size=2
```

有效 batch size 约为：

```text
4 × 8 × 2 = 64
```

## 14. 梯度裁剪

优化前执行：

```python
torch.nn.utils.clip_grad_norm_(
    model.parameters(),
    args.grad_clip
)
```

默认：

```text
grad_clip = 1.0
```

如果全部参数梯度的全局范数超过 `1.0`，PyTorch 会按比例缩小梯度方向，而不是逐元素截断。梯度裁剪主要用于避免异常 batch 或长序列导致更新幅度突然爆炸。

## 15. 一次参数更新的完整过程

把源码组合起来，一次 optimizer update 可以写成：

```python
optimizer.zero_grad(set_to_none=True)

for _ in range(accumulation_steps):
    input_ids, labels = next(loader)

    with autocast_ctx:
        outputs = model(input_ids, labels=labels)
        total_loss = outputs.loss + outputs.aux_loss
        scaled_micro_loss = total_loss / accumulation_steps

    scaler.scale(scaled_micro_loss).backward()

scaler.unscale_(optimizer)
torch.nn.utils.clip_grad_norm_(model.parameters(), grad_clip)
scaler.step(optimizer)
scaler.update()
optimizer.zero_grad(set_to_none=True)
```

从因果关系看：

```text
标准 assistant token
  -> cross entropy
  -> 对正确 token 的 logit 产生梯度
  -> 梯度穿过 lm_head、Transformer、Embedding
  -> AdamW 更新全部模型参数
  -> 下次遇到相似上下文时，标准回答 token 概率提高
```

## 16. SFT 与预训练的关键差异

预训练和 SFT 都使用 next-token cross entropy，模型内部甚至复用同一段 loss 代码。主要差异来自标签范围：

| 项目 | 预训练 | SFT |
|---|---|---|
| 输入 | 普通连续文本 | 带角色协议的对话 |
| 有效标签 | 除 padding 外几乎所有 token | 仅 assistant 内容和结束标记 |
| 学习目标 | 学习通用文本分布 | 学习条件回答和指令遵循 |
| 默认基础权重 | 从零或已有预训练权重 | `pretrain` |
| 默认学习率 | 通常较大 | `1e-5` |

`SFTDataset` 中的 assistant-only mask 是“同样的交叉熵为什么会学出聊天行为”的关键。

## 17. 运行方式

本项目教程约定使用 `deepspeed` conda 环境：

```bash
conda activate deepspeed
cd /path/to/minimind/trainer
python train_full_sft.py
```

默认关键参数为：

```text
epochs             = 2
batch_size          = 16
learning_rate       = 1e-5
accumulation_steps  = 1
grad_clip           = 1.0
max_seq_len         = 768
from_weight         = pretrain
data_path           = ../dataset/sft_t2t_mini.jsonl
```

运行前需要确保基础权重路径存在：

```text
../out/pretrain_768.pth
```

## 18. 建议的源码验证实验

可以取消 `SFTDataset.__getitem__` 中已有的调试打印注释：

```python
for i, (x, y) in enumerate(zip(input_ids[:-1], labels[1:])):
    print(
        f"{i:3d}: "
        f"X={self.tokenizer.decode([x])!r:16s} "
        f"---> Y={self.tokenizer.decode([input_ids[i+1]])!r} "
        f"label={y}"
    )
```

观察时应确认：

1. user/system token 对应的 label 是 `-100`。
2. assistant 第一个内容 token 的预测位置比它自身早一位。
3. assistant 内容和 EOS 的 label 是真实 token id。
4. padding label 是 `-100`。
5. 多轮对话中的每个 assistant 区间都被选中。

## 19. 总结

MiniMind 的 SFT 优化目标可以概括为：

$$
\boxed{
\text{assistant-only next-token cross entropy}
+
\text{optional MoE load-balancing loss}
}
$$

参数更新过程是：

```text
交叉熵计算 assistant token 的预测误差
  -> 混合精度 backward
  -> 多个 micro-batch 梯度累积
  -> 全局梯度范数裁剪
  -> AdamW 全参数更新
  -> cosine learning-rate decay
```

理解 SFT 时最重要的不是只记住“用了交叉熵”，而是同时确认三件事：

1. 哪些 token 的 label 不是 `-100`。
2. `logits[..., :-1, :]` 与 `labels[..., 1:]` 如何对齐。
3. loss 的梯度最终更新了哪些参数。
