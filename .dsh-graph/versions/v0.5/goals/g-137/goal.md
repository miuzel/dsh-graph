---
{
  "id": "g-137",
  "title": "版本内=planning / backlog=draft 语义 + draft 仅前向到 planning + backlog 平铺 GUI（不再分横向泳道）",
  "status": "in_progress",
  "blocked_reason": null,
  "created_at": "2026-08-23T00:02:24+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.5",
  "scope": [
    "core/ops.ts",
    "core/machine.ts",
    "client.js",
    "版本/backlog 语义与看板布局"
  ],
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

1. 语义：createGoal 带 version → 初始状态 planning；不带 version（backlog）→ draft；moveGoal 进版本 → planning、进 backlog → draft（standalone 不动状态）
2. draft 前向边仅 draft→planning（相邻）：draft→collecting / draft→in_progress 保持非法（machine.ts 现状已是，不改 EDGES）；后续规划流程 planning→collecting→ready→in_progress→review→delivered 按顺序
3. GUI backlog 行不再按横向 stage 列拆分：整块矩形背景、所有 backlog 卡片平铺展示；不为 backlog 卡显示/适用描述/采集等列
4. 改源 core/*.ts（勿改编译版）+ 重跑 sync-core；node --check；node --test core/tests/*.test.ts 全部通过；graph_validate 无问题
5. 不破坏已交付功能（拖放/g-131 纪律提醒/scope 去除）；index.js/client.js 只改 backlog 渲染与状态相关，不误删其它

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
