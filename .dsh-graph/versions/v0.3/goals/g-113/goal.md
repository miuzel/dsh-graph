---
{
  "id": "g-113",
  "title": "dsh-graph 新项目开箱即用：root 跟随会话 workspace + 使用指引注入",
  "status": "in_progress",
  "blocked_reason": null,
  "created_at": "2026-08-22T03:17:41+08:00",
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

让 dsh-graph 在「新项目」里开箱即用——负责人跨项目验证（comma-cli）暴露两个缺陷：

1. **root 不跟随会话 workspace**：`core/root.ts` 的 `resolveRoot` 用 `process.cwd()`，但 dsh web 服务进程的 cwd 在 bwrap 沙箱里固定（≈ `~/.dsh/profiles/web`），不是当前会话的 workspace。结果：在任意项目开会话，board 与 graph_* 工具都读 `~/.dsh/profiles/web/.dsh-graph` 这个空骨架，而不是项目自己的 `.dsh-graph`。
   - 修法：root 应跟随**会话 workspace** ＝ `session.header.cwd`（或 `sandboxPolicy.workspaceRoot`）。需调研 host/client 两半各自如何拿到当前会话的 workspace（工具侧从 `ex.agent.session.header.cwd`，board 端点侧可能需从 connection/sessions 或前端带 workspace 参数），统一注入到 resolveRoot。
2. **新 agent 无使用上下文**：只注册了 `dsh-graph-supervisor`（给主管），普通 agent 不懂 dsh-graph 是什么、graph_* 工具怎么用、目标生命周期怎么走。需给普通会话注入「dsh-graph 使用指引」（skill 或 agent instructions）：工具清单、目标生命周期（draft→planning→…→delivered）、判据先行、卡片/收集/执行概念。

产出：root 随 workspace 的解析实现（两半一致）+ 使用指引 skill 注册 + 跨项目实测（comma-cli 例子各项目各用自己的 .dsh-graph）+ 测试。

## 质量判据

1. root 跟随会话 workspace（session.header.cwd / sandboxPolicy.workspaceRoot），不用 process.cwd()；host 工具与 client board 端点两半一致
2. 跨项目实测：在 comma-cli（或其他非 dsh-graph 目录）开会话，board/graph_* 读该项目自己的 .dsh-graph，而非 profile 本地骨架
3. 注册普通 agent 的 dsh-graph 使用指引（skill 或 instructions）：graph_* 工具清单、目标生命周期、判据先行、卡片/收集/执行概念
4. 测试不回归 + 真实新项目开箱验证通过

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
