# 01｜背景知识：读 Pi 源码前需要掌握的概念

这一章不是 TypeScript 或 LLM 的完整课程，只补充理解 Pi 设计所需的关键知识。

## 1. npm workspaces 与包边界

Pi 是 monorepo：一个 Git 仓库中包含多个可独立发布的 npm 包。根目录 [`package.json`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/package.json) 的 `workspaces` 负责把本地包连接起来。

包边界的价值不只是整理目录：

- `pi-ai` 不应知道终端怎样渲染；
- `pi-agent-core` 不应依赖某个具体 Provider；
- `pi-tui` 不应知道什么是 LLM；
- `pi-coding-agent` 负责组合这些能力，因而依赖最多。

判断代码应放哪一层的简单方法：如果把 Coding Agent 换成网页应用，这段代码是否仍有意义？若仍有意义，它通常属于更底层的 ai、agent 或 protocol。

## 2. ESM、TypeScript 与显式扩展名

项目使用现代 Node.js ESM。常见形式：

    import { Agent } from "@earendil-works/pi-agent-core";
    import type { Message } from "@earendil-works/pi-ai";

`import type` 只存在于类型检查阶段，编译后的 JavaScript 不会加载它。这样能减少运行时依赖和循环引用。

阅读时区分三件事：

- TypeScript 类型：编译期约束，运行时已经消失；
- JavaScript 值：类、函数、常量，运行时真实存在；
- Schema：运行时验证未知输入，尤其是模型生成的工具参数或网络消息。

## 3. 判别联合：事件系统的骨架

