# 第 7 章：终端界面——你眼睛看到的那一层

终端里那个花花绿绿的界面有 487 个文件，干的事只有一件：把 core 回流的 `EventMsg` 画成屏幕上的东西。前面几章反复说的"界面层只是 `EventMsg` 的一个视图"，在 `codex-tui` 里能看到具体代码。

## 7.1 它是什么、不是什么

`codex-tui` 基于 `ratatui`（Rust 的终端 UI 框架）。职责非常纯粹：

1. 把你的键盘输入，变成 `Op::TurnInput` 提交给 core；
2. 把 core 回流的 `EventMsg`，渲染成屏幕上的文字、进度条、补丁预览。

它**不**持有任何会话逻辑、不跑模型、不执行命令，那些都在 core 和 exec-server 里。

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

![](assets/diagrams/tui.svg)

TUI 每一帧画面，就是把目前为止收到的所有 `EventMsg` 按顺序 fold 出来的当前状态——Redux/Elm 的 `state = reduce(events)`，只不过事件源不是用户点击，而是 core 的智能体活动。

两个直接后果：

- **界面可替换**。IDE 插件、桌面 app 拿到的是同一份 `EventMsg`，只是改成在编辑器里画进度条。第 2 章说的"界面层能被随意替换"，指的就是这件事。
- **可回放**。状态完全由事件序列决定，`codex-rollout-trace` 把事件存下来，就能原样重演一次会话（debug、评测都靠它）。

## 7.3 钻进去看：App 状态怎么组织

`tui` 内部是个朴素的状态机：`App` 持有一大坨可变状态，事件（终端按键、来自 core 的 `ServerNotification`、app-server 通知）不断流入，每个事件都被某个 `handle_*` 方法就地改写状态，再由渲染函数把状态画成帧。

顶层入口 `run_ratatui_app`（`tui/src/lib.rs:955`）做完鉴权、onboarding、配置加载后，调用 `App::run`（`tui/src/lib.rs:1697`）。`App` 定义在 `tui/src/app.rs:523`，是一个巨大的状态容器：既装着 UI 状态（`chat_widget`、`ChatWidget`、滚动位置、overlay、keymap），也装着线程路由状态（`thread_event_channels`、`active_thread_rx`、`active_thread_id`）。

字段全是"被事件改写的记忆"。`App` 没有一层 getter 堆叠出来的业务方法；按键也好、一条 `AgentMessageDelta` 也好，都通过对应的 `handle_*` 直接 mutation 这些字段，不存在独立的状态拷贝。

## 7.4 主事件循环：四类事件如何合并

事件循环本体是 `App::run`（`tui/src/app/startup.rs:59`）末尾的 `loop`（`tui/src/app/startup.rs:653`）。它用 tokio 的 `select!`（`tui/src/app/startup.rs:662`）把四个来源并发收口，哪个先到处理哪个：

1. `app_event_rx.recv()`（`tui/src/app/startup.rs:663`）——app 内部事件；
2. `active_thread_rx.recv()`（`tui/src/app/startup.rs:689`）——当前线程缓冲好的 `ThreadBufferedEvent`，交给 `handle_active_thread_event`（`tui/src/app/thread_routing.rs:1729`）；
3. `tui_events.next()`（`tui/src/app/startup.rs:706`）——crossterm 的终端事件（按键、粘贴、resize），交给 `handle_tui_event`（`tui/src/app.rs:737`）；
4. `app_server.next_event()`（`tui/src/app/startup.rs:736`）——来自 app-server 的 `ServerNotification`。

第二类和第四类是同一股数据流的两个通道：app-server 把 core 产生的 `EventMsg` 包装成 `ServerNotification`，一份经线程 channel 进 `active_thread_rx`，一份经 `app_server.next_event()` 进全局处理。两条路最终都汇入 `ChatWidget::handle_server_notification`，渲染逻辑只有一份。

## 7.5 一个组件怎么渲染某类 EventMsg

以"输出区"为例，看模型回包和命令输出增量如何落到屏幕上。

线程事件携带的是 `ThreadBufferedEvent::Notification(ServerNotification)`。进入 `ChatWidget::handle_server_notification`（`tui/src/chatwidget/protocol.rs:4`）后，对一个大 `match` 做分发：

- `ServerNotification::AgentMessageDelta(notification)`（第 78 行）调用 `self.on_agent_message_delta(notification.delta)`；
- `ServerNotification::CommandExecutionOutputDelta(notification)`（第 94 行）调用 `self.on_exec_command_output_delta(&notification.item_id, &notification.delta)`。

`on_agent_message_delta` 定义在 `tui/src/chatwidget/streaming.rs:141`，内部只是把 delta 推给 `handle_streaming_delta`，后者把文本追加到当前"流式尾 cell"并请求重绘。core 每吐一小块模型文本，TUI 就把它接成一个可重排的可滚动历史单元——第 3 章里 `AgentMessageDelta` 这类增量，在这里被翻译成终端里的逐字输出。

## 7.6 为什么有 487 个文件

"只是渲染 EventMsg"却写出这么多代码，因为终端 UI 的脏活都在细节里：

- 流式文本要增量重绘，不能每来一个字符整屏闪；
- 补丁预览要语法高亮、要 diff 配色；
- 审批弹窗、多环境切换、滚动缓冲区、鼠标支持……

这些都被拆进了 `codex-tui` 以及一堆 `codex-tui-*` 组件 crate。读 TUI 源码时，建议**按组件而不是按文件**去找：先定你要看哪块界面（输入栏？输出区？审批框？），再顺着对应组件进去，别从 `main` 硬读。

想确认"屏幕上某块对应哪个 Event"，最省事的办法是在 `EventMsg` 的变体里挑你关心的那个，全局搜它被 `match` 的地方，基本都能定位到 TUI 里负责渲染它的那几行。

下一章讲 app-server：core 怎么被包成 IDE 能连的服务，线协议到底是什么。
