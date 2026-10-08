/**
 * g-438：v0.19.8「**保留**目标类型派生默认评审策略」裁决的**最终兼容核验**（零产品改动）。
 *
 * 本文件不是新放行逻辑，而是把「裁决在合并态仍成立」变成**可执行断言**（判据 1–4 的证据面）：
 *
 *  - 判据 2 → 未配置 `review.policy` 时类型派生表**逐项实测**（公共 API `resolveReviewPolicy`）：
 *             `patch`/`chore` ⇒ `auto`(source=`type_default`)；
 *             `feature`/`bug`/`task`/`improvement` ⇒ `strict`(`type_or_policy_strict`)；
 *             `""`/`null`/`undefined`/未知类型 ⇒ `strict`（fail-safe）；
 *             显式 `auto`/`none`/`strict` ⇒ `source=explicit`（含与缺省对照）；
 *  - 判据 3 → 与 g-435 的交互：已登记区域 + `auto` ⇒ 不升级；未登记区域 + `auto` ⇒
 *             `unknown_region` 安全升级 `strict`；`regions: []`（非法，fail-closed）与
 *             `contract_paths: []` / `non_product_prefixes: []`（合法）口径未变；
 *             与 g-437 的交互：`fast_track` 仍要求 `machine_report.attempt`，且报告 baseline
 *             必须等于**引擎锚点**（诚实放行 / 自选基线拒绝）——只抽查这两条契约；
 *  - 判据 3（关键）→ **没有**「默认 auto」也**没有**「reviewer 硬门禁」：
 *             (a) 空 root 的 `review.policy` 为 `null`（未配置，不注入 auto）；
 *             (b) `defaults.review.reviewer=human` + `policy` 派生 auto + 诚实报告 ⇒ **仍放行**；
 *             (c) 结构性核验 `resolveReviewPolicy` 的生产调用点与唯一拒绝点，证明
 *                 「strict 的**阻断性**消费点仍是 fast_track 准入」；
 *  - 判据 4 → 既有整台套件（`node scripts/run-tests.mjs`）全绿为门禁，本文件只补证据面。
 *
 * 反自我满足：类型表与区域判定的断言全部打在**公共 API 的返回值**上；fast_track 断言走**真 Git 夹具**
 * （真仓库 + 真 attempt 工作树 + 真 attempt 记录 + 诚实报告，`fixtures/fast-track-fixture.ts`）；
 * 结构性断言只读**产品源码文本**（不复制第二份判定逻辑）。
 *
 * 边界（如实声明）：「本仓库自身的 project.yaml（core 已登记 + reviewer=human）」的核对以
 * `repoProject*` 常量**镜像**配置值做行为断言；对真实 `.dsh-graph/project.yaml` 的只读探针在
 * 交付证据里单独给出（本文件保持 hermetic，不依赖开发机看板目录是否存在）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createGoal,
  findGoalFile,
  init,
  loadGoal,
  readProjectConfig,
  resolveAccept,
  saveGoal,
  setCriteria,
  writeProjectConfig,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import {
  DEFAULT_NON_PRODUCT_PREFIXES,
  DEFAULT_REVIEW_REGIONS,
  REVIEW_LIST_FIELDS,
  REVIEW_POLICIES,
  effectiveNonProductPrefixesOf,
  normalizeReviewPolicy,
  resolveReviewPolicy,
  typeDefaultReviewPolicy,
} from "../review-policy.ts";
import { CRITERIA_VERIFIED_MARK } from "../model.ts";
import { GraphError } from "../machine.ts";
import { makeFastTrackFixture } from "./fixtures/fast-track-fixture.ts";

const repoRoot = join(import.meta.dirname, "../..");
const VERIFIED = CRITERIA_VERIFIED_MARK;

/** 合法类型的期望派生（评审策略真源）。 */
const AUTO_TYPES = ["patch", "chore"] as const;
const STRICT_TYPES = ["feature", "bug", "task", "improvement"] as const;

/**
 * **本仓库 `.dsh-graph/project.yaml` 的有效配置镜像**（g-435 显式校准的登记值）。
 * 只用于行为断言；真实文件的只读探针在交付证据中单独给出。
 */
