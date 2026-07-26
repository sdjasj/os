# 11. MCP、Apps 与 Extensions：三种扩展能力如何汇流

> 本章对应源码快照 <code>61a44880a85d2fd0d8770908dea5733495e571c8</code>。MCP 与 Apps 仍在快速演进；若旧文档、生成类型和当前实现不一致，以该版本源码和测试为准。

## 学习目标

学完本章，你应该能够：

- 分清 Codex 连接外部 MCP server 与 Codex 自己充当 MCP server；
- 解释 MCP catalog 的来源优先级、冲突和调用绑定；
- 说明 app metadata 为什么不等于一个可调用工具；
- 分清 Apps、Plugins 和 Rust Extensions；
- 从配置、catalog、runtime 一路追到模型可见工具和 app instructions。

## 1. 先建立坐标系：MCP 描述协议角色，不描述产品概念

MCP（Model Context Protocol）让 host、client 与 server 通过标准消息交换 tools、resources 和 prompts 等能力。阅读 Codex 时必须先问：“这一段代码中，谁是 MCP client，谁是 MCP server？”

Codex 同时支持两个相反方向：

~~~text
方向 A：出站 / outbound
Codex host ──MCP client──> 外部 MCP server
                         提供 tools/resources

方向 B：入站 / inbound
外部 MCP client ──> Codex MCP server
                    提供 codex / codex-reply 工具
~~~

这两条链路共享 MCP 概念，却有不同配置、生命周期和用途。app-server 又是第三套 JSON-RPC-like API，不能因为它也暴露 MCP 相关方法，就把 app-server 当成 MCP transport。

## 2. 出站 MCP：Codex 如何连接外部服务器

### 2.1 从配置到已解析 catalog

用户配置形状在 [mcp_types.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/config/src/mcp_types.rs)。一个 server 可以使用：

- stdio transport：Codex 启动子进程，通过 stdin/stdout 交换 MCP 消息；
- streamable HTTP transport：连接远端 HTTP endpoint；
- enabled/required、启动与工具超时；
- tool allow/deny filter；
- OAuth、审批行为、环境标识等。

安全原则值得单独记住：HTTP bearer token 应配置成“环境变量的名称”，而不是把 token 字面量写进 TOML。实现会拒绝不安全的 literal bearer 形式。

概念配置：

~~~toml
[mcp_servers.docs]
url = "https://mcp.example.invalid/api"
bearer_token_env_var = "STUDY_MCP_TOKEN"
enabled = true
required = false
~~~

教程中的域名不可访问，环境变量也只是占位符。真实项目应由秘密管理系统注入变量，不要提交 token。

[catalog.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/codex-mcp/src/catalog.rs) 的 <code>McpCatalogBuilder</code> 汇总多个来源，产出 <code>ResolvedMcpCatalog</code>。当前来源大致按以下层级覆盖：

~~~text
plugin
  < selected plugin
  < config
  < compatibility
  < extension
~~~

层内规则还取决于来源携带的顺序值：普通 plugin 和 selected plugin 用 `Reverse<usize>`，因此较早的发现/选择顺序优先；extension 的 `contribution_order` 越大优先级越高；只有两个 action 的完整 `RegistrationPrecedence` 完全相同时，稳定排序才保留插入顺序，并由后插入者成为最终 winner。构建器还会记录 conflict。稳定顺序不是美观问题：工具列表顺序改变会影响缓存、快照和模型上下文。

### 2.2 catalog 不等于已连接 runtime

[runtime.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/codex-mcp/src/runtime.rs) 的 <code>McpRuntime</code> 接收解析后的输入并管理实际运行状态。[connection_manager.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/codex-mcp/src/connection_manager.rs) 负责：

- 启动与连接；
- required server 的失败语义；
- 工具过滤与命名空间；
- resources 读取；
- elicitation；
- 连接复用和增量检查。

因此要区分三个阶段：

| 阶段 | 代表对象 | 回答的问题 |
|---|---|---|
| 声明 | Raw/McpServerConfig | 用户想连接什么 |
| 解析 | ResolvedMcpCatalog | 多来源冲突后保留什么 |
| 运行 | McpRuntime / manager | 当前真正连接和可调用什么 |

### 2.3 为什么一次工具调用要“捕获 binding”

MCP server 可能在一个 turn 中刷新工具列表。若模型选择工具 A 后，执行阶段再按最新 catalog 查同名工具，调用可能被重路由到另一个 server，形成 TOCTOU（检查时与使用时不一致）问题。

[binding.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/codex-mcp/src/binding.rs) 用 prepared/captured binding 固定模型看到的目标。简化对比：

