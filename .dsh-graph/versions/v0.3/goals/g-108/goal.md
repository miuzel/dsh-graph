---
{
  "id": "g-108",
  "title": "看板顶部 supervisor 会话状态栏：复用实时控件+一键跳转主管对话",
  "status": "in_progress",
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
  "rules_snapshot": "r-2026-08-3",
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

执行中范围补充（负责人指示，发现#23 从 g-a92e1406 移入）：依赖徽章按状态显示——未交付依赖显示「⛓ 等待 X 交付」（琥珀）；已交付依赖显示「✅ 依赖满足：g-107 已交付」（绿色/中性），不再一概只按 depends_on 非空显示等待。


## 质量判据

1. 看板顶部固定 supervisor 状态栏：复用 LiveStrip 控件（运行/空闲、最新流式行、tok/ctx、模型名）
2. 一键跳转主管对话窗（sessions.open + 复用 activateChatTab 切对话 tab；已在该会话看板 tab 时切回对话）
3. supervisor 会话 id 记入 project.yaml（supervisor.session），host board 端点以下发字段 supervisorSession 提供给 client，代码不硬编码会话 id
4. [script] scripts/check_g108.sh 全绿 + 负责人浏览器人工实测
5. 依赖徽章状态化（发现#23）：未交付依赖显示「⛓ 等待 X 交付」，已交付依赖显示「✅ 依赖满足：X 已交付」，不再只看 depends_on 非空

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
