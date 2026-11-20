# goal-graph for Claude Code

把本地 goal-graph 目标看板接入 Claude Code：一个插件同时带来 **看板 MCP 工具** 与 **外部宿主版技能正文**。

> **本插件不含产品代码**：MCP 能力来自你已安装的 `goal-graph` CLI（`goal-graph-cli`）启动的本地 `serve` 实例，
> 技能正文由插件内 `skills/` 提供（外部宿主专用版，不含 DSH 插件版里外部宿主做不到的指引）。

## 1. 前置

| 项 | 要求 | 检查 |
|---|---|---|
| Node.js | ≥ 22 | `node --version` |
| goal-graph CLI | 提供 `goal-graph serve`（含 `serve init/status`） | `goal-graph version` |
| Claude Code | ≥ 2.1（需 `plugin` / `plugin marketplace` 子命令） | `claude --version` |
| 看板数据 | 目标项目内已有 `.dsh-graph/`（或自定义核心资料目录） | 该项目内 `goal-graph status` |

**服务必须先在目标项目里初始化**（`serve init` 会生成 ≥256bit token 与 0600 私有凭据文件）。

先设两个**不同的**绝对路径（下文所有命令都复用这两个变量，请在同一 shell 里 export 一次）：

```bash
# DSH_BOARD：看板数据目录（放在工作树之外，与执行目录分离）
# DSH_WS   ：执行目录（你实际改代码的项目根）
export DSH_BOARD="$HOME/.dsh-graph-boards/$(basename "$PWD")"
export DSH_WS="$PWD"
mkdir -p "$DSH_BOARD"
```

```bash
goal-graph serve init --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788
```

> ⚠️ **`--root` 与 `--workspace` 必须不同，且不得互相包含**（安全语义：看板数据不得混在被扫描的工作树里）。
> `--root "$PWD" --workspace "$PWD"` 会直接报错 `错误：graphRoot 与 executionWorkspace 不得相同：<路径>`（exit 2）；
> 把 `--root` 设成 `$PWD` 的父目录则报 `不得互相包含`。两者都必须是**绝对路径**。
>
> `--port` 建议**显式指定**：不指定时 `serve` 每次启动都用系统分配的随机端口（实测同一配置两次启动
> 分别落在 `44698` / `45158`），而插件 `.mcp.json` 里写的是固定 URL，端口一变就连不上。
>
> 若你的看板用了自定义资料目录名，追加 `--graph-dir-name <名字>`（或直接把 `--root` 指向该目录的绝对路径）。

## 2. 一条命令安装

```bash
claude plugin marketplace add <本目录路径> && claude plugin install goal-graph@goal-graph -y
```

把 `<本目录路径>` 换成 `plugins/claude-code` 的绝对路径。例：

```bash
claude plugin marketplace add /path/to/dsh-graph/plugins/claude-code
claude plugin install goal-graph@goal-graph -y
```

`marketplace add` 支持**本地路径**，所以不需要发布到远端即可安装。

可选：若你想让两台机器共用一个市场，也可以 `claude plugin marketplace add <git-url> --sparse plugins/claude-code`。

## 3. 启动服务并注入 token

插件里的 `.mcp.json` **只写变量名**，token 本体绝不落盘：

```json
{ "Authorization": "Bearer ${GOAL_GRAPH_MCP_TOKEN}" }
```

所以启动服务前要把凭据文件里的 token 注入环境变量（服务私有状态目录默认在
`${XDG_STATE_HOME:-~/.local/state}/goal-graph-service/token`，`serve init` 的输出会打印确切路径）：

```bash
export GOAL_GRAPH_MCP_TOKEN="$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/goal-graph-service/token")"
goal-graph serve --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788
```

> **`serve` 不是 `serve init` 的回放**：`serve` 同样要求 `--root` / `--workspace` 两个绝对路径（缺任一个都报用法错误），
> 且 `--port` 也必须显式给（见 §1 的端口说明）。启动成功会打印 `goal-graph 本地只读服务已启动：http://127.0.0.1:7788`。

默认只读。要让 Claude 能改看板（建目标/写判据/加卡片等），服务端加 `--allow-write`：

```bash
goal-graph serve --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788 --allow-write
```

> 启动行会变成 `goal-graph 本地服务（写模式已开启）已启动：…`，并多打印一行 `写模式 ON（--allow-write）`。

> 写模式**只能由服务端启动参数决定**；在 Claude 里传 `allowWrite` 之类的参数不会生效，还会被当保留参数拒绝。

## 4. 最小验证

在**另一个终端**先确认服务与 token 正常：

```bash
curl -s -X POST http://127.0.0.1:7788/mcp \
  -H "Authorization: Bearer $GOAL_GRAPH_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

预期：返回一个 `"tools":[...]` 数组。**默认只读时 11 个工具**，`--allow-write` 时 **38 个**。

再在 Claude Code 里确认插件装好且组件被识别：

```bash
claude plugin details goal-graph@goal-graph
```

预期输出包含：

```
Component inventory
  Skills (1)  goal-graph
  MCP servers (1)  goal-graph
