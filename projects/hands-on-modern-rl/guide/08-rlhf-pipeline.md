# 08. 从 SFT 到 PPO：RLHF 的工件流水线

前一章的 PPO 在固定维度的动作空间里更新策略。
语言模型把动作空间换成了词表，把一段回答换成了逐 token 的长轨迹。
每一步仍然由策略给出概率，最终奖励却通常要等整段回答生成后才能得到。
有了这种长轨迹，训练必须同时处理文本格式、序列概率、偏好监督和策略约束。

本章以 [`rlhf_ppo_train.py`](./rlhf_ppo_train.py) 为主线，依次建立四个对象：

1. 经过监督微调的策略模型；
2. 由回答偏好训练出的奖励模型；
3. 冻结的参考策略；
4. 用奖励和 KL 约束更新的 PPO 策略。

脚本为了在单机上展示数据流，省略了生产级 RLHF 的多项关键机制。
我们会先推导完整对象，再逐项标出代码真正执行的计算。

## 1. 一段回答是一条自回归轨迹

### 1.1 Chat template 决定模型实际看到的 prompt

用户输入只是业务层字符串。
聊天模型训练时还看过角色标记、消息边界和“现在轮到助手回答”的控制 token。
分词器的 chat template 把这些约定写成模型熟悉的序列。

主脚本生成回答时先构造一条用户消息：

```python
messages = [{"role": "user", "content": prompt}]
text = tokenizer.apply_chat_template(
    messages,
    tokenize=False,
    add_generation_prompt=True,
)
```

`add_generation_prompt=True` 会追加助手回复的起始标记。
模型随后从这个位置继续生成。
奖励模型评分时已经同时拥有用户消息和助手回答，因此使用
`add_generation_prompt=False`，避免再追加一个空的助手开头。

同一份数据若在 SFT、奖励模型和 PPO 阶段使用不同模板，token 边界会改变。
模型学到的条件分布也随之改变。
所以 chat template 属于训练工件的一部分，不能只把它当作显示格式。

### 1.2 token 是语言模型策略的动作

设模板化后的 prompt 为 \(x\)，回答 token 为
\(y=(y_1,\ldots,y_T)\)。
自回归策略把整段回答的概率分解为

\[ \pi_\theta(y\mid x)=\prod_{t=1}^{T}\pi_\theta(y_t\mid x,y_{<t}). \]

乘积在长序列上容易下溢，训练代码使用对数概率：

\[ \log \pi_\theta(y\mid x)=\sum_{t=1}^{T}\log \pi_\theta(y_t\mid x,y_{<t}). \]

这一步把“生成一段回答”还原成了强化学习轨迹：
状态是已有上下文，动作是下一个 token，策略是词表上的 softmax 分布。

### 1.3 shift log probability 为什么要错开一位

因果语言模型在位置 \(t\) 输出 logits，用来预测位置 \(t+1\) 的 token。
因此 [`compute_log_probs`](./rlhf_ppo_train.py) 把最后一个 logits 去掉，
把第一个标签去掉：

```python
shift_logits = logits[:, :-1, :]
shift_labels = input_ids[:, 1:]
log_probs = F.log_softmax(shift_logits, dim=-1)
token_log_probs = log_probs.gather(
    2, shift_labels.unsqueeze(-1)
).squeeze(-1)
```

假设序列是 `[BOS, 我, 会, 答]`。
第一个有效训练对是“看到 BOS，预测‘我’”，
最后一个有效训练对是“看到‘会’，预测‘答’”。
不做 shift 会把每个位置的输出拿去解释当前输入，破坏因果关系。

### 1.4 attention mask 与回答 mask 解决不同问题

attention mask 标记真实 token 和批处理 padding。
回答 mask 标记哪些真实 token 属于模型生成的回答。
RLHF 的策略动作只包含回答 token，因此通常需要

\[
m_t^{\text{response}}=
\begin{cases}
1,& t \text{ 属于回答};\\
0,& t \text{ 属于 prompt 或 padding}.
\end{cases}
\]

主脚本把整条序列的 attention mask 设为 1，
随后直接平均所有 shift 后的 token 对数概率。
它排除了 padding，却没有排除 prompt token。
`generate_response` 已经返回 `input_length`，但训练循环没有用它构造回答 mask。
这会让 prompt 的概率进入 PPO 比率和 KL 统计。

## 2. 三阶段训练由工件连接

RLHF 经常画成 SFT、奖励模型、PPO 三个方框。
真正决定阶段能否连接的是每一步写出的文件和它所依赖的模型版本。

