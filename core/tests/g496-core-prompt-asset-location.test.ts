/**
 * core/tests/g496-core-prompt-asset-location.test.ts
 *
 * g-496（P8）：core 侧提示词正文资产从「代码内联」迁到 `.md` 单一真源后，core 必须在
 * **两种发布形态**下都能定位到资产，且资产缺失时**明确失败**（绝不回读仓库源掩盖漏包）。
 *
 * 负责人批准的两项**明确静态定位**（无 cwd 探测 / 无目录搜索 / 无新依赖 / 无构建生成链）：
 *   · 源形态（`core/ops.ts`）         ⇒ `<repo>/dsh-graph-host/prompts/`
 *   · 发布形态（`dist/core/ops.js`）  ⇒ `<root>/dist/prompts/`
 *
 * 本守卫断言的是**真实行为**（真读资产、真装配正文、真按目录切换），不是 `new Function`
 * 抽块或字符串自证：
 *   A. 源码树里 `readCorePromptAsset` 返回的正文与 `dsh-graph-host/prompts/<name>.<lang>.md`
 *      **逐字节一致**（去掉尾部换行后的装配形态），且 zh/en 各自取到对应语言。
 *   B. 发布产物 `dist/core/ops.js` 在 `dist/` 布局下解析到 `dist/prompts/`；把 `dist/` 整体
 *      复制到**任意名字**的目录后仍自洽（不依赖父目录恰叫 `dist`）⇒ 证明判别看的是
 *      「两个候选目录本身」，而不是路径里的名字。
 *   C. fail-closed：只带 `core/` 的裸拷贝 ⇒ import 即抛 `GraphError`（点名缺失资产），
 *      **不**回落去读仓库源；未知/缺省语言一律回落 zh（不另立第二套语言状态）。
 *   D. 结构性：`core/ops.ts` 只允许出现批准的两项定位，且不含 cwd 探测 / 目录搜索 / 第二处
 *      正文副本。
 */

import { test } from "node:test";

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

import {
  readCorePromptAsset, resolvePromptAssetDirUrl, resolveSubagentMode, subagentModePrompt,
  SUBAGENT_MODE_PROMPTS, SUBAGENT_MODE_PROMPTS_EN,
} from "../ops.ts";

const repoRoot = join(import.meta.dirname, "../..");
const distRoot = join(repoRoot, "dist");
const promptsSrc = join(repoRoot, "dsh-graph-host/prompts");

/** 已知由 core 读取的资产基名（迁移过来的正文真源）。 */
const CORE_READ_ASSETS = [
  "attempt-report-skeleton",
  "subagent-mode",
] as const;

// ============================================================ A. 源码形态

test("g-496 A：源码形态从 dsh-graph-host/prompts 真读正文，zh/en 各自取到对应语言", () => {
  for (const name of CORE_READ_ASSETS) {
    for (const lang of ["zh", "en"] as const) {
      const file = join(promptsSrc, `${name}.${lang}.md`);
      assert.ok(existsSync(file), `${name}.${lang}.md 必须存在于源资产目录`);
      const raw = readFileSync(file, "utf8");
      const got = readCorePromptAsset(name, lang);
      // `readCorePromptAsset` 的契约是**逐字节返回文件原文**（含尾部换行）；去尾换行由各装配点负责。
      assert.equal(got, raw, `${name}.${lang} 必须与源资产逐字节一致（原文，含尾部换行）`);
    }
    // 语言真的起作用：zh 与 en 正文必须不同（否则「按语言取」是空转）。
    assert.notEqual(readCorePromptAsset(name, "zh"), readCorePromptAsset(name, "en"), `${name} 的 zh/en 正文必须不同`);
  }
  // 未知/缺省/null 一律回落 zh（不另立第二套语言状态）。
  const name = CORE_READ_ASSETS[0];
  const zh = readCorePromptAsset(name, "zh");
  for (const bogus of [undefined, null, "", "ZH", "jp", "en-US"]) {
    assert.equal(readCorePromptAsset(name, bogus as any), zh, `语言 ${JSON.stringify(bogus)} 必须回落 zh`);
  }
});

