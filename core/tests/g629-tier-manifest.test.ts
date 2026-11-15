/**
 * g-629：测试**分层清单**的一致性守卫。
 *
 * 分层按**文件集合**（shakedown ⊊ integration ⊊ full ⊊ full ∪ microTests = everything）；
 * 既有 g-326 是**按改动性质**的三档（一档零行为/二档小幅逻辑/三档新增功能）。
 * 两者**正交并存**：本文件只管「跑哪些文件」，不改变「该配什么测试力度」。
 *
 * 唯一真源：`core/tests/tier-manifest.json`。本文件守这些事：
 *  ① 日常回归梯度是**严格真子集链**（shakedown ⊊ integration ⊊ full），相邻层相等即判红；
 *  ② `everything` = `full ∪ microTests` = 磁盘全集：full 与 microTests 不相交、
 *     并集与磁盘**双向**相等；磁盘出现未分类新文件 ⇒ fail-closed 判红并点名；幽灵项 ⇒ 判红；
 *  ③ `focused` 是**关键目标专题集合**，不是层级：层级**不得** include `focused`，
 *     `focused` 不得出现在 `tiers` 里，每个专题必须非空且说明「为谁而建」；
 *  ④ 安全/鉴权、隔离、门禁防伪绿**三大家族必须有日常覆盖**（全部位于 shakedown 或 integration，
 *     清单在本文件**显式枚举**，缺一判红）；
 *  ⑤ **反向变异**必红（每类都对**同一套判据函数** `manifestProblems` 施加变异并断言报错）：
 *     删掉某层文件 / 上层改成与下层相等 / 新增未分类文件 / 把家族文件移出日常层 /
 *     专题集合为空 / 把 focused 当层级 include。
 *
 * 变异做法：在**纯数据**上改（`structuredClone` 后的 manifest、内存里的磁盘文件列表），
 * 必要时在仓库内 gitignored 的 `tmp/` 下建私有副本跑**真实的**入口脚本（负向对照）。
 * 不碰真实 manifest、不修改任何既有测试、不写被跟踪的文件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname, "..", "..");
const MANIFEST_REL = "core/tests/tier-manifest.json";
const TESTS_DIR_REL = "core/tests";
const TEST_SUFFIX = ".test.ts";
const ENTRY_REL = "scripts/test-tier.mjs";

/** 日常回归梯度：相邻必须严格递增（后者真包含前者）。`everything` 是磁盘全集端，单独核。 */
const TIER_ORDER = ["shakedown", "integration", "full"];

/** microTests 的硬上限：断言数 ≤8（细则见 docs/test-tiers.md）。 */
const MICRO_MAX_ASSERTS = 8;

/**
 * 三大家族：**显式枚举**（不靠通配），缺一判红。这是「必须被日常覆盖的下限」——
 * manifest.families 只能比它多，不能比它少；且每个文件必须真在 **shakedown 或 integration**。
 */
const REQUIRED_FAMILIES = {
  "安全/鉴权": [
    "g507-auth-negative-controls.test.ts",
    "g507-evidence-collect.test.ts",
    "g507-http-auth-guard.test.ts",
    "g507-http-auth-real-host.test.ts",
    "g507-http-auth-surface.test.ts",
    "g611-private-workspace-isolation.test.ts",
    "g383-lock-ownership.test.ts",
  ],
  隔离: [
    "g289-workspace-cleanliness.test.ts",
    "g363-scratch-isolation.test.ts",
    "g406-dispatch-isolation-verdict.test.ts",
    "g414-dispatch-prediction-readonly.test.ts",
    "g448-cross-board-worktree-ownership.test.ts",
    "g449-cross-board-clean-ownership.test.ts",
    "g611-private-workspace-isolation.test.ts",
    "worktree-isolation-g283.test.ts",
    "g329-abandon-worktree.test.ts",
  ],
  门禁防伪绿: [
    "g350-test-hygiene.test.ts",
    "g407-nested-runner-context.test.ts",
    "g413-gate-integrity.test.ts",
    "g415-gate-hardening.test.ts",
    "g416-nested-runner-coverage.test.ts",
    "g417-nested-runner-selection-and-paths.test.ts",
    "g418-nested-runner-strict-targets.test.ts",
    "g419-nested-runner-fallback-injection.test.ts",
    "g420-nested-runner-crosscheck-and-shell-subset.test.ts",
    "g421-nested-runner-negative-verdict.test.ts",
    "g424-negative-verdict-skip-todo.test.ts",
  ],
};

