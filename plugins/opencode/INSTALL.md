# dsh-graph for OpenCode

> ## ✅ 验证状态（请先读这里）
>
> **本目录的 OpenCode 接入已在真机实测通过关键链路**（OpenCode CLI v2.0.24）：配置形状、`{env:}` 插值、
> 认证头实际发出、真实 `dsh-graph serve` 上的 MCP 协议往返有实测证据（**可用
> `scripts/g633-opencode-mcp-probe.mjs` 一条命令复跑**）。
> **未验证项（与 §8 表格逐项相同）**：① `skills/` 是否被 OpenCode 自动发现；② OpenCode **会话内**经 LLM
> 走到工具调用的链路（本机 LLM 上游不可用，仅证实 OpenCode 发起了 MCP 连接）。
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
> - **已实测**：① `opencode mcp add` 能正常写入配置，产出的 JSON 与本目录 `opencode.json` **逐字段一致**；
>   ② `opencode debug config` 能读到该配置并把 header 显示为 `***`（**注意：`***` 仅为显示掩码，对任意值一律生效，
>   对「引用是否被识别」无鉴别力** —— 纯字面量同样显示 `***`）；
>   ③ 带日志监听器实收 OpenCode 发出的头：导出 token 时为 `Bearer <token>`（`{env:}` 已插值），
>   未导出时退化为 `Bearer`（长度 6），`${VAR}` 形态退化为字面量不插值。
> - **MCP 协议往返已实测**：探针 `P7` 对真实 `dsh-graph serve` 完成 `initialize`（`serverInfo=dsh-graph-local`）、
>   `tools/list`（11 个工具）、`tools/call`；且**不带认证头时返回 401**，证明认证层确实生效。
>   **限定**：这一步由探针内建的协议客户端驱动，**不是** OpenCode 会话内的工具调用 —— 本机 LLM 上游不可用，
>   `opencode run` 在 MCP 连接后即因模型错误退出，走不到会话内工具调用。
> - **`opencode mcp list` 不作判据**：本环境实测它**冷启动**时返回 `No MCP servers configured`，
>   **跑过一次会话后**又能列出 `○ dsh-graph pending`；若后台托管服务端口被占则直接报错
>   （`Managed service port … already in use`）。**配置未变、输出不同 ⇒ 原因未查明**，故不作判据
>   （机制猜测已删除）。**验证请以 §8 探针的认证头实收与 `tools/list` 往返为准**。
> - **与 Codex 的对照**：Codex 一侧已用受控探针做过运行时验证（服务端实收 `Bearer <token>`）；
>   OpenCode 一侧现已补齐等价的运行时证据（见 §8），两者结论一致但机制不同（OpenCode 用 `{env:}` 插值，
>   Codex 用 `bearer_token_env_var`）。

把本地 dsh-graph 目标看板接入 OpenCode。本目录提供 OpenCode 原生的 `opencode.json` 配置片段与外部宿主版技能正文。

> **重要差异（如实说明）**：OpenCode 的 `opencode plugin add` 只接受 **npm / Git 包说明符**，
> 没有 Claude Code / Codex 那样的「本地路径市场」。因此本目录**不能**用一条 `plugin add`
> 直接从仓库路径装进去；请按下文把配置片段合并进你的 OpenCode 配置（仍是**一条命令**）。

## 1. 前置

| 项 | 要求 | 检查 |
|---|---|---|
| Node.js | ≥ 22 | `node --version` |
| dsh-graph CLI | 提供 `dsh-graph serve` | `dsh-graph version` |
| OpenCode | ≥ 2.0（需 `mcp` 子命令） | `opencode --version` |
| 看板数据 | 目标项目内已有看板核心资料目录 | 该项目内 `dsh-graph status` |

**服务必须先初始化**。先设两个**不同的**绝对路径（下文所有命令复用，同一 shell 里 export 一次）：

```bash
export DSH_BOARD="$HOME/.dsh-graph-boards/$(basename "$PWD")"
export DSH_WS="$PWD"
mkdir -p "$DSH_BOARD"
```

```bash
dsh-graph serve init --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788
```

