# dsh-graph / goal-graph v1.0.0 发布记录

## v1.0.0 — 2026-11-21

首个正式大版本线：在 0.24.x 之上完成五包拆分分发、跨宿主 `goal-graph` 命令行与零配置 stdio MCP、独立本地服务、大看板性能提速，并将宿主支持面收窄至 DSH `>=0.2.2-rc.3 <0.2.3-0`。

### 核心亮点

- **五包拆分与跨宿主命名统一**：DSH 专属插件本体保留 `dsh-graph`；跨宿主产物统一去 `dsh-` 前缀拆分为 4 个独立可装包：`goal-graph-cli`（命令 `goal-graph`）、`goal-graph-service`、`goal-graph-skills`、`goal-graph-mcp`，同时随仓提供 Claude Code / Codex / OpenCode 三宿主插件定义（`plugins/{claude-code,codex,opencode}/`）。详见 [docs/multi-package-design.md](multi-package-design.md)。
- **独立命令行 `goal-graph`**：零常驻服务、毫秒级只读查询（`info` / `status` / `goal list|show` / `version`），支持 `--graph-dir-name` 按项目自定义核心资料目录名（默认 `.dsh-graph` 零迁移）；提供 `sync` 受控区段投影、`claim` 目标认领与 `submit` 自检门禁闭环。
- **零配置 stdio MCP 与独立本地服务**：
  - `goal-graph mcp` 供 Claude Code / Codex / OpenCode 打开工作区即自动拉起（默认 38 个读写工具、`--read-only` 切回 11 只读工具），按工作区在 `127.0.0.1:0` 自动分配空闲端口起/复用本地 Web 看板，宿主退出自动回收端口；
  - 显式 `goal-graph serve` 提供单进程 Web 页面、Web API 与 localhost HTTP MCP（仅绑 `127.0.0.1`、0600 CSPRNG 凭据、默认只读、`--allow-write` 按需开启写工具并留审计、省略 `--port` 沿用配置端口）；
  - 人工裁决（`graph_resolve_accept`、`transition → delivered`）与派发（`graph_start_attempt`、`graph_claim_supervisor`）在所有外部宿主模式下始终 fail-closed；MCP 数组返回值统一封装 `structuredContent` 为 `{ items, count }` 满足严格客户端校验。
- **大看板 `status` 提速与架构图更新**：事件流增量索引（大小 + inode + 头部指纹三重校验）使大看板中位耗时减半；插件「📖 使用说明 → Graph 设计」与 `docs/` 新增 v1.0.0 仓库与多宿主交互式架构图。
- **宿主支持面收窄与测试分层**：`engines.dsh` 与 `peerDependencies["@deepseek-ai/dsh-settings"]` 统一收窄为 `>=0.2.2-rc.3 <0.2.3-0`（已在 DSH `0.2.2-rc.5` 上完成端到端实机验证）；测试治理为 `shakedown ⊊ integration ⊊ full ⊊ everything` 四层，发布门禁仍为无参全量。

### 安装方式

- **DSH 插件（DSH Web / Desktop）**：
  ```sh
  dsh plugin --profile <profile-name> add dsh-graph
  ```
- **跨宿主 CLI + Claude Code / Codex / OpenCode 插件**：
  ```sh
  npm install -g goal-graph-cli
  # Claude Code 示例：
  claude plugin marketplace add <repo>/plugins/claude-code
  claude plugin install goal-graph@goal-graph -y
  ```
- 各包完整安装指南见 `docs/packages/<package-name>/INSTALL.md` 与 `plugins/<host>/INSTALL.md`。

### 平台实测状态（v1.0.0）

- **Linux / WSL2**：✅ 全量自证门禁 `3332/3332` 全绿（`fail=0 skipped=0 cancelled=0 todo=0`），DSH `0.2.2-rc.5` 浏览器端到端与 Claude Code 零配置 stdio MCP 实机验证通过。
- **原生 macOS**：✅ 实机安装通过；`win-smoke-test.mjs --tarball`（T1–T5）与 `platform-smoke-test.mjs --skip-build --tarball`（P1–P3 + T1–T5）双 PASS（未执行依赖源码构建的 P4–P6，见 [docs/platform-gate.md](platform-gate.md) §7.14）。
- **原生 Windows**：⚠️ 原生 Windows DSH Desktop 实机安装通过、未见严重缺陷；本版尚未在原生 Windows 补跑 `win-smoke-test.mjs` 完整 T1–T5 命令行脚本（跨平台 T1 静态/台账 86 项 / 296 处已全绿，见 [docs/platform-gate.md](platform-gate.md) §7.13 / §7.14）。

### 发布产物与清单

- 5 个 `1.0.0` tarball 及其 SHA-256 校验和见构建产物目录 `out/SHA256SUMS.txt` 与 [docs/release-checklist-v1.0.0.md](release-checklist-v1.0.0.md)。
