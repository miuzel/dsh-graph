# dsh-graph-service 安装指南

dsh-graph 本地**只读**服务：同一进程提供 Web App（`/`）、Web API（`/api/…`）与 localhost MCP
endpoint（`POST /mcp`）。

**自包含**：所需的 core 运行时与提示词资产都在 tarball 内，不依赖其他 dsh-graph 包。

## 1. 前置要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | ≥ 22 | `node -v` 自查 |
| DeepSeek Harness | `>=0.2.2-rc.3 <0.2.3-0` | 与 `engines.dsh` / peer 逐字一致 |
| 一个已初始化的看板 | `.dsh-graph/` 含 `events.jsonl` | 服务**不会**自动 init/claim 看板 |
| 回环地址 | 仅 `127.0.0.1` | 拒绝 `0.0.0.0` / `::` / LAN / 主机名 |

## 2. 安装

```bash
npm install -g dsh-graph-service        # 全局
npm install --save-exact dsh-graph-service   # 项目本地
```

> 本包**不自带可执行入口**（`bin`）：驱动方式有两条——装 `dsh-graph-cli` 后用
> `dsh-graph serve …`，或直接在 Node 里 import `dsh-graph-service` 的 `runServeCommand`。
> 若你只想要命令行入口，请装 `dsh-graph-cli`（它已内含本服务）。

## 3. 最小验证步骤

```bash
# ① 首次初始化：生成 ≥256 bit token（0600 凭据）+ 运行配置
#
# ⚠️ --root 与 --workspace 必须**互不包含**：服务会拒绝「图根位于执行工作区内」或反之的配置
#    （安全语义：看板数据不得混在被扫描的工作树里）。所以看板目录要放在工作区**之外**，
#    例如 ~/.dsh-graph-boards/myproject —— 不要写成 <project>/.dsh-graph 配 <project>。
mkdir -p ~/.dsh-graph-service && chmod 700 ~/.dsh-graph-service
dsh-graph serve init \
  --root ~/.dsh-graph-boards/myproject \
  --workspace /path/to/project \
  --state-dir ~/.dsh-graph-service \
  --port 7801
# 期望：{ "ok": true, "tokenCreated": true, "graphInitialized": true, ... }

# ② 状态（只读）
dsh-graph serve status --state-dir ~/.dsh-graph-service
# 期望：{ "ok": true, "initialized": true, "tokenPresent": true, ... }

# ③ 启动后做一次真实 MCP 往返
dsh-graph serve --root /path/to/project/.dsh-graph --workspace /path/to/project \
  --state-dir ~/.dsh-graph-service --port 7801 &
curl -s -X POST http://127.0.0.1:7801/mcp \
  -H "Authorization: Bearer $(cat ~/.dsh-graph-service/token)" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

实测输出（v1.0.0）：

```
启动横幅：dsh-graph 本地只读服务已启动：http://127.0.0.1:7801
MCP initialize → {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18",
  "serverInfo":{"name":"dsh-graph-local","version":"1.0-draft.1"} ...}}
tools/list → 11 个只读工具（graph_board、graph_list_goals、graph_query_goal …）
无 token / 错 token → HTTP 401
```

## 4. 卸载

```bash
dsh-graph serve uninstall --state-dir ~/.dsh-graph-service   # 只删本服务自有凭据与运行配置
npm uninstall -g dsh-graph-service
```

`serve uninstall` **只删服务自有的运行配置与凭据**，看板数据（`.dsh-graph/`）一字不动。

## 5. 常见故障排查

### 5.1 版本不匹配

```bash
node -p "require('dsh-graph-service/package.json').engines"
```

要求 DSH `>=0.2.2-rc.3 <0.2.3-0`。超出上限（≥ 0.2.3-0）本包未经适配。

### 5.2 端口占用

```
错误：端口不可用（7801）：EADDRINUSE —— 不抢占已占用端口，也不回退到其他端口
```

```bash
ss -ltnp | grep 7801        # Linux
lsof -i :7801               # macOS
```

改用 `--port <其他端口>`。服务刻意**不回退**——静默换端口会让 MCP 配置里的 endpoint 失配。

### 5.3 token 缺失 / 401

- `serve status` 显示 `"tokenPresent": false` ⇒ 尚未 `serve init`，或凭据文件被删。
  重新执行 `serve init`（会生成新 token）。
- MCP 请求 401：`Authorization: Bearer <token>` 缺失、为空、错误、已轮换或已撤销**一律 401**，
  且响应**不区分**原因、不回显 token。
- token **不接受**作为参数 / URL（`?token=`）/ 请求体字段——只能走 Authorization 头。

### 5.4 权限问题

```
错误：私有状态目录权限过宽（755），要求 0700：/path/to/state
```

```bash
chmod 700 <state-dir>
```

凭据目录必须 0700、token 文件必须 0600；权限无法收紧时服务**拒绝启动**（不是警告）。

### 5.5 `graphInitialized: false`

指到了没有 `events.jsonl` 的目录。`--root` 要指向**已初始化的看板目录**
（即 `.dsh-graph` 本身），`--workspace` 是另一个**独立**的执行目录，两者必须显式分离。