| 阶段 | 输入 | 学习目标 | 本项目输出 |
| --- | --- | --- | --- |
| SFT | 指令与示范回答 | 对模板化序列做语言建模；标准目标只统计回答 token | `output/sft_results/sft_model/` |
| 奖励模型 | prompt、优选回答、劣选回答 | 让优选回答得分更高 | `output/rm_results/value_head.pt` |
| PPO | prompt、策略采样、奖励、参考策略 | 提高奖励并限制策略漂移 | `output/ppo_results/aligned_model/` |

### 2.1 SFT 先提供可用的回答分布

[`sft_pipeline.py`](./sft_pipeline.py) 构造
`(instruction, response)` 示例，用同一 chat template 拼成完整对话。
训练采用教师强制：第 \(t\) 步总是看到数据中的正确前缀。
标准的回答条件似然只统计回答 token：

\[ \mathcal L_{\text{SFT}}(\theta)=-\sum_t \log \pi_\theta(y_t^{*}\mid x,y_{<t}^{*}). \]

SFT 让策略先进入“能按指令生成回答”的区域。
如果直接从一个不懂对话格式的基础模型开始 PPO，
大部分采样都拿不到有区分度的奖励，探索成本会迅速增大。

固定脚本把完整模板化对话存入单个 `text` 字段，再交给 `SFTTrainer`，没有构造只覆盖助手回答的标签掩码。因此当前配置会对用户 prompt、角色标记和回答的整段序列计算语言模型损失。运行时应检查分词后批次的 labels；若目标是上式，需要显式采用只计算回答部分的数据整理器或等价标签掩码。

主脚本优先加载 SFT 输出目录。
目录不存在时，它退回 `Qwen2.5-0.5B-Instruct`。
所以日志中的“PPO 完成”并不能证明前两阶段已经真实执行；
必须同时核对输入工件。

### 2.2 偏好对把“好回答”变成相对判断

奖励数据的一条记录是

\[ (x,y_w,y_l). \]

其中 \(y_w\) 是标注者偏好的回答，\(y_l\) 是同一 prompt 下的劣选回答。
奖励模型输出标量 \(r_\phi(x,y)\)。
Bradley–Terry 模型把分数差解释为偏好概率：

\[
P(y_w \succ y_l\mid x)
=\sigma\!\left(
r_\phi(x,y_w)-r_\phi(x,y_l)
\right).
\]

相应损失为

\[ \mathcal L_{\text{RM}}(\phi)=-\log \sigma\!\left(r_w-r_l\right). \]

当 \(r_w-r_l\) 增大时，损失下降。
该目标只约束排序，分数的绝对零点没有独立含义。

[`reward_model_training.py`](./reward_model_training.py) 取序列最后一个有效 token 的隐藏状态，
再用线性 `value_head` 映射到一个标量。
训练时基础模型与线性头都在优化器中，因此骨干表示也会更新。

### 2.3 奖励模型工件存在配套缺口

奖励模型脚本最终只保存 `value_head.state_dict()`。
它没有保存已经共同训练过的骨干参数。
PPO 脚本发现线性头后，重新加载一份原始 Qwen 骨干，再挂上这个线性头。

这两个对象没有在训练中配套出现过：

```text
训练时：更新后的骨干 hidden state -> 训练后的 value_head
加载时：原始骨干 hidden state   -> 训练后的 value_head
```

线性头依赖输入表示的坐标系。
骨干改变后，只保存线性头不能重建同一个奖励函数。
生产流程应保存完整奖励模型，或冻结骨干并明确记录其不可变版本。

## 3. PPO 阶段需要三个策略角色

### 3.1 当前策略负责采样和学习

当前策略 \(\pi_\theta\) 从 prompt 生成回答。
奖励模型对完整回答给出序列级奖励。
主脚本每一步随机取 4 个 prompt，每个 prompt 采样一段回答。

### 3.2 旧策略固定一次 rollout 的行为概率

PPO 的重要性采样比率应比较当前参数与采样时参数：

\[ \rho_t(\theta)=\frac{\pi_\theta(a_t\mid s_t)}{\pi_{\theta_{\text{old}}}(a_t\mid s_t)}=\exp(\log\pi_\theta-\log\pi_{\theta_{\text{old}}}). \]

采样后应冻结 `old_log_probs`，再对同一批 rollout 做一个或多个优化 epoch。
参数更新后，比率才会偏离 1，裁剪才有机会限制过大的变化。

主脚本记录旧对数概率后，立刻用尚未更新的同一模型计算新对数概率。
同一步中两者权重相同，所以比率数值为 1，或只受随机层影响而接近 1。
接下来只做一次反向传播。
梯度仍能通过新对数概率传回策略，但裁剪分支在这次计算中不会形成有效约束。