const repoProjectRegions = ["core", "dsh-graph-host", "dsh-graph-host/lib/client", "dsh-graph-host/prompts", "scripts"];
const repoProjectContractPaths = ["core/schema.ts", "schema/SCHEMA.md"];
const repoProjectNonProductPrefixes = ["core/tests", "dist", "core-dist", "node_modules", ".worktrees"];

/** 建一个干净的看板 root（无 project.yaml），目标置 review 状态并登记已验判据。 */
function plainFixture(type: string) {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g438-"));
  init(root);
  const goal = createGoal(root, { title: "g438 fixture", version: "v-test", type, actor: "t" });
  setCriteria(root, goal, [`全量测试全绿 ${VERIFIED}`, `无回归 ${VERIFIED}`], "t");
  const file = findGoalFile(root, goal);
  const doc = loadGoal(file);
  saveGoal(file, { meta: { ...doc.meta, status: "review" }, body: doc.body });
  return { root, goal, file };
}

const statusOf = (file: string) => String(loadGoal(file).meta.status ?? "");
const eventsOf = (root: string, goal: string, name: string) =>
  readEvents(root).filter((e) => e.goal === goal && e.event === name);

// ---------------------------------------------------------------------------
// 判据 2：未配置 review.policy 时的类型派生表（逐项实测，公共 API）
// ---------------------------------------------------------------------------

test("g-438 判据2：未配置 policy 时 patch/chore ⇒ auto(type_default)、其余合法类型 ⇒ strict(type_or_policy_strict)", () => {
  for (const t of AUTO_TYPES) {
    const d = resolveReviewPolicy({ policy: null, type: t });
    assert.equal(d.policy, "auto", `${t} 应派生 auto（实测 ${d.policy}）`);
    assert.equal(d.source, "type_default", `${t} 的来源必须是类型派生`);
    assert.deepEqual(d.strictReasons, [], `${t} 不得带任何升级理由`);
    // 逐项与单一入口 typeDefaultReviewPolicy 同源
    assert.equal(typeDefaultReviewPolicy(t), "auto", `${t} 的派生真源必须同为 auto`);
  }
  for (const t of STRICT_TYPES) {
    const d = resolveReviewPolicy({ policy: null, type: t });
    assert.equal(d.policy, "strict", `${t} 应派生 strict（实测 ${d.policy}）`);
    assert.equal(d.source, "type_default", `${t} 的来源必须是类型派生`);
    assert.deepEqual(d.strictReasons, ["type_or_policy_strict"], `${t} 的升级理由`);
    assert.equal(typeDefaultReviewPolicy(t), "strict", `${t} 的派生真源必须同为 strict`);
  }
  // 缺省形态一：整个 input 省略（等价于「未配置 + 无 type」）
  const bare = resolveReviewPolicy();
  assert.equal(bare.policy, "strict", "无入参 ⇒ fail-safe strict");
  assert.equal(bare.source, "type_default");
  assert.deepEqual(bare.strictReasons, ["type_or_policy_strict"]);
  // 缺省形态二：显式传 `policy: undefined`（字段存在但无值）与 `null` 同口径
  const nullForm = resolveReviewPolicy({ policy: null, type: "task" });
  const undefForm = resolveReviewPolicy({ policy: undefined, type: "task" });
  assert.deepEqual(undefForm, nullForm, "policy 为 undefined 与 null 必须逐字同口径");
});

test("g-438 判据2：缺失 / 空串 / 未知类型一律 fail-safe 派生 strict（大小写与空白归一化不放松）", () => {
  const failSafe: unknown[] = ["", null, undefined, "unknown-type", "patched", "chores", 0, {}, [], "  ", "auto"];
  for (const t of failSafe) {
    const raw = resolveReviewPolicy({ policy: null, type: t as any });
    assert.equal(raw.policy, "strict", `不可判定类型必须安全侧兜底 strict：${JSON.stringify(t)}`);
    assert.equal(raw.source, "type_default", `fail-safe 仍走类型派生来源：${JSON.stringify(t)}`);
    assert.equal(typeDefaultReviewPolicy(t), "strict", `派生真源兜底 strict：${JSON.stringify(t)}`);
  }
  // 大小写 / 空白归一化：合法类型不因书写形态改判
  const norm = [
    ["PATCH", "auto"], [" Chore ", "auto"],
    ["FEATURE", "strict"], [" Task ", "strict"], ["Improvement", "strict"], ["BUG", "strict"],
  ] as const;
  for (const [t, expect] of norm) {
    assert.equal(resolveReviewPolicy({ policy: null, type: t }).policy, expect, `${JSON.stringify(t)} ⇒ ${expect}`);
  }
});

