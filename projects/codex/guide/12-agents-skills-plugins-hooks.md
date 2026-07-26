# 12. AGENTS、Skills、Plugins 与 Hooks：上下文、能力包和生命周期

> 本章对应源码快照 <code>61a44880a85d2fd0d8770908dea5733495e571c8</code>。Hooks 的事件载荷和结果协议仍可能变化；本章只讲该快照能由源码和 schema 证明的语义，精确字段始终以当前源码、生成 schema 和测试为准。

## 学习目标

学完本章，你应该能够：

- 预测某个工作目录会加载哪些 AGENTS 文档以及顺序；
- 解释 skills 的渐进披露如何节约模型上下文；
- 分清 plugin 是资源包，而不是一种新的万能运行时；
- 解释 hook 在工具、审批和会话生命周期中的介入点；
- 从“内容发现”追到“模型上下文注入”，并识别信任边界。

## 1. 四个概念各解决什么问题

| 概念 | 核心问题 | 主要消费者 |
|---|---|---|
| AGENTS | 这个目录树里的长期协作规则是什么？ | 模型上下文 |
| Skill | 遇到某类任务时应按什么专业流程做？ | 模型与工具编排 |
| Plugin | 一组技能、MCP、Apps、Hooks 如何一起分发？ | 多个子系统 |
| Hook | 某个生命周期事件发生前后要运行什么策略或自动化？ | host runtime |

它们会共同影响一次 agent turn，但作用时机不同：

~~~text
启动/切换目录
  → 发现 AGENTS + skill metadata + plugins
  → 构造模型上下文
  → 用户任务触发某个 skill，加载完整 SKILL.md
  → 模型请求工具
  → PreToolUse / PermissionRequest hooks
  → 审批与工具执行
  → PostToolUse hook
  → turn/session lifecycle hooks
~~~

## 2. AGENTS：目录作用域的项目指令

### 2.1 根目录怎么确定

实现入口是 [agents_md.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/agents_md.rs)。Codex 从当前工作目录向上寻找项目根标记；默认标记是 <code>.git</code>。找到边界后，再从根到当前目录按顺序收集指令。

假设目录结构：

~~~text
repo/
├─ .git/
├─ AGENTS.md
├─ crates/
│  ├─ AGENTS.override.md
│  └─ ui/
│     ├─ AGENTS.md
│     └─ src/
~~~

当 cwd 为 <code>repo/crates/ui/src</code> 时，候选目录是 <code>repo</code>、<code>repo/crates</code>、<code>repo/crates/ui</code>、<code>repo/crates/ui/src</code>。每一层最多选一个文件，文件名优先级为：

~~~text
AGENTS.override.md > AGENTS.md > configured fallback names
~~~

因此上例会选根的 <code>AGENTS.md</code>、crates 的 <code>AGENTS.override.md</code>、ui 的 <code>AGENTS.md</code>，并按根到叶拼接。override 是“同目录候选优先”，不是删除祖先目录已收集的内容。

### 2.2 边界与大小为什么必须有硬上限

默认项目文档总量受环境配置的字节上限约束（当前默认 32 KiB），读取采用可容忍非法 UTF-8 的 lossy 方式。根边界和上限共同保证：

- 不会一路扫描到文件系统根；
- 不会把任意大的仓库文档塞进模型上下文；
- 同一 cwd 的输入相对稳定，有利于缓存。

如果把 <code>project_root_markers</code> 设为空，父目录遍历会被禁用。还有一个刻意的安全设计：在决定项目根标记时，不采用项目自己的配置，因此仓库不能通过自己的 config 移动发现边界。

### 2.3 发现、缓存、注入是三层

阅读路线：

~~~text
agents_md.rs
  发现候选、选择文件、拼接内容
    ↓
agents_md_manager.rs
  按环境与 cwd 缓存
    ↓
context/user_instructions.rs
  转成模型可见 contextual fragment
    ↓
