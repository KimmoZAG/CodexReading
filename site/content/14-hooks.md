# 第 14 章：Hooks——在回合关键节点插一脚

Codex 不只被动地「接收用户输入 → 跑工具 → 给模型」，它还允许你在会话生命周期的若干**关键节点**上挂载外部脚本（或 MCP 工具、prompt、agent），这层机制就是 **Hooks**。Hook 本质上是 Codex 在会话（session）、回合（turn）以及单个工具调用前后，自动触发的用户定义动作——它们运行在 Codex 主流程之外，却能读取上下文、注入上下文，甚至**拦截或阻断**一次工具调用。

## 有哪些钩子点

Codex 把生命周期切成了一系列命名事件。从配置结构 `HookEventsToml` 可以看到全部钩子点：`PreToolUse`、`PostToolUse`、`PermissionRequest`、`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`SubagentStart`、`SubagentStop`、`Stop`、`PreCompact`、`PostCompact`（`config/src/hook_config.rs:36`）。其中与「回合」最相关的是 `SessionStart`（会话开始）、`UserPromptSubmit`（用户提交 prompt，即 turn 起点）、`Stop`/`SubagentStop`（回合收尾），而 `PreToolUse` 与 `PostToolUse` 则精确地贴在**每一次工具调用**的前后。

## 钩子怎么被加载与执行

Hooks 通过 config 里的 `hooks` 配置加载。每个钩子点由一组 `MatcherGroup` 构成，每个 group 带一个可选的 `matcher`（按工具名等匹配）和若干 `HookHandlerConfig`（`config/src/hook_config.rs:139`）。Handler 类型包括 `command`（外部命令）、`mcp_tool`、`prompt`、`agent`。

加载完成后，真正调度发生在 `core/src/hook_runtime.rs`。会话开始会调用 `run_pending_session_start_hooks`（`core/src/hook_runtime.rs:111`）；每个 turn 的起点则经 `run_hooks_and_record_inputs` 先 `inspect_pending_input`、再 `record_pending_input`，从而把 `UserPromptSubmit` 等钩子插入到用户输入落库之前（`core/src/session/turn.rs:615`）。

工具前后的两个钩子点是最常被用到的：`run_pre_tool_use_hooks`（`core/src/hook_runtime.rs:171`）在工具执行前运行，`run_post_tool_use_hooks`（`core/src/hook_runtime.rs:272`）在工具产出成功后运行。它们最终都委托给 `codex_hooks` crate：`registry.run_pre_tool_use`（`hooks/src/registry.rs:203`）→ `engine.run_pre_tool_use`（`hooks/src/engine/mod.rs:259`），由引擎按 handler 类型真正拉起命令或 MCP 调用。

## 与工具系统的关系

Hooks 紧贴第 5 章讲的工具系统：`PreToolUse` 拿到的是即将执行的工具名与 `tool_input`，`PostToolUse` 额外拿到 `tool_input` 与 `tool_response`（`core/src/hook_runtime.rs:171`、`:272`）。`PreToolUse` 最关键的能力是**阻断**：若钩子返回 `should_block`，主流程据此返回 `PreToolUseHookResult::Blocked`，工具调用根本不会执行（`core/src/hook_runtime.rs:206`）。

## 最小示例：用 PreToolUse 拒绝某个命令

```toml
# settings/projects/<id>/hooks.toml
[[PreToolUse.hooks]]
type = "command"
command = '''
if [ "$TOOL_NAME" = "Bash" ] && echo "$TOOL_INPUT" | grep -q "rm -rf"; then
  echo "拒绝危险命令: rm -rf" >&2
  exit 2   # 非零退出 -> should_block
fi
'''
```

当模型准备执行 `Bash` 且命令包含 `rm -rf` 时，该钩子非零退出，Codex 触发 `PreToolUseHookResult::Blocked`，工具调用被取消，并把原因回传给模型。

## 小结

Hooks 让 Codex 从「封闭的工具循环」变成「可被外部逻辑介入的流水线」：在 session/turn/工具前后挂载脚本，既能读上下文、注入上下文，也能按策略放行或拦截。它与第 5 章工具系统深度耦合——`PreToolUse`/`PostToolUse` 就是工具调用前后的两道闸门，理解它们也就理解了 Codex 可扩展性的核心入口。
