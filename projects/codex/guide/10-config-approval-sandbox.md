# 10. 配置、审批与沙箱：从 TOML 到操作系统强制边界

> 本章对应源码快照 <code>61a44880a85d2fd0d8770908dea5733495e571c8</code>。安全行为会随平台与版本演进，遇到文档和实现不一致时，以当前源码、生成 schema 和测试为准。

## 学习目标

学完本章，你应该能够：

- 区分配置来源优先级、管理要求和项目信任三个概念；
- 从 <code>config.toml</code> 追到最终运行时 <code>Config</code>；
- 区分审批策略、权限描述、沙箱强制方式和平台沙箱实现；
- 解释一次工具调用何时提示用户、何时在沙箱中执行、何时允许重试；
- 用临时规则和 crate 测试验证策略，而不触碰真实项目或凭据。

## 1. 安全模型先拆成两条流水线

Codex 的配置与执行安全相关，但不是同一个阶段：

~~~text
配置流水线
多个来源 → 分层合并 → 管理要求约束 → 运行时 Config

执行流水线
工具请求 → exec policy → 是否审批 → 权限画像 → 沙箱选择
         → 第一次执行 → 识别沙箱拒绝 → 必要时重新审批 → 受控重试
~~~

如果把它们混成“一个 sandbox 参数”，就会产生危险误解。例如 <code>approval_policy = "never"</code> 的意思是“不弹审批框”，不是“允许所有操作”；沙箱和权限仍然可以拒绝命令。

## 2. 配置分层：同一个键为什么会有多个答案

原始 TOML 形状定义在 [config_toml.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/config/src/config_toml.rs)。其中既有模型和 profile，也有审批、sandbox、permissions、MCP、项目文档和 skills 等字段。

每个配置来源由 [config_layer_source.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/config/src/config_layer_source.rs) 建模。普通配置层的大致低到高顺序是：

| 层 | 典型优先级 | 用途 |
|---|---:|---|
| MDM | 0 | 设备管理注入的普通配置值 |
| System | 10 | 系统范围默认值 |
| Enterprise managed | 15 | 企业托管层 |
| User | 20 | 用户配置 |
| User profile | 21 | 被选中的 profile |
| Project | 25 | 项目目录中的配置 |
| Session flags | 30 | 本次启动覆盖 |
| Legacy managed file | 40 | 兼容旧式托管配置 |
| Legacy managed MDM | 50 | 兼容旧式 MDM |

这里最反直觉的一点是：

> MDM 在“普通值合并”中优先级低，不代表管理员约束弱。普通配置值和 requirements 是两条不同的组合通道。

普通层回答“最终建议值是什么”；requirements 回答“最终值允许落在哪个集合”。高优先级 session flag 也不能越过强制要求。

可以把合并写成概念伪代码：

~~~rust
let ordinary = merge_low_to_high(enabled_layers);
let constrained = requirements.validate_and_constrain(ordinary)?;
let runtime = ConfigBuilder::from(constrained).build()?;
~~~

真实装载入口是 [loader/mod.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/config/src/loader/mod.rs) 的 <code>load_config_layers_state</code>。它组合系统、云端/企业、用户、profile、当前目录树、仓库和运行时覆盖。合并语义可继续追到 [merge.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/config/src/merge.rs)。

### 2.1 disabled 层不是“从世界上消失”

[state.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/config/src/state.rs) 中的 <code>ConfigLayerStack</code> 同时支持：

- 计算 <code>effective_config</code>：只合并启用层；
- 查询来源 <code>origins</code>：解释值来自哪里；
- 高到低遍历；
- 查询时选择是否包含 disabled 层。

因此，“这层未参与最终配置”与“这层完全不可见”是两件事。诊断 UI 可以展示 disabled 层；某些资源发现逻辑也可能有意观察完整 layer stack。

### 2.2 项目信任控制的是配置采用

未信任项目的 project config 会被禁用，避免仓库通过配置静默扩大能力。但不要进一步推导成“仓库内所有内容都不会被发现”。AGENTS 文档和 skill roots 有各自的发现与注入规则；信任边界必须逐个子系统核对。

运行时强类型配置位于 [core/config/mod.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/config/mod.rs)。阅读时区分：

- <code>ConfigToml</code>：用户可写的稀疏输入；
- <code>ConfigLayerStack</code>：带来源、启用状态和合并语义的中间态；
- <code>Config</code>：填充默认值、解析路径并施加约束后的运行态。

