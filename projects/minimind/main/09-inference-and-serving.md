# 09. 生成、评测、转换与服务

## 1. 推理入口的两种权重格式

`eval_llm.py:init_model` 根据 `--load_from` 判断：

```python
if 'model' in args.load_from:
    model = MiniMindForCausalLM(MiniMindConfig(...))
    model.load_state_dict(torch.load(ckp), strict=True)
else:
    model = AutoModelForCausalLM.from_pretrained(
        args.load_from, trust_remote_code=True
    )
```

- `--load_from ./model --weight full_sft`：tokenizer 来自 `model/`，权重来自 `out/full_sft_768.pth`；
- `--load_from ./minimind-3`：读取完整 Transformers 目录。

这里用路径是否包含字符串 `model` 判断是项目约定，不是通用可靠的格式探测。自定义目录命名时要注意这个分支。

## 2. 推理前的模板处理

SFT 权重使用：

```python
inputs = tokenizer.apply_chat_template(
    conversation,
    tokenize=False,
    add_generation_prompt=True,
    open_thinking=bool(args.open_thinking),
)
```

预训练权重没有对齐聊天协议，所以代码只拼 `bos_token + prompt`。用 chat template 测 pretrain 或裸文本测 SFT 都可能显著影响表现。

历史裁剪按消息条数而非 token 数：

```python
conversation = conversation[-args.historys:]
```

真正服务还应按 token budget 截断，确保 prompt + `max_new_tokens` 不超过可用上下文。

## 3. 自回归生成循环

`MiniMindForCausalLM.generate` 每轮：

1. 用 KV Cache 只前向尚未处理的 token；
2. 取最后位置 logits；
3. 除以 temperature；
4. 应用 repetition penalty；
5. top-k 过滤；
6. top-p 过滤；
7. multinomial 采样或 argmax；
8. 追加 token，更新 cache；
9. 全部样本 EOS 后停止。

## 4. Temperature

$$p_i=\operatorname{softmax}(z_i/T)$$

- `T<1`：分布更尖锐，输出更稳定；
- `T>1`：分布更平坦，随机性更强；
- `T` 不能为 0；确定性生成应使用 `do_sample=False`，不是令 temperature 为 0。

## 5. Top-K 与 Top-P

Top-K 只保留分数最高的 K 个 token：

```python
threshold = torch.topk(logits, top_k)[0][..., -1, None]
logits[logits < threshold] = -inf
```

Top-P（nucleus）按概率降序，保留累计概率刚超过 `p` 所需的最小候选集合。代码把 mask 右移一位，保证跨过阈值的第一个 token 仍被保留，也保证至少一个候选。

两者同时使用时先 top-k 再 top-p，最终候选是两次过滤后的集合。

## 6. Repetition Penalty

对已出现 token：

```python
score > 0: score /= penalty
score <= 0: score *= penalty
```

当 penalty > 1 时，正 logits 降低、负 logits 更负，都减少重复 token 概率。过高会破坏必要的术语、代码符号和语法重复。

## 7. EOS、PAD 与批量结束

`finished` 是 batch 级布尔向量。某条序列 EOS 后，后续步骤强制继续填 EOS，直到所有序列完成，再整体 break。解码时通常只取 prompt 后的新 token，并设置 `skip_special_tokens=True`。

## 8. KV Cache 实验

对相同 prompt 比较 cache 开关。为公平，应关闭采样：

```bash
python - <<'PY'
import time, torch
from model.model_minimind import MiniMindConfig, MiniMindForCausalLM
device = 'cuda' if torch.cuda.is_available() else 'cpu'
cfg = MiniMindConfig(hidden_size=128, num_hidden_layers=4,
    num_attention_heads=4, num_key_value_heads=2,
    vocab_size=6400, max_position_embeddings=512)
m = MiniMindForCausalLM(cfg).to(device).eval()
x = torch.randint(0, cfg.vocab_size, (1, 128), device=device)
for cache in (False, True):
    if device == 'cuda': torch.cuda.synchronize()
    start = time.perf_counter()
    y = m.generate(x, max_new_tokens=64, do_sample=False,
                   use_cache=cache, eos_token_id=None)
    if device == 'cuda': torch.cuda.synchronize()
    print(cache, time.perf_counter()-start, tuple(y.shape))
PY
```

首次运行可能含 CUDA 初始化/编译开销，应 warmup 后重复多次取中位数。

## 9. 模型转换

`scripts/convert_model.py` 支持：

- 原生 `.pth` -> Transformers 目录；
- Transformers -> `.pth`；
- 基座 + LoRA -> 合并 `.pth`；
- chat template 在 JSON/Jinja 文件间转换。

