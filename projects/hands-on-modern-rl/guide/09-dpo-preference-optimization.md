# 09. DPO：把偏好对直接变成策略目标

上一章的 RLHF 先学习奖励模型，再用 PPO 追逐奖励。
这条路径能处理在线采样，却要同时维护策略、参考策略、奖励模型和价值模型。
有了离线偏好对，我们可以消去显式奖励模型，直接更新语言模型。
Direct Preference Optimization（DPO）由此得到一个监督学习形态的偏好目标。

本章围绕 [`dpo_hands_on.py`](./dpo_hands_on.py) 展开。
我们先从 KL 正则化强化学习推导 DPO，再沿 Chapter 2 的顺序脚本完成实验，
最后建立数据审计和评测矩阵。

## 1. 偏好数据描述的是条件排序

一条 DPO 样本包含三个字段：

\[ (x,y_w,y_l). \]

其中 \(x\) 是 prompt，\(y_w\) 是优选回答，\(y_l\) 是劣选回答。
两段回答必须对应同一个 prompt。
标签表达的是条件偏好 \(y_w\succ y_l\mid x\)，
没有给出两段回答各自的绝对分数。

主脚本内置 10 条数据。
它们把礼貌、有用、共情的回答放在 `chosen`，
把粗鲁、讽刺或拒绝沟通的回答放在 `rejected`。
模型将很容易发现语气差异，数据也因此留下明显的风格捷径。

### 1.1 序列概率只应计算回答部分

设回答 token 为 \(y_1,\ldots,y_T\)。
条件对数概率是

\[ \log \pi_\theta(y\mid x)=\sum_{t=1}^{T}\log \pi_\theta(y_t\mid x,y_{<t}). \]

prompt 负责定义条件，不是被比较的回答动作。
实现必须完成三件事：

1. 用相同格式编码 `prompt + chosen` 和 `prompt + rejected`；
2. shift logits 与 labels，使位置 \(t\) 预测下一 token；
3. 屏蔽 prompt 与 padding，只聚合回答 token 的对数概率。

若 chosen 通常更长，直接求和会引入长度效应；
若改用 token 平均，又会改变序列似然的原始目标。
采用哪种聚合必须与训练库的实现和评测解释一致。

### 1.2 chat template 也是数据定义

脚本的生成函数显式调用 chat template，训练数据却是普通字符串字段。
因此固定快照中的训练格式与推理格式并不一致；`DPOTrainer` 会负责拼接、分词、截断和标签掩码，却不会自动把这些普通字符串改写成脚本推理阶段使用的 chat template。
因此需要从实际 batch 检查以下事实：

- 训练时是否加入了与推理一致的角色 token；
- chosen 与 rejected 的 prompt 前缀是否逐 token 相同；
- 截断是否保留了回答中的关键差异；
- EOS 和 padding 是否被正确处理。

只看原始 JSON 无法回答这些问题。
最终进入损失函数的是 tokenized batch。

## 2. 从 KL 正则化目标推导 DPO

### 2.1 先写出受参考策略约束的奖励最大化

给定 prompt 分布 \(x\sim\mathcal D\)，
RLHF 常用的理想目标是

\[ \max_\pi\;\mathbb E_{x,y\sim\pi(\cdot\mid x)}[r(x,y)]-\beta D_{\mathrm{KL}}(\pi(\cdot\mid x)\Vert\pi_{\mathrm{ref}}(\cdot\mid x)). \]

\(\pi_{\mathrm{ref}}\) 通常是 SFT 模型。
\(\beta>0\) 控制偏离参考策略的代价。
在奖励固定时，这个优化问题的最优策略满足

\[ \pi^*(y\mid x)=\frac{1}{Z(x)}\pi_{\mathrm{ref}}(y\mid x)\exp\!\left(\frac{r(x,y)}{\beta}\right). \]

其中 \(Z(x)\) 是只依赖 prompt 的归一化因子。

### 2.2 反解隐式奖励

对上式取对数并整理：

\[ r(x,y)=\beta\left[\log\pi^*(y\mid x)-\log\pi_{\mathrm{ref}}(y\mid x)\right]+\beta\log Z(x). \]

同一 prompt 下比较两段回答时，
\(\beta\log Z(x)\) 会在分数差中抵消：

