# 第 23 章：协议与类型生成——一份定义怎么同时喂给 Rust 和 TS

第 8 章讲过 `codex-protocol` 是整个仓库的「通用语言」：`Op`、`EventMsg`、权限与审批类型都在这里，不依赖 core，谁都能 import。本章补上第 8 章没展开的另一半：这套语言不只给 Rust 用，它还会被**编译成 TypeScript**，给 IDE 插件、桌面前端、SDK 直接消费。同一个 struct，一处定义，两边编译。

## 为什么协议必须单独成 crate

`protocol/README.md:3` 把定位写得很直白：这个 crate 定义 Codex CLI 协议的「类型」，既包含 `codex-core` 与 `codex-tui` 之间的内部类型，也包含 `codex app-server` 对外暴露的外部类型；紧接着 `protocol/README.md:5` 要求它「依赖尽可能少」，`protocol/README.md:7` 更进一步说不要在这里放实质业务逻辑，要加行为就用 `Ext` trait 在别的 crate 里加。

原因到这一章才彻底清楚：一旦协议 crate 混进业务逻辑或重依赖，它就没法作为 codegen 的输入了。类型生成器要能在不拖起半个引擎的前提下遍历所有类型定义。`protocol/src/lib.rs:40` 把 `pub mod protocol;` 摊开导出，`protocol/src/lib.rs:19`、`protocol/src/lib.rs:38` 再导出 `config_types`、`permissions`——这些模块全都是「可被生成」的纯数据。

## 怎么做到 Rust 与前端共享同一套类型

靠 `ts-rs`。`protocol/Cargo.toml:44` 把它列为正式依赖并打开 `uuid-impl`、`serde-json-impl`、`no-serde-warnings` 三个 feature；`protocol/src/protocol.rs:76` 一行 `use ts_rs::TS;`，之后所有对外类型的 derive 列表里都多挂一个 `TS`。

几个真实例子：

- `protocol/src/protocol.rs:173` 的 `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema, TS)]` 配上 `protocol/src/protocol.rs:175` 的 `#[ts(type = "string")]`，让 `protocol/src/protocol.rs:176` 的 newtype `pub struct GitSha(pub String)` 在 TS 侧就是一个裸 `string`，不会变成 `{ 0: string }` 这种丑东西。
- `protocol/src/protocol.rs:201` 的 `W3cTraceContext` 用 `protocol/src/protocol.rs:204` 和 `protocol/src/protocol.rs:207` 的 `#[ts(optional)]`，把 Rust 的 `Option<String>` 映射成 TS 的 `traceparent?: string`——而不是 `string | null`。
- 最关键的 `EventMsg`（`protocol/src/protocol.rs:1288`）在 `protocol/src/protocol.rs:1284` 同时 derive 了 `JsonSchema` 和 `TS`，并用 `protocol/src/protocol.rs:1285` 的 `#[serde(tag = "type", rename_all = "snake_case")]` 与 `protocol/src/protocol.rs:1286` 的 `#[ts(tag = "type")]` 保持一致：序列化用的判别字段和 TS 判别联合的判别字段是同一个 `type`。

输出目录不是通过 `build.rs` 配的——`protocol/` 下并没有 `build.rs`，全仓也搜不到 `TS_RS_EXPORT_DIR`。真正的目录信息写在属性里：`protocol/src/protocol.rs:3809` 的 `#[ts(export_to = "protocol/")]`（作用于 `ThreadGoalStatus`）、`protocol/src/protocol.rs:3835` 的同款属性（作用于 `ThreadGoal`），以及 `protocol/src/capabilities.rs:11` 的 `#[ts(export_to = "v2/")]`。

真正把这些属性「跑起来」的是隔壁 crate：`app-server-protocol/src/export.rs:113` 的 `generate_ts_with_options`，里面 `app-server-protocol/src/export.rs:122` 到 `app-server-protocol/src/export.rs:129` 依次调用 `ClientRequest::export_all_to(out_dir)`、`ServerNotification::export_all_to(out_dir)` 等，`export_all_to` 会连带把依赖的类型全部写出，再由 `app-server-protocol/src/export.rs:136` 的 `generate_index_ts` 生成 barrel 文件、`app-server-protocol/src/export.rs:43` 的 `GENERATED_TS_HEADER` 给每个文件盖上 `// GENERATED CODE! DO NOT MODIFY BY HAND!`。入口则是 CLI 子命令：`cli/src/main.rs:1354` 的 `AppServerSubcommand::GenerateTs` 收下 `--out DIR`，在 `cli/src/main.rs:1359` 调用生成函数（用法见 `app-server/README.md:62`）。

## 一处定义、两边编译的好处

第一，**漂移在编译期就被抓住**。前端拿到的 `.ts` 是从 Rust 结构体推导出来的，字段改名、少个变体，TS 侧立刻红。第二，**序列化语义只有一份**：`#[serde(...)]` 与 `#[ts(...)]` 并排放在同一个类型头上，改 wire 格式时不可能只改一半。第三，**多目标复用**：同一批类型还 derive 了 `JsonSchema`（`protocol/Cargo.toml:34` 的 `schemars`），于是同一份定义能同时产出 TS 与 JSON Schema。第四，**分发成本低**：`app-server-protocol/src/precomputed_exports.rs:15` 与 `app-server-protocol/src/precomputed_exports.rs:17` 把稳定版与实验版的导出结果打成 zstd 压缩包 `include_bytes!` 进二进制，用户执行 generate 时不需要重新编译整棵类型树。

## 小结

第 8 章说 protocol 是「通用语言」，本章给出了这句话的字面实现：语言的语法由 Rust 类型定义，`ts-rs` 的 `TS` derive 是它的翻译器，`export_all_to` 是它的印刷机，`codex app-server generate-ts` 是它的发行渠道。协议 crate 之所以要保持零业务逻辑、极少依赖，正是因为它得同时充当运行时类型和 codegen 的源文件——只有把词典和字典排版分开，插座才可能既插得上 Rust，也插得上 TypeScript。
