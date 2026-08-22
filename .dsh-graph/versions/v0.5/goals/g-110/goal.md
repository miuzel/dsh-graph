---
{
  "id": "g-110",
  "title": "目标卡片归档（草稿/规划中/已交付可归档，看板右上角显示开关，回到原泳道带已归档标记，可取消归档）",
  "status": "review",
  "blocked_reason": null,
  "created_at": "2026-08-21T12:36:22+08:00",
  "created_by": "supervisor:k3",
  "version": "v0.5",
  "scope": [],
  "depends_on": [
    {
      "goal": "g-109",
      "consumes": [
        "看板 UI 同区改造（目标卡片操作菜单）"
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

（原「暂缓／合并／删除」已拆分为独立目标 g-138 暂缓 / g-139 合并 / g-140 删除。本目标聚焦「卡片归档」。）

负责人需求（2026-08-23）：新增卡片归档功能。
- 仅「草稿 draft / 规划中 planning / 已交付 delivered」可归档；其它状态拒绝并提示；
- 默认不显示已归档卡片；看板右上角加「显示已归档」checkbox；
- 已归档可取消归档（恢复原位置、状态保持）；
- 实现：把 goal 实际移入对应 archived 目录——版本 goals→`versions/vX/archived/<id>/`、独立目标→`goals/archived/<id>/`、backlog→`backlog/archived/<id>.md`；已归档在勾选显示时回到原泳道、带「已归档」标记；
- 归档／取消归档走 graph 工具 + 事件流（R-02）。

实现要点：1) 新增 archiveGoal/unarchiveGoal op（move 到/移出 对应 archived 目录 + 记 goal.archived / goal.unarchived 事件，R-02）；2) boardProjection 默认不含 archived（隐藏），增加 includeArchived 选项（端点 ?includeArchived=1）时把 archived 目标也列入并打 archived:true 标记，回到原泳道；3) client 右上角「显示已归档」checkbox → 控制请求 includeArchived；4) 归档/取档约束状态（仅 draft/planning/delivered 可归档）；5) 存档目录路径见上。


## 补充 4（负责人 2026-08-22 v0.5 GUI 细化）

**goal.md 文件链接**：目标卡片/上下文卡片抽屉提供 goal.md 的文件链接，用户可直接用编辑器打开文件自由编辑：
- core goalDetail 暴露 goal.md 路径（相对 workspace 或绝对）；
- GUI 目标详情/卡片抽屉加「打开 goal.md」链接——点击触发打开方式（DSH 有 file-reference 服务但为 agent @ 语法；GUI 场景需评估：复制路径 / 调用系统编辑器 / web 内查看。实现时定，至少提供可复制路径 + 打开动作）。



## 补充 3（负责人 2026-08-22 v0.5 GUI 细化）

**GUI 直接创建目标（goal）入口 + 弹窗**：现 GUI 无建 goal 能力——「添加信息收集任务」只在目标详情内建卡片，无法发起新 goal；建 goal 只能跟主管聊天（graph_create_goal 工具）。需：
- host 新增 `/api/dsh-graph/create-goal` 端点（POST title/version/scope，调 core createGoal，事件先行 goal.created）；
- GUI 看板主界面加「新建目标」入口 + 弹窗（填标题、可选 version 排期、scope）。



## 补充 2（负责人 2026-08-22 v0.5 GUI 细化）

1. **卡片删除/归档**：不仅 core 需要删除、归档功能，**卡片上也要删除/归档按钮**——删除操作的 GUI 应**二次确认防误删，要求输入卡片 id**（防止手滑删错）；
2. **添加卡片入口 + 弹窗**：GUI 增加添加卡片的入口和弹窗（现 add-card 按名字添加、kind 固定 text；需弹窗可选择 kind=text/file/image/data、填标题）。



## 补充（负责人 2026-08-22 v0.5 规划）

v0.5 GUI 功能范围确认：本目标（g-110）扩展纳入**上下文卡片的新增、删除**：
- 上下文卡片新增：现有 add-card 端点 + GUI 抽屉已具备（g-109），核对完整性即可；
- 上下文卡片删除：core 无 deleteCard——需新增引擎 op（删卡片文件 + 从 goal context_cards 移除引用 + 记 card.deleted 事件，事件先行 R-02）；
- 与目标删除（deleteGoal）同批实现（共用「删除 + 事件」模式）。



## 质量判据

1. 归档：move 目标到其归属的 archived 子目录——版本 goals→versions/vX/archived/<id>/；standalone→goals/archived/<id>/；backlog→backlog/archived/<id>.md；board 默认不读 archived → 默认隐藏
2. 仅 draft / planning / delivered 可归档（其它状态拒绝并提示）
3. 看板右上角「显示已归档」checkbox：默认关（不显示）；勾选→把 archived 目标也列入看板**回到原泳道**、带「已归档」标记；取消勾选恢复隐藏
4. 已归档可取消归档（移回原位置 goals/backlog，状态保持原样）
5. 归档/取消归档走 graph 工具 + 事件流（R-02），不手改文件；boardProjection/工具需覆盖各 archived 目录并打 archived 标记
6. 改源 core/*.ts + sync-core；node --check；node --test core/tests/*.test.ts 全过；graph_validate 无问题；不破坏已交付功能

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
