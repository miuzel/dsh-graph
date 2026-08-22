---
{
  "id": "g-110",
  "title": "目标卡片操作：暂缓（移回 backlog）、与现有目标合并、删除",
  "status": "draft",
  "blocked_reason": null,
  "created_at": "2026-08-21T12:36:22+08:00",
  "created_by": "supervisor:k3",
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
  "skill_refs": []
}
---

## 目标描述

（待填写）

负责人需求原话：目标卡片可以选择暂缓、与现有目标合并或删除操作；本目标进 backlog 排队。

实现要点：
- **暂缓**＝排期移动回 backlog（复用现有 moveGoal，卡片从版本泳道退回 backlog 泳道，记 goal.moved）；
- **删除**：需新增引擎 op deleteGoal——删文件 + 记 goal.deleted 事件（有先例：g-f8317edc 手工删除漏事件；replay 须容忍 deleted 终态）；
- **合并**（A 并入 B）：需新增引擎 op mergeGoal——A 的描述/判据/依赖以修订形式追加进 B（记 B 的 goal.amended，note 注明来源 A），A 记 goal.deleted（details.merged_into=B）后删除；卡片/attempts 附件随删除清理；
- UI：目标卡片（或弹窗）加操作菜单——暂缓/合并/删除，走 host 写端点（事件先行）；合并需选择目标目标（下拉/搜索现有目标）；删除需二次确认；
- 依赖：与 g-109 同改看板 UI，排期时注意文件冲突（串行）。

## 补充 2（负责人 2026-08-22 v0.5 GUI 细化）

1. **卡片删除/归档**：不仅 core 需要删除、归档功能，**卡片上也要删除/归档按钮**——删除操作的 GUI 应**二次确认防误删，要求输入卡片 id**（防止手滑删错）；
2. **添加卡片入口 + 弹窗**：GUI 增加添加卡片的入口和弹窗（现 add-card 按名字添加、kind 固定 text；需弹窗可选择 kind=text/file/image/data、填标题）。



## 补充（负责人 2026-08-22 v0.5 规划）

v0.5 GUI 功能范围确认：本目标（g-110）扩展纳入**上下文卡片的新增、删除**：
- 上下文卡片新增：现有 add-card 端点 + GUI 抽屉已具备（g-109），核对完整性即可；
- 上下文卡片删除：core 无 deleteCard——需新增引擎 op（删卡片文件 + 从 goal context_cards 移除引用 + 记 card.deleted 事件，事件先行 R-02）；
- 与目标删除（deleteGoal）同批实现（共用「删除 + 事件」模式）。



## 质量判据

1. core 新增引擎 op：deleteGoal（删文件+记 goal.deleted）、deleteCard（删卡片文件+context_cards 移除引用+记 card.deleted）、mergeGoal（A 并入 B，A 记 deleted/merged_into）——事件先行 R-02
2. GUI 目标卡片操作菜单：暂缓（moveGoal 回 backlog）/合并（选目标目标）/删除——删除需二次确认且要求输入目标 id 防误删
3. GUI 上下文卡片删除/归档按钮：删除需二次确认且要求输入卡片 id（负责人 2026-08-22 明确）
4. GUI 添加卡片入口+弹窗：可填标题、选择 kind=text/file/image/data（现 add-card 仅按名字+固定 text）
5. 全量测试与冻结脚本 PASS，graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
