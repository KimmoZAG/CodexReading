# 引子：Codex 到底是什么

在终端里敲下 `codex "把这段正则改成不回溯的版本"`，几秒钟后你会拿到改好的文件、测试运行的输出，外加一句"我顺手修了你那个没处理的边界情况"。背后是一整套拆得很碎的 Rust 代码在跑。

本仓库是 OpenAI 的 **Codex**（工程代号 `codex-rs`）。它起家于"在终端里帮你写代码"的命令行工具，如今的体量远超一个 CLI：能被 IDE 嵌入的 JSON-RPC 服务、跑在沙箱里的命令执行器、带图形界面的桌面 app、插件/MCP 扩展平台，全都装在同一个 Cargo workspace 里，下面挂着近 200 个 crate。

读这个项目卡人的地方有两个：不知道从哪下手，以及不知道某块代码为什么被拆成这样。这份指南就冲着这两点写，结论都配真实文件路径和源码。

## 万米视角：四个角色，一条信任边界

CLI、App-Server、Codex-Core、Exec-Server 各占一块，Exec-Server 被虚线框住的「信任边界」单独隔在外面。

![](assets/diagrams/overview.svg)

分成三个进程的意图是**隔离信任边界**。模型生成的"我要执行 `rm -rf`"这类指令，永远不会在你本机的进程里直接 `system()` 掉，而是被序列化、送检，再交给一个被沙箱约束的执行器。第 6 章专讲这条边界。

## 一个最小可运行的例子

装好之后，最常见的两种用法：

```bash
# 交互式：直接进 TUI，像聊天一样干活
codex

# 非交互式：一条命令，干完就退出（CI、脚本里常用）
codex exec "给 src/utils.rs 的 debounce 补一个测试并跑 npm test"
```

`exec` 把"跑一次任务"做成了无界面模式，IDE 插件和后台 agent 调用 Codex 走的就是这条路。第 2 章会把它和交互式链路摆在一起对照。

## 这份指南的读法

按顺序读。第 1 章把近 200 个 crate 归类，免得在 `core/src` 深处迷路；第 2 章讲三进程怎么协作；第 3、4 章啃 `codex-core` 的公共 API 和主循环，这两章是重头，读完等于握住了整个项目的驱动轴；再往后是工具系统、沙箱与安全、TUI、协议、配置，最后是执行与运行时、扩展生态、模型与上下文、工程化。

章节里像 `core/src/codex_thread.rs:463` 这样的标注，都对应仓库里的真实位置。仓库在 `github.com/openai/codex`，拼成链接大致是：

```
https://github.com/openai/codex/blob/main/codex-rs/core/src/codex_thread.rs#L463
```

行号会随版本漂移，但函数和结构体名基本稳定，靠名字搜更靠谱。

## 章节速览

按难度分四组，每组列出该组全部章节，点击可直达内页。

### 入门

- [引子：Codex 到底是什么](#/read/00-overview)
- [第 1 章：仓库地形图](#/read/01-repo-map)

### 进阶

- [第 2 章：进程模型](#/read/02-process-model)
- [第 3 章：codex-core 公共 API](#/read/03-core-api)
- [第 4 章：主循环 run_turn](#/read/04-turn-loop)
- [第 5 章：工具系统](#/read/05-tools)
- [第 6 章：沙箱与安全](#/read/06-sandbox)
- [第 7 章：终端界面](#/read/07-tui)
- [第 8 章：协议与 app-server](#/read/08-protocol)
- [第 9 章：配置系统](#/read/09-config)

### 深入

- [第 10 章：执行与运行时](#/read/10-runtime)
- [第 11 章：扩展生态](#/read/11-extensions)
- [第 12 章：模型与上下文](#/read/12-model-ctx)
- [第 13 章：工程化](#/read/13-engineering)

### 参考

- [术语表与架构全景](#/read/14-glossary)
- [收尾：阅读路线与关于本站点](#/read/15-roadmap)
