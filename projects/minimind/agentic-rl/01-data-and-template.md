# 01. 数据与 Chat Template

## 1. Agent RL 样本契约

项目使用 JSONL，每行是独立 JSON。一个最小教学样本：

```json
{
  "conversations": [
    {
      "role": "system",
      "content": "你可以使用给定工具完成任务。",
      "tools": "[{\"type\":\"function\",\"function\":{\"name\":\"calculate_math\",\"description\":\"计算数学表达式\",\"parameters\":{\"type\":\"object\",\"properties\":{\"expression\":{\"type\":\"string\"}},\"required\":[\"expression\"]}}}]"
    },
    {"role": "user", "content": "计算 12 乘以 7"},
    {"role": "assistant", "content": "84"}
  ],
  "gt": ["84"]
}
```

`tools` 可以是 JSON 字符串或已解析数组。公开数据用什么形式应以实际样本为准，Dataset 同时兼容两者。

## 2. `AgentRLDataset` 做了什么

`dataset/lm_dataset.py:226-252`：

```python
def parse_conversations(self, conversations):
    messages = []
    tools = None
    for message in conversations:
        message = dict(message)
        if message.get('role') == 'system' and message.get('tools'):
            tools = json.loads(message['tools']) \
                if isinstance(message['tools'], str) else message['tools']
        messages.append(message)
    return messages[:-1], tools
```

关键行为：

- 从带 `tools` 的 system 消息提取工具 schema；
- 返回 `messages[:-1]`，也就是丢掉最后一条 conversation；
- 最后返回 `messages/tools/gt`；
- `max_length` 被保存，但当前 `__getitem__` 并未用它截断。

最后一条通常是数据中的参考 assistant 答案，只为构造/校验数据服务。online RL 必须让当前 policy 自己生成，不能把它放进初始状态。

### 隐含约束

如果自定义数据最后一条不是“应丢弃的参考答案”，代码仍会无条件删除它。若 conversations 只有 system+user，最后的 user 会被删除，训练状态就错了。因此制作数据时要明确保留占位/参考 assistant 尾项，或修改 Dataset 契约。

## 3. 为什么需要自定义 `collate_fn`

工具 schema、消息轮数、GT 数量都是变长 Python 对象，不能让默认 DataLoader 直接堆成张量。`train_agent.py:456`：

```python
def collate_fn(batch):
    return {
        'messages': [b['messages'] for b in batch],
        'tools': [b['tools'] for b in batch],
        'gt': [b['gt'] for b in batch],
    }
```

真正的 tokenization 在 rollout 时逐条/逐轮发生，而不是 Dataset 阶段。

## 4. 工具 Schema 的作用

Schema 同时影响两处：

1. Chat Template 把工具名、描述和参数定义写进 prompt；
2. reward 用 `valid_names` 检查模型调用是否属于当前样本允许的工具。

训练脚本顶部虽然定义全局 `TOOLS`，但 rollout 实际传入的是每条样本解析出的 `tools_batch`。全局列表主要与执行器和校验器的实现对应。

## 5. Chat Template 如何展开工具

`model/tokenizer_config.json` 在 `tools` 非空时创建 system 消息，大致为：

```text
<|im_start|>system
你可以使用给定工具完成任务。

# Tools

You may call one or more functions ...
<tools>
{"type":"function", ...}
</tools>

For each function call, return ...
<tool_call>
{"name": <function-name>, "arguments": <args-json-object>}
</tool_call><|im_end|>
<|im_start|>user
计算 12 乘以 7<|im_end|>
<|im_start|>assistant
<think>

</think>

```

这段文本既定义动作空间，也示范输出协议。工具描述质量会直接影响调用选择。

## 6. assistant/tool 消息如何重建

assistant 工具调用最终表示为：

```text
<|im_start|>assistant
<think>...</think>

<tool_call>
{"name":"calculate_math","arguments":{"expression":"12*7"}}
</tool_call><|im_end|>
```

工具 observation 被包装为 user 侧工具响应：

```text
<|im_start|>user
<tool_response>
{"result":"84"}
</tool_response><|im_end|>
```

连续多个 tool 消息会被合并进同一 user 消息边界。这是模板协议，不是模型结构特性。

## 7. `open_thinking` 的采样

每条轨迹开始时：

```python
open_thinking = random.random() < thinking_ratio
```

这个布尔值在该轨迹所有 turn 保持不变：

- 开启：生成 prompt 以 `<think>\n` 结束；
- 关闭：预填空 `<think>\n\n</think>\n\n`。

默认 Agent RL 的 `thinking_ratio=0.1`。它不是每轮重新抽样，避免同一轨迹中协议突然变化。

## 8. 运行 Dataset 与模板检查

先创建自己的 JSONL，再运行：

```bash
conda activate deepspeed
python - <<'PY'
from transformers import AutoTokenizer
from dataset.lm_dataset import AgentRLDataset

t = AutoTokenizer.from_pretrained('model')
ds = AgentRLDataset('dataset/my_agent.jsonl', t)
sample = ds[0]
print('messages:', sample['messages'])
print('tools:', sample['tools'])
print('gt:', sample['gt'])
prompt = t.apply_chat_template(
    sample['messages'], tools=sample['tools'],
    tokenize=False, add_generation_prompt=True,
    open_thinking=False,
)
print(prompt)
print('tokens:', len(t(prompt, add_special_tokens=False).input_ids))
PY
```

## 9. 数据审计清单

每条数据至少检查：

- JSON 可解析；
- conversations 非空，角色顺序合理；
- 最后一项确实可以被删除；
- system 中 tools 可解析为列表；
- schema 中工具名与执行器一致；
- required 参数与 `CHECK_ARGS` 一致；
- `gt` 始终为列表，空列表是否有明确语义；
- 工具 prompt token 长度不会挤掉用户问题；
- 相同问题能产生多种合理轨迹，而不是只有唯一格式。

## 10. 一个重要的长度事实

`--max_seq_len` 被传入 `MiniMindConfig(max_seq_len=...)` 和 Dataset，但当前 Agent rollout 没用它截断初始 prompt；真正训练侧上界是 `--max_total_len`，在轨迹完成后从左侧截断。

因此超长工具 schema 可能在 rollout 阶段先消耗大量上下文和显存。生产化应在模板后、生成前显式执行 token budget 策略，并优先保留 system 工具定义、最近用户问题和必要 observation。

## 11. 思考题

1. 为什么 online RL 要删除数据中的最后一条参考 assistant？
2. 如果 `gt` 是字符串而非列表，`len(gt)` 和遍历逻辑会怎样误解它？
3. 工具描述很长但工具从不被选中，应先检查模型能力、schema 文案还是 reward？如何分层定位？
4. 如何修改 Dataset，使“无参考答案、最后就是 user”的数据也能安全加载？
