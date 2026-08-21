# 第 30 章：安装与分发——codex 二进制怎么到你机器上

用户怎么把 codex 装到本地，大体有三条路：其一，运行官方安装脚本（macOS/Linux 用 `curl -fsSL https://chatgpt.com/codex/install.sh | sh`，Windows 用 `install.ps1`），这也是脚本本身推荐的 "standalone" 方式；其二，用包管理器全局安装 `npm install -g @openai/codex`，`bun` / `pnpm` 同理，或 macOS 上 `brew install --cask codex`；其三，让 codex 自己更新自己，即 `codex update` 子命令。

安装脚本 `scripts/install/install.sh` 干的事可以拆开看。`resolve_release` 先把 `latest` 或指定的 `x.y.z` 版本归一化，优先从 `releases.openai.com` 拉取 `release.json` 元数据，失败再回退 GitHub Releases（`resolve_release_from_github`）。真正把文件搬回来的是 `download_file`（`scripts/install/install.sh:103`），它优先用 `curl`，没有就退 `wget`，并会校验 SHA-256 摘要（`verify_archive_digest`）。下载到的是 `codex-package-<target>.tar.gz` 归档，`install_package_release`（`scripts/install/install.sh:935`）把它解包到 `~/.codex/packages/standalone/releases/<version>-<target>/`，并对 `bin/codex` 等做 `chmod 0755`。

"放 PATH" 由 `update_current_link`（`scripts/install/install.sh:1025`）与 `update_visible_command` 完成：脚本在 releases 目录里维护一个 `current` 软链指向当前版本目录，再把 `$HOME/.local/bin/codex` 这个可见命令软链到 `current/bin/codex`。`add_to_path`（`scripts/install/install.sh:585`）负责把 `$HOME/.local/bin` 写进 shell 的 profile（`~/.zshrc` / `~/.bashrc` 等），用 `# >>> Codex installer >>>` 标记块避免重复写入。

自更新怎么实现？关键不在脚本，而在 Rust 侧。`cli/src/main.rs:883` 的 `run_update_command()` 调用 `codex_tui::get_update_action()`；后者在 `tui/src/update_action.rs:76` 通过 `InstallContext::current()`（`install-context/src/lib.rs:119`）反查"我是怎么被装上的"。`install_method_from_exe`（`install-context/src/lib.rs:273`）顺着可执行文件路径判断：在 `~/.codex/packages/standalone` 下即 `Standalone`，在 `/opt/homebrew` 下即 `Brew`。拿到方法后，`command_args()`（`tui/src/update_action.rs:42`）返回对应命令——standalone 就重跑一遍 `curl -fsSL .../install.sh | CODEX_NON_INTERACTIVE=1 sh`，npm 就 `npm install -g @openai/codex`。也就是说，自更新本质是"按当初的安装方式再跑一次安装流程"，而非二进制内原地 patch。

小结：codex 的安装与分发刻意做成"脚本 + 元数据"的简单模型——脚本只负责选平台、下归档、建软链、写 PATH；自更新复用同一套脚本，靠 `InstallContext` 在运行时推断安装来源，把升级还原成一次幂等的重新安装。理解这点，就能看懂为什么冲突卸载时会出现 `brew uninstall` / `npm uninstall` 多套提示，以及为什么升级几乎不需要单独的二进制逻辑。