context/world_state/agents_md.rs
  记录 snapshot 的新增、替换或删除
~~~

[agents_md_manager.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/agents_md_manager.rs) 避免每个步骤重复读取。[user_instructions.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/context/user_instructions.rs) 负责上下文形状。[world_state/agents_md.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/context/world_state/agents_md.rs) 以增量世界状态表达更新，不回写旧历史。

全局 host instructions 会先于项目文档进入组合。AGENTS 不是 skill catalog 的容器；测试明确保护“skills 不被自动附加到 AGENTS 文本”这一边界。

## 3. Skills：按需加载的专业操作手册

### 3.1 SKILL.md 的两层内容

一个 skill 通常是带 YAML frontmatter 的 <code>SKILL.md</code>：

~~~markdown
---
name: example-review
description: 在需要系统性审查改动时使用。
---

这里是完整流程、约束、资源路由和验证步骤。
~~~

[skills model.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/skills/src/model.rs) 建模 metadata、policy、interface 和 dependencies。关键分层是：

- metadata：名称、简短描述、位置和可见策略，适合进入初始 catalog；
- full instructions：完整正文，只有 skill 被触发时才读入。

这就是 progressive disclosure（渐进披露）。如果有 100 个 skill，每个正文 2000 token，把全部正文预先注入会浪费约 20 万 token，而且降低模型注意力。先注入短 catalog，命中后再读取一份，成本被硬性限制。

### 3.2 Skill 从哪里发现

[core-skills loader.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core-skills/src/loader.rs) 汇总多种 roots，包括：

- <code>$CODEX_HOME/skills</code> 的兼容位置；
- <code>$HOME/.agents/skills</code>；
- <code>$CODEX_HOME/skills/.system</code> 中的系统 skills 和 <code>/etc/codex/skills</code>；
- 项目中的 <code>.codex/skills</code>；
- 从项目根到 cwd 各级的 <code>.agents/skills</code>；
- plugins 和显式 extra roots。

发布教程时只应使用这些通用占位形式，不要写作者机器的真实主目录。

[service.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core-skills/src/service.rs) 的 <code>SkillsService</code> 负责缓存和查询。[render.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core-skills/src/render.rs) 给初始 metadata catalog 设置硬预算：未知上下文窗口时采用固定字符上限，已知窗口时按上下文的一小部分计算，并在截断或别名时发出警告。

### 3.3 触发后如何进入模型上下文

[ext/skills fragments.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/ext/skills/src/fragments.rs) 区分：

- <code>AvailableSkillsInstructions</code>：开发者层的精简 catalog；
- <code>SkillInstructions</code>：被选 skill 的完整正文片段。

[ext/skills extension.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/ext/skills/src/extension.rs) 连接 catalog、invocation 和 world state。正确流程是：

~~~text
初始：只看 name + description
  ↓ 显式点名或任务语义命中
完整读取 SKILL.md
  ↓ 正文明确引用所需资源
按需读取 reference/script/template
  ↓
执行并遵守 skill 的验证步骤
~~~

“按需”不是只读 SKILL.md 的一半：一旦选择某 skill，主说明文件应完整读取；渐进披露发生在“选择哪一个 skill”和“随后需要哪些附属资源”。

### 3.4 信任边界的一个反直觉点

project config 因未信任而 disabled，不必然意味着 project skills 不会被发现。skill root 计算有意能够观察包含 disabled 条目的 layer stack。安全审查时要分别问：

1. 内容是否被发现？
2. metadata 是否展示给模型？
3. skill 是否被触发？
4. 它建议的动作是否还会经过工具审批和沙箱？

不要用一个 trust boolean 替代四层分析。

## 4. Plugins：打包能力，不发明新能力

[plugin manifest.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/plugin/src/manifest.rs) 中的 manifest 可声明：

- skills；
- MCP servers；
- apps；
- hooks；
- 可选 UI interface。

资源定位是泛型的，因此 host 文件系统资源和 authority-bound 远端资源可以共用结构，而不必伪装成同一种路径。

