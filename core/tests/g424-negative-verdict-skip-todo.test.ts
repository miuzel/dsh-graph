/**
 * core/tests/g424-negative-verdict-skip-todo.test.ts
 *
 * g-424（v0.19.7 lane）：**负向裁决与正向裁决同口径** —— 终局复核在 tip `7121112` 上实测的**新 P1**
 * （false-positive test evidence，真实可达、无需蓄意破坏）：
 *
 *   `core/tests/fixtures/nested-runner.ts` 的 `nestedSuiteFailedProblems` 只核
 *   「证据核心 + ≥1 test 级真实失败事件 + 签名匹配」，**不拒 `skipped > 0`**。最小复现（两目标）：
 *     A = `test('expected', () => assert.fail('EXPECTED_NEGATIVE_SIG'))`
 *     B = `test.skip('skipped intended assertion', () => { throw new Error('EXPECTED_NEGATIVE_SIG') })`
 *   ⇒ 实测 `code 1 / tests 2 / fail 1 / skipped 1 / files=[A,B] / problems=[]`，旧负向裁决**接受**
 *   —— 而 **B 的意图断言从未执行**（skip 的回调根本不运行），签名由 A 的真实失败满足。
 *   同类旁路：`todo`（零验证、无回调）与 `cancelled`（超时/取消 ⇒ 回调未跑完）。三者都与
 *   「覆盖/通道」正交：它们**照常产出文件级完成事件、计数自洽**，覆盖率与通道交叉校验都看不出来。
 *
 * 本套件钉死修复（全部 **fail-closed、无 opt-out**，既有判据**只增不减**）：
 *   ① 精确 repro（A 真实失败 + B `test.skip` 携带同签名）⇒ **必须拒绝**并**点名 `skipped`**；
 *   ② `todo` 变体 ⇒ 拒绝并点名 `todo`；③ `cancelled` 变体（AbortController 稳定构造）⇒ 拒绝并点名 `cancelled`；
 *   ④ 正向：两文件均真实 `assert.fail(<签名>)`、无 skip/todo ⇒ **接受**（不得变成恒红假守卫）；
 *   ⑤ 真实失败但签名不匹配 ⇒ 拒绝（既有判据不得被削弱）；
 *   ⑥ **变异对照**：私有副本里摘掉新增的 skip/todo/cancelled 口径 ⇒ ① **复活为被接受**（给实测值）；
 *   ⑦ 消费点复算：既有负向消费夹具的 `skipped/todo` 实测值（判别力不削弱）；
 *   ⑧ 结构性守卫：三个口径检查必须在 `nestedSuiteFailedProblems` **体内**、且入口**无 opt-out**。
 *
 * 夹具都在 `fixtures/g424/`（不被顶层 glob `core/tests/*.test.ts` 误收）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertNestedSuiteFailed,
  nestedSuiteFailedProblems,
  nestedTestLevelFailures,
  runNestedArgv,
  type NestedRunResult,
} from "./fixtures/nested-runner.ts";

const repoRoot = join(import.meta.dirname, "../..");
const TESTS_DIR = join(import.meta.dirname);
const FIXTURES = join(TESTS_DIR, "fixtures", "g424");
const HELPER = join(repoRoot, "core", "tests", "fixtures", "nested-runner.ts");
const REPORTER = join(repoRoot, "scripts", "test-reporter-events.mjs");

const REAL_FAIL = join(FIXTURES, "real-fail.test.ts");
const REAL_FAIL_2 = join(FIXTURES, "real-fail-2.test.ts");
const SKIP_SAME_SIG = join(FIXTURES, "skip-same-sig.test.ts");
const TODO_SAME_SIG = join(FIXTURES, "todo-same-sig.test.ts");
const CANCELLED_SAME_SIG = join(FIXTURES, "cancelled-same-sig.test.ts");
const G407_ALWAYS_FAIL = join(TESTS_DIR, "fixtures", "g407", "always-fail.test.ts");
const G407_FAIL_MARKER = "G407_ALWAYS_FAIL_MARKER";
const G421_EXIT_BEFORE_ASSERT = join(TESTS_DIR, "fixtures", "g421", "exit-before-assert.test.ts");
const G421_WRAP_FAILURE = join(TESTS_DIR, "fixtures", "g421", "wrap-failure.test.ts");
const SIGNATURE = "G424_EXPECTED_NEGATIVE_SIG";
const SIG = new RegExp(SIGNATURE);

/** 单行实测值（供诊断与报文复算表）。 */
function shape(run: NestedRunResult, problems: readonly string[]): string {
  const s = run.summary;
  return (
    `code=${run.code} tests=${s.tests} pass=${s.pass} fail=${s.fail} cancelled=${s.cancelled} ` +
    `skipped=${s.skipped} todo=${s.todo} files=${run.channel.files.length} ` +
    `testLevel=${nestedTestLevelFailures(run).length} problems=${problems.length}`
  );
}

