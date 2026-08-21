# 第 15 章：Skills——把可复用能力喂进上下文

## Skill 是什么

在 Codex 里，一个 Skill 本质是一段**带元数据的提示词 / 指令**：它写在仓库（或用户目录）下的 `SKILL.md` 里，由一个 YAML frontmatter 描述其名字、用途等元数据，正文则是具体要做的事。用户可以在对话里用 `@技能名` 显式点名调用它，Codex 也会在命令里隐式识别到对 skill 脚本/文档的访问并自动注入。

解析后的元数据由 `SkillMetadata` 承载（`skills/src/model.rs:8`），其中包含 `name`、`description`，以及可选的 `SkillPolicy`（`skills/src/model.rs:62`，用 `allow_implicit_invocation` 控制是否允许被隐式触发）、`SkillInterface`（`skills/src/model.rs:70`）和 `SkillDependencies`（`skills/src/model.rs:80`，声明 skill 依赖的 MCP 工具）。每个 skill 还带 `scope`（`skills/src/model.rs:17`，取值 user/repo/system/admin 决定优先级）与可选的 `plugin_id`（`skills/src/model.rs:18`），说明它既可以是本地文件系统上的 skill，也可以由插件提供。

## 它和 prompt / tool 的区别

- **prompt（系统提示词）**是写死的、通用的背景说明；Skill 是按需、可点名加载的一段专门指令。
- **tool** 是模型可调用的确定性函数（有输入输出 schema）；Skill 不是函数，而是一段被拼进上下文的提示词，用来改变模型的意图与做法，本身不执行副作用。
- 简单说：tool 给模型「手」，skill 给模型「心法」。两者可以配合——skill 的 `SkillToolDependency` 还能声明它要靠哪个 MCP 工具完成工作。

## 怎么被加载、怎么拼进 turn 上下文

Skill 的 `SKILL.md` frontmatter 由 `parse_skill_frontmatter_metadata` 解析校验（`skills/src/parser.rs:44`），产出 `ParsedSkillFrontmatter`（`skills/src/parser.rs:24`）；非法 YAML 还会尝试逐行修复。

加载与主循环注入发生在 `build_skills_and_plugins`（`core/src/session/turn.rs:758`，呼应第 4 章的 turn 主循环）。该函数先取出 `skills_snapshot`，再用 `collect_explicit_skill_mentions`（`core/src/session/turn.rs:809`）收集用户 `@` 提到的 skill，随后调用 `skills_snapshot.load_skill_prompts(&mentioned_skills)`（`core/src/session/turn.rs:826`）把这些 skill 正文渲染成 `ContextualUserFragment` 片段。最终这些片段作为 `injection_items` 在 turn 开头被 `record_conversation_items` 写进会话（`core/src/session/turn.rs:278`），从而进入模型看到的上下文。Codex 还会用 `InjectedHostSkillPrompts` 做去重（`core/src/session/turn.rs:879` 起），避免同一个 host skill 既经扩展机制又经本次逻辑被重复注入。

隐式调用则由 `detect_implicit_skill_invocation_for_command`（`skills/src/invocation.rs:26`）识别命令里对 skill 脚本/文档的访问来完成。

## 最小 skill 示例

一个最小 `SKILL.md`：

```markdown
---
name: sum-csv
description: 把 CSV 的某列求和
metadata:
  short-description: 汇总 CSV 数值列
---
请读取用户指定的 CSV，对其中的 amount 列求和，
仅输出总和数字，不要解释。
```

用户 `@sum-csv` 后，该正文片段就会被注入当前 turn，模型据此行动。

## 小结

Skill 是「可点名加载的提示词包」，用 `SKILL.md` 的 frontmatter 描述、正文承载指令；它介于系统 prompt 与 tool 之间，靠 `build_skills_and_plugins` 在每次 turn 开始时解析 `@` 提及并拼入上下文，是给用户低成本复用领域能力的主要机制。
