---
{
  "id": "g-130",
  "title": "goal.md 格式约束：graph_amend_goal 工具内剥离标题 + append 规范化（防重复小节）",
  "status": "draft",
  "blocked_reason": null,
  "created_at": "2026-08-22T16:36:30+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.5",
  "scope": [
    "core",
    "dsh-graph-host"
  ],
  "depends_on": [
    {
      "goal": "g-125",
      "consumes": [
        "goa.md 描述结构规范（防重复小节）"
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
    "card-ee78c929"
  ]
}
---

## 目标描述

v0.5（负责人 2026-08-22 提出，方案转向后）：**goal.md 格式约束**——不搞文件监听，
直接在 `graph_amend_goal` 工具内实现格式约束（工具写盘是统一入口，比监听可靠简单）：

1. **amendGoal 剥离 appendDescription 的 Markdown 标题**（/^##?\s/ 开头则剥离，保留正文）——根治 g-119/120/124/125/128/129 连环「重复小节」坑；
2. **append 规范化**：写盘后 body 满足单「## 目标描述」小节、无占位残留；appendDescription 为空或仅标题时行为明确（告警或忽略）；
3. 用户用编辑器手改 goal.md 的格式问题仍由 `graph_validate` 兜底（g-129 文件链接配套说明「建议用工具改，手改后跑 validate」）。

## 质量判据

1. amendGoal 剥离 appendDescription 中的 Markdown 标题（/^##?\s/ 开头则剥离，保留正文）——根治重复小节坑（g-119/120/124/125/128/129）
2. append 规范化：写入后 body 仍满足单「## 目标描述」小节、无占位残留；appendDescription 为空或仅标题时行为明确（告警或忽略）
3. 用户手改 goal.md 的格式问题仍由 graph_validate 兜底（g-129 文件链接配套说明）
4. 单测覆盖：append 带头标题被剥离、正常正文不受影响、重复小节不产生；全量测试与冻结脚本 PASS
5. graph_validate 无问题

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