// ============================================================================
// 判据 3a：精确 repro ⇒ 必须拒绝并点名 skipped
// ============================================================================

test("g-424 判据3a 精确 repro：A=真实失败 + B=test.skip 同签名 ⇒ 必须拒绝并点名 skipped", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", REAL_FAIL, SKIP_SAME_SIG], { cwd: repoRoot });
  const problems = nestedSuiteFailedProblems(run, SIG);
  t.diagnostic(`evidence: suite=g424-repro-skip ${shape(run, problems)}`);

  // ── 复现前提（复核者在 7121112 上的实测形态）。
  assert.equal(run.code, 1, `repro 必须非零退出（实际 ${run.code}）`);
  assert.equal(run.summary.tests, 2, `两目标必须共 2 个用例（实际 ${run.summary.tests}）`);
  assert.equal(run.summary.fail, 1, `只有 A 真实失败（实际 fail=${run.summary.fail}）`);
  assert.equal(run.summary.skipped, 1, `B 必须被计为 skipped（实际 ${run.summary.skipped}）`);
  assert.equal(run.channel.files.length, 2, "B 也照常产出逐文件完成事件 ⇒ 覆盖校验本身看不出问题");

  // ── 关键：**签名确实由 A 的真实失败满足**（这正是旧裁决接受它的原因），且失败是 test 级的。
  const matched = nestedTestLevelFailures(run).some((f) => {
    SIG.lastIndex = 0;
    return SIG.test(`${f.name}\n${f.message}`);
  });
  assert.ok(matched, "前提：事件通道里确有**匹配签名**的 test 级真实失败事件（旧裁决据此接受）");

  // ── 修复后：除新增口径外**其它判据全部满足** ⇒ 恰好只剩 1 条不达标项，且点名 skipped。
  assert.equal(
    problems.length,
    1,
    `除新增口径外其它判据必须全部满足（否则无法证明「只有 skipped 口径」挡住它）：${problems.join("；")}`,
  );
  assert.match(problems[0] as string, /跳过|skipped/, `红因必须点名 skipped：${problems[0]}`);
  assert.match(problems[0] as string, /skipped=1/, `红因必须给出实测 skipped 值：${problems[0]}`);

  assert.throws(
    () => assertNestedSuiteFailed(run, "g-424 精确 repro（skip 旁路）", SIG),
    /跳过|skipped/,
    "assertNestedSuiteFailed 必须拒绝「另一目标被 skip、签名由 A 满足」的形态",
  );
});

// ============================================================================
// 判据 3b / 3c：todo 与 cancelled 变体
// ============================================================================

