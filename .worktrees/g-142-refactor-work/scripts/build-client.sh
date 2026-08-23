#!/usr/bin/env bash
# dsh-graph client.js 构建脚本（g-142 模块化重构）
# 将 lib/client/ 目录下的子模块拼接组装为 lib/client.js
# 用法：bash scripts/build-client.sh
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="dsh-graph-host/lib/client.js"
MODULES_DIR="dsh-graph-host/lib/client"

# 按依赖顺序拼接子模块
PARTS=(
  "00-wrapper-top"
  "01-constants"
  "02-helpers"
  "03-session-hooks"
  "04-live-panel"
  "05-supervisor-bar"
  "06-card"
  "07-card-drawer"
  "08-goal-actions"
  "09-goal-modal"
  "10-drag-prompts"
  "11-kanban"
  "12-plugin"
  "99-wrapper-bot"
)

# 先清空
> "$OUT"

for part in "${PARTS[@]}"; do
  file="$MODULES_DIR/${part}.js"
  if [ ! -f "$file" ]; then
    echo "ERROR: 缺少子模块 $file" >&2
    exit 1
  fi
  cat "$file" >> "$OUT"
done

LINES=$(wc -l < "$OUT")
echo "✅ client.js 已组装完成 ($LINES 行)"
