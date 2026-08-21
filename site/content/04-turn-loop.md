# 第 4 章：主循环——`run_turn` 是怎么"想一步、做一步"的

`next_event` 背后在循环什么？答案在 `run_turn`，`codex-core` 真正的心跳。

## 4.1 run_turn 干的事

`run_turn` 在 `core/src/session/turn.rs:153`。它的文档注释本身就写得很清楚：

```rust
// core/src/session/turn.rs:139
/// Takes initial turn input and runs a loop where, at each sampling request,
/// the model replies with either:
///
/// - requested function calls
/// - an assistant message
///
/// While it is possible for the model to return multiple of these items in a
/// single sampling request, in practice, we generally one item per sampling request:
///
/// - If the model requests a function call, we execute it and send the output
///   back to the model in the next sampling request.
/// - If the model sends only an assistant message, we record it in the
///   conversation history and consider the turn complete.
pub(crate) async fn run_turn(
    sess: Arc<Session>,
    turn_context: Arc<TurnContext>,
    input: Vec<TurnInput>,
    prewarmed_client_session: Option<ModelClientSession>,
    cancellation_token: CancellationToken,
) -> CodexResult<Option<String>> {
```

一个回合就是反复"问模型 → 看它回了什么"。模型每次回的东西只有两种可能：要么"我要调个工具"（function call），要么"我说完了"（assistant message）。前者就执行工具、把结果塞回去再问；后者就记进历史、回合结束。

## 4.2 循环骨架

真实代码里这一圈被拆成了 `run_sampling_request`（同文件 `:1340` 附近）之类的内部函数。先看图建立直觉：

![](assets/diagrams/turn-loop.svg)

一圈四件事：问模型、看它回的是 function call 还是 assistant message、要调工具就执行、到终态就收工。箭头从"执行工具"绕回"问模型"，就是下一轮循环。

返回类型 `CodexResult<Option<String>>` 里那个 `Option<String>` 是"最终给用户的文本结论"。过程中所有的实时变化（命令输出、补丁进度、思考内容）不走返回值，而是经 `sess` 上的事件发射器，变成第 3 章那些 `EventMsg` 流出去。

## 4.3 为什么"进循环前"比循环本身还长

读 `run_turn` 最容易懵的一点：真正 `loop` 的体量，还不如它前面那一大坨准备工作。一个能用的 agent 回合，难点从来不在"调 API"，而在这几件事：

- **上下文压缩**：历史太长会爆 token，得先 `run_pre_sampling_compact` 把旧内容压缩掉（`:169`）。
- **环境捕获**：这次要在哪个目录、哪个沙箱环境里跑？`capture_step_context_with_required_mcp_servers`（`:207`）。
- **技能/插件注入**：用户 `@` 了某个 skill 或插件，得先把它们的提示词拼进上下文（`build_skills_and_plugins`，`:250`）。
- **Hook 编排**：`run_pending_session_start_hooks`、`run_hooks_and_record_inputs`……外部插件能在回合关键节点插一脚。

"玩具 agent"和"生产级 agent"的差距就落在这几项上。Codex 的工程量大头也在这里，不在循环本身。

## 4.4 怎么停下

循环的终止由"是否到达终态"决定。常见出口：

- 模型只回了 assistant message → 记录、回合完成（`TurnComplete`）。
- 触发了需要人工审批的指令（比如跑一条危险命令）→ 发 `ExecApprovalRequest`，等你在 `Op::ExecApproval` 里回话，再继续或中止。
- 被 `CancellationToken` 取消（`Interrupt` Op 会触发它）。
- 上下文压缩失败、`TurnAborted` 等错误路径。

终态只是"这一轮"的结束，不是进程结束。所以 `codex exec` 跑完一轮能干净退出，交互会话还能接着接你的下一句。

下一章看循环里那个 `FunctionCall` 分支：工具怎么被调起来，`apply_patch` 又怎么一边改文件一边把进度推给你。
