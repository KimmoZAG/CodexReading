# 第 28 章：异步运行时——tokio 怎么撑起整套并发

## 为什么必须是 tokio

Codex 是一个 I/O 密集而非计算密集的程序：一次 turn 里，模型的 SSE 流要持续解析、exec-server 的 RPC 要等子进程回话、MCP 服务器在另一条连接上待命、TUI 还得随时响应键盘和重绘。这些任务的共同点是「大部分时间在等」，用线程池阻塞式地一对一伺候会浪费大量栈内存与上下文切换。于是整个工作区统一钉在 tokio 上：根 `Cargo.toml` 声明 `tokio = "1"`（`reference/codex/codex-rs/Cargo.toml:458`），core 再按需开启 feature——`io-std`、`macros`、`process`、`rt-multi-thread`、`signal`（`reference/codex/codex-rs/core/Cargo.toml:112`）。`process` 用于沙箱里拉起子进程，`signal` 用于捕获 Ctrl-C，`rt-multi-thread` 则决定了下面要讲的调度器形态。配套还引入了 `tokio-util`，只启用 `rt` feature（`reference/codex/codex-rs/core/Cargo.toml:119`），它提供的 `CancellationToken` 是全仓中断机制的基石。

## 并发原语之一：channel 把 Op 与 Event 串起来（呼应第 3 章）

第 3 章讲过公共 API 只有 `submit` 与 `next_event` 两个口子，它们的异步本质就在这里。`CodexThread::submit`（`reference/codex/codex-rs/core/src/codex_thread.rs:190`）与 `CodexThread::next_event`（`reference/codex/codex-rs/core/src/codex_thread.rs:463`）都只是转交给内部的 `SessionIo`。真正的双向管道定义在 `pub(crate) struct SessionIo`（`reference/codex/codex-rs/core/src/session/mod.rs:367`）：一个 `tx_sub: Sender<Submission>` 负责把请求灌进会话循环，一个 `rx_event: Receiver<Event>` 负责把事件端出来。值得注意的是，提交侧用的并不是 `tokio::sync::mpsc`，而是 `async-channel`（`reference/codex/codex-rs/core/Cargo.toml:21`）的有界队列，容量常量 `SUBMISSION_CHANNEL_CAPACITY: usize = 512`（`reference/codex/codex-rs/core/src/session/mod.rs:460`）——选它是因为其 `Sender`/`Receiver` 两端都可克隆，方便像 `codex_delegate.rs:74` 那样为子 agent 再架一对桥接队列。有界还带来天然的背压：`submit_with_id` 里 `self.tx_sub.send(sub).await` 会在队列满时挂起而不是无限堆积，若对端已死则映射为 `CodexErr::InternalAgentDied`（`reference/codex/codex-rs/core/src/session/mod.rs:832`）。模型流式那侧才用 tokio 原生 mpsc：`mpsc::channel::<Result<ResponseEvent>>(RESPONSE_STREAM_CHANNEL_CAPACITY)`（`reference/codex/codex-rs/core/src/client.rs:2023`，容量 1600 见 `client.rs:1983`），由一个 `tokio::spawn` 的映射任务（`client.rs:2028`）把原始 SSE 翻译成 `ResponseEvent` 喂给 `pub struct ResponseStream`（`reference/codex/codex-rs/core/src/client_common.rs:105`）。

## 并发原语之二：CancellationToken 实现中断（呼应第 4 章）

第 4 章的 `run_turn` 末位参数就是 `cancellation_token: CancellationToken`（`reference/codex/codex-rs/core/src/session/turn.rs:158`）。中断不靠 kill 线程，而靠协作式取消：仓库自定义了扩展 trait `OrCancelExt`，其 `or_cancel` 内部是一个 `tokio::select!`，在 `token.cancelled()` 与业务 future 之间赛跑，前者胜出即返回 `Err(CancelErr::Cancelled)`（`reference/codex/codex-rs/async-utils/src/lib.rs:26`）。于是主循环里每个可能长耗时的 await 只要挂上 `.or_cancel(&cancellation_token)`（如 `turn.rs:195`）就获得了可中断能力，最终收敛成第 27 章的 `TurnAborted` 终态。token 还能派生子 token 做级联取消，`cancel_token.child_token()`（`reference/codex/codex-rs/core/src/codex_delegate.rs:146`）让父会话一取消，两个转发任务 `tokio::spawn`（`codex_delegate.rs:158`）随之退出。

## 一个多线程 runtime 是怎么配出来的

runtime 并非由 `#[tokio::main]` 宏隐式创建，而是在 arg0 层手工构建：`fn build_runtime()` 里 `Builder::new_multi_thread()` 配合 `enable_all()`，并显式设置 `thread_stack_size(TOKIO_WORKER_STACK_SIZE_BYTES)`（`reference/codex/codex-rs/arg0/src/lib.rs:291`），该常量为 `16 * 1024 * 1024`，即 16 MB（`reference/codex/codex-rs/arg0/src/lib.rs:25`）。之所以要把栈开这么大，是因为深层嵌套的 async 状态机与递归式的 JSON/协议解析容易撑爆默认 2 MB 栈。更细的一笔是：入口没有直接 `block_on`，而是先 `std::thread::Builder::new().name("codex-main").stack_size(...)` 起一条同等栈预算的线程（`reference/codex/codex-rs/arg0/src/lib.rs:233`），再在其中 `runtime.block_on(...)`（`reference/codex/codex-rs/arg0/src/lib.rs:238`）——注释明确指出 `Runtime::block_on` 会把顶层 future 跑在调用者的 OS 栈上，不这么做主 future 就享受不到 16 MB 待遇。

## 小结

tokio 在 Codex 里承担三件事：多线程 runtime 提供调度底座（`arg0/src/lib.rs:291`），channel 把第 3 章的 `Op`/`Event` 解耦成带背压的队列（`session/mod.rs:367`），`CancellationToken` 配合 `tokio::select!` 让第 4 章的每一步 await 都可被打断（`async-utils/src/lib.rs:26`）。理解这三者，就理解了为什么 Codex 能一边刷模型流、一边跑工具、一边响应你的 Esc。
