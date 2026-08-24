#!/usr/bin/env bash
#
# dev-dsh-instance.sh — 在**与主 dsh 隔离**的 profile 里跑一个可重现的测试 dsh 实例，
# 用来开发/验证本地 dsh-graph-host（不占用主 dsh 正在用的 3080 profile）。
#
# 解决的问题
# -----------
# 主 GUI（dsh --profile web，默认 3080）的 package.json 当前把 dsh-graph 指向本地
#   link:/…/dsh-graph-host。这会让“正在开发中的 dsh-graph 插件”直接注入生产 profile，
#   哪天改坏了，主 GUI 也跟着坏。此脚本把开发搬进一个独立 profile，主 dsh 则切到
#   已发布（稳定）的 dsh-graph npm 包。
#
# 本脚本做什么
# -----------
#   1. 建一个与 web 隔离的测试 profile（dsh-graph-test），把 dsh-graph
#      绑定到本地 dsh-graph-host（link:），其余 bundle 复用 web 壳的最小集
#      （@deepseek-ai/dsh-base + @deepseek-ai/dsh-web-app + dsh-graph）。
#   2. 在 <PORT>（默认 3082，避开已被占用的 3081）上拉起 `dsh --profile <PROFILE> --port <PORT>`。
#   3. 可选：把主 web profile 的 dsh-graph 从本地 link 切回已发布的 `^0.6.1`。
#
# 用法
# ----
#   scripts/dev-dsh-instance.sh run             # setup + 前台启动测试实例（默认端口 3082）
#   scripts/dev-dsh-instance.sh run --port 3090 # 指定端口
#   scripts/dev-dsh-instance.sh setup           # 只建 profile，不启动
#   scripts/dev-dsh-instance.sh main-published  # 把主 web profile 切到已发布 dsh-graph
#   scripts/dev-dsh-instance.sh main-dev        # 把主 web profile 切回本地 link（开发态）
#   scripts/dev-dsh-instance.sh status          # 打印两个 profile 的 dsh-graph 依赖与端口占用
#
# 环境变量（均可覆盖，脚本内已给合理默认值）
#   DSH_HOME=$HOME/.dsh          profiles 根
#   PROFILE=dsh-graph-test       测试 profile 名
#   PORT=3082                    测试实例端口（必须 ≠ 3080）
#   CWD=…                        测试实例的工作目录（决定 .dsh-graph 数据落在哪）
#   HOST_DIR=…$REPO/dsh-graph-host  本地 host 插件目录
#   PUBLISHED_VER=^0.6.1         已发布版本 spec
#   MAIN_PROFILE=web             主 profile 名
#
set -euo pipefail

# ---- 定位仓库根（即使从任意 cwd 调用也正确） ----
SELF="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

# ---- 常量 / 可覆盖默认值 ----
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${PROFILE:-dsh-graph-test}"
PORT="${PORT:-3082}"
HOST_DIR="${HOST_DIR:-$REPO_ROOT/dsh-graph-host}"
PUBLISHED_VER="${PUBLISHED_VER:-^0.6.1}"
MAIN_PROFILE="${MAIN_PROFILE:-web}"
# 测试实例的工作目录：默认放在 $DSH_HOME 下、非 git 仓库，确保 .dsh-graph 完全独立，
# 不会和主 GUI/代码仓库的那份发生 g-149 canonicalize 合并。
CWD="${CWD:-$DSH_HOME/dev-workspace/$PROFILE}"

PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
MAIN_DIR="$DSH_HOME/profiles/$MAIN_PROFILE"

# ---- 基建检查 ----
need() { command -v "$1" >/dev/null 2>&1 || { echo "错误：缺少命令 $1" >&2; exit 127; }; }
need dsh
need pnpm
need node

die() { echo "错误：$*" >&2; exit 1; }

[ -f "$HOST_DIR/package.json" ] || die "本地 host 插件目录不存在：$HOST_DIR"
HOST_NAME="$(node -e 'console.log(require(process.argv[1]).name)' "$HOST_DIR/package.json")"
[ "$HOST_NAME" = "dsh-graph" ] || die "$HOST_DIR/package.json 的 name 应为 dsh-graph，实际是 $HOST_NAME"

# ---- 打印一个 profile 的 dsh-graph 依赖 ----
show_dep() { # $1 = profile dir
  local dir="$1"
  if [ -f "$dir/package.json" ]; then
    node -e '
      const m = require(process.argv[1]);
      const dep = m.dependencies && m.dependencies["dsh-graph"];
      const b = (m.dsh && m.dsh.profile && m.dsh.profile.bundles) || [];
      console.log("  dsh-graph dependency: " + (dep || "(未声明)"));
      console.log("  bundled: " + (b.includes("dsh-graph") ? "是" : "否"));
    ' "$dir/package.json"
  else
    echo "  （profile 未初始化）"
  fi
}

# ---- setup：写入测试 profile 的全部文件并安装/对账 ----
setup() {
  echo "==> 准备测试 profile：$PROFILE_DIR"
  mkdir -p "$PROFILE_DIR" "$CWD"

  # 测试 profile 的 manifest：最小 web 壳 + 本地 dsh-graph（link:），与主 profile 隔离。
  cat > "$PROFILE_DIR/package.json" <<MANIFEST
{
  "name": "dsh-profile-$PROFILE",
  "private": true,
  "dependencies": {
    "dsh-graph": "link:$HOST_DIR"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-graph"
      ]
    }
  }
}
MANIFEST

  # 空根配置 + 空的用户 patch 层（boot 时 loader 会重写 cordis.yml；这里给一个干净起点）。
  cat > "$PROFILE_DIR/cordis.yml" <<'ROOT'
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
ROOT
  cat > "$PROFILE_DIR/cordis.patch.yml" <<'PATCH'
