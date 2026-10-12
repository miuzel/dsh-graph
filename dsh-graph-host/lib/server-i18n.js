// Server-side bilingual strings for graph_* tool metadata and host prompts.
// Keep keys symmetric so adding a language is an additive operation.
const zh = Object.freeze({
  reportStatus: "汇报当前 attempt 的一句最新工作状态（会显示在看板卡片上）；state 必须使用 working/blocked/done/error。保持一句人话（≤40 字符）；完整测试证据不要塞进 status，改用单行结构化概要 evidence: suite=… passed=… failed=… exit=… ms=… diff=… commit=…（一套件一行、单条 ≤160 字符）。",
  promptLanguage: "提示词语言：follow/zh/en；follow 跟随 DSH locale，解析失败回退中文。",
  stateWorking: "进行中",
  stateBlocked: "阻塞",
  stateDone: "完成",
  stateError: "错误",
  "tool.graph_create_goal": "创建目标（默认进 backlog；带 version 则排期入版本）。可选 type 指定类型（feature/bug/task/improvement/patch/chore，默认 task；patch/chore 为微小改动快速通道）。返回目标 id。",
  "tool.graph_set_criteria": "登记目标的质量判据（判据先于执行；自动快照规则库版本）。",
  "tool.graph_transition": "目标状态迁移。状态机与不变式由核心层强制；进 blocked 必须给 reason。",
  "tool.graph_add_card": "为目标创建上下文卡片（empty 占位）。返回卡片 id。默认创建共享卡（scope=shared，落共享池并挂到该 goal）；goal 自有卡必须显式传 scope=\"goal\"。卡片统一为正文 + 可选附件引用（@att/<name>），kind 仅为兼容读取字段、可不传、不限定类型。",
  "tool.graph_store_attachment": "存储一个上下文附件到项目根 .dsh-graph/attachments/（可含安全子目录），返回稳定引用名（用 @att/<相对引用名> 在卡片正文/goal.md 引用）。文本用 content；二进制/图片/Excel 用 base64。name 拒绝绝对路径、./.. 穿越、反斜杠、NUL；目标已存在且内容不同会生成唯一名（不覆盖）；异常不留半文件。",
  "tool.graph_delete_attachment": "显式删除附件；仍被任何卡片/目标正文引用的附件禁止删除（解除/删除卡片不误删仍被引用的附件）。",
  "tool.graph_fill_card": "填充上下文卡片（正文 + 可选附件引用）。text 写卡片正文全文；正文与 goal.md 里用 @att/<相对引用名> 引用附件。summary 是一句话要点式摘要（≤100 字左右），细节写进 text。正文是结构化结论与断言引用，不是数据倾倒场：单条建议 ≤150 字符，禁止倾倒多行 JSON、DOM dump 或原始日志。content_ref 仅为兼容读取字段。",
  "tool.graph_review_card": "复核已填充的上下文卡片（filled → reviewed）。",
  "tool.graph_delete_card": "删除目标的上下文卡片（删卡片文件 + context_cards 移除引用 + 记 card.deleted 事件，事件先行 R-02）。正在收集中的卡片（status=collecting）不可删除。",
  "tool.graph_convert_card_to_shared": "将 goal 自有卡转换为共享卡（落共享池，原 goal 保留引用）。适用场景：多目标协作需要共享上下文。限制：collecting 状态禁止转换。",
  "tool.graph_convert_card_to_owned": "将共享卡转换回 goal 自有卡（从共享池收回为独占）。适用场景：收回独占权、共享池清理。限制：collecting 状态禁止转换；仅当引用计数恰为 1 时可操作。",
  "tool.graph_attach_shared_card": "把共享池中已有的共享卡挂载到目标（复用此前收集好的上下文，引用计数 +1，记 card.shared_referenced 事件）。仅限目标 owner（创建者/human）或已配置的主管；执行子代理无权挂载。目标已引用同一卡时幂等（不重复挂载、不重复记事件）。",
  "tool.graph_detach_shared_card": "解除目标对共享卡的引用（引用计数 -1，记 card.shared_unreferenced 事件）；卡本体始终留在共享池，零引用也不删除。收集中（collecting）的共享卡拒绝解除。仅限目标 owner（创建者/human）或已配置的主管。",
  "tool.graph_list_shared_cards": "只读列出共享池的全部共享卡：返回 { cards: [{ id, title, status, refs }] }，refs 为引用该卡的 goal id 列表（含已归档）；不返回卡片正文。空池返回空数组。",
  "tool.graph_record_attempt_handoff": "主管/负责人登记前序 attempt 的返工 handoff：记录已核实失败、返工约束（禁止项）、推荐基线/保留项与验收命令。每个 goal 仅一个 handoff，新登记覆盖旧内容；旧历史由事件流保留。source_attempts 必须属于该 goal。",
  "tool.graph_set_directive": "设置/替换目标的「最近指令」：写下一次 attempt 生效的补充任务、边界和验收。写入 goal.md 的「最近指令」小节并追加事件；新 attempt 派发时自动读取注入初始 prompt。directive 为空字符串时清空指令。",
  "tool.graph_set_description": "设置/替换目标的「目标描述」：就地编辑目标描述内容。写入 goal.md 的「目标描述」小节并追加事件；仅改描述小节正文，frontmatter 与其他小节字节级不变。description 为空字符串时清空描述。",
  "tool.graph_set_relation": "标记/解除目标间关系：action=add|remove；type 限 supersedes/amends/extends/related；target 为对端目标 id。只写 goal frontmatter 的 meta.relations，幂等。depends_on 请改用 meta.depends_on（本工具拒绝）；会形成替代环的标记被拒绝。",
  "tool.graph_add_comment": "向目标的「评论」小节追加一条可追溯的历史讨论/反馈。评论不自动注入执行 prompt，但执行者可通过 goal.md 查看历史。事件先行。核验记录用结构化结论与断言引用（单条建议 ≤150 字符），禁止倾倒多行 JSON、DOM dump、原始日志或围栏代码块；确需引用长日志时只给文件路径 + 关键行。",
  "tool.graph_write_results": "写入一次 attempt 的完成摘要（<goalDir>/results-att-<attempt>.md）：主管/用户在**无子代理**的轻量改动（chore/patch、文档或看板数据修订）后**务必主动使用**它补写，避免结果真空。与自动截获共用同一写入器/路径/格式，零 LLM，文件头标注 source（默认 manual）与写入者；重复调用为 last-wins 覆盖。attempt 必须真实存在。",
  "tool.graph_refresh_results": "重写 <goalDir>/results.md 完成摘要；旧版归档为 results-archive-*.md。写入器自身零 LLM：①`llm:true` 派 summarizer 子代理写正文（source=llm，按 source_hash 缓存，`force:true` 强制重来，失败降级 source=deterministic）；②省略 content/llm 则零 LLM 拼装；③传 content 用调用方正文（source=manual）；④单目标 goal 或批量 goals[]。**主管自做 chore/patch 等无子代理改动后应主动调用**。细则见 help(topic=\"usage\")。",
  "tool.graph_bind_collect_card": "把已派发的收集子代理绑定到上下文卡片：写 child_id/parent_session_id、置 status=collecting，并记 card.collecting 事件（事件先行，R-02）。parent_session_id 缺省取当前会话 id（子代理会话文件头 parentSession 为权威来源，需不一致时显式传入）；重复绑定同一 child 幂等（不重复记事件）。",
  "tool.graph_help": "输出 dsh-graph 使用说明与 supervisor 接管（claim）指引：graph_* 工具清单、graph_handoff/graph_claim_supervisor 换会话步骤。",
  "tool.graph_move_goal": "排期移动目标：backlog ↔ 独立 goals/ ↔ 版本。文件移动即归属变更，记 goal.moved 事件。",
  "tool.graph_amend_goal": "记录对目标的修订/补充（人工反馈的一等记录）；可选把修订内容追加进目标描述，使目标内容体现最终修订。",
  "tool.graph_rename_goal": "重命名目标：更新 goal.md 的 meta.title，记 goal.renamed 事件（旧/新标题）。title 非空、去首尾空白；相同标题为 no-op。",
  "tool.graph_set_goal_tags": "设置目标标签列表（最多20个，每个不超过32字，禁止控制字符）。支持基于 base_tags 的乐观并发，force=true 时强制覆盖。写入前事件先行。",
  "tool.graph_set_goal_type": "设置目标类型（feature/bug/task/improvement/patch/chore；patch/chore 为微小改动快速通道），只更新 meta.type 并记 goal.type_changed 事件（old_type/new_type/actor）；不改 status/version/执行。非法类型安全回退 task；相同类型为 no-op。",
  "tool.graph_validate": "全量不变式校验（状态、归属、判据、依赖环、卡片引用）。返回问题列表。",
  "tool.graph_rebuild": "从事件流重建各目标状态并与 frontmatter 对账。返回 drift 列表。",
  "tool.graph_report_status": "汇报当前 attempt 的一句最新工作状态（会显示在看板卡片上）；state 必须使用 working/blocked/done/error。保持一句人话（≤40 字符）；完整测试证据不要塞进 status，改用单行结构化概要 evidence: suite=… passed=… failed=… exit=… ms=… diff=… commit=…（一套件一行、单条 ≤160 字符）。",
  "tool.graph_report_supervisor_status": "supervisor 汇报自己的一句最新工作状态（显示在看板顶部状态栏，带运行动画）。status 要简短（一句人话）。",
  "tool.graph_handoff": "生成/更新 .dsh-graph/HANDOFF.md 换会话交接文档：board 投影 + 长期记忆 + 关键环境事实段自动拼接。产物不依赖会话上下文；返回交接全文。旧会话交接时调用。写盘前若旧 HANDOFF.md 存在且内容不同，先归档到 <root>/handoffs/HANDOFF-<时间戳>.md（归档目录不入 git）。",
  "tool.graph_claim_supervisor": "新会话接手时调用：把 project.yaml 的 supervisor.session 更新为当前会话 id（ex.agent.session 链），记 supervisor.claimed 事件（幂等：重复调用不重复记），返回 HANDOFF 交接全文并同时落盘 HANDOFF.md（写盘统一走归档逻辑：旧版先归档到 <root>/handoffs/）。",
  "tool.graph_memory_add": "新增持久事实/记忆。scope 默认 on_demand（按需，不占常驻 Prompt）；仅「人类明确要求记为常驻/铁律」或「涉及工作区隔离/不可违背的安全禁令」才可设 standing（硬上限 200 字符，普通记忆上限 1000 字符）。可选 source_ref 是迁移来源键：提供时同来源重复 add 幂等（返回原 ID、不重复记事件）。",
  "tool.graph_memory_replace": "修正或合并已有记忆条目（用短唯一 old 片段定位已有记忆，text 为新内容）。",
  "tool.graph_memory_remove": "删除记忆条目（仅负责人明确撤回或证实过时后才可删除；用短唯一 old 片段定位）。",
  "tool.graph_memory_recall": "按关键词/类型检索返回匹配的持久记忆条目（供 supervisor 及子代理引用）。",
  "tool.graph_start_review": "为**既有执行 attempt** 派发独立评审子代理（reviewer，只读审查）。评审是附属记录：不新建 attempt、不迁移状态、不覆盖作者 child_id 与结果文件；复用作者工作树；结论落盘 <goalDir>/reviews/<review_id>.md。同一 attempt + 同一候选幂等。reviewer 不得自行 accept/fast_track/delivered。",
  "tool.graph_start_attempt": "为目标派发 attempt：先过准入门禁（backlog/draft/blocked/delivered、无判据/未确认判据/状态不允许拒绝，零副作用），通过后落地 in_progress 并启动可续轮子 agent。worktree 显式传值优先，未传按目标类型 × 工作区干净度解析（干净时 patch/chore/task 不建树，feature/bug/improvement 建树）；返回 isolated/worktree/worktree_reason 可判定隔离。task_type 取 merge/rewrite/fix。细则见 help(topic=\"usage\")。",
  // 生效面说明（g-437 P3-b）：本键在注册时覆盖 def.description 的内联副本 ⇒ 这里才是生效描述；
  // 改文案须与 index.js 内联字面量同改（键不可删：prompt-i18n-parity 要求每个注册工具恰有一把 tool.* 键）。
  "tool.graph_resolve_accept": "主管裁决接受请求：verdict=accept 通过 / object 异议；force=true 强制接受并记理由。fast_track=true 走机器快速放行：须策略判定为 auto（patch/chore 派生；≥150 行产品代码/契约变更升级 strict），且 ①tests ②typecheck 为**调用方证据**（引擎不复跑，须留痕 command/collected_at/source）、③变更规模由**引擎 Git 自算**（machine_report.attempt 必填）、④判据以 ✅已验 结尾。",
  "tool.graph_list_worktrees": "查询 Git worktree 清理候选（只读，不自动删除）。",
  "tool.graph_clean_worktree": "用户明确选择后清理已实时验证的 worktree；默认不删除分支。",
  "tool.graph_archive_goal": "归档目标（仅 draft/planning/delivered 可归档）。移动到对应 archived 目录，记 goal.archived 事件。",
  "tool.graph_unarchive_goal": "取消归档目标（移回原位置，状态保持原样）。记 goal.unarchived 事件。",
  "tool.graph_delete_goal": "删除已归档目标（含其卡片/attempts 目录）。仅已归档目标可删除，且不能有活跃子代理。记 goal.deleted 事件。",
  "tool.graph_postpone_goal": "暂缓目标：将版本/独立目标移回 backlog 目录形态并置为 draft（保留 cards/attempts）。存在活跃 agent 时拒绝操作。",
  "tool.graph_unbind_goal_child": "从目标安全解绑执行子代理：按 goal + 唯一 selector（attempt 或 child_id）+ 当前 binding token 定位；仅授权主管或目标 owner 可执行（子代理不能自我解绑）。只清理绑定，attempt/事件/日志保留可审计；幂等。遗留缺 token 的绑定可显式 legacy: true 并给 reason 受控解绑（若存在 token 则禁止绕过）。",
  "tool.graph_abandon_attempt": "放弃陈旧/失联 attempt：把指定 attempt 标记为已放弃（result=cancelled、detached=true），清除绑定；仅授权主管或目标 owner 可执行；子代理仍运行（live registry）或状态不可确认时拒绝；事件先行（attempt.abandoned 含 reason/actor）。放弃后该 attempt 不再被判为活跃，目标可正常暂缓/归档/删除。",
  "tool.graph_get_settings": "读取当前 workspace 的项目配置（基于 readProjectConfig）：返回解析后的配置对象、配置文件路径与合法枚举/字段元信息。只读，不修改任何文件。",
  "tool.graph_update_settings": "更新当前 workspace 的项目配置（基于 writeProjectConfig）。传入部分 patch；保留 schema 校验、非法枚举拒绝、未知键与 YAML 注释保留、原子写，并记 project.config_set 事件。未传字段保持不变。",
  // === g-489：「使用说明 → 工具清单」的分类标签与工具简称（zh/en 必须对称）===
  // 分类归属表见文件末尾的 TOOL_TAXONOMY；与注册真源的一致性由 helpToolTaxonomyProblems 守卫。
  "toolCategory.goal": "目标与判据",
  "toolCategory.card": "卡片与附件",
  "toolCategory.exec": "派发与执行",
  "toolCategory.memory": "记忆",
  "toolCategory.handoff": "协同交接",
  "toolCategory.ops": "工作树与状态",
  "toolCategory.settings": "设置",
  "toolCategory.diag": "校验与帮助",
  "toolShort.graph_create_goal": "建目标",
  "toolShort.graph_set_criteria": "写判据",
  "toolShort.graph_transition": "迁移状态",
  "toolShort.graph_move_goal": "排期归属",
  "toolShort.graph_rename_goal": "改标题",
  "toolShort.graph_set_goal_type": "设类型",
  "toolShort.graph_set_goal_tags": "设标签",
  "toolShort.graph_set_relation": "目标关系",
  "toolShort.graph_amend_goal": "记录修订",
  "toolShort.graph_set_description": "写描述",
  "toolShort.graph_set_directive": "写指令",
  "toolShort.graph_add_comment": "加评论",
  "toolShort.graph_archive_goal": "归档目标",
  "toolShort.graph_unarchive_goal": "取消归档",
  "toolShort.graph_delete_goal": "删除目标",
  "toolShort.graph_postpone_goal": "暂缓目标",
  "toolShort.graph_add_card": "建卡片",
  "toolShort.graph_fill_card": "填卡片",
  "toolShort.graph_review_card": "复核卡片",
  "toolShort.graph_delete_card": "删卡片",
  "toolShort.graph_convert_card_to_shared": "转共享卡",
  "toolShort.graph_convert_card_to_owned": "收回自有",
  "toolShort.graph_attach_shared_card": "挂共享卡",
  "toolShort.graph_detach_shared_card": "解挂共享卡",
  "toolShort.graph_list_shared_cards": "共享卡列表",
  "toolShort.graph_store_attachment": "存附件",
  "toolShort.graph_delete_attachment": "删附件",
  "toolShort.graph_bind_collect_card": "绑定收集",
  "toolShort.graph_start_attempt": "派发执行",
  "toolShort.graph_start_review": "派发评审",
  "toolShort.graph_resolve_accept": "裁决接受",
  "toolShort.graph_record_attempt_handoff": "登记返工",
  "toolShort.graph_unbind_goal_child": "解绑执行",
  "toolShort.graph_abandon_attempt": "放弃执行",
  "toolShort.graph_write_results": "写结果",
  "toolShort.graph_refresh_results": "刷新结果",
  "toolShort.graph_memory_add": "加记忆",
  "toolShort.graph_memory_replace": "改记忆",
  "toolShort.graph_memory_remove": "删记忆",
  "toolShort.graph_memory_recall": "查记忆",
  "toolShort.graph_handoff": "交接文档",
  "toolShort.graph_claim_supervisor": "接管主管",
  "toolShort.graph_list_worktrees": "工作树列表",
  "toolShort.graph_clean_worktree": "清理工作树",
  "toolShort.graph_report_status": "报执行状态",
  "toolShort.graph_report_supervisor_status": "报主管状态",
  "toolShort.graph_get_settings": "读设置",
  "toolShort.graph_update_settings": "改设置",
  "toolShort.graph_validate": "校验不变量",
  "toolShort.graph_rebuild": "重建状态",
  "toolShort.graph_help": "工具速查",
});
const en = Object.freeze({
  reportStatus: "Report the latest attempt status shown on the board; state must be working/blocked/done/error. Keep it one short human sentence (at most 40 characters); do not put full test evidence in the status - use the single-line structured summary evidence: suite=... passed=... failed=... exit=... ms=... diff=... commit=... instead (one suite per line, at most 160 characters each).",
  promptLanguage: "Prompt language: follow/zh/en; follow uses the DSH locale and falls back to Chinese when unavailable.",
  stateWorking: "working",
  stateBlocked: "blocked",
  stateDone: "done",
  stateError: "error",
  "tool.graph_create_goal": "Create a goal (goes to backlog by default; specifying version schedules it into that version). Optional type selects feature/bug/task/improvement/patch/chore (default task; patch/chore are quick paths for small changes). Returns the goal id.",
  "tool.graph_set_criteria": "Register quality criteria for a goal (criteria precede execution; the ruleset version is snapshotted automatically).",
  "tool.graph_transition": "Transition a goal's status. The core layer enforces the state machine and invariants; entering blocked requires a reason.",
  "tool.graph_add_card": "Create a context card for a goal (an empty placeholder). Returns the card id. Creates a shared card by default (scope=shared, stored in the shared pool and attached to the goal); a goal-owned card requires explicitly passing scope=\"goal\". Cards contain body text plus optional attachment references (@att/<name>); kind is retained for compatibility, optional, and unrestricted.",
  "tool.graph_store_attachment": "Store a context attachment under the project root .dsh-graph/attachments/ (safe subdirectories allowed) and return a stable reference name (use @att/<relative reference name> in card body/goal.md). Use content for text and base64 for binary files, images, or Excel files. name rejects absolute paths, ./.. traversal, backslashes, and NUL; if the name exists with different content, a unique name is generated (no overwrite); failures leave no partial file.",
  "tool.graph_delete_attachment": "Explicitly delete an attachment; deletion is forbidden while any card or goal body references it (unreferencing or deleting a card does not accidentally delete an attachment that remains referenced).",
  "tool.graph_fill_card": "Fill a context card (body text plus optional attachment references). text is the complete card body; reference attachments from card text and goal.md with @att/<relative reference name>. summary is a one-sentence key-point summary (about 100 characters or fewer); put details in text. The body carries structured conclusions and assertion references, not data dumps: keep each entry at most 150 characters and never dump multi-line JSON, DOM markup, or raw logs. content_ref is retained only for compatibility.",
  "tool.graph_review_card": "Review a filled context card (filled -> reviewed).",
  "tool.graph_delete_card": "Delete a goal's context card (delete the card file, remove its context_cards reference, and record a card.deleted event with the event first per R-02). A card currently being collected (status=collecting) cannot be deleted.",
  "tool.graph_convert_card_to_shared": "Convert a goal-owned card to a shared card (stored in the shared pool; the original goal retains its reference). Use case: sharing context across multiple goals for collaboration. Restriction: conversion is forbidden while the card is being collected.",
  "tool.graph_convert_card_to_owned": "Convert a shared card back to a goal-owned card (reclaim exclusive ownership from the shared pool). Use case: reclaiming exclusive ownership or cleaning up the shared pool. Restriction: conversion is forbidden while the card is being collected; only allowed when the reference count is exactly 1.",
  "tool.graph_attach_shared_card": "Attach an existing shared card from the shared pool to a goal (reuse previously collected context; the reference count increases by 1 and a card.shared_referenced event is recorded). Only the goal owner (creator/human) or the configured supervisor may attach; execution subagents are not authorized. Idempotent when the goal already references the same card (no duplicate attach, no duplicate event).",
  "tool.graph_detach_shared_card": "Remove a goal's reference to a shared card (the reference count decreases by 1 and a card.shared_unreferenced event is recorded); the card itself always stays in the shared pool and is not deleted even at zero references. A shared card being collected (collecting) refuses detachment. Only the goal owner (creator/human) or the configured supervisor may detach.",
  "tool.graph_list_shared_cards": "Read-only listing of every shared card in the shared pool: returns { cards: [{ id, title, status, refs }] }, where refs is the list of goal ids referencing that card (archived goals included); card bodies are not returned. An empty pool returns an empty array.",
  "tool.graph_record_attempt_handoff": "Register a handoff for reworking a previous attempt as supervisor or owner: record verified failures, rework constraints (prohibitions), the recommended baseline/retained items, and verification commands. Each goal has only one handoff; a new registration replaces the old content while event history is retained. source_attempts must belong to the goal.",
  "tool.graph_set_directive": "Set or replace a goal's latest directive: write supplemental tasks, boundaries, and acceptance details for the next attempt. Writes the Latest Directive section in goal.md and records an event; the next attempt dispatch reads and injects it into the initial prompt. An empty directive string clears the directive.",
  "tool.graph_set_description": "Set or replace a goal's description: edit the description in place. Writes the Goal Description section in goal.md and records an event; only the description section body changes, while frontmatter and all other sections remain byte-for-byte unchanged. An empty description string clears the description.",
  "tool.graph_set_relation": "Mark or unmark a relation between goals: action=add|remove; type is limited to supersedes/amends/extends/related; target is the peer goal id. Only writes meta.relations in the goal frontmatter; idempotent. Use meta.depends_on for depends_on (this tool refuses to write it into relations); marks that would form a supersede cycle are rejected.",
  "tool.graph_add_comment": "Append a traceable historical discussion or feedback entry to a goal's Comments section. Comments are not automatically injected into execution prompts, but executors can read the history in goal.md. The event is recorded first. Write verification records as structured conclusions plus assertion references (each entry at most 150 characters), never dump multi-line JSON, DOM markup, raw logs, or fenced code blocks; when a long log really must be cited, give only its file path plus the key line.",
  "tool.graph_write_results": "Write the completion summary for one attempt (<goalDir>/results-att-<attempt>.md): use it proactively right after the supervisor or user finishes a lightweight change that had no subagent (a chore/patch, a docs or board-data revision). It shares the auto-capture writer, path, and format; zero LLM calls; the header records source (manual by default) and the writer; repeating the call is last-wins. The attempt record must already exist.",
  "tool.graph_refresh_results": "Rewrite the completion summary <goalDir>/results.md; the previous version is archived as results-archive-*.md. The writer itself makes zero LLM calls: (1) `llm:true` dispatches the summarizer subagent (source=llm, cached by source_hash, force:true rewrites anyway, failure degrades to source=deterministic); (2) without content/llm the body is assembled with zero LLM calls; (3) with content the caller body is used (source=manual); (4) one goal or a goals[] batch. **Use it after a subagent-less chore/patch change.** Details: help(topic=\"usage\").",
  "tool.graph_bind_collect_card": "Bind a dispatched collection subagent to a context card: write child_id/parent_session_id, set status=collecting, and record a card.collecting event first per R-02. parent_session_id defaults to the current session id (the child session file's parentSession is authoritative; pass it explicitly if they differ); binding the same child again is idempotent and records no duplicate event.",
  "tool.graph_help": "Print dsh-graph usage instructions and supervisor handoff (claim) guidance: the graph_* tool list and graph_handoff/graph_claim_supervisor session-transfer steps.",
  "tool.graph_move_goal": "Move a goal between backlog, a standalone goals/ directory, and a version schedule. Moving the file changes its ownership and records a goal.moved event.",
  "tool.graph_amend_goal": "Record a revision or addition to a goal (a first-class human feedback record); optionally append the revision to the goal description so the goal reflects the final revision.",
  "tool.graph_rename_goal": "Rename a goal: update meta.title in goal.md and record a goal.renamed event (old/new titles). title must be non-empty and is trimmed; the same title is a no-op.",
  "tool.graph_set_goal_tags": "Set a goal's tag list (at most 20 tags, each at most 32 characters; control characters are forbidden). Supports optimistic concurrency based on base_tags; force=true overwrites unconditionally. Records the event before writing.",
  "tool.graph_set_goal_type": "Set a goal type (feature/bug/task/improvement/patch/chore; patch/chore are quick paths for small changes), updating only meta.type and recording a goal.type_changed event (old_type/new_type/actor); status/version/execution are unchanged. Invalid types safely fall back to task; the same type is a no-op.",
  "tool.graph_validate": "Validate all invariants (status, ownership, criteria, dependency cycles, and card references). Returns a list of problems.",
  "tool.graph_rebuild": "Rebuild each goal's state from the event stream and reconcile it with frontmatter. Returns a list of drift items.",
  "tool.graph_report_status": "Report the latest attempt status shown on the board; state must be working/blocked/done/error. Keep it one short human sentence (at most 40 characters); do not put full test evidence in the status - use the single-line structured summary evidence: suite=... passed=... failed=... exit=... ms=... diff=... commit=... instead (one suite per line, at most 160 characters each).",
  "tool.graph_report_supervisor_status": "Report the supervisor's latest one-line work status (shown in the board's top status bar with a running indicator). status must be brief and human-readable.",
  "tool.graph_handoff": "Generate or update the .dsh-graph/HANDOFF.md session-transfer document: automatically combine the board projection, long-term memories, and key environment facts. The artifact does not depend on conversation context; returns the full handoff. Call this when transferring from an old session. Before writing, if an existing HANDOFF.md differs, archive it at <root>/handoffs/HANDOFF-<timestamp>.md (the archive directory is not tracked by git).",
  "tool.graph_claim_supervisor": "Call when a new session takes over: update project.yaml supervisor.session with the current session id (the ex.agent.session chain), record a supervisor.claimed event (idempotent; repeated calls do not duplicate it), return the full HANDOFF, and write HANDOFF.md at the same time (writes use the archive logic; archive the old version at <root>/handoffs/ first).",
  "tool.graph_memory_add": "Add a persistent fact or memory. scope defaults to on_demand (not part of the standing prompt); standing is allowed only when a human explicitly requests standing/rule memory or when it concerns workspace isolation or a non-negotiable security prohibition (hard limit 200 characters; ordinary memory limit 1000 characters). The optional source_ref is a migration source key: when provided, repeating add for the same source is idempotent (returns the original id, records no extra event).",
  "tool.graph_memory_replace": "Correct or merge an existing memory entry (locate it using a short unique old fragment; text is the replacement content).",
  "tool.graph_memory_remove": "Delete a memory entry (only after the owner explicitly withdraws it or confirms it is obsolete; locate it using a short unique old fragment).",
  "tool.graph_memory_recall": "Search for matching persistent memory entries by keyword or type (for reference by the supervisor and subagents).",
  "tool.graph_start_review": "Dispatch an independent review subagent (reviewer, read-only) for an existing execution attempt. The review is an attachment record: it creates no new attempt, performs no status transition, and never overwrites the author's child_id or result files; it reuses the author's worktree; the conclusion is stored at <goalDir>/reviews/<review_id>.md. Repeated calls for the same attempt and candidate are idempotent. A reviewer must not accept, fast-track, or deliver on its own.",
  "tool.graph_start_attempt": "Dispatch an attempt for a goal: the admission gate runs first (backlog/draft/blocked/delivered, missing or unconfirmed criteria, and disallowed states are rejected with zero side effects); on admission the goal moves to in_progress and a continuable subagent starts. An explicit worktree value wins; otherwise it is resolved from goal type x workspace cleanliness (on a clean workspace patch/chore/task get none and feature/bug/improvement get one). The result exposes isolated/worktree/worktree_reason for an isolation verdict. task_type is merge/rewrite/fix. Details: help(topic=\"usage\").",
  "tool.graph_resolve_accept": "Resolve an acceptance request: verdict=accept approves it, object raises an objection; force=true force-accepts and records the reason. fast_track=true takes the machine fast track: the policy must resolve to auto (derived for patch/chore; 150+ product-code lines or a contract change escalate to strict), and (1) tests and (2) typecheck are CALLER evidence (the engine never re-runs them; command/collected_at/source must be recorded), (3) change size is computed by the ENGINE from Git truth (machine_report.attempt required), (4) criteria end with the verified mark.",
  "tool.graph_list_worktrees": "List Git worktrees eligible for cleanup (read-only; does not delete automatically).",
  "tool.graph_clean_worktree": "Clean a worktree after the user explicitly selects it and it has been live-verified; branches are not deleted by default.",
  "tool.graph_archive_goal": "Archive a goal (only draft/planning/delivered may be archived). Move it to the corresponding archived directory and record a goal.archived event.",
  "tool.graph_unarchive_goal": "Unarchive a goal (move it back to its original location while preserving its status). Record a goal.unarchived event.",
  "tool.graph_delete_goal": "Delete an archived goal (including its cards/attempts directory). Only archived goals may be deleted, and no active subagent may remain. Record a goal.deleted event.",
  "tool.graph_postpone_goal": "Postpone a goal: move a version or standalone goal back to the backlog directory form and set it to draft (preserve cards/attempts). Refuses the operation while an active agent exists.",
  "tool.graph_unbind_goal_child": "Safely detach an execution subagent from a goal: locate by goal plus one selector (attempt or child_id) and the current binding token; only the supervisor or goal owner is authorized (a subagent cannot detach itself). Only the binding is cleared; attempt/event/log evidence remains auditable; repeated detaches are idempotent. For legacy bindings lacking a binding_token, supports explicitly declaring legacy: true with a reason for controlled detachment (bypassing with legacy while a token exists is forbidden).",
  "tool.graph_abandon_attempt": "Abandon a stale or lost attempt: mark the specified attempt as abandoned (result=cancelled, detached=true) and clear its binding; only the authorized supervisor or goal owner can execute this; rejected if the subagent is still running (live registry) or its status cannot be confirmed; event-first (attempt.abandoned records reason/actor). After being abandoned, the attempt is no longer considered active, allowing the goal to be postponed, archived, or deleted normally.",
  "tool.graph_get_settings": "Read the current workspace project configuration (based on readProjectConfig): returns the parsed config object, the config file path, and valid enum/field metadata. Read-only; no files are modified.",
  "tool.graph_update_settings": "Update the current workspace project configuration (based on writeProjectConfig). Pass a partial patch; schema validation, illegal-enum rejection, preservation of unknown keys and YAML comments, atomic writes, and a project.config_set event are retained. Omitted fields remain unchanged.",
  // === g-489: category labels and tool short names for "Help -> Tools" (zh/en stay symmetric) ===
  // The category assignment table is TOOL_TAXONOMY at the end of this file; helpToolTaxonomyProblems guards it against the registration source.
  "toolCategory.goal": "Goals & criteria",
  "toolCategory.card": "Cards & attachments",
  "toolCategory.exec": "Dispatch & execution",
  "toolCategory.memory": "Memory",
  "toolCategory.handoff": "Handoff",
  "toolCategory.ops": "Worktrees & status",
  "toolCategory.settings": "Settings",
  "toolCategory.diag": "Validation & help",
  "toolShort.graph_create_goal": "New goal",
  "toolShort.graph_set_criteria": "Set criteria",
  "toolShort.graph_transition": "Transition",
  "toolShort.graph_move_goal": "Schedule",
  "toolShort.graph_rename_goal": "Rename",
  "toolShort.graph_set_goal_type": "Set type",
  "toolShort.graph_set_goal_tags": "Set tags",
  "toolShort.graph_set_relation": "Relations",
  "toolShort.graph_amend_goal": "Amend",
  "toolShort.graph_set_description": "Description",
  "toolShort.graph_set_directive": "Directive",
  "toolShort.graph_add_comment": "Add comment",
  "toolShort.graph_archive_goal": "Archive",
  "toolShort.graph_unarchive_goal": "Unarchive",
  "toolShort.graph_delete_goal": "Delete goal",
  "toolShort.graph_postpone_goal": "Postpone",
  "toolShort.graph_add_card": "New card",
  "toolShort.graph_fill_card": "Fill card",
  "toolShort.graph_review_card": "Review card",
  "toolShort.graph_delete_card": "Delete card",
  "toolShort.graph_convert_card_to_shared": "To shared",
  "toolShort.graph_convert_card_to_owned": "To owned",
  "toolShort.graph_attach_shared_card": "Attach shared",
  "toolShort.graph_detach_shared_card": "Detach shared",
  "toolShort.graph_list_shared_cards": "List shared",
  "toolShort.graph_store_attachment": "Add file",
  "toolShort.graph_delete_attachment": "Delete file",
  "toolShort.graph_bind_collect_card": "Bind collect",
  "toolShort.graph_start_attempt": "Dispatch",
  "toolShort.graph_start_review": "Start review",
  "toolShort.graph_resolve_accept": "Resolve accept",
  "toolShort.graph_record_attempt_handoff": "Rework brief",
  "toolShort.graph_unbind_goal_child": "Unbind child",
  "toolShort.graph_abandon_attempt": "Abandon",
  "toolShort.graph_write_results": "Write results",
  "toolShort.graph_refresh_results": "Refresh results",
  "toolShort.graph_memory_add": "Remember",
  "toolShort.graph_memory_replace": "Revise memory",
  "toolShort.graph_memory_remove": "Forget",
  "toolShort.graph_memory_recall": "Recall",
  "toolShort.graph_handoff": "Handoff",
  "toolShort.graph_claim_supervisor": "Claim supervisor",
  "toolShort.graph_list_worktrees": "List worktrees",
  "toolShort.graph_clean_worktree": "Clean worktree",
  "toolShort.graph_report_status": "Report status",
  "toolShort.graph_report_supervisor_status": "Report supervisor",
  "toolShort.graph_get_settings": "Get settings",
  "toolShort.graph_update_settings": "Update settings",
  "toolShort.graph_validate": "Validate",
  "toolShort.graph_rebuild": "Rebuild",
  "toolShort.graph_help": "Tool help",
});

