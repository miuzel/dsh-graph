#!/usr/bin/env bash
# Start an isolated DSH web instance for one published version.
# The web alias owns the fixed "web" profile; DSH_HOME is the isolation boundary.
set -euo pipefail
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$SELF_DIR/.." && pwd -P)
VERSION=""; PORT=""; HOST=""; HOST_DIR=""; USE_PROXY=0; SKIP_INSTALL=0
die() { printf '错误：%s\n' "$*" >&2; exit 2; }
usage() { printf '用法：%s <DSH 版本> [--port PORT] [--proxychains] [--host HOST] [--host-dir PATH] [--skip-install]\n' "$(basename "$0")"; }
[ $# -gt 0 ] || { usage >&2; die '必须显式指定 DSH 版本'; }
VERSION=$1; shift
[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._+~-]*$ ]] || die "非法 DSH 版本：$VERSION"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) [ $# -ge 2 ] || die '--port 需要一个值'; [ -z "$PORT" ] || die '--port 不可重复'; PORT=$2; shift 2;;
    --host) [ $# -ge 2 ] || die '--host 需要一个值'; [ -z "$HOST" ] || die '--host 不可重复'; HOST=$2; shift 2;;
    --host-dir) [ $# -ge 2 ] || die '--host-dir 需要一个值'; [ -z "$HOST_DIR" ] || die '--host-dir 不可重复'; HOST_DIR=$2; shift 2;;
    --proxychains) [ "$USE_PROXY" -eq 0 ] || die '--proxychains 不可重复'; USE_PROXY=1; shift;;
    --skip-install|--no-install) [ "$SKIP_INSTALL" -eq 0 ] || die '--skip-install 不可重复'; SKIP_INSTALL=1; shift;;
    --help|-h) usage; exit 0;;
    --profile|--patch|--dump-config|--dump-default-config|--open|--no-open|--workspace|--cwd|--dsh-home|--DSH_HOME|--) die "禁止透传受管参数：$1";;
    *) die "不支持的参数：$1（仅允许 --port、--host、--host-dir、--proxychains、--skip-install）";;
  esac