## 3. 四个安全轴：不要再把它们都叫 sandbox

### 3.1 AskForApproval：什么时候请求人类决定

[protocol.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/protocol/src/protocol.rs) 定义 <code>AskForApproval</code>：

- <code>UnlessTrusted</code>：wire 上使用 <code>untrusted</code>，对非可信操作更保守；
- <code>OnRequest</code>：默认策略，模型或执行路径在需要时请求；
- <code>Granular</code>：按更细粒度规则决定；
- <code>Never</code>：永不向用户弹出请求。

<code>Never</code> 不会自动更改文件系统或网络权限。它可能使某些需要额外授权的操作直接失败。

### 3.2 PermissionProfile：允许访问什么

[models.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/protocol/src/models.rs) 将权限画像分为：

- <code>Managed</code>：由 Codex 管理并可转成具体沙箱策略；
- <code>Disabled</code>：不使用 Codex 的沙箱限制；
- <code>External</code>：相信外部运行环境已经提供隔离。

常见内置画像可理解为只读、工作区可写和高权限三档，但权限结构本身更细。文件系统策略见 [permissions.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/protocol/src/permissions.rs)：

- 读、写、拒绝可以作用于不同路径；
- 相同具体度下 deny 最强；
- <code>.git</code>、<code>.agents</code>、<code>.codex</code> 等敏感元数据可有额外保护；
- 网络策略与文件系统策略分开表达。

路径策略不是单纯字符串前缀。设计和测试必须考虑规范化、父子目录、符号链接、跨平台分隔符和保护目录。

### 3.3 SandboxEnforcement：谁负责强制

同在 [models.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/protocol/src/models.rs) 的 <code>SandboxEnforcement</code> 回答另一问题：限制由 Codex 管理、显式关闭，还是由外部环境强制。

<code>PermissionProfile::External</code> 和平台沙箱类型不是同一层。前者表达信任契约；后者是 Codex 真正选择的本机实现。

### 3.4 SandboxType：Linux、macOS、Windows 怎么落地

[sandboxing manager.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/sandboxing/src/manager.rs) 定义平台选择与命令变换。当前类型包括：

- <code>None</code>；
- macOS Seatbelt；
- Linux seccomp/相关 Linux 隔离组合；
- Windows restricted token。

平台细节分别在 [seatbelt.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/sandboxing/src/seatbelt.rs)、[bwrap.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/sandboxing/src/bwrap.rs)、[landlock.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/sandboxing/src/landlock.rs) 和 [windows.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/sandboxing/src/windows.rs)。同一权限意图在不同 OS 上可能由不同原语近似实现，所以跨平台测试不可省略。

四轴对照：

| 问题 | 对应概念 |
|---|---|
| 是否向人提问？ | AskForApproval |
| 允许读写/联网到哪里？ | PermissionProfile |
| 谁承担限制责任？ | SandboxEnforcement |
| 本机用什么机制执行？ | SandboxType |

## 4. exec policy：命令在进入沙箱前先做语义分类

[exec policy](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/exec_policy.rs) 和 [execpolicy README](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/execpolicy/README.md) 支持按命令前缀给出 <code>allow</code>、<code>prompt</code> 或 <code>forbidden</code>。匹配多个规则时采用更严格结果，而不是“最后一个配置覆盖前面”。

概念示例：

~~~text
prefix_rule(pattern=["git", "status"], decision="allow")
prefix_rule(pattern=["git", "push"], decision="prompt")
prefix_rule(pattern=["rm", "-rf"], decision="forbidden")
~~~

规则只描述命令分类，不等于给命令授予任意文件系统能力。即便 <code>git status</code> 被 policy 允许，它仍在当前权限画像和沙箱中运行。

## 5. 一次工具调用的完整安全状态机

中央编排位于 [tools/orchestrator.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/orchestrator.rs)。省略错误处理后的流程是：

~~~rust
let approval = determine_approval_requirement(call, policy, config);
let decision = maybe_ask_user(approval).await?;
let permissions = materialize_permission_profile(decision, config)?;
let sandbox = select_initial_sandbox(permissions, platform);
let first = run(call, sandbox).await;

if first.looks_like_sandbox_denial() && escalation_is_allowed() {
    let retry_decision = request_fresh_approval().await?;
    return run(call, retry_decision.sandbox()).await;
}
first
~~~

