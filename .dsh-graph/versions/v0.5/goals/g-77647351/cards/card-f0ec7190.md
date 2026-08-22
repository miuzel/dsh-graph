---
{
  "id": "card-f0ec7190",
  "goal": "g-77647351",
  "title": "调研：看板卡片拖放实现方案（HTML5 DnD / pointer 事件 / 现有组件）",
  "kind": "text",
  "status": "reviewed",
  "filled_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "filled_at": "2026-08-22T16:53:44+08:00",
  "content_ref": null,
  "summary": "拖放方案：HTML5 原生 DnD（推荐，零依赖），照抄 dsh-client-ui-workspace 的 SessionTree 拖拽状态机（rowHalf 落点/提交防重/document 兜底/order 对账）。两个前置缺口：①后端无 /api/dsh-graph/transition 端点（需新增，参照 /accept、错误 400）；②无排序持久化（需 order.json + GET/POST order 端点）。跨列拖动→graph_transition 映射：列 key↔状态已存在，blocked 只能回 blocked_from、delivered 终态、in_progress 有门槛需服务端报错、planning→collect 二义默认 collecting。",
  "child_id": "492b3b32-d471-4619-beda-dcbd99e73b6f",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

# 看板卡片拖放实现方案调研（g-77647351）

## 结论摘要
- DSH 有现成参考：dsh-client-ui-workspace（HTML5 原生 DnD 行重排，含拖拽状态机/插入点 marker/文档兜底/order 对账）——可照抄到 dsh-graph client.js；
- 技术路线：**HTML5 原生 DnD**（draggable + onDragStart/onDragOver/onDrop），零依赖、有仓库内权威参考；pointer 方案需自研拖影/命中/滚动，仅 layout resize 有先例；
- 两个前置缺口：①无 /api/dsh-graph/transition 端点（需新增）；②无排序持久化（需 order.json + 端点）。

## 现有拖放参考
- dsh-client-ui-workspace/lib/client.js：SessionNodeItem（draggable + 4 handler）、rowHalf 落点（clientY 半区）、SessionTree 拖拽状态机（drag state + dropCommitted ref 防双提交）、commitSessionDrag 提交算法、useNativeDragAcceptance 文档级兜底、reconciledSessionOrder 对账；
- dsh-client-ui-attachment：文件拖放（document 级监听）；
- dsh-client-ui-layout：pointer DragHandle（仅 resize，不适用列表）。

## 方案对比
| 维度 | HTML5 DnD（推荐） | pointer 自研 |
|---|---|---|
| 参考 | workspace 行重排可整段照抄 | 无列表先例 |
| 代码量 | ~60 行状态机 + 每元素 4 handler | ~300+ 行自研 |
| 触摸 | 不支持（桌面 GUI 可接受） | 支持 |
| 坑 | dragover 需 preventDefault、document 兜底、dragend 兜底 | 全要自踩 |

## 看板现状
- STAGES 列定义（:10-17）+ stageOf 反向映射已存在——列 key↔状态枚举直接复用；
- KanbanView lane 渲染（:1625-1739），S.cell 是列级 drop 目标、.dg-card 是卡片级目标；
- Card 根 div（:836-848）直接加 draggable + handler 即可，key 稳定 g.id；
- HOVER_CSS 字符串追加新类（.dg-dragging/.dg-drop-before/after）零构建；
- 无任何现有拖放代码；
- 状态机 EDGES + 门槛（blocked 需 reason、in_progress 需 rules_snapshot+判据+criteria.confirmed）；
- board 载荷不含 criteria 状态——客户端无法预校验 in_progress 门槛，靠服务端报错兜底；
- API 无 transition/order 端点。

## 推荐实现路线
1. 新增 POST /api/dsh-graph/transition {goal,to,reason?}——参照 /accept，GraphError 返 400（现 /accept 返 500 不要照抄）；
2. KanbanView 加拖拽状态 {goalId, fromStatus} + dropCommitted ref + document 级兜底；
3. 卡片级/列级 drop 目标，rowHalf 落点计算（同列=重排，跨列=transition）；
4. 跨列映射：from=blocked→仅 blocked_from；candidates=列 statuses∩EDGES[from]（单→取一；零→拒绝；planning→collect 二义默认 collecting）；to=blocked 弹 reason 输入；to=delivered 需 confirm；to=in_progress 不预校验直接调端点；
5. 排序持久化：.dsh-graph/order.json（v-slug|standalone|backlog × 列 → goalId[]），GET/POST order 端点，workspace 对账模式；
6. 同列重排 commit 照抄 commitSessionDrag。

## 风险
无 transition 端点（新增低风险）、in_progress 门槛客户端不可知（服务端报错兜底）、order 对账与轮询并发（低概率）、blocked/delivered 需交互确认、planning→collect 二义、HTML5 DnD 固有坑、collect 列 collecting→ready 同列无法拖动表达（保持工具做）、released 泳道只读。

## 读过文件
dsh-client-ui-workspace/lib/client.js（拖拽状态机全段）、dsh-client-ui-attachment/lib/client.js、dsh-client-ui-layout/lib/client.js、dsh-graph-host/lib/client.js（STAGES/Card/KanbanView）、core/machine.js（全文）、core/ops.js（transition/boardProjection）、dsh-graph-host/index.js（API 路由）。
