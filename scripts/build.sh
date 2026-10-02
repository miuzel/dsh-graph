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
#   - g-359：退化路径此前**零测试覆盖**（在 coreutils ≥ 9.6 的构建机上永远走不到），且它同样
#     影响 coreutils < 9.6 的 Linux 用户与 macOS。故提供**行为中性**的测试注入
#     `BUILD_FORCE_TWO_RENAME=1`：强制跳过 `mv --exchange` 能力探测、直接走两次 rename。
#     未设置（或非 "1"）时判断与历史实现逐字等价（仍按 mv 能力探测），发布方式与产物一字未变。
#   - 子脚本（sync-core.sh / build-client.sh）的产物根由 DIST_DIR 重定向到暂存区，编译中间
#     目录由 CORE_DIST 重定向，故并发构建之间不再共享（也不再互相 rm -rf）任何可写目录。
#
# ── g-353：无 exchange 平台（coreutils < 9.6 / macOS / BSD）的两次 rename 加固 ──────────
# 两次 rename 之间必然存在一个「dist/ 已被移走、新树尚未就位」的窗口。此前：
#   - 第二次 rename 失败 ⇒ set -e 退出 ⇒ EXIT trap 顺手 rm -rf dist.prev.<pid> ⇒ 旧树也没了；
#   - 窗口内被 SIGKILL ⇒ trap 根本不运行 ⇒ dist/ 缺失、旧树孤零零留在 dist.prev.<pid>。
# 现在（最小可恢复 + fail-closed 并存）：
#   1. 第二次 rename 失败 ⇒ 先**回滚**（mv dist.prev.<pid> dist），活动路径恢复为逐字节完好的
#      旧树，再以非 0 退出；只有回滚也失败才进入 fail-closed。
#   2. fail-closed：此刻旧树是**唯一完好副本**，EXIT trap 绝不删除它（被 INT/TERM 打断时同理），
#      并打印恢复命令。绝不为了兜底而删除仍然完好的旧 dist。
#   3. SIGKILL（trap 无法运行，遗留 dist.prev.<pid>）⇒ 下次构建启动时自动恢复（可重放：恢复
#      动作幂等，重复执行无副作用），或手工执行恢复命令。
# 恢复命令（dist/ 缺失、旧树在 dist.prev.<pid> 时）：
#   mv dist.prev.<pid> dist
# 能力探测与实际失败的区分：`mv --exchange --help` 只判定 **mv 二进制能力**；`mv -T --exchange`
# 的运行时失败（文件系统/挂载点不支持 RENAME_EXCHANGE，如部分 overlayfs / 网络挂载）是另一回事，
# 此时暂存树与 dist/ 都完好，退回两次 rename 继续发布并明确告警，而不是把两者混为一谈。
#
# ⚠️ 实验性构建禁止在主树进行（见 AGENTS.md「Build Isolation」）：构建一律在隔离 worktree
# 或仓库内私有副本中进行；主树 dist/ 是运行中宿主的资产来源。
#
# 适用场景（g-353：**唯一打包入口**，根 package.json 的 build 与 prepare 都指向本脚本；
# 根没有 prepack —— 打包 = 先构建、再进产物目录打包）：
# - 本地开发 / 构建：pnpm build（= bash scripts/build.sh）
# - 打包 / 预发布：bash scripts/build.sh && (cd dist && npm pack)
# - GitHub 源码安装：npm install github:owner/repo 自动触发 prepare 脚本（同一条入口）
# - 纯只读检查（不构建、不修复、不改文件）：node --test core/tests/dist-freshness-g312.test.ts
#   ⚠️ g-408：`pnpm check:dist` **不是**只读入口 —— pnpm 在 run/exec 前先做 verifyDepsBeforeRun
#   检查（pnpm ≥ 11 默认 install），node_modules 不新鲜时会隐式 `pnpm install`，从而执行本脚本
#   （prepare = 完整构建）并原子替换 dist/（2026-10-02 实测，pnpm 12.3.4）。绝不要在主树跑它。
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
# g-353：两次 rename 的中间窗口标志。置 1 = dist/ 已被移走、新树尚未就位 —— 此刻
# LEGACY_PREV 是**唯一完好副本**，EXIT trap 绝不能删除它（fail-closed，绝不为兜底删旧树）。
SWAP_IN_FLIGHT=""
cleanup() {
  if [ -n "$SWAP_IN_FLIGHT" ] && [ -e "$LEGACY_PREV" ]; then
    echo "⚠️ 发布未完成：旧 dist/ 是唯一完好副本，完好保留在 $LEGACY_PREV（未删除）" >&2
    echo "   恢复命令：mv \"$LEGACY_PREV\" \"$DIST\"（下次 bash scripts/build.sh 亦会自动恢复）" >&2
  else
    rm -rf "$LEGACY_PREV"
  fi
  rm -rf "$STAGE_ROOT"
}
trap cleanup EXIT

# ── g-353：上次两次 rename 被 SIGKILL 打断后的**可重放恢复** ─────────────────────────────
# 中断窗口留下的最小痕迹：dist/ 缺失 + 遗留 dist.prev.<pid>。此时 dist.prev.<pid> 就是最后
# 一次成功构建的完整产物，放回活动路径即可恢复；恢复动作幂等，重复执行无副作用。
# 只在 dist/ **确实缺失**时恢复：绝不覆盖现存 dist/，也绝不删除任何 dist.prev.*（不自动 GC）。
prev_latest=""
for cand in "$REPO_ROOT"/dist.prev.*; do
  [ -d "$cand" ] || continue
  if [ -z "$prev_latest" ] || [ "$cand" -nt "$prev_latest" ]; then prev_latest="$cand"; fi
