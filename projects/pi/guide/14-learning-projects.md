# 14｜渐进式实战项目

下面四个项目从单进程内存实验逐步走向扩展、会话分析和远程客户端。每个项目都要求先写设计说明，再实现，再用测试证明。

## 项目一：零网络 Mini Agent

### 目标

只使用 `pi-ai`、`pi-agent-core` 和 Faux Provider，完成一个可调用内存工具的 Agent。不要加载 coding-agent、真实模型或文件系统。

### 背景

这是验证你是否真正理解“模型事件”和“Agent 事件”差异的最小项目。

### 功能

实现两个工具：

    add_note({ text })
    list_notes({})

预制模型行为：

1. 用户说“记下 alpha”；
2. Faux assistant 调用 add_note；
3. 工具返回成功；
4. Faux assistant 输出“已记录”；
5. 用户再问列表；
6. 模型调用 list_notes 并总结。

### 实现步骤

1. 阅读 AI `faux.ts` 的构造 helper；
2. 实现内存数组，不访问磁盘；
3. 为工具定义 TypeBox 参数；
4. 创建按调用次数返回不同流的 StreamFn；
5. 创建 Agent，注册工具；
6. 订阅 AgentEvent 并打印简洁轨迹；
7. 分别消费实时事件和最终 result；
8. 增加 abort；
9. 用 InMemoryTelemetry 包住两次模型调用和工具。

### 验收标准

- [ ] 不需要 API key；
- [ ] 所有测试完全确定；
- [ ] 第二次模型 Context 含正确 toolResult；
- [ ] toolCallId 一致；
- [ ] 事件有 start/end，不只检查文本；
- [ ] abort 后有 agent_end；
- [ ] telemetry 工具 span 挂在 prompt span 下；
- [ ] 无未处理 Promise rejection。

### 进阶

- 两个 `add_note` 并行调用；
- 将其中一个工具设为 sequential；
- Faux 返回 stopReason=length，验证工具绝不执行；
- 自定义一种 AgentMessage，并通过 convertToLlm 过滤。

### 源码提示

- [AI 类型](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/types.ts)
- [Faux Provider](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/providers/faux.ts)
- [Agent 类型](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/types.ts)
- [Agent loop tests](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/test/agent-loop.test.ts)

## 项目二：安全命令扩展

### 目标

为 coding-agent 编写一个 `/safe` 扩展，在学习目录中提供工作流级命令限制和确认。

### 功能

- `/safe on|off`；
- safe 开启时禁用 edit/write；
- bash 只允许你明确实现的只读命令；
- 可疑命令在 interactive UI 要求 confirm；
- 无 UI 模式默认拒绝，而不是默认允许；
- footer status 展示 SAFE；
- custom entry 保存状态；
- session 恢复时重建；
- reload 不重复注册/污染状态。

### 设计前必须回答

1. 为什么只从 active tools 移除 write/edit 不够？
2. `git diff` 是只读，但 pager、external diff driver 和 hook 是否可能执行程序？
3. shell 字符串中的 `;`、`&&`、换行、`$()`、重定向如何处理？
4. allowlist 是安全边界还是便利策略？
5. 项目信任和本扩展各解决什么？

### 推荐实现范围

第一版不要写“通用 shell parser”。只允许参数完全匹配的少量命令，例如通过结构化规则解析第一词，并拒绝所有 shell 元字符。清楚说明仍不等于系统沙箱。

### 验收标准

- [ ] TypeBox/命令参数验证；
- [ ] interactive 与 headless 行为明确；
- [ ] 阻止发生在 `tool_call` 执行前；
- [ ] 状态持久化但不进入 LLM context；
- [ ] 退出 safe 恢复原工具，而非硬编码覆盖第三方工具；
- [ ] 单元测试覆盖 shell 拼接、换行和空命令；
- [ ] UI 取消不会执行命令；
- [ ] README 写明威胁模型。

### 参考

- [hello 工具](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/examples/extensions/hello.ts)
- [确认扩展](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/examples/extensions/confirm-destructive.ts)
- [plan mode](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/examples/extensions/plan-mode/index.ts)

## 项目三：Session Tree Inspector

### 目标

实现一个只读 CLI，解析 Pi JSONL 会话并输出：

