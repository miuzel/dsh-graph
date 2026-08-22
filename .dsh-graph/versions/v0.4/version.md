---
{
  "id": "v-004",
  "name": "v0.4 单包时代（0.4.x）",
  "status": "active",
  "created_at": "2026-08-22T13:02:00+08:00"
}
---

## 版本目标
单包 dsh-graph 0.4.x 时代（g-116 合并单包后）：功能演进与对外发布。
承接全部 0.4.x 单包时代目标（含 g-111~g-113——其发布产物实为 0.4.0/0.4.1，见 g-126 对齐）。

## 范围
<!-- 受管小节：引擎按 goals/ 目录维护 -->
- g-111 对外发布与插件商店上架（实际发布版本 0.4.0/0.4.1）⛔ blocked
- g-112 root 通用化：数据目录解析与初始化 ✅ delivered
- g-113 dsh-graph 新项目开箱即用 ✅ delivered
- g-116 合并单包：dsh-graph-client 并入 dsh-graph-host ✅ delivered
- g-117 supervisor 会话交接：一键 handoff + 自动更新主管会话 id ✅ delivered
- g-118 supervisor 守则自动注入 ✅ delivered
- g-119 收集卡绑定工具 + supervisor skill 绑定约束 ✅ delivered
- g-120 执行派发注入已收集卡片成果 ✅ delivered
- g-121 HANDOFF 旧版归档 ✅ delivered
- g-122 dummy：g-120 实机验证 ✅ delivered
- g-123 dummy2：负责人 GUI 手动验证执行注入 ✅ delivered
- g-124 状态行改进：tooltip 延续时长 + 结束工作前更新 status ✅ delivered
- g-125 看板卡片精简：交付/阻塞默认折叠 + 摘要折叠 2 行 ✅ delivered
- g-126 看板版本泳道与包版本对齐 🚧 in_progress

## 范围说明
g-126 对齐（2026-08-22 负责人确认方案 A）：0.4.x 单包时代（0.4.0 @ 8/22 10:24 已发）
的全部目标归入本泳道；0.3.x 两包时代（0.3.0/0.3.1/0.3.2）目标留在 v0.3 泳道并标记 released。

## 集成测试决策
（待）

## 人工测试与测试数据
（待）

## 发布记录
- 0.4.0 released @ 2026-08-22 10:24（g-116 单包合并版，npm 已发；不含 g-117 工具）
- 0.4.1 待发（含 g-117 graph_handoff/graph_claim_supervisor，负责人执行）