test("g-438 判据2：显式 auto/none/strict ⇒ source=explicit（并与缺省类型派生逐项对照）", () => {
  for (const p of REVIEW_POLICIES) {
    // 用一个「派生方向相反」的类型，证明显式值真的压过类型默认
    const t = p === "strict" ? "chore" : "task";
    const d = resolveReviewPolicy({ policy: p, type: t });
    assert.equal(d.policy, p, `显式 policy=${p} 必须生效`);
    assert.equal(d.source, "explicit", `显式 policy=${p} 的来源必须是 explicit`);
    if (p === "strict") assert.deepEqual(d.strictReasons, ["type_or_policy_strict"], "显式 strict 的理由");
    else assert.deepEqual(d.strictReasons, [], `显式 ${p} 无升级理由`);
    // 对照：同类型未配置时是类型派生（task ⇒ strict / chore ⇒ auto）
    const derived = resolveReviewPolicy({ policy: null, type: t });
    assert.equal(derived.source, "type_default", "对照组的来源必须是 type_default");
    assert.notEqual(
      `${derived.policy}/${derived.source}`,
      `${d.policy}/${d.source}`,
      `显式值与类型派生的对照必须可区分（${p} vs ${t}）`,
    );
  }
});

test("g-438 判据2：写侧仍拒绝三值之外的取值（读宽写严的已知口径不对称如实钉住）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g438-schema-"));
  try {
    init(root);
    // 先落一个合法值让 project.yaml 存在（拒绝用例要断言「文件逐字节不变」）
    writeProjectConfig(root, { review: { policy: "none" } }, "t");
    const confFile = join(root, "project.yaml");
    // 写侧：大小写不符 / 空串 / 未知取值一律拒绝（不得静默归一化）
    for (const raw of ["AUTO", "Auto", "", "fast"]) {
      const before = readFileSync(confFile, "utf8");
      assert.throws(
        () => writeProjectConfig(root, { review: { policy: raw } }, "t"),
        (e: unknown) => e instanceof GraphError && /review\.policy/.test((e as Error).message),
        `写侧必须拒绝 ${JSON.stringify(raw)}`,
      );
      assert.equal(readFileSync(confFile, "utf8"), before, `拒绝必须零副作用（${JSON.stringify(raw)}）`);
    }
    // 读侧归一化：`AUTO` 被 normalize 为合法 auto（读宽写严，已知不对称、非绕过路径）
    assert.equal(normalizeReviewPolicy("AUTO"), "auto", "读侧归一化口径（已知不对称，留档）");
    assert.equal(resolveReviewPolicy({ policy: "AUTO", type: "task" }).policy, "auto", "读侧 AUTO 归一为 auto");
    // 写侧三值往返（合法值不被拒绝）
    for (const p of REVIEW_POLICIES) {
      writeProjectConfig(root, { review: { policy: p } }, "t");
      assert.equal(readProjectConfig(root).review.policy, p, `${p} 往返`);
    }
    // 清空 ⇒ 回到「未配置」（null），不是 auto
    writeProjectConfig(root, { review: { policy: null } }, "t");
    assert.equal(readProjectConfig(root).review.policy, null, "清空后必须回到未配置(null)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 判据 3：与 g-435 的交互（区域登记是安全升级源，不是放行源）
// ---------------------------------------------------------------------------

test("g-438 判据3：g-435 交互——已登记区域 + auto ⇒ auto；未登记区域 + auto ⇒ unknown_region 升级 strict", () => {
  // 普适默认区域（DEFAULT_REVIEW_REGIONS）下：`src/` 已登记 ⇒ 不升级
  const registered = resolveReviewPolicy({ policy: "auto", type: "patch", changedPaths: ["src/a.ts"] });
  assert.equal(registered.policy, "auto", "已登记区域 + auto 不得被升级");
  assert.deepEqual(registered.strictReasons, []);
  assert.ok(DEFAULT_REVIEW_REGIONS.includes("src"), "前提：普适默认已登记 src");

  // 未登记区域的产品代码 ⇒ 安全升级（g-435 的核心缺口修复）
  const unknown = resolveReviewPolicy({ policy: "auto", type: "patch", changedPaths: ["weird/x.ts"] });
  assert.equal(unknown.policy, "strict", "未登记区域 + auto 必须升级 strict");
  assert.deepEqual(unknown.strictReasons, ["unknown_region"], "升级理由必须是 unknown_region");

  // 本仓库配置镜像：已登记 ⇒ auto；未登记 ⇒ strict
  const repoCore = resolveReviewPolicy({
    policy: "auto", type: "patch", changedPaths: ["core/ops.ts"],
    regions: repoProjectRegions, contractPaths: repoProjectContractPaths, nonProductPrefixes: repoProjectNonProductPrefixes,
  });
  assert.equal(repoCore.policy, "auto", "core 已登记 ⇒ 不升级");
  const repoUnknown = resolveReviewPolicy({
    policy: "auto", type: "patch", changedPaths: ["unregistered-area/tool.ts"],
    regions: repoProjectRegions, contractPaths: repoProjectContractPaths, nonProductPrefixes: repoProjectNonProductPrefixes,
  });
  assert.equal(repoUnknown.policy, "strict", "未登记区域 ⇒ strict");
  assert.deepEqual(repoUnknown.strictReasons, ["unknown_region"]);

  // 非产品码（core/tests 前缀、.md）中性：既不算未知区域，也不算升级源
  const repoTests = resolveReviewPolicy({
    policy: "auto", type: "patch", changedPaths: ["core/tests/g438-review-policy-final-verification.test.ts"],
    regions: repoProjectRegions, contractPaths: repoProjectContractPaths, nonProductPrefixes: repoProjectNonProductPrefixes,
  });
  assert.equal(repoTests.policy, "auto", "core/tests 属非产品码 ⇒ 不触发 unknown_region");
  const docs = resolveReviewPolicy({ policy: "auto", type: "patch", changedPaths: ["README.md"], regions: repoProjectRegions });
  assert.equal(docs.policy, "auto", ".md 属非产品码 ⇒ 保持 auto");

  // 契约路径（M1）优先于区域判定，仍升级 strict
  const contract = resolveReviewPolicy({
    policy: "auto", type: "patch", changedPaths: ["core/schema.ts"],
    regions: repoProjectRegions, contractPaths: repoProjectContractPaths, nonProductPrefixes: repoProjectNonProductPrefixes,
  });
  assert.equal(contract.policy, "strict", "契约路径 + auto ⇒ strict");
  assert.deepEqual(contract.strictReasons, ["contract_change"]);

  // M2（≥150 行）仍独立生效 —— 类型派生不是唯一升级源
  const big = resolveReviewPolicy({ policy: "auto", type: "patch", changedPaths: ["scripts/run.sh"], productChangedLines: 150 });
  assert.equal(big.policy, "strict", "≥150 行产品码 ⇒ M2 升级");
  assert.deepEqual(big.strictReasons, ["product_size"]);
  assert.equal(
    resolveReviewPolicy({ policy: "auto", type: "patch", changedPaths: ["scripts/run.sh"], productChangedLines: 149 }).policy,
    "auto",
    "149 行仍在门禁阈值内",
  );

  // M3：跨 ≥3 个已登记区域 ⇒ strict（只计产品码）
  const cross = resolveReviewPolicy({
    policy: "auto", type: "patch", changedPaths: ["core/a.ts", "scripts/b.sh", "dsh-graph-host/c.ts"],
    regions: repoProjectRegions, contractPaths: repoProjectContractPaths, nonProductPrefixes: repoProjectNonProductPrefixes,
  });
  assert.equal(cross.policy, "strict", "跨 3 区域 ⇒ strict");
  assert.deepEqual(cross.strictReasons, ["cross_region"]);
});

test("g-438 判据3：regions: [] 非法（fail-closed 升级）而 contract_paths/non_product_prefixes 的 [] 合法且与未配置区分", () => {
  // regions 显式空列表：无可评估区域 ⇒ fail-closed 升级（口径未变）
  const emptyRegions = resolveReviewPolicy({ policy: "auto", type: "patch", regions: [] });
  assert.equal(emptyRegions.policy, "strict", "regions: [] 必须 fail-closed 升级 strict");
  assert.deepEqual(emptyRegions.strictReasons, ["cross_region"]);
  assert.ok(emptyRegions.reasons.length > 0, "升级理由必须有可读文案");

  // contract_paths / non_product_prefixes 的 [] 合法：不产生 policy_unrecognized，且**真的生效**
  const legalEmpty = resolveReviewPolicy({
    policy: "auto", type: "patch", changedPaths: ["dist/a.js"], regions: ["src"],
    contractPaths: [], nonProductPrefixes: [],
  });
  assert.equal(legalEmpty.policy, "strict", "nonProductPrefixes: [] ⇒ dist 也算产品码 ⇒ 未登记区域升级");
  assert.deepEqual(legalEmpty.strictReasons, ["unknown_region"]);
  const unsetPrefixes = resolveReviewPolicy({ policy: "auto", type: "patch", changedPaths: ["dist/a.js"], regions: ["src"] });
  assert.equal(unsetPrefixes.policy, "auto", "未配置 non_product_prefixes ⇒ dist 被普适默认排除");
  assert.deepEqual(unsetPrefixes.strictReasons, []);
  // 显式 [] 与未配置在**有效值**上可区分（dist/node_modules/.worktrees 默认排除项）
  assert.deepEqual(effectiveNonProductPrefixesOf([]), [], "显式 [] 的有效值必须是空");
  assert.deepEqual([...effectiveNonProductPrefixesOf(null)], [...DEFAULT_NON_PRODUCT_PREFIXES], "未配置 ⇒ 普适默认");

  // 字段级 allowEmpty 真源未变
  const spec = Object.fromEntries(REVIEW_LIST_FIELDS.map((s) => [s.key, s]));
  assert.equal(spec.regions.allowEmpty, false, "regions 不允许显式空列表");
  assert.equal(spec.contract_paths.allowEmpty, true, "contract_paths 允许显式空列表");
  assert.equal(spec.non_product_prefixes.allowEmpty, true, "non_product_prefixes 允许显式空列表");
});

// ---------------------------------------------------------------------------
// 判据 3：与 g-437 的交互（只抽查两条契约：attempt 必填 + 锚点必须是引擎侧）
// ---------------------------------------------------------------------------

test("g-438 判据3：fast_track 仍要求 machine_report.attempt（缺失 ⇒ 拒绝且文案可操作）", () => {
  const f = makeFastTrackFixture({ type: "patch", omitAttempt: true });
  try {
    const before = readEvents(f.root).length;
    assert.throws(
      () => resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report() }),
      (e: unknown) => {
        if (!(e instanceof GraphError)) return false;
        const m = (e as Error).message;
        return /必须显式给出 attempt/.test(m) && /graph_start_attempt/.test(m) && /att-001/.test(m);
      },
      "缺 attempt 必须以可操作文案拒绝（点名字段 + graph_start_attempt + 形态示例）",
    );
    assert.equal(statusOf(f.file), "review", "状态不变");
    assert.equal(eventsOf(f.root, f.goal, "review.fast_track").length, 0, "不得记 fast_track");
    assert.equal(readEvents(f.root).length, before, "零副作用");
  } finally {
    f.dispose();
  }
});