真实的审批缓存、执行要求和 sandbox attempt 类型在 [tools/sandboxing.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/sandboxing.rs)，审批交互在 [tools/approvals.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/approvals.rs)。

这里有三个重要性质：

1. **先审批再执行**：高风险调用不能先产生副作用再补票；
2. **沙箱失败不等于命令业务失败**：系统会检测拒绝特征，但不能把所有非零退出都当成沙箱问题；
3. **重试需要新鲜授权**：第一次受限执行失败，不代表可以静默切到无限制模式。

如果权限明确 deny read，升级路径也不能把它偷偷改成可读。这类不变量由 [sandboxing_tests.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/sandboxing_tests.rs) 覆盖。

## 6. 配置变更也有并发安全

app-server 暴露配置读写 API 时，不能假设只有一个客户端。实现位于 [config_processor.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/src/request_processors/config_processor.rs)，使用预期版本/哈希一类的乐观并发控制思想：

~~~text
client A read version V
client B read version V
client A write based on V → success, now V+1
client B write based on V → conflict, must re-read
~~~

这避免两个 UI 相互覆盖配置。对应行为可在 [config_rpc.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/app-server/tests/suite/v2/config_rpc.rs) 中验证。

## 7. 安全的动手实验

### 实验 A：在临时目录检查 exec policy

只在临时目录创建规则，不写用户配置：

~~~bash
tmp_dir="$(mktemp -d)"
rules_file="$tmp_dir/study.rules"
printf '%s\n' \
  'prefix_rule(pattern=["git", "status"], decision="allow")' \
  'prefix_rule(pattern=["git", "push"], decision="prompt")' \
  >"$rules_file"

codex execpolicy check --rules "$rules_file" git status
codex execpolicy check --rules "$rules_file" git push
~~~

观察匹配规则和最终 decision。完成后用系统的临时目录清理机制或明确目标清理；不要把真实 token、主目录路径或破坏性命令放进教材规则。

### 实验 B：验证沙箱选择

~~~bash
cd codex-rs
just test -p codex-sandboxing
~~~

重点阅读 [manager_tests.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/sandboxing/src/manager_tests.rs)，回答“什么输入选择什么平台沙箱”和“命令如何被变换”。

### 实验 C：配置 schema

修改 <code>ConfigToml</code> 或嵌套配置类型时：

~~~bash
cd codex-rs
just write-config-schema
git diff -- core/config.schema.json
~~~

schema diff 是用户配置兼容性的一部分。仅添加 Rust 字段、忘记刷新 [config.schema.json](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/config.schema.json)，会让编辑器和下游校验器落后。

## 8. 常见误区

1. **把低普通优先级理解成低管理权。** requirements 与普通值不是同一条优先级链。
2. **认为 session flag 能越过企业限制。** 高层覆盖值仍要通过 requirements。
3. **认为 disabled 层不可查询。** 它不参与有效合并，但可能保留用于解释和资源发现。
4. **把未信任项目理解为完全不读取仓库内容。** 配置采用、AGENTS 与 skills 发现要分别分析。
5. **把 never approval 理解为 full access。** 不询问不等于不限制。
6. **把 allow 规则理解为绕过沙箱。** exec policy 和 OS 强制是串联防线。
7. **把任意非零退出都当沙箱拒绝并升级。** 这会把普通业务错误变成权限扩大。
8. **在 PostToolUse 阶段试图撤销副作用。** 工具完成后的策略只能处理结果，不能让已经发生的写入倒流。
9. **只在 Linux 验证路径策略。** Codex 支持 Linux、macOS 和 Windows。

## 9. 自测题

1. 普通配置层和 requirements 分别解决什么问题？
2. 为什么 MDM 的普通层 precedence 为 0，不代表用户层可以越过管理限制？
3. <code>ConfigToml</code>、<code>ConfigLayerStack</code>、<code>Config</code> 各处在哪个阶段？
4. <code>AskForApproval::Never</code> 与 <code>PermissionProfile::Disabled</code> 有什么本质区别？
5. exec policy 为 allow 时，命令还可能因哪些原因失败？
6. 第一次沙箱执行疑似被拒后，为什么不能直接无沙箱重跑？
7. deny read 为什么应该在升级后继续成立？
8. 配置 RPC 为什么需要乐观并发控制？

如果你能用“四轴表格”诊断一个失败命令，而不是笼统地说“sandbox 出问题”，就已经建立了正确的安全心智模型。
