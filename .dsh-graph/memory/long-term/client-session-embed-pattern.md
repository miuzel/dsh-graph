---
{
  "id": "mem-003",
  "type": "success-pattern",
  "source_goal": "g-107",
  "promoted_by": "supervisor",
  "promoted_at": "2026-08-21T15:05:00+08:00",
  "status": "active"
}
---

## client 实时会话嵌入的 API 落点速查（g-107 实证）

1. **inject 三件套**：`["slots", "sessions", "connection"]`；facade 非函数属性直通，
   `connection.api.*` 全命名空间可用（无 RPC 白名单）。
2. **实时流式**：`sessions.binding(childId).session` → `open()`（幂等，不 open 活事件被丢）
   → `subscribe/getSnapshot().chat.legacy.partial` 取最新流式行。
3. **token/上下文**：`session.projections.faceOf("tokenUsage"|"contextPressure")`，
   投影推送**不要求 open**，看板常驻首选。
4. **模型**：`api.sessions.models({sessionId})` 对 origin=subagent 会话被 host 围栏拒绝
   （agent-busy）——必须退化查父会话并标注来源；错误不可静默吞（曾致常驻"查询中"）。
5. **发指令**：`session.prompt(content, "queue"|"steer")`；continuable 子代理仅文本
   （SUBAGENT_IMAGE_UNSUPPORTED 硬限制），前端须明示降级。
6. **最近记录**：`api.subagents.history({parentSessionId, childSessionId, mode, maxMessages})`。
7. **跳转切 tab**：无跨插件 view 切换 API，DOM 点击首 tab（order=0 对话）是脆弱约定，
   DSH 暴露正式 API 后应替换。
8. **UX 迭代规律**：信息密度优先（状态+token 合并一行、折叠态内联摘要）、
   重交互控件收进弹窗/抽屉、卡片保持轻量——负责人六轮 review 的一致取向。
