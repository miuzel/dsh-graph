#!/usr/bin/env bash
# g-a92e1406 验收脚本 —— 由规划方（supervisor）在 planning 时编写并冻结（R-03）。
# 执行方不得修改本文件；如需变更走判据变更流程。
# 验证：client.js 静态取证——流动背景/图标动画、modal 标题下状态摘要、
#       modal tab 结构（详情/近期动态）、近期动态收录汇报、被复用徽章。
# 浏览器逐条实测为判据第 3 条，由负责人人工执行。
#
# 修订记录（仅规划方可改，均先于执行）：
#   v1（初版）：动画、modal status_line、MEANINGFUL 收录。
#   v2：发现#23 依赖徽章修复移交 g-108（判据 5），本脚本不覆盖。
#   v3：补 modal tab 结构断言（第 4 条）与「被复用」徽章断言（第 6 条），
#       对应负责人补充的 tab 承载要求与会话复用政策；
#       断言使用专名标记 dg-tab / 被复用，避免真空通过。
#   v4：修复 SIGPIPE 竞态（att-004 上报）——awk|grep -q 在 pipefail 下 grep 提前
#       退出致 awk SIGPIPE 间歇 FAIL；item3/item5 改 grep "…">/dev/null 读完再退。
set -euo pipefail
cd "$(dirname "$0")/.."
C=dsh-graph-client/lib/client.js

echo "== 0. 语法 =="
node --check "$C"

echo "== 1. 流动背景动画与图标动画（CSS keyframes） =="
grep -q "@keyframes" "$C" || { echo "FAIL: 无 keyframes 动画定义"; exit 1; }
grep -q "animation" "$C"  || { echo "FAIL: 无 animation 应用"; exit 1; }

echo "== 2. 运行动画只作用于状态摘要行（⏳），阻塞行（⛔）不动画 =="
# 状态行必须使用带动画的类/样式；阻塞行保持静态（statusLine 样式直用、无动画类）
grep -q "dg-running\|dg-flow\|dg-pulse" "$C" \
  || { echo "FAIL: 缺运行动画类（dg-running/dg-flow/dg-pulse 之一）"; exit 1; }

echo "== 3. modal 标题下方显示状态摘要 =="
# GoalModal 内渲染 attempts 的 status_line
awk '/function GoalModal/,/^    }$/' "$C" | grep "status_line" >/dev/null \
  || { echo "FAIL: modal 未渲染 status_line"; exit 1; }

echo "== 4. modal 改为 tab 结构（详情 / 近期动态） =="
# tab 承载：GoalModal 内须有 tab 切换实现，近期动态不再只是纵向一节
grep -q "dg-tab" "$C" \
  || { echo "FAIL: 缺 dg-tab 标记（modal 未做 tab 结构）"; exit 1; }
grep -q "近期动态" "$C" || { echo "FAIL: 缺「近期动态」tab 标签"; exit 1; }
grep -q "详情" "$C"     || { echo "FAIL: 缺「详情」tab 标签"; exit 1; }

echo "== 5. 状态汇报履历进入近期动态白名单 =="
grep -q '"attempt.status_reported"' "$C" \
  || { echo "FAIL: attempt.status_reported 未出现"; exit 1; }
awk '/const MEANINGFUL = new Set/,/]);/' "$C" | grep "attempt.status_reported" >/dev/null \
  || { echo "FAIL: MEANINGFUL 白名单未含 attempt.status_reported"; exit 1; }

echo "== 6. 被复用徽章（同一 child 跨目标绑定时旧绑定打标） =="
grep -q "被复用" "$C" \
  || { echo "FAIL: 缺「被复用」徽章文案"; exit 1; }

echo "PASS: g-a92e1406 静态验收全部通过"
