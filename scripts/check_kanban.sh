#!/usr/bin/env bash
# g-102 验收脚本 —— 由规划方（supervisor）在 planning 时编写并冻结（R-03）。
# 执行方不得修改本文件；如需变更走判据变更流程。
# 验证：单测 → 看板数据投影 → 隔离 DSH_HOME 起 web 实例（非默认端口）实测三端点。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. 单元测试（含 boardProjection） =="
node --test core/tests/*.test.ts

echo "== 2. 看板数据投影冒烟 =="
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; [ -n "${WEBPID:-}" ] && kill "$WEBPID" 2>/dev/null || true' EXIT
node core/main.ts --root "$TMP/g" init > /dev/null
GID=$(node core/main.ts --root "$TMP/g" create-goal --title 看板样例目标 --version v-demo)
node core/main.ts --root "$TMP/g" start-attempt --goal "$GID" --executor agent:test > /dev/null
node core/main.ts --root "$TMP/g" report-status --goal "$GID" --attempt att-001 --status "演示状态行" > /dev/null
node core/main.ts --root "$TMP/g" create-goal --title 暂存样例 > /dev/null
node -e '
const { boardProjection } = await import("./core/ops.ts");
const b = boardProjection(process.argv[2]);
if (!b.versions.length || !b.versions[0].goals.length) throw new Error("版本/目标缺失");
const g = b.versions[0].goals[0];
if (g.status_line !== "演示状态行") throw new Error("status_line 缺失: " + JSON.stringify(g));
if (!b.backlog.length) throw new Error("backlog 缺失");
console.log("boardProjection ok:", JSON.stringify(b.versions[0].goals[0].id));
' x "$TMP/g"

echo "== 3. 隔离 web 实例实测（DSH_HOME 隔离 + 端口 4299） =="
DSH_HOME_DIR="$TMP/home"
WS="$TMP/ws"
mkdir -p "$WS"
cp -r "$TMP/g" "$WS/.dsh-graph"
DSH_HOME="$DSH_HOME_DIR" dsh --profile web --dump-default-config > /dev/null 2>&1  # 初始化 web profile
DSH_HOME="$DSH_HOME_DIR" dsh plugin --profile web add "$(pwd)/dsh-graph-client" --store-dir "$TMP/pnpm-store" > /dev/null
# 用户层 patch 按 id 覆盖 bundle 层 config：把 root 指向隔离图根（bundle 里硬编码的是真实工作区）
cat > "$DSH_HOME_DIR/profiles/web/cordis.patch.yml" <<YAML
- id: dsh-graph-client
  config:
    root: '$WS/.dsh-graph'
YAML

set +e
( cd "$WS" && DSH_HOME="$DSH_HOME_DIR" dsh web --port 4299 --no-open ) > "$TMP/web.log" 2>&1 &
WEBPID=$!
set -e
for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:4299/" && break; sleep 2; done

curl -sf "http://127.0.0.1:4299/" | grep -q "plugins/dsh-graph-client/client.js" || { echo "FAIL: index 未含插件 bundle"; tail -20 "$TMP/web.log"; exit 1; }
curl -sf -o /dev/null -w "%{http_code}" "http://127.0.0.1:4299/plugins/dsh-graph-client/client.js" | grep -q 200 || { echo "FAIL: client.js 未 serving"; exit 1; }
curl -sf "http://127.0.0.1:4299/api/dsh-graph" | node -e '
let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{
  const b=JSON.parse(s);
  if(!b.versions?.[0]?.goals?.[0]?.id) { console.error("FAIL: /api/dsh-graph 结构不对"); process.exit(1); }
  console.log("/api/dsh-graph ok:", b.versions[0].goals[0].id);
});'
kill "$WEBPID" 2>/dev/null || true
WEBPID=""

echo "check_kanban: PASS"
