---
{
  "id": "g-129",
  "title": "GUI 建目标入口 + goal.md 文件链接（create-goal 端点 + 打开链接编辑器编辑）",
  "status": "review",
  "blocked_reason": null,
  "created_at": "2026-08-22T16:32:50+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.5",
  "scope": [
    "core",
    "dsh-graph-host"
  ],
  "depends_on": [
    {
      "goal": "g-109",
      "consumes": [
        "看板 UI 同区（新建目标按钮/弹窗）"
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
    "card-cc069a44"
  ],
  "blocked_from": null
}
---

## 目标描述

v0.5 GUI 建目标 + 文件链接（从 g-110 拆出，负责人 2026-08-22 拆分指示）：

1. **GUI 直接创建目标（goal）**：host 新增 `/api/dsh-graph/create-goal` 端点（POST title/version/scope，调 core createGoal，事件先行 goal.created）+ 看板主界面「新建目标」按钮/弹窗——现建 goal 只能跟主管聊天（graph_create_goal 工具无 GUI/端点）；
2. **goal.md 文件链接**：core goalDetail 暴露 goal.md 路径；GUI 目标详情/卡片抽屉提供「打开 goal.md」链接（可复制路径 + 打开动作），用户可用编辑器自由编辑。



## 质量判据

1. host 新增 /api/dsh-graph/create-goal 端点：POST title/version/scope，调 core createGoal，事件先行 goal.created
2. GUI 看板主界面「新建目标」入口 + 弹窗（填标题、可选 version/scope）
3. core goalDetail 暴露 goal.md 路径（相对 workspace 或绝对）
4. GUI 目标详情/卡片抽屉提供「打开 goal.md」链接：可复制路径 + 打开动作（用户可用编辑器自由编辑）
5. 全量测试与冻结脚本 PASS，graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
