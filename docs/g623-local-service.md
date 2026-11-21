# g-623：独立本地只读服务 MVP（实现说明）

2026-11-16；基线 `a93216f`。设计来源：[g-622 研究](<g622-local-web-mcp-design.md>)；公共契约：[v1.0.0 草案](<v1.0.0-public-contract-draft.md>)。
本文记录**已实现**的行为与**已验证**的范围；未验证项单独列出，不在此处夸大为「已通过」。

## 1. 形态：一个进程、一个端口、三个入口

```
dsh-graph serve --root <graphRoot 绝对路径> --workspace <executionWorkspace 绝对路径>
                [--state-dir <绝对路径>] [--port N] [--host 127.0.0.1]
```

同一 HTTP 服务器（`core/service/server.ts`）同时提供：

| 入口 | 路由 | 认证 |
|---|---|---|
| Web 静态 App | `GET /` `/app.js` `/app.css` | 无（页面不含数据/秘密） |
| Web API | `/api/session`（GET/POST/DELETE）、`/api/board` `/api/goals` `/api/versions` `/api/goal` `/api/criteria` `/api/cards` `/api/results` `/api/settings` `/api/attachments` `/api/events`（只 GET） | HttpOnly 会话 Cookie（由 `POST /api/session` 用 token 换取） |
| MCP endpoint | `POST /mcp`（JSON-RPC 2.0 over HTTP） | `Authorization: Bearer <token>`（**每请求**校验） |

CLI（`core/cli/*`）**不承担 UI，也不托管服务生命周期**：`serve` 只是一次性前台进程
（Ctrl-C / SIGINT / SIGTERM 停止）。`serve init` / `serve status` / `serve uninstall` 是显式一次性动作。

## 2. 安全边界（逐条对应判据）

| 判据 | 实现位置 | 行为 |
|---|---|---|
| 2 只绑 127.0.0.1 | `policy.validateBindHost` + `server.resolveBindHost` | 只接受数值回环 `127.0.0.1`；`0.0.0.0` / `::` / `[::]` / LAN / 主机名 / `::1` 一律**启动前**拒绝（分区红因 `wildcard-v4` / `wildcard-v6` / `lan` / `name` / `ipv6`），**不存在**回退通配的路径。peer 判定只接受 IPv4 回环（含 `::ffff:127.x`）。每个请求校验 `Host` 必须是 `127.0.0.1:<实际端口>` 或 `localhost:<实际端口>`；带 `Origin` 的请求必须同 origin。**不读**任何 `X-Forwarded-*` / `Forwarded` 头。 |
| 3 token | `credentials.ts` | `crypto.randomBytes(32)`（256 bit）；私有目录 0700、凭据文件 0600（**宽权限 fail-closed**，不「先收紧再当没事」）；轮换原子替换、无宽限期；只暴露 `sha256:` 短指纹。token 只落**服务自有状态目录**的凭据文件一个位置。 |
| 4 MCP 认证先行 | `mcp.handleMcpRequest` | 顺序固定：① token 伪参数（URL query / body 字段，含工具 args）⇒ 401 → ② token 校验 ⇒ 401 → ③ JSON 解析 → ④ 分派。`Mcp-Session-Id` **不**携带权限；每个请求（含重连）重新验 token。错误/缺失/旧 token、轮换/撤销后的旧连接全部 401 且**零 store 副作用**。 |
| 5 Web/MCP 分离 | `server.ts` | Web API **拒绝** `Authorization: Bearer`（即使 token 正确）——MCP token 不能换取 Web 会话，也不能调用任何人工审批路由；MCP **拒绝**仅带 Cookie 的请求。CORS：从不下发 `Access-Control-Allow-Origin`；外站 Origin 在边界层 403。轮换/撤销同时吊销全部 Web 会话。 |
| 6 只读白名单 | `queries.READ_ONLY_COMMANDS` | 11 个只读命令（list/query/board/settings/attachments/events）。`tools/call` 只查白名单，其余（create/transition/claim/start/accept/deliver/delete/…）返回 `-32601` + `E_UNKNOWN_COMMAND`，**未触碰 store**；Web 侧没有对应写路由（404/405）。全部先过 `assertInitialized()`。**g-632 修订**：本条的「所有写命令未注册」是**默认（未开启写模式）**口径；服务端显式 `--allow-write` 后可注册执行类写工具，但人工裁决（`graph_resolve_accept` / `transition→delivered`）与主管/派发仍 fail-closed —— 详见 [g632-write-mode-and-custom-root.md](<g632-write-mode-and-custom-root.md>)。 |
| 7 root 分离 | `config.assertSeparatedRoots` + `queries.assertInitialized` | `graphRoot` 与 `executionWorkspace` 都必须是**显式绝对路径**，不得相同、不得互相包含（字面 + realpath 双重判定）。查询一律复用 core 读函数（`boardPayload` / `goalDetail` / `goalCards` / `readProjectConfig` / `listAttachments` / `readAttachment` / `readEvents`），不拼 frontmatter、不解析事件、不绕过锁/CAS。未初始化只报 `E_NOT_INITIALIZED`，**不** init/claim。 |
| 8 设置与磁盘 | `queries.querySettings` + `web-app.ts` | 设置只读投影来自 core `readProjectConfig`（不复制默认/迁移），显式 `readOnly: true` + `writeDisabledReason`。投影剥掉绝对路径、`binding_token`、`child_id` 等运行字段。浏览器只经同 origin `/api/*` 取数；静态页带严格 CSP（`default-src 'self'`、`frame-ancestors 'none'`）。 |