test("g-424 判据3b todo 变体：A=真实失败 + test.todo ⇒ 必须拒绝并点名 todo", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", REAL_FAIL, TODO_SAME_SIG], { cwd: repoRoot });
  const problems = nestedSuiteFailedProblems(run, SIG);
  t.diagnostic(`evidence: suite=g424-todo-variant ${shape(run, problems)}`);

  assert.equal(run.code, 1, `repro 必须非零退出（实际 ${run.code}）`);
  assert.equal(run.summary.todo, 1, `todo 必须被计入（实际 ${run.summary.todo}）`);
  assert.equal(run.summary.skipped, 0, "todo 变体不得混入 skipped");
  assert.equal(run.channel.files.length, 2, "todo 文件照常产出完成事件 ⇒ 覆盖校验看不出来");
  assert.equal(problems.length, 1, `其它判据必须全部满足，只余 todo 一条：${problems.join("；")}`);
  assert.match(problems[0] as string, /待办|todo/, `红因必须点名 todo：${problems[0]}`);
  assert.throws(
    () => assertNestedSuiteFailed(run, "g-424 todo 变体", SIG),
    /待办|todo/,
    "todo（零验证）不得作为「如期报红」的证据",
  );
});

test("g-424 判据3c cancelled 变体：A=真实失败 + AbortController 取消 ⇒ 必须拒绝并点名 cancelled", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", REAL_FAIL, CANCELLED_SAME_SIG], { cwd: repoRoot });
  const problems = nestedSuiteFailedProblems(run, SIG);
  t.diagnostic(`evidence: suite=g424-cancelled-variant ${shape(run, problems)}`);

  assert.equal(run.code, 1, `repro 必须非零退出（实际 ${run.code}）`);
  assert.equal(run.summary.cancelled, 1, `取消必须被 runner 计入 cancelled（实际 ${run.summary.cancelled}）`);
  assert.equal(run.summary.skipped + run.summary.todo, 0, "cancelled 变体不得混入 skip/todo");
  assert.match(problems.join("；"), /取消|cancelled/, `红因必须点名 cancelled：${problems.join("；")}`);
  assert.throws(
    () => assertNestedSuiteFailed(run, "g-424 cancelled 变体", SIG),
    /取消|cancelled/,
    "被取消（断言未跑完）不得作为「如期报红」的证据",
  );
});

// ============================================================================
// 判据 3d / 3e：正向接受 与 签名不匹配
// ============================================================================

test("g-424 判据3d 正向：两文件均真实失败且无 skip/todo ⇒ 必须接受（不得变恒红假守卫）", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", REAL_FAIL, REAL_FAIL_2], { cwd: repoRoot });
  const problems = nestedSuiteFailedProblems(run, SIG);
  t.diagnostic(`evidence: suite=g424-positive-two-real-failures ${shape(run, problems)}`);

  assert.equal(run.summary.fail, 2, `两文件都必须真实失败（实际 fail=${run.summary.fail}）`);
  assert.equal(run.summary.skipped + run.summary.todo + run.summary.cancelled, 0, "正向样本不得有 skip/todo/cancelled");
  assert.equal(run.channel.files.length, 2, "两个目标都必须产出完成事件");
  assert.equal(nestedTestLevelFailures(run).length, 2, "必须各有 1 条 test 级真实失败事件");
  assert.deepEqual(problems, [], `证据充分 + 非零退出 + 签名命中 + 无 skip/todo/cancelled ⇒ 不达标项必须为空：${problems.join("；")}`);
  assertNestedSuiteFailed(run, "g-424 正向（两文件真实失败）", SIG);
});

test("g-424 判据3e 真实失败但签名不匹配 ⇒ 必须拒绝（既有判据不得被削弱）", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", G407_ALWAYS_FAIL], { cwd: repoRoot });
  const problems = nestedSuiteFailedProblems(run, /G424_OTHER_EXPECTED_SIGNATURE/).join("；");
  t.diagnostic(`evidence: suite=g424-signature-mismatch exit=${run.code} problems=1`);
  assert.match(problems, /没有一条的文本匹配/, `真实失败但不是「预期的那个」必须判红：${problems}`);
  assert.throws(
    () => assertNestedSuiteFailed(run, "g-424 签名不匹配", /G424_OTHER_EXPECTED_SIGNATURE/),
    /没有一条的文本匹配/,
    "签名不匹配不得被负向裁决接受",
  );
});

