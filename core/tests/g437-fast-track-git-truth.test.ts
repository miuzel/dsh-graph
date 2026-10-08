/**
 * g-437：门禁③「证据真源化」——四项门禁的**证据分层**与**报告↔Git 真源对账**。
 *
 * 被修的两条不实/不一致表述（本文件用真实文件断言钉住）：
 *  - 工具描述与指南把四项门禁一律说成「由引擎自算」——其实 ① tests / ② typecheck 是**调用方证据**，
 *    引擎**不复跑**；
 *  - ③ 变更规模原样采信调用方自报的 `product_changed_lines` / `untracked_files` /
 *    `changed_paths`（只要自报 < 150 且 0 未跟踪即可放行）——现在由引擎在**本次 attempt 的实际
 *    工作树**上自算真源，并与报告**逐项对账**，不一致即拒绝。
 *
 * 断言分层：
 *  - 纯解码器（`parseNumstatZ` / `parsePorcelainZ` / `summarizeProductLinesStrict`）：
 *    `-z` 输出按 NUL 解析、rename 旧新两条路径、二进制非数字列**不得静默计 0**；
 *  - 有效配置单一默认点（与 g-435 的排除前缀、契约路径**同一份**，不引入第二套默认/分类器）；
 *  - `collectAttemptGitTruth` 的绑定语义（隔离树 / 非隔离 / 缺失即拒绝不回退 / 未提交 tracked 改动）；
 *  - `resolveAccept(fast_track=true)` 端到端：正例、篡改、边界、归属、fail-safe、零副作用；
 *  - 文档/工具描述如实（zh/en 一致）；缺省 accept / object / force 路径逐字不变。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createGoal,
  findGoalFile,
  init,
  loadGoal,
  readProjectConfig,
  resolveAccept,
  saveGoal,
  setCriteria,
  collectAttemptGitTruth,
} from "../ops.ts";
import { appendEvent, readEvents } from "../events.ts";
import {
  DEFAULT_CONTRACT_PATHS,
  DEFAULT_NON_PRODUCT_PREFIXES,
  DEFAULT_REVIEW_REGIONS,
  FAST_TRACK_MAX_PRODUCT_LINES,
  effectiveContractPathsOf,
  effectiveNonProductPrefixesOf,
  effectiveReviewListValue,
  effectiveReviewRegionsOf,
  isContractPath,
  isMalformedConfigList,
  isProductCodePath,
  normalizeMachineReport,
  parseNumstatZ,
  parsePorcelainZ,
  reconcileMachineReportWithGitTruth,
  regionOfPath,
  regionsOfPaths,
  resolveReviewPolicy,
  summarizeProductLinesStrict,
} from "../review-policy.ts";
import { GraphError } from "../machine.ts";
import { makeFastTrackFixture } from "./fixtures/fast-track-fixture.ts";

const repoRoot = join(import.meta.dirname, "../..");

/** 指南原文（P2 口径守卫用）。 */
const guideZhText = () => readFileSync(join(repoRoot, "dsh-graph-host/supervisor-guide.zh.md"), "utf8");
const guideEnText = () => readFileSync(join(repoRoot, "dsh-graph-host/supervisor-guide.en.md"), "utf8");

/** 期望拒绝且**零副作用**：状态不变、无 review.passed / review.fast_track、事件数不变。 */
function assertRejectedWithNoSideEffects(
  run: () => unknown,
  fixture: { root: string; goal: string; file: string },
  pattern: RegExp,
  label: string,
) {
  const before = readEvents(fixture.root).length;
  assert.throws(
    run,
    (e: unknown) => e instanceof GraphError && pattern.test((e as Error).message),
    `${label}：必须以 GraphError 拒绝并匹配 ${pattern}`,
  );
  const events = readEvents(fixture.root);
  assert.equal(String(loadGoal(fixture.file).meta.status ?? ""), "review", `${label}：状态必须不变`);
  assert.equal(
    events.filter((e) => e.goal === fixture.goal && e.event === "review.fast_track").length,
    0,
    `${label}：不得出现 review.fast_track`,
  );
  assert.equal(
    events.filter((e) => e.goal === fixture.goal && e.event === "review.passed").length,
    0,
    `${label}：不得出现 review.passed`,
  );
  assert.equal(events.length, before, `${label}：零副作用（事件数不变）`);
}

// ---------------------------------------------------------------------------
// 1. 纯解码器：`-z` 输出必须按 NUL 解析
// ---------------------------------------------------------------------------

test("g-437 判据 1：parseNumstatZ 按 NUL 解析——rename 两条路径、制表符/空格/非 ASCII 路径原样、不可解析即 malformed", () => {
  // 普通记录 + 含空格/非 ASCII 的路径（`-z` 不做引号化，路径原样）
  const plain = parseNumstatZ("3\t1\tscripts/a b.ts\u00002\t0\tdir/带 空格/名.ts\u0000");
  assert.equal(plain.malformed.length, 0);
  assert.deepEqual(plain.entries.map((e) => e.paths), [["scripts/a b.ts"], ["dir/带 空格/名.ts"]]);
  assert.deepEqual(plain.entries.map((e) => [e.added, e.deleted]), [[3, 1], [2, 0]]);

  // 路径本身含制表符：第 3 列起原样拼接（不得按 \t 截断）
  const tabbed = parseNumstatZ("1\t2\tweird\tname.ts\u0000");
  assert.deepEqual(tabbed.entries[0].paths, ["weird\tname.ts"]);

  // 前导空格必须保留（绝不 trim）
  const leading = parseNumstatZ("1\t2\t  leading.ts\u0000");
  assert.deepEqual(leading.entries[0].paths, ["  leading.ts"]);

  // rename/copy：`<added>\t<deleted>\t\0<old>\0<new>\0` ⇒ 旧新两条路径，且**不是**两个记录
  const renamed = parseNumstatZ("5\t5\t\u0000scripts/old.ts\u0000scripts/new.ts\u0000");
  assert.equal(renamed.malformed.length, 0);
  assert.equal(renamed.entries.length, 1, "rename 必须是一条记录（两条路径），不是两条记录");
  assert.deepEqual(renamed.entries[0].paths, ["scripts/old.ts", "scripts/new.ts"]);

  // 二进制：数字列是非数字（`-`）——解析得出记录，但列值为 null（绝不当作 0）
  const binary = parseNumstatZ("-\t-\tblob.bin\u0000");
  assert.deepEqual(binary.entries, [{ added: null, deleted: null, paths: ["blob.bin"] }]);

  // 字段不足 / rename 缺路径 ⇒ malformed（不静默丢弃、也不猜值）
  assert.ok(parseNumstatZ("1\t2\u0000").malformed.length > 0);
  assert.equal(parseNumstatZ("1\t2\u0000").entries.length, 0);
  const brokenRename = parseNumstatZ("1\t1\t\u0000only-old.ts\u0000");
  assert.ok(brokenRename.malformed.length > 0, "rename 缺新路径必须 malformed");
  assert.equal(brokenRename.entries.length, 0);

  // 空输出 ⇒ 无记录、无 malformed（不是错误）
  assert.deepEqual(parseNumstatZ(""), { entries: [], malformed: [] });
});

