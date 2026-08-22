---
{
  "id": "att-001",
  "goal": "g-118",
  "executor": "agent:executor",
  "sandbox": "directory",
  "started_at": "2026-08-22T11:18:58+08:00",
  "claimed_at": null,
  "status_line": "5条判据逐条对照完成，等待 review",
  "result": "pending",
  "child_id": "f6755d54-b094-4957-a028-1774c68a6ae0",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

## 执行笔记

### att-001 完成声明（负责人 2026-08-22 设计转向后改造交付，逐条对照 5 条判据）

**判据 1（调研结论沉淀）— PASS**
方案 A = `systemPrompt.section` 条件渲染（空文本被 `renderPrompt` 丢弃，零 token）已确认：
`dsh-system-prompt/lib/index.js` L66 filter + `assembleContextFor(agent)` 携带 `agent.session.id`。
沉淀：`docs/guide-auto-injection.md` §1（三机制对比：agent-instructions 否决 / skill 无自动触发 / section 采用）。

**判据 2（所有会话注入简短引导提示词，完整守则不自动注入）— PASS**
`dsh-graph-host/index.js` 注册 `dsh-graph-guide-hint` section（order 10），`text: () => GUIDE_HINT` 恒定渲染：
所有会话（主管/普通/执行子代理/无 agent）收到 ~120 字引导——graph_claim_supervisor 用法 + graph_help 命令存在
+ 「完整守则不自动注入」说明。完整 supervisor 守则（supervisor-guide.md）**不**自动注入，仍走显式 skill 调用。
单测覆盖（guide-injection.test.ts：「所有会话渲染简短引导提示词」用例）。

**判据 3（新增 dsh-graph help 命令）— PASS**
新增 `graph_help` 工具（graph_* 工具，无参）：输出 HELP_TEXT（dsh-graph 使用说明 + 工具清单 +
graph_handoff/graph_claim_supervisor 换会话步骤 + 完整守则走 skill 的说明）。与引导提示词呼应
（引导告知 help 命令存在）。单测覆盖（「graph_help 工具注册，输出使用说明 + claim 指引」用例），
可执行且输出无损 JSON。

**判据 4（隔离验证：主管守则绝不注入执行子代理/临时会话）— PASS**
注入内容与 help 输出均断言**不含**「绝不自己实现」「不可妥协」「主管 Agent」——主管守则绝不自动注入
任何会话（含执行子代理）；引导提示词除外（轻量无害，只告知「如何」接管，不授予角色）。
单测覆盖（「隔离——注入内容不含 supervisor 完整守则」用例）。

**判据 5（全量测试与冻结脚本 PASS，graph_validate 无问题）— PASS**
- 全量测试：`node --test core/tests/*.test.ts` → **72/72 通过**（含 guide-injection.test.ts 6 用例，
  与 g-119 bind-collect-card.test.ts 等共存；plugin.test.ts/root.test.ts 工具数断言已同步 18）；
- 真实 DSH `renderPrompt` 链路验证 6/6 PASS（tmp/verify-g118-render.mjs）；
- 冻结脚本：check_plugin.sh / check_cards.sh / check_core.sh / check_kanban.sh / check_g108.sh 全部 PASS
  （check_plugin.sh 含隔离 DSH_HOME headless 真实加载，marker: tools ok, validate PASS）；
- `graph_validate` → problems: []。

**与 g-119 并行改动兼容**：graph_bind_collect_card 工具（17 个）+ graph_help（18 个）共存，
两边测试互不破坏；supervisor-guide.md 的 g-119 绑定约束保留。

## Review 记录

<!-- 受管小节 -->