export const SERVER_I18N = Object.freeze({ zh, en });
export const SERVER_I18N_KEYS = Object.freeze(Object.keys(zh));
export function sT(key, language = "zh") {
  const lang = language === "en" ? "en" : "zh";
  return SERVER_I18N[lang][key] ?? SERVER_I18N.zh[key] ?? SERVER_I18N.en[key] ?? key;
}

export function assertServerI18nParity() {
  const a = Object.keys(zh).sort();
  const b = Object.keys(en).sort();
  if (a.length !== b.length || a.some((key, i) => key !== b[i])) throw new Error("server i18n dictionaries are not symmetric");
  return true;
}

// ===== g-489：「使用说明 → 工具清单」的分类表（唯一分类真源）=====
// 类别顺序 = 页签里的展示顺序；类别标签 = `toolCategory.<key>`，工具简称 = `toolShort.<name>`（zh/en 对称）。
// 分类表与**注册真源**（apply() 里 tools 数组实收的名字）的相等关系由 helpToolTaxonomyProblems 守卫：
// 漏一个 / 多一个 / 重名 / 缺简称 / 非法类别 / 无主简称键 一律返回红因，将来新增工具必然被判红。
export const TOOL_CATEGORIES = Object.freeze([
  "goal", "card", "exec", "memory", "handoff", "ops", "settings", "diag",
]);

