/**
 * g-311：分级评审机制与机器快速放行（Fast-Track Review Policy）——判据 1–4 的行为断言。
 *
 * 断言分层（与判据一一对应）：
 *  - 判据 1 → 配置管道：`writeProjectConfig → readProjectConfig` 三值往返、清空、
 *             三类非法值被 schema 拒绝且**零副作用**（文件未被改写）、未配置为 null；
 *  - 判据 2 → 门禁四项逐条单测（含 149/150 边界）、产品代码口径（排除 tests/*.md/生成物）、
 *             判据「✅已验」判定、fail-safe（任一信号取不到即不放行）；
 *  - 判据 3 → `resolveAccept(fast_track=true, machine_report=…)` 全绿则记 `review.fast_track`
 *             （含四项机器证据与 baseline）并走同一 accept 映射；任一项失效即拒绝且**零副作用**
 *             （状态不变、无 `review.passed`、无 `review.fast_track`）；门禁 ④ 以引擎自算覆盖自报；
 *  - 判据 4 → 契约路径 / 跨 ≥3 顶层区域 / 显式 `strict_required` 一律判定 strict（含**本目标自身
 *             真实属性**的自洽用例）；指南 zh/en 含该小节且行数仍相等；并如实断言指南写明了
 *             「判定 + 指南约束，非引擎强制」与「不得绕过 delivered 人工 gate」。
 *
 * 反自我满足设计：负向对照全部在**内存字符串**上定点破坏后重放同一套检查器（hermetic），
 * 并断言真实文件逐字节未变——不写第二份「演示用」判定逻辑。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  findGoalFile,
  loadGoal,
  writeProjectConfig,
  readProjectConfig,
  resolveAccept,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import {
  REVIEW_POLICIES,
  FAST_TRACK_MAX_PRODUCT_LINES,
  typeDefaultReviewPolicy,
  normalizeReviewPolicy,
  resolveReviewPolicy,
  evaluateFastTrackGate,
  countProductChangedLines,
  isProductCodePath,
} from "../review-policy.ts";
import { allCriteriaVerified, verifiedCriteriaItems, CRITERIA_VERIFIED_MARK } from "../model.ts";
import { GraphError } from "../machine.ts";
import { apply } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const VERIFIED = `${CRITERIA_VERIFIED_MARK}`;

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 建一个干净的看板 root（无 project.yaml），目标置于 review 状态并登记已验判据。 */
function fixture(opts: { type?: string; criteria?: string[]; status?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g311-"));
  init(root);
  const goal = createGoal(root, { title: "fixture", version: "v-test", type: opts.type ?? "patch", actor: "t" });
  setCriteria(root, goal, opts.criteria ?? [`全量测试全绿 ${VERIFIED}`, `无回归 ${VERIFIED}`], "t");
  const file = findGoalFile(root, goal);
  writeFileSync(file, readFileSync(file, "utf8").replace('"status": "planning"', `"status": "${opts.status ?? "review"}"`));
  return { root, goal, file };
}

const statusOf = (file: string) => String(loadGoal(file).meta.status ?? "");
const eventsOf = (root: string, goal: string, name: string) =>
  readEvents(root).filter((e) => e.goal === goal && e.event === name);

/** 全绿机器报告（各用例按需覆盖单个字段构造负向对照）。 */
function greenReport(over: Record<string, unknown> = {}) {
  return {
    baseline_commit: "86b2c2b",
    changed_paths: ["core/ops.ts"],
    product_changed_lines: 12,
    untracked_files: 0,
    tests: { exit_code: 0, fail: 0 },
    typecheck: { exit_code: 0 },
    criteria: { all_verified: true },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// 判据 1：策略三值与按类型派生
// ---------------------------------------------------------------------------

test("g-311 判据 1：三值常量与归一化——仅 auto/strict/none 合法，其余一律 null", () => {
  assert.deepEqual([...REVIEW_POLICIES], ["auto", "strict", "none"]);
  for (const p of REVIEW_POLICIES) assert.equal(normalizeReviewPolicy(p), p);
  assert.equal(normalizeReviewPolicy(" AUTO "), "auto", "读路径大小写/空白容错（写路径由 schema enum 严格拒绝）");
  assert.equal(normalizeReviewPolicy("Strict"), "strict");
  for (const bad of ["fast", "0", "true", 123, {}, [], true, "", "  "]) {
    assert.equal(normalizeReviewPolicy(bad), null, `非三值必须归一为「未配置」：${JSON.stringify(bad)}`);
  }
});

test("g-311 判据 1：按目标类型派生（patch/chore→auto，feature/bug/task/improvement→strict，空/非法→strict）", () => {
  assert.equal(typeDefaultReviewPolicy("patch"), "auto");
  assert.equal(typeDefaultReviewPolicy("chore"), "auto");
  assert.equal(typeDefaultReviewPolicy("PATCH"), "auto", "大小写归一化");
  for (const t of ["feature", "bug", "task", "improvement", "Feature", "BUG"]) {
    assert.equal(typeDefaultReviewPolicy(t), "strict", `${t} 应派生 strict`);
  }
  for (const t of [null, undefined, "", "   ", "research", 42, {}]) {
    assert.equal(typeDefaultReviewPolicy(t), "strict", `空/非法/未登记类型必须安全侧兜底 strict：${JSON.stringify(t)}`);
  }
});

test("g-311 判据 1：resolveReviewPolicy 显式值优先、未配置按类型派生、非法显式值安全侧兜底", () => {
  // 未配置（null）→ 类型派生，来源标注为 type_default
  assert.deepEqual(resolveReviewPolicy({ policy: null, type: "patch" }), {
    policy: "auto", source: "type_default", strictReasons: [], reasons: [],
  });
  assert.equal(resolveReviewPolicy({ policy: null, type: "feature" }).policy, "strict");
  assert.equal(resolveReviewPolicy({ policy: null, type: "feature" }).source, "type_default");
  // 显式三值 → 尊重显式（patch 也能被显式抬成 strict，none 也能被显式指定）
  assert.equal(resolveReviewPolicy({ policy: "strict", type: "patch" }).policy, "strict");
  assert.equal(resolveReviewPolicy({ policy: "strict", type: "patch" }).source, "explicit");
  assert.equal(resolveReviewPolicy({ policy: "none", type: "feature" }).policy, "none");
  assert.equal(resolveReviewPolicy({ policy: "auto", type: "feature" }).policy, "auto");
  // 非法显式值 → strict 兜底（绝不当作 auto），理由进闭集
  const bad = resolveReviewPolicy({ policy: "fast", type: "patch" });
  assert.equal(bad.policy, "strict");
  assert.deepEqual(bad.strictReasons, ["policy_unrecognized"]);
});

test("g-311 判据 1：配置管道三值往返 + 清空 + 保留注释与未知键", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g311-cfg-"));
  init(root);
  writeFileSync(
    join(root, "project.yaml"),
    "executor:\n  provider: openai-codex   # 行尾注释须保留\nunknown_block:\n  mystery: keep-me\n",
  );
  for (const policy of REVIEW_POLICIES) {
    writeProjectConfig(root, { review: { policy } }, "human:gui");
    assert.equal(readProjectConfig(root).review.policy, policy, `${policy} 往返读回`);
  }
  const text = readFileSync(join(root, "project.yaml"), "utf8");
  assert.match(text, /provider: openai-codex   # 行尾注释须保留/, "写入 review.policy 不得破坏既有注释");
  assert.match(text, /mystery: keep-me/, "未知键必须保留");
  assert.match(text, /^review:\n {2}policy: none$/m, "顶层 review.policy 落位形态");
  // 清空 → 读回 null（＝未配置 → 按类型派生）
  writeProjectConfig(root, { review: { policy: null } }, "human:gui");
  assert.equal(readProjectConfig(root).review.policy, null);
  // 无 project.yaml 时也为 null，且不得因读取而创建文件
  const bare = mkdtempSync(join(tmpdir(), "dsh-graph-g311-bare-"));
  init(bare);
  assert.equal(readProjectConfig(bare).review.policy, null);
});

test("g-311 判据 1：三类非法值经 schema 拒绝，且零副作用（文件逐字节不变）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g311-bad-"));
  init(root);
  const file = join(root, "project.yaml");
  writeProjectConfig(root, { review: { policy: "auto" } }, "human:gui");
  const before = readFileSync(file, "utf8");
  const beforeEvents = readEvents(root).length;
  const illegal: Array<[string, unknown]> = [
    ["未知取值", "fast"],
    ["大小写不符", "AUTO"],
    ["类型不符", 123],
  ];
  for (const [label, policy] of illegal) {
    assert.throws(
      () => writeProjectConfig(root, { review: { policy } }, "human:gui"),
      (e: unknown) => e instanceof GraphError && /review\.policy/.test(String((e as Error).message)),
      `${label}（${JSON.stringify(policy)}）必须被拒绝`,
    );
  }
  assert.equal(readFileSync(file, "utf8"), before, "非法值被拒后文件必须逐字节不变");
  assert.equal(readEvents(root).length, beforeEvents, "非法值被拒后不得追加任何事件");
  assert.equal(readProjectConfig(root).review.policy, "auto", "既有合法值不受影响");
});

