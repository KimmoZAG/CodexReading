# 第 19 章：登录与鉴权——API key 从哪来、存在哪

## 为什么单独讲鉴权

API key、access token、refresh token 是 Codex 最高危的资产：它等同于你的账号身份，一旦泄露，攻击者可冒用配额、读取会话历史。这也正是第 2 章进程模型与第 6 章沙箱反复强调的**信任边界**——沙箱挡得住命令执行，却挡不住已经合法签发的密钥被读取或外传。所以鉴权链路的每一环（来源、存储、注入）都值得单独审视，而不是藏在某次网络调用里。

## 登录流程：device code / OAuth 还是直接 key

Codex 同时存在两条路径。交互式登录走 OAuth device code 流程：`run_device_code_login` 先 `request_device_code` 拿到一次性 `user_code` 与 `verification_url`，用户在浏览器确认后由 `poll_for_token` 轮询换取授权码，再 `exchange_code_for_tokens` 得到 id/access/refresh token（`login/src/device_code_auth.rs:234`、`login/src/device_code_auth.rs:100`）。非交互场景则可直接用 `login_with_api_key` 注入一个现成 key（`login/src/lib.rs:56`）。运行时也可经 `read_codex_access_token_from_env` 从环境变量 `CODEX_ACCESS_TOKEN` 读取，优先级高于落盘文件（`login/src/auth/manager.rs:905`）。

## token 存哪：codex home

拿到 token 后，`persist_tokens_async` 写入 `CODEX_HOME/auth.json`（`login/src/server.rs:886`）；其结构由 `AuthDotJson` 定义，包含 `openai_api_key`、`tokens`、`personal_access_token` 等字段（`login/src/auth/storage.rs:40`）。`CODEX_HOME` 本身由 `find_codex_home` 决定，默认 `~/.codex`，可被同名环境变量覆盖（`core/src/config/mod.rs:4625`）。注意：启用 secret storage 时还会尝试写入系统 keyring，落盘 `auth.json` 只是兜底——当 keyring 写入失败时才会回退到明文文件（`login/src/auth/storage.rs:151` 指向的 `codex_home.join("auth.json")`）。登出时则走 `logout_with_revoke`：先吊销服务端 refresh token，再删除本地 `auth.json`，避免"服务端还有效、本地已删"的悬空状态（`login/src/lib.rs:59`）。换言之，凭证的生命周期始终在"签发—落盘—注入—吊销"这条闭环里，每一段都可被单独审计。

## 启动时怎么组装

在完整 `Config` 就绪前，cli 通过 `bootstrap_auth_config` 用本地 bootstrap 配置先拼出 `AuthConfig`——它携带 `codex_home`、凭证存储模式、keyring 后端与登录限制，供登录与后续 cloud 要求加载使用（`core/src/config/auth_keyring.rs:39`）。这套配置呼应第 9 章的配置解析：鉴权是配置最早被消费的部分之一。

## 怎么注入到 client

`AuthManager` 是 `auth.json` 派生的唯一真相源（`login/src/auth/manager.rs:1991`），它对外提供当前有效的 token/key。第 12 章的模型客户端正是从这里取凭证，把它塞进通往模型网关的 HTTP 头——也就是说，鉴权不是"模型客户端自己想办法"，而是上游统一签发、下游只消费。

## 小结

鉴权链可概括为四步：**登录签发**（`request_device_code`/`login_with_api_key`）→ **本地落盘**（`auth.json`，受 `find_codex_home` 决定位置）→ **启动组装**（`bootstrap_auth_config`）→ **注入客户端**（`AuthManager` 供模型客户端取用）。把最高危的密钥交给单一可信模块管理，并让沙箱之外的存储与注入都可审计，正是 Codex 守住信任边界的方式。
