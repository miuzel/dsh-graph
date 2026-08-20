---
{
  "id": "g-104",
  "title": "PK 沙盒编排与对比评审",
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
目标级 PK 支持：多 attempt 并行派发（git worktree 沙盒隔离 + 独立交付目录）、
独立核验 + 横向对比评审、选定/合并/全灭三出路路由。依赖 g-001、g-101。
