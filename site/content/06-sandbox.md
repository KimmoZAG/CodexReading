# 第 6 章：沙箱——为什么敢让模型跑命令

前面好几章都在铺垫一个事实：模型会产出"执行 `rm -rf`"或"改你家 SSH 密钥"这种指令。Codex 之所以能在生产里用，靠的不是"模型很乖"，而是一整套**把不可信指令关进笼子**的隔离设计。这章讲那层笼子。

## 6.1 核心思路：策略与平台分离

沙箱相关的逻辑集中在 `codex-sandboxing`。它的关键抽象是：**先用一套平台无关的策略描述"能碰什么"，再翻译成具体 OS 的沙箱原语**。

你在工具代码里能直接看到这种分层。比如 `apply_patch` handler 落盘前，会去算"有效的文件系统策略"：

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

把"策略"和"怎么执行策略"拆开，好处是：哪天 Linux 换了个更潮的隔离机制，只要改后端，上层工具代码一行都不用动。这是典型的"依赖倒置"，在这么大的仓库里尤其值钱。

## 6.3 真正的执行发生在另一个进程

回忆第 2 章的三进程模型：`exec-server`（`codex-exec-server`）是那个**真的去跑命令**的进程，而且它本身就是被沙箱裹着的。流程串起来是：

```text
core 的工具系统
  → 策略检查（codex-sandboxing）：这条命令/这个路径在不在白名单？
  → 需要批准？发 ExecApprovalRequest，等你 Op::ExecApproval 点头
  → 交给 exec-server（codex-exec / codex-exec-server）
       → exec-server 在沙箱里 fork 出受限子进程执行
       → 输出经 ExecCommandOutputDelta 流回
```

注意执行器和"持有你登录态、会话上下文"的 core 不在同一个进程。这意味着即便 exec-server 里的命令被注入、逃逸，它手里也没有你的 API key，能搞破坏的范围也被沙箱限死。这就是第 2 章说的"信任边界"。

## 6.4 批准记录会被记住

`codex-execpolicy` 负责把"你这次批准过什么"固化下来。下次模型再想跑同类命令，如果在已批准的策略范围内，就直接放行，不用每次都打断你。这平衡了"安全"和"别太烦人"——纯白名单太死板，纯每次问太啰嗦，所以它走"语义化审批 + 记忆"的路线。

## 6.5 一句话收束

读到这里你应该能拼出完整的安全故事了：

> 模型产出指令 → 工具系统接住 → 沙箱策略判定能碰哪 → 要紧的先问你 → exec-server 在受限进程里真跑 → 输出回流。

这套东西就是 Codex 和普通"我替你 `system()` 一下"脚本的本质区别。它不假设模型可信，而是假设它**不可信但可被约束**——这才是能放心交给真项目用的前提。

下一章我们看"你眼睛看到的那一层"：TUI。