### 3.3 参考策略定义长期锚点

参考策略 \(\pi_{\text{ref}}\) 通常是冻结的 SFT 模型。
它与旧策略承担不同职责：

- 旧策略对应本批 rollout 的采样分布，会周期性刷新；
- 参考策略对应对齐起点，通常在整个训练中保持冻结。

主脚本用 `copy.deepcopy(policy_model)` 创建参考模型并冻结参数。
这个对象关系是正确的，后续 KL 的接入方式仍需单独检查。

## 4. 从奖励到 PPO 目标

### 4.1 完整实现需要价值基线或 GAE

序列奖励 \(R\) 本身方差很大。
PPO 通常训练价值函数 \(V_\psi(s_t)\)，再用 GAE 估计逐 token 优势：

\[ \delta_t=r_t+\gamma V(s_{t+1})-V(s_t). \]

\[ \hat A_t=\sum_{l\ge 0}(\gamma\lambda)^l\delta_{t+l}. \]

主脚本没有价值网络，也没有 GAE。
它把 4 个序列奖励减去批均值、除以批标准差，
再把每个序列的一个标量优势用于整段平均对数概率。
这保留了“高于批均值的回答被鼓励”这一机制，
无法表达回答内部不同 token 的信用分配。

### 4.2 裁剪目标限制单批更新幅度

PPO 的裁剪代理目标为

\[
L^{\text{clip}}
=\mathbb E_t\left[
\min\left(
\rho_t\hat A_t,
\operatorname{clip}(\rho_t,1-\epsilon,1+\epsilon)\hat A_t
\right)
\right].
\]

正优势样本的概率不能无界增大，负优势样本的概率也不能无界减小。
主脚本设置 \(\epsilon=0.2\)，但同一步 old/new 相同，
所以这个超参数没有得到预期的实验检验。

### 4.3 KL 约束防止奖励驱动的分布漂移

奖励模型只覆盖有限偏好。
策略若只追逐奖励，可能学会重复格式词、刻意拉长回答或利用评分漏洞。
参考策略提供约束：

\[ J(\theta)=\mathbb E[R(x,y)]-\beta D_{\mathrm{KL}}(\pi_\theta\Vert\pi_{\text{ref}}). \]

主脚本的 `compute_kl_divergence` 在 `torch.no_grad()` 中计算 KL，
随后调用 `.item()` 转成 Python `float`。
`kl_penalty` 因而只是加在日志数值上的常数，
对 `total_loss.backward()` 没有任何梯度贡献。
训练曲线可以显示 KL 变化，但优化器不会主动压低它。

此外，这个 KL 使用整条 prompt+response 序列的分布，
没有用回答 mask 排除 prompt。
完整实现应让 KL 梯度保留在当前策略一侧，并只在生成 token 上聚合。

## 5. 准确阅读这份教学脚本

脚本能够展示以下真实数据流：

1. 用 chat template 构造语言模型输入；
2. 从策略采样完整回答；
3. 用规则或神经网络头产生序列奖励；
4. 用 batch 内奖励归一化建立相对优势；
5. 让优势乘回答概率的梯度更新语言模型；
6. 保存训练指标、图片与最终模型。

它同时包含五个会改变算法含义的简化：

| 代码行为 | 直接后果 | 完整实现方向 |
| --- | --- | --- |
| KL 在 `no_grad` 中转成浮点数 | KL 只记录，不约束梯度 | 保留当前策略侧计算图 |
| old/new 在同次更新前计算 | ratio 约为 1，裁剪不生效 | rollout 后做多轮优化 |
| 只使用 attention mask | prompt token 进入目标 | 构造 response mask |
| batch 奖励直接当优势 | 没有逐 token 信用分配 | 训练 value head 并计算 GAE |
| 只保存 RM 的 value head | 加载时骨干与头不配套 | 保存完整 RM 或冻结骨干 |

规则评分还会奖励长度、列表、代码块和礼貌词。
这些规则适合观察优化方向，也容易被策略机械利用。
因此训练后规则奖励上升，只能说明模型更符合这组规则。

## 6. 运行成本分级

| 级别 | 内容 | 典型成本 | 适合验证的问题 |
| --- | --- | --- | --- |
| A | 阅读函数并运行张量小实验 | 秒级、无模型下载 | shift、mask、log probability |
| B | 单独运行 SFT 或奖励模型 | 约 1 GB 模型下载，CPU 较慢 | 工件格式和损失方向 |
| C | 依次运行三阶段与 PPO 10 步 | 多份 0.5B 模型和优化器状态 | 端到端数据流 |