// ---------------------------------------------------------------------------
// 判据 2：产品代码口径 + 门禁四项 + fail-safe
// ---------------------------------------------------------------------------

test("g-311 判据 2③：产品代码口径（排除 core/tests/**、*.md 与生成物）", () => {
  const product = ["core/ops.ts", "core/review-policy.ts", "dsh-graph-host/index.js", "schema/SCHEMA.md".replace("SCHEMA.md", "x.json"), "scripts/build.sh"];
  for (const p of product) assert.equal(isProductCodePath(p), true, `${p} 应计入产品代码`);
  const excluded = [
    "core/tests/g311-review-policy.test.ts",
    "README.md",
    "dsh-graph-host/supervisor-guide.zh.md",
    "docs/design.md",
    "dist/core/ops.js",
    "core-dist/ops.js",
    "node_modules/x/index.js",
    "pnpm-lock.yaml",
    "",
  ];
  for (const p of excluded) assert.equal(isProductCodePath(p), false, `${p} 应被口径排除`);

  const numstat = [
    "10\t2\tcore/ops.ts",
    "3\t0\tcore/tests/g311-review-policy.test.ts",
    "5\t1\tdsh-graph-host/supervisor-guide.zh.md",
    "-\t-\tassets/logo.png",
    "7\t7\tdsh-graph-host/index.js",
  ].join("\n");
  const counted = countProductChangedLines(numstat);
  assert.equal(counted.lines, 10 + 2 + 0 + 7 + 7, "仅产品代码行数计入（含二进制 0 行）");
  assert.deepEqual(counted.files, ["core/ops.ts", "assets/logo.png", "dsh-graph-host/index.js"]);
  assert.deepEqual(counted.skipped, ["core/tests/g311-review-policy.test.ts", "dsh-graph-host/supervisor-guide.zh.md"]);
});

