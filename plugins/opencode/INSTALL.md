# goal-graph for OpenCode

> ## ✅ 验证状态（请先读这里）
>
> **本目录的 OpenCode 接入已在真机实测通过关键链路**（OpenCode CLI v2.0.24）：零配置 stdio（`type: "local"` + `command: ["goal-graph", "mcp"]`）配置形状、OpenCode 真实拉起 `goal-graph mcp` 子进程、真实 stdio MCP 往返（38 工具默认 / `--read-only` 11 工具 + 随机端口 Web），以及进阶 HTTP 模式的 `{env:}` 插值、认证头实际发出与真实 `goal-graph serve` 协议往返均有实测证据（**可用 `scripts/g633-opencode-mcp-probe.mjs` 一条命令复跑**）。
> **未验证项（与 §8 表格逐项相同）**：① `skills/` 是否被 OpenCode 自动发现；② OpenCode **会话内**经 LLM
> 走到工具调用的链路（本机 LLM 上游不可用，仅证实 OpenCode 拉起了 stdio 进程并发起了 MCP 连接）。
> 逐项对照见文末 §8。
>
> - **日志路径不是硬编码**：OpenCode 的数据目录与日志路径由 `XDG_DATA_HOME` 派生
>   （默认 `~/.local/share/opencode/log/opencode.log`）。若该默认位置只读（沙盒/EROFS），进程会在写日志时崩溃，
>   但**把 `XDG_*` 重定向到可写目录后即可正常启动** —— 实测 `opencode --version` 输出 `opencode v2.0.24` 且 exit 0：
>
>   ```bash
>   XDG_DATA_HOME=... XDG_CONFIG_HOME=... XDG_STATE_HOME=... XDG_CACHE_HOME=... opencode --version
>   # → opencode v2.0.24   (exit 0)
>   ```
>
> - **已实测**：① `opencode mcp add goal-graph --global -- goal-graph mcp` 产出的 JSON 与本目录 `opencode.json` **逐字段一致**，且 `opencode run --standalone` 实测真实拉起 `goal-graph mcp` 子进程；
>   ② 真实 `goal-graph mcp` stdio 往返完成 `initialize`（`serverInfo=goal-graph-local`）、`tools/list`（默认 38 个工具、`--read-only` 11 个）并自动以 `127.0.0.1:0` 分配空闲端口起本地 Web 看板；
>   ③ 进阶 HTTP 模式下 `opencode debug config` 显示 `***`（**注意：`***` 仅为显示掩码，对任意值一律生效，无鉴别力**），带日志监听器实收 `{env:}` 插值后的 `Bearer <token>`（未导出退化为 `Bearer` 长度 6，`${VAR}` 不插值），真实 `goal-graph serve` 无认证头返回 401。
> - **`opencode mcp list` 不作判据**：本环境实测它**冷启动**时返回 `No MCP servers configured`，
>   **跑过一次会话后**又能列出 `○ goal-graph pending`；若后台托管服务端口被占则直接报错。**配置未变、输出不同 ⇒ 原因未查明**，故不作判据。

把本地 goal-graph 目标看板接入 OpenCode。本目录提供 OpenCode 原生的零配置 stdio `opencode.json` 配置片段与外部宿主版技能正文。

> **零配置开箱即用**：装好 `goal-graph-cli` 与本配置后，在任意工作区启动 OpenCode 即可自动使用（无需手动跑 `goal-graph serve`、无需固定端口 `7788`、无需 `export GOAL_GRAPH_MCP_TOKEN`）。
> **重要差异（如实说明）**：OpenCode 的 `opencode plugin add` 只接受 **npm / Git 包说明符**，没有 Claude Code / Codex 那样的「本地路径市场」；请按下文用一条 `opencode mcp add` 命令写入配置。

## 1. 前置

