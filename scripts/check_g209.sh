#!/usr/bin/env bash
# g-209 验收脚本 —— 按变更风险收敛 worktree 与 attempt 的规范验证。
# 验证点：
#   1. AGENTS.md 包含预建树模型、main 只读、版本分支、文档快速通道；
#   2. supervisor-guide.md 明确 attempt 复用、fresh reviewer、预建树规则（版本无关）；
#   3. 正向验证：文档中必须存在的正确规则；
#   4. 反向验证：文档中不得存在的误导文本（篡改检查），实际非零失败；
#   5. bash 语法检查通过；git 状态检查无意外变更。
# 禁止：no-op、skip、mock、grep||true、无条件 PASS、只检查自身。
set -euo pipefail
cd "$(dirname "$0")/.."

A=AGENTS.md
S=dsh-graph-host/supervisor-guide.md

ERR=0
fail() { echo "FAIL: $1"; ERR=1; }

# =====================================================================
# 0. bash 语法自检查（真实检查，不是 no-op）
# =====================================================================
echo "== 0. bash 语法自检查 =="
bash -n "$0" || { echo "FAIL: 本脚本自身有语法错误"; exit 1; }

# =====================================================================
# 1. AGENTS.md 正向验证
# =====================================================================
echo "== 1. AGENTS.md 正向验证 =="

# 1.1 必须存在 "Worktree Isolation by Change Risk" 章节
grep -q "## Worktree Isolation by Change Risk" "$A" || fail "AGENTS.md 缺 'Worktree Isolation by Change Risk' 章节"

# 1.2 main 只读原则
grep -q "main.*只读" "$A" || fail "AGENTS.md 未声明 main 只读"
grep -q "main.*只承载已发布版本" "$A" || fail "AGENTS.md 未明确 main 只承载已发布版本"

# 1.3 预建树模型：supervisor 先建 <version>-test 分支，再预创建 worktree
grep -q "<version>-test" "$A" || fail "AGENTS.md 未提及 <version>-test 分支模型"
grep -q "预创建并登记子代理 worktree" "$A" || fail "AGENTS.md 未要求预创建 worktree"
grep -q "绝不自行拉树" "$A" || fail "AGENTS.md 未禁止子代理自行拉树"
grep -q "绝不自行.*建分支" "$A" || fail "AGENTS.md 未禁止子代理自行建分支"
grep -q "绝不自行.*改分支" "$A" || fail "AGENTS.md 未禁止子代理自行改分支"

# 1.4 worktree=true 必须要求：专属路径、版本分支、基线 commit、禁止自行拉树
grep -q "专属 worktree 路径" "$A" || fail "AGENTS.md worktree=true 未要求专属路径"
grep -q "版本分支" "$A" || fail "AGENTS.md worktree=true 未要求版本分支"
grep -q "基线 commit" "$A" || fail "AGENTS.md worktree=true 未要求基线 commit"
grep -q "禁止自行拉树" "$A" || fail "AGENTS.md 未禁止自行拉树"

# 1.5 worktree=false 快速通道：只读审计 + 文档小修
grep -q "快速通道" "$A" || fail "AGENTS.md 未提及快速通道"
grep -q "只读审计" "$A" || fail "AGENTS.md 未提及只读审计"
grep -q "特别小的独立文档/记忆修改" "$A" || fail "AGENTS.md 未提及文档快速通道"

# 1.6 worktree=false 必须要求：显式理由、禁止写文件（只读审计场景）
grep -q "显式豁免，需理由" "$A" || fail "AGENTS.md worktree=false 未要求显式理由"
grep -q "明确禁止写文件" "$A" || fail "AGENTS.md worktree=false 未要求禁止写文件"

# 1.7 铁律：worktree=false 绝不意味着可直接修改 main
grep -q "绝不意味着可直接修改 main" "$A" || fail "AGENTS.md 未明确 worktree=false 绝不意味着可改 main"
grep -q "修改 main 分支（main 只读）" "$A" || fail "AGENTS.md 未明确禁止修改 main 分支"

# 1.8 必须包含 worktree 安全清理规则（逐项确认，禁止批量删除）
grep -q "Worktree 安全清理" "$A" || fail "AGENTS.md 缺 'Worktree 安全清理' 章节"
grep -q "禁止批量" "$A" || fail "AGENTS.md 未禁止批量删除"
grep -q "无未提交改动" "$A" || fail "AGENTS.md 未要求检查未提交改动"
grep -q "无活跃代理" "$A" || fail "AGENTS.md 未要求检查活跃代理"
grep -q "无唯一审计证据" "$A" || fail "AGENTS.md 未要求检查唯一审计证据"

# 1.9 必须保留 golden/3080/主DSH_HOME 隔离与人工 review/delivered gate
grep -q "golden" "$A" || fail "AGENTS.md 未保留 golden 隔离"
grep -q "3080" "$A" || fail "AGENTS.md 未保留 3080 隔离"
grep -q "主 DSH_HOME" "$A" || fail "AGENTS.md 未保留主 DSH_HOME 隔离"
grep -q "人工 review/delivered gate" "$A" || fail "AGENTS.md 未保留人工 review/delivered gate"

