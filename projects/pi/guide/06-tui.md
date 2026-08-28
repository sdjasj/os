# 06｜TUI：组件、差量重绘与全屏布局

TUI 包与 LLM 无关。它提供一个轻量终端渲染框架，coding-agent 再用它构建聊天界面。

主要源码：

- [基础 TUI](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/tui.ts)
- [普通主屏幕](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/tui-main-screen.ts)
- [备用全屏](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/tui-alt-screen.ts)
- [布局系统](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/layout.ts)

## 1. 最小组件协议

`Component` 的核心非常小：

    interface Component {
      render(width: number): string[];
      handleInput?(data: string): void;
      invalidate(): void;
    }

`render` 接收可用宽度，返回终端行。组件不直接写 stdout，这使父容器可以组合、裁剪、缓存和测试输出。

可聚焦组件还需要处理：

- 当前是否 focus；
- 输入交给谁；
- 光标位置；
- IME 需要的 `CURSOR_MARKER`。

## 2. 组件树

`Container` 保存子组件，渲染时按顺序合并行。真实界面会进一步包含：

- 消息列表；
- 编辑器；
- 状态栏；
- 自动补全菜单；
- modal/overlay；
- 图片或选择区域。

组件树与 DOM 有相似之处，但输出目标是字符串网格，不是浏览器布局盒。

## 3. invalidate 与 requestRender

状态改变后，组件调用 `invalidate`，最终触发 TUI 的 `requestRender`。渲染不是每次事件都立即同步执行；实现会合并短时间内的请求，并以约 16ms 节流。

原因：

- 模型 token 可能高频到达；
- 每个 delta 都完整重绘会浪费 CPU 和终端 I/O；
- 同一事件循环内多个状态更新可以合并成一帧。

强制渲染用于必须立即更新的少数场景，但滥用会破坏节流收益。

数据流：

    model/tool/input event
      → 更新组件状态
      → invalidate
      → requestRender
      → 合并请求
      → doRender

## 4. 普通模式的差量重绘

[`tui-main-screen.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/tui-main-screen.ts) 的 `doRender` 会：

1. 渲染所有子组件和覆盖层；
2. 处理光标标记；
3. 得到新行数组；
4. 与上一帧比较；
5. 找到第一条和最后一条变化行；
6. 移动光标，只写变化区间；
7. 若旧帧更长，清除残留；
8. 保存新帧作为下次比较基线。

示例：

    old:
      0 "用户：解释 EventStream"
      1 "助手：Event"
      2 "运行中"

    new:
      0 "用户：解释 EventStream"
      1 "助手：EventStream 是异步事件队列"
      2 "完成"

第一行相同，重绘从第 1 行开始。若宽度变化、首次渲染、终端高度变化或帧结构无法安全复用，则走更完整的重绘。

### 为什么要同步输出

光标移动、清行、写文本若被终端逐步展示，会产生闪烁或中间态。实现使用终端支持的同步输出序列尽可能把一帧原子呈现。

## 5. 全屏模式为何不同

[`tui-alt-screen.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/tui-alt-screen.ts) 进入终端 alternate screen：

- 不污染用户原有滚屏历史；
- 拥有固定宽高的全屏画布；
- 适合滚动视图、搜索、选择和覆盖层；
- 退出后恢复原屏幕。

