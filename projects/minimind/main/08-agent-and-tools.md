# 08. Tool Calling 与 Agentic RL

本章提供整体导读。逐函数、逐 token 的深入版本见 [Agentic RL 专题教程](agentic-rl/README.md)。

## 1. Tool Calling 不只是输出 JSON

完整工具调用系统包含四层：

1. **协议层**：模板将工具 schema 和消息角色编码进上下文；
2. **模型层**：生成 `<tool_call>{...}</tool_call>`；
3. **执行层**：解析 JSON、校验参数、调用真实或模拟工具；
4. **循环层**：将 tool result 作为 observation 拼回对话，让模型继续回答。

只训练模型输出一段 JSON，不实现执行与回填，就不是完整 Tool Use。

## 2. SFT 中的 Tool Calling 数据

数据通常类似：

```json
{
  "conversations": [
    {"role":"system","content":"","tools":"[...]"},
    {"role":"user","content":"计算256乘37"},
    {"role":"assistant","content":"","tool_calls":"[{...}]"},
    {"role":"tool","content":"{\"result\":9472}"},
    {"role":"assistant","content":"结果是9472。"}
  ]
}
```

`SFTDataset.create_chat_prompt` 将字符串形式的 `tools/tool_calls` 反序列化，再交给 chat template。模板展开为工具说明、`<tool_call>` 与 `<tool_response>`。因此基础 Tool Call 能力已经可以在 full SFT 中学习。

## 3. 推理循环

`scripts/eval_toolcall.py:177-199` 的核心：

```text
messages = [user]
while True:
    content = model(messages, tools)
    calls = parse_tool_calls(content)
    if no calls: break
    messages += assistant(tool_calls)
    for call:
        result = execute_tool(call)
        messages += tool(result)
```

下一次模型调用能看见此前调用和观察结果，从而支持“先生成随机数，再计算平方”这种多步任务。

生产系统不能直接照搬示例中的 `eval` 数学工具。必须使用安全解析器、允许列表、资源限制、超时、权限隔离和审计。

## 4. Agent RL 数据的不同

`AgentRLDataset` 不提供标准回答 token，而提供：

```text
messages: 起始状态
tools:    当前可用动作空间描述
gt:       轨迹最终应命中的答案集合
```

优化对象是一条轨迹：

$$\tau=(a_1,o_1,a_2,o_2,\ldots,a_T)$$

- `a_t`：模型生成的工具调用或最终回答；
- `o_t`：工具返回的 observation；
- reward：轨迹结束后统一计算。

## 5. 多轮 rollout

`train_agent.py:98-157` 的 `rollout_single`：

1. 用当前 messages/tools 渲染 context；
2. rollout 一次 assistant 输出；
3. 解析 `<tool_call>`；
4. 无调用则终止；
5. 有调用则执行工具，将 assistant 与 tool 消息追加到 messages；
6. 渲染加入 observation 的新 context；
7. 继续下一轮，最多 `max_turns=3`。

代码保存的不只是文本，还有：

```text
prompt_ids
response_ids
response_mask
response_old_logps
turn_outputs
unfinished
```

## 6. 最关键的 action/observation mask

模型生成的 token 是 action，应参与 policy gradient：

```python
response_ids.extend(new_ids)
response_mask.extend([1] * len(new_ids))
response_old_logps.extend(new_logps)
```

工具观察由环境给出，不是模型采样动作，不应作为策略目标：

```python
response_ids.extend(obs_delta)
response_mask.extend([0] * len(obs_delta))
response_old_logps.extend([0.0] * len(obs_delta))
```

这解决了一个根本问题：模型可以读取 observation 作为下一步状态，但不应该被训练成“声称自己生成了环境返回值”。

## 7. 为什么重新渲染后取 `obs_delta`

工具消息有复杂模板边界。代码不手工拼 token，而是重新调用 `apply_chat_template`，然后：

```python
current_len = len(prompt_ids) + len(response_ids)
obs_delta = observe_ids[current_len:]
```

这样 observation 包含模板需要的 `<tool_response>`、角色和换行。前提是重新渲染的已有前缀 token 必须与之前完全一致；模板的非确定性或消息序列不一致会造成 token 对齐错误。

## 8. 轨迹打包

`rl_train_epoch` 把可变长轨迹补齐：

```python
ids = prompt + response
mask = [0] * len(prompt) + response_action_mask
old_logps = [0.0] * (len(prompt)-1) + response_old_logps
```

若超过 `max_total_len`，从左侧截断保留尾部。随后：

```text
input_ids            [B*G,L]
full_response_masks  [B*G,L]
old_per_token_logps  [B*G,L-1]
```

