/**
 * core/tests/g421-nested-runner-negative-verdict.test.ts
 *
 * g-421（v0.19.7 lane）：**负向裁决** helper 缺目标覆盖/事件通道 —— 终局 codex 复核在 tip `ae1414c`
 * 上实测的 P1（false-positive test evidence，非蓄意破坏即可达成）：
 *
 *   `core/tests/fixtures/nested-runner.ts` 的 `assertNestedSuiteFailed`（**负向变异对照**专用）
 *   只核 `run.code !== 0` + 输出正则，**不核目标覆盖/事件通道**。最小实测：夹具打印 sentinel、
 *   注册 `assert.fail(sentinel)` 后**立即 `process.exit(1)`** ⇒ `code 1 / tests 1 / fail 1` 但
 *   **`channel.files = []`**（断言**从未执行**），helper **仍然接受** ⇒ 「进程早退」冒充「预期失败」。
 *
 * 本套件钉死修复（全部 **fail-closed、无 opt-out**）：
 *   ① 精确 repro（`fixtures/g421/exit-before-assert.test.ts`）⇒ **拒绝**，红因点名「完成事件」并说明
 *      「失败不是由目标文件真实测试断言产生的可能」；
 *   ② 其它「无完成事件」形态（SIGKILL 文件进程 / SIGKILL 运行器 / 伪造汇总+早退）⇒ 一律**拒绝**；
 *   ②b **`assertNestedSuiteRan` 同样收口**（终局复核追加数据点）：它是 `g353` 两个负向对照
 *      （陈旧产物 / 漏模块）与整套件自证闸门直接消费的入口，只核「跑过」会让「非零退出 + 输出签名」
 *      的**早退伪造**冒充负向对照成立 ⇒ 现与终局裁决**同一组**证据不变式（变异对照一并钉住）；
 *   ③ 正向：真实断言失败（**有**逐文件完成事件）⇒ 仍**接受**（判别力未被削弱成恒红）；
 *   ④ **结构性守卫**：`nested-runner.ts` 全部**裁决职责**导出的调用闭包必须到达唯一证据核心
 *      `nestedEvidenceProblems`（新增裁决 helper 漏掉覆盖/通道不变式 ⇒ 本守卫变红）；导出枚举**穷举**
 *      （`function`/`async function`/`generator`/`const|let|var`），且**所有运行时导出**必须恰好登记进
 *      VERDICTS / PRECONDITIONS / PARTS / NON_VERDICT 之一 —— 未归类、重复登记、清单漂移、不支持的
 *      `export` 形态、以及「形如裁决入口却落在非裁决清单」一律 **fail-closed 判红**；
 *   ⑤ **变异对照**：私有副本摘掉新增覆盖校验 ⇒ repro **复活为被接受**（给实测 code/tests/fail/files/problems）。
 *
 * **第二轮收口（终局复核第二轮 P1：覆盖校验不足以堵住负向伪造）**：
 *   `test('assertions pass', () => {})` **良性通过** + 打印期望签名 + 模块末尾 `process.exitCode = 1`
 *   ⇒ 实测 `code 1 / tests 2 / pass 1 / fail 1 / files=1`（那 1 个 `fail` 只是 Node 为**文件进程**非零退出
 *   合成的「**文件包装**失败」，`details.error` 带 `exitCode`/`signal`），**本该失败的断言从未执行**。
 *   故负向裁决现在还要求：事件通道里**确有 test/subtest 级真实失败事件**（
 *   `nestedTestLevelFailures`：`details.type === "test"` 且不带进程级 `exitCode`/`signal`），
 *   且（传入签名时）**该失败事件文本匹配签名**。为此 `scripts/test-reporter-events.mjs` **加法式**新增
 *   `{"type":"failure",…}` 实体级记录（summary/tally 语义不变），由 `parseEventChannel` 收进
 *   `channel.failures`。对应用例：`fixtures/g421/wrap-failure.test.ts` 精确 repro ⇒ 拒绝；
 *   真实 test 级 `assert.fail(<签名>)` ⇒ 接受；**签名不匹配**的真实失败 ⇒ 拒绝；
 *   变异对照（摘掉 test 级失败要求）⇒ wrap repro 复活为被接受。
 *
 * 负向夹具都在 `fixtures/g421/`（不被顶层 glob `core/tests/*.test.ts` 误收）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  NESTED_EVIDENCE_PARTS,
  NESTED_EVIDENCE_PRECONDITIONS,
  NESTED_EVIDENCE_VERDICTS,
  NESTED_NON_VERDICT_EXPORTS,
  assertNestedSuiteFailed,
  assertNestedSuitePassed,
  assertNestedSuiteRan,
  nestedSuiteFailedProblems,
  nestedTestLevelFailures,
  parseEventChannel,
  parseTestSummary,
  runNestedArgv,
  type NestedRunResult,
} from "./fixtures/nested-runner.ts";

const repoRoot = join(import.meta.dirname, "../..");
const TESTS_DIR = join(import.meta.dirname);
const FIXTURES = join(TESTS_DIR, "fixtures", "g421");
const G416_FIXTURES = join(TESTS_DIR, "fixtures", "g416");
const G407_FIXTURES = join(TESTS_DIR, "fixtures", "g407");
const HELPER = join(repoRoot, "core", "tests", "fixtures", "nested-runner.ts");
const REPORTER = join(repoRoot, "scripts", "test-reporter-events.mjs");
const HELPER_REL = "core/tests/fixtures/nested-runner.ts";

const EXIT_BEFORE_ASSERT = join(FIXTURES, "exit-before-assert.test.ts");
const WRAP_FAILURE = join(FIXTURES, "wrap-failure.test.ts");
const SENTINEL = "G421_EXPECTED_NEGATIVE_SENTINEL";
const WRAP_SENTINEL = "G421_WRAP_EXIT_SENTINEL";
const G407_FAIL_MARKER = "G407_ALWAYS_FAIL_MARKER";
/** 「无完成事件 / 通道不可信 / 退出码不达标」的红因特征（各形态下取其一即可）。 */
const NO_EVIDENCE_RE = /完成事件|事件通道|汇总|退出码|信号|失败/;