test("g-311 判据 2④：判据「✅已验」判定（allCriteriaVerified / verifiedCriteriaItems）", () => {
  const body = (items: string) => `## 质量判据\n\n${items}\n\n## 其他\n\nx\n`;
  assert.equal(allCriteriaVerified(body(`1. 甲 ${VERIFIED}\n2. 乙 ${VERIFIED}`)), true);
  assert.equal(verifiedCriteriaItems(body(`1. 甲 ${VERIFIED}\n2. 乙`)).length, 1);
  assert.equal(allCriteriaVerified(body(`1. 甲 ${VERIFIED}\n2. 乙`)), false, "有一条未验即 false");
  assert.equal(allCriteriaVerified(body("（待登记）")), false, "无判据即 false");
  assert.equal(allCriteriaVerified("## 无此小节\n"), false);
  assert.equal(
    allCriteriaVerified(body(`1. 甲 ${VERIFIED}\n<!-- 2. 注释里的 ${VERIFIED} 不算 -->`)),
    true,
    "HTML 注释行不计入判据",
  );
  assert.equal(allCriteriaVerified(body(`1. 甲 ${VERIFIED} `)), true, "尾部空白不影响判定");
});

test("g-311 判据 2：门禁四项逐条判定，全绿才放行（含 149/150 边界）", () => {
  const green = evaluateFastTrackGate(greenReport());
  assert.equal(green.allowed, true);
  assert.deepEqual(green.checks.map((c) => [c.id, c.ok]), [
    ["tests", true], ["typecheck", true], ["diff_size", true], ["criteria_verified", true],
  ]);
  assert.equal(green.evidence.baseline_commit, "86b2c2b", "证据须保留 baseline_commit");

  // ① 双条件：exit_code 与 fail 必须同时满足
  assert.match(evaluateFastTrackGate(greenReport({ tests: { exit_code: 1, fail: 0 } })).failed.join(), /tests/);
  assert.match(evaluateFastTrackGate(greenReport({ tests: { exit_code: 0, fail: 1 } })).failed.join(), /tests/);
  // ② 类型检查
  assert.deepEqual(evaluateFastTrackGate(greenReport({ typecheck: { exit_code: 2 } })).failed, ["typecheck"]);
  // ③ 边界：149 放行、150 拒绝；未跟踪新文件与缺失基线一律拒绝
  assert.equal(evaluateFastTrackGate(greenReport({ product_changed_lines: FAST_TRACK_MAX_PRODUCT_LINES - 1 })).allowed, true);
  assert.deepEqual(
    evaluateFastTrackGate(greenReport({ product_changed_lines: FAST_TRACK_MAX_PRODUCT_LINES })).failed,
    ["diff_size"],
    `恰好 ${FAST_TRACK_MAX_PRODUCT_LINES} 行必须拒绝（阈值口径为严格小于）`,
  );
  assert.deepEqual(evaluateFastTrackGate(greenReport({ untracked_files: 1 })).failed, ["diff_size"]);
  assert.deepEqual(evaluateFastTrackGate(greenReport({ baseline_commit: "" })).failed, ["diff_size"]);
  // ④ 判据已验
  assert.deepEqual(evaluateFastTrackGate(greenReport({ criteria: { all_verified: false } })).failed, ["criteria_verified"]);
});

