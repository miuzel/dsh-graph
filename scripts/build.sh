#!/usr/bin/env bash
# 统一构建脚本：核心层编译 + 客户端打包 + 发布产物组装 + **原子发布**到独立 dist/ 目录
#
# 用法：从仓库根目录运行 bash scripts/build.sh
#
# 构建流程：
# 1. sync-core.sh：编译 core/*.ts → <暂存>/dist/core/*.js（经 DIST_DIR 重定向）
# 2. build-client.sh：拼接 dsh-graph-host/lib/client/*.js → <暂存>/dist/lib/client.js
# 3. 将 dsh-graph-host 中的非构建产物同步到 <暂存>/dist（index.js、prompts、文档等）
# 4. 生成 <暂存>/dist/package.json（主入口/导出指向 dist 内编译产物）
# 5. 原子发布：全部步骤成功后，用**一次** rename 把暂存树切换为 dist/
#
# 产物结构：dist/ 目录具备独立完整的发布结构，可在 dist/ 内直接打包和发布。
#
# ── g-348：为什么必须原子发布（真实故障，非理论风险）──────────────────────────
# 旧实现在开头 `rm -rf dist`，之后才逐步拷回资产；而运行中的宿主**每次调用**都从 dist/
# 现读插件资产（prompts/*.md 等）。于是 `rm -rf dist` → `cp -r dsh-graph-host/prompts`
# 之间的整个窗口期内，任何读者都会撞上 ENOENT —— 宿主随即报
# `dsh-graph prompt asset missing or unreadable: guide-hint.zh.md` 并**终止该轮次**，
# 已实测击杀两个在途 worker attempt（g-346 att-001/att-002）。该窗口不需要并发、不需要异常
# 路径，只要「仓库根跑一次正常构建 + 有宿主正在运行」就必然出现。
#
# 现流程：
#   - 所有产物先落在仓库根内的暂存目录 `.dist-stage.XXXXXX/`（必须与 dist 同一文件系统，
#     否则 rename 会退化成跨设备拷贝而失去原子性；故不能放 /tmp）；
#   - 任何一步失败 ⇒ 旧 dist/ 一字未动，EXIT trap 清掉暂存根（不留半个 dist、不留暂存残留）；
#   - 全部成功后发布：`mv -T --exchange`（renameat2 RENAME_EXCHANGE）把暂存树与 dist/ 在
#     **单次系统调用**内互换 ⇒ 读者要么看到完整旧树、要么看到完整新树，零空窗。
#     被换出来的旧树位于暂存根内，随 EXIT trap 一次性删除（读者永远不会走这条路径）。
#   - 退化路径：mv 不支持 --exchange（需 GNU coreutils ≥ 9.6；macOS/BSD mv 与旧 coreutils
#     均无）时退回「两次 rename」并在 stderr 明确告警 —— 该路径存在极短空窗，仅为可用性兜底，
#     Linux/WSL2 目标平台不走这里。
#   - 子脚本（sync-core.sh / build-client.sh）的产物根由 DIST_DIR 重定向到暂存区，编译中间
#     目录由 CORE_DIST 重定向，故并发构建之间不再共享（也不再互相 rm -rf）任何可写目录。
#
# ⚠️ 实验性构建禁止在主树进行（见 AGENTS.md「Build Isolation」）：构建一律在隔离 worktree
# 或仓库内私有副本中进行；主树 dist/ 是运行中宿主的资产来源。
#
# 适用场景：
# - 本地开发：pnpm build / npm run build
# - 预发布：pnpm prepack / npm run prepack
# - GitHub 源码安装：npm install github:owner/repo 自动触发 prepare 脚本
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"
DIST="$REPO_ROOT/dist"

