---
{
  "id": "g-138",
  "title": "目标暂缓：把目标移回 backlog（支持带附件目标，先停止/解除再移）",
  "status": "planning",
  "blocked_reason": null,
  "created_at": "2026-08-23T01:09:29+08:00",
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


目标暂缓（负责人 2026-08-23）：把目标移回 backlog（版本/独立目标均可暂缓）；带卡片/attempts 的目标暂缓需先停止执行子代理，并把目标目录迁到 backlog 目录形态；走工具+事件流（R-02），原状态/事件保留可回溯。


## 质量判据

1. 目标可「暂缓」：移回 backlog（版本/独立目标均可暂缓到 backlog）
2. 带卡片/attempts 的目标暂缓：需先停止执行子代理，并把该目标的目录（cards/attempts/goal.md）迁到 backlog 目录形态（backlog 平铺限制需解除/或临时支持暂缓带附件）
3. 走 graph 工具 + 事件流（R-02）；原状态/事件保留可回溯；node --check + 108 测试 + graph_validate 过

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