```

最后在 Claude Code 会话里让它列目标，预期能读到看板数据（或 `E_NOT_INITIALIZED`，说明该项目还没 `serve init`）。

## 5. 能做什么 / 做不到什么

- **只读模式**：11 个查询工具（看板、目标、判据、卡片、结果、附件、事件、设置）。
- **写模式**（`--allow-write`）：再加 27 个写工具，可建目标、登记判据、迁移到
  `draft/planning/collecting/ready/in_progress/review/blocked`、写卡片/评论/记忆/设置。
- **做不到（人工裁决保留项）**：`graph_resolve_accept`、`graph_transition → delivered`、
  `graph_claim_supervisor`、`graph_start_attempt` 在任何模式下都不可达。
  Claude 最多把目标推进到 `review`，**必须由人在 DSH 看板或本地 GUI 裁决**。

详见插件内技能正文 `skills/goal-graph/SKILL.md`。

## 6. 卸载

```bash
claude plugin uninstall goal-graph@goal-graph
claude plugin marketplace remove goal-graph
```

服务侧如需一并清理（只删本服务自有凭据与运行配置，**看板数据不动**）：

```bash
goal-graph serve uninstall
```

## 7. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| MCP 报 401 | `GOAL_GRAPH_MCP_TOKEN` 没注入或与凭据文件不一致 | 重新 `export GOAL_GRAPH_MCP_TOKEN=...`，确认与服务启动时的 token 同源；必要时 `serve status` 看 `tokenFingerprint` |
| 连不上 `127.0.0.1:7788` | **① `--root` 与 `--workspace` 相同或互相包含 → 服务根本没起来**（`错误：graphRoot 与 executionWorkspace 不得相同：<路径>`，exit 2）<br>② `serve` 没显式 `--port`，端口是随机的<br>③ 服务没起 | 两个路径必须不同且不互相包含（见 §1）；`serve` 与 `serve init` 一样显式带 `--port 7788`；先确认启动行打印的 origin |
| 端口被占 | 该端口已有进程 | 换 `--port`，并同步改 `.mcp.json` 的 `url` |
| `serve init` 报 `ENOENT ... mkdir '<XDG 路径>/goal-graph-service'` | `XDG_STATE_HOME` 指向的位置**不可写**（沙盒/只读挂载），服务状态目录由它派生 | 把 `XDG_STATE_HOME` 指向可写目录（或显式 `--state-dir <可写绝对路径>`）后重跑 `serve init`；token 与运行配置都落在该目录 |
| `serve status` 显示 `port: 7788` 但服务实际监听别的端口 | `parseServeArgs` 在未给 `--port` 时把 port 置为 `0`，`args.port ?? config.port` 的 `??` 不会拦截 `0` ⇒ **运行配置里的 port 被忽略、退回系统随机端口**（产品行为，已在 §1 用显式 `--port` 规避） | 一律显式 `--port`；端口以启动行打印的 origin 为准，不以 `serve status` 为准 |
| **同一 XDG 目录连跑两次 `opencode run`，第二次不再连 MCP** | 探针实测：第一次有 `server=goal-graph` 连接记录（收到 3 个请求），第二次同目录重跑未再发起连接（收到 0 个）—— **确切原因未查明**，不对机制作断言 | 每轮验证用**全新** `XDG_*` 目录（探针即如此做）；不要复用上一次的 `XDG_DATA_HOME` / `XDG_CONFIG_HOME` 重跑 |
| `E_NOT_INITIALIZED` | 看板未初始化 | 在目标项目执行 `goal-graph serve init --root <绝对路径> --workspace <绝对路径>` |
| `E_UNKNOWN_COMMAND` | 工具未注册：写了写工具但服务是只读；或碰了人工裁决保留项 | 需要写就重启服务加 `--allow-write`；人工裁决走 GUI |
| `E_FORBIDDEN` | 参数被拒（典型：`to=delivered`） | 改用 `review`，交付由人裁决 |
| `plugin install` 报找不到插件 | marketplace 名/插件名不对 | `claude plugin marketplace list` 确认名字是 `goal-graph` |
| 版本不匹配 | 插件 `1.0.0` 与 CLI 大版本不一致 | 升级 CLI 到同版本；插件只依赖 `serve` 的 MCP 契约（`contractVersion`），跨小版本通常兼容 |

不想用插件的 `.mcp.json` 而想手配 MCP（同时用插件技能）时：

```bash
claude mcp add --transport http goal-graph http://127.0.0.1:7788/mcp \
  --header "Authorization: Bearer $GOAL_GRAPH_MCP_TOKEN"
```
