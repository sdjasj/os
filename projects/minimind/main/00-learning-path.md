# 00. 学习路线与项目地图

## 1. 项目解决什么问题

MiniMind 用较少的原生 PyTorch 代码串起一个 decoder-only 大语言模型的生命周期：

```text
原始文本/对话
  -> BPE Tokenizer + Chat Template
  -> Dataset 生成 input_ids / labels / mask
  -> MiniMindForCausalLM 前向计算 logits
  -> Pretrain / SFT / 偏好优化 / 在线 RL
  -> .pth 权重或 Transformers 模型目录
  -> CLI / WebUI / OpenAI 兼容 API / Tool Calling
```

主线代码只有数千行，适合源码学习，但“代码短”不代表背景知识少。本教程先补齐概念，再将概念映射回实际实现。

## 2. 目录职责

```text
minimind/
├── model/
│   ├── model_minimind.py   # Dense/MoE Transformer、loss、generate
│   ├── model_lora.py       # 原生 LoRA 注入、保存、加载、合并
│   ├── tokenizer.json      # BPE 词表与分词规则
│   └── tokenizer_config.json # special token 与 chat_template
├── dataset/
│   └── lm_dataset.py       # Pretrain/SFT/DPO/RLAIF/Agent RL 数据适配
├── trainer/
│   ├── train_pretrain.py
│   ├── train_full_sft.py
│   ├── train_lora.py
│   ├── train_distillation.py
│   ├── train_dpo.py
│   ├── train_ppo.py
│   ├── train_grpo.py
│   ├── train_agent.py
│   ├── rollout_engine.py   # 本地 PyTorch 与远端 SGLang rollout
│   └── trainer_utils.py    # DDP、学习率、checkpoint、模型初始化
├── scripts/
│   ├── convert_model.py
│   ├── serve_openai_api.py
│   ├── web_demo.py
│   ├── eval_toolcall.py
│   └── chat_api.py
└── eval_llm.py             # 最直接的命令行推理入口
```

## 3. 五条核心调用链

### 3.1 预训练

```text
train_pretrain.py
  -> init_model(..., from_weight='none')
  -> PretrainDataset
  -> model(input_ids, labels=labels)
  -> CE(next token) + MoE aux_loss
  -> AdamW + checkpoint
```

重点文件：`dataset/lm_dataset.py:37`、`trainer/train_pretrain.py:24`、`model/model_minimind.py:245`。

### 3.2 SFT

```text
train_full_sft.py
  -> init_model(..., from_weight='pretrain')
  -> SFTDataset
     -> apply_chat_template
     -> 只保留 assistant 区间的 labels
  -> 与预训练相同的 next-token CE
```

算法形式相同，监督位置不同。这是理解本项目最重要的连接之一。

### 3.3 DPO

```text
chosen/rejected 对
  -> DPODataset 生成四组序列与 mask
  -> 冻结 reference model + 可训练 policy model
  -> 计算 chosen/rejected 序列 log probability
  -> 优化相对 reference 的偏好差
```

重点文件：`dataset/lm_dataset.py:122`、`trainer/train_dpo.py:25`。

### 3.4 在线策略优化

```text
prompt
  -> rollout_engine 用当前 policy 采样回答
  -> Reward Model/规则打分
  -> PPO: Critic 估计 advantage
     或 GRPO/CISPO: 同一 prompt 的组内 reward 标准化
  -> reference model 提供 KL 约束
  -> 更新 policy
  -> 同步新 policy 给 rollout engine
```

重点文件：`trainer/rollout_engine.py`、`trainer/train_ppo.py`、`trainer/train_grpo.py`。

### 3.5 Agentic RL

```text
messages + tools + gt
  -> 模型生成 <tool_call>
  -> Python 执行模拟工具
  -> tool observation 拼回上下文
  -> 最多多轮生成
  -> 按工具合法性、gt 命中、格式、是否完成等给整条轨迹打分
  -> 只在模型生成 token 上计算策略损失
```

重点文件：`trainer/train_agent.py:98`、`:188`、`:242`。

## 4. 环境与最低硬件认知

当前机器已有 `deepspeed` Conda 环境，先激活：

```bash
conda activate deepspeed
```

如果非交互 shell 中 `conda activate` 尚不可用，先加载 Conda shell hook：

```bash
source /path/to/miniconda3/etc/profile.d/conda.sh
conda activate deepspeed
```

查看环境而不修改任何东西：

```bash
python --version
python - <<'PY'
import torch
print('torch:', torch.__version__)
print('cuda available:', torch.cuda.is_available())
print('cuda version:', torch.version.cuda)
if torch.cuda.is_available():
    print('gpu:', torch.cuda.get_device_name(0))
    print('bf16:', torch.cuda.is_bf16_supported())
PY
```

依赖文件没有固定安装 `torch`，因为 CUDA/CPU 平台需要选择不同 wheel。其余依赖可用：

```bash
pip install -r requirements.txt
```

资源判断：

- **只读代码与 tokenizer 实验**：CPU 足够。
- **极小模型前向/反向**：CPU 可运行，速度较慢。
- **默认 64M 模型完整训练**：推荐 CUDA GPU。
- **PPO/GRPO/Agent RL**：同时保留策略、参考、奖励模型，显存与耗时显著高于 SFT。
- **SGLang rollout**：还需要独立服务进程与可共享的模型目录。

## 5. 读源码的方法

### 第一遍：只追踪对象

对每个入口脚本只回答：`args -> config -> model/tokenizer -> dataset -> loader -> train_epoch -> save`。

### 第二遍：只追踪形状

统一使用：

- `B`：batch size
- `T`：序列长度
- `V`：词表大小，当前为 6400
- `D`：hidden size，默认 768
- `H`：query head 数，默认 8
- `H_kv`：KV head 数，默认 4
- `d`：每个 head 的维度，默认 `D/H=96`
- `E`：专家数，默认 4

### 第三遍：只追踪梯度

问每个张量：是否位于 `torch.no_grad()` 中？参数的 `requires_grad` 是否为真？是否被 `.detach()`？loss 是否能反向走到它？

## 6. 学习完成标准

在进入下一个模块前，尝试不看教程回答：

1. 为什么 `labels` 要向右错一位，而不是与 `input_ids` 同位置比较？
2. 为什么 SFT 中用户问题通常是 `-100`？
3. GQA 的 KV head 少于 Q head，在哪一行被复制到相同 head 数？
4. `use_cache=True` 为什么能加速逐 token 解码？
5. DPO 为什么需要冻结的 reference model？
6. GRPO 为什么不需要 Critic？什么情况下组内优势会退化为 0？
7. Agent RL 为什么必须区分“模型动作 token”和“工具观察 token”？

答不上来时，回到相应模块做实验，不要仅背定义。
