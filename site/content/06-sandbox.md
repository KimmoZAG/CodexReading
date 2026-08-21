# 第 6 章：沙箱与安全——为什么敢让模型跑命令

模型会产出"执行 `rm -rf`"或者"改你家 SSH 密钥"这种指令。Codex 能在生产里用，靠的不是"模型很乖"，而是一整套把不可信指令关进笼子的设计。笼子和"哪些命令要你点头"的审批本来就是一套东西，这章一起讲。

## 6.1 核心思路：策略与平台分离

沙箱逻辑集中在 `codex-sandboxing`。关键抽象是：**先用一套平台无关的策略描述"能碰什么"，再翻译成具体 OS 的沙箱原语**。

这个分层在工具代码里就能看到。`apply_patch` handler 落盘前，会先去算"有效的文件系统策略"：

```rust
// core/src/tools/handlers/apply_patch.rs:50 引入沙箱策略变换（调用点在同文件 :306）
use codex_sandboxing::policy_transforms::effective_file_system_sandbox_policy; // 定义于 sandboxing/src/policy_transforms.rs:477
use codex_sandboxing::policy_transforms::merge_permission_profiles;            // 定义于 sandboxing/src/policy_transforms.rs:90
use codex_sandboxing::policy_transforms::normalize_additional_permissions;     // 定义于 sandboxing/src/policy_transforms.rs:19
```

- `effective_file_system_sandbox_policy`：把"用户配置 + 本次会话临时授予的权限 + 工具自身需要的权限"合并成一份最终策略。
- `merge_permission_profiles` / `normalize_additional_permissions`：处理"用户 @ 授权了某目录""插件声明了自己要碰的路径"这类叠加情况。

策略对象（在 `codex-protocol` 里）长这样：`FileSystemPermissions`（`protocol/src/models.rs:82`）、`AdditionalPermissionProfile`（`protocol/src/models.rs:250`）——都是"描述性"的，不关心 Linux 还是 macOS。

## 6.2 平台后端：各 OS 各显神通

同一份策略，落到不同系统上变成不同的"硬隔离"：

- **Linux**：`linux-sandbox`（用 seccomp / Landlock / namespace 之类的原语把进程关起来）。
- **macOS**：`sandbox-exec`（Apple 的 Sandbox 配置文件）。
- **Windows**：走另一套（仓库里有 `sandbox_setup` 模块专门伺候它）。

策略和"怎么执行策略"拆开之后，Linux 哪天换了更新的隔离机制，只要改后端，上层工具代码一行都不用动。

## 6.3 真正的执行发生在另一个进程

第 2 章的三进程模型里，`exec-server`（`codex-exec-server`）是真的去跑命令的那个进程，它本身也被沙箱裹着。整道闸门长这样：

![](assets/diagrams/sandbox.svg)

`core` 的工具系统先进"策略判定"：命中白名单的直接进沙箱执行；需批准的那条先发 `ExecApprovalRequest`，等你 `Op::ExecApproval` 点头，再交给 `Exec-Server` 在沙箱里 fork 一个受限子进程跑，输出经 `ExecCommandOutputDelta` 流回。

执行器和"持有你登录态、会话上下文"的 core 不在同一个进程。即便 exec-server 里的命令被注入、逃逸，它手里也没有你的 API key，能搞破坏的范围还被沙箱限死——第 2 章说的"信任边界"就是指这个。

沙箱套在 exec-server 外面的具体机制在第 10 章讲（选哪种 `SandboxType`、把策略包进 argv 都是那时发生的事）。这里只需记住：core 不自己判断"该不该限制"，它把决策结果塞进 `ExecRequest`，执行层按约定启动。

## 6.4 审批：这一步要不要你先点头

沙箱管的是环境边界——能跑什么、碰哪些文件，但它挡不住"模型想跑一个它不该跑的命令"。审批这道人工闸门补的就是这一块：有后果、可能被滥用的行为，默认都要先得到你的确认。

一次执行前，Codex 先问策略层"这条命令需不需要批准"。`core/src/exec_policy.rs:311` 的 `create_exec_approval_requirement_for_command` 把命令交给 `codex-execpolicy` 的 `Policy::check_multiple_with_options` 去匹配前缀规则——命中的 `allow` 规则意味着"这条之前已放行"，命不中且策略为 `on-request`/`on-failure` 时才会触发提问。

真"等你点头"发生在审批中枢。`core/src/tools/approvals.rs:438` 的 `Session::request_approval` 是统一入口；判定需要人工确认时，`request_user_approval`（`core/src/tools/approvals.rs:610`）封装出 `ExecApprovalRequest`，通过事件推给前端（`protocol/src/protocol.rs:1409`）。你做出选择后，前端以 `Op::ExecApproval`（`protocol/src/protocol.rs:599`，携带 `id` 与 `ReviewDecision`）回提交队列，主循环据此放行或拒绝。第 3 章那对 `submit` / `next_event` 在这里落地。

## 6.5 批准记录会被记住

会话内，Codex 用 `with_cached_approval`（`core/src/tools/sandboxing.rs:70`）维护一张 `tool_approvals` 缓存：若某 key 已是 `ReviewDecision::ApprovedForSession`，直接跳过提问。跨会话的"永久记忆"则写在 `codex-execpolicy`：你选"记住这条命令"时，`execpolicy/src/amend.rs:65` 的 `blocking_append_allow_prefix_rule` 把一条 `prefix_rule(pattern=..., decision="allow")` 追加进策略文件（`execpolicy/src/amend.rs:174` 用咨询锁去重），下次加载策略直接命中，不再打扰你。

再往上一层是**语义化审批**：模型可以提议一条 `ExecPolicyAmendment`，把"以 `cargo test` 开头的命令都允许"这样的规则写进白名单，而不是记住某个具体命令行；配合 `ReviewDecision::ApprovedExecpolicyAmendment`，你批准的是一类行为。三种机制的差别就是信任粒度：`ApprovedForSession` 只管这次会话，追加的 `allow` 前缀规则记住这条命令，`ExecPolicyAmendment` 放行的是一类命令。

上述四道防线从外到内层层套叠，整体长这样：

![Codex 安全模型四层防御](assets/diagrams/security-model.svg)

## 6.6 整条链路

> 模型产出指令 → 工具系统接住 → 沙箱策略判定能碰哪 → 要紧的先问你（审批）→ exec-server 在受限进程里真跑 → 输出回流。

Codex 的前提不是模型可信，而是模型不可信、但可以被约束住。

下一章看你眼睛看到的那一层：TUI。
