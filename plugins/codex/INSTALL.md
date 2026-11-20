# goal-graph for Codex

把本地 goal-graph 目标看板接入 Codex CLI。本目录提供 Codex 可识别的插件清单、MCP 连接与外部宿主版技能正文。

> Codex 直接读取 `.claude-plugin/marketplace.json` 与 `.claude-plugin/plugin.json`（与 Claude Code 同格式），
> 因此两者共用清单形状；**但 MCP 的 token 传递方式不同**，见 §3。

## 1. 前置

| 项 | 要求 | 检查 |
|---|---|---|
| Node.js | ≥ 22 | `node --version` |
| goal-graph CLI | 提供 `goal-graph serve` | `goal-graph version` |
| Codex CLI | ≥ 0.166（需 `plugin` / `plugin marketplace` / `mcp` 子命令） | `codex --version` |
| 看板数据 | 目标项目内已有看板核心资料目录 | 该项目内 `goal-graph status` |

**服务必须先初始化**。先设两个**不同的**绝对路径（下文所有命令复用，同一 shell 里 export 一次）：

```bash
export DSH_BOARD="$HOME/.dsh-graph-boards/$(basename "$PWD")"
export DSH_WS="$PWD"
mkdir -p "$DSH_BOARD"
```

```bash
goal-graph serve init --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788
```

> ⚠️ `--root` 与 `--workspace` **必须不同、且不得互相包含**（看板数据不得混在被扫描的工作树里）。
> 同值会报 `错误：graphRoot 与 executionWorkspace 不得相同：<路径>`（exit 2）；互为父子则报 `不得互相包含`。
> `--port` 也建议显式给 —— 不指定时 `serve` 每次用系统随机端口，而 `.mcp.json` 里是固定 URL，端口一变就连不上。

## 2. 一条命令安装

```bash
codex plugin marketplace add <本目录路径> && codex plugin add goal-graph@goal-graph
```

`<本目录路径>` 换成 `plugins/codex` 的绝对路径。例：

```bash
codex plugin marketplace add /path/to/dsh-graph/plugins/codex
codex plugin add goal-graph@goal-graph
```

Codex 的 `plugin marketplace add` 接受**本地路径**。

## 3. 认证：为什么用 `bearer_token_env_var`

goal-graph 服务只认 `Authorization: Bearer <token>` 一种形态（`parseBearer` 要求 `Bearer\s+<token>`）。
Codex 0.166 的插件 MCP schema（`AgentPluginMcpServer::StreamableHttp`）承载 `url`、`headers` 与
`bearer_token_env_var`；但**承载 ≠ 运行时会用** —— 下面三种写法在**运行时**的真实表现并不相同
（受控探针实测，见 §5）：

| 写法 | 服务端实收 | 说明 |
|---|---|---|
| `headers: { Authorization: "Bearer ${VAR}" }` | 不发认证头 | 该字段**被 schema 接受**，但插件路径下 `${VAR}` 不做环境变量插值，发出去是字面量/空 |
| `env_http_headers: { Authorization: "Bearer ${VAR}" }` | **不发认证头**（`undefined`） | **不可用**：插件 MCP schema 不承载该字段，运行时被丢弃 |
| `bearer_token_env_var: "GOAL_GRAPH_MCP_TOKEN"` | ✅ `Bearer <token>` | 本目录采用：变量名进配置、token 值只在环境变量里 |

> 判读要点：`headers` 与 `bearer_token_env_var` **都是 schema 承认的字段**，区别在于
> **插件运行时只对 `bearer_token_env_var` 做真正的 token 注入**；而 `env_http_headers` 连 schema 都不承载。

所以本目录的 `.mcp.json` 用：

```json
{ "mcpServers": { "goal-graph": { "type": "http", "url": "http://127.0.0.1:7788/mcp",
  "bearer_token_env_var": "GOAL_GRAPH_MCP_TOKEN" } } }
```

`bearer_token_env_var` 发送的正是 `Bearer <token>`，**就是本服务接受的形式**（裸 token 无前缀会被 401 拒绝）。
插件路径**确实承载并使用**该字段（与 `headers` 不同：后者虽被 schema 接受，运行时却不做插值），
无需额外的宿主侧 `codex mcp add` 配置。

> ⚠️ **`codex mcp get` 不能作为「认证可用」的证据**：它只回显静态配置，即使认证头在运行时被丢弃也照样显示。
> 判别性验证见 §5。

**token 不落盘**：配置里只有变量名（值 `GOAL_GRAPH_MCP_TOKEN`），token 值只在环境变量里。

## 4. 启动服务并注入 token

