# 第 10 章：执行与运行时——命令在哪跑、靠什么并发

命令在哪台机器执行、用什么进程模型跑、并发靠什么撑、语音通道怎么接进来——这四件事都服从同一条原则：**把"在哪里、怎么跑"从核心逻辑里抽出去**。

执行链路上的进程分工：

![](assets/diagrams/processes.svg)

CLI、App-Server（内嵌 Core）、Exec-Server 是三个独立进程，命令的落地被收口在带信任边界的 Exec-Server 里。

## 10.1 exec-server：命令真正落地的那个进程

core 负责跟模型对话、跑工具循环，真正把命令落到操作系统上则要跨一条进程边界——**exec-server**（`codex_exec_server` crate）。

拆出来是为了信任边界：模型生成的 shell 指令是不可信输入，文件系统访问、网络出口、进程信号都得统一收口。让 core 在进程内直接 `std::process::Command` 也能跑，但沙箱策略、能力发现、远程执行环境这些逻辑就会和数据面耦合。放进一个独立的 executor 进程、core 只通过协议与它通信，"执行"才能做成可替换、可审计、可远程化的组件——本地跑在 `DEFAULT_LISTEN_URL`（`exec-server/src/lib.rs:208`），远程则连到托管环境。

进程入口非常薄，只是把监听地址、运行时路径、HTTP client 工厂接起来：

```rust
// exec-server/src/server.rs:21
pub async fn run_main(
    listen_url: &str,
    runtime_paths: ExecServerRuntimePaths,
    http_client_factory: HttpClientFactory,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
```

真正的逻辑在 `run_main_with_telemetry`（`exec-server/src/server.rs:41`），它在 `RequestDispatchMode::Inline` 下调用 `transport::run_transport` 启动 JSON-RPC 服务。对外的执行契约由 `codex_exec_server_protocol` 定义：`ExecParams` 描述一次执行请求，执行过程中的增量输出用 `ExecOutputDeltaNotification` 回传。

core 侧真正发起命令的入口是 `process_exec_tool_call`（`core/src/exec.rs:291`）。它先做两件事：用 `build_exec_request` 把 `ExecParams` 翻译成具体的 argv/env，再统一路由到 `crate::sandboxing::execute_env`：

```rust
// core/src/exec.rs:291
pub async fn process_exec_tool_call(
    params: ExecParams,
    permission_profile: &PermissionProfile,
    sandbox_cwd: &AbsolutePathBuf,
    ...
) -> Result<ExecToolCallOutput> {
    let exec_req = build_exec_request(...)?;
    crate::sandboxing::execute_env(exec_req, stdout_stream).await
}
```

`build_exec_request`（`core/src/exec.rs:315`）先把命令拆成 `program`/`args`，再交给 `SandboxManager` 做策略转换；执行前的沙箱选择发生在 `select_process_exec_tool_sandbox_type`（`core/src/exec.rs:342`），它调用 `SandboxManager::new().select_initial(...)` 决定用哪种 `SandboxType`（Linux 下的 landlock/seccomp、macOS 的 sandbox-exec、Windows 的受限令牌）。core 不自己判断"该不该限制"，而是把决策结果塞进 `ExecRequest`，执行层只负责按约定启动。

命令跑起来后，stdout/stderr 由 `read_output`（`core/src/exec.rs:1078`）按块读取。每当攒到一段增量，且本次调用还在增量预算内（`MAX_EXEC_OUTPUT_DELTAS_PER_CALL`，`core/src/exec.rs:1102` 附近），就构造一条事件推回上层：

```rust
// core/src/exec.rs:1102
let msg = EventMsg::ExecCommandOutputDelta(ExecCommandOutputDeltaEvent {
    call_id: stream.call_id.clone(),
    stream: if is_stderr { ExecOutputStream::Stderr } else { ExecOutputStream::Stdout },
    chunk,
});
```

`ExecCommandOutputDelta` 只是数据流的中间片，完整生命周期由另外两条 `EventMsg` 收口：`ExecCommandBegin`（`protocol/src/protocol.rs:3273`）标记一次调用开始，`ExecCommandEnd`（`protocol/src/protocol.rs:3307`）携带最终 exit_code 与聚合输出。TUI 因此能实时看到输出，而一次执行的"开始—增量—结束"在协议层也完整可重放。

## 10.2 多环境：同一会话怎么跑在不同机器上

shell、apply_patch、read 这些工具如果各自关心命令落在本机还是远端，每个都得写两套分支。Codex 的做法是把"在哪里执行"收敛成一个 **Environment 抽象**，调用方只拿到一个统一句柄——本机进程和远程机器上的进程在接口上没有区别。

`Environment` 本身是个轻量句柄，关键字段是两套 trait 对象（`exec-server/src/environment.rs:658`）：

```rust
pub struct Environment {
    remote_client: Option<LazyRemoteExecServerClient>,
    exec_backend: Arc<dyn ExecBackend>,          // 执行命令
    filesystem: Arc<dyn ExecutorFileSystem>,     // 读写文件
    ...
}
```