test("g-311 判据 2：fail-safe——任一信号取不到即不放行（绝不当成证据为真）", () => {
  const allFour = ["tests", "typecheck", "diff_size", "criteria_verified"];
  for (const empty of [undefined, null, {}, [], "green", 42, { tests: {} }]) {
    const r = evaluateFastTrackGate(empty);
    assert.equal(r.allowed, false, `不可信报告必须拒绝：${JSON.stringify(empty)}`);
    assert.deepEqual(r.failed, allFour, `缺失信号必须逐项计入 failed：${JSON.stringify(empty)}`);
  }
  // 单个字段缺失同样拒绝（不因为其余三项全绿而放行）
  assert.deepEqual(evaluateFastTrackGate(greenReport({ product_changed_lines: undefined })).failed, ["diff_size"]);
  assert.deepEqual(evaluateFastTrackGate(greenReport({ tests: { exit_code: 0 } })).failed, ["tests"]);
  assert.deepEqual(evaluateFastTrackGate(greenReport({ criteria: {} })).failed, ["criteria_verified"]);
});

// ---------------------------------------------------------------------------
// 判据 4：strict 升级闭集（M1–M4）
// ---------------------------------------------------------------------------

test("g-311 判据 4：契约路径 / 跨 ≥3 顶层区域 / 显式 strict_required 一律判定 strict", () => {
  const base = { policy: "auto", type: "patch" } as const;
  // M1 契约冻结——显式 auto（甚至 none）不得推翻
  for (const p of ["core/schema.ts", "schema/SCHEMA.md", "./core/schema.ts"]) {
    const d = resolveReviewPolicy({ ...base, changedPaths: [p] });
    assert.equal(d.policy, "strict", `${p} 必须升级 strict`);
    assert.deepEqual(d.strictReasons, ["contract_change"]);
    assert.equal(d.source, "explicit", "升级不改变基础策略来源标注");
  }
  assert.equal(resolveReviewPolicy({ policy: "none", type: "patch", changedPaths: ["core/schema.ts"] }).policy, "strict");
  // M2 产品代码规模（149 不触发、150 触发）
  assert.equal(resolveReviewPolicy({ ...base, productChangedLines: 149 }).policy, "auto");
  assert.deepEqual(resolveReviewPolicy({ ...base, productChangedLines: 150 }).strictReasons, ["product_size"]);
  // M3 跨 ≥3 个顶层区域（2 个不触发）
  const twoRegions = ["core/ops.ts", "dsh-graph-host/index.js"];
  const threeRegions = [...twoRegions, "dsh-graph-host/lib/client/board.js"];
  assert.equal(resolveReviewPolicy({ ...base, changedPaths: twoRegions }).policy, "auto");
  const cross = resolveReviewPolicy({ ...base, changedPaths: threeRegions });
  assert.equal(cross.policy, "strict");
  assert.deepEqual(cross.strictReasons, ["cross_region"]);
  // 未登记区域的路径不计入 M3（照闭集定义），但契约路径另有 M1 兜底
  assert.equal(resolveReviewPolicy({ ...base, changedPaths: ["docs/a.md", "core/ops.ts", "README.md"] }).policy, "auto");
  assert.equal(resolveReviewPolicy({ ...base, changedPaths: ["schema/SCHEMA.md", "docs/a.md", "README.md"] }).policy, "strict");
  // M4 显式声明（覆盖核心层重写等无法用路径表达的场景）
  const declared = resolveReviewPolicy({ policy: "none", type: "patch", strictRequired: true });
  assert.equal(declared.policy, "strict");
  assert.deepEqual(declared.strictReasons, ["declared_strict"]);
});

