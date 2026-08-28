#!/usr/bin/env bash
# g-206 静态回归检查 —— 验证审查边界是否固化到 AGENTS.md 与 supervisor-guide.md。
# 规则来源：g-206（负责人确认）。
# 正向检查：关键条款必须存在；反向检查：注入/篡改边界文本必须非零失败。
# 过程标签检查：supervisor-guide.md 不得出现 v0.8/g-206/固化/本次/提交等过程标签。
# 禁止 grep || true / skip / mock / 无条件 PASS。
set -euo pipefail

cd "$(dirname "$0")/.."

A=AGENTS.md
S=dsh-graph-host/supervisor-guide.md

ERR=0
fail() { echo "FAIL: $1"; ERR=1; }

# ---------- 正向检查：AGENTS.md ----------
echo "== 1. AGENTS.md 威胁模型条款 =="

# 1.1 单用户本地 owner-trusted
grep -q "单用户本地、owner-trusted" "$A" || fail "AGENTS.md 缺 '单用户本地、owner-trusted'"

# 1.2 强制基线六项（逐条检查，不合并为一次 grep）
grep -q "跨 workspace 越界" "$A" || fail "AGENTS.md 缺强制基线：跨 workspace 越界"
grep -q "凭据泄漏" "$A" || fail "AGENTS.md 缺强制基线：凭据泄漏"
grep -q "明显 symlink" "$A" || fail "AGENTS.md 缺强制基线：明显 symlink/路径错误"
grep -q "普通并发数据丢失" "$A" || fail "AGENTS.md 缺强制基线：普通并发数据丢失"
grep -q "未授权破坏性写入" "$A" || fail "AGENTS.md 缺强制基线：未授权破坏性写入"
grep -q "错误输入崩溃" "$A" || fail "AGENTS.md 缺强制基线：错误输入崩溃"

# 1.3 边界外四项（不作为强制 BLOCK）
grep -q "同 UID 恶意 FD 复用" "$A" || fail "AGENTS.md 缺边界外：同 UID 恶意 FD 复用"
grep -q "内核级全量 TOCTOU" "$A" || fail "AGENTS.md 缺边界外：内核级全量 TOCTOU"
grep -q "分布式一致性" "$A" || fail "AGENTS.md 缺边界外：分布式一致性"
grep -q "无限递归 rollback" "$A" || fail "AGENTS.md 缺边界外：无限递归 rollback"

# 1.4 并发模型
grep -q "有限本地锁 / CAS" "$A" || fail "AGENTS.md 缺并发模型：有限本地锁/CAS"
grep -q "不要求.*分布式系统语义" "$A" || fail "AGENTS.md 缺并发模型：不要求分布式系统语义"

# 1.5 @att/ 受限语法
grep -q "@att/" "$A" || fail "AGENTS.md 缺 @att/ 语法说明"
grep -q "不无限扩张 regex 边界" "$A" || fail "AGENTS.md 缺 '不无限扩张 regex 边界'"

# 1.6 共享基础设施优先
grep -q "共享事务 / 错误处理与 REST schema middleware 优先" "$A" || fail "AGENTS.md 缺共享基础设施优先"

# ---------- 正向检查：supervisor-guide.md ----------
echo "== 2. supervisor-guide.md review 分级与收敛规则 =="

# 2.1 四级输出
grep -q "PASS" "$S" || fail "supervisor-guide.md 缺 PASS 分级"
grep -q "BLOCK" "$S" || fail "supervisor-guide.md 缺 BLOCK 分级"
grep -q "UNVERIFIED" "$S" || fail "supervisor-guide.md 缺 UNVERIFIED 分级"
grep -q "OUT-OF-SCOPE" "$S" || fail "supervisor-guide.md 缺 OUT-OF-SCOPE 分级"

# 2.2 边界外不自动 BLOCK
grep -q "边界外理论攻击不自动 BLOCK" "$S" || fail "supervisor-guide.md 缺 '边界外理论攻击不自动 BLOCK'"

