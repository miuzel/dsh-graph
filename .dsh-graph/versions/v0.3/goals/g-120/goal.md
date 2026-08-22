---
{
  "id": "g-120",
  "title": "执行派发注入已收集卡片成果（context_cards 内容注入执行子代理 + injected_cards 事件）",
  "status": "review",
  "blocked_reason": null,
  "created_at": "2026-08-22T11:22:16+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.3",
  "scope": [
    "core",
    "dsh-graph-host"
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

负责人 2026-08-22 报 bug：看板点「执行」（start-execution）创建的执行子代理没有拿到目标已收集完成的上下文卡片成果。goal.md 的 `context_cards` 只有卡片 id 引用，子代理不知道去哪读卡片内容，会重新收集一遍。

现状：`graph_start_attempt` 工具 prompt 只有目标文件路径 + 状态汇报/泳道迁移指令；start-execution 端点 prompt 有目标描述+判据，但两处都**未注入 context_cards 里 filled/reviewed 卡片的成果**（skill 指南第 4 条：「执行 attempt 启动时按 context_cards 顺序把 filled/reviewed 卡片注入执行子代理上下文，注入清单记入 attempt.started 的 details.injected_cards」）。

修复：core 新增读取函数（按 context_cards 顺序返回 filled/reviewed 卡片的 title+summary+正文），host 两处执行派发在 prompt 里注入「已收集上下文卡片成果」段，attempt.started 事件 details 记 injected_cards。

**worktree 隔离（负责人 2026-08-22 指示，纳入本目标交付范围）**：并发/复杂的执行任务，子代理宜先 `git worktree add` 独立工作树（与 main 隔离）再改代码，review 交付阶段由 supervisor 复核通过后合并回 main——避免并发子代理互相踩提交、半成品直接落 main。本目标改 spawn 提示词时一并实现：
- 在「已收集卡片成果」注入段旁附带 worktree 指令（提示词模板内联；主管可在 `graph_start_attempt` 参数或提示词模板里开关，至少文档化，不强制所有任务走 worktree——简单/单文件小修可跳过）；
- 明确 worktree 与主工作树的数据/事件流分工：**代码改动在 worktree，看板数据 `.dsh-graph/` 仍在主工作树写**（看板/事件流不被 worktree 分支隔离，避免状态漂移），review 合并回 main 时处理冲突；
- supervisor-guide.md 执行规范已沉淀 worktree 条目（2026-08-22），spawn 提示词与该条目保持一致。



## 质量判据

1. core 新增函数：按 context_cards 顺序读取 filled/reviewed 卡片的成果（title+summary+正文全文），跳过 empty/collecting；无卡片时返回空
2. host 两处执行派发（graph_start_attempt 工具 prompt + /api/dsh-graph/start-execution 端点 prompt）注入「已收集上下文卡片成果」段：按顺序列出每张卡的 title/summary/正文，子代理无需自己猜卡片路径
3. attempt.started 事件 details 记 injected_cards（注入的卡片 id 清单，按注入顺序）
4. spawn 提示词附带 worktree 隔离指令（负责人 2026-08-22 指示）：并发/复杂任务子代理先 git worktree add 独立工作树再改代码，review 交付阶段复核通过后合并回 main；指令可开关（参数/模板），简单小修可跳过；明确代码改 worktree、看板数据 .dsh-graph/ 仍在主工作树写的数据分工
5. 单测覆盖：core 读取函数（顺序/过滤状态/无卡片）；host 两处 prompt 含卡片成果段；事件含 injected_cards；prompt 含 worktree 指令断言；全量测试与冻结脚本 PASS
6. graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