~~~rust
// 错误思路：执行时按易变全局表重新解析
let server = current_catalog.lookup(call.tool_name)?;
server.call(call).await

// 正确心智：准备模型工具时就捕获目标
let binding = catalog.prepare_binding(tool)?;
binding.call(call.arguments).await
~~~

这条不变量由 [binding_tests.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/codex-mcp/src/binding_tests.rs) 覆盖。

### 2.4 外部工具如何进入 agent

core 的 [MCP tool handler](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/mcp.rs) 和 [MCP resource handler](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/handlers/mcp_resource.rs) 把标准化调用接入通用工具编排。MCP 工具仍要经过 Codex 的审批、权限和生命周期逻辑；“来自标准协议”不等于“自动可信”。

app-server 同时为 UI 暴露 <code>mcpServerStatus/list</code>、<code>mcpServer/resource/read</code>、<code>mcpServer/tool/call</code>。这些是 app-server 方法，用来检查或代理 Codex 管理的 MCP runtime，并不把 app-server 连接变成 MCP 会话。

## 3. 入站 MCP：把 Codex 暴露给另一个 MCP host

另一方向的二进制入口在 [mcp-server/lib.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/mcp-server/src/lib.rs)。消息处理器 [message_processor.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/mcp-server/src/message_processor.rs) 实现 MCP server 语义。

在本快照中，<code>tools/list</code> 返回两个核心工具：

- <code>codex</code>：开始一个新的 Codex 会话；
- <code>codex-reply</code>：继续已有会话。

它们最终操作 ThreadManager，但 wire contract 是 MCP tool call，而不是 app-server 的 <code>thread/start</code> 或 <code>turn/start</code>。

对比：

| 场景 | Codex 角色 | 外部看到的接口 |
|---|---|---|
| 配置一个 docs MCP server | MCP client/host | 外部 server 的 tools/resources |
| 启动 Codex MCP server | MCP server | <code>codex</code>、<code>codex-reply</code> |
| 连接 app-server | JSON-RPC-like server | <code>thread/start</code> 等 v2 方法 |

旧的 [codex_mcp_interface.md](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/docs/codex_mcp_interface.md) 含有把 app-server v2 叙述与 MCP 工具放在一起的历史内容。它可帮助理解背景，但判断当前接口时应以 <code>mcp-server</code> 的 <code>tools/list</code> 实现和测试为准。

## 4. Apps：连接器身份、目录状态与可调用能力的交集

Apps 的协议类型位于 [v2/apps.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server-protocol/src/protocol/v2/apps.rs)，包括：

- app catalog 列表和详情；
- installed apps；
- connector metadata；
- 分页 response。

[apps_processor.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/request_processors/apps_processor.rs) 会综合 feature、认证、workspace、plugin capability summary，以及缓存或远端 connector 列表。

关键公式是：

~~~text
一个 app 可调用
  = catalog 中有身份
  ∩ 用户/工作区可访问且启用
  ∩ 对应 hosted MCP server 已运行
  ∩ 至少一个非 synthetic 工具对模型可见
  ∩ 有效 policy 允许
~~~

所以“Apps UI 中看到了某个连接器”不能推出“模型现在可以调用它”。[installed.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/request_processors/apps_processor/installed.rs) 把 installed/callable snapshot 与 host-owned Apps MCP server 的工具状态对齐。

当至少一个 connector 同时 accessible 和 enabled 时，[apps render.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/apps/render.rs) 才生成模型可见的 Apps instructions。相关上下文片段定义在 [apps_instructions.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/context/apps_instructions.rs)。

完整数据流：

~~~text
App catalog metadata
  → plugin 声明 connector IDs
  → hosted Apps MCP runtime
  → MCP catalog / model-visible tools
  → Apps instructions
  → 模型选择并调用已绑定工具
~~~

## 5. Extensions：编译进 host 的 Rust 贡献点

