---
{
  "id": "g-109",
  "title": "看板可写交互：目标描述编辑与人工反馈、上下文卡片添加、抽屉收集提示词可编辑",
  "status": "delivered",
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
    },
    {
      "goal": "g-108",
      "consumes": [
        "顶部状态栏布局落定（串行改 client.js）"
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
  "rules_snapshot": "r-2026-08-3",
  "skill_refs": []
}
---

## 目标描述

让看板成为可写工作台，把「确认/反馈/收集」这些 gate 直接做在看板卡片弹窗里，不再依赖线性对话翻找待决项（负责人动机）。

交付三块：
1. **目标描述区可写**：「✅ 接受」+「💬 反馈」。接受默认经主管 Agent 异步复核——无异议生效、有异议显示在按钮处并转「强制接受」（可填理由记事件供 Agent 学习）；反馈＝追加式修订。接受生效映射：描述阶段→description.confirmed、判据待确认→criteria.confirmed(actor=human)、review→review.passed+delivered。
2. **信息收集区可新增卡片**：直接命名（空占位）／通过对话（建卡即准备派发收集子代理）。
3. **抽屉收集提示词可编辑**：未填充卡片自动生成提示词草稿（卡片标题+目标上下文模板）、textarea 可编辑，「开始收集」派发子代理并绑定卡片（child_id/parent_session_id，↗ 可跳）。

实现约束：
- 全部写操作走 host 端点（/api/dsh-graph 写路由），事件先行，前端绝不直改文件；
- 直接改文本＝替换「目标描述」小节 + 记 goal.amended；人工反馈＝追加式修订；
- 与 backlog g-106（graph_collect_card 工具）分工：本目标是 UI 半边，g-106 工具落地后切换复用。

主管复核实现（负责人定案）：点击接受→写 review.requested 事件→主管经 graph_resolve_accept 裁决（accept 按阶段写确认事件／object 写 review.objected 异议）→前端轮询 goal 详情显示生效或异议+强制接受。当前为事件驱动（主管轮询 review.requested），非 push 通知；push 待 DSH 暴露向任意会话发消息的接口后补。

## 质量判据

1. 弹窗目标描述区：「接受」+「反馈」输入框；接受默认经主管 Agent 复核——无异议生效，有异议显示在按钮处并转「强制接受」（可选理由记事件供学习）；生效映射：描述→description.confirmed、判据→criteria.confirmed(actor=human)、review→review.passed+delivered；反馈=追加式修订
2. 弹窗信息收集区可新增上下文卡片：直接命名（空占位）／通过对话（建卡即准备派发收集）
3. 抽屉对未填充卡片自动生成收集提示词草稿（卡片标题+目标上下文模板）、textarea 可编辑，「开始收集」派发子代理并绑定卡片（↗ 可跳）
4. 全部写操作走新增 host 端点（事件先行），前端无直改文件路径
5. [script] scripts/check_g109.sh 全绿 + 负责人浏览器人工实测

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
