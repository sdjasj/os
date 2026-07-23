# 10. 实验手册与排错

本章把前面知识变成一组由浅入深的实验。建议每次只改变一个变量，保存命令、git commit、随机种子、环境和结果。

## 1. 实验 0：环境清点

```bash
python --version
python -m pip show torch transformers datasets tokenizers
nvidia-smi
git status --short
git rev-parse --short HEAD
```

记录 Python、PyTorch、CUDA driver/runtime、GPU、显存和仓库 commit。无法复现实验时，环境差异通常比算法差异更常见。

## 2. 实验 1：Tokenizer 压缩率

目标：理解字符数不等于 token 数。

```bash
python - <<'PY'
from transformers import AutoTokenizer
t = AutoTokenizer.from_pretrained('model')
samples = {
  'zh': '大语言模型通过预测下一个词元学习文本分布。',
  'en': 'A language model predicts the next token.',
  'code': 'def f(x):\n    return x * x\n',
}
for name, s in samples.items():
    ids = t.encode(s, add_special_tokens=False)
    print(name, 'chars=', len(s), 'tokens=', len(ids),
          'chars/token=', len(s)/len(ids), ids)
PY
```

扩展：加入数字、JSON、罕见汉字、emoji，观察 ByteLevel 的行为。

## 3. 实验 2：SFT label mask 审计

目标：证明模型只在 assistant 区间受监督。

对真实数据随机抽 100 条，统计：

```text
total tokens
valid label tokens
valid ratio
all-ignore samples
assistant turn count
truncated samples
```

验收：`all-ignore samples == 0`；随机打印 5 条逐 token target，边界全部正确。

## 4. 实验 3：模型形状与参数量

目标：手算并验证 Dense/GQA/MoE 参数。

分别实例化：

```text
D=64, layers=2, H=4, H_kv=4, Dense
D=64, layers=2, H=4, H_kv=2, Dense
D=64, layers=2, H=4, H_kv=2, MoE E=4 K=1
```

记录总参数、每个投影 shape、单次前向时间和 KV Cache shape。解释 GQA 改变哪些参数，MoE 改变哪些参数。

## 5. 实验 4：因果性测试

目标：验证位置 `t` 的 logits 不受未来 token 改变影响。

```bash
python - <<'PY'
import torch
from model.model_minimind import MiniMindConfig, MiniMindForCausalLM
torch.manual_seed(0)
c = MiniMindConfig(hidden_size=64, num_hidden_layers=2,
    num_attention_heads=4, num_key_value_heads=2,
    vocab_size=100, max_position_embeddings=32,
    dropout=0, flash_attn=False)
m = MiniMindForCausalLM(c).eval()
a = torch.tensor([[1,2,3,4,5,6]])
b = torch.tensor([[1,2,3,4,90,91]])
with torch.no_grad():
    la, lb = m(a).logits, m(b).logits
print('prefix max diff:', (la[:,:4]-lb[:,:4]).abs().max().item())
print('future max diff:', (la[:,4:]-lb[:,4:]).abs().max().item())
PY
```

前四个输入相同，对应位置 logits 应只出现数值级微小差异或完全相同；未来部分应不同。

## 6. 实验 5：过拟合一个 batch

这是训练链路最有效的单元测试。选 2-8 条样本，关闭随机增强，反复训练同一 batch，目标是让 loss 明显降到很低。

若做不到，优先怀疑：

- labels/mask；
- 学习率和 optimizer；
- forward 位移；
- 梯度是否存在；
- 模型是否处于 train；
- 数据是否全部 padding/ignore。

能过拟合一个 batch 不代表模型泛化良好，但不能过拟合通常表示管线有 bug。

## 7. 实验 6：Pretrain 到 SFT 的能力变化

保存固定 prompt 集：

```text
续写类：春天来了，
知识类：为什么天空是蓝色的？
指令类：用三点解释光合作用。
格式类：只输出合法 JSON。
```

分别测试随机模型、pretrain、full_sft。固定 greedy decoding 或固定随机种子/采样参数。比较：连贯性、指令遵循、EOS、格式，而不只看主观“更好”。

## 8. 实验 7：LoRA 参数与合并等价性

1. 注入 LoRA 后确认初始 logits 不变；
2. 只训练 LoRA 数步，确认基座参数逐位不变；
3. 保存 adapter；
4. 合并到基座；
5. 比较“基座+adapter”与“merged” logits 最大误差。

半精度保存会引入小误差，设置合理 tolerance，而不是要求 bitwise identical。

## 9. 实验 8：DPO 数值单元测试

构造人工 sequence logp：

