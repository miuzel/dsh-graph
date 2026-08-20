---
{
  "id": "g-102",
  "title": "Kanban 二维泳道看板（client-plugin）",
  "status": "draft",
  "blocked_reason": null,
  "created_at": "2026-08-20 17:29:00+08:00",
  "created_by": "supervisor",
  "version": null,
  "scope": [],
  "depends_on": [],
  "review": {
    "reviewer": "human",
    "prompt": null
  },
  "pk": {
    "lanes": 1,
    "sandbox": "directory"
  },
  "rules_snapshot": "r-2026-08",
  "skill_refs": []
}
---

## 目标描述
DSH client-plugin 形态的看板：横轴生命周期阶段、纵轴版本泳道 + backlog 区；
卡片查看详情/判据核对/履历；干预操作（声明完成、CRUD、给 supervisor 输入）。
依赖 g-101 提供的接口。