# =====================================================================
# 2. supervisor-guide.md 正向验证（版本无关制品）
# =====================================================================
echo "== 2. supervisor-guide.md 正向验证 =="

# 2.1 必须明确 main 只读
grep -q "main 只读" "$S" || fail "supervisor-guide.md 未明确 main 只读"

# 2.2 必须明确预创建 worktree 模型（版本无关的 <version>-test）
grep -q "预创建 worktree" "$S" || fail "supervisor-guide.md 未明确预创建 worktree"
grep -q "<version>-test" "$S" || fail "supervisor-guide.md 未使用 <version>-test 抽象"
grep -q "绝不自行拉树" "$S" || fail "supervisor-guide.md 未禁止子代理自行拉树"

# 2.3 必须明确 fresh reviewer 不等于新 worktree
grep -q "fresh reviewer 是新会话但不等于新 worktree" "$S" || fail "supervisor-guide.md 未明确 fresh reviewer ≠ 新 worktree"

# 2.4 必须明确同一候选小范围反馈优先 send_message 复用原 attempt
grep -q "send_message" "$S" || fail "supervisor-guide.md 未提及 send_message 复用"
grep -q "优先复用原执行 Agent 的既有 attempt 会话" "$S" || fail "supervisor-guide.md 未要求优先复用原 attempt"

# 2.5 必须明确只有新范围/实质返工/无法安全复用才开新 attempt
grep -q "只有新范围、实质返工、或无法安全复用" "$S" || fail "supervisor-guide.md 未明确新开 attempt 条件"

# 2.6 必须明确只写 graph 数据可显式不建 worktree，改源码仍隔离（在 supervisor-guide 的 worktree 隔离章节中）
grep -q "只写 graph 数据" "$S" || fail "supervisor-guide.md 未提及只写 graph 数据可免 worktree"
grep -q "改源码仍隔离" "$S" || fail "supervisor-guide.md 未明确改源码仍隔离"

# 2.7 worktree=false 必须不是可任意修改 main 的通行证
grep -q "绝不意味着可直接修改 main" "$S" || fail "supervisor-guide.md 未明确 worktree=false 绝不意味着可改 main"

# 2.8 必须包含旧 worktree 安全清理规则
grep -q "旧 worktree 清理" "$S" || fail "supervisor-guide.md 未提及旧 worktree 清理"
grep -q "禁止批量" "$S" || fail "supervisor-guide.md 未禁止批量删除"

# 2.9 版本无关检查：不得出现具体版本号、目标号、提交号、固化等过程标签
echo "== 2.9 supervisor-guide.md 版本无关检查 =="
# 允许 "固化为 skill" 出现在沉淀章节（这是通用术语，不是过程标签）
# 检查除沉淀章节外的其他位置是否出现过程标签
if grep -n -E "v0\.[0-9]+|g-[0-9]+|att-[0-9]+|本次改动|过程标签" "$S" >/dev/null 2>&1; then
  while IFS= read -r line; do
    # 允许 Worktree Naming 示例中的 g-<goal-number> 和 g-xxx-att-xx 模式
    if echo "$line" | grep -q "Examples:\|g-<goal-number>\|g-xxx-att-xx\|Worktree Naming"; then
      continue
    fi
    fail "supervisor-guide.md 包含过程标签/版本号（应版本无关）: $line"
  done < <(grep -n -E "v0\.[0-9]+|g-[0-9]+|att-[0-9]+|本次改动|过程标签" "$S" || true)
fi

# =====================================================================
# 3. 反向篡改检查（文档中不得存在的误导文本）—— 实际非零失败
# =====================================================================
echo "== 3. 反向篡改检查 =="

# 3.1 不得出现 "所有 review 必须新 worktree" 或等价误导
if grep -iq "所有.*review.*必须.*新.*worktree" "$A" "$S" 2>/dev/null; then
  fail "发现误导文本：'所有 review 必须新 worktree'"
fi
if grep -iq "review.*必须.*新建.*worktree" "$A" "$S" 2>/dev/null; then
  fail "发现误导文本：'review 必须新建 worktree'"
fi

# 3.2 不得出现 "worktree=false 可直接改 main" 或 "worktree=false 直接修改 main"
# 注意：正确的表述是 "绝不意味着可直接修改 main"，这里检查的是错误表述（没有"绝不意味着"前缀）
if grep -iq "worktree=false.*可直接改 main" "$A" "$S" 2>/dev/null; then
  fail "发现误导文本：'worktree=false 可直接改 main'"
fi
# 检查 "worktree=false 直接修改 main" 但不匹配 "绝不意味着可直接修改 main"
# 逐行检查：匹配行若含"绝不意味着"前缀则跳过，否则 FAIL
while IFS= read -r line; do
  if echo "$line" | grep -iq "绝不意味着"; then
    continue
  fi
  fail "发现误导文本：'worktree=false 直接修改 main' => $line"
