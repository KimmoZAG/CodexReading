# CodexReading

这是 `codex-rs`（OpenAI 开源的那个能改代码、能跑命令的 agent）的仓库导读站点。仓库本体在 `github.com/openai/codex`，这份站点是我顺手整理的一份由浅入深的阅读路线，帮你在 200 来个 crate 里少迷路。

整份导读一共 16 篇，从进程模型到协议、配置逐步往下钻。

## 它是什么、由什么组成

codex-rs 不是一个"调 API 拼 prompt"的脚本。它把"会写代码、会自己跑命令"当成一件需要被约束的安全问题来做。撑起整个系统的就几块：

- `codex-cli`：你敲 `codex` 跑的二进制，比较薄，管登录、解析参数、挑界面。
- `codex-app-server`：把 core 包成 JSON-RPC 服务，IDE 和桌面端连的就是它。
- `codex-core`：智能体的大脑，会话、采样循环、工具调用、审批都在这一个 crate（仓库里最大的一块）。
- `codex-exec-server`：真正去执行 shell 命令的地方，跑在沙箱里。
- `codex-protocol`：上面这些组件之间说话用的类型定义（事件和指令）。

剩下一百多个 `codex-*` 基本是工具库、适配器和小组件，用到再查就行。

## 设计立场：模型产出的指令不可信

这是读整个仓库之前要先立住的一点。Codex 没有把所有逻辑塞进一个进程，而是按信任边界拆开：CLI 起一个 app-server，core 在 app-server 里跑，要真跑命令时再交给一个被沙箱裹着的 exec-server。

为什么这么拆？因为模型说"我要执行 X"这件事本身不可信。让它直接在本机 `system()` 掉一条它"觉得该跑"的命令是灾难。Codex 的流程是：模型提出指令 → 过策略检查 → 危险的需要你点头 → 才在一个受限进程里跑。哪怕那个进程被注入了，它手里也没有你的 API key，能搞坏的范围也有限。

这套"先假设模型会犯错、用笼子关住它"的思路贯穿整个仓库。看懂它，工具系统、沙箱、审批那几篇就顺了。

## 怎么读

导读站点在 `site/` 目录，纯静态，本地预览直接：

    cd site
    python3 -m http.server 8000

然后开 `http://localhost:8000` 即可。

线上版本已经用 GitHub Pages 跑起来了：`https://kimmozag.github.io/CodexReading/`。

建议的阅读顺序（对应 site/ 里的 16 篇）：

1. 先建立进程模型（cli / app-server / exec-server 怎么协作）；
2. 再钻 `codex-core` 的公共 API——其实就两个方法：`submit(Op)` 和 `next_event()`，一个发指令、一个收事件；
3. 然后看主循环 `run_turn`，就是"问模型 → 它要么回一段话、要么要调个工具 → 执行工具、把结果塞回去再问"的循环；
4. 工具、沙箱、TUI、协议、配置，都围着这个轴展开。

正文里每个 `path:line` 标注都对应仓库里的真实位置，可以边读边跳过去看。

## 几个踩坑提醒

- 它重。想改核心行为，得先穿过不少"上下文压缩、skill 注入、hook 编排"之类的准备代码，真正的采样循环反而没那么长。这是生产级 agent 的常态，不是过度设计。
- 配置即安全策略。你在项目里写的 `codex.toml`（允许访问哪些目录、跑哪些命令），直接决定了沙箱的上限。
- 行号会随版本漂移，但 `run_turn`、`ApplyPatchHandler`、`dispatch_any_with_terminal_outcome` 这类名字很稳，靠名字搜比靠行号靠谱。

如果只是想用，装好直接 `codex` 进交互，或 `codex exec "..."` 非交互跑一条任务。想改的话，这 16 篇导读能省你在 `core/src` 深处迷路的时间。
