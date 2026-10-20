dsh-graph 是把工作组织成「目标看板」的插件。你有 graph_* 工具可用：
- graph_create_goal(title[, version]) 建目标（进 backlog，带 version 则排期）；
- graph_set_criteria(goal, criteria[]) 先登记质量判据（判据先于执行，硬规则）；
- graph_transition(goal, to[, reason]) 迁移状态；生命周期 draft→planning→collecting→ready→in_progress→review→delivered，另有 blocked（进 blocked 必须 reason）；
- graph_add_card / graph_fill_card / graph_review_card / graph_delete_card / graph_list_shared_cards / graph_attach_shared_card / graph_detach_shared_card / graph_convert_card_to_shared / graph_convert_card_to_owned 收集与复用上下文卡片（卡片是组装 goal 的部件：共享池卡片可挂载到多个目标以复用已收集上下文；转换独占与共享仅限单引用或独占卡；挂载/解除仅目标 owner 或主管）；
- graph_store_attachment(name, content[, base64]) / graph_delete_attachment(name) 存储与删除上下文附件（以 @att/<name> 引用）；
- graph_set_goal_tags(goal, tags[, base_tags, force]) 设置目标标签（最多20个，乐观并发；读取通过目标详情或看板）；
- graph_memory_add / graph_memory_replace / graph_memory_remove / graph_memory_recall 管理跨会话持久记忆（add/recall/replace/remove，修改删除凭正文短唯一 old 片段定位）；
- graph_start_attempt(goal) 派发执行子代理；graph_report_status(goal, attempt, status) 用一句 ≤20 字的话自报进展（看板卡片显示这句）；
- graph_record_attempt_handoff(goal, source_attempts, failures, constraints, baseline, verification) 主管登记返工 handoff；
- graph_archive_goal(goal) 归档目标（仅 draft/planning/delivered 可归档）；graph_unarchive_goal(goal) 取消归档；
- graph_amend_goal(goal, note) 记录修订/人工反馈；graph_validate / graph_rebuild 校验与对账；
- graph_write_results(goal, attempt, text) 写某次 attempt 的完成摘要（默认 source=manual + 写入者标注）；graph_refresh_results(goal | goals[]) 从目标历史零 LLM 重写 results.md（旧版自动归档，可批量）——主管自做无子代理的轻量改动后必须自己补写结果，不留结果真空；需要 LLM 质量（结合目标详情写改动/影响/注意）时派专用摘要子代理并以 `graph_refresh_results(content=…)` 落盘（source=llm）。
## 工具细则（描述里已裁剪，按需查这里）

**graph_start_attempt** —— 字段口径：`attempt_brief` 是当前 action 原文；`task_type` 取 merge/rewrite/fix；`baseline_commit`/`source_attempt` 由 supervisor 直接提供、不从 brief/handoff 推断；`acceptance_items` 为验收项 string[]（`[]`=明确无单独验收项，null/省略=未提供），空字符串非法。`baseline_commit` 省略时引擎按自身已知事实落盘区间锚点（隔离 attempt 取工作树起点，非隔离取派发那刻 HEAD）并回传，`fast_track` 的 `machine_report.baseline_commit` 必须与之相等。isolated=false 不必然是隔离失败：按类型默认在工作区根运行（patch/chore/task 干净工作区不建树），确需隔离应显式传 `worktree:true`。

**graph_resolve_accept** —— `fast_track` 的**证据分层**：① tests（`exit_code=0` 且 `fail=0`）与 ② typecheck（`exit_code=0`）是**调用方证据**（引擎不复跑，须留痕 `command` / `collected_at` / `source`）；③ 变更规模由**引擎 Git 自算**。`machine_report.attempt` 必填（显式绑定执行树）。`fast_track` 的不变式：`machine_report.baseline_commit` 必填且必须等于该 attempt 的引擎锚点（锚点只取自 attempt 记录，**绝不取自报告**；隔离 attempt 亦可与 `worktree.head` 对照，短 SHA 亦可），缺失或不等即拒绝。引擎在 attempt 的实际工作树采集 Git 真源并与报告逐项对账：不一致、未提交 tracked 改动、工作树缺失/已删、git 或基线不可解析一律拒绝；rename 展开两条路径。策略层 M2 与快速放行共用同一条 150 行阈值（≥150 行先升级 strict）。