test("g-311 判据 4 自洽：用本目标的真实属性解析，结果必须是 strict（不得给自己开快速通道）", () => {
  // 真实属性：type=feature；变更路径含 core/schema.ts（契约）+ core 与 dsh-graph-host 两个区域。
  const decision = resolveReviewPolicy({
    policy: null,
    type: "feature",
    changedPaths: [
      "core/review-policy.ts",
      "core/schema.ts",
      "core/ops.ts",
      "core/model.ts",
      "dsh-graph-host/index.js",
      "dsh-graph-host/lib/server-i18n.js",
      "dsh-graph-host/supervisor-guide.zh.md",
    ],
    productChangedLines: 120,
  });
  assert.equal(decision.policy, "strict", "本目标改 core/schema.ts，必须被判 strict");
  assert.ok(decision.strictReasons.includes("contract_change"), "M1 契约变更必须命中");
  assert.ok(decision.strictReasons.includes("type_or_policy_strict"), "type=feature 的派生本身即 strict");
  assert.ok(decision.reasons.length > 0, "strict 必须给出人读理由");
});

// ---------------------------------------------------------------------------
// 判据 3：resolveAccept(fast_track) 行为与零副作用
// ---------------------------------------------------------------------------

test("g-311 判据 3：门禁全绿且策略派生为 auto 时快速放行，记 review.fast_track（含四项证据与 baseline）", () => {
  const { root, goal, file } = fixture({ type: "patch" });
  const before = readEvents(root).length;
  const r = resolveAccept(root, goal, {
    actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: greenReport(),
  });
  assert.equal(r.ok, true);
  assert.equal(r.fast_track, true);
  assert.equal(statusOf(file), "delivered", "快速放行后走同一 accept 映射");

  const ft = eventsOf(root, goal, "review.fast_track");
  assert.equal(ft.length, 1, "必须恰好记一次 review.fast_track");
  const d = ft[0].details as Record<string, any>;
  assert.equal(d.policy, "auto");
  assert.equal(d.baseline, "86b2c2b", "事件必须含 baseline");
  assert.deepEqual(d.checks, { tests: true, typecheck: true, diff_size: true, criteria_verified: true });
  assert.deepEqual(Object.keys(d.evidence).sort(), [
    "changed_paths", "criteria_all_verified", "product_changed_lines",
    "tests_exit_code", "tests_fail", "typecheck_exit_code", "untracked_files",
  ].sort(), "事件必须含四项机器证据");
  assert.equal(d.evidence.criteria_all_verified, true);
  assert.equal(d.evidence.product_changed_lines, 12);
  assert.ok(eventsOf(root, goal, "review.passed").length === 1, "仍走既有 review.passed 路径");
  assert.deepEqual(
    readEvents(root).slice(before).map((e) => e.event),
    ["review.fast_track", "goal.transition", "review.passed"],
    "新增事件序列：机器证据先行 → 迁移 → review.passed",
  );
});

