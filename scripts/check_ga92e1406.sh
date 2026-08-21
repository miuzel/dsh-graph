#!/usr/bin/env bash
# g-a92e1406 验收脚本 —— 由规划方（supervisor）在 planning 时编写并冻结（R-03）。
# 执行方不得修改本文件；如需变更走判据变更流程。
# 验证：client.js 静态取证——流动背景/图标动画、modal 标题下状态摘要、近期动态收录汇报。
# 浏览器逐条实测为判据第 4 条，由负责人人工执行。
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
awk '/function GoalModal/,/^    }$/' "$C" | grep -q "status_line" \
  || { echo "FAIL: modal 未渲染 status_line"; exit 1; }

echo "== 4. 状态汇报履历进入近期动态白名单 =="
grep -q '"attempt.status_reported"' "$C" \
  || { echo "FAIL: attempt.status_reported 未出现"; exit 1; }
awk '/const MEANINGFUL = new Set/,/]);/' "$C" | grep -q "attempt.status_reported" \
  || { echo "FAIL: MEANINGFUL 白名单未含 attempt.status_reported"; exit 1; }

echo "PASS: g-a92e1406 静态验收全部通过"
