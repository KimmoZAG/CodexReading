# 第 22 章：TUI 内部——一个终端界面怎么被拼出来

第 7 章把 TUI 当成黑盒看了个轮廓，本章钻进 `codex-rs/tui` 的源码，看这个看似「实时动画」的终端界面，内部其实是一个朴素的状态机：`App` 持有一大坨可变状态，事件（终端按键、来自 core 的 `ServerNotification`、app-server 通知）不断流入，每个事件都被某个 `handle_*` 方法就地改写状态，再由渲染函数把状态画成帧。这与第 7 章的「事件驱动」结论、以及第 3 章「core 吐出 EventMsg 流」的设定一脉相承——TUI 就是 core 那股事件流的终端消费者。

## App 状态怎么组织：state = reduce(events)

顶层入口 `run_ratatui_app`（`tui/src/lib.rs:955`）做完鉴权、onboarding、配置加载后，调用 `App::run`（`tui/src/lib.rs:1697`）。而 `App` 本身是一个巨大的「状态容器」，定义在 `tui/src/app.rs:523` 的 `pub(crate) struct App`：里面既装着 UI 状态（`chat_widget: ChatWidget`、滚动位置、overlay、keymap），也装着线程路由状态（`thread_event_channels: HashMap<ThreadId, ThreadEventChannel>`、`active_thread_rx: Option<mpsc::Receiver<ThreadBufferedEvent>>`、`active_thread_id`）。

所有字段都是「被事件改写的记忆」。`App` 没有 getter 堆叠的业务方法，而是把「当前状态 + 一个事件」化简为「下一个状态」——这正是呼应第 7 章的 `state = reduce(events)` 思路。无论是按键还是一条 `AgentMessageDelta`，都通过对应的 `handle_*` 直接 mutation 这些字段，不存在独立的状态拷贝。

## 主事件循环：四类事件如何合并

事件循环本体是 `App::run`（`tui/src/app/startup.rs:59`）末尾的 `loop`（`tui/src/app/startup.rs:653`）。它用 tokio 的 `select!`（`tui/src/app/startup.rs:662`）把四个来源并发收口，哪个先到就处理哪个：

1. `app_event_rx.recv()`（`tui/src/app/startup.rs:663`）——app 内部事件，如 `InsertHistoryCell`、`StartupThreadStarted`。
2. `active_thread_rx.recv()`（`tui/src/app/startup.rs:689`）——当前线程缓冲好的 `ThreadBufferedEvent`，交给 `handle_active_thread_event`（`tui/src/app/thread_routing.rs:1729`）。
3. `tui_events.next()`（`tui/src/app/startup.rs:706`）——crossterm 的终端事件（按键、粘贴、resize），交给 `handle_tui_event`（`tui/src/app.rs:737`）。
4. `app_server.next_event()`（`tui/src/app/startup.rs:736`）——来自 app-server 的 `ServerNotification`。

注意第二类和第四类其实是同一股数据流的两个通道：app-server 把 core 产生的 `EventMsg` 包装成 `ServerNotification`，一份经线程 channel 进 `active_thread_rx`，一份经 `app_server.next_event()` 进全局处理。两条路最终都汇入 `ChatWidget::handle_server_notification`，保证渲染逻辑只有一份。

## 一个组件怎么渲染某类 EventMsg

以「输出区」为例，看 `AgentMessage`（呼应第 3 章的模型回包）和命令输出增量如何落到屏幕上。

线程事件携带的是 `ThreadBufferedEvent::Notification(ServerNotification)`。进入 `ChatWidget::handle_server_notification`（`tui/src/chatwidget/protocol.rs:4`）后，对一个大 `match` 做分发：

- `ServerNotification::AgentMessageDelta(notification)`（第 78 行）调用 `self.on_agent_message_delta(notification.delta)`；
- `ServerNotification::CommandExecutionOutputDelta(notification)`（第 94 行）调用 `self.on_exec_command_output_delta(&notification.item_id, &notification.delta)`。

`on_agent_message_delta` 定义在 `tui/src/chatwidget/streaming.rs:141`，内部只是把 delta 推给 `handle_streaming_delta`，后者把文本追加到当前「流式尾 cell」并请求重绘。换句话说，core 每吐一小块模型文本，TUI 就把它接成一个可重排的可滚动历史单元——第 3 章里 `ItemCompleted` / `AgentMessageDelta` 这类增量，在这里被翻译成终端里的逐字输出。

## 小结

TUI 没有魔法：一个巨型 `App` 状态（`tui/src/app.rs:523`），靠 `select!` 把终端事件与 core 事件流合并（`tui/src/app/startup.rs:662`），每条 `ServerNotification` 经过 `ChatWidget::handle_server_notification`（`tui/src/chatwidget/protocol.rs:4`）分派给具体的渲染方法（如 `on_agent_message_delta`，`tui/src/chatwidget/streaming.rs:141`）。理解了「状态即事件的累积、帧即状态的投影」，第 7 章的轮廓和第 3 章的 core API 就在这几行 `match` 里严丝合缝地接上了。
