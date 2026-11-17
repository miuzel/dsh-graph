# dsh-graph-mcp 安装指南

把 dsh-graph 的**只读**看板 MCP endpoint 接入外部 Agent，并生成 Claude Code / Codex / OpenCode
三宿主配置。

**token 绝不写进配置文件**——三个生成器都只写**环境变量名**，真实 token 从 dsh-graph 服务的
0600 凭据文件注入环境。

## 1. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 22 | 生成器零依赖 |
| 一个运行中的 dsh-graph 服务 | `dsh-graph serve`（来自 `dsh-graph-service` 或 `dsh-graph-cli`） | 提供 `http://127.0.0.1:<port>/mcp` |
| 服务已初始化 | 0600 凭据文件里存有 token | `dsh-graph serve init` 生成 |

本包**只生成配置**，不含服务本身。若还没有 endpoint，先装 `dsh-graph-service`（或用
`dsh-graph-cli` 的 `serve` 子命令）。

## 2. 安装

```bash
npm install -g dsh-graph-mcp           # 全局
npm install --save-exact dsh-graph-mcp # 项目本地
```

## 3. 最小验证步骤

```bash
# ① 生成三宿主配置（期望：三段配置，url 全部是同一 endpoint）
dsh-graph-mcp all --port 7801

# ② 自检：确认配置只引用环境变量、不含 token 字面量
dsh-graph-mcp all --check
# 期望：三个 ✅ 行，退出码 0

# ③ 把真实 token 注入环境（从服务凭据文件读，不要写进任何配置文件）
export DSH_GRAPH_MCP_TOKEN="$(cat ~/.dsh-graph-service/token)"

# ④ 用该 token 打通 endpoint
curl -s -X POST http://127.0.0.1:7801/mcp \
  -H "Authorization: Bearer $DSH_GRAPH_MCP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 200
```

实测输出（v1.0.0）：

```
--- claude-code ---
{ "mcpServers": { "dsh-graph": { "type": "http",
    "url": "http://127.0.0.1:7801/mcp",
    "headers": { "Authorization": "Bearer ${DSH_GRAPH_MCP_TOKEN}" } } } }

--- codex ---
[mcp_servers.dsh-graph]
url = "http://127.0.0.1:7801/mcp"
bearer_token_env_var = "DSH_GRAPH_MCP_TOKEN"

--- opencode ---
{ "mcp": { "dsh-graph": { "type": "remote", "url": "http://127.0.0.1:7801/mcp",
    "headers": { "Authorization": "Bearer {env:DSH_GRAPH_MCP_TOKEN}" } } } }

# 三宿主共用同一 endpoint：http://127.0.0.1:7801/mcp
```

### 3.1 三宿主各自的落点

| 宿主 | 写到哪 | 合并方式 |
|---|---|---|
| Claude Code | 项目 `.mcp.json`（可入库）或 `~/.claude.json` 的 `mcpServers` | 直接写入该 JSON |
| Codex | `~/.codex/config.toml` | **只合并** `[mcp_servers.dsh-graph]` 一张表，**绝不整文件覆盖**（该文件被同机所有 Codex agent 共享） |
| OpenCode | `~/.config/opencode/opencode.json` 或项目 `opencode.json` | 并入 `mcp` 键 |

`--write <dir>` 可把片段落盘为对应文件名（`.mcp.json` / `mcp-codex.toml` / `opencode.json`），
供你复制进真实配置；生成器**不直接写**真实宿主配置路径。

Claude Code 也可直接用 CLI（等价于生成的内容）：

```bash
claude mcp add --transport http dsh-graph http://127.0.0.1:7801/mcp \
  --header "Authorization: Bearer $DSH_GRAPH_MCP_TOKEN"
```

## 4. 卸载

```bash
npm uninstall -g dsh-graph-mcp
```

并手工从各宿主配置里删掉 `dsh-graph` 条目（Codex 删 `[mcp_servers.dsh-graph]` 整张表）。

## 5. 常见故障排查

### 5.1 版本不匹配

本包不依赖 DSH，只要求 Node ≥ 22。`--check` 退出码非 0 表示某个宿主模板没按预期引用环境变量，
请附 `dsh-graph-mcp all` 的完整输出报 issue。

### 5.2 端口占用

生成器把 `--port` 的取值原样写进配置。若服务实际没起来，宿主会报连接失败：
先用 `ss -ltnp | grep <port>` 确认服务在跑，且**配置里的端口与 `serve init` 时的端口一致**
（`serve status` 可查 `config.port`）。

### 5.3 token 缺失（401）

- 外部 Agent 里报 `401` ⇒ 环境变量 `DSH_GRAPH_MCP_TOKEN` 未在本进程环境中设置。
  注意：**宿主进程**要能看到该变量（GUI 应用需重新登录会话 / 重启应用才读到新变量）。
- 生成器**绝不**把 token 写进配置；若你的配置里出现了 `Bearer eyJ…` 这类字面量，那是手工改坏的，
  请重新生成。
- 旧 token 被轮换后请同步更新环境变量（服务对旧值一律 401）。

### 5.4 权限问题

- 读凭据文件失败（`cat: Permission denied`）⇒ 该文件应为 0600、目录 0700，且属主是你。
- 写 `--write` 目录失败 ⇒ 换成你有写权限的目录。

### 5.5 Codex 配置写坏

`~/.codex/config.toml` 被同机所有 Codex agent 共享。若手工合并出错导致 Codex 启动失败，
请**只删掉** `[mcp_servers.dsh-graph]` 这一段（三行），其余配置不要动。
