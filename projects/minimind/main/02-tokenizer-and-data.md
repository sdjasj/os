# 02. Tokenizer、Chat Template 与数据集

## 1. 为什么模型不能直接读取字符串

神经网络只处理数值。Tokenizer 建立两种映射：

```text
字符串 --encode--> token ids --Embedding--> 连续向量
token ids --decode--> 字符串
```

MiniMind 当前词表大小为 6400，使用 `BPE + ByteLevel`。ByteLevel 让任意 UTF-8 字节原则上都可表示，BPE 再把频繁相邻单元合并，兼顾开放词表与压缩率。

## 2. Tokenizer 训练代码

入口是 `trainer/train_tokenizer.py:24`。关键配置：

```python
tokenizer = Tokenizer(models.BPE())
tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
trainer = trainers.BpeTrainer(
    vocab_size=vocab_size,
    initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
    special_tokens=all_special_tokens,
)
tokenizer.train_from_iterator(texts, trainer=trainer)
tokenizer.decoder = decoders.ByteLevel()
```

BPE 的直观训练过程：先使用近似字节级的初始单元，统计相邻 token 对频率，反复合并最常见 token 对，直到达到词表大小或没有可合并项。

高频词可能只占一个 token，低频词会拆成多个 token。词表过小会增加序列长度，词表过大会增加 Embedding 和 LM Head 参数：

$$N_{embedding}=V\times D$$

在权重绑定时输入 Embedding 和输出 LM Head 共享同一矩阵，但 logits 的计算成本仍随 `V` 增长。

## 3. Special Token 与普通文本标记

`train_tokenizer.py:28-42` 定义：

- `<|endoftext|>`：pad/unk；
- `<|im_start|>`：bos，同时表示一条消息起始；
- `<|im_end|>`：eos，同时表示一条消息结束；
- `<tool_call>`、`<tool_response>`、`<think>` 等能力标记；
- buffer token：预留词表位置。

一个容易忽略的细节是，保存 tokenizer 后，代码会把不属于 `special_tokens_list` 的 added token 的 `special` 标志改回 `False`。因此 `<think>` 等标记虽然拥有固定 token id，却不会像真正 special token 一样总在 `skip_special_tokens=True` 时消失。这样推理层仍能解析这些结构标签。

## 4. Chat Template 是协议编译器

`model/tokenizer_config.json` 中的 Jinja 模板把结构化消息编译成单一 token 序列。例如：

```python
messages = [
    {'role': 'system', 'content': '你是助手'},
    {'role': 'user', 'content': '1+1等于几？'},
    {'role': 'assistant', 'content': '等于2。'},
]
text = tokenizer.apply_chat_template(
    messages, tokenize=False, add_generation_prompt=False
)
```

大致得到：

```text
<|im_start|>system
你是助手<|im_end|>
<|im_start|>user
1+1等于几？<|im_end|>
<|im_start|>assistant
<think>

</think>

等于2。<|im_end|>
```

模板不是装饰。训练和推理若使用不同角色边界、换行或思考标记，模型会看到分布外输入。

### `add_generation_prompt`

- 训练完整对话：`False`，数据已经包含 assistant 回答和结束标记。
- 推理或 RL rollout：`True`，模板只写出 assistant 回答的开头，让模型续写。

### `open_thinking`

- `False`：预填空的 `<think>...</think>`，提示模型直接回答；
- `True`：只预填 `<think>` 起点，让模型继续生成思考内容。

它是输入协议开关，不是切换另一套模型权重。

## 5. 预训练数据

`PretrainDataset.__getitem__` 位于 `dataset/lm_dataset.py:47-55`：

```python
tokens = tokenizer(sample['text'], add_special_tokens=False,
                   max_length=max_length - 2,
                   truncation=True).input_ids
tokens = [bos_id] + tokens + [eos_id]
input_ids = tokens + [pad_id] * (max_length - len(tokens))
labels = input_ids.clone()
labels[input_ids == pad_id] = -100
```

一条 JSONL 至少含：

```json
{"text": "天空呈蓝色与大气中的瑞利散射有关。"}
```

所有非 padding token 都参与 next-token loss，包括正文和 EOS。模型由此学习文本分布和终止位置。

## 6. SFT 数据与 assistant-only loss

SFT 数据示例：

```json
{"conversations":[
  {"role":"user","content":"什么是光合作用？"},
  {"role":"assistant","content":"光合作用是植物利用光能合成有机物的过程。"}
]}
```

`SFTDataset` 的流程：

1. `pre_processing_chat` 以一定概率增加 system prompt；
2. `create_chat_prompt` 调用模板；
3. `post_processing_chat` 随机移除一部分空 thinking 标签；
4. tokenize、截断、右侧 padding；
5. `generate_labels` 只标记 assistant 消息内容。

核心定位方式：

```python
self.bos_id = tokenizer(
    f'{tokenizer.bos_token}assistant\n', add_special_tokens=False
).input_ids
self.eos_id = tokenizer(
    f'{tokenizer.eos_token}\n', add_special_tokens=False
).input_ids
```

