---
{
  "id": "g-141",
  "title": "GUI 目标重命名：在目标操作里填新标题，更新 goal.md title + 事件流",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-23T01:11:22+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.5",
  "depends_on": [],
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

## 质量判据

1. GUI 目标操作里可重命名：填新标题 → 更新该目标 goal.md 的 meta.title（及 frontmatter 标题）
2. 为提供 graph 工具/端点（如 rename-goal 或 amendGoal 传 title）；走事件流（R-02）记 goal.renamed 事件（旧/新标题）
3. 校验：title 非空、去首尾空白；node --check + 108 测试 + graph_validate 过；不破坏已交付功能

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
