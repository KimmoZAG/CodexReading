# 第 29 章：构建系统——cargo 之外为什么还有 bazel

Codex 的 Rust 代码同时活在两套构建系统里。日常你跑 `cargo build`，而 CI 与发布却走 `bazel`。这不是重复劳动，而是同一个 cargo workspace 被两双眼睛看着：一套给开发者，一套给流水线。

## 仓库用 cargo 还是 bazel？

两者都有。cargo 是事实上的入口：`codex-rs/Cargo.toml` 的 `[workspace]` 段以 `members = [` 列出上百个 crate（aws-auth、cli、core、tui、ext/*、utils/* 等，见 `reference/codex/codex-rs/Cargo.toml:2`），`resolver = "2"`（`reference/codex/codex-rs/Cargo.toml:138`）开启新版特性解析。所有 crate 统一继承 `[workspace.package]` 里的 `edition = "2024"`（`reference/codex/codex-rs/Cargo.toml:146`），新人用 `cargo new -w` 建出的 crate 也自动拿到该 edition。bazel 并不另写一份构建描述，而是复用这份 Cargo.toml：`MODULE.bazel:269` 的 `crate.from_cargo(cargo_lock = "//codex-rs:Cargo.lock", cargo_toml = "//codex-rs:Cargo.toml", ...)` 直接读取同一份 manifest 与 lockfile，生成 bazel 侧的 crate 目标。

## workspace 怎么组织这么多 crate？

靠 `members` 的显式罗列，配合 `[workspace.dependencies]`（`reference/codex/codex-rs/Cargo.toml:149` 起）做"路径依赖集中声明"——每个内部 crate 只写 `codex-core = { path = "core" }`，版本与仓库无关的细节全部上提到 workspace 顶层。这样既避免版本漂移，也让 bazel 的 `crate.from_cargo` 能一次性拿到整张依赖图，无需逐个 crate 维护 BUILD 文件。`codex-rs/BUILD.bazel:5` 的 `filegroup(name = "workspace-files", ...)` 只是把整个 workspace 目录暴露给 bazel 沙箱，真正的 Rust 目标是 rules_rs 从 Cargo 元数据自动生成的。

## bazel 解决什么问题？

可重现构建是第一动力：bazel 用 hermetic action 与内容寻址缓存，把 C++/Swift/Rust 跨语言依赖（如 `v8`、OpenSSL、alsa）锁在同一类沙箱里。`rules_rs`（`reference/codex/MODULE.bazel:148`）提供 Rust 规则，`toolchains.toolchain(edition = "2024", version = "1.95.0")`（`reference/codex/MODULE.bazel:247`）统一工具链版本。跨语言（Rust 通过 bindgen 生成 C 绑定、调 V8）、多平台产物（10 种 target triple 列在 `crate.from_cargo` 的 `platform_triples` 中），以及 CI 的远程缓存命中率——这些都是 cargo 难以低成本提供的。cargo 关心"能不能编译"，bazel 关心"在任何机器、任何时间编译出逐字节一致的产物"。

## 日常开发用哪个？

本地 `cargo` 最顺手：增量编译快、IDE 与 rust-analyzer 友好、报错可读。bazel 留给发布、跨平台交叉产物、以及对 CI 缓存命中率敏感的场景。二者共用同一份 `Cargo.lock`，所以依赖图不会分叉——你本地 `cargo update` 之后，bazel 也会读到同一棵锁定的树。

## 小结

cargo 是开发者的方向盘，bazel 是工厂的流水线；桥接点是 `crate.from_cargo` 这位"翻译"，让同一份 workspace 既能被 `cargo` 读懂，也能被 bazel 沙箱化、缓存化、跨语言化。理解这一点，就理解了为什么改一个 crate 时你只用管 `Cargo.toml`，而发布链路却要关心 `MODULE.bazel` 里那一长串 `crate.annotation`（`reference/codex/MODULE.bazel:308`）补丁。例如仓库对 `v8`、`openssl-sys`、`aws-lc-sys` 等原生依赖都写了 annotation，把第三方 C/C++ 库通过 `inject_repo`（`reference/codex/MODULE.bazel:350`）注入，再用 `gen_build_script`（`reference/codex/MODULE.bazel:317`）控制 build script 是否重新生成——这些只在 bazel 侧有意义，cargo 用户永远不会碰到。两套系统共享源码与锁文件，分工却泾渭分明：cargo 管"写得爽"，bazel 管"造得稳"。
