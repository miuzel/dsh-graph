#!/usr/bin/env bash
# g-101 验收脚本 —— 由规划方（supervisor）在 planning 时编写并冻结（R-03）。
# 执行方不得修改本文件；如需变更走判据变更流程。
# 验证：包结构 → 隔离 DSH_HOME 中真实加载 → 工具注册可见 → core 自测落盘。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. 单元测试（含新增 attempt/status） =="
node --test core/tests/*.test.ts

echo "== 2. 核心 CLI 冒烟：start-attempt / report-status =="
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
node core/main.ts --root "$TMP/g" init > /dev/null
ID=$(node core/main.ts --root "$TMP/g" create-goal --title 插件测试 --version v-t)
ATT=$(node core/main.ts --root "$TMP/g" start-attempt --goal "$ID" --executor agent:test)
node core/main.ts --root "$TMP/g" report-status --goal "$ID" --attempt "$ATT" --status "正在测试状态汇报"
node core/main.ts --root "$TMP/g" validate
node core/main.ts --root "$TMP/g" rebuild --check

echo "== 3. 插件真实加载（隔离 DSH_HOME + headless + --patch overlay） =="
DSH_HOME_DIR="$TMP/home"
WS="$TMP/ws"
mkdir -p "$WS"
node core/main.ts --root "$WS/.dsh-graph" init > /dev/null

# 初始化隔离 profile（首次使用自动建）
DSH_HOME="$DSH_HOME_DIR" dsh --profile headless --dump-default-config > /dev/null 2>&1
PROFILE_DIR="$DSH_HOME_DIR/profiles/headless"
test -d "$PROFILE_DIR" || { echo "FAIL: headless profile 未初始化"; exit 1; }

PLUGIN_ENTRY="$(pwd)/dsh-graph-host/index.js"
REL=$(realpath --relative-to="$PROFILE_DIR" "$PLUGIN_ENTRY")
cat > "$TMP/overlay.yml" <<YAML
- insert:
    - id: dsh-graph-host
      name: '$REL'
      config:
        root: '$WS/.dsh-graph'
        marker: '$TMP/marker.json'
YAML

# 全量启动；凭据缺失会非零退出，但插件加载与自测先于 LLM 调用发生
set +e
( cd "$WS" && DSH_HOME="$DSH_HOME_DIR" dsh --profile headless --patch "$TMP/overlay.yml" "ping" ) > "$TMP/run.log" 2>&1
set -e

test -f "$TMP/marker.json" || { echo "FAIL: marker 未生成（插件未加载）"; tail -20 "$TMP/run.log"; exit 1; }
node -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[2], "utf8"));
const need = ["graph_create_goal","graph_set_criteria","graph_transition","graph_add_card","graph_fill_card","graph_review_card","graph_validate","graph_rebuild","graph_report_status","graph_start_attempt"];
const missing = need.filter((t) => !m.tools.includes(t));
if (missing.length) { console.error("FAIL: 工具未注册: " + missing.join(",")); process.exit(1); }
if (m.validate !== "PASS") { console.error("FAIL: 插件内 core validate 未通过: " + m.validate); process.exit(1); }
console.log("marker: tools ok, validate PASS");
' x "$TMP/marker.json"

echo "check_plugin: PASS"
