---
{
  "id": "card-0112ddd4",
  "goal": "g-122",
  "title": "dummy 调研：DSH workspace 服务 API（辨识度内容供注入验证）",
  "kind": "text",
  "status": "reviewed",
  "filled_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "filled_at": "2026-08-22T11:56:02+08:00",
  "content_ref": null,
  "summary": "DSH workspace 服务 API：WorkspaceRegistry（Cordis Service）公开 create/get/list/delete/insertBefore/archiveSession/sessionKnown/resolveByPath；list() 返回 WorkspaceEntity[]（id/path/title/sessionIds/createdAt/updatedAt，sessionIds 按 canonical cwd 过滤）；按 sessionId 找 workspace 用 registry.list().find(ws => ws.sessionIds.includes(id))（无独立反向方法）。辨识标记 DUMMY-VERIFY-G120-7f3a。",
  "child_id": "11477eae-2f63-4857-93f9-2df19267271e",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

# DSH workspace 服务 API 调研报告

**对象**：`.../@deepseek-ai/dsh-workspace/lib/index.js`（757 行）

## 1. 公开方法清单
模块导出（L757）：`WorkspaceId`、`WorkspaceRegistry`（默认导出，L289）、`WorkspaceMoveInvalidError`、`WorkspaceOrderInvalidError`、`WorkspaceUnknownSessionError`、`realpathNormalize`、`workspaceDomainSpec`、`workspaceDomainState`、`workspaceRecord`。

**WorkspaceRegistry 服务**（Cordis Service，L289）：
- `create(path, title)` L341 — 为已存在目录创建/复用（realpath 规范化，同路径幂等）
- `get(id)` L351 — 按 id 取实体，未知返回 undefined
- `list()` L360 — 按持久化顺序返回实体数组（同步）
- `delete(id)` L375 — 删除注册（保留目录与日志）
- `insertBefore(id, beforeId)` L385 — DOM-insertBefore 式重排显示顺序
- `archiveSession(sessionId)` L422 — 全局归档（不动 workspace 记账）
- `sessionKnown(id)` L439 — 会话是否存在
- `resolveByPath(path)` L452 — 按规范化路径解析，不创建
- `get archivedSessionIds` L412

**WorkspaceEntity**（L52-168，包私有）：`id` 属性；`path/title/createdAt/updatedAt/sessionIds` getter（L66-80）；`setTitle` L81、`attachSession` L87（校验 header.cwd 规范化后 === workspace.path）、`insertSessionBefore` L106、`detachSession` L124、`status()` L130（"ok"/"missing-dir"）。

## 2. `list()` 返回结构
返回 `WorkspaceEntity[]`（L360-366），非原始记录。快照字段（schema `workspaceRecord` L184-190）：
- `id`：string（randomUUID）
- `path`：realpath 规范化绝对路径（唯一性 canon）
- `title`：string，缺省 basename(path)
- `sessionIds`：SessionId[] 有序数组（数组序=显示序）
- `createdAt`/`updatedAt`：ISO-8601 string

⚠️ `sessionIds` getter（L78-80）按 canonical cwd 过滤：仅返回 `sessionPath(id) === record.path` 的会话（无效 header/目录缺失/路径不符会被滤出并告警 L709-719）。

## 3. 按 sessionIds 找 workspace
无独立公开反向方法（内部 `sessionPaths: Map<sessionId, path>` L296/L301 是私有索引）。标准做法：
```js
registry.list().find((ws) => ws.sessionIds.includes(sessionId));
```
唯一性由 `validateStoredState`（L662-666）保证：同一 session 不得被两个 workspace 记账。归档不影响 sessionIds 槽位。

**辨识标记：DUMMY-VERIFY-G120-7f3a**
