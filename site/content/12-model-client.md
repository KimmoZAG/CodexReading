# 第 12 章：模型客户端与流式响应——怎么跟 Responses API 对话

上一章（第 11 章）讲清楚了指令怎么进到沙箱执行，但"模型到底是怎么把字一句句吐出来的"还没拆过。这一章聚焦 `codex-core` 里负责跟模型服务对话的客户端，以及它如何把 HTTP 流式响应转成我们内部能消费的 item。建议和第 3 章（core 公共 API）、第 4 章（`run_turn` 主循环）对照着读。

## 一、用的是哪种接口：响应式 + 流式

Codex 走的是 OpenAI 的 **Responses API**，并且默认开启 **SSE 流式**（`stream: true`，见 `core/src/client.rs:933`）。也就是说，一次"turn"不是等模型整段生成完再返回，而是服务端通过 HTTP 长连接按事件一块块地把 `ResponseEvent` 推过来。更低一层的 `codex-client` 把字节流转成 UTF-8 的 SSE `data:` 帧：`codex-client/src/sse.rs:12` 的 `sse_stream` 用 `eventsource()` 把 `ByteStream` 逐帧解析，并通过 `mpsc` 把每帧文本或 `StreamError` 发出来（`sse.rs:23` 的 `timeout(idle_timeout, …)` 还顺带做了空闲超时）。`codex-client/src/lib.rs:12` 则把 `CodexHttpClient` 重新导出，作为统一的底层 HTTP 封装。

客户端入口在 `core/src/client.rs`。`ModelClientSession::stream`（`client.rs:1861`）是"turn 作用域"的流式入口：它先看 wire_api，若 provider 支持且 WebSocket 健康就走 `stream_responses_websocket`，否则回退到 `stream_responses_api`（`client.rs:1899`）。注意它有明确的降级路径——WS 失败会 `try_switch_fallback_transport` 强制切到 HTTP（`client.rs:1894`）。

真正的 HTTP 流式请求在 `stream_responses_api`（`client.rs:1440`）：它构造 transport、组装 request，再调用 `ApiResponsesClient::stream_request`（`client.rs:1513`），拿到 `codex_api::ResponseStream` 后包一层 `map_response_stream` 返回。

## 二、chunk 怎么变成内部的 item

关键点：`client` 这一层**不直接生成** `AssistantMessage` / `Reasoning` / `FunctionCall` 这些 world_state 里的 item。它先把原始流的 `ResponseEvent` 原样搬运、重发，由上层 `run_turn` 去消费并落进 world_state。

`map_response_stream`（`client.rs:1986`）只是个转发壳，真正干活的是 `map_response_events`（`client.rs:2009`）。它 `tokio::spawn` 一个任务，在 `loop` 里 `api_stream.next()` 逐条取事件（`client.rs:2048`），然后分三类转发给 `mpsc` 通道：

- `ResponseEvent::OutputItemDone(item)`：一个完整 item 落地，压入 `items_added` 并转发（`client.rs:2054`）；
- `ResponseEvent::Completed { token_usage, end_turn }`：整轮结束，顺手把汇总的 `LastResponse` 经 `oneshot` 回传（`client.rs:2069`、`client.rs:2084`）；
- 其余事件（如各类 `*Delta`）原样转发（`client.rs:2102`）。

出错时则调用 `provider.map_api_error` 把底层错误归一化后再发（`client.rs:2117`、`client.rs:2125`）。这样上层拿到的永远是统一的 `ResponseEvent` 流，不关心底层是 HTTP 还是 WS。

到 `run_turn`（`session/turn.rs:153`）这一层，才把事件翻译成 world_state 内容：`ResponseEvent::OutputItemDone(mut item)` 在 `turn.rs:2295` 被消费，配合 `AssistantMessageStreamParsers`（`turn.rs:1615`）把 Reasoning/文本增量（`ReasoningContentDelta` 等）逐块拼装，最终经 `event_mapping.rs` 映射成 `TurnItem::Reasoning` 等内部 item。这就是第 4 章说的"主循环消费这些 item"。

## 三、流式是怎么逐块回调 / emit 的

整条链路是 **channel + spawn** 的异步流水线：底层 `sse_stream` 把字节帧塞进 channel → `ApiResponsesClient` 把 SSE 文本反序列化成 `ResponseEvent` → `map_response_events` 再转发到自己的 `tx_event`（`client.rs:2056` 等）→ `run_turn` 在 `while let Some(event) = stream.next()` 里逐个 `emit` 成 UI / 协议事件（如 `turn.rs:2653` 的 `ReasoningContentDeltaEvent`）。每一块 delta 都是"收到即 emit"，所以界面上文字是边生成边刷新的。

## 四、失败重试与限流在哪处理

两层各自负责：

- **客户端层**：`stream_responses_api` 里对 `ApiError::Transport` 的可恢复鉴权错误会触发 `auth_recovery` 重试（`client.rs:1525`），WS→HTTP 的 fallback 也在这里兜底。
- **底层 HTTP 层**：`codex-client/src/retry.rs` 提供了通用重试。`RetryOn::should_retry`（`retry.rs:22`）明确对 **429 限流**、**5xx**、以及传输错误（`Timeout`/`Connection`/`Network`）决定是否重试；`run_with_retry`（`retry.rs:80`）按 `max_attempts` 循环，配合 `backoff`（`retry.rs:39`）做指数退避 + 抖动。注意 `run_with_retry` 的消费方是更下层的 HTTP 请求，而流式采样本身的"重试"语义更多体现在 `RetryOperation::Sampling` 与 WS→HTTP 降级上。

## 小结

模型客户端是一条"流式搬运 + 分层转换"的管道：底层 `sse_stream` 解析 SSE 字节帧，中间 `stream_responses_api`/`stream` 负责选择 HTTP/WS 并做鉴权恢复与降级，`map_response_events` 把 `ResponseEvent` 原样转发成统一流，最后由 `run_turn` 配合 `AssistantMessageStreamParsers` 把事件落成 `AssistantMessage`/`Reasoning`/`FunctionCall` 这些 world_state item。重试与限流则由 `codex-client` 的 `RetryOn`/`run_with_retry` 在 HTTP 层兜底，WS 失败时再由客户端层切回 HTTP。理解了这条链路，再看第 3、4 章里 `run_turn` 如何消费 item，就完整串起来了。
