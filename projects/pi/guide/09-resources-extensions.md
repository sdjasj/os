# 09｜资源与扩展：不改核心也能改变 Pi

Pi 把大量定制能力放在资源系统中：

- project context 文件；
- extensions；
- skills；
- prompt templates；
- themes；
- packages。

核心加载器是 [`resource-loader.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/resource-loader.ts)，扩展类型和运行器位于 [`core/extensions`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/extensions)。

## 1. 资源分层

默认有两类来源：

### 用户级

通常在 `~/.pi/agent/` 下，适合个人跨项目习惯、认证以外的通用定制、主题和技能。

### 项目级

通常在项目 `.pi/` 目录及项目上下文文件中，适合团队约定、项目专用扩展和提示。

合并时必须同时考虑：

- 发现顺序；
- 同名覆盖规则；
- 当前项目是否受信；
- 设置中的显式路径；
- 包贡献的资源；
- reload 后是否变化。

调试资源时不要只看当前目录，先让 ResourceLoader 报告实际加载结果和诊断信息。

## 2. AGENTS.md 上下文发现

项目上下文加载会寻找 `AGENTS.md` 一类文件。概念顺序：

1. 用户级上下文；
2. 从文件系统/项目根向 cwd 逐层发现；
3. 祖先到子目录顺序合并，使更具体目录的说明位于后面；
4. 同层存在 override 文件时按规则优先使用；
5. 最终组成 system/context 的项目指令部分。

这使 monorepo 可在根目录写全局约定，在子包目录追加局部约定。

上下文文件是模型指令，不是强制权限。即使写了“禁止删除”，系统级防护仍需工具 hook 或沙箱。

## 3. 项目信任的两阶段加载

项目资源可能包含可执行 TypeScript 扩展。安全启动不能先执行它再问“是否信任”。

合理流程：

1. 发现项目资源元数据；
2. 判断目录信任状态，必要时提示用户；
3. 只有受信后才加载项目可执行资源；
4. 用户级已信任资源按其规则加载。

因此 ResourceLoader 不只是 `readdir`；它还需要保存 diagnostics，区分发现、允许和实际加载。

再次强调：信任阻止的是陌生项目自动注入 Pi 定制，不是 bash/read/write/edit 的系统沙箱。

## 4. 五种定制机制如何选择

| 机制 | 适合内容 | 是否执行代码 |
| --- | --- | --- |
| AGENTS/context | 项目约定、构建命令、架构说明 | 否 |
| prompt template | 可复用的一次性提示骨架 | 否 |
| skill | 一套按需加载的任务知识、流程和资源 | 通常以说明为主，可引用脚本 |
| theme | 终端颜色与样式 | 配置 |
| extension | 事件、工具、命令、UI、策略 | 是 |
| package | 分发上述一组资源 | 取决于内容 |

如果只是复用一段 prompt，不要先写扩展；如果需要拦截工具或持久化状态，才进入扩展。

## 5. 扩展如何加载

扩展是 TypeScript/JavaScript 模块，默认导出接收 `ExtensionAPI` 的函数：

    export default function (pi: ExtensionAPI) {
      // 注册工具、命令、快捷键和事件处理器
    }

加载器使用运行时 TS 模块加载机制，并为 Pi 自身包提供可解析模块。异步扩展工厂会被等待，因此可在初始化阶段准备资源，但不应让启动无限阻塞。

扩展加载失败应进入 diagnostics，而不是悄悄丢失。排查时查看：

- 文件是否被发现；
- 项目是否受信；
- 模块导入是否成功；
- 默认导出形状是否正确；
- 注册名称是否冲突；
- 当前模式是否有 UI。

## 6. 最小自定义工具

真实示例 [`hello.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/examples/extensions/hello.ts) 的核心：

    const helloTool = defineTool({
      name: "hello",
      label: "Hello",
      description: "A simple greeting tool",
      parameters: Type.Object({
        name: Type.String({ description: "Name to greet" }),
      }),

      async execute(_id, params) {
        return {
          content: [
            { type: "text", text: "Hello, " + params.name + "!" }
          ],
          details: { greeted: params.name },
        };
      },
    });

    export default function (pi: ExtensionAPI) {
      pi.registerTool(helloTool);
    }

这是一个好起点，因为它展示了：

- Schema 同时描述和校验输入；
- content 给模型；
- details 给扩展/UI；
- 注册逻辑与工具定义分离。

第二步再增加 signal、onUpdate 和 render，不要第一次就复制复杂工具。

## 7. 常用 ExtensionAPI 能力

### 注册

- `registerTool`：自定义 Agent 工具；
- `registerCommand`：斜杠命令；
- `registerShortcut`：键盘快捷键；
- `registerFlag`：CLI flag。

### 运行中控制

