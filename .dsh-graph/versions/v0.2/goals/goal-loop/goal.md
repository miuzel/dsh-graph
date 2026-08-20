---
{
  "id": "g-101",
  "title": "目标闭环 DSH 插件（goal-loop）",
  "status": "review",
  "blocked_reason": null,
  "created_at": "2026-08-20 17:29:00+08:00",
  "created_by": "supervisor",
  "version": "v0.2",
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
  "rules_snapshot": "r-2026-08",
  "skill_refs": [],
  "context_cards": [
    "card-b561d092",
    "card-74640f91"
  ]
}
---

## 目标描述
把核心层包装为 DSH 插件（cordis 插件包）：驱动单目标全生命周期（生成取证计划与判据 →
收集信息 → 派发 attempt → 判据核验 → 处置分支路由）。依赖 g-001 的核心层。

**状态汇报（负责人指定）**：执行中的 attempt agent 周期性调用插件工具汇报**一句可展示
的工作状态**（如"正在实现 validate 环检测"），写入 attempt 状态行并追加
`attempt.status_reported` 事件；看板卡片只显示最新一句，代替流式思考/生成输出。
执行 agent 的指导（persona/skill/工具描述）必须包含汇报要求。

**多会话管理（负责人指定）**：收集阶段的工具调用与原始内容在 subagent 内消化，仅精炼
证据回流，保证执行阶段上下文干净；当收集 agent 输出简单干净时，直接复用该 subagent
续轮进入执行阶段，提高上下文缓存命中率。

**实现约束（不自建轮子，源码调研结论）**：
- 面向模型的图操作经 `ctx.tools.register(defineTool(...))`（`dsh-tools`）注册；
- subagent 多会话直接映射 `ctx.subagents` 服务（`dsh-subagent`）：
  `startContinuable`（持久化可续轮子 agent）/ `followup`（续轮）/ `interrupt` /
  `listChildren`；子级结算通知由管理器自动投递给父级。插件只做 attempt ↔ childId
  的绑定与创建/复用/归档决策记录，**不自建会话管理**；
- 技能沉淀走 `ctx.skills.register`（`dsh-skill` 运行时注册）或写 SKILL.md 由
  `dsh-skill-filesystem` 发现。

## 质量判据

1. [script] scripts/check_plugin.sh