test("g-437 判据 1：parsePorcelainZ 按 NUL 解析——rename 的第二条路径不得变成独立状态记录", () => {
  const simple = parsePorcelainZ("?? scratch/a.txt\u0000 M scripts/run.sh\u0000");
  assert.equal(simple.malformed.length, 0);
  assert.deepEqual(simple.entries.map((e) => [e.status, e.paths]), [
    ["??", ["scratch/a.txt"]],
    [" M", ["scripts/run.sh"]],
  ]);

  // rename：`R  <new>\0<old>\0`（git 的 -z 顺序是「新」在前）
  const renamed = parsePorcelainZ("R  scripts/new.ts\u0000scripts/old.ts\u0000?? user.txt\u0000");
  assert.equal(renamed.malformed.length, 0);
  assert.equal(renamed.entries.length, 2, "rename 的第二条路径不得成为独立记录");
  assert.deepEqual(renamed.entries[0], { status: "R ", paths: ["scripts/new.ts", "scripts/old.ts"] });
  assert.deepEqual(renamed.entries[1], { status: "??", paths: ["user.txt"] });

  // 含空格路径原样；形态非法 ⇒ malformed
  assert.deepEqual(parsePorcelainZ("?? scratch b.txt\u0000").entries[0].paths, ["scratch b.txt"]);
  assert.ok(parsePorcelainZ("XY\u0000").malformed.length > 0);
  assert.ok(parsePorcelainZ("M\tpath\u0000").malformed.length > 0, "第 3 个字符必须是空格");
  assert.ok(parsePorcelainZ("R  new.ts\u0000").malformed.length > 0, "rename 缺原路径必须 malformed");
});

test("g-437 判据 1：非数字 numstat 列（二进制）不得静默计 0——严格口径下即 malformed", () => {
  const strict = summarizeProductLinesStrict(parseNumstatZ("-\t-\tblob.bin\u0000").entries, null);
  assert.equal(strict.lines, 0);
  assert.ok(strict.malformed.length > 0, "二进制不得当作 0 行放行");
  assert.deepEqual(strict.files, ["blob.bin"], "文件仍如实列出（不静默丢弃）");

  // rename：分类看旧新两条路径，行数按记录只计一次
  const renamed = summarizeProductLinesStrict(
    parseNumstatZ("4\t4\t\u0000scripts/old.ts\u0000scripts/new.ts\u0000").entries,
    null,
  );
  assert.equal(renamed.lines, 8, "一条 rename 记录只计一次（不因两条路径翻倍）");
  assert.deepEqual(renamed.files, ["scripts/old.ts", "scripts/new.ts"], "两条路径都参与分类");
});

// ---------------------------------------------------------------------------
// 2. 有效配置：单一默认点（与 g-435 排除前缀、契约路径同源）
// ---------------------------------------------------------------------------

test("g-437 判据 5：有效配置是单一默认点——resolveReviewPolicy 与真源分类取同一份列表", () => {
  // 未配置（null/undefined）⇒ **值**等于默认常量（g-442 合入后本体委托 `resolveReviewListInput`，
  // 它每次返回副本，故这里断言值等价而不再断言同一引用——委托不得因此丢掉默认语义）。
  assert.deepEqual(effectiveContractPathsOf(undefined), [...DEFAULT_CONTRACT_PATHS]);
  assert.deepEqual(effectiveContractPathsOf(null), [...DEFAULT_CONTRACT_PATHS]);
  assert.deepEqual(effectiveReviewRegionsOf(undefined), [...DEFAULT_REVIEW_REGIONS]);
  assert.deepEqual(effectiveNonProductPrefixesOf(undefined), [...DEFAULT_NON_PRODUCT_PREFIXES]);
  // 合法数组原样透传；非法标量（被读成字符串/数字等）⇒ 空列表（安全侧：不靠默认豁免）
  assert.deepEqual(effectiveNonProductPrefixesOf(["vendored"]), ["vendored"]);
  assert.deepEqual(effectiveNonProductPrefixesOf("dist"), []);
  assert.deepEqual(effectiveReviewRegionsOf(7), []);
  assert.deepEqual(effectiveContractPathsOf("core/schema.ts"), []);

  // 显式传入默认值 ⇒ 判定与「未配置」逐字一致（证明 resolveReviewPolicy 用的就是同一份默认）
  const implicit = resolveReviewPolicy({ policy: "auto", type: "patch" });
  const explicit = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    regions: [...DEFAULT_REVIEW_REGIONS],
    contractPaths: [...DEFAULT_CONTRACT_PATHS],
    nonProductPrefixes: [...DEFAULT_NON_PRODUCT_PREFIXES],
  });
  assert.deepEqual(explicit, implicit);
});

// ---------------------------------------------------------------------------
// 1b. g-442 协同：三项列表的「有效值 / 畸形」必须与引擎实际消费**同一口径**
//     （投影、策略解析、门禁③分类只允许一条归一化 + 一个谓词）
// ---------------------------------------------------------------------------

/** 15 组原始值：合法 / 未配置 / 标量 / 映射 / 合法数组但内容畸形（空串、尾斜杠、父段、重复、绝对路径）。 */
const REVIEW_LIST_INPUTS: ReadonlyArray<readonly [string, unknown]> = [
  ["undefined（未配置）", undefined],
  ["null（未配置）", null],
  ["[]（显式空）", []],
  ["['core/tests']（合法）", ["core/tests"]],
  ["123（标量）", 123],
  ["[123]（数字元素）", [123]],
  ["{a:1}（映射）", { a: 1 }],
  ["'core/tests'（整串标量）", "core/tests"],
  ["['']（空串元素）", [""]],
  ["['core/']（尾斜杠）", ["core/"]],
  ["['../core']（父段）", ["../core"]],
  ["['core','core']（重复）", ["core", "core"]],
  ["['./core']（点斜杠前缀）", ["./core"]],
  ["['/abs/path']（绝对路径）", ["/abs/path"]],
  ["['C:\\\\x']（Windows 绝对）", ["C:\\x"]],
];

test("g-437 判据 5：有效值 = 引擎实际消费值——15 输入 × 3 字段行为探针（g-442 投影须据此对齐）", () => {
  for (const [label, raw] of REVIEW_LIST_INPUTS) {
    // ① 契约路径：引擎的 M1 命中与否，必须等于「用有效值直接匹配」的结果
    const m1 = resolveReviewPolicy({
      contractPaths: raw,
      regions: ["core", "schema"],
      changedPaths: ["core/schema.ts", "schema/SCHEMA.md", "src/a.ts"],
    }).strictReasons.includes("contract_change");
    const m1Expected = ["core/schema.ts", "schema/SCHEMA.md"]
      .some((p) => isContractPath(p, effectiveContractPathsOf(raw)));
    assert.equal(m1, m1Expected, `contract_paths ${label}：引擎 M1 判定与有效值不一致`);

    // ② 区域：引擎的 unknown_region（= regionOfPath 为空）必须等于「用有效值算区域」的结果
    const registered = !resolveReviewPolicy({
      regions: raw,
      contractPaths: [],
      nonProductPrefixes: [],
      changedPaths: ["src/a.ts"],
    }).strictReasons.includes("unknown_region");
    assert.equal(
      registered,
      regionOfPath("src/a.ts", effectiveReviewRegionsOf(raw)) !== null,
      `regions ${label}：引擎区域判定与有效值不一致`,
    );

    // ③ 排除前缀：引擎是否把 dist/bundle.js 当产品码，必须等于「用有效值判产品码」的结果
    const asProduct = resolveReviewPolicy({
      regions: ["src"],
      contractPaths: [],
      nonProductPrefixes: raw,
      changedPaths: ["dist/bundle.js"],
    }).strictReasons.includes("unknown_region");
    assert.equal(
      asProduct,
      isProductCodePath("dist/bundle.js", effectiveNonProductPrefixesOf(raw)),
      `non_product_prefixes ${label}：引擎产品码判定与有效值不一致`,
    );

    // ④ 三字段的有效值本身 + 键控分发同值（g-442 投影的唯一入口）
    assert.deepEqual(effectiveReviewListValue("regions", raw), [...effectiveReviewRegionsOf(raw)]);
    assert.deepEqual(effectiveReviewListValue("contract_paths", raw), [...effectiveContractPathsOf(raw)]);
    assert.deepEqual(effectiveReviewListValue("non_product_prefixes", raw), [...effectiveNonProductPrefixesOf(raw)]);
  }
});