// ============================================================================
// 判据 1：精确 repro ⇒ 负向裁决必须拒绝（修复前该形态被接受）
// ============================================================================

test("g-421 判据1 精确 repro：sentinel + 注册 assert.fail + 立即 process.exit(1) ⇒ 必须拒绝", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", EXIT_BEFORE_ASSERT], { cwd: repoRoot });
  t.diagnostic(
    `evidence: suite=g421-repro exit=${run.code} tests=${run.summary.tests} fail=${run.summary.fail} ` +
      `files=${run.channel.files.length} summaries=${run.channel.summaries} targets=${run.targets.length}`,
  );

  // ── 复现前提（终局复核实测值）：非零退出 + 计数「看起来」像一次真实失败，但断言从未执行。
  assert.equal(run.code, 1, `repro 夹具必须 exit 1（实际 ${run.code}）`);
  assert.equal(run.summary.tests, 1, `repro 必须报 tests 1（实际 ${run.summary.tests}）`);
  assert.equal(run.summary.fail, 1, `repro 必须报 fail 1（实际 ${run.summary.fail}）`);
  assert.match(
    `${run.out}\n${run.err}`,
    new RegExp(SENTINEL),
    "sentinel 必须出现在运行输出里（否则「非零退出 + 特征」前提不成立）",
  );
  assert.equal(run.channel.files.length, 0, "断言从未执行 ⇒ **不得**有逐文件完成事件（这正是 P1 的支点）");
  assert.equal(run.targets.length, 1, "helper 必须推导出 1 个目标文件");

  // ── 修复后：负向裁决必须拒绝，且红因明确说明「失败不是由真实测试断言产生」。
  const problems = nestedSuiteFailedProblems(run, new RegExp(SENTINEL)).join("；");
  assert.match(problems, /完成事件/, `红因必须点名目标文件完成事件缺失：${problems}`);
  assert.match(
    problems,
    /真实测试断言/,
    `红因必须说明失败不是由真实测试断言产生的可能（早退/断言未执行）：${problems}`,
  );
  let refusal: Error | null = null;
  try {
    assertNestedSuiteFailed(run, "g-421 精确 repro", new RegExp(SENTINEL));
  } catch (e) {
    refusal = e as Error;
  }
  assert.ok(refusal, "assertNestedSuiteFailed 必须拒绝「早退冒充预期失败」");
  assert.match(refusal.message, /完成事件/, `拒绝信息必须点名目标文件完成事件缺失：${refusal.message}`);
  assert.match(
    refusal.message,
    /真实测试断言/,
    `拒绝信息必须说明「失败不是由真实测试断言产生」：${refusal.message}`,
  );
});

test("g-421 判据1 判别力对照：同一夹具的**正向**裁决（全绿路径）同样判红（同口径）", async () => {
  const run = await runNestedArgv(process.execPath, ["--test", EXIT_BEFORE_ASSERT], { cwd: repoRoot });
  assert.throws(
    () => assertNestedSuitePassed(run, "g-421 repro 正向路径"),
    /完成事件/,
    "正向路径早已核覆盖；负向必须与它同口径（本断言钉住「两条腿不漂移」）",
  );
});

// ============================================================================
// 判据 1（第二轮）：良性用例 + process.exitCode=1 ⇒ **覆盖校验挡不住**，必须拒绝
// ============================================================================

test("g-421 判据1 第二形态 repro：良性通过的用例 + 签名 + process.exitCode=1 ⇒ 必须拒绝", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", WRAP_FAILURE], { cwd: repoRoot });
  t.diagnostic(
    `evidence: suite=g421-wrap-repro exit=${run.code} tests=${run.summary.tests} pass=${run.summary.pass} ` +
      `fail=${run.summary.fail} files=${run.channel.files.length} failures=${run.channel.failures.length} ` +
      `test_level=${nestedTestLevelFailures(run).length}`,
  );

  // ── 复现前提：覆盖/通道**全部正常**（这正是「只核覆盖」挡不住的原因）。
  assert.equal(run.code, 1, `wrap repro 必须 exit 1（实际 ${run.code}）`);
  assert.equal(run.channel.files.length, 1, "wrap repro **有**逐文件完成事件（与早退形态的关键区别）");
  assert.equal(run.summary.pass, 1, `良性用例必须计 pass 1（实际 ${run.summary.pass}）`);
  assert.equal(run.summary.fail, 1, `失败只有文件包装那 1 条（实际 ${run.summary.fail}）`);
  assert.match(`${run.out}\n${run.err}`, new RegExp(WRAP_SENTINEL), "签名必须出现在输出里");
  assert.equal(
    nestedTestLevelFailures(run).length,
    0,
    "**关键**：没有任何 test/subtest 级真实失败事件（唯一失败是文件包装）",
  );
  assert.ok(
    run.channel.failures.some((f) => f.exitCode !== null || f.signal !== null),
    "通道里应能观测到「文件包装失败」（带进程级 exitCode/signal）——判别依据本身必须可观测",
  );

  // ── 修复后：必须拒绝，且红因点名「失败不是 test/subtest 级断言产生 / 只是文件包装」。
  const problems = nestedSuiteFailedProblems(run, new RegExp(WRAP_SENTINEL)).join("；");
  assert.doesNotMatch(problems, /完成事件/, `覆盖已满足 ⇒ 不该再报覆盖问题：${problems}`);
  assert.match(problems, /没有任何 test\/subtest 级的失败事件/, `必须点名「无 test 级失败事件」：${problems}`);
  assert.match(problems, /文件包装/, `必须说明失败只是文件包装（退出码/信号）：${problems}`);

  let refusal: Error | null = null;
  try {
    assertNestedSuiteFailed(run, "g-421 wrap repro", new RegExp(WRAP_SENTINEL));
  } catch (e) {
    refusal = e as Error;
  }
  assert.ok(refusal, "assertNestedSuiteFailed 必须拒绝「良性用例 + 改退出码」冒充如期报红");
  assert.match(
    refusal.message,
    /没有任何 test\/subtest 级的失败事件/,
    `拒绝信息必须点名「无 test 级失败事件」：${refusal.message}`,
  );
});

