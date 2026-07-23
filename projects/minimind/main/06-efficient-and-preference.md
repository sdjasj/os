# 06. LoRA、知识蒸馏与 DPO

这三种方法都发生在预训练/SFT 之后，但目标不同：

| 方法 | 学习信号 | 训练对象 | 是否需要第二模型 |
|---|---|---|---|
| LoRA | 与 SFT 相同的标签 | 低秩增量参数 | 否 |
| 白盒蒸馏 | 标签 + 教师 token 分布 | 学生全部参数 | 是，Teacher |
| DPO | chosen/rejected 偏好对 | Policy 全部参数 | 是，冻结 Reference |

## 1. LoRA 的数学

原线性层：

$$y=Wx$$

LoRA 不直接更新 `W`，而学习低秩增量：

$$y=Wx+BAx$$

其中 `A: in -> r`，`B: r -> out`，且 `r` 远小于输入输出维度。新增参数量是：

$$r\times in + out\times r$$

远小于完整 `out*in`。

## 2. 项目如何注入 LoRA

`model/model_lora.py:21-32` 遍历方形线性层：

```python
if isinstance(module, nn.Linear) \
        and module.in_features == module.out_features:
    lora = LoRA(in_features, out_features, rank=rank)
    original_forward = module.forward
    def forward_with_lora(x, layer1=original_forward, layer2=lora):
        return layer1(x) + layer2(x)
    module.forward = forward_with_lora
```

当前规则只给 `in_features == out_features` 的 Linear 注入，不是所有 Q/K/V/FFN 层都会注入。对默认 GQA：

- `q_proj: D -> D`，注入；
- `o_proj: D -> D`，注入；
- `k_proj/v_proj: D -> H_kv*d`，通常不注入；
- FFN 各层通常非方形，不注入。

这是项目自己的简化策略，不应泛化成所有 LoRA 实现的固定做法。

## 3. 初始化为什么不破坏原模型

`A` 高斯初始化，`B` 全零：

```python
self.A.weight.normal_(0, 0.02)
self.B.weight.zero_()
```

初始 `BAx=0`，所以注入瞬间输出与基座相同。训练后 B 离开零点，低秩分支开始产生增量。

## 4. 训练、保存与合并

`train_lora.py:139-152` 冻结非 LoRA 参数，optimizer 只接收 `lora_params`。保存时只提取 `.lora.` state dict，因此 adapter 文件很小。

合并公式直接体现在 `merge_lora`：

```python
merged_weight = module.weight + module.lora.B.weight @ module.lora.A.weight
```

合并后不再需要 monkey patch，适合部署和导出。项目没有额外 `alpha/rank` 缩放，因此它就是未经缩放的 `BA`。

### 实验：确认初始输出一致

```bash
python - <<'PY'
import torch
from model.model_minimind import MiniMindConfig, MiniMindForCausalLM
from model.model_lora import apply_lora
torch.manual_seed(0)
m = MiniMindForCausalLM(MiniMindConfig(hidden_size=64,
    num_hidden_layers=1, num_attention_heads=4,
    num_key_value_heads=2, vocab_size=100,
    max_position_embeddings=32)).eval()
x = torch.randint(0, 100, (1, 8))
with torch.no_grad(): before = m(x).logits
apply_lora(m, rank=4)
with torch.no_grad(): after = m(x).logits
print('max diff:', (before-after).abs().max().item())
print([n for n,p in m.named_parameters() if 'lora' in n][:8])
PY
```

`train_lora.py` 主动关闭 `torch.compile`，因为动态替换 `forward` 的 monkey patch 与编译不兼容。

## 5. 知识蒸馏背景

硬标签只告诉学生正确 token 是谁。教师分布还告诉它次优 token 的相对合理性，例如：

```text
teacher: “北京” 0.70, “上海” 0.15, “中国” 0.10, ...
hard label: “北京” 1, 其他 0
```

温度 `T` 软化分布：

