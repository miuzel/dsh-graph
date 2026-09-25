#!/usr/bin/env bash
# scripts/migrate-dsh-graph-repo.sh — g-149: 将 .dsh-graph 从父仓库解耦为独立 Git 仓库
#
# 用法：
#   bash scripts/migrate-dsh-graph-repo.sh                  # dry-run（默认，只报告将要做什么）
#   bash scripts/migrate-dsh-graph-repo.sh --apply           # 执行迁移
#   bash scripts/migrate-dsh-graph-repo.sh --apply --remote <url>  # 执行迁移并配置远端
#   bash scripts/migrate-dsh-graph-repo.sh --rollback        # 回滚迁移（仅限未提交父库 untrack 时）
#
# 前提条件：
#   - 当前目录是含 .dsh-graph 的 Git 仓库根
#   - .dsh-graph 尚未是独立 Git 仓库（无 .dsh-graph/.git 目录）
#   - 数据目录 .dsh-graph 存在
#
# 安全保证：
#   - 不执行 git clean、git reset --hard、rm -rf .dsh-graph
#   - 不自动 push（--remote 只添加 remote，不 push）
#   - dry-run 模式只报告，不修改任何文件
#   - 迁移前备份整个 .dsh-graph 到 tar.gz
#   - events.jsonl 纳入内层仓库跟踪（R-02 审计证据）
#   - order.json、index.json、handoffs/ 由内层 .gitignore 排除
#
set -euo pipefail

# ===== 参数解析 =====
DRY_RUN=true
REMOTE=""
DO_ROLLBACK=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)   DRY_RUN=false; shift ;;
    --remote)  REMOTE="$2"; shift 2 ;;
    --rollback) DO_ROLLBACK=true; shift ;;
    --help|-h)
      echo "用法：bash scripts/migrate-dsh-graph-repo.sh [--apply] [--remote <url>] [--rollback]"
      echo "  (默认)      dry-run：只报告将要做什么"
      echo "  --apply     执行迁移"
      echo "  --remote    添加远端（不自动 push）"
      echo "  --rollback  回滚迁移（仅限未提交父库 untrack 时）"
      exit 0
      ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

# ===== 环境检测 =====
# 使用调用者的当前目录（而非脚本所在目录），以支持在目标仓库中直接运行
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$REPO_ROOT" ]]; then
  echo "❌ 当前目录不在 Git 仓库中" >&2
  exit 1
fi
cd "$REPO_ROOT"

GRAPH_DIR="$REPO_ROOT/.dsh-graph"
BACKUP_DIR="$REPO_ROOT/.."
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/dsh-graph-data-pre-migration-${TIMESTAMP}.tgz"

if [[ ! -d "$GRAPH_DIR" ]]; then
  echo "❌ 数据目录 $GRAPH_DIR 不存在" >&2
  exit 1
fi

# 检查是否已经是独立仓库
if [[ -d "$GRAPH_DIR/.git" ]]; then
  echo "❌ $GRAPH_DIR 已经是独立 Git 仓库（存在 .git 目录）。无需迁移。" >&2
  exit 1
fi

# ===== 回滚模式 =====
if $DO_ROLLBACK; then
  echo "===== 回滚模式 ====="
  if [[ -d "$GRAPH_DIR/.git" ]]; then
    echo "回滚步骤："
    echo "  1. 删除内层 .git 和 .gitignore："
    echo "     rm -rf $GRAPH_DIR/.git $GRAPH_DIR/.gitignore"
    echo "  2. 恢复父仓库跟踪（如果已 untrack）："
    echo "     git restore --staged .dsh-graph .gitignore"
    echo "     git add -f .dsh-graph"
    echo "  3. 恢复根 .gitignore（移除 /.dsh-graph/ 规则）"
    echo ""
    echo "⚠️  回滚需要手动执行上述步骤（避免意外数据丢失）。"
    echo "确认备份存在后，按步骤执行。"
  else
    echo "内层 .git 不存在，回滚只需撤销父库暂存："
    echo "  git restore --staged .dsh-graph .gitignore"
  fi
  exit 0
fi

