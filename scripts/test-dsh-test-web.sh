#!/usr/bin/env bash
# Offline smoke for scripts/dsh-test-web.sh: stub pnpx and assert
#   - SemVer prerelease families share the stable base DSH_HOME (0.1.1-rc.2 / 0.1.1-alpha.5 -> 0.1.1/home;
#     v0.1.2-alpha.4 / v0.1.2 -> v0.1.2/home, v kept iff input has v);
#   - workspace/cache/pnpm-store stay isolated per FULL_VERSION;
#   - profile reuse across a shared home (same version again, and another prerelease of the same core);
#   - argv/cwd of the plugin add and web run; illegal args / roots are rejected.
# All temp files live under the repo tmp/ (no /tmp writes); no real network.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
SCRIPT="$ROOT/scripts/dsh-test-web.sh"
mkdir -p "$ROOT/tmp"
TMP=$(mktemp -d "$ROOT/tmp/.g229-smoke.XXXXXX")
TEST_ROOT=$(mktemp -d "$ROOT/tmp/.g229-root.XXXXXX")
cleanup() {
  local rc=$?
  [ -L "$TEST_ROOT-link" ] && rm -f -- "$TEST_ROOT-link"
  if [ -d "$TEST_ROOT" ]; then
    find "$TEST_ROOT" -depth -type l -delete
    find "$TEST_ROOT" -depth -type f -delete
    find "$TEST_ROOT" -depth -type d -exec rmdir -- {} +
  fi
  rm -rf -- "$TMP" "$TEST_ROOT"
  return "$rc"
}
trap cleanup EXIT
mkdir -p "$TMP/bin"
cat > "$TMP/bin/pnpx" <<'STUB'
#!/usr/bin/env bash
if [[ "${3:-}" == plugin ]]; then
  count_file="$SMOKE_OUT/install-count-$SMOKE_ID"; count=0; [ -f "$count_file" ] && count=$(<"$count_file"); count=$((count + 1)); printf '%s\n' "$count" > "$count_file"
  printf '%s\n' "$@" > "$SMOKE_OUT/install-$SMOKE_ID-$count"
  printf '%s\n' "$PWD" > "$SMOKE_OUT/install-cwd-$SMOKE_ID-$count"
  mkdir -p "$DSH_HOME/profiles/web/node_modules"
  ln -s "${7#link:}" "$DSH_HOME/profiles/web/node_modules/dsh-graph"
  printf '{\"name\":\"dsh-profile-web\",\"dependencies\":{\"dsh-graph\":\"%s\"},\"dsh\":{\"profile\":{\"bundles\":[\"@deepseek-ai/dsh-base\",\"@deepseek-ai/dsh-web-app\",\"dsh-graph\"]}}}\n' "${7:-}" > "$DSH_HOME/profiles/web/package.json"
else
  if [[ "${3:-}" == web && "${4:-}" == --dump-config ]]; then
    printf '@deepseek-ai/dsh-base\n@deepseek-ai/dsh-web-app\ndsh-graph\n'
  else
    printf '%s\n' "$@" > "$SMOKE_OUT/args-$SMOKE_ID"
    printf '%s\n' "$PWD" > "$SMOKE_OUT/cwd-$SMOKE_ID"
  fi