done
if [ ! -e "$DIST" ] && [ -n "$prev_latest" ]; then
  echo "⚠️ 检测到被中断的两次 rename 发布（dist/ 缺失）：自动恢复 $prev_latest → dist/" >&2
  mv "$prev_latest" "$DIST"
fi

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
# g-359 测试注入：仅当字面等于 "1" 时强制走退化路径；未设置/其它取值 ⇒ 与历史实现等价。
FORCE_TWO_RENAME="${BUILD_FORCE_TWO_RENAME:-0}"
# g-353 故障注入（仅测试；未设置/其它取值 ⇒ 与历史实现逐字等价）：
#   exchange      = 能力探测通过、文件系统实际 exchange 失败（运行时失败）
#   second-rename = 第二次 rename 失败（回滚成功）
#   rollback      = 第二次 rename 失败且回滚也失败（fail-closed）
#   kill          = 第一次 rename 后被 SIGKILL（trap 不运行，模拟不可捕获的中断）
BUILD_FAIL_INJECT="${BUILD_INJECT_PUBLISH_FAILURE:-}"

# 发布动作各包一层，便于故障注入；未注入时与直接 `mv` 逐字等价。
# renameat2(RENAME_EXCHANGE)：暂存树与 dist/ 在单次系统调用内互换，读者零空窗。
exchange_publish() { mv -T --exchange "$STAGE_DIST" "$DIST"; }
swap_out_old() { mv "$DIST" "$LEGACY_PREV"; }
swap_in_new() { mv "$STAGE_DIST" "$DIST"; }
rollback_old() { mv "$LEGACY_PREV" "$DIST"; }
case "$BUILD_FAIL_INJECT" in
  exchange) exchange_publish() { echo "⚠️ [注入] 模拟 RENAME_EXCHANGE 运行时失败（EXDEV/EINVAL）" >&2; return 1; } ;;
  second-rename | rollback) swap_in_new() { echo "⚠️ [注入] 模拟第二次 rename 失败" >&2; return 1; } ;;
esac
if [ "$BUILD_FAIL_INJECT" = "rollback" ]; then
  rollback_old() { echo "⚠️ [注入] 模拟回滚 rename 失败" >&2; return 1; }
fi

# 退化发布路径：两次 rename（存在极短空窗）+ 第二次失败回滚 + 回滚失败 fail-closed。
two_rename_publish() {
  echo "  → 两次 rename：dist/ → $(basename "$LEGACY_PREV")，再把新树就位" >&2
  SWAP_IN_FLIGHT=1
  if ! swap_out_old; then
    SWAP_IN_FLIGHT=""
    echo "❌ 无法移出旧 dist/（$DIST → $LEGACY_PREV）：dist/ 一字未动，构建中止" >&2
    exit 1
  fi
  if [ "$BUILD_FAIL_INJECT" = "kill" ]; then
    echo "⚠️ [注入] 模拟第一次 rename 后被 SIGKILL（trap 不运行）" >&2
    kill -9 "$$"
  fi
  if swap_in_new; then
    rm -rf "$LEGACY_PREV"
    SWAP_IN_FLIGHT=""
    echo "✅ 发布完成（退化路径：两次 rename）"
    return 0
  fi
  echo "❌ 第二次 rename 失败（dist/ 当前缺失）：尝试回滚" >&2
  if rollback_old; then
    SWAP_IN_FLIGHT=""
    echo "✅ 已回滚：dist/ 恢复为逐字节完好的旧树，本次构建中止（exit 1）" >&2
    exit 1
  fi
  echo "❌ 回滚也失败（fail-closed）：旧 dist 完整保留在 $LEGACY_PREV（绝不删除）" >&2
  echo "   恢复命令：mv \"$LEGACY_PREV\" \"$DIST\"（下次 bash scripts/build.sh 亦会自动恢复）" >&2
  exit 1
}

if [ ! -e "$DIST" ]; then
  # 首次构建：目标不存在，单次 rename 即就位
  mv "$STAGE_DIST" "$DIST"
  echo "✅ 原子发布（首次）：dist/ 由暂存树单次 rename 就位"
elif [ "$FORCE_TWO_RENAME" != "1" ] && mv --exchange --help >/dev/null 2>&1; then
  # ① 能力判定：mv 二进制是否支持 --exchange（GNU coreutils ≥ 9.6）。
  # ② 运行时：文件系统/挂载点**实际**是否支持 renameat2(RENAME_EXCHANGE)。二者必须区分：
  #    能力探测通过而运行时失败（部分 overlayfs / 网络挂载）不是「平台不支持」，而是本次
  #    发布的运行时失败；此时暂存树与 dist/ 都完好，退回两次 rename 继续发布并明确告警。
  if exchange_publish; then
    echo "✅ 原子发布：mv -T --exchange（单次系统调用，读者零空窗）"
  else
    echo "⚠️ 能力探测通过（mv 支持 --exchange），但文件系统实际 exchange 失败（RENAME_EXCHANGE 不受支持）：退回两次 rename，存在极短空窗" >&2
    two_rename_publish
  fi
else
  if [ "$FORCE_TWO_RENAME" = "1" ]; then
    echo "⚠️ BUILD_FORCE_TWO_RENAME=1（g-359 测试注入）：跳过 mv --exchange 探测，退回两次 rename：存在极短空窗" >&2
  else
    echo "⚠️ 当前 mv 不支持 --exchange（需 GNU coreutils ≥ 9.6），退回两次 rename：存在极短空窗" >&2
  fi
  two_rename_publish
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
