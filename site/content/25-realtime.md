# 第 25 章：Realtime——用语音/流式对话替代打字

## Realtime 是什么

前 24 章里我们看到的模型交互，本质是「请求—响应」：你在第 12 章见到的 `ModelClientSession::stream` 走的是 HTTP，把一整段 prompt 发出去，再逐 token 把答案读回来（`content/12-model-client.md`）。Realtime 完全换了一条通道——它是基于 WebSocket（或 WebRTC 媒体面 + sideband WebSocket 控制面）的**低延迟双向音频/流式通道**：麦克风采集的音频帧直接帧帧往服务端推，模型可以边听边想边说，回出来的也直接是音频与文本，而不是等一轮对话结束才返回。

客户端的连接入口在 `ModelClient` 上：`create_realtime_call_with_headers` 先通过 HTTP 在 `/realtime/calls` 端点建一个媒体 call，再保留鉴权让实时 WebSocket 以 sideband 身份挂进同一个 call（`reference/codex/codex-rs/core/src/client.rs:659`，常量 `REALTIME_CALLS_ENDPOINT = "/realtime/calls"` 见 `client.rs:161`；返回的 `RealtimeWebrtcCallStart` 结构体见 `client.rs:405`）。随后 sideband 任务调用 `client.connect_webrtc_sideband(...)` 真正建立那条双向通道（`reference/codex/codex-rs/core/src/realtime_conversation/sideband.rs:53`）。

## 音频怎么进模型、怎么转成 turn

会话侧的状态中枢是 `RealtimeConversationManager`（`reference/codex/codex-rs/core/src/realtime_conversation.rs:126`），由 `start_realtime_conversation` 调用 `sess.conversation.start(start, mode_instructions)` 拉起（`realtime_conversation.rs:1480`）。

音频的采集与上行都在 `run_realtime_input_task` 里完成。它用 `tokio::select!` 同时监听三路输入：服务端下发的事件（`events.next_event()`）、文本输入（`text_rx`）、以及麦克风音频帧（`audio_rx`）。用户音频帧到达后调用 `handle_user_audio_input(user_audio_frame, &writer)` 直接写进 WebSocket 写端（`realtime_conversation.rs:1770`，音频分支见 `realtime_conversation.rs:1866`）。模型回出来的音频在 fanout 任务里被逐步通过 `EventMsg::RealtimeConversationRealtime(RealtimeConversationRealtimeEvent { payload })` 广播给前端（`realtime_conversation.rs:1542`）。

## 它和第 3 章 submit/next_event 模型怎么接上

关键问题：Realtime 用的是不是第 3 章那套 `EventMsg`？**是同一套事件总线，但有专属的变体。** `RealtimeConversationStarted / Sdp / Realtime / Closed / ListVoicesResponse` 都是 `EventMsg` 的变体，它们经由 `sess.send_event_raw(...)` 进入和第 3 章 `submit`/`next_event`（`reference/codex/codex-rs/core/src/session/mod.rs:801`、`mod.rs:898`）完全相同的事件通道，在主循环的 `next_event` 里被当作透传事件处理（`session/turn.rs:1777` 一路罗列这些变体）。

更深的一层接驳在「handoff」：当模型在实时对话中请求把某段文本交给 Codex 去真正执行（而不是只靠语音回答），实时层会把它路由回会话的正常 turn 循环——`route_realtime_text_input` 用 `TurnInputMode::StartOrSteer` 把文本当作一次普通用户输入提交（`reference/codex/codex-rs/core/src/session/turn_input.rs:423`）。换句话说，音频通道是「平行的传输方式」，但它产出的指令最终仍汇入第 3、4 章的 `submit → run_turn` 主循环。

## 小结

Realtime 不是另一套 submit/next_event 引擎，而是架在第 3 章事件总线之上的「低延迟音视频传输面」：前端语音经 `audio_rx` + `handle_user_audio_input` 帧帧入 WebSocket（`realtime_conversation.rs:1866`），模型音频/文本经 `RealtimeConversationRealtime` 事件回传（`realtime_conversation.rs:1542`），而任何需要真正「动手」的请求又回落到 `route_realtime_text_input → submit` 这条老路（`turn_input.rs:423`）。读这一章时，把它想成「第 12 章 HTTP 流式能力的双向实时版」最贴切。