fi
printf '%s\n' "$DSH_HOME" "$npm_config_cache" "$pnpm_config_store_dir" "$XDG_CACHE_HOME" >> "$SMOKE_OUT/env-$SMOKE_ID"
STUB
chmod +x "$TMP/bin/pnpx"
export PATH="$TMP/bin:$PATH" SMOKE_OUT="$TMP" DSH_TEST_ROOT="$TEST_ROOT" DSH_TEST_MODE=1
# Neutral cwd under the repo tmp; the launcher cd's into the per-version workspace before pnpx.
NEUTRAL="$ROOT/tmp"
run() { (cd "$NEUTRAL" && SMOKE_ID="$1" "$SCRIPT" "$2" --port "$3" >/dev/null); }
argv_eq() { # argv_eq <file> <expected...>
  local file=$1; shift
  mapfile -t actual < "$file"
  ((${#actual[@]} == $#)) || { echo "argv 长度不符：$file" >&2; exit 1; }
  local i=0; for exp in "$@"; do [[ "${actual[$i]}" == "$exp" ]] || { echo "argv[$i] 不符：$file（期望 $exp，实际 ${actual[$i]}）" >&2; exit 1; }; i=$((i + 1)); done
}
HOST_LINK="link:$ROOT/dsh-graph-host"

# one: prerelease 0.1.1-rc.2 (no v) -> stable home 0.1.1, per-version workspace/cache/store
run one 0.1.1-rc.2 18082
# two: stable 0.1.2, run twice -> home 0.1.2, profile reused on the second run
run two 0.1.2 18083
run two 0.1.2 18083
# three: a different prerelease of the same core 0.1.1 -> shares one's home, no second install
run three 0.1.1-alpha.5 18084
# four/five: v-prefixed prerelease and its stable base share v0.1.2/home
run four v0.1.2-alpha.4 18086
run five v0.1.2 18087

# --- home mapping -----------------------------------------------------------
mapfile -t env_one < "$TMP/env-one"; mapfile -t env_two < "$TMP/env-two"
mapfile -t env_three < "$TMP/env-three"; mapfile -t env_four < "$TMP/env-four"; mapfile -t env_five < "$TMP/env-five"
[[ "${env_one[0]}" == "$TEST_ROOT/0.1.1/home" ]]          || { echo 'one: home 未映射到稳定基 0.1.1' >&2; exit 1; }
[[ "${env_two[0]}" == "$TEST_ROOT/0.1.2/home" ]]          || { echo 'two: stable home 应保持 0.1.2' >&2; exit 1; }
[[ "${env_three[0]}" == "${env_one[0]}" ]]                || { echo 'three: prerelease 应共享 0.1.1 home' >&2; exit 1; }
[[ "${env_four[0]}" == "$TEST_ROOT/v0.1.2/home" ]]        || { echo 'four: v 前缀应保留并映射 v0.1.2 home' >&2; exit 1; }
[[ "${env_five[0]}" == "${env_four[0]}" ]]                || { echo 'five: v0.1.2 stable 应共享 v0.1.2 home' >&2; exit 1; }
[[ "${env_one[0]}" != "${env_two[0]}" ]]                  || { echo '不同核心不应共享 home' >&2; exit 1; }
# no per-version home dirs may exist (only the stable base home is created)
for p in "$TEST_ROOT/0.1.1-rc.2/home" "$TEST_ROOT/0.1.1-alpha.5/home" "$TEST_ROOT/v0.1.2-alpha.4/home"; do
  [ ! -e "$p" ] || { echo "不应存在按完整版本隔离的 home：$p" >&2; exit 1; }
done

# --- per-FULL_VERSION workspace/cache/pnpm-store isolation ------------------
[[ "${env_one[1]}" == "$TEST_ROOT/0.1.1-rc.2/cache/npm" && "${env_three[1]}" == "$TEST_ROOT/0.1.1-alpha.5/cache/npm" ]] || { echo 'cache 未按完整版本隔离' >&2; exit 1; }
[[ "${env_one[2]}" == "$TEST_ROOT/0.1.1-rc.2/pnpm-store" && "${env_three[2]}" == "$TEST_ROOT/0.1.1-alpha.5/pnpm-store" ]] || { echo 'pnpm store 未按完整版本隔离' >&2; exit 1; }
[[ "${env_one[3]}" == "$TEST_ROOT/0.1.1-rc.2/cache/xdg" && "${env_three[3]}" == "$TEST_ROOT/0.1.1-alpha.5/cache/xdg" ]] || { echo 'xdg cache 未按完整版本隔离' >&2; exit 1; }
[[ "${env_two[1]}" != "${env_five[1]}" && "${env_two[2]}" != "${env_five[2]}" && "${env_four[2]}" == "$TEST_ROOT/v0.1.2-alpha.4/pnpm-store" ]] || { echo 'store/cache 隔离断言失败' >&2; exit 1; }

# --- profile reuse & install argv ------------------------------------------
[[ $(<"$TMP/install-count-one") == 1 ]]                   || { echo 'one: 安装次数应为 1' >&2; exit 1; }
[ ! -e "$TMP/install-one-2" ]                             || { echo 'one: 不应重复安装' >&2; exit 1; }
[ ! -e "$TMP/install-three-1" ]                           || { echo 'three: 共享 home 应复用 profile，不得重装' >&2; exit 1; }
[[ $(<"$TMP/install-count-two") == 1 && ! -e "$TMP/install-two-2" ]] || { echo 'two: 第二次运行应复用 profile' >&2; exit 1; }
[[ $(<"$TMP/install-count-four") == 1 && ! -e "$TMP/install-five-1" ]] || { echo 'four/five: v 家族应仅安装一次' >&2; exit 1; }
argv_eq "$TMP/install-one-1" --yes '@deepseek-ai/dsh@0.1.1-rc.2' plugin --profile web add "$HOST_LINK"
argv_eq "$TMP/install-two-1" --yes '@deepseek-ai/dsh@0.1.2' plugin --profile web add "$HOST_LINK"
argv_eq "$TMP/install-four-1" --yes '@deepseek-ai/dsh@v0.1.2-alpha.4' plugin --profile web add "$HOST_LINK"
# install ran from the per-version workspace and manifest lives in the shared home
[[ $(<"$TMP/install-cwd-one-1") == "$TEST_ROOT/0.1.1-rc.2/workspace" ]] || { echo 'install cwd 应为完整版本 workspace' >&2; exit 1; }
[[ $(<"$TEST_ROOT/0.1.1/home/profiles/web/package.json") == *"$HOST_LINK"* ]] || { echo '共享 home manifest 应记录 host link' >&2; exit 1; }

# --- web-run argv/cwd (pnpx/dsh use the full version) -----------------------
argv_eq "$TMP/args-one" --yes '@deepseek-ai/dsh@0.1.1-rc.2' web --no-open --port 18082
argv_eq "$TMP/args-two" --yes '@deepseek-ai/dsh@0.1.2' web --no-open --port 18083
argv_eq "$TMP/args-three" --yes '@deepseek-ai/dsh@0.1.1-alpha.5' web --no-open --port 18084
argv_eq "$TMP/args-four" --yes '@deepseek-ai/dsh@v0.1.2-alpha.4' web --no-open --port 18086
argv_eq "$TMP/args-five" --yes '@deepseek-ai/dsh@v0.1.2' web --no-open --port 18087
[[ $(<"$TMP/cwd-one") == "$TEST_ROOT/0.1.1-rc.2/workspace" && $(<"$TMP/cwd-three") == "$TEST_ROOT/0.1.1-alpha.5/workspace" ]] || { echo 'web cwd 应为完整版本 workspace' >&2; exit 1; }
[[ $(<"$TMP/cwd-four") == "$TEST_ROOT/v0.1.2-alpha.4/workspace" && $(<"$TMP/cwd-five") == "$TEST_ROOT/v0.1.2/workspace" ]] || { echo 'v 家族 cwd 应为完整版本 workspace' >&2; exit 1; }

# --- illegal args / roots ----------------------------------------------------
reject() { if (cd "$NEUTRAL" && "$SCRIPT" 0.1.2 "$@" >/dev/null 2>&1); then echo "应拒绝：$*" >&2; exit 1; fi; }
reject --profile evil; reject -- --port 3080; reject --port 18084 --port 3085
if "$SCRIPT" 0.1.2 --port 3080 >/dev/null 2>&1; then echo '应拒绝 3080' >&2; exit 1; fi
if "$SCRIPT" 0.1.2 --port nope >/dev/null 2>&1; then echo '应拒绝非法端口' >&2; exit 1; fi
if (env -u DSH_TEST_MODE DSH_TEST_ROOT=/tmp/dsh-test "$SCRIPT" 0.1.2 --port 18084 >/dev/null 2>&1); then echo '应拒绝遗留外部 DSH_TEST_ROOT' >&2; exit 1; fi
reject_root() { if DSH_TEST_ROOT="$1" "$SCRIPT" 0.1.2 --port 18084 >/dev/null 2>&1; then echo "应拒绝 root：$1" >&2; exit 1; fi; }
reject_root /tmp/g229-external
reject_root "$ROOT/../escape"
ln -s /tmp "$TEST_ROOT-link"
reject_root "$TEST_ROOT-link"
trap - EXIT
cleanup
[ ! -e "$TEST_ROOT" ] && [ ! -L "$TEST_ROOT" ] || { echo 'test root 未清理' >&2; exit 1; }
[ ! -e "$TEST_ROOT-link" ] && [ ! -L "$TEST_ROOT-link" ] || { echo 'test root sibling symlink 未清理' >&2; exit 1; }
[ ! -e "$TMP" ] || { echo 'smoke 临时目录未清理' >&2; exit 1; }
echo '离线 smoke 通过：stable/prerelease home 共享、FULL_VERSION 隔离、profile 复用、argv/cwd、非法参数（真实网络 UNVERIFIED）'