test("g-437 判据 5：畸形口径唯一——isMalformedConfigList 只看原始值（含合法数组但内容畸形）", () => {
  for (const [label, raw] of REVIEW_LIST_INPUTS) {
    // 策略层的 fail-closed 升级口（policy_unrecognized）必须**恰好**等于该谓词
    const viaEngine = resolveReviewPolicy({ policy: null, regions: raw })
      .strictReasons.includes("policy_unrecognized");
    assert.equal(viaEngine, isMalformedConfigList(raw, false), `${label}：畸形判定与引擎升级口不一致`);
  }
  // 钉住「合法数组但内容畸形」这一类（g-442 旧投影漏判的正是这一类）
  for (const bad of [[""], ["core/"], ["../core"], ["core", "core"], [123], ["/abs/path"], ["C:\\x"]]) {
    assert.equal(isMalformedConfigList(bad), true, `${JSON.stringify(bad)} 必须判为畸形`);
  }
  // 反例：`./core` 会被归一化后再比重复，单元素合法；合法数组与未配置都**不是**畸形
  assert.equal(isMalformedConfigList(["./core"]), false, "['./core'] 合法，不得误判畸形");
  assert.equal(isMalformedConfigList(["core/tests"]), false);
  assert.equal(isMalformedConfigList([]), false);
  assert.equal(isMalformedConfigList(null), false);
  assert.equal(isMalformedConfigList(undefined), false);
  // 未配置 ⇒ 有效值**值等于**默认常量；畸形标量 ⇒ 空列表（不是默认！绝不套默认放行）
  assert.deepEqual(effectiveReviewRegionsOf(undefined), [...DEFAULT_REVIEW_REGIONS]);
  assert.deepEqual(effectiveReviewRegionsOf(123), []);
  assert.deepEqual(effectiveNonProductPrefixesOf("dist"), []);
  assert.deepEqual(effectiveContractPathsOf({ a: 1 }), []);
});

