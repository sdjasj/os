# 03. Rollout Engine

## 1. Rollout Engine 的职责边界

`trainer/rollout_engine.py` 只负责：

```text
prompt token -> policy 采样 -> completion token/text/old log-prob
```

它不解析工具、不执行环境、不计算 reward、不更新梯度。多轮 Agent 逻辑位于 `train_agent.py:rollout_single`。这个边界让本地 PyTorch 和远端 SGLang 可以共享训练代码。

## 2. `RolloutResult`

```python
@dataclass
class RolloutResult:
    output_ids: Tensor       # 完整 prompt+completion
    completion_ids: Tensor   # 仅新生成部分
    per_token_logps: Tensor  # 生成策略对 completion 的 logp
    completions: List[str]   # 解码文本
    prompt_lens: Tensor
    completion_mask: Tensor
```

典型形状：

```text
prompt_ids       [B,P]
num_generations  G
output_ids       [B*G,P+R]
completion_ids   [B*G,R]
per_token_logps  [B*G,R]
completion_mask  [B*G,R]
```

在 `rollout_single` 中每次只传一条 prompt 且 `G=1`；外层 `rollout_batch` 自己循环实现多 generation。

## 3. `compute_per_token_logps`

核心代码：

```python
logits = model(
    input_ids,
    attention_mask=attention_mask,
    logits_to_keep=n_keep + 1,
).logits[:, :-1, :]

ids = input_ids[:, -n_keep:]
logps = logits.log_softmax(-1)
selected = gather(logps, 1, ids.unsqueeze(1)).squeeze(1)
```

为什么需要 `n_keep+1` 个 logits，却最后取 `[:-1]`？要给最后 `n_keep` 个 token 计算条件概率，需要它们各自前一位置的 logits：

```text
logits position:  ... P-1, P, P+1, ...
predict token:        token[P], token[P+1], ...
```

最终返回 `[B,n_keep]`，与 completion token 一一对应。

## 4. Torch Rollout

`TorchRolloutEngine.rollout`：

```python
output_ids = model.generate(
    prompt_ids.repeat_interleave(G, dim=0),
    attention_mask=attention_mask.repeat_interleave(G, dim=0),
    do_sample=True,
    temperature=temperature,
    max_new_tokens=max_new_tokens,
)
completion_ids = output_ids[:, prompt_len:]
old_logps = compute_per_token_logps(
    policy_model, output_ids, completion_ids.size(1), full_mask
)
```

生成在 `torch.no_grad()` 和 autocast 下完成。之后再前向一次计算精确的 token logp。也就是说本地 rollout 至少包含生成前向和 logp 重算，吞吐不等同单纯推理。

### 当前 completion mask

Torch 引擎返回全 1 mask：

```python
attention_mask.new_ones(output_ids.size(0), completion_ids.size(1))
```

MiniMind 自定义 generate 在某行提前 EOS 后会继续为已完成样本填 EOS，直到整个 batch 都完成。但 Agent 单条 rollout 的 batch size 是 1，通常首个 EOS 后立即 break，所以问题较小。若改成真正批量 rollout，应重新按 EOS/PAD 构造 mask。

## 5. 为什么 rollout 时保存 old logp

训练 policy 前向可能发生在采样之后，甚至对同一批数据做多次更新。importance sampling 用：

$$r_t=\frac{\pi_\theta(a_t|s_t)}{\pi_{old}(a_t|s_t)}$$

若不保存采样当时 logp，就无法知道样本行为策略。SGLang 返回服务端 logp，本地引擎重算当前采样模型 logp。

## 6. SGLang Rollout

SGLang 路径先去除左 padding，把每条有效 prompt id 发到 `/generate`：

```json
{
  "input_ids": [[...], [...]],
  "sampling_params": {
    "temperature": 0.8,
    "max_new_tokens": 768,
    "stop_token_ids": [2]
  },
  "return_logprob": true
}
```

服务返回 completion ids 和 `output_token_logprobs`。客户端修正 logp 长度后，把变长结果 padding 成张量，并显式构建 `completion_mask`。

## 7. SGLang 的长度对齐策略

若返回 logp 少于 token：

```python
logprobs = [0.0] * missing + logprobs
```

若多于 token，保留尾部。这个容错让训练继续，但 0 logp 不是正确行为概率，会污染 ratio。正式使用应把不匹配变成可观测错误，统计比例，并在超过阈值时停止训练。

## 8. Policy 权重同步

Torch 引擎：

```python
def update_policy(self, model):
    self.policy_model = model
```

只是更新引用。SGLang 引擎则由 rank 0：

1. unwrap DDP/compile；
2. 保存 FP16 state dict 与 tokenizer 到共享目录；
3. POST `/update_weights_from_disk`；
4. 将成功标志 broadcast 给所有 rank；
5. barrier 保证同步。

训练脚本在初始化和每次 save interval/最后 step 调用 `update_policy`。因此当 `save_interval>1` 时，远端 rollout 可能在若干 optimizer step 内继续使用较旧权重，ratio 就不再接近 1。

## 9. 同步频率的权衡

- 每 step 同步：样本更新鲜，磁盘保存/加载开销大；
- 间隔同步：吞吐更高，off-policy 偏差更大；
- 监控 ratio、KL、clip fraction 可以判断 stale policy 程度；
- 当前 Agent 日志没有直接打印 ratio/clip fraction，可扩展。

## 10. Tokenizer 必须完全一致

训练侧和 SGLang 侧若 tokenizer 不同：

- 相同 id 解码成不同文本；
- EOS/PAD 不一致；
- tool 标签 tokenization 不一致；
- 服务 logp 与训练 input_ids 失去语义对应。

不能只比较 vocab size；应比较 tokenizer 文件哈希、special ids 和一组模板 encode 结果。

## 11. 直接验证 log-prob 形状

```bash
conda activate deepspeed
python - <<'PY'
import torch
from model.model_minimind import MiniMindConfig, MiniMindForCausalLM
from trainer.rollout_engine import compute_per_token_logps

cfg = MiniMindConfig(hidden_size=64, num_hidden_layers=1,
    num_attention_heads=4, num_key_value_heads=2,
    vocab_size=100, max_position_embeddings=64,
    flash_attn=False)
m = MiniMindForCausalLM(cfg).eval()
x = torch.randint(0, 100, (2, 12))
lp = compute_per_token_logps(m, x, n_keep=5)
assert lp.shape == (2, 5)
assert torch.isfinite(lp).all()
print(lp.shape, lp[0])
PY
```

## 12. 抽象设计的扩展点

可以增加 vLLM、TensorRT-LLM 或自研 server，只要严格返回同一 `RolloutResult` 契约。适配时优先测试：

- prompt 是否被服务重复添加 BOS；
- completion 是否包含 prompt；
- logp 是采样 token 还是所有候选；
- EOS 是否包含在 output_ids/logp；
- padding 方向；
- 多 generation 排序是否仍为 `[sample0*g..., sample1*g...]`。

## 13. 本章检查题

1. 为什么计算最后 R 个 token 的概率需要 R+1 个 logits 位置？
2. Torch rollout 为什么在 generate 后还需一次完整前向？
3. SGLang 每 10 step 同步时，old policy 实际可能多旧？这如何体现在 ratio？
4. logp 缺失时补 0 为什么只是容错而不是正确修复？
