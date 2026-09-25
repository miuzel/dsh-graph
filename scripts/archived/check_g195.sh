#!/usr/bin/env bash
# g-195 验收脚本 —— 子代理实时流式数据刷新性能与节流保障。
# 验证点：
#   1. client.js 语法正确且包含 GENERATED header；
#   2. session-hooks.js 与 bundle 含 useThrottledLiveSession、trailing edge 定时器与清理逻辑；
#   3. LiveStrip 接入节流 hook；
#   4. check_g107 静态检查通过（不破坏现有 API 契约）；
#   5. 全量单元测试通过。
set -euo pipefail
cd "$(dirname "$0")/.."
C=dsh-graph-host/lib/client.js
S=dsh-graph-host/lib/client/session-hooks.js
L=dsh-graph-host/lib/client/live-panel.js

echo "== 0. 语法与生成标记 =="
node --check "$C"
grep -q "⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY" "$C" || { echo "FAIL: client.js 缺 GENERATED header"; exit 1; }

echo "== 1. session-hooks.js 提供 useThrottledLiveSession 节流 hook =="
grep -q "function useThrottledLiveSession" "$S" || { echo "FAIL: session-hooks 缺 useThrottledLiveSession"; exit 1; }
grep -q "intervalMs = 200" "$S" || { echo "FAIL: 缺 200ms / 5fps 默认间隔"; exit 1; }
grep -q "setTimeout(flush" "$S" || { echo "FAIL: 缺 trailing edge 定时器"; exit 1; }
grep -q "clearTimeout(timer)" "$S" || { echo "FAIL: 缺卸载与重置时的定时器清理"; exit 1; }

echo "== 2. LiveStrip 使用 useThrottledLiveSession =="
grep -q "useThrottledLiveSession(session" "$L" || { echo "FAIL: live-panel 缺 useThrottledLiveSession 调用"; exit 1; }

echo "== 3. 兼容既有 g-107 静态验收 =="
bash scripts/check_g107.sh

echo "== 4. 单元测试回归 =="
node --test core/tests/client.test.ts

echo "PASS: g-195 静态与单元测试验收全部通过"
