dsh-graph 是把工作组织成「目标看板」的插件。可用 graph_* 工具（共 44 个）：

## 目标生命周期
- graph_create_goal(title[, version][, type]) 建目标（进 backlog，带 version 则排期；type 可选 feature/bug/task/improvement/patch/chore）；
- graph_transition(goal, to[, reason]) 迁移状态；生命周期 draft→planning→collecting→ready→in_progress→review→delivered，另有 blocked（进 blocked 必须 reason）；
- graph_archive_goal(goal) 归档目标（仅 draft/planning/delivered 可归档）；
- graph_unarchive_goal(goal) 取消归档；
- graph_delete_goal(goal) 删除已归档目标（含卡片/attempts）；
- graph_postpone_goal(goal[, reason]) 暂缓目标（移回 backlog，置为 draft）；
- graph_rename_goal(goal, title) 重命名目标。

## 目标内容
- graph_amend_goal(goal, note[, append]) 记录修订/人工反馈；note 为修订备注，append 追加进描述正文；
- graph_set_description(goal, description) 就地编辑目标描述（description 空则清空）；
- graph_set_directive(goal, directive) 设置下一次 attempt 的补充指令（空则清空）；
- graph_set_goal_tags(goal, tags[, base_tags][, force]) 设置标签（≤20 个；base_tags 为乐观并发基线，force 强制覆盖）；
- graph_set_goal_type(goal, type) 设置类型 feature/bug/task/improvement/patch/chore；
- graph_move_goal(goal, to[, version]) 移动目标：backlog ↔ 独立 goals/ ↔ 版本；
- graph_add_comment(goal, text) 追加评论/反馈到 Comments 小节。

## 判据·卡片·附件
- graph_set_criteria(goal, criteria[]) 先登记质量判据（判据先于执行，硬规则）；
- graph_add_card(goal, title[, kind][, scope]) 创建上下文卡片（默认 shared；scope="goal" 为自有卡）；
- graph_fill_card(goal, card[, text][, content_ref][, summary]) 填充卡片正文（可用 @att/<name> 引用附件；content_ref 仅兼容读取）；
- graph_review_card(goal, card) 复核已填充卡片（filled → reviewed）；
- graph_delete_card(goal, card) 删除卡片（collecting 状态不可删）；
- graph_convert_card_to_shared(goal, card) 自有卡 → 共享卡；
- graph_convert_card_to_owned(goal, card) 共享卡 → 自有卡（引用计数须为 1）；
- graph_store_attachment(name[, content][, base64]) 存储附件（text 用 content，二进制用 base64）；
- graph_delete_attachment(name) 删除附件（仍被引用则拒绝）；
- graph_bind_collect_card(goal, card, child_id[, parent_session_id][, provider][, model]) 绑定收集子代理到卡片。

## 执行与返工
- graph_start_attempt(goal[, card][, executor][, provider][, model][, reasoning_effort][, mode][, worktree][, attempt_brief][, task_type][, baseline_commit][, source_attempt][, acceptance_items]) 派发执行子代理；
- graph_record_attempt_handoff(goal, source_attempts[], failures, constraints, baseline, verification) 主管登记返工约束；
- graph_unbind_goal_child(goal, {attempt|child_id}[, token][, reason][, legacy]) 安全解绑执行子代理（token 走严格 CAS；遗留绑定无 token 时须显式 legacy=true 并给 reason）；
- graph_abandon_attempt(goal, attempt, reason) 标记 attempt 为已放弃；
- graph_resolve_accept(goal, verdict[, objection][, force][, reason][, fast_track][, machine_report]) 主管裁决接受请求（accept/object）；fast_track=true 走机器快速放行：须策略判定 auto 且 machine_report 四项门禁全绿（tests/typecheck exit_code=0、产品代码 <150 行且无未跟踪新文件、判据全部 ✅已验，由引擎自算），返回 {ok, fast_track}。

## 校验对账
- graph_validate() 全量校验不变量（状态、归属、判据、依赖环、卡片引用）；
- graph_rebuild() 从事件流重建状态并与 frontmatter 对账。

## 记忆管理
- graph_memory_add(kind, text[, scope][, importance][, source_goal]) 新增记忆（scope: on_demand 默认 / standing 常驻；source_goal 关联来源目标）；
- graph_memory_replace(old, text[, kind][, importance][, source_goal]) 修正已有记忆（old 定位，text 为新内容，source_goal 关联来源目标）；
- graph_memory_remove(old[, reason]) 删除记忆（须确认过时或撤回）；
- graph_memory_recall([query][, kind][, limit]) 检索记忆。

## 协同交接
- graph_handoff([query][, memory_limit]) 换会话交接（生成 HANDOFF.md：board 投影 + 记忆 + 环境事实）；
- graph_claim_supervisor() 新会话接管 supervisor（幂等，返回 HANDOFF 全文）。

## 工作树·状态·配置
- graph_list_worktrees([goal]) 查询 worktree 清理候选（只读）；
- graph_clean_worktree(id, confirm) 清理已验证的 worktree（默认保留分支）；
- graph_report_status(goal, attempt, status[, state]) 上报 attempt 状态（state: working/blocked/done/error，可选）；
- graph_report_supervisor_status(status) 主管自报状态（看板顶部状态栏）；
- graph_get_settings() 只读查询项目配置及合法枚举元信息；
- graph_update_settings(patch) 更新项目配置（schema 校验、保留注释、原子写）。

## 帮助
- graph_help() 显示本帮助（全部 44 个工具清单与参数速查）。

## 接管 supervisor
**仅在负责人明确要求你接管 supervisor 时执行**——默认任何会话都不得自动 claim：
1. 旧会话：graph_handoff() —— 生成 HANDOFF.md；
2. 新会话：graph_claim_supervisor() —— 更新 supervisor.session，返回 HANDOFF 全文。

完整 supervisor 工作守则见 skill dsh-graph-supervisor，显式调用加载。
原则：产出物才是证据；关键阶段主动迁移卡片、自报状态；长任务节流心跳；不确定先问。
