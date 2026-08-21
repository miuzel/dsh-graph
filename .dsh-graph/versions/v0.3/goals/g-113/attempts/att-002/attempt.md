---
{
  "id": "att-002",
  "goal": "g-113",
  "executor": "subagent",
  "sandbox": "directory",
  "started_at": "2026-08-22T03:27:19+08:00",
  "claimed_at": null,
  "status_line": "定点 bug 已修：看板按被查看会话取 workspace",
  "result": "pending",
  "child_id": "ea561db6-143a-4716-a74c-58ce50a37eb8",
  "parent_session_id": "session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b"
}
---

## 执行笔记

### att-002 执行记录（2026-08-22）

**补记 2（定点 bug：看板按「被查看会话」取 workspace）**：负责人实测 aseit-ella 会话看板仍显示
dsh-graph 卡片——`currentWorkspace()` 原用全局聚焦 `list.current`，但看板是「按会话渲染」的。
修法：
- `KanbanView(props)` 接收 conversation.view 渲染回调的 slot props，取**被查看会话 id**；
- 字段名确认为 **`props.sessionId`**（DSH 源码证据：`dsh-client-ui-renderer/lib/client.js:562`
  `standard["sessionId"] = info.sessionId`；`dsh-client-runtime/lib/client.js:8748-8754`
  `materializeInfo` 返回 `{ sessionId: binding.sessionId, ... }`；conversation.view 为 session
  作用域 slot，渲染于 per-session ConversationSession 内）；
- `viewedSessionId` 模块变量由 KanbanView 挂载 effect 写入，`currentWorkspace()` 优先级：
  被查看会话 cwd → `list.current` cwd → null（裸路径，端点兜底 process.cwd()）；
- 逻辑仿真（tmp/g113-viewed-session-sim.mjs）7 项全过：被查看≠current 时取被查看、
  条目缺失/无 cwd 回退 current、无会话裸路径、已有 query 追加 &workspace=。
验证：node --check 通过；53/53 单测；8/8 冻结脚本；probe PASS。
真浏览器端到端（aseit-ella 会话看板）需负责人重启 profile 后实测。

**补记（复核对齐 brief）**：客户端取 workspace 的确切方式已核实两条路径并选用更直接的——
`ctx.sessions.list.getSnapshot()` 的 `{items, current}`，items 条目带 `cwd`（session.header.cwd 客户端投影）；
备选 `ctx.get("workspaces")`（`ctx.reflect.provide` 提供）`list.getSnapshot().items` 含
`{workspaceId, path, sessionIds}`，需按 `sessionIds.includes(current)` 映射到 `path`，与 header.cwd 同目录。
端点参数已加 `?root=` 别名（与 `?workspace=` 等价，语义均为 workspace 根 → `<ws>/.dsh-graph`），
新增 `?root=` 隔离读取测试；resolveRoot 冒烟（不同 workspace 不同 root、默认回退 process.cwd()、
config.root 相对/绝对语义）并入 probe。53/53 单测 + 8/8 冻结脚本 + probe PASS。

**承接**：c279b45 已完成 host 工具 root 跟随会话 workspace（rootFor(ex)）+ 注册普通 agent 使用指引 skill；遗留 client board 端点 workspace 传递。

**本次完成**：

1. **client board 端点 root 跟随请求 workspace（判据 1 后半）**：
   - `dsh-graph-client/index.js`：新增 `workspaceOf(req, body)`（query `?workspace=` 优先，其次 POST body.workspace，兜底 process.cwd()）+ `rootFor(req, body)`；9 个端点（board/goal/accept/resolve-accept/edit-description/add-card/start-collection/start-execution/spawn-options）全部按请求 workspace 解析 root。
   - `dsh-graph-client/lib/client.js`：新增 `currentWorkspace()`（从注入的 sessions 服务 `list.getSnapshot()` 的 current 条目取 cwd，即 session.header.cwd 的客户端投影）+ `graphUrl()`；10 处 fetch 全部带 `?workspace=`。
2. **host rootFor 兜底链补 sandboxPolicy.workspaceRoot**（`session.header.cwd → sandboxPolicy.workspaceRoot → process.cwd()`），与 DSH 沙箱策略的 workspace 语义一致。
3. **开箱骨架**：两半解析出 root 后幂等 `init()`——工具/端点首次触达某个 workspace 时自动建全骨架，避免半成品落盘（probe 发现：仅靠 createGoal 会缺 events.jsonl/index.json/rules.md）。
4. **连带 bug 修正（本次会话实测踩到）**：start-attempt/start-execution 给子代理注入的目标文件相对路径原为 `relative(rootFor, goalFile)`（相对 .dsh-graph 目录，漏 `.dsh-graph/` 前缀），子代理工作目录=workspace 根（startContinuable 继承父会话 header.cwd，dsh-subagent 源码核实）→ 改为 `relative(workspaceRoot, goalFile)`（`.dsh-graph/versions/...`）。本会话开场收到的路径 `versions/v0.3/goals/g-113/goal.md` 就是旧逻辑产物、read 不到，已由该修复根治。
5. **测试**（52/52 全绿，新增 9 项）：client 端点 ?workspace= 隔离读取、body.workspace 写路径、query 参数 POST、无参回退 config.root、全新 workspace 自动 init 骨架、start-execution 相对路径基准；host 工具 session.header.cwd 落位、sandboxPolicy 兜底、graph_start_attempt 相对路径基准。
6. **跨项目实测（probe PASS，判据 2/4）**：comma-cli 项目 board 读到自己的 board-probe-1、不串 dsh-graph 仓库、profile web 骨架无新写入；全新空项目开箱自动建骨架、工具落新项目；usage skill（工具清单/生命周期/判据先行）+ supervisor skill 注册验证。

**未做**：真实 dsh web 进程端到端浏览器实测（需重启 profile 进程，超出本沙箱；端点层功能已由 probe 覆盖，浏览器侧 workspace 派生由源码核实）。

**回归**：8/8 验收脚本 + 52/52 单测 + probe 全绿；`bash scripts/sync-core.sh` 已同步两包 core/*.js 产物。

## Review 记录

<!-- 受管小节 -->
