# 第 27 章：错误处理——CodexResult 与出错时的优雅降级

## 为什么需要统一的错误类型

Codex 的运行链路上，模型客户端、工具执行、沙箱、鉴权、配置解析都可能失败，且分属不同 crate。若任由 `io::Error`、`serde_json::Error`、`HttpError` 各自上抛，调用方根本无法做统一决策。因此 protocol 层定义了一个唯一的错误类型 `CodexErr`，并把结果类型统一为 `pub type Result<T> = std::result::Result<T, CodexErr>`（`reference/codex/codex-rs/protocol/src/error.rs:30`）——这就是第 3 章公共 API 里 `CodexResult` 的真身（`protocol.rs` 中以 `use crate::error::Result as CodexResult` 重新导出）。`CodexErr` 本身很薄，只包了两样东西：语义化的 `details: CodexErrorDetails` 和一个可选的 `retry_delay: Option<Duration>`（`reference/codex/codex-rs/protocol/src/error.rs:70`），前者归类、后者携带退避策略，二者解耦，便于上层判断“能不能重试”而不关心底层细节。

## 错误怎么分类：可重试 / 终态 / 用户可恢复

真正用于分类的是 `pub enum CodexErrorDetails`（`reference/codex/codex-rs/protocol/src/error.rs:81`），它枚举了上下文超限、连接失败、沙箱拒绝、配额耗尽、策略违规等几十种情形。是否可重试由一个方法集中裁决：`pub fn is_retryable(&self) -> bool`（`reference/codex/codex-rs/protocol/src/error.rs:364`）。例如 `Stream`、`Timeout`、`ConnectionFailed`、`Io`、`Json` 等被标记为 `true`，主循环据此自动退避重试；而 `TurnAborted`、`ContextWindowExceeded`、`UsageLimitReached`、`Sandbox` 等返回 `false`，属终态错误，必须由用户或流程收尾。还有一类“用户可恢复”的并非走 `CodexErr`，而是第 21 章的审批流（如 `ExecApprovalRequest`）——它们以事件而非错误的形式交还用户决策，避免把“等用户点同意”误判成失败。

## 错误如何变成 EventMsg::Error 流给界面（呼应第 3 章）

错误不会原地崩溃，而是被翻译成协议层的客户端可理解结构。`CodexErr::to_error_event`（`reference/codex/codex-rs/protocol/src/error.rs:458`）先 `to_string` 拿到人类可读消息，再调用 `to_codex_protocol_error` 把内部 `CodexErrorDetails` 映射成线协议枚举 `pub enum CodexErrorInfo`（`reference/codex/codex-rs/protocol/src/protocol.rs:1771`，如 `ContextWindowExceeded`、`SandboxError`、`Unauthorized`），最终产出 `pub struct ErrorEvent { message, codex_error_info }`（`reference/codex/codex-rs/protocol/src/protocol.rs:1937`）。该事件被包进 `EventMsg::Error(ErrorEvent)`（`reference/codex/codex-rs/protocol/src/protocol.rs:1290`），经由第 3 章的 EQ 事件队列推送至 TUI / app-server，UI 据此既展示文案也能按 `codex_error_info` 做针对性提示（比如“上下文超了，开新会话”）。

## 主循环怎么处理终态错误：TurnAborted（呼应第 4 章）

进入第 4 章的 `run_turn` 主循环后，终态错误有专门的出口。循环对 `Err` 逐一 `matches!(err.details(), CodexErrorDetails::TurnAborted)`（`reference/codex/codex-rs/core/src/session/turn.rs:216`），把“被中断/中止”与“真正的硬失败”区分开：普通终态错误会再走一次 `to_error_event` 发 `EventMsg::Error`（`turn.rs:580`）后结束本轮；而 `TurnAborted` 则发出 `EventMsg::TurnAborted`，让线程保留状态、等待用户下一条输入，实现“优雅降级”而非进程退出。可重试错误则在上游就被拦截、按 `retry_delay` 退避重投，用户几乎无感。

## 小结

Codex 的错误处理是一条“分类 → 翻译 → 分流”的流水线：`CodexErrorDetails` 给出语义分类，`is_retryable` 决定退避重试还是终态，`to_error_event` 把错误降级为 `EventMsg::Error` 进入第 3 章的事件流，主循环（第 4 章）对 `TurnAborted` 等终态做收尾。统一类型让跨 crate 的失败既能自动恢复，又能在必要时把真相完整交给界面与用户。
