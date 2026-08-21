# 引子：Codex 到底是什么

如果你在终端里敲下 `codex "把这段正则改成不回溯的版本"`，几秒钟后它就会把修改后的文件、运行测试的输出、以及一句"我顺手修了你那个没处理的边界情况"一起端到你面前——这不是魔法，是一整套被拆得非常碎、又非常讲究的 Rust 代码在背后运转。

本仓库是 OpenAI 的 **Codex**（工程代号 `codex-rs`）。它最初是个"在终端里帮你写代码"的命令行工具，但现在的体量已经远超一个 CLI：它同时是一个能被 IDE 嵌入的 JSON-RPC 服务、一个跑在沙箱里的命令执行器、一个带图形界面的桌面 app，以及一个插件/MCP 扩展平台。整个东西是一个 Cargo workspace，下面挂着近 200 个 crate。

所以读这个项目最大的难点不是"某段逻辑看不懂"，而是**不知道从哪下手**，以及**不知道某一块代码为什么要被拆成现在这样**。这本 guide 的目的就是替你先走一遍，把地图画出来，再把最值得读的几个核心点拎出来，配上真实文件路径和源码片段。

## 先建立一个 10,000 英尺的视角

把它想成一台有三个齿轮的机器：

```
        你（终端 / IDE）
              │  stdin / JSON-RPC
              ▼
        ┌──────────┐
        │   cli    │   进程 A：薄薄的一层，负责登录、解析参数、起界面
        └────┬─────┘
             │  把"核心"跑在一个独立进程里（app-server）
             ▼
        ┌──────────┐         ┌──────────────┐
        │ app-server│◄─RPC──►│  codex-core   │  进程 B：智能体的大脑
        │ (core 的  │         │  （会话/工具/  │
        │  前端)    │         │   采样循环）   │
        └────┬─────┘         └──────┬───────┘
             │  需要真的跑 shell 命令时
             ▼
        ┌──────────┐
        │exec-server│  进程 C：跑在沙箱里，替你把 `cargo test` 这类命令执行掉
        └──────────┘
```

三进程不是炫技。核心意图是**隔离信任边界**：模型生成的"我要执行 `rm -rf`"这种指令，永远不会在你本机的进程里直接 `system()` 掉，而是被序列化、送检、再交给一个被沙箱约束的执行器。这个边界后面会单独花一章讲（第 6 章）。

## 一个最小可运行的例子

装好之后，最常见的两种用法：

```bash
# 交互式：直接进 TUI，像聊天一样干活
codex

# 非交互式：一条命令，干完就退出（CI、脚本里常用）
codex exec "给 src/utils.rs 的 debounce 补一个测试并跑 npm test"
```

`exec` 这条子命令很有代表性——它把"跑一次任务"这件事做成了无界面的模式，也正是 IDE 插件和后台 agent 调用 Codex 的方式。后面讲进程模型时会回到它。

## 这本 guide 的读法

建议**顺序读**：第 1 章先把近 200 个 crate 归归类，你就不会在 `core/src` 深处迷路；第 2 章讲清三进程怎么协作；第 3、4 章是重头戏，啃下 `codex-core` 的公共 API 和主循环，你就握住了整个项目的"驱动轴"；后面几章是围绕它展开的工具系统、沙箱、TUI、协议和配置。

每一章里凡是像 `core/src/codex_thread.rs:463` 这样的标注，都直接对应仓库里的真实位置。想顺手看源码的话，仓库在 `github.com/openai/codex`，对应文件大致是：

```
https://github.com/openai/codex/blob/main/codex-rs/core/src/codex_thread.rs#L463
```

（行号会随版本漂移，但函数和结构体名基本稳定，靠名字搜更靠谱。）

下一章，我们先把这片 crate 的森林，变成一张你能记住的地图。

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
- [第 6 章：沙箱](#/read/06-sandbox)
- [第 7 章：TUI](#/read/07-tui)
- [第 8 章：协议与 app-server](#/read/08-protocol)
- [第 9 章：配置系统](#/read/09-config)

### 深入

- [第 11 章：exec-server 执行链路](#/read/11-exec-server)
- [第 12 章：模型客户端与流式响应](#/read/12-model-client)
- [第 13 章：配置分层](#/read/13-config-layers)
- [第 14 章：Hooks 系统](#/read/14-hooks)
- [第 15 章：Skills 系统](#/read/15-skills)
- [第 16 章：MCP 接入](#/read/16-mcp)
- [第 17 章：上下文压缩](#/read/17-compact)
- [第 18 章：Rollout 与回放](#/read/18-rollout)
- [第 19 章：登录与鉴权](#/read/19-auth)
- [第 20 章：插件系统](#/read/20-plugins)
- [第 21 章：审批策略](#/read/21-approval)
- [第 22 章：TUI 内部](#/read/22-tui-internals)
- [第 23 章：协议与类型生成](#/read/23-protocol-ts)
- [第 24 章：多环境](#/read/24-environments)
- [第 25 章：Realtime](#/read/25-realtime)
- [第 26 章：测试策略](#/read/26-testing)
- [第 27 章：错误处理](#/read/27-error-handling)
- [第 28 章：异步运行时](#/read/28-async)
- [第 29 章：构建系统](#/read/29-build)
- [第 30 章：安装与分发](#/read/30-installer)

### 参考

- [术语表](#/read/glossary)
- [架构全景](#/read/architecture)
- [关于本指南](#/read/about)
- [收尾：阅读路线](#/read/10-roadmap)