\[ r(x,y_w)-r(x,y_l)=\beta\left[\log\frac{\pi^*(y_w\mid x)}{\pi_{\mathrm{ref}}(y_w\mid x)}-\log\frac{\pi^*(y_l\mid x)}{\pi_{\mathrm{ref}}(y_l\mid x)}\right]. \]

这一步是 DPO 的关键。
奖励分差可以由策略相对参考策略的对数概率变化表示，
显式奖励网络因而不再是必要对象。

### 2.3 代入 Bradley–Terry 偏好模型

偏好概率写成

\[ P(y_w\succ y_l\mid x)=\sigma(r_w-r_l). \]

用当前策略 \(\pi_\theta\) 近似最优策略，得到

\[
z_\theta=
\beta\left[
\log\pi_\theta(y_w\mid x)
-\log\pi_{\mathrm{ref}}(y_w\mid x)
-\log\pi_\theta(y_l\mid x)
+\log\pi_{\mathrm{ref}}(y_l\mid x)
\right].
\]

DPO 损失就是偏好标签的负对数似然：

\[ \mathcal L_{\mathrm{DPO}}(\theta)=-\mathbb E_{(x,y_w,y_l)\sim\mathcal D}\left[\log\sigma(z_\theta)\right]. \]

策略若相对参考模型更多地提高 chosen 的概率，\(z_\theta\) 增大，
损失随之下降。
rejected 的相对概率下降也产生同样方向的贡献。

## 3. 如何理解 β

\(\beta\) 源自 KL 正则化奖励目标。
较大的 \(\beta\) 表示偏离参考策略的代价更高，
对应更保守的理想策略。
在 DPO 损失中，它同时缩放偏好 logit \(z_\theta\)，
因而也会改变 sigmoid 的饱和程度和梯度大小。

主脚本比较 `0.01`、`0.1`、`1.0` 三个值。
脚本注释把较小 β 解释为更强的对齐、较大的 β 解释为更保守。
实验时仍要同时观察：

- chosen/rejected 的隐式奖励差；
- 策略相对参考策略的 KL 或回答 log probability 变化；
- 留出任务能力是否退化；
- 训练损失是否因尺度变化而更快饱和。

单看最终 loss 不能比较三个 β 的模型质量。
不同 β 定义了不同尺度的目标，loss 数值不在同一解释标尺上。

## 4. Chapter 2 的顺序脚本先建立最小闭环

项目在 [`chapter02_dpo`](../chapter02_dpo/requirements.txt) 中把流程拆成五步。
这些脚本比一键训练更适合定位工件问题。

### 4.1 第 0 步：固定基础模型

[`0-download_model.py`](../chapter02_dpo/0-download_model.py)
从 ModelScope 下载 `Qwen2.5-0.5B-Instruct`，
并检查本地目录是否存在 `config.json`。
后续脚本优先复用这个目录。

基础模型必须固定。
训练前后若加载了不同 revision，输出差异就不能归因于 DPO。

### 4.2 第 1 步：生成偏好数据

[`1-generate_data.py`](../chapter02_dpo/1-generate_data.py)
从 6 个模板随机采样 100 次，主题是减少过度顺从。
prompt 尾部追加“场景编号”，chosen/rejected 文本则会重复。

这份数据适合验证管线，不能当作 100 条独立语义样本。
随机划分同一批数据会把几乎相同的模板放进训练集和测试集，
从而高估泛化能力。

### 4.3 第 2 步：保存训练前基线

[`2-test_before.py`](../chapter02_dpo/2-test_before.py)
使用一个未逐字出现在模板中的学历 prompt 做生成。
它调用模型 chat template，并只解码 prompt 之后的新 token。

应把完整输出连同模型 revision、解码参数和随机种子保存下来。
终端中一次生成的文本不构成稳定基线。

### 4.4 第 3 步：执行 DPO

[`3-train_dpo.py`](../chapter02_dpo/3-train_dpo.py)
读取 JSON，构造 `prompt/chosen/rejected` 三列，
然后把模型、数据和 `DPOConfig` 交给 TRL。
训练产物写入 `output/dpo_results/final_model/`。

### 4.5 第 4 步：用同一 prompt 复测

[`4-test_after.py`](../chapter02_dpo/4-test_after.py)
加载保存后的模型，复用训练前的测试 prompt。
同一输入与相同解码设置构成最小前后对照。

运行顺序为：

