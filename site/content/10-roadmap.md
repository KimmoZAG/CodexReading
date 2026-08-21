# 收尾：接下去，你自己怎么读

九章走完，你应该已经能在脑子里画出 Codex 的骨架了：三进程模型、core 的 `submit/next_event` 驱动轴、采样—执行主循环、工具与沙箱、TUI 作为事件视图、协议把大脑变成服务、配置把一切串起来。

这章不灌新概念，只给你一份"下一步往哪钻"的路线，按目标分。

## 路线 A：想改模型交互行为

从 `core/src/client.rs`（或更底层的 `codex-client`）读起，看流式响应怎么变成 `world_state`、再进 `run_turn` 的采样循环（`core/src/session/turn.rs:153`）。要调 prompt 工程，看 `build_skills_and_plugins`（`:250`）和 skills 那几个 crate（`codex-skills`）。

## 路线 B：想加一个新工具

照 `core/src/tools/handlers/` 里现有 handler（比如 `apply_patch.rs`）的骨架，实现同一套 trait，到 `core/src/tools/registry.rs` 注册。记得 PreToolUse / PostToolUse 两道 hook，以及要不要走审批闸门。需要外部能力就走 `codex-mcp` / `codex-plugin-*`。

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

## 最后一句

这个项目最让人服气的地方，不是某个算法多巧妙，而是它把"让不可信的模型安全地替你干活"这件本质上很危险的事，拆成了一组清晰、可替换、边界分明的进程与协议。你读的每一层隔离、每一次事件回流，背后都是"假设模型会犯错，所以先用笼子关住它"这个朴素却彻底的工程立场。

祝读得开心。要是哪块卡住了，回到第 1 章的地图，先确认你手上的 crate 属于哪条主线——八成就通了。
