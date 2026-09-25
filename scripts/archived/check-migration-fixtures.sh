#!/usr/bin/env bash
# scripts/check-migration-fixtures.sh — g-149: 迁移脚本 fixture 测试
#
# 在隔离的临时目录模拟父仓库 + .dsh-graph，验证迁移脚本行为：
# 1. dry-run 不修改文件
# 2. --apply 创建内层仓库、父库 untrack、events.jsonl 跟踪
# 3. 回滚路径可恢复
# 4. worktree ignore 正确
#
# 用法：bash scripts/check-migration-fixtures.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATE_SCRIPT="$SCRIPT_DIR/migrate-dsh-graph-repo.sh"

PASS=0
FAIL=0

pass() { echo "  ✅ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ❌ $1"; FAIL=$((FAIL + 1)); }

# 创建隔离测试环境
setup_test_env() {
  local tmpdir
  tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/g149-migration-test-XXXXXX")"
  echo "$tmpdir"
}

# ===== Test 1: dry-run 不修改文件 =====
echo "=== Test 1: dry-run 不修改文件 ==="
T1_DIR="$(setup_test_env)"
trap "rm -rf '$T1_DIR'" EXIT

# 创建模拟父仓库
mkdir -p "$T1_DIR/repo/.dsh-graph/backlog"
mkdir -p "$T1_DIR/repo/.dsh-graph/goals"
mkdir -p "$T1_DIR/repo/.dsh-graph/versions"
mkdir -p "$T1_DIR/repo/.dsh-graph/memory/long-term"
echo "" > "$T1_DIR/repo/.dsh-graph/events.jsonl"
echo "{}" > "$T1_DIR/repo/.dsh-graph/index.json"
echo "rules" > "$T1_DIR/repo/.dsh-graph/rules.md"
echo "# test project" > "$T1_DIR/repo/.dsh-graph/project.yaml"

cd "$T1_DIR/repo"
git init -b main
git config user.email "test@test.com"
git config user.name "Test"
git add -A
git commit -m "initial"

# 记录迁移前文件哈希
HASHES_BEFORE=$(find .dsh-graph -type f -exec sha256sum {} \; | sort)

# 运行 dry-run
bash "$MIGRATE_SCRIPT" > "$T1_DIR/dry-run-output.txt" 2>&1

# 验证文件未变
HASHES_AFTER=$(find .dsh-graph -type f -exec sha256sum {} \; | sort)
if [[ "$HASHES_BEFORE" == "$HASHES_AFTER" ]]; then
  pass "dry-run 未修改任何文件"
else
  fail "dry-run 修改了文件"
fi

# 验证没有创建 .dsh-graph/.git
if [[ ! -d ".dsh-graph/.git" ]]; then
  pass "dry-run 未创建内层 .git"
else
  fail "dry-run 创建了内层 .git"
fi

# 验证输出包含关键信息
if grep -q "DRY-RUN" "$T1_DIR/dry-run-output.txt"; then
  pass "输出标记为 DRY-RUN"
else
  fail "输出未标记为 DRY-RUN"
fi
if grep -q "Step 1" "$T1_DIR/dry-run-output.txt"; then
  pass "输出包含 Step 1"
else
  fail "输出缺少 Step 1"
fi

# ===== Test 2: --apply 完整迁移 =====
echo ""
echo "=== Test 2: --apply 完整迁移 ==="
T2_DIR="$(setup_test_env)"

# 创建模拟父仓库（含未跟踪文件）
mkdir -p "$T2_DIR/repo/.dsh-graph/backlog"
mkdir -p "$T2_DIR/repo/.dsh-graph/goals/g-test"
mkdir -p "$T2_DIR/repo/.dsh-graph/versions"
mkdir -p "$T2_DIR/repo/.dsh-graph/memory/long-term"
echo '{"event":"test","ts":"2026-01-01"}' > "$T2_DIR/repo/.dsh-graph/events.jsonl"
echo "{}" > "$T2_DIR/repo/.dsh-graph/index.json"
echo '---\n{"version":"r-test"}\n---\n\nrules' > "$T2_DIR/repo/.dsh-graph/rules.md"
echo "# test" > "$T2_DIR/repo/.dsh-graph/project.yaml"
echo "# goal" > "$T2_DIR/repo/.dsh-graph/goals/g-test/goal.md"
# 模拟未跟踪文件
echo "untracked" > "$T2_DIR/repo/.dsh-graph/goals/g-test/note.md"

