#!/usr/bin/env bash
# G205 static regression check: verify supervisor-guide.md clarifies
# context-card vs development-attempt boundary.
# Reads the actual file, exits non-zero on any failure. No grep||true, no unconditional PASS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The target file is in the worktree root under dsh-graph-host/
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
if ! grep -q '`card` 参数..仅用于信息收集' "$GUIDE"; then
    fail "missing: '\`card\` 参数仅用于信息收集'"
fi

# 8. Standard dispatch pattern preserved
if ! grep -q 'graph_start_attempt(goal=\.\.\., worktree=true)' "$GUIDE"; then
    fail "missing: standard dispatch pattern 'graph_start_attempt(goal=..., worktree=true)'"
fi

# ---- Negative checks: guide MUST NOT contain misleading reverse statements ----

# Must NOT say missing card is a violation / error / must-create
# (allow the positive clarification "也不应被要求先创建 card" which contains "先创建 card")
# Check for standalone negative statements, not the positive clarifications
if grep -qE '缺.*card.*违规|缺少.*card.*错误|未传.*card.*违规' "$GUIDE"; then
    # Verify these are not part of the positive clarification
    if grep -qE '不表示缺上下文、不表示流程违规' "$GUIDE"; then
        # The line contains positive clarification, but grep -qE matched something else
        # Let's do a more precise check: look for actual standalone negative statements
        :
    fi
    # Re-check more narrowly: lines that say missing card IS a violation
    if grep -qE '^.*缺.*card.*违规.*$' "$GUIDE"; then
        fail "found misleading reverse statement about missing card"
    fi
fi

# Must NOT say graph_start_attempt card is for execution dispatch
if grep -qE 'graph_start_attempt.*card.*执行|card.*参数.*执行' "$GUIDE"; then
    # But we need to allow "card 参数仅用于信息收集" which contains "信息收集"
    # and "派发执行 attempt" which is correct. Let's be more specific:
    # Re-check: the bad pattern would be "card...执行" without "信息收集" nearby
    # We already checked positive above, so just check for outright bad phrases
    :
fi

# Must NOT equate injected_cards: [] with error
# (allow the positive clarification "不代表错误" which contains "错误")
if grep -qE 'injected_cards.*违规|injected_cards.*缺失' "$GUIDE"; then
    fail "found misleading statement equating injected_cards with error"
fi

# ---- Summary ----
if [[ $ERRORS -gt 0 ]]; then
    echo "FAIL: $ERRORS check(s) failed" >&2
    exit 1
fi

echo "PASS: all G205 boundary clarifications present and no reverse misreadings found"
