---
{
  "id": "g-128",
  "title": "GUI 卡片管理：上下文卡片新增/删除/归档/split + 添加弹窗（kind 可选）",
  "status": "draft",
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

1. **core 引擎 op**：`deleteCard`（删卡片文件 + context_cards 移除引用 + 记 card.deleted，事件先行 R-02）；`splitCard`（卡片拆分成多张——内容按指定边界拆为两张新卡，原卡记 split 事件，待确认细节）；
2. **GUI 卡片删除/归档按钮**：删除需二次确认且**要求输入卡片 id** 防误删（负责人 2026-08-22 明确）；
3. **GUI 添加卡片入口 + 弹窗**：可填标题、选择 kind=text/file/image/data（现 add-card 仅按名字+固定 text）；
4. **卡片 split 功能**（负责人 2026-08-22 补充）。

## splitCard 细节待确认（负责人 2026-08-22 提到）

卡片 split（拆分）功能细节需与负责人确认：
- 拆分边界怎么指定（按段落/行/手动选择）？
- 拆分后原卡状态（保留+标记 split？还是删除替换为两张新卡？）
- 是否同时拆 context_cards 引用与收集子代理绑定？
实现前先确认，避免返工。



## 质量判据

1. core 新增 deleteCard 引擎 op：删卡片文件 + context_cards 移除引用 + 记 card.deleted 事件（事件先行 R-02）
2. core 新增 splitCard 引擎 op（待确认细节）：卡片按边界拆成两张新卡 + 记 card.split 事件
3. GUI 上下文卡片删除/归档按钮：删除需二次确认且要求输入卡片 id 防误删（负责人 2026-08-22 明确）
4. GUI 添加卡片入口+弹窗：可填标题、选择 kind=text/file/image/data（现 add-card 仅按名字+固定 text）
5. GUI 卡片 split 功能：卡片抽屉提供拆分操作（待确认 UI）
6. 全量测试与冻结脚本 PASS，graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
