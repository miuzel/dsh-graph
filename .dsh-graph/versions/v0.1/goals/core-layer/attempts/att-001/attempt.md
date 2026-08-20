---
{
  "id": "att-001",
  "goal": "g-001",
  "executor": "agent:k3",
  "sandbox": "主工作区（v0.1 单 lane，免隔离）",
  "started_at": "2026-08-20T18:20:00+08:00",
  "claimed_at": "2026-08-20T18:40:00+08:00",
  "result": "selected"
}
---

## 执行笔记

交付物为 workspace 根下的 `core/`（目标 scope），delivery/ 留空作占位。

实现摘要：`model.ts`（frontmatter 解析/写回，正文逐字节保留）、`events.ts`
（append/replay）、`machine.ts`（状态机+不变式）、`ops.ts`（init/create-goal/
set-criteria/transition/validate/rebuild）、`main.ts`（CLI）。
9 个单元测试 + 冻结脚本冒烟全过；真实图根 validate/rebuild 一致。

## Review 记录
<!-- 受管小节 -->
审核方：human:负责人（2026-08-20，会话内逐条材料核验）

| 判据 | 结果 |
|------|------|
| 1 create-goal 符合 schema、正文原文保留 | ✅ 通过 |
| 2 合法迁移+事件追加；三类非法迁移拒绝且退出码非零 | ✅ 通过 |
| 3 validate 报告存量不变式违例 | ✅ 通过 |
| 4 rebuild --check 一致性与篡改检测 | ✅ 通过 |
| 5 scripts/check_core.sh PASS | ✅ 通过 |

结论：通过交付（review.passed → delivered）。
