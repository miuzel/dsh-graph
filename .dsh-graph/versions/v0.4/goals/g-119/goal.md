---
{
  "id": "g-119",
  "title": "收集卡绑定工具 graph_bind_collect_card + supervisor skill 绑定约束",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-22T11:09:05+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.4",
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

agent 侧缺「把已派发的收集子代理绑定到上下文卡片」的工具：core 已有 bindCardChild（写 child_id/parent_session_id、置 status=collecting、记 card.collecting 事件），但只被 GUI 的 /api/dsh-graph/start-collection 端点调用，supervisor 无法用工具完成绑定（g-118 实测只能写 tmp 探针脚本直调 core hack）。本目标：

1. host 注册新工具 graph_bind_collect_card(goal, card, child_id[, parent_session_id])：调用 core bindCardChild；parent_session_id 缺省取当前会话 id。
2. supervisor-guide.md 信息收集规范加硬约束：派发收集子代理后必须立即绑定卡片，parent_session_id 从子代理会话文件头反查 parentSession（权威来源），禁止按工作区+时间推断；未绑定视为流程违规（g-118 教训）。



## 质量判据

1. 实现 graph_bind_collect_card 工具：参数 goal/card/child_id/(parent_session_id 可选)，调用 core bindCardChild，写 child_id/parent_session_id/status=collecting + 记 card.collecting 事件（事件先行，R-02）
2. supervisor-guide.md 信息收集规范加硬约束：派发收集子代理后必须立即用绑定工具把 child_id 绑到卡片（含 parent_session_id 取值规则：从子代理会话文件头反查 parentSession，禁止推断）；无绑定即流程违规
3. 单测覆盖：绑定工具注册 + 执行成功写事件恰 1 条；幂等/参数缺失报错；guide 含约束文本断言
4. 全量测试与冻结脚本 PASS，graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
