---
{
  "id": "mem-001",
  "type": "success-graph",
  "source_goal": "g-001, g-003",
  "promoted_by": "supervisor",
  "promoted_at": "2026-08-20T19:20:00+08:00",
  "status": "active"
}
---

## 核心层目标的成功路径（v0.1）

适用于"实现引擎/工具类"目标的可复用模式：

1. **planning 即冻结验收脚本**：把判据中的 `[script]` 项在 planning 时写成可运行脚本
   （含合法路径 + 必须失败的反向用例），执行期不许改——首跑失败暴露设计缺陷是常态
   （g-001 的 rules_snapshot、g-003 无此问题），改设计而不是改脚本；
2. **引擎强制不变式，不靠自觉**：状态机闸、判据闸、rebuild 对账都在引擎里；
   本次两个目标共抓出 7 个流程/schema 缺陷（见 g-002 证据台账），全部来自
   "引擎实报"或"脚本首跑失败"，无一靠人工 review 发现；
3. **文件移动即排期**：归属变更 = `mv` + `goal.moved` 事件，不是状态迁移；
4. **履历顺序**：先 completion.claimed 再 transition→review（g-003 曾颠倒，无害但
   不规范，goal-loop 模块应把声明做成迁移前置）。

## 反模式（失败模式）

- 把排期移动记成 `goal.transition`（to 填路径）——污染 replay；
- 用 DSH goal 自动续轮驱动人工 gate 流程——冲过所有人工决策点；
- 手工填 rules_snapshot——应引擎自动快照。

## 建卡描述的正确姿势（2026-08-22 踩坑）

- `graph_create_goal` 生成的 body 是固定模板，**不支持初始描述**（GOAL_BODY 占位
  「（待填写）」）；
- 补描述用 `graph_amend_goal(goal, note=..., append=...)`，**append 只传正文内容，
  绝不自带「## 目标描述」标题**——amendGoal 内部 replace 已把内容并入目标描述
  小节；自带标题会产生重复小节，看板取第一个（「（待填写）」）显示（g-119/g-120
  教训，负责人 2026-08-22 指出）；
- 同理 append 里也不要带「## 补充」等顶级标题：它会插到描述小节内。

## in_progress 前征得负责人同意（2026-08-22 指示）

- 目标移入 `in_progress` 前**必须询问负责人同意**（除非 profile 自动授权模式）——
  不能凭「判据已登记」默认放行；判据确认 ≠ 执行放行，是两个 gate；
- 已入 supervisor-guide「不可妥协#4」与「阶段推进规范#2」。

## supervisor status line 持续更新（2026-08-22 负责人指出）

- guide 原只有「每轮开始第一时间」报状态 → 不够：大部分时间没更新，
  看板顶部长期显示过期 status（负责人 2026-08-22 指出）；
- 加强：**每完成一个动作/阶段变化都立即更新**（派发/回填/复核/提交/迁移/
  等输入空窗期报「正在等 X」）——与执行子代理「每做一个动作就写一句」对等；
- 已入 supervisor-guide「执行规范」首条。

## 再踩：append 自带标题（2026-08-22 g-122）

- 即使 guide 已沉淀「append 只传正文、不自带标题」，g-122 建卡时又犯——
  说明仅文档化不够，需在工具层防呆：graph_amend_goal 若检测到 append 以
  「## 」开头的 Markdown 标题，应告警或剥离（待排期 hardening）。

## supervisor status 执行纪律（2026-08-22 二次指出，仍是执行问题非 guide 问题）

- 负责人两次指出「看板一直显示🔄 等待最新状态…」——guide 已写「每轮开始立即+持续更新」，
  但**实际执行仍没做到**：轮首先做建目标/派发/回填等动作，把报状态推迟到中途；
- **硬性执行规则**：每个 turn 的**第一个工具调用必须是 graph_report_supervisor_status**，
  之后每个动作（派发/回填/迁移/复核/提交）后紧跟一次；不要等有「实质进展」才报，
  「正在做什么」本身就是有效状态；
- 看板「🔄 等待最新状态…」= 客户端已清空过期状态在等我替换，出现即证明我失职。

## append 自带标题第三次踩坑 + start_attempt 后状态检查（2026-08-22 g-124）

- g-119/g-120/g-124 连续三次：graph_amend_goal 的 append 参数自带「## 目标描述」标题
  → goal.md 重复小节、看板显示「（待填写）」。guide 已沉淀仍执行犯——**必须工具层防呆**：
  amendGoal 检测 append 以 Markdown 标题（/^##?\s/）开头时自动剥离标题或告警（排期 hardening，
  建议独立 backlog 目标）；
- 写 goal.md 描述的正确姿势：append 只传正文，用「首行即内容」格式；或先 amend 空 append
  再单独编辑文件（保持事件先行）。
- startAttempt 派发后：frontmatter 可能因缓存读成旧状态，以事件流/工具返回为准（g-121/g-124
  误判过滞留，实际已 in_progress）。

## 复核通过后必须立即迁 delivered（2026-08-22 g-124）

- g-124 复核通过+代码合并推送后，漏掉 review→delivered 状态迁移（看板停在确认 lane，
  负责人指出）——技术复核通过 ≠ 状态落定，两件事都要做；
- 规则：代码合并/验收通过那一刻，立即 graph_transition(review→delivered) 并补 graph_validate。
