---
{
  "id": "g-a92e1406",
  "title": "状态摘要运行动画与履历：流动背景+图标动画、modal 显示、近期动态收录汇报",
  "status": "planning",
  "blocked_reason": null,
  "created_at": "2026-08-21T11:38:46+08:00",
  "created_by": "agent:session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b",
  "version": "v0.3",
  "scope": [],
  "depends_on": [
    {
      "goal": "g-107",
      "consumes": [
        "看板卡片/modal 结构改动（避免并行改 client.js 冲突）"
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
  "rules_snapshot": null,
  "skill_refs": []
}
---

## 目标描述

（待填写）

负责人需求原话：卡片中显示运行状态摘要时（如"⏳ API 取证完成…开始改造 client.js 内嵌实时区"），摘要部分应有流动背景动画、图标也要动画，表示正在运行；该摘要在点开的卡片（modal）中也能看到（标题下方）；状态摘要的履历加入近期动态 event 列表。

实现要点（调研结论）：动画用 CSS keyframes 加在 statusLine 上（流动背景 background-position 动画 + 图标 pulse/spin），仅运行中（有 status_line 且非 blocked）启用，⛔ 阻塞行不动画；modal 从 goalDetail.attempts 取最新 status_line 渲染在标题下方；近期动态白名单 MEANINGFUL 补 attempt.status_reported（人类化话术已有："汇报：…"）。

负责人补充：近期动态在弹窗（modal）中用**独立 tab** 承载（不再是纵向分区的一节）；modal 改为 tab 结构（如 详情 / 近期动态）。

依赖：等 g-107 完成后再执行（两者都改 client.js 看板视图，避免冲突）。


## 质量判据

（待登记；进入 in_progress 前必须非空且已确认）

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