// ── 纯函数判据（真实清单与变异副本共用同一套；这是「变异必红」有意义的前提）──────────────

/** 沿 include 链展开**登记在 manifest 里**的层（并集语义）。
 *  未知层级 / include 环**不抛异常**，而是作为问题返回（fail-closed），
 *  这样「层级 include 了 focused」这类结构错误能被判据本身点名，而不是让守卫崩掉。 */
function expandDeclared(manifest, tier, chain = [], problems = []) {
  const def = manifest.tiers?.[tier];
  if (!def) {
    problems.push(`层级定义缺失：include 链引用了不存在的层级「${tier}」⇒ 判红`);
    return new Set();
  }
  if (chain.includes(tier)) {
    problems.push(`层级 include 出现环：${[...chain, tier].join(" → ")} ⇒ 判红`);
    return new Set();
  }
  const next = [...chain, tier];
  const set = new Set();
  for (const parent of def.include ?? []) {
    for (const f of expandDeclared(manifest, parent, next, problems)) set.add(f);
  }
  for (const name of def.files ?? []) set.add(name);
  return set;
}

/** 全部定位集合：日常梯度 + everything（磁盘端）+ microTests + focused 各专题。 */
function buildSets(manifest, diskFileList, problems = []) {
  const tiers = {};
  for (const tier of TIER_ORDER) tiers[tier] = expandDeclared(manifest, tier, [], problems);
  tiers.everything = new Set(diskFileList);
  const micro = new Set((manifest.microTests?.files ?? []).map((e) => e.file));
  const topics = {};
  for (const [name, def] of Object.entries(manifest.focused?.topics ?? {})) {
    topics[name] = new Set(def.files ?? []);
  }
  return { tiers, micro, topics };
}

const list = (set) => [...set].sort();

