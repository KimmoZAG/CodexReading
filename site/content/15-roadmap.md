# 收尾：阅读路线与关于本站点

本指南一共 16 篇：开头的引子、第 1 章到第 13 章这十三章正文，以及结尾的术语表与架构全景、阅读路线两页参考。把引子、第 1 章到第 9 章（仓库地图一路读到配置系统）走完，Codex 的驱动轴和主干流程就清晰了：三进程模型、core 的 `submit/next_event` 驱动轴、采样—执行主循环、工具与沙箱、TUI 作为事件视图、协议把大脑变成服务、配置把一切串起来。后面第 10–13 章是围绕它展开的执行链路、扩展生态、模型与上下文、工程化，按你的目标挑读就行。

下面按目标给出几条路线。

## 路线 A：想改模型交互行为

从 `core/src/client.rs`（或更底层的 `codex-client`）读起，看流式响应怎么变成 `world_state`、再进 `run_turn` 的采样循环（`core/src/session/turn.rs:153`）。要调 prompt 工程，看 `build_skills_and_plugins`（`turn.rs:758`）和 skills 那几个 crate（`codex-skills`）。细节都在第 12 章。

## 路线 B：想加一个新工具

照 `core/src/tools/handlers/` 里现有 handler（比如 `apply_patch.rs`）的骨架，实现同一套 trait，到 `core/src/tools/registry.rs` 注册。记得 PreToolUse / PostToolUse 两道 hook，以及要不要走审批闸门（第 5 章、第 6 章）。需要外部能力就走 `codex-mcp` / `codex-plugin-*`（第 11 章）。

## 路线 C：想动安全边界

`codex-sandboxing` 的 `policy_transforms` 是入口；平台后端在 `linux-sandbox` / 对应 OS crate。审批持久化在 `codex-execpolicy`。动这里务必保守——你改的是"模型能造成多大破坏"的上限。

## 路线 D：想接自己的前端

读 `codex-app-server-protocol` 的 `rpc.rs` 和 `codex-app-server-transport`，然后记住铁律：**你只是在渲染 `EventMsg`**。先列出你想支持的 `EventMsg` 变体，再逐个画 UI，比从 `main` 硬读高效十倍。

## 几个通用的读码习惯

1. **先抓公共面，再进内部**。`CodexThread` 的 `submit/next_event` 比 `run_turn` 内部好懂一百倍，先建立驱动轴再深入。
2. **顺着 `EventMsg` 走**。想知道"某现象从哪来"，全局搜这个枚举变体被 `match` / `emit` 的地方，基本一击命中。
3. **把 `codex-*` 小 crate 当标准库**。遇到 `codex-utils-*` 别停下细读，用到再查。
4. **行号会漂，名字不会**。`run_turn`、 `ApplyPatchHandler`、 `dispatch_any_with_terminal_outcome` 这类名字比行号稳定，靠名字搜更靠谱。
5. **配置即策略**。看到 `turn.config.features.enabled(...)` 别跳过，它往往标着"实验性行为"。

## 关于本站点：怎么用这份指南

这是一份面向工程师的 Codex 源码阅读指南，把 Codex 这个"让不可信模型安全替你干活"的项目，按进程、协议、配置、工具、前端等主线拆成一份可逐章钻进去的地图。它更像一本陪你读代码的书，不是 API 文档：每一章聚焦一条主线，告诉你该从哪个 crate / 哪个文件读起，行号会漂但名字不会，所以多用名字去搜。

怎么用这个站点：

- **左侧选章**：左侧目录列出全部章节，按阅读顺序排列，点一下即可跳转；当前章会高亮。
- **全文搜索**：按 `Ctrl`（Windows/Linux）或 `⌘`（macOS）加 `K`，弹出搜索框，对整个站点做全文检索，回车跳到命中处。
- **看快捷键**：按 `?` 弹出快捷键一览，所有键盘操作都在里面。
- **翻章**：用 `←` / `→`，或者 Vi 风格的 `j` / `k`，在上/下一章之间快速切换。
- **跳到源码**：正文中出现的 `path:line`（例如 `core/src/session/turn.rs:153`）是可点击引用，点一下直接跳到 GitHub 对应文件与行号，方便边读边对照。
- **深浅色切换**：右上角切换浅色 / 深色主题，刷新后也会记住你的选择。

## 结语

Codex 的重心不在某个巧妙算法，而在把"让不可信模型安全地替你干活"这件危险事，拆成一组清晰、可替换、边界分明的进程与协议。整份代码的隔离与事件回流，都服务于同一个立场：先假设模型会犯错，再用笼子把它关住。