// ============================================================================
// 判据 1：其它「无完成事件」形态 ⇒ 一律拒绝
// ============================================================================

for (const [label, fixture] of [
  ["SIGKILL 测试文件进程（无完成事件）", join(G416_FIXTURES, "sigkill.test.ts")],
  ["SIGKILL 运行器进程（通道未收尾）", join(G416_FIXTURES, "kill-runner.test.ts")],
  ["伪造 ℹ tests 99 汇总 + 早退（无事件）", join(G416_FIXTURES, "forged-summary.test.ts")],
] as const) {
  test(`g-421 判据1：${label} ⇒ assertNestedSuiteFailed 必须拒绝`, async (t) => {
    const run = await runNestedArgv(process.execPath, ["--test", fixture], { cwd: repoRoot });
    t.diagnostic(
      `evidence: suite=g421-no-evidence form=${fixture.split("/").pop()} exit=${String(run.code)} ` +
        `files=${run.channel.files.length} tally=${run.channel.tally ? "yes" : "null"}`,
    );
    assert.throws(
      () => assertNestedSuiteFailed(run, label, /G421_NEVER_PRESENT_SIGNATURE/),
      NO_EVIDENCE_RE,
      `${label}：无完成事件/通道不可信的形态不得被负向裁决接受`,
    );
  });
}

// ============================================================================
// 判据 1（正向）：真实断言失败（有逐文件完成事件）⇒ 仍被接受
// ============================================================================

test("g-421 判据1 正向：真实断言失败的嵌套文件（有完成事件）⇒ 负向裁决必须接受", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", join(G407_FIXTURES, "always-fail.test.ts")], {
    cwd: repoRoot,
  });
  t.diagnostic(
    `evidence: suite=g421-real-failure exit=${run.code} fail=${run.summary.fail} files=${run.channel.files.length} ` +
      `test_level=${nestedTestLevelFailures(run).length}`,
  );
  assert.notEqual(run.code, 0, "真实失败必须非零退出");
  assert.ok(run.summary.fail >= 1, `必须观测到真实失败用例（fail=${run.summary.fail}）`);
  assert.equal(run.channel.files.length, 1, "真实失败的文件**必须**产出逐文件完成事件（修复不得变成恒红假守卫）");
  assert.equal(nestedTestLevelFailures(run).length, 1, "必须观测到 **1 条 test 级真实失败事件**");
  assert.match(
    `${nestedTestLevelFailures(run)[0]?.name}\n${nestedTestLevelFailures(run)[0]?.message}`,
    new RegExp(G407_FAIL_MARKER),
    "test 级失败事件的文本必须携带断言消息（签名据此匹配「预期的那个失败」）",
  );
  assert.deepEqual(
    nestedSuiteFailedProblems(run, new RegExp(G407_FAIL_MARKER)),
    [],
    "证据充分 + 非零退出 + 特征命中 + test 级失败 ⇒ 负向裁决的不达标项必须为空",
  );
  assertNestedSuiteFailed(run, "g-421 真实失败", new RegExp(G407_FAIL_MARKER));
});

test("g-421 判据1：真实失败但**签名不匹配**（失败不是预期的那个）⇒ 必须拒绝", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", join(G407_FIXTURES, "always-fail.test.ts")], {
    cwd: repoRoot,
  });
  t.diagnostic(
    `evidence: suite=g421-signature-mismatch exit=${run.code} test_level=${nestedTestLevelFailures(run).length}`,
  );
  const problems = nestedSuiteFailedProblems(run, /G421_OTHER_EXPECTED_SIGNATURE/).join("；");
  assert.match(
    problems,
    /没有一条的文本匹配/,
    `真实失败但不是「预期的那个」时必须判红（否则任意失败都能充当负向对照）：${problems}`,
  );
  assert.throws(
    () => assertNestedSuiteFailed(run, "g-421 签名不匹配", /G421_OTHER_EXPECTED_SIGNATURE/),
    /没有一条的文本匹配/,
    "签名不匹配的真实失败不得被负向裁决接受",
  );
});

// ============================================================================
// 判据 2：全体裁决 helper 结构性普查守卫（导出**穷举** + 调用闭包必须到达证据核心）
// ============================================================================

/** 提取 `nested-runner.ts` 全部顶层**函数声明**体（`[export ][async ]function NAME(` 起、到下一条前）。 */
function topLevelFunctions(src: string): Map<string, string> {
  const re = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)\s*\(/gm;
  const hits = [...src.matchAll(re)].map((m) => ({ name: m[1] as string, index: m.index as number }));
  const bodies = new Map<string, string>();
  for (let i = 0; i < hits.length; i += 1) {
    const end = i + 1 < hits.length ? hits[i + 1].index : src.length;
    bodies.set(hits[i].name, src.slice(hits[i].index, end));
  }
  return bodies;
}