export const TOOL_TAXONOMY = Object.freeze({
  graph_create_goal: "goal",
  graph_set_criteria: "goal",
  graph_transition: "goal",
  graph_move_goal: "goal",
  graph_rename_goal: "goal",
  graph_set_goal_type: "goal",
  graph_set_goal_tags: "goal",
  graph_set_relation: "goal",
  graph_amend_goal: "goal",
  graph_set_description: "goal",
  graph_set_directive: "goal",
  graph_add_comment: "goal",
  graph_archive_goal: "goal",
  graph_unarchive_goal: "goal",
  graph_delete_goal: "goal",
  graph_postpone_goal: "goal",
  graph_add_card: "card",
  graph_fill_card: "card",
  graph_review_card: "card",
  graph_delete_card: "card",
  graph_convert_card_to_shared: "card",
  graph_convert_card_to_owned: "card",
  graph_attach_shared_card: "card",
  graph_detach_shared_card: "card",
  graph_list_shared_cards: "card",
  graph_store_attachment: "card",
  graph_delete_attachment: "card",
  graph_bind_collect_card: "card",
  graph_start_attempt: "exec",
  graph_start_review: "exec",
  graph_resolve_accept: "exec",
  graph_record_attempt_handoff: "exec",
  graph_unbind_goal_child: "exec",
  graph_abandon_attempt: "exec",
  graph_write_results: "exec",
  graph_refresh_results: "exec",
  graph_memory_add: "memory",
  graph_memory_replace: "memory",
  graph_memory_remove: "memory",
  graph_memory_recall: "memory",
  graph_handoff: "handoff",
  graph_claim_supervisor: "handoff",
  graph_list_worktrees: "ops",
  graph_clean_worktree: "ops",
  graph_report_status: "ops",
  graph_report_supervisor_status: "ops",
  graph_get_settings: "settings",
  graph_update_settings: "settings",
  graph_validate: "diag",
  graph_rebuild: "diag",
  graph_help: "diag",
});

