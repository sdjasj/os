# 09. 调试、评测与扩展

## 1. 按层调试，不要先调超参数

推荐顺序：

```text
schema/data
  -> template text
  -> token prefix
  -> parser/validator/executor
  -> single-turn fake rollout
  -> multi-turn mask/logp alignment
  -> reward breakdown
  -> group advantage
  -> policy gradient
  -> real model rollout
  -> SGLang/DDP
```

如果 parser 成功率只有 5%，调整 beta 几乎没有意义。

## 2. 数据层断言

```python
assert isinstance(sample['messages'], list)
assert sample['messages']
assert sample['messages'][-1]['role'] == 'user'
assert isinstance(sample['tools'], list) and sample['tools']
assert isinstance(sample['gt'], list)
for tool in sample['tools']:
    assert tool['type'] == 'function'
    assert tool['function']['name'] in MOCK_RESULTS
```

注意 Dataset 已删掉参考 assistant，因此返回 messages 最后一项应通常是 user/tool 后的初始待回答状态。

## 3. 模板前缀一致性

在 `rollout_single` observation 切片前增加调试断言：

```python
expected_prefix = prompt_ids + response_ids
actual_prefix = observe_ids[:len(expected_prefix)]
if actual_prefix != expected_prefix:
    for i, (a, b) in enumerate(zip(expected_prefix, actual_prefix)):
        if a != b:
            raise AssertionError(
                f'prefix mismatch at {i}: expected={a}, actual={b}'
            )
```

再 decode 差异前后各 10 个 token。只比较字符串可能忽略 normalizer 和 special token 差异。

## 4. 轨迹不变量

每条轨迹：

```python
assert len(response_ids) == len(response_mask)
assert len(response_ids) == len(response_old_logps)
assert set(response_mask) <= {0, 1}
for m, lp in zip(response_mask, response_old_logps):
    if m == 0:
        assert lp == 0.0
```

打包后：

```python
assert input_ids.shape == full_response_masks.shape
assert old_per_token_logps.shape[1] == input_ids.shape[1]-1
assert completion_mask.shape == old_per_token_logps.shape
assert torch.isfinite(per_token_logps).all()
assert torch.isfinite(ref_per_token_logps).all()
```

## 5. Reward 分项日志

把 `calculate_rewards` 重构成先返回 breakdown，再求 total。每 100 step 按工具/任务类型统计：

```text
parse_rate
schema_valid_rate
execution_success_rate
gt_success_rate
final_answer_rate
unfinished_rate
mean_tool_calls
format_score
repeat_penalty
total_reward
```

如果 total 上升而 gt success 不升，优先判定 reward hacking，而不是宣称 Agent 能力提升。

## 6. 退化组定位

记录每组 reward 向量：

```python
degenerate = grouped_rewards.std(1, unbiased=False) < 1e-6
print('degenerate_rate', degenerate.float().mean())
```

原因分类：

- 全部无法解析工具；
- 全部调用同一错误工具；
- reward 裁剪全部饱和到 3/-3；
- RM 输出几乎常数；
- 采样 temperature 太低；
- 模型太弱或任务太难；
- verifier 粒度太粗。

## 7. Ratio 与 policy age

```python
masked_ratio = ratio[completion_mask.bool()]
for q in [0.5, 0.9, 0.99]:
    print(q, torch.quantile(masked_ratio, q))
```

Torch 路径一次更新前 ratio 应接近 1。SGLang 大幅偏离通常说明权重同步不及时、logp/token 对齐错误或 tokenizer 不一致。

## 8. 梯度归因

选择一条简单轨迹，将 observation token 改成另一个值但 mask 保持 0。后续 action logp 和梯度可以变化，因为状态改变；observation 自身位置不应直接进入 loss。这能验证“mask 为 0 不等于完全无影响”。

还可注册 embedding 梯度 hook，检查 observation token 对应 embedding 行仍可能因作为上下文而收到间接梯度，这是正常的；被 mask 排除的是“预测 observation token”的 loss，不是禁止它参与后续计算。

### DDP 参数一致性

