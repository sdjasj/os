# 05. 奖励函数

## 1. Reward 是任务规格

Agent RL 不会自动理解“任务完成”。代码给什么分，模型就优化什么。MiniMind 的奖励可概括为：

$$R=R_{format}+R_{tool}+R_{gt}+R_{rm}-P_{repeat}-P_{unfinished}$$

最终裁剪到 `[-3,3]`。但实际代码根据是否解析到工具调用走两个不同分支，不能简单认为每条轨迹都包含所有项。

## 2. 输入与分组映射

`calculate_rewards` 接收扁平轨迹数组。第 `idx` 条轨迹属于：

```python
sample_idx = idx // num_gen
tools = tools_batch[sample_idx]
gt = gt_batch[sample_idx]
```

这依赖 rollout 排序为 sample-major。`turn_outputs_batch[idx]` 保存每一轮模型输出，`completions[idx]` 只保存最后一轮输出。

## 3. 先剥离 thinking

```python
turn_answers = [
    turn.split('</think>', 1)[-1].strip()
    if '</think>' in turn else turn.strip()
    for turn in turn_outputs
]
```

工具解析只检查 `</think>` 后部分，避免把 thinking 中讨论工具协议的文字误当真实动作。若输出只有 `<think>` 没闭合，则整段仍参与工具解析。

## 4. 标签闭合惩罚

```python
reward -= 0.5 * sum(
    abs(turn.count('<tool_call>') -
        turn.count('</tool_call>'))
    for turn in turn_answers
)
```

它只比较开闭数量，不验证嵌套和顺序。例如先闭后开数量相等仍不会扣这一项，但 JSON 解析可能失败。更严格方式是状态机/XML parser。

## 5. 无工具调用分支

若所有 turn 都没解析到合法 JSON tool call：

```python
reward += 0.5 if 5 <= len(response.strip()) <= 800 else -0.5
if '</think>' in response:
    reward += 1.0 if 20 <= len(think.strip()) <= 300 else -0.5
    reward += 0.25 if response.count('</think>') == 1 else -0.25
if reward_model:
    reward += reward_model.get_score(messages, answer)
reward -= rep_penalty(answer)
reward = clip(reward, -3, 3)
```

注意这里的 `response` 是最后一轮输出。一个本应调用工具却直接编造答案的轨迹也进入此分支，而且 `gt` 不参与评分，只由 RM/格式判断。这是潜在 reward loophole。

## 6. Reward Model 分数

`LMForRewardModel.get_score` 将初始 prompt 历史和最终 answer 送入外部 RM，并把 RM 原始分裁剪到 `[-3,3]`。之后再与格式奖励相加，最终总分再次裁剪。

RM 只用于无工具调用分支；解析到工具调用的轨迹不使用 RM，而依赖工具合法性和 GT。这种设计避免 RM 对可验证答案喧宾夺主，但也造成两个分支评分尺度可能不同。

## 7. 重复惩罚

`rep_penalty` 按小写后的 3-gram 重复数计算，上限 0.5：

```python
toks = re.findall(r'\w+|[^\w\s]', text.lower())
grams = [tuple(toks[i:i+3]) ...]
duplicate = len(grams) - len(set(grams))
```

对于中文，正则 `\w+` 可能把连续汉字视为较大块，行为与英文按词切分不同。若重复退化主要发生在中文短语，应使用 tokenizer token n-gram 或专门中文切分验证。

## 8. 有工具调用分支：合法调用数

```python
valid_names = {tool['function']['name'] for tool in tools}
valid_call_count = sum(
    name in valid_names and
    name in CHECK_ARGS and
    CHECK_ARGS[name](arguments)
)
```

这里只检查工具名与参数存在性，不检查执行是否成功、结果是否正确。执行器返回错误也可能算 valid call。

## 9. `tool_gap`

