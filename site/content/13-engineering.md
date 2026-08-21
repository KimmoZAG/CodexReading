# 第 13 章：工程化——鉴权、错误处理、测试、构建与分发

这章换工程视角：最高危的密钥怎么管、出错怎么优雅降级、这么大的仓库怎么保证不崩、又怎么构建和装到你机器上。这几件事撑起了"能放心交付"的底线。

先放一张全局架构图，方便把鉴权、错误处理、测试、构建这些工程子系统对准到各自的进程与 crate 上：

![](assets/diagrams/overview.svg)

CLI 薄壳之下，Core 常驻于 App-Server，Exec-Server 独立在信任边界内——后面每节工程机制都落在这几个进程之上。

## 13.1 登录与鉴权：API key 从哪来、存在哪

API key、access token、refresh token 是 Codex 最高危的资产：它等同于你的账号身份，一旦泄露，攻击者可冒用配额、读取会话历史。这也正是第 2 章进程模型与第 6 章沙箱反复强调的**信任边界**——沙箱挡得住命令执行，却挡不住已经合法签发的密钥被读取或外传。

Codex 同时存在两条登录路径。交互式登录走 OAuth device code 流程：`run_device_code_login` 先 `request_device_code` 拿到一次性 `user_code` 与 `verification_url`，用户在浏览器确认后由 `poll_for_token` 轮询换取授权码，再 `exchange_code_for_tokens` 得到 id/access/refresh token（`login/src/device_code_auth.rs:234`、`login/src/device_code_auth.rs:100`）。非交互场景则可直接用 `login_with_api_key` 注入一个现成 key（`login/src/lib.rs:56`）。运行时也可经 `read_codex_access_token_from_env` 从环境变量 `CODEX_ACCESS_TOKEN` 读取，优先级高于落盘文件（`login/src/auth/manager.rs:905`）。

拿到 token 后，`persist_tokens_async` 写入 `CODEX_HOME/auth.json`（`login/src/server.rs:886`）；其结构由 `AuthDotJson` 定义，包含 `openai_api_key`、`tokens`、`personal_access_token` 等字段（`login/src/auth/storage.rs:40`）。`CODEX_HOME` 本身由 `find_codex_home` 决定，默认 `~/.codex`，可被同名环境变量覆盖（`core/src/config/mod.rs:4625`）。启用 secret storage 时还会尝试写入系统 keyring，落盘 `auth.json` 只是兜底（`login/src/auth/storage.rs:151`）。登出时则走 `logout_with_revoke`：先吊销服务端 refresh token，再删除本地 `auth.json`，避免"服务端还有效、本地已删"的悬空状态（`login/src/lib.rs:59`）。

在完整 `Config` 就绪前，cli 通过 `bootstrap_auth_config` 用本地 bootstrap 配置先拼出 `AuthConfig`（`core/src/config/auth_keyring.rs:39`）。这套配置呼应第 9 章的配置解析：鉴权是配置最早被消费的部分之一。`AuthManager` 是 `auth.json` 派生的唯一真相源（`login/src/auth/manager.rs:1991`），它对外提供当前有效的 token/key。第 12 章的模型客户端正是从这里取凭证，把它塞进通往模型网关的 HTTP 头——也就是说，鉴权不是"模型客户端自己想办法"，而是上游统一签发、下游只消费。

鉴权链可概括为四步：**登录签发**（`request_device_code`/`login_with_api_key`）→ **本地落盘**（`auth.json`）→ **启动组装**（`bootstrap_auth_config`）→ **注入客户端**（`AuthManager` 供模型客户端取用）。把最高危的密钥交给单一可信模块管理，正是 Codex 守住信任边界的方式。

## 13.2 错误处理：CodexResult 与出错时的优雅降级