$$p_i^{(T)}=\frac{e^{z_i/T}}{\sum_j e^{z_j/T}}$$

`T>1` 让非最大 token 概率更明显，暴露“暗知识”。

## 6. 项目的蒸馏损失

`train_distillation.py:25-36`：

```python
teacher_probs = softmax(teacher_logits / T).detach()
student_log_probs = log_softmax(student_logits / T)
kl = kl_div(student_log_probs, teacher_probs,
            reduction='batchmean')
return T**2 * kl
```

### 输入张量表示什么

传入 `distillation_loss` 前，训练循环已经完成因果位移，并使用 `loss_mask` 只保留 assistant token：

```python
loss_mask = (labels[..., 1:] != -100).float()
student_logits = model(input_ids).logits[..., :-1, :]
teacher_logits = teacher_model(input_ids).logits[..., :-1, :]

distill_loss = distillation_loss(
    student_logits.view(-1, student_logits.size(-1))[loss_mask.view(-1) == 1],
    teacher_logits.view(-1, teacher_logits.size(-1))[loss_mask.view(-1) == 1],
    temperature=T
)
```

设有效 assistant token 总数为 `N`，词表大小为 `V`，则：

```text
teacher_logits  [N, V]
student_logits  [N, V]
```

每一行不是一个 token id，而是模型在某个位置对全部 `V` 个候选 token 给出的未归一化分数。普通 SFT 只告诉学生标准 token 是谁；白盒蒸馏还告诉学生教师如何给其他候选 token 分配概率。

### 温度如何软化分布

教师概率的计算是：

$$
p_i^{(T)}
=
\frac{\exp(z_i^{teacher}/T)}
{\sum_j\exp(z_j^{teacher}/T)}
$$

假设教师在某个位置的 logits 是：

```python
teacher_logits = [8.0, 4.0, 2.0]
```

当 `T=1` 时：

```text
softmax([8, 4, 2]) ≈ [0.980, 0.018, 0.002]
```

教师几乎只强调概率最大的 token。当 `T=2` 时：

```text
softmax([8, 4, 2] / 2)
= softmax([4, 2, 1])
≈ [0.844, 0.114, 0.042]
```

第二、第三候选 token 的相对关系变得明显，这些非最高概率候选中包含的结构信息通常称为“暗知识”。温度的作用可以概括为：

```text
T < 1：分布更尖锐
T = 1：普通 softmax
T > 1：分布更平滑
T 很大：逐渐接近均匀分布
```

项目默认 `temperature=1.5`。温度过低时蒸馏逐渐接近硬标签训练；温度过高时分布可能过于均匀，使有意义的偏好差异变弱。

### 为什么 teacher 使用 `softmax(...).detach()`

```python
teacher_probs = F.softmax(
    teacher_logits / temperature,
    dim=-1
).detach()
```

`softmax` 把教师 logits 转换成普通概率分布。`.detach()` 表示教师概率的数值参与 loss，但反向传播不进入教师模型：

```text
teacher -> 提供固定训练目标，不更新
student -> 拟合教师分布，接收梯度
```

项目还同时执行了：

```python
teacher_model.eval()
teacher_model.requires_grad_(False)

with torch.no_grad():
    teacher_logits = teacher_model(input_ids).logits
```

所以函数内的 `.detach()` 是额外的显式保护。它既表达“教师是固定目标”的语义，也防止未来单独调用该函数时意外保存教师计算图。

### 为什么 student 使用 `log_softmax`

```python
student_log_probs = F.log_softmax(
    student_logits / temperature,
    dim=-1
)
```

PyTorch `F.kl_div` 的第一个参数要求是 log probability，第二个参数默认要求是普通 probability，因此两边分别使用：

```text
student：log_softmax -> log probability
teacher：softmax     -> probability
```

学生侧不能 `detach()`，因为训练需要保留这条梯度链：

```text
KL loss
  -> student_log_probs
  -> student_logits
  -> student model parameters
```