test("g-311 判据 3 负向对照：门禁任一项失效即拒绝且零副作用（状态不变、无 review.passed/fast_track）", () => {
  // 门禁 ④ 的信号取自 goal.md（引擎自算），故它的负向对照通过夹具的判据文本失效来构造。
  const broken: Array<[string, Record<string, unknown>, string[]?]> = [
    ["① 测试失败非零", { tests: { exit_code: 1, fail: 3 } }],
    ["① fail 非零", { tests: { exit_code: 0, fail: 1 } }],
    ["② 类型检查非零", { typecheck: { exit_code: 1 } }],
    ["③ 变更超阈值", { product_changed_lines: FAST_TRACK_MAX_PRODUCT_LINES }],
    ["③ 存在未跟踪新文件", { untracked_files: 2 }],
    ["③ 缺基线", { baseline_commit: "" }],
    ["④ 判据未全验", {}, ["全量测试全绿", "无回归"]],
  ];
  for (const [label, over, criteria] of broken) {
    const { root, goal, file } = fixture({ type: "patch", ...(criteria ? { criteria } : {}) });
    const before = readEvents(root).length;
    assert.throws(
      () => resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: greenReport(over) }),
      (e: unknown) => e instanceof GraphError && /fast_track 被拒/.test((e as Error).message),
      `${label} 必须被拒绝`,
    );
    assert.equal(statusOf(file), "review", `${label}：状态必须不变`);
    assert.equal(eventsOf(root, goal, "review.passed").length, 0, `${label}：不得出现 review.passed`);
    assert.equal(eventsOf(root, goal, "review.fast_track").length, 0, `${label}：不得出现 review.fast_track`);
    assert.equal(readEvents(root).length, before, `${label}：零副作用（事件数不变）`);
  }
  // 报告整体缺失 → fail-safe 拒绝，而不是退回普通 accept
  const { root, goal, file } = fixture({ type: "patch" });
  assert.throws(
    () => resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept", fast_track: true }),
    /fast_track 被拒/,
  );
  assert.equal(statusOf(file), "review");
});

test("g-311 判据 3：门禁 ④ 由引擎自算——报告自报「判据已验」无效", () => {
  const { root, goal, file } = fixture({ type: "patch", criteria: ["全量测试全绿", "无回归"] }); // 均无 ✅已验
  assert.throws(
    () => resolveAccept(root, goal, {
      actor: "supervisor:test", verdict: "accept", fast_track: true,
      machine_report: greenReport({ criteria: { all_verified: true } }),
    }),
    (e: unknown) => e instanceof GraphError && /✅已验 结尾 → false/.test((e as Error).message),
    "自报 all_verified=true 不得骗过引擎自算",
  );
  assert.equal(statusOf(file), "review");
  assert.equal(eventsOf(root, goal, "review.fast_track").length, 0);
});

test("g-311 判据 3/4：策略非 auto 时拒绝快速放行（契约路径 / feature 派生 / 显式声明）", () => {
  const cases: Array<[string, { type?: string; policy?: string; paths?: string[]; strictRequired?: boolean }]> = [
    ["契约路径（M1）", { type: "patch", policy: "auto", paths: ["core/schema.ts"] }],
    ["feature 派生 strict（M5）", { type: "feature" }],
    ["显式 strict", { type: "patch", policy: "strict" }],
    ["显式声明 strict_required（M4）", { type: "patch", policy: "auto", strictRequired: true }],
  ];
  for (const [label, opts] of cases) {
    const { root, goal, file } = fixture({ type: opts.type ?? "patch" });
    if (opts.policy) writeProjectConfig(root, { review: { policy: opts.policy } }, "human:gui");
    const report = greenReport({ changed_paths: opts.paths ?? ["core/ops.ts"], ...(opts.strictRequired ? { strict_required: true } : {}) });
    assert.throws(
      () => resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: report }),
      (e: unknown) => e instanceof GraphError && /策略为 strict/.test((e as Error).message),
      `${label} 必须拒绝快速放行`,
    );
    assert.equal(statusOf(file), "review", `${label}：状态不变`);
    assert.equal(eventsOf(root, goal, "review.fast_track").length, 0);
  }
});

test("g-311 判据 3 默认路径逐字不变：不带 fast_track 时行为与既往一致（不记 review.fast_track）", () => {
  const { root, goal, file } = fixture({ type: "feature" });
  const r = resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept" });
  assert.deepEqual(r, { ok: true }, "返回值不得被 fast_track 字段污染");
  assert.equal(statusOf(file), "delivered");
  assert.equal(eventsOf(root, goal, "review.fast_track").length, 0);
  assert.equal(eventsOf(root, goal, "review.passed").length, 1);
});

// ---------------------------------------------------------------------------
// 判据 4：指南约束（zh/en 等价）
// ---------------------------------------------------------------------------

const ZH_GUIDE = join(repoRoot, "dsh-graph-host", "supervisor-guide.zh.md");
const EN_GUIDE = join(repoRoot, "dsh-graph-host", "supervisor-guide.en.md");

