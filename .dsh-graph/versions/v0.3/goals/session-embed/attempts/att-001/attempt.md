---
{
  "id": "att-001",
  "goal": "g-107",
  "executor": "agent:k3",
  "sandbox": "directory",
  "started_at": "2026-08-21T11:21:14+08:00",
  "claimed_at": "2026-08-21T11:53:50+08:00",
  "status_line": "五轮意见落地：实时会话标题加跳转按钮，跳转后自动切回对话 tab；验收+回归+冒烟全绿，等待复测",
  "result": "pending",
  "child_id": "43ad9d40-cf2b-4c59-afd9-3e5e2e676526",
  "parent_session_id": "session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b"
}
---

## 执行笔记

交付物：`dsh-graph-client/lib/client.js`（唯一改动文件，+~330 行）。

实现要点（对应判据 1–6，全部落点经 DSH 源码核实）：
1. **实时区**：`sessions.binding(childId).session` → uSES 订阅快照；`session.open()`
   拉尾页后活事件才落地（openState 门控）；运行/空闲读 `snap.running`，最新流式行
   从 `chat.legacy.partial.blocks` 逆序取最后一条 text/reasoning/tool-call。
   绑定即 `configureSubagent({parentSessionId,childSessionId,mode})`（mode 取自
   setSubagentCatalogOpen+refreshSubagents 的目录 entry，发现#21 同款前置），
   使 prompt/history 自动路由 subagents.*。
2. **token/上下文**：`session.projections.faceOf("tokenUsage"|"contextPressure")`，
   face 为 identity-stable uSES face；投影推送不要求 open（manager 无条件落 store）。
   tokenUsage 视图=四类桶合计；contextPressure 用 projectedTokens/contextWindow 百分比。
3. **模型**：`connection.api.sessions.models({sessionId})`，面板挂载时拉取 + 30s 轮询。
4. **直达指令**：`session.prompt([{type:"text"}], "queue"|"steer")`；continuable 自动路由
   subagents.prompt。多模态降级为常驻明示文案 + 错误回显（SUBAGENT_IMAGE_UNSUPPORTED），
   one-shot 显示只读提示。
5. **最近记录**：抽屉/详情面板内「查看最近会话记录」→ `api.subagents.history`
   （无父会话时退化 `api.sessions.history`），渲染最近 12 条。
6. inject 升级为 `["slots", "sessions", "connection"]`；facade 对非函数属性直通，
   `ctx.connection.api` 可用（dsh-cordis-client-runner/lib/client.js guardedService 核实）。

UI 落点（经 review 两轮调整）：目标卡/上下文子卡内嵌 LiveStrip（原位：状态行/摘要之下；
摘要行 = 状态 + token/ctx 合一行，下接最新流式行）；直达指令 PromptBox 只在
CardDrawer 与 GoalModal 的 SessionPanel 内（卡片上不放）。

Review 记录（均已记 goal.amended）：
- 一轮（2026-08-21）：①卡片上去掉指令框；②状态与 token 统计合并一行；
  ③实时区上移+可折叠——执行时误读到卡片实时条上。
- 二轮（2026-08-21 澄清）：③实际指详情弹窗的「📡 会话实时」面板——已挪到弹窗上部
  （标题与状态摘要下方）；卡片实时条恢复原位（仅保留一行合并）。弹窗标题下新增
  1-2 行目标要素：状态/泳道/归属版本/评审方式 + 等待依赖/阻塞原因/状态摘要。
- 三轮（2026-08-21）：弹窗上部的「📡 会话实时」默认折叠、点击标题行展开
  （折叠时不拉模型 RPC）；抽屉内面板保持展开。
- 四轮（2026-08-21）：抽屉内面板同样默认折叠可展开；面板标题统一改名「📡 实时会话」。
- 五轮（2026-08-21）：「📡 实时会话」标题行右侧加「↗ 打开会话」跳转按钮；所有会话跳转
  （卡片/抽屉/弹窗共用 openChildSession）后自动切回「对话」tab——tab 选中态存于
  ui-conversation 的 per-session chatStore、无跨插件 API，采用双 rAF 后点击首 tab
  （chat = conversation.view order 0 固定首 tab）的 DOM 方式，单视图无 tab 栏时不动。
五轮调整后 check_g107.sh、四个回归脚本与离线冒烟均全绿。

验证：
- `scripts/check_g107.sh` 全绿（冻结脚本，未改）；
- check_kanban/check_cards/check_plugin/check_core 回归全 PASS；
- 离线冒烟：mock __ModuleLoader__+React 加载模块，inject 与看板 slot 注册正常；
- 判据 7 的浏览器逐条实测待负责人执行（需刷新页面/重载插件后看板生效）。

已知边界：
- 会话不在客户端列表时（如宿主重启后子代理会话未回列）实时条显示「未接入」，
  列表刷新后自动接入；
- 目录未收录的子代理跳过地址配置，prompt 走 session.prompt 默认路由，失败会明示。

## Review 记录

<!-- 受管小节 -->
