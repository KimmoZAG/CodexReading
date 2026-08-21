# 第 8 章：协议与 app-server——怎么把大脑变成别人能连的服务

IDE、桌面 app、远程控制都通过两层对外接口驱动 Codex：`codex-protocol` 定义词汇，`codex-app-server` 把词汇搬到跨进程的 JSON-RPC 上。

## 8.1 通用语言：`codex-protocol`

`Op` 和 `EventMsg` 都定义在 `protocol/src/protocol.rs`，模型对象、权限类型、审批请求结构也在这里。它不依赖 core，是个纯类型/序列化层——CLI、TUI、app-server、exec-server 因此能共享同一套词汇，谁也不用 import 谁的大脑。

`Op`/`EventMsg` 在各组件之间的流动：

![](assets/diagrams/dataflow.svg)

把协议抽成一个无依赖 crate，是 codex-rs 最值得抄的设计之一：组件之间只通过协议说话，物理依赖被压成一张干净的 DAG。

`protocol/README.md:3` 把定位写得很直白：它定义 Codex CLI 协议的"类型"，既包含 `codex-core` 与 `codex-tui` 之间的内部类型，也包含 `codex app-server` 对外暴露的外部类型；要求"依赖尽可能少"（`:5`），且不要在这里放实质业务逻辑，要加行为就用 `Ext` trait 在别的 crate 里加（`:7`）。约束这么严的理由在 8.4 节：协议 crate 一旦混进业务逻辑或重依赖，就当不了 codegen 的输入。

## 8.2 app-server：core 的"网络前端"

`app-server`（`codex-app-server`）是常驻进程，把 `codex-core` 包成一个服务（第 2 章）。它干的活只有一件：

> 把"本地的方法调用 `submit(Op)` / `next_event()`"翻译成"跨进程/跨网络的 JSON-RPC 请求和响应"。

对外契约在 `codex-app-server-protocol`，传输层在 `codex-app-server-transport`。仓库里能看到典型的 RPC 组织方式：

```text
codex-app-server-protocol/
    rpc.rs              # RPC 方法定义
    protocol/           # 请求/响应类型
    experimental_api.rs # 还在试验期的接口
codex-app-server-transport/
    transport/          # stdio / websocket 等传输实现
    outgoing_message.rs
```

`cli/src/main.rs` 里 import 的 `codex_app_server_daemon` 那几个类型——`BootstrapOptions`（`cli/src/main.rs:6`）、`LifecycleCommand`（`cli/src/main.rs:7`）、`RemoteControlMode`（`cli/src/main.rs:8`）——说明：app-server 既可以随 CLI 临时起来，也能作为一个**独立 daemon** 常驻，供 `codex agents`（浏览所有会话）、`codex remote-control`（远程控制）这类子命令接入。

## 8.3 IDE 集成就走这条线

IDE 插件用 Codex，通常不是 spawn 一个 `codex` 子进程再解析它的 stdout——那样太脆。它连到 app-server 的 JSON-RPC，发 `Op`，收 `EventMsg`，把自己的编辑器组件当成"另一个 TUI"来渲染。于是 TUI、VS Code 插件、桌面 app 吃的都是同一份事件流，行为不用各自对齐；换前端不影响大脑，加前端也不用改 core。第 3、7 章那句"界面层是 EventMsg 的视图"，在这里适用于所有前端。

把 app-server 单独拆出来常驻，解决三个实际问题：

- **冷启动贵**：载模型配置、建会话、连 MCP 都要时间。常驻一份，多个前端共享。
- **多前端共存**：你在终端里开的会话，IDE 里能接着看（`codex agents` 子命令就是干这个）。
- **隔离**：前端崩了，core 不死；core 出错，前端能拿到 `EventMsg::Error` 优雅降级。

## 8.4 一套类型，两边编译：TypeScript 生成

协议里的类型不只给 Rust 用，它们还会被**编译成 TypeScript**，交给 IDE 插件、桌面前端、SDK 直接消费——同一个 struct 定义一次，Rust 和 TS 两边共用。这就是 8.1 节那条"零业务逻辑、极少依赖"约束的来由。

靠的是 `ts-rs`。`protocol/Cargo.toml:44` 把它列为正式依赖并打开 `uuid-impl`、`serde-json-impl`、`no-serde-warnings` 三个 feature；`protocol/src/protocol.rs:76` 一行 `use ts_rs::TS;`，之后所有对外类型的 derive 列表里都多挂一个 `TS`。

几个真实例子：

- `protocol/src/protocol.rs:173` 的 `#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, JsonSchema, TS)]` 配上 `:175` 的 `#[ts(type = "string")]`，让 `:176` 的 newtype `pub struct GitSha(pub String)` 在 TS 侧就是一个裸 `string`，不会变成 `{ 0: string }` 这种丑东西。
- `protocol/src/protocol.rs:201` 的 `W3cTraceContext` 用 `:204`、`:207` 的 `#[ts(optional)]`，把 Rust 的 `Option<String>` 映射成 TS 的 `traceparent?: string`——而不是 `string | null`。
- 最关键的 `EventMsg`（`protocol/src/protocol.rs:1288`）在 `:1284` 同时 derive 了 `JsonSchema` 和 `TS`，并用 `:1285` 的 `#[serde(tag = "type", rename_all = "snake_case")]` 与 `:1286` 的 `#[ts(tag = "type")]` 保持一致：序列化用的判别字段和 TS 判别联合的判别字段是同一个 `type`。

输出目录不是通过 `build.rs` 配的——`protocol/` 下并没有 `build.rs`，全仓也搜不到 `TS_RS_EXPORT_DIR`。真正的目录信息写在属性里：`protocol/src/protocol.rs:3809` 的 `#[ts(export_to = "protocol/")]`、`protocol/src/capabilities.rs:11` 的 `#[ts(export_to = "v2/")]` 等。

真正把这些属性"跑起来"的是隔壁 crate：`app-server-protocol/src/export.rs:113` 的 `generate_ts_with_options`，里面 `:122`–`:129` 依次调用 `ClientRequest::export_all_to(out_dir)`、`ServerNotification::export_all_to(out_dir)` 等，`export_all_to` 会连带把依赖的类型全部写出，再由 `:136` 的 `generate_index_ts` 生成 barrel 文件、`:43` 的 `GENERATED_TS_HEADER` 给每个文件盖上 `// GENERATED CODE! DO NOT MODIFY BY HAND!`。入口是 CLI 子命令：`cli/src/main.rs:1354` 的 `AppServerSubcommand::GenerateTs` 收下 `--out DIR`，在 `:1359` 调用生成函数。

这么做最实际的好处是漂移在编译期就暴露：前端拿到的 `.ts` 从 Rust 结构体推导而来，字段改名、少个变体，TS 侧立刻红。序列化语义也只有一份——`#[serde(...)]` 与 `#[ts(...)]` 并排挂在同一个类型头上，改 wire 格式时没法只改一半。同一批类型顺带 derive 了 `JsonSchema`，一份定义能同时产出 TS 与 JSON Schema。分发成本也压下来了：`app-server-protocol/src/precomputed_exports.rs:15`、`:17` 把稳定版与实验版的导出打成 zstd 压缩包 `include_bytes!` 进二进制，用户执行 generate 时不必重新编译整棵类型树。

## 8.5 小结

`codex-protocol` 出词汇，app-server 把 `submit/next_event` 翻成 JSON-RPC 并常驻，`ts-rs` 把同一份定义送进 TypeScript。协议 crate 既是运行时类型又是 codegen 的源文件，因此它必须保持零业务逻辑、极少依赖——它一重，整条对外链路都跟着重。