| 项 | 要求 | 检查 |
|---|---|---|
| Node.js | ≥ 22 | `node --version` |
| goal-graph CLI | `goal-graph-cli`（提供 `goal-graph mcp` 与 `goal-graph serve`） | `goal-graph version` |
| OpenCode | ≥ 2.0（需 `mcp` 子命令） | `opencode --version` |
| 看板数据 | 目标项目内已有 `.dsh-graph/`（或自定义核心资料目录；未初始化时 MCP 照常启动，查询返回 `E_NOT_INITIALIZED`） | 该项目内 `goal-graph status` |

## 2. 一条命令安装

用 OpenCode 自己的 `mcp add --global` 写入零配置 stdio 配置（无需端口、无需 token）：

```bash
opencode mcp add goal-graph --global -- goal-graph mcp
```

写入位置：`${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json`。产出的配置形状与本目录的 `opencode.json` 逐字段一致：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "servers": {
      "goal-graph": {
        "type": "local",
        "command": ["goal-graph", "mcp"]
      }
    }
  }
}
```

也可直接采用本目录的文件：

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
cp plugins/opencode/opencode.json "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
```

需要仅只读时，把 `command` 改为 `["goal-graph", "mcp", "--read-only"]`（11 个只读工具；默认 38 个读写工具，并自动按工作区以 `127.0.0.1:0` 分配空闲端口起/复用本地 Web 看板，退出自动回收）。

技能正文：把 `plugins/opencode/skills/goal-graph/` 放到 OpenCode 的技能目录（与你的 OpenCode 版本的技能发现规则一致），或直接让 agent 阅读 `SKILL.md` 作为说明文档。

## 3. 进阶：显式 HTTP `goal-graph serve` 模式

若你需要连接手动管理的长期前台 HTTP 服务（默认只读 11 工具，按需 `--allow-write` 开启 38 工具），需先显式初始化并注入 token：

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

再用 `opencode mcp add` 或 `goal-graph-mcp opencode --transport http --port 7788` 写入 HTTP 配置：

```bash
opencode mcp add goal-graph --url http://127.0.0.1:7788/mcp \
  --header "Authorization=Bearer {env:GOAL_GRAPH_MCP_TOKEN}" --global
```

## 4. 最小验证

