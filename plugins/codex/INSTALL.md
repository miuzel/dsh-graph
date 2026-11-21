# goal-graph for Codex

把本地 goal-graph 目标看板接入 Codex CLI。本目录提供 Codex 可识别的插件清单、**零配置 stdio MCP** 配置与外部宿主版技能正文。

> **零配置开箱即用**：装好 `goal-graph-cli` 与本插件后，在任意工作区启动 Codex 即可使用（无需手动跑 `goal-graph serve`、无需固定端口 `7788`、无需 `export GOAL_GRAPH_MCP_TOKEN`）。
> Codex 直接读取 `.claude-plugin/marketplace.json` / `plugin.json` 与 `.mcp.json`，自动在当前工作区拉起 `goal-graph mcp`（默认 38 个读写工具，并按工作区以 `127.0.0.1:0` 自动分配空闲端口起/复用本地 Web 看板，退出自动回收）。

## 1. 前置

| 项 | 要求 | 检查 |
|---|---|---|
| Node.js | ≥ 22 | `node --version` |
| goal-graph CLI | `goal-graph-cli`（提供 `goal-graph mcp` 与 `goal-graph serve`） | `goal-graph version` |
| Codex CLI | ≥ 0.166（需 `plugin` / `plugin marketplace` / `mcp` 子命令） | `codex --version` |
| 看板数据 | 目标项目内已有 `.dsh-graph/`（或自定义核心资料目录；未初始化时 MCP 照常启动，查询返回 `E_NOT_INITIALIZED`） | 该项目内 `goal-graph status` |

## 2. 一条命令安装

```bash
codex plugin marketplace add <本目录路径> && codex plugin add goal-graph@goal-graph
```

`<本目录路径>` 换成 `plugins/codex` 的绝对路径。例：

```bash
codex plugin marketplace add /path/to/dsh-graph/plugins/codex
codex plugin add goal-graph@goal-graph
```

Codex 的 `plugin marketplace add` 接受**本地路径**。插件内置的 `.mcp.json` 采用原生 stdio 形态：

```json
{
  "mcpServers": {
    "goal-graph": {
      "type": "stdio",
      "command": "goal-graph",
      "args": ["mcp"]
    }
  }
}
```

若不想安装插件而直接写入 `~/.codex/config.toml`，也可执行：

```bash
codex mcp add goal-graph -- goal-graph mcp
```

## 3. 传输方式与工具模式

- **默认零配置 stdio（`goal-graph mcp`）**：直连当前工作区，**无需 token 或固定端口**，默认注册 **38 个工具**（11 只读 + 27 执行类写工具，固定 actor `mcp:local-service`），并在后台自动按工作区以 `127.0.0.1:0` 分配空闲端口起/复用本地 Web 看板（多工作区零端口冲突）。
- **只读模式**：将 `args` 改为 `["mcp", "--read-only"]` 即切回 **11 个只读工具**；不需本地 Web 时可加 `--no-web`。
- **写模式只能由服务端参数决定**：客户端在请求中传入 `actor` / `owner` / `human` / `approval` / `allowWrite` / `writeMode` / `mode` 一律被拒。

## 4. 进阶：显式 HTTP `goal-graph serve` 模式

若你需要连接手动管理的长期前台 HTTP 服务（默认只读，按需 `--allow-write`），需先显式初始化并注入 token：

```bash
export DSH_BOARD="$HOME/.dsh-graph-boards/$(basename "$PWD")"
export DSH_WS="$PWD"
mkdir -p "$DSH_BOARD"

goal-graph serve init --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788
export GOAL_GRAPH_MCP_TOKEN="$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/goal-graph-service/token")"
goal-graph serve --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788
# 需要写模式时由服务端显式加 --allow-write：
goal-graph serve --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788 --allow-write
```

> ⚠️ 显式 HTTP 模式下 Codex 必须使用 `bearer_token_env_var = "GOAL_GRAPH_MCP_TOKEN"`（`headers` 与 `env_http_headers` 在插件路径运行时均不发送认证头）。可用 `goal-graph-mcp codex --transport http --port 7788` 生成片段。

## 5. 最小验证

**5a. 确认插件与 stdio 条目已就绪**：

```bash
codex plugin list
codex mcp get goal-graph
```

预期 `codex mcp get goal-graph` 显示：

```
goal-graph
  enabled: true
  transport: stdio
  command: goal-graph
  args: mcp
```

