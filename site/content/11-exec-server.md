# 第 11 章：exec-server 执行链路——命令到底在哪跑的

## 为什么 exec 要单独成进程

前面几章我们看到，Codex 的核心（codex-core）负责与大模型对话、跑工具循环，而真正把命令落到操作系统上执行，却走了一条独立的进程边界。这个独立进程就是 **exec-server**（`codex_exec_server` crate）。

把它拆出来是出于**信任边界**的考虑：大模型生成的 shell 指令是不可信输入，文件系统访问、网络出口、进程信号都需要被统一收口。让 core 在进程内直接 `std::process::Command` 显然也能跑，但那样沙箱策略、能力发现（capability discovery）、远程执行环境（RemoteEnvironment）等逻辑会和数据面耦合。把它们放进一个独立的 executor 进程，core 只通过协议与之通信，就能把"执行"这件事做成可替换、可审计、可远程化的组件——本地跑在 `DEFAULT_LISTEN_URL`（`exec-server/src/lib.rs:208`，`pub use server::DEFAULT_LISTEN_URL`），远程则连到托管环境。

## exec-server 的对外接口与入口

exec-server 的进程入口非常薄，只是把监听地址、运行时路径、HTTP client 工厂接起来：

```rust
// exec-server/src/server.rs:21
pub async fn run_main(
    listen_url: &str,
    runtime_paths: ExecServerRuntimePaths,
    http_client_factory: HttpClientFactory,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
```

真正的逻辑在 `run_main_with_telemetry`（`exec-server/src/server.rs:41`），它在 `RequestDispatchMode::Inline` 下调用 `transport::run_transport` 启动 JSON-RPC 服务。对外的执行契约由 `codex_exec_server_protocol` 定义：`ExecParams`（`ExecParams`/`ExecResponse` 在 `exec-server/src/lib.rs:147` 等处被 re-export）描述一次执行请求，执行过程中的增量输出用 `ExecOutputDeltaNotification` 回传。

## core 侧怎么把命令请求发过去

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

`build_exec_request`（`core/src/exec.rs:315`）先把命令拆成 `program`/`args`，再交给 `SandboxManager` 做策略转换；app-server 的 `command/exec` 流式执行则走 `CommandExecManager::start`（`app-server/src/command_exec.rs:143`），它直接 `spawn_pty_process` 并桥接回 app-server 协议。两条路最终都归结为"构造 `ExecRequest` → 执行 → 收集输出"。

## 沙箱如何套在它外面

呼应[第 6 章：沙箱](06-sandbox.md)，执行前的沙箱选择发生在 `select_process_exec_tool_sandbox_type`（`core/src/exec.rs:342`），它调用 `SandboxManager::new().select_initial(...)` 决定用哪种 `SandboxType`（如 Linux 下的 landlock/seccomp 沙箱、macOS 的 sandbox-exec、Windows 的受限令牌）。在 `build_exec_request` 里，这个 `sandbox_type` 连同 `codex_linux_sandbox_exe`（`core/src/exec.rs:387`，即 `codex-sandboxing`/`linux-sandbox` 可执行文件）一起交给 `manager.transform(...)`，把原始命令包成带沙箱 wrapper 的真实 argv。换句话说，core 不自己判断"该不该限制"，而是把决策结果塞进 `ExecRequest`，执行层只负责按约定启动。

## 输出如何经 EventMsg 流回

命令跑起来后，stdout/stderr 由 `read_output`（`core/src/exec.rs:1078`）按块读取。每当攒到一段增量，且本次调用还在增量预算内（`MAX_EXEC_OUTPUT_DELTAS_PER_CALL`，`core/src/exec.rs:1102` 附近），就构造一条事件推回上层：

```rust
// core/src/exec.rs:1102
let msg = EventMsg::ExecCommandOutputDelta(ExecCommandOutputDeltaEvent {
    call_id: stream.call_id.clone(),
    stream: if is_stderr { ExecOutputStream::Stderr } else { ExecOutputStream::Stdout },
    chunk,
});
```

`ExecCommandOutputDelta` 只是数据流的中间片。完整的生命周期由另外两条 `EventMsg` 收口：`ExecCommandBegin`（`protocol/src/protocol.rs:3273` 定义 `ExecCommandBeginEvent`）标记一次调用开始，`ExecCommandEnd`（`protocol/src/protocol.rs:3307` 定义 `ExecCommandEndEvent`）携带最终 exit_code 与聚合输出。app-server 侧则会把这些事件再转成 `CommandExecOutputDeltaNotification` 流式推给前端。这样既保证了 TUI/客户端能实时看到输出，又让一次执行的"开始—增量—结束"在协议层是完整可重放的。

## 小结

exec-server 的存在，让"命令在哪跑"成为一条清晰的、带信任边界的链路：core 不直接碰 shell，而是用 `process_exec_tool_call`（`core/src/exec.rs:291`）构造 `ExecRequest`，沙箱策略在 `build_exec_request`（`core/src/exec.rs:315`）阶段就已被包进 argv，执行进程通过 `run_main`（`exec-server/src/server.rs:21`）独立启动并以 JSON-RPC 协议通信，输出则经由 `ExecCommandBegin`/`ExecCommandOutputDelta`/`ExecCommandEnd` 三段 `EventMsg` 完整回流。理解了这条链路，再看第 6 章的沙箱与第 8 章的协议，就能把"安全边界"和"数据流"两件事串成一条线。
