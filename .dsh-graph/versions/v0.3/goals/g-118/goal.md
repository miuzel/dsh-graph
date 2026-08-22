---
{
  "id": "g-118",
  "title": "supervisor 守则自动注入：新 supervisor 会话无需显式调用 skill 即拿到工作守则",
  "status": "draft",
  "blocked_reason": null,
  "created_at": "2026-08-22T10:49:16+08:00",
  "created_by": "agent:session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b",
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
  "skill_refs": []
}
---

## 目标描述

让 supervisor 工作守则**自动注入**新主管会话，不再依赖「新会话记得显式调用 `dsh-graph-supervisor` skill」。背景：2026-08-22 新会话接手时未调用 skill，裸奔自实现 g-117，撑爆会话、认知降级——根因是 skill 按需调用、不保证注入。

要做的（调研 + 实现）：
1. 调研 DSH 让插件内容**自动注入会话**的机制：`dsh-agent-instructions` 包（系统提示词注入）、skill 的自动触发标记、或 host 插件注册 instructions 的方式。给出可行方案。
2. 实现：让 `dsh-graph-host` 在 supervisor 会话（或所有会话）自动注入 supervisor-guide.md 的核心守则（至少「只规划/派发/把关，绝不自己实现」这条铁律 + 工具速查 + 环境事实），不依赖显式 skill 调用。
3. 验证：新会话不调用 skill 也能看到守则（可从 system prompt / 上下文注入确认）。

注：与 g-117（graph_handoff/claim_supervisor）互补——g-117 管「换会话状态」，本目标管「换会话后守则自动到位」。

**关键设计约束（负责人提出）：注入必须按会话作用域隔离**——
- 主管会话（`session.id === project.yaml 的 supervisor.session`）→ 注入 `dsh-graph-supervisor`（主管守则）；
- 其余会话/执行子代理 → 注入 `dsh-graph`（普通使用指引）或什么都不注入，**绝不能**把主管守则注入执行子代理，否则它们会误以为自己是主管、反而违背「执行/实现」角色。

## 质量判据

1. 调研 DSH 自动注入机制（dsh-agent-instructions / skill 自动触发）并给出可行方案
2. 实现：dsh-graph-host 自动注入 supervisor 核心守则（铁律「绝不自己实现」+ 工具速查 + 环境事实）到新主管会话，不依赖显式 skill 调用
3. 验证：新会话不调用 skill 也能从上下文看到守则

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
