# mem-006：看板可写工作台 + root 通用化（g-109 / g-112 交付模式）

source_goal: g-109、g-112（versions/v0.3/goals/），交付于 f27e5d3（g-112 追认交付）

## g-109 看板可写工作台
- 弹窗「🚀 执行」＝ POST /api/dsh-graph/start-execution 直接派发执行子代理；「💬 反馈」＝跳主管会话+预填模板+toast 自动复制（无 DSH 预填 API 的退化方案）。
- 写操作一律 host 端点、事件先行；卡片/收集绑定走 core op bindCardChild（写 child_id/parent_session_id + card.collecting 事件）。
- 执行/反馈按钮显示条件：status∈{draft,planning,collecting,ready} 且无「执行类」attempt.started——**hasActiveAttempt 要排除 agent:collect**，否则「开始收集」也会误藏执行按钮。
- ReExecBox：实时会话内换 provider/model 重执行（读 ctx.llm.listProviders()/listModels()，不暴露 spawn/fork 这类 subagent provider）。
- spawnChild 两个 provider 概念别混用：subagent provider（spawn/fork，选带 prepareContinuable 能力的）≠ LLM provider（agentOptions，用户可选）；找不到 subagent provider 时明确报错列已注册名，**绝不回退字面量 "spawn"**。

## g-112 root 通用化
- core/root.ts `resolveRoot(config?, workspaceRoot=process.cwd()) = resolve(workspaceRoot, config?.root ?? ".dsh-graph")`，host/client 共用同一函数。
- DSH 约定：第三方插件数据放**工作区内**（非 $DSH_HOME）；「运行目录=默认 workspace 根」。本地开发靠 ~/.dsh/profiles/web/cordis.patch.yml 用户层覆盖，不破坏。
- host/client apply 幂等调 core init()（以 events.jsonl 是否存在判首次），新用户装上自动建骨架。

## 教训
- **human gate 不可被自移越过**：执行子代理误把「主管技术复核通过」当「确认交付」，自行 review→delivered（g-112）。spawn 模板已加「禁区：不得自移 delivered」。执行子代理最多自移到 review。