执行走 `exec-server/src/process.rs:222` 的 `pub trait ExecBackend: Send + Sync { fn start(&self, params: ExecParams) ... }`；文件系统走 `file-system/src/lib.rs:456` 的 `pub trait ExecutorFileSystem: Send + Sync`。上层只通过这些 trait 拿到 `get_exec_backend()` 与 `get_filesystem()`（`exec-server/src/environment.rs:1052`、`:1060`），完全不知道背后是本地还是远程。

两套实现的切换发生在 `Environment::create_inner`（`exec-server/src/environment.rs:734`）：若传入 `exec_server_url` 就走 `remote_with_transport`，否则走 `local`。

- **Local**：`local()`（`exec-server/src/environment.rs:750`）把后端装成 `LocalProcess`（`exec-server/src/local_process.rs:167`），文件系统装成 `LocalFileSystem`，命令直接在本机 spawn。
- **Remote**：`remote_with_transport`（`exec-server/src/environment.rs:770`）持有一个 `LazyRemoteExecServerClient`，执行后端换成 `RemoteProcess`（`exec-server/src/remote_process.rs:22`），经 WebSocket 把命令发往远端 `exec-server`，文件读写也走 `RemoteFileSystem`。

Local/Remote 的区别被封死在 `exec_backend` / `filesystem` 两个 trait 的实例化里，对外接口完全一致。

一次 turn 具体用哪个环境，由 `TurnEnvironmentSelection` 决定：`protocol/src/protocol.rs:148` 定义它含 `environment_id`、`cwd`、`workspace_roots`、`config`。`core/src/session/turn_context.rs:39` 的 `TurnEnvironment` 把它和具体的 `Arc<Environment>` 绑在一起。选择发生在 `capture_step_context` 阶段：`core/src/session/mod.rs:3159` 在开局调用 `turn_context.environments.refresh_readiness()`（`:3179`），把每个 selection 解析成可用的 `Environment` 句柄，再交给 `run_turn`（`core/src/session/turn.rs:208`）使用。这保证了整轮 turn 看到的机器不变。

## 10.3 异步运行时：tokio 撑起整套并发

Codex 是 I/O 密集而非计算密集的程序：一次 turn 里，模型的 SSE 流要持续解析、exec-server 的 RPC 要等子进程回话、MCP 服务器在另一条连接上待命、TUI 还得随时响应键盘和重绘。这些任务的共同点是"大部分时间在等"，用线程池阻塞式地一对一伺候会浪费大量栈内存与上下文切换。于是整个工作区统一钉在 tokio 上：根 `Cargo.toml` 声明 `tokio = "1"`（`Cargo.toml:458`），core 再按需开启 `io-std`、`macros`、`process`、`rt-multi-thread`、`signal` 等 feature（`core/Cargo.toml:112`）。`process` 用于沙箱里拉起子进程，`signal` 用于捕获 Ctrl-C，`rt-multi-thread` 决定调度器形态。配套还引入了 `tokio-util`，只启用 `rt` feature（`core/Cargo.toml:119`），它提供的 `CancellationToken` 是全仓中断机制的基石。

### channel 把 Op 与 Event 串起来

第 3 章那两个口子 `submit` 与 `next_event`，异步实现就落在这一节。`CodexThread::submit`（`core/src/codex_thread.rs:190`）与 `CodexThread::next_event`（`core/src/codex_thread.rs:463`）都只是转交给内部的 `SessionIo`。真正的双向管道定义在 `pub(crate) struct SessionIo`（`core/src/session/mod.rs:367`）：一个 `tx_sub: Sender<Submission>` 把请求灌进会话循环，一个 `rx_event: Receiver<Event>` 把事件端出来。提交侧用的不是 `tokio::sync::mpsc`，而是 `async-channel`（`core/Cargo.toml:21`）的有界队列，容量常量 `SUBMISSION_CHANNEL_CAPACITY: usize = 512`（`core/src/session/mod.rs:460`）——选它是因为其 `Sender`/`Receiver` 两端都可克隆，方便为子 agent 再架一对桥接队列。有界还带来天然背压：`submit_with_id` 里 `self.tx_sub.send(sub).await` 会在队列满时挂起而不是无限堆积，若对端已死则映射为 `CodexErr::InternalAgentDied`（`core/src/session/mod.rs:832`）。模型流式那侧才用 tokio 原生 mpsc：`mpsc::channel::<Result<ResponseEvent>>(RESPONSE_STREAM_CHANNEL_CAPACITY)`（`core/src/client.rs:2023`，容量 1600 见 `core/src/client.rs:1983`），由一个 `tokio::spawn` 的映射任务（`core/src/client.rs:2028`）把原始 SSE 翻译成 `ResponseEvent` 喂给 `ResponseStream`（`core/src/client_common.rs:105`）。

### CancellationToken 实现中断

