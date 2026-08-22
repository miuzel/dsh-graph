---
{
  "id": "g-77647351",
  "title": "看板卡片拖放交互（泳道内排序、跨列拖动触发状态迁移）",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-21T11:20:02+08:00",
  "created_by": "agent:session-b00ed183-bc6c-4f66-b07e-e5d909c1f46b",
  "version": "v0.5",
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
    "card-f0ec7190"
  ]
}
---

## 目标描述

v0.5 看板卡片拖放交互（负责人 2026-08-22 排期）：泳道内拖动排序、跨列拖动触发状态迁移。

实现方案（调研卡 card-f0ec7190 已定）：
1. 技术路线：HTML5 原生 DnD（照抄 dsh-client-ui-workspace 拖拽状态机：rowHalf 落点/提交防重/document 兜底/order 对账）；
2. 前置缺口：新增 POST /api/dsh-graph/transition 端点（参照 /accept，GraphError 返 400）+ .dsh-graph/order.json 排序持久化（GET/POST order 端点）；
3. 跨列拖动→graph_transition 映射：列 key↔状态枚举（STAGES）；blocked 只能回 blocked_from、delivered 终态需确认、in_progress 门槛服务端报错兜底、planning→collect 二义默认 collecting；
4. 落点：卡片 clientY 半区 before/after、列空白区/列头定列尾/列首；同列重排照抄 commitSessionDrag。

## 拖放交互约束（负责人 2026-08-22 补充）

跨列拖动需检查状态机约束，人工拖动视为授权（拖动即人工意图）：

1. **进执行列（in_progress）**：若无子代理 → **视同点击了「执行」**（触发 start-execution 派发执行子代理）；
2. **从后方状态往前方状态拖动**（如 delivered/confirm → 执行/收集等，即回退方向）：**询问用户理由**——理由作为消息：有子代理 → 作为子代理消息补充给子代理（send_message 语义）；无子代理 → 补充给主管（supervisor 收到理由）；
3. 仍受状态机 EDGES 约束（blocked 只能回 blocked_from、delivered 终态等），拖动非法时服务端报错兜底。



## 质量判据

1. 新增 POST /api/dsh-graph/transition 端点：{goal, to, reason?}，调 core transition，GraphError 返 400（参照 /accept 模式，actor human:gui）
2. 看板泳道内拖动排序：HTML5 原生 DnD（draggable + onDragStart/onDragOver/onDrop/onDragEnd），落点 rowHalf 半区判定，同列重排不触发 transition
3. 跨列拖动触发状态迁移：列 key↔状态枚举映射（STAGES）；blocked 只能回 blocked_from（需 reason）、delivered 终态需确认、in_progress 门槛服务端报错兜底、planning→collect 二义默认 collecting；人工拖动视为授权（负责人 2026-08-22）
4. 进执行列（in_progress）时若无子代理 → 视同点击「执行」触发 start-execution 派发（负责人 2026-08-22）；从后方状态往前方状态拖动时询问用户理由：有子代理作为子代理消息补充（send_message），无子代理补充给主管（负责人 2026-08-22）
5. 排序持久化：.dsh-graph/order.json（v-slug|standalone|backlog × 列 → goalId[]）+ GET/POST order 端点，workspace reconciledSessionOrder 对账模式
6. 全量测试与冻结脚本 PASS，graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
