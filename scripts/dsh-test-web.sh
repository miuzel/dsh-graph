#!/usr/bin/env bash
# Start an isolated DSH web instance for one published version.
# The web alias owns the fixed "web" profile; DSH_HOME is the isolation boundary.
#
# g-301：`--dry-run` / `--doctor` 为**只读预检**，复用启动路径自身的端口/工具/link/隔离检查，
# 如实报告工具可用性、候选路径、实际 link 目标、端口占用与 DSH_HOME/workspace 缺项
# （目录存在 ≠ 环境正确）。预检零副作用：不建目录、不安装、不写配置、不启动服务、不回显凭据。
# 危险/无效输入（非法端口含前导零、3080、危险字符、空值、生产 HOME 或看板路径）一律在
# mkdir/install/配置写入/启动**之前**以 exit 2 拒绝。
set -euo pipefail
SELF_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
REPO_ROOT=$(CDPATH= cd -- "$SELF_DIR/.." && pwd -P)
VERSION=""; PORT=""; HOST=""; HOST_DIR=""; HOST_DIR_EXPLICIT=0; USE_PROXY=0; SKIP_INSTALL=0; DRY_RUN=0
PROD_HOME="${HOME:-}"
die() { printf '错误：%s\n' "$*" >&2; exit 2; }
usage() {
  printf '用法：%s <DSH 版本> [--port PORT] [--proxychains] [--host HOST] [--host-dir PATH] [--skip-install] [--dry-run]\n' "$(basename "$0")"
  printf '  --dry-run|--doctor  只读预检：复用启动路径的端口/工具/link/隔离检查并如实报告缺项；\n'
  printf '                      零副作用（不建目录/不安装/不写配置/不启动/不回显凭据）。\n'
  printf '                      退出码：0=可按当前参数启动，1=存在阻塞项，2=非法或危险输入。\n'
  printf '  平台范围：linux/WSL2（bash + GNU coreutils）；原生 Windows / macOS 未验证。\n'
}
# --help/-h 在任何参数校验之前生效（不依赖位置参数，零副作用）。
case "${1:-}" in --help|-h) usage; exit 0;; esac
[ $# -gt 0 ] || { usage >&2; die '必须显式指定 DSH 版本'; }
VERSION=$1; shift
[[ "$VERSION" =~ ^[A-Za-z0-9][A-Za-z0-9._+~-]*$ ]] || die "非法 DSH 版本：$VERSION"
while [ $# -gt 0 ]; do
  case "$1" in
    --port) [ $# -ge 2 ] || die '--port 需要一个值'; [ -n "$2" ] || die '--port 值不能为空'; [ -z "$PORT" ] || die '--port 不可重复'; PORT=$2; shift 2;;
    --host) [ $# -ge 2 ] || die '--host 需要一个值'; [ -n "$2" ] || die '--host 值不能为空'; [ -z "$HOST" ] || die '--host 不可重复'; HOST=$2; shift 2;;
    --host-dir) [ $# -ge 2 ] || die '--host-dir 需要一个值'; [ -n "$2" ] || die '--host-dir 值不能为空'; [ -z "$HOST_DIR" ] || die '--host-dir 不可重复'; HOST_DIR=$2; HOST_DIR_EXPLICIT=1; shift 2;;
    --proxychains) [ "$USE_PROXY" -eq 0 ] || die '--proxychains 不可重复'; USE_PROXY=1; shift;;
    --skip-install|--no-install) [ "$SKIP_INSTALL" -eq 0 ] || die '--skip-install 不可重复'; SKIP_INSTALL=1; shift;;
    --dry-run|--doctor) [ "$DRY_RUN" -eq 0 ] || die '--dry-run 不可重复'; DRY_RUN=1; shift;;
    --help|-h) usage; exit 0;;
    --profile|--patch|--dump-config|--dump-default-config|--open|--no-open|--workspace|--cwd|--dsh-home|--DSH_HOME|--) die "禁止透传受管参数：$1";;
    *) die "不支持的参数：${1}（仅允许 --port、--host、--host-dir、--proxychains、--skip-install、--dry-run）";;
  esac