done < <(grep -in "worktree=false.*直接修改 main" "$A" "$S" 2>/dev/null || true)

# 3.3 不得出现 "无需保留证据" 或等价误导
if grep -iq "无需保留证据" "$A" "$S" 2>/dev/null; then
  fail "发现误导文本：'无需保留证据'"
fi
if grep -iq "不需要保留证据" "$A" "$S" 2>/dev/null; then
  fail "发现误导文本：'不需要保留证据'"
fi

# 3.4 不得出现 "允许批量删除" 或 "可以批量删除"
if grep -iq "允许批量删除" "$A" "$S" 2>/dev/null; then
  fail "发现误导文本：'允许批量删除'"
fi
if grep -iq "可以批量删除" "$A" "$S" 2>/dev/null; then
  fail "发现误导文本：'可以批量删除'"
fi

# 3.5 不得削弱 main/golden/3080 隔离（检查是否出现"可修改 main"等）
if grep -iq "可修改 main" "$A" "$S" 2>/dev/null; then
  fail "发现误导文本：'可修改 main'"
fi
if grep -iq "可以修改 main" "$A" "$S" 2>/dev/null; then
  fail "发现误导文本：'可以修改 main'"
fi

# 3.6 不得出现 "子代理可自行拉树/建分支"（但允许"绝不自行拉树"等正确表述）
# 逐行检查：匹配行若含"绝不/禁止/不得/不能/不可"前缀则跳过，否则 FAIL
while IFS= read -r line; do
  if echo "$line" | grep -iq "绝不\|禁止\|不得\|不能\|不可"; then
    continue
  fi
  fail "发现误导文本：子代理可自行拉树 => $line"
done < <(grep -in "子代理.*自行.*拉树" "$A" "$S" 2>/dev/null || true)
while IFS= read -r line; do
  if echo "$line" | grep -iq "绝不\|禁止\|不得\|不能\|不可"; then
    continue
  fi
  fail "发现误导文本：子代理可自行建分支 => $line"
done < <(grep -in "子代理.*自行.*建分支" "$A" "$S" 2>/dev/null || true)

# =====================================================================
# 4. git 状态检查 —— 确保只有预期文件被修改
# =====================================================================
echo "== 4. git 状态检查 =="

# 4.0 确认在 git 仓库中
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  fail "当前目录不是 git 仓库"
fi

# 4.1 检查工作树是否有未跟踪文件或改动
UNTRACKED=$(git status --porcelain 2>/dev/null | grep '^??' || true)
if [ -n "$UNTRACKED" ]; then
  fail "发现未跟踪文件：\n$UNTRACKED"
fi

# 4.2 检查已跟踪文件的改动（排除预期文件）
CHANGED_FILES=$(git status --porcelain 2>/dev/null | grep -v '^??' | awk '{print $2}' || true)

if [ -z "$CHANGED_FILES" ]; then
  echo "OK: 工作树干净，无意外变更"
else
  echo "检测到以下文件有改动："
  echo "$CHANGED_FILES"

  for f in $CHANGED_FILES; do
    case "$f" in
      AGENTS.md|dsh-graph-host/supervisor-guide.md|scripts/check_g209.sh)
        echo "  OK: $f 是预期修改的文件"
        ;;
      *)
        fail "非预期文件被修改: $f"
        ;;
    esac
  done
fi

# 4.3 检查 merge-base 到 HEAD 的变更文件集合（确保 main 未被改动）
MERGE_BASE=$(git merge-base HEAD main 2>/dev/null || true)
if [ -n "$MERGE_BASE" ]; then
  MERGE_CHANGED=$(git diff --name-only "$MERGE_BASE" HEAD 2>/dev/null || true)
  if [ -n "$MERGE_CHANGED" ]; then
    echo "merge-base 到 HEAD 的变更文件："
    echo "$MERGE_CHANGED"
    for f in $MERGE_CHANGED; do
      case "$f" in
        AGENTS.md|dsh-graph-host/supervisor-guide.md|scripts/check_g209.sh)
          echo "  OK: $f 是预期修改的文件"
          ;;
        *)
          fail "非预期文件在提交历史中: $f"
          ;;
      esac
    done
  fi
fi

# 4.4 git diff --check 检查空白错误
if ! git diff --check HEAD 2>/dev/null; then
  fail "git diff --check 发现空白错误（trailing whitespace 等）"
fi

# =====================================================================
# 5. 报告
# =====================================================================
echo ""
if [ "$ERR" -eq 0 ]; then
  echo "PASS: g-209 规范验证全部通过"
  echo "  - AGENTS.md: 预建树模型、main 只读、版本分支、快速通道、安全清理 ✓"
  echo "  - supervisor-guide.md: 预建树规则、attempt 复用、fresh reviewer、版本无关 ✓"
  echo "  - 反向篡改检查: 无误导文本 ✓"
  exit 0
else
  echo "FAIL: g-209 规范验证存在失败项，请检查上方输出"
  exit 1
fi
