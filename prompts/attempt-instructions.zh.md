<!-- dsh-graph:phrase:positioningLine1 -->
【本次任务定位】这是一次 {{taskTypeLabel}} 任务；以下仅『本次 attempt brief/directive』为唯一 action 来源；{{historyNotice}}为约束/背景，仅供理解候选设计与禁项，不产生新任务。
<!-- dsh-graph:phrase:positioningLine2 -->
你是 dsh-graph 目标 {{goal}} 的执行 attempt {{attempt}}。
<!-- dsh-graph:phrase:goalRelInlined -->
目标文件精确路径（工作目录相对）：{{goalRel}}（目标描述与质量判据已在下方基于当前快照内联，请直接依据执行；如需历史评论/台账可按需查阅，无需无条件重读全文）。
<!-- dsh-graph:phrase:goalRelPlain -->
目标文件精确路径（工作目录相对）：{{goalRel}}——用 read 工具读它，不要自己猜路径。
<!-- dsh-graph:phrase:briefHeading -->
## 本次 attempt brief/directive
<!-- dsh-graph:phrase:briefOnlySource -->
唯一 action 来源：以下两项当前数据；历史 handoff、卡片和通用纪律均不产生新任务。
<!-- dsh-graph:phrase:briefPriority -->
brief 优先于 directive：brief 是当前任务的直接描述，directive 是目标文件中的背景指令；两者冲突以 brief 为准。
<!-- dsh-graph:phrase:briefContextLabel -->
目标背景（来自当前 goal.md，仅供理解，不产生 action）
<!-- dsh-graph:phrase:overrideHeading -->
## 覆盖声明
<!-- dsh-graph:phrase:overrideRule -->
覆盖声明：本段与上文 handoff 不一致处，一律以本段为准（列出覆盖点：task_type、baseline_commit、source_attempt、acceptance_items）。
<!-- dsh-graph:phrase:overrideTaskType -->
- 任务类型（当前 attempt 数据）：{{taskTypeLabel}}
<!-- dsh-graph:phrase:overrideBaseline -->
- 权威基线 commit（当前 attempt 数据）：{{baselineFact}}
<!-- dsh-graph:phrase:overrideSourceAttempt -->
- 真正前序 attempt 身份（当前 attempt 数据）：{{sourceAttemptFact}}
<!-- dsh-graph:phrase:overrideAcceptance -->
- 当前验收项（当前 attempt 数据）：{{acceptanceFact}}
<!-- dsh-graph:phrase:overrideProvenance -->
以上字段由 supervisor 通过独立参数直接传入；不从 brief/directive、handoff 或卡片截取/推断。
<!-- dsh-graph:phrase:overrideHandoff -->
- 历史 handoff：{{handoffState}}
<!-- dsh-graph:phrase:structuredState -->
【结构化状态字段】每次调用 graph_report_status 除 status 外必须传 state，且只能是 working、blocked、done、error；看板状态判定优先读取该字段，status 文本仅供展示。
<!-- dsh-graph:phrase:disciplineHeading -->
## 通用执行纪律
<!-- dsh-graph:phrase:disciplinePreface -->
以下内容是通用纪律与环境约束，不产生本次任务 action；本次 action 只来自当前 brief/directive。