# 暂存根：与 dist 同一文件系统（仓库根内），供 rename/EXCHANGE 原子切换。
STAGE_ROOT="$(mktemp -d "$REPO_ROOT/.dist-stage.XXXXXX")"
# 子脚本内部会自行 cd 到仓库根，故这里传相对路径即可（日志更可读）。
STAGE_ROOT_REL="${STAGE_ROOT#"$REPO_ROOT"/}"
STAGE_DIST_REL="$STAGE_ROOT_REL/dist"
STAGE_CORE_DIST_REL="$STAGE_ROOT_REL/core-dist"
STAGE_DIST="$STAGE_ROOT/dist"
# 仅退化路径（无 --exchange）使用的旧树临时名；正常路径不创建。
LEGACY_PREV="$REPO_ROOT/dist.prev.$$"
cleanup() { rm -rf "$STAGE_ROOT" "$LEGACY_PREV"; }
trap cleanup EXIT

echo "=== 统一构建：核心层 + 客户端 + dist 组装（原子发布）==="
echo "暂存目录：$STAGE_ROOT_REL（发布前 dist/ 保持不变）"

# 暂存根内提供 `dsh-graph-host` 视图：下面第 3 步的复制清单保持字面 `dsh-graph-host/... →
# dist/...` 形式（既有 dist 同步断言逐条解析该清单），故把组装阶段的 cwd 切到暂存根。
mkdir -p "$STAGE_DIST"
ln -s "$REPO_ROOT/dsh-graph-host" "$STAGE_ROOT/dsh-graph-host"

echo ""
echo "--- 步骤 1/3：编译核心层 → dist/core/ ---"
DIST_DIR="$STAGE_DIST_REL" CORE_DIST="$STAGE_CORE_DIST_REL" bash scripts/sync-core.sh

echo ""
echo "--- 步骤 2/3：打包客户端 → dist/lib/client.js ---"
DIST_DIR="$STAGE_DIST_REL" bash scripts/build-client.sh

echo ""
echo "--- 步骤 3/3：组装发布产物到 dist/（暂存，未发布）---"
cd "$STAGE_ROOT"

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
cd "$REPO_ROOT"

echo ""
echo "--- 原子发布：切换 dist/ ---"
if [ ! -e "$DIST" ]; then
  # 首次构建：目标不存在，单次 rename 即就位
  mv "$STAGE_DIST" "$DIST"
  echo "✅ 原子发布（首次）：dist/ 由暂存树单次 rename 就位"
elif mv --exchange --help >/dev/null 2>&1; then
  # renameat2(RENAME_EXCHANGE)：暂存树与 dist/ 在单次系统调用内互换，读者零空窗
  mv -T --exchange "$STAGE_DIST" "$DIST"
  echo "✅ 原子发布：mv -T --exchange（单次系统调用，读者零空窗）"
else
  echo "⚠️ 当前 mv 不支持 --exchange（需 GNU coreutils ≥ 9.6），退回两次 rename：存在极短空窗" >&2
  mv "$DIST" "$LEGACY_PREV"
  mv "$STAGE_DIST" "$DIST"
  rm -rf "$LEGACY_PREV"
fi

echo ""
echo "--- 清理 dsh-graph-host 内的历史遗留构建产物（g-319 之前的旧产物位置，非源目录）---"
# g-319 之前 core 编译到 dsh-graph-host/core/、client 拼接到 dsh-graph-host/lib/client.js；
# 这两处已被 .gitignore 标记为「不再跟踪」的历史产物路径。它们**不是**源目录（源是根 core/*.ts
# 与 dsh-graph-host/lib/client/*.js），这里只做源树卫生清理，与发布无先后依赖，故放在发布之后。
rm -rf dsh-graph-host/core
rm -f dsh-graph-host/lib/client.js

echo ""
echo "=== 构建完成 ==="
echo "产物目录：dist/"
echo "  dist/core/*.js（来自 core/*.ts 编译）"
echo "  dist/lib/client.js（来自 dsh-graph-host/lib/client/*.js 拼接）"
echo "  dist/index.js（插件入口）"
echo "  dist/package.json（发布配置）"