Codex 的运行链路上，模型客户端、工具执行、沙箱、鉴权、配置解析都可能失败，且分属不同 crate。若任由 `io::Error`、`serde_json::Error`、`HttpError` 各自上抛，调用方根本无法做统一决策。因此 protocol 层定义了一个唯一的错误类型 `CodexErr`，并把结果类型统一为 `pub type Result<T> = std::result::Result<T, CodexErr>`（`protocol/src/error.rs:30`）——这就是第 3 章公共 API 里 `CodexResult` 的真身。`CodexErr` 本身很薄，只包了两样东西：语义化的 `details: CodexErrorDetails` 和一个可选的 `retry_delay: Option<Duration>`（`protocol/src/error.rs:70`），前者归类、后者携带退避策略，便于上层判断"能不能重试"而不关心底层细节。

真正用于分类的是 `pub enum CodexErrorDetails`（`protocol/src/error.rs:81`），它枚举了上下文超限、连接失败、沙箱拒绝、配额耗尽、策略违规等几十种情形。是否可重试由一个方法集中裁决：`pub fn is_retryable(&self) -> bool`（`protocol/src/error.rs:364`）。例如 `Stream`、`Timeout`、`ConnectionFailed`、`Io`、`Json` 等被标记为 `true`，主循环据此自动退避重试；而 `TurnAborted`、`ContextWindowExceeded`、`UsageLimitReached`、`Sandbox` 等返回 `false`，属终态错误，必须由用户或流程收尾。还有一类"用户可恢复"的并非走 `CodexErr`，而是第 6 章的审批流（如 `ExecApprovalRequest`）——它们以事件而非错误的形式交还用户决策，避免把"等用户点同意"误判成失败。

错误不会原地崩溃，而是被翻译成协议层的客户端可理解结构。`CodexErr::to_error_event`（`protocol/src/error.rs:458`）先 `to_string` 拿到人类可读消息，再调用 `to_codex_protocol_error` 把内部 `CodexErrorDetails` 映射成线协议枚举 `pub enum CodexErrorInfo`（`protocol/src/protocol.rs:1771`，如 `ContextWindowExceeded`、`SandboxError`、`Unauthorized`），最终产出 `pub struct ErrorEvent { message, codex_error_info }`（`protocol/src/protocol.rs:1937`）。该事件被包进 `EventMsg::Error(ErrorEvent)`（`protocol/src/protocol.rs:1290`），经由第 3 章的事件队列推送至 TUI / app-server，UI 据此既展示文案也能按 `codex_error_info` 做针对性提示。

进入第 4 章的 `run_turn` 主循环后，终态错误有专门的出口。循环对 `Err` 逐一 `matches!(err.details(), CodexErrorDetails::TurnAborted)`（`core/src/session/turn.rs:216`），把"被中断/中止"与"真正的硬失败"区分开：普通终态错误会再走一次 `to_error_event` 发 `EventMsg::Error`（`turn.rs:580`）后结束本轮；而 `TurnAborted` 则发出 `EventMsg::TurnAborted`，让线程保留状态、等待用户下一条输入，实现"优雅降级"而非进程退出。可重试错误则在上游就被拦截、按 `retry_delay` 退避重投，用户几乎无感。

## 13.3 测试策略：这么大的仓库怎么保证不崩

Codex 是个超大型 Rust 单体仓库（`codex-rs`）。要在持续迭代中不崩，靠的是一套**分层的测试策略**：

- **单元测试**：模块内 `#[test]`，例如 `tui/src/app/history_ui_tests.rs` 里直接构造 `history_cell` 来验证渲染契约，不依赖任何外部环境。
- **集成测试**：`core/tests/suite/` 下上百个用例，通过 `core_test_support` 提供的 `TestCodexBuilder::test_codex()`（`core/tests/common/test_codex.rs:1330`）拉起真实的 `Codex` 生命周期，覆盖工具、审批、compact 等端到端行为。
- **快照测试（insta）**：对"请求长什么样、界面长什么样"这类结构化输出做快照比对，是主力手段。
- **评测回放**：把线上 rollout 当成测试用例来回放，呼应第 12 章；如 `core/tests/suite/rollout_list_find.rs:93` 的 `find_locates_rollout_file_by_id()`，先用 `RolloutRecorder` 写出一个最小 rollout，再校验 `find_archived_thread_path_by_id_str` 的查找逻辑。