直接使用 `log_softmax` 也比 `log(softmax(logits))` 更稳定，避免 softmax 概率过小时先下溢为零、再得到 `log(0)`。

### `kl_div` 的方向

源码参数顺序容易造成误解：

```python
F.kl_div(
    input=student_log_probs,
    target=teacher_probs,
    reduction='batchmean'
)
```

虽然 student 是第一个参数，实际计算的是：

$$
D_{KL}(P_{teacher}\Vert P_{student})
=
\sum_i P_{teacher}(i)
\left[
\log P_{teacher}(i)-\log P_{student}(i)
\right]
$$

当学生和教师分布完全相同时，KL 为零；学生偏离教师越远，KL 越大。例如：

```text
teacher = [0.80, 0.15, 0.05]
student = [0.30, 0.40, 0.30]
```

KL 会推动学生提高第一个 token 的概率，并降低后两个 token 的概率，使整个分布向教师靠近，而不只是拟合教师概率最大的 token。

### `batchmean` 如何归约

传入函数的第一维已经是有效 assistant token 数 `N`。`reduction='batchmean'` 会先对所有 token 和词表项求和，再除以 `N`：

$$
\mathcal L_{KL}
=
\frac{1}{N}
\sum_{n=1}^{N}
\sum_{v=1}^{V}
P_T(n,v)
\left[
\log P_T(n,v)-\log P_S(n,v)
\right]
$$

因此它表示每个有效 assistant token 的平均 KL。user、system、角色前缀和 padding 已被 `loss_mask` 排除。

### 为什么乘 `T²`

未补偿的温度 KL 对学生 logits 的梯度为：

$$
\frac{\partial D_{KL}}{\partial z_k^{student}}
=
\frac{q_k^{(T)}-p_k^{(T)}}{T}
$$

除以温度直接产生一个 `1/T`；在较高温度下，教师与学生的软化概率差异通常也会缩小约 `1/T`。因此梯度量级近似缩小为 `1/T²`。

源码乘回：

```python
return (temperature ** 2) * kl
```

是为了补偿这个梯度缩小，使不同温度下蒸馏项的梯度量级大致可比：

```text
T = 1.0 -> 乘 1
T = 1.5 -> 乘 2.25
T = 2.0 -> 乘 4
```

`T²` 不会消除软化效果。概率分布仍然使用温度后的形状，它只对最终损失和梯度做尺度补偿。不同温度下记录的 KL 数值也因此不能脱离 `T²` 直接比较。

总损失：

$$\mathcal L=\alpha\mathcal L_{CE}+(1-\alpha)T^2\operatorname{KL}(p_t^T\Vert p_s^T)$$

代码只在 `loss_mask==1` 的 assistant token 上蒸馏。教师 `eval()`、`requires_grad_(False)` 且前向在 `no_grad` 中，避免保存教师梯度。

项目默认 `alpha=0.5,T=1.5`，因此总目标由一半标准答案交叉熵和一半教师分布 KL 组成：

| 监督信号 | 教给学生的内容 |
|---|---|
| Ground-Truth CE | 标准答案 token 是什么 |
| Temperature KL | 教师如何给所有候选 token 分配概率 |

一句话概括：温度负责暴露教师的候选分布结构，KL 负责让学生拟合这个结构，`detach()` 保证只训练学生，`T²` 负责补偿高温造成的梯度衰减。

### 词表限制

代码把 teacher logits 截到 student vocab size：

```python
teacher_logits = teacher_logits[..., :vocab_size_student]
```

这只有在教师和学生的前 `V_student` token id 语义一致时才成立。若 tokenizer 不同，即使形状一致也没有蒸馏意义。当前流程更适合同生态、同词表的 MiniMind 教师/学生。

## 7. 黑盒与白盒蒸馏

- 黑盒：只取得教师生成文本，再作为 SFT 数据；不需要教师 logits。
- 白盒：训练时访问教师 logits，使用 KL；需要同时加载教师模型。

本项目的 `train_distillation.py` 是白盒实现；主 SFT 数据中使用强模型生成回答则属于广义黑盒蒸馏。

