# 第 18 章：Rollout 与回放——一次会话怎么被存下来重演

## 为什么要持久化一次会话

Codex 的每一次交互本质上是「事件流」：模型吐出的 token、工具调用、用户消息、回合边界。把这条流落盘，至少有三类用途。其一是**评测**——离线重放一段对话能精确复现模型当时的上下文，做回归或基准对比；其二是**调试**——线上出问题后，开发者可以 `jq -C . ~/.codex/sessions/rollout-*.jsonl` 直接围观原始事件（`rollout/src/recorder.rs:82`）；其三是**回放**——把存下的事件按顺序喂回去，就能在 TUI 里原样还原出当时的界面。持久化不是日志装饰，而是 Codex 把「运行态」变成「可读可重演的数据」的关键一跃。

## Rollout 存的是什么

核心数据结构是 `RolloutItem` 枚举（`history/src/lib.rs:95`），它涵盖会话元信息、响应项、压缩片段、世界状态，以及最重要的 `EventMsg(EventMsg)` 变体。这里的 `EventMsg` 正是第 3 章讲过的那个协议事件类型（`protocol/src/protocol.rs:1288`）——`UserMessage`、`AgentMessage`、`TurnStarted`、`TurnComplete` 等都装在这一个枚举里。换句话说，一次 rollout 文件就是按时间线排布的 `RolloutItem` 序列，而其中绝大多数「动作」都以 `EventMsg` 形态存在。理解这一点，第 3 章的 `EventMsg` 与本章的落盘格式就接上了。

## 怎么写：JSONL 加一个后台写线程

写入由 `RolloutRecorder` 负责（`rollout/src/recorder.rs:85`），它本身只是个句柄，真正的写入跑在一个独立的后台 task 上，通过 channel 接收 `AddItems(Vec<RolloutItem>)` 等命令。业务侧调用 `record_canonical_items`（`rollout/src/recorder.rs:953`）把当前回合产生的规范化 `RolloutItem` 投进管道；后台 task 在 `write_pending_items_once`（`rollout/src/recorder.rs:1788`）里逐个取出，给每条打上递增的 ordinal，再序列化为一行 JSON 追加到 `.jsonl` 文件——落盘的那一行就是 `self.file.write_all(json.as_bytes())`（`rollout/src/recorder.rs:1971`）。用 JSONL 而非单条大 JSON，是为了让写入可增量追加、损坏也只丢最后一行。

> 注：任务提示里提到的「SQLite」实际是另一层——线程元数据/索引由 `state_db` 模块落在 SQLite 上，`state_db::init`（`rollout/src/state_db.rs:45`）在进程启动时打开这个 `StateRuntime`，用于会话列表、搜索等；而会话事件流本体存的是 JSONL。二者互补：JSONL 是「事件真相」，SQLite 是「检索目录」。

## 怎么回放：把事件重放一遍还原界面

回放分两步。先 `load_rollout_items`（`rollout/src/recorder.rs:1009`），它打开 JSONL 逐行 `decode_rollout_line`、反序列化成 `Vec<RolloutItem>`。然后 `Session::reconstruct_history_from_rollout`（`core/src/session/rollout_reconstruction.rs:114`）对这些 item 做「逆序重放」：从最新回合往回扫描 `EventMsg::TurnComplete`（`:193`）、`TurnStarted`（`:252`）、`UserMessage`（`:216`）等，重建出断点续跑所需的 `WorldState` 与历史基线。回放产出的 history 再交给主循环，于是第 7 章说的「TUI 是 `EventMsg` 的视图」在此闭环——界面不是被另存，而是从同一份 `EventMsg` 流里重新渲染出来的。

## 小结

一次会话 = 一串 `RolloutItem`，主体是 `EventMsg`（`history/src/lib.rs:95` 与 `protocol/src/protocol.rs:1288`）。写入由 `RolloutRecorder` 后台线程以 JSONL 增量追加（`:1971`），元数据进 SQLite（`state_db.rs:45`）；回放则先 `load_rollout_items`（`:1009`）读回，再 `reconstruct_history_from_rollout`（`:114`）重演。评测、调试、续跑、界面还原，全部建立在这同一条可重演的事件流之上——这也是第 3 章与第 7 章在存储层的最终汇合点。
