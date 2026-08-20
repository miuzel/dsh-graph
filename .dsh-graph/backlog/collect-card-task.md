---
{
  "id": "g-106",
  "title": "收集项任务化：卡片绑定收集子代理",
  "status": "draft",
  "blocked_reason": null,
  "created_at": "2026-08-20T23:50:00+08:00",
  "created_by": "human:负责人",
  "version": null,
  "scope": ["dsh-graph-host/", "core/"],
  "depends_on": [{ "goal": "g-101", "consumes": ["startContinuable 派发与绑定"] }],
  "review": { "reviewer": "human", "prompt": null },
  "pk": { "lanes": 1, "sandbox": "directory" },
  "rules_snapshot": "r-2026-08-3",
  "skill_refs": []
}
---

## 目标描述
收集计划中的每一项是一张独立的上下文卡片，可指定子代理作为收集任务执行：
- `graph_collect_card` 工具：为卡片派发收集子代理（startContinuable），卡片 → collecting，
  绑定 child_id；
- 收集子代理运行过程可见（周期 graph_report_status 汇报，状态行进事件流与看板）；
- 收集结果回填卡片（filled），连同来源一并记录；
- attempt（goal runner）启动时，filled/reviewed 卡片按 context_cards 顺序注入其会话上下文，
  注入清单记入 attempt.started 事件 details.injected_cards。

来源：负责人 2026-08-20 看板实测反馈第 5 条。
