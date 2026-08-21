# 第 9 章：配置系统——贯穿全程的那根线

前面每一章几乎都顺手提到 `Config`：工具看它判断特性开关，沙箱看它算权限，TUI 看它决定配色。`codex-config` 就是那根把各模块串起来的线。这章讲清它怎么组织，免得你读源码时遇到 `ConfigBuilder`、`layer` 这类词发懵。

## 9.1 配置无处不在，所以单独成 crate

`cli/src/main.rs` 顶部一大片 import 都来自 config：

```rust
// cli/src/main.rs:74
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

最值得记住的是 `layer_stack` 这个词。Codex 的配置不是单个文件，而是一叠：

```text
内置默认值
   ▲ 被覆盖
系统级配置
   ▲ 被覆盖
用户全局 (~/.codex)
   ▲ 被覆盖
项目级 (仓库里的 codex.toml)
   ▲ 被覆盖
命令行覆盖 (--profile=..., -c key=value)
```

越靠上优先级越高。这意味着同一个仓库里，作者可以提交一份"项目级 codex.toml"规定沙箱白名单，用户又能用自己的全局配置调模型，互不打架。读 `apply_patch.rs` 时看到的 `turn.config.features.enabled(Feature::Xxx)`，就是在这一叠配置上查开关。

## 9.3 特性开关：`codex-features`

很多行为不是"开/关整个功能"，而是细到某个小优化。这些由 `codex-features` 的 `Feature` 枚举管：前面见过 `ApplyPatchStreamingEvents`、`ApplyPatchPreserveLineEndings`、`CwdRelativeTurnDiffs` 等。工具代码里到处是 `if turn.config.features.enabled(Feature::Xxx)` 这种判断。

设计上这叫"用特性开关做渐进发布"：新行为先藏在开关后，默认关，验证稳了再翻默认。读代码时遇到这种 `if`，可以默认"这是实验性/可回退的行为"，不必当成核心路径死磕。

## 9.4 配置与信任边界的关系

配置和沙箱是绑定的：你在项目级 `codex.toml` 里写的"允许访问哪些目录、允许跑哪些命令"，正是第 6 章 `effective_file_system_sandbox_policy` 的输入之一。所以**配置不只是偏好，更是安全策略的载体**——这也是为什么它要分层、要能被 profile 精确控制：不同项目想要不同的"信任等级"。

## 9.5 读配置代码的建议

- 想改某行为：先 `grep` 对应的 `Feature::` 或配置字段名，逆着 `layer_stack` 找到它从哪层来。
- 想加新配置：走 `ConfigBuilder` + 在对应 `toml` 层加字段，记得同步 `codex-app-server` 那边的配置管理（`config_manager.rs` 等），因为前端也要能读写它。

到此，九个核心章节讲完了。下一篇（收尾）给你一张"接下去自己怎么读"的路线图。