- header/version；
- 树和所有 leaves；
- 当前 leaf 路径；
- message 角色、toolCall/result 关联；
- model/thinking changes；
- compaction/branch summary；
- custom/custom_message 区别；
- 悬空 parent、重复 ID、环、坏 JSON 行；
- 每个分支的近似模型可见消息数。

### 安全约束

- 默认不打印消息全文，只显示类型、长度和脱敏预览；
- 不修改原文件；
- 对超大文件流式读取；
- 限制单行大小；
- 错误报告不回显敏感 payload；
- 路径参数显式传入，不扫描整个 home；
- 增加 `--show-content` 时明确警告。

### 实现阶段

#### 阶段一：内存模型

手工创建 A～F 分支条目，建立 `byId` 与 children。

#### 阶段二：JSONL parser

正确处理：

- LF/CRLF；
- 末尾无换行；
- UTF-8 跨 buffer；
- 坏行位置；
- header。

#### 阶段三：语义分析

- 找 root/leaves；
- 从 leaf 回溯；
- 检测 parent 环；
- 标记当前分支；
- 区分模型可见与不可见条目。

#### 阶段四：输出

先做纯文本树，再可选输出 JSON。终端宽度处理可复用 TUI 工具，也可让纯文本不含 ANSI。

### 验收标准

- [ ] 与 SessionManager 对同一 fixture 构建的路径一致；
- [ ] 分支不按文件追加顺序误判；
- [ ] compaction 后模型视图正确；
- [ ] custom 不算模型消息；
- [ ] 1GB 理论文件不会一次性读入内存；
- [ ] 坏文件只读报告；
- [ ] 测试覆盖跨块 Unicode；
- [ ] 默认输出不泄漏全文。

### 进阶

- 输出 Mermaid/DOT；
- 比较两个 leaf 的共同祖先和差异；
- 将 SQLite backend 的同一领域视图也接入；
- 搜索 tool call 与 result 不匹配。

## 项目四：实验性远程 Session 客户端

### 目标

基于 `pi-client` 和 `pi-server` testing 工具做一个简单客户端 UI，理解 transport、framing、lease 和权威快照。先用内存测试 transport，不要直接暴露公网。

### 功能

- connect/hello；
- list/create/acquire session；
- exclusive 和 shared lease 展示；
- prompt/steer/abort；
- progress 区域；
- snapshot 区域；
- disconnect/reconnect；
- 最后一个 lease 释放后 detach。

### 阶段一：协议，不做 UI

直接使用 protocol encoder/decoder：

- hello；
- 把 frame 按随机 chunk 切分；
- 关联 request ID；
- 拒绝坏版本、超限 frame 和未知字段。

### 阶段二：PiClient

实现 ByteTransportFactory：

- 每次连接新 transport；
- send 保序；
- backpressure；
- onData/onClose/onError；
- 认证在 factory resolve 前完成。

### 阶段三：状态模型

维护两份状态：

    authoritativeSnapshot
    transientProgress

snapshot 到达就替换权威状态并清理不再适用的 progress，不从 progress 猜 phase。

### 阶段四：最小 UI

可以使用普通日志或 TUI。UI 不是重点，先保证状态机和资源释放。

### 验收标准

- [ ] 任意 fragmentation/coalescing；
- [ ] hello 版本校验；
- [ ] pending request 在断连时全部结束；
- [ ] 不自动偷偷重连；
- [ ] exclusive/shared 冲突有明确错误；
- [ ] lease release 期间拒绝新命令；
- [ ] snapshot 权威；
- [ ] diagnostic 不显示原始敏感 payload；
- [ ] 无公网监听；
- [ ] server service 与 transport auth 分离。

### 参考

- [Protocol README](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/protocol/README.md)
- [Framing](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/protocol/src/framing.ts)
- [Client README](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/client/README.md)
- [Server README](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/server/README.md)

## 最终挑战：为 Pi 设计一个新能力

任选需求，例如“远程只读仓库分析”或“会话质量统计”，提交一页设计：

1. 用户问题；
2. 应放在哪个包；
3. 公共类型；
4. 状态所有者；
5. 正常/错误/abort 路径；
6. 事件；
7. 持久化；
8. 扩展还是核心；
9. 安全与隐私；
10. 单元/集成/E2E 测试；
11. 向后兼容；
12. 如何证明它不破坏现有主链。

若你能在不写代码时先把这些边界说清，才算真正理解了项目架构。
