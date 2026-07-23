# 11. 公式与术语速查

## 1. 张量符号

| 符号 | 含义 | 默认值/例子 |
|---|---|---|
| `B` | batch size | 训练参数决定 |
| `T` | sequence length | Pretrain 默认 340，SFT 默认 768 |
| `V` | vocabulary size | 6400 |
| `D` | hidden size | 768 |
| `N` | Transformer 层数 | 8 |
| `H` | query attention heads | 8 |
| `H_kv` | key/value heads | 4 |
| `d` | head dimension | 96 |
| `I` | FFN intermediate size | 默认 2432 |
| `E` | expert count | 4 |
| `K` | experts per token | 1 |
| `G` | generations per prompt | GRPO 默认 6 |

## 2. 模型形状

```text
input_ids                 [B,T]
embedding/hidden_states   [B,T,D]
Q                         [B,T,H,d] -> [B,H,T,d]
K,V                       [B,T,H_kv,d] -> repeat -> [B,H,T,d]
attention scores          [B,H,T,T]
logits                    [B,T,V]
KV cache per layer        K,V each [B,T,H_kv,d]
```

## 3. 常用公式

### Next-token CE

$$\mathcal L_{CE}=-\frac1{|M|}\sum_{t\in M}\log P(y_t|x_{\le t})$$

`M` 是有效 label mask；Pretrain 是正文，SFT 是 assistant。

### Attention

$$\operatorname{Attention}(Q,K,V)=\operatorname{softmax}(QK^T/\sqrt d+mask)V$$

### RMSNorm

$$\operatorname{RMSNorm}(x)=w\odot x/\sqrt{mean(x^2)+\epsilon}$$

### SwiGLU

$$W_d(\operatorname{SiLU}(W_gx)\odot W_ux)$$

### LoRA

$$W'=W+BA$$

### Distillation

$$\alpha\mathcal L_{CE}+(1-\alpha)T^2KL(p_t^T\Vert p_s^T)$$

### DPO

$$-\log\sigma(\beta[(\log\pi_w-\log\pi_l)-(\log\pi_{ref,w}-\log\pi_{ref,l})])$$

### Importance ratio

$$r_t=\exp(\log\pi_\theta(a_t|s_t)-\log\pi_{old}(a_t|s_t))$$

### GRPO advantage

$$A_i=(R_i-\mu_{group})/(\sigma_{group}+\epsilon)$$

### Token KL estimator

令 `delta = logp_ref - logp_policy`：

$$KL_t\approx e^{delta}-delta-1$$

## 4. 四种 mask

| 名称 | 屏蔽什么 | 代码表达 |
|---|---|---|
| causal | 未来 token | attention 上三角 `-inf` |
| attention | padding | 真实=1、pad=0 |
| labels | 不监督的 prompt/pad | `-100` |
| policy/completion | prompt、pad、环境 observation | action=1，其余=0 |

## 5. 模型角色

| 角色 | 是否训练 | 作用 |
|---|---|---|
| student/policy/actor | 是 | 当前被优化的生成模型 |
| teacher | 否 | 蒸馏时提供 soft targets |
| reference | 否 | DPO/RL 中限制 policy 偏移 |
| old policy | 固定于当前 rollout | importance sampling 分母 |
| reward model | 否 | 回答映射为标量奖励 |
| critic | PPO 中训练 | 状态价值与 advantage |

## 6. 方法对比

| 阶段 | 数据 | loss | 主要产物 |
|---|---|---|---|
| Tokenizer | text | BPE 统计合并 | tokenizer files |
| Pretrain | `text` | all-token CE | base weights |
| SFT | conversations | assistant CE | chat weights |
| LoRA | conversations | assistant CE | adapter |
| Distill | conversations + teacher | CE + KL | student weights |
| DPO | chosen/rejected | preference logistic | aligned weights |
| PPO | prompts + online reward | clipped actor + value + KL | actor weights |
| GRPO | prompts + grouped samples | group advantage + clip + KL | policy weights |
| CISPO | 同 GRPO | detached clipped ratio × logp + KL | policy weights |
| Agent RL | messages/tools/gt | trajectory reward + GRPO/CISPO | agent weights |

## 7. 权重文件

| 文件 | 内容 | 用途 |
|---|---|---|
| `out/*.pth` | 半精度模型 state dict | 推理、下一阶段初始化 |
| `checkpoints/*_resume.pth` | 模型+optimizer+进度等 | 断点续训 |
| LoRA `.pth` | 仅 adapter 参数 | 可插拔加载/合并 |
| Transformers 目录 | config、tokenizer、权重等 | 生态部署 |

## 8. 术语

- **AR / autoregressive**：按从左到右条件概率逐 token 生成。
- **Decoder-only**：只有因果 self-attention 的 Transformer 架构。
- **Prefill**：一次处理整个 prompt 并建立 KV Cache。
- **Decode**：利用 cache 逐 token 生成。
- **GQA**：多个 Q head 共享较少的 K/V head。
- **RoPE**：通过旋转 Q/K 编入位置信息。
- **YaRN**：用于 RoPE 长度外推的频率缩放方法。
- **MoE**：每个 token 只路由到部分 FFN 专家。
- **PEFT**：只训练少量参数的高效微调。
- **On-policy**：训练数据由较新的当前策略采样。
- **Off-policy**：使用并非由当前策略实时产生的数据。
- **Rollout**：策略在 prompt/环境中采样完整回答或轨迹。
- **Advantage**：某动作/回答相对 baseline 好多少。
- **KL regularization**：限制 policy 远离参考分布。
- **Reward hacking**：模型利用奖励漏洞得高分而未完成真实目标。
- **Degenerate group**：同 prompt 的组内 reward 无方差，GRPO 优势消失。
- **TTFT**：从请求到第一个输出 token 的延迟。
- **TPOT**：后续每个输出 token 的平均延迟。

## 9. 源码索引

| 主题 | 文件与符号 |
|---|---|
| Config/RMSNorm/RoPE | `model/model_minimind.py` |
| Attention/GQA/KV Cache | `Attention.forward` |
| Dense/MoE FFN | `FeedForward`、`MOEFeedForward` |
| CE/generate | `MiniMindForCausalLM` |
| LoRA | `model/model_lora.py` |
| 五类 Dataset | `dataset/lm_dataset.py` |
| 训练公共设施 | `trainer/trainer_utils.py` |
| Rollout | `trainer/rollout_engine.py` |
| DPO | `trainer/train_dpo.py` |
| PPO | `trainer/train_ppo.py` |
| GRPO/CISPO | `trainer/train_grpo.py` |
| Agent RL | `trainer/train_agent.py` |
| CLI 推理 | `eval_llm.py` |
| Tool 测试 | `scripts/eval_toolcall.py` |
| 模型转换 | `scripts/convert_model.py` |
| API 服务 | `scripts/serve_openai_api.py` |