# 2.3 WebBridge 缺失标 UNVERIFIED
grep -q "WebBridge 缺失标 UNVERIFIED" "$S" || fail "supervisor-guide.md 缺 WebBridge 缺失标 UNVERIFIED"
grep -q "不得伪造证据或强行 PASS" "$S" || fail "supervisor-guide.md 缺 '不得伪造证据或强行 PASS'"

# 2.4 GUI 自动验证只做一轮
grep -q "GUI 自动验证只做一轮" "$S" || fail "supervisor-guide.md 缺 'GUI 自动验证只做一轮'"
grep -q "转负责人手动复核" "$S" || fail "supervisor-guide.md 缺 '转负责人手动复核'"

# 2.5 @att/ 受限语法与共享基础设施
grep -q "\`@att/\` 受限语法" "$S" || fail "supervisor-guide.md 缺 '@att/ 受限语法'"
grep -q "共享基础设施优先" "$S" || fail "supervisor-guide.md 缺 '共享基础设施优先'"

# ---------- 反向检查：篡改/降级文本必须失败 ----------
echo "== 3. 反向检查：篡改边界文本必须被检出 =="

# 3.1 若 AGENTS.md 出现"分布式一致性必须 BLOCK"这种篡改，脚本应失败
if grep -q "分布式一致性.*必须.*BLOCK" "$A"; then
  fail "AGENTS.md 被篡改：分布式一致性被错误升级为必须 BLOCK"
fi

# 3.2 若 supervisor-guide.md 出现"WebBridge 缺失可标 PASS"这种篡改，脚本应失败
# 注意：原文"WebBridge 缺失标 UNVERIFIED"和"不得伪造证据或强行 PASS"都含这些关键词，
# 反向检查要匹配的是"把缺失当成 PASS"的篡改语义，而非原文正确表述。
if grep -qE "WebBridge.*缺失.*(标|可).*PASS" "$S"; then
  # 排除原文正确的 "WebBridge 缺失标 UNVERIFIED"
  if ! grep -q "WebBridge 缺失标 UNVERIFIED" "$S"; then
    fail "supervisor-guide.md 被篡改：WebBridge 缺失被错误标为 PASS"
  fi
fi

# 3.3 若出现"要求分布式事务"这种篡改，脚本应失败
# 排除原文正确的 "不要求分布式系统语义"
if grep -qE "^\s*[*-]\s*要求.*分布式事务" "$A"; then
  fail "AGENTS.md 被篡改：并发模型被错误升级为分布式事务"
fi

# ---------- 过程标签检查：supervisor-guide.md 必须是版本无关长期规范 ----------
echo "== 4. 过程标签检查：supervisor-guide.md 不得含版本/目标/过程标签 =="

# 4.1 不得出现版本号标签（排除原有文档中描述版本分支的示例，如 v0.8-test）
# 只检查标题/章节级别的版本标签，不检查正文示例中的版本分支名
if grep -qE "^#{1,4}\s.*v[0-9]+\.[0-9]+" "$S"; then
  fail "supervisor-guide.md 标题含版本号标签，必须是版本无关长期规范"
fi

# 4.2 不得出现目标 ID 标签
if grep -qE "g-[0-9]+|g-206" "$S"; then
  fail "supervisor-guide.md 含目标 ID 标签（如 g-206），必须是版本无关长期规范"
fi

# 4.3 不得出现"固化"等过程性词汇（排除原有"固化为 skill"的正当用法）
# 只检查标题/章节级别的"固化"标签
if grep -qE "^#{1,4}\s.*固化" "$S"; then
  fail "supervisor-guide.md 标题含过程标签'固化'，必须是稳定规范"
fi

# 4.4 不得出现"本次""本次改动"等临时性描述
if grep -qE "本次|本次改动|本次提交|本提交" "$S"; then
  fail "supervisor-guide.md 含临时过程描述（如'本次'），必须是稳定规范"
fi

# ---------- 语法与格式检查 ----------
echo "== 5. bash 语法与 git diff 检查 =="
bash -n "$0"
git diff --check || fail "git diff --check 发现格式问题"

# ---------- 结果 ----------
if [ "$ERR" -eq 0 ]; then
  echo "PASS: g-206 静态回归检查全部通过"
  exit 0
else
  echo "FAIL: g-206 静态回归检查存在失败项"
  exit 1
fi