> ⚠️ `--root` 与 `--workspace` **必须不同、且不得互相包含**（看板数据不得混在被扫描的工作树里）。
> 同值会报 `错误：graphRoot 与 executionWorkspace 不得相同：<路径>`（exit 2）；互为父子则报 `不得互相包含`。
> `--port` 也建议显式给 —— 不指定时 `serve` 每次用系统随机端口，而配置里是固定 URL，端口一变就连不上。

## 2. 一条命令安装

用 OpenCode 自己的 `mcp add --global` 写入配置（`{env:...}` 由 OpenCode 原生插值，token 不落盘）：

```bash
opencode mcp add dsh-graph --url http://127.0.0.1:7788/mcp --header "Authorization=Bearer {env:DSH_GRAPH_MCP_TOKEN}" --global
```

> **端口**：上面假设 `serve` 在默认端口 7788。若你的服务不在 7788，把 `--url` 改成实际端口
> （端口以 `dsh-graph serve` 启动时打印的那行为准；不确定就用 `dsh-graph serve status` 看 `port`）。

写入位置：`${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json`。产出的配置形状即本目录的 `opencode.json`：

```json
{
  "mcp": {
    "servers": {
      "dsh-graph": {
        "type": "remote",
        "url": "http://127.0.0.1:7788/mcp",
        "headers": { "Authorization": "Bearer {env:DSH_GRAPH_MCP_TOKEN}" }
      }
    }
  }
}
```

若你想直接采用本目录的文件（例如随仓库分发统一配置），把它合并到上面那个路径即可：

```bash
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
cp plugins/opencode/opencode.json "${XDG_CONFIG_HOME:-$HOME/.config}/opencode/opencode.json"
```

技能正文：把 `plugins/opencode/skills/dsh-graph/` 放到 OpenCode 的技能目录（与你的 OpenCode 版本的技能发现规则一致），
或直接让 agent 阅读 `SKILL.md` 作为说明文档。

## 3. 启动服务并注入 token

```bash
export DSH_GRAPH_MCP_TOKEN="$(cat "${XDG_STATE_HOME:-$HOME/.local/state}/dsh-graph-service/token")"
dsh-graph serve --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788
```

> **`serve` 与 `serve init` 是两条不同命令**：`serve` 同样要求 `--root` / `--workspace`（缺则报用法错误），
> `--port` 也必须显式给（否则用随机端口）。启动行打印 `dsh-graph 本地只读服务已启动：http://127.0.0.1:7788`。

需要 OpenCode 能修改看板时由**服务端**开启写模式：

```bash
dsh-graph serve --root "$DSH_BOARD" --workspace "$DSH_WS" --port 7788 --allow-write
```

## 4. 最小验证

先确认服务与 token：

```bash
curl -s -X POST http://127.0.0.1:7788/mcp \
  -H "Authorization: Bearer $DSH_GRAPH_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

预期：`"tools":[...]` 数组（默认 11 个；`--allow-write` 时 38 个）。

再确认 OpenCode 读到了配置（**注意：下面的 `***` 只是显示掩码，对任意值一律生效，对「引用是否被识别」无鉴别力**，
它只能证明「条目存在」，不能证明 token 会被插值）：

```bash
opencode debug config
```

预期在输出中看到：

```
"mcp": { "servers": { "dsh-graph": { "type": "remote", "url": "http://127.0.0.1:7788/mcp",
  "headers": { "Authorization": "***" } } } }