const ZH_TOKENS = [
  "#### 分级评审与机器快速放行",
  "`review.policy ∈ {auto, strict, none}`",
  "patch`/`chore` → `auto`",
  "`core/schema.ts`",
  "`strict_required`",
  "`node --test core/tests/*.test.ts`",
  "`exit_code=0` 且 `fail=0`",
  "`./node_modules/.bin/tsc --noEmit -p tsconfig.json`",
  "`git diff --numstat <attempt.baseline_commit> HEAD`",
  "<150 行",
  "`✅已验`",
  "`review.fast_track`",
  "零副作用",
  "不是引擎强制",
  "（g-248 未接线）",
  "不得绕过 `delivered` 人工 gate",
];
const EN_TOKENS = [
  "#### Graded Review and Machine Fast Track",
  "`review.policy ∈ {auto, strict, none}`",
  "`patch`/`chore` → `auto`",
  "`core/schema.ts`",
  "`strict_required`",
  "`node --test core/tests/*.test.ts`",
  "`exit_code=0` and `fail=0`",
  "`./node_modules/.bin/tsc --noEmit -p tsconfig.json`",
  "`git diff --numstat <attempt.baseline_commit> HEAD`",
  "under 150 lines",
  "`✅已验`",
  "`review.fast_track`",
  "zero side effects",
  "not engine enforcement",
  "(g-248 not wired)",
  "must not bypass the `delivered` human gate",
];

