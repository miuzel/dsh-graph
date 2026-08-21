---
{
  "id": "g-109",
  "title": "看板可写交互：目标描述编辑与人工反馈、上下文卡片添加、抽屉收集提示词可编辑",
  "status": "planning",
  "blocked_reason": null,
  "created_at": "2026-08-21T12:33:41+08:00",
  "created_by": "supervisor:k3",
  "version": "v0.3",
  "scope": [],
  "depends_on": [
    {
      "goal": "g-107",
      "consumes": [
        "看板弹窗/抽屉结构与 client.js（避免并行改同一文件）"
      ]
    }
  ],
  "review": {
    "reviewer": "human",
    "prompt": null
  },
  "pk": {
    "lanes": 1,
    "sandbox": "directory"
  },
  "rules_snapshot": null,
  "skill_refs": []
}
---

## 目标描述

（待填写）

负责人需求原话：
1. 目标卡片弹窗的目标描述部分：可直接提交人工反馈，或直接修改目标文本；
2. 弹窗的上下文卡片部分：允许用户添加新上下文卡片——通过对话（建卡即准备派发收集子代理）或直接命名（空占位）两种方式；
3. 上下文卡片抽屉：自动生成信息收集提示词，允许用户在开始执行（派发收集）前修改。

实现要点：
- 全部写操作走 host 端点（新增 /api/dsh-graph 写路由：amend-goal / edit-description / add-card / start-collection），事件先行，绝不前端直改文件；
- 直接改文本＝替换 goal.md「目标描述」小节 + 记 goal.amended（note 注明"直接编辑"）；人工反馈＝graph_amend_goal 追加式（原机制）；
- 抽屉提示词模板由卡片标题+目标上下文自动生成，渲染为可编辑 textarea，「开始收集」时派发子代理并绑定卡片（child_id/parent_session_id，看板 ↗ 可跳）；
- 与 backlog g-106（收集项任务化 graph_collect_card 工具）关系：本目标是 UI 半边；g-106 工具落地后切换到它，不重复造派发逻辑。

负责人补充需求（动机：不再依赖线性对话确认待决项，gate 在看板上直接行使）：
目标卡片弹窗的目标描述部分直接提供「✅ 接受」按钮 + 带文字输入框的「💬 反馈」功能。

语义提案（待负责人确认）：「接受」按当前阶段映射为确认事件——
- 描述阶段（draft/planning）：确认描述，记 description.confirmed 事件，可推进下一阶段；
- 判据已登记待确认（ready 前）：确认判据，记 criteria.confirmed（actor=human）；
- review 阶段：接受＝评审通过，记 review.passed 并 →delivered；
「反馈」＝graph_amend_goal 追加式修订（原有机制）。


## 质量判据

（待登记；进入 in_progress 前必须非空且已确认）

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
