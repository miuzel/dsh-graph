---
{
  "id": "card-6a4b3a86",
  "goal": "g-f8317edc",
  "title": "att-003 验证记录：状态机走通确认",
  "kind": "text",
  "status": "reviewed",
  "filled_by": "agent:9168dcab-14eb-47bc-aab8-3ceba5db26c0",
  "filled_at": "2026-08-20T15:52:43.161Z",
  "content_ref": null
}
---

att-003 验证记录（dogfood 插件全流程）：

一、状态机走通（判据1，来自 events.jsonl 实证）：
- goal.created（backlog）→ draft → planning → collecting → ready → in_progress → review，全部经 graph_transition 触发，事件齐全。
- goal.moved（backlog → goals/ 独立目标目录）事件已由 supervisor 补记。

二、att-003 本轮实测的工具面：
- graph_report_status：PASS（状态行写入 attempt frontmatter）
- graph_add_card / graph_fill_card / graph_review_card：PASS（卡片生命周期 created → filled → reviewed）
- graph_validate：不变式校验通过（见执行笔记）
- graph_rebuild：事件流重建与 frontmatter 对账无 drift（见执行笔记）

三、结论：判据1「能走通状态机」满足；判据2 为 [script] 无，无需脚本验收。