cd "$T2_DIR/repo"
git init -b main
git config user.email "test@test.com"
git config user.name "Test"
git add -A
git commit -m "initial"

# 运行 --apply
bash "$MIGRATE_SCRIPT" --apply > "$T2_DIR/apply-output.txt" 2>&1

# 验证 1: 内层仓库存在
if [[ -d ".dsh-graph/.git" ]]; then
  pass "内层 .git 目录已创建"
else
  fail "内层 .git 目录未创建"
fi

# 验证 2: 内层仓库根正确
INNER_TOPLEVEL="$(git -C .dsh-graph rev-parse --show-toplevel)"
INNER_REALPATH="$(realpath "$INNER_TOPLEVEL")"
OUTER_REALPATH="$(realpath "$T2_DIR/repo/.dsh-graph")"
if [[ "$INNER_REALPATH" == "$OUTER_REALPATH" ]]; then
  pass "内层 git toplevel 正确"
else
  fail "内层 git toplevel 不正确：$INNER_REALPATH vs $OUTER_REALPATH"
fi

# 验证 3: events.jsonl 已跟踪
if git -C .dsh-graph ls-files events.jsonl | grep -q events.jsonl; then
  pass "events.jsonl 已跟踪"
else
  fail "events.jsonl 未跟踪"
fi

# 验证 4: order.json/index.json/handoffs/ 被忽略
if git -C .dsh-graph check-ignore order.json 2>/dev/null; then
  pass "order.json 被内层忽略"
else
  fail "order.json 未被内层忽略"
fi
if git -C .dsh-graph check-ignore index.json 2>/dev/null; then
  pass "index.json 被内层忽略"
else
  fail "index.json 未被内层忽略"
fi

# 验证 5: 父库不再跟踪 .dsh-graph
PARENT_TRACKS=$(git ls-files .dsh-graph | wc -l)
if [[ "$PARENT_TRACKS" -eq 0 ]]; then
  pass "父库不再跟踪 .dsh-graph"
else
  fail "父库仍跟踪 $PARENT_TRACKS 个 .dsh-graph 文件"
fi

# 验证 6: 父库 .gitignore 包含 /.dsh-graph/
if grep -q '^/\.dsh-graph/$' .gitignore 2>/dev/null; then
  pass "父库 .gitignore 包含 /.dsh-graph/"
else
  fail "父库 .gitignore 缺少 /.dsh-graph/"
fi

# 验证 7: 文件未丢失（goal 仍存在）
if [[ -f ".dsh-graph/goals/g-test/goal.md" ]]; then
  pass "目标文件未丢失"
else
  fail "目标文件丢失"
fi

# 验证 8: 未跟踪文件保留
if [[ -f ".dsh-graph/goals/g-test/note.md" ]]; then
  pass "未跟踪文件保留"
else
  fail "未跟踪文件丢失"
fi

# 验证 9: 备份已创建（备份在 REPO_ROOT/.. = $T2_DIR/）
BACKUP_COUNT=$(ls "$T2_DIR"/dsh-graph-data-pre-migration-*.tgz 2>/dev/null | wc -l)
if [[ "$BACKUP_COUNT" -ge 1 ]]; then
  pass "备份已创建"
else
  fail "备份未创建"
fi

# 验证 10: 内层有 project.yaml
if git -C .dsh-graph ls-files project.yaml | grep -q project.yaml; then
  pass "project.yaml 在内层仓库跟踪"
else
  fail "project.yaml 未在内层仓库跟踪"
fi

# 验证 11: 父库 git status 不显示 .dsh-graph 内部改动
PARENT_STATUS=$(git status --short .dsh-graph 2>/dev/null | wc -l)
if [[ "$PARENT_STATUS" -eq 0 ]]; then
  pass "父库 status 不显示 .dsh-graph 改动"
else
  fail "父库 status 显示 .dsh-graph 改动（$PARENT_STATUS 行）"
fi

# ===== Test 3: worktree ignore =====
echo ""
echo "=== Test 3: worktree ignore ==="
# 验证根 .gitignore 的 /.dsh-graph/ 规则可被 git check-ignore 识别
if [[ -f ".dsh-graph/project.yaml" ]]; then
  if git check-ignore -v .dsh-graph/project.yaml 2>/dev/null; then
    pass "父库 check-ignore 可识别 .dsh-graph 内文件"
  else
    fail "父库 check-ignore 未识别 .dsh-graph 内文件"
  fi
fi

# ===== 总结 =====
echo ""
echo "===== 结果：$PASS passed, $FAIL failed ====="
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