test("g-437 判据 5：归一化收敛到单点——regionOfPath/regionsOfPaths/isProductCodePath 不再内联第二份默认", () => {
  const src = readFileSync(join(repoRoot, "core/review-policy.ts"), "utf8");
  const body = (name: string) => {
    const start = src.indexOf(`export function ${name}(`);
    assert.ok(start >= 0, `未找到 ${name}`);
    const next = src.indexOf("\nexport function ", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  };
  // 三个消费点都必须委派给 effective*Of（源码级守卫：禁止再写「数组/未配置/其它」三分支）
  // 只看代码（注释里可以提到默认常量名，但那不是第二份实现）
  const code = (name: string) => body(name).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.match(body("regionOfPath"), /effectiveReviewRegionsOf\(/, "regionOfPath 必须委派单一归一化");
  assert.match(body("regionsOfPaths"), /effectiveReviewRegionsOf\(/, "regionsOfPaths 必须委派单一归一化");
  assert.match(body("isProductCodePath"), /effectiveNonProductPrefixesOf\(/, "isProductCodePath 必须委派单一归一化");
  assert.match(body("isContractPath"), /effectiveContractPathsOf\(/, "isContractPath 必须委派单一归一化");
  for (const fn of ["regionOfPath", "regionsOfPaths", "isProductCodePath", "isContractPath"]) {
    assert.doesNotMatch(code(fn), /DEFAULT_(REVIEW_REGIONS|NON_PRODUCT_PREFIXES)/, `${fn} 不得内联默认列表`);
    assert.doesNotMatch(code(fn), /configuredRegions === null/, `${fn} 不得内联三分支归一化`);
    assert.doesNotMatch(code(fn), /contractPaths !== undefined && contractPaths !== null/, `${fn} 不得内联三分支归一化`);
    assert.doesNotMatch(code(fn), /DEFAULT_CONTRACT_PATHS/, `${fn} 不得内联默认列表`);
  }
  // g-442 合入后的**委托结构**：三个 effective*Of 本体只允许一行委托，不得再自持归一化/默认值
  for (const fn of ["effectiveContractPathsOf", "effectiveReviewRegionsOf", "effectiveNonProductPrefixesOf"]) {
    assert.match(code(fn), /resolveReviewListInput\(/, `${fn} 必须委托 g-442 的唯一归一化`);
    assert.doesNotMatch(code(fn), /Array\.isArray\(|DEFAULT_|\bif \(/, `${fn} 委托后不得再自持任何逻辑/默认值`);
  }
  assert.match(
    src,
    /const REVIEW_LIST_SPEC[^;]*REVIEW_LIST_FIELDS\.map/s,
    "字段→SPEC 必须取自 g-442 的 REVIEW_LIST_FIELDS 表（不得另抄一份默认值表）",
  );
  assert.equal((src.match(/export function isMalformedConfigList\(/g) ?? []).length, 1, "畸形谓词必须唯一（不得出现第二份）");
  // 行为面：非法标量不再抛 TypeError（旧实现 `prefixes.some is not a function`），一律按空列表
  for (const bad of [123, { a: 1 }, "core/tests"] as unknown[]) {
    assert.equal(isProductCodePath("dist/bundle.js", bad as never), true, "非法前缀（无豁免）不得抛错");
    assert.deepEqual(regionsOfPaths(["src/a.ts"], bad as never), []);
    assert.equal(regionOfPath("src/a.ts", bad as never), null);
    assert.equal(isContractPath("core/schema.ts", bad as never), false, "非法契约路径列表不得抛错（空列表匹配不到）");
  }
  // 幂等：把有效值再喂回去，**分类类**判定不变（证明「引擎按有效值分类」）。
  // 只比 contract_change / product_size / unknown_region / declared_strict —— `policy_unrecognized`
  // 是**原始值**的畸形标记，`cross_region` 还含「显式 regions: [] ⇒ fail-closed」这条**原始值**规则
  // （`[]` 作为有效值回喂时会额外触发该规则），两者都不属于「按有效值分类」的口径，故排除。
  const pick = (d: ReturnType<typeof resolveReviewPolicy>) =>
    d.strictReasons.filter((r) => ["contract_change", "product_size", "unknown_region", "declared_strict"].includes(r));
  for (const [label, raw] of REVIEW_LIST_INPUTS) {
    const eff = { regions: effectiveReviewRegionsOf(raw), contractPaths: effectiveContractPathsOf(raw), nonProductPrefixes: effectiveNonProductPrefixesOf(raw) };
    assert.deepEqual(
      pick(resolveReviewPolicy({ regions: raw, contractPaths: raw, nonProductPrefixes: raw, changedPaths: ["src/a.ts", "dist/x.js"] })),
      pick(resolveReviewPolicy({ regions: eff.regions, contractPaths: eff.contractPaths, nonProductPrefixes: eff.nonProductPrefixes, changedPaths: ["src/a.ts", "dist/x.js"] })),
      `${label}：以有效值再跑一遍，分类判定必须不变`,
    );
  }
});

test("g-437 判据 5：对账为集合相等——漏报/多报路径、行数、未跟踪数逐项报错", () => {
  const truth = { changed_paths: ["scripts/a.ts", "scripts/b.ts"], product_changed_lines: 7, untracked_files: 0 };
  const evidence = (over: Record<string, unknown>) =>
    normalizeMachineReport({
      baseline_commit: "abc",
      changed_paths: ["scripts/a.ts", "scripts/b.ts"],
      product_changed_lines: 7,
      untracked_files: 0,
      tests: { exit_code: 0, fail: 0 },
      typecheck: { exit_code: 0 },
      ...over,
    });

  assert.deepEqual(reconcileMachineReportWithGitTruth(evidence({}), truth), [], "一致时零问题");
  const missing = reconcileMachineReportWithGitTruth(evidence({ changed_paths: ["scripts/a.ts"] }), truth);
  assert.equal(missing.length, 1);
  assert.match(missing[0], /漏报：scripts\/b\.ts/);
  const extra = reconcileMachineReportWithGitTruth(evidence({ changed_paths: ["scripts/a.ts", "scripts/b.ts", "x.ts"] }), truth);
  assert.match(extra[0], /多报：x\.ts/);
  assert.match(
    reconcileMachineReportWithGitTruth(evidence({ product_changed_lines: 8 }), truth)[0],
    /product_changed_lines 与 Git 真源不一致（引擎 7 \/ 报告 8）/,
  );
  assert.match(
    reconcileMachineReportWithGitTruth(evidence({ untracked_files: 3 }), truth)[0],
    /untracked_files 与 Git 真源不一致（引擎 0 \/ 报告 3）/,
  );
  // 路径归一化（`./` 前缀）不应造成假分歧
  assert.deepEqual(
    reconcileMachineReportWithGitTruth(evidence({ changed_paths: ["./scripts/a.ts", "scripts/b.ts"] }), truth),
    [],
  );
});

// ---------------------------------------------------------------------------
// 3. collectAttemptGitTruth：绑定语义（真 Git）
// ---------------------------------------------------------------------------

test("g-437 判据 3：绑定实际 attempt 工作树——真源取自隔离树，含 worktree 列表实时注册校验", () => {
  const f = makeFastTrackFixture();
  try {
    const r = collectAttemptGitTruth({
      workspaceDir: dirname(f.root),
      graphRoot: f.root,
      attemptWorktree: { path: f.tree },
      baseline: f.baseline,
      attemptBaseline: f.baseline,
    });
    assert.equal(r.ok, true, r.ok ? "" : r.reason);
    if (!r.ok) return;
    assert.equal(r.truth.tree.path, f.tree);
    assert.equal(r.truth.tree.toplevel, f.tree, "porcelain/numstat 路径锚点为仓库根");
    assert.equal(r.truth.tree.isolation, "isolated_worktree");
    assert.equal(r.truth.baseline_resolved, f.baseline);
    assert.equal(r.truth.head, f.head);
    assert.deepEqual(r.truth.changed_paths, f.changedPaths);
    assert.equal(r.truth.product_changed_lines, f.productLines);
    assert.equal(r.truth.untracked_files, 0);
  } finally {
    f.dispose();
  }
});

test("g-437 判据 3：attempt 记录形态未知（既非含 path 的对象也不是 false）⇒ 拒绝，不猜执行树", () => {
  const f = makeFastTrackFixture();
  try {
    for (const bad of [undefined, {}, { path: "" }, { path: 123 }, true, "tree"]) {
      const r = collectAttemptGitTruth({
        workspaceDir: dirname(f.root),
        graphRoot: f.root,
        attemptWorktree: bad,
        baseline: f.baseline,
      });
      assert.equal(r.ok, false, `形态 ${JSON.stringify(bad)} 必须拒绝`);
      if (!r.ok) assert.match(r.reason, /拒绝猜测|缺少可绑定的执行树证据/);
    }
  } finally {
    f.dispose();
  }
});

test("g-437 判据 3：Git 运行失败 ⇒ fail-safe 拒绝（不抛出、不放行）", () => {
  const f = makeFastTrackFixture();
  try {
    const boom = () => {
      throw new Error("git: command not found (injected)");
    };
    const r = collectAttemptGitTruth({
      workspaceDir: dirname(f.root),
      graphRoot: f.root,
      attemptWorktree: { path: f.tree },
      baseline: f.baseline,
      runner: boom,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /Git worktree 列表不可用/);
  } finally {
    f.dispose();
  }
});

// ---------------------------------------------------------------------------
// 4. resolveAccept(fast_track=true)：端到端
// ---------------------------------------------------------------------------

test("g-437 判据 2/6：报告与真源逐项一致 ⇒ 放行，且事件如实标注证据分层、① ② 留痕与 Git 真源", () => {
  const f = makeFastTrackFixture({ type: "patch" });
  try {
    const r = resolveAccept(f.root, f.goal, {
      actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report(),
    });
    assert.deepEqual(r, { ok: true, fast_track: true });

    const ft = readEvents(f.root).filter((e) => e.event === "review.fast_track");
    assert.equal(ft.length, 1);
    const d = ft[0].details as Record<string, any>;

    // 证据分层：① ② 调用方证据；③ ④ 引擎自算（如实，不再一律声称「引擎自算」）
    assert.deepEqual(d.gate_sources, {
      tests: "caller_reported",
      typecheck: "caller_reported",
      diff_size: "engine_git",
      criteria_verified: "engine_computed",
    });
    // ① ② 的调用方留痕（命令原文 + 采集时间 + 来源）原样入事件
    assert.deepEqual(d.caller_evidence, {
      tests: { command: "fixture command", collected_at: "2026-01-01T00:00:00.000Z", source: "fixture:executor" },
      typecheck: { command: "fixture command", collected_at: "2026-01-01T00:00:00.000Z", source: "fixture:executor" },
    });
    // ③ 的引擎 Git 真源（绑定到哪棵树、哪个 HEAD、采到了什么）
    assert.equal(d.git_truth.tree.path, f.tree);
    assert.equal(d.git_truth.tree.isolation, "isolated_worktree");
    assert.equal(d.git_truth.baseline_commit, f.baseline);
    assert.equal(d.git_truth.baseline_resolved, f.baseline);
    assert.equal(d.git_truth.head, f.head);
    assert.deepEqual(d.git_truth.changed_paths, f.changedPaths);
    assert.equal(d.git_truth.product_changed_lines, f.productLines);
    assert.equal(d.git_truth.untracked_files, 0);
    // 既有键保持不变（向后兼容：baseline / checks / evidence）
    assert.equal(d.baseline, f.baseline);
    assert.deepEqual(d.checks, { tests: true, typecheck: true, diff_size: true, criteria_verified: true });
    assert.equal(d.evidence.product_changed_lines, f.productLines);
  } finally {
    f.dispose();
  }
});

test("g-437 判据 2：篡改 product_changed_lines / untracked_files / changed_paths 一律拒绝且零副作用", () => {
  const tampers: Array<[string, (rep: Record<string, any>) => Record<string, unknown>]> = [
    ["product_changed_lines 归零", () => ({ product_changed_lines: 0 })],
    ["product_changed_lines 低报", (rep) => ({ product_changed_lines: Math.max(0, rep.product_changed_lines - 1) })],
    ["untracked_files 谎报 0", () => ({ untracked_files: 0 })],
    ["changed_paths 漏报", () => ({ changed_paths: [] })],
    ["changed_paths 多报", (rep) => ({ changed_paths: [...rep.changed_paths, "scripts/ghost.ts"] })],
  ];
  for (const [label, mutate] of tampers) {
    const f = makeFastTrackFixture({ type: "patch", untracked: ["scratch/user.txt"] });
    try {
      const rep = f.report(mutate(f.report() as Record<string, any>));
      assertRejectedWithNoSideEffects(
        () => resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: rep }),
        f,
        /机器报告与 Git 真源不一致/,
        label,
      );
    } finally {
      f.dispose();
    }
  }
});

test("g-437 判据 2：未提交的 tracked 改动（staged / unstaged / deleted）一律拒绝", () => {
  const cases: Array<[string, (f: ReturnType<typeof makeFastTrackFixture>) => void]> = [
    ["unstaged 修改", (f) => writeFileSync(join(f.tree, "scripts", "run.sh"), "echo dirty\n")],
    ["staged 新增", (f) => {
      writeFileSync(join(f.tree, "scripts", "staged.sh"), "echo staged\n");
      f.git(f.tree, ["add", "--", "scripts/staged.sh"]);
    }],
    ["deleted（未提交删除）", (f) => rmSync(join(f.tree, "scripts", "run.sh"), { force: true })],
  ];
  for (const [label, break_] of cases) {
    const f = makeFastTrackFixture({ type: "patch" });
    try {
      break_(f);
      assertRejectedWithNoSideEffects(
        () => resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report() }),
        f,
        /未提交的 tracked 改动/,
        label,
      );
    } finally {
      f.dispose();
    }
  }
});

test("g-437 判据 3：attempt 工作树缺失/已删/指向主树 ⇒ 拒绝，绝不回退主树", () => {
  // 主树上提交**内容完全相同**的改动：若引擎偷偷回退主树，报告就会「看起来一致」而放行。
  const build = () => {
    const f = makeFastTrackFixture({ type: "patch" });
    writeFileSync(
      join(f.repo, "scripts", "run.sh"),
      readFileSync(join(f.repo, "scripts", "run.sh"), "utf8") + "echo line-1\necho line-2\necho line-3\n",
    );
    f.git(f.repo, ["add", "--", "scripts/run.sh"]);
    f.git(f.repo, ["commit", "-q", "-m", "same content on main"]);
    return f;
  };

  // (a) 注册被移除（`git worktree remove --force`）
  const removed = build();
  try {
    removed.git(removed.repo, ["worktree", "remove", "--force", removed.tree]);
    assertRejectedWithNoSideEffects(
      () => resolveAccept(removed.root, removed.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: removed.report() }),
      removed,
      /工作树不存在或不可读/,
      "worktree removed",
    );
  } finally {
    removed.dispose();
  }

  // (b) 目录被直接删除
  const deleted = build();
  try {
    rmSync(deleted.tree, { recursive: true, force: true });
    assertRejectedWithNoSideEffects(
      () => resolveAccept(deleted.root, deleted.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: deleted.report() }),
      deleted,
      /工作树不存在或不可读/,
      "worktree dir deleted",
    );
  } finally {
    deleted.dispose();
  }

  // (c) 记录指向主工作树 ⇒ 明确拒绝（不得把主树当 attempt 树）
  const mainPointed = makeFastTrackFixture({ type: "patch" });
  try {
    const attFile = join(dirname(findGoalFile(mainPointed.root, mainPointed.goal)), "attempts", mainPointed.attempt, "attempt.md");
    const att = loadGoal(attFile);
    saveGoal(attFile, { meta: { ...att.meta, worktree: { path: mainPointed.repo } }, body: att.body });
    assertRejectedWithNoSideEffects(
      () => resolveAccept(mainPointed.root, mainPointed.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: mainPointed.report() }),
      mainPointed,
      /指向主工作树/,
      "worktree points at main",
    );
  } finally {
    mainPointed.dispose();
  }
});

test("g-437 判据 3：attempt 树与主树各自提交 ⇒ 只计 attempt 树", () => {
  const f = makeFastTrackFixture({ type: "patch" });
  try {
    // 主树上另有提交（不在 attempt 树的 baseline..HEAD 里）
    writeFileSync(join(f.repo, "scripts", "main-only.sh"), "echo main only\n");
    f.git(f.repo, ["add", "--", "scripts/main-only.sh"]);
    f.git(f.repo, ["commit", "-q", "-m", "main only"]);
    const mainHead = f.git(f.repo, ["rev-parse", "HEAD"]).trim();
    assert.notEqual(mainHead, f.head, "两棵树的 HEAD 必须不同，断言才有意义");

    // 报告只含 attempt 树 ⇒ 放行（引擎若用主树就会不一致）
    assert.deepEqual(
      resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report() }),
      { ok: true, fast_track: true },
    );
    const d = readEvents(f.root).filter((e) => e.event === "review.fast_track")[0].details as Record<string, any>;
    assert.equal(d.git_truth.head, f.head, "真源 HEAD 必须是 attempt 树的 HEAD");
    assert.ok(!d.git_truth.changed_paths.includes("scripts/main-only.sh"));
  } finally {
    f.dispose();
  }
});

test("g-437 判据 2：契约匹配看到 rename 的旧路径（M1 命中）；调用方隐藏该路径同样拒绝", () => {
  const opts = {
    renamed: [{ from: "core/schema.ts", to: "scripts/schema-renamed.ts" }],
    projectConfig: { review: { contract_paths: ["core/schema.ts"], regions: ["core", "scripts"] } },
  } as const;

  const f = makeFastTrackFixture(opts as any);
  try {
    // 真源集合必须含旧路径（契约匹配才看得到）
    assert.deepEqual(f.changedPaths, ["core/schema.ts", "scripts/schema-renamed.ts"]);
    assertRejectedWithNoSideEffects(
      () => resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report() }),
      f,
      /M1 变更路径含契约文件（core\/schema\.ts）/,
      "rename 旧路径命中契约",
    );
  } finally {
    f.dispose();
  }

  // 调用方只报新路径（隐藏旧路径）⇒ 对账即拒绝（M1 无法被报告面绕过）
  const hidden = makeFastTrackFixture(opts as any);
  try {
    assertRejectedWithNoSideEffects(
      () => resolveAccept(hidden.root, hidden.goal, {
        actor: "supervisor:test", verdict: "accept", fast_track: true,
        machine_report: hidden.report({ changed_paths: ["scripts/schema-renamed.ts"] }),
      }),
      hidden,
      /机器报告与 Git 真源不一致/,
      "隐藏 rename 旧路径",
    );
  } finally {
    hidden.dispose();
  }
});

