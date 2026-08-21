# 第 21 章：审批策略——哪些命令要你点头

Codex 会替你跑命令、改文件，但模型不是可信的执行者。第 6 章讲过沙箱把"能做什么"关进笼子；沙箱决定的是**环境边界**，而审批决定的是**这一步要不要你先点头**。沙箱挡不住"模型想跑一个它不该跑的命令"，所以需要审批这道人工闸门：所有可能被模型滥用的后果性行为，默认都要先得到你的确认。

一次执行前，Codex 先问策略层"这条命令需不需要批准"。`reference/codex/codex-rs/core/src/exec_policy.rs:311` 的 `create_exec_approval_requirement_for_command` 把命令交给 `codex-execpolicy` 的 `Policy::check_multiple_with_options` 去匹配前缀规则——命中的 `allow` 规则意味着"这条之前已放行"，命不中且策略为 `on-request`/`on-failure` 时才会触发提问。它返回 `ExecApprovalRequirement`，正是后续提问的依据。

真正"等你点头"发生在审批中枢。`reference/codex/codex-rs/core/src/tools/approvals.rs:438` 的 `Session::request_approval` 是统一入口；当判定需要人工确认时，`request_user_approval`（`reference/codex/codex-rs/core/src/tools/approvals.rs:610`）会封装出 `ExecApprovalRequest`，通过事件 `ExecApprovalRequest` 推送给前端（`reference/codex/codex-rs/protocol/src/protocol.rs:1409`）。这呼应第 3 章的公共 API：前端拿到请求后，用户做出选择，再以 `Op::ExecApproval`（`reference/codex/codex-rs/protocol/src/protocol.rs:599`，携带 `id` 与 `ReviewDecision`）回提交队，主循环据此放行或拒绝。第 5 章工具系统的每个 consequential 工具，最终都绕回这条路径。

批准记录怎么被记住，避免每次都问？两层。会话内，Codex 用 `with_cached_approval`（`reference/codex/codex-rs/core/src/tools/sandboxing.rs:70`）维护一张 `tool_approvals` 缓存：若某 key 已是 `ReviewDecision::ApprovedForSession`，直接跳过提问（呼应第 6 章"会话内可复用"的语义）。跨会话的"永久记忆"则写在 `codex-execpolicy`：当你选择"记住这条命令"时，`reference/codex/codex-rs/execpolicy/src/amend.rs:65` 的 `blocking_append_allow_prefix_rule` 把一条 `prefix_rule(pattern=..., decision="allow")` 追加进策略文件，并用咨询锁去重（`amend.rs:174` 避免重复行）。下次加载策略，`check_multiple_with_options` 直接命中，不再打扰你。

更进一步是**语义化审批**：模型不只是"这次放行"，还可以提议一条 `ExecPolicyAmendment`（见 `exec_policy.rs:22` 的导入与 `derive_requested_execpolicy_amendment_from_prefix_rule`），即把"以 `cargo test` 开头的命令都允许"这种**语义规则**写进白名单，而非记住某个具体命令行。配合 `ReviewDecision::ApprovedExecpolicyAmendment`，你批准的是一类行为，而不是一次调用。这也是白名单（`allow` 前缀规则）与逐次确认的根本区别——白名单把信任从"你这次点头"升级为"这类命令都可信"。

小结：审批存在是因为模型不可信——沙箱管环境、审批管决策。一次提问由 `ExecApprovalRequest` 发起、以 `Op::ExecApproval` 收尾；会话内靠缓存、跨会话靠 `codex-execpolicy` 的前缀规则"记住"。白名单与语义化 `ExecPolicyAmendment` 让信任可累积，把重复确认压到最低，又不丢掉最后那道闸门。
