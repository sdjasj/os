# 10. 实践练习

## 1. 练习路线

按顺序完成，不要直接从正式训练开始：

```text
模板 -> parser -> executor -> fake rollout -> mask
-> reward -> policy loss -> tiny real rollout -> full training
```

每个实验记录输入、期望、实际结果和失败样本。

## 2. 练习一：画出真实模板

目标：能指出工具定义、user、assistant prefix、thinking prefix 的 token 边界。

任务：

1. 构造 calculate_math schema；
2. 分别用 `open_thinking=False/True` 渲染；
3. 打印 token id 和单 token decode；
4. 标出 `<tool_call>` 是否单 token；
5. 计算 schema 占 prompt token 的比例。

验收：encode/decode round trip 一致，两个 thinking 模式只有预期后缀差异。

## 3. 练习二：Parser 模糊测试

测试：

```text
正确 JSON
arguments 是 JSON 字符串
缺结束标签
多个调用
未知工具
缺 required 参数
错误类型
标签数量相同但顺序错误
```

为每个案例记录 parse/schema/execute 三层结果。扩展 parser 返回明确错误码，不再静默吞异常。

## 4. 练习三：Fake Engine 多轮轨迹

基于 [多轮轨迹章节](04-multi-turn-rollout.md) 的 FakeEngine，增加第三轮：

```text
random_number -> observation -> calculate_math -> observation -> final
```

打印每个 token 来源并断言：

- 两段 tool call 和 final 是 action；
- 两段 observation 和模板边界不是 action；
- action 数等于非零 old logp 数；
- 前缀重建完全一致；
- unfinished=False。

再把 `max_turns=2`，观察 unfinished 与 final_text/reward 的变化。

## 5. 练习四：Reward 表驱动测试

建立测试表：

| case | parse | valid tool | gt hit | unfinished | expected reward |
|---|---:|---:|---:|---:|---:|
| 正确调用+答案 | 1 | 1 | 1 | 0 | 3.0 |
| 未知工具 | 1 | 0 | 0 | 0 | 按公式计算 |
| 正确调用无总结 | 1 | 1 | 0 | 1 | 按公式计算 |
| 标签不闭合 | 0 | - | - | 0 | 无工具分支+惩罚 |
| 否定句含 GT | 1 | 1 | 子串误命中 | 0 | 暴露 verifier 缺陷 |

把 reward 拆成分项后用自动断言固定当前行为，重构时避免意外变化。

## 6. 练习五：Token 对齐属性测试

随机生成 prompt/action/observation 片段长度，验证任意组合和左截断后：

```python
len(ids) == len(mask)
len(old_logps) == len(ids)-1
sum(completion_mask) == action_target_count
```

再故意把 prompt 占位从 `P-1` 改成 `P`，确认测试能捕获错位。

## 7. 练习六：手算 GRPO

对一题四条轨迹给奖励：

```text
[-1, 0, 2, 3]
```

手算 mean、population std、advantage，再与 PyTorch 对比。然后全部设为 3，解释为什么 reward clipping 会制造退化组。

## 8. 练习七：GRPO 与 CISPO 梯度

固定 old/new logp 和正负 advantage，分别计算两种 loss 的 `dL/d(new_logp)`。测试 ratio：

```text
0.5, 1.0, 1.3, 6.0
```

画表比较 clip 后梯度，特别观察 CISPO ratio 超过 5 后仍有 `new_logp` 梯度。

## 9. 练习八：结构化数学 Verifier

替换文本子串：

1. 从最终回答解析一个明确 `<final_answer>` 数值；
2. 拒绝多个冲突数值；
3. 支持绝对/相对误差；
4. 检查单位；
5. 对否定句和 thinking 泄露不计分；
6. 返回 error code 与 breakdown。

用至少 30 个正反例做单元测试。

## 10. 练习九：增加安全工具

实现 `add_integers`：

- schema、validator、executor 同步；
- 严格类型和范围；
- 结构化成功/错误返回；
- Dataset 样本；
- 模板检查；
- SFT 推理检查；
- Agent reward 测试；
- 未见数值组合泛化评测。

不要使用 `eval`。

## 11. 练习十：Tiny Agent Smoke Test

正式权重与数据准备好后，复制 4-16 条能力范围内样本到 tiny JSONL，设置：

```text
batch_size=1
num_generations=2 或 4
max_gen_len=64/128
max_total_len=512
debug_interval=1
save_interval=1
```

至少检查一个 optimizer step 前后：

- 轨迹文本；
- reward 分项；
- group std；
- ratio；
- action token 数；
- grad norm；
- 固定 held-out 任务输出。

只有 smoke test 正确，才扩大数据和长度。

## 12. 练习十一：EOS 改造

当前 rollout 过滤生成 EOS。尝试改造成：

- completion ids 保留首个 EOS；
- EOS old logp 保留；
- EOS 标记 action=1；
- 模板重建时不重复计算同一个 EOS；
- prefix assertion 仍通过；
- completion mask 在首个 EOS 截止。

比较修改前后平均生成长度和正常终止率。

## 13. 练习十二：SGLang 一致性

对相同模型、prompt 和固定可控采样设置，比较 Torch/SGLang：

- tokenizer ids；
- completion ids；
- EOS；
- per-token logp 误差；
- completion mask；
- 解码文本；
- 多 generation 排序。

允许浮点小误差，但不允许 token 或位置错位。

## 14. 毕业项目：可靠 Agent RL 管线

交付物：

1. 可版本化工具 registry；
2. 严格 schema validator；
3. 隔离执行器；
4. 结构化轨迹格式；
5. token/action/observation provenance；
6. reward breakdown 与 verifier 测试；
7. GRPO/CISPO 指标；
8. Torch/SGLang 一致性测试；
9. held-out end-to-end benchmark；
10. reward hacking 红队案例。

## 15. 完成标准

你应能不看教程回答：

1. `response_ids/mask/old_logps` 为什么等长？
2. 打包后的 old logp 为什么是 `L-1`？
3. observation mask 为 0 为什么仍改变后续 action？
4. 当前 reward 为什么可能鼓励不调用工具直接猜答案？
5. SGLang 权重同步间隔怎样影响 ratio？
6. 当前实现为什么不直接优化 EOS？
7. `num_generations=1` 为什么使 GRPO 失效？
8. 总 reward 上升为什么不能单独证明 Agent 能力提升？