语言模型 logp 对应 `input_ids[:,1:]`，所以最终 `completion_mask = full_response_masks[:,1:]`。

## 9. Reward 设计

`calculate_rewards` 分两类。

### 无工具调用

- 回答长度；
- thinking 长度与闭合；
- Reward Model 分数；
- 重复惩罚；
- 总分裁剪到 `[-3,3]`。

### 有工具调用

- `<tool_call>` 标签是否成对；
- 工具名是否在当前 schema 中；
- 必填参数是否存在；
- 有效调用数量与 `gt` 数量是否匹配；
- 最终回答是否命中 `gt`；
- 是否达到最大轮数仍未完成；
- 重复惩罚。

总 reward 作用于整条轨迹，然后像 GRPO 一样在同 prompt 的 `G` 条轨迹内标准化。

## 10. Ground Truth 校验

`validate_gt_in_text` 同时做字符串包含和数值近似匹配。它适合教学用封闭任务，但生产评测要警惕：

- 子串误命中，例如短词出现在无关句中；
- 单位缺失；
- 数值出现但语义相反；
- 多个候选答案的逻辑关系；
- 模型在思考或工具调用中泄露答案，最终结论却错误。

可验证任务应尽量用结构化执行结果，而不是只做文本包含。

## 11. 策略更新

打包后计算：

- 当前 policy 的全序列 token logp；
- reference policy logp；
- rollout 保存的 old logp；
- GRPO 组内 advantage；
- GRPO 或 CISPO token loss；
- MoE aux loss。

所有策略项乘 `completion_mask`，所以工具观察不会产生 policy gradient。reward 虽是整条轨迹一个标量，但广播到该轨迹所有 action token，这是一种序列级信用分配近似。

## 12. 工具的安全边界

教学代码 `MOCK_RESULTS['calculate_math']` 使用受限 builtins 的 `eval` 和 alarm，但仍不应作为不可信生产输入的安全沙箱。真正系统至少要：

- JSON Schema 严格校验类型、范围和长度；
- 工具允许列表与最小权限；
- 网络/文件/进程隔离；
- wall time、CPU、内存、输出长度限制；
- 幂等性与重试策略；
- 脱敏日志和调用审计；
- 明确把工具错误返回给模型，避免伪造成功。

## 13. 训练命令

本地 PyTorch rollout：

```bash
(cd trainer && python train_agent.py \
  --data_path ../dataset/agent_rl.jsonl \
  --reward_model_path ../../internlm2-1_8b-reward \
  --debug_mode)
```

SGLang 需要先从合适目录启动服务，再训练：

```bash
python -m sglang.launch_server \
  --model-path ./minimind-3 \
  --attention-backend triton \
  --host 0.0.0.0 --port 8998

(cd trainer && python train_agent.py \
  --rollout_engine sglang \
  --sglang_base_url http://localhost:8998 \
  --sglang_shared_path ./ckpt_mm \
  --data_path ../dataset/agent_rl_math.jsonl)
```

`sglang_shared_path` 要对训练进程和服务进程都可见。

## 14. 调试一条轨迹

依次验证：

1. chat template 是否包含正确 tools；
2. 第一轮生成文本能否解析为 JSON；
3. 参数校验是否通过；
4. 工具结果是否正确；
5. observation 回填后的 token 前缀是否一致；
6. action mask 中生成 token 为 1、observation 为 0；
7. old logp 长度是否与 response token 对齐；
8. 最终 gt 是否只在有效最终回答中命中；
9. 同组 reward 是否有方差；
10. policy loss 是否只覆盖有效 action token。

`--debug_mode --debug_interval 1` 很有价值，但输出可能很长，只在小数据/短生成下使用。

## 15. 常见失败模式

- 工具 schema 与执行器工具名不同；
- assistant `tool_calls` 格式与模板预期不同；
- JSON arguments 被二次编码，字符串/对象混淆；
- observation token 误设为 action，模型学习伪造工具输出；
- 左截断删掉关键初始问题或工具定义；
- 稀疏最终 reward 无法区分多条失败轨迹；
- 模型学会在文本中写 gt，而没有完成工具任务；
- 多轮达到上限仍有调用，却未正确标记 unfinished。

## 16. 本章检查题

1. 为什么工具结果必须进入 `input_ids`，却必须从策略 mask 排除？
2. 整条轨迹一个 reward 广播到所有 action token 有什么信用分配缺陷？
3. 如何设计“调用数据库并返回准确行数”的结构化 verifier，避免文本子串奖励？
4. 若模板在每次渲染时随机插入 system prompt，`obs_delta` 方法会怎样失败？
5. Tool SFT 与 Agent RL 各自解决什么问题，为什么通常先 SFT 再 RL？