Agent 训练当前用 unwrapped policy 做可训练前向。多卡实验必须在 optimizer step 后比较参数校验和：

```python
p = next(model.parameters()).detach()
checksum = p.float().sum()
gathered = [torch.zeros_like(checksum)
            for _ in range(dist.get_world_size())]
dist.all_gather(gathered, checksum)
if dist.get_rank() == 0:
    print('rank checksums:', [x.item() for x in gathered])
```

校验和只能快速报警；严格测试应抽取同一参数若干位置 `all_gather` 后逐项比较。若各 rank 在一步后分叉，将训练前向改为经过 DDP wrapper，并重新测试。

## 9. 评测要分层

### 协议指标

- tool-call tag 闭合率；
- JSON parse rate；
- schema validity；
- unknown tool rate。

### 环境指标

- execution success；
- timeout/error rate；
- observation utilization；
- 平均调用数与轮数。

### 任务指标

- final answer exact/structured match；
- end-to-end task success；
- 不需要工具时的 abstain/no-call accuracy；
- 需要工具时的 call recall。

### 稳定性指标

- 多随机种子 pass@k；
- 未见工具/参数组合泛化；
- 工具错误后的恢复率；
- 长上下文与多轮退化。

## 10. 与 `eval_toolcall.py` 的差异

推理脚本也执行多轮循环，但没有训练侧的 old logp、mask、reward 和组内采样。它适合验证部署行为。训练/评测工具表也不完全相同：评测脚本额外有随机数、文本长度等工具，训练 Agent 的执行映射只有六种。比较结果前先统一工具集合。

## 11. 推荐的代码改进顺序

### 第一阶段：可观察性

- prefix/shape 断言；
- reward breakdown；
- parser 错误分类；
- ratio/clip/degenerate 指标；
- 轨迹 JSONL 日志。

### 第二阶段：正确性

- JSON Schema 严格校验；
- execution success 纳入 reward；
- 结构化 verifier；
- 明确保留并训练 EOS；
- 按消息优先级截断。

### 第三阶段：吞吐

- 同轮动态 batching；
- 并发工具执行；
- rollout/learner 分设备；
- 减少重复全序列 logp 前向；
- 更高效权重同步。

### 第四阶段：算法

- step/process reward；
- per-turn advantage；
- verifier-guided search；
- curriculum；
- replay/off-policy 校正；
- 异步 rollout。

先保证轨迹正确和指标可信，再引入复杂算法。

## 12. 生产工具安全

必须考虑：

- 不可信参数与 prompt injection；
- 最小权限与工具 allowlist；
- 网络/文件/进程隔离；
- secrets 不进入模型上下文；
- 调用超时、限额和幂等；
- 多租户隔离；
- PII 脱敏；
- 工具结果可信度和来源；
- 完整审计但不记录敏感内容。

训练中安全模拟工具与生产工具应使用相同协议，但不必共享危险执行权限。

## 13. 常见症状速查

| 症状 | 优先检查 |
|---|---|
| reward 恒定 | 分项、组 std、任务难度、采样温度 |
| loss 有变化但成功率不升 | reward hacking、mask、GT verifier |
| ratio 极大 | old logp 对齐、SGLang stale、tokenizer |
| 工具调用越来越多 | tool_gap/调用奖励是否鼓励冗余 |
| 会调用但不总结 | unfinished/final reward、SFT 数据 |
| 直接猜答案不调用 | 无工具分支 RM 给分漏洞 |
| 生成重复 | reward、temperature、KL、重复惩罚分词 |
| 多卡卡死 | rank 控制流、工具超时、DDP forward 次数 |
| SGLang 更新失败 | 共享路径、模型格式、服务 API/权限 |
| 长轨迹突然变差 | 左截断删掉 system/user、RoPE 上限 |

## 14. 本章检查题

1. observation mask 为 0，为什么其 embedding 仍可能有梯度？
2. 总 reward 上升时至少还要看哪三个任务指标？
3. ratio 在 Torch 路径第一轮就远离 1，最可能是什么问题？
4. 为什么先增加 reward breakdown 比先换一种 PO 算法更重要？
