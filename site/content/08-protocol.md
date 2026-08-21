# 第 8 章：协议与 app-server——怎么把大脑变成别人能连的服务

前面所有章节基本都在这台机器"内部"转。这章往外接：IDE、桌面 app、远程控制，凭什么能驱动 Codex？答案是 `codex-protocol` + `codex-app-server` 这一层"对外协议"。

## 8.1 通用语言：`codex-protocol`

整本 guide 里被引用最多的 crate 就是它。`Op` 和 `EventMsg` 都定义在这里（`protocol/src/protocol.rs`），还有模型对象、权限类型、审批请求结构。它不依赖 core，是个纯类型/序列化层——所以 CLI、TUI、app-server、exec-server 都能共享同一套"词汇"，谁也不用 import 谁的大脑。

这种"把协议单独抽成一个无依赖 crate"的作法，是这个仓库最值得抄的设计之一：组件之间只通过协议说话，物理依赖被压成一张干净的 DAG。

## 8.2 app-server：core 的"网络前端"

第 2 章说过，`app-server`（`codex-app-server`）是常驻进程，把 `codex-core` 包成一个服务。它干的事，用一句话概括就是：

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

一个 IDE 插件想用 Codex，通常不是去 spawn 一个 `codex` 子进程然后解析它的 stdout——那样太脆。它连到 app-server 的 JSON-RPC，发 `Op`，收 `EventMsg`，再把自己的编辑器组件当成"另一个 TUI"来渲染。于是：

- 同一份 core，TUI 也好、VS Code 插件也好、桌面 app 也好，**行为一致**，因为大家吃的都是同一套事件流。
- 换前端不影响大脑，加前端也不用改 core。

这正好闭环了第 3、7 章反复强调的"界面层是 EventMsg 的视图"。

## 8.4 为什么要把"前端"也拆成进程

把 app-server 单独拆出来常驻，解决几个实际问题：

- **冷启动贵**：载模型配置、建会话、连 MCP 都要时间。常驻一份，多个前端共享。
- **多前端共存**：你在终端里开的会话，IDE 里能接着看（`codex agents` 子命令就是干这个）。
- **隔离**：前端崩了，core 不死；core 出错，前端能拿到 `EventMsg::Error` 优雅降级。

## 8.5 小结

到这里，整条链路就通了：

```text
protocol(Op/Event 定义)
   ▲              │
   │              ▼
 core ──被包成──► app-server(JSON-RPC) ──stdio/ws──► IDE / 桌面 / 远程
   │                                          
   └──工具/沙箱──► exec-server
```

协议层是"插座"，core 是"电器"，各种前端是"插头"。理解了这个图，你再看仓库里那一堆 `codex-app-server-*`、`codex-*-client` 的 crate，就只是在给这个插座做不同形状的转接头而已。

下一章，我们回头看一个贯穿始终的东西：配置系统。
