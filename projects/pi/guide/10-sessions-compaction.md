# 10｜会话与压缩：append-only JSONL、分支树和长期上下文

会话系统解决两个不同问题：

1. 保存完整、可恢复、可分支的交互历史；
2. 在模型上下文有限时构造一个可用的历史视图。

核心文件：

- [SessionManager](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/session-manager.ts)
- [消息转换](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/messages.ts)
- [Compaction](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/compaction/compaction.ts)
- [Branch summarization](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/compaction/branch-summarization.ts)

## 1. JSONL 文件结构

当前格式版本是 3。第一行是 header：

    {
      "type": "session",
      "version": 3,
      "id": "...",
      "timestamp": "...",
      "cwd": "...",
      "parentSession": "..."
    }

之后每行是一个 `SessionEntry`，共同字段：

    {
      "type": "...",
      "id": "8-char-or-uuid",
      "parentId": "previous-entry-id-or-null",
      "timestamp": "..."
    }

文件行顺序是追加顺序；当前对话顺序则由 parentId 路径决定。二者不能混为一谈。

## 2. 条目类型

### message

保存 `AgentMessage`：用户、assistant、toolResult，以及经扩展转换的消息。

### model_change / thinking_level_change

模型与思考级别也是会话状态。恢复时沿当前分支寻找有效设置。

### compaction

保存旧上下文摘要、首个保留条目 ID、压缩前 token 数、usage 和可选 details。

### branch_summary

切换/分叉时保存被离开分支的摘要，帮助新路径保留必要背景。

### custom

扩展私有数据，不进入模型上下文。

### custom_message

扩展注入的上下文消息，会转换为 user 侧消息；`display` 决定 TUI 是否展示。

### label / session_info

分别表示条目标记和会话显示元数据。它们不会自动变成聊天内容。

## 3. 一个有分支的例子

假设文件追加顺序：

    A user: "分析 bug"          parent=null
    B assistant: "原因是 X"    parent=A
    C user: "按方案一修复"      parent=B
    D assistant: "已修复"      parent=C
    E user: "改用方案二"        parent=B
    F assistant: "方案二说明"  parent=E

树：

    A
    └─ B
       ├─ C
       │  └─ D
       └─ E
          └─ F  ← current leaf

当 leaf 是 F，模型上下文路径是 `A → B → E → F`。C/D 仍在文件中，可再次切换，但不进入当前分支上下文。

分支不需要复制 A/B，也不需要删除 C/D；只需让新条目的 parentId 指向 B，并移动当前 leaf。

## 4. buildSessionPath

逻辑可写成：

    byId = Map(entries by id)
    current = requested leaf or latest valid leaf
    path = []

    while current exists:
      path.push(current)
      current = byId.get(current.parentId)

    return reverse(path)

实际实现还要处理缺失 parent、迁移旧格式、标签和防御性索引。任何会话可视化工具都应检测环和悬空引用，即使正常写入不会产生它们。

## 5. 从条目到模型上下文

`sessionEntryToContextMessages` 决定每种条目是否以及如何进入 LLM：

- message → 原消息；
- custom_message → 转为上下文消息；
- compaction/branch summary → 转为特殊摘要消息；
- custom/label/session_info → 不进入；
- model/thinking changes → 影响设置，不成为聊天文本。

`buildSessionContext`：

    path = buildSessionPath(...)
    settings = getSessionContextSettings(path)
    contextEntries = buildContextEntries(...)
    messages = contextEntries.flatMap(sessionEntryToContextMessages)

持久化格式和模型格式由转换函数隔开，因此可保存 UI/扩展元数据而不污染 token。

## 6. 何时持久化

Agent 流式生成时会发很多 `message_update`，但 SessionManager 不为每个 delta 追加行。`AgentSession._handleAgentEvent` 在完整 `message_end` 边界追加 user/assistant/toolResult。

好处：

- 文件体积与消息数相关，而不是 token delta 数；
- 恢复时不会拼装半截流；
- 一条条目包含完整 usage、stopReason 和内容块。

实现还对新会话首次持久化时机做谨慎处理，以避免只有空壳/无有效 assistant 的噪声会话。阅读 append 路径时要同时检查内存 entries 和实际文件创建时机。

## 7. append-only 的事务思维

append-only 不代表永远不会写坏。应考虑：

- 进程在半行 JSON 中退出；
- 文件末尾缺少换行；
- 旧版本需要迁移；
- 一行 JSON 语法坏；
- header 无效；
- 大文件不能一次读入；
- UTF-8 字符恰好跨读取 buffer。

当前 loader 用流/缓冲和 `StringDecoder` 处理跨块 UTF-8，并跳过无法解析的行；对 header 和修复步骤有额外保护。

