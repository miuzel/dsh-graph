---
{
  "id": "g-147",
  "title": "版本归属迁移保留生命周期状态",
  "status": "delivered",
  "blocked_reason": null,
  "created_at": "2026-08-23T17:53:11+08:00",
  "created_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "version": "v0.5",
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


修复 `moveGoal` 的归属迁移规则。

- **backlog → standalone/version**：仍按既有约定把目标从描述 lane 进入 `planning`。
- **standalone ↔ version**：仅改变目录归属和 `version` 元数据，必须保留当前生命周期状态（包括 `collecting`、`ready`、`in_progress`、`review`、`delivered`、`blocked`）。
- **version/standalone → backlog**：保持既有返回 backlog 时进入 `draft` 的语义，除非负责人另行调整。

本修复必须防止 g-145 这类已 `delivered` 的独立目标移入 v0.5 后被错误降级到 `planning`。作为 v0.5 热修复，与 g-145 一同纳入 0.5.2 发布。


## 质量判据

1. `backlog → standalone` 与 `backlog → version` 仍将目标置为 `planning`，并维持既有事件/目录行为。
2. `standalone ↔ version` 迁移只改变位置与 `version` 元数据；对 `collecting`、`ready`、`in_progress`、`review`、`delivered`、`blocked` 等状态均逐一保留，特别覆盖 delivered 的 g-145 型场景。
3. `version/standalone → backlog` 保持现有进入 `draft` 的语义，且带 cards/attempts 的非法平铺迁移仍被拒绝。
4. 每次合法归属迁移仅追加 `goal.moved`；除 backlog 语义转换外不得伪造或追加生命周期 `goal.transition` 事件。
5. 新增核心层回归测试覆盖 backlog/standalone/version 三类方向、各关键状态保留和事件序列；`node --test core/tests/*.test.ts` 全量通过。
6. 修复已提交并与 g-145 一同纳入 v0.5.2 发布记录。

## 证据台账

| id | 内容 | 来源 | 时间 | freshness |
|----|------|------|------|-----------|

## 处置分支

（使用项目默认）

## 依赖我的下游

（暂无）