[`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/types.ts) 中的 `AssistantMessageEvent` 是典型判别联合。简化后：

    type Event =
      | { type: "text_start"; contentIndex: number }
      | { type: "text_delta"; contentIndex: number; delta: string }
      | { type: "text_end"; contentIndex: number; content: string }
      | { type: "done"; message: AssistantMessage }
      | { type: "error"; error: Error };

`type` 字段是判别器。TypeScript 能在分支中自动缩窄类型：

    function handle(event: Event) {
      switch (event.type) {
        case "text_delta":
          process.stdout.write(event.delta);
          break;
        case "done":
          save(event.message);
          break;
      }
    }

为什么这比一个拥有许多可选字段的对象好？因为 `done` 不可能“忘记”携带 message，`text_delta` 也不会误用不存在的 error。

阅读练习：打开 AI 类型文件，列出完整的 `AssistantMessageEvent`，再找出哪些事件表示边界、哪些表示增量、哪些表示终止。

## 4. TypeBox：同时拥有类型与运行时校验

大模型返回的工具参数来自外部，不可信。TypeScript 无法验证运行时 JSON，因此 Pi 使用 TypeBox 声明工具参数：

    const parameters = Type.Object({
      path: Type.String({ description: "File path" }),
      offset: Type.Optional(Type.Number({ minimum: 1 })),
    });

TypeBox Schema 同时用于：

1. 推导 TypeScript 参数类型；
2. 向模型描述工具参数；
3. 在工具执行前验证实际 JSON。

边界原则：来自模型、RPC、文件或网络的数据都应在边界验证；进入核心逻辑后再依赖静态类型。

源码入口：

- [工具公共类型](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/types.ts)
- [read 工具 Schema](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools/read.ts)
- [协议 Schema](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/protocol/src/schemas.ts)

## 5. Promise、异步迭代器与流

Promise 表示“未来得到一个结果”：

    const message = await complete(model, context);

异步迭代器表示“未来陆续得到多个结果”：

    for await (const event of stream(model, context)) {
      if (event.type === "text_delta") {
        process.stdout.write(event.delta);
      }
    }

模型输出天然适合异步迭代器，因为首个 token 到达时不必等待完整响应。工具也可通过 `onUpdate` 在完成前报告进度。

Pi 的 [`EventStream`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/utils/event-stream.ts) 同时提供两种消费方式：

- `for await`：消费增量事件；
- `stream.result()`：等待最终 `AssistantMessage`。

它内部维护：

- queue：消费者暂时没取走的事件；
- waiters：消费者已经等待、但生产者还没推送；
- done：流是否关闭；
- result Promise：最终结果或错误。

这是一种轻量的生产者—消费者队列。阅读该文件时，分别模拟“先 push 后 next”和“先 next 后 push”。

## 6. AbortSignal：协作式取消

JavaScript 不能安全地强制杀死一个任意异步函数。`AbortController` 提供协作式取消：

    const controller = new AbortController();
    doWork({ signal: controller.signal });
    controller.abort();

被调用方必须主动：

- 在开始前检查 `signal.aborted`；
- 监听 `abort` 事件；
- 将 signal 继续传给 fetch、子进程或更下游的函数；
- 及时清理监听器、进程和文件句柄。

在 Pi 中，取消从 Agent 向模型流和工具执行传播。阅读时要检查的不只是“有没有 signal 参数”，还要检查它是否一路传到底层。

## 7. LLM 消息、内容块与工具调用

模型上下文通常是消息序列：

    UserMessage
       content: string | [text, image...]

    AssistantMessage
       content: [thinking?, text?, toolCall?...]

    ToolResultMessage
       toolCallId: string
       content: [text/image...]

一次 assistant 回复可以同时含文本和多个工具调用。工具结果通过 `toolCallId` 与请求配对，而不是靠数组位置猜测。

“模型消息”不等于 UI 上的一行文字。思考块、图片、工具调用、用量、停止原因和错误都属于结构化状态。

## 8. Turn、Agent Loop 与状态机

一次用户 prompt 可能触发：

    用户消息
      → 模型请求
      → assistant 工具调用
      → 工具结果
      → 再次模型请求
      → assistant 最终文本

每次模型请求及随后的工具处理可以视为一个 turn。Agent loop 是状态机：根据 assistant 的停止原因、是否存在工具调用、是否收到 steering/follow-up、是否 abort 决定下一状态。

与普通 while 循环不同，它还必须持续发事件、维护完整消息历史，并保证任何退出路径都产生一致的最终状态。

## 9. Append-only JSONL 与树

JSONL 是“一行一个 JSON 对象”的文本格式：

    {"type":"session","version":3,"id":"s1"}
    {"type":"message","id":"a","parentId":null,"message":{"role":"user"}}
    {"type":"message","id":"b","parentId":"a","message":{"role":"assistant"}}

append-only 意味着旧行不原地修改。优点：

- 追加写简单，崩溃时更容易保留已有内容；
- 历史不可变，审计和调试更清晰；
- 用 `id/parentId` 可表达分支，不必复制整段历史。

当前上下文是“从当前叶子沿 parentId 回溯到根，再反转”。切换分支只需改变当前叶子，不删除其他节点。

代价是读取时要重建索引，文件可能累积无用分支，需要额外的压缩或清理策略。

## 10. 上下文窗口与 compaction

模型上下文有 token 上限。若历史不断增长，最终无法再发送新请求。最粗暴的方法是删除旧消息，但会丢失任务背景。

Pi 的思路是：

1. 预留一部分 token 给下一次回复；
2. 超过阈值时选择切分点；
3. 将较旧部分总结为 compaction summary；
4. 保留最近消息原文；
5. 下一次构建上下文时，用“摘要 + 最近原文”替代完整旧历史。

这是有损压缩。好的摘要要保留决策、文件改动、未完成事项和关键标识符，而不是只做聊天概括。

## 11. ANSI 终端、cell 宽度与差量渲染

终端不是像素画布，而是字符 cell 网格。ANSI 转义序列控制光标、颜色、清屏和备用屏幕。

几个常见陷阱：

- 一个 Unicode 字符不一定占一个 cell；
- 中文通常占两个 cell，组合字符可能占零或与前字符合并；
- ANSI 颜色码有字符串长度，但不占显示宽度；
- 终端 resize 会使已有换行布局失效；
- IME 输入需要准确知道真实光标位置。

Pi TUI 的组件返回字符串行。普通模式缓存上一帧，与新帧比较后只写变化区间；全屏模式还要维护布局树、滚动区域和覆盖层。

差量渲染示例：

    old = ["问题：", "正在生成……", "状态：运行中"]
    new = ["问题：", "答案完成",     "状态：完成"]

第一行相同，只需从第二行开始更新。若新帧比旧帧短，还必须清除多余旧行。

## 12. 依赖注入与可测试边界

Pi 中常见的接口：

- `StreamFn`：给定模型和上下文，返回流；
- `ReadOperations`：读取文本或图片；
- `BashOperations`：启动命令并流式输出；
- `TelemetryContext`：创建 span；
- Transport：读写协议帧。

核心代码依赖接口，产品启动时注入真实实现，测试时注入假实现。这不是为了抽象而抽象，而是把不稳定边界（网络、文件、终端、时钟）从确定性控制流中分离。

## 13. 本章自测

不看前文回答：

1. 为什么 `AssistantMessageEvent` 适合判别联合？
2. TypeScript 已有类型时，为什么工具参数还要 Schema？
3. Promise 与 AsyncIterable 的消费体验有何区别？
4. append-only 会话怎样在不复制历史的情况下建立分支？
5. 项目信任和操作系统沙箱解决的是不是同一个问题？
6. 为什么计算终端字符串的 `length` 不能得到光标列？

若有三题答不清，先用 15 的索引打开相应源码，再进入后续章节。