test("g-437 判据 2：149/150 边界按**有效排除配置**判定（同一份配置，不是第二套默认）", () => {
  // 默认配置：scripts/* 计入产品码 ⇒ 149 放行、150 拒绝
  const under = makeFastTrackFixture({ type: "patch", changed: [{ path: "scripts/run.sh", lines: FAST_TRACK_MAX_PRODUCT_LINES - 1 }] });
  try {
    assert.equal(under.productLines, FAST_TRACK_MAX_PRODUCT_LINES - 1);
    assert.deepEqual(
      resolveAccept(under.root, under.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: under.report() }),
      { ok: true, fast_track: true },
      "恰好 149 行必须放行",
    );
  } finally {
    under.dispose();
  }

  const at = makeFastTrackFixture({ type: "patch", changed: [{ path: "scripts/run.sh", lines: FAST_TRACK_MAX_PRODUCT_LINES }] });
  try {
    assert.equal(at.productLines, FAST_TRACK_MAX_PRODUCT_LINES);
    assertRejectedWithNoSideEffects(
      () => resolveAccept(at.root, at.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: at.report() }),
      at,
      /M2 产品代码变更 ≥ 150 行/,
      "恰好 150 行必须拒绝",
    );
  } finally {
    at.dispose();
  }

  // 有效排除配置改了：`scripts` 被排除 ⇒ 真源 0 行（诚实报告按同一份配置算），149 行也不再阻断
  const excluded = makeFastTrackFixture({
    type: "patch",
    changed: [{ path: "scripts/run.sh", lines: FAST_TRACK_MAX_PRODUCT_LINES - 1 }],
    projectConfig: { review: { non_product_prefixes: ["scripts"] } },
    nonProductPrefixes: ["scripts"],
  });
  try {
    assert.equal(excluded.productLines, 0, "排除前缀必须被真源分类与报告同时采用");
    const cfg = readProjectConfig(excluded.root);
    assert.deepEqual(effectiveNonProductPrefixesOf(cfg.review.non_product_prefixes), ["scripts"]);
    assert.deepEqual(
      resolveAccept(excluded.root, excluded.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: excluded.report() }),
      { ok: true, fast_track: true },
    );
  } finally {
    excluded.dispose();
  }
});

