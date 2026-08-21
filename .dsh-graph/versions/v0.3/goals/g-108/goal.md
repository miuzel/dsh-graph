---
{
  "id": "g-108",
  "title": "看板顶部 supervisor 会话状态栏：复用实时控件+一键跳转主管对话",
  "status": "planning",
  "blocked_reason": null,
  "created_at": "2026-08-21T12:32:14+08:00",
  "created_by": "supervisor:k3",
  "version": "v0.3",
  "scope": [],
  "depends_on": [
    {
      "goal": "g-107",
      "consumes": [
        "看板卡片实时控件 LiveStrip 与 client.js 结构（避免并行改同一文件）"
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

负责人需求原话：在看板顶部显示 supervisor agent 会话的状态信息，复用卡片内的智能体状态控件（LiveStrip），可一键跳转到 supervisor agent 的对话窗。

实现要点：
- supervisor 会话 id 不能硬编码——记入图数据层（project.yaml 的 supervisor_session 字段），board 端点下发；主管 Agent 会话启动/绑定时候更新该字段；
- 顶部状态条复用 LiveStrip（运行/空闲、最新流式行、tok/ctx、模型）；supervisor 是顶层会话，直接 sessions.binding(id)，无 parent；
- 跳转 = sessions.open(id) + 切对话 tab（复用 openChildSession 的 activateChatTab 逻辑；若用户已在该会话的看板 tab，跳转即切回对话 tab）；
- 跳转目标就是主管会话本身（当前为 session-b00ed183）。


## 质量判据

（待登记；进入 in_progress 前必须非空且已确认）

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
