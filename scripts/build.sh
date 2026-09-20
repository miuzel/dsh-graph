#!/usr/bin/env bash
# 统一构建脚本：核心层编译 + 客户端打包 + 发布产物组装到独立 dist/ 目录
#
# 用法：从仓库根目录运行 bash scripts/build.sh
#
# 构建流程：
# 1. sync-core.sh：编译 core/*.ts → dist/core/*.js
# 2. build-client.sh：拼接 dsh-graph-host/lib/client/*.js → dist/lib/client.js
# 3. 将 dsh-graph-host 中的非构建产物同步到 dist/（index.js、prompts、文档等）
# 4. 生成 dist/package.json（主入口/导出指向 dist 内编译产物）
#
# 产物结构：dist/ 目录具备独立完整的发布结构，可在 dist/ 内直接打包和发布。
#
# 适用场景：
# - 本地开发：pnpm build / npm run build
# - 预发布：pnpm prepack / npm run prepack
# - GitHub 源码安装：npm install github:owner/repo 自动触发 prepare 脚本
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 统一构建：核心层 + 客户端 + dist 组装 ==="

# 清理旧的 dist/
rm -rf dist
mkdir -p dist

echo ""
echo "--- 步骤 1/3：编译核心层 → dist/core/ ---"
bash scripts/sync-core.sh

echo ""
echo "--- 步骤 2/3：打包客户端 → dist/lib/client.js ---"
bash scripts/build-client.sh

echo ""
echo "--- 步骤 3/3：组装发布产物到 dist/ ---"

# 复制 dsh-graph-host 中的非构建产物（源码文件）
cp dsh-graph-host/index.js dist/index.js
mkdir -p dist/lib
cp dsh-graph-host/lib/server-i18n.js dist/lib/server-i18n.js
cp dsh-graph-host/cordis.patch.yml dist/cordis.patch.yml
cp dsh-graph-host/LICENSE dist/LICENSE
cp dsh-graph-host/README.md dist/README.md
cp -r dsh-graph-host/prompts dist/prompts
cp dsh-graph-host/supervisor-guide.zh.md dist/supervisor-guide.zh.md
cp dsh-graph-host/supervisor-guide.en.md dist/supervisor-guide.en.md

# 从 dsh-graph-host/package.json 生成 dist/package.json：
# 移除 scripts（构建已在仓库根完成），添加 main 和 exports（指向 dist 内产物）
node -e '
  const src = JSON.parse(require("fs").readFileSync("dsh-graph-host/package.json", "utf8"));
  delete src.scripts;
  src.main = "index.js";
  src.exports = {
    ".": "./index.js",
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  };
  require("fs").writeFileSync("dist/package.json", JSON.stringify(src, null, 2) + "\n");
'

echo ""
echo "--- 清理旧的 dsh-graph-host 内构建产物 ---"
rm -rf dsh-graph-host/core
rm -f dsh-graph-host/lib/client.js

echo ""
echo "=== 构建完成 ==="
echo "产物目录：dist/"
echo "  dist/core/*.js（来自 core/*.ts 编译）"
echo "  dist/lib/client.js（来自 dsh-graph-host/lib/client/*.js 拼接）"
echo "  dist/index.js（插件入口）"
echo "  dist/package.json（发布配置）"
