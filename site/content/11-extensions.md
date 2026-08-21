# 第 11 章：扩展生态——怎么把外部能力接进来

Codex 留了四条扩展路径：**Hooks** 在回合的关键节点插一脚，**Skills** 把可复用经验喂进上下文，**MCP** 把外部服务接进工具系统，**插件**把前三者打包分发。四条路径最后都落在同一条工具分发链路上。

![](assets/diagrams/tool-dispatch.svg)

ToolCall 经路由、注册表、处理器走到审批与 Exec-Server，MCP 接进来的外部工具和内置工具共用这条链路；Hooks、Skills、插件都是往它上面挂东西。

## 11.1 Hooks：在回合关键节点插一脚

Hook 是 Codex 在会话（session）、回合（turn）以及单个工具调用前后自动触发的用户定义动作，可以是外部脚本，也可以是 MCP 工具、prompt、agent。它们跑在主流程之外，但能读取上下文、往上下文里注入内容，甚至**拦截或阻断**一次工具调用。

Codex 把生命周期切成了一系列命名事件。从配置结构 `HookEventsToml` 能看到全部钩子点：`PreToolUse`、`PostToolUse`、`PermissionRequest`、`SessionStart`、`SessionEnd`、`UserPromptSubmit`、`SubagentStart`、`SubagentStop`、`Stop`、`PreCompact`、`PostCompact`（`config/src/hook_config.rs:36`）。其中与"回合"最相关的是 `SessionStart`、`UserPromptSubmit`、`Stop`/`SubagentStop`，而 `PreToolUse` 与 `PostToolUse` 精确地贴在**每一次工具调用**的前后。

Hooks 通过 config 里的 `hooks` 配置加载。每个钩子点由一组 `MatcherGroup` 构成，每个 group 带一个可选的 `matcher`（按工具名等匹配）和若干 `HookHandlerConfig`（`config/src/hook_config.rs:139`）。Handler 类型包括 `command`（外部命令）、`mcp_tool`、`prompt`、`agent`。

加载完成后，真正调度发生在 `core/src/hook_runtime.rs`。会话开始会调用 `run_pending_session_start_hooks`（`core/src/hook_runtime.rs:111`）；每个 turn 的起点则经 `run_hooks_and_record_inputs` 先 `inspect_pending_input`、再 `record_pending_input`，从而把 `UserPromptSubmit` 等钩子插入到用户输入落库之前（`core/src/session/turn.rs:615`）。

工具前后的两个钩子点最常用：`run_pre_tool_use_hooks`（`core/src/hook_runtime.rs:171`）在工具执行前运行，`run_post_tool_use_hooks`（`core/src/hook_runtime.rs:272`）在工具产出成功后运行。它们最终都委托给 `codex_hooks` crate：`registry.run_pre_tool_use`（`hooks/src/registry.rs:203`）→ `engine.run_pre_tool_use`（`hooks/src/engine/mod.rs:259`），由引擎按 handler 类型真正拉起命令或 MCP 调用。

`PreToolUse` 拿到的是即将执行的工具名与 `tool_input`，`PostToolUse` 额外拿到 `tool_response`。`PreToolUse` 最关键的能力是**阻断**：若钩子返回 `should_block`，主流程据此返回 `PreToolUseHookResult::Blocked`，工具调用根本不会执行（`core/src/hook_runtime.rs:206`）。

最小示例——用 `PreToolUse` 拒绝某个命令：

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

## 11.2 Skills：把可复用能力喂进上下文

一个 Skill 就是一段**带元数据的提示词 / 指令**：写在仓库（或用户目录）下的 `SKILL.md` 里，YAML frontmatter 描述名字、用途等元数据，正文是具体要做的事。用户在对话里用 `@技能名` 点名调用它，Codex 也会从命令里隐式识别出对 skill 脚本/文档的访问并自动注入。

解析后的元数据由 `SkillMetadata` 承载（`skills/src/model.rs:8`），包含 `name`、`description`，以及可选的 `SkillPolicy`（`skills/src/model.rs:62`，用 `allow_implicit_invocation` 控制是否允许被隐式触发）、`SkillInterface`（`skills/src/model.rs:70`）和 `SkillDependencies`（`skills/src/model.rs:80`，声明 skill 依赖的 MCP 工具）。每个 skill 还带 `scope`（`skills/src/model.rs:17`，取值 user/repo/system/admin 决定优先级）与可选的 `plugin_id`（`skills/src/model.rs:18`），说明它既可以是本地文件系统上的 skill，也可以由插件提供。

它和 prompt / tool 的区别：

