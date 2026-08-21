# 第 3 章：codex-core 的公共 API

`codex-core` 对外的公共面小得出奇：只有两个方法、两个类型。先抓住这两个，再看 `run_turn` 那种几百行的主循环，脉络就清楚。

核心类型是 `CodexThread`，定义在 `core/src/codex_thread.rs`，它把"和智能体对话"抽象成一对极简操作：

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

有这两个方法就能写出一个最小驱动：

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

`submit` 发指令，`next_event` 收事件。所有复杂度都藏在 `Op` 和 `Event` 这两个枚举背后，而它们定义在 `codex-protocol`——整个仓库的通用语言。

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

这里**没有**"运行命令""改文件"这种 Op。用户侧只能"提问"和"审批"，不能替模型直接下执行指令；模型要执行动作得走另一条路（第 5 章的工具系统），并且通常还要等你用 `ExecApproval` 点头。

## 3.2 它"回流"给你的东西：`Event` / `EventMsg`

`Event` 是个薄包装，真正的内容在 `msg` 里：

```rust
// protocol/src/protocol.rs:1270
pub struct Event {
    pub id: String,     // 与对应的 Op 关联，用于配对
    pub msg: EventMsg,  // 具体发生了什么
}
```

`EventMsg` 几乎刻画了你用 Codex 时眼睛能看到的所有界面变化：

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

这个枚举值得记熟。TUI 上的每一屏、IDE 里的每一个进度条，都是它的某个变体被渲染出来的结果——界面层是 `EventMsg` 的一个纯函数视图。第 7 章讲 TUI、第 8 章讲协议，都建立在这一点上。

## 3.3 为什么这个 API 长这样

`submit` / `next_event` 是一对生产者/消费者接口，配上事件溯源：输入是离散的 `Op`（指令即事件），输出是离散的 `Event`（状态变化即事件），中间那团采样、工具调用、审批对调用方完全不可见。

好处很具体：同一个 `core`，TUI 能驱动它，IDE 通过 app-server 的 JSON-RPC 也能驱动它，`exec` 模式则直接驱动。大家都只是"submit Op、收 Event"，拿到 Event 之后怎么渲染各自决定。第 2 章说界面层能随意替换，原因就在这里。

`next_event` 背后那团"采样—执行"循环，下一章掀开看。
