---
{
  "id": "g-139",
  "title": "目标合并：把一个目标并入另一个（内容/卡片/事件归并，源目标删除）",
  "status": "planning",
  "blocked_reason": null,
  "created_at": "2026-08-23T01:09:32+08:00",
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
  "rules_snapshot": null,
  "skill_refs": []
}
---

## 目标描述


目标合并（负责人 2026-08-23）：把一个目标并入另一个——A 的描述/判据/依赖以修订追加进 B（记 B 的 goal.amended，注明来源 A），A 记 goal.deleted（details.merged_into=B）后删除；卡片/attempts 附件随删除清理；UI 选择目标目标（下拉/搜索现有目标）；走工具+事件流（R-02）。


## 质量判据

（待登记；进入 in_progress 前必须非空且已确认）

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