如果你实现其他后端，必须定义等价的原子性和恢复语义，而不只是“存一张 messages 表”。

## 8. 为什么需要 compaction

设模型上下文窗口为 `W`，当前上下文估算为 `C`，预留输出为 `R`：

    当 C > W - R 时触发压缩

默认设置：

    enabled = true
    reserveTokens = 16384
    keepRecentTokens = 20000

数值可配置；默认值仅描述当前快照。

预留 token 很重要。若等到 `C >= W` 才压缩，连“请求模型生成摘要”或下一回复的空间都可能没有。

## 9. token 估算

优先使用最近一个有效 assistant message 的 usage，因为它是 Provider 对当时完整上下文的实际计量。若其后还有 user/tool 消息，则对尾部额外估算。

若没有可用 usage，就对所有消息估算。aborted/error/全零 usage 不适合作为可靠基线。

估算一定有误差，因此 reserveTokens 也是安全余量，而不仅是输出预算。

## 10. 压缩算法

高层过程：

1. 沿当前 leaf 构建 branch；
2. 找最近有效 usage 并判断阈值；
3. 选择 cut point，使最近约 `keepRecentTokens` 原文保留；
4. 提取较旧消息；
5. 若已有 previous compaction，将旧摘要也纳入更新；
6. 提取已读/已修改文件信息；
7. 用专门 system prompt 请求模型生成结构化摘要；
8. 验证摘要回复未因 length/error/abort 失效；
9. 追加 compaction entry；
10. 重新构建当前 context：

        compaction summary
        + firstKeptEntryId 之后的最近原文

原始旧条目没有被删除。compaction 改变的是当前模型视图，不是抹除审计历史。

## 11. 为什么跟踪文件操作

编程任务的摘要若只保留“讨论了某文件”，恢复后模型可能不知道：

- 哪些文件只读过；
- 哪些实际修改过；
- 关键变更是否已经落盘；
- 接下来应验证什么。

compaction details 会合并此前摘要的文件信息和新消息中的工具调用，帮助摘要保留任务执行状态。

## 12. 切分点约束

不能在任意消息中间截断：

- assistant toolCall 与 ToolResult 需要配对；
- 自定义上下文可能有边界语义；
- 只保留工具结果却丢掉调用会让 Provider 拒绝或模型困惑；
- recent token 目标只是目标，不应破坏消息结构。

阅读 cut point 函数时，重点检查“如何处理工具调用序列”，而不只是 token 累加。

## 13. branch summary 与 compaction 的区别

`compaction summary`：

- 原因是当前分支太长；
- 用摘要替代旧历史进入后续上下文；
- 仍沿同一 leaf 工作。

`branch summary`：

- 原因是从一个历史点分叉或离开分支；
- 总结被离开的工作，帮助新分支理解已发生事项；
- 与树导航语义相关。

二者都生成摘要，但触发条件、引用字段和上下文位置不同。

## 14. CustomEntry 与 CustomMessage 的选择

假设扩展记录：

    { readonlyEnabled: true }

模型不需要看到内部布尔值，应使用 custom entry。恢复时扩展扫描最后状态。

假设扩展注入：

    "当前任务只能做只读分析"

模型必须看到，应使用 custom message 或 before_agent_start/context hook。若只对下一轮有效，临时 hook 通常比永久 custom message 更合适。

## 15. 一个会话检查器的伪代码

    read header
    assert version supported
    entries = parse each complete JSONL line
    byId = new Map()

    for entry in entries:
      report duplicate id
      report missing parent
      add child edge

    detect cycles
    print roots and leaves
    for each leaf:
      print path
      build model-visible entries
      estimate token contribution

不要让检查器自动“修复”原文件；先生成只读报告。修复应备份并有明确策略。

## 16. 动手练习

### 练习 A：手工分支

用六个内存条目构造本章 A～F 树。分别以 D、F 为 leaf 调 `buildSessionContext`，断言消息路径不同且共同前缀复用。

### 练习 B：压缩触发

为 `shouldCompact` 做边界测试：

- disabled；
- 刚好等于 `W-R`；
- 比阈值多 1；
- reserve 大于 window 的异常配置。

然后测试最近 usage + trailing messages 的估算。

### 练习 C：摘要质量评审

准备一段包含：

- 用户目标；
- 两次失败尝试；
- 三个读文件；
- 一个实际修改；
- 未运行的测试。

生成摘要后检查它是否保留“失败原因、已改内容、未完成验证”，而不只保留聊天主题。

### 练习 D：会话可视化器

完成第 14 章项目三：只读解析 JSONL，输出树、当前路径、摘要节点、模型/思考级别变化和异常引用。