```bash
cd <project-root>/code/chapter02_dpo
python -m pip install -r requirements.txt
python 0-download_model.py
python 1-generate_data.py
python 2-test_before.py
python 3-train_dpo.py
python 4-test_after.py
```

预期观察是模型更愿意礼貌纠正用户的绝对化判断。
如果它在所有问题上都机械加入“其实情况更复杂”，
说明模型学到了表面模板，尚未建立可靠判断能力。

## 5. 主脚本把哪些工作交给 TRL

[`dpo_hands_on.py`](./dpo_hands_on.py) 自己完成：

- 定义 10 条偏好三元组；
- 加载 0.5B 指令模型和分词器；
- 配置 batch size、学习率、epoch 与 β；
- 串行训练三个 β；
- 打印 TRL 日志并保存每个模型；
- 用 4 个 prompt 展示训练前后回答。

`DPOTrainer` 承担了更接近算法核心的部分：

- prompt 与回答的拼接、分词和截断；
- prompt/padding 标签掩码；
- 当前策略与冻结参考策略的序列对数概率；
- chosen/rejected 的 DPO 损失；
- batch、优化器、反向传播和日志指标。

脚本没有显式传入 `ref_model`，因此参考模型的创建与管理依赖
项目固定的 TRL 0.24 行为。
升级 TRL 时应先检查构造参数、数据整理器和指标命名，
不能只要求代码“还能运行”。

封装还隐藏了数据格式边界。
建议在第一个 batch 上打印 token、attention mask、label mask 和截断长度，
确认推理 chat template 与训练表示一致。

## 6. 数据质量决定模型学到什么

### 6.1 明显的风格捷径

主脚本的 chosen 普遍更长、更礼貌、更有结构，
rejected 普遍带有人身攻击和讽刺。
模型只要识别“抱歉、建议、请”等词，就能降低训练损失。
这不能证明它学会了事实判断、共情边界或任务帮助性。

改进数据时应加入更难的对：

- 两段回答都礼貌，只有事实正确性不同；
- 两段回答都正确，只有简洁度不同；
- chosen 更短，避免长度成为固定标签；
- rejected 看似流畅，但包含一个可定位的逻辑错误；
- 对同一主题交换表达风格，保留偏好理由。

### 6.2 泄漏不仅是逐字重复

主脚本的 4 个测试 prompt 中有 2 个直接出现在训练数据里。
另外 2 个虽然是新文本，仍与训练中的负面情绪和礼貌回应高度同构。

应区分三层泄漏：

1. **样本泄漏**：同一 prompt 或回答出现在训练和测试中；
2. **模板泄漏**：只替换人物或主题，句式和偏好规则相同；
3. **标注者泄漏**：同一套措辞习惯同时主导训练标签和评测标签。

划分数据时先按语义模板、来源和标注者分组，再做训练/验证/测试切分。

### 6.3 错误偏好会被直接放大

DPO 没有独立奖励模型作为可检查的中间层。
chosen 中的事实错误、过度拒绝或冗长习惯会直接进入策略更新。
因此每条偏好对至少要记录：

- 偏好理由；
- 标注来源和一致性；
- 安全与事实校验结果；
- 两段回答的长度和格式特征；
- 是否与其他 split 共享模板。

## 7. 一套可复用的评测矩阵

| 切片 | 输入来源 | 主要问题 | 指标 |
| --- | --- | --- | --- |
| 训练内 | 原始训练 prompt | 能否拟合偏好 | pair accuracy、margin |
| 同分布留出 | 相同任务的新 prompt | 能否泛化行为 | 盲评胜率、事实正确率 |
| 模板外 | 不同措辞和领域 | 是否只学表面句式 | 盲评胜率、拒答率 |
| 能力保持 | 数学、代码、知识问答 | 是否遗忘原能力 | 任务准确率、通过率 |
| 风格对照 | 长短与礼貌程度反转 | 是否依赖捷径 | 分层 pair accuracy |
| 安全边界 | 合法请求与危险请求成对 | 是否过度拒绝 | 合规率、过拒率 |
| 分布漂移 | 相对参考模型 | 更新是否过猛 | token KL、长度变化 |

每个切片都应同时比较基础模型与三个 β 模型。
生成评测要固定解码配置；偏好评测要随机交换答案顺序，
避免位置偏差进入结论。

## 8. 运行成本分级

