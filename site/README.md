# Codex 阅读指南（静态站点）

这是一个**无构建步骤**的静态阅读站，用于导读 OpenAI 的 `codex-rs` 仓库。内容是一份源码导读，并附带一个可交互的 crate 地图。

## 本地预览

```bash
cd site
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

站点通过 `fetch` 加载章节和 crate 索引，所以必须经 HTTP 访问，不能直接 `file://` 双击打开。

如果你只是想离线看，仓库里另提供了 `dist/` 目录，里面是打包好的单文件版，直接双击即可打开，无需起服务器。

## 部署到 GitHub Pages

仓库已配好 Actions 工作流：push 到 `main` 分支就会自动构建并部署。

线上地址：`https://kimmozag.github.io/CodexReading/`

不需要手动操作 Pages 设置。`.nojekyll` 已包含，避免 GitHub 把 `css/`、`js/` 当成 Jekyll 特殊处理。

## 目录结构

```
site/
├── index.html          # 单页阅读器
├── css/styles.css       # 样式（含深浅色）
├── js/app.js            # 路由 + Markdown 渲染 + crate 地图
├── content/
│   ├── manifest.json    # 章节清单
│   └── 00-overview.md … 10-roadmap.md   # 正文（带源码引用）
└── data/
    └── crates.json       # 由 codex-rs 扫描生成的 crate 索引
```

正文里的 `path:line` 标注都对应 `github.com/openai/codex` 仓库中 `codex-rs/` 下的真实位置；crate 卡片点击后跳转到对应目录。

## 功能清单

- **章节阅读**：共 34 篇，含引子、仓库地形图、进程模型、`codex-core` 公共 API、主循环 `run_turn`、工具系统、沙箱、TUI、协议与 app-server、配置系统（入门/进阶），以及 20 篇深入章（exec-server、模型客户端、配置分层、Hooks、Skills、MCP、上下文压缩、Rollout、鉴权、插件、审批策略、TUI 内部、协议与类型生成、多环境、Realtime、测试、错误处理、异步运行时、构建、安装分发），外加术语表、架构全景、关于本指南、阅读路线（参考）。
- **上一章 / 下一章导航**：每章底部提供相邻章节跳转链接。
- **键盘翻章**：`←` / `→` 与 `j` / `k` 切换上一章 / 下一章。
- **快捷键帮助**：按 `?` 弹出快捷键说明。
- **全文搜索**：`Ctrl` / `⌘` + `K` 打开搜索框，跨所有章节正文检索。
- **本页目录（TOC）**：自动提取页内标题并生成锚点链接，滚动时高亮当前小节（scrollspy）。
- **滚动阅读进度条**：顶部进度条反映当前章节阅读进度。
- **代码块复制按钮**：每个代码块附带一键复制。
- **源码引用跳转**：正文中的 `path:line` 标注自动渲染为指向 GitHub `codex-rs` 对应位置的链接。
- **深 / 浅色主题**：首次跟随系统 `prefers-color-scheme`，可手动切换并记忆（仅手动切换后才脱离系统跟随）。
- **移动端抽屉式侧边栏**：窄屏下侧边栏折叠为抽屉，带遮罩与 `Esc` 关闭。
- **打印样式**：内置 `@media print` 规则，可直接导出 PDF。
- **阅读时长估算**：根据正文长度估算并显示阅读分钟数。
- **章节难度标签**：按 manifest 的 `level`（入门 / 进阶 / 深入 / 参考）显示难度徽标。
- **阅读进度记忆**：记住上次阅读的章节以及每章的滚动位置，再次打开自动恢复。
- **复制本章链接**：一键复制当前章节的可分享 URL（`#/read/<id>`）。
- **回到顶部按钮**：滚动后出现，平滑回到页首。
- **JSON-LD 结构化数据**：`index.html` 内嵌 `application/ld+json`。
- **社交分享元标签**：`og:`（Open Graph）与 `twitter:` 卡片元标签。
- **SEO 文件**：`sitemap.xml` 与 `robots.txt`。
- **仓库地图**：可搜索的 crate 地图（141 个 crate，核心 crate 高亮）。
- **无障碍（a11y）**：合理使用 `aria-*` 属性，并提供 `focus-visible` 焦点样式。
- **性能优化**：对 CDN 设置 `preconnect` 预连接，第三方脚本与 `app.js` 均 `defer` 加载。
