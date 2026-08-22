---
{
  "id": "card-ee78c929",
  "goal": "g-130",
  "title": "确认：append 剥离标题边界（剥离 vs 告警；纯标题 append 行为）",
  "kind": "text",
  "status": "reviewed",
  "filled_by": "agent:session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36",
  "filled_at": "2026-08-22T16:53:58+08:00",
  "content_ref": null,
  "summary": "append 规范化规格：①开头 ##/# 标题→剥离保留正文；②只含标题无正文→抛 GraphError（原子，不写入）；③正文中 h2 降级为 h3（代码围栏内不处理）；④首尾空行清理。事件 details 加 append_normalized 标记（不静默）。实现：normalizeAppend 纯函数 + amendGoal 调用，需跑 sync-core.sh。测试 10 项核心 + 2 项端到端。可选：validate() 增重复小节不变式。现状：amendGoal 无任何标题约束（L1369-1396），重复小节坑靠 guide 文案不强制。",
  "child_id": "34a09829-4144-40b1-b382-60aeb94a7b11",
  "parent_session_id": "session-5f6bf96d-1abf-46da-aa7c-bc99e32d7b36"
}
---

# g-130 调研：graph_amend_goal append 标题剥离边界规格

## 现状
- amendGoal（core/ops.ts L1369-1396）：append 逐字插入，**无标题剥离/告警/报错**——重复小节靠 supervisor-guide 文案约束，核心零强制；
- 症状链：append 带 `## 目标描述` → body 两个同名 h2 → 看板 section() 取第一个 → 显示占位「待填写」→ 二次 amend 插入位置错乱；
- 事件不可追溯：goal.amended details 只有 note；
- validate() 无「重复小节」检查；测试零覆盖标题/边界场景。

## 边界规格（4 种情况）
1. **开头 `## `/`# ` → 剥离标题保留正文**（`### ` 开头不剥离——h3 是正文合法子结构）；事件 details 加 append_normalized: true；
2. **只含标题无正文 → 抛 GraphError**（"append 只含标题没有正文"），任何写入前抛，原子；纯空白视为未传（跳 append 仍记 note）；
3. **正文中 h2 → 降级为 `### `**（不报错，GUI 粘贴友好）；代码围栏（``` / ~~~）内不处理（~10 行扫描器）；`### ` 保留；
4. **格式规范**：剥离首尾空行、首行无前导空行。

## 测试建议（10 核心 + 2 端到端）
纯正文不变/开头 ## 剥离/# 剥离/只标题抛错（原子）/中段 h2 降级/围栏内不动/纯空白跳过/二次 amend 无重复/else 新建分支规范化/append_normalized 标记；plugin edit-description 端到端。

## 实现草案
normalizeAppend(raw) 纯函数（H 正则 /^[ \t]{0,3}#{1,2}[ \t]+\S/，围栏跟踪）+ amendGoal 内调用（校验先于写入）；向后兼容（无标题 append 逐字节不变）。

## 决策点（待主管/负责人拍板）
1. 情况 3 降级 h2→h3 vs 报错（推荐降级）；
2. `### ` 开头是否剥离（推荐保留）；
3. 是否顺带加 validate() 重复小节不变式（推荐加）。

（纯调研，未改任何文件。）
