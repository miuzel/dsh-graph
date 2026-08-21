---
{
  "id": "att-001",
  "goal": "g-108",
  "executor": "agent:k3",
  "sandbox": "directory",
  "started_at": "2026-08-21T15:15:03+08:00",
  "claimed_at": "2026-08-21T15:40:49+08:00",
  "status_line": "追加：status_line 摘要并入状态小窗（LiveStrip），图标随子代理状态——运行中 ⏳ / 空闲 ✅ 最近已完成；全脚本 PASS",
  "result": "pending",
  "child_id": "43ad9d40-cf2b-4c59-afd9-3e5e2e676526",
  "parent_session_id": "session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b"
}
---

## 执行笔记

交付物：`core/ops.ts`（readSupervisorSession）、`core/tests/core.test.ts`（+1 测试）、
`dsh-graph-host/index.js`（boardPayload 组合）、`dsh-graph-client/index.js`（端点改用它）、
`dsh-graph-client/lib/client.js`（SupervisorBar + useSessionModel 抽取 + 依赖徽章状态化）。

实现要点（对应判据）：
1. **顶部状态栏**：`SupervisorBar`（class `dg-supervisor`，sticky 顶置）复用 LiveStrip
   （parentId=null，顶层会话直接 sessions.binding(id) → open()）+ `useSessionModel`
   模型名（从 SessionPanel 抽取的共用 hook）+ 「↗ 主管对话」按钮。
2. **跳转**：`sessionsRt.open(id)` + 复用 `activateChatTab()`（g-107 五轮的切 tab 逻辑，
   已在该会话看板 tab 时自动切回对话 tab）。
3. **id 不硬编码**：core 新增 `readSupervisorSession(root)`（零依赖行扫描 project.yaml
   的 supervisor.session，去引号/注释）；host 包导出 `boardPayload(root)` =
   boardProjection + supervisorSession 字段；client 的 host 半边 /api/dsh-graph 改用它下发；
   client 消费 `b.supervisorSession`，未配置则不渲染状态栏。
4. **判据 5（发现#23 依赖徽章状态化，负责人指示从 g-a92e1406 移入本目标）**：KanbanView 建全量
   goalStatus 映射传入 Card；已交付依赖显示「✅ 依赖满足：X 已交付」（绿色），仅未交付
   依赖显示「⛓ 等待」并触发琥珀边框，两类可同时显示（g-108 自身依赖 g-107 已交付即活样例）；
   GoalModal 头部依赖行同步拆分两态（通过 goalStatus prop 保持一致）。

验证：
- `scripts/check_g108.sh` 全绿（冻结脚本未改，含 planner 修订 2 的依赖徽章检查）；
- check_g107/check_kanban/check_cards/check_plugin/check_core 回归全 PASS；
- core 单测 +1（readSupervisorSession 正/反向用例），node --test 全过；
- 离线冒烟：mock loader+React，模块加载与 slot 注册正常；
- boardPayload 真实图根冒烟：supervisorSession 正确读出 session-b00ed183-…。

已知边界：
- supervisor 会话 id 变更需手工更新 project.yaml（goal 描述里的「启动/绑定时更新字段」
  属 supervisor 侧行为，未在本目标做自动回写）；
- activateChatTab 的 DOM 首 tab 点击依赖 chat order=0 约定（g-107 已录脆弱点）。

## Review 记录

<!-- 受管小节 -->
