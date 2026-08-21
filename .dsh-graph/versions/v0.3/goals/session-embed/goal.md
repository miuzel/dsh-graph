---
{
  "id": "g-107",
  "title": "卡片会话内嵌：实时状态与看板直达指令",
  "status": "delivered",
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

1. 绑定 child_id 的卡片内嵌实时区：子代理运行/空闲状态 + 最新一行流式输出（session.open() + chat.legacy.partial）
2. token 用量 + 上下文窗口占用（投影 faceOf tokenUsage/contextPressure，无需 open，看板常驻）
3. 当前模型名显示（api.sessions.models）
4. 看板直达指令：卡片内向 continuable 子代理发文本（session.prompt，queue/steer）；多模态降级：子代理图片源码级不支持（SUBAGENT_IMAGE_UNSUPPORTED），前端必须明确提示而非静默失败
5. 查看最近会话记录（chat.nodes 或 api.subagents.history）
6. client inject 升级为 [slots, sessions, connection]
7. [script] scripts/check_g107.sh 全绿；另由负责人浏览器逐条人工实测

## 证据台账
| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|