test("g-437 判据 4：未跟踪计数复用 g-443 真实归属——插件自有目录不算，真实用户文件仍阻断", () => {
  // (a) 非隔离 attempt：看板 `.dsh-graph/**` 全是未跟踪，但属插件自有 ⇒ 不计入
  const nonIsolated = makeFastTrackFixture({ type: "patch", nonIsolated: true });
  try {
    assert.deepEqual(nonIsolated.changedPaths, ["scripts/run.sh"]);
    assert.deepEqual(
      resolveAccept(nonIsolated.root, nonIsolated.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: nonIsolated.report() }),
      { ok: true, fast_track: true },
      "插件自有看板目录不得阻断",
    );
  } finally {
    nonIsolated.dispose();
  }

  // (b) 真实用户未跟踪文件（含含空格名与嵌套目录）⇒ 门禁③按真源计数拒绝
  const userFiles = makeFastTrackFixture({ type: "patch", untracked: ["scratch/a.txt", "scratch b.txt", "deep/nested/c.txt"] });
  try {
    assert.equal(userFiles.untrackedFiles, 3);
    assert.throws(
      () => resolveAccept(userFiles.root, userFiles.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: userFiles.report() }),
      (e: unknown) => e instanceof GraphError && /未跟踪新文件 3 个（要求 0）/.test((e as Error).message),
    );
  } finally {
    userFiles.dispose();
  }

  // (c) attempt 树内**嵌套的、已注册且在 attempt.started 留痕的**插件工作树 ⇒ 其内未跟踪文件不计，
  //     同级的真实用户文件仍计入（证明归属判定按真实证据，而不是「树内一律豁免」）
  const nested = makeFastTrackFixture({ type: "patch" });
  try {
    const nestedTree = join(nested.tree, "vendor", "nested-wt");
    nested.git(nested.repo, ["worktree", "add", "-q", "-b", "nested-branch", nestedTree]);
    appendEvent(nested.root, {
      actor: "t",
      event: "attempt.started",
      goal: nested.goal,
      details: { attempt: "att-000", worktree: { path: nestedTree } },
    });
    writeFileSync(join(nestedTree, "owned-untracked.txt"), "plugin own\n");
    writeFileSync(join(nested.tree, "user-untracked.txt"), "user own\n");
    // 嵌套工作树是否被 git 列为未跟踪，决定了这条断言是否真的走到「归属排除」分支；
    // 两种情形都不得把它算作真实用户文件（前者由归属排除，后者 git 根本不报）。
    const rawStatus = nested.git(nested.tree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

    const r = collectAttemptGitTruth({
      workspaceDir: dirname(nested.root),
      graphRoot: nested.root,
      attemptWorktree: { path: nested.tree },
      baseline: nested.baseline,
      attemptBaseline: nested.baseline,
    });
    assert.equal(r.ok, true, r.ok ? "" : r.reason);
    if (r.ok) {
      assert.deepEqual(r.truth.untracked_paths, ["user-untracked.txt"], "嵌套插件工作树内不计，真实用户文件必须计");
      assert.equal(r.truth.untracked_files, 1);
      // 本环境的 git 会把嵌套工作树目录列为 `?? vendor/nested-wt/`（实测）——因此这条断言**确实**
      // 走到了「按真实归属排除」分支，而不是因为 git 压根没报它而空过。
      assert.ok(rawStatus.includes("vendor/nested-wt/"), `git 必须报告嵌套工作树目录（原始 status：${rawStatus}）`);
      assert.ok(rawStatus.includes("user-untracked.txt"));
    }
  } finally {
    nested.dispose();
  }
});

test("g-437 判据 2：基线不可解析 / 报告基线取到 HEAD / Git 失败 ⇒ fail-safe 拒绝且零副作用", () => {
  // (a) 基线不可解析
  const badBaseline = makeFastTrackFixture({ type: "patch" });
  try {
    assertRejectedWithNoSideEffects(
      () => resolveAccept(badBaseline.root, badBaseline.goal, {
        actor: "supervisor:test", verdict: "accept", fast_track: true,
        machine_report: badBaseline.report({ baseline_commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" }),
      }),
      badBaseline,
      /基线不可解析/,
      "bad baseline",
    );
  } finally {
    badBaseline.dispose();
  }

  // (b) 报告把基线取到 HEAD（自我归零：diff 为空 ⇒ 0 行 0 未跟踪）——必须与 attempt 持久化基线绑定
  const zeroBypass = makeFastTrackFixture({ type: "patch" });
  try {
    assertRejectedWithNoSideEffects(
      () => resolveAccept(zeroBypass.root, zeroBypass.goal, {
        actor: "supervisor:test", verdict: "accept", fast_track: true,
        machine_report: zeroBypass.report({ baseline_commit: zeroBypass.head, changed_paths: [], product_changed_lines: 0, untracked_files: 0 }),
      }),
      zeroBypass,
      /与 attempt 持久化基线/,
      "baseline=HEAD 自我归零",
    );
  } finally {
    zeroBypass.dispose();
  }

  // (c) 工作树的 git 元数据被破坏 ⇒ Git 采集失败，同样 fail-safe 拒绝
  const brokenGit = makeFastTrackFixture({ type: "patch" });
  try {
    rmSync(join(brokenGit.tree, ".git"), { force: true });
    assertRejectedWithNoSideEffects(
      () => resolveAccept(brokenGit.root, brokenGit.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: brokenGit.report() }),
      brokenGit,
      /fast_track 被拒/,
      "git metadata broken",
    );
  } finally {
    brokenGit.dispose();
  }
});

// ---------------------------------------------------------------------------
// 1c. g-437 P1（独立复核的洞）：**区间锚点必须来自 attempt 记录，绝不来自报告**
//     洞形态：attempt 未持久化 baseline_commit 时，旧实现把报告里的 baseline 当区间锚点 ⇒
//     报告写 baseline=该 attempt 的 HEAD、changed_paths=[]、0 行 ⇒ diff 恒为空 ⇒ 必然放行。
// ---------------------------------------------------------------------------

/** 洞形态报告：基线取到自己的 HEAD + 空路径 + 0 行 + 0 未跟踪（真产品码 300 行被隐藏）。 */
const holeReport = (f: { head: string }) => ({
  baseline_commit: f.head,
  changed_paths: [] as string[],
  product_changed_lines: 0,
  untracked_files: 0,
});

test("g-437 P1：无持久化基线时报告把 baseline 取到 attempt HEAD ⇒ 必须拒绝（隔离 attempt）", () => {
  const f = makeFastTrackFixture({
    type: "patch",
    changed: [{ path: "scripts/run.sh", lines: 300 }],
    omitBaseline: true, // 复现「派发时未持久化基线」的旧记录形态（仍留有 worktree.head）
  });
  try {
    assert.equal(f.productLines, 300, "夹具真源必须是 300 行真实产品码");
    assertRejectedWithNoSideEffects(
      () => resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report(holeReport(f)) }),
      f,
      /与 attempt 持久化基线\/工作树 head/,
      "P1 洞：无持久化基线 + baseline=HEAD",
    );
  } finally {
    f.dispose();
  }
});

