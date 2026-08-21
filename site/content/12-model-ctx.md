# 第 12 章：模型与上下文——怎么跟模型对话、怎么不爆 token、怎么重演

这章把"模型吐字"这个黑盒拆开：客户端怎么把 HTTP 流变成内部 item、会话太长时怎么压缩、一次会话怎么被存下来重演。

## 12.1 模型客户端：流式响应怎么变成内部 item

Codex 走的是 OpenAI 的 **Responses API**，并且默认开启 **SSE 流式**（`stream: true`，见 `core/src/client.rs:933`）。一次"turn"不是等模型整段生成完再返回，而是服务端通过 HTTP 长连接按事件一块块地把 `ResponseEvent` 推过来。更底层 `codex-client` 把字节流转成 UTF-8 的 SSE `data:` 帧：`codex-client/src/sse.rs:12` 的 `sse_stream` 用 `eventsource()` 把 `ByteStream` 逐帧解析，并通过 `mpsc` 把每帧文本或 `StreamError` 发出来（`sse.rs:23` 的 `timeout(idle_timeout, …)` 还顺带做了空闲超时）。`codex-client/src/lib.rs:12` 则把 `CodexHttpClient` 重新导出，作为统一的底层 HTTP 封装。

客户端入口在 `core/src/client.rs`。`ModelClientSession::stream`（`client.rs:1861`）是"turn 作用域"的流式入口：它先看 wire_api，若 provider 支持且 WebSocket 健康就走 `stream_responses_websocket`，否则回退到 `stream_responses_api`（`client.rs:1899`）。它有明确的降级路径——WS 失败会 `try_switch_fallback_transport` 强制切到 HTTP（`client.rs:1894`）。

真正的 HTTP 流式请求在 `stream_responses_api`（`client.rs:1440`）：它构造 transport、组装 request，再调用 `ApiResponsesClient::stream_request`（`client.rs:1513`），拿到 `codex_api::ResponseStream` 后包一层 `map_response_stream` 返回。

关键点：`client` 这一层**不直接生成** `AssistantMessage` / `Reasoning` / `FunctionCall` 这些 world_state 里的 item。它先把原始流的 `ResponseEvent` 原样搬运、重发，由上层 `run_turn` 去消费并落进 world_state。

`map_response_stream`（`client.rs:1986`）只是个转发壳，真正干活的是 `map_response_events`（`client.rs:2009`）。它 `tokio::spawn` 一个任务，在 `loop` 里 `api_stream.next()` 逐条取事件（`client.rs:2048`），然后分三类转发给 `mpsc` 通道：

- `ResponseEvent::OutputItemDone(item)`：一个完整 item 落地，压入 `items_added` 并转发（`client.rs:2054`）；
- `ResponseEvent::Completed { token_usage, end_turn }`：整轮结束，顺手把汇总的 `LastResponse` 经 `oneshot` 回传（`client.rs:2069`、`client.rs:2084`）；
- 其余事件（如各类 `*Delta`）原样转发（`client.rs:2102`）。

出错时则调用 `provider.map_api_error` 把底层错误归一化后再发（`client.rs:2117`、`client.rs:2125`）。这样上层拿到的永远是统一的 `ResponseEvent` 流，不关心底层是 HTTP 还是 WS。

到 `run_turn`（`core/src/session/turn.rs:153`）这一层，才把事件翻译成 world_state 内容：`ResponseEvent::OutputItemDone(mut item)` 在 `turn.rs:2295` 被消费，配合 `AssistantMessageStreamParsers`（`turn.rs:1615`）把 Reasoning/文本增量逐块拼装，最终经 `event_mapping.rs` 映射成 `TurnItem::Reasoning` 等内部 item。这就是第 4 章说的"主循环消费这些 item"。

整条链路是 **channel + spawn** 的异步流水线：底层 `sse_stream` 把字节帧塞进 channel → `ApiResponsesClient` 把 SSE 文本反序列化成 `ResponseEvent` → `map_response_events` 再转发到自己的 `tx_event`（`client.rs:2056`）→ `run_turn` 在 `while let Some(event) = stream.next()` 里逐个 `emit` 成 UI / 协议事件（如 `turn.rs:2653` 的 `ReasoningContentDeltaEvent`）。每一块 delta 都是"收到即 emit"，所以界面上文字是边生成边刷新的。

![](assets/diagrams/dataflow.svg)

图：模型响应回流链路（dataflow）——从 SSE 帧到内部 item。

失败重试与限流分两层各自负责：

- **客户端层**：`stream_responses_api` 里对 `ApiError::Transport` 的可恢复鉴权错误会触发 `auth_recovery` 重试（`client.rs:1525`），WS→HTTP 的 fallback 也在这里兜底。
- **底层 HTTP 层**：`codex-client/src/retry.rs` 提供了通用重试。`RetryOn::should_retry`（`retry.rs:22`）明确对 **429 限流**、**5xx**、以及传输错误（`Timeout`/`Connection`/`Network`）决定是否重试；`run_with_retry`（`retry.rs:80`）按 `max_attempts` 循环，配合 `backoff`（`retry.rs:39`）做指数退避 + 抖动。

## 12.2 上下文压缩：长会话怎么不爆 token

第 4 章里 `run_turn` 是怎么"想一步、做一步"的。它每一次采样都把整段对话历史塞进 prompt；但历史不是无限的——模型有上下文窗口，token 越多越贵，也越容易把前面的指令稀释掉。

压缩不在回合结束后，而在 `run_turn` 进主循环**之前**。第 4 章讲过，`run_turn` 开头先 drain 上一轮的 hook 结果，紧接着就调用 `run_pre_sampling_compact`（`core/src/session/turn.rs:169`）：

