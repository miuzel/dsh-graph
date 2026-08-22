#!/usr/bin/env bash
# g-125 验收脚本 —— 看板卡片精简：delivered/blocked 卡片默认折叠 + 上下文摘要折叠 2 行 + summary 写法约束。
# 执行方（att-001）编写；如需变更走判据变更流程（R-03）。
# 验证点（对应质量判据 1-4）：
#   1. client.js：delivered/blocked 状态卡片默认折叠——折叠态不渲染依赖、livestrip、执行会话按钮、上下文卡片列表（仅核心信息），可展开查看完整；
#   2. client.js：上下文卡片摘要默认折叠到 2 行（超长截断+省略号，可展开全文）；
#   3. summary 写法约束：graph_fill_card 工具描述 + supervisor-guide 信息收集规范（一句话要点、≤100 字左右）；
#   4. 核心单测回归 PASS。
set -euo pipefail
cd "$(dirname "$0")/.."
C=dsh-graph-host/lib/client.js
H=dsh-graph-host/index.js
G=dsh-graph-host/supervisor-guide.md

echo "== 0. 语法 =="
node --check "$C"
node --check "$H"

echo "== 1. delivered/blocked 卡片默认折叠精简（判据 1，负责人 fb1 修订：三角按钮置标题左侧） =="
# 折叠态判定：所有卡片统一 collapsed = !expanded（三角 ▸/▾ 标题左侧）；delivered/blocked 默认折叠由
# KanbanView 的 defExpanded 决定（delivered/blocked → false，其余 → true），手动切换记入 expandedGoals
grep -q "const collapsed = !expanded;" "$C" || { echo "FAIL: 缺 collapsed 折叠态判定"; exit 1; }
grep -q "const defExpanded = g.status !== \"delivered\" && g.status !== \"blocked\";" "$C" \
  || { echo "FAIL: 缺 delivered/blocked 默认折叠（defExpanded）"; exit 1; }
# 三角按钮（▸/▾）在标题左侧：chevron 先于标题渲染在同一行（titleRow 内 chevron 在前）
awk '/const chevron = h\("button"/,/^      }, collapsed \? "▸" : "▾"\);$/' "$C" | grep -q "▸" \
  || { echo "FAIL: 缺折叠三角 ▸"; exit 1; }
grep -q 'const titleRow = h("div"' "$C" || { echo "FAIL: 缺标题行 titleRow（chevron+标题同行）"; exit 1; }
awk '/const titleRow = h\("div"/,/titleRow,/' "$C" | grep -q "chevron" \
  || { echo "FAIL: titleRow 未包含 chevron（三角未在标题左侧）"; exit 1; }
# fb3（负责人反馈）：三角按钮样式——暗底纹、窄宽度、不用 S.btn/dg-btn（避免播放按钮观感、不占整列）
grep -q "className: \"dg-chevron\"" "$C" || { echo "FAIL: chevron 未用独立 .dg-chevron 类"; exit 1; }
grep -q '\.dg-chevron {' "$C" || { echo "FAIL: 缺 .dg-chevron 样式"; exit 1; }
grep -q "background: rgba(128,128,128,.18);" "$C" || { echo "FAIL: .dg-chevron 缺暗底纹（rgba(128,128,128,.18)）"; exit 1; }
grep -q "min-width: 16px;" "$C" || { echo "FAIL: .dg-chevron 缺窄宽度约束（min-width: 16px）"; exit 1; }
awk '/const chevron = h\("button"/,/^      }, collapsed \? "▸" : "▾"\);$/' "$C" | grep -q "S.btn" \
  && { echo "FAIL: chevron 仍复用 S.btn（默认按钮背景→播放按钮观感）"; exit 1; }
# 折叠态分支只渲染核心（标题+状态一行），不渲染 status_line/deps/livestrip/执行按钮/上下文卡片
awk '/if \(collapsed\) \{/,/^      }$/' "$C" | grep -q "titleRow" \
  || { echo "FAIL: 折叠态缺标题行"; exit 1; }