/**
 * **穷举**源码里的 `export` 声明（g-421 防回归 P2：旧的 `/^export function/` 会漏掉
 * `export async function` / `export const NAME = …`（箭头函数/函数表达式）等形态 ⇒ 未来的
 * 弱裁决 helper 可绕过 registry 比较）。
 *
 * `values` = 运行时值导出（可执行 ⇒ 可能下裁决）；`types` = 类型导出（`type`/`interface`/`class`/`enum`）。
 * **fail-closed（g-422 收紧）**：除上表已支持的三种形态外，**任何**以 `export` 开头的行都抛错 ——
 * 也包括 `export {…}`（可 `as` 别名重命名）、`export default`、`export *`：它们会让裁决入口以**别名 /
 * 默认导出**的形态绕过导出普查（`function weak(){…}; export {weak as assertNestedFoo}` 在 `values`
 * 里完全不可见 ⇒ 清单完备性与调用闭包比较全部失效）。本文件当前不含这些形态；将来若确需，
 * 必须**先**扩展枚举并把新入口登记进清单，**绝不**静默跳过。
 */
function exportInventory(src: string): { values: string[]; types: string[] } {
  const values: string[] = [];
  const types: string[] = [];
  const declared = new Set<number>();
  const forms: ReadonlyArray<readonly [RegExp, "value" | "type"]> = [
    [/^export\s+(?:async\s+)?function\s*\*?\s*(\w+)/gm, "value"],
    [/^export\s+(?:const|let|var)\s+(\w+)/gm, "value"],
    [/^export\s+(?:type|interface|class|enum)\s+(\w+)/gm, "type"],
  ];
  for (const [re, kind] of forms) {
    for (const m of src.matchAll(re)) {
      declared.add(m.index as number);
      (kind === "value" ? values : types).push(m[1] as string);
    }
  }
  for (const line of src.matchAll(/^export\b.*$/gm)) {
    if (declared.has(line.index as number)) continue;
    const text = line[0].trim();
    // g-422：`export {…}`（含 `as` 别名）、`export default`、`export *` **不得**静默跳过 ——
    // 别名/默认导出能把裁决入口藏到 `values` 之外，使下面的清单完备性与调用闭包比较整体失效。
    throw new Error(`不支持的 export 形态（守卫 fail-closed，请显式支持并登记）：${text.slice(0, 120)}`);
  }
  return { values, types };
}

/**
 * 把**所有运行时值导出**分派到给定清单：每个名字必须**恰好**归属一张清单 ——
 * 未归类 / 重复登记 / 清单里有并不存在的名字 ⇒ 一律抛错（fail-closed，不静默跳过）。
 */
function classifyExports(
  values: readonly string[],
  lists: Record<string, readonly string[]>,
): Map<string, string> {
  const owner = new Map<string, string>();
  for (const [listName, names] of Object.entries(lists)) {
    for (const name of names) {
      const previous = owner.get(name);
      if (previous) throw new Error(`导出 ${name} 同时登记在 ${previous} 与 ${listName}`);
      owner.set(name, listName);
    }
  }
  const unclassified = values.filter((v) => !owner.has(v));
  if (unclassified.length > 0) {
    throw new Error(
      `未归类的运行时导出（新增导出必须显式登记进 VERDICTS/PRECONDITIONS/PARTS/NON_VERDICT 之一）：` +
        unclassified.join(", "),
    );
  }
  const ghost = [...owner.keys()].filter((n) => !values.includes(n));
  if (ghost.length > 0) throw new Error(`清单里登记了并不存在的导出（清单与源码漂移）：${ghost.join(", ")}`);
  return owner;
}

/** 「形如裁决入口」的命名（`assertNested*` / `nested*Problems`）—— 这类名字**不得**藏在非裁决清单里。 */
function looksLikeVerdict(name: string): boolean {
  return /^assertNested/.test(name) || /^nested\w*Problems$/.test(name);
}

/** 函数体内对**本文件其它顶层函数**的调用（同名 token 后跟 `(`）。 */
function localCallees(body: string, allNames: readonly string[]): string[] {
  return allNames.filter((name) => new RegExp(`\\b${name}\\s*\\(`).test(body));
}

/** 沿本文件调用图求闭包，判断 `start` 能否（经任意跳数）到达 `target`。 */
function reaches(bodies: Map<string, string>, start: string, target: string): boolean {
  const allNames = [...bodies.keys()];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const body = bodies.get(current);
    if (!body) continue;
    for (const callee of localCallees(body, allNames)) {
      if (callee === target) return true;
      if (!seen.has(callee)) queue.push(callee);
    }
  }
  return false;
}

const REGISTRY_LISTS = {
  NESTED_EVIDENCE_VERDICTS,
  NESTED_EVIDENCE_PRECONDITIONS,
  NESTED_EVIDENCE_PARTS,
  NESTED_NON_VERDICT_EXPORTS,
} as const;

