---
{
  "id": "card-b26ad014",
  "goal": "g-134",
  "title": "版本元数据、事件流与看板投影现状",
  "kind": "text",
  "status": "reviewed",
  "filled_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "filled_at": "2026-08-23T05:09:55+08:00",
  "content_ref": null,
  "summary": "版本由 version.md + 事件流投影；创建/重命名/删除与发布 guard 是当前缺口。",
  "child_id": "6014a227-f00a-471c-8b14-15b1063fcb65",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

## 收集结论

### 版本元数据与目录

- 版本元数据位于 `.dsh-graph/versions/<slug>/version.md`，frontmatter 包含 `id`、`name`、`status`、`created_at`；目标在 `goals/`，归档目标在 `archived/`。
- `createGoal(..., { version })` 会在版本不存在时隐式创建 `version.md`，初始 `status: planning`，并记录 `version.created`。
- 当前已核对的版本状态：v0.1–v0.5 均为 `released`，v0.6 为 `planning`。`active` 可作为历史/模型中的版本状态使用，但不是当前 v0.4 的状态。

### 事件与投影

- 已有相关事件：`version.created`、`version.released` 与目标归属变更 `goal.moved`。
- `core/ops.ts` 的 `BoardVersion` / `boardProjection()` 扫描版本目录，读取 `version.md` 并汇集 `goals/`、`archived/` 生成看板泳道投影。
- 历史版本迁移已验证 `goal.moved` 与 `version.released` 可共同形成可追溯记录。

### g-134 实现缺口

1. 没有脱离 `create-goal --version` 的显式版本创建操作；
2. 没有 `version.renamed` / `version.deleted` 事件及对应的目录、目标 `version` 引用安全迁移；
3. 没有“仅空版本可删除”的统一安全检查；
4. 发布前全目标 `delivered` 校验属于 g-135，需与 g-134 的版本元数据和看板入口衔接。

### 关键位置

- `.dsh-graph/versions/<version>/version.md`
- `.dsh-graph/events.jsonl`
- `core/ops.ts`（`createGoal`、`moveGoal`、`BoardVersion`、`boardProjection`）

上述内容可直接作为 g-134 设计与收集阶段的基线。