awk '/if \(collapsed\) \{/,/^      }$/' "$C" | grep -q "status_line" \
  && { echo "FAIL: 折叠态仍渲染 status_line（负责人 fb1：折叠态不显示 status_line）"; exit 1; }
awk '/if \(collapsed\) \{/,/^      }$/' "$C" | grep -q "(g.cards ?? \[\]).map" \
  && { echo "FAIL: 折叠态仍渲染上下文卡片列表"; exit 1; }
awk '/if \(collapsed\) \{/,/^      }$/' "$C" | grep -q "sessionLinkBtn" \
  && { echo "FAIL: 折叠态仍渲染执行会话按钮"; exit 1; }
awk '/if \(collapsed\) \{/,/^      }$/' "$C" | grep -q "LiveStrip" \
  && { echo "FAIL: 折叠态仍渲染 livestrip"; exit 1; }
# 完整分支仍渲染依赖/执行按钮/livestrip/上下文卡片（未误删活动阶段信息）
grep -q "⛓ 等待" "$C" || { echo "FAIL: 完整视图丢依赖等待标识"; exit 1; }
grep -q "(g.cards ?? \[\]).map" "$C" || { echo "FAIL: 完整视图丢上下文卡片列表"; exit 1; }
grep -q "sessionLinkBtn(g.attempt_parent_session_id" "$C" || { echo "FAIL: 完整视图丢执行会话按钮"; exit 1; }
echo "PASS: 判据 1"

echo "== 2. 上下文摘要折叠 2 行（判据 2） =="
grep -q "dg-summary-clamp" "$C" || { echo "FAIL: 缺摘要折叠类 dg-summary-clamp"; exit 1; }
grep -q -- "-webkit-line-clamp: 2" "$C" || { echo "FAIL: 缺 2 行截断 -webkit-line-clamp: 2"; exit 1; }
grep -q "点击展开摘要全文" "$C" || { echo "FAIL: 缺摘要展开交互（点击展开摘要全文）"; exit 1; }
grep -q "function CardSummary" "$C" || { echo "FAIL: 缺 CardSummary 组件"; exit 1; }
echo "PASS: 判据 2"

echo "== 3. summary 写法约束（判据 3） =="
# 工具描述：graph_fill_card 的 summary 必须简短（一句话要点、≤100 字左右）
grep -q "一句话要点式、≤100 字左右" "$H" || { echo "FAIL: graph_fill_card 工具描述缺 summary 长度约束"; exit 1; }
# supervisor-guide 信息收集规范沉淀写法要求（不带目标编号——提示词/指南文本对模型读者无干扰）
grep -q "summary 写法约束" "$G" || { echo "FAIL: supervisor-guide 缺 summary 写法约束条目"; exit 1; }
grep -q "≤100 字左右" "$G" || { echo "FAIL: supervisor-guide 缺 ≤100 字约束"; exit 1; }
# 收集提示词回填要求（client autoPrompt + host 收集默认提示词）
grep -q "一句话要点式摘要" "$C" || { echo "FAIL: client 收集提示词缺 summary 写法要求"; exit 1; }
grep -q "一句话要点式摘要（≤100 字左右）" "$H" || { echo "FAIL: host 收集默认提示词缺 summary 写法要求"; exit 1; }
# fb2（负责人反馈）：注入模型的提示词文本不得含目标编号（g-125 等）——干扰模型读者；
# 只查提示词文本行（description / autoPrompt / prompt 字符串），代码注释不注入模型、不算违规
grep -n "g-125" "$H" | grep -E "description:|prompt \|\||prompt\|\|" \
  && { echo "FAIL: host 提示词文本含目标编号 g-125"; exit 1; }
grep -n "g-125" "$C" | grep -E "const autoPrompt" \
  && { echo "FAIL: client 提示词文本含目标编号 g-125"; exit 1; }
grep -q "summary 写法约束（g-125）" "$G" \
  && { echo "FAIL: supervisor-guide 条目仍带目标编号 g-125"; exit 1; }
echo "PASS: 判据 3"

echo "== 4. 核心单测回归（判据 4） =="
node --test core/tests/*.test.ts > /dev/null

echo "PASS: g-125 静态验收全部通过"