它使用 [`layout.ts`](https://github.com/earendil-works/pi/blob/4e494929998d6bc4fccf75e0a233f727db4b70ee/packages/tui/src/layout.ts)：

    LayoutBox
      ├─ VStack
      │   ├─ header
      │   ├─ ScrollView(content)
      │   └─ editor
      └─ overlay

布局阶段计算每个节点的矩形区域，渲染阶段再把内容写入 `LayoutFrame`。这比普通线性行数组复杂，但能明确处理固定区域和滚动窗口。

## 6. 终端宽度不是字符串长度

下面三者的 JavaScript `length` 和终端占宽没有简单一一对应：

    "abc"
    "中文"
    "e + 组合重音符"

还要忽略 ANSI 颜色序列。任何截断、填充、光标定位都应使用项目已有的显示宽度工具，不能写：

    text.slice(0, width)
    " ".repeat(width - text.length)

错误后果包括边框错位、中文被切半、光标列错误和旧字符残留。

## 7. 光标与 IME

终端输入法组合文字时，系统需要知道真实光标位置。Pi 使用特殊 `CURSOR_MARKER` 把逻辑光标嵌入渲染输出：

1. 编辑器在文本中放 marker；
2. TUI 渲染时找到 marker；
3. marker 本身不显示；
4. 计算它对应的终端行列；
5. 把硬件光标移动到那里。

若组件只用字符串索引推断列，中文、换行、ANSI 和组合字符都会令 IME 候选窗位置漂移。

## 8. 输入与焦点

原始终端输入是字节/转义序列，不是浏览器 KeyboardEvent。可能包含：

- 普通字符；
- Ctrl/Alt 组合键；
- 方向键转义序列；
- 粘贴；
- 鼠标协议；
- resize 信号。

TUI 先确定聚焦组件，再把数据传入 `handleInput`。overlay/modal 出现时通常要截获输入，避免底层编辑器同时响应。

研究输入问题时记录原始数据的转义表示，而不是只打印可见字符。

## 9. 一个最小计数组件

下面是基于真实协议的教学示例：

    class Counter implements Component {
      private value = 0;

      constructor(private readonly onInvalidate: () => void) {}

      render(width: number): string[] {
        const line = "count: " + this.value;
        return [truncateToWidth(line, width)];
      }

      handleInput(data: string): void {
        if (data === "+") {
          this.value += 1;
          this.invalidate();
        }
      }

      invalidate(): void {
        this.onInvalidate();
      }
    }

`truncateToWidth` 应使用仓库的 cell-aware 工具；这里故意不实现，以提醒你不要用 `slice`。

测试它不需要真实终端：

    assert.deepEqual(component.render(20), ["count: 0"]);
    component.handleInput("+");
    assert.deepEqual(component.render(20), ["count: 1"]);

组件纯渲染协议是 TUI 可测试性的来源。

## 10. 从 AgentEvent 到终端

coding-agent 大致执行：

    AgentEvent
      → AgentSession 订阅者
      → interactive mode 更新消息组件/状态组件
      → component.invalidate()
      → TUI.requestRender()
      → 新行与旧行比较
      → ANSI 输出

模型层只知道事件，TUI 只知道组件状态。interactive mode 是二者适配层。

## 11. 常见 bug 的定位方式

### 文字正确但屏幕残留

检查新帧变短时是否清理旧行，以及终端 resize 是否触发完整重绘。

### 中文导致边框错位

检查是否使用 `string.length` 或 `slice` 处理显示宽度。

### 高频流输出闪烁

检查是否绕过 `requestRender` 直接写 stdout，或每个 delta 都强制渲染。

### modal 出现后编辑器仍输入

检查 focus 与 overlay 的输入优先级。

### IME 候选框位置不对

检查 CURSOR_MARKER 是否在裁剪/ANSI 处理后仍被正确识别。

## 12. 动手练习

### 练习 A：差量区间

写函数接收 old/new 行数组，返回第一和最后变化行。覆盖：

- 完全相同；
- 只改中间一行；
- 新帧变长；
- 新帧变短；
- 空帧。

再与 `TuiMainScreen.doRender` 的逻辑比较。

### 练习 B：宽字符组件

实现一个带边框的 label，测试英文、中文、emoji、ANSI 彩色文本。目标是任何宽度下边框都对齐。

### 练习 C：事件节流

模拟 100 个快速 text_delta，统计实际 render 次数。解释为什么 UI 最终内容不能只依赖“每个 delta 一定对应一帧”。

## 13. 本章完成标准

你应能解释：

- `render(width): string[]` 为什么是足够强的组件协议；
- invalidate 与 requestRender 的分工；
- 普通差量模式和 alternate-screen 布局模式的差异；
- ANSI 字符串长度与终端 cell 宽度的差异；
- 为什么模型流的高频事件需要渲染合并。
