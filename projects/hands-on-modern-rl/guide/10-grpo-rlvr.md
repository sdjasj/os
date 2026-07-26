# 10. GRPO 与 RLVR：组内比较、可验证奖励和奖励作弊

DPO 需要人工或模型给出 chosen/rejected 偏好对。
数学、代码和形式化任务拥有可自动检查的答案，系统可以在采样后直接验证结果。
有了可验证奖励，同一个问题可以生成一组回答，再用组内相对表现构造优势。
这条路径连接了 RLVR 与 GRPO。

本章先运行纯 NumPy 的 [`grpo_mechanism.py`](./grpo_mechanism.py)，
再阅读 [`grpo_math_reasoning.py`](./grpo_math_reasoning.py) 的模型训练循环。
我们会把脚本准确称为“组归一化 REINFORCE 教学版”，
并补出完整 GRPO 所需的旧策略比率、裁剪和参考策略 KL。

## 1. 先用 NumPy 看清组内优势

给定一个问题 \(x\)，策略采样 \(G\) 个回答：

\[ y_1,\ldots,y_G\sim\pi_{\theta_{\text{old}}}(\cdot\mid x). \]

验证器为每个回答给出奖励 \(r_i\)。
GRPO 用组内均值和标准差建立相对优势：

\[ \bar r=\frac{1}{G}\sum_{i=1}^{G}r_i. \]

\[ s_r=\sqrt{\frac{1}{G}\sum_{i=1}^{G}(r_i-\bar r)^2}. \]

\[ \hat A_i=\frac{r_i-\bar r}{s_r+\varepsilon}. \]

同一问题中的回答共享任务难度。
减去组均值后，优势回答为正，劣势回答为负。
除以标准差后，不同问题的奖励尺度更容易放在同一 batch 中训练。

### 1.1 一个具体数值组

机制脚本使用固定奖励：

```text
[0.35, 0.52, 0.68, 0.41, 0.89, 0.73, 0.28, 0.61]
```

运行：

```bash
cd <project-root>/code/chapter09_grpo_rlvr
python -m pip install -r requirements.txt
python grpo_mechanism.py
```

脚本会打印均值、标准差、每个回答的归一化优势，
并生成奖励归一化与 PPO/GRPO 优势对比图。
这是最低成本的机制实验，不需要下载语言模型。
该脚本直接导入 NumPy 和 Matplotlib；若环境中没有这两个包，需要先安装。

预期观察：

- 优势均值接近 0；
- 优势标准差接近 1；
- 0.89 对应最大的正优势；
- 0.28 对应最大的负优势；
- 原始奖励的绝对大小让位于同组内排序。

### 1.2 组内基线取代了 Critic

PPO 常用价值网络估计基线 \(V(s)\)，再计算 \(R-V(s)\)。
GRPO 用同一问题的其他回答构成经验基线，省去了独立 Critic。
代价是每个 prompt 必须采样多个回答，rollout 计算随 group size 增长。

组内优势还具有相对性。
奖励 0.7 在困难问题中可能最高，在简单问题中可能最低。
算法更新的是“这个回答比同题其他回答好多少”。

### 1.3 零方差组没有学习信号

若一组奖励全部相同，

```text
[0, 0, 0, 0]
```

或

```text
[1, 1, 1, 1]
```

则每个 \(r_i-\bar r=0\)。
分母加 \(\varepsilon\) 只能防止除零，不能创造差异，
所以所有优势都为 0。

这会出现在两个训练阶段：

- 模型太弱时，整组答案全错；
- 模型太强或题目太简单时，整组答案全对。

提高 group size 只能增加发现差异的机会。
真正的解决方向是调整题目难度、采样温度或奖励粒度，
让同一组内出现有意义的质量差异。

## 2. RLVR 把答案检查器放进训练闭环

RLVR 的奖励来自可执行规则、单元测试、符号检查器或形式化验证器。
它减少了人工偏好标注，也把训练上限交给验证器定义。

数学脚本的奖励流程为：

1. 优先提取 `\boxed{...}`；
2. 再匹配中文“答案是/为”；
3. 再匹配英文 `The answer is`；
4. 最后使用回复中的最后一个数字；
5. 与标准答案做浮点容差比较。

答案正确时奖励直接设为 1，错误时为 0。
代码随后尝试对步骤式格式增加 0.1，并把结果限制在 1 以内。

### 2.1 格式奖励实际上已经饱和

主脚本的逻辑可以写成：

```python
reward = 1.0 if answer_is_correct else 0.0
if reward > 0 and has_steps:
    reward = min(1.0, reward + 0.1)
```

正确答案进入格式分支前已经是 1，
`min(1.0, 1.1)` 仍然等于 1。
错误答案不会进入格式分支。
因此最终奖励只有 0 和 1，步骤标记对奖励完全没有影响。

仓库另有更细的 [`rule_based_reward.py`](./rule_based_reward.py)，
它分别计算正确性、格式和启发式推理质量。
数学训练主脚本没有调用这套组合奖励。
阅读两个文件时必须区分“仓库中存在的奖励函数”和“训练循环实际使用的奖励函数”。

