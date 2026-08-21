# 第 16 章：MCP 接入——把外部工具接进来

## MCP 是什么

MCP（Model Context Protocol，模型上下文协议）是一套让模型「调用外部世界」的开放协议。在第 5 章我们看到，Codex 内部已经有一套工具系统（`ToolRegistry` + `dispatch_any_with_terminal_outcome`）。但内置工具是写死在代码里的，而 MCP 让运维/用户可以在不改动 Codex 源码的前提下，把任意一个遵循协议的服务端接进来，由模型像调用内置工具一样去调用它。MCP server 能向外暴露三类能力：**tools**（可被模型调用的函数）、**resources**（可被读取的数据）、**resource templates**（按模板定位的数据）。

## Codex 怎么连上一个 MCP server

连接的生命周期在 `codex-rs/codex-mcp/src/rmcp_client.rs` 的 `start_server_task` 里：它先用 `mcp_initialize_request_params` 拼出握手参数，再调用 `client.initialize(params, startup_timeout, send_elicitation)` 完成 **initialize 握手**（`codex-rs/codex-mcp/src/rmcp_client.rs:884`）。握手参数由 `mcp_initialize_request_params` 构造，声明客户端能力并固定协议版本 `ProtocolVersion::V_2025_06_18`（`codex-rs/codex-mcp/src/rmcp_client.rs:998`）。

握手成功后，紧接着调用 `list_tools_for_client_uncached` 拉取对端工具清单，内部走 `client.list_tools_with_connector_ids`，并按协议分页收集（`codex-rs/codex-mcp/src/rmcp_client.rs:610`）。resources 的列举同理，在 `codex-rs/codex-mcp/src/mcp/mod.rs:691` 的 `collect_mcp_server_status_snapshot_from_manager` 中由 `list_all_resources` / `list_all_resource_templates` 完成。

## 传输方式

传输层在 `make_rmcp_client` 里按配置分叉（`codex-rs/codex-mcp/src/rmcp_client.rs:1058`）：最常见的是 **stdio**——Codex 直接拉起一个子进程并通过其标准输入输出收发 JSON-RPC，对应 `RmcpClient::new_stdio_client_with_protocol_mode`（`:1117`）；另一种是 **Streamable HTTP**，用于远程托管的 server，对应 `new_streamable_http_client_with_protocol_mode_and_redirect_mode`（`:1150`）。stdio 之所以最普遍，是因为它无需监听端口、部署最简单，配置里一条命令即可。

## 外部工具如何并入库内工具系统

这是呼应第 5 章的关键一环。所有已连 server 的工具在 `codex-rs/codex-mcp/src/connection_manager/tool_catalog.rs:89` 的 `McpConnectionSet::list_all_tools` 里被聚合并规范化名称（默认加 `mcp__` 前缀，见 `codex-rs/codex-mcp/src/mcp/mod.rs:79` 的 `qualified_mcp_tool_name_prefix`）。聚合结果封装成 `McpBinding`，其 `tools`（模型可见声明）与 `calls`（按 server+tool 名字索引的 `PreparedMcpCall`）一起交给 core。

最终，在 `codex-rs/codex-mcp/src/../core/src/tools/spec_plan.rs:285` 的 `append_source_tools` 中，每个 MCP 工具通过 `registry.register_external_with_exposure(tool.runtime, tool.exposure)` 被注册进统一的 `ToolRegistry`（`codex-rs/core/src/tools/registry.rs:271`、`register_external` 见 `:336`）。一旦进表，模型的一次 `tool_use` 就会落到第 5 章讲过的 `ToolRegistry::dispatch_any_with_terminal_outcome`（`codex-rs/core/src/tools/registry.rs:479`）里：按名字查表、跑 PreToolUse 钩子、执行、再跑 PostToolUse 钩子——MCP 工具和内置工具走的是同一套分发与审批链路。

## 小结

MCP 把「外部能力」变成了「库内工具」：握手（`initialize`）建立会话，列举（`tools/list`、`resources/list`）拿到能力清单，stdio/HTTP 负责传输，而 `register_external*` 把外部工具并入 `ToolRegistry`，让第 5 章的工具分发系统对内置与 MCP 工具一视同仁。理解这条链路，就看懂了 Codex 工具系统最具可扩展性的那道「活水入口」。
