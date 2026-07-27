# 项目学习库与 OS 2026 课程教程

本仓库是一个多项目中文学习站。根页面提供项目目录，每个项目拥有独立 URL、学习路线、全文搜索、长文阅读器和本地阅读进度；当前收录 OS/2026、CubeSandbox、E2B、MiniMind、Ray、Strix、ARVO、mini-SWE-agent、OpenHands、Codex、OpenClaw、Hands-On Modern RL、verl 与非官方 pwn.college 中文教程。

其中 OS 项目保存了南京大学 JYY《操作系统原理（2026 春）》公开课程页面的资料快照，并在其 30 讲课程讲义与 9 个 MiniLab 的基础上整理了一套面向实践的中文教程。教程同时提供逐讲详解和按知识依赖重组的主题版，两者共享一组可运行实验。

抓取日期：2026-07-22。课程原始资料来自 <https://jyywiki.cn/OS/2026/>，采用 [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)；转载、修改和再分发时请保留原作者署名并遵守非商业性使用条款。本教程是重新组织和扩写的学习笔记，不替代课程原讲义。

## 从哪里开始

- [在线项目学习库](https://sdjasj.github.io/os/)：从项目目录进入各自独立的教程 URL。
- [前端阅读网站](web/README.md)：项目门户、三栏长文阅读器、全文搜索、深色模式与本地学习进度。
- [外部项目教程清单](projects/README.md)：导入来源、快照、章节数、许可证与安全边界。
- [30 讲逐讲详解](tutorial/lectures/README.md)：逐份对应课程 PPT，共 32,640 行，覆盖 779 个非重复一级主题，适合跟课、复习和逐项查漏。
- [主题版教程](tutorial/README.md)：按知识依赖重组的 17 章速览，适合先建立全局框架。
- [原始资料清单](sources/README.md)：30 讲、9 个 MiniLab、课程说明与参考书目。
- [可运行示例](examples/README.md)：进程、虚拟内存、管道、并发、事件循环、WAL 等实验。

在 Linux 上构建并运行所有示例：

```bash
make -C examples -j
make -C examples smoke
```

启动前端阅读网站：

```bash
cd web
npm install
npm run dev
```

生成可部署的静态网站：

```bash
cd web
npm run build
npm run preview
```

重新抓取课程页面并提取正文：

```bash
bash scripts/download_sources.sh
```

脚本只抓取公开课程页面；课程中的交互演示、视频回放和站外资料仍通过原链接访问。保存的 HTML 仍保留少量线上站内路径，因此正文与图片可本地检索，但它不是一个完全自包含、可断网浏览的站点镜像。

## 目录结构

```text
.
├── tutorial/             # 17 章主题版教程
│   └── lectures/         # 严格对应 30 份 PPT 的逐讲详解
├── projects/             # 13 个外部项目的教程内容快照与来源边界
├── examples/             # 教程配套的独立、可编译 C 示例
├── web/                  # React/Vite 多项目静态阅读网站
├── sources/
│   ├── site_html/        # 下载的原始渲染页面和课程图片
│   ├── notes/            # 从页面抽取的可检索 Markdown 正文
│   └── urls.txt          # 抓取 URL 清单
└── scripts/              # 下载与正文提取脚本
```