test("g-437 P1：无持久化基线时报告把 baseline 取到 attempt HEAD ⇒ 必须拒绝（非隔离 attempt，无任何锚点）", () => {
  const f = makeFastTrackFixture({
    type: "patch",
    nonIsolated: true,
    changed: [{ path: "scripts/run.sh", lines: 300 }],
    omitBaseline: true,
  });
  try {
    // 非隔离记录里既无 baseline_commit 也无 worktree.head ⇒ 引擎侧无锚点 ⇒ fail-closed
    assertRejectedWithNoSideEffects(
      () => resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report(holeReport(f)) }),
      f,
      /未记录任何引擎侧区间锚点/,
      "P1 洞：非隔离 + 无锚点",
    );
  } finally {
    f.dispose();
  }
});

test("g-437 P1：无任何引擎锚点时错误可操作——告诉调用方重新派发或走普通 accept", () => {
  const f = makeFastTrackFixture({ type: "patch", nonIsolated: true, omitBaseline: true });
  try {
    assert.throws(
      () => resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report() }),
      (e: unknown) => e instanceof GraphError
        && /未记录任何引擎侧区间锚点/.test((e as Error).message)
        && /重新派发/.test((e as Error).message)
        && /普通 accept/.test((e as Error).message),
      "无锚点必须给出可操作指引（重新派发 / 普通 accept），不得只说「拒绝」",
    );
    assert.equal(String(loadGoal(f.file).meta.status ?? ""), "review", "状态不变");
  } finally {
    f.dispose();
  }
});

test("g-437 P1：锚点回退到 worktree.head 后，诚实报告仍放行且事件如实标注锚点来源", () => {
  const f = makeFastTrackFixture({
    type: "patch",
    changed: [{ path: "scripts/run.sh", lines: 3 }],
    omitBaseline: true, // 无持久化基线 ⇒ 锚点回退 attempt 工作树 head（= 真基线）
  });
  try {
    const r = resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report() });
    assert.deepEqual(r, { ok: true, fast_track: true });
    const ft = readEvents(f.root).find((e) => e.event === "review.fast_track")!;
    const truth = (ft.details as any).git_truth;
    assert.equal(truth.anchor_source, "attempt_worktree_head", "必须如实标注锚点取自 worktree.head");
    assert.equal(truth.baseline_resolved, f.baseline, "采集区间必须锚到派发时的工作树起点（真基线）");
    assert.equal(truth.product_changed_lines, f.productLines, "真源行数必须来自锚点区间");
    assert.equal((ft.details as any).baseline, f.baseline, "事件基线 = 引擎锚点");
  } finally {
    f.dispose();
  }
});

test("g-437 P1：有持久化基线时锚点来源标注为 attempt_baseline（优先于 worktree.head）", () => {
  const f = makeFastTrackFixture({ type: "patch", changed: [{ path: "scripts/run.sh", lines: 2 }] });
  try {
    resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report() });
    const ft = readEvents(f.root).find((e) => e.event === "review.fast_track")!;
    assert.equal((ft.details as any).git_truth.anchor_source, "attempt_baseline");
  } finally {
    f.dispose();
  }
});

test("g-437 P1：报告基线只用于比对——同一 commit 的不同写法（短 SHA）也接受，不同 commit 一律拒绝", () => {
  // 短 SHA：与锚点解析到同一 commit ⇒ 接受（比对按 commit，不按字符串）
  const f = makeFastTrackFixture({ type: "patch", changed: [{ path: "scripts/run.sh", lines: 1 }] });
  try {
    const short = f.baseline.slice(0, 8);
    const r = resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report({ baseline_commit: short }) });
    assert.deepEqual(r, { ok: true, fast_track: true });
  } finally {
    f.dispose();
  }
  // 另一条**真实且可解析**的 commit（attempt 树自己的 HEAD，即「取到 HEAD 自我归零」）：
  // 解析得到但 ≠ 锚点 ⇒ 拒绝（锚点只能来自 attempt 记录）
  const g = makeFastTrackFixture({ type: "patch", changed: [{ path: "scripts/run.sh", lines: 1 }] });
  try {
    assert.notEqual(g.head, g.baseline, "夹具：attempt HEAD 必须不同于基线");
    assertRejectedWithNoSideEffects(
      () => resolveAccept(g.root, g.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: g.report({ baseline_commit: g.head }) }),
      g,
      /与 attempt 持久化基线\/工作树 head/,
      "报告基线 = 真实但非锚点的 commit",
    );
  } finally {
    g.dispose();
  }
});

/** 报错文案不得写死仓库路径（去本仓库假设；路径对调用方无行动价值）。 */
const assertNoRepoPath = (m: string) => {
  for (const token of ["dsh-graph-g437-", ".dsh-graph", "attempts/", "goal.md", "/home/", "tmp/"]) {
    assert.ok(!m.includes(token), `报错不得写仓库绝对/相对路径（命中 ${token}）：${m}`);
  }
};

test("g-437 P4：三条 attempt 报错必须可操作（形态示例 / 枚举现有 attempt / 空目录显式取值 / 不写仓库路径）", () => {
  const call = (root: string, goal: string, report: Record<string, unknown>) =>
    resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: report });

  // (a) 缺字段：点明「必填」+ 期望形态 + 该值从哪拿（引擎不猜工作树）
  const miss = makeFastTrackFixture({ type: "patch", omitAttempt: true });
  try {
    assert.throws(() => call(miss.root, miss.goal, miss.report()), (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /必须显式给出 attempt/);
      assert.match(m, /必填/);
      assert.match(m, /"att-001"/, "必须给出编号形态示例");
      assert.match(m, /graph_start_attempt/, "必须指出正确值从哪来");
      assertNoRepoPath(m);
      return true;
    });
  } finally {
    miss.dispose();
  }

  const f = makeFastTrackFixture({ type: "patch" });
  try {
    // (b) 编号格式非法：保留既有「取值非法」措辞 + 给出期望形态
    assert.throws(() => call(f.root, f.goal, f.report({ attempt: "attempt-1" })), (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /取值非法/);
      assert.match(m, /"att-001"/);
      assertNoRepoPath(m);
      return true;
    });
    // (c) 编号不存在：必须枚举该目标现有 attempt（此处恰有 att-001）
    assert.throws(() => call(f.root, f.goal, f.report({ attempt: "att-007" })), (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /不存在 attempt att-007/);
      assert.ok(m.includes(f.attempt), `必须枚举现有 attempt（缺 ${f.attempt}）：${m}`);
      assert.doesNotMatch(m, /（当前无 attempt）/, "有 attempt 时不得说「当前无 attempt」");
      assertNoRepoPath(m);
      return true;
    });
    // (d) 空 attempts 目录：显式给出「（当前无 attempt）」，绝不回传空串/undefined
    rmSync(join(dirname(f.file), "attempts"), { recursive: true, force: true });
    assert.throws(() => call(f.root, f.goal, f.report({ attempt: "att-007" })), (e: unknown) => {
      const m = (e as Error).message;
      assert.match(m, /（当前无 attempt）/, "空目录必须显式取「（当前无 attempt）」");
      assert.doesNotMatch(m, /undefined|NaN/, "不得把空值渲染成 undefined/NaN");
      assertNoRepoPath(m);
      return true;
    });
  } finally {
    f.dispose();
  }
});

