# 08｜内置工具：read、write、edit、bash 与并发安全

Pi 默认只有四个通用工具。少而清晰的工具面既减少模型选择成本，也把更有偏好的工作流留给扩展。

目录：[`packages/coding-agent/src/core/tools`](https://github.com/earendil-works/pi/tree/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools)

## 1. 通用 ToolDefinition

产品层工具在 AgentTool 契约之外还带 UI 与 prompt 信息：

- `name`、`label`、`description`；
- TypeBox `parameters`；
- `execute(toolCallId, params, signal, onUpdate, ctx)`；
- prompt snippet/guidelines；
- 可选 `renderCall`、`renderResult`。

工具有三套不同输出：

1. 返回给模型的结构化 content；
2. details 中给产品/UI 的元数据；
3. render 函数生成的人类界面。

不要把彩色 diff 文本直接当作唯一机器结果；UI details 与模型说明可分别优化。

## 2. read：文本、图片与有界输出

[`read.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools/read.ts) 的参数：

    {
      path: string,
      offset?: number,  // 1-based 起始行
      limit?: number    // 最大行数
    }

执行过程：

1. 相对路径基于 cwd 解析；
2. 检查是否可读；
3. 检测受支持图片 MIME；
4. 图片可按设置缩放并作为 ImageContent 返回；
5. 文本按 offset/limit 切片；
6. 再按最大行数/字节数截断；
7. details 记录是否截断以及原因。

截断不是单纯 UI 行为。若无限制地把大型日志送入模型，会快速占满上下文。工具说明会提示模型使用后续 offset 继续读取。

`ReadOperations` 把 `readFile/access/detectImageMimeType` 注入，使同一工具可映射到本地、SSH 或虚拟文件系统。

## 3. write：完整创建或覆盖

[`write.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools/write.ts) 的参数：

    { path: string, content: string }

它：

1. 解析绝对路径；
2. 进入该文件的 mutation queue；
3. 递归创建父目录；
4. 写完整 UTF-8 内容；
5. 返回写入字节/字符相关说明。

工具 prompt 明确建议 write 用于新文件或完整重写；精确修改应使用 edit。原因是完整覆盖更容易意外丢失模型没有复述的部分。

`WriteOperations` 注入 `mkdir/writeFile`，同样允许远程后端。

## 4. edit：基于原文件的精确替换

当前快照的 [`edit.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools/edit.ts) 接收：

    {
      path: string,
      edits: [
        { oldText: string, newText: string },
        ...
      ]
    }

关键语义：

- 每个 `oldText` 必须精确且唯一匹配；
- 所有 edit 都相对“原始文件”匹配，不是前一个 edit 的结果；
- edits 不得重叠或嵌套；
- 邻近修改应合并成一个替换块；
- 一次调用可修改同文件多个离散区域。

这样设计避免多个模型工具调用之间的竞态，也让单次结果产生完整 diff。

### 执行细节

1. 兼容少数模型把 edits 错发成 JSON 字符串或单对象；
2. 运行 Schema/自定义输入验证；
3. 进入文件 mutation queue；
4. 检查读写权限；
5. 读取原文件；
6. 暂时剥离 UTF-8 BOM；
7. 检测 CRLF/LF，并在内部规范化为 LF；
8. 对原始内容验证和应用所有替换；
9. 恢复 BOM 与原换行风格；
10. 写回；
11. 返回展示 diff、unified patch 和首个变化行。

这些细节解释了为什么一个“字符串替换工具”仍需要相当多代码：保持文件格式和失败原子性比调用 `replace` 更重要。

## 5. bash：子进程、流式输出、超时与终止

[`bash.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools/bash.ts) 的参数：

    {
      command: string,
      timeout?: number  // 秒；未提供则无默认超时
    }

本地实现：

- 按平台 shell 配置启动子进程；
- 合并处理 stdout/stderr 增量；
- 约每 100ms 节流一次 UI update；
- timeout 时终止进程树；
- abort 时终止进程树；
- 等待子进程稳定退出；
- 清理 timer、监听器和 PID 跟踪；
- 输出太大时截断模型可见部分，并可保留完整输出路径。

杀“进程”不一定够，因为 shell 命令可能创建子进程。`killProcessTree` 处理的是整个相关进程树。

### 环境暴露

按设置，bash 可获得 `PI_SESSION_ID`、`PI_SESSION_FILE`、`PI_PROVIDER`、`PI_MODEL`、`PI_REASONING_LEVEL` 等会话信息。实现先从环境副本删除旧值，再按当前 context 注入，避免继承错误状态。

这些变量可能透露会话路径和模型信息。远程或不受信环境中应评估是否关闭暴露。

## 6. OutputAccumulator 与截断

流式命令存在两个不同需求：

- UI 希望看到最近输出并持续更新；
- 模型结果必须受 token/字节限制；
- 用户在排障时可能需要完整输出。

因此实现将“增量累积”“预览”“最终截断”“完整输出保存”分开。设计自定义日志工具时也应保留这三层，不要每次 update 都复制无限增长的大字符串。

## 7. 同文件 mutation queue

[`file-mutation-queue.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/tools/file-mutation-queue.ts) 的目标：

    相同真实路径：串行
    不同路径：仍可并行

简化算法：

1. resolve 路径；已存在文件尽量 realpath，统一符号链接；
2. Map 中保存该路径当前队列 Promise；
3. 新操作接到旧 Promise 后；
4. 等旧操作释放再执行；
5. finally 中释放下一个，并在队尾清理 Map。

还有一个 registration queue，保证“查当前队列并注册下一队列”的过程不会因异步 realpath 交错而丢失顺序。

### 为什么 abort 后也不能立刻释放锁

write/edit 在每个 await 后检查 `signal.aborted`，而不是 abort 监听器一触发就拒绝外层 Promise。否则底层文件写入可能仍未结束，队列却让下一操作启动，导致两个写入重叠。

正确原则是：取消改变最终结果，但锁要持有到实际 I/O 已 settled。

## 8. 工具 wrapper 与扩展 hook

最终 AgentTool 通常由 wrapper 包裹，使扩展可：

- 在 `tool_call` 前检查或阻止；
- 改变相关上下文；
- 观察 result；
- 用自定义 render 呈现；
- 在 UI 中确认。

安全策略应在执行边界拦截，而不只是依靠 system prompt 告诉模型“不要运行危险命令”。模型提示是软约束，hook/权限/沙箱才是不同强度的控制。

## 9. 真实风险模型

### read

可能读取私钥、环境文件、浏览器资料。只读不等于无风险，因为内容会进入模型请求或日志。

### write/edit

以当前用户权限覆盖文件，可能修改 shell 配置、构建脚本或凭据。Git 只保护已跟踪文件。

### bash

拥有当前进程能做的几乎所有事情，包括网络访问、删除文件和启动后台进程。

降低风险：

- 在专用目录运行；
- 为陌生项目使用容器/低权限用户；
- 通过扩展确认高风险调用；
- 只启用任务所需工具；
- 审核项目扩展；
- 避免让输出包含密钥；
- 对远程 Operations 做服务端路径和权限校验。

## 10. 一个远程 read 的设计草图

    const remoteReadOps: ReadOperations = {
      async access(path) {
        await remote.statAndCheckReadable(path);
      },
      async readFile(path) {
        return remote.readBuffer(path);
      },
      async detectImageMimeType(path) {
        return remote.detectMime(path);
      },
    };

只替换 Operations 还不够。远程端必须：

- 规范化路径并限制根目录；
- 防御 `..` 和符号链接逃逸；
- 验证每次请求身份；
- 限制大小与耗时；
- 传播取消；
- 不相信客户端传来的“已校验”结论。

## 11. 动手练习

### 练习 A：edit 边界

为 edit 写测试：

- 唯一替换成功；
- oldText 不存在；
- oldText 出现两次；
- 两个 edits 重叠；
- 保留 CRLF；
- 保留 BOM；
- 写入期间 abort 不提前释放 queue。

### 练习 B：受控 bash

参考 plan-mode 扩展，实现只允许 `pwd`、`ls` 和 `git status` 的 hook。测试含管道、重定向、换行和 shell 拼接符的输入，体会字符串 allowlist 为什么很难做到完整安全。

### 练习 C：同文件与异文件并发

用可控 Promise 替换 WriteOperations：

- 对同一路径发两次写，验证第二次等待；
- 对两个不同路径发写，验证可同时开始；
- 对符号链接与真实路径发写，检查 realpath 是否合并队列。
