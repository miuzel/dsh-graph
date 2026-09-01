#!/usr/bin/env bash
# Offline smoke: stub pnpx and assert argv, cwd, isolation, and flag gates.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
SCRIPT="$ROOT/scripts/dsh-test-web.sh"; TMP=$(mktemp -d); TEST_ROOT=$(mktemp -d "$ROOT/tmp/.g220-smoke.XXXXXX")
cleanup() {
  local rc=$?
  [ -L "$TEST_ROOT-link" ] && rm -f -- "$TEST_ROOT-link"
  if [ -d "$TEST_ROOT" ]; then
    find "$TEST_ROOT" -depth -type l -delete
    find "$TEST_ROOT" -depth -type f -delete
    find "$TEST_ROOT" -depth -type d -exec rmdir -- {} +
  fi
  rm -rf -- "$TMP"
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
run() { (cd /tmp && SMOKE_ID="$1" "$SCRIPT" "$2" --port "$3" >/dev/null); }
run one 0.1.1-rc.2 18082
run two 0.1.2 18083
# A valid manifest must avoid a second plugin add.
run two 0.1.2 18083
[ ! -e "$TMP/install-two-second" ]
install_expected=(--yes '@deepseek-ai/dsh@0.1.2' plugin --profile web add "link:$ROOT/dsh-graph-host")
mapfile -t install_actual < "$TMP/install-two-1"
((${#install_actual[@]} == ${#install_expected[@]})) || { echo 'install argv 长度不符' >&2; exit 1; }
for i in "${!install_expected[@]}"; do [[ "${install_actual[$i]}" == "${install_expected[$i]}" ]] || { echo "install argv[$i] 不符" >&2; exit 1; }; done
[[ $(<"$TMP/install-cwd-two-1") == "$TEST_ROOT/0.1.2/workspace" ]]
[[ $(<"$TMP/install-count-two") == 1 && ! -e "$TMP/install-two-2" ]]
[[ $(<"$TEST_ROOT/0.1.2/home/profiles/web/package.json") == *"link:$ROOT/dsh-graph-host"* ]]
expected=(--yes '@deepseek-ai/dsh@0.1.2' web --no-open --port 18083)
mapfile -t actual < "$TMP/args-two"
((${#actual[@]} == ${#expected[@]})) || { echo 'argv 长度不符' >&2; exit 1; }
for i in "${!expected[@]}"; do [[ "${actual[$i]}" == "${expected[$i]}" ]] || { echo "argv[$i] 不符" >&2; exit 1; }; done
[[ $(<"$TMP/cwd-one") == "$TEST_ROOT/0.1.1-rc.2/workspace" ]]
[[ $(<"$TMP/cwd-two") == "$TEST_ROOT/0.1.2/workspace" ]]
mapfile -t env_one < "$TMP/env-one"; mapfile -t env_two < "$TMP/env-two"
[[ "${env_one[0]}" == "$TEST_ROOT/0.1.1-rc.2/home" && "${env_two[0]}" == "$TEST_ROOT/0.1.2/home" ]]
[[ "${env_one[1]}" != "${env_two[1]}" && "${env_one[2]}" != "${env_two[2]}" && "${env_one[3]}" != "${env_two[3]}" ]]
reject() { if (cd /tmp && "$SCRIPT" 0.1.2 "$@" >/dev/null 2>&1); then echo "应拒绝：$*" >&2; exit 1; fi; }
reject --profile evil; reject -- --port 3080; reject --port 18084 --port 3085
if "$SCRIPT" 0.1.2 --port 3080 >/dev/null 2>&1; then echo '应拒绝 3080' >&2; exit 1; fi
if "$SCRIPT" 0.1.2 --port nope >/dev/null 2>&1; then echo '应拒绝非法端口' >&2; exit 1; fi
if (env -u DSH_TEST_MODE DSH_TEST_ROOT=/tmp/dsh-test "$SCRIPT" 0.1.2 --port 18084 >/dev/null 2>&1); then echo '应拒绝遗留外部 DSH_TEST_ROOT' >&2; exit 1; fi
reject_root() { if DSH_TEST_ROOT="$1" "$SCRIPT" 0.1.2 --port 18084 >/dev/null 2>&1; then echo "应拒绝 root：$1" >&2; exit 1; fi; }
reject_root /tmp/g220-external
reject_root "$ROOT/../escape"
ln -s /tmp "$TEST_ROOT-link"
reject_root "$TEST_ROOT-link"
trap - EXIT
cleanup
[ ! -e "$TEST_ROOT" ] && [ ! -L "$TEST_ROOT" ] || { echo 'test root 未清理' >&2; exit 1; }
[ ! -e "$TEST_ROOT-link" ] && [ ! -L "$TEST_ROOT-link" ] || { echo 'test root sibling symlink 未清理' >&2; exit 1; }
echo '双版本隔离 smoke 通过（离线 stub，真实网络 UNVERIFIED）'