# 测试 profile 用户 patch 层：默认无覆盖。如需覆盖 dsh-graph-host 的 config（如把
# root 指到绝对路径以强制隔离数据目录），在此用 id 覆盖：
# - id: dsh-graph-host
#   config:
#     root: /abs/path/to/.dsh-graph
[]
PATCH

  # pnpm / npm 相关配置，与主 web profile 保持一致。
  cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'WS'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
WS
  printf 'minimum-release-age=0\n' > "$PROFILE_DIR/.npmrc"

  # 安装并把 bundle 层与安装态对账（base/web-app 来自 dsh 安装，无需 pnpm 装）。
  echo "==> dsh plugin --profile $PROFILE install"
  dsh plugin --profile "$PROFILE" install

  echo "==> 测试 profile 就绪"
  show_dep "$PROFILE_DIR"
}

# ---- run：setup 后前台启动测试实例 ----
run() {
  # 解析 `run [--port N] [--host H] [其余 web 应用参数…]`，避免重复 --port。
  local app_args=()
  local port="$PORT" host=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --port) [ "$#" -ge 2 ] || die "--port 需要一个值"; port="$2"; shift 2 ;;
      --host) [ "$#" -ge 2 ] || die "--host 需要一个值"; host="$2"; shift 2 ;;
      --) shift; app_args+=("$@"); break ;;
      *) app_args+=("$1"); shift ;;
    esac
  done
  PORT="$port"
  setup
  # 门禁：测试端口不允许用主 dsh 的 3080。
  if [ "$PORT" = "3080" ]; then
    die "--port 不能是 3080（那是主 dsh）。请另选，例如 --port 3082"
  fi
  echo "==> 启动测试 dsh：--profile $PROFILE --port $PORT"
  echo "    cwd=$CWD（.dsh-graph 数据落在 $CWD/.dsh-graph）"
  echo "    浏览器地址：http://127.0.0.1:$PORT"
  echo "    （默认 --no-open；需要自动开浏览器请追加 --open）"
  mkdir -p "$CWD"
  # 把解析后的参数透传给 web 应用（如 --open / --trusted-host …）。
  cd "$CWD"
  local launch_args=()
  [ -n "$host" ] && launch_args+=(--host "$host")
  launch_args+=(--port "$PORT" "${app_args[@]}")
  exec dsh --profile "$PROFILE" "${launch_args[@]}"
}

# ---- 修改一个 profile 的 dsh-graph 依赖到给定 spec ----
set_main_dep() { # $1 = spec（如 ^0.6.1 或 link:/…/dsh-graph-host）
  local spec="$1"
  [ -f "$MAIN_DIR/package.json" ] || die "主 profile 不存在：$MAIN_DIR"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const spec = process.argv[2];
    const m = JSON.parse(fs.readFileSync(path, "utf8"));
    m.dependencies = m.dependencies || {};
    const prev = m.dependencies["dsh-graph"];
    m.dependencies["dsh-graph"] = spec;
    fs.writeFileSync(path, JSON.stringify(m, null, 2) + "\n");
    console.log("主 profile " + process.argv[3]);
    console.log("  dsh-graph: " + prev + "  ->  " + spec);
  ' "$MAIN_DIR/package.json" "$spec" "$MAIN_PROFILE"
  echo "==> 重新安装并对账：dsh plugin --profile $MAIN_PROFILE install"
  dsh plugin --profile "$MAIN_PROFILE" install
  echo "==> 请注意：主 dsh（$MAIN_PROFILE，3080）需要**重启/刷新**后才会使用新的 dsh-graph 版本。"
  echo "    建议顺序：先在本脚本 run 的测试实例(端口 $PORT)验证 OK，再切主 profile 并重启主 GUI。"
}

cmd_main_published() {
  set_main_dep "$PUBLISHED_VER"
}
cmd_main_dev() {
  set_main_dep "link:$HOST_DIR"
}

cmd_status() {
  echo "== 主 profile: $MAIN_PROFILE（$MAIN_DIR）"
  show_dep "$MAIN_DIR"
  echo "== 测试 profile: $PROFILE（$PROFILE_DIR）"
  show_dep "$PROFILE_DIR"
  echo "== 端口监听"
  (ss -ltn 2>/dev/null | grep -E ':(3080|'"$PORT"')\b') || echo "  3080 / $PORT 状态未知或未监听"
}

usage() {
  sed -n '2,30p' "$SELF" | sed 's/^# \{0,1\}//' | sed 's/^#//'
  echo
  echo "可用子命令：run | setup | main-published | main-dev | status | help"
}

case "${1:-help}" in
  run)            shift; run "$@" ;;
  setup)          setup ;;
  main-published) cmd_main_published ;;
  main-dev)       cmd_main_dev ;;
  status)         cmd_status ;;
  help|-h|--help) usage ;;
  *) die "未知子命令：$1（用 help 查看用法）" ;;
esac