/** 指南检查器：返回缺口列表（空＝通过）；抽成纯函数以便负向对照在内存里重放同一判定。 */
function guideGaps(zh: string, en: string): string[] {
  const gaps: string[] = [];
  for (const t of ZH_TOKENS) if (!zh.includes(t)) gaps.push(`zh 指南缺片段：「${t}」`);
  for (const t of EN_TOKENS) if (!en.includes(t)) gaps.push(`en 指南缺片段：「${t}」`);
  if (zh.split("\n").length !== en.split("\n").length) gaps.push("zh/en 指南行数不等");
  const levels = (t: string) => JSON.stringify((t.match(/^#{1,6} /gm) ?? []).map((h) => h[0]));
  if (levels(zh) !== levels(en)) gaps.push("zh/en 指南标题层级序列不一致");
  return gaps;
}

test("g-311 判据 4：指南 zh/en 同含分级评审小节（三值/四项命令/150 行/strict 触发/边界如实标注）", () => {
  const zh = readFileSync(ZH_GUIDE, "utf8");
  const en = readFileSync(EN_GUIDE, "utf8");
  const gaps = guideGaps(zh, en);
  assert.deepEqual(gaps, [], gaps.join("\n"));
  // 插在「审查分级与收敛规则」段末：新标题紧跟在共享基础设施条目之后
  assert.ok(
    zh.indexOf("#### 分级评审与机器快速放行") > zh.indexOf("#### 审查分级与收敛规则") &&
      zh.indexOf("#### 分级评审与机器快速放行") < zh.indexOf("#### 测试力度分级"),
    "zh 新小节必须落在「审查分级与收敛规则」段末",
  );
  assert.ok(
    en.indexOf("#### Graded Review and Machine Fast Track") > en.indexOf("#### Review Grading and Convergence Rules") &&
      en.indexOf("#### Graded Review and Machine Fast Track") < en.indexOf("#### Test Intensity Tiers"),
    "en 新小节必须落在同一位置",
  );
});

test("g-311 判据 4 负向对照：删掉指南任一片段即红（内存定点破坏，真实文件逐字节未变）", () => {
  const zh = readFileSync(ZH_GUIDE, "utf8");
  const en = readFileSync(EN_GUIDE, "utf8");
  assert.deepEqual(guideGaps(zh, en), [], "对照组：未破坏时必须零缺口");
  const drop = (text: string, token: string) => text.split(token).join("");
  for (const token of ZH_TOKENS) {
    assert.ok(guideGaps(drop(zh, token), en).length > 0, `删掉「${token}」后必须报红`);
  }
  for (const token of EN_TOKENS) {
    assert.ok(guideGaps(zh, drop(en, token)).length > 0, `en 删掉「${token}」后必须报红`);
  }
  assert.ok(guideGaps(zh, `${en}\nextra line\n`).length > 0, "en 多一行后行数不变量必须报红");
  assert.equal(readFileSync(ZH_GUIDE, "utf8"), zh, "负向对照不得污染真实指南");
  assert.equal(readFileSync(EN_GUIDE, "utf8"), en, "负向对照不得污染真实指南");
});

// ---------------------------------------------------------------------------
// 插件层接线（工具 + REST 端点）：证明 host 真的把 fast_track/machine_report 透传下去了
// 本段读 dist/（apply 来自投递副本），运行前需先 `bash scripts/build.sh`（与其余 dist 断言同款）。
// ---------------------------------------------------------------------------

function hostHarness(root: string) {
  const registered: any[] = [];
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (d: any) => { registered.push(d); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  const byName = new Map(registered.map((d) => [d.name, d]));
  const exec = { agent: undefined, signal: new AbortController().signal };
  const callTool = (name: string, args: Record<string, unknown>) => byName.get(name)!.execute(args, exec);
  return { byName, routes, callTool };
}

function fakeResponse() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}

async function postRoute(routes: Map<string, any>, path: string, body: unknown) {
  const handler = routes.get(path);
  assert.ok(handler, `路由 ${path} 必须已注册`);
  const req: any = { method: "POST", _l: {} as Record<string, (v?: any) => void>, on(ev: string, cb: (v?: any) => void) { req._l[ev] = cb; } };
  const res = fakeResponse();
  const p = handler(req, res);
  req._l.data?.(JSON.stringify(body));
  req._l.end?.();
  await p;
  return { code: res._code, body: res._body };
}

test("g-311 判据 3：host graph_resolve_accept 透传 fast_track/machine_report 并回传 fast_track 标记", async () => {
  const { root, goal, file } = fixture({ type: "patch" });
  const { byName, callTool } = hostHarness(root);
  const def = byName.get("graph_resolve_accept")!;
  assert.deepEqual(
    Object.keys(def.parameters.properties).sort(),
    ["fast_track", "force", "goal", "machine_report", "objection", "reason", "verdict"],
    "工具参数白名单必须含新增的可选参数（additionalProperties=false）",
  );
  const out = await callTool("graph_resolve_accept", { goal, verdict: "accept", fast_track: true, machine_report: greenReport() });
  assert.deepEqual(JSON.parse(JSON.stringify(out)), { ok: true, fast_track: true }, "工具输出必须无损且带 fast_track 标记");
  assert.equal(statusOf(file), "delivered");
  const ft = eventsOf(root, goal, "review.fast_track");
  assert.equal(ft.length, 1);
  assert.equal((ft[0].details as any).baseline, "86b2c2b");

  // 负向：门禁失效经工具层同样拒绝，且零副作用（工具 execute 为同步包装，异常同步抛出）
  const bad = fixture({ type: "patch" });
  const h2 = hostHarness(bad.root);
  assert.throws(
    () => h2.callTool("graph_resolve_accept", { goal: bad.goal, verdict: "accept", fast_track: true, machine_report: greenReport({ typecheck: { exit_code: 1 } }) }),
    /fast_track 被拒/,
  );
  assert.equal(statusOf(bad.file), "review");
  assert.equal(eventsOf(bad.root, bad.goal, "review.fast_track").length, 0);
});

test("g-311 判据 3：host REST /resolve-accept 同样透传（200 放行 / 400 拒绝）", async () => {
  const { root, goal, file } = fixture({ type: "patch" });
  const { routes } = hostHarness(root);
  const ok = await postRoute(routes, "/api/dsh-graph/resolve-accept", { goal, verdict: "accept", fast_track: true, machine_report: greenReport() });
  assert.equal(ok.code, 200);
  assert.deepEqual(ok.body, { ok: true });
  assert.equal(statusOf(file), "delivered");

  const bad = fixture({ type: "patch" });
  const h2 = hostHarness(bad.root);
  const rejected = await postRoute(h2.routes, "/api/dsh-graph/resolve-accept", {
    goal: bad.goal, verdict: "accept", fast_track: true, machine_report: greenReport({ untracked_files: 1 }),
  });
  assert.equal(rejected.code, 400);
  assert.match(String(rejected.body.error), /fast_track 被拒/);
  assert.equal(statusOf(bad.file), "review");
  assert.equal(eventsOf(bad.root, bad.goal, "review.passed").length, 0);
});

test("g-311 判据 1：host graph_get_settings 下发 review.policy 取值提示与读回值", async () => {
  const { root, goal } = fixture({ type: "patch" });
  writeProjectConfig(root, { review: { policy: "strict" } }, "human:gui");
  const { callTool } = hostHarness(root);
  const out: any = await callTool("graph_get_settings", {});
  assert.deepEqual(out.schema_hints["review.policy"].values, ["auto", "strict", "none"]);
  assert.equal(out.config.review.policy, "strict");
  assert.equal(typeof goal, "string");
});
