#!/usr/bin/env bash
# dsh-graph client.js 构建脚本（g-142 模块化重构）
# 将 dsh-graph-host/lib/client/ 目录下的子模块拼接组装为 dsh-graph-host/lib/client.js
#
# 用法：从仓库根目录运行 bash scripts/build-client.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="dsh-graph-host/lib/client.js"
MOD="dsh-graph-host/lib/client"

PARTS=(
  "_wrapper-top"
  "constants"
  "helpers"
  "session-hooks"
  "live-panel"
  "supervisor-bar"
  "card"
  "card-drawer"
  "goal-actions"
  "goal-modal"
  "drag-prompts"
  "kanban"
  "plugin"
  "_wrapper-bottom"
)

> "$OUT"
first=true
for part in "${PARTS[@]}"; do
  file="$MOD/${part}.js"
  if [ ! -f "$file" ]; then
    echo "ERROR: 缺少子模块 $file" >&2
    exit 1
  fi
  if [ "$first" = true ]; then
    first=false
    cat "$file" >> "$OUT"
    # 添加空行分隔（与原始文件第 9 行一致）
    echo "" >> "$OUT"
  else
    cat "$file" >> "$OUT"
  fi
done

LINES=$(wc -l < "$OUT")
echo "✅ client.js 已组装完成 ($LINES 行)"
