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

echo "== 1. delivered/blocked 卡片默认折叠精简（判据 1） =="
# 折叠态判定：delivered 或 blocked 且未展开 → collapsed
grep -q 'const collapsed = (g.status === "delivered" || blocked) && !expanded;' "$C" \
  || { echo "FAIL: 缺 collapsed 折叠态判定"; exit 1; }
# 折叠态分支只渲染核心（标题/状态/阻塞原因/status_line/展开按钮），不渲染 deps/livestrip/执行按钮/上下文卡片
awk '/if \(collapsed\) \{/,/^      }$/' "$C" | grep -q "expandBtn" \
  || { echo "FAIL: 折叠态缺展开按钮引用"; exit 1; }
# 展开按钮文案：折叠态「▸ 展开完整」，展开态「▾ 收起精简」（expandBtn 定义在折叠分支之前）
grep -q "▸ 展开完整" "$C" || { echo "FAIL: 缺展开按钮文案（▸ 展开完整）"; exit 1; }
grep -q "▾ 收起精简" "$C" || { echo "FAIL: 缺收起按钮文案（▾ 收起精简）"; exit 1; }
# 折叠态分支不得包含上下文卡片列表渲染（g.cards ?? []).map）
awk '/if \(collapsed\) \{/,/^      }$/' "$C" | grep -q "(g.cards ?? \[\]).map" \
  && { echo "FAIL: 折叠态仍渲染上下文卡片列表"; exit 1; }
awk '/if \(collapsed\) \{/,/^      }$/' "$C" | grep -q "sessionLinkBtn" \
  && { echo "FAIL: 折叠态仍渲染执行会话按钮"; exit 1; }
awk '/if \(collapsed\) \{/,/^      }$/' "$C" | grep -q "LiveStrip" \
  && { echo "FAIL: 折叠态仍渲染 livestrip"; exit 1; }
# 完整分支仍渲染依赖与上下文卡片（未误删活动阶段信息）
grep -q "⛓ 等待" "$C" || { echo "FAIL: 完整视图丢依赖等待标识"; exit 1; }
grep -q "(g.cards ?? \[\]).map" "$C" || { echo "FAIL: 完整视图丢上下文卡片列表"; exit 1; }
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
# supervisor-guide 信息收集规范沉淀写法要求
grep -q "summary 写法约束（g-125）" "$G" || { echo "FAIL: supervisor-guide 缺 summary 写法约束条目"; exit 1; }
grep -q "≤100 字左右" "$G" || { echo "FAIL: supervisor-guide 缺 ≤100 字约束"; exit 1; }
# 收集提示词回填要求（client autoPrompt + host 收集默认提示词）
grep -q "一句话要点式摘要" "$C" || { echo "FAIL: client 收集提示词缺 summary 写法要求"; exit 1; }
echo "PASS: 判据 3"

echo "== 4. 核心单测回归（判据 4） =="
node --test core/tests/*.test.ts > /dev/null

echo "PASS: g-125 静态验收全部通过"