## 3. 命令目录（MCP 与 Web 同源）

`graph_list_goals`、`graph_list_versions`、`graph_query_goal`、`graph_query_criteria`、`graph_list_cards`、
`graph_query_results`、`graph_board`、`graph_settings`、`graph_list_attachments`、`graph_read_attachment`、`graph_events`。

参数中的可信上下文字段（`actor` / `owner` / `human` / `approval` / `root` / `token` / `sessionId` /
`capability` / `role` …）一律 `E_FORBIDDEN`；MCP 根级 `params` 里出现同样字段直接 `-32602`。

## 4. 生命周期

| 动作 | 行为 |
|---|---|
| `serve init` | 首次显式初始化：生成 token（幂等：已存在则不重新生成）、写 0600 凭据 + 只含连接信息的 `server.json`。看板未初始化 ⇒ 只提示，不 init/claim。 |
| `serve` | 读运行配置（缺失 ⇒ 明确失败、**不**自动初始化）→ 绑定 `127.0.0.1`（端口 0 = 系统分配）→ 前台运行。启动提示只打印 token **指纹**。 |
| `serve status` | 只读：是否初始化、token 指纹、graphRoot/executionWorkspace、看板是否初始化。 |
| `serve uninstall` | 只删除**本服务自有**凭据与运行配置（含空状态目录），不跟随 symlink；**graph 数据逐字节不动**。 |
| 停止 | SIGINT/SIGTERM ⇒ 关闭监听、吊销全部 Web 会话；端口释放后进程退出。无后台守护进程，`serve stop` 明确报告「无事可做」。 |

## 5. 已验证 / 未验证（逐项如实）

**已验证**（`core/tests/g623-service*.test.ts`，见交付报文 evidence 行）：

- 同进程三入口可用；只绑 127.0.0.1；凭据权限 0600/0700 与宽权限 fail-closed；token 不落 graph/宿主工作区/配置；
- MCP 认证先行（缺/空/错/旧 token、伪参数、仅 session id、轮换/撤销后）全部拒绝且 graph 树快照逐字节不变；
- Web 会话与 MCP token 分离；外站 Origin / 预检 / CORS 无放行；MCP token 调审批/写路由 401，会话调写路由 405；
- 路径穿越 / 编码穿越 / 绝对路径 / 根外 symlink / 客户端 roots 覆盖全部拒绝，根外 sentinel 不变；
- 未注册写工具 fail-closed；GET 不触发隐式 init；端口占用不抢占不回退；超大请求体 413；
- 端到端：真实 CLI 子进程离线隔离（私有 HOME/XDG/config/cache）初始化→启动→Web/API/MCP→SIGTERM→端口释放→卸载，graph 树（含 mtime）逐字节不变；
- 防伪绿对照：把「认证先行」改坏（不校验 token）后，同一未认证请求会被当作已认证处理 ⇒ 套件的 401 断言必须判红。

**未验证**（不宣称通过）：

- **真实 MCP 客户端**（Claude Code / OpenCode / Codex CLI）的传输兼容性：本轮只实现了 JSON-RPC 2.0 over HTTP
  的核心方法（`initialize` / `tools/list` / `tools/call` / `ping`），**未**与任何官方 SDK 做互操作实测，
  也未验证 SSE / `Accept` 协商等流式细节。
- **Windows**：`credentials.ts` 在非 POSIX 平台跳过 chmod 检查（依赖用户 profile ACL），**未**在 Windows 真机验证；
  按发布门禁须如实标注「Windows 未验证」。
- **浏览器真机行为**：CSP、`SameSite=Strict` Cookie、页面渲染未在浏览器中目视核验（仅静态断言 bundle 内容与响应头）。
- **多进程同时访问同一 graphRoot**：只读路径未做跨进程并发认证（设计 §1 已声明未认证）。
- **IPv6**：不开放（`::1` 绑定被显式拒绝），dual-stack 行为未验证。

## 6. 与其他契约的关系

- 不新增远程服务、OAuth、多租户、RBAC、跨机身份；无 `publish` / `tag` / `push` / 合 main。
- 现有 DSH 插件、`graph_*` 工具、GUI、profile、发布链**完全保留**：本服务是新目录 `core/service/*`，
  只**读**既有 core 函数；`.dsh-graph/` 布局、事件、配置格式一字未改。
