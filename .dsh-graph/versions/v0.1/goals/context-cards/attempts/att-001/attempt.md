---
{
  "id": "att-001",
  "goal": "g-003",
  "executor": "agent:k3",
  "sandbox": "主工作区（v0.1 单 lane，免隔离）",
  "started_at": "2026-08-20T19:00:00+08:00",
  "claimed_at": "2026-08-20T19:10:00+08:00",
  "result": "pending"
}
---

## 执行笔记

交付物：`core/` 新增卡片命令与校验。

实现摘要：`ops.ts` 新增 addCard/fillCard/reviewCard 与 validate 卡片校验（悬空引用、归属、状态合法）；
`main.ts` 新增三个 CLI 命令；`tests/cards.test.ts` 新增 4 个测试。13/13 测试通过，
check_cards.sh PASS，check_core.sh 回归 PASS。

## Review 记录
<!-- 受管小节 -->
