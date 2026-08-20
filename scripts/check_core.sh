#!/usr/bin/env bash
# g-001 验收脚本 —— 由规划方（supervisor）在 planning 时编写并冻结（R-03）。
# 执行方不得修改本文件；如需变更走判据变更流程。
# 第二版：核心层改用 TypeScript（负责人指示），Node ≥ 23.6 原生运行 .ts。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. 单元测试（node:test 原生跑 .ts） =="
node --test core/tests/*.test.ts

echo "== 2. CLI 冒烟（临时图根） =="
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

node core/main.ts --root "$TMP" init
ID=$(node core/main.ts --root "$TMP" create-goal --title 冒烟目标)
echo "created: $ID"

# 合法迁移：draft -> planning -> collecting -> ready
node core/main.ts --root "$TMP" transition --goal "$ID" --to planning
node core/main.ts --root "$TMP" transition --goal "$ID" --to collecting
node core/main.ts --root "$TMP" transition --goal "$ID" --to ready

# 非法迁移必须失败（以下若成功即判失败）
if node core/main.ts --root "$TMP" transition --goal "$ID" --to delivered 2>/dev/null; then
  echo "FAIL: 跳阶段迁移被接受" >&2; exit 1
fi
if node core/main.ts --root "$TMP" transition --goal "$ID" --to blocked 2>/dev/null; then
  echo "FAIL: 无 reason 进 blocked 被接受" >&2; exit 1
fi
if node core/main.ts --root "$TMP" transition --goal "$ID" --to in_progress 2>/dev/null; then
  echo "FAIL: 无判据进 in_progress 被接受" >&2; exit 1
fi

# 补判据后应可进入执行（通过引擎接口登记判据）
node core/main.ts --root "$TMP" set-criteria --goal "$ID" --criteria "验收脚本通过"
node core/main.ts --root "$TMP" transition --goal "$ID" --to in_progress

# 全量校验与事件流重建
node core/main.ts --root "$TMP" validate
node core/main.ts --root "$TMP" rebuild --check

echo "check_core: PASS"
