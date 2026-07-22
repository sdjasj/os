# Scaling Law 和 Agentic AI (Hacking Day)

# Hacking Day

应对课程向 3 学时调整，将会有 1/4 的课程内容为补充选讲内容，讲授本课程相关的扩展知识，不作为考试内容。

## 1\. 大语言模型和 Agents

# 在课堂上第一次感受 ChatGPT 的威力

## 问 ChatGPT: 编译器会对这段代码做出怎样的优化？

  - 2023.2.16 (ChatGPT 发布 2 个月 17 天)
      - GPT-3.5 给出了完美的回答
      - 在大家还在各种微调 BERT 的时候，忽然感觉世界变了

    int return_1() {
      int x;
      for (int i = 0; i < 100; i++) {
        // Compiler will assign [%0] an assembly operand
        asm("movl $1, %0" : "=g"(x));  // "x = 1;"
      }
      return x;
    }

# 大; 语言; 模型

## 大

  - Schrödinger: 《生命是什么》中的灵魂拷问：原子为什么这么小，我们为什么这么大？
  - 原子本身不可能带有太多的**信息**
      - “大” 是应对宏观复杂性的必要条件

## 语言

  - 人类沉淀千年的世界模型
  - 一个非常棒的，在人类之间对齐的 “物理世界模型” (你无法和外星人对齐)

## 模型

  - 然后，我们就只要一个模型就行了

# 大语言模型的进化

## “眼睛”

  - [ViT](https://arxiv.org/abs/2010.11929)
      - 一切 “感官” 都可以对齐到语言系统上

## “草稿纸”

  - Chain-of-thought
      - GPT-4 时代的宝藏 prompt: “think step by step”
      - 有时候还需要我们帮他想一个 plan
      - (谁说 AI 自己不能想到呢)

## “计算器”

  - [ReAct](https://arxiv.org/abs/2210.03629) 和 [Toolformer](https://arxiv.org/abs/2302.04761)，
      - 知道 123 \* 456 算不对，那就 “结果是 \<| python3 -c “123 \* 456” |\>”
      - 这就是 AI 的手和脚

# LLM Agents

## 既然有眼睛、草稿纸、计算器 (等工具) 了

  - LLM 根本就是一个**活生生的人**
  - 能犯错、能尝试，但最终能把事情做对
      - ChatGPT 之前，我们都用 [thef\*\*k](https://github.com/nvbn/thefuck) (我还带一个同学做增强这个的毕业设计)

## Agentic Loop

  - 记忆：完整的工作区
      - Context + Git repository
      - 有时候觉得 LLM 像是在一个[死亡循环](https://store.steampowered.com/app/1252330/DEATHLOOP/)中
  - 想出一个计划 (分解任务)
  - 逐个执行、调用工具、检查结果
      - 复用：tools, sub-agents, skills

## 2\. 量变和质变

# The Bitter Lesson

## By Richard Sutton (2024 Turing Award Winner)

> The actual contents of minds are tremendously, irredeemably complex; we should stop trying to find simple ways to think about the contents of minds, such as simple ways to think about space, objects, multiple agents, or symmetries. All these are part of the arbitrary, intrinsically-complex, outside world. They are not what should be built in, as their complexity is endless; instead we should build in only the meta-methods that can find and capture this arbitrary complexity.

  - 全文在[这里](https://www.cs.utexas.edu/~eunsol/courses/data/bitter_lesson.pdf)

# “量变引起质变”

## 一个我很喜欢的故事

  - 1980s, 网页的增长速度慢于存储系统的增长速度
      - 我们有朝一日可以存下互联网上所有的数据
      - (所以我们有了 Google)

![](../site_html/static/img/storage-density.jpg)

## 还有一个励志故事

  - Loongson GS132 的 “烂代码”
      - 它竟然可以运行，后来竟然越来越快了
      - (要从零开始做)

# 再讲一个我经历过的故事

## DeepBlue 的 “Scaling Law”

  - [Elo ranking system](https://www.attackingchess.com/understanding-the-elo-rating-system-in-chess/)

![](../site_html/static/img/garry.jpg)

# 和大家经历过的故事

## AlphaGo 的 “Scaling Law”

  - 2016 年，在美国熬夜看直播

![](../site_html/static/img/lee.jpg)

# 今天的 Scaling Law

## 为什么 OpenAI 敢训练更大的模型？

  - 实验科学：“[Kaplan’s Scaling Law Paper](https://arxiv.org/pdf/2001.08361)”; [Chinchilla Paper](https://arxiv.org/abs/2203.15556)
      - 我们甚至不知道 optimal 在哪里，人类就造出智能机器了
      - 和 “生物进化” 很像：人类也是 highly suboptimal 的

![](../site_html/static/img/llm-scale.png)

# 世界变了

> Heuristics is dead, Policy is Heuristics, LLM is Policy, Mechanism is King.
>
> 原文：“Tape is Dead, Disk is Tape, Flash is Disk, RAM Locality is King.” (Jim Gray, 2006)

## 对 “量变引起质变” 的理解

  - ❌ 沉溺在低水平陷阱里，认为 “做什么都是有意义的”
  - ✅ 要找到 “能走量” 的途径 (Agentic AI, OpenClaw, Agent Skills, …)

## Code is cheap 的时代

  - 以往不具有 scalability 的高级智能，现在 scale 了
      - 可以血洗一切了：“这篇学位论文是否有显著的逻辑错误，致使结论完全不能成立？如果没有，尝试复现实验结果，如果严重不吻合，指出论文可能存在潜在造假的地方。”

## 3\. 打开 Agentic AI

# 如何用好大模型的能力？

## 大模型是 **Transformer**

  - Attention is all you need
      - Prompt engineering 实际上是 **attention engineering**
      - (这就是为什么 GPT 刚开始出来的时候会有非常长的提示词)
  - 没有合适的提示词，LLM 会倾向于 “车轱辘话”
      - (一部分是因为 instruct fine-tuning/RLHF)

## 提示词的方法

  - 帮他**分解问题**
      - 曾经的 “Think step by step” prompt，以及 o1/deepseek-r1
      - Agent 实现了分解和复用 (而不是 single-context 推理)

# 软件工程中的复杂性分解

## “构建合适的抽象”

  - 软件生态 - 系统调用 - 操作系统实现
  - 操作系统/软件生态 - 指令集 - 硬件实现

## 一个软件中也可以有复杂性分解

  - 函数调用 (封装)：自由组合、无限复用
      - register\_user(name=…, gender=…)
  - 但一旦**接口改变**，就涉及软件的多处修改
      - LLM 可以维护，但容易造成失控
  - 实现 sub-systems 和 protocols (类似 syscall/ISA)
      - 例子：Vibe-learning 和基于文件系统的 protocols

# Hacking Day: 尝试

## Vibe Code 一个 OS Kernel\!

  - 全部交给 AI
  - 测试一下模型的能力
      - 我们已经准备好了 os-minimal 的框架
      - GPT-5.4 生成了一个 CLAUDE.md

## 我没有事先准备

  - 随时可能翻车

# [最小 “操作系统”](/OS/demos/intro/os-minimal)

我们希望不依赖任何外部库函数和代码，在 Coding Agent 的协助下实现一个最小的操作系统：在 CLAUDE.md ([AGENTS.md](https://github.com/openclaw/openclaw/blob/main/AGENTS.md)) 描述设计思路、架构、流程等 (对于实际的项目，这些文档需要分解)，并设计一些有用的 skills/subagents，体验 “一个人就是产品经理” 的感觉。(CLAUDE.md 由 GPT-5.4 生成。)