Extensions 不是用户在目录中下载的脚本包。它们是 Rust host 内部的 typed contribution API，定义于 [ext/extension-api](https://github.com/openai/codex/tree/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/ext/extension-api)。

[contributors.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/ext/extension-api/src/contributors.rs) 提供多个职责单一的 trait，例如：

- <code>McpServerContributor</code>；
- <code>ContextContributor</code>；
- <code>ThreadLifecycleContributor</code>、<code>TurnLifecycleContributor</code>；
- <code>TurnInputContributor</code>；
- <code>ConfigContributor</code>；
- <code>SkillInvocationContributor</code>；
- <code>ToolContributor</code>、<code>ToolLifecycleContributor</code>；
- <code>ApprovalReviewContributor</code>；
- <code>TurnItemContributor</code>。

[registry.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/ext/extension-api/src/registry.rs) 的 builder 按类型收集有序 contributor，构建不可变 registry。与“万能 plugin trait”相比，这种设计缩小每个扩展点的权限和调用契约。

app-server 在 [extensions.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/extensions.rs) 组装 goal、git attribution、guardian、memories、MCP、web search、image generation 和 skills 等 host 扩展。

Apps 对 MCP 的接入就是实例：[ext/mcp/lib.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/ext/mcp/src/lib.rs) 中的 hosted plugin runtime extension 实现 <code>McpServerContributor</code>，在 Apps feature 开启时贡献 host-owned MCP server，关闭时移除它。

## 6. Apps、Plugins、Extensions 一张表分清

| 概念 | 本质 | 典型内容 | 何时生效 |
|---|---|---|---|
| App | 外部连接器身份与状态 | catalog metadata、connector ID、授权状态 | runtime 中满足可访问、启用、工具可见和 policy |
| Plugin | 能力资源包 | skills、MCP declarations、apps、hooks | 被发现、选择并通过各子系统策略后 |
| Extension | host 内 Rust 贡献接口 | contributor trait 实现 | 编译并注册进 host 时 |
| MCP server | 协议对端 | tools、resources、prompts | transport 建连并初始化后 |

一个 plugin 可以声明 app 或 MCP server；一个 extension 可以向 catalog 贡献 MCP server；一个 app 的可调用工具通常通过 hosted MCP runtime 到达模型。它们会组合，但不是同义词。

## 7. 测试与实验路线

### 实验 A：只验证 catalog，不连接网络

阅读并运行 catalog 测试：

~~~bash
cd codex-rs
just test -p codex-mcp
~~~

重点看 [catalog_tests.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/codex-mcp/src/catalog_tests.rs)：构造同名 server 的 plugin/config/extension actions，预测最终来源、冲突记录和顺序，再运行测试验证。

### 实验 B：验证入站 MCP 的工具表

阅读 [codex_tool.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/mcp-server/tests/suite/codex_tool.rs)，确认 <code>codex</code> 与 <code>codex-reply</code> 的 schema、开始/继续语义。测试使用模拟服务，不需要把真实访问令牌写入仓库。

### 实验 C：验证 extension registry 顺序

[registry tests](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/ext/extension-api/tests/registry.rs) 展示 builder 如何收集 contributor。尝试画出注册顺序与执行顺序，确认 registry 是否保持它。

### 实验 D：从 AppInfo 追到工具

选择 [apps processor](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/request_processors/apps_processor.rs) 中一条 installed 路径，逐项记录：

1. metadata 从何而来；
2. connector 是否 accessible/enabled；
3. 对应 MCP server 名称；
4. 工具是否 synthetic；
5. 最终是否进入 model-visible catalog。

这是纯源码实验，不需要安装或授权任何真实 app。

## 8. 常见误区

1. **把 app-server 当成 MCP server。** 它们有不同 wire contract；app-server 只是能管理或代理 MCP runtime。
2. **看到 <code>mcp_servers</code> 配置就认为 Codex 在对外提供 MCP。** 该配置描述的是出站 client 连接。
3. **把 token 写进配置。** 应只存环境变量名。
4. **刷新 catalog 后重新解析已准备调用。** 这可能产生 TOCTOU 重路由。
5. **把 catalog 条目当成健康连接。** 声明、解析、运行是三个阶段。
6. **把 AppInfo 当成 tool。** metadata 还要经过授权、runtime、可见性和 policy。
7. **把 plugin 当成可直接调用能力。** plugin 是包装；真正执行的是其中的 skill、MCP tool、hook 等。
8. **把 Extension 当作可下载插件格式。** 当前 extension API 是编译期 Rust host 接口。
9. **只看历史文档判断 MCP 工具。** 对快速演进接口要核对 <code>tools/list</code> 源码和测试。

## 9. 自测题

1. Codex 作为 MCP client 和 MCP server 时，数据流方向分别是什么？
2. 为什么 app-server 的 <code>mcpServer/tool/call</code> 不等于建立 MCP 会话？
3. MCP catalog 中 config 与 extension 同名时，哪一层优先？
4. captured binding 防止了什么竞态？
5. 一个 app 从 catalog 可见到模型可调用，中间至少经过哪些条件？
6. Plugin 与 Extension 的部署和信任边界有何不同？
7. 为什么稳定的 catalog 排序会影响正确性和可测试性？
8. 当前入站 Codex MCP server 对外暴露哪两个核心工具？

能从一个模型工具调用反向追到 binding、runtime、catalog、来源声明和安全策略，才算真正理解 Codex 的扩展汇流。