done
PORT="${PORT:-3082}"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "非法端口：$PORT"
(( PORT >= 1 && PORT <= 65535 )) || die "非法端口：$PORT（必须为 1-65535）"
[ "$PORT" != 3080 ] || die '拒绝端口 3080（生产 DSH web）'
command -v pnpx >/dev/null 2>&1 || die '缺少 pnpx；请安装 pnpm 后重试'
command -v node >/dev/null 2>&1 || die '缺少 node；无法检查端口'
if [ "$USE_PROXY" -eq 1 ]; then command -v proxychains4 >/dev/null 2>&1 || die '已请求 --proxychains，但找不到 proxychains4'; fi
port_in_use=0
if command -v ss >/dev/null 2>&1 && ss -H -ltn 2>/dev/null | awk -v p=":$PORT" '$4 ~ p"$" { found=1 } END { exit !found }'; then port_in_use=1
elif ! node -e 'const net=require("net"); const s=net.createServer(); s.once("error",()=>process.exit(1)); s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close(()=>process.exit(0)));' "$PORT"; then port_in_use=1
fi
[ "$port_in_use" -eq 0 ] || die "端口已占用：$PORT"
command -v realpath >/dev/null 2>&1 || die '缺少 realpath；无法安全检查测试根'
TMP_PATH="$REPO_ROOT/tmp"
[ -d "$TMP_PATH" ] || mkdir -p "$TMP_PATH"
TMP_ROOT=$(realpath -e "$TMP_PATH") || die "无法 canonicalize 测试根：$TMP_PATH"
case "$TMP_ROOT" in "$REPO_ROOT/tmp"|"$REPO_ROOT/tmp"/*) ;; *) die "仓库 tmp symlink 越界：$TMP_ROOT";; esac
# DSH_TEST_ROOT is only for the offline smoke, never a public launcher override.
if [ -n "${DSH_TEST_ROOT:-}" ] && [ "${DSH_TEST_MODE:-}" != 1 ]; then die "拒绝遗留 DSH_TEST_ROOT；仅离线 smoke 可使用内部 override"; fi
TEST_ROOT="${DSH_TEST_ROOT:-$TMP_ROOT/dsh-test}"
[[ "$TEST_ROOT" = /* ]] || die "DSH_TEST_ROOT 必须是 canonical tmp 下的绝对路径"
case "$TEST_ROOT" in *"/../"*|*/..|../*|.. ) die "DSH_TEST_ROOT 禁止包含 ..";; esac
TEST_ROOT=$(realpath -m "$TEST_ROOT") || die "无法 canonicalize DSH_TEST_ROOT：$TEST_ROOT"
case "$TEST_ROOT" in "$TMP_ROOT"|"$TMP_ROOT"/*) ;; *) die "DSH_TEST_ROOT 必须位于 canonical $TMP_ROOT 下";; esac
if [ -e "$TEST_ROOT" ] && [ "$(realpath -e "$TEST_ROOT")" != "$TEST_ROOT" ]; then die "DSH_TEST_ROOT 不得通过 symlink 越界：$TEST_ROOT"; fi
# FULL_VERSION = raw requested dsh version. Workspace/cache/effective-config/pnpm-store and the
# pnpx/dsh package target stay per FULL_VERSION; only DSH_HOME moves to the shared stable base home.
FULL_VERSION="$VERSION"
# STABLE_VERSION: SemVer prerelease v?MAJOR.MINOR.PATCH-suffix maps to v?MAJOR.MINOR.PATCH
# (v kept iff the input has v, e.g. v0.1.2-alpha.4 -> v0.1.2, 0.1.1-rc.2 -> 0.1.1).
# Stable / non-prerelease versions stay unchanged.
STABLE_VERSION="$FULL_VERSION"
if [[ "$FULL_VERSION" =~ ^(v?[0-9]+\.[0-9]+\.[0-9]+)-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
  STABLE_VERSION="${BASH_REMATCH[1]}"
fi
VERSION_ROOT="$TEST_ROOT/$FULL_VERSION"
DSH_HOME="$TEST_ROOT/$STABLE_VERSION/home"
WORKSPACE="$VERSION_ROOT/workspace"
CACHE_ROOT="$VERSION_ROOT/cache"
HOST_DIR="${HOST_DIR:-$REPO_ROOT/dist}"
HOST_DIR=$(realpath -e "$HOST_DIR") || die "无法 canonicalize 本地插件目录：$HOST_DIR"
case "$HOST_DIR" in "$REPO_ROOT/dist"|"$REPO_ROOT/dsh-graph-host"|"$REPO_ROOT/.worktrees"/*/dist|"$REPO_ROOT/.worktrees"/*/dsh-graph-host) ;; *) die "--host-dir 必须位于仓库 dist、dsh-graph-host 或 .worktrees 下：$HOST_DIR";; esac
[ -f "$HOST_DIR/package.json" ] || die "本地插件缺失：$HOST_DIR/package.json"
[ "$(node -e 'console.log(require(process.argv[1]).name)' "$HOST_DIR/package.json")" = "dsh-graph" ] || die "本地插件 package name 必须为 dsh-graph：$HOST_DIR/package.json"
# The web alias owns the fixed web profile; DSH_HOME (stable base home, shared across a prerelease family) is the profile boundary.
mkdir -p "$DSH_HOME" "$WORKSPACE" "$CACHE_ROOT/npm" "$CACHE_ROOT/xdg" "$VERSION_ROOT/pnpm-store"
cd "$WORKSPACE"
export DSH_HOME npm_config_cache="$CACHE_ROOT/npm" pnpm_config_store_dir="$VERSION_ROOT/pnpm-store" XDG_CACHE_HOME="$CACHE_ROOT/xdg"
printf '==> DSH %s | root %s | profile web | DSH_HOME %s | workspace %s | port %s\n' "$FULL_VERSION" "$TEST_ROOT" "$DSH_HOME" "$WORKSPACE" "$PORT"
PROFILE_MANIFEST="$DSH_HOME/profiles/web/package.json"
HOST_LINK="link:$HOST_DIR"
needs_install=1
profile_ready() {
  node -e 'const fs=require("fs"),path=require("path"); try { const mf=process.argv[1],host=fs.realpathSync.native(process.argv[2]),m=JSON.parse(fs.readFileSync(mf,"utf8")); const resolved=require.resolve("dsh-graph/package.json",{paths:[path.dirname(mf)]}); const p=JSON.parse(fs.readFileSync(resolved,"utf8")); process.exit(m.dependencies?.["dsh-graph"]!==process.argv[3] || fs.realpathSync.native(resolved)!==host || p.name!=="dsh-graph" || p.dsh?.bundle?.patch===void 0 ? 1 : 0); } catch { process.exit(1); }' "$PROFILE_MANIFEST" "$HOST_DIR/package.json" "$HOST_LINK"
}
if [ -f "$PROFILE_MANIFEST" ] && profile_ready; then needs_install=0; fi
if [ "$SKIP_INSTALL" -eq 1 ]; then
  [ "$needs_install" -eq 0 ] || die '--skip-install 要求目标 DSH_HOME 已有可复用的 dsh-graph profile；请先不带该参数运行一次'
  printf '==> 跳过 dsh-graph 插件安装（复用已有 profile）\n'
elif [ "$needs_install" -eq 1 ]; then
  install=(pnpx --yes "@deepseek-ai/dsh@$VERSION" plugin --profile web add @deepseek-ai/schemastery)
  install=(pnpx --yes "@deepseek-ai/dsh@$VERSION" plugin --profile web add "$HOST_LINK")
  printf '==> 安装本地 dsh-graph 插件（每版本 profile）\n'
  if [ "$USE_PROXY" -eq 1 ]; then proxychains4 -q "${install[@]}" || die "插件安装失败：DSH $VERSION profile web"; else "${install[@]}" || die "插件安装失败：DSH $VERSION profile web"; fi
fi
[ -f "$PROFILE_MANIFEST" ] || die "插件 profile manifest 缺失：$PROFILE_MANIFEST"
profile_ready || die "插件 profile/link/bundle 未就绪：$PROFILE_MANIFEST"
EFFECTIVE_CONFIG="$VERSION_ROOT/effective-config.yml"
if [ "$SKIP_INSTALL" -eq 1 ]; then
  command -v dsh >/dev/null 2>&1 || die '--skip-install 需要 PATH 中已有 dsh 命令'
  DSH_CMD=(dsh)
  printf '==> 复用 PATH 中的 dsh 命令（跳过 DSH 包安装）\n'
else
  DSH_CMD=(pnpx --yes "@deepseek-ai/dsh@$FULL_VERSION")
fi
dump=("${DSH_CMD[@]}" web --dump-config)
if [ "$USE_PROXY" -eq 1 ]; then proxychains4 -q "${dump[@]}" >"$EFFECTIVE_CONFIG" 2>/dev/null || die "无法读取 web effective config：DSH $VERSION"; else "${dump[@]}" >"$EFFECTIVE_CONFIG" 2>/dev/null || die "无法读取 web effective config：DSH $VERSION"; fi
grep -q "@deepseek-ai/dsh-base" "$EFFECTIVE_CONFIG" || die "web effective config 缺少 dsh-base：DSH $VERSION"
grep -q "@deepseek-ai/dsh-web-app" "$EFFECTIVE_CONFIG" || die "web effective config 缺少 dsh-web-app：DSH $VERSION"
grep -q "dsh-graph" "$EFFECTIVE_CONFIG" || die "web effective config 缺少 dsh-graph：DSH $VERSION"
cmd=("${DSH_CMD[@]}" web --no-open --port "$PORT")
[ -n "$HOST" ] && cmd+=(--host "$HOST")
printf '==> 加载本地 dsh-graph 插件\n'
if [ "$USE_PROXY" -eq 1 ]; then exec proxychains4 -q "${cmd[@]}"; else exec "${cmd[@]}"; fi