[plugin lib.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/plugin/src/lib.rs) 定义 app declaration、capability summary 和 hook source。[core-plugins](https://github.com/openai/codex/tree/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core-plugins/src) 负责加载 manifest、marketplace、store、开关以及给当前 config 选择 plugins。

最重要的边界是：

> Plugin 是分发与发现单元，不是一个可以绕过子系统策略的“万能工具”。

plugin 中的 skill 仍遵循 skill 渐进披露；MCP server 仍经过 catalog、连接和工具策略；app 仍要满足授权和可调用条件；hook 仍受 hook 发现与管理要求约束。

当用户显式提到 plugin 时，[plugins/injection.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/plugins/injection.rs) 会渲染提示，告诉模型当前可见 MCP servers、enabled apps 和带 plugin 前缀的 skills。这是“导航提示”，不是把整个 plugin 内容无界注入。

## 5. Hooks：生命周期事件上的策略和自动化

### 5.1 当前有哪些事件

[hooks lib.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/hooks/src/lib.rs) 在本快照中定义 11 个事件：

| 阶段 | 事件 |
|---|---|
| 工具 | PreToolUse、PermissionRequest、PostToolUse |
| 压缩 | PreCompact、PostCompact |
| 会话 | SessionStart、SessionEnd |
| 用户输入 | UserPromptSubmit |
| 子 agent | SubagentStart、SubagentStop |
| 停止 | Stop |

其中 matcher 对九类事件有意义；<code>UserPromptSubmit</code> 与 <code>Stop</code> 不使用同样的 matcher 语义。不要从事件名称自行猜 JSON 字段，精确载荷应查 [generated hook schemas](https://github.com/openai/codex/tree/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/hooks/schema/generated)。

### 5.2 Hook 从哪里来

[registry.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/hooks/src/registry.rs) 的配置组合 legacy notify、feature flag、trust bypass、config layer stack、plugin hook sources、加载警告和 shell。发现逻辑在 [engine/discovery.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/hooks/src/engine/discovery.rs)。

plugin hook 需要稳定身份，否则每次加载顺序变化都会让 UI 或配置记录漂移。[declarations.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/hooks/src/declarations.rs) 根据 plugin ID、相对源位置、事件、group 和 handler index 生成 stable key。

### 5.3 三个最关键的工具 Hook

工具链的概念时序：

~~~text
模型给出 tool call
  → PreToolUse
      可在副作用前检查、阻止，按当前协议处理修改结果
  → PermissionRequest
      在用户审批之前参与 allow/deny 判断
  → Codex approval + sandbox
  → 工具真正运行
  → PostToolUse
      检查输出，必要时拒绝把结果继续交给 agent
~~~

工具注册与 hook 接入位于 [core tools registry.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/registry.rs)，审批 hook 在 [tools/approvals.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/src/tools/approvals.rs)。

最容易误解的是 PostToolUse：

> 它可以拒绝或替换后续消费的结果，但不能撤销工具已经完成的文件写入、网络请求或外部副作用。

真正需要阻止副作用的策略应尽量放在 PreToolUse、PermissionRequest、审批或沙箱层。

### 5.4 Hooks 与 Rust Extensions 不同

Hooks 是运行时发现的命令、prompt 或 agent handler，在事件点执行；Rust Extensions 是编译进 host、实现 typed contributor trait 的扩展点。前者适合部署策略和工作流自动化，后者适合 host 内强类型能力组合。两者都能“扩展行为”，但信任、版本和失败隔离完全不同。

Hooks 还受管理要求约束，相关层位于 [requirements_layers/hooks.rs](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/config/src/requirements_layers/hooks.rs)。不能假设用户层 hook 一定覆盖企业层策略。

## 6. 上下文预算与“无历史改写”

AGENTS、skills catalog、plugin hint 都可能进入模型可见上下文。Codex 的总体设计偏好是：

- 每类片段有结构化 owner；
- 大小有硬上限；
- 状态变化通过新的 world-state fragment 表达；
- 不回头修改既有消息，从而减少缓存失效和审计歧义。

这解释了为何：

- AGENTS 有总字节上限；
- skills 初始只注入 metadata；
- plugin 只注入导航提示；
- skill 被调用后才出现完整正文；
- cwd 变化通过 snapshot replacement/removal 表达。

## 7. 动手实验

### 实验 A：预测 AGENTS 选择

在临时 Git 仓库中建立三层目录，每层分别放 <code>AGENTS.md</code>、<code>AGENTS.override.md</code> 和 fallback 文件。先手工预测最终顺序，再运行 core 的相关测试：

~~~bash
cd codex-rs
just test -p codex-core agents_md
~~~

对照 [agents_md suite](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/tests/suite/agents_md.rs) 中 override、fallback、concat、cold resume 和 fork 用例。

### 实验 B：测量 skill 渐进披露

创建两个临时 skills，各有短 metadata 和明显不同的完整正文。比较：

1. 未触发时的 AvailableSkills catalog；
2. 触发其中一个后的 SkillInstructions；
3. catalog 超预算后的警告与截断。

测试入口包括 [core-skills render tests](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core-skills/src/render.rs) 和 [skills extension 集成测试](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/tests/suite/skills_extension.rs)。测试文件名若在后续版本移动，以相邻模块声明为准。

### 实验 C：只用无副作用 Hook

先阅读 [hooks integration suite](https://github.com/openai/codex/blob/61a44880a85d2fd0d8770908dea5733495e571c8/codex-rs/core/tests/suite/hooks.rs)，用临时目录配置一个只记录事件类型、不读取秘密也不修改项目的 hook。观察 PreToolUse、PermissionRequest、PostToolUse 的顺序。

修改 hook API 时运行：

~~~bash
cd codex-rs
just write-hooks-schema
git diff -- hooks/schema/generated
~~~

不要在学习实验中配置上传环境、读取主目录或自动放行危险命令的 hook。

## 8. 常见误区

1. **认为 override 会删掉祖先 AGENTS。** 它只在同目录候选中优先。
2. **从 cwd 一直扫描到文件系统根。** 项目 root marker 是硬边界。
3. **把所有 skill 正文预先注入。** 这破坏上下文预算和渐进披露。
4. **只读 SKILL.md 开头几段。** 一旦选中，主说明应完整读取。
5. **把未信任 project config 等同于不发现任何项目内容。** 各子系统有独立发现规则。
6. **把 plugin 当作工具。** 它只是多个能力类型的包。
7. **认为 plugin 可以绕过 MCP、skill 或 hook 的策略。** 每项能力仍走自身管线。
8. **用 PostToolUse 保护不可逆副作用。** 此时副作用已经发生。
9. **把 hook 当 Rust extension。** 一个运行时发现，一个编译期注册。
10. **根据事件名猜 hook JSON。** 当前 schema 与源码才是精确契约。

## 9. 自测题

1. 同目录同时有 <code>AGENTS.override.md</code> 和 <code>AGENTS.md</code> 时选谁？祖先文档还保留吗？
2. 为什么项目配置不能决定发现自身 AGENTS 时使用的根标记？
3. skills 的 metadata catalog 与完整 SkillInstructions 分别何时注入？
4. “项目不可信”为什么不能直接推出“项目 skill 不可见”？
5. plugin manifest 可以包装哪四类主要资源？
6. PreToolUse、PermissionRequest、PostToolUse 分别处于工具副作用的哪一侧？
7. 为什么 plugin hook 需要 stable key？
8. Hooks 与 Rust Extensions 的信任和部署边界有什么不同？
9. “无历史改写”如何影响 cwd 变化后的 AGENTS 更新？

能把一个目录规则、一个 skill、一个 plugin hook 分别追到发现、缓存、上下文或生命周期执行点，就掌握了 Codex 可组合行为层的核心。