| 级别 | 实验 | 资源与时间特征 |
| --- | --- | --- |
| A | 生成和审计 Chapter 2 偏好 JSON | 秒级，无模型 |
| B | 基础模型前后各生成一次 | 约 1 GB 下载，单模型推理 |
| C | 训练一个 β | 0.5B 模型、参考策略及优化器状态 |
| D | 完整运行主脚本三个 β | 三次串行训练，产生三个模型目录 |

CPU 可以完成小数据实验，但训练时间较长。
GPU 需要为当前策略、参考计算和优化器预留显存。
磁盘还要容纳基础模型与三个输出目录。
首次实验先只保留 `beta_values = [0.1]`，验证管线后再做网格比较。

主脚本应从自身目录运行：

```bash
cd <project-root>/code/chapter09_alignment
python -m pip install -r requirements.txt
python dpo_hands_on.py
```

## 9. 实验一：先审计数据，再训练

运行数据生成脚本后，统计唯一 prompt、chosen 和 rejected：

```python
import json

data = json.load(open("output/preference_data.json", encoding="utf-8"))
for key in ("prompt", "chosen", "rejected"):
    print(key, len({row[key] for row in data}))
```

预期观察：prompt 因场景编号接近 100 个，
chosen 和 rejected 的唯一文本各只有 6 个。
这个差异说明“样本数 100”没有带来 100 种偏好语义。

随后人工抽查以下项目：

- chosen 是否始终更长；
- rejected 是否都含明显负面词；
- 偏好是否由事实质量而非礼貌词决定；
- 是否存在无法确定优劣的歧义对。

## 10. 实验二：比较 β 时控制变量

主脚本为每个 β 重新加载同一个基础模型，
这一点保证了共同起点。
为了让比较有效，还应固定：

- 数据顺序和随机种子；
- batch size、epoch、学习率；
- 最大 prompt 和回答长度；
- 推理解码参数；
- 评测 prompt 与评分规则。

每个 β 记录以下结果：

```text
train loss
rewards/chosen
rewards/rejected
rewards/margins
held-out pair accuracy
token KL to reference
capability retention
```

预期观察是训练 margin 增大。
若训练 margin 很大而留出胜率不变，模型正在记忆训练对或利用风格捷径。
若偏好胜率上升但基础能力明显下降，更新幅度过大或数据覆盖过窄。

## 11. 实验三：做一次泄漏敏感评测

把测试集拆成三组：

1. 主脚本中逐字出现过的 prompt；
2. 相同情绪场景的新措辞；
3. 与礼貌修正无关的事实、代码和数学问题。

对每组统计基础模型与 DPO 模型的人工盲评胜率。
预期结果应呈现难度梯度：训练内最高，模板外较低，能力保持接近基线。
如果三组都输出同一种安抚模板，模型发生了行为过度泛化。

## 12. 自测

1. DPO 为什么可以省去显式奖励模型？
2. 推导中为什么 \(Z(x)\) 会消失？
3. DPO 仍然为什么需要参考策略？
4. β 同时影响哪两个方面？
5. 为什么 100 条由 6 个模板复制出的数据不能视为 100 个独立样本？
6. 训练 loss 下降为何不能证明偏好泛化？
7. `DPOTrainer` 封装后最应该检查哪个实际对象？

参考答案要点：

1. KL 正则化最优策略可把奖励差改写为策略与参考策略的对数概率差；
2. chosen 和 rejected 共享同一 prompt，归一化常数相减为零；
3. 它定义原能力锚点和隐式奖励的相对基准；
4. KL 约束强度以及 DPO logit/梯度尺度；
5. 重复模板高度相关，随机切分还会造成模板泄漏；
6. 模型可能记忆样本或利用长度、礼貌词等捷径；
7. 进入损失的 tokenized batch，包括模板、截断与 prompt mask。

## 13. 本章结论

DPO 把“训练奖励模型，再用 PPO 优化”压缩为一个偏好分类似然。
它仍然依赖 SFT 参考策略、准确的回答对数概率和高质量偏好对。
省去在线强化学习后，数据问题会更直接地进入模型参数。

[`dpo_hands_on.py`](./dpo_hands_on.py) 展示了 TRL 的一体化训练方式；
Chapter 2 的五个顺序脚本则暴露了模型、数据、基线、训练和复测工件。
先用顺序脚本建立可复现实验，再用评测矩阵比较 β，
才能区分真实偏好泛化、模板记忆和基础能力退化。
