/**
 * core/tests/g408-check-dist-not-readonly.test.ts
 *
 * g-408 守卫：`pnpm check:dist` **不是**只读入口 —— 把「文档口径 = pnpm 实测行为」钉成机器断言。
 *
 * 机制（2026-10-02，pnpm 12.3.4 实测复现）：
 *   `pnpm check:dist` 即 `pnpm run check:dist`；pnpm 在 `run` / `exec` 之前先做
 *   `verifyDepsBeforeRun` 检查（**pnpm ≥ 11 默认 `install`；pnpm 10 为 `false`**，见
 *   https://pnpm.io/settings/build）。`node_modules` 不新鲜时它**隐式执行 `pnpm install`**，
 *   于是根生命周期脚本 `prepare`（= `bash scripts/build.sh`）被触发 ⇒ **完整构建 + 原子替换
 *   `dist/`**，之后才轮到 dist-freshness 守卫。⇒ 任何「照文档跑 `pnpm check:dist` 是只读的」
 *   预期都是错的；在主树照做即等于在主树跑实验构建（g-346 教训）。
 *
 * 实测证据（本次 attempt，隔离 worktree）：
 *   - 构建出 dist 后放入哨兵 `dist/.g408-sentinel`：38 文件 / treehash `fbd6df9be2bf1684`；
 *   - `pnpm check:dist` 输出含 `prepare: … === 构建完成 ===` 与 `mv -T --exchange`；
 *     之后哨兵消失、37 文件 / treehash `ae66501b8d4d2166`（dist 被真实替换）；
 *   - 纯只读入口 `node --test core/tests/dist-freshness-g312.test.ts`：0 行 `prepare`，
 *     运行前后 dist mtime + 全树 hash 逐字节不变；
 *   - 全程主树 `dist` mtime/hash 与 `git status --porcelain`（=0）均未变。
 *
 * 本套件把上述结论固化为断言：
 *   ① 三处文档（AGENTS.md / docs/release-handbook.md / scripts/build.sh）都必须写明
 *      `verifyDepsBeforeRun` → `prepare` → 替换 `dist/`，并统一给出**不经 pnpm** 的纯只读入口；
 *   ② 负向对照：任一处回退成旧口径（「只读检查…`pnpm check:dist`」）必红；
 *   ③ 纯只读入口与 `package.json` 的 `check:dist` 指向同一守卫，且命令文本里不得出现包管理器。
 * 路线选择：g-408 走「**订正文档 + 明确纯只读入口**」，**不改** pnpm 行为（不设
 * `verifyDepsBeforeRun: false`）—— 关掉它会全仓改变 `pnpm run`/`exec` 的语义（越出本目标边界，
 * 且与 pnpm 11+ 的默认相反）。④ 把该选择也钉住：真正改走「让 check:dist 规避 prepare」时，
 * 必须连同本守卫与三处文档一起改。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "../..");
/** 唯一不触发构建的只读入口：不经 pnpm ⇒ 无 verifyDepsBeforeRun、无生命周期脚本。 */
const PURE_READONLY = "node --test core/tests/dist-freshness-g312.test.ts";
const DOCS = ["AGENTS.md", "docs/release-handbook.md", "scripts/build.sh"];

const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

/** 旧口径（与实测相反）的逐字原文 —— 任一处回退即红（负向对照，而非「恒真断言」）。 */
const FORBIDDEN: Array<{ file: string; re: RegExp; what: string }> = [
  {
    file: "AGENTS.md",
    re: /Read-only check \(never builds, never repairs, writes nothing\): `pnpm check:dist`/,
    what: "把 pnpm check:dist 写成 Read-only check",
  },
  {
    file: "AGENTS.md",
    re: /只读[^\n]{0,40}`pnpm check:dist`/,
    what: "「只读…`pnpm check:dist`」同句正面表述",
  },
  {
    file: "docs/release-handbook.md",
    re: /只读[^\n]{0,20}用[\s\S]{0,60}`pnpm check:dist`/,
    what: "把 pnpm check:dist 说成只读检查入口",
  },
  {
    file: "scripts/build.sh",
    re: /只读检查（不构建、不修复、不改文件）：pnpm check:dist/,
    what: "脚本头把 pnpm check:dist 说成只读检查",
  },
];

test("g-408 判据 1：三处文档逐处订正，并统一给出不经 pnpm 的纯只读入口", () => {
  for (const rel of DOCS) {
    const body = read(rel);
    assert.ok(body.includes(PURE_READONLY), `${rel} 须给出纯只读入口「${PURE_READONLY}」`);
    assert.match(body, /verifyDepsBeforeRun/, `${rel} 须写明 pnpm 的 verifyDepsBeforeRun 机制（真实成因）`);
    assert.match(body, /prepare/, `${rel} 须写明会触发 prepare（完整构建）`);
    assert.match(body, /check:dist/, `${rel} 须显式点名 pnpm check:dist（并说明其并不是只读入口）`);
    assert.match(
      body,
      /不是\s*\**\s*(只读|安全)|not\b[^\n]{0,12}read-?only|不要用/,
      `${rel} 须**显式否定**「check:dist 是只读入口」的旧口径，而不是含糊带过`,
    );
    assert.match(body, /dist\//, `${rel} 须写明会替换 dist/`);
  }
  assert.doesNotMatch(PURE_READONLY, /\bpnpm\b|\bnpm\b/, "纯只读入口不得经由包管理器（run/exec 会先做依赖校验）");
});

test("g-408 判据 2：纯只读入口与 package.json 的 check:dist 指向同一守卫，且语义不变", () => {
  const pkg = JSON.parse(read("package.json")) as { scripts?: Record<string, string> };
  assert.equal(
    (pkg.scripts ?? {})["check:dist"],
    PURE_READONLY,
    "check:dist 仍是指向既有只读守卫的最小入口（脚本内容未变，变的是它经 pnpm 运行时会先构建）",
  );
  const guard = read("core/tests/dist-freshness-g312.test.ts");
  assert.doesNotMatch(
    guard,
    /\b(spawn|spawnSync|execFileSync|execSync)\s*\(/,
    "纯只读守卫不得具备 spawn/exec 能力（结构上不可能静默触发构建）",
  );
});

test("g-408 判据 4 负向对照：旧「check:dist 只读」口径回退即红", () => {
  for (const { file, re, what } of FORBIDDEN) {
    assert.doesNotMatch(read(file), re, `${file}：${what}（与 2026-10-02 pnpm 12.3.4 实测相反）`);
  }
});

test("g-408 判据 3：本目标选择「订正文档」路线 —— 未改动 pnpm 行为", () => {
  for (const rel of ["pnpm-workspace.yaml", ".npmrc"]) {
    if (!existsSync(join(repoRoot, rel))) continue;
    assert.doesNotMatch(
      read(rel),
      /verify[-_]?[Dd]eps[-_]?[Bb]efore[-_]?[Rr]un\s*[:=]\s*(false|["']false["'])/,
      `${rel} 不得为了让 check:dist 变只读而关闭 pnpm 的 verifyDepsBeforeRun（包管理器行为越界）；` +
        "若确要走该路线，须连同本守卫与三处文档一起改（见文件头「路线选择」）",
    );
  }
});
