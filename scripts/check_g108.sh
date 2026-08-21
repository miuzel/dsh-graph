#!/usr/bin/env bash
# g-108 验收脚本 —— 由规划方（supervisor）在判据确认时编写并冻结（R-03）。
# 执行方不得修改本文件；如需变更走判据变更流程。
# 验证：看板顶部 supervisor 状态栏（复用 LiveStrip、跳转对话 tab）、
# 会话 id 来自 project.yaml（不硬编码）、board 端点下发（字段名 supervisorSession）。
# 浏览器逐条实测为判据第 4 条，由负责人人工执行。
# 注意：检查项必须用实现前不存在的判别标记（首版用 supervisor/LiveStrip 被
# 存量代码虚过，planner 修订：改用 dg-supervisor / supervisorSession 专名）。
# planner 修订 2（执行中范围补充，负责人指示）：新增判据 5 依赖徽章状态化检查。
# planner 修订 3（att-004 上报，SIGPIPE 竞态）：awk|grep -q 在 pipefail 下 grep 提前退出
# 使 awk SIGPIPE 间歇 FAIL（client.js 输出量增大后高频触发）；item3 改 grep "…">/dev/null 读完再退。
set -euo pipefail
cd "$(dirname "$0")/.."
C=dsh-graph-client/lib/client.js

echo "== 0. 语法 =="
node --check "$C"

echo "== 1. 顶部 supervisor 状态栏存在且复用 LiveStrip =="
grep -q "dg-supervisor" "$C" || { echo "FAIL: 缺顶部状态栏（dg-supervisor 标记）"; exit 1; }

echo "== 2. 状态栏数据来自 board 端点下发字段 supervisorSession（不硬编码会话 id） =="
grep -q "supervisorSession" "$C" \
  || { echo "FAIL: client 未消费 supervisorSession 字段"; exit 1; }
! grep -q "session-b00ed183" "$C" \
  || { echo "FAIL: client.js 硬编码了会话 id"; exit 1; }
grep -rq "supervisorSession" dsh-graph-host/index.js \
  || { echo "FAIL: host board 端点未下发 supervisorSession"; exit 1; }
grep -q "session:" .dsh-graph/project.yaml \
  || { echo "FAIL: project.yaml 缺 supervisor.session"; exit 1; }

echo "== 3. 一键跳转主管对话（open + 切对话 tab） =="
awk '/dg-supervisor/,0' "$C" | grep "activateChatTab" >/dev/null \
  || { echo "FAIL: supervisor 状态栏跳转未复用切 tab 逻辑"; exit 1; }

echo "== 4. 依赖徽章状态化（发现#23） =="
grep -q "依赖满足" "$C" || { echo "FAIL: 缺已交付依赖的「依赖满足」显示"; exit 1; }
grep -q "等待" "$C"     || { echo "FAIL: 缺未交付依赖的「等待」显示"; exit 1; }

echo "== 5. 单元测试回归 =="
node --test core/tests/*.test.ts > /dev/null

echo "PASS: g-108 静态验收全部通过"