# ===== 状态报告 =====
echo "===== dsh-graph 数据仓库迁移 ====="
echo "模式：$(if $DRY_RUN; then echo "🔍 DRY-RUN（只报告）"; else echo "⚡ APPLY（执行迁移）"; fi)"
echo "仓库根：$REPO_ROOT"
echo "数据目录：$GRAPH_DIR"
if [[ -n "$REMOTE" ]]; then
  echo "远端：$REMOTE"
fi
echo ""

# ===== 父库跟踪状态 =====
echo "--- 父库跟踪状态 ---"
TRACKED_COUNT=$(git ls-files .dsh-graph 2>/dev/null | wc -l)
echo "父库已跟踪 .dsh-graph 文件数：$TRACKED_COUNT"
UNTRACKED_COUNT=$(git ls-files --others --exclude-standard .dsh-graph 2>/dev/null | wc -l)
echo "父库未跟踪 .dsh-graph 文件数：$UNTRACKED_COUNT"
echo ""

# ===== Step 0: 备份 =====
echo "--- Step 0: 备份 .dsh-graph ---"
if $DRY_RUN; then
  echo "[dry-run] 将创建备份：$BACKUP_FILE"
else
  tar -C "$REPO_ROOT" -czf "$BACKUP_FILE" .dsh-graph
  echo "✅ 备份已创建：$BACKUP_FILE"
  echo "   大小：$(du -h "$BACKUP_FILE" | cut -f1)"
fi
echo ""

# ===== Step 1: 内层仓库初始化 =====
echo "--- Step 1: 在 .dsh-graph 内初始化独立 Git 仓库 ---"
if $DRY_RUN; then
  echo "[dry-run] 将执行："
  echo "  git -C $GRAPH_DIR init -b main"
  echo "  创建 $GRAPH_DIR/.gitignore（排除运行态文件）"
  echo "  git -C $GRAPH_DIR add -A"
  echo "  git -C $GRAPH_DIR commit -m 'Initialize dsh-graph data repository'"
else
  git -C "$GRAPH_DIR" init -b main 2>&1 || {
    # 老 Git 不支持 -b
    git -C "$GRAPH_DIR" init
    git -C "$GRAPH_DIR" branch -M main
  }
  # 配置内层仓库用户信息
  git -C "$GRAPH_DIR" config user.email "$(git config user.email 2>/dev/null || echo 'dsh-graph@local')"
  git -C "$GRAPH_DIR" config user.name "$(git config user.name 2>/dev/null || echo 'dsh-graph')"

  # 内层 .gitignore：排除运行态/派生内容，保留耐久数据（含 events.jsonl）
  cat > "$GRAPH_DIR/.gitignore" << 'INNER_GITIGNORE'
# dsh-graph 数据仓库 ignore 策略（g-149）
# 跟踪：项目配置、目标、版本、卡片、事件流（R-02 审计证据）、skills、规则
# 排除：高频运行态索引、order.json、交接旧版归档

/order.json
/index.json
/handoffs/
INNER_GITIGNORE

  echo "✅ 内层 .gitignore 已创建"
  echo "--- 内层待提交文件 ---"
  git -C "$GRAPH_DIR" status --short
  echo ""

  git -C "$GRAPH_DIR" add -A
  git -C "$GRAPH_DIR" diff --cached --check 2>/dev/null || true
  git -C "$GRAPH_DIR" commit -m "Initialize dsh-graph data repository"
  echo "✅ 内层首提完成"
  git -C "$GRAPH_DIR" log --oneline -1
fi
echo ""

# ===== Step 2: 父仓库 untrack =====
echo "--- Step 2: 父仓库取消跟踪 .dsh-graph ---"
if $DRY_RUN; then
  echo "[dry-run] 将执行："
  echo "  在根 .gitignore 添加 /.dsh-graph/ 规则"
  echo "  git rm -r --cached -- .dsh-graph"
  echo "  git add .gitignore"
  echo "  git commit -m 'chore: manage dsh-graph data in its own repository'"