/** ① ② ③ ④：返回**全部**问题（空数组 = 全绿）。变异用同一函数，不得另写一份宽松版。 */
function manifestProblems(manifest, diskFileList) {
  const problems = [];
  const diskSet = new Set(diskFileList);
  const { tiers, micro, topics } = buildSets(manifest, diskFileList, problems);

  // ── ③ focused 不是层级 ────────────────────────────────────────────────────
  if (manifest.tiers?.focused) {
    problems.push("focused 出现在 tiers 里 ⇒ focused 是专题集合、不是层级，判红");
  }
  for (const tier of TIER_ORDER) {
    if ((manifest.tiers?.[tier]?.include ?? []).includes("focused")) {
      problems.push(`层级「${tier}」include 了 focused ⇒ 专题集合不得作日常层底座，判红`);
    }
  }
  const topicEntries = Object.entries(manifest.focused?.topics ?? {});
  if (topicEntries.length === 0) {
    problems.push("focused 专题集合为空 ⇒ 判红");
  }
  for (const [name, def] of topicEntries) {
    const files = def.files ?? [];
    if (files.length === 0) problems.push(`专题「focused/${name}」为空 ⇒ 判红`);
    if (new Set(files).size !== files.length) problems.push(`专题「focused/${name}」含重复文件 ⇒ 判红`);
    const ghost = files.filter((f) => !diskSet.has(f));
    if (ghost.length > 0) problems.push(`专题「focused/${name}」含磁盘上不存在的文件 ⇒ 判红：${ghost.join("、")}`);
    // 专题必须说明「为哪个关键 goal/事故建的、要防什么复发」
    if (typeof def.description !== "string" || def.description.trim().length < 20) {
      problems.push(`专题「focused/${name}」缺少有意义的目的说明（description）⇒ 判红`);
    }
  }

  // ── ② everything = full ∪ microTests = 磁盘全集 ───────────────────────────
  const full = tiers.full;
  const overlap = list(micro).filter((f) => full.has(f));
  if (overlap.length > 0) {
    problems.push(`microTests 必须**排除**在 full 之外（full 已含）⇒ 判红：${overlap.join("、")}`);
  }
  const unionFiles = new Set([...full, ...micro]);
  const unclassified = diskFileList.filter((f) => !unionFiles.has(f));
  if (unclassified.length > 0) {
    problems.push(`磁盘有未分类测试文件（既不在 full 也不在 microTests）⇒ fail-closed 判红：${unclassified.join("、")}`);
  }
  const phantom = list(unionFiles).filter((f) => !diskSet.has(f));
  if (phantom.length > 0) {
    problems.push(`manifest 登记了磁盘上不存在的文件（幽灵项）⇒ 判红：${phantom.join("、")}`);
  }
  for (const [name, entry] of (manifest.microTests?.files ?? []).entries()) {
    if (!entry.file || typeof entry.file !== "string") problems.push(`microTests[${name}] 缺少 file ⇒ 判红`);
    if (!entry.why || String(entry.why).trim().length < 20) {
      problems.push(`microTests[${name}]（${entry.file}）缺少代码证据 why ⇒ 判红`);
    }
  }

  // ── ④ 三大家族必须有日常覆盖 ──────────────────────────────────────────────
  const daily = new Set([...tiers.shakedown, ...tiers.integration]);
  const manifestFam = new Set(Object.values(manifest.families ?? {}).flatMap((fam) => fam.files ?? []));
  for (const [name, required] of Object.entries(REQUIRED_FAMILIES)) {
    const missingFromDaily = required.filter((f) => !daily.has(f));
    if (missingFromDaily.length > 0) {
      problems.push(`家族「${name}」有文件不在日常层（shakedown/integration）⇒ 判红：${missingFromDaily.join("、")}`);
    }
    const missingFromManifest = required.filter((f) => !manifestFam.has(f));
    if (missingFromManifest.length > 0) {
      problems.push(`家族「${name}」有文件未登记进 manifest.families ⇒ 判红：${missingFromManifest.join("、")}`);
    }
    const downshifted = required.filter((f) => micro.has(f));
    if (downshifted.length > 0) {
      problems.push(`家族「${name}」有文件被下放到 microTests ⇒ 判红：${downshifted.join("、")}`);
    }
  }

  // ── ① 严格真子集链 shakedown ⊊ integration ⊊ full ────────────────────────
  for (let i = 0; i + 1 < TIER_ORDER.length; i++) {
    const lower = TIER_ORDER[i];
    const upper = TIER_ORDER[i + 1];
    const notSubset = list(tiers[lower]).filter((f) => !tiers[upper].has(f));
    if (notSubset.length > 0) {
      problems.push(`「${lower}」不是「${upper}」的子集 ⇒ 判红：${notSubset.join("、")}`);
    }
    if (tiers[lower].size === tiers[upper].size) {
      problems.push(`「${lower}」与「${upper}」文件数相等（${tiers[lower].size}）⇒ 不是真子集，层级失去意义`);
    }
  }
  // 层与层之间**不重复登记**（每层 files 是「本层新增」；重复登记会让并集口径与「层」概念漂移）
  const declaredIn = new Map();
  for (const tier of Object.keys(manifest.tiers ?? {})) {
    for (const f of manifest.tiers[tier].files ?? []) {
      if (declaredIn.has(f)) problem_dup(problems, f, declaredIn.get(f), tier);
      else declaredIn.set(f, tier);
    }
  }

  // 每层非空；标签非空且成员真实存在
  for (const tier of [...TIER_ORDER, "everything"]) {
    if (tiers[tier].size === 0) problems.push(`层级「${tier}」为空 ⇒ 判红`);
  }
  const labels = manifest.labels ?? {};
  if (Object.keys(labels).length === 0) problems.push("manifest 没有任何标签维度 ⇒ 判红");
  for (const [label, def] of Object.entries(labels)) {
    const files = def.files ?? [];
    if (files.length === 0) problems.push(`标签「${label}」为空 ⇒ 判红`);
    if (new Set(files).size !== files.length) problems.push(`标签「${label}」含重复文件 ⇒ 判红`);
    const ghost = files.filter((f) => !diskSet.has(f));
    if (ghost.length > 0) problems.push(`标签「${label}」含磁盘上不存在的文件 ⇒ 判红：${ghost.join("、")}`);
  }

  // 专题文件**可以**与层级重叠（这是有意的：专题是按需验证脚本，层级是回归梯度），
  // 但专题本身不得引用 microTests 之外的空洞 —— 上面已核「磁盘存在」。
  return problems;
}