## 8. DPO 的问题设定

数据给出同一 prompt 下的 `chosen` 与 `rejected`。DPO 希望 policy 相对 reference 更偏向 chosen：

$$\Delta_\pi=\log\pi(y_w|x)-\log\pi(y_l|x)$$

$$\Delta_{ref}=\log\pi_{ref}(y_w|x)-\log\pi_{ref}(y_l|x)$$

$$\mathcal L_{DPO}=-\log\sigma\left(\beta(\Delta_\pi-\Delta_{ref})\right)$$

reference 通常是训练开始时的 SFT 模型，固定不动。它提供锚点，DPO 优化的是 policy 相对于该锚点的偏好变化。

## 9. 从代码追踪 DPO

`train_dpo.py:57-84` 把 chosen/rejected 沿 batch 维拼接，只需 policy 和 reference 各做一次前向：

```python
x = cat([x_chosen, x_rejected], dim=0)
y = cat([y_chosen, y_rejected], dim=0)
mask = cat([mask_chosen, mask_rejected], dim=0)

with no_grad(): ref_logits = ref_model(x).logits
policy_logits = model(x).logits
```

`logits_to_log_probs` 用 gather 取得目标 token log probability；`dpo_loss` 先乘 mask 并沿序列求和，再把 batch 前后两半拆成 chosen/rejected。

序列 log probability 是 token log probability 的和，因此长回答可能具有更负的总 log probability。项目没有长度归一化；偏好对的长度分布应当被检查。

## 10. `beta` 如何理解

`beta` 缩放偏好 margin。DPO 理论中它对应偏离 reference 的正则强度，但在这段直接实现里，它也直接缩放 sigmoid 输入和梯度，因此不能脱离学习率与数据单独解释：

- 太小：sigmoid 输入接近 0，偏好信号较弱；
- 太大：sigmoid 更容易饱和，优化对 margin 和学习率更敏感；
- 最佳值依赖数据质量、学习率、模型大小与训练步数。

代码默认学习率极低（`4e-8`），注释也强调避免遗忘。DPO 数据量虽可能小，但它直接更新完整 policy，应做通用能力回归。

## 11. 为什么 DPO 不等于 PPO

| 特性 | DPO | PPO/GRPO |
|---|---|---|
| 数据来源 | 离线偏好对 | 当前 policy 在线采样 |
| Reward Model | 不需要显式 RM | 通常需要 RM/规则 |
| Rollout | 不需要 | 需要 |
| Critic | 不需要 | PPO 需要，GRPO 不需要 |
| 工程成本 | 较低 | 较高 |
| 探索新回答 | 弱 | 强 |

## 12. 训练命令

```bash
(cd trainer && python train_lora.py)
(cd trainer && python train_distillation.py)
(cd trainer && python train_dpo.py)
```

这些默认命令都依赖相应数据、基础权重；蒸馏还依赖教师配置，DPO 会同时加载 policy/reference。运行前先读各脚本 `argparse` 默认值，不要假设 README 示例覆盖了本地路径。

## 13. 如何选择

- 少量垂域数据、显存有限、希望可插拔：LoRA。
- 有更强同词表教师、希望压缩能力：白盒蒸馏。
- 有高质量 chosen/rejected，希望改善偏好：DPO。
- 有可自动评分任务，希望 policy 自己探索：下一章的 PPO/GRPO。

## 14. 本章检查题

1. 为什么 LoRA 的 B 零初始化可保证注入前后输出相同？A、B 都为零会有什么优化问题？
2. 为什么 tokenizer 不同的教师不能只靠截断 logits 直接蒸馏？
3. DPO 的 mask 若包含 prompt token，会给 loss 带来什么影响？
4. policy 与 reference 初始化完全相同时，初始 DPO margin 为多少，单样本初始 loss 约是多少？
5. LoRA、蒸馏、DPO 中，哪个最节省可训练参数，哪个通常最耗前向显存？
