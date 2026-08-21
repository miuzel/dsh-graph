# mem-005：状态摘要动画、modal tab、被复用派生与 supervisor 状态栏（g-a92e1406 交付模式）

source_goal: g-a92e1406（versions/v0.3/goals/g-a92e1406），交付于 1168aa0

## 模式
- **运行态动画**：status_line 统一走 `StatusLine(running)`（class `dg-running-flow`），
  流动背景 keyframes + 图标 pulse/spin；`running` = 有 status_line 且非 blocked，
  ⛔ 阻塞行走静态 `S.statusLine`。动画强度要够（渐变 alpha 0.30/0.42 + inset 轮廓），
  太淡在低对比度显示器不可辨（负责人 checklist 反馈实例）。
- **modal tab 一体**：选中页签「上圆角 + 与面板同底色 + marginBottom:-1 覆盖分隔线」，
  未选中扁平透明，面板承接分隔线包住内容——区别于按钮、页签连着面板。
- **被复用徽章派生（boardProjection，host 半边）**：同一 child_id 跨目标绑定时旧绑定标
  `reused_by`。双源：① `attempt.reused` 事件（权威方向 goal→details.reused_by，取 "/" 前段）
  ② 绑定记录兜底（无事件时按 attempt_started_at 定旧新）。**不要用数组/目录序猜旧新**——
  readdir 字母序≠时间序，会把 g-107/g-108 双卡都错标成「被复用→g-107」。
- **supervisor 状态栏**：supervisor 不在 goals 体系，不能复用 reportStatus，走独立
  `supervisor.status_reported` 事件 + `graph_report_supervisor_status` 工具 + board 下发
  `supervisorStatus`，client SupervisorBar 传 statusLine 复用同一 LiveStrip 动画分支。

## 教训
- **冻结脚本 SIGPIPE 竞态**：`awk '…' | grep -q '…'` 在 `set -o pipefail` 下，grep -q 匹配即退、
  awk 未写完被 SIGPIPE，client.js 输出超 ~10KB 后间歇 FAIL（易误判为「文件写入抖动」）。
  修法：管道里改 `grep "…" >/dev/null`（读完再退）；直接 `grep -q "$file"` 无管道不受影响。
- **验证纪律**：子代理「修复完成」必须逐行对照代码——att-001 第三轮声明与代码不符
  （ph=true 仍隐藏正文）、att-004 虽越权「只确认不改」却修掉 3 个真缺陷（其中两处是判据必败）。
  脚本 PASS 是必要非充分。
- **checklist 反馈驱动返工**：负责人在 modal 判据 checklist 上逐条 💬 反馈 → 同 attempt 小修，
  返工即 review→in_progress→review，每次记 amend。判据 3 六点全走这条链收敛。