```bash
export GOAL_GRAPH_MCP_TOKEN="$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/goal-graph-service/token")"
goal-graph serve --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788
```

> **`serve` 与 `serve init` 是两条不同命令**：`serve` 同样要求 `--root` / `--workspace`（缺则报用法错误），
> `--port` 也必须显式给（否则用随机端口）。启动行打印 `goal-graph 本地只读服务已启动：http://127.0.0.1:7788`。

需要 Codex 能修改看板时由服务端开启写模式（客户端无法开启）：

```bash
goal-graph serve --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788 --allow-write
```

## 5. 最小验证（判别性：必须看到实际认证结果）

> 下面两步都**必须**看到「服务端是否接受认证」的真实结果。只回显配置的命令没有判别力（见 **5c**）。

**5a. 先确认服务端接受 `Bearer <token>`**（绕过 Codex，确认服务与 token 本身可用）：

```bash
curl -s -X POST http://127.0.0.1:7788/mcp \
  -H "Authorization: Bearer $GOAL_GRAPH_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

预期：`"tools":[...]` 数组（默认 11 个；`--allow-write` 时 38 个）。若这里已 401，问题在 token/端口，
与 Codex 无关，先按 §8 排障。

**5b. 再确认 Codex 侧真的能调到工具**（这才是认证是否生效的判据）：在 Codex 里让模型调用一次
`graph_list_goals`（只读，最轻）。**判据是工具返回正常结果**；若返回 401 / 未认证，说明认证头没发出去。

反向自检（可选，用来确认 401 是什么样子）：先 `unset GOAL_GRAPH_MCP_TOKEN` 再调同一个工具，
应得到 401 —— 拿到正常结果即证明认证确实生效。

**5c. 不要**把下面两条当成「认证可用」的证据：

```bash
codex plugin list     # 只说明插件装上了，与认证无关
codex mcp get goal-graph  # 只回显静态配置：即使认证头运行时被丢弃也照样显示"已配置"
```

`codex mcp get` 可以确认「字段写对了」（应显示 `bearer_token_env_var: GOAL_GRAPH_MCP_TOKEN`），
但**无法证明**认证头真的发出 —— 这一条当年正是把 `env_http_headers` 误判为生效的原因。

预期 `codex plugin list` 显示：

```
PLUGIN                 STATUS              VERSION  SOURCE
goal-graph@goal-graph  installed, enabled  1.0.0    /path/to/plugins/codex
```

预期 `codex mcp get goal-graph` 显示：

```
  url: http://127.0.0.1:7788/mcp
  bearer_token_env_var: GOAL_GRAPH_MCP_TOKEN