`generate_labels` 扫描每个 assistant 起点到消息结束位置，把相应 `input_ids` 复制给 labels，其他位置保持 `-100`。

```text
token:  <user-begin> 问题 <end> <assistant-begin> 回答 <end> <pad>
label:      -100    -100  -100       -100        回答 <end> -100
```

虽然 prompt 位置不计算 CE，它仍参与前向注意力，为回答提供上下文。`-100` 表示“不监督该位置”，不是“从输入中删除”。

### 截断风险

代码先将整个模板截成 `max_length`，再生成标签。如果长 prompt 把 assistant 回答完全截掉，labels 可能全部为 `-100`，loss 会变成无效值。定制数据时应统计：

- 有效 label token 数分布；
- 截断比例；
- assistant 消息是否至少保留一个 token；
- 多轮对话尾部是否被系统性丢弃。

## 7. DPO 数据

格式包含共享问题上下文下的优选和拒绝回答：

```json
{
  "chosen": [
    {"role":"user","content":"解释月食"},
    {"role":"assistant","content":"月食发生在地球位于太阳和月球之间时……"}
  ],
  "rejected": [
    {"role":"user","content":"解释月食"},
    {"role":"assistant","content":"月食是太阳被云遮住。"}
  ]
}
```

`DPODataset` 返回：

```text
x_chosen, y_chosen, mask_chosen
x_rejected, y_rejected, mask_rejected
```

这里数据集已经显式做 next-token 位移：`x=input_ids[:-1]`，`y=input_ids[1:]`。mask 仍只覆盖 assistant 区间，防止 prompt 长度主导序列 log probability。

## 8. RLAIF 与 Agent RL 数据

`RLAIFDataset` 只返回 prompt，最后一个已有回答不参与训练：

```python
apply_chat_template(conversations[:-1],
                    add_generation_prompt=True,
                    open_thinking=use_thinking)
return {'prompt': prompt, 'answer': ''}
```

这是 online RL：回答必须由当前 policy 生成，而不是照抄数据中的静态 answer。

`AgentRLDataset` 返回：

```python
{'messages': messages, 'tools': tools, 'gt': sample['gt']}
```

- `messages`：开始 rollout 前的对话；
- `tools`：可调用工具 schema；
- `gt`：最终答案校验目标。

## 9. 直接检查真实模板

```bash
python - <<'PY'
from transformers import AutoTokenizer
t = AutoTokenizer.from_pretrained('model')
messages = [
    {'role': 'user', 'content': '计算 12*7'},
    {'role': 'assistant', 'content': '12*7=84。'},
]
text = t.apply_chat_template(messages, tokenize=False,
                             add_generation_prompt=False)
ids = t(text, add_special_tokens=False).input_ids
print(text)
print('token count:', len(ids))
print('round trip:', t.decode(ids, skip_special_tokens=False) == text)
print(list(zip(ids[:20], t.convert_ids_to_tokens(ids[:20]))))
PY
```

## 10. 检查一条 SFT 样本的监督区间

准备临时 JSONL 后使用真实 Dataset：

```bash
tmp=$(mktemp /tmp/minimind-sft-XXXX.jsonl)
printf '%s\n' '{"conversations":[{"role":"user","content":"2+3?"},{"role":"assistant","content":"等于5。"}]}' > "$tmp"
python - "$tmp" <<'PY'
import sys
from transformers import AutoTokenizer
from dataset.lm_dataset import SFTDataset
t = AutoTokenizer.from_pretrained('model')
ds = SFTDataset(sys.argv[1], t, max_length=64)
x, y = ds[0]
for i in range(len(x)-1):
    target = 'IGN' if y[i+1].item() == -100 else repr(t.decode([y[i+1].item()]))
    print(f'{i:02d} input={t.decode([x[i].item()])!r:12} next_target={target}')
PY
rm "$tmp"
```

检查的重点不是输出是否漂亮，而是只有 assistant 内容与结束标记成为目标。

## 11. 常见错误

- 把 `pad_token_id` 当作一定等于 0：应从 tokenizer 读取。
- 直接拼接字符串模拟聊天模板：训练/推理边界容易不一致。
- 自定义数据使用 `instruction/output` 字段但不改 Dataset：加载会直接失败。
- 以字符长度代替 token 长度：中文、英文、代码的压缩率不同。
- 认为 `reasoning_content` 会自动进入普通 `content`：模板有专门分支，应检查渲染结果。
- 工具 schema 填在任意消息：当前 `SFTDataset` 从带 `tools` 的 system 消息提取。

## 12. 本章检查题

1. 为什么 `<think>` 需要固定 token id，却不一定应当被设置为可跳过的 special token？
2. SFT 中若用户 token 也参与 loss，模型可能学到什么不希望的行为？
3. `add_generation_prompt=True` 用在完整训练样本上会引入什么额外片段？
4. 设计一个统计脚本，报告有效 label 数为 0 的样本比例与 token 截断比例。