done
PORT="${PORT:-3082}"
[[ "$PORT" =~ ^[0-9]+$ ]] || die "非法端口：$PORT"
if [ "${#PORT}" -gt 1 ] && [[ "$PORT" = 0* ]]; then die "非法端口：${PORT}（禁止前导零）"; fi
(( PORT >= 1 && PORT <= 65535 )) || die "非法端口：${PORT}（必须为 1-65535）"
[ "$PORT" != 3080 ] || die '拒绝端口 3080（生产 DSH web）'
# --host 只接受主机名/IP 字面量所需字符：空值、前导 '-'、空白/换行与 shell 元字符一律先拒绝。
if [ -n "$HOST" ]; then
  [[ "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || die "非法 --host：${HOST}（仅允许字母/数字/.-_: 且不得以 - 开头）"
fi
# 工具可用性：启动路径缺任一即拒绝；只读预检只如实登记缺项（不自动安装、不自动修环境）。
if [ "$DRY_RUN" -eq 0 ]; then
  command -v pnpm >/dev/null 2>&1 || die '缺少 pnpm；请安装 pnpm 后重试'
  command -v node >/dev/null 2>&1 || die '缺少 node；无法检查端口'
  if [ "$USE_PROXY" -eq 1 ]; then command -v proxychains4 >/dev/null 2>&1 || die '已请求 --proxychains，但找不到 proxychains4'; fi
fi
# 端口占用：**保持原判定的逐字语义**（ss 命中即占用；否则退回 node 监听探测）。
# node 只短暂 bind/close，不监听服务；预检额外把「两种探测都不可用」如实标成无法探测。
PORT_STATE=free
probe_missing=0
command -v ss >/dev/null 2>&1 || command -v node >/dev/null 2>&1 || probe_missing=1
port_in_use=0
if command -v ss >/dev/null 2>&1 && ss -H -ltn 2>/dev/null | awk -v p=":$PORT" '$4 ~ p"$" { found=1 } END { exit !found }'; then port_in_use=1
elif ! command -v node >/dev/null 2>&1; then port_in_use=1
elif ! node -e 'const net=require("net"); const s=net.createServer(); s.once("error",()=>process.exit(1)); s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close(()=>process.exit(0)));' "$PORT"; then port_in_use=1
fi
if [ "$port_in_use" -eq 1 ]; then if [ "$probe_missing" -eq 1 ]; then PORT_STATE=unknown; else PORT_STATE=busy; fi; fi
[ "$DRY_RUN" -eq 1 ] || [ "$port_in_use" -eq 0 ] || die "端口已占用：$PORT"
if ! command -v realpath >/dev/null 2>&1; then
  [ "$DRY_RUN" -eq 0 ] || { printf '==> 只读预检：阻塞项：缺少 realpath；无法安全检查测试根\n' >&2; exit 1; }
  die '缺少 realpath；无法安全检查测试根'
fi
TMP_PATH="$REPO_ROOT/tmp"
# 只读预检不得创建任何目录：先用 realpath -m（不要求存在）完成 canonicalize 与越界判定，
# 目录创建推迟到全部输入校验之后。
TMP_ROOT=$(realpath -m "$TMP_PATH") || die "无法 canonicalize 测试根：$TMP_PATH"
case "$TMP_ROOT" in "$REPO_ROOT/tmp"|"$REPO_ROOT/tmp"/*) ;; *) die "仓库 tmp symlink 越界：$TMP_ROOT";; esac
# DSH_TEST_ROOT is only for the offline smoke, never a public launcher override.
if [ -n "${DSH_TEST_ROOT:-}" ] && [ "${DSH_TEST_MODE:-}" != 1 ]; then die "拒绝遗留 DSH_TEST_ROOT；仅离线 smoke 可使用内部 override"; fi
TEST_ROOT="${DSH_TEST_ROOT:-$TMP_ROOT/dsh-test}"
[[ "$TEST_ROOT" = /* ]] || die "DSH_TEST_ROOT 必须是 canonical tmp 下的绝对路径"
case "$TEST_ROOT" in *"/../"*|*/..|../*|.. ) die "DSH_TEST_ROOT 禁止包含 ..";; esac
TEST_ROOT=$(realpath -m "$TEST_ROOT") || die "无法 canonicalize DSH_TEST_ROOT：$TEST_ROOT"
# g-301：生产 HOME 与看板数据必须**先于**任何 mkdir/install/配置写入/启动被拒绝；
# 判定放在「必须在仓库 tmp 下」之前，以便给出准确原因。
case "$TEST_ROOT" in
  "$PROD_HOME"|"$PROD_HOME"/.dsh|"$PROD_HOME"/.dsh/*) die "拒绝把测试根指向生产 HOME：$TEST_ROOT";;
esac
case "$TEST_ROOT" in
  */.dsh-graph|*/.dsh-graph/*) die "拒绝把测试根指向看板数据：$TEST_ROOT";;
esac
case "$TEST_ROOT" in "$TMP_ROOT"|"$TMP_ROOT"/*) ;; *) die "DSH_TEST_ROOT 必须位于 canonical $TMP_ROOT 下";; esac
if [ -e "$TEST_ROOT" ] && [ "$(realpath -e "$TEST_ROOT")" != "$TEST_ROOT" ]; then die "DSH_TEST_ROOT 不得通过 symlink 越界：$TEST_ROOT"; fi
# FULL_VERSION = raw requested dsh version. Workspace/cache/effective-config/pnpm-store and the
# installed dsh runtime stay per FULL_VERSION; only DSH_HOME moves to the shared stable base home.
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
if [ -n "$HOST_DIR" ]; then
  HOST_DIR=$(realpath -e "$HOST_DIR") || die "无法 canonicalize 本地插件目录：$HOST_DIR"
else
  HOST_DIR="$REPO_ROOT/dist"
  [ ! -e "$HOST_DIR" ] || HOST_DIR=$(realpath -e "$HOST_DIR") || die "无法 canonicalize 本地插件目录：$HOST_DIR"
fi
# 生产 HOME / 看板：在 mkdir/install 之前显式拒绝（--host-dir 指向这些位置必然是误用）。
case "$HOST_DIR" in
  "$PROD_HOME"|"$PROD_HOME"/.dsh|"$PROD_HOME"/.dsh/*) die "拒绝把 --host-dir 指向生产 HOME：$HOST_DIR";;
esac
case "$HOST_DIR" in */.dsh-graph|*/.dsh-graph/*) die "拒绝把 --host-dir 指向看板数据：$HOST_DIR";; esac
case "$HOST_DIR" in "$REPO_ROOT/dist"|"$REPO_ROOT/dsh-graph-host"|"$REPO_ROOT/.worktrees"/*/dist|"$REPO_ROOT/.worktrees"/*/dsh-graph-host) ;; *) die "--host-dir 必须位于仓库 dist、dsh-graph-host 或 .worktrees 下：$HOST_DIR";; esac
# 本地插件必须可识别（启动路径的原有门禁，保持一字不差）；只读预检把它报成阻塞项/缺项而不提前退出。
HOST_PKG_OK=0
if [ -f "$HOST_DIR/package.json" ] && command -v node >/dev/null 2>&1; then
  if [ "$(node -e 'try{console.log(require(process.argv[1]).name)}catch(e){}' "$HOST_DIR/package.json" 2>/dev/null || true)" = dsh-graph ]; then HOST_PKG_OK=1; fi
fi
# 显式给出的 --host-dir 若不是本插件 ⇒ 无效输入，任何模式下先拒绝；默认 dist 缺失在预检里只报阻塞项。
if [ "$HOST_DIR_EXPLICIT" -eq 1 ] || [ "$DRY_RUN" -eq 0 ]; then
  [ -f "$HOST_DIR/package.json" ] || die "本地插件缺失：$HOST_DIR/package.json"
  [ "$HOST_PKG_OK" -eq 1 ] || die "本地插件 package name 必须为 dsh-graph：$HOST_DIR/package.json"
fi
# The web alias owns the fixed web profile; DSH_HOME (stable base home, shared across a prerelease family) is the profile boundary.
PROFILE_DIR="$DSH_HOME/profiles/web"
PROFILE_MANIFEST="$PROFILE_DIR/package.json"
RUNTIME_DIR="$VERSION_ROOT"
RUNTIME_DSH="$RUNTIME_DIR/node_modules/.bin/dsh"
ALLOW_BUILDS=()
HOST_LINK="link:$HOST_DIR"
# $1: pnpm project dir; remaining args: packages whose build scripts are allowed.
write_pnpm_root() {
  local dir=$1 pkg; shift
  mkdir -p "$dir"
  { printf 'packages:\n  - .\nautoInstallPeers: true\n'
    if [ $# -gt 0 ]; then printf 'allowBuilds:\n'; for pkg in "$@"; do printf "  '%s': true\n" "$pkg"; done; fi
  } >"$dir/pnpm-workspace.yaml"
}
# $1: pnpm log; prints the package names pnpm reported as having ignored build scripts.
ignored_build_pkgs() {
  node -e '
    const fs = require("fs");
    const m = fs.readFileSync(process.argv[1], "utf8").match(/Ignored build scripts:([\s\S]*?)(?:\n\s*\n|\n\s*help:|$)/);
    if (!m) process.exit(1);
    const names = m[1].split(/[\s,]+/).filter(Boolean).map((t) => t.match(/^(@[^@\s/]+\/[^@\s/]+|[^@\s/][^@\s/]*)@\d[^\s,)]*$/)).filter(Boolean);
    for (const hit of new Set(names.map((hit) => hit[1]))) console.log(hit);
  ' "$1"
}
# $1: pnpm project dir, $2: log file, rest: command. Returns the command's exit code.
run_pnpm_step() {
  local dir=$1 log=$2 rc=0; shift 2
  if [ "$USE_PROXY" -eq 1 ]; then ( cd "$dir" && proxychains4 -q "$@" ) 2>&1 | tee "$log" || rc=$?
  else ( cd "$dir" && "$@" ) 2>&1 | tee "$log" || rc=$?; fi
  return "$rc"
}
# $1: pnpm project dir, $2: log file, rest: command. Writes the private root first; on
# failure parses pnpm's ignored-build report, allows those packages and retries once.
install_step() {
  local dir=$1 log=$2 rc=0 pkg added=0; shift 2
  write_pnpm_root "$dir" ${ALLOW_BUILDS[@]+"${ALLOW_BUILDS[@]}"}
  run_pnpm_step "$dir" "$log" "$@" || rc=$?
  [ "$rc" -ne 0 ] || return 0
  local names=()
  while IFS= read -r pkg; do [ -n "$pkg" ] && names+=("$pkg"); done < <(ignored_build_pkgs "$log" 2>/dev/null || true)
  [ "${#names[@]}" -gt 0 ] || return "$rc"
  for pkg in "${names[@]}"; do
    case " ${ALLOW_BUILDS[*]-} " in *" $pkg "*) ;; *) ALLOW_BUILDS+=("$pkg"); added=1;; esac
  done
  [ "$added" -eq 1 ] || return "$rc"
  printf '==> 放行依赖构建脚本：%s（写入隔离根配置后重试一次）\n' "${names[*]}"
  write_pnpm_root "$dir" "${ALLOW_BUILDS[@]}"
  run_pnpm_step "$dir" "$log" "$@"
}
needs_install=1
profile_ready() {
  node -e 'const fs=require("fs"),path=require("path"); try { const mf=process.argv[1],host=fs.realpathSync.native(process.argv[2]),m=JSON.parse(fs.readFileSync(mf,"utf8")); const resolved=require.resolve("dsh-graph/package.json",{paths:[path.dirname(mf)]}); const p=JSON.parse(fs.readFileSync(resolved,"utf8")); process.exit(m.dependencies?.["dsh-graph"]!==process.argv[3] || fs.realpathSync.native(resolved)!==host || p.name!=="dsh-graph" || p.dsh?.bundle?.patch===void 0 ? 1 : 0); } catch { process.exit(1); }' "$PROFILE_MANIFEST" "$HOST_DIR/package.json" "$HOST_LINK"
}
if [ -f "$PROFILE_MANIFEST" ] && profile_ready; then needs_install=0; fi
# 只读诊断：逐项打印 profile 与实际 host link 的差异（不写任何文件、不安装）。判定字段与
# profile_ready() 一致；doctor 用两者交叉核对，出现分歧即报阻塞项（防止报告与启动判定漂移）。
profile_diag() {
  node -e '
    const fs = require("fs"), path = require("path");
    const [mf, host, link] = process.argv.slice(1);
    let ready = true;
    const bad = (msg) => { ready = false; console.log(msg); };
    if (!fs.existsSync(mf)) { console.log("manifest 缺失：" + mf); process.exit(1); }
    let m = null;
    try { m = JSON.parse(fs.readFileSync(mf, "utf8")); } catch (e) { console.log("manifest 非法 JSON：" + e.message); process.exit(1); }
    const dep = m && m.dependencies ? m.dependencies["dsh-graph"] : undefined;
    if (dep !== link) bad("声明依赖 " + JSON.stringify(dep) + " ≠ 期望 " + JSON.stringify(link));
    if (!fs.existsSync(host)) { bad("host package.json 缺失：" + host); process.exit(ready ? 0 : 1); }
    let resolved = null;
    try { resolved = require.resolve("dsh-graph/package.json", { paths: [path.dirname(mf)] }); } catch { }
    if (!resolved) bad("node_modules 中解析不到 dsh-graph/package.json");
    else {
      const rp = fs.realpathSync.native(resolved);
      const hp = fs.realpathSync.native(host);
      if (rp !== hp) bad("实际 link 解引用 " + rp + " ≠ " + hp);
      let p = null;
      try { p = JSON.parse(fs.readFileSync(resolved, "utf8")); } catch { }
      if (!p || p.name !== "dsh-graph") bad("link 目标 package name ≠ dsh-graph");
      else if (p.dsh === undefined || p.dsh.bundle === undefined || p.dsh.bundle.patch === undefined) bad("link 目标缺少 dsh.bundle.patch");
    }
    process.exit(ready ? 0 : 1);
  ' "$PROFILE_MANIFEST" "$HOST_DIR/package.json" "$HOST_LINK"
}
# $1: 路径 → 缺失 / 目录 / 非目录(!)
dir_state() { if [ -d "$1" ]; then printf '目录'; elif [ -e "$1" ]; then printf '非目录(!)'; else printf '缺失'; fi; }
# $1: 路径 → 存在 / 缺失
file_state() { if [ -f "$1" ]; then printf '存在'; else printf '缺失'; fi; }
# ── g-301 只读预检（--dry-run / --doctor）─────────────────────────────────────
# 复用启动路径**同一份**判定（工具、端口、隔离根、host link、profile_ready）；绝不创建目录、
# 不安装、不写配置、不启动服务。不运行 `web --dump-config`（那需要子进程/运行时）⇒ 明确列为未验证。
# 退出码：0 = 按当前参数可启动；1 = 存在阻塞项；2 = 非法/危险输入（已在上方拒绝，零副作用）。
doctor() {
  local blockers=() missing=() line state pr pr_ready=0
  printf '==> 只读预检（dry-run）：DSH %s | profile web | 平台 %s\n' "$FULL_VERSION" "$(uname -srm 2>/dev/null || echo 未知)"
  printf '平台范围：linux/WSL2（bash + GNU coreutils）；原生 Windows / macOS 未验证\n'
  printf -- '--- 输入（已通过危险/无效输入校验）---\n'
  printf 'version=%s port=%s host=%s host-dir=%s proxychains=%s skip-install=%s\n' \
    "$FULL_VERSION" "$PORT" "${HOST:-<dsh 默认>}" "$HOST_DIR" \
    "$([ "$USE_PROXY" -eq 1 ] && printf 开 || printf 关)" "$([ "$SKIP_INSTALL" -eq 1 ] && printf 开 || printf 关)"
  printf -- '--- 隔离根（测试 HOME/workspace 必须落在项目 tmp 内）---\n'
  for pair in "TEST_ROOT:$TEST_ROOT" "DSH_HOME:$DSH_HOME" "WORKSPACE:$WORKSPACE" "CACHE/npm:$CACHE_ROOT/npm" "CACHE/xdg:$CACHE_ROOT/xdg" "pnpm-store:$VERSION_ROOT/pnpm-store"; do
    line=${pair%%:*}; state="${pair#*:}"
    printf '%-11s %s  [%s]\n' "$line" "$state" "$(dir_state "$state")"
    if [ -d "$state" ]; then :
    elif [ -e "$state" ]; then blockers+=("$line 存在但不是目录：$state")
    else missing+=("${line}（启动时将创建）：$state"); fi
  done
  printf '（DSH_HOME 为稳定版本 %s 的共享 home；workspace/cache 按完整版本 %s 隔离）\n' "$STABLE_VERSION" "$FULL_VERSION"
  printf -- '--- 工具 ---\n'
  for t in pnpm node realpath; do
    if command -v "$t" >/dev/null 2>&1; then printf '%-12s %s（可用）\n' "$t" "$(command -v "$t")"
    else printf '%-12s 缺项(!)\n' "$t"; blockers+=("缺少工具 $t"); fi
  done
  if [ "$USE_PROXY" -eq 1 ]; then
    if command -v proxychains4 >/dev/null 2>&1; then printf '%-12s %s（可用）\n' proxychains4 "$(command -v proxychains4)"
    else printf '%-12s 缺项(!)\n' proxychains4; blockers+=('已请求 --proxychains，但找不到 proxychains4'); fi
  else printf '%-12s 未请求（--proxychains 关闭）\n' proxychains4; fi
  if [ "$SKIP_INSTALL" -eq 1 ]; then
    if command -v dsh >/dev/null 2>&1; then printf '%-12s %s（可用，--skip-install 复用）\n' dsh "$(command -v dsh)"
    else printf '%-12s 缺项(!)\n' dsh; blockers+=('--skip-install 需要 PATH 中已有 dsh'); fi
  fi
  printf -- '--- 端口 ---\n'
  case "$PORT_STATE" in
    free) printf '端口 %s：空闲\n' "$PORT";;
    busy) printf '端口 %s：已占用(!)\n' "$PORT"; blockers+=("端口已占用：$PORT");;
    *) printf '端口 %s：无法探测(!)（ss 与 node 都不可用）\n' "$PORT"; blockers+=("无法探测端口占用：$PORT");;
  esac
  printf -- '--- 本地插件与 link ---\n'
  printf '候选 host-dir ：%s\n' "$HOST_DIR"
  printf '实际 link 目标：%s\n' "$HOST_LINK"
  if [ -f "$HOST_DIR/package.json" ]; then
    if ! command -v node >/dev/null 2>&1; then printf 'host package  ：存在（name 未校验：缺 node）\n'
    elif [ "$HOST_PKG_OK" -eq 1 ]; then printf 'host package  ：存在（name=dsh-graph）\n'
    else printf 'host package  ：存在但 name 非 dsh-graph(!)\n'; blockers+=("host-dir package name 必须为 dsh-graph：$HOST_DIR/package.json"); fi
  else
    printf 'host package  ：缺失(!)：%s/package.json\n' "$HOST_DIR"; blockers+=("本地插件缺失：$HOST_DIR/package.json（需先构建 dist 或指向 dsh-graph-host）")
  fi
  printf -- '--- 已安装 profile / 运行时（复用启动路径判定）---\n'
  if [ -x "$RUNTIME_DSH" ]; then printf 'RUNTIME_DSH  ：%s（可执行）\n' "$RUNTIME_DSH"
  else printf 'RUNTIME_DSH  ：%s  [%s]\n' "$RUNTIME_DSH" "$(dir_state "$RUNTIME_DSH")"; missing+=("DSH 运行时（启动时将 pnpm add，需 registry）:$RUNTIME_DSH"); fi
  if [ -f "$PROFILE_MANIFEST" ]; then printf 'PROFILE      ：%s（存在）\n' "$PROFILE_MANIFEST"
  else printf 'PROFILE      ：缺失：%s\n' "$PROFILE_MANIFEST"; missing+=("web profile manifest（启动时将安装 link:）：$PROFILE_MANIFEST"); fi
  if [ -f "$PROFILE_MANIFEST" ]; then
    if line=$(profile_diag 2>&1); then
      pr=ready
      printf 'profile 判定 ：就绪（依赖/link/name/bundle.patch 与实际 link 一致）\n'
    else
      pr=stale
      printf 'profile 判定 ：未就绪\n'
      while IFS= read -r state; do [ -n "$state" ] && printf '  · %s\n' "$state"; done <<<"$line"
      missing+=("web profile 未就绪（启动时将重装 link:）")
    fi
    if profile_ready; then pr_ready=1; fi
    if [ "$pr_ready" -eq 1 ] && [ "$pr" != ready ]; then blockers+=('内部判定不一致：profile_ready 与诊断结论不同（请上报）'); fi
    if [ "$pr_ready" -eq 0 ] && [ "$pr" != stale ]; then blockers+=('内部判定不一致：profile_ready 与诊断结论不同（请上报）'); fi
    printf 'pnpm-workspace.yaml：%s [%s]\n' "$PROFILE_DIR/pnpm-workspace.yaml" "$(file_state "$PROFILE_DIR/pnpm-workspace.yaml")"
  fi
  if [ "$SKIP_INSTALL" -eq 1 ] && [ "$needs_install" -ne 0 ]; then blockers+=('--skip-install 要求目标 DSH_HOME 已有可复用的 dsh-graph profile'); fi
  printf -- '--- 结论 ---\n'
  if [ "${#blockers[@]}" -eq 0 ]; then printf '阻塞项：0（按当前参数可以启动）\n'
  else
    printf '阻塞项：%s\n' "${#blockers[@]}"
    for line in ${blockers[@]+"${blockers[@]}"}; do printf '  x %s\n' "$line"; done
  fi
  if [ "${#missing[@]}" -eq 0 ]; then printf '缺项：0（隔离根/profile/运行时均已就绪）\n'
  else
    printf '缺项（启动时将创建/安装）：%s\n' "${#missing[@]}"
    for line in ${missing[@]+"${missing[@]}"}; do printf '  - %s\n' "$line"; done
  fi
  printf '未验证：web 有效配置（--dump-config 需子进程/运行时，预检不运行）；真实安装与服务可达性\n'
  printf '凭据：预检只读取路径与工具名，不回显任何环境变量/密钥值\n'
  if [ "${#blockers[@]}" -gt 0 ]; then printf '==> 只读预检结论：阻塞（exit 1）\n'; return 1; fi
  printf '==> 只读预检结论：可按当前参数启动（exit 0）\n'; return 0
}
if [ "$DRY_RUN" -eq 1 ]; then
  if doctor; then exit 0; else exit 1; fi
fi
[ -d "$TMP_PATH" ] || mkdir -p "$TMP_PATH"
TMP_ROOT=$(realpath -e "$TMP_PATH") || die "无法 canonicalize 测试根：$TMP_PATH"
case "$TMP_ROOT" in "$REPO_ROOT/tmp"|"$REPO_ROOT/tmp"/*) ;; *) die "仓库 tmp symlink 越界：$TMP_ROOT";; esac
mkdir -p "$DSH_HOME" "$WORKSPACE" "$CACHE_ROOT/npm" "$CACHE_ROOT/xdg" "$VERSION_ROOT/pnpm-store"
cd "$WORKSPACE"
export DSH_HOME npm_config_cache="$CACHE_ROOT/npm" pnpm_config_store_dir="$VERSION_ROOT/pnpm-store" XDG_CACHE_HOME="$CACHE_ROOT/xdg"
printf '==> DSH %s | root %s | profile web | DSH_HOME %s | workspace %s | port %s\n' "$FULL_VERSION" "$TEST_ROOT" "$DSH_HOME" "$WORKSPACE" "$PORT"
# pnpm takes the *nearest* pnpm-workspace.yaml as its workspace root. Every path here lives
# under $REPO_ROOT/tmp, so without a nearer file pnpm adopts the repo root's config
# (autoInstallPeers: false, nodeLinker: hoisted) and installs a tree without the packages
# others declare as peers -> ERR_MODULE_NOT_FOUND @deepseek-ai/cordis-plugin-group. The DSH
# runtime is therefore installed into the version directory (not through pnpx/dlx, which
# reads that same inherited config) and each pnpm project gets its own root file.
# pnpm 12 also fails the install when a dependency's build script is not allowed, so
# allowBuilds is fed from pnpm's own report instead of hardcoded names that drift.
if [ "$SKIP_INSTALL" -eq 1 ]; then
  [ "$needs_install" -eq 0 ] || die '--skip-install 要求目标 DSH_HOME 已有可复用的 dsh-graph profile；请先不带该参数运行一次'
  printf '==> 跳过 dsh-graph 插件安装（复用已有 profile）\n'
else
  if [ ! -x "$RUNTIME_DSH" ]; then
    printf '==> 安装 DSH 运行时到版本目录（隔离仓库根 pnpm 配置）\n'
    install_step "$RUNTIME_DIR" "$VERSION_ROOT/runtime-install.log" pnpm add "@deepseek-ai/dsh@$FULL_VERSION" \
      || die "DSH 运行时安装失败：DSH ${FULL_VERSION}（详见 $VERSION_ROOT/runtime-install.log）"
  fi
  if [ "$needs_install" -eq 1 ]; then
    printf '==> 安装本地 dsh-graph 插件（每版本 profile）\n'
    install_step "$PROFILE_DIR" "$VERSION_ROOT/profile-install.log" "$RUNTIME_DSH" plugin --profile web add "$HOST_LINK" \
      || die "插件安装失败：DSH $VERSION profile web（详见 $VERSION_ROOT/profile-install.log）"
  fi
fi
[ -f "$PROFILE_MANIFEST" ] || die "插件 profile manifest 缺失：$PROFILE_MANIFEST"
profile_ready || die "插件 profile/link/bundle 未就绪：$PROFILE_MANIFEST"
EFFECTIVE_CONFIG="$VERSION_ROOT/effective-config.yml"
if [ "$SKIP_INSTALL" -eq 1 ]; then
  command -v dsh >/dev/null 2>&1 || die '--skip-install 需要 PATH 中已有 dsh 命令'
  DSH_CMD=(dsh)
  printf '==> 复用 PATH 中的 dsh 命令（跳过 DSH 包安装）\n'
else
  DSH_CMD=("$RUNTIME_DSH")
fi
# Report what actually runs (the --skip-install reuse path may not be the requested version).
RUNTIME_VERSION="$("${DSH_CMD[@]}" --version 2>/dev/null | head -1 || true)"
printf '==> 运行时 dsh：%s（版本 %s）\n' "${DSH_CMD[*]}" "${RUNTIME_VERSION:-未知}"
dump=("${DSH_CMD[@]}" web --dump-config)

if [ "$USE_PROXY" -eq 1 ]; then proxychains4 -q "${dump[@]}" >"$EFFECTIVE_CONFIG" 2>/dev/null || die "无法读取 web effective config：DSH $VERSION"; else "${dump[@]}" >"$EFFECTIVE_CONFIG" 2>/dev/null || die "无法读取 web effective config：DSH $VERSION"; fi
grep -q "@deepseek-ai/dsh-base" "$EFFECTIVE_CONFIG" || die "web effective config 缺少 dsh-base：DSH $VERSION"
grep -q "@deepseek-ai/dsh-web-app" "$EFFECTIVE_CONFIG" || die "web effective config 缺少 dsh-web-app：DSH $VERSION"
grep -q "dsh-graph" "$EFFECTIVE_CONFIG" || die "web effective config 缺少 dsh-graph：DSH $VERSION"
cmd=("${DSH_CMD[@]}" web --no-open --port "$PORT")
[ -n "$HOST" ] && cmd+=(--host "$HOST")
printf '==> 加载本地 dsh-graph 插件\n'
if [ "$USE_PROXY" -eq 1 ]; then exec proxychains4 -q "${cmd[@]}"; else exec "${cmd[@]}"; fi
