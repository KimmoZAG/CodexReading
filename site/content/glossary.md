# 术语表

读这本 guide 时反复撞到的词，先在这里统一对个暗号。每个词一句话大白话，后面标了它主要在哪章被掰开揉碎讲。

| 术语 | 大白话解释 | 主要出现在 |
| --- | --- | --- |
| **Op** | 你（或 IDE、桌面 app）发给 Codex 的"指令信封"，比如"开始一轮对话""同意跑这条命令"都装在这里面。 | [第 8 章：协议与 app-server](content/08-protocol.md) |
| **EventMsg** | Codex 回给你的"事件信封"，模型说了啥、命令跑出啥、出啥错，全靠它一路往外流。界面层说白了就是它的"显示器"。 | [第 3 章：codex-core 公共 API](content/03-core-api.md) |
| **codex-core** | 整个项目的大脑，真正"想一步做一步"、管会话和工具的逻辑都在这一层。 | [第 3 章：codex-core 公共 API](content/03-core-api.md) |
| **app-server** | 把 codex-core 包成一个能跨进程/跨网络连的服务，IDE 和远程控制都靠它当"转接头"。 | [第 8 章：协议与 app-server](content/08-protocol.md) |
| **exec-server** | 真正动手执行命令、改文件的那个进程，和大脑分开跑，崩了也不带回核心一起死。 | [第 11 章：exec-server 执行链路](content/11-exec-server.md) |
| **sandbox（沙箱）** | 给命令划的一块"隔离牢笼"，限制它能碰哪些文件、走不走网络，防止跑飞了搞坏你的机器。 | [第 6 章：沙箱](content/06-sandbox.md) |
| **MCP** | 一套标准插座，让 Codex 能接上外部工具和数据源，像挂 U 盘一样扩展能力。 | [第 16 章：MCP 接入](content/16-mcp.md) |
| **skill** | 一段可复用的提示词/操作模板，你 `@` 一下就能把某类任务的经验塞进上下文。 | [第 15 章：Skills 系统](content/15-skills.md) |
| **hook** | 在回合关键节点自动插一脚的外部脚本，比如回合前自动检查、结束后自动发通知。 | [第 14 章：Hooks 系统](content/14-hooks.md) |
| **rollout** | 把一次完整会话原样录下来、事后能逐帧回放和审查的那套机制。 | [第 18 章：Rollout 与回放](content/18-rollout.md) |
| **TurnAborted** | "这一轮被中途打断"的信号，和"硬失败"不同，它让进程留着状态等你下一条输入，而不是直接崩。 | [第 4 章：主循环 run_turn](content/04-turn-loop.md) |
| **CodexErr** | 全仓库统一的错误类型，把各种底层报错归好类、区分"能不能重试"，再翻译成界面看得懂的事件。 | [第 27 章：错误处理](content/27-error-handling.md) |
