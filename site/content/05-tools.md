# 第 5 章：工具系统——模型说"我要调个函数"之后发生了什么

第 4 章的主循环里，`FunctionCall` 这个分支是整台机器"动手干活"的入口。模型本身不会读写文件、不会跑命令，它只会**产出一段结构化的"我想调这个工具，参数是这些"**。真正把这句话变成磁盘上的改动、终端里的输出，是 `codex-core` 的工具系统在干。

## 5.1 一个工具调用长什么样

模型吐出来的函数调用，被封装成 `ToolCall`：`tool_name`、`call_id`、`payload`。核心拿到它之后的分发逻辑在 `core/src/tools/router.rs`：

```rust
// core/src/tools/router.rs:260
let ToolCall {
    tool_name,
    call_id,
    payload,
    ..
} = call;

// 把调用信息和环境打包进 ToolInvocation
let invocation = ToolInvocation {
    session, turn, step_context,
    cancellation_token, tracker,
    call_id, tool_name, source, payload,
};

// 交给注册表去真正执行
self.registry
    .dispatch_any_with_terminal_outcome(invocation, terminal_outcome_reached)
    .await
```

`dispatch_any_with_terminal_outcome` 这个名字信息量很大：

- **`dispatch_any`**：按 `tool_name` 找到对应的 handler（可能是内置的，也可能是 MCP/插件提供的）。
- **`terminal_outcome`**：标记这次调用是否构成了回合的"终态"（比如 `exec` 跑完一条命令、或 `apply_patch` 落地），主循环据此判断要不要结束。

## 5.2 工具不是"函数"，是带生命周期的对象

每个工具的 handler 都实现同一套 trait（集中在 `core/src/tools/registry.rs`、`core/src/tools/context.rs`）。它要处理的远不止"执行"：

- **执行前（PreToolUse）**：跑 hook、做权限检查。
- **执行中**：把流式进度通过 `ToolEmitter` 往外发（`EventMsg` 里的 `ExecCommandOutputDelta`、`PatchApplyUpdated` 都来自这里）。
- **执行后（PostToolUse）**：把结果转成协议里的 `ToolCallOutput`，并决定要不要记入会话历史。

一个工具从"被模型点名"到"结果回到模型"，中间要过三道关卡。这跟第 6 章的沙箱是一体两面的设计。

## 5.3 例子：`apply_patch`——它是怎么一边改文件一边直播的

`apply_patch` 是 Codex 改代码的主工具（而不是让模型直接输出整个文件）。它的 handler 在 `core/src/tools/handlers/apply_patch.rs`。有意思的是它**流式**解析模型给的补丁：

```rust
// core/src/tools/handlers/apply_patch.rs:85
#[derive(Default)]
struct ApplyPatchArgumentDiffConsumer {
    parser: StreamingPatchParser,   // 边收边解析补丁
    last_sent_at: Option<Instant>,  // 节流：别每条 delta 都发事件
    pending: Option<PatchApplyUpdatedEvent>,
}

impl ToolArgumentDiffConsumer for ApplyPatchArgumentDiffConsumer {
    fn consume_diff(&mut self, turn: &TurnContext, call_id: String, diff: &str)
        -> Option<EventMsg> {
        // 特性开关没开就干脆不发增量事件
        if !turn.config.features.enabled(Feature::ApplyPatchStreamingEvents) {
            return None;
        }
        self.push_delta(call_id, diff)
            .map(EventMsg::PatchApplyUpdated)   // 实时把"补丁长啥样"推给界面
    }
}
```

这里有两个值得记住的工程细节：

1. **流式解析**：模型不是一次性给完整补丁，而是一点一点吐。`StreamingPatchParser` 边收边解析成 `Hunk`，界面就能实时显示"正在改第 3 个文件"。
2. **节流**：`APPLY_PATCH_ARGUMENT_DIFF_BUFFER_INTERVAL = 500ms`（`:58`），避免高频 delta 把事件总线冲爆。这种"该省就省"的克制，是这个仓库成熟度的一个小注脚。

补丁最终通过 `ApplyPatchRuntime`（`core/src/tools/runtimes/apply_patch.rs`）落到文件系统——而**落盘的权限，仍由第 6 章的沙箱策略把关**。

## 5.4 命令类工具：审批从哪来

模型想跑 `cargo test` 这类 shell 命令，走的也是工具系统，但多一道人工关卡。它不会直接在本机 `system()`，而是先发 `ExecApprovalRequest` 事件（第 3 章见过），等你用 `Op::ExecApproval` 表态，点头后才转交给 `exec-server` 在沙箱里执行，输出经 `ExecCommandOutputDelta` 流回界面。整条分发链路长这样：

![](assets/diagrams/tool-dispatch.svg)

从 `ToolCall` 进 `ToolRouter`、`ToolRegistry` 找到 handler，到"审批"那道虚线闸门（命中白名单才放行，否则拦下等你确认），最后落到 `Exec-Server`/沙箱。这一道"审批闸门 + 沙箱执行"，就是 Codex 敢让模型跑命令的底气。下一章我们专门拆沙箱。