function problem_dup(problems, file, firstTier, secondTier) {
  problems.push(`文件「${file}」被重复登记在「${firstTier}」与「${secondTier}」⇒ 各层 files 应为本层新增，判红`);
}

/** microTests 的断言数上界核验（粗粒度但可复算的代码证据，不靠文件名归类）。 */
function countAsserts(source) {
  const matches = source.match(/(?:^|[^A-Za-z0-9_$.])assert\.[A-Za-z]+\(/g) ?? [];
  return matches.length;
}

function readManifest() {
  return JSON.parse(readFileSync(join(repoRoot, MANIFEST_REL), "utf8"));
}

/** 磁盘展开（everything 的真源）：与入口/闸门同一 `core/tests/*.test.ts` 语义。 */
function diskFiles() {
  return readdirSync(join(repoRoot, TESTS_DIR_REL))
    .filter((name) => name.endsWith(TEST_SUFFIX))
    .sort();
}

// ── 正向：真实清单必须全绿 ──────────────────────────────────────────────────

test("g-629 正向：真子集链 + everything=full∪microTests=磁盘 + 专题非空 + 家族日常覆盖", (t) => {
  const manifest = readManifest();
  const files = diskFiles();
  const problems = manifestProblems(manifest, files);
  assert.deepEqual(problems, [], `分层清单不达标 —— ${problems.join("；")}`);
  const { tiers, micro, topics } = buildSets(manifest, files);
  t.diagnostic(
    `evidence: suite=g629-tier-manifest shakedown=${tiers.shakedown.size} integration=${tiers.integration.size} ` +
      `full=${tiers.full.size} micro=${micro.size} everything=${tiers.everything.size} ` +
      `topics=${Object.keys(topics).length} problems=0`,
  );
});

test("g-629 正向：三大家族逐类点名在日常层（shakedown 或 integration，显式枚举缺一判红）", (t) => {
  const manifest = readManifest();
  const { tiers, micro } = buildSets(manifest, diskFiles());
  const daily = new Set([...tiers.shakedown, ...tiers.integration]);
  for (const [family, required] of Object.entries(REQUIRED_FAMILIES)) {
    const missing = required.filter((f) => !daily.has(f));
    assert.deepEqual(missing, [], `家族「${family}」必须全部位于日常层，缺：${missing.join("、")}`);
    const downshifted = required.filter((f) => micro.has(f));
    assert.deepEqual(downshifted, [], `家族「${family}」不得下放到 microTests：${downshifted.join("、")}`);
    t.diagnostic(`evidence: suite=g629-tier-family family=${family} required=${required.length} missing=0`);
  }
});

test("g-629 正向：focused 专题不是层级（层级不 include 它、tiers 里也没有它）", () => {
  const manifest = readManifest();
  assert.equal(manifest.tiers?.focused, undefined, "focused 不得作为 tiers 的一个层级");
  for (const tier of TIER_ORDER) {
    const include = manifest.tiers[tier].include ?? [];
    assert.ok(!include.includes("focused"), `层级「${tier}」不得 include focused（专题不是日常层底座）`);
  }
  assert.ok(Object.keys(manifest.focused?.topics ?? {}).length > 0, "focused 必须至少有一个具名专题");
});

test("g-629 正向：microTests 逐项有代码证据（断言数 ≤8、非家族、非构建产物依赖、真被排除在 full 外）", (t) => {
  const manifest = readManifest();
  const { tiers, micro } = buildSets(manifest, diskFiles());
  const famFiles = new Set(Object.values(manifest.families ?? {}).flatMap((fam) => fam.files ?? []));
  const entries = manifest.microTests?.files ?? [];
  assert.ok(entries.length > 0, "microTests 不得为空集（everything 必须真包含细小低风险集）");
  for (const entry of entries) {
    const file = entry.file;
    assert.ok(!tiers.full.has(file), `${file} 属于 microTests ⇒ full **不得**包含它`);
    assert.ok(micro.has(file), `${file} 必须在 microTests 里`);
    assert.ok(!famFiles.has(file), `${file} 属于三大家族 ⇒ 不得下放 microTests`);
    const source = readFileSync(join(repoRoot, TESTS_DIR_REL, file), "utf8");
    const asserts = countAsserts(source);
    assert.ok(
      asserts <= MICRO_MAX_ASSERTS,
      `${file} 断言数 ${asserts} 超过下放上限 ${MICRO_MAX_ASSERTS} ⇒ 不得归入 microTests（须逐项用代码证据复核）`,
    );
    // 构建产物依赖（读 dist/）⇒ 必须留 integration，不得算「无副作用」
    assert.ok(
      !/from\s+["'][^"']*\/dist\//.test(source),
      `${file} 依赖构建产物（import …/dist/…）⇒ 不得下放 microTests`,
    );
    t.diagnostic(`evidence: suite=g629-tier-micro file=${file} asserts=${asserts} inFull=no`);
  }
});

test("g-629 正向：专题内容允许与层级重叠，但每个专题可独立展开且非空", (t) => {
  const manifest = readManifest();
  const { tiers, topics } = buildSets(manifest, diskFiles());
  const daily = new Set([...tiers.shakedown, ...tiers.integration]);
  let overlapped = 0;
  for (const [name, files] of Object.entries(topics)) {
    assert.ok(files.size > 0, `专题 focused/${name} 为空`);
    if ([...files].some((f) => daily.has(f))) overlapped++;
  }
  // 这是**有意的**语义：专题常复用日常层文件做「按需快验证」，不是重复登记错误。
  t.diagnostic(`evidence: suite=g629-tier-topic count=${Object.keys(topics).length} overlapWithDaily=${overlapped}`);
});

// ── ⑤ 反向变异：每类都必须让**同一套判据**报错 ────────────────────────────

/** 变异前先断言正向全绿（保证「红」不是恒红，而是变异造成的）。 */
function fresh(g, mutate) {
  const manifest = readManifest();
  const files = diskFiles();
  assert.deepEqual(manifestProblems(manifest, files), [], "变异前正向必须全绿，否则变异对照无意义");
  const cloned = structuredClone(manifest);
  const disk = [...files];
  const ctx = { manifest: cloned, disk };
  mutate?.(ctx);
  return { manifest: ctx.manifest, disk: ctx.disk, problems: manifestProblems(ctx.manifest, ctx.disk) };
}

test("g-629 反向变异①：删掉某层的一个文件 ⇒ 判红并点名", () => {
  const victim = "memory.test.ts";
  const { problems } = fresh(null, ({ manifest }) => {
    manifest.tiers.shakedown.files = manifest.tiers.shakedown.files.filter((f) => f !== victim);
  });
  assert.ok(
    problems.some((p) => p.includes(victim)),
    `删掉 shakedown 的 ${victim} 必须判红并点名，实际：${JSON.stringify(problems)}`,
  );
});

test("g-629 反向变异②：把上层改成与下层相等 ⇒ 不是真子集必红", () => {
  const { problems } = fresh(null, ({ manifest }) => {
    // 清空 integration 的本层新增 ⇒ integration ≡ shakedown
    manifest.tiers.integration.files = [];
  });
  assert.ok(
    problems.some((p) => p.includes("shakedown") && p.includes("integration") && p.includes("真子集")),
    `integration ≡ shakedown 必须判红「不是真子集」，实际：${JSON.stringify(problems)}`,
  );
});

test("g-629 反向变异③：磁盘新增未分类测试文件 ⇒ fail-closed 判红并点名", () => {
  const mutantName = "g629-unclassified-new.test.ts";
  // **真读**：在 gitignored 的 tmp/ 私有副本里真写一个文件，再用 readdir 真读回来（不留死代码准备）。
  const base = join(repoRoot, "tmp");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, "g629-mutant-"));
  try {
    mkdirSync(join(dir, TESTS_DIR_REL), { recursive: true });
    writeFileSync(join(dir, TESTS_DIR_REL, mutantName), "// g-629 变异对照用的未分类占位文件\n", "utf8");
    const readBack = readdirSync(join(dir, TESTS_DIR_REL)).filter((n) => n.endsWith(TEST_SUFFIX));
    assert.deepEqual(readBack, [mutantName], "变异目录必须真被读取（禁止写了不读的死代码）");
    const { problems } = fresh(null, (ctx) => {
      ctx.disk = [...ctx.disk, mutantName].sort();
    });
    assert.ok(
      problems.some((p) => p.includes("未分类") && p.includes(mutantName)),
      `磁盘新增未分类文件必须 fail-closed 判红并点名，实际：${JSON.stringify(problems)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-629 反向变异④：把家族文件移出日常层 ⇒ 判红并点名", () => {
  const victim = "g415-gate-hardening.test.ts";
  const { problems } = fresh(null, ({ manifest }) => {
    // 把它从 shakedown 挪到 full 的「本层新增」（日常层不再覆盖门禁家族）
    manifest.tiers.shakedown.files = manifest.tiers.shakedown.files.filter((f) => f !== victim);
    manifest.tiers.full.files = [...manifest.tiers.full.files, victim];
  });
  assert.ok(
    problems.some((p) => p.includes("门禁防伪绿") && p.includes(victim)),
    `家族文件移出日常层必须判红并点名，实际：${JSON.stringify(problems)}`,
  );
});

test("g-629 反向变异⑤：专题集合为空 ⇒ 判红", () => {
  const emptyAll = fresh(null, ({ manifest }) => {
    manifest.focused.topics = {};
  });
  assert.ok(
    emptyAll.problems.some((p) => p.includes("专题集合为空")),
    `专题集合为空必须判红，实际：${JSON.stringify(emptyAll.problems)}`,
  );
  const emptyOne = fresh(null, ({ manifest }) => {
    manifest.focused.topics["gate-integrity"].files = [];
  });
  assert.ok(
    emptyOne.problems.some((p) => p.includes("focused/gate-integrity") && p.includes("为空")),
    `单个专题清空必须判红并点名，实际：${JSON.stringify(emptyOne.problems)}`,
  );
});

test("g-629 反向变异⑥：把 focused 当层级用（层级 include focused / 放进 tiers）⇒ 判红", () => {
  const asInclude = fresh(null, ({ manifest }) => {
    manifest.tiers.shakedown.include = ["focused"];
  });
  assert.ok(
    asInclude.problems.some((p) => p.includes("include 了 focused")),
    `层级 include focused 必须判红，实际：${JSON.stringify(asInclude.problems)}`,
  );
  const asTier = fresh(null, ({ manifest }) => {
    manifest.tiers.focused = { description: "把专题误做成层级", include: [], files: [] };
  });
  assert.ok(
    asTier.problems.some((p) => p.includes("focused 出现在 tiers")),
    `focused 出现在 tiers 必须判红，实际：${JSON.stringify(asTier.problems)}`,
  );
});

test("g-629 反向变异⑦：把家族文件下放到 microTests ⇒ 判红", () => {
  const victim = "g507-http-auth-guard.test.ts";
  const { problems } = fresh(null, ({ manifest }) => {
    manifest.tiers.shakedown.files = manifest.tiers.shakedown.files.filter((f) => f !== victim);
    manifest.microTests.files = [...manifest.microTests.files, { file: victim, why: "变异对照：把安全家族下放" }];
  });
  assert.ok(
    problems.some((p) => p.includes(victim) && (p.includes("microTests") || p.includes("日常层"))),
    `安全家族下放 microTests 必须判红并点名，实际：${JSON.stringify(problems)}`,
  );
});

// ── 入口 / 闸门契约（真实源码断言）──────────────────────────────────────────

test("g-629 入口/闸门契约：分层入口只展开集合、不改闸门 glob 与无参行为", () => {
  const gate = readFileSync(join(repoRoot, "scripts", "run-tests.mjs"), "utf8");
  assert.equal(
    /const TEST_GLOB = "([^"]+)"/.exec(gate)?.[1],
    "core/tests/*.test.ts",
    "run-tests.mjs 的 TEST_GLOB 字面量必须逐字不变（g-629 不得改动发布门禁入口）",
  );
  const entry = readFileSync(join(repoRoot, ENTRY_REL), "utf8");
  // ① 入口必须把显式文件路径交给 run-tests.mjs
  assert.match(entry, /spawn\(\s*process\.execPath\s*,\s*\[\s*GATE\b/, "入口必须以显式路径 spawn scripts/run-tests.mjs");
  // ② 入口**不得复制**闸门的判定逻辑（不出现这些判定符号）
  for (const forbidden of [
    "parseEventChannel",
    "test-reporter-events",
    "assertNestedSuiteRan",
    "nestedSuitePassProblems",
    "coverageProblems",
    "findTestSelectionOption",
    "cleanTestEnv",
  ]) {
    assert.ok(
      !entry.includes(forbidden),
      `分层入口不得复制闸门逻辑（出现 ${forbidden}）⇒ 判定必须全部继承 run-tests.mjs`,
    );
  }
  // ③ 入口自身防空集（不依赖下游 exit 2）
  assert.match(entry, /files\.length === 0/, "入口必须自己判空集失败");
  // ④ 入口必须支持专题选择与全专题选择
  assert.match(entry, /FOCUSED_PREFIX/, "入口必须支持 focused/<专题> 选择");
});

test("g-629 入口负向对照：未知层 / 未知专题 ⇒ 真实进程 exit 2（不跑任何判定）", () => {
  const run = (args) =>
    spawnSync(process.execPath, [join(repoRoot, ENTRY_REL), ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      env: process.env,
    });
  const unknownTier = run(["no-such-tier"]);
  assert.equal(unknownTier.status, 2, `未知层必须 exit 2，实际 ${unknownTier.status}`);
  assert.match(unknownTier.stderr, /未知层级/, "未知层必须点名原因");
  const unknownTopic = run(["focused/no-such-topic"]);
  assert.equal(unknownTopic.status, 2, `未知专题必须 exit 2，实际 ${unknownTopic.status}`);
  assert.match(unknownTopic.stderr, /未知专题/, "未知专题必须点名原因，并列出已有专题");
  // 注：full 覆盖磁盘全集 ⇒ 层 ∩ 标签**本就不可能为空**（这正是「full ∪ micro = 磁盘」的推论），
  // 故空集合只能用「专题清空 / 层被清空」这类清单侧变异验证（见变异⑤与下面的静态断言）。
  const emptyGuard = readFileSync(join(repoRoot, ENTRY_REL), "utf8");
  assert.match(emptyGuard, /集合为空/, "入口必须有**自身**的空集合判红分支（不得只靠 run-tests 的 exit 2）");
});
