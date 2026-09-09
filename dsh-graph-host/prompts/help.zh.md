dsh-graph 是把工作组织成「目标看板」的插件。可用 graph_* 工具：
- graph_create_goal(title[, version]) 建目标（进 backlog，带 version 则排期）；
- graph_set_criteria(goal, criteria[]) 先登记质量判据（判据先于执行，硬规则）；
- graph_transition(goal, to[, reason]) 迁移状态；生命周期 draft→planning→collecting→ready→in_progress→review→delivered，另有 blocked（进 blocked 必须 reason）；
- graph_add_card / graph_fill_card / graph_review_card / graph_delete_card 管理目标下的上下文卡片（信息收集）；
- graph_bind_collect_card(goal, card, child_id) 把收集子代理绑定到卡片；
- graph_start_attempt(goal) 派发执行子代理；graph_report_status(goal, attempt, status) 用一句 ≤20 字的话自报进展；
- graph_record_attempt_handoff(goal, source_attempts, failures, constraints, baseline, verification) 主管登记返工 handoff；
- graph_amend_goal(goal, note) 记录修订/人工反馈；graph_validate / graph_rebuild 校验与对账；
- graph_archive_goal(goal) 归档目标（仅 draft/planning/delivered 可归档）；graph_unarchive_goal(goal) 取消归档；
- graph_report_supervisor_status(status) 主管自报状态（看板顶部状态栏）；graph_resolve_accept 评审裁决；
- graph_handoff() / graph_claim_supervisor() 换会话交接。

## 接管 supervisor
**仅在负责人明确要求你接管 supervisor 时执行**——默认任何会话都不得自动 claim（避免临时会话争抢主管角色）：
1. 旧会话：graph_handoff() —— 生成/更新 .dsh-graph/HANDOFF.md（board 投影 + 长期记忆 + 环境事实）；
2. 新会话：graph_claim_supervisor() —— 把 project.yaml 的 supervisor.session 更新为当前会话 id，记 supervisor.claimed 事件（幂等），并返回 HANDOFF 全文。

完整 supervisor 工作守则（阶段推进/信息收集/执行规范/环境事实等）见 skill dsh-graph-supervisor，显式调用加载。
原则：状态不是证据、产出物才是；关键阶段主动迁移卡片、自报状态；长任务节流心跳；不确定先问。