```python
tool_gap = (
    abs(valid_call_count - len(gt))
    + max(0, len(tool_calls) - valid_call_count)
)
reward += 0.5 if tool_gap == 0 else -0.5 * tool_gap
```

它把期望有效调用数量近似设成 `len(gt)`。这在“每个 GT 对应一个工具结果”的数据上合理，但不是普适规则：

- 一个工具调用可能产生多个 GT；
- 多步任务可能调用两个工具只产生一个 GT；
- 重试可能是合理行为；
- 无需工具的 GT 仍可能非空。

扩展任务时应把期望调用计划或 verifier 单独放入数据，而不是用 `len(gt)` 代替。

## 10. GT 命中

```python
verified = validate_gt_in_text(final_text, gt)
reward += 2.5 * len(verified) / len(gt)
```

校验支持：

- 大小写不敏感的字符串子串；
- 去逗号后的数字解析；
- 数值误差 `<1e-6`。

例如 gt `84` 可匹配“结果是 84”。但子串校验也可能误判：gt `1` 会匹配“答案不是 1”，短字符串可能出现在无关词中。

## 11. 最终答案提取

```python
final_text = '' if unfinished else (
    answer.split('</tool_call>')[-1]
    if '</tool_call>' in answer else answer
)
```

如果最后一轮同时输出 tool call 和自然语言总结，只取最后一个闭合标签后的文本。若轨迹达到最大 turn 且仍调用工具，`unfinished=True`，final_text 为空、没有 GT 分并额外扣 0.5。

## 12. 奖励手算例子

假设：

```text
gt = ['84']
允许 calculate_math
轨迹有 1 个合法调用
最终回答“计算结果是84。”
无重复、非 unfinished
```

则：

```text
标签差        0
tool_gap      0 -> +0.5
GT 命中率   1/1 -> +2.5
unfinished    0
重复惩罚      0
总分          3.0
```

正好达到裁剪上界。多项继续加分不会再产生区分度，容易出现 reward saturation。

## 13. 直接运行奖励实验

```bash
conda activate deepspeed
python - <<'PY'
from trainer.train_agent import calculate_rewards, TOOLS

tools = [[t for t in TOOLS
          if t['function']['name'] == 'calculate_math']]
turns = [[
  '<tool_call>{"name":"calculate_math","arguments":{"expression":"12*7"}}</tool_call>',
  '计算结果是84。'
]]
r = calculate_rewards(
    prompts=[''], completions=['计算结果是84。'],
    gt_batch=[['84']], tools_batch=tools, num_gen=1,
    reward_model=None, device='cpu',
    turn_outputs_batch=turns, unfinished_batch=[False],
)
assert r.item() == 3.0
print(r)
PY
```

## 14. Reward hacking 审计

对每个奖励项尝试构造反例：

- 不调用工具，直接猜中答案是否能得高 RM 分？
- 输出 GT 但说“不是 GT”是否仍命中？
- 调用合法工具但忽略错误结果是否仍得工具分？
- 用多个冗余工具调用能否操纵 tool_gap？
- 重复内容换同义词能否绕过 3-gram？
- thinking 中泄露 GT、最终回答错误是否被误判？
- 达到 3 分裁剪后，质量更高的轨迹是否失去区分度？

## 15. 更稳健的 verifier 设计

建议 reward 返回结构而非一个标量：

```python
RewardBreakdown(
    parse_ok=1,
    schema_ok=1,
    execution_ok=1,
    result_correct=1,
    final_answer_correct=1,
    format_score=0.2,
    repetition_penalty=0.0,
    total=3.0,
)
```

训练用 total，日志保留分项。这样 reward 上升时能判断是任务成功率提升，还是模型只学会格式。

## 16. 本章检查题

1. 为什么“没有解析到 tool call”不等于“模型正确决定不调用工具”？
2. `len(gt)` 作为期望调用数在哪些任务中不成立？
3. GT 子串命中怎样被否定句利用？
4. 总分裁剪到 3 后，哪些样本失去组内区分度？