测试依赖集中在声明处：`core/Cargo.toml:152`（`insta`）与 `:169`（`wiremock`），TUI 侧对应 `tui/Cargo.toml:159`、`:166`。其中 `wiremock` 用于模拟 Responses API：`core/tests/common/responses.rs:1272` 的 `start_mock_server()` 返回 `MockServer`，配合 `mount_sse_once()` 注入 SSE 响应，让集成测试彻底摆脱真实网络依赖。

看一个快照测试（`core/tests/suite/additional_context.rs:84`）：

```rust
insta::assert_snapshot!(
    "additional_context_simple_input",
    context_snapshot::format_labeled_requests_snapshot(
        "additional context is inserted before the user turn input.",
        &[("Request", &request)],
        &ContextSnapshotOptions::default()
            .strip_capability_instructions()
            .render_mode(ContextSnapshotRenderMode::KindWithTextPrefix { max_chars: 160 }),
    )
);
```

它把发给模型的请求序列化成带行号的可读文本，再与实际快照比对。快照文件头部记录 `source:` 与 `expression:`，正文形如：

```text
## Request
00:message/developer:<PERMISSIONS_INSTRUCTIONS>
01:message/developer:<automation_info>run one</automation_info>
02:message/user:<external_browser_info>tab one</external_browser_info>
03:message/user:inspect the active tab
```

一旦 prompt 构造逻辑变动导致文本偏移，CI 立刻变红。TUI 侧同理：`history_ui_tests.rs:12` 的 `insta::assert_snapshot!("desktop_thread_opened_history", render_cell(&cell))` 把 `HistoryCell` 渲染成 80 列文本快照，守住历史面板的排版不退步。

Codex 的测试不是"越多越好"，而是"分层对位"：单元测试守住局部契约，`wiremock` 集成守住端到端行为；`insta` 快照看输出形态有没有漂，rollout 回放确保线上一致。

## 13.4 构建系统：cargo 之外为什么还有 bazel

Codex 的 Rust 代码同时活在两套构建系统里。日常你跑 `cargo build`，而 CI 与发布却走 `bazel`。这不是重复劳动，而是同一个 cargo workspace 被两双眼睛看着：一套给开发者，一套给流水线。

cargo 是事实上的入口：`codex-rs/Cargo.toml` 的 `[workspace]` 段以 `members = [` 列出上百个 crate（`Cargo.toml:2`），`resolver = "2"`（`Cargo.toml:138`）开启新版特性解析。所有 crate 统一继承 `[workspace.package]` 里的 `edition = "2024"`（`Cargo.toml:146`）。bazel 并不另写一份构建描述，而是复用这份 Cargo.toml：`MODULE.bazel:269` 的 `crate.from_cargo(cargo_lock = "//codex-rs:Cargo.lock", cargo_toml = "//codex-rs:Cargo.toml", ...)` 直接读取同一份 manifest 与 lockfile，生成 bazel 侧的 crate 目标。

靠 `members` 的显式罗列，配合 `[workspace.dependencies]`（`Cargo.toml:149` 起）做"路径依赖集中声明"——每个内部 crate 只写 `codex-core = { path = "core" }`，版本与仓库无关的细节全部上移到 workspace 顶层。这样既避免版本漂移，也让 bazel 的 `crate.from_cargo` 能一次性拿到整张依赖图。`codex-rs/BUILD.bazel:5` 的 `filegroup(name = "workspace-files", ...)` 只是把整个 workspace 目录暴露给 bazel 沙箱，真正的 Rust 目标是 rules_rs 从 Cargo 元数据自动生成的。

