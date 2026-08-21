#!/usr/bin/env bash
# g-111 B7：把仓库根 core/ 同步进两个发布包（dsh-graph-host/core、dsh-graph-client/core）。
# 包自包含发布结构：npm 包内必须带自己的 core 副本（发布后无 ../core 可引用）。
# 根 core/ 是唯一事实来源；本脚本保证副本一致，prepack 前必跑。
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT_CORE="core"
PKGS=("dsh-graph-host" "dsh-graph-client")

echo "== sync core → 各包 =="
for pkg in "${PKGS[@]}"; do
  dest="$pkg/core"
  mkdir -p "$dest"
  # 只同步 .ts 源码（tests 目录不进包）；先 diff 源码：漂移即同步
  if ! diff -rq --exclude=tests "$ROOT_CORE" "$dest" >/dev/null 2>&1; then
    echo "[$pkg] core 副本与根 core 不一致，正在同步…"
    cp "$ROOT_CORE"/*.ts "$dest"/
  fi
  echo "[$pkg] core 已同步：$(ls "$dest"/*.ts | wc -l) 个文件"
done

echo "== 同步后一致性校验 =="
for pkg in "${PKGS[@]}"; do
  if diff -rq --exclude=tests "$ROOT_CORE" "$pkg/core" >/dev/null 2>&1; then
    echo "[$pkg] ✅ 一致"
  else
    echo "[$pkg] ❌ 仍不一致（根 core 与副本差异：）"
    diff -rq --exclude=tests "$ROOT_CORE" "$pkg/core" || true
    exit 1
  fi
done
echo "== OK：两包 core 与根 core 完全一致 =="