第 4 章的 `run_turn` 末位参数就是 `cancellation_token: CancellationToken`（`core/src/session/turn.rs:158`）。中断不靠 kill 线程，而靠协作式取消：仓库自定义了扩展 trait `OrCancelExt`，其 `or_cancel` 内部是一个 `tokio::select!`，在 `token.cancelled()` 与业务 future 之间赛跑，前者胜出即返回 `Err(CancelErr::Cancelled)`（`async-utils/src/lib.rs:26`）。于是主循环里每个可能长耗时的 await 只要挂上 `.or_cancel(&cancellation_token)`（如 `core/src/session/turn.rs:195`）就获得了可中断能力，最终收敛成第 13 章会讲到的 `TurnAborted` 终态。token 还能派生子 token 做级联取消，`cancel_token.child_token()`（`core/src/codex_delegate.rs:146`）让父会话一取消，子 agent 的转发任务随之退出。

### 多线程 runtime 怎么配出来

runtime 并非由 `#[tokio::main]` 宏隐式创建，而是在 arg0 层手工构建：`fn build_runtime()` 里 `Builder::new_multi_thread()` 配合 `enable_all()`，并显式设置 `thread_stack_size(TOKIO_WORKER_STACK_SIZE_BYTES)`（`arg0/src/lib.rs:291`），该常量为 `16 * 1024 * 1024`，即 16 MB（`arg0/src/lib.rs:25`）。之所以把栈开这么大，是因为深层嵌套的 async 状态机与递归式的 JSON/协议解析容易撑爆默认 2 MB 栈。更细的一笔：入口没有直接 `block_on`，而是先 `std::thread::Builder::new().name("codex-main").stack_size(...)` 起一条同等栈预算的线程（`arg0/src/lib.rs:233`），再在其中 `runtime.block_on(...)`（`arg0/src/lib.rs:238`）——注释明确指出 `Runtime::block_on` 会把顶层 future 跑在调用者的 OS 栈上，不这么做主 future 就享受不到 16 MB 待遇。

## 10.4 Realtime：用语音/流式对话替代打字

常规的模型交互是请求—响应：`ModelClientSession::stream` 走 HTTP，把一整段 prompt 发出去，再逐 token 读回答案（第 12 章）。Realtime 换了一条通道——基于 WebSocket（或 WebRTC 媒体面 + sideband WebSocket 控制面）的**低延迟双向音频/流式通道**：麦克风采集的音频帧一帧一帧往服务端推，模型边听边想边说，回出来的也直接是音频与文本。它相当于 HTTP 流式能力的双向实时版。

连接入口在 `ModelClient` 上：`create_realtime_call_with_headers` 先通过 HTTP 在 `/realtime/calls` 端点建一个媒体 call，再保留鉴权让实时 WebSocket 以 sideband 身份挂进同一个 call（`core/src/client.rs:659`，常量 `REALTIME_CALLS_ENDPOINT = "/realtime/calls"` 见 `core/src/client.rs:161`）。随后 sideband 任务调用 `client.connect_webrtc_sideband(...)` 建立那条双向通道（`core/src/realtime_conversation/sideband.rs:53`）。

会话侧的状态中枢是 `RealtimeConversationManager`（`core/src/realtime_conversation.rs:126`），由 `start_realtime_conversation` 调用 `sess.conversation.start(start, mode_instructions)` 拉起（`core/src/realtime_conversation.rs:1480`）。音频的采集与上行都在 `run_realtime_input_task` 里完成，它用 `tokio::select!` 同时监听三路输入：服务端下发的事件、文本输入、以及麦克风音频帧。用户音频帧到达后调用 `handle_user_audio_input` 直接写进 WebSocket 写端（`core/src/realtime_conversation.rs:1770`，音频分支见 `core/src/realtime_conversation.rs:1866`）。模型回出来的音频在 fanout 任务里通过 `EventMsg::RealtimeConversationRealtime(RealtimeConversationRealtimeEvent { payload })` 广播给前端（`core/src/realtime_conversation.rs:1542`）。

Realtime 并没有另起一套事件系统，用的还是第 3 章那条总线，只是多了专属变体。`RealtimeConversationStarted / Sdp / Realtime / Closed / ListVoicesResponse` 都是 `EventMsg` 的变体，经 `sess.send_event_raw(...)` 进入和 `submit`/`next_event`（`core/src/session/mod.rs:801`、`core/src/session/mod.rs:898`）完全相同的事件通道。接驳最深的一处是 "handoff"：模型在实时对话里要求把某段文本交给 Codex 真正执行时，实时层把它路由回正常的 turn 循环——`route_realtime_text_input` 用 `TurnInputMode::StartOrSteer` 把文本当作一次普通用户输入提交（`core/src/session/turn_input.rs:423`）。音频通道只是平行的传输方式，它产出的指令最终仍汇入第 3、4 章的 `submit → run_turn` 主循环。

## 10.5 小结

**核心只产生意图（Op/Event），"在哪跑、怎么跑"全部外置**。exec-server 是命令落地的独立进程；Environment 把本地/远程藏进 `ExecBackend` 与 `ExecutorFileSystem` 两个 trait；tokio 的有界 channel 提供背压，`CancellationToken` 提供协作式中断；Realtime 则是在同一条事件总线之上另接了一层低延迟音视频传输面。
