# 第 26 章：测试策略——这么大的仓库怎么保证不崩

Codex 是一个超大型 Rust 单体仓库（`codex-rs`）。要在持续迭代中不崩，靠的不是某一种神技，而是一套**分层的测试策略**。本章承接第 18 章「Rollout 与回放」，从单元测试、集成测试、快照测试到回放评测，逐层拆解它如何守住正确性。

## 测试分层

- **单元测试**：模块内 `#[test]`，例如 `tui/src/app/history_ui_tests.rs` 里直接构造 `history_cell` 来验证渲染契约，不依赖任何外部环境。
- **集成测试**：`core/tests/suite/` 下上百个用例，通过 `core_test_support` 提供的 `TestCodexBuilder::test_codex()`（`core/tests/common/test_codex.rs:1330`）拉起真实的 `Codex` 生命周期，覆盖工具、审批、compact 等端到端行为。
- **快照测试（insta）**：对「请求长什么样、界面长什么样」这类结构化输出做快照比对，是主力手段。
- **评测回放**：把线上 rollout 当成测试用例来回放，呼应第 18 章；如 `core/tests/suite/rollout_list_find.rs:93` 的 `find_locates_rollout_file_by_id()`，先用 `RolloutRecorder` 写出一个最小 rollout，再校验 `find_archived_thread_path_by_id_str` 的查找逻辑。

## 关键库

测试依赖集中在声明处：`core/Cargo.toml:152`（`insta`）与 `:169`（`wiremock`），TUI 侧对应 `tui/Cargo.toml:159`、`:166`。其中 `wiremock` 用于模拟 Responses API：`core/tests/common/responses.rs:1272` 的 `start_mock_server()` 返回 `MockServer`，配合 `mount_sse_once()` 注入 SSE 响应，让集成测试彻底摆脱真实网络依赖。

## 一个快照测试长什么样

看 `core/tests/suite/additional_context.rs:84`：

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

它把发给模型的请求序列化成带行号的可读文本，再与实际快照比对。快照文件 `core/tests/suite/snapshots/all__suite__additional_context__additional_context_simple_input.snap` 头部记录 `source:` 与 `expression:`，正文形如：

```
## Request
00:message/developer:<PERMISSIONS_INSTRUCTIONS>
01:message/developer:<automation_info>run one</automation_info>
02:message/user:<external_browser_info>tab one</external_browser_info>
03:message/user:inspect the active tab
```

一旦 prompt 构造逻辑变动导致文本偏移，CI 立刻变红。TUI 侧同理：`history_ui_tests.rs:12` 的 `insta::assert_snapshot!("desktop_thread_opened_history", render_cell(&cell))` 把 `HistoryCell` 渲染成 80 列文本快照，守住历史面板的排版不退步。

## 小结

Codex 的测试不是「越多越好」，而是「分层对位」：单元守住局部契约，`wiremock` 集成守住端到端行为，`insta` 快照守住输出形态，rollout 回放守住线上一致性。读懂这套分层，再看仓库里那几百个 `tests/suite/*.rs` 就不会迷路——它们都在回答同一个问题：这次改动，凭什么不崩？
