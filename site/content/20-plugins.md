# 第 20 章：插件系统——把 Skill/MCP/命令打包分发

前面第 15 章讲了 Skill，第 16 章讲了 MCP。两者都是"能力"，但都靠用户手动在配置里一个个写。插件系统解决的是**分发**问题：把 skill、MCP server、slash 命令（app）、hook 一起打成一份可安装、可升级、可下发的包。

## Plugin 是什么

一个插件（Plugin）是一份"能力包"，一次加载就能同时贡献四类东西：

- **skills**：插件自带的一组技能根目录；
- **mcp_servers**：插件声明要启动的 MCP server；
- **apps**：插件的 slash 命令 / 应用入口（即用户 `@` 提到的 connector）；
- **hooks**：插件的事件钩子。

加载完成后，会话对每个插件生成一个能力摘要 `PluginCapabilitySummary`，字段直接列出了 `has_skills` 与 `mcp_server_names`，见 `plugin/src/lib.rs:49`：

```rust
pub struct PluginCapabilitySummary {
    pub config_name: String,
    pub display_name: String,
    pub plugin_namespace: Option<String>,
    pub description: Option<String>,
    pub has_skills: bool,
    pub mcp_server_names: Vec<String>,
    pub app_connector_ids: Vec<AppConnectorId>,
}
```

注意它把 skill、MCP、app 统一收进一个摘要——这正是"打包分发"在数据上的体现。

## 插件怎么声明

插件内容由一份 manifest 描述。解析结果是泛型模型 `PluginManifest<Resource>`，其中真正决定"装了什么"的是 `PluginManifestPaths`（`plugin/src/manifest.rs:18`）：

```rust
pub struct PluginManifestPaths<Resource> {
    pub skills: Vec<Resource>,
    pub mcp_servers: Option<PluginManifestMcpServers<Resource>>,
    pub apps: Option<Resource>,
    pub hooks: Option<PluginManifestHooks<Resource>>,
}
```

`Resource` 在宿主（host）侧是绝对路径，在远程解析后换成带 authority 的 locator。换言之，manifest 里写的是 paths/objects，加载器负责把它们映射成实际资源。`interface` 字段（`plugin/src/manifest.rs:42`）则承载展示用的名称、描述、图标等元信息——这是"可分发"必须的门面，否则用户在一个 marketplace 列表里分不清谁是谁。

## 怎么被加载进会话

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

每个插件落地成一个 `LoadedPlugin`（`plugin/src/load_outcome.rs:19`），它带着 `skill_roots`、`mcp_servers`、`apps`、`hook_sources`。多个插件汇总成 `PluginLoadOutcome`，并通过两个"effective"方法把全量能力拍平：

- `effective_plugin_skill_roots()`（`plugin/src/load_outcome.rs:123`）——所有 active 插件的 skill 根，按 namespace 合并去重；
- `effective_mcp_servers()`（`plugin/src/load_outcome.rs:150`）——所有 active 插件的 MCP server 合并进一张表。

**呼应第 5/15 章**：这些合并结果最终在 turn 开头被注入会话。`core/src/session/turn.rs:250` 调用了 `build_skills_and_plugins`，其定义在 `core/src/session/turn.rs:758`；函数内部用 `build_plugin_injections`（`core/src/session/turn.rs:847`）把插件能力写进这一轮的 injection items。也就是说，skill 根不是第 15 章里孤立配置的，而是可以"随插件"一起被带进 turn。

## 与第 15 章、第 16 章的关系

一句话：**插件是容器，skill 与 MCP 是内容**。

- 第 15 章的 skill 系统关注"单个 skill 如何被发现、注入、执行"；插件提供的是"一批 skill + 它们的命名空间"作为分发单元，`effective_plugin_skill_roots` 正是把插件维度接回 skill 系统的桥。
- 第 16 章的 MCP 关注"如何连上一个 MCP server"；插件把 MCP server 声明内联进 manifest，`effective_mcp_servers` 把它们并进会话的 connector 快照，于是插件的 `@` 命令就能直接驱动这些 server。

所以第 15、16 章是"能力本身"，本章是"能力的打包与分发层"。

## 小结

插件 = manifest 声明的 skills + MCP servers + apps(slash 命令) + hooks，经 `load_plugins_from_layer_stack` 加载成 `LoadedPlugin`，再经 `PluginLoadOutcome` 的 `effective_*` 合并，`build_skills_and_plugins` 在每轮把结果注入会话。它把第 15 章的 skill 与第 16 章的 MCP 从"零散配置"升级成"可安装的能力包"，是 Codex 做能力生态分发的核心机制。