```rust
// core/src/session/turn.rs:169
if let Err(err) = run_pre_sampling_compact(
    &sess, &turn_context, &mut client_session, &cancellation_token,
).await { ... }
```

它的定义在 `core/src/session/turn.rs:1012`。它先检查 `context_window_token_status`，只有 `token_limit_reached` 为真才真正触发——压缩因此是"按需"的，短会话不会被无谓打扰。

`run_pre_sampling_compact` 最终落到 `run_inline_auto_compact_task`（`compact.rs:111`），再进入核心实现 `run_compact_task_inner_impl`（`compact.rs:240`）。本质策略是**摘要旧消息 + 丢弃过期内容**：

1. 把整段 history 作为"待总结材料"喂给模型，让它生成一段摘要（`SUMMARIZATION_PROMPT`）；
2. 摘要与挑选出的用户消息一起，经 `build_compacted_history`（`compact.rs:639`）重建出一段更短的历史，"摘要 item" 作为最后一项追加；
3. 旧 history 被 `replace_compacted_history` 整体替换，并推进一个 `auto_compact_window` 计数。

策略不是简单"全删"：用户消息按 token 预算从新到旧挑选（`build_compacted_history_with_limit`，`compact.rs:652`，上限 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`），预算装不下的再截断。若压缩过程中又 `ContextWindowExceeded`，会从头部继续 `remove_first_item` 重试（`compact.rs:315`），优先保住近期消息。

压缩本身也是一个会失败的异步任务。`run_compact_task_inner`（`compact.rs:169`）里：若 pre-compact hook 返回 `Stopped`，或 post-compact hook 中止，都直接 `return Err(CodexErr::TurnAborted)`（`compact.rs:193`、`:226`）。这个 `TurnAborted` 正是第 4 章讲过的终态之一——它会一路冒泡回 `run_turn:177`，让整个 turn 以 `TurnAborted` 收尾，而不是带着损坏的历史继续采样。

压缩是 `run_turn` 进循环前的"瘦身"步骤，保证后续循环始终跑在预算之内。

## 12.3 Rollout 与回放：一次会话怎么被存下来重演

Codex 的每一次交互就是一条"事件流"：模型吐出的 token、工具调用、用户消息、回合边界。把这条流落盘，至少有三类用途。其一是**评测**——离线重放一段对话能精确复现模型当时的上下文，做回归或基准对比；其二是**调试**——线上出问题后，开发者可以 `jq -C . ~/.codex/sessions/rollout-*.jsonl` 直接围观原始事件（`rollout/src/recorder.rs:82`）；其三是**回放**——把存下的事件按顺序喂回去，就能在 TUI 里原样还原出当时的界面。

核心数据结构是 `RolloutItem` 枚举（`history/src/lib.rs:95`），它涵盖会话元信息、响应项、压缩片段、世界状态，以及最重要的 `EventMsg(EventMsg)` 变体。这里的 `EventMsg` 正是第 3 章讲过的那个协议事件类型（`protocol/src/protocol.rs:1288`）——`UserMessage`、`AgentMessage`、`TurnStarted`、`TurnComplete` 等都装在这一个枚举里。所以一次 rollout 文件就是按时间线排布的 `RolloutItem` 序列，而其中绝大多数"动作"都以 `EventMsg` 形态存在。

写入由 `RolloutRecorder` 负责（`rollout/src/recorder.rs:85`），它本身只是个句柄，真正的写入跑在一个独立的后台 task 上，通过 channel 接收 `AddItems(Vec<RolloutItem>)` 等命令。业务侧调用 `record_canonical_items`（`rollout/src/recorder.rs:953`）把当前回合产生的规范化 `RolloutItem` 投进管道；后台 task 在 `write_pending_items_once`（`rollout/src/recorder.rs:1788`）里逐个取出，给每条打上递增的 ordinal，再序列化为一行 JSON 追加到 `.jsonl` 文件——落盘的那一行就是 `self.file.write_all(json.as_bytes())`（`rollout/src/recorder.rs:1971`）。用 JSONL 而非单条大 JSON，是为了让写入可增量追加、损坏也只丢最后一行。

> 注：仓库里会话事件流本体存的是 JSONL，而线程元数据/索引由 `state_db` 模块落在 SQLite 上——`state_db::init`（`rollout/src/state_db.rs:45`）在进程启动时打开这个 `StateRuntime`，用于会话列表、搜索等。二者互补：JSONL 是"事件真相"，SQLite 是"检索目录"。

回放分两步。先 `load_rollout_items`（`rollout/src/recorder.rs:1009`），它打开 JSONL 逐行 `decode_rollout_line`、反序列化成 `Vec<RolloutItem>`。然后 `Session::reconstruct_history_from_rollout`（`core/src/session/rollout_reconstruction.rs:114`）对这些 item 做"逆序重放"：从最新回合往回扫描 `EventMsg::TurnComplete`（`:193`）、`TurnStarted`（`:252`）、`UserMessage`（`:216`）等，重建出断点续跑所需的 `WorldState` 与历史基线。回放产出的 history 再交给主循环，于是第 7 章说的"TUI 是 `EventMsg` 的视图"在此闭环——界面不是被另存，而是从同一份 `EventMsg` 流里重新渲染出来的。

## 12.4 小结

模型与上下文这三条线，都汇到同一个 `EventMsg` 上：客户端把它从 SSE 流里翻译出来（12.1），压缩保证它始终跑在预算内（12.2），rollout 把它原样存下、又能重放（12.3）。

下一章看工程化：测试、构建、安装、鉴权、错误处理。
