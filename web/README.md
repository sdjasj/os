# 多项目教程学习库前端

这是教程仓库的静态阅读网站。根页面是项目门户，每个项目有独立 URL、学习路线、项目内搜索和阅读进度。目前包含：

- OS/2026：30 讲逐讲详解、17 章主题教程、9 个 MiniLab 和 18 个可运行 C 示例；
- CubeSandbox、E2B、MiniMind、Ray、Strix、ARVO、mini-SWE-agent、OpenHands、Codex、OpenClaw、Hands-On Modern RL、verl、DeepSpeed、Megatron-LM 与非官方 pwn.college 中文教程：合计 280 篇源码/研究/实践教程；
- PDF 阅读书库：10 本、948 页大模型、智能体、强化学习、GPU 与安全资料，提供 PDF 内置目录、按页加载、缩放、文字选择、滑动翻页与本地续读；
- 课内目录、全文搜索、代码高亮与复制、公式、表格、图片预览、深色模式和本地阅读进度。

## 本地开发

需要 Node.js 20.19+ 或 22.12+，推荐使用当前 LTS 或更新版本。

```bash
cd web
npm install
npm run dev
```

开发服务器默认从 `/os/` 提供门户。项目入口使用真实路径，例如 `/os/projects/ray/`；项目内部使用 hash 路由，例如 `/os/projects/ray/#/doc/usage--02-core-tasks`，因此章节刷新不依赖服务器回退配置。

## 生产构建

```bash
cd web
npm run build
npm run preview
```

`npm run build` 会先运行 TypeScript 检查，再生成 `web/dist/`，随后为全部项目和 `pdf-library` 写入 `dist/projects/<slug>/index.html` 和 `.nojekyll`。默认部署前缀是 `/os/`；其他站点可通过 `VITE_BASE_PATH` 覆盖。

## 内容来源与实现

- `src/content.ts` 使用 Vite `import.meta.glob` 读取 `../tutorial/`、`../sources/notes/labs/`、`../examples/` 和课程图片。
- `src/projects.ts` 维护外部项目元数据、章节顺序、上游源码映射和项目 URL。
- `src/markdown.ts` 负责 GFM、KaTeX、代码高亮、站内路由和资源路径改写。
- `src/ProjectSite.tsx` 提供项目门户与通用项目阅读器；`src/App.tsx` 保留完整 OS 课程应用并负责顶层分流。
- `src/PdfLibrarySite.tsx` 与 `src/pdfLibrary.ts` 提供独立 PDF 书库、PDF.js 按页阅读器和精确文件目录。
- `scripts/create-route-entrypoints.mjs` 为 GitHub Pages 生成可直接访问的项目入口。
- `src/styles.css` 包含桌面三栏阅读布局、移动端抽屉、浅深色主题和打印样式。

修改教程 Markdown 后重新运行构建即可，不需要维护第二份内容。阅读进度和主题选择保存在浏览器 `localStorage`，不会上传。导入来源和安全边界见 [`projects/README.md`](../projects/README.md)。

OS 课程原始资料来自 JYY 的 OS/2026 公开课程站点，并采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)。其他项目的源码归属、适用许可证与无统一许可证时的例外均记录在 [项目清单](../projects/README.md)；教程内容不会重新授权上游项目。
