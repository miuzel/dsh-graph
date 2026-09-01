#!/usr/bin/env bash
#
# dev-dsh-011-instance.sh — 在本地独立目录安装并运行 dsh@0.1.1-rc.2 测试实例
# 与全局安装的 dsh（0.1.2-alpha.2）及 3080/3083 完全隔离，免反复重装切换。
#
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
REPO_ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"

DSH_011_DIR="$REPO_ROOT/tmp/dsh-011-bin"
TEST_HOME="$REPO_ROOT/tmp/test-review-011"
PORT="${PORT:-3084}"
HOST_DIR="$REPO_ROOT/dsh-graph-host"

mkdir -p "$DSH_011_DIR" "$TEST_HOME"

# 统一隔离 pnpm store
export PNPM_STORE_DIR="${PNPM_STORE_DIR:-$TEST_HOME/.pnpm-store}"
export pnpm_config_store_dir="$PNPM_STORE_DIR"
mkdir -p "$PNPM_STORE_DIR"

# 1. 检查并安装独立版本。
# Linux-only: realpath -m, mv -- and rm -- are provided by coreutils on the
# supported test environment.  pnpm records its store in .modules.yaml.
install_runner() {
  local modules="$DSH_011_DIR/node_modules"
  local metadata="$modules/.modules.yaml" recorded="" recorded_real=""
  local quarantine="" install_rc=0

  # pnpm v11 uses a versioned child (normally v11) as the effective store.
  selected_real="$(pnpm store path --store-dir "$PNPM_STORE_DIR" | tail -n 1 | tr -d '\r')"
  selected_real="$(realpath -m "$selected_real")"
  if [ -e "$modules" ] || [ -L "$modules" ]; then
    if [ -f "$metadata" ]; then
      # pnpm 11 writes JSON YAML: also accept classic YAML, quotes, comments, CRLF.
      recorded="$(sed -n -E 's/^[[:space:]]*"?storeDir"?[[:space:]]*:[[:space:]]*"?([^"#]*?)"?[[:space:]]*,?[[:space:]]*$/\1/p' "$metadata" | head -n 1 | sed -e 's/\r$//' -e 's/[[:space:]]*#.*$//' -e "s/^[[:space:]]*[\"']//" -e "s/[\"'][[:space:]]*$//")"
    fi
    if [ -n "$recorded" ]; then recorded_real="$(realpath -m "$recorded")"; fi
    # Empty/unknown metadata is unsafe: let the controlled reinstall establish it.
    if [ ! -f "$modules/.bin/dsh" ] || [ -z "$recorded_real" ] || [ "$recorded_real" != "$selected_real" ]; then
      quarantine="$DSH_011_DIR/.node_modules.stale.$$"
      mv -- "$modules" "$quarantine"
    fi
  fi

  if [ ! -f "$DSH_011_DIR/node_modules/.bin/dsh" ]; then
    echo "==> 使用 pnpm store $selected_real 安装 dsh@0.1.1-rc.2..."
    if (
      cd "$DSH_011_DIR"
      if [ ! -f "package.json" ]; then
        printf '%s\n' '{"name":"dsh-011-runner","private":true}' > package.json
      fi
      printf '%s\n' 'node-linker=hoisted' 'shared-workspace-lockfile=false' > .npmrc
      # pnpm 11 otherwise exits ERR_PNPM_IGNORED_BUILDS in non-interactive runs.
      pnpm --store-dir "$PNPM_STORE_DIR" add @deepseek-ai/dsh@0.1.1-rc.2 --save-exact --ignore-scripts
    ) && [ -f "$DSH_011_DIR/node_modules/.bin/dsh" ]; then
      : # Keep the replacement until installation has been fully accepted.
    else
      install_rc=$?
      # Never leave a partial tree in place or discard the known-good tree.
      if [ -e "$modules" ] || [ -L "$modules" ]; then rm -rf -- "$modules"; fi
      if [ -n "$quarantine" ] && [ -e "$quarantine" ]; then mv -- "$quarantine" "$modules"; fi
      return "$install_rc"
    fi
  fi

  if [ -n "$quarantine" ] && [ -e "$quarantine" ]; then
    rm -rf -- "$quarantine"
  fi
}
install_runner

DSH_BIN="$DSH_011_DIR/node_modules/.bin/dsh"

# 2. 准备隔离 profile
PROFILE_DIR="$TEST_HOME/profiles/dsh-graph-011"
mkdir -p "$PROFILE_DIR" "$TEST_HOME/workspace"

cat > "$PROFILE_DIR/package.json" <<MANIFEST
{
  "name": "dsh-profile-011",
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

# 3. 安装 profile 依赖并启动
echo "==> 使用独立 dsh@0.1.1-rc.2 启动测试实例..."
export DSH_HOME="$TEST_HOME"
export PNPM_STORE_DIR="$TEST_HOME/.pnpm-store"
export pnpm_config_store_dir="$TEST_HOME/.pnpm-store"
mkdir -p "$TEST_HOME/.pnpm-store"
cd "$TEST_HOME/workspace"
"$DSH_BIN" plugin --profile dsh-graph-011 install
echo "==> 启动旧版实例在 http://127.0.0.1:$PORT"
exec "$DSH_BIN" --profile dsh-graph-011 --port "$PORT" "$@"
