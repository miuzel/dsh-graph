---
{
  "id": "g-140",
  "title": "目标删除：删除目标（含其卡片/attempts 目录；delivered/评审中需确认）",
  "status": "review",
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
  "rules_snapshot": "r-2026-08-3",
  "skill_refs": []
}
---

## 目标描述


目标删除（负责人 2026-08-23 反馈）：仅「已归档」目标可删除（未归档先归档/提示）；且目标不能有活跃子代理（有执行子代理时拒绝/提示先停止）。删除含目标卡片/attempts 目录，记 goal.deleted 事件（R-02），replay 容忍 deleted 终态。

实现要点（负责人 2026-08-23）：1) 新增 deleteGoal op——仅当目标已归档（在 archived 目录）才可删除，且无活跃子代理（attempt 未结束）；2) 删除 = 删目标目录（含 cards/attempts）+ 记 goal.deleted 事件（R-02，details 含 id），replay 容忍 deleted 终态；3) GUI 目标操作里加「删除」（仅已归档目标显示，二次确认）；4) 走 graph 工具/端点；不破坏已交付功能。


## 质量判据

1. 仅「已归档」目标可删除：未归档目标删除时拒绝并提示先归档（deleteGoal 前置校验 archived）
2. 目标不能有活跃子代理：有 attempt 在执行（子代理未结束）时拒绝并提示先停止/等其结束
3. 删除目标文件 + 其卡片/attempts 目录；记 goal.deleted 事件（details 含 id），replay 容忍 deleted 终态
4. 走 graph 工具 + 事件流（R-02），先删后事件（或事件先行）；node --check + 108 测试 + graph_validate 过；不破坏已交付功能

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
