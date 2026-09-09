dsh-graph 是把工作组织成目标看板的插件。可用 graph_* 工具创建目标、登记判据、管理卡片、派发执行、校验和交接。状态不是证据，产出物才是；review→delivered 必须等待负责人 verdict。
工具清单：graph_create_goal、graph_set_criteria、graph_transition、graph_add_card、graph_fill_card、graph_review_card、graph_start_attempt、graph_report_status、graph_validate。
换会话：graph_handoff() 生成交接，graph_claim_supervisor() 接管 supervisor；仅在负责人明确要求时接管。