# 13｜测试与调试：用确定性边界验证异步系统

Pi 的复杂性主要来自异步事件、外部边界和多层状态。测试的目标不是覆盖每一行，而是固定每层契约和跨层不变量。

## 1. 分层测试策略

    纯函数单元测试
      ├─ Schema/消息转换
      ├─ token 估算与切分点
      ├─ ANSI 宽度与 diff
      └─ framing/CBOR

    组件测试
      ├─ Provider 事件映射
      ├─ Agent loop + Faux
      ├─ 工具 + fake Operations
      ├─ SessionManager + 临时文件
      └─ TUI + virtual terminal

    集成测试
      ├─ AgentSession + in-memory session
      ├─ extensions/resources
      ├─ RPC 子进程
      └─ client/server test transport

    少量真实 E2E
      ├─ 真实 Provider
      ├─ 真终端交互
      └─ 平台 shell/clipboard/images

越靠下越快、越确定；越靠上越接近真实但更慢、更易受环境影响。

## 2. 先找现有测试

代表性入口：

- [AI tests](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/test)
- [Agent loop tests](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/test/agent-loop.test.ts)
- [Agent facade tests](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/test/agent.test.ts)
- [TUI virtual terminal](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/test/virtual-terminal.ts)
- [TUI render tests](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/test/tui-render.test.ts)
- [Coding Agent tests](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/test)
- [Session tree traversal](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/test/session-manager/tree-traversal.test.ts)
- [Protocol tests](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/protocol/test)
- [Server testing support](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/server/src/testing)

修改行为前，先用 `rg` 找已有断言，避免新增与既有语义冲突的“另一套真相”。

## 3. Faux Provider 与自定义 StreamFn

不要让 Agent loop 单元测试依赖真实模型。构造精确 assistant message：

    fauxAssistantMessage({
      content: [
        fauxText("先读取文件"),
        fauxToolCall("call-1", "read", { path: "a.ts" }),
      ],
      stopReason: "toolUse",
    });

再让下一次模型请求返回最终文本。测试可断言：

- StreamFn 被调用两次；
- 第二次 Context 含 ToolResult；
- toolCallId 匹配；
- 事件顺序正确；
- 最终消息数量正确。

如果 API 名称在新版本变化，保持测试思想：以预制消息驱动，而不是要求模型现场生成指定 JSON。

## 4. 事件断言

只断言最终文本会漏掉大量 bug。建议把事件映射成简洁轨迹：

    const trace = events.map(event => {
      if (event.type.startsWith("tool_execution_")) {
        return event.type + ":" + event.toolCallId;
      }
      return event.type;
    });

正常工具路径应包含：

    agent_start
    turn_start
    message_start(user)
    message_end(user)
    message_start(assistant)
    message_update...
    message_end(assistant)
    tool_execution_start
    tool_execution_end
    turn_end
    turn_start
    ...
    agent_end

对 delta 数量不要过度绑定，除非测试的就是 Provider 分片契约；网络分片大小可能改变，但 start/end/done 不变量应稳定。

## 5. 可控 Promise：测试并发与竞态

用 deferred：

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>(r => { resolve = r; });
      return { promise, resolve };
    }

工具 execute 先记录 started，再等待 deferred。这样可验证：

- 并行工具是否同时启动；
- sequential 工具是否阻塞后一个；
- abort 时锁是否仍持有；
- session 替换时旧事件是否泄漏；
- dispose 后是否还有回调。

不要用固定 `setTimeout(100)` 判断先后；慢 CI 上会产生偶发失败。

## 6. 测试文件工具

使用每个测试独立的临时目录，并在 finally/async dispose 中清理。注入 Operations 可更精确地制造：

- access 失败；
- read 中途 abort；
- write settled 前取消；
- CRLF/BOM；
- 超大输出；
- 符号链接与真实路径。

不要让测试读写仓库源码或用户 home。测试失败时也必须不会留下重要文件改动。

## 7. 测试 SessionManager

至少覆盖：

- v1/v2 到 v3 迁移；
- header 验证；
- 末行不完整；
- 跨 buffer UTF-8；
- duplicate/missing parent；
- branch leaf 切换；
- custom 不进 context；
- custom_message 进入 context；
- compaction firstKeptEntryId；
- model/thinking 恢复；
- session name/label；
- 首次持久化边界。

对持久化后端做 contract test，比为每个后端复制完全不同测试更可靠。

## 8. 测试 TUI

组件测试直接调用 `render(width)`。集成渲染使用 virtual terminal 捕获 ANSI 操作并检查最终屏幕。

宽度测试矩阵：

    ASCII
    中文/CJK
    emoji
    combining marks
    ANSI color
    很窄宽度：0/1/2
    resize
    新帧变短

仓库已有多个 CJK、overlay、shrink、ANSI wrap 的 regression test。发现视觉 bug 时先写最小字符串复现，再运行整个交互界面。

## 9. 测试 framing 与协议

一个协议消息至少经过：

    domain
      → wire DTO
      → Schema validation
      → CBOR
      → frame
      → arbitrary chunks
      → decoder
      → Schema validation

测试层次：

- encode/decode round trip；
- 未知字段拒绝；
- 不安全数、无穷值、坏 UTF-8；
- 任意 fragmentation/coalescing；
- max frame/container/depth；
- hello 版本不匹配；
- request ID 关联；
- snapshot 权威语义；
- lease 冲突；
- 断连资源释放；
- domain ↔ wire 桥接的穷尽映射。

## 10. Telemetry 测试原则

Telemetry 测试不能只检查“有 span”。还要断言：

- callback 只调用一次；
- 返回/拒绝 identity；
- 父子与并发 parentage；
- throw 自动 error；
- 显式 status；
- backend recording 抛错不影响业务；
- settled 后调用无效；
- attributes 合并。

优先复用包内 conformance suite。

## 11. 运行检查

根目录：

    npm run check
    ./test.sh

学习或开发时先定位受影响包的 `package.json`，运行其测试脚本或定向测试文件。不要在不清楚脚本语义时随意附加会更新 snapshot、联网或覆盖 fixture 的参数。

提交前检查：

    git status --short
    git diff --check
    git diff --stat

确认没有密钥、临时日志、测试输出和生成的大文件。

## 12. 调试场景一：UI 不再流式更新

按层检查：

1. Provider 是否发 `text_delta`；
2. `streamAssistantResponse` 是否消费；
3. Agent 是否发 `message_update`；
4. AgentSession 订阅者是否收到；
5. interactive 组件状态是否更新；
6. `invalidate/requestRender` 是否调用；
7. doRender 是否认为帧无变化；
8. stdout 是否被其他代码污染。

一次只在层边界记录事件，避免在每个内部函数打印海量日志。

## 13. 调试场景二：工具“调用了但模型不知道”

检查：

- toolCall 是否有 ID；
- 工具结果的 `toolCallId` 是否相同；
- result 是否加入 currentContext；
- 下一次 StreamFn Context 是否包含 result；
- `convertToLlm` 是否错误过滤；
- Provider 消息转换是否保留关联；
- length stop 是否故意拒绝了调用。

## 14. 调试场景三：恢复会话少了消息

检查：

1. 文件中是否真的有 message entry；
2. 当前 leaf 是否位于另一分支；
3. parentId 链是否完整；
4. 是否存在 compaction，旧消息被摘要替代；
5. 条目是否 custom 而非 custom_message；
6. JSON 行是否损坏并被 loader 跳过；
7. 读取的是不是另一个 cwd 对应的 session 目录。

## 15. 调试场景四：偶发文件内容覆盖

检查：

- 两个工具是否并行修改同文件；
- 路径字符串不同但 realpath 相同；
- 自定义 Operations 是否在 Promise resolve 前完成真实写入；
- abort 是否提前释放 queue；
- edit 是否都基于同一原始版本；
- 外部进程是否同时修改文件。

mutation queue 只协调经过当前进程该队列的操作，无法锁住任意外部编辑器。

## 16. 测试反模式

- 真实 Provider 作为唯一单元测试；
- 只 sleep，不控制异步完成点；
- 断言完整 ANSI 字符串却不检查最终屏幕语义；
- 用 snapshot 掩盖未经评审的大变化；
- 测试依赖 `~/.pi/agent` 的个人配置；
- 在固定绝对路径写文件；
- 忽略 abort/error/length；
- 只检查最终文本，不检查 toolCallId 和事件；
- 并行测试共享同一个 session 文件或环境变量。

## 17. 本章练习

为第 05 章的 `add_note` Agent 写一组测试，必须包含：

- 纯文本；
- 工具成功后再次请求模型；
- 参数无效；
- 工具抛错；
- 两个并行工具；
- sequential；
- model streaming abort；
- tool abort；
- 事件轨迹；
- telemetry parentage。

目标不是测试数量，而是每个状态转移都有一个可重复证据。
