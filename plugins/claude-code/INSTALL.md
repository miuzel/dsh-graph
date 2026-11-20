# goal-graph for Claude Code

把本地 goal-graph 目标看板接入 Claude Code：一个插件同时带来 **零配置 stdio MCP 工具** 与 **外部宿主版技能正文**。

> **零配置开箱即用**：装好 `goal-graph-cli` 与本插件后，在任意工作区打开 Claude Code 即可直接使用（无需手动跑 `goal-graph serve`、无需配固定端口 `7788`、无需手动导出 `GOAL_GRAPH_MCP_TOKEN`）。
> Claude Code 会在当前工作区自动拉起 `goal-graph mcp`（默认开启 38 个执行类读写工具，同时按工作区自动以 `127.0.0.1:0` 分配空闲端口启动/复用本地 Web 看板；退出时自动回收）。
> **本插件不含产品代码**：MCP 能力来自你已安装的 `goal-graph` CLI（`goal-graph-cli`），技能正文由插件内 `skills/` 提供。

## 1. 前置

| 项 | 要求 | 检查 |
|---|---|---|
| Node.js | ≥ 22 | `node --version` |
| goal-graph CLI | `goal-graph-cli`（提供 `goal-graph mcp` 与 `goal-graph serve`） | `goal-graph version` |
| Claude Code | ≥ 2.1（需 `plugin` / `plugin marketplace` 子命令） | `claude --version` |
| 看板数据 | 目标项目内已有 `.dsh-graph/`（或自定义核心资料目录；未初始化时 MCP 照常启动，查询返回 `E_NOT_INITIALIZED`） | 该项目内 `goal-graph status` |

## 2. 一条命令安装

```bash
claude plugin marketplace add <本目录路径> && claude plugin install goal-graph@goal-graph -y
```

把 `<本目录路径>` 换成 `plugins/claude-code` 的绝对路径。例：

```bash
claude plugin marketplace add /path/to/dsh-graph/plugins/claude-code
claude plugin install goal-graph@goal-graph -y
```

插件内置的 `.mcp.json` 直接配置零配置 stdio 入口：

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

安装完成后直接进入目标项目打开 Claude Code 即可使用：
- 默认开启 **38 个工具**（11 只读 + 27 执行类写工具，actor 固定 `mcp:local-service`）；
- 需要仅只读时，把 `args` 改为 `["mcp", "--read-only"]`（11 个只读工具）；
- 启动时按当前工作区自动检查/复用或以 `127.0.0.1:0` 分配随机空闲端口启动本地 Web 看板（多工作区并行零端口冲突），不需要 Web 时可加 `--no-web`。

## 3. 最小验证

先在终端确认插件结构合法且被 Claude Code 识别：

```bash
claude plugin validate /path/to/dsh-graph/plugins/claude-code
claude plugin details goal-graph@goal-graph
```

预期 `details` 输出包含：

```
Component inventory
  Skills (1)  goal-graph
  MCP servers (1)  goal-graph
```

也可直接用一行 JSON-RPC 验证 `goal-graph mcp` stdio 响应：

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n' | goal-graph mcp --no-web
```

预期：stdout 输出单行合法 JSON-RPC 响应，含 **38 个工具**（加 `--read-only` 为 **11 个**）。
随后在 Claude Code 会话里让它列目标（`graph_list_goals`），预期能直接读到当前工作区的看板数据。

## 4. 能做什么 / 做不到什么

- **默认零配置 stdio（`goal-graph mcp`）**：38 个工具（11 只读 + 27 写工具），可建目标、登记判据、迁移到
  `draft/planning/collecting/ready/in_progress/review/blocked`、写卡片/评论/记忆/设置（actor=`mcp:local-service`）。
- **只读模式（`goal-graph mcp --read-only` 或显式 HTTP 默认 `goal-graph serve`）**：仅 11 个查询工具。
- **做不到（人工裁决保留项）**：`graph_resolve_accept`、`graph_transition → delivered`、
  `graph_claim_supervisor`、`graph_start_attempt` 在任何模式下都不可达。
  Claude 最多把目标推进到 `review`，**必须由人在 DSH 看板或本地 GUI 裁决**。

详见插件内技能正文 `skills/goal-graph/SKILL.md`。

## 5. 进阶：显式 HTTP `goal-graph serve` 模式

若你需要手工管理固定端口与 bearer token（例如跨终端共享单个长期前台服务或默认只读策略），仍可使用显式 HTTP 服务模式：

```bash
# DSH_BOARD：看板数据目录（放在工作树之外，与执行目录分离）
# DSH_WS   ：执行目录（你实际改代码的项目根）
export DSH_BOARD="$HOME/.dsh-graph-boards/$(basename "$PWD")"
export DSH_WS="$PWD"
mkdir -p "$DSH_BOARD"

