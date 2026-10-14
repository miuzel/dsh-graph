<!-- dsh-graph:automation-guidance:begin -->
<!--
  g-496：六键自动化动作指导的**唯一正文真源**（zh）。
  本文件是「数据资产」：宿主 `renderAutomationGuidance` 读取后按 `@@<字段>` 分块解析，
  **结构/门控/语言回落/空串语义**全部仍在代码里（本文件只有正文，不含任何判断逻辑）。

  字段说明：
  · `@@header` / `@@confirm` / `@@autonomous` / `@@trailer` —— 段首、human 子句、ai 子句、段尾；
  · `@@action.<key>` / `@@boundary.<key>` —— 六键各自的**动作**与**边界**正文。
  六键键名是**闭集**，与代码里 `AUTOMATION_GUIDANCE_KEYS` 一一对应；缺块/多块都会 fail-closed。
-->
@@header
⚠️ **自动化动作指导**（来自本 workspace 的 supervisor.automation 配置）：
@@confirm
请就此动作请求负责人确认
@@autonomous
在已授权范围内自主判断并留痕
@@action.scope_planning
**范围/排期与版本计划调整**
@@boundary.scope_planning
不是首次 start 授权
@@action.integration_decision
**候选选择与合入取舍**
@@boundary.integration_decision
不是 review verdict / delivered 授权
@@action.rework
**既有目标返工取舍**
@@boundary.rework
不授权首次 start、不自动批准扩大范围
@@action.memory_promotion
**记忆提炼**
@@boundary.memory_promotion
不绕 standing 特权：仍默认 on_demand，standing 仅限人类常驻指令/安全禁令且 ≤200 字
@@action.skill_proposal
**是否提出 skill 沉淀建议**
@@boundary.skill_proposal
不等于安装或发布
@@action.release
**发布决策**
@@boundary.release
release=ai 也不能单独放行 delivered
@@trailer
边界与优先级（只增不减）：human 只增加确认要求，绝不被低风险豁免覆盖；负责人明确、范围清楚的批量授权可覆盖其**列明动作**的逐项询问，笼统方向授权不构成覆盖；明确禁 push/publish/tag 永远优先；Full access 不是业务批准。四类 gate 中「开始工作」与「审核」没有对应键，其既有要求（含 review→delivered 必须等负责人 verdict）保持不变。本指导只影响提示，不改变工具权限，也不构成引擎强制。
<!-- dsh-graph:automation-guidance:end -->
