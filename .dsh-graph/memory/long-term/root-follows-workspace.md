# mem-007：root 跟随会话 workspace（g-113 交付模式）

source_goal: g-113（versions/v0.3/goals/g-113），交付于 2a72715

## 核心
- 会话 workspace = `SessionHeader.cwd`（dsh-session：『Absolute working directory the session was created in』）。
- root 解析：`resolveRoot(config, workspace) = path.resolve(workspace, config?.root ?? ".dsh-graph")`，config.root 必须**相对**，workspace 才能跟随。
- 三处统一：
  - host 工具 `rootFor(ex)`：`sessionWorkspace = ex.agent.session.header.cwd ?? ctx.get("sandboxPolicy").workspaceRoot ?? process.cwd()`，然后 `init(r)` 幂等建骨架。
  - client 端点 `workspaceOf(req, body)`：query `?workspace=`/`?root=` → body → process.cwd()，`rootFor` 也 `init(r)`。
  - 前端 `currentWorkspace()`：优先**被查看会话**（KanbanView 接 `conversation.view` 的 `props.sessionId`）→ `list.current` → null；fetch 统一 `graphUrl()` 追加 `?workspace=`。

## 两个大坑（都要记牢）
1. **绝对路径覆盖会顶掉 workspace**：`path.resolve(ws, absoluteRoot)` 直接返回 absoluteRoot。本地开发给 host/client 配的 `config.root` 一旦是绝对路径，workspace 跟随就失效（host/client 两半先后都踩过）。**本地覆盖一律用相对 `.dsh-graph`**；发布包 bundle patch 本来就是相对，无此问题。
2. **sessions 列表条目 cwd 不可靠**：DSH 源码 `...entry.cwd !== void 0 ? {cwd} : {}`（dsh-client-runtime:9233），cwd 并非总有。可靠来源是 **workspaces 服务**：`workspaces.list.getSnapshot().items.find(w => w.sessionIds.includes(sessionId))?.path`（归属映射见 client-runtime:9866）。

## 其他
- 看板是 `conversation.view`（session 作用域 slot）按会话渲染；`props.sessionId` 由 renderer 注入（dsh-client-ui-renderer:562 `standard["sessionId"] = info.sessionId`）。
- 看板头部 DEBUG 行（`sessionId=… ws=…`）保留作诊断，定位「读错项目」直接看它。
- 遗留小瑕疵：apply 期 `init(root)` 用 process.cwd() 会在 profile 目录留空骨架，可后续清理（改为只按 workspace init）。