goal-graph serve init --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788
export GOAL_GRAPH_MCP_TOKEN="$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/goal-graph-service/token")"
goal-graph serve --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788
# 需要写模式时由服务端显式加 --allow-write：
goal-graph serve --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788 --allow-write
```

再用 `claude mcp add` 或 `goal-graph-mcp claude-code --transport http --port 7788` 生成 HTTP 配置：

```bash
claude mcp add --transport http goal-graph http://127.0.0.1:7788/mcp \
  --header "Authorization: Bearer $GOAL_GRAPH_MCP_TOKEN"
```

## 6. 卸载

```bash
claude plugin uninstall goal-graph@goal-graph
claude plugin marketplace remove goal-graph
```

如曾用过显式 `serve` 模式，可一并清理服务自有凭据与配置（**看板数据不动**）：

```bash
goal-graph serve uninstall
```

## 7. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 宿主报找不到 `goal-graph` 命令 | `goal-graph-cli` 未安装或不在宿主进程 `PATH` 中 | 执行 `npm install -g goal-graph-cli`，确认 `which goal-graph` 可见并重启 Claude Code |
| `E_NOT_INITIALIZED` | 当前工作区没有 `.dsh-graph/events.jsonl` | 确认在目标项目目录下打开 Claude Code，或先初始化项目看板；自定义目录名可给 `mcp` 追加 `--graph-dir-name <名>` |
| `E_UNKNOWN_COMMAND` | 工具未注册：开启了 `--read-only` / 默认只读 `serve`，或碰了人工裁决保留项 | 零配置 stdio 默认可写（去掉 `--read-only`）；显式 HTTP 需加 `--allow-write`；人工裁决走 GUI |
| `E_FORBIDDEN` | 参数被拒（典型：`to=delivered` 或客户端传入保留参数 `actor/allowWrite/mode` 等） | 改用 `review`，交付由人裁决；不要传递保留参数 |
| `plugin install` 报找不到插件 | marketplace 名/插件名不对 | `claude plugin marketplace list` 确认名字是 `goal-graph` |
| 显式 HTTP 模式连不上 `127.0.0.1:7788` | **① `--root` 与 `--workspace` 相同或互相包含 → 服务根本没起来**（`错误：graphRoot 与 executionWorkspace 不得相同：<路径>`，exit 2）<br>② 端口被占或未显式 `--port`<br>③ 服务没起 | 两路径必须不同且不互相包含（见 §5）；显式 HTTP 模式建议改用默认零配置 stdio `goal-graph mcp` |
| 显式 HTTP 模式报 401 | `GOAL_GRAPH_MCP_TOKEN` 没注入或与凭据文件不一致 | 重新 `export GOAL_GRAPH_MCP_TOKEN=...` 或改用默认零配置 stdio |
| `serve init` / 自动 Web 服务报 `ENOENT ... mkdir '<XDG 路径>/goal-graph-service'` | `XDG_STATE_HOME` 指向的位置**不可写**（沙盒/只读挂载），服务状态目录由它派生 | 把 `XDG_STATE_HOME` 指向可写目录（或传 `--state-dir <可写绝对路径>` / `--no-web`） |
| **同一 XDG 目录连跑两次 `opencode run`，第二次不再连 MCP** | 探针在 OpenCode 侧实测：第一次连接成功，第二次同目录重跑未再发起连接（**确切原因未查明**，不对机制作断言） | 在跨宿主排障/验证时每轮使用**全新** `XDG_*` 目录 |
| 版本不匹配 | 插件 `1.0.0` 与 CLI 大版本不一致 | 升级 `goal-graph-cli` 到同版本 |

不想用插件而想手配零配置 stdio MCP 时：

```bash
claude mcp add --transport stdio goal-graph -- goal-graph mcp
```
