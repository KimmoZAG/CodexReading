# Codex 阅读指南（静态站点）

这是一个**无构建步骤**的静态阅读站，用于导读 OpenAI 的 `codex-rs` 仓库。内容是一份由浅入深的源码导读（11 篇），并附带一个可交互的 crate 地图。

## 本地预览

```bash
cd site
python3 -m http.server 8080
# 浏览器打开 http://localhost:8080
```

> 必须通过 HTTP 访问（GitHub Pages / 本地静态服务器），不能直接 `file://` 双击打开——章节和 crate 索引是通过 `fetch` 加载的。

## 部署到 GitHub Pages

两种方式任选其一：

**方式 A：把 `site/` 作为 Pages 根目录**
1. 把 `site/` 目录下的所有文件推到某个分支（例如 `gh-pages`）；
2. 仓库 Settings → Pages → Source 选该分支、根目录（`/`）；
3. 等待构建，访问 `https://<user>.github.io/<repo>/`。

**方式 B：作为仓库子目录**
如果你希望站点放在主仓库里，可以在 Pages 设置里选择 "Deploy from a folder" 并指定 `site/` 文件夹。

`.nojekyll` 已包含，避免 GitHub 把 `css/`、`js/` 当成 Jekyll 特殊处理。

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