先确认 `goal-graph mcp` stdio 往返正常：

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n' | goal-graph mcp --no-web
```

预期：stdout 输出单行合法 JSON-RPC 响应，含 **38 个工具**（加 `--read-only` 为 **11 个**）。

再确认 OpenCode 读到了配置：

```bash
opencode debug config
```

预期在输出中看到 `"mcp": { "servers": { "goal-graph": { "type": "local", "command": ["goal-graph", "mcp"] } } }`。
最后在 OpenCode 会话里让它列目标（`graph_list_goals`），预期能读到当前工作区的看板数据。

> **不要用 `opencode mcp list` 判断接入是否成功**：本环境实测它冷启动时返回 `No MCP servers configured`，
> 跑过会话后又能列出 `○ goal-graph pending`（配置未变、输出不同，**原因未查明**），故不作判据。
> 判据请用 §8 探针的真实拉起（`P2c`）与协议往返（`P2d` / `P4`–`P7`）。

## 5. 能做什么 / 做不到什么

与 Claude Code / Codex 版一致：零配置 stdio 默认 38 个读写工具（`--read-only` 或显式 `serve` 默认只读为 11 个）；
`graph_resolve_accept` / `transition → delivered` / `graph_claim_supervisor` / `graph_start_attempt`
**不可达**，须回 DSH 看板或本地 GUI 裁决。详见 `skills/goal-graph/SKILL.md`。

## 6. 卸载

```bash
# OpenCode 的 mcp 子命令没有 remove（只有 list/add/auth/logout）⇒ 从配置里删掉该条目：
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const f=path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),".config"),"opencode","opencode.json");
const j=JSON.parse(fs.readFileSync(f,"utf8"));
delete j.mcp?.servers?.["goal-graph"];
fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");
console.log("removed goal-graph from",f);'
```

如曾用过显式 `serve` 模式，服务侧清理（不动看板数据）：`goal-graph serve uninstall`。

## 7. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即报 `EROFS ... /opencode/log/opencode.log` | 默认数据目录只读（该路径由 `XDG_DATA_HOME` 派生，非硬编码） | 把 `XDG_DATA_HOME`（必要时加 `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME`）指向可写目录后重启；实测重定向后 `opencode --version` 正常输出 `v2.0.24` |
| OpenCode 找不到 `goal-graph` 命令 | `goal-graph-cli` 未安装或不在 OpenCode 进程 `PATH` 中 | 执行 `npm install -g goal-graph-cli`，确认 `which goal-graph` 可见后重启 |
| `opencode mcp list` 输出不可靠（冷启动报 `No MCP servers configured`，跑过会话后又列出 `pending`） | **原因未查明** | **不要据此判失败**；用 §8 探针实测子进程拉起与 MCP 协议往返 |
| 显式 HTTP 模式报 401 | `GOAL_GRAPH_MCP_TOKEN` 没在**启动 OpenCode 的那个 shell** 里导出，`{env:}` 被替换成空串 | 同一 shell `export` 后重启 OpenCode，或改用默认零配置 stdio |
| 显式 HTTP 模式连不上 `127.0.0.1:7788` | **① `--root` 与 `--workspace` 相同或互相包含 → 服务根本没起来**（`错误：graphRoot 与 executionWorkspace 不得相同：<路径>`，exit 2）<br>② 未显式 `--port` 或端口被占<br>③ 服务未启动 | 两路径必须不同且不互相包含（见 §3）；建议改用默认零配置 stdio |
| `serve init` / 自动 Web 服务报 `ENOENT ... mkdir '<XDG 路径>/goal-graph-service'` | `XDG_STATE_HOME` 指向的位置**不可写**（沙盒/只读挂载），服务状态目录由它派生 | 把 `XDG_STATE_HOME` 指向可写目录（或传 `--state-dir <可写绝对路径>` / `--no-web`） |
| **同一 XDG 目录连跑两次 `opencode run`，第二次不再连 MCP** | 探针实测：第一次有 `server=goal-graph` 连接记录，第二次同目录重跑未再发起连接（**确切原因未查明**，不对机制作断言） | 每轮验证用**全新** `XDG_*` 目录（探针即如此做）；不要复用上一次的 `XDG_DATA_HOME`/`XDG_CONFIG_HOME` 重跑 |
| `E_NOT_INITIALIZED` | 当前工作区没有 `.dsh-graph/events.jsonl` | 在含看板的项目目录启动 OpenCode，或初始化看板 |
| `E_UNKNOWN_COMMAND` | 工具未注册（开启了 `--read-only` / 显式只读 `serve`，或人工裁决保留项） | 需要写就去掉 `--read-only`（显式 HTTP 加 `--allow-write`）；裁决走 GUI |
| `E_FORBIDDEN` | 参数被拒（典型 `to=delivered`） | 迁到 `review`，交付由人裁决 |
| 版本不匹配 | 插件配置 `1.0.0` 与 CLI 差距过大 | 升级 `goal-graph-cli` |

## 8. 实测记录与验证状态

**版本绑定期**：下表全部结论绑定在 `OpenCode CLI v2.0.24` + 本仓库 `1.0.0` 上实测；换版本后请重跑探针。

**证据可复跑**（探针已落盘，同时覆盖零配置 stdio 与进阶显式 HTTP 两种形态）：

```bash
# 在仓库根执行；需要先 bash scripts/build.sh 产出 dist/，以及 PATH 里有 opencode
TMPDIR=/tmp node scripts/g633-opencode-mcp-probe.mjs
```

探针会自动建临时目录、跑完即清理，打印每个实测项 `PASS/FAIL`、**是否具鉴别力**，并给出 `exit` 码。

| 项 | 状态 | 证据（可复跑） |
|---|---|---|
| `XDG_*` 重定向后可启动（日志路径由 `XDG_DATA_HOME` 派生，非硬编码） | ✅ 已实测 | 探针 `P1`：四路 `XDG_*` 指向可写目录后 `opencode --version` → `opencode v2.0.24`，exit 0 |
| `opencode mcp add` 写入的零配置 stdio 形状与插件 `opencode.json` 一致 | ✅ 已实测 | 探针 `P2`/`P2b`：产出 `mcp.servers.goal-graph.{type:"local",command:["goal-graph","mcp"]}`，与本目录 `opencode.json` 键/值逐字段一致 |
| OpenCode 按 `type: "local"` 真实拉起 `goal-graph mcp` 子进程 | ✅ 已实测 | 探针 `P2c`：shim 捕获 `SPAWNED args=mcp --no-web`（零端口/零 token）；`P2d` 实测 stdio 往返默认 38 工具 + 自动随机端口 Web、`--read-only` 11 工具 |
| 进阶 HTTP：`opencode debug config` 能读到该条目 | ✅ 已实测（**无鉴别力**） | 探针 `P3`：输出含该条目，`headers.Authorization` 显示为 `"***"`。**`***` 仅为显示掩码，对任意值一律生效** —— 探针 `P3b` 实测纯字面量 `"Bearer PLAINLITERAL_NOT_VAR"` 同样显示 `***`，故**该命令不能证明「引用被识别而非字面量」**，只能证明条目存在 |
| 进阶 HTTP：认证头是否真的发出 + `{env:}` 是否真的插值 | ✅ 已实测 | 探针 `P4`：带日志监听器实收 `Bearer ` + token（长度 = 7 + token 长度）。**注意：这个长度算术本身可被等长字面量伪满足**，决定性证据见下两行负向对照 |
| 进阶 HTTP 负向对照 A：未导出该变量时 | ✅ 已实测（**决定性**） | 探针 `P5`：实收退化为 `Bearer`（长度 6，插值为空）⇒ 替换确实取自环境变量 |
| 进阶 HTTP 负向对照 B：`${VAR}` 形态 | ✅ 已实测（**决定性**） | 探针 `P6`：实收为字面量 `${GOAL_GRAPH_MCP_TOKEN}`，不插值 ⇒ OpenCode 只认 `{env:}`，与 Claude Code 语法确实可区分 |
| 进阶 HTTP：MCP 协议往返（真实 `goal-graph serve`） | ✅ 已实测 | 探针 `P7`：`initialize` → `serverInfo=goal-graph-local`；`tools/list` → 11 个工具；`tools/call` 有响应；**不带认证头 → HTTP 401**（认证层确实生效）。**注意：不以应用层错误文本推断认证结果** —— 认证据以「无认证头返回 401」单独证明，`tools/call` 返回的 `E_NOT_INITIALIZED` 只是应用层语义，不作认证证据 |
| OpenCode **会话内**的工具调用链路（经 LLM 走到 tools/call） | ❌ **未验证** | 本机 LLM 上游不可用，`opencode run` 在拉起 stdio 子进程 / 建立 MCP 连接后即因 `Model is unavailable` 退出，走不到工具调用。已知的是 OpenCode **确实拉起**了 stdio 进程（`P2c`）并发起了连接（`P4`） |
| `skills/` 被 OpenCode 自动发现 | ❌ **未验证** | 未在本次实测范围内；OpenCode 侧技能目录规则未确认，请按你的版本手工放置 |

> **关于 `opencode mcp list`**：本环境实测它在**冷启动**时返回 `No MCP servers configured`，
> 在**跑过一次会话后**能列出 `○ goal-graph pending`（配置本身未变）。**确切原因未查明**，
> 因此**不作为判据**，也不对机制作任何断言。
