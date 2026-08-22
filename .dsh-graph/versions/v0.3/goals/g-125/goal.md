---
{
  "id": "g-125",
  "title": "看板卡片精简：交付/阻塞卡片默认折叠（隐藏依赖/livestrip/执行按钮/上下文卡片），摘要折叠 2 行 + 摘要写法约束",
  "status": "ready",
  "blocked_reason": null,
  "created_at": "2026-08-22T12:12:36+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.3",
  "scope": [
    "dsh-graph-host",
    "supervisor-guide"
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

负责人 2026-08-22 UI 改进反馈（看板卡片信息密度过高，非活动阶段卡片不必展开全部）：

1. **交付（delivered）/阻塞（blocked）阶段卡片默认折叠精简**：不显示依赖（deps）、livestrip（会话实时条）、执行会话按钮、上下文卡片列表——这些是活动阶段才需要的信息，交付/阻塞卡片只留核心（标题/状态/摘要/结果）；
2. **上下文卡片摘要默认折叠到 2 行**：卡片摘要过长时截断显示（2 行 + 省略），展开可见全文；
3. **约束上下文卡片摘要的写法**：graph_fill_card 的 summary 应简短（一句话要点式），guide/提示词规范约束长度（如 ≤100 字），从源头减少长摘要。

改动面：client.js（卡片渲染折叠逻辑 + 摘要截断）、core/ops.ts 或 guide（summary 写法约束）。



## 质量判据

1. client.js：delivered/blocked 状态卡片默认折叠——不渲染依赖、livestrip、执行会话按钮、上下文卡片列表（仅核心信息），可展开查看完整
2. client.js：上下文卡片摘要默认折叠到 2 行（超长截断+省略号，可展开全文）
3. 摘要写法约束：graph_fill_card 的 summary 规范（一句话要点、≤100 字左右），supervisor-guide/提示词沉淀写法要求
4. 全量测试与冻结脚本 PASS，graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
