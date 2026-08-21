# 第 9 章：配置系统——贯穿全程的那根线

各模块都从 `Config` 取东西：工具靠它判断特性开关，沙箱算权限，TUI 定配色。`codex-config` 就是那根把各模块串起来的线，机制核心只有一条：一份设置由多层叠加而成，读到的永远是叠完的结果。

## 9.1 配置无处不在，所以单独成 crate

`cli/src/main.rs` 顶部一大片 import 都来自 config：

```rust
// cli/src/main.rs:76
use codex_core::config::Config;
use codex_core::config::ConfigBuilder;
use codex_core::config::ConfigLoadOptions;
use codex_core::config::ConfigOverrides;
use codex_core::config::bootstrap_auth_config;
use codex_core::config::edit::ConfigEditsBuilder;
use codex_core::config::find_codex_home;
use codex_core::config::load_config_toml_with_layer_stack;
use codex_core::config::resolve_profile_v2_config_path;
```

挑几个说说它们是干嘛的：

- `find_codex_home`：定位 Codex 的配置主目录（`~/.codex` 之类）。
- `load_config_toml_with_layer_stack`：**分层加载**——系统默认、用户全局、项目级、命令行覆盖，一层层叠上去。
- `resolve_profile_v2_config_path`：Codex 支持"profile"（不同场景用不同配置），这个函数把当前 profile 解析成具体文件路径。
- `ConfigOverrides` / `CliConfigOverrides`：命令行里临时盖掉某个字段。
- `ConfigBuilder` / `ConfigEditsBuilder`：程序化地构造或修改配置。

## 9.2 "分层"是关键

`layer_stack` 是读配置代码时最该先记住的词。Codex 的配置不是单个文件，而是一叠：

![](assets/diagrams/config-layers.svg)

越靠上优先级越高。同一台机器上可能同时存在厂商下发的托管策略、`~/.codex` 下的全局偏好、项目仓库里 `.codex/config.toml` 的项目级覆盖，以及 `--model` / `--sandbox` 这种一次性覆盖。来源冲突时的规则是"后加载的层覆盖先加载的层"，于是仓库作者能提交一份项目级 codex.toml 规定沙箱白名单，用户仍可以用自己的全局配置换模型，两边不用互相妥协。读 `apply_patch.rs` 时看到的 `turn.config.features.enabled(Feature::Xxx)`，查的就是这一叠配置。

合并的入口是 `load_config_toml_with_layer_stack`，它调用 `codex_config::loader::load_config_layers_state` 拿到 `ConfigLayerStack`，再取合并后的 TOML（`core/src/config/mod.rs:1934`）：

```rust
let config_layer_stack = load_config_layers_state(LOCAL_FS.as_ref(), codex_home, cwd, &cli_overrides, options, ...).await?;
let merged_toml = config_layer_stack.effective_config();
```

语义上就是"内置默认 → 系统/托管 → 用户全局 → 项目级 → 命令行覆盖"自低到高叠放，合并结果 `effective_config()` 代表最终生效配置。仓库里读取某一字段时一律按这个顺序走：例如判定权限语法用的是 `config_layer_stack.layers_low_to_high()`，从低到高遍历，后面遇到的 `default_permissions` / `sandbox_mode` 不断改写前面的选择（`core/src/config/mod.rs:2453`）；`SessionFlags` 这类最高优先级层用 `layers_high_to_low().find(...)` 优先命中（`core/src/config/mod.rs:2439`）。规则始终是**后层覆盖前层，谁离命令行最近谁说了算**。

## 9.3 profile 怎么选配置

Codex 支持把配置拆成多个「profile」，按名字切换整份配置。`resolve_profile_v2_config_path` 负责把一个 `ProfileV2Name` 解析成 codex_home 下的具体文件路径（`core/src/config/mod.rs:1865`）：

```rust
pub fn resolve_profile_v2_config_path(codex_home: &Path, profile_name: &ProfileV2Name) -> AbsolutePathBuf {
    AbsolutePathBuf::resolve_path_against_base(format!("{profile_name}{CONFIG_PROFILE_V2_SUFFIX}"), codex_home)
}
```

它只决定"这份 profile 文件在哪"，真正加载时仍走同一套 `load_config_layers_state`——profile 文件本身也是 `ConfigLayerStack` 里的一层，所以 profile 选中的那套值，依旧要和其它层按优先级合并，而不是无条件全量替换。

## 9.4 命令行怎么盖字段

CLI 与宿主（harness）传进来的覆盖集中在 `ConfigOverrides` 结构体里，字段全是 `Option`：从 `model`、`approval_policy`、`sandbox_mode`、`permission_profile` 到 `base_instructions`、`workspace_roots` 等等（`core/src/config/mod.rs:2512`）。这些覆盖在 `ConfigBuilder` 里被装配：`ConfigBuilder` 持有 `codex_home`、`cli_overrides`、`harness_overrides`（`ConfigOverrides`）、`loader_overrides` 等（`core/src/config/mod.rs:1319`），`build()` 时先 `find_codex_home()` 定位 home 目录（`:4625`），再把 `cli_overrides` 和 `harness_overrides.cwd` 喂给 `load_config_layers_state`，叠出 `effective_config()`（`:1374`）。`Option` 类型天然保证"没传就不盖"——只覆盖你明确指定的字段，其余字段仍由各层决定。

## 9.5 特性开关：`codex-features`

很多行为不是"开/关整个功能"，而是细到某个小优化。这些由 `codex-features` 的 `Feature` 枚举管：前面见过 `ApplyPatchStreamingEvents`、`ApplyPatchPreserveLineEndings`、`CwdRelativeTurnDiffs` 等。工具代码里到处是 `if turn.config.features.enabled(Feature::Xxx)` 这种判断。

设计上这叫"用特性开关做渐进发布"：新行为先藏在开关后，默认关，验证稳了再翻默认。读代码时遇到这种 `if`，可以默认"这是实验性/可回退的行为"，不必当成核心路径死磕。

## 9.6 配置与信任边界的关系

配置和沙箱是绑定的：项目级 `codex.toml` 里写的"允许访问哪些目录、允许跑哪些命令"，正是第 6 章 `effective_file_system_sandbox_policy` 的输入之一。**配置同时是安全策略的载体**，不只是偏好——这也是它必须分层、必须能被 profile 精确控制的原因：不同项目要的信任等级不同。

## 9.7 读配置代码的建议

- 想改某行为：先 `grep` 对应的 `Feature::` 或配置字段名，逆着 `layer_stack` 找到它从哪层来。
- 想加新配置：走 `ConfigBuilder` + 在对应 `toml` 层加字段，记得同步 `codex-app-server` 那边的配置管理（`config_manager.rs` 等），因为前端也要能读写它。
- 遇到"明明改了项目里的 `config.toml` 却没生效"：多半是更高层（CLI、SessionFlags 或托管要求）把它盖掉了。