默认的 `convert_torch2transformers` 利用当前权重命名已与生态对齐这一点，按 `lm_config` 创建 `Qwen3Config/Qwen3MoeConfig` 和相应模型；Transformers 5.x 的 MoE 专家权重还会做堆叠重排。另一个 `convert_torch2transformers_minimind` 则导出保留 MiniMind 自定义类的目录。

转换的关键步骤是：

1. 用 `lm_config` 构建形状和语义兼容的目标 config/模型；
2. 必要时转换 MoE state dict 布局，再严格加载；
3. `save_pretrained` 保存模型权重/config；
4. 保存 tokenizer 与必要源码/auto map 配置；
5. 用 `AutoModelForCausalLM.from_pretrained` 回读验证。

修改脚本底部硬编码路径与 config 后运行：

```bash
(cd scripts && python convert_model.py)
```

转换前后至少验证：

- state dict key/shape；
- 相同输入 logits 最大误差；
- tokenizer id 完全一致；
- greedy generation 结果；
- tied weights 是否保持；
- Dense/MoE config 是否匹配。

## 10. OpenAI 兼容服务

`scripts/serve_openai_api.py` 使用 FastAPI/Pydantic 风格请求模型，支持：

- `/v1/chat/completions`；
- 流式与非流式响应；
- `reasoning_content`；
- `tool_calls`；
- `open_thinking`。

从 `scripts/` 启动，确保 Transformers 模型目录位于脚本扫描/参数所需位置：

```bash
(cd scripts && python serve_openai_api.py)
```

示例客户端 `scripts/chat_api.py` 当前默认连接 `http://localhost:11434/v1`，更像 Ollama/OpenAI 兼容端点示例；若连接本仓库服务，应按服务实际 host/port 修改 `base_url` 和模型名。

## 11. 流式输出如何工作

服务端 `CustomStreamer`/线程生成把 token 增量交给响应生成器。推理文本还需解析：

- `<think>...</think>` -> `reasoning_content`；
- `<tool_call>...</tool_call>` -> 结构化 `tool_calls`；
- 其余 -> `content`。

流式解析比完整文本解析难，因为标签和 JSON 可能跨 chunk。状态机必须缓存未闭合片段，不能假设每个 chunk 恰好是完整标签。

## 12. Tool Call 评测

本地权重：

```bash
(cd scripts && python eval_toolcall.py \
  --backend local \
  --load_from ../model \
  --save_dir ../out \
  --weight full_sft)
```

API 后端：

```bash
(cd scripts && python eval_toolcall.py \
  --backend api \
  --api_base_url http://localhost:8998/v1 \
  --api_model minimind)
```

评测不应只看最终文本。至少分开统计：工具选择准确率、参数 JSON 合法率、参数值准确率、调用次数、工具结果利用率、最终任务成功率。

## 13. WebUI

`scripts/web_demo.py` 负责模型发现、会话状态、thinking 展示、工具选择与多轮执行。它是交互验证工具，不等于生产服务：生产还需要鉴权、并发控制、批处理、超时、监控、限流与安全隔离。

## 14. 性能指标

- **TTFT**：time to first token，受 prompt prefill 影响；
- **TPOT**：time per output token，受 decode 和 KV Cache 影响；
- **tokens/s**：脚本当前以生成 token 数除总时间；
- **吞吐**：服务单位时间处理的总 token/请求；
- **峰值显存**：模型权重 + cache + 临时激活；
- **上下文长度**：应区分配置上限、位置外推上限和验证过的有效能力。

## 15. 常见问题

- 生成不停止：EOS id/config/template 不一致，或模型未学会 EOS。
- 输出乱码/替换字符：ByteLevel token 被流式逐个 decode，需做字节缓冲；tokenizer 训练脚本已有流式解码测试。
- API content 为空：回答可能全部在 reasoning/tool_calls，客户端需读取相应字段。
- 原生权重能跑，Transformers 权重不能跑：检查 config、remote code、权重绑定和 tokenizer 文件是否完整。
- 开 YaRN 仍不能理解长文：位置可表示不等于能力已训练。
- history 很少却超长：消息数不是 token budget。

## 16. 本章检查题

1. Top-P 为什么要把累计概率 mask 右移一位？
2. KV Cache 节省了哪些重复计算，哪些计算仍随上下文增长？
3. 为什么模型转换验证应比较 logits，而不只比较生成文本？
4. 流式 tool call JSON 跨 chunk 时，简单正则为何不可靠？
5. TTFT 和 TPOT 分别更受 prompt 长度还是生成长度影响？
