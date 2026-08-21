#!/usr/bin/env bash
# g-111 B7：把仓库根 core/*.ts 编译为 .js 产物并同步进两个发布包（dsh-graph-host/core、dsh-graph-client/core）。
#
# 背景（关键 bug 修复）：发布包必须 ship 编译后的 .js——Node 原生 type-stripping 对
# node_modules 下的 .ts 硬禁用（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
# 装进用户 node_modules 后 .ts 不可加载。本地仓库内 .ts 能跑（不在 node_modules 下），
# 但 npm 包安装后一定在 node_modules 下。
#
# 语义：根 core/*.ts 是唯一事实来源 → tsc 编译 → 两包内 core/*.js（自包含发布物）。
# prepack 前必跑；一致性校验保证两包产物与编译输出完全一致、无 .ts 泄漏。
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT_CORE="core"
PKGS=("dsh-graph-host" "dsh-graph-client")

echo "== 1. tsc 编译 core/*.ts → core-dist/*.js =="
rm -rf core-dist
./node_modules/.bin/tsc -p tsconfig.json
echo "编译完成：$(ls core-dist/*.js | wc -l) 个 .js 产物"

echo "== 2. 同步 .js 产物 → 各包 core/ =="
for pkg in "${PKGS[@]}"; do
  dest="$pkg/core"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp core-dist/*.js "$dest"/
  echo "[$pkg] 已同步：$(ls "$dest"/*.js | wc -l) 个 .js"
done

echo "== 3. 一致性校验（两包产物与编译输出一致，且无 .ts 泄漏） =="
for pkg in "${PKGS[@]}"; do
  if diff -rq core-dist "$pkg/core" >/dev/null 2>&1; then
    echo "[$pkg] ✅ 与 core-dist 一致"
  else
    echo "[$pkg] ❌ 不一致"
    diff -rq core-dist "$pkg/core" || true
    exit 1
  fi
  if ls "$pkg"/core/*.ts >/dev/null 2>&1; then
    echo "[$pkg] ❌ 包内发现 .ts 泄漏"
    exit 1
  fi
done
echo "== 4. 清理构建中间目录 =="
rm -rf core-dist
echo "== OK：两包 core/*.js 为根 core/*.ts 的编译产物，完全一致 =="
