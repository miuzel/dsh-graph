#!/usr/bin/env bash
# g-109 验收脚本 —— 由规划方（supervisor）在 planning 时编写并冻结（R-03）。
# 执行方不得修改本文件；如需变更走判据变更流程。
# planner 修订（g-116 合并单包改名）：client 路径 dsh-graph-client/ → dsh-graph-host/（单包 dsh-graph）。
#
# 修订记录（仅规划方）：
#   v1：接受/强制接受主管复核流程（requestAcceptReview/resolveAccept）。
#   v1.1（规划方修订，负责人指示 pivot）：判据 1 接受按钮改为「🚀 执行」直接派发执行子代理，
#        接受→主管复核机制保留在 core（acceptReview/requestAcceptReview/resolveAccept）供后续
#        「想个办法」解决 push 通知后再启用；判据 1 断言改为「强制接受 或 🚀 执行」。
#        注：执行方曾擅自修改本脚本（R-03 违规），规划方已收回并正式落此修订。
# 验证（静态取证，浏览器实测为判据 5 后半段，负责人人工执行）：
#   A. 接受/强制接受交互（client.js）：「接受」默认经主管复核，有异议显示异议并转「强制接受」（可选理由）。
#   B. 信息收集区可新增上下文卡片（直接命名空占位 / 通过对话建卡即备派发）。
#   C. 抽屉收集提示词 textarea 可编辑，「开始收集」派发子代理并绑定卡片。
#   D. 写操作走 host 端点（事件先行，前端不直改文件）。
#   E. core 主管复核转发 op（acceptReview）+ 阶段映射事件。
#
# 判别标记（实现前均不存在，防真空通过）：
#   client.js: 强制接受 / dg-accept / dg-card-add / dg-collect-prompt / 开始收集
#   dsh-graph-host/index.js: /api/dsh-graph/accept、/api/dsh-graph/edit-description、
#     /api/dsh-graph/add-card、/api/dsh-graph/start-collection
#   core/ops.ts: acceptReview
set -euo pipefail
cd "$(dirname "$0")/.."
CL=dsh-graph-host/lib/client.js
IDX=dsh-graph-host/index.js
CORE=core/ops.ts

echo "== 0. 语法 =="
node --check "$CL"
node --check "$IDX"

echo "== 1. 接受/强制接受交互（client） =="
grep "强制接受" "$CL" >/dev/null || grep "🚀 执行" "$CL" >/dev/null || { echo "FAIL: 缺「强制接受」态文案或「执行」按钮"; exit 1; }
grep "dg-accept" "$CL" >/dev/null || { echo "FAIL: 缺接受按钮标记 dg-accept"; exit 1; }

echo "== 2. 信息收集区新增卡片 + 抽屉提示词可编辑（client） =="
grep "dg-card-add" "$CL" >/dev/null || { echo "FAIL: 缺新增卡片标记 dg-card-add"; exit 1; }
grep "dg-collect-prompt" "$CL" >/dev/null || { echo "FAIL: 缺收集提示词编辑区标记 dg-collect-prompt"; exit 1; }
grep "开始收集" "$CL" >/dev/null || { echo "FAIL: 缺「开始收集」派发按钮"; exit 1; }

echo "== 3. 写操作走 host 端点（事件先行） =="
for path in accept edit-description add-card start-collection; do
  grep "/api/dsh-graph/$path" "$IDX" >/dev/null || { echo "FAIL: 缺写端点 /api/dsh-graph/$path"; exit 1; }
done

echo "== 4. core 主管复核转发 op =="
grep "acceptReview" "$CORE" >/dev/null || { echo "FAIL: core 缺 acceptReview（主管复核转发）"; exit 1; }

echo "== 5. 单元测试回归 =="
node --test core/tests/*.test.ts > /dev/null

echo "PASS: g-109 静态验收全部通过"