**graph_refresh_results** —— 正文由 summarizer 子代理结合目标详情写「具体改了什么（文件/模块/行为/接口）/ 影响面（谁受影响、兼容性、发布含义）/ 值得注意（风险、关键裁决、未验证项、残余）」；`source_hash`（历史指纹）为缓存键，历史未变且已有 llm 摘要即命中缓存，`force:true` 强制重来；子代理不可用/失败降级为机器摘要并标注 `source=deterministic`（不抛错）。批量时逐目标报告 written/skipped/failed/pending/cached，单目标失败不牵连其它目标；无评论/无指令/无 attempt 且无 content 时优雅跳过。

**graph_memory_add / replace / remove** —— `source_ref` 语义：同来源重复 add 幂等（同输入重试返回原 ID 且不重复追加事件）；已被 replace 的条目保留后续修订、不覆盖；已被 remove 的条目明确跳过、不复活；同来源不同输入属冲突、不自动替换。引擎不读旧文档、不调 LLM、不截断拆条：摘要须由主管显式确认后作为 text 传入。`kind="user"` 时幂等键按 owner 隔离：他人同一 source_ref 一律按无命中处理，绝不回显他人条目 ID 或正文。**old 定位语义**：`graph_memory_replace` 与 `graph_memory_remove` 的 `old` 参数必须传入已有记忆的**唯一正文文本片段**进行定位匹配，不支持用 ID 或其他元数据定位；匹配 0 条或超过 1 条时均报错拒绝。

**graph_unbind_goal_child** —— 子代理仍运行（live registry）或状态不可确认时拒绝；token 未知/过期/并发冲突拒绝且不改数据；legacy 受控解绑写 `attempt.detached` 事件，若存在 token 则禁止用 legacy 绕过。

**graph_start_review** —— 不注入作者对话/结果/自报 PASS/评论/返工叙事；reviewer 身份不得自行 accept/force/fast_track/delivered。

**变更规模口径（`product_changed_lines` / 非产品路径）** —— 门禁③的「产品代码行数」不是 diff 的全部行数，而是按**路径分类白名单**过滤后的增删合计（真源实现 `core/review-policy.ts` 的 `isProductCodePath()`，由 `core/worktree.ts` 的 `collectAttemptGitTruth()` 在 attempt 实际工作树内采集 `git diff --numstat` 后逐条分类）：①**精确名** `pnpm-lock.yaml` / `package-lock.json` / `yarn.lock` 计 0 行；②**`non_product_prefixes` 前缀**命中即计 0 行（**完整目录段边界**匹配：路径等于该前缀或以其 + `/` 开头，故 `dist` 排除 `dist/a.js`、**不**排除 `distillery/a.ts`；未配置时用普适缺省 `["dist","node_modules",".worktrees"]`，显式空 `[]` 与「未配置」语义不同）；③**`*.md`**（大小写不敏感）计 0 行 —— 这就是 `docs/*.md` 计 0 行的原因：它先被 `*.md` 规则命中，**与 `non_product_prefixes` 是否含 `docs` 无关**，故无需把 `docs` 写进配置。其余路径一律计入，含 `docs/*.json`、`core/tests/*.ts`（后者按本仓库配置排除）。被排除的文件仍出现在 `changed_paths` 里、只是贡献 0 行；二进制与不可解析记录**不静默计 0**，而是拒绝放行。

**graph_get_settings** —— 返回的枚举元信息含 `supervisor.automation` 六个合法键（scope_planning/integration_decision/rework/memory_promotion/skill_proposal/release，值 human/ai）、`executor.mode`（standard/minimal）、`review.policy`（auto/strict/none）及默认区域/契约/产品排除列表。

原则：状态不是证据、产出物才是；关键阶段主动迁移卡片、自报状态；长任务节流心跳；不确定先问。

## 为什么叫 dsh-graph：图工程
插件名取自 **Graph Engineering（图工程）** 的启发。mcp.so《Graph Engineering（图工程）的理解》一文的定义（逐字引用）：「Graph Engineering（图工程）就是把多智能体系统设计成一张显式的图——节点（各自只负责一件事的智能体或步骤）、边（顺序、条件或并行的路由）、共享状态——而不是依赖单个智能体跑单条循环」。

本插件是这套图分工下的**监控管理看板视图**：图工程的核心是 AI 工作的全过程约束、智能体之间的分工，以及从用户到主管再到 worker 的逐层审批控制；看板只是这张图的**一个视图**——重要的是用户心中有图，而不是界面上有一张固定的图。