test("g-438 判据3：fast_track 的报告 baseline 必须等于引擎锚点（诚实放行 / 自选基线拒绝）", () => {
  // 诚实报告：放行，且事件里的基线就是引擎锚点（= 派发时的工作树起点）
  const ok = makeFastTrackFixture({ type: "patch" });
  try {
    assert.notEqual(ok.head, ok.baseline, "前提：attempt HEAD 必须不同于基线");
    const r = resolveAccept(ok.root, ok.goal, {
      actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: ok.report(),
    });
    assert.deepEqual(r, { ok: true, fast_track: true }, "诚实报告必须放行");
    const ft = eventsOf(ok.root, ok.goal, "review.fast_track");
    assert.equal(ft.length, 1);
    const d = ft[0].details as Record<string, any>;
    assert.equal(d.baseline, ok.baseline, "事件基线 = 引擎锚点");
    assert.equal(d.policy_source, "type_default", "patch 未配置策略 ⇒ 来源为类型派生");
  } finally {
    ok.dispose();
  }

  // 报告自选基线（取自己的 HEAD，等价于自我归零）⇒ 拒绝且零副作用
  const selfCho = makeFastTrackFixture({ type: "patch" });
  try {
    const before = readEvents(selfCho.root).length;
    assert.throws(
      () => resolveAccept(selfCho.root, selfCho.goal, {
        actor: "supervisor:test", verdict: "accept", fast_track: true,
        machine_report: selfCho.report({ baseline_commit: selfCho.head }),
      }),
      (e: unknown) => e instanceof GraphError && /与 attempt 持久化基线\/工作树 head/.test((e as Error).message),
      "报告基线取到自己的 HEAD 必须拒绝",
    );
    assert.equal(statusOf(selfCho.file), "review", "状态不变");
    assert.equal(eventsOf(selfCho.root, selfCho.goal, "review.fast_track").length, 0, "不得记 fast_track");
    assert.equal(readEvents(selfCho.root).length, before, "零副作用");
  } finally {
    selfCho.dispose();
  }
});

