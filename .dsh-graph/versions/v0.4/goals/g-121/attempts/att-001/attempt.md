---
{
  "id": "att-001",
  "goal": "g-121",
  "executor": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "sandbox": "directory",
  "started_at": "2026-08-22T11:45:02+08:00",
  "claimed_at": null,
  "status_line": "完成：归档+4单测，85测试8脚本全绿",
  "result": "pending",
  "child_id": "8602cf87-b476-4783-adc8-fe8e1f6c7b0f",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

## 执行笔记

g-121 判据逐条对照（att-001）：

- **判据 1（generateHandoff(write:true) 写前归档旧版）**：core/ops.ts 新增 `writeHandoff(root, content)` 统一写盘入口——目标文件存在且内容不同时，先 `copyFileSync` 归档到 `<root>/handoffs/HANDOFF-<YYYYMMDD-HHmmss-fff>.md`（目录 mkdirSync recursive），再写新文件；generateHandoff 的 `opts.write` 分支改走 writeHandoff。✅
- **判据 2（归档目录不入 git）**：仓库根 .gitignore 增加 `handoffs/`（带 g-121 注释）；`git check-ignore -v` 实测命中 `.gitignore:9:handoffs/`。✅
- **判据 3（claimSupervisor / graph_handoff 行为同步）**：claimSupervisor 改为 `generateHandoff(root, { write: true })`——返回 HANDOFF 时同时落盘，写盘统一走 writeHandoff 归档逻辑；host 两个工具（graph_handoff / graph_claim_supervisor）描述同步更新（注明归档与落盘语义）。✅
- **判据 4（单测覆盖）**：core.test.ts 新增 4 用例——①首写无归档+二次写归档（归档内容=旧版全文、文件名带时间戳、位于 handoffs/）；②writeHandoff 内容相同不归档（幂等）；③claimSupervisor 返回时同时落盘+触发归档（事件幂等不受影响）；④仓库根 .gitignore 排除 handoffs/ 断言。全量 85/85 绿；8 冻结脚本全 PASS。✅
- **判据 5（graph_validate）**：PASS。✅

变更文件：core/ops.ts（writeHandoff/handoffTs + claimSupervisor 写盘）、.gitignore（handoffs/）、core/tests/core.test.ts（4 用例）、dsh-graph-host/index.js（两工具描述）、dsh-graph-host/core/*.js（sync-core.sh 编译同步）、tmp/handoff-archive-probe.mjs（实机探针）。

## Review 记录

<!-- 受管小节 -->
