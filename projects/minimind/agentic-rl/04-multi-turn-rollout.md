# 04. 多轮轨迹展开

## 1. `rollout_single` 的输入输出

输入：

```text
rollout_engine, tokenizer
messages, tools
max_turns, max_new_tokens, thinking_ratio, device
```

输出八项：

```text
final_output          最后一轮模型文本
final_context         最后一次完整模板文本
prompt_ids            第一轮初始 prompt token
response_ids          此后动作+观察 token
response_mask         response_ids 中 action=1/observation=0
response_old_logps    action 的 old logp，observation 为 0
turn_outputs          每轮模型文本
unfinished            达到最大轮数仍发起工具调用
```

## 2. 第一轮状态

```python
context = tokenizer.apply_chat_template(
    messages, tokenize=False,
    add_generation_prompt=True,
    tools=tools, open_thinking=open_thinking,
)
inputs = tokenizer(context, return_tensors='pt',
                   add_special_tokens=False)
if prompt_ids is None:
    prompt_ids = context_ids
```

只有第一轮 context 作为 `prompt_ids`。后续重建 context 的增量被加入 `response_ids`，否则初始 prompt 会重复。

## 3. 模型动作

引擎返回 completion token/logp 后：

```python
pairs = [(tok, lp) for tok, lp in zip(new_ids, new_logps)
         if tok != pad_id and tok != eos_id]
response_ids.extend(action_ids)
response_mask.extend([1] * len(action_ids))
response_old_logps.extend(action_logps)
```

动作 token mask 为 1。当前实现过滤 PAD 和 EOS，所以 RL 不直接优化生成 EOS 的概率。

## 4. 无工具调用时终止

```python
calls = parse_tool_calls(new_text)
if not calls:
    break
```

这既可能表示模型正确给出最终回答，也可能表示工具解析失败。后续 reward 的“无工具分支”会把它当普通回答，因此解析错误需要额外监控。

## 5. 有工具调用时更新环境

```python
messages.append({'role': 'assistant', 'content': new_text})
for call in calls:
    result = execute_tool(name, args)
    messages.append({'role': 'tool', 'content': json.dumps(result)})
```

一次 assistant 输出可以包含多个调用；环境依次执行并追加多个 tool 消息。当前工具彼此独立，没有显式依赖调度。

## 6. Observation 重建

```python
observe_context = tokenizer.apply_chat_template(
    messages,
    add_generation_prompt=not unfinished,
    tools=tools,
    open_thinking=open_thinking,
)
observe_ids = tokenizer(observe_context).input_ids
current_len = len(prompt_ids) + len(response_ids)
obs_delta = observe_ids[current_len:]
```

为什么重新渲染而不是手拼？工具角色边界、`<tool_response>`、消息 EOS 和下一轮 assistant prefix 都由模板统一生成。

`obs_delta` mask 为 0、old logp 填 0。它包括环境结果，也可能包括由模板重建的 assistant 消息结束标记和下一轮 generation prompt。

## 7. 前缀一致性假设

`observe_ids[current_len:]` 隐含假设：

```python
observe_ids[:current_len] == prompt_ids + response_ids
```

只看长度不够。模板、解码再编码、空格规范化或 special token 处理若改变前缀，切片会静默错位。建议加入断言：

```python
expected = prompt_ids + response_ids
assert observe_ids[:len(expected)] == expected
```

在当前代码里，生成 EOS 被过滤，而重新渲染 assistant 消息会加 `<|im_end|>`；该边界从 `obs_delta` 开始，被归类成 observation mask 0。这是当前语义，修改 EOS 策略时必须重做对齐。

## 8. 最大轮数

```python
unfinished = turn == max_turns - 1
```

若最后允许轮仍生成 tool call：

- 工具仍会被执行和回填；
- `add_generation_prompt=False`，不再邀请下一轮 assistant；
- reward 扣 0.5；
- `final_text` 置空，不给 GT 命中奖励。

这避免“最后只调用工具、没有总结答案”的轨迹被算作完成。

## 9. Batch 与 generation 顺序

`rollout_batch` 是双重 Python 循环：

```python
for messages, tools in zip(messages_batch, tools_batch):
    for _ in range(num_gen):
        rollout_single(...)
```

输出顺序为：

```text
sample0/gen0, sample0/gen1, ...,
sample1/gen0, sample1/gen1, ...
```

因此 reward 才能用 `sample_idx = idx // num_gen`，并能 `rewards.view(-1,num_gen)`。改变并行化顺序时必须同步修改这两个假设。

## 10. 用假引擎验证真实轨迹

下面无需模型权重，只用真实 tokenizer 和项目函数生成两轮轨迹：

```bash
conda activate deepspeed
python - <<'PY'
import torch
from transformers import AutoTokenizer
from trainer.rollout_engine import RolloutResult
from trainer.train_agent import rollout_single, TOOLS

class FakeEngine:
    def __init__(self, tokenizer):
        self.t = tokenizer
        self.i = 0
        self.outputs = [
          '<tool_call>{"name":"calculate_math","arguments":{"expression":"12*7"}}</tool_call>',
          '计算结果是84。',
        ]
    def rollout(self, prompt_ids, attention_mask, num_generations,
                max_new_tokens, temperature=0.8):
        text = self.outputs[self.i]
        self.i += 1
        ids = self.t(text, add_special_tokens=False,
                     return_tensors='pt').input_ids
        ids = ids.to(prompt_ids.device)
        full = torch.cat([prompt_ids, ids], dim=1)
        logps = torch.full(ids.shape, -0.5, device=ids.device)
        return RolloutResult(full, ids, logps, [text],
            torch.tensor([prompt_ids.size(1)], device=ids.device),
            torch.ones_like(ids))

t = AutoTokenizer.from_pretrained('model')
messages = [{'role':'user','content':'计算12乘7'}]
tools = [x for x in TOOLS if x['function']['name']=='calculate_math']
result = rollout_single(FakeEngine(t), t, messages, tools,
                        max_turns=3, device='cpu', thinking_ratio=0)
final, context, prompt_ids, response_ids, mask, old_lp, turns, unfinished = result
assert final == '计算结果是84。'
assert len(response_ids) == len(mask) == len(old_lp)
assert 0 in mask and 1 in mask
assert not unfinished
print('turns:', turns)
print('prompt/action-observation lengths:', len(prompt_ids),
      sum(mask), len(mask)-sum(mask))
print('mask transitions:', ''.join(map(str, mask)))
PY
```

## 11. 当前实现的性能特点

`B * G * turns` 次 rollout 基本串行执行。优点是逻辑直观，缺点是 GPU 利用率低。优化方向包括：

- 同一轮批量处理多个轨迹；
- 按当前状态分组，动态 batch；
- 工具执行并发化；
- rollout server 连续批处理；
- 用轨迹状态机替代深层 Python 循环。

任何并行化都必须保持 sample/group 顺序、token/logp 对齐和环境副作用隔离。

## 12. 本章检查题

1. 为什么 `prompt_ids` 只记录第一轮 context？
2. 重新渲染 observation 时，为什么应断言 token 前缀而不仅比较文本？
3. 当前 EOS 被归入哪一类信号？这会如何影响停止行为训练？
4. 把 rollout_batch 改为 generation-first 顺序后，哪些 reward/reshape 代码必须修改？
