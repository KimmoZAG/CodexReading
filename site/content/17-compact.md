# 第 17 章：上下文压缩——长会话怎么不爆 token

第 4 章里我们看了 `run_turn` 是怎么"想一步、做一步"的。它每一次采样都把整段对话历史塞进 prompt；但历史不是无限的——模型有上下文窗口，token 越多越贵，也越容易把前面的指令稀释掉。这一章看 Codex 怎么在会话变长时把历史"压"小。

## 17.1 为什么要压缩

Codex 的对话历史是累积的：每一轮的用户输入、模型回复、工具调用结果都留在 `Session` 的 history 里。当历史接近模型上下文窗口上限，继续塞会触发 `ContextWindowExceeded`，请求直接失败；即便没到上限，超长的历史也会让每次采样都更贵、更慢。压缩（compaction）的目的，就是在进采样之前把"旧的、不再需要逐字保留"的内容换成一段更短的摘要，让上下文重新回到预算内。

## 17.2 压缩时机：每次采样前

压缩不在回合结束后，而在 `run_turn` 进主循环*之前*。第 4 章讲过，`run_turn` 开头先 drain 上一轮的 hook 结果，紧接着就调用 `run_pre_sampling_compact`（`core/src/session/turn.rs:169`）：

```rust
// core/src/session/turn.rs:169
if let Err(err) = run_pre_sampling_compact(
    &sess, &turn_context, &mut client_session, &cancellation_token,
).await { ... }
```

它的定义在 `core/src/session/turn.rs:1012`。它先检查 `context_window_token_status`，只有 `token_limit_reached` 为真才真正触发——也就是说压缩是"按需"的，短会话不会被无谓打扰。这正好呼应第 4 章里 `run_turn` 进循环前的准备工作：压缩是采样真正开始前的最后一道闸门。

## 17.3 压缩策略有哪些

`run_pre_sampling_compact` 最终落到 `run_inline_auto_compact_task`（`compact.rs:111`），再进入核心实现 `run_compact_task_inner_impl`（`compact.rs:240`）。本质策略是**摘要旧消息 + 丢弃过期内容**：

1. 把整段 history 作为"待总结材料"喂给模型，让它生成一段摘要（`SUMMARIZATION_PROMPT`）；
2. 摘要与挑选出的用户消息一起，经 `build_compacted_history`（`compact.rs:639`）重建出一段更短的历史，"摘要 item" 作为最后一项追加；
3. 旧 history 被 `replace_compacted_history` 整体替换，并推进一个 `auto_compact_window` 计数。

注意策略不是简单"全删"：用户消息按 token 预算从新到旧挑选（`build_compacted_history_with_limit`，`compact.rs:652`，上限 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`），预算装不下的再截断。若压缩过程中又 `ContextWindowExceeded`，会从头部继续 `remove_first_item` 重试（`compact.rs:315`），优先保住近期消息。

## 17.4 压缩失败怎么办

压缩本身也是一个会失败的异步任务。`run_compact_task_inner`（`compact.rs:169`）里：若 pre-compact hook 返回 `Stopped`，或 post-compact hook 中止，都直接 `return Err(CodexErr::TurnAborted)`（`compact.rs:193`、`:226`）。这个 `TurnAborted` 正是第 4 章讲过的终态之一——它会一路冒泡回 `run_turn:177`，让整个 turn 以 `TurnAborted` 收尾，而不是带着损坏的历史继续采样。其它错误（如 `SessionBudgetExceeded`）也同样以 `Err` 返回，被调用方记入 turn 错误生命周期。

## 17.5 小结

- 压缩解决"历史太长爆 token / 变贵"的问题；
- 时机在每次采样前，由 `run_pre_sampling_compact`（`turn.rs:169` / `:1012`）按需触发；
- 策略是"摘要旧消息 + 预算内挑选用户消息 + 丢弃"，核心在 `run_compact_task_inner_impl`（`compact.rs:240`）与 `build_compacted_history`（`compact.rs:639`）；
- 失败时以 `TurnAborted` 等终态终止 turn，呼应第 4 章 `run_turn` 的终态处理。

一句话：压缩就是 `run_turn` 进循环前的"瘦身"步骤——它保证后面那套"想一步、做一步"的循环始终跑在预算之内。
