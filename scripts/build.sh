#!/usr/bin/env bash
# 统一构建脚本：串联核心层编译与客户端打包
# 用法：从仓库根目录运行 bash scripts/build.sh
#
# 构建流程：
# 1. sync-core.sh：编译 core/*.ts → dsh-graph-host/core/*.js
# 2. build-client.sh：拼接 dsh-graph-host/lib/client/*.js → dsh-graph-host/lib/client.js
#
# 适用场景：
# - 本地开发：pnpm build / npm run build
# - 预发布：pnpm prepack / npm run prepack
# - GitHub 源码安装：npm install github:owner/repo 自动触发 prepare 脚本
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 统一构建：核心层 + 客户端 ==="

echo ""
echo "--- 步骤 1/2：编译核心层 ---"
bash scripts/sync-core.sh

echo ""
echo "--- 步骤 2/2：打包客户端 ---"
bash scripts/build-client.sh

echo ""
echo "=== 构建完成 ==="
echo "核心层：dsh-graph-host/core/*.js（来自 core/*.ts 编译）"
echo "客户端：dsh-graph-host/lib/client.js（来自 dsh-graph-host/lib/client/*.js 拼接）"