- `getActiveTools/setActiveTools`；
- 发送或排队消息；
- append 自定义 session entry；
- 使用 session/model/context 信息。

### UI

在 `ctx.hasUI` 时可：

- notify；
- confirm；
- select；
- setStatus；
- setWidget；
- 使用当前 theme。

print/RPC 模式可能没有交互 UI。扩展必须检查 `hasUI`，并为无 UI 模式定义合理行为。

## 8. 事件与返回值语义

不同事件的 handler 返回值不是统一的。常见类别：

- **观察型**：记录 turn_end，不改变流程；
- **变换型**：input/context 返回变换后的值；
- **阻止型**：tool_call 返回 `block: true`；
- **可取消型**：session_before_* 返回 `cancel: true`；
- **注入型**：before_agent_start 返回 message/system prompt 修改。

不要凭事件名字猜返回格式，应查 [扩展类型](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/extensions/types.ts) 的精确联合类型。

## 9. 真实示例一：危险会话操作确认

[`confirm-destructive.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/examples/extensions/confirm-destructive.ts) 监听：

- `session_before_switch`；
- `session_before_fork`。

它先检查 `ctx.hasUI`，再调用 confirm/select；用户拒绝时返回 `{ cancel: true }`。

这个例子说明“before 事件”是产品事务的前置关口。确认必须发生在状态改变前，事后 notify 无法撤销已切换的会话。

## 10. 真实示例二：plan mode

[`plan-mode/index.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/examples/extensions/plan-mode/index.ts) 展示一个完整工作流如何完全由扩展实现：

- 注册 `--plan` flag、`/plan` 和快捷键；
- 保存进入 plan 前的 active tools；
- 禁用 edit/write；
- 对 bash `tool_call` 做 allowlist 检查；
- `before_agent_start` 注入只读模式上下文；
- `context` 过滤过期的 plan 消息；
- `turn_end` 解析完成标记；
- 用 status/widget 展示进度；
- `appendEntry` 持久化扩展状态；
- 退出时恢复原工具集合。

它也揭示两个安全事实：

1. 仅从 active tools 移除 edit/write 不能限制 bash；
2. shell 命令 allowlist 是工作流保护，不等同于强沙箱。

## 11. 自定义条目与自定义消息

扩展持久化状态时有两个概念：

### custom entry

保存扩展内部数据，例如 plan 是否开启。恢复时扫描条目重建状态；它不进入 LLM 上下文。

### custom message

保存需要在恢复后继续进入 LLM 上下文的内容，可选择是否在 TUI 显示。

不要用 custom message 存纯 UI 状态，否则会浪费 token 并改变模型行为。

## 12. Skills 与 prompt templates

prompt template 适合参数化文本展开；skill 更像带入口说明和相关资源的知识模块。`AgentSession.prompt` 会在 input hook 后处理 `/skill:name` 与 template。

设计 skill 时：

- 入口说明聚焦“何时使用、怎么做”；
- 将大参考材料拆开并按需读取；
- 脚本应可审查、参数明确；
- 不把密钥或本机绝对路径写入；
- 明确失败与安全边界。

设计 template 时：

- 让参数位置清晰；
- 避免偷偷改变工具权限；
- 不假定所有项目目录结构相同。

## 13. Packages：分发而非新的运行时

Pi package 是把扩展、技能、主题或模板组合并分发的方式。它解决发现、安装和共享，不取代具体资源机制。

评估第三方 package：

- 来源和许可证；
- 是否含可执行扩展；
- 加载哪些文件；
- 是否引入 npm 依赖；
- 是否读取环境或发网络请求；
- 更新策略与锁定版本。

## 14. 扩展开发顺序

建议：

1. 从 `hello.ts` 复制最小结构；
2. 放入个人或测试项目的扩展目录；
3. reload 并检查 diagnostics；
4. 只注册一个命令或工具；
5. 增加事件 hook；
6. 增加持久化；
7. 最后才增加 UI 和多模式兼容；
8. 为无 UI、abort、重复 reload 写测试。

## 15. 动手练习

### 练习 A：只读保护

实现扩展：

- 命令 `/readonly` 切换；
- 禁用 write/edit；
- bash 一律阻止；
- status 显示状态；
- custom entry 持久化；
- session 恢复时重建状态；
- 无 UI 模式仍然正确阻止工具。

### 练习 B：上下文标记

在 `before_agent_start` 注入当前 Git 分支和 dirty 状态，但：

- 设置超时；
- 限制输出长度；
- 不把完整 diff 注入；
- 非 Git 目录优雅降级。

比较“custom message 永久保存”和“context hook 临时注入”的差异。

### 练习 C：资源冲突

创建用户级和项目级同名 template/skill，观察 loader 的最终选择与 diagnostics。记录实际规则，不依赖猜测。