// ============================================================ B. 发布形态

test("g-496 B：发布形态解析到 dist/prompts；dist/ 整体复制到任意目录名后仍自洽", async () => {
  // 源码树当前形态：本测试文件在 core/tests 下、import 的是 core/ops.ts ⇒ 源形态。
  assert.ok(resolvePromptAssetDirUrl().href.endsWith("/dsh-graph-host/prompts/"),
    `源码树必须解析到 dsh-graph-host/prompts/，实得 ${resolvePromptAssetDirUrl().href}`);

  const tmpBase = join(repoRoot, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const root = mkdtempSync(join(tmpBase, "g496-loc-"));
  try {
    // 把**整个 dist/** 复制到一个与 `dist` 同构但**名字无关**的目录。
    const renamed = join(root, "pkg-some-other-name");
    cpSync(distRoot, renamed, { recursive: true, dereference: true });
    assert.ok(existsSync(join(renamed, "prompts", "attempt-report-skeleton.zh.md")),
      "复制后的包必须带有 prompts/ 资产");

    const mod: any = await import(pathToFileURL(join(renamed, "core", "ops.js")).href);
    assert.ok(mod.resolvePromptAssetDirUrl().href.endsWith("/pkg-some-other-name/prompts/"),
      `发布形态必须解析到 <pkg>/prompts/（与目录名无关），实得 ${mod.resolvePromptAssetDirUrl().href}`);
    // 真读：装配结果必须与随包资产一致。
    const raw = readFileSync(join(renamed, "prompts", "attempt-report-skeleton.zh.md"), "utf8");
    assert.equal(mod.readCorePromptAsset("attempt-report-skeleton", "zh"), raw,
      "发布形态必须读到随包资产原文（逐字节）");
    assert.ok(mod.ATTEMPT_REPORT_SKELETON.includes(raw.trim().split("\n")[0]),
      "发布形态下已装配的骨架必须含资产首行（证明走的是资产，不是内联副本）");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================ C. fail-closed

test("g-496 C：只带 core/ 的裸拷贝 ⇒ import 即抛 GraphError（不回读仓库源掩盖漏包）", async () => {
  const tmpBase = join(repoRoot, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const root = mkdtempSync(join(tmpBase, "g496-bare-"));
  try {
    // 裸拷贝：只有 core/，既无 ../prompts/ 也无 ../dsh-graph-host/prompts/。
    cpSync(join(distRoot, "core"), join(root, "core"), { recursive: true, dereference: true });
    assert.ok(!existsSync(join(root, "prompts")), "裸拷贝不得带 prompts");
    assert.ok(!existsSync(join(root, "dsh-graph-host")), "裸拷贝不得带 dsh-graph-host");

    await assert.rejects(
      () => import(pathToFileURL(join(root, "core", "ops.js")).href),
      (e: any) => {
        assert.match(String(e?.message ?? ""), /prompt asset missing or unreadable/,
          `失败必须点名缺失资产，实得：${e?.message}`);
        // 不硬编码具体文件名（加载顺序会随实现调整）：只要求点名**某个** core 侧 .md 资产。
        assert.match(String(e?.message ?? ""), /[a-z0-9-]+\.(zh|en)\.md/,
          `失败必须点名具体资产文件，实得：${e?.message}`);
        return true;
      },
      "资产缺失必须 fail-closed（import 期抛错），绝不静默回落",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("g-496 C2：发布形态**删掉** prompts/ ⇒ 明确失败，绝不回读仓库源", async () => {
  const tmpBase = join(repoRoot, "tmp");
  mkdirSync(tmpBase, { recursive: true });
  const root = mkdtempSync(join(tmpBase, "g496-leak-"));
  try {
    const pkg = join(root, "pkg");
    cpSync(distRoot, pkg, { recursive: true, dereference: true });
    // 模拟「漏包」：prompts 缺失。仓库源**仍然存在且在磁盘上可达**，正是最容易被回读掩盖的场景。
    rmSync(join(pkg, "prompts"), { recursive: true, force: true });
    // 同时造一个源形态目录，内容残缺（若实现错误地优先试源形态，会读到空/缺文件）。
    mkdirSync(join(pkg, "dsh-graph-host", "prompts"), { recursive: true });
    writeFileSync(join(pkg, "dsh-graph-host", "prompts", "attempt-report-skeleton.zh.md"), "STALE-SOURCE\n", "utf8");

    await assert.rejects(
      () => import(pathToFileURL(join(pkg, "core", "ops.js")).href),
      (e: any) => {
        assert.match(String(e?.message ?? ""), /prompt asset missing or unreadable/, `实得：${e?.message}`);
        return true;
      },
      "发布形态漏包必须失败，不得回读另一位置掩盖",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ============================================================ D. 结构性

test("g-496 D：core/ops.ts 只含批准的两项定位，无 cwd 探测 / 目录搜索 / 第二处正文副本", () => {
  const ops = readFileSync(join(repoRoot, "core/ops.ts"), "utf8");
  // 两项候选都在（且只有这两项）。
  assert.ok(ops.includes('new URL("../prompts/", import.meta.url)'), "发布形态定位必须存在");
  assert.ok(ops.includes('new URL("../dsh-graph-host/prompts/", import.meta.url)'), "源形态定位必须存在");
  // 无 cwd 探测 / 目录搜索 / 环境变量开关。
  assert.doesNotMatch(ops, /process\.cwd\(\)/, "不得用 cwd 探测定位资产");
  assert.doesNotMatch(ops, /readdirSync\([^)]*prompts/, "不得对 prompts 目录做搜索式定位");
  assert.doesNotMatch(ops, /DSH_GRAPH_PROMPT|PROMPT_DIR\s*=\s*process\.env/, "不得引入环境变量开关");
  // 正文真源仍在 md：骨架与模式策略不得在 core 里内联。
  assert.ok(ops.includes('readCorePromptAsset("attempt-report-skeleton"'), "骨架必须从资产读取");
  assert.ok(ops.includes('readCorePromptAsset("subagent-mode"'), "模式策略必须从资产读取");
});

test("g-496 D2：模式策略表仍是可变导出、standard 为空、minimal 来自资产（API 兼容）", () => {
  assert.equal(SUBAGENT_MODE_PROMPTS.standard, "", "standard 必须为空串（不注入正文）");
  assert.equal(SUBAGENT_MODE_PROMPTS_EN.standard, "", "standard（en）必须为空串");
  const zhFile = readFileSync(join(promptsSrc, "subagent-mode.zh.md"), "utf8").replace(/\n+$/, "");
  const enFile = readFileSync(join(promptsSrc, "subagent-mode.en.md"), "utf8").replace(/\n+$/, "");
  assert.equal(SUBAGENT_MODE_PROMPTS.minimal, zhFile, "minimal（zh）必须等于源资产正文");
  assert.equal(SUBAGENT_MODE_PROMPTS_EN.minimal, enFile, "minimal（en）必须等于源资产正文");
  // 导出形态仍是可写表（`Record<SubagentMode, string>`），不是冻结对象。
  assert.equal(Object.isFrozen(SUBAGENT_MODE_PROMPTS), false, "导出表不得被冻结（保持既有可变 API）");
});

/**
 * g-496 返工核心断言：`minimal` 必须是**普通数据属性**（可写/可枚举/可配置），
 * 而**不是**无 setter 的访问器 —— 后者在严格模式（ESM / `tsc` 产物）下写入即抛
 * `TypeError: Cannot set property minimal of #<Object> which has only a getter`，
 * 破坏「测试可写入该表做变异对照 / 调用方可覆盖」的既有可变 API。
 *
 * 两语言**都**真跑：赋值成功 → `subagentModePrompt`/`resolveSubagentMode` 实际吃到覆盖值
 * → 恢复原值；并核对枚举/JSON/standard 空与原行为一致。只改注释不算通过。
 */
test("g-496 D3：minimal 是可写数据属性（非 getter）—— 覆盖值被实际使用，两语言各自成立", () => {
  for (const lang of ["zh", "en"] as const) {
    const table = lang === "en" ? SUBAGENT_MODE_PROMPTS_EN : SUBAGENT_MODE_PROMPTS;
    const original = table.minimal;

    // ① 属性形态：数据属性（有 value、无 get/set），且可写/可枚举/可配置。
    const desc = Object.getOwnPropertyDescriptor(table, "minimal")!;
    assert.ok("value" in desc, `${lang}: minimal 必须是数据属性（不得是 getter）`);
    assert.equal(desc.get, undefined, `${lang}: minimal 不得有 getter`);
    assert.equal(desc.set, undefined, `${lang}: minimal 不得有 setter（不引入 override 状态）`);
    assert.equal(desc.writable, true, `${lang}: minimal 必须可写`);
    assert.equal(desc.enumerable, true, `${lang}: minimal 必须可枚举（JSON 化口径不变）`);
    assert.equal(desc.configurable, true, `${lang}: minimal 必须可配置`);

    const mutate = (v: string) => { (table as unknown as Record<string, string>).minimal = v; };
    const probe = `PROBE-${lang}-1F2E3D`;
    try {
      // ② 赋值必须成功且**读回即覆盖值**（严格模式下 getter 会在此抛 TypeError）。
      mutate(probe);
      assert.equal(table.minimal, probe, `${lang}: 赋值后读回必须是覆盖值（getter 会抛 TypeError）`);

      // ③ 覆盖值必须被**真实消费路径**吃到（不是只有表本身变了）。
      assert.ok(
        subagentModePrompt("minimal", lang).includes(probe),
        `${lang}: subagentModePrompt 必须使用覆盖值`,
      );
      assert.equal(resolveSubagentMode("minimal", null, null, lang).mode, "minimal", `${lang}: resolveSubagentMode 仍认该 mode`);
      assert.ok(
        resolveSubagentMode("minimal", null, null, lang).prompt.includes(probe),
        `${lang}: 经 resolveSubagentMode 的完整链路必须使用覆盖值`,
      );
      // 另一语言**不受影响**（证明覆盖不是全局串味）。
      const other = lang === "en" ? SUBAGENT_MODE_PROMPTS : SUBAGENT_MODE_PROMPTS_EN;
      assert.ok(!other.minimal.includes(probe), `${lang}: 覆盖不得串到另一语言表`);
    } finally {
      // ④ 恢复原值，且恢复后逐字节回到资产正文。
      mutate(original);
    }
    assert.equal(table.minimal, original, `${lang}: 必须能恢复原值`);
    assert.ok(!subagentModePrompt("minimal", lang).includes(probe), `${lang}: 恢复后不得残留探针`);
  }

  // ⑤ 枚举 / JSON / standard 空 —— 与原行为一致。
  assert.deepEqual(Object.keys(SUBAGENT_MODE_PROMPTS).sort(), ["minimal", "standard"], "zh 键集合必须恰为 {minimal,standard}");
  assert.deepEqual(Object.keys(SUBAGENT_MODE_PROMPTS_EN).sort(), ["minimal", "standard"], "en 键集合必须恰为 {minimal,standard}");
  const roundTripped = JSON.parse(JSON.stringify(SUBAGENT_MODE_PROMPTS));
  assert.ok(roundTripped.minimal.length > 0, "JSON 化必须带上 minimal 正文（可枚举）");
  assert.ok(!JSON.stringify(SUBAGENT_MODE_PROMPTS).includes("PROBE-"), "JSON 化不得残留探针");
  assert.equal(SUBAGENT_MODE_PROMPTS.standard, "", "standard 仍为空串（zh）");
  assert.equal(SUBAGENT_MODE_PROMPTS_EN.standard, "", "standard 仍为空串（en）");
});