```

最后在 OpenCode 会话里让它列目标（`graph_list_goals`），预期能读到看板数据。

> **不要用 `opencode mcp list` 判断接入是否成功**：本环境实测它冷启动时返回 `No MCP servers configured`，
> 跑过会话后又能列出 `○ dsh-graph pending`（配置未变、输出不同，**原因未查明**），故不作判据。
> 判据请用 ① `Authorization` 头是否真被发出（见 §8 探针 P4–P6）、② MCP 工具调用有真实返回。

## 5. 能做什么 / 做不到什么

与 Claude Code / Codex 版一致：默认只读 11 个工具；`--allow-write` 后 38 个；
`graph_resolve_accept` / `transition → delivered` / `graph_claim_supervisor` / `graph_start_attempt`
**不可达**，须回 DSH 看板或本地 GUI 裁决。详见 `skills/dsh-graph/SKILL.md`。

## 6. 卸载

```bash
# OpenCode 的 mcp 子命令没有 remove（只有 list/add/auth/logout）⇒ 从配置里删掉该条目：
node -e '
const fs=require("fs"),os=require("os"),path=require("path");
const f=path.join(process.env.XDG_CONFIG_HOME||path.join(os.homedir(),".config"),"opencode","opencode.json");
const j=JSON.parse(fs.readFileSync(f,"utf8"));
delete j.mcp?.servers?.["dsh-graph"];
fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");
console.log("removed dsh-graph from",f);'
```

服务侧清理（不动看板数据）：`dsh-graph serve uninstall`。

## 7. 排障

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动即报 `EROFS ... /opencode/log/opencode.log` | 默认数据目录只读（该路径由 `XDG_DATA_HOME` 派生，非硬编码） | 把 `XDG_DATA_HOME`（必要时加 `XDG_CONFIG_HOME` / `XDG_STATE_HOME` / `XDG_CACHE_HOME`）指向可写目录后重启；实测重定向后 `opencode --version` 正常输出 `v2.0.24` |
| `opencode mcp list` 输出不可靠（冷启动报 `No MCP servers configured`，跑过会话后又列出 `pending`） | **原因未查明**（机制猜测已排除：OpenCode 确实会读取并解析本配置） | **不要据此判失败**；用 §8 的探针看 `Authorization` 头是否真被发出，或用 MCP 工具调用看实际连通 |
| OpenCode 报 401 | `DSH_GRAPH_MCP_TOKEN` 没在**启动 OpenCode 的那个 shell** 里导出，`{env:}` 被替换成空串 | 同一 shell `export` 后重启 OpenCode；`debug config` 只显示 `***`，看不到实际值 |
| 连不上 `127.0.0.1:7788` | **① `--root` 与 `--workspace` 相同或互相包含 → 服务根本没起来**（`错误：graphRoot 与 executionWorkspace 不得相同：<路径>`，exit 2）<br>② `serve` 没显式 `--port`，端口是随机的<br>③ 服务没起 | 两路径必须不同且不互相包含（见 §1）；`serve` 同样显式 `--port 7788`；以启动行打印的 origin 为准 |
| 端口被占 | 该端口已有进程（`serve` 不会抢占、也不会自动换端口） | 换 `--port` 并同步 URL |
| `serve init` 报 `ENOENT ... mkdir '<XDG 路径>/dsh-graph-service'` | `XDG_STATE_HOME` 指向的位置**不可写**（沙盒/只读挂载），服务状态目录由它派生 | 把 `XDG_STATE_HOME` 指向可写目录（或显式 `--state-dir <可写绝对路径>`）后重跑 `serve init` |
| `serve status` 显示 `port: 7788` 但实际监听别的端口 | 未给 `--port` 时 `parseServeArgs` 把 port 置 `0`，`args.port ?? config.port` 拦不住 `0` ⇒ **运行配置里的 port 被忽略**（产品行为，已用显式 `--port` 规避） | 一律显式 `--port`；端口以启动行为准 |
| **同一 XDG 目录连跑两次 `opencode run`，第二次不再连 MCP** | 探针实测：第一次有 `server=dsh-graph` 连接记录，第二次同目录重跑未再发起连接（**确切原因未查明**，不对机制作断言） | 每轮验证用**全新** `XDG_*` 目录（探针即如此做）；不要复用上一次的 `XDG_DATA_HOME`/`XDG_CONFIG_HOME` 重跑 |
| `E_NOT_INITIALIZED` | 看板未初始化 | 在目标项目 `dsh-graph serve init --root <绝对路径> --workspace <绝对路径>` |
| `E_UNKNOWN_COMMAND` | 工具未注册（只读模式下请求写工具，或人工裁决保留项） | 需要写就重启服务加 `--allow-write`；裁决走 GUI |
| `E_FORBIDDEN` | 参数被拒（典型 `to=delivered`） | 迁到 `review`，交付由人裁决 |
| 版本不匹配 | 插件配置 `1.0.0` 与 CLI 差距过大 | 升级 CLI；本配置只依赖 `serve` 的 MCP 契约 |

## 8. 实测记录与验证状态

**版本绑定期**：下表全部结论绑定在 `OpenCode CLI v2.0.24` + 本仓库 `1.0.0` 上实测；换版本后请重跑探针。

**证据可复跑**（本轮起探针已落盘，不再是「用完即删」）：

```bash
# 在仓库根执行；需要先 bash scripts/build.sh 产出 dist/，以及 PATH 里有 opencode
TMPDIR=/tmp node scripts/g633-opencode-mcp-probe.mjs
```

探针会自动建临时目录、跑完即清理，打印每个实测项 `PASS/FAIL`、**是否具鉴别力**，并给出 `exit` 码。

| 项 | 状态 | 证据（可复跑） |
|---|---|---|
| `XDG_*` 重定向后可启动（日志路径由 `XDG_DATA_HOME` 派生，非硬编码） | ✅ 已实测 | 探针 `P1`：四路 `XDG_*` 指向可写目录后 `opencode --version` → `opencode v2.0.24`，exit 0 |
| `opencode mcp add` 写入的配置形状 | ✅ 已实测 | 探针 `P2`/`P2b`：产出 `mcp.servers.dsh-graph.{type:"remote",url,headers}`，与本目录 `opencode.json` 键/值逐字段一致 |
| `opencode debug config` 能读到该条目 | ✅ 已实测（**无鉴别力**） | 探针 `P3`：输出含该条目，`headers.Authorization` 显示为 `"***"`。**`***` 仅为显示掩码，对任意值一律生效** —— 探针 `P3b` 实测纯字面量 `"Bearer PLAINLITERAL_NOT_VAR"` 同样显示 `***`，故**该命令不能证明「引用被识别而非字面量」**，只能证明条目存在 |
| 认证头是否真的发出 + `{env:}` 是否真的插值 | ✅ 已实测 | 探针 `P4`：带日志监听器实收 `Bearer ` + token（长度 = 7 + token 长度）。**注意：这个长度算术本身可被等长字面量伪满足**，决定性证据见下两行负向对照 |
| 负向对照 A：未导出该变量时 | ✅ 已实测（**决定性**） | 探针 `P5`：实收退化为 `Bearer`（长度 6，插值为空）⇒ 替换确实取自环境变量 |
| 负向对照 B：`${VAR}` 形态 | ✅ 已实测（**决定性**） | 探针 `P6`：实收为字面量 `${DSH_GRAPH_MCP_TOKEN}`，不插值 ⇒ OpenCode 只认 `{env:}`，与 Claude Code 语法确实可区分 |
| MCP 协议往返（真实 `dsh-graph serve`） | ✅ 已实测 | 探针 `P7`：`initialize` → `serverInfo=dsh-graph-local`；`tools/list` → 11 个工具；`tools/call` 有响应；**不带认证头 → HTTP 401**（认证层确实生效）。**注意：不以应用层错误文本推断认证结果** —— 认证据以「无认证头返回 401」单独证明，`tools/call` 返回的 `E_NOT_INITIALIZED` 只是应用层语义，不作认证证据 |
| OpenCode **会话内**的工具调用链路（经 LLM 走到 tools/call） | ❌ **未验证** | 本机 LLM 上游不可用，`opencode run` 在 MCP 连接建立后即因 `Model is unavailable` 退出，走不到工具调用。已知的是 OpenCode **确实发起**了连接（`P4` 实收认证头 + `opencode.log` 的 `server=dsh-graph origin=…` 记录） |
| `skills/` 被 OpenCode 自动发现 | ❌ **未验证** | 未在本次实测范围内；OpenCode 侧技能目录规则未确认，请按你的版本手工放置 |

> **关于 `opencode mcp list`**：本环境实测它在**冷启动**时返回 `No MCP servers configured`，
> 在**跑过一次会话后**能列出 `○ dsh-graph pending`（配置本身未变）。**确切原因未查明**，
> 因此**不作为判据**，也不对机制作任何断言。
