---
{
  "id": "g-122",
  "title": "dummy：g-120 实机验证（收集→执行注入观察）",
  "status": "in_progress",
  "blocked_reason": null,
  "created_at": "2026-08-22T11:55:12+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.3",
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
  "rules_snapshot": "r-2026-08-3",
  "skill_refs": [],
  "context_cards": [
    "card-0112ddd4"
  ]
}
---

## 目标描述

dummy 目标（负责人 2026-08-22 指示）：用于 g-120 实机验证——观察「GUI 点执行」与「supervisor 对话派发」两条路径是否自动注入已收集卡片成果。流程：

1. 建一张收集卡，派发收集子代理填一个**有辨识度的调研内容**（如「DSH 的 workspace 服务 API 是什么？」）；
2. 收集完成（filled/reviewed）后，从 GUI 点「执行」与用 graph_start_attempt 各派发一次执行；
3. 观察执行子代理的上下文是否含卡片成果段（「已收集上下文卡片成果」+ 内容）——验证 g-120 注入生效。

验证完本目标即交付/归档，不产生真实代码改动。



## 质量判据

1. 实机验证 g-120：GUI 点「执行」派发的执行子代理上下文中含「已收集上下文卡片成果」段及卡片内容
2. 实机验证 g-120：graph_start_attempt 对话派发的执行子代理同样注入卡片成果段
3. 验证完 dummy 目标即归档，不产生真实代码改动

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
