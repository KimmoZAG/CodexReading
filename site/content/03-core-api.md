# 第 3 章：codex-core 的公共 API

前面两章都在"外围"。从这一章起，我们进大脑。先别急着看 `run_turn` 那种几百行的主循环，那会劝退。正确入口是 `codex-core` 对外暴露的**极小公共面**——你只要理解两个方法和两个类型，整个系统的脉搏就握在手上了。

核心类型叫 `CodexThread`，定义在 `core/src/codex_thread.rs`。它把"和智能体对话"抽象成一对极简的操作：

```rust
// core/src/codex_thread.rs:46
impl CodexThread {
    /// 你向智能体"投递"一个操作（提问、打断、批准……）
    pub fn submit(&self, op: Op) -> Result<OpSent, SubmitError> { ... }

    /// 阻塞等待，拿回智能体"说"出来的下一件事
    pub async fn next_event(&self) -> Result<Event, ThreadShutdown> { ... }

    // 还有 start_or_steer_turn 之类用来主动推进回合的变体
    pub async fn start_or_steer_turn(&self, turn_ctx: TurnContext) -> ... { ... }
}
```

读到这里你应该已经能写出一个最小驱动了：

```rust
let thread = CodexThread::new(config, client, ...)?;
thread.submit(Op::TurnInput(TurnInput { /* 用户的 prompt */ }))?;
loop {
    match thread.next_event().await {
        Ok(event) => { /* 把 event 画到界面上 / 打印 */ }
        Err(_) => break,
    }
}
```

就这么简单。`submit` 发指令，`next_event` 收事件。所有复杂度都被藏在 `Op` 和 `Event` 这两个枚举背后——而这正是 `codex-protocol` 作为"通用语言"的价值。

## 3.1 你"投递"的东西：`Op`

`Op` 定义在 `protocol/src/protocol.rs:543`，它代表"对这次会话能做的一切操作"：

```rust
// protocol/src/protocol.rs:543（节选）
pub enum Op {
    Interrupt,                       // 打断当前回合
    TurnInput(TurnInput),            // 一轮新的用户输入（prompt）
    RecoverTurn(...),                // 从异常里恢复一个回合
    ThreadSettings(...),             // 改会话级设置
    ExecApproval(...),               // 对某个待执行的命令给出批准/拒绝
    // ...
}
```

注意这里**没有**"运行命令""改文件"这种 Op。原因很关键：用户侧只能"提问"和"审批"，不能替模型直接下执行指令。模型要执行动作，得走另一条路（第 5 章的工具系统），并且通常还要等你用 `ExecApproval` 点头。

## 3.2 它"回流"给你的东西：`Event` / `EventMsg`

`Event` 是个薄包装，真正的内容在 `msg` 里：

```rust
// protocol/src/protocol.rs:1270
pub struct Event {
    pub id: String,     // 与对应的 Op 关联，用于配对
    pub msg: EventMsg,  // 具体发生了什么
}
```

`EventMsg` 是整本 guide 里最重要的枚举之一，它几乎刻画了"用 Codex 时你眼睛看到的所有变化"：

```rust
// protocol/src/protocol.rs:1288（节选）
pub enum EventMsg {
    TurnStarted,                          // 一轮开始了
    TurnComplete(TurnComplete),          // 一轮结束
    AgentMessage(AgentMessage),          // 模型吐出一段文字
    AgentReasoning(AgentReasoning),      // 模型的"思考"（reasoning）
    ExecCommandBegin(ExecCommandBegin),  // 要跑一条命令了
    ExecCommandOutputDelta(ExecCommandOutputDelta), // 命令的实时输出
    ExecCommandEnd(ExecCommandEnd),      // 命令跑完
    ExecApprovalRequest(ExecApprovalRequest),       // 等你批准
    PatchApplyUpdated(PatchApplyUpdated), // 正在打补丁（实时）
    Error,                                // 出错了
    // ... 还有 SessionConfigured / Exit / ThoughtThrottle 等
}
```

把 `EventMsg` 的品种记熟，你会发现 TUI 的每一个画面、IDE 里的每一个进度条，都只是这个枚举的某个变体被渲染了出来。换句话说，**界面层是 `EventMsg` 的一个纯函数视图**。这个洞察后面讲 TUI（第 7 章）和协议（第 8 章）时会反复用到。

## 3.3 为什么这个 API 长这样

回头看 `submit` / `next_event` 这对方法，它其实是经典的**生产者/消费者 + 事件溯源**模型：

- 输入是离散的 `Op`（指令即事件）；
- 输出是离散的 `Event`（状态变化即事件）；
- 中间那团复杂的采样、工具调用、审批，对调用方完全不可见。

这个设计的直接好处是：**同一个 `core`，既能被 TUI 驱动，也能被 IDE 通过 app-server 的 JSON-RPC 驱动，还能被 `exec` 模式直接驱动**——因为大家都只是"submit Op、收 Event"，只不过拿到 Event 之后各自怎么渲染不同。这也回答了第 2 章留下的疑问：为什么界面层能被随意替换。

下一章，我们终于掀开盖子，看 `next_event` 背后那团复杂的"采样—执行"循环到底长什么样。
