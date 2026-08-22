#!/usr/bin/env bash
# g-124 验收脚本 —— 状态行改进：tooltip 显示状态延续时间 + supervisor/子代理结束工作前更新 status。
# 执行方（att-001）编写；如需变更走判据变更流程（R-03）。
# 验证点：
#   1. client.js staleStatus 分支显示状态延续时长（statusAt 距今），不再显示「🔄 等待最新状态…」；
#   2. supervisor-guide.md 含「结束工作前更新 status 为完成态（空闲待命）」规范；
#   3. host/index.js 两处 spawn 提示词（graph_start_attempt 工具 + start-execution 端点）
#      均含「结束工作前更新 status」指令（≥2 处）；
#   4. 核心单测回归 + 语法检查。
set -euo pipefail
cd "$(dirname "$0")/.."
C=dsh-graph-host/lib/client.js
G=dsh-graph-host/supervisor-guide.md
H=dsh-graph-host/index.js

echo "== 0. 语法 =="
node --check "$C"

echo "== 1. client staleStatus 分支显示状态延续时长，不再显示等待占位 =="
grep -q "状态延续" "$C" || { echo "FAIL: client.js 缺延续时长显示（状态延续）"; exit 1; }
! grep -q "等待最新状态" "$C" || { echo "FAIL: client.js 仍残留「🔄 等待最新状态…」占位"; exit 1; }
grep -q "fmtElapsed" "$C" || { echo "FAIL: client.js 缺延续时长格式化函数 fmtElapsed"; exit 1; }

echo "== 2. supervisor-guide 含「结束工作前更新 status 为完成态」规范 =="
grep -q "结束工作前" "$G" || { echo "FAIL: supervisor-guide 缺「结束工作前」规范"; exit 1; }
grep -q "空闲待命" "$G" || { echo "FAIL: supervisor-guide 缺完成态示例（空闲待命）"; exit 1; }
! grep -q "等待最新状态" "$G" || { echo "FAIL: supervisor-guide 仍引用已废弃的等待占位文案"; exit 1; }

echo "== 3. host 两处 spawn 提示词均含结束前更新 status 指令 =="
n=$(grep -c "结束工作前更新 status" "$H" || true)
[ "$n" -ge 2 ] || { echo "FAIL: host/index.js 指令只出现 $n 次（应 ≥2：graph_start_attempt + start-execution）"; exit 1; }
# 两处分别落在工具提示词与端点提示词（用上下文锚点区分）
awk '/【状态汇报——你自己做，supervisor 不会替你更新】/,/完成时用 graph_report_status 汇报最终状态/' "$H" \
  | grep -c "结束工作前更新 status" | grep -q "^2$" \
  || { echo "FAIL: 两处 spawn 提示词未各自包含结束前更新指令"; exit 1; }

echo "== 4. 核心单测回归 =="
node --test core/tests/*.test.ts > /dev/null

echo "PASS: g-124 静态验收全部通过"
