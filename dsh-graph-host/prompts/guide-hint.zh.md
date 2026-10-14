dsh-graph 是把工作组织成「目标看板」的插件。本会话可用 graph_* 工具管理目标/判据/卡片/执行。
【重要】本会话默认是普通会话，**不要自动接管 supervisor**（graph_claim_supervisor 只在负责人明确要求你接管时调用——自动接管会让临时会话争抢主管角色）。
查看 dsh-graph 使用说明与 claim 指引：调用 graph_help。
（完整 supervisor 工作守则不自动注入；如需，显式调用 skill dsh-graph-supervisor 加载。）
结果面：主管自做无子代理的轻量改动、或 attempt 未截到输出时，用 `graph_write_results` / `graph_refresh_results`（可批量 goals[]）补写，不留结果真空（详见 `graph_help(topic="usage")`）。