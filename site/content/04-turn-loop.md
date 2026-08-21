# 第 4 章：主循环——`run_turn` 是怎么"想一步、做一步"的

第 3 章我们站在一个舒服的距离看了 `submit` / `next_event`。这一章往里走一步，看 `next_event` 背后到底在循环什么。这段逻辑是 `codex-core` 真正的心跳。

## 4.1 一句话定义

`run_turn` 在 `core/src/session/turn.rs:153`。它的文档注释几乎是最好的说明书，原文是这样的：

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

把这段翻译成人话：**一个回合就是反复"问模型 → 看它回了什么"的循环**。模型每次回的东西只有两种可能——要么"我要调个工具"（function call），要么"我说完了"（assistant message）。前者就执行工具、把结果塞回去再问；后者就记进历史、回合结束。

## 4.2 循环骨架（伪代码版）

真实代码里这一圈被拆成了 `run_sampling_request`（同文件 `:1340` 附近）之类的内部函数，但骨架长这样，方便你建立直觉：

```text
run_turn(input):
    # —— 进入循环前的准备（占 run_turn 前半段大量代码）——
    压缩上下文(run_pre_sampling_compact)        # 太长先瘦身
    解析用户输入里 @ 提到的 MCP 服务 / 插件
    捕获 step_context（这一次采样要用的环境）
    组装 skills / plugins / connectors
    跑各种 hook（session 开始、turn 开始）

    # —— 真正的采样循环 ——
    loop:
        items = client.make_api_call_with_streaming(world_state)   # 问模型
        for item in items:
            match item:
                AssistantMessage => 记进历史; 标记回合可结束
                FunctionCall     => 把调用交给工具系统执行（第5章）
                                   结果作为新 item 追加进 world_state
                Reasoning        => 作为"思考"事件往外发
        if 已到达终态(terminal outcome): break
    发 TurnComplete 事件
```

注意一个细节：`run_turn` 的返回值类型是 `CodexResult<Option<String>>`，那个 `Option<String>` 就是"最终给用户的文本结论"。而**过程中所有的实时变化**（命令输出、补丁进度、思考内容）都不是通过返回值传的，而是通过 `sess` 上的事件发射器，最终变成第 3 章讲过的 `EventMsg` 流出去。这再次印证了"界面层只是 Event 的视图"。

## 4.3 为什么"进循环前"比循环本身还长

新手读 `run_turn` 最容易懵的一点：真正 `loop` 的体量，还不如它前面那一大坨准备工作。原因很实在——一个能用的 agent 回合，难点从来不在"调 API"，而在：

- **上下文压缩**：历史太长会爆 token，得先 `run_pre_sampling_compact` 把旧内容Summary掉（`:169`）。
- **环境捕获**：这次要在哪个目录、哪个沙箱环境里跑？`capture_step_context_with_required_mcp_servers`（`:207`）。
- **技能/插件注入**：用户 `@` 了某个 skill 或插件，得先把它们的提示词拼进上下文（`build_skills_and_plugins`，`:250`）。
- **Hook 编排**：`run_pending_session_start_hooks`、`run_hooks_and_record_inputs`……外部插件能在回合关键节点插一脚。

这些恰恰是一个"玩具 agent"和"生产级 agent"的分水岭。Codex 把大量工程投在这里，而不是在循环本身。

## 4.4 怎么停下

循环的终止由"是否到达终态"决定。常见出口：

- 模型只回了 assistant message → 记录、回合完成（`TurnComplete`）。
- 触发了需要人工审批的指令（比如跑一条危险命令）→ 发 `ExecApprovalRequest`，等你在 `Op::ExecApproval` 里回话，再继续或中止。
- 被 `CancellationToken` 取消（`Interrupt` Op 会触发它）。
- 上下文压缩失败、`TurnAborted` 等错误路径。

理解"终态"这个概念很重要：它解释了为什么 `codex exec` 能在跑完一轮后干净退出，而交互式会话能在一个回合结束后继续接你的下一句——**终态只是"这一轮"的结束，不是进程结束**。

下一章看循环里那个 `FunctionCall` 分支：工具到底是咋被调起来的，`apply_patch` 又是怎么一边改文件一边把进度推给你的。