**5b. 确认 `goal-graph mcp` 本身正常响应 stdio JSON-RPC**：

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n' | goal-graph mcp --no-web
```

预期：stdout 输出合法 JSON-RPC 响应，包含 **38 个工具**（加 `--read-only` 为 **11 个**）。

**5c. 在 Codex 会话中实测**：在含看板的项目目录里让 Codex 调用一次 `graph_list_goals`（最轻只读工具），确认拿到真实返回。

## 6. 能做什么 / 做不到什么

与 Claude Code 版一致：零配置 stdio 默认 38 个读写工具（`--read-only` 或显式 `serve` 默认只读为 11 个）；
`graph_resolve_accept` / `transition → delivered` / `graph_claim_supervisor` / `graph_start_attempt`
**在任何模式下都不可达**，必须回 DSH 看板或本地 GUI 裁决。详见 `skills/goal-graph/SKILL.md`。

## 7. 卸载

```bash
codex plugin remove goal-graph@goal-graph
codex plugin marketplace remove goal-graph
```

如曾用过显式 `serve` 模式，服务侧清理（不动看板数据）：`goal-graph serve uninstall`。

## 8. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| Codex 找不到 `goal-graph` 命令 | `goal-graph-cli` 未安装或不在 Codex 进程 `PATH` 中 | 执行 `npm install -g goal-graph-cli`，确认 `which goal-graph` 可见后重启 Codex |
| `E_NOT_INITIALIZED` | 当前工作区没有 `.dsh-graph/events.jsonl` | 在目标项目根启动 Codex，或用 `--graph-dir-name` 指定自定义目录名 |
| `E_UNKNOWN_COMMAND` | 工具未注册（开启了 `--read-only` / 显式只读 `serve`，或人工裁决保留项） | 需要写就去掉 `--read-only`（显式 HTTP 加 `--allow-write`）；裁决走 GUI |
| `E_FORBIDDEN` | 参数被拒（典型 `to=delivered` 或传入保留参数） | 迁到 `review`，交付由人裁决 |
| 显式 HTTP 模式连不上 `127.0.0.1:7788` | **① `--root` 与 `--workspace` 相同或互相包含 → 服务根本没起来**（`错误：graphRoot 与 executionWorkspace 不得相同：<路径>`，exit 2）<br>② 未显式 `--port` 或端口被占<br>③ 服务未启动 | 两路径必须不同且不互相包含（见 §4）；建议优先使用零配置 stdio 模式 |
| 显式 HTTP 模式报 401 | 误用 `headers`/`env_http_headers` 或未导出 `GOAL_GRAPH_MCP_TOKEN` | HTTP 模式改用 `bearer_token_env_var` 并导出变量；或改用默认零配置 stdio |
| `serve init` / 自动 Web 服务报 `ENOENT ... mkdir '<XDG 路径>/goal-graph-service'` | `XDG_STATE_HOME` 指向的位置**不可写**（沙盒/只读挂载），服务状态目录由它派生 | 把 `XDG_STATE_HOME` 指向可写目录（或传 `--state-dir <可写绝对路径>` / `--no-web`） |
| **同一 XDG 目录连跑两次 `opencode run`，第二次不再连 MCP** | 探针实测：第一次有 `server=goal-graph` 连接记录，第二次同目录重跑未再发起连接（**确切原因未查明**，不对机制作断言；该现象在 OpenCode 侧观测，Codex 侧未做同类对照） | 跨宿主验证时每轮用**全新** `XDG_*` 目录 |
| 版本不匹配 | 插件 `1.0.0` 与 CLI 版本差距过大 | 升级 `goal-graph-cli` |

## 9. 验证状态（哪些实测过、哪些没有）

> **口径**：只有**实际跑过并留下输出**的条目才算「✅ 已实测」；其余一律标「❌ 未验证」并写明原因，
> **不声称已通过**。本表与 OpenCode 版（`plugins/opencode/INSTALL.md` §8）同一口径，
> 并由 `core/tests/g633-host-plugins.test.ts` 的 ⑧b-codex 守卫逐条钉住。

### 9a. 已实测（`codex-cli 0.166.0`）

| 项 | 状态 | 证据（当时实跑的输出） |
|---|---|---|
| `codex plugin marketplace add <本目录>` 能接受本地路径 | ✅ 已实测 | 输出 `Added marketplace`，exit 0 |
| `codex plugin add goal-graph@goal-graph` 能装上并启用 | ✅ 已实测 | 输出 `installed, enabled`；`codex mcp get goal-graph` 显示 `transport: stdio`、`command: goal-graph`、`args: mcp` |
| Codex 插件路径运行时**真实拉起** `goal-graph mcp` 并完成 MCP 握手与工具列表发现 | ✅ 已实测（`codex app-server` 运行时探针） | 安装本目录插件后启动 `codex app-server` 并查询 `mcpServerStatus/list`：shim 日志捕获真实子进程启动（`args=mcp`），响应返回 `pluginId="goal-graph@goal-graph"`、`serverInfo={"name":"goal-graph-local","version":"1.0-draft.1"}` 及全部 38 个工具 |
| `codex mcp add goal-graph -- goal-graph mcp` 生成配置形状 | ✅ 已实测 | `config.toml` 写入 `[mcp_servers.goal-graph]` + `command = "goal-graph"` + `args = ["mcp"]`，与 `goal-graph-mcp codex` 默认产出逐字一致 |
| 进阶 HTTP 模式：`bearer_token_env_var` 运行时发 `Bearer <token>`、`env_http_headers` 不发头 | ✅ 已实测（受控探针） | 同一插件对比：`bearer_token_env_var` 实收 `Bearer <token>`；`env_http_headers` 实收 `undefined` |

### 9b. 未实测（如实标注，不要按「已通过」理解）

| 项 | 状态 | 原因 / 边界 |
|---|---|---|
| Codex **会话内**经模型走完 `tools/call` 的完整链路 | ❌ **未验证** | 本轮已实测到插件安装 + `codex app-server` 真实拉起 `goal-graph mcp` 并完成 `initialize`/`tools/list`；但**模型在会话里实际调用一次 `graph_*` 工具并拿到结果**这一步未在本机跑过（无在线 LLM 上游）。请在你的 Codex 会话中按 §5c 确认 |
| `skills/` 目录被 Codex 自动发现并加载 | ❌ **未验证** | 未做实测；Codex 侧技能目录规则未确认，请按你的 Codex 版本手工放置或核对 |
| `codex plugin remove` / `plugin marketplace remove`（§7 卸载命令） | ❌ **未验证** | 卸载命令按 CLI 帮助写成，未在本轮实跑 |
| Codex 侧「同一 XDG 目录连跑两次第二次不连 MCP」的同类对照 | ❌ **未验证** | 该现象在 **OpenCode 侧**实测到；Codex 侧**没有做**同类对照，故 §8 该行明确写了「Codex 侧未做」 |
