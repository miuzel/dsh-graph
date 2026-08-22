---
{
  "id": "g-118",
  "title": "supervisor 守则自动注入：新 supervisor 会话无需显式调用 skill 即拿到工作守则",
  "status": "delivered",
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
  "skill_refs": [],
  "context_cards": [
    "card-71d340a3"
  ]
}
---

## 目标描述

**最终设计（负责人 2026-08-22 定案，取代早期「自动注入完整守则」方案）**：
否决「每个会话自动注入 supervisor 角色/完整守则」——临时会话若被注入主管角色会**争抢 supervisor**，不好。改为：

1. **保持显式调用**：新会话想接管 supervisor 用 `graph_claim_supervisor`（g-117 已实现）；
2. **注入简短引导提示词**：dsh-graph-host 在所有会话注入一条**简短**提示（不注入完整守则），告知用户/会话：如何 claim 新 supervisor（graph_claim_supervisor 用法）、如何查看帮助（dsh-graph help）——引导接管而非自动赋权；
3. **新增 `dsh-graph help` 命令**：查看 dsh-graph 使用说明 / claim 指引（形式：graph_* 工具或端点，实现时定）；
4. **完整 supervisor 守则仍走显式 skill 调用**（dsh-graph-supervisor），不自动注入。

背景：2026-08-22 新会话接手时未调用 skill，裸奔自实现 g-117，撑爆会话、认知降级——根因是 skill 按需调用、不保证注入。g-117（graph_handoff/claim_supervisor）管「换会话状态」，本目标管「换会话后如何引导接管」。

**关键设计约束（负责人提出）**：
- 主管守则**绝不**自动注入执行子代理/临时会话（避免角色争抢与执行角色误判）；
- 简短引导提示词是轻量、无害的（告知「如何」接管，不授予角色），可注入所有会话；
- 注入机制沿用调研结论方案 A：`systemPrompt.section` 条件渲染（空文本被丢弃，零 token），实现已验证（att-001 遗留，可复用）。

## 质量判据

1. 调研结论沉淀（att-001 已产出，可复用）：DSH 注入机制方案 A = systemPrompt.section 条件渲染（空文本丢弃零 token）
2. 实现：dsh-graph-host 在所有会话注入**简短引导提示词**（非完整守则）——告知如何 claim 新 supervisor（graph_claim_supervisor 用法）+ dsh-graph help 命令存在；完整 supervisor 守则**不**自动注入，仍走显式 skill 调用
3. 实现：新增 dsh-graph help 命令（graph_* 工具或端点）输出 dsh-graph 使用说明与 claim 指引
4. 隔离验证：主管守则绝不注入执行子代理/临时会话（引导提示词除外）；单测覆盖引导注入+help 命令+隔离断言
5. 全量测试与冻结脚本 PASS，graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
