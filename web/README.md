# OS/2026 系统实验手册前端

这是教程仓库的静态阅读网站。它在构建时直接载入仓库现有 Markdown 和课程资源，包含：

- 30 讲逐讲详解；
- 17 章主题教程；
- 9 个 MiniLab；
- 18 个可运行 C 示例；
- 课内目录、全文搜索、代码高亮与复制、公式、表格、图片预览、深色模式和本地阅读进度。

## 本地开发

需要 Node.js 20.19+ 或 22.12+，推荐使用当前 LTS 或更新版本。

```bash
cd web
npm install
npm run dev
```

开发服务器默认显示在终端给出的本地地址。网站使用 hash 路由，例如 `#/lecture/20`，刷新任意阅读页都不依赖服务器回退配置。

## 生产构建

```bash
cd web
npm run build
npm run preview
```

`npm run build` 会先运行 TypeScript 检查，再生成 `web/dist/`。`dist/` 可直接部署到任意静态文件服务器，也可以挂在站点子目录；Vite 的相对 `base` 配置会让脚本、样式和课件图片继续正确解析。

## 内容来源与实现

- `src/content.ts` 使用 Vite `import.meta.glob` 读取 `../tutorial/`、`../sources/notes/labs/`、`../examples/` 和课程图片。
- `src/markdown.ts` 负责 GFM、KaTeX、代码高亮、站内路由和资源路径改写。
- `src/App.tsx` 提供课程地图、阅读器、搜索、进度和 hash 路由。
- `src/styles.css` 包含桌面三栏阅读布局、移动端抽屉、浅深色主题和打印样式。

修改教程 Markdown 后重新运行构建即可，不需要维护第二份内容。阅读进度和主题选择保存在浏览器 `localStorage`，不会上传。

课程原始资料来自 JYY 的 OS/2026 公开课程站点，并采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)。本网站是非官方学习教程；转载、修改和再分发时请保留原作者署名并遵守非商业性使用条款。
