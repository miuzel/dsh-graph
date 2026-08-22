---
{
  "id": "g-117",
  "title": "supervisor 会话交接：一键 handoff + 自动更新主管会话 id",
  "status": "draft",
  "blocked_reason": null,
  "created_at": "2026-08-22T10:36:30+08:00",
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

让 supervisor 换会话「一键完成」，取代现在的手改 project.yaml + settings.yaml + 手写 HANDOFF.md。背景：2026-08-22 换会话时靠手写 HANDOFF.md + sed 改 supervisor.session，易漏、易错。

交付两个工具（core op + graph_* 工具，事件先行）：
1. **graph_handoff**（旧会话交接时调用）：生成/更新 `.dsh-graph/HANDOFF.md`——从 board 投影 + 长期记忆 + 关键环境事实自动拼一份结构化交接（当前版本目标状态、进行中事项、下一步、环境事实、遗留）。产出物落盘，不依赖会话上下文。
2. **graph_claim_supervisor**（新会话接手时调用）：把 project.yaml 的 `supervisor.session` 更新为**当前会话 id**（读 ex.agent.session.id / header.cwd 同一链），记 `supervisor.claimed` 事件（actor=当前会话），并把 HANDOFF.md 内容作为返回值返回（供新会话直接注入上下文，无需再去读文件）。幂等：重复调用不重复记事件。

设计要点：
- supervisor.session 的写入走 core op（写 project.yaml 的 supervisor 块，事件先行、原子写），与 readSupervisorSession 对应；
- HANDOFF.md 生成走 boardProjection + 长期记忆目录 + 固定环境事实段（provider 名、root 相对覆盖、pnpm supply-chain 等，这些是 supervisor-guide 里已有的硬事实）；
- 看板顶部主管栏自动读新 session id（readSupervisorSession 现读，无需额外改动）。

## 质量判据

1. graph_handoff 生成/更新 .dsh-graph/HANDOFF.md（board 投影 + 长期记忆 + 环境事实段），产物不依赖会话上下文
2. graph_claim_supervisor 把 project.yaml 的 supervisor.session 更新为当前会话 id（ex.agent.session 链），记 supervisor.claimed 事件且幂等，返回 HANDOFF.md 内容
3. core 提供写 supervisor.session 的 op（与 readSupervisorSession 对应，原子写、事件先行）
4. 测试不回归 + 实测：新会话调用 graph_claim_supervisor 后看板主管栏指向新会话

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