// ---------------------------------------------------------------------------
// 判据 3（关键）：没有「默认 auto」，也没有「reviewer 硬门禁」
// ---------------------------------------------------------------------------

test("g-438 判据3：未配置 review.policy 时读回 null（不得注入默认 auto）", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g438-null-"));
  try {
    init(root);
    const conf = readProjectConfig(root);
    assert.equal(conf.review.policy, null, "未配置必须是 null（「未配置」与「auto」可区分）");
    assert.notEqual(conf.review.policy, "auto", "绝不能有默认 auto");
    // 项目缺省之下，随手建的目标（task）仍是 strict
    const goal = createGoal(root, { title: "default-type", version: "v-test", actor: "t" });
    const file = findGoalFile(root, goal);
    assert.equal(loadGoal(file).meta.type, "task", "未传 type ⇒ task");
    assert.equal(
      resolveReviewPolicy({ policy: conf.review.policy, type: loadGoal(file).meta.type }).policy,
      "strict",
      "未配置 + 默认 task ⇒ strict（现行派生语义）",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("g-438 判据3：defaults.review.reviewer=human 不是 fast_track 阻断（诚实报告仍放行）", () => {
  const f = makeFastTrackFixture({
    type: "patch",
    projectConfig: { defaults: { review: { reviewer: "human" } } },
  });
  try {
    // 前提：配置确实是 reviewer=human，且 policy 仍未配置 ⇒ 派生 auto
    const conf = readProjectConfig(f.root);
    assert.equal(conf.defaults.review.reviewer, "human", "前提：reviewer=human 已落盘");
    assert.equal(conf.review.policy, null, "前提：policy 未配置");
    assert.equal(
      resolveReviewPolicy({ policy: conf.review.policy, type: "patch" }).policy,
      "auto",
      "前提：patch ⇒ 派生 auto",
    );
    // 与不配 reviewer 的同型夹具逐字同结果 ⇒ reviewer 不参与 fast_track 准入
    const r = resolveAccept(f.root, f.goal, {
      actor: "supervisor:test", verdict: "accept", fast_track: true, machine_report: f.report(),
    });
    assert.deepEqual(r, { ok: true, fast_track: true }, "reviewer=human 不得阻断 fast_track");
    assert.equal(statusOf(f.file), "delivered", "放行后走同一 accept 映射");
    const ft = eventsOf(f.root, f.goal, "review.fast_track");
    assert.equal(ft.length, 1, "记入 fast_track 事件");
    assert.ok(
      !/reviewer/i.test(JSON.stringify(ft[0].details)),
      "fast_track 事件不得含 reviewer 相关字段（无联动）",
    );
  } finally {
    f.dispose();
  }
});

test("g-438 判据3：普通 accept 不受 strict 阻断（strict 只影响可见标注，不放行/不阻断）", () => {
  for (const type of ["task", "feature"] as const) {
    const f = plainFixture(type);
    try {
      const decision = resolveReviewPolicy({ policy: readProjectConfig(f.root).review.policy, type });
      assert.equal(decision.policy, "strict", `前提：${type} 派生 strict`);
      const r = resolveAccept(f.root, f.goal, { actor: "supervisor:test", verdict: "accept" });
      assert.deepEqual(r, { ok: true }, `${type}：普通 accept 必须成功（strict 不阻断）`);
      assert.equal(statusOf(f.file), "delivered", `${type}：走既有 accept 映射`);
      assert.equal(eventsOf(f.root, f.goal, "review.fast_track").length, 0, `${type}：不得走快速通道`);
      assert.equal(eventsOf(f.root, f.goal, "review.passed").length, 1, `${type}：人工路径留痕`);
      // strict 的实际效果 = 一条**不阻断**的可见标注（g-436）
      assert.equal(eventsOf(f.root, f.goal, "review.independent_missing").length, 1, `${type}：可见标注`);
      assert.ok(!eventsOf(f.root, f.goal, "review.fast_track").length, `${type}：无快速通道事件`);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("g-438 判据3（结构）：resolveReviewPolicy 生产调用点恰为 2 处，唯一阻断点是 fast_track 准入", () => {
  const opsSrc = readFileSync(join(repoRoot, "core/ops.ts"), "utf8");

  // 生产调用点：① goalReviewState（可见化投影）② resolveAccept 的 fast_track 分支（准入）
  const calls = [...opsSrc.matchAll(/resolveReviewPolicy\(/g)];
  assert.equal(calls.length, 2, `resolveReviewPolicy 的生产调用点必须恰为 2 处（实测 ${calls.length}）`);

  // 唯一「策略不满足即拒绝」的判定
  const denials = [...opsSrc.matchAll(/policy\.policy !== "auto"/g)];
  assert.equal(denials.length, 1, `唯一拒绝点必须恰为 1 处（实测 ${denials.length}）`);

  const acceptStart = opsSrc.indexOf("export function resolveAccept");
  const acceptEnd = opsSrc.indexOf("function applyAcceptMapping");
  assert.ok(acceptStart > 0 && acceptEnd > acceptStart, "前提：能定位 resolveAccept 主体");
  const acceptSrc = opsSrc.slice(acceptStart, acceptEnd);
  const ftAt = acceptSrc.indexOf("if (opts.fast_track)");
  assert.ok(ftAt > 0, "前提：能定位 fast_track 分支");
  const preFastTrack = acceptSrc.slice(0, ftAt);
  const ftBlock = acceptSrc.slice(ftAt);

  // 非 fast_track 路径不得消费 policy（普通 accept 不过问策略）
  assert.ok(!/policy/i.test(preFastTrack), "resolveAccept 的非 fast_track 路径不得消费 policy");
  assert.ok(!/reviewer/i.test(preFastTrack), "resolveAccept 的非 fast_track 路径不得消费 reviewer");
  // fast_track 分支不得消费 reviewer / defaults.review（无 reviewer 硬门禁）
  assert.ok(!/reviewer/i.test(ftBlock), "fast_track 分支不得消费 reviewer（无硬门禁）");
  assert.ok(!/defaults\.review/.test(ftBlock), "fast_track 分支不得消费 defaults.review");
  // 唯一拒绝点落在 fast_track 分支内
  assert.equal([...ftBlock.matchAll(/policy\.policy !== "auto"/g)].length, 1, "唯一拒绝点必须位于 fast_track 分支");

  // 拒绝点之前不得有任何事件写入（准入前置、零副作用）——拒绝语句出现在 appendEvent 之前
  const denialAt = ftBlock.indexOf('policy.policy !== "auto"');
  assert.ok(ftBlock.indexOf("review.fast_track") > denialAt, "fast_track 事件写入必须在策略准入之后");
});
