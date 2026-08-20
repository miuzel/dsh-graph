#!/usr/bin/env bash
# g-003 验收脚本 —— 由规划方（supervisor）在 planning 时编写并冻结（R-03）。
# 执行方不得修改本文件；如需变更走判据变更流程。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. 全部单元测试 =="
node --test core/tests/*.test.ts

echo "== 2. 卡片 CLI 冒烟（临时图根） =="
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

node core/main.ts --root "$TMP" init > /dev/null
ID=$(node core/main.ts --root "$TMP" create-goal --title 卡片测试 --version v-test)

# 建卡两张，顺序应保留
C1=$(node core/main.ts --root "$TMP" add-card --goal "$ID" --title 资料甲 --kind text)
C2=$(node core/main.ts --root "$TMP" add-card --goal "$ID" --title 数据乙 --kind data)
echo "cards: $C1 $C2"

# 填充 + 复核
node core/main.ts --root "$TMP" fill-card --goal "$ID" --card "$C1" --text "认证链路内容……" --by human:tester
node core/main.ts --root "$TMP" review-card --goal "$ID" --card "$C1" --by human:lead

# backlog 目标（无目录）建卡必须被拒绝
BID=$(node core/main.ts --root "$TMP" create-goal --title 暂存目标)
if node core/main.ts --root "$TMP" add-card --goal "$BID" --title 不该成功 --kind text 2>/dev/null; then
  echo "FAIL: backlog 目标建卡被接受" >&2; exit 1
fi

# 悬空引用检测：往 context_cards 塞入不存在的卡片 id，validate 必须报问题
GOAL_FILE="$TMP/versions/v-test/goals/$ID/goal.md"
node -e '
const fs = require("fs");
const f = process.argv[2];
let t = fs.readFileSync(f, "utf8");
t = t.replace("\"context_cards\": [", "\"context_cards\": [\n    \"card-ghost\",");
fs.writeFileSync(f, t);
' x "$GOAL_FILE"
if node core/main.ts --root "$TMP" validate 2>/dev/null; then
  echo "FAIL: 悬空卡片引用未被 validate 发现" >&2; exit 1
fi

# 修掉悬空引用后全量通过（卡片事件不得干扰 rebuild）
node -e '
const fs = require("fs");
const f = process.argv[2];
let t = fs.readFileSync(f, "utf8");
t = t.replace("\"card-ghost\",", "");
fs.writeFileSync(f, t);
' x "$GOAL_FILE"
node core/main.ts --root "$TMP" validate
node core/main.ts --root "$TMP" rebuild --check

echo "check_cards: PASS"
