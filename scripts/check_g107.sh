#!/usr/bin/env bash
# g-107 验收脚本 —— 由规划方（supervisor）在判据确认时编写并冻结（R-03）。
# 执行方不得修改本文件；如需变更走判据变更流程。
# 验证：client.js 静态取证（inject 升级、实时状态/投影/模型/发指令/降级提示/历史记录
# 六个能力点的 API 落点）。浏览器逐条实测为判据第 7 条，由负责人人工执行。
set -euo pipefail
cd "$(dirname "$0")/.."
C=dsh-graph-client/lib/client.js

echo "== 0. 语法 =="
node --check "$C"

echo "== 1. inject 升级为 [slots, sessions, connection] =="
grep -q 'inject: \["slots", "sessions", "connection"\]' "$C" \
  || { echo "FAIL: inject 未包含 sessions/connection"; exit 1; }

echo "== 2. 实时状态与最新流式行（session.open + chat.legacy.partial + running） =="
grep -q '\.binding(' "$C"            || { echo "FAIL: 缺 sessions.binding"; exit 1; }
grep -q '\.open()' "$C"               || { echo "FAIL: 缺 session.open()"; exit 1; }
grep -q 'chat.legacy.partial' "$C"    || { echo "FAIL: 缺流式快照读取"; exit 1; }

echo "== 3. token/上下文投影（faceOf tokenUsage + contextPressure，无需 open） =="
grep -q "faceOf(" "$C"                || { echo "FAIL: 缺 projections.faceOf"; exit 1; }
grep -q "tokenUsage" "$C"             || { echo "FAIL: 缺 tokenUsage 投影"; exit 1; }
grep -q "contextPressure" "$C"        || { echo "FAIL: 缺 contextPressure 投影"; exit 1; }

echo "== 4. 当前模型（api.sessions.models） =="
grep -q "sessions.models" "$C"        || { echo "FAIL: 缺模型查询"; exit 1; }

echo "== 5. 看板直达指令（session.prompt，queue/steer）+ 多模态降级提示 =="
grep -q "\.prompt(" "$C"              || { echo "FAIL: 缺 session.prompt"; exit 1; }
grep -q "SUBAGENT_IMAGE_UNSUPPORTED\|不支持.*图\|图片.*不支持" "$C" \
  || { echo "FAIL: 缺子代理图片降级的明确提示"; exit 1; }

echo "== 6. 最近会话记录（chat.nodes 或 subagents.history） =="
grep -q "chat.nodes\|subagents.history" "$C" \
  || { echo "FAIL: 缺历史记录读取"; exit 1; }

echo "PASS: g-107 静态验收全部通过"
