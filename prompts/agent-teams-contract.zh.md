<!-- dsh-graph:agent-teams-contract:begin -->
**Agent Teams 最小契约（单 attempt 内扇出 + 独立验证者；仅负责人勾选启用后才注入派发提示词）**：
- **扇出成员不是 attempt**：单 attempt 内可把**只读或互不重叠**的工作面并行派给若干**成员**（复用 harness 原生 subagent/workflow）。成员不分配 attempt ID、不建 worktree、不占看板、不改「一目标一活跃 attempt」投影；attempt 生命周期是唯一收口——结束前每个成员必须「已汇总」或明确记为放弃/超时，**不留悬挂成员**。
- **上限与写纪律**：成员数 **N ≤ 3**；无明显独立并行面时不扇出（默认单线程）；写型任务只能分区（互不重叠文件集）或串行；成员一律**不得**自行 commit / branch / push（沿用 worktree 纪律），且不继承父模型路由。
- **独立验证者**：由作者之外的成员复核其中若干块；**作者自报不得冒充独立验证**——作者自己的输出、自查、以及作者自派的评审（记为 `self_requested`）**一律不算独立验证**；独立验证须引用**角色/来源**。
- **结论词表（闭集）**：`PASS` / `BLOCK` / `UNVERIFIED`（**不得**使用 FAIL）。
- **留痕（A 档）**：固定小节写在 attempt 完成摘要内，标题 `## 扇出与独立验证`（en 对偶 `## Fan-out and independent verification`），每行一条、键为 ASCII（占位符须替换为真实值，不得原样照抄）。
- member 行格式：`- member: name=<成员> scope=<范围> status=<done|abandoned|timeout> conclusion=<PASS|BLOCK|UNVERIFIED> evidence='<单行证据>'`
- verify 行格式：`- verify: review=<review_id> scope=<被审块> conclusion=<PASS|BLOCK|UNVERIFIED> source=<independent|self_requested|author>`
- **证据引用**：`review` 必须指向真实留痕 `<goalDir>/reviews/<review_id>.md`；**没有对应记录就不得声称独立验证**；遵守结果面纪律（单行 evidence，禁多行日志倾倒）。
- **降级（fail-safe：不失败、只降级）**：扇出需子代理深度 ≥ 2；环境不支持或深度 < 2 时**静默降级**为现有单子代理路径，不报错、不阻断，并在结果中如实登记降级原因；已勾选但成员失败/超时 ⇒ 如实登记放弃状态，**不得计入 PASS**。
<!-- dsh-graph:agent-teams-contract:end -->