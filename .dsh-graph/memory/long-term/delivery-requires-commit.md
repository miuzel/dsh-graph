---
id: delivery-requires-commit
title: 交付阶段改动必须已 git commit
source: g-77647351/g-131 交付（负责人 2026-08-22）
---

# 交付阶段改动必须已 git commit

**规则**：凡到 `delivered` 的目标，其改动（源码 / 文档 / `.dsh-graph` 对应目标文件）
**必须先 git commit**，supervisor 才能在 `review→delivered` 前确认代码已落库。

- 未 commit 不得 delivered——避免「状态 delivered 但代码没提交」的假交付。
- supervisor 在 `review→delivered` 前核对 `git status`，确认目标涉及改动已提交；有未提交则
  先提交/要求子代理提交，再标记 delivered。

## 背景（来源目标引用）

- g-77647351 / g-131 交付时，源码（`core/machine.ts` force/collecting、`core/model.ts`
  criteria_count、`core/tests/guide-injection.test.ts`）与 `.dsh-graph` 目标数据当时**未提交**
  但目标已标 delivered → 负责人指出「到交付阶段的改动都要有 commit」。
- 已把该规则写入 `dsh-graph-host/supervisor-guide.md` 阶段推进规范第 6 条，并沉淀于此记忆。