### 2.2 可验证不等于不可利用

验证器只观察可解析文本。
模型会寻找任何能让解析器返回正确值的输出模式。
当前兜底规则取最后一个数字，因此以下回答都可能得到满分：

```text
我无法解释过程。42
```

```text
前面的推导全部错误，但答案是 42。
```

```text
题目中的数字有 15 和 27；最后写标准答案 42。
```

若标准答案是 42，验证器不会判断推理是否支持结论。
这种现象称为奖励作弊或 reward hacking：
策略满足了奖励程序的可见条件，却没有获得目标能力。

## 3. 从题目到一次策略更新

数学脚本包含 20 道算术应用题。
每个 epoch 对每道题执行以下步骤：

1. 用 chat template 构造 prompt；
2. 以 `temperature=0.7`、`top_p=0.9` 采样 4 个回答；
3. 用规则提取答案并给出 0/1 奖励；
4. 对 4 个奖励做组内归一化；
5. 计算回答 token 的平均对数概率；
6. 用优势加权并执行一次优化器更新。

3 个 epoch 共处理 60 个问题实例，生成 240 段回答，
每段最多 200 个新 token。
主要成本来自串行生成，而非 NumPy 的优势计算。

### 3.1 回答 token 的对数概率切片

脚本先单独编码模板化 prompt，得到 `prompt_len`，
再把回答 token 拼到后面。
因果 shift 后，预测第一个回答 token 的 logits 位于
`prompt_len - 1`。
所以代码使用：

```python
response_logits = logits[0, prompt_len - 1:-1, :]
response_tokens = full_ids[0, prompt_len:]
```

两者长度一致，每一行 logits 对应一个实际回答 token。
这比上一章把 prompt 和回答一起平均更接近正确的回答掩码。

脚本对 token log probability 取平均，
避免长回答仅因 token 更多而得到更大绝对损失。
这也改变了序列目标的长度权重，实验报告中应明确记录。

### 3.2 训练循环跳过所有负优势

更新函数包含：

```python
if advantage <= 0:
    continue
```

因此只有高于组均值的回答进入损失。
低于组均值的回答没有被显式抑制。
原本零均值的组优势经过筛选后只剩正值，
训练目标变成对组内较好样本做加权似然最大化。

这仍然能提高正确回答的概率，
却不等价于使用完整正负优势的策略梯度。
当一组只有一个正确答案时，它接近“用该答案自训练”；
当整组全错或全对时，没有任何更新。

### 3.3 这份脚本是组归一化 REINFORCE 教学版

脚本的损失为

\[ \mathcal L_{\text{teach}}=-\frac{1}{|P|}\sum_{i\in P}\hat A_i\,\overline{\log\pi_\theta(y_i\mid x)}. \]

其中 \(P=\{i:\hat A_i>0\}\)。
它具有 REINFORCE 的“优势乘 log probability”结构，
优势来自 GRPO 式组内归一化。

它没有保存 rollout 时的旧策略对数概率，
没有重要性采样比率，没有 PPO 裁剪，也没有参考策略 KL。
因此应称为组归一化 REINFORCE 教学版，
不能用它的训练曲线代表完整 GRPO 的稳定性。

## 4. 完整 GRPO 还需要什么

### 4.1 冻结 rollout 的旧策略概率

采样时保存每个回答 token 在旧策略下的对数概率：

\[ \log\pi_{\theta_{\text{old}}}(y_{i,t}\mid x,y_{i,<t}). \]

训练时重新计算当前策略概率，并形成比率：

\[ \rho_{i,t}(\theta)=\exp\left(\log\pi_\theta(y_{i,t}\mid s_{i,t})-\log\pi_{\theta_{\text{old}}}(y_{i,t}\mid s_{i,t})\right). \]

同一批 rollout 可以做多个优化 epoch。
参数改变后，ratio 才反映离采样分布有多远。

### 4.2 对正负优势都使用裁剪代理目标

完整目标对每个回答 token 使用

\[ \min\left(\rho_{i,t}\hat A_i,\operatorname{clip}(\rho_{i,t},1-\epsilon,1+\epsilon)\hat A_i\right). \]

正优势限制概率上升幅度，负优势限制概率下降幅度。
跳过负优势会删除后一半约束。

### 4.3 加入冻结参考策略的 KL

旧策略用于本批重要性采样，参考策略用于长期能力锚定。
完整 GRPO 通常还优化

\[ L_{\mathrm{GRPO}}=L_{\mathrm{clip}}-\beta D_{\mathrm{KL}}(\pi_\theta\Vert\pi_{\mathrm{ref}}). \]

KL 应在回答 token 上计算，并保留当前策略侧梯度。
它降低策略利用狭窄奖励规则、快速偏离原模型的风险。

## 5. 奖励作弊测试

先不要训练模型，直接测试解析器。保持工作目录为 `<project-root>/code/chapter09_grpo_rlvr`，再从 [`grpo_math_reasoning.py`](./grpo_math_reasoning.py) 导入函数：

