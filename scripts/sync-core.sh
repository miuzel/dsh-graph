#!/usr/bin/env bash
# 编译 core/*.ts 并输出到 dist/core/*.js（g-319：产物隔离到独立 dist 目录）。
#
# 背景（关键 bug 修复）：发布包必须 ship 编译后的 .js——Node 原生 type-stripping 对
# node_modules 下的 .ts 硬禁用（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
# 装进用户 node_modules 后 .ts 不可加载。本地仓库内 .ts 能跑（不在 node_modules 下），
# 但 npm 包安装后一定在 node_modules 下。
#
# 语义：根 core/*.ts 是唯一事实来源 → tsc 编译 → dist/core/*.js（发布产物）。
# prepack 前必跑。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== 1. tsc 编译 core/*.ts → core-dist/*.js =="
rm -rf core-dist
./node_modules/.bin/tsc -p tsconfig.json
echo "编译完成：$(ls core-dist/*.js | wc -l) 个 .js 产物"

echo "== 2. 同步 .js 产物 → dist/core/ =="
dest="dist/core"
rm -rf "$dest"
mkdir -p "$dest"
cp core-dist/*.js "$dest"/
echo "已同步：$(ls "$dest"/*.js | wc -l) 个 .js"

echo "== 3. 一致性校验（无 .ts 泄漏） =="
if ls "$dest"/*.ts >/dev/null 2>&1; then
  echo "❌ dist/core/ 内发现 .ts 泄漏"
  exit 1
fi

echo "== 4. 清理构建中间目录 =="
rm -rf core-dist
echo "== OK：dist/core/*.js 为根 core/*.ts 的编译产物 =="
