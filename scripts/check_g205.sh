#!/usr/bin/env bash
# G205 static regression check: verify supervisor-guide.md clarifies
# context-card vs development-attempt boundary.
# Reads the actual file, exits non-zero on any failure. No grep||true, no unconditional PASS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUIDE="${SCRIPT_DIR}/../dsh-graph-host/supervisor-guide.md"

if [[ ! -f "$GUIDE" ]]; then
    echo "FAIL: guide not found at $GUIDE" >&2
    exit 1
fi

ERRORS=0

fail() {
    echo "FAIL: $1" >&2
    ERRORS=$((ERRORS + 1))
}

# ---- Positive checks: guide MUST contain these clarifications ----

# 1. Standard dispatch without card is legal
if ! grep -q '未传 `card` 完全合法' "$GUIDE"; then
    fail "missing: '未传 \`card\` 完全合法'"
fi

if ! grep -q '不表示缺上下文、不表示流程违规' "$GUIDE"; then
    fail "missing: '不表示缺上下文、不表示流程违规'"
fi

if ! grep -q '也不应被要求先创建 card' "$GUIDE"; then
    fail "missing: '也不应被要求先创建 card'"
fi

# 2. Card is only for information collection
if ! grep -q '仅在目标确有信息收集需求时才创建 card' "$GUIDE"; then
    fail "missing: '仅在目标确有信息收集需求时才创建 card'"
fi

if ! grep -q '不为走流程而收集' "$GUIDE"; then
    fail "missing: '不为走流程而收集'"
fi

# 2b. graph_add_card is for real collection needs only
if ! grep -q 'graph_add_card' "$GUIDE"; then
    fail "missing: 'graph_add_card' mention"
fi

# 2c. collecting → filled/reviewed lifecycle
if ! grep -q 'collecting' "$GUIDE"; then
    fail "missing: 'collecting' lifecycle state"
fi
if ! grep -q 'filled' "$GUIDE"; then
    fail "missing: 'filled' lifecycle state"
fi
if ! grep -q 'reviewed' "$GUIDE"; then
    fail "missing: 'reviewed' lifecycle state"
fi

# 3. graph_bind_collect_card is for collecting child only
if ! grep -q '派发.*收集子代理.*必须立即.*graph_bind_collect_card' "$GUIDE"; then
    fail "missing: binding collect child requirement"
fi

# 4. injected_cards: [] is not an error
if ! grep -q 'injected_cards: \[\]' "$GUIDE"; then
    fail "missing: 'injected_cards: []' mention"
fi

if ! grep -q '不代表错误.*不代表缺上下文' "$GUIDE"; then
    fail "missing: clarification that injected_cards: [] is not an error"
fi

# 5. Lifecycle distinction
if ! grep -q '开发生命周期' "$GUIDE"; then
    fail "missing: '开发生命周期'"
fi

if ! grep -q '收集生命周期' "$GUIDE"; then
    fail "missing: '收集生命周期'"
fi

if ! grep -q 'goal → attempt → child' "$GUIDE"; then
    fail "missing: 'goal → attempt → child'"
fi

if ! grep -q 'goal → card → collecting child' "$GUIDE"; then
    fail "missing: 'goal → card → collecting child'"
fi

# 6. subagent does not auto-generate attempt, unrelated to card presence
if ! grep -q '不会自动生成 graph attempt/状态记录' "$GUIDE"; then
    fail "missing: '不会自动生成 graph attempt/状态记录'"
fi

if ! grep -q '没有 card 不代表流程缺失' "$GUIDE"; then
    fail "missing: '没有 card 不代表流程缺失'"
fi

# 7. graph_start_attempt card parameter semantics
if ! grep -q '`card` 参数.*仅用于信息收集' "$GUIDE"; then
    fail "missing: '\`card\` 参数仅用于信息收集'"
fi

# 8. Standard dispatch pattern preserved
if ! grep -q 'graph_start_attempt(goal=\.*, worktree=true)' "$GUIDE"; then
    fail "missing: standard dispatch pattern 'graph_start_attempt(goal=..., worktree=true)'"
fi

# ---- Negative checks: guide MUST NOT contain misleading reverse statements ----

# Must NOT say missing card is a violation / error / must-create
# Extract lines that contain standalone negative claims (not within positive clarifications)
# We grep for bad phrases, then verify they only appear inside positive clarification context
BAD_CARD_LINES=$(grep -nE '缺.*card|缺少.*card|未传.*card|必须先创建.*card' "$GUIDE" || true)
if [[ -n "$BAD_CARD_LINES" ]]; then
    # Check if any of these lines are NOT part of positive clarifications
    # Positive lines contain "不表示" or "不代表" or "也不应被要求"
    while IFS= read -r line; do
        if [[ -n "$line" ]] && ! echo "$line" | grep -qE '不表示|不代表|也不应被要求'; then
            fail "found misleading reverse statement about missing card: $line"
        fi
    done <<< "$BAD_CARD_LINES"
fi

# Must NOT say card parameter is for execution/development dispatch
# The guide must NOT say "card...执行" or "card...开发" in the context of graph_start_attempt
# Positive: "card 参数仅用于信息收集" is OK
# Negative: any line that says card is for execution/development
# Allow "执行 attempt 启动时" and "本次执行无预填充卡片" which are about attempt injection, not card semantics
BAD_CARD_EXEC_LINES=$(grep -nE 'card.*执行|card.*开发' "$GUIDE" || true)
if [[ -n "$BAD_CARD_EXEC_LINES" ]]; then
    while IFS= read -r line; do
        if [[ -n "$line" ]]; then
            # Skip lines that are about attempt injection mechanics (not card semantics)
            if echo "$line" | grep -qE '执行 attempt 启动|执行无预填充卡片|context_cards.*注入'; then
                continue
            fi
            # Skip lines that already clarify card is for collection
            if echo "$line" | grep -qE '信息收集|收集子代理'; then
                continue
            fi
            fail "found card incorrectly associated with execution/development: $line"
        fi
    done <<< "$BAD_CARD_EXEC_LINES"
fi

# Must NOT equate injected_cards: [] with error
BAD_INJECTED_LINES=$(grep -nE 'injected_cards.*错误|injected_cards.*违规|injected_cards.*缺失' "$GUIDE" || true)
if [[ -n "$BAD_INJECTED_LINES" ]]; then
    while IFS= read -r line; do
        if [[ -n "$line" ]] && ! echo "$line" | grep -qE '不代表|不表示'; then
            fail "found injected_cards incorrectly equated with error: $line"
        fi
    done <<< "$BAD_INJECTED_LINES"
fi

# ---- Summary ----
if [[ $ERRORS -gt 0 ]]; then
    echo "FAIL: $ERRORS check(s) failed" >&2
    exit 1
fi

echo "PASS: all G205 boundary clarifications present and no reverse misreadings found"
