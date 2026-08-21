---
{
  "id": "g-107",
  "title": "卡片会话内嵌：实时状态与看板直达指令",
  "status": "ready",
  "blocked_reason": null,
  "created_at": "2026-08-21T00:50:00+08:00",
  "created_by": "human:负责人",
  "version": "v0.3",
  "scope": [
    "dsh-graph-client/",
    "dsh-graph-host/",
    "core/"
  ],
  "depends_on": [
    {
      "goal": "g-102",
      "consumes": [
        "看板视图"
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
  "skill_refs": [],
  "context_cards": [
    "card-e453207d"
  ]
}
---

## 目标描述
（负责人 2026-08-21 直接指示）
1. 目标卡片、上下文卡片内可直接查看对应会话/子代理会话的最新记录；
2. 看板视图内直接添加文本与多模态指令（发送到对应会话）；
3. 卡片实时显示：会话运行中 Agent 更新的当前状态、流式输出的最新一行、
   token 使用情况、上下文窗口、模型等基本信息。

复用 DSH 客户端会话机制（Session 对象/投影/RPC），不自建轮询外的数据通道。

## 质量判据
（待 planning 登记）

## 证据台账
| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|