bazel 解决的是可重现构建：用 hermetic action 与内容寻址缓存，把 C++/Swift/Rust 跨语言依赖（如 `v8`、OpenSSL、alsa）锁在同一类沙箱里。`rules_rs`（`MODULE.bazel:148`）提供 Rust 规则，`toolchains.toolchain(edition = "2024", version = "1.95.0")`（`MODULE.bazel:247`）统一工具链版本。跨语言（Rust 通过 bindgen 生成 C 绑定、调 V8）、多平台产物（10 种 target triple 列在 `crate.from_cargo` 的 `platform_triples` 中），以及 CI 的远程缓存命中率——这些都是 cargo 难以低成本提供的。cargo 关心"能不能编译"，bazel 关心"在任何机器、任何时间编译出逐字节一致的产物"。

本地 `cargo` 最顺手：增量编译快、IDE 与 rust-analyzer 友好、报错可读。bazel 留给发布、跨平台交叉产物、以及对 CI 缓存命中率敏感的场景。二者共用同一份 `Cargo.lock`，所以依赖图不会分叉。

## 13.5 安装与分发：codex 二进制怎么到你机器上

用户装 codex 大体有三条路：其一，运行官方安装脚本（macOS/Linux 用 `curl -fsSL https://chatgpt.com/codex/install.sh | sh`，Windows 用 `install.ps1`），这也是脚本本身推荐的 "standalone" 方式；其二，用包管理器全局安装 `npm install -g @openai/codex`，`bun` / `pnpm` 同理，或 macOS 上 `brew install --cask codex`；其三，让 codex 自己更新自己，即 `codex update` 子命令。

安装脚本 `scripts/install/install.sh` 干的事可以拆开看。`resolve_release` 先把 `latest` 或指定的 `x.y.z` 版本归一化，优先从 `releases.openai.com` 拉取 `release.json` 元数据，失败再回退 GitHub Releases。真正把文件搬回来的是 `download_file`（`scripts/install/install.sh:103`），它优先用 `curl`，没有就退 `wget`，并会校验 SHA-256 摘要（`verify_archive_digest`）。下载到的是 `codex-package-<target>.tar.gz` 归档，`install_package_release`（`scripts/install/install.sh:935`）把它解包到 `~/.codex/packages/standalone/releases/<version>-<target>/`，并对 `bin/codex` 等做 `chmod 0755`。

"放 PATH" 由 `update_current_link`（`scripts/install/install.sh:1025`）与 `update_visible_command` 完成：脚本在 releases 目录里维护一个 `current` 软链指向当前版本目录，再把 `$HOME/.local/bin/codex` 这个可见命令软链到 `current/bin/codex`。`add_to_path`（`scripts/install/install.sh:585`）负责把 `$HOME/.local/bin` 写进 shell 的 profile（`~/.zshrc` / `~/.bashrc` 等），用 `# >>> Codex installer >>>` 标记块避免重复写入。

自更新怎么实现？关键不在脚本，而在 Rust 侧。`cli/src/main.rs:883` 的 `run_update_command()` 调用 `codex_tui::get_update_action()`；后者在 `tui/src/update_action.rs:76` 通过 `InstallContext::current()`（`install-context/src/lib.rs:119`）反查"我是怎么被装上的"。`install_method_from_exe`（`install-context/src/lib.rs:273`）顺着可执行文件路径判断：在 `~/.codex/packages/standalone` 下即 `Standalone`，在 `/opt/homebrew` 下即 `Brew`。拿到方法后，`command_args()`（`tui/src/update_action.rs:42`）返回对应命令——standalone 就重跑一遍安装脚本，npm 就 `npm install -g @openai/codex`。所以自更新本质是"按当初的安装方式再跑一次安装流程"，而非二进制内原地 patch。

## 13.6 小结

工程化这几块看着散，但都围着"可信、可测、可交付"：鉴权把最高危的密钥收进单一模块（13.1），错误处理把跨 crate 的失败统一成可重试/终态的 `CodexErr` 并降级为 `EventMsg::Error`（13.2），分层测试守住"这次改动凭什么不崩"（13.3），cargo/bazel 双构建系统兼顾写代码爽和造得稳（13.4），而脚本+元数据模型让安装与自更新保持幂等（13.5）。读到这，你对 Codex 从源码到用户机器的全链路就有谱了。
