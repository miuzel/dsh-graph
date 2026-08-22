---
{
  "id": "g-128",
  "title": "GUI 卡片管理：上下文卡片新增/删除/归档 + 添加弹窗（kind 可选）",
  "status": "planning",
  "blocked_reason": null,
  "created_at": "2026-08-22T16:32:47+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.5",
  "scope": [
    "core",
    "dsh-graph-host"
  ],
  "depends_on": [
    {
      "goal": "g-110",
      "consumes": [
        "deleteGoal 的删除+事件模式（deleteCard 复用）"
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

v0.5 GUI 卡片管理（从 g-110 拆出，负责人 2026-08-22 拆分指示）：

1. **core 引擎 op**：`deleteCard`（删卡片文件 + context_cards 移除引用 + 记 card.deleted，事件先行 R-02）；
2. **GUI 卡片删除/归档按钮**：删除需二次确认且**要求输入卡片 id** 防误删（负责人 2026-08-22 明确）；
3. **GUI 添加卡片入口 + 弹窗**：可填标题、选择 kind=text/file/image/data（现 add-card 仅按名字+固定 text）；

## split 暂缓（负责人 2026-08-22 定）

卡片 split（拆分）功能**暂缓**——拆分场景不常见，由主管智能体按需处理（supervisor 可用现有工具拆卡/建新卡），不做 GUI split 功能。g-128 范围收窄为：卡片新增/删除/归档 + 添加弹窗（kind 可选）+ 删除二次确认。



## 质量判据

1. core 新增 deleteCard 引擎 op：删卡片文件 + context_cards 移除引用 + 记 card.deleted 事件（事件先行 R-02）
2. GUI 上下文卡片删除/归档按钮：删除需二次确认且要求输入卡片 id 防误删（负责人 2026-08-22 明确）
3. GUI 添加卡片入口+弹窗：可填标题、选择 kind=text/file/image/data（现 add-card 仅按名字+固定 text）
4. 卡片 split 暂缓（负责人 2026-08-22 定：不常见，交主管智能体按需处理）——不在本目标范围
5. 全量测试与冻结脚本 PASS，graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