const TOOL_SHORT_PREFIX = "toolShort.";
const TOOL_CATEGORY_PREFIX = "toolCategory.";
const SHORT_MAX_ZH = 6;   // 负责人要求：简称 2–6 字
const SHORT_MAX_EN = 24;  // 英文同为短标签（不设「字」口径，只防长句）
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * g-489 结构守卫（纯函数）：分类表 + 简称/类别文案 与**注册真源**必须精确相等。
 * 输入是 `apply()` 时 `ctx.tools.register` 的实收工具名 —— 不读本文件的任何第二份清单。
 * `opts` 只用于**负向对照**（注入被变异的字典/分类表），生产调用一律省略。
 * @param {string[]} registeredNames 注册真源里的工具名
 * @param {{dicts?: {zh: Record<string,string>, en: Record<string,string>}, categories?: readonly string[], taxonomy?: Record<string,string>}} [opts]
 * @returns {string[]} 问题清单（空数组 = 全绿）
 */
export function helpToolTaxonomyProblems(registeredNames, opts = {}) {
  const problems = [];
  const zhDict = (opts.dicts && opts.dicts.zh) || zh;
  const enDict = (opts.dicts && opts.dicts.en) || en;
  const categoriesList = opts.categories || TOOL_CATEGORIES;
  const taxonomy = opts.taxonomy || TOOL_TAXONOMY;
  const names = Array.isArray(registeredNames) ? registeredNames.map((n) => String(n)) : [];
  const seen = new Set();
  for (const n of names) {
    if (seen.has(n)) problems.push(`注册真源里工具名重复：${n}`);
    seen.add(n);
  }
  const table = Object.keys(taxonomy);
  const missing = [...new Set(names)].filter((n) => !table.includes(n)).sort();
  if (missing.length) problems.push(`分类表漏掉注册工具（漏一）：${missing.join(",")}`);
  const extra = table.filter((n) => !names.includes(n)).sort();
  if (extra.length) problems.push(`分类表含注册真源之外的工具（多一/残留）：${extra.join(",")}`);
  const catKeys = new Set(categoriesList);
  if (catKeys.size !== categoriesList.length) problems.push(`TOOL_CATEGORIES 有重复类别键：${categoriesList.join(",")}`);
  for (const key of categoriesList) {
    for (const lang of ["zh", "en"]) {
      const dict = lang === "zh" ? zhDict : enDict;
      const value = String(dict[`${TOOL_CATEGORY_PREFIX}${key}`] ?? "").trim();
      if (!value) problems.push(`类别 ${key} 缺 ${lang} 标签`);
      else if (lang === "en" && CJK_RE.test(value)) problems.push(`类别 ${key} 的 en 标签含 CJK`);
    }
  }
  for (const name of table) {
    const cat = taxonomy[name];
    if (!catKeys.has(cat)) problems.push(`工具 ${name} 的类别非法：${JSON.stringify(cat)}`);
    const shortZh = String(zhDict[`${TOOL_SHORT_PREFIX}${name}`] ?? "").trim();
    const shortEn = String(enDict[`${TOOL_SHORT_PREFIX}${name}`] ?? "").trim();
    if (!shortZh) problems.push(`工具 ${name} 缺 zh 简称`);
    else if (shortZh.length > SHORT_MAX_ZH) problems.push(`工具 ${name} 的 zh 简称超过 ${SHORT_MAX_ZH} 字：${shortZh}`);
    if (!shortEn) problems.push(`工具 ${name} 缺 en 简称`);
    else if (shortEn.length > SHORT_MAX_EN) problems.push(`工具 ${name} 的 en 简称超过 ${SHORT_MAX_EN} 字符：${shortEn}`);
    else if (CJK_RE.test(shortEn)) problems.push(`工具 ${name} 的 en 简称含 CJK`);
  }
  // i18n 侧「多一」：简称键必须都有分类条目，否则是残留键（改名/删工具后忘记同步）。
  for (const key of Object.keys(zhDict)) {
    if (!key.startsWith(TOOL_SHORT_PREFIX)) continue;
    const name = key.slice(TOOL_SHORT_PREFIX.length);
    if (!table.includes(name)) problems.push(`简称键无对应分类条目（多一/残留）：${key}`);
  }
  return problems;
}
