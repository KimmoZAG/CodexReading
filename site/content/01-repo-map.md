# 第 1 章：仓库地形图

第一次 `ls codex-rs` 会被吓到：满屏的 `codex-xxx` 目录。但拆开看，这些 crate 其实只服务于几条清晰的主线。本章给你一个分类框架，后面遇到陌生 crate 时，先把它塞进下面某一类，心里就有底了。

> 站点顶部的「仓库地图」页里放了一份可展开的交互式清单（数据来自对 `codex-rs` 下全部 141 个带 `Cargo.toml` 的 crate 的扫描），本章先讲分类逻辑，那个页面用来"按图索骥"。

## 1.1 第一梯队：你真正要读懂的那几个

整个仓库的"戏肉"集中在少数的几个大 crate 上。读懂它们，等于读懂了 80%。

| Crate | 路径 | 角色 | 规模 |
| --- | --- | --- | --- |
| `codex-core` | `core/` | 智能体大脑：会话、采样循环、工具调用、审批 | 573 个 rs 文件 |
| `codex-cli` | `cli/` | 二进制入口：参数解析、登录、子命令分发 | 76 个 rs 文件 |
| `codex-tui` | `tui/` | 终端界面（基于 ratatui） | 487 个 rs 文件 |
| `codex-app-server` | `app-server/` | 把 core 包成一个 JSON-RPC 服务，供 IDE/桌面端接入 | 237 个 rs 文件 |
| `codex-exec-server` | `exec-server/` | 沙箱里的命令执行器 | 129 个 rs 文件 |
| `codex-protocol` | `protocol/` | 所有组件之间的线协议（事件、指令、模型对象） | — |

注意 `codex-core` 一个 crate 就占了近 600 个文件。它内部还分了 `session/`、`tools/`、`client.rs`、`apply_patch.rs` 等子模块，第 3、4 章会钻进去。

## 1.2 围绕"大脑"的支撑层

大脑要干活，得有人喂它模型响应、有人管配置、有人记日志：

- **`codex-client` / `core/src/client.rs`**：跟 OpenAI Responses API 对话，把 HTTP 流式响应翻译成内部的事件流。
- **`codex-config`**：配置系统。`core` 里几乎所有模块都从 `Config` 读开关（`core/src/config/`）。第 9 章专门讲。
- **`codex-protocol`**：前面提过，是整个仓库的"通用语言"。`Op`（你提交给智能体的指令）和 `Event`（它回流给你的事件）都定义在这里（`protocol/src/protocol.rs`）。
- **`codex-state` / `codex-rollout-trace`**：把一次会话持久化到 SQLite，并能回放（replay），用来做评测和调试。做 agent 评测的人会频繁碰 `rollout`。

## 1.3 安全与隔离：沙箱那条线

这是 Codex 工程上最见功力的部分，也是它和普通"调个 API"脚本的本质区别：

- **`codex-sandboxing`**：把"能不能碰这个文件 / 跑这个命令"抽象成策略，并能转换成平台具体的沙箱（Linux 用 `linux-sandbox` / seccomp，macOS 用 `sandbox-exec`）。
- **`codex-exec` / `codex-exec-server`**：执行器本体与它的服务端。模型想跑命令，请求先到这里，被策略检过、被沙箱兜住，才真正落地。
- **`codex-execpolicy`**：把"用户批准过什么"固化成策略，避免每次都问。

## 1.4 扩展与生态

Codex 把自己做成了一个平台，所以有一堆"接入别人"的 crate：

- **`codex-mcp` / `codex-plugin-*`**：MCP（模型上下文协议）服务和插件运行时。模型能调用的工具可以来自外部插件。
- **`codex-chatgpt` / `codex-login`**：登录与 ChatGPT 侧的桥接。
- **`codex-marketplace`**：插件/命令的市场。
- **`codex-app-server-protocol` / `codex-app-server-transport`**：app-server 对外暴露的 RPC 契约与传输层（stdio / websocket）。

## 1.5 一堆"工具型"小 crate

剩下的大多数 `codex-*` 是几十到几百行的小库，命名基本是自解释的：`codex-ansi-escape`（处理终端转义）、`codex-utils-*` 系列（路径、CLI、绝对路径……）、`codex-features`（特性开关）、`codex-tui-*` 系列（TUI 的组件）。读核心时遇到它们，当"标准库"看就行，不必逐个深究。

## 1.6 一个判读习惯

遇到不认识的 crate，按这个顺序问自己三句话：

1. 它名字里带 `core / cli / tui / app-server / exec-server / protocol` 吗？——带的话，是主线，值得读。
2. 它名字里带 `util / proto / types / test` 吗？——带的话，大概率是辅助，用到再查。
3. 它名字里带 `mcp / plugin / marketplace / chatgpt` 吗？——带的话，是扩展生态，先放过。

有了这个框架，下一章我们讲清这几条主线在**运行时**是怎么连成一条链路的。
