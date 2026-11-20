# goal-graph-mcp 安装指南

为 Claude Code / Codex / OpenCode 生成 goal-graph MCP 配置片段：
- **默认零配置 `stdio` 模式**：直接拉起当前工作区的 `goal-graph mcp`（无需手动起 `serve`、无需固定端口、无需导出 token）；
- **进阶显式 `http` 模式（`--transport http [--port <p>]`）**：连接显式 `goal-graph serve` 端点，**token 绝不写进配置文件**（只写环境变量名 `GOAL_GRAPH_MCP_TOKEN`）。

## 1. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 22 | 生成器零依赖 |
| `goal-graph-cli`（stdio 默认模式） | 提供 `goal-graph mcp` | 装完 CLI 与配置后打开工作区即自动可用 |
| `goal-graph serve`（仅 `--transport http` 进阶模式） | 需先 `serve init` 生成 0600 token | 默认 stdio 模式无需手动启动或导出 token |

本包**只生成配置**，不含服务本身。默认 stdio 模式只需安装 `goal-graph-cli`；显式 HTTP 模式另需运行 `goal-graph serve`。

## 2. 安装

```bash
npm install -g goal-graph-mcp           # 全局
npm install --save-exact goal-graph-mcp # 项目本地
```

## 3. 最小验证步骤

```bash
# ① 默认生成三宿主零配置 stdio 配置（拉起 goal-graph mcp）
goal-graph-mcp all

# ② 可选：生成显式 HTTP 模式配置（指向同一 endpoint + 仅引用环境变量）
goal-graph-mcp all --transport http --port 7801

# ③ 自检：同时校验 stdio 与 http 两种模式不含 token 字面量
goal-graph-mcp all --check
# 期望：六个 ✅ 行（三宿主 × stdio/http），退出码 0
```

实测输出（v1.0.0，默认零配置 stdio）：

```
--- claude-code ---
{ "mcpServers": { "goal-graph": { "type": "stdio", "command": "goal-graph", "args": ["mcp"] } } }

--- codex ---
[mcp_servers.goal-graph]
command = "goal-graph"
args = ["mcp"]

--- opencode ---
{ "$schema": "https://opencode.ai/config.json",
  "mcp": { "servers": { "goal-graph": { "type": "local", "command": ["goal-graph", "mcp"] } } } }
```

### 3.1 三宿主各自的落点

| 宿主 | 写到哪 | 合并方式 |
|---|---|---|
| Claude Code | 项目 `.mcp.json`（可入库）或 `~/.claude.json` 的 `mcpServers` | 直接写入该 JSON |
| Codex | `~/.codex/config.toml` | **只合并** `[mcp_servers.goal-graph]` 一张表，**绝不整文件覆盖**（该文件被同机所有 Codex agent 共享） |
| OpenCode | `~/.config/opencode/opencode.json` 或项目 `opencode.json` | 并入 `mcp.servers` 键 |

`--write <dir>` 可把片段落盘为对应文件名（`.mcp.json` / `mcp-codex.toml` / `opencode.json`），
供你复制进真实配置；生成器**不直接写**真实宿主配置路径。

Claude Code 也可直接用 CLI（等价于默认 stdio 生成结果）：

```bash
claude mcp add --transport stdio goal-graph -- goal-graph mcp
```

## 4. 卸载

```bash
npm uninstall -g goal-graph-mcp
```

并手工从各宿主配置里删掉 `goal-graph` 条目（Codex 删 `[mcp_servers.goal-graph]` 整张表）。

## 5. 常见故障排查

### 5.1 版本不匹配

本包不依赖 DSH，只要求 Node ≥ 22。`--check` 退出码非 0 表示某个宿主模板没按预期引用环境变量，
请附 `goal-graph-mcp all` 的完整输出报 issue。

### 5.2 端口占用

生成器把 `--port` 的取值原样写进配置。若服务实际没起来，宿主会报连接失败：
先用 `ss -ltnp | grep <port>` 确认服务在跑，且**配置里的端口与 `serve init` 时的端口一致**
（`serve status` 可查 `config.port`）。

### 5.3 token 缺失（401）

- 外部 Agent 里报 `401` ⇒ 环境变量 `GOAL_GRAPH_MCP_TOKEN` 未在本进程环境中设置。
  注意：**宿主进程**要能看到该变量（GUI 应用需重新登录会话 / 重启应用才读到新变量）。
- 生成器**绝不**把 token 写进配置；若你的配置里出现了 `Bearer eyJ…` 这类字面量，那是手工改坏的，
  请重新生成。
- 旧 token 被轮换后请同步更新环境变量（服务对旧值一律 401）。

### 5.4 权限问题

- 读凭据文件失败（`cat: Permission denied`）⇒ 该文件应为 0600、目录 0700，且属主是你。
- 写 `--write` 目录失败 ⇒ 换成你有写权限的目录。

### 5.5 Codex 配置写坏

`~/.codex/config.toml` 被同机所有 Codex agent 共享。若手工合并出错导致 Codex 启动失败，
请**只删掉** `[mcp_servers.goal-graph]` 这一段（三行），其余配置不要动。