test("g-421 判据2：裁决 helper 清单完备且**每一个**调用闭包都到达唯一证据核心", (t) => {
  const src = readFileSync(HELPER, "utf8");
  const bodies = topLevelFunctions(src);
  const { values, types } = exportInventory(src);

  // ⓪ **穷举**分派：所有运行时值导出必须恰好归属一张清单（未归类/重复/幽灵 ⇒ 抛错判红）。
  classifyExports(values, REGISTRY_LISTS);
  assert.ok(
    values.length >= 25,
    `运行时导出枚举下限校验失败（实际 ${values.length}）—— 枚举失效会让本守卫变永真`,
  );
  assert.ok(types.length >= 3, `类型导出枚举下限校验失败（实际 ${types.length}）`);

  // ⓪b **形态 fail-closed**：名字形如裁决入口的值导出，必须登记进**三张证据清单之一**
  //     （VERDICTS / PRECONDITIONS / PARTS）—— **不得藏进非裁决清单**；
  //     并且闭包分析只支持 `function` 声明形态 —— 新形态（如 `export const assertNestedFoo = … =>`）
  //     会在此处**判红**（要求人显式扩展守卫），而不是被静默跳过。
  const evidenceRegistry = [
    ...NESTED_EVIDENCE_VERDICTS,
    ...NESTED_EVIDENCE_PRECONDITIONS,
    ...NESTED_EVIDENCE_PARTS,
  ];
  for (const name of values.filter(looksLikeVerdict)) {
    assert.ok(
      evidenceRegistry.includes(name),
      `${name} 形如裁决入口，必须登记进 NESTED_EVIDENCE_VERDICTS / PRECONDITIONS / PARTS（不得藏进非裁决清单）`,
    );
    assert.ok(
      bodies.has(name),
      `${name} 的形态不被闭包分析支持（只支持 \`function\` 声明）—— 新增形态必须扩展本守卫，不得静默通过`,
    );
  }
  assert.deepEqual(
    values.filter(looksLikeVerdict).sort(),
    [...new Set(evidenceRegistry)].sort(),
    "证据清单与「形如裁决入口的运行时导出」不一致：新增/删除裁决 helper 必须同步登记",
  );

  // ⓪c PARTS 是**证据核心的组成判据**（不是自留地）：核心必须**逐个直接调用**它们 ——
  //     否则「把新裁决逻辑登记成 PARTS」就成了绕过调用闭包检查的后门。
  for (const name of NESTED_EVIDENCE_PARTS) {
    if (name === "nestedEvidenceProblems") continue;
    assert.match(
      bodies.get("nestedEvidenceProblems") as string,
      new RegExp(`\\b${name}\\s*\\(`),
      `PARTS 成员 ${name} 必须被证据核心直接调用（组成判据不得成为绕过闭包检查的登记地）`,
    );
  }

  // ① **每一个**裁决入口（终局裁决 + 阶段组件，含 g353/闸门消费的 assertNestedSuiteRan）的调用闭包
  //    都必须到达 `nestedEvidenceProblems`（覆盖 + 通道交叉校验的唯一实现）—— 无豁免名单。
  const verdictRegistry = [...NESTED_EVIDENCE_VERDICTS, ...NESTED_EVIDENCE_PRECONDITIONS];
  for (const name of verdictRegistry) {
    assert.ok(bodies.has(name), `${name} 必须是本文件的顶层函数`);
    assert.ok(
      reaches(bodies, name, "nestedEvidenceProblems"),
      `${name} 的调用闭包必须到达 nestedEvidenceProblems（否则该裁决路径缺覆盖/通道不变式 —— g-421 的 P1 形态）`,
    );
  }

  // ② 证据核心不得被掏空：必须引用两个构成判据（覆盖 + 通道内部交叉校验）。
  const core = bodies.get("nestedEvidenceProblems") as string;
  assert.match(core, /\bnestedTargetCoverageProblems\s*\(/, "证据核心必须核对逐目标文件完成事件覆盖");
  assert.match(core, /\bnestedChannelCrossCheckProblems\s*\(/, "证据核心必须做通道内部 tally↔summary 交叉校验");

  // ③ 阶段组件不得孤立：必须被至少一个终局裁决组合（避免「只在弱入口用一次」的自留地）。
  for (const name of NESTED_EVIDENCE_PRECONDITIONS) {
    assert.ok(
      NESTED_EVIDENCE_VERDICTS.some((v) => reaches(bodies, v, name)),
      `${name} 必须被至少一个终局裁决组合（不得孤立使用）`,
    );
  }

  // ④ 正/负两条腿必须共用同一实现，**不得各写一份**：终局聚合器只调核心，不直接调构成判据。
  for (const name of ["nestedSuitePassProblems", "nestedSuiteFailedProblems"]) {
    const body = bodies.get(name) as string;
    assert.doesNotMatch(
      body,
      /\bnestedTargetCoverageProblems\s*\(|\bnestedChannelCrossCheckProblems\s*\(/,
      `${name} 不得直接内联覆盖/通道判据 —— 必须经 nestedEvidenceProblems（同口径、单一实现）`,
    );
  }
  assert.match(
    bodies.get("assertNestedSuiteFailed") as string,
    /\bnestedSuiteFailedProblems\s*\(/,
    "assertNestedSuiteFailed 必须经负向聚合器（含证据不变式），不得自行拼装断言",
  );
  assert.match(
    bodies.get("assertNestedSuitePassed") as string,
    /\bnestedSuitePassProblems\s*\(/,
    "assertNestedSuitePassed 必须经正向聚合器",
  );

  // ⑤ g-421 第二轮：负向裁决必须**逐个**要求 test/subtest 级真实失败事件（不得只看覆盖/退出码）。
  const failedBody = bodies.get("nestedSuiteFailedProblems") as string;
  assert.match(
    failedBody,
    /\bnestedTestLevelFailures\s*\(/,
    "nestedSuiteFailedProblems 必须要求 test/subtest 级真实失败事件（否则「良性用例 + process.exitCode=1」可冒充如期报红）",
  );
  const levelBody = bodies.get("nestedTestLevelFailures") as string;
  assert.match(levelBody, /exitCode/, "nestedTestLevelFailures 必须排除带进程级 exitCode 的「文件包装失败」");
  assert.match(levelBody, /signal/, "nestedTestLevelFailures 必须排除带进程级 signal 的「文件包装失败」");
  assert.match(levelBody, /entityType/, "nestedTestLevelFailures 必须按实体层级（details.type）过滤 suite 聚合");

  t.diagnostic(
    `evidence: suite=g421-verdict-inventory value_exports=${values.length} type_exports=${types.length} ` +
      `verdicts=${NESTED_EVIDENCE_VERDICTS.length} preconditions=${NESTED_EVIDENCE_PRECONDITIONS.length} ` +
      `parts=${NESTED_EVIDENCE_PARTS.length} non_verdict=${NESTED_NON_VERDICT_EXPORTS.length} all_reach_core=1`,
  );
});

test("g-421 判据2 防回归：导出枚举覆盖 async/const 形态，未归类与不支持形态一律 fail-closed", (t) => {
  const sample = [
    "export function assertNestedA(x: number): number {",
    "  return nestedEvidenceProblems(x);",
    "}",
    "export async function assertNestedB(): Promise<void> {}",
    "export function* assertNestedC(): Generator<number> {}",
    "export const nestedSuiteDProblems = (x: number) => x;",
    "export let NESTED_NON_VERDICT_SAMPLE = 1;",
    "export type Foo = { a: 1 };",
    "export interface Bar { b: 2 }",
  ].join("\n");
  const inv = exportInventory(sample);
  assert.deepEqual(
    [...inv.values].sort(),
    ["NESTED_NON_VERDICT_SAMPLE", "assertNestedA", "assertNestedB", "assertNestedC", "nestedSuiteDProblems"],
    "导出枚举必须覆盖 plain/async/generator function 与 const/let 声明形态",
  );
  assert.deepEqual([...inv.types].sort(), ["Bar", "Foo"], "类型导出单独归类（不可执行 ⇒ 不参与裁决分类）");

  // `export const assertNestedFoo = … =>` 这类**新形态裁决入口**：枚举认得出（不再静默漏掉），
  // 但闭包分析不支持其形态 ⇒ 未登记即判红。
  assert.ok(inv.values.includes("nestedSuiteDProblems"), "箭头函数形态的 `nested*Problems` 导出必须被枚举到");
  assert.throws(
    () => classifyExports(inv.values, { VERDICTS: ["assertNestedA"] }),
    /未归类的运行时导出/,
    "未登记的新导出（无论什么形态）必须 fail-closed 判红",
  );
  assert.throws(
    () => exportInventory("export declare function assertNestedFoo(x: number): void;\n"),
    /不支持的 export 形态/,
    "无法识别的 export 形态必须 fail-closed 判红，不得静默跳过",
  );
  // g-422：别名 / 默认 / 星号导出同样必须 fail-closed —— 它们是「裁决入口绕过导出普查」的可行旁路
  // （`function weak(){…}; export {weak as assertNestedFoo}` 在 `values` 中完全不可见 ⇒ 清单完备性失效）。
  for (const form of [
    "export { weak as assertNestedFoo };\n",
    "export default function assertNestedFoo() {}\n",
    "export * from './nested-runner.js';\n",
  ]) {
    assert.throws(
      () => exportInventory(form),
      /不支持的 export 形态/,
      `别名/默认/星号导出必须 fail-closed 判红（会绕过导出普查）：${form.trim()}`,
    );
  }
  assert.throws(
    () => classifyExports(["A"], { X: ["A"], Y: ["A"] }),
    /同时登记/,
    "同一导出重复登记必须判红",
  );
  assert.throws(
    () => classifyExports(["A"], { X: ["A", "GHOST"] }),
    /并不存在的导出/,
    "清单与源码漂移（登记了不存在的导出）必须判红",
  );
  t.diagnostic("evidence: suite=g421-guard-hardening forms=5 fail_closed=4");
});

test("g-421 判据1 负向加固：信号终止即便通道/覆盖完整也不得冒充「如期报红」", (t) => {
  // 真实的「信号终止且通道完整」难以稳定构造，故用合成结果直接压测负向聚合器（非抛错形态）。
  const target = EXIT_BEFORE_ASSERT;
  const out = `ℹ tests 1\nℹ pass 0\nℹ fail 1\n${SENTINEL}\n`;
  const summary = parseTestSummary(out);
  const run: NestedRunResult = {
    code: null,
    out,
    err: "",
    command: "(synthetic-signal)",
    cwd: repoRoot,
    summary,
    targets: [target],
    channel: { summary, tally: summary, summaries: 2, files: [target], badLines: 0 },
  };
  const problems = nestedSuiteFailedProblems(run, new RegExp(SENTINEL)).join("；");
  assert.match(problems, /信号终止/, `信号终止必须被判红（exit=null）：${problems}`);
  assert.doesNotMatch(problems, /必须非零退出/, "exit=null 的红因是「信号终止」，不得只当作「非零退出」放行");
  assert.throws(
    () => assertNestedSuiteFailed(run, "g-421 信号终止（通道完整）", new RegExp(SENTINEL)),
    /信号终止/,
    "「非零退出」不等于「被信号终止即可」——后者不是测试断言失败",
  );
  t.diagnostic("evidence: suite=g421-signal-complete-channel red=signal");
});

// ============================================================================
// 判据 2：g353 消费点 assertNestedSuiteRan 也必须消费证据不变式（不得被早退伪造）
// ============================================================================

test("g-421 判据2：assertNestedSuiteRan（g353 负向对照消费点）必须拒绝无完成事件的早退形态", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", EXIT_BEFORE_ASSERT], { cwd: repoRoot });
  t.diagnostic(
    `evidence: suite=g421-ran-consumer exit=${run.code} tests=${run.summary.tests} fail=${run.summary.fail} ` +
      `files=${run.channel.files.length}`,
  );
  // 「非零退出 + 输出签名 + 计数自洽」正是 g353 两个负向对照的消费形态；
  // 若 assertNestedSuiteRan 只核「跑过」，该形态会被判「确实跑了」⇒ 负向对照可被早退伪造。
  assert.equal(run.summary.hasSummary, true, "前提：早退形态仍会产出汇总（计数看着自洽）");
  assert.throws(
    () => assertNestedSuiteRan(run, "g-421 ran 消费点（早退形态）"),
    /完成事件|证据不足/,
    "g353 消费的 assertNestedSuiteRan 必须与终局裁决同口径：无完成事件 ⇒ 拒绝",
  );
});

test("g-421 判据2 接线：g353 的两个负向对照消费点确实落在受证据不变式保护的入口上", (t) => {
  const g353 = readFileSync(join(TESTS_DIR, "g353-build-chain-boundaries.test.ts"), "utf8");
  assert.match(g353, /\bassertNestedSuiteRan\(\s*redStale/, "g353 陈旧产物负向对照必须走 assertNestedSuiteRan");
  assert.match(g353, /\bassertNestedSuiteRan\(\s*redModule/, "g353 漏模块负向对照必须走 assertNestedSuiteRan");
  // 源码级接线检查：该入口自身必须到达证据核心（防止未来把不变式从入口摘掉而消费点「无感」变弱）。
  const bodies = topLevelFunctions(readFileSync(HELPER, "utf8"));
  assert.ok(
    reaches(bodies, "assertNestedSuiteRan", "nestedEvidenceProblems"),
    "g353 消费的入口必须到达 nestedEvidenceProblems，否则两个负向对照可被「早退伪造」冒充",
  );
  t.diagnostic("evidence: suite=g421-g353-wiring call_sites=2 ran_reaches_core=1");
});

test("g-421 判据2 变异对照：摘掉覆盖校验 ⇒ assertNestedSuiteRan 对该早退形态复活为接受", async (t) => {
  const { helper: mutant, dir } = await loadMutantHelper((src) =>
    src.replace(
      "  problems.push(...nestedTargetCoverageProblems(run.targets, channel, run.cwd));",
      "  // mutant: g-421 coverage check removed",
    ),
  );
  try {
    const real = await runNestedArgv(process.execPath, ["--test", EXIT_BEFORE_ASSERT], { cwd: repoRoot });
    assert.throws(() => assertNestedSuiteRan(real, "真实 helper"), /完成事件|证据不足/, "前提：真实 helper 判红");
    const run = await mutant.runNestedArgv(process.execPath, ["--test", EXIT_BEFORE_ASSERT], { cwd: repoRoot });
    mutant.assertNestedSuiteRan(run, "变异 helper（覆盖检查已去掉）");
    t.diagnostic(
      `evidence: suite=g421-ran-mutant real=rejected mutant=accepted exit=${run.code} ` +
        `tests=${run.summary.tests} fail=${run.summary.fail} files=${run.channel.files.length}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 3：变异对照（摘掉新增覆盖校验 ⇒ repro 复活为被接受）
// ============================================================================

/** 生成与被测 helper **同相对深度**的私有副本（reporter 路径由 `import.meta.url` 推导）。 */
async function loadMutantHelper(transform: (src: string) => string): Promise<{
  helper: typeof import("./fixtures/nested-runner.ts");
  dir: string;
}> {
  const original = readFileSync(HELPER, "utf8");
  const mutantSrc = transform(original);
  assert.notEqual(mutantSrc, original, "变异锚点失效：helper 源码必须命中该锚点");
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g421-mutant-"));
  const fixturesDir = join(dir, "core", "tests", "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  symlinkSync(REPORTER, join(dir, "scripts", "test-reporter-events.mjs"));
  const mutantPath = join(fixturesDir, "nested-runner-mutant.ts");
  writeFileSync(mutantPath, mutantSrc);
  const helper = (await import(pathToFileURL(mutantPath).href)) as typeof import("./fixtures/nested-runner.ts");
  return { helper, dir };
}

test("g-421 判据3 变异对照 A（覆盖校验）：摘掉目标覆盖校验 ⇒ 「有 test 级失败但无完成事件」形态复活为被接受", async (t) => {
  // 为什么用合成结果：真实「早退」夹具（exit-before-assert）**同时**缺完成事件与缺 test 级失败事件
  // ⇒ 只摘覆盖也仍被第二轮判红。要**孤立**检验覆盖校验的判别力，需要一个「有 test 级失败事件、
  // 但没有逐文件完成事件」的输入（正是覆盖校验唯一能挡住的那一类）。
  const target = EXIT_BEFORE_ASSERT;
  const out = `ℹ tests 1\nℹ pass 0\nℹ fail 1\n${SENTINEL}\n`;
  const summary = parseTestSummary(out);
  const synthetic: NestedRunResult = {
    code: 1,
    out,
    err: "",
    command: "(synthetic: test 级失败但无完成事件)",
    cwd: repoRoot,
    summary,
    targets: [target],
    channel: {
      summary,
      tally: summary,
      summaries: 1, // 只有全局汇总 ⇒ **没有**逐文件完成事件
      files: [],
      failures: [
        { name: "g-421 合成用例", entityType: "test", message: SENTINEL, file: target, exitCode: null, signal: null },
      ],
      badLines: 0,
    },
  };
  assert.match(
    nestedSuiteFailedProblems(synthetic, new RegExp(SENTINEL)).join("；"),
    /完成事件/,
    "前提：真实 helper 对该合成输入判红（红因 = 覆盖）",
  );

  const { helper: mutant, dir } = await loadMutantHelper((src) =>
    src.replace(
      "  problems.push(...nestedTargetCoverageProblems(run.targets, channel, run.cwd));",
      "  // mutant: g-421 coverage check removed",
    ),
  );
  try {
    assert.deepEqual(
      mutant.nestedSuiteFailedProblems(synthetic, new RegExp(SENTINEL)),
      [],
      "摘掉覆盖校验后本形态必须重新被接受（复活）—— 否则变异对照不成立",
    );
    mutant.assertNestedSuiteFailed(synthetic, "变异 helper（覆盖检查已去掉）", new RegExp(SENTINEL));
    // 纵深防御（实测数据点）：真实早退 repro **同时**缺 test 级失败事件 ⇒ 即便摘掉覆盖也仍判红。
    const earlyExit = await mutant.runNestedArgv(process.execPath, ["--test", EXIT_BEFORE_ASSERT], { cwd: repoRoot });
    const earlyProblems = mutant.nestedSuiteFailedProblems(earlyExit, new RegExp(SENTINEL));
    assert.ok(
      earlyProblems.some((p) => /没有任何 test\/subtest 级的失败事件/.test(p)),
      "真实早退 repro 在摘掉覆盖后仍须由第二轮（test 级失败）判红 —— 两道防线相互独立",
    );
    t.diagnostic(
      `evidence: suite=g421-mutant-coverage real=rejected mutant=accepted synthetic_targets=${synthetic.targets.length} ` +
        `files=${synthetic.channel.files.length} test_level=${nestedTestLevelFailures(synthetic).length} ` +
        `early_exit_still_red=${earlyProblems.length}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-421 判据3 变异对照 B（test 级失败要求）：摘掉新增要求 ⇒ wrap repro 复活为被接受", async (t) => {
  // 前提：真实 helper 必须拒绝「良性用例 + process.exitCode=1」。
  const real = await runNestedArgv(process.execPath, ["--test", WRAP_FAILURE], { cwd: repoRoot });
  assert.throws(
    () => assertNestedSuiteFailed(real, "真实 helper", new RegExp(WRAP_SENTINEL)),
    /没有任何 test\/subtest 级的失败事件/,
    "前提：真实 helper 必须拒绝 wrap repro（红因 = 无 test 级失败事件）",
  );

  // 变异副本：**整块摘掉**第二轮要求（「必须有 test 级真实失败事件」+「其 error 文本匹配签名」）。
  const { helper: mutant, dir } = await loadMutantHelper((src) =>
    src.replace(
      / {2}const testFailures = nestedTestLevelFailures\(run\);[\s\S]*?\n {2}}\n {2}return problems;/,
      "  // mutant: g-421 test/subtest 级失败要求已摘掉\n  return problems;",
    ),
  );
  try {
    const run = await mutant.runNestedArgv(process.execPath, ["--test", WRAP_FAILURE], { cwd: repoRoot });
    const problems = mutant.nestedSuiteFailedProblems(run, new RegExp(WRAP_SENTINEL));
    assert.deepEqual(
      problems,
      [],
      "摘掉 test 级失败要求后 wrap 形态必须重新被接受（复活）—— 否则变异对照不成立",
    );
    mutant.assertNestedSuiteFailed(run, "变异 helper（test 级要求已去掉）", new RegExp(WRAP_SENTINEL));
    t.diagnostic(
      `evidence: suite=g421-mutant-testlevel real=rejected mutant=accepted code=${run.code} tests=${run.summary.tests} ` +
        `pass=${run.summary.pass} fail=${run.summary.fail} files=${run.channel.files.length} ` +
        `test_level=${run.channel.failures.length > 0 ? nestedTestLevelFailures(run).length : 0} problems=[]`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 5：干净通道必须识别新增的实体级 failure 记录（不得计为 badLines）
// ============================================================================

test("g-421 判据5：failure 记录被干净通道识别（badLines 不得增加 —— 闸门把 badLines>0 当红因）", (t) => {
  const text = [
    JSON.stringify({
      type: "failure",
      name: "/x.test.ts",
      entityType: "test",
      message: "test failed",
      file: "/x.test.ts",
      exitCode: 1,
      signal: null,
    }),
    JSON.stringify({
      type: "summary",
      file: "/x.test.ts",
      counts: { tests: 1, passed: 0, failed: 1, cancelled: 0, skipped: 0, todo: 0 },
    }),
    JSON.stringify({ type: "tally", counts: { tests: 1, pass: 0, fail: 1, cancelled: 0, skipped: 0, todo: 0 } }),
    "ℹ tests 1", // 人类可读文本仍必须是 badLine（通道只认带类型事件）
  ].join("\n");
  const channel = parseEventChannel(text);
  assert.equal(channel.badLines, 1, "只有人类可读行算坏行；failure 记录必须被识别");
  assert.equal(channel.failures.length, 1, "failure 记录必须被解析进 channel.failures");
  assert.deepEqual(
    channel.failures[0],
    { name: "/x.test.ts", entityType: "test", message: "test failed", file: "/x.test.ts", exitCode: 1, signal: null },
    "实体级字段必须逐字保留（entityType/message/exitCode/signal）",
  );
  assert.deepEqual(channel.files, ["/x.test.ts"], "逐文件完成事件照常收集");
  t.diagnostic("evidence: suite=g421-channel-failure-record bad_lines=1 failures=1");
});

// ============================================================================
// 判据 4：夹具位置（不被顶层 glob 误收）+ 文档口径接线
// ============================================================================

test("g-421 判据4：负向夹具在 fixtures/g421 子目录（顶层 glob 零命中）+ helper 文件头口径已同步", (t) => {
  const topLevel = readdirSync(TESTS_DIR).filter((name) => name.endsWith(".test.ts"));
  for (const name of ["exit-before-assert.test.ts", "wrap-failure.test.ts"]) {
    assert.ok(!topLevel.includes(name), `${name} 不得出现在 core/tests 顶层（会被顶层 glob 收作正式套件）`);
  }
  const helper = readFileSync(HELPER, "utf8");
  assert.match(helper, /g-421/, `${HELPER_REL} 文件头必须记录 g-421 的负向裁决收口口径`);
  assert.match(
    helper,
    /export function nestedEvidenceProblems/,
    "正向与负向裁决必须共用唯一证据核心 nestedEvidenceProblems",
  );
  assert.match(
    helper,
    /export function nestedTestLevelFailures/,
    "负向裁决必须要求 test/subtest 级真实失败事件（第二轮收口）",
  );
  const reporter = readFileSync(REPORTER, "utf8");
  assert.match(
    reporter,
    /type:\s*"failure"/,
    "私有 reporter 必须以**加法**方式输出实体级 failure 记录（summary/tally 语义不变）",
  );
  t.diagnostic("evidence: suite=g421-fixture-placement top_level_hits=0 header_synced=1 reporter_failure_record=1");
});