```text
reference: chosen=-5, rejected=-6  => margin=1
policy A:  chosen=-4, rejected=-6  => margin=2，应受鼓励
policy B:  chosen=-6, rejected=-6  => margin=0，应有更高 loss
```

直接调用 `dpo_loss`，断言 `loss_A < loss_B`。再改变 mask，确认被遮位置不影响 loss。

## 10. 实验 9：GRPO 组内优势

手工 reward：

```text
prompt 1: [1, 2, 3]
prompt 2: [5, 5, 5]
```

计算组内标准化。第一组优势均值应近 0 且有正负；第二组全部为 0。由此直观看见 degenerate group。

## 11. 实验 10：Agent action mask

使用一个固定模拟轨迹：

```text
prompt -> tool_call -> tool_response -> final answer
```

打印每个 token、来源、mask、old logp。验收：

- prompt mask=0；
- tool_call 和 final answer mask=1；
- tool_response mask=0；
- `input_ids[:,1:]`、logp、mask 长度完全相同；
- 截断后仍满足对齐。

## 12. 调试层次

按以下顺序定位，不要直接调超参数：

1. **数据层**：字段、模板、token、截断、labels；
2. **形状层**：每个张量 shape/dtype/device；
3. **数值层**：NaN/Inf、logits 范围、有效 mask 分母；
4. **梯度层**：requires_grad、grad norm、no_grad/detach；
5. **优化层**：学习率、step 时机、zero_grad、scheduler；
6. **分布式层**：sampler、rank 控制流、collective 对称；
7. **评测层**：生成参数、seed、模板和指标一致性。

## 13. 常用诊断片段

### 检查 NaN/Inf

```python
assert torch.isfinite(loss), loss
for name, p in model.named_parameters():
    if p.grad is not None and not torch.isfinite(p.grad).all():
        print('bad grad:', name)
        break
```

### 梯度范数

```python
sq = sum(p.grad.float().pow(2).sum()
         for p in model.parameters() if p.grad is not None)
print('grad_norm=', sq.sqrt().item())
```

### 有效监督 token

```python
valid = (labels != -100)
print(valid.sum(1), valid.float().mean())
assert valid.any(dim=1).all()
```

### 峰值显存

```python
torch.cuda.reset_peak_memory_stats()
# run step
print(torch.cuda.max_memory_allocated() / 1024**3, 'GiB')
```

### 参数是否真的更新

```python
before = model.model.layers[0].self_attn.q_proj.weight.detach().clone()
# optimizer step
after = model.model.layers[0].self_attn.q_proj.weight.detach()
print((after-before).abs().max())
```

## 14. 结果记录模板

```markdown
# 实验名称
- commit:
- command:
- hardware:
- seed:
- data/version/count:
- model config:
- train config:
- generation config:

## 假设

## 指标
| step | train loss | val loss | reward | KL | tok/s | memory |

## 固定样例

## 结论

## 下一步
```

## 15. 建议毕业项目

### A. 数据审计器（入门）

写一个 CLI，读取五类 JSONL，报告 schema、token 长度、截断、有效 label、角色序列和工具 JSON 合法率。不要修改训练代码，先构建可观察性。

### B. 小模型端到端（中级）

用 64/128 hidden size 完成 tiny pretrain -> SFT -> CLI inference。绘制 train/validation loss，保存固定 prompt 对比。

### C. LoRA 领域适配（中级）

制作小型领域对话集，比较 full SFT 与 LoRA 的可训练参数、显存、领域准确率和通用能力遗忘，并验证 adapter 合并。

### D. 可验证 GRPO（高级）

构建模型能力范围内的算术任务，使用结构化答案 verifier，不依赖大 Reward Model。监控 group std、正确率、KL 和 reward hacking。

### E. 安全 Tool Agent（高级）

替换教学 `eval` 工具为安全表达式解析器，加入 schema 校验、超时、错误 observation 和任务成功率评测，再比较 Tool SFT 与 Agent RL。

## 16. 最终自测

完成教程后，应能独立回答：

1. 一条 SFT JSONL 最终哪些 token 产生梯度？
2. 默认 GQA 的 Q/K/V shape 和 KV Cache shape 是什么？
3. MoE aux loss 从哪来，在哪加到总 loss？
4. `.pth` 推理权重和 `_resume.pth` 有何区别？
5. LoRA 在本项目具体注入哪些层？
6. 蒸馏 KL 为什么乘 `T^2`，tokenizer 为什么必须对齐？
7. DPO 的四个序列 log probability 如何组成 loss？
8. PPO、GRPO、CISPO 的 advantage 和策略项分别是什么？
9. Agent 轨迹中为什么 observation mask 为 0？
10. 转换前后为何要比较 logits、tokenizer 和 greedy generation？
