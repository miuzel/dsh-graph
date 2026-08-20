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