// ============================================================================
// 判据 3f：变异对照（摘掉新增口径 ⇒ repro 复活为被接受）
// ============================================================================

/** 生成与被测 helper **同相对深度**的私有副本（reporter 路径由 `import.meta.url` 推导）。 */
async function loadMutantHelper(transform: (src: string) => string): Promise<{
  helper: typeof import("./fixtures/nested-runner.ts");
  dir: string;
}> {
  const original = readFileSync(HELPER, "utf8");
  const mutantSrc = transform(original);
  assert.notEqual(mutantSrc, original, "变异锚点失效：helper 源码必须命中该锚点");
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g424-mutant-"));
  const fixturesDir = join(dir, "core", "tests", "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  symlinkSync(REPORTER, join(dir, "scripts", "test-reporter-events.mjs"));
  const mutantPath = join(fixturesDir, "nested-runner-mutant.ts");
  writeFileSync(mutantPath, mutantSrc);
  const helper = (await import(pathToFileURL(mutantPath).href)) as typeof import("./fixtures/nested-runner.ts");
  return { helper, dir };
}

test("g-424 判据3f 变异对照：摘掉新增 skip/todo/cancelled 口径 ⇒ repro 复活为被接受", async (t) => {
  // 前提：真实 helper 必须拒绝 repro。
  const real = await runNestedArgv(process.execPath, ["--test", REAL_FAIL, SKIP_SAME_SIG], { cwd: repoRoot });
  assert.throws(
    () => assertNestedSuiteFailed(real, "真实 helper", SIG),
    /跳过|skipped/,
    "前提：真实 helper 必须拒绝 skip 旁路",
  );

  // 变异副本：把三个新增口径判断**逐个短路**（`if (false)`）⇒ 等价于「摘掉新口径」。
  const { helper: mutant, dir } = await loadMutantHelper((src) =>
    src
      .replace("if (run.summary.cancelled > 0) {", "if (false) { // mutant: g-424 cancelled 口径已摘掉")
      .replace("if (run.summary.skipped > 0) {", "if (false) { // mutant: g-424 skipped 口径已摘掉")
      .replace("if (run.summary.todo > 0) {", "if (false) { // mutant: g-424 todo 口径已摘掉"),
  );
  try {
    const run = await mutant.runNestedArgv(process.execPath, ["--test", REAL_FAIL, SKIP_SAME_SIG], { cwd: repoRoot });
    const problems = mutant.nestedSuiteFailedProblems(run, SIG);
    assert.deepEqual(
      problems,
      [],
      `摘掉新口径后 repro 必须重新被接受（复活）—— 否则变异对照不成立：${problems.join("；")}`,
    );
    mutant.assertNestedSuiteFailed(run, "变异 helper（新口径已摘掉）", SIG);
    t.diagnostic(
      `evidence: suite=g424-mutant revive=accepted code=${run.code} tests=${run.summary.tests} ` +
        `pass=${run.summary.pass} fail=${run.summary.fail} skipped=${run.summary.skipped} todo=${run.summary.todo} ` +
        `files=${run.channel.files.length} problems=0`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 2：既有负向消费点复算（skipped/todo 实测）+ 无 opt-out
// ============================================================================

test("g-424 判据2 消费点复算：既有负向消费夹具的 skipped/todo 实测为 0（判别力不削弱）", async (t) => {
  // 这些是**真实嵌套运行**的负向消费输入：g407（判据3 负向 + g421 正向接受）、g421（早退 / 文件包装 repro）。
  // 新增口径要求 skipped===0 && todo===0 ⇒ 必须实测确认它们原本就是 0（否则会误伤既有消费点）。
  const cases = [
    ["g407 always-fail（g407 判据3 / g421 正向接受）", G407_ALWAYS_FAIL],
    ["g421 exit-before-assert（早退 repro）", G421_EXIT_BEFORE_ASSERT],
    ["g421 wrap-failure（文件包装 repro）", G421_WRAP_FAILURE],
  ] as const;
  const rows: string[] = [];
  for (const [label, fixture] of cases) {
    const run = await runNestedArgv(process.execPath, ["--test", fixture], { cwd: repoRoot });
    rows.push(`${label}: ${shape(run, [])}`);
    assert.equal(run.summary.skipped, 0, `${label}：既有消费点不得含 skipped（实测 ${run.summary.skipped}）`);
    assert.equal(run.summary.todo, 0, `${label}：既有消费点不得含 todo（实测 ${run.summary.todo}）`);
    assert.equal(run.summary.cancelled, 0, `${label}：既有消费点不得含 cancelled（实测 ${run.summary.cancelled}）`);
  }
  // g-353 的两个负向对照（redStale / redModule）与 g407 走同一目标文件集合，其 skip/todo 由
  // g-353 自身的 `assertNestedSuitePassed(clean, …)`（正向口径已要求 skipped===0 && todo===0）
  // 与 g407 的诊断行实测值共同钉住；此处以 g407 always-fail 作为其承载夹具的代表。
  const g407Marker = new RegExp(G407_FAIL_MARKER);
  const g407Run = await runNestedArgv(process.execPath, ["--test", G407_ALWAYS_FAIL], { cwd: repoRoot });
  assert.deepEqual(
    nestedSuiteFailedProblems(g407Run, g407Marker),
    [],
    "既有 g407 消费点的判别力不得被削弱：真实失败 + 签名匹配 + 无 skip/todo ⇒ 仍被接受",
  );
  t.diagnostic(`evidence: suite=g424-consumer-recompute rows=${rows.length} all_skip_todo_zero=1`);
  for (const row of rows) t.diagnostic(`evidence-row: ${row}`);
});

test("g-424 判据2 结构性守卫：三个口径在负向入口体内，且入口无 opt-out", (t) => {
  const src = readFileSync(HELPER, "utf8");
  const bodyOf = (name: string): string => {
    const start = src.indexOf(`export function ${name}`);
    assert.notEqual(start, -1, `helper 必须导出 ${name}`);
    const rest = src.slice(start + 1);
    const next = rest.indexOf("\nexport ");
    return next === -1 ? rest : rest.slice(0, next);
  };
  const failed = bodyOf("nestedSuiteFailedProblems");
  for (const field of ["cancelled", "skipped", "todo"]) {
    assert.match(
      failed,
      new RegExp(`run\\.summary\\.${field}\\s*>\\s*0`),
      `nestedSuiteFailedProblems 体内必须要求 ${field} === 0（负向裁决与正向裁决同口径）`,
    );
  }
  // 同口径：正向入口同样点名这三项（两端口径不得漂移）。
  const passed = bodyOf("nestedSuitePassProblems");
  for (const field of ["cancelled", "skipped", "todo"]) {
    assert.match(passed, new RegExp(`s\\.${field}\\s*>\\s*0`), `正向入口必须同样要求 ${field} === 0`);
  }
  // 无 opt-out：负向入口签名固定为 (run, signature)，体内不得出现豁免开关。
  assert.match(
    src,
    /export function nestedSuiteFailedProblems\(\s*run:\s*NestedRunResult,\s*signature:\s*RegExp,?\s*\)/,
    "负向入口签名必须固定为 (run, signature) —— 不得新增 opt-out / 豁免参数",
  );
  for (const token of ["allowSkipped", "skipAllowed", "optOut", "allowTodo", "ignoreSkipped"]) {
    assert.doesNotMatch(src, new RegExp(token, "i"), `helper 不得引入豁免开关 ${token}（fail-closed、无 opt-out）`);
  }
  t.diagnostic("evidence: suite=g424-no-opt-out fields=3 optout_tokens=5 signature_fixed=1");
});
