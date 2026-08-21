# 第 7 章：TUI——你眼睛看到的那一层

前面反复抛出一个观点：**界面层只是 `EventMsg` 的一个视图**。这章用 `codex-tui` 把这个观点坐实，也顺便解释为什么终端里那个花花绿绿的界面，代码量能到 487 个文件。

## 7.1 它是什么、不是什么

`codex-tui` 基于 `ratatui`（Rust 的终端 UI 框架）。它的职责非常纯粹：

1. 把你的键盘输入，变成 `Op::TurnInput` 提交给 core；
2. 把 core 回流的 `EventMsg`，渲染成屏幕上的文字、进度条、补丁预览。

它**不**持有任何会话逻辑、不跑模型、不执行命令。那些都在 core 和 exec-server 里。TUI 是个"尽职的传声筒"。

`cli/src/main.rs` 里直接 import 了它的几个对外类型，能看出它的对外形状：

```rust
// cli/src/main.rs:31-34
use codex_tui::AppExitInfo;
use codex_tui::Cli as TuiCli;
use codex_tui::ExitReason;
use codex_tui::UpdateAction;
```

- `TuiCli`：TUI 这一侧的 CLI 参数（颜色、是否交互等）。
- `UpdateAction`：界面内部一次"状态更新"的动作——可以想象成 TUI 自己的 reducer action。
- `AppExitInfo` / `ExitReason`：退出时带回的信息（正常退出？被中断？错误？）。

## 7.2 "纯函数视图"意味着什么

回头看第 3 章那个 `EventMsg` 枚举：

```rust
// EventMsg 定义于 protocol/src/protocol.rs:1288（对端的 Op 在 protocol/src/protocol.rs:543）
pub enum EventMsg {
    TurnStarted,
    AgentMessage(AgentMessage),
    ExecCommandBegin(ExecCommandBegin),
    ExecCommandOutputDelta(ExecCommandOutputDelta),
    ExecApprovalRequest(ExecApprovalRequest),
    PatchApplyUpdated(PatchApplyUpdated),
    // ...
}
```

TUI 每一帧的画面，本质上就是"到目前为止收到的所有 `EventMsg` 按顺序折叠（fold）出来的当前状态"。这正是 Redux/Elm 那套 `state = reduce(events)` 的思想，只不过事件源不是用户点击，而是 core 的智能体活动。

这个设计的妙处：

- **界面可替换**。IDE 插件、桌面 app 拿到的也是同一份 `EventMsg`，只是换成在编辑器里画进度条。第 2 章说"界面层能被随意替换"，根子就在这。
- **可回放**。因为状态完全由事件序列决定，`codex-rollout-trace` 把事件存下来，就能原样重演一次会话（debug、评测都靠它）。

## 7.3 为什么有 487 个文件

既然"只是渲染 EventMsg"，代码量怎么还这么大？因为终端 UI 的脏活都在细节里：

- 流式文本要增量重绘，不能每来一个字符整屏闪；
- 补丁预览要语法高亮、要 diff 配色；
- 审批弹窗、多环境切换、滚动缓冲区、鼠标支持……

这些都被拆进了 `codex-tui` 以及一堆 `codex-tui-*` 组件 crate。读 TUI 源码时，建议**按组件而不是按文件**去找：先定你要看哪块界面（输入栏？输出区？审批框？），再顺着对应组件进去，别从 `main` 硬读。

## 7.4 一个读 TUI 的小技巧

想快速确认"屏幕上某块对应哪个 Event"，最省事的办法是：在 `EventMsg` 的变体里挑你关心的那个，全局搜它被 `match` 的地方，基本都能定位到 TUI 里负责渲染它的那几行。反过来，想知道"模型在干什么时屏幕会怎样变"，也是顺着 `EventMsg` 走。

下一章我们把视野抬到组件之间：app-server 怎么把 core 变成 IDE 能连的服务，线协议到底是什么。
