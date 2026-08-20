---
{
  "id": "g-003",
  "title": "上下文卡片模型与核心命令",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-20T18:50:00+08:00",
  "created_by": "supervisor",
  "version": "v0.1",
  "scope": [
    "core/",
    "schema/SCHEMA.md"
  ],
  "depends_on": [
    {
      "goal": "g-001",
      "consumes": [
        "core/ 引擎"
      ]
    }
  ],
  "review": {
    "reviewer": "human",
    "prompt": null
  },
  "pk": {
    "lanes": 1,
    "sandbox": "directory"
  },
  "rules_snapshot": "r-2026-08-3",
  "skill_refs": []
}
---

## 目标描述
在核心层实现上下文卡片模型（DESIGN.md §2.2 / SCHEMA.md §2.5）：
卡片文件（目标目录下 `cards/<card-id>.md`）、`add-card` / `fill-card` / `review-card`
命令、目标 frontmatter 的 `context_cards` 有序引用、attempt 启动注入清单事件、
validate 校验卡片引用完整性。

## 质量判据

1. [script] scripts/check_cards.sh

## 证据台账
| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|