else
  # 检查根 .gitignore 是否已有 /.dsh-graph/ 规则
  if ! grep -q '^/\.dsh-graph/$' .gitignore 2>/dev/null; then
    # 添加 ignore 规则（保留现有条目）
    echo "" >> .gitignore
    echo "# g-149: .dsh-graph 由独立 Git 仓库管理，不再由父仓库跟踪" >> .gitignore
    echo "/.dsh-graph/" >> .gitignore
    echo "✅ 已向根 .gitignore 添加 /.dsh-graph/ 规则"
  else
    echo "ℹ️  根 .gitignore 已包含 /.dsh-graph/ 规则"
  fi

  # 从父仓库索引删除（不删文件）
  git rm -r --cached -- .dsh-graph 2>&1 || echo "ℹ️  git rm --cached 部分文件可能已不在索引中"
  git diff --cached --check 2>/dev/null || true
  git add .gitignore
  echo ""
  echo "--- 父库 untrack 状态 ---"
  git diff --cached --name-status -- .dsh-graph | head -20
  echo "..."

  git commit -m "chore: manage dsh-graph data in its own repository (g-149)"
  echo "✅ 父库 untrack 提交完成"
fi
echo ""

# ===== Step 3: 验证 =====
echo "--- Step 3: 验证 ---"
if $DRY_RUN; then
  echo "[dry-run] 将验证："
  echo "  内层 git -C .dsh-graph rev-parse --show-toplevel"
  echo "  父库 git ls-files .dsh-graph（应无输出）"
  echo "  git check-ignore -v .dsh-graph/project.yaml"
  echo "  test -d .dsh-graph/.git"
else
  echo "内层 top-level："
  git -C "$GRAPH_DIR" rev-parse --show-toplevel
  echo ""

  PARENT_TRACKS=$(git ls-files .dsh-graph 2>/dev/null | wc -l)
  echo "父库仍跟踪 .dsh-graph 文件数：$PARENT_TRACKS（应为 0）"
  if [[ "$PARENT_TRACKS" -gt 0 ]]; then
    echo "⚠️  警告：父库仍跟踪 $PARENT_TRACKS 个文件"
  fi
  echo ""

  if [[ -f "$GRAPH_DIR/project.yaml" ]]; then
    echo "git check-ignore 验证："
    git check-ignore -v "$GRAPH_DIR/project.yaml" || echo "⚠️  未被忽略"
  fi
  echo ""

  echo "内层仓库存在性："
  test -d "$GRAPH_DIR/.git" && echo "✅ .dsh-graph/.git 存在" || echo "❌ .dsh-graph/.git 不存在"
  echo ""

  echo "内层事件流跟踪状态："
  if [[ -f "$GRAPH_DIR/events.jsonl" ]]; then
    git -C "$GRAPH_DIR" ls-files events.jsonl | grep -q events.jsonl && echo "✅ events.jsonl 已跟踪" || echo "❌ events.jsonl 未跟踪"
  else
    echo "ℹ️  events.jsonl 不存在（将在首次写操作时创建）"
  fi
fi
echo ""

# ===== Step 4: 远端配置（仅 --apply 且 --remote 时） =====
if [[ -n "$REMOTE" ]] && ! $DRY_RUN; then
  echo "--- Step 4: 配置远端 ---"
  git -C "$GRAPH_DIR" remote add origin "$REMOTE" 2>/dev/null || git -C "$GRAPH_DIR" remote set-url origin "$REMOTE"
  echo "✅ 已配置远端："
  git -C "$GRAPH_DIR" remote -v
  echo ""
  echo "ℹ️  远端已配置但未 push。请手动执行："
  echo "  git -C .dsh-graph push -u origin main"
elif [[ -n "$REMOTE" ]]; then
  echo "--- Step 4: 远端配置 ---"
  echo "[dry-run] 将配置远端：$REMOTE"
  echo "[dry-run] 不会自动 push"
fi

echo ""
echo "===== 迁移完成 $(if $DRY_RUN; then echo '(dry-run)'; fi) ====="
echo ""
echo "后续步骤："
echo "  1. 运行回归测试：bash scripts/check_core.sh && bash scripts/check_plugin.sh && bash scripts/check_kanban.sh"
echo "  2. 验证看板仍可读取：在 DSH 会话中调用 graph_validate"
if $DRY_RUN; then
  echo "  3. 确认无误后，用 --apply 执行真实迁移"
fi
