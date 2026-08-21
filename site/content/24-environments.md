# 第 24 章：多环境——同一会话怎么跑在不同机器上

## 为什么需要环境抽象

第 2 章（进程模型）把 Codex 拆成「大脑」与「手脚」：模型在云端思考，真正执行命令、读写文件的是本机或某台远程机器上的进程。第 11 章（exec-server 执行链路）进一步说明，同一个 `exec-server` 既能跑在本地，也能跑在远端容器里。于是问题来了：上层工具（shell、apply_patch、read）不该关心命令到底落在哪台机器——否则每个工具都要写两套分支。解决办法就是把「在哪里执行」收敛成一个**环境（Environment）抽象**，调用方只拿到一个统一句柄。

## Environment 接口长什么样

`Environment` 本身是一个轻量句柄，关键字段是两套 trait 对象：`exec-server/src/environment.rs:658` 中定义为

```rust
pub struct Environment {
    remote_client: Option<LazyRemoteExecServerClient>,
    exec_backend: Arc<dyn ExecBackend>,          // 执行命令
    filesystem: Arc<dyn ExecutorFileSystem>,     // 读写文件
    ...
}
```

执行走 `exec-server/src/process.rs:222` 的 `pub trait ExecBackend: Send + Sync { fn start(&self, params: ExecParams) ... }`；文件系统走 `file-system/src/lib.rs:456` 的 `pub trait ExecutorFileSystem: Send + Sync`。上层只通过这些 trait 拿到 `get_exec_backend()` 与 `get_filesystem()`（`exec-server/src/environment.rs:1052`、`:1060`），完全不知道背后是本地还是远程。

## Local 与 Remote 两种实现

两套实现的切换发生在 `Environment::create_inner`：`exec-server/src/environment.rs:734` 里，若传入 `exec_server_url` 就走 `remote_with_transport`，否则走 `local`。

- **Local**：`exec-server/src/environment.rs:750` 的 `local()` 把后端装成 `LocalProcess`（`exec-server/src/local_process.rs:167`），文件系统装成 `LocalFileSystem`，命令直接在本机 spawn。
- **Remote**：`remote_with_transport`（`exec-server/src/environment.rs:770`）持有一个 `LazyRemoteExecServerClient`，执行后端换成 `RemoteProcess`（`exec-server/src/remote_process.rs:22`），经 WebSocket 把命令发往远端 `exec-server`，文件读写也走 `RemoteFileSystem`。

也就是说，Local/Remote 的区别被封死在 `exec_backend` / `filesystem` 这两个 trait 的实例化里，对外接口完全一致。

## turn 怎么选环境

一次 turn 具体用哪个环境，由 `TurnEnvironmentSelection` 决定：`protocol/src/protocol.rs:148` 定义它含 `environment_id`、`cwd`、`workspace_roots`、`config`。`core/src/session/turn_context.rs:39` 的 `TurnEnvironment` 把它和具体的 `Arc<Environment>` 绑在一起。

选择发生在 `capture_step_context` 阶段：`core/src/session/mod.rs:3159` 的 `capture_step_context`（以及带 MCP 依赖的 `:3172`）在开局调用 `turn_context.environments.refresh_readiness()`（`:3179`），把每个 selection 解析成可用的 `Environment` 句柄，再交给 `run_turn`（`core/src/session/turn.rs:208`）使用。第 4 章讲过的 `capture_step_context_with_required_mcp_servers` 正是这一步——它一边等 MCP 就绪，一边把环境绑定固定下来，保证整轮 turn 看到的机器不变。

## 小结

多环境的核心思想：用 `Environment` 这一个句柄统一「本地执行」和「远程执行」，差异只藏在 `ExecBackend` / `ExecutorFileSystem` 两个 trait 的 Local/Remote 实现里；turn 通过 `TurnEnvironmentSelection` + `capture_step_context` 在每轮开始时把抽象落定为具体机器。这样工具层、模型层都无需关心代码跑在哪台机器上——呼应了第 2 章的进程模型与第 11 章的 exec-server 双形态。
