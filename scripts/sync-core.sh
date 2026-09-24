#!/usr/bin/env bash
# 编译 core/*.ts 并输出到 <DIST_DIR>/core/*.js（g-319：产物隔离到独立 dist 目录）。
#
# 背景（关键 bug 修复）：发布包必须 ship 编译后的 .js——Node 原生 type-stripping 对
# node_modules 下的 .ts 硬禁用（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING），
# 装进用户 node_modules 后 .ts 不可加载。本地仓库内 .ts 能跑（不在 node_modules 下），
# 但 npm 包安装后一定在 node_modules 下。
#
# 语义：根 core/*.ts 是唯一事实来源 → tsc 编译 → <DIST_DIR>/core/*.js（发布产物）。
# prepack 前必跑。
#
# 可重定向（g-348，默认值与独立调用契约不变）：
# - DIST_DIR：产物根目录，默认 dist/。build.sh 把它指向原子发布暂存区，使发布前 dist/ 不被触碰。
# - CORE_DIST：tsc 编译中间目录，默认 core-dist/。build.sh 把它放进本次构建的暂存根，
#   使并发构建不再共享/互相 rm -rf 同一个中间目录。
#
# ⚠️ 独立调用会在 DIST_DIR 内先清空 core/（分段调试用，非原子）；**发布路径一律走
#    bash scripts/build.sh**（暂存 + 单次原子切换，见该脚本头部说明）。
set -euo pipefail
cd "$(dirname "$0")/.."

DEST_DIR="${DIST_DIR:-dist}"
CORE_DIST="${CORE_DIST:-core-dist}"

echo "== 1. tsc 编译 core/*.ts → $CORE_DIST/*.js =="
rm -rf "$CORE_DIST"
./node_modules/.bin/tsc -p tsconfig.json --outDir "$CORE_DIST"
echo "编译完成：$(ls "$CORE_DIST"/*.js | wc -l) 个 .js 产物"

echo "== 2. 同步 .js 产物 → $DEST_DIR/core/ =="
dest="$DEST_DIR/core"
rm -rf "$dest"
mkdir -p "$dest"
cp "$CORE_DIST"/*.js "$dest"/
echo "已同步：$(ls "$dest"/*.js | wc -l) 个 .js"

echo "== 3. 一致性校验（无 .ts 泄漏） =="
if ls "$dest"/*.ts >/dev/null 2>&1; then
  echo "❌ $DEST_DIR/core/ 内发现 .ts 泄漏"
  exit 1
fi

echo "== 4. 清理构建中间目录 =="
rm -rf "$CORE_DIST"
echo "== OK：$DEST_DIR/core/*.js 为根 core/*.ts 的编译产物 =="