```python
from grpo_math_reasoning import compute_reward, extract_answer_from_response

cases = [
    "42",
    "推导有误，但最后写 42",
    "步骤1：15+27=41。答案是 42",
    "答案是 41，备注编号 42",
    "没有任何计算，只输出 \\boxed{42}",
]

for text in cases:
    print(extract_answer_from_response(text), compute_reward(text, "42"))
```

预期观察：多个没有可靠推理的文本仍得到 1。
“答案是 41，备注编号 42”会优先匹配中文答案标记，通常得到 0；
这说明规则优先级会改变可利用方式。

再比较格式奖励：

```python
plain = "42"
formatted = "首先计算，然后得到答案是 42"
print(compute_reward(plain, "42"))
print(compute_reward(formatted, "42"))
```

两者都应为 1，直接证明格式加分饱和。

## 6. 组方差实验

用主脚本的优势函数测试三类组：

```python
from grpo_math_reasoning import compute_grpo_advantages

groups = [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 1],
]

for rewards in groups:
    print(rewards, compute_grpo_advantages(rewards))
```

预期观察：

- 前两组优势全为 0；
- 第三组唯一正确回答得到较大正优势；
- 三个错误回答得到负优势，但当前更新函数会全部跳过。

接着把 `advantage <= 0` 的跳过逻辑仅在实验副本中移除，
比较一次更新前后正确与错误回答的平均 log probability。
完整正负优势应同时鼓励正确回答、抑制错误回答。

## 7. 运行成本分级

| 级别 | 内容 | 资源与预期时间 |
| --- | --- | --- |
| A | NumPy 组归一化与奖励作弊测试 | 秒级，CPU |
| B | 单题、4 个回答、一次更新 | 0.5B 模型，分钟级 |
| C | 20 题、1 epoch | 80 次生成，CPU 较慢 |
| D | 默认 3 epoch | 240 次最长 200-token 生成 |

完整脚本使用 `float32` 加载模型并优化全部参数。
GPU 通常需要数 GB 显存，CPU 则要预留较长生成时间。
首次运行可把数据截成 2 题、epoch 攺为 1、`max_new_tokens` 改为 64，
先验证奖励、优势和梯度链路。

保持本章前面建立的工作目录，完成机制与奖励单元测试后再运行模型实验：

```bash
cd <project-root>/code/chapter09_grpo_rlvr
python grpo_math_reasoning.py
```

[`requirements.txt`](./requirements.txt) 固定了 Transformers、TRL、Torch、
Datasets 与 Accelerate 版本。
NumPy 由脚本直接使用；机制可视化还直接使用 Matplotlib。

## 8. 设计更稳健的验证器

奖励函数应从目标失败方式出发设计。
数学任务可以采用分层检查：

1. 严格解析最终答案的结构化字段；
2. 拒绝多个互相冲突的最终答案；
3. 用符号工具复算中间等式；
4. 将答案正确性与格式奖励分别记录；
5. 对解析失败、超长和模板注入设置明确策略；
6. 用一组对抗样例做回归测试。

格式奖励若要产生区分度，应避免先把正确性分数推到总上限。
例如分别返回 `accuracy_reward` 与 `format_reward`，
在日志中观察两个分量，再用经过校准的权重组合。

验证器仍无法证明自然语言推理完全忠实。
它能做的是缩小可作弊空间，并让已知失败模式进入自动测试。

## 9. 自测

1. GRPO 为什么要对同一 prompt 采样多个回答？
2. \(\varepsilon\) 为什么不能解决零方差组？
3. 当前格式奖励为何没有实际贡献？
4. 跳过负优势会怎样改变更新方向？
5. 为什么本脚本应称为组归一化 REINFORCE 教学版？
6. 旧策略与参考策略各自负责什么？
7. “取最后一个数字”会打开哪类奖励作弊路径？

参考答案要点：

1. 同题回答构成难度共享的经验基线；
2. 分子全部为零，非零分母也产生全零优势；
3. 正确答案已得 1，再加 0.1 后被上限裁回 1；
4. 只鼓励高于均值的回答，不再显式压低劣势回答概率；
5. 它没有 old-policy ratio、裁剪和 reference KL；
6. 旧策略固定 rollout 分布，参考策略限制长期漂移；
7. 模型可以把正确数值放在文本末尾而不完成有效推理。

## 10. 本章结论

RLVR 用可执行规则替代部分人工偏好，
GRPO 用同题多回答的组内统计替代 Critic 基线。
两者结合后，训练质量由采样多样性和验证器质量共同决定。

[`grpo_math_reasoning.py`](./grpo_math_reasoning.py) 展示了生成、规则奖励、
组归一化和策略梯度的最小链路。
它跳过负优势，没有旧策略比率、裁剪与参考策略 KL，
因此属于组归一化 REINFORCE 教学版。
先通过零方差实验和奖励作弊测试验证机制，
再增加完整 GRPO 约束，才能解释训练奖励的真实含义。