test("g-437 判据 6：① ② 是调用方证据——command / collected_at / source 缺一即拒绝且零副作用", () => {
  const missing: Array<[string, (rep: Record<string, any>) => Record<string, unknown>]> = [
    ["tests.command", (rep) => ({ tests: { ...rep.tests, command: undefined } })],
    ["tests.collected_at", (rep) => ({ tests: { ...rep.tests, collected_at: "" } })],
    ["tests.source", (rep) => ({ tests: { ...rep.tests, source: "   " } })],
    ["typecheck 整段缺失", () => ({ typecheck: { exit_code: 0 } })],
  ];
  for (const [label, mutate] of missing) {
    const f = makeFastTrackFixture({ type: "patch" });
    try {
      const rep = f.report(mutate(f.report() as Record<string, any>) as Record<string, any>);
      assertRejectedWithNoSideEffects(
        () => resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: rep }),
        f,
        /缺少调用方留痕/,
        label,
      );
    } finally {
      f.dispose();
    }
  }
});

// ---------------------------------------------------------------------------
// 5. 缺省路径逐字不变（非 git 看板同样可用）
// ---------------------------------------------------------------------------

/** 非 Git 看板夹具（证明缺省 accept / object / force 路径**不依赖** Git 真源采集）。 */
function plainFixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g437-plain-"));
  init(root);
  const goal = createGoal(root, { title: "plain", version: "v-test", type: "feature", actor: "t" });
  setCriteria(root, goal, [`全量测试全绿 ✅已验`], "t");
  const file = findGoalFile(root, goal);
  const doc = loadGoal(file);
  saveGoal(file, { meta: { ...doc.meta, status: "review" }, body: doc.body });
  return { root, goal, file };
}

test("g-437 判据 7：缺省 accept / object / force 路径逐字不变（非 Git 看板可用，不触 Git 真源）", () => {
  // 普通 accept：返回值不得被 fast_track 字段污染，事件序列不变
  const plain = plainFixture();
  try {
    assert.deepEqual(resolveAccept(plain.root, plain.goal, { actor: "supervisor:test", verdict: "accept" }), { ok: true });
    const names = readEvents(plain.root).map((e) => e.event);
    assert.ok(names.includes("review.passed"), "普通 accept 必须仍记 review.passed");
    assert.ok(!names.includes("review.fast_track"), "普通 accept 不得记 review.fast_track");
    assert.equal(String(loadGoal(plain.file).meta.status ?? ""), "delivered");
  } finally {
    rmSync(plain.root, { recursive: true, force: true });
  }

  // object：只记 review.objected，状态不变
  const obj = plainFixture();
  try {
    assert.deepEqual(resolveAccept(obj.root, obj.goal, { actor: "supervisor:test", verdict: "object", objection: "证据不足" }), { ok: true });
    const objected = readEvents(obj.root).filter((e) => e.event === "review.objected");
    assert.equal(objected.length, 1);
    assert.equal((objected[0].details as any).objection, "证据不足");
    assert.equal(String(loadGoal(obj.file).meta.status ?? ""), "review");
  } finally {
    rmSync(obj.root, { recursive: true, force: true });
  }

  // force + reason：记 goal.amended 后走同一 accept 映射
  const forced = plainFixture();
  try {
    assert.deepEqual(resolveAccept(forced.root, forced.goal, { actor: "supervisor:test", verdict: "accept", force: true, reason: "负责人裁决" }), { ok: true });
    const names = readEvents(forced.root).map((e) => e.event);
    assert.ok(names.includes("goal.amended"), "force 必须记 goal.amended");
    assert.ok(names.includes("review.passed"));
    assert.ok(!names.includes("review.fast_track"));
    assert.equal(String(loadGoal(forced.file).meta.status ?? ""), "delivered");
  } finally {
    rmSync(forced.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. 文档与工具描述如实（修掉两条不实/不一致表述）
// ---------------------------------------------------------------------------

test("g-437 判据 6：工具描述/指南/帮助如实标注「① ② 调用方证据（引擎不复跑）、③ 引擎 Git 自算」，zh/en 一致", () => {
  const indexJs = readFileSync(join(repoRoot, "dsh-graph-host", "index.js"), "utf8");
  const i18n = readFileSync(join(repoRoot, "dsh-graph-host", "lib", "server-i18n.js"), "utf8");
  const guideZh = readFileSync(join(repoRoot, "dsh-graph-host", "supervisor-guide.zh.md"), "utf8");
  const guideEn = readFileSync(join(repoRoot, "dsh-graph-host", "supervisor-guide.en.md"), "utf8");
  const helpZh = readFileSync(join(repoRoot, "dsh-graph-host", "prompts", "help.zh.md"), "utf8");
  const helpEn = readFileSync(join(repoRoot, "dsh-graph-host", "prompts", "help.en.md"), "utf8");

  // 不实表述必须消失：不再把四项门禁一律说成「由引擎自算」
  assert.ok(
    !indexJs.includes("产品代码增删 <150 行且无未跟踪新文件、全部判据以 ✅已验 结尾，由引擎自算）"),
    "工具描述不得再把四项门禁一律说成引擎自算",
  );
  // 如实分层：① ② 调用方证据 + 引擎不复跑；③ 引擎 Git 自算
  assert.match(indexJs, /调用方证据/);
  assert.match(indexJs, /引擎不复跑/);
  assert.match(indexJs, /引擎 Git 自算/);
  // machine_report 参数描述必须点名真实字段（attempt 必填 + ①② 留痕字段）
  assert.match(indexJs, /attempt 必填/);
  assert.match(indexJs, /collected_at/);
  // zh / en 两侧同一口径（en 无 CJK 由 prompt-i18n-parity 守卫）
  assert.match(i18n, /调用方证据/);
  assert.match(i18n, /CALLER evidence/);
  assert.match(i18n, /never re-runs/);
  assert.match(guideZh, /证据分层/);
  assert.match(guideEn, /Evidence layering/);
  assert.match(guideZh, /调用方证据/);
  assert.match(guideEn, /caller evidence/);
  assert.match(helpZh, /调用方证据/);
  assert.match(helpEn, /caller evidence/);
  // zh/en 指南仍逐行对齐（新增分层说明必须两侧同步）
  assert.equal(guideZh.split("\n").length, guideEn.split("\n").length, "zh/en 指南行数必须仍相等");
});

test("g-437 P2：指南的采集口径必须含 rename 展开说明，不再宣称「numstat 口径采集即可」", () => {
  const guides = { zh: guideZhText(), en: guideEnText() };
  for (const lang of ["zh", "en"] as const) {
    const g = guides[lang];
    // 正确口径：`--name-status -z`（rename/copy 给旧新两条路径）
    assert.match(g, /git diff --name-status -z <attempt\.baseline_commit> HEAD/, `${lang}：必须给出 rename 感知的采集口径`);
    // 既有 numstat 表述保留（g-311 的 token 断言不缩水）
    assert.match(g, /git diff --numstat <attempt\.baseline_commit> HEAD/, `${lang}：保留既有 numstat 口径表述`);
    // 明确点名 rename/copy 必须展开两条路径，并说明两种「看似可用」的写法为何过不了对账
    assert.match(g, /rename\/copy/i, `${lang}：必须说明 rename/copy 需展开旧新两条路径`);
    assert.match(g, /old => new/, `${lang}：必须点名非 -z 的复合串写法`);
    assert.match(g, /--name-only/, `${lang}：必须点名 --name-only 只给新路径`);
  }
  // 负向对照：旧的「口径采集即可」误导表述必须消失
  assert.doesNotMatch(guides.zh, /口径采集即可/, "zh 不得再宣称 numstat 口径采集即可");
  assert.doesNotMatch(guides.en, /may collect with the `git diff --numstat/, "en 不得再宣称 numstat 口径即可");
});
