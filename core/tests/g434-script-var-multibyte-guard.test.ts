/**
 * core/tests/g434-script-var-multibyte-guard.test.ts
 *
 * g-434 结构性守卫：macOS 自带 **bash 3.2** 的「多字节变量名吞并」缺陷不得再进入构建脚本。
 *
 * 真机事故（2026-10-06，v0.19.7 发布候选，负责人在原生 macOS 上执行 `bash scripts/build.sh`）：
 *
 *     scripts/build.sh: 行 112: STAGE_ROOT_REL<0xEF>: 未绑定的变量
 *
 * 该行原文是 `echo "暂存目录：$STAGE_ROOT_REL（发布前 dist/ 保持不变）"` —— 变量名后**紧跟全角括号**
 * （UTF-8 `EF BC 88`）。bash 3.2 在 UTF-8 locale 下把紧随的多字节字符首字节**并进变量名** ⇒ 展开的名字
 * 不存在 ⇒ `set -u`（`scripts/build.sh:69` 的 `set -euo pipefail`）判「未绑定变量」并立即中止 ⇒
 * `dist/` 从未构建 ⇒ **macOS 源码构建 100% 失败**（含 `npm install github:miuzel/dsh-graph` 触发的
 * `prepare`）。Linux / Git Bash 用的是 bash 4/5，在 ASCII 边界停止 ⇒ 同一份源码不会暴露该问题
 * （本机 bash 5.3 实测 `$x（` 正常展开），这正是它长期潜伏的原因。
 *
 * 为什么必须有机器守卫：M4「发布脚本可移植性审计」是**静态**审计，当时判定通过 —— 而这条真机致命
 * 缺陷就写在它审的文件里。静态审计的盲区只能由断言补上，正解一律写 `${NAME}`（花括号）。
 *
 * 三个断言面：
 *  A. 文件集非空（防退化空跑）：非 archived 的 `scripts/**` 下 `.sh` 不少于 4 个且点名四个构建脚本；
 *  B. 0 命中：任何 `$NAME`（含 `$1` 这类位置参数）紧跟非 ASCII 字节的**代码行**都判红；
 *  C. 判别力自检：合成样本里裸写必须命中、加花括号或紧跟 ASCII 必须不命中（守卫不许恒真/恒假）。
 *
 * 口径边界（有意为之）：只扫 shell 脚本；整行注释（`^\s*#`）不参与执行，故不扫；`scripts/archived/**`
 * 是已废弃脚本（不参与任何运行路径），不扫。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");

/**
 * `$NAME`（含 `$1`）**紧跟非 ASCII 字节**。捕获组 1 = 变量名，用于给出 `${NAME}` 修法。
 * 注意：不能只认字母开头 —— 真机上同一类里的 `$1（…）` 同样会崩。
 */
const HAZARD_SRC = String.raw`\$([A-Za-z0-9_]+)[^\x00-\x7F]`;

/** 递归收集非 archived 的 shell 脚本（`scripts/archived/**` 已废弃，不参与运行）。 */
function collectShellScripts(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "archived") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectShellScripts(full));
    else if (entry.name.endsWith(".sh")) found.push(full);
  }
  return found.sort();
}

test("g-434 判据 1：非 archived 的 shell 脚本文件集非空（守卫不得空跑）", () => {
  const files = collectShellScripts(SCRIPTS_DIR);
  assert.ok(files.length >= 4, `scripts/ 下非 archived 的 .sh 应 ≥ 4 个，实际 ${files.length}`);
  for (const name of ["build.sh", "build-client.sh", "sync-core.sh", "dsh-test-web.sh"]) {
    assert.ok(
      files.includes(join(SCRIPTS_DIR, name)),
      `文件集必须包含 scripts/${name}（守卫不得因改名/移动而静默失效）`,
    );
  }
});

test("g-434 判据 2：不存在「$VAR 紧跟非 ASCII」的代码行（macOS bash 3.2 会吞并变量名）", () => {
  const problems: string[] = [];
  for (const file of collectShellScripts(SCRIPTS_DIR)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, index) => {
      if (/^\s*#/.test(line)) return; // 整行注释不执行，不构成风险
      const match = new RegExp(HAZARD_SRC).exec(line);
      if (match) {
        problems.push(
          `${relative(REPO_ROOT, file)}:${index + 1}: $${match[1]} 紧跟非 ASCII ⇒ 应写成 \${${match[1]}}`,
        );
      }
    });
  }
  assert.deepEqual(
    problems,
    [],
    `macOS bash 3.2 会吞并下列变量名（加花括号即可，语义不变）：\n${problems.join("\n")}`,
  );
});

test("g-434 判据 3：守卫判别力自检（裸写必命中、加花括号/紧跟 ASCII 必不命中）", () => {
  const hits = (source: string) => new RegExp(HAZARD_SRC).test(source);
  // 正向：真机事故原样 + 另外两处真机同型
  assert.equal(
    hits('echo "暂存目录：$STAGE_ROOT_REL（发布前 dist/ 保持不变）"'),
    true,
    "真机事故原样必须命中",
  );
  assert.equal(hits('die "非法端口：$PORT（禁止前导零）"'), true, "裸写必须命中");
  assert.equal(hits('die "不支持的参数：$1（仅允许 --port）"'), true, "位置参数形态必须命中");
  // 反向：正解与安全形态
  assert.equal(
    hits('echo "暂存目录：${STAGE_ROOT_REL}（发布前 dist/ 保持不变）"'),
    false,
    "加花括号必须不命中",
  );
  assert.equal(hits('echo "路径=$STAGE_ROOT_REL/dist"'), false, "紧跟 ASCII 必须不命中");
});