- **prompt（系统提示词）**是写死的、通用的背景说明；Skill 是按需、可点名加载的一段专门指令。
- **tool** 是模型可调用的确定性函数（有输入输出 schema）；Skill 不是函数，而是一段被拼进上下文的提示词，用来改变模型的意图与做法，本身不执行副作用。
- tool 给模型"手"，skill 给模型"心法"。两者可以配合——skill 的 `SkillToolDependency` 还能声明它要靠哪个 MCP 工具完成工作。

Skill 的 `SKILL.md` frontmatter 由 `parse_skill_frontmatter_metadata` 解析校验（`skills/src/parser.rs:44`），产出 `ParsedSkillFrontmatter`（`skills/src/parser.rs:24`）；非法 YAML 还会尝试逐行修复。

加载与主循环注入发生在 `build_skills_and_plugins`（`core/src/session/turn.rs:758`，呼应第 4 章的 turn 主循环）。该函数先取出 `skills_snapshot`，再用 `collect_explicit_skill_mentions`（`core/src/session/turn.rs:809`）收集用户 `@` 提到的 skill，随后调用 `skills_snapshot.load_skill_prompts(&mentioned_skills)`（`core/src/session/turn.rs:826`）把这些 skill 正文渲染成 `ContextualUserFragment` 片段。最终这些片段作为 `injection_items` 在 turn 开头被 `record_conversation_items` 写进会话（`core/src/session/turn.rs:278`），从而进入模型看到的上下文。Codex 还会用 `InjectedHostSkillPrompts` 做去重（`core/src/session/turn.rs:879` 起），避免同一个 host skill 既经扩展机制又经本次逻辑被重复注入。隐式调用则由 `detect_implicit_skill_invocation_for_command`（`skills/src/invocation.rs:26`）识别命令里对 skill 脚本/文档的访问来完成。

最小 `SKILL.md`：

```markdown
---
name: sum-csv
description: 把 CSV 的某列求和
metadata:
  short-description: 汇总 CSV 数值列
---
请读取用户指定的 CSV，对其中的 amount 列求和，
仅输出总和数字，不要解释。
```

用户 `@sum-csv` 后，该正文片段就会被注入当前 turn，模型据此行动。

## 11.3 MCP：把外部工具接进来

第 5 章的工具系统（`ToolRegistry` + `dispatch_any_with_terminal_outcome`）里，内置工具是写死在代码里的。MCP（Model Context Protocol，模型上下文协议）这套开放协议让运维/用户在**不改动 Codex 源码**的前提下把任意一个遵循协议的服务端接进来，模型调它和调内置工具没区别。MCP server 能暴露三类能力：**tools**（可被模型调用的函数）、**resources**（可被读取的数据）、**resource templates**（按模板定位的数据）。

连接的生命周期在 `codex-mcp/src/rmcp_client.rs` 的 `start_server_task` 里：它先用 `mcp_initialize_request_params` 拼出握手参数，再调用 `client.initialize(params, startup_timeout, send_elicitation)` 完成 **initialize 握手**（`:884`）。握手参数由 `mcp_initialize_request_params` 构造，声明客户端能力并固定协议版本 `ProtocolVersion::V_2025_06_18`（`:998`）。

握手成功后，紧接着调用 `list_tools_for_client_uncached` 拉取对端工具清单，内部走 `client.list_tools_with_connector_ids`，并按协议分页收集（`:610`）。resources 的列举同理，在 `codex-mcp/src/mcp/mod.rs:691` 的 `collect_mcp_server_status_snapshot_from_manager` 中由 `list_all_resources` / `list_all_resource_templates` 完成。

传输层在 `make_rmcp_client` 里按配置分叉（`:1058`）：最常见的是 **stdio**——Codex 直接拉起一个子进程并通过其标准输入输出收发 JSON-RPC，对应 `RmcpClient::new_stdio_client_with_protocol_mode`（`:1117`）；另一种是 **Streamable HTTP**，用于远程托管的 server，对应 `new_streamable_http_client_with_protocol_mode_and_redirect_mode`（`:1150`）。stdio 之所以最普遍，是因为它无需监听端口、部署最简单。

外部工具汇入注册表的路径是这样的。所有已连 server 的工具在 `codex-mcp/src/connection_manager/tool_catalog.rs:89` 的 `McpConnectionSet::list_all_tools` 里被聚合并规范化名称（默认加 `mcp__` 前缀，见 `codex-mcp/src/mcp/mod.rs:79` 的 `qualified_mcp_tool_name_prefix`）。聚合结果封装成 `McpBinding`，其 `tools`（模型可见声明）与 `calls`（按 server+tool 名字索引的 `PreparedMcpCall`）一起交给 core。