```

## 6. 能做什么 / 做不到什么

与 Claude Code 版一致：默认只读 11 个工具；`--allow-write` 后 38 个；
`graph_resolve_accept` / `transition → delivered` / `graph_claim_supervisor` / `graph_start_attempt`
**在任何模式下都不可达**，必须回 DSH 看板或本地 GUI 裁决。详见 `skills/goal-graph/SKILL.md`。

## 7. 卸载

```bash
codex plugin remove goal-graph@goal-graph
codex plugin marketplace remove goal-graph
```

服务侧清理（不动看板数据）：`goal-graph serve uninstall`。

## 8. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 服务报 401 未认证 | 认证头没发出：配了 `headers` 或 `env_http_headers`（插件路径都不发头） | 改用 `bearer_token_env_var`（本目录默认已是） |
| 401 且已用 `bearer_token_env_var` | `GOAL_GRAPH_MCP_TOKEN` 没在**启动 Codex 的那个 shell** 里导出，或值为空 | 在同一 shell `export`（值不要带 `Bearer ` 前缀）后重启 Codex |
| 连不上 `127.0.0.1:7788` | **① `--root` 与 `--workspace` 相同或互相包含 → 服务根本没起来**（`错误：graphRoot 与 executionWorkspace 不得相同：<路径>`，exit 2）<br>② `serve` 没显式 `--port`，端口是随机的<br>③ 服务没起 | 两路径必须不同且不互相包含（见 §1）；`serve` 同样显式 `--port 7788`；以启动行打印的 origin 为准 |
| 端口被占 | 该端口已有进程 | 换 `--port` 并同步 `url` |
| `serve init` 报 `ENOENT ... mkdir '<XDG 路径>/goal-graph-service'` | `XDG_STATE_HOME` 指向的位置**不可写**（沙盒/只读挂载），服务状态目录由它派生 | 把 `XDG_STATE_HOME` 指向可写目录（或显式 `--state-dir <可写绝对路径>`）后重跑 `serve init` |
| `serve status` 显示 `port: 7788` 但实际监听别的端口 | 未给 `--port` 时 `parseServeArgs` 把 port 置 `0`，`args.port ?? config.port` 拦不住 `0` ⇒ **运行配置里的 port 被忽略**（产品行为，已用显式 `--port` 规避） | 一律显式 `--port`；端口以启动行为准 |
| **同一 XDG 目录连跑两次 `opencode run`，第二次不再连 MCP** | 探针实测：第一次有 `server=goal-graph` 连接记录（收到 3 个请求），第二次同目录重跑未再发起连接（收到 0 个）—— **确切原因未查明**，不对机制作断言（该现象在 OpenCode 侧观测；Codex 侧未做同类对照） | 每轮验证用**全新** `XDG_*` 目录（探针即如此做）；不要复用上一次的 `XDG_DATA_HOME` / `XDG_CONFIG_HOME` 重跑 |
| `E_NOT_INITIALIZED` | 看板未初始化 | 在目标项目 `goal-graph serve init --root <绝对路径> --workspace <绝对路径>` |
| `E_UNKNOWN_COMMAND` | 工具未注册（只读模式下请求写工具，或人工裁决保留项） | 需要写就重启服务加 `--allow-write`；裁决走 GUI |
| `E_FORBIDDEN` | 参数被拒（典型 `to=delivered`） | 迁到 `review`，交付由人裁决 |
| 版本不匹配 | 插件 `1.0.0` 与 CLI 版本差距过大 | 升级 CLI；插件只依赖 `serve` 的 MCP 契约 |

## 9. 验证状态（哪些实测过、哪些没有）

> **口径**：只有**实际跑过并留下输出**的条目才算「✅ 已实测」；其余一律标「❌ 未验证」并写明原因，
> **不声称已通过**。本表与 OpenCode 版（`plugins/opencode/INSTALL.md` §8）同一口径，
> 并由 `core/tests/g633-host-plugins.test.ts` 的 ⑧b 守卫逐条钉住。

### 9a. 已实测（`codex-cli 0.166.0`）

| 项 | 状态 | 证据（当时实跑的输出） |
|---|---|---|
| `codex plugin marketplace add <本目录>` 能接受本地路径 | ✅ 已实测 | 输出 `Added marketplace`，无错误 |
| `codex plugin add goal-graph@goal-graph` 能装上并启用 | ✅ 已实测 | 输出 `installed, enabled`；`codex plugin list` 显示 `goal-graph@goal-graph  installed, enabled  1.0.0  /path/to/plugins/codex` |
| `codex mcp list` 能读到本目录的 MCP 条目 | ✅ 已实测（**无鉴别力**） | 显示 `goal-graph ... Bearer token`。**只证明条目存在与静态字段被识别**，不证明认证头真的发出（见 §3 与 §5c） |
| `bearer_token_env_var` 在**运行时**确实发出 `Authorization: Bearer <token>` | ✅ 已实测（受控探针） | 用同一插件、同一本地监听器对比三种写法：`bearer_token_env_var` ⇒ 服务端收到 `Bearer <token>`、`authStatus=bearerToken`；`env_http_headers` ⇒ 服务端收到 `undefined`、`authStatus=unknown`。见 §3 的表 |
| `env_http_headers` 在插件路径下**不**发认证头 | ✅ 已实测（决定性负向对照） | 同上探针，服务端实收 `undefined`（根本没有 `Authorization` 头）⇒ 该写法不可用 |

### 9b. 未实测（如实标注，不要按「已通过」理解）

| 项 | 状态 | 原因 / 边界 |
|---|---|---|
| Codex **会话内**经模型走完 `tools/call` 的完整链路 | ❌ **未验证** | 本轮只验证到「插件安装 + MCP 条目被识别 + 认证头在传输层确实发出」为止；**模型在会话里实际调用一次 `graph_*` 工具并拿到结果**这一步没有跑过。因此 §5b 的判据请你在自己的 Codex 里当场确认，不要把本文件的实测项当成它的背书 |
| `skills/` 目录被 Codex 自动发现并加载 | ❌ **未验证** | 未做实测；Codex 侧技能目录规则未确认，请按你的 Codex 版本手工放置或核对 |
| `codex plugin remove` / `plugin marketplace remove`（§7 卸载命令） | ❌ **未验证** | 卸载命令按 CLI 帮助写成，未在本轮实跑 |
| Codex 侧「同一 XDG 目录连跑两次第二次不连 MCP」的同类对照 | ❌ **未验证** | 该现象在 **OpenCode 侧**实测到；Codex 侧**没有做**同类对照，故 §8 该行明确写了「Codex 侧未做」 |
