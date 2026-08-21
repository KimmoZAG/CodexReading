# 第 13 章：配置分层——一份设置怎么叠成最终值

> 深读辅助篇。建议先读完第 9 章「配置系统」，本章把它没讲透的一件事补全：一份 `model`、`approval_policy`、`sandbox_mode` 到底是怎么从多个来源合并成最终生效值的。

## 为什么配置要分层

Codex 不是只读一个 `config.toml` 就完事。同一台机器上，可能有厂商下发的托管策略（managed requirements）、有你 `~/.codex` 下的全局偏好、有当前项目仓库里 `.codex/config.toml` 的项目级覆盖，还有命令行 `--model` / `--sandbox` 这种一次性覆盖。如果这些来源互相打架，必须有一套**确定且可预期的优先级**：后加载的层覆盖先加载的层。

代码里这一层抽象叫 `ConfigLayerStack`。注意：真正把各层「拼起来」的实现在外部 crate `codex_config::loader` 中——`mod.rs` 顶部只是 `use codex_config::loader::load_config_layers_state;`（[core/src/config/mod.rs:33](../../reference/codex/codex-rs/core/src/config/mod.rs#L33)）。本仓库能看到的是调用点和对合并结果的使用，本章就以这些调用点为准。

## layer_stack 是怎么合并的

合并的入口是 `load_config_toml_with_layer_stack`，它调用 `load_config_layers_state` 拿到 `ConfigLayerStack`，再取合并后的 TOML（[core/src/config/mod.rs:1934](../../reference/codex/codex-rs/core/src/config/mod.rs#L1934)）：

```rust
let config_layer_stack = load_config_layers_state(LOCAL_FS.as_ref(), codex_home, cwd, &cli_overrides, options, ...).await?;
let merged_toml = config_layer_stack.effective_config();
```

语义上就是「内置默认 → 系统/托管 → 用户全局 → 项目级 → 命令行覆盖」自低到高叠放，合并结果 `effective_config()` 代表最终生效配置。仓库里读取某一字段时一律按这个顺序走：例如判定权限语法用的是 `config_layer_stack.layers_low_to_high()`，从低到高遍历，后面遇到的 `default_permissions` / `sandbox_mode` 不断改写前面的选择（[core/src/config/mod.rs:2453](../../reference/codex/codex-rs/core/src/config/mod.rs#L2453)）；而 `resolve_tool_suggest_config_from_layer_stack` 同样用 `layers_low_to_high()` 逐个取（[core/src/config/mod.rs:2340](../../reference/codex/codex-rs/core/src/config/mod.rs#L2340)）。`SessionFlags` 这类最高优先级层用 `layers_high_to_low().find(...)` 优先命中（[core/src/config/mod.rs:2439](../../reference/codex/codex-rs/core/src/config/mod.rs#L2439)）。一句话：**后层覆盖前层，谁离命令行最近谁说了算。**

## profile 怎么选配置

Codex 支持把配置拆成多个「profile」，按名字切换整份配置。`resolve_profile_v2_config_path` 负责把一个 `ProfileV2Name` 解析成 codex_home 下的具体文件路径（[core/src/config/mod.rs:1865](../../reference/codex/codex-rs/core/src/config/mod.rs#L1865)）：

```rust
pub fn resolve_profile_v2_config_path(codex_home: &Path, profile_name: &ProfileV2Name) -> AbsolutePathBuf {
    AbsolutePathBuf::resolve_path_against_base(format!("{profile_name}{CONFIG_PROFILE_V2_SUFFIX}"), codex_home)
}
```

它只决定「这份 profile 文件在哪」，真正加载时仍走同一套 `load_config_layers_state`——profile 文件本身也是 `ConfigLayerStack` 里的一层，所以 profile 选中的那套值，依旧要和其它层按优先级合并，而不是无条件全量替换。

## ConfigOverrides 怎么在命令行盖字段

CLI 与宿主（harness）传进来的覆盖集中在 `ConfigOverrides` 结构体里，字段全是 `Option`：从 `model`、`approval_policy`、`sandbox_mode`、`permission_profile` 到 `base_instructions`、`workspace_roots` 等等（[core/src/config/mod.rs:2512](../../reference/codex/codex-rs/core/src/config/mod.rs#L2512)）。这些覆盖在 `ConfigBuilder` 里被装配：`ConfigBuilder` 持有 `codex_home`、`cli_overrides`、`harness_overrides`（`ConfigOverrides`）、`loader_overrides` 等字段（[core/src/config/mod.rs:1319](../../reference/codex/codex-rs/core/src/config/mod.rs#L1319)），`build()` 时先 `find_codex_home()` 定位 home 目录（[core/src/config/mod.rs:4625](../../reference/codex/codex-rs/core/src/config/mod.rs#L4625)），再把 `cli_overrides` 和 `harness_overrides.cwd` 喂给 `load_config_layers_state`，叠出 `effective_config()`（[core/src/config/mod.rs:1374](../../reference/codex/codex-rs/core/src/config/mod.rs#L1374)）。`Option` 类型天然保证「没传就不盖」——只覆盖你明确指定的字段，其余字段仍由各层决定。

## 小结

回到第 9 章的视角：第 9 章讲了 `Config` 这张「最终快照」有哪些字段、`ConfigToml` 如何反序列化；本章补上它之前「忽略的半层」——**快照不是凭空来的，而是 `ConfigLayerStack` 把内置默认、托管策略、用户全局、项目级、profile、命令行覆盖按优先级合并出来的**。理解了 `load_config_toml_with_layer_stack` → `effective_config()` 这条主线，以及 `ConfigOverrides` 作为最高优先级一层的角色，你就能解释「为什么我明明改了项目里的 `config.toml` 却没生效」这类问题：多半是更高层（CLI、SessionFlags 或托管要求）把它盖掉了。