PPO 脚本创建策略副本，并可能再加载奖励骨干。
所有模型使用 `float32`，内存需求明显高于单模型推理。
脚本虽然打印检测到的设备，却没有把这些模型显式移动到该设备；
按默认加载行为运行时应以 CPU 路径和较长生成时间做预算。

## 7. 实验一：先验证 shift 与回答 mask

在运行大模型前，用一个长度为 6 的玩具序列写出监督位置：

```python
tokens = [10, 11, 12, 20, 21, 22]
prompt_len = 3

labels = tokens[1:]
response_mask = [0] * (prompt_len - 1) + [1] * (len(tokens) - prompt_len)

print(list(zip(tokens[:-1], labels, response_mask)))
```

预期观察：

- 一共得到 5 个“当前位置预测下一 token”的训练对；
- mask 的最后 3 项为 1，对应回答 token `20, 21, 22`；
- prompt 内部的预测对仍可用于 SFT，但不应进入 PPO 回答目标。

接着在主脚本中搜索 `input_length`。
你会看到它在生成函数中计算并返回，却没有参与 `compute_log_probs`。
这个静态检查直接定位了 prompt 未屏蔽的问题。

## 8. 实验二：按工件顺序运行

进入 [`chapter08_rlhf`](./requirements.txt) 对应目录并安装依赖后，依次执行：

```bash
cd <project-root>/code/chapter08_rlhf
python -m pip install -r requirements.txt
python sft_pipeline.py
python reward_model_training.py
python rlhf_ppo_train.py
```

每一步都先检查前一阶段的输出：

```text
output/sft_results/sft_model/
output/rm_results/value_head.pt
output/ppo_results/aligned_model/
output/ppo_results/ppo_stats.json
```

预期观察：

1. SFT 损失可以下降，但小数据上的下降不能证明泛化；
2. 奖励模型的训练对准确率会快速上升，测试集只有少量样本；
3. PPO 日志会输出奖励和 KL，KL 数值不会对梯度产生约束；
4. 对齐前后都使用随机采样，单次文本差异不能直接归因于训练。

为了比较前后输出，应固定随机种子，保存同一组 prompt，
并对每个 checkpoint 采样多次后再汇总奖励与人工评价。

## 9. 实验三：验证两项关键简化

### 9.1 检查 ratio

在计算 `ratio` 后临时记录其数值，不改变训练目标。
第一轮更新前应看到它非常接近 1。
若给同一批 rollout 连续做第二个 optimizer step，再重新计算 new log probability，
ratio 才会反映策略变化。

### 9.2 检查 KL 是否可求导

主脚本返回的 `kl_div` 是 Python 浮点数。
可以在训练前检查：

```python
print(type(kl_div), getattr(kl_div, "requires_grad", None))
```

预期输出的类型是 `float`，没有 `requires_grad`。
这证明 KL 只能作为监控指标。

## 10. 自测

1. `attention_mask` 已经排除了 padding，为什么仍然需要 response mask？
2. 为什么 logits 和 labels 必须 shift 一位？
3. 参考策略与旧策略分别解决什么问题？
4. 同一步中 old/new log probability 相等时，PPO 裁剪为何失去作用？
5. KL 数值出现在 `total_loss` 中，为什么仍可能没有梯度？
6. Bradley–Terry 损失能否确定奖励分数的绝对零点？
7. 奖励模型只保存 value head 会丢失什么？

参考答案要点：

1. attention mask 区分真实 token 与 padding，response mask 区分 prompt 与策略动作；
2. 位置 \(t\) 的 logits 预测位置 \(t+1\)；
3. 旧策略固定 rollout 分布，参考策略固定长期对齐锚点；
4. ratio 为 1，尚未触及裁剪边界；
5. `no_grad` 和 `.item()` 已经切断计算图；
6. 不能，它只约束同一 prompt 下的相对分差；
7. 丢失共同训练后的骨干表示，线性头的输入坐标系不再匹配。

## 11. 本章结论

语言模型 RLHF 的主线由工件串起：SFT 提供可用策略，偏好对训练奖励模型，
参考策略提供 KL 锚点，PPO 再用 rollout、优势和概率比率更新回答 token。
[`rlhf_ppo_train.py`](./rlhf_ppo_train.py) 实现的是简化且不完整的训练：它确实执行反向传播并更新 0.5B 策略模型参数，但 KL 不回传、
同一步 ratio 约为 1、prompt token 未屏蔽，奖励模型工件也缺少配套骨干。
理解这些边界后，日志中的每个数字才有明确含义。
