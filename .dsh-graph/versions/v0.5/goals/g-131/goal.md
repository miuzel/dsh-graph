---
{
  "id": "g-131",
  "title": "主管会话每 turn 自动注入简短纪律提醒（仅主管会话，杜绝主管越权自实现）",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-22T20:28:36+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.5",
  "scope": [
    "dsh-graph-host",
    "systemPrompt.section 注入机制"
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

1. 短提醒仅注入主管会话（project.yaml 的 supervisor.session 指向的会话）；普通会话/执行子代理不注入或沿用现有 GUIDE_HINT，二者行为分明
2. 提醒内容强调主管铁律：只做规划/派发/把关/复核、实现交子代理（自己动手仅限一句话决策/一行小修）、每动作后 graph_report_supervisor_status、review→delivered 必须等负责人 verdict
3. 每 turn 开头可见（system prompt 段落），文本简短、token 成本小
4. 复用/扩展现有 systemPrompt.section（index.js:819-858 现对所有会话恒渲染 GUIDE_HINT），不破坏既有普通会话/子代理引导
5. 子代理须先核实 systemPrompt.section 的 text() 能否拿到当前会话 id 判断 supervisor；不能则找正确按会话注入机制（DSH systemPrompt 来自 runtime host，需实测）
6. 验证：主管会话看到提醒、普通/子代理会话不误注入；node --check 通过；graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