最终，在 `core/src/tools/spec_plan.rs:285` 的 `append_source_tools` 中，每个 MCP 工具通过 `registry.register_external_with_exposure(tool.runtime, tool.exposure)` 被注册进统一的 `ToolRegistry`（`core/src/tools/registry.rs:271`、`register_external` 见 `:336`）。一旦进表，模型的一次 `tool_use` 就会落到第 5 章讲过的 `ToolRegistry::dispatch_any_with_terminal_outcome`（`core/src/tools/registry.rs:479`）里：按名字查表、跑 PreToolUse 钩子（见 11.1）、执行、再跑 PostToolUse 钩子——MCP 工具和内置工具走的是同一套分发与审批链路。

## 11.4 插件：把 Skill/MCP/Hooks 打包分发

前面讲了 Skill、MCP、Hooks，它们都靠用户手动在配置里一个个写。插件系统解决的是**分发**问题：把 skill、MCP server、slash 命令（app）、hook 一起打成一份可安装、可升级、可下发的包。

一个插件（Plugin）是一份"能力包"，一次加载就能同时贡献四类东西：

- **skills**：插件自带的一组技能根目录；
- **mcp_servers**：插件声明要启动的 MCP server；
- **apps**：插件的 slash 命令 / 应用入口（即用户 `@` 提到的 connector）；
- **hooks**：插件的事件钩子。

加载完成后，会话对每个插件生成一个能力摘要 `PluginCapabilitySummary`，字段直接列出了 `has_skills` 与 `mcp_server_names`，见 `plugin/src/lib.rs:49`。它把 skill、MCP、app 统一收进一个摘要——这正是"打包分发"在数据上的体现。

插件内容由一份 manifest 描述。解析结果是泛型模型 `PluginManifest<Resource>`，其中真正决定"装了什么"的是 `PluginManifestPaths`（`plugin/src/manifest.rs:18`）：

```rust
pub struct PluginManifestPaths<Resource> {
    pub skills: Vec<Resource>,
    pub mcp_servers: Option<PluginManifestMcpServers<Resource>>,
    pub apps: Option<Resource>,
    pub hooks: Option<PluginManifestHooks<Resource>>,
}
```

`Resource` 在宿主侧是绝对路径，在远程解析后换成带 authority 的 locator。manifest 里写的是 paths/objects，加载器负责把它们映射成实际资源。`interface` 字段（`plugin/src/manifest.rs:42`）则承载展示用的名称、描述、图标等元信息——这是"可分发"必须的门面。

加载的入口在 `core-plugins` 的 `PluginManager::plugins_for_config`，它内部调用 `load_plugins_from_layer_stack` 把配置层栈上的插件全部读进来（`core-plugins/src/manager.rs:610`、`:675`）：

```rust
let plugins = load_plugins_from_layer_stack(
    &config.config_layer_stack,
    self.remote_installed_plugins_snapshot(),
    &self.store,
    Some(&plugin_skill_snapshots),
    self.restriction_product,
    remote_global_catalog_active,
    self.skill_root_loader.as_ref(),
).await;
```

每个插件落地成一个 `LoadedPlugin`（`plugin/src/load_outcome.rs:19`），带着 `skill_roots`、`mcp_servers`、`apps`、`hook_sources`。多个插件汇总成 `PluginLoadOutcome`，并通过两个"effective"方法把全量能力拍平：`effective_plugin_skill_roots()`（`plugin/src/load_outcome.rs:123`）把所有 active 插件的 skill 根按 namespace 合并去重；`effective_mcp_servers()`（`plugin/src/load_outcome.rs:150`）把所有 active 插件的 MCP server 合并进一张表。这些合并结果最终在 turn 开头被注入会话——`core/src/session/turn.rs:250` 调用 `build_skills_and_plugins`（定义在 `:758`），函数内部用 `build_plugin_injections`（`core/src/session/turn.rs:847`）把插件能力写进这一轮的 injection items。所以 skill 根不是 11.2 节里孤立配置的，而是可以"随插件"一起被带进 turn。

四条路径的关系：**插件是容器，skill 与 MCP 是内容，hooks 是介入点**。第 5 章的工具系统关注"单个工具如何被执行"；本章的 MCP 把外部工具并进同一个 `ToolRegistry`；skill 给模型"心法"；hooks 在工具前后设闸门；插件则把三者（外加 apps）作为一份可分发单元打包。理解了这条链，你就能解释"为什么 `@` 一个命令就能连上一个远程 MCP server"——它背后是插件 manifest、MCP 握手、工具注册三层叠在一起。

下一章看模型与上下文：客户端怎么跟模型对话、长会话怎么压缩、一次会话怎么被存下来重演。
