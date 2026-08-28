# 03｜开发环境：构建、运行、调试与安全实验

## 1. 当前目录布局

本教程采用“源码与笔记分离”：

    /path/to/pi/
      ├─ pi-mono/    # 上游源码，保持其 Git 历史
      └─ tutorial/   # 本教程

所有源码命令默认在 `pi-mono` 中执行：

    cd /path/to/pi/pi-mono

先确认版本：

    git rev-parse HEAD
    node --version

教程基线为 `4e494929998d6bc4fccf75e0a233f727db4b70ee`，Node.js 需要 `>= 22.19.0`。

## 2. 安装依赖

仓库推荐：

    npm install --ignore-scripts

`--ignore-scripts` 会阻止依赖包在安装阶段自动运行生命周期脚本，缩小供应链脚本的执行面。它不意味着依赖绝对安全，但适合源码学习和本项目的构建流程。

如果只阅读代码，不需要先安装依赖；需要运行、类型检查或测试时再安装。

## 3. 构建命令

根目录 [`package.json`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/package.json) 提供：

    npm run build
    npm run build:offline

- `build` 构建工作区包，并执行需要联网生成的数据步骤；
- `build:offline` 适合没有网络或不想刷新外部模型数据时使用；
- 构建产物由各包脚本决定，不要手工编辑生成文件。

仓库根 [`AGENTS.md`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/AGENTS.md) 要求文档改动不必运行完整构建；源码改动则根据影响范围选择检查。开始贡献前应完整阅读它。

## 4. 运行开发版 Pi

完成安装和构建后：

    ./pi-test.sh

该脚本从当前源码启动 Pi，适合验证 coding-agent 修改，不必先把包发布到 npm。

常见使用模式：

    ./pi-test.sh
    ./pi-test.sh -p "概括当前仓库结构"
    ./pi-test.sh --help

参数可能随版本变化，始终以 `./pi-test.sh --help` 为准。

第一次连接真实模型还需要认证。可以使用交互式 `/login`，或按 Provider 文档设置 API key。不要把密钥写入仓库、扩展示例或教程代码。

## 5. 质量检查

根脚本中最重要的命令：

    npm run check
    ./test.sh

`npm run check` 统一执行格式、静态检查和类型相关验证；`./test.sh` 运行仓库测试。开发时优先运行受影响包的测试，结束前再按变更风险扩大范围。

定位测试：

    rg --files packages | rg '(^|/)(test|tests)/|[.]test[.]ts$'
    rg 'describe`(|test`(' packages/agent packages/ai

测试不是最后的仪式。研究某个行为时，先找到对应测试，往往能直接看到边界条件和可注入假实现。

## 6. 高效导航源码

### 按符号搜索

    rg 'export class AgentSession' packages
    rg 'function createAgentSession' packages
    rg 'type: "tool_execution_start"' packages

### 列出一个包的公共入口

    sed -n '1,240p' packages/agent/src/index.ts
    sed -n '1,240p' packages/ai/src/index.ts

### 查调用者

    rg 'createAgentSession`(' packages/coding-agent
    rg 'appendMessage`(' packages/coding-agent/src

先按函数名找定义和调用，不要依赖教程行号。行号只对固定提交稳定。

## 7. 建立最小调试闭环

### 日志法

研究事件顺序时，订阅 session：

    const unsubscribe = session.subscribe((event) => {
      console.error(JSON.stringify(event));
    });

    try {
      await session.prompt("列出当前目录");
    } finally {
      unsubscribe();
      session.dispose();
    }

日志写到 stderr，可避免与 print 模式的正常 stdout 混杂。临时日志不要包含 API key、完整敏感 prompt 或文件内容。

### Node 调试器

对构建后的入口使用：

    node --inspect-brk path/to/entry.js

建议断点：

- [`createAgentSession`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/sdk.ts)
- [`AgentSession.prompt`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/agent-session.ts)
- [`runLoop`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts)
- [`streamAssistantResponse`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/agent/src/agent-loop.ts)
- [`ModelsImpl.stream`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/ai/src/models.ts)
- [`SessionManager.appendMessage`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/coding-agent/src/core/session-manager.ts)

第一次调试只跟踪一个无工具调用的 prompt；第二次再允许 read 工具。这样更容易区分模型流和工具循环。

## 8. 建议的实验目录

不要在重要项目中测试 write、edit、bash。创建一个明确、可丢弃的目录：

    mkdir -p /tmp/pi-learning-sandbox
    cd /tmp/pi-learning-sandbox
    git init

放入少量假文件，再从这里运行开发版 Pi。Git 能让你检查每次实验改了什么，但它不是权限隔离。

更高隔离需求请使用容器、虚拟机或操作系统沙箱，并只挂载必要目录。Pi 自身不会为内置工具自动建立系统级沙箱。

## 9. 环境变量和本地配置

官方环境变量文档列出了 agent 目录、Provider key 和运行行为的可配置项。学习时遵循：

- 密钥只放进进程环境或受保护的凭据存储；
- 不在 shell history 中直接粘贴长期密钥；
- 项目专用设置放 `.pi/` 前先检查是否适合提交；
- `~/.pi/agent/` 是用户级资源目录，不要假定团队成员拥有相同内容；
- 调试“为什么我的行为不同”时，同时检查全局与项目资源。

## 10. 项目信任的真实边界

打开陌生目录时，项目内的 `.pi` 资源可能包含可执行扩展。项目信任用于控制是否加载这些本地资源。

它不能：

- 限制已经启用的 bash 工具可执行哪些系统命令；
- 限制 read/write/edit 的操作系统权限；
- 把网络访问自动关掉；
- 代替代码审查或容器隔离。

因此安全模型应理解为：

    项目信任：是否接受项目提供的 Pi 定制
    操作系统权限：Pi 进程实际能访问什么
    用户确认/扩展策略：工作流层面的额外约束
    沙箱/容器：强制资源边界

四者是互补关系。

## 11. 第一次运行检查表

- [ ] Git 提交与教程基线一致，或已接受版本差异；
- [ ] Node.js 版本满足要求；
- [ ] 已阅读根 `AGENTS.md`；
- [ ] 依赖使用 `--ignore-scripts` 安装；
- [ ] API key 不在 Git 工作区；
- [ ] 在可丢弃目录测试文件工具；
- [ ] 先运行一个纯文本 prompt；
- [ ] 再运行一个只读工具 prompt；
- [ ] 记录事件顺序并与第 05 章核对。
