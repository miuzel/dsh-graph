/**
 * core/tests/g416-nested-runner-coverage.test.ts
 *
 * g-416（v0.19.7 lane）：闸门的「目标文件覆盖」判据（g-415 判据③）此前**只**落在
 * `scripts/run-tests.mjs` 里，**共享 helper** `core/tests/fixtures/nested-runner.ts` 的
 * `nestedSuitePassProblems` / `assertNestedSuitePassed` 仍只看人类可读汇总 + 退出码 + `fail`/
 * `cancelled`/`skipped`/`todo`，**没有逐目标文件完成事件覆盖**。
 *
 * 终局复核在 tip `d988944` 上实测的残余洞（本文件钉死修复）：
 *   夹具注册 `test('pass',…)` + `test('fail',()=>assert.fail())`，随后在文件顶层用**反射退出**
 *   `globalThis['pro'+'cess']['ex'+'it'](0)` 早退 ⇒ 经 `runNestedArgv(process.execPath,['--test',f],…)`
 *   得 `code 0 / tests 1 / pass 1 / fail 0`，旧 helper 判据**接受**（本文件先复现该「旧判据会接受」
 *   的前提，再断言修复后判红）。
 *
 * 收口后（全部 **fail-closed，无 opt-out**）：
 *   ① 判据核对「目标文件集合 ≡ 产出逐文件 `test:summary`（带 `file`）的集合且 `>0`」；
 *   ② 目标集合由 helper 从**调用参数**推导（`--test` 后的位置参数；支持多文件 / 目录 / `<dir>/*<suffix>`
 *      glob，与顶层闸门展开口径一致），无法推导时退回调用方显式声明 `opts.targets`，都没有则**抛错**；
 *   ③ 事件通道（`NODE_OPTIONS` 注入的私有 reporter）与人类可读汇总**逐字段交叉校验**；
 *   ④ 负向对照：反射早退 / 直接早退 / todo-only / skip-only / SIGKILL / 伪造汇总；正向：多文件全绿；
 *      变异对照：私有副本去掉覆盖检查 ⇒ 早退夹具**复活为被接受**。
 *
 * 负向夹具都在 `fixtures/g416/`（不被顶层 glob 误收）且立即收敛，不挂起。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertNestedSuitePassed,
  deriveNestedTargetTokens,
  expandNestedTargets,
  nestedSuitePassProblems,
  nestedTargetCoverageProblems,
  parseEventChannel,
  runNestedArgv,
  runNestedCommand,
  type NestedRunResult,
} from "./fixtures/nested-runner.ts";

const repoRoot = join(import.meta.dirname, "../..");
const TESTS_DIR = join(import.meta.dirname);
const FIXTURES = join(TESTS_DIR, "fixtures", "g416");
const HELPER = join(repoRoot, "core", "tests", "fixtures", "nested-runner.ts");
const GATE = join(repoRoot, "scripts", "run-tests.mjs");
const REPORTER = join(repoRoot, "scripts", "test-reporter-events.mjs");

const REFLECTION_EXIT = join(FIXTURES, "reflection-exit.test.ts");
const DIRECT_EXIT = join(FIXTURES, "direct-exit.test.ts");
const TODO_ONLY = join(FIXTURES, "todo-only.test.ts");
const SKIP_ONLY = join(FIXTURES, "skip-only.test.ts");
const SIGKILL_FIXTURE = join(FIXTURES, "sigkill.test.ts");
const KILL_RUNNER = join(FIXTURES, "kill-runner.test.ts");
const FORGED_SUMMARY = join(FIXTURES, "forged-summary.test.ts");
const PASS_A = join(FIXTURES, "pass-a.test.ts");
const PASS_B = join(FIXTURES, "pass-b.test.ts");

/** 覆盖判据的红因特征（点名「完成事件」）。 */
const COVERAGE_RE = /未产出完成事件|完成事件/;

/** 跑一个 fixture（argv 形态），回传结果与其全部不达标项。 */
async function problemsOf(fixture: string): Promise<{ run: NestedRunResult; problems: string }> {
  const run = await runNestedArgv(process.execPath, ["--test", fixture], { cwd: repoRoot });
  return { run, problems: nestedSuitePassProblems(run).join("；") };
}

// ============================================================================
// 判据 1：最小复现 + 修复后判红（反射早退 / 直接早退）
// ============================================================================

for (const [label, fixture] of [
  ["反射早退 globalThis['pro'+'cess']['ex'+'it'](0)", REFLECTION_EXIT],
  ["直接 process.exit(0) 早退", DIRECT_EXIT],
] as const) {
  test(`g-416 判据1：${label} ⇒ helper 全绿判据必须判红并点名完成事件`, async (t) => {
    const { run, problems } = await problemsOf(fixture);

    // 前提：这正是「旧判据会接受」的形态（终局复核实测 code 0 / tests 1 / pass 1 / fail 0）。
    assert.equal(run.code, 0, `早退形态必须 exit 0（否则复现前提不成立）：\n${run.err.slice(-500)}`);
    assert.equal(run.summary.tests, 1, "早退形态只报文件级 subtest（tests 1）");
    assert.equal(run.summary.pass, 1, "早退形态把失败用例整个吞掉（pass 1）");
    assert.equal(run.summary.fail, 0, "早退形态 fail 为 0 —— 旧判据据此放行");

    // 修复后：逐目标文件完成事件缺失 ⇒ 判红，且人类/通道口径本身并不冲突（红因只能是覆盖）。
    assert.equal(run.targets.length, 1, "helper 必须推导出 1 个目标文件");
    assert.equal(run.channel.files.length, 0, "早退文件不得产出逐文件完成事件");
    assert.match(problems, COVERAGE_RE, `红因必须点名目标文件完成事件：${problems}`);
    assert.doesNotMatch(problems, /计数口径不自洽/, "该形态的计数口径自洽（红因不能是别的判据）");
    assert.throws(() => assertNestedSuitePassed(run, label), COVERAGE_RE, "assertNestedSuitePassed 必须判红");
    t.diagnostic(`evidence: suite=g416-early-exit form=${fixture.split("/").pop()} exit=${run.code} red=no-completion-event`);
  });
}

// ============================================================================
// 判据 1/3：其余负向形态（todo / skip / SIGKILL / 伪造汇总）
// ============================================================================

test("g-416 判据1：todo-only ⇒ 红因来自 todo（文件完成事件正常产出，两判据互不掩盖）", async (t) => {
  const { run, problems } = await problemsOf(TODO_ONLY);
  assert.equal(run.channel.files.length, 1, "文件跑完了 ⇒ 完成事件照常产出");
  assert.match(problems, /todo=1/, `必须点名 todo：${problems}`);
  assert.doesNotMatch(problems, COVERAGE_RE, "覆盖判据不得误红（否则会掩盖 todo 判据）");
  assert.throws(() => assertNestedSuitePassed(run, "todo-only"), /待办|todo/);
  t.diagnostic(`evidence: suite=g416-todo exit=${run.code} red=todo-1 coverage=ok`);
});

test("g-416 判据1：skip-only ⇒ 红因来自 skipped（文件完成事件正常产出）", async (t) => {
  const { run, problems } = await problemsOf(SKIP_ONLY);
  assert.equal(run.channel.files.length, 1, "文件跑完了 ⇒ 完成事件照常产出");
  assert.match(problems, /skipped=1/, `必须点名 skipped：${problems}`);
  assert.doesNotMatch(problems, COVERAGE_RE, "覆盖判据不得误红");
  assert.throws(() => assertNestedSuitePassed(run, "skip-only"), /跳过|skipped/);
  t.diagnostic(`evidence: suite=g416-skip exit=${run.code} red=skipped-1 coverage=ok`);
});

test("g-416 判据1：SIGKILL 测试文件进程 ⇒ 非零退出 + 该文件无完成事件 ⇒ 判红", async (t) => {
  const { run, problems } = await problemsOf(SIGKILL_FIXTURE);
  // `node --test` 默认按文件隔离进程：杀掉文件进程后 runner 仍能收尾（exit 1 / fail 1），
  // 但**逐文件完成事件不会产出** ⇒ 判红；这里同时钉住「被杀不得被当成 0 失败放行」。
  assert.notEqual(run.code, 0, `被 SIGKILL 的文件不得让 runner 判绿（exit=${run.code}）`);
  assert.ok(run.summary.fail >= 1, `runner 必须报告该文件失败（fail=${run.summary.fail}）`);
  assert.equal(run.channel.files.length, 0, "被杀文件不得产出逐文件完成事件");
  assert.match(problems, /退出码|失败/, `红因必须可读地点名退出码/失败：${problems}`);
  assert.throws(() => assertNestedSuitePassed(run, "SIGKILL 文件进程"), /退出码|失败/);
  t.diagnostic(`evidence: suite=g416-sigkill-file exit=${String(run.code)} fail=${run.summary.fail} files=0`);
});

test("g-416 判据1：SIGKILL 运行器进程 ⇒ code null + 通道未收尾 ⇒ 判红", async (t) => {
  const { run, problems } = await problemsOf(KILL_RUNNER);
  assert.equal(run.code, null, `子 runner 被信号终止时 code 必须为 null（实际 ${run.code}）`);
  assert.equal(run.channel.tally, null, "runner 被杀 ⇒ 干净通道没有逐事件计数（未收尾）");
  assert.equal(run.channel.summary, null, "runner 被杀 ⇒ 事件通道没有任何汇总");
  assert.match(problems, /退出码|信号|事件通道/, `红因必须可读地点名信号/通道：${problems}`);
  assert.throws(() => assertNestedSuitePassed(run, "SIGKILL 运行器"), /信号|汇总|事件通道|完成事件|退出码/);
  t.diagnostic(`evidence: suite=g416-sigkill-runner exit=${String(run.code)} channel_tally=null`);
});

test("g-416 判据3：伪造 ℹ tests 99 全绿汇总 + 早退 ⇒ 计数只认事件通道，覆盖判据判红", async (t) => {
  const { run, problems } = await problemsOf(FORGED_SUMMARY);
  // 人类可读通道里确实混入了测试打印的伪造块（summaryBlocks > 1），但它**不得**污染判定：
  // 末尾才是 runner 真实汇总（tests 1），权威计数只认带类型事件通道。
  assert.ok(run.summary.summaryBlocks > 1, `伪造块必须可见（summaryBlocks=${run.summary.summaryBlocks}）`);
  assert.equal(run.summary.tests, 1, "伪造的 tests 99 不得被采纳（必须取末尾的真实汇总）");
  assert.equal(run.summary.pass, 1, "伪造的 pass 99 不得被采纳");
  assert.equal(run.channel.summary?.tests, 1, "事件通道里只有 runner 自产的 typed 汇总");
  assert.equal(run.channel.files.length, 0, "早退文件没有完成事件");
  assert.match(problems, COVERAGE_RE, `必须点名完成事件缺失：${problems}`);
  assert.equal(run.code, 0, "该形态 exit 0 —— 旧判据据此放行（复现前提）");
  assert.throws(() => assertNestedSuitePassed(run, "伪造汇总"), COVERAGE_RE);
  t.diagnostic(`evidence: suite=g416-forged exit=${run.code} forged_not_adopted=1 red=no-completion-event`);
});

// ============================================================================
// 判据 1/2：正向多文件全绿 + 目标集合推导
// ============================================================================

test("g-416 判据1（正向）：多文件全绿 ⇒ 覆盖判据不得误红", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", PASS_A, PASS_B], { cwd: repoRoot });
  assert.deepEqual(nestedSuitePassProblems(run), [], "全绿多文件不得被判红");
  assertNestedSuitePassed(run, "g-416 多文件全绿");
  assert.equal(run.targets.length, 2, "目标集合必须推导出 2 个文件");
  assert.equal(run.channel.files.length, 2, "两个文件都必须产出完成事件");
  assert.equal(run.summary.tests, 2, "两个文件的用例都必须真的跑");
  t.diagnostic(`evidence: suite=g416-coverage-multifile exit=${run.code} targets=2 files=2`);
});

test("g-416 判据2：目标集合由调用参数推导（多文件 / 取值选项 / -- 分隔 / 默认发现为 null）", () => {
  assert.deepEqual(deriveNestedTargetTokens(["--test", "a.test.ts", "b.test.ts"]), ["a.test.ts", "b.test.ts"]);
  assert.deepEqual(
    deriveNestedTargetTokens(["--test-reporter=spec", "--test", "a.test.ts"]),
    ["a.test.ts"],
    "带 = 的选项 token 不得被当成目标",
  );
  assert.deepEqual(
    deriveNestedTargetTokens(["--test", "--test-concurrency", "4", "a.test.ts"]),
    ["a.test.ts"],
    "独立取值的选项（--test-concurrency 4）后面的值不得被当成目标",
  );
  assert.deepEqual(
    deriveNestedTargetTokens(["--test", "--", "-weird-name.test.ts"]),
    ["-weird-name.test.ts"],
    "-- 之后一律是目标",
  );
  assert.deepEqual(deriveNestedTargetTokens(["--test"]), [], "只有 --test（默认文件发现）⇒ 推导出空集合");
  assert.equal(deriveNestedTargetTokens(["a.test.ts"]), null, "没有 --test ⇒ 推导失败（需显式声明 targets）");
});

test("g-416 判据2：目录 / glob 展开口径与顶层闸门一致（含不支持的 glob 形态 fail-closed）", (t) => {
  const dirFiles = expandNestedTargets([FIXTURES], repoRoot);
  assert.ok(dirFiles.length >= 8, `目录必须递归展开为全部 *.test.ts（实际 ${dirFiles.length}）`);
  assert.ok(dirFiles.every((f) => f.endsWith(".test.ts")), "目录展开只能收测试文件");
  const globFiles = expandNestedTargets(["core/tests/fixtures/g416/*.test.ts"], repoRoot);
  assert.deepEqual(globFiles, dirFiles, "等价 glob 与目录入参必须展开出同一集合（同口径）");
  assert.throws(
    () => expandNestedTargets(["core/**/*.test.ts"], repoRoot),
    /不支持的 glob 形态/,
    "闸门不支持的 glob 形态必须 fail-closed（不静默判绿）",
  );
  t.diagnostic(`evidence: suite=g416-target-expansion dir=${dirFiles.length} glob=${globFiles.length}`);
});

test("g-416 判据2：无法推导目标 ⇒ fail-closed（抛错 / 判红），无跳过覆盖的静默路径", () => {
  assert.throws(
    () => runNestedArgv(process.execPath, ["--test"], { cwd: repoRoot }),
    /fail-closed|显式传 opts\.targets/,
    "argv 形态无法推导目标必须抛错",
  );
  assert.throws(
    () => runNestedCommand("node --test", { cwd: repoRoot }),
    /fail-closed|显式传 opts\.targets/,
    "shell 形态无法推导目标必须抛错",
  );
  const empty = parseEventChannel("");
  assert.ok(nestedTargetCoverageProblems([], empty, repoRoot).length > 0, "目标集合为空必须判红");
  assert.ok(nestedTargetCoverageProblems(null, empty, repoRoot).length > 0, "目标未声明必须判红（无 opt-out）");
  assert.ok(
    nestedTargetCoverageProblems([PASS_A], empty, repoRoot).length > 0,
    "目标未产出完成事件必须判红",
  );
});

test("g-416 判据2：显式声明 targets 被采信且被真正校验（一致 ⇒ 通过；与推导不一致 ⇒ 拒绝，g-418 收紧）", async (t) => {
  const ok = await runNestedArgv(process.execPath, ["--test", PASS_A], { cwd: repoRoot, targets: [PASS_A] });
  assert.deepEqual(nestedSuitePassProblems(ok), [], "显式声明与真实目标一致 ⇒ 必须通过（逃生口可用）");
  // g-418①（语义收紧）：`args` 可推导时**必须以推导集合为准**；声明错文件不再「跑完再由覆盖判据判红」，
  // 而是**在 spawn 之前直接拒绝**（旧实现会静默取声明）；覆盖判据仍保留给「无法推导时用声明」的形态。
  assert.throws(
    () => runNestedArgv(process.execPath, ["--test", PASS_A], { cwd: repoRoot, targets: [PASS_B] }),
    /不一致|精确一致/,
    "声明的目标与推导集合不一致 ⇒ 必须拒绝执行（声明不能被当成橡皮图章）",
  );
  t.diagnostic(`evidence: suite=g416-explicit-targets ok=accepted mismatched=refused`);
});

// ============================================================================
// 判据 4：变异对照（私有副本去掉覆盖检查 ⇒ 早退夹具复活为被接受）
// ============================================================================

test("g-416 判据4 变异对照：私有副本去掉覆盖检查 ⇒ 反射早退夹具复活为被接受", async (t) => {
  const helperSrc = readFileSync(HELPER, "utf8");
  const anchor = "  problems.push(...nestedTargetCoverageProblems(run.targets, channel, run.cwd));";
  const mutantSrc = helperSrc.replace(anchor, "  // mutant: coverage removed");
  assert.notEqual(mutantSrc, helperSrc, "变异锚点失效：helper 必须存在覆盖断言那一行");

  // 变异副本必须与被测 helper **同相对深度**（私有 reporter 路径由 import.meta.url 推导），
  // 故建一个含 `scripts/` 的临时根，并以 symlink 指向真实 reporter（不写仓库、不复制产物）。
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g416-mutant-"));
  try {
    const fixturesDir = join(dir, "core", "tests", "fixtures");
    mkdirSync(fixturesDir, { recursive: true });
    mkdirSync(join(dir, "scripts"), { recursive: true });
    symlinkSync(REPORTER, join(dir, "scripts", "test-reporter-events.mjs"));
    const mutantPath = join(fixturesDir, "nested-runner-mutant.ts");
    writeFileSync(mutantPath, mutantSrc);
    const mutant = (await import(pathToFileURL(mutantPath).href)) as typeof import("./fixtures/nested-runner.ts");

    // 前提：真实 helper 对同一夹具判红。
    const real = await runNestedArgv(process.execPath, ["--test", REFLECTION_EXIT], { cwd: repoRoot });
    assert.throws(() => assertNestedSuitePassed(real, "真实 helper"), COVERAGE_RE, "前提：真实 helper 必须判红");

    // 变异 helper：同一夹具复活为「被接受」（证明覆盖检查就是判别力来源）。
    const run = await mutant.runNestedArgv(process.execPath, ["--test", REFLECTION_EXIT], { cwd: repoRoot });
    assert.equal(run.code, 0, "变异运行仍应 exit 0");
    assert.equal(run.summary.tests, 1, "变异的只是覆盖判据，计数不变");
    assert.deepEqual(
      mutant.nestedSuitePassProblems(run),
      [],
      "去掉覆盖检查后旧判据必须重新接受早退形态（复活）",
    );
    mutant.assertNestedSuitePassed(run, "变异 helper（覆盖检查已去掉）");
    t.diagnostic(`evidence: suite=g416-helper-mutant real=red mutant=accepted exit=${run.code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 5：接线结构守卫 + 夹具位置 + 文档口径
// ============================================================================

test("g-416 判据5：helper 内判据 + 闸门传入 targets/channel（接线不是死代码）", (t) => {
  const helperSrc = readFileSync(HELPER, "utf8");
  assert.match(
    helperSrc,
    /nestedTargetCoverageProblems\(run\.targets, channel, run\.cwd\)/,
    "全绿判据必须自己核对逐目标文件完成事件",
  );
  assert.match(helperSrc, /export function nestedTargetCoverageProblems/, "覆盖判据必须有唯一实现");
  assert.match(helperSrc, /--test-reporter=/, "事件通道必须由 helper 注入 reporter");

  const gateSrc = readFileSync(GATE, "utf8");
  assert.match(gateSrc, /targets: targetFiles,/, "闸门必须把目标集合挂到 run 上（helper 判据据此比对）");
  assert.match(gateSrc, /channel,\s*\n\s*\};/m, "闸门必须把干净事件通道挂到 run 上");
  assert.match(
    gateSrc,
    /coverageProblems\(targetFiles, channel\)/,
    "闸门侧既有覆盖断言必须保留（只增不减，双保险）",
  );
  t.diagnostic(`evidence: suite=g416-wiring helper=coverage gate=targets+channel`);
});

test("g-416 判据5：负向/正向夹具都在 fixtures 子目录（不被顶层 glob 误收）", (t) => {
  const topLevel = readdirSync(TESTS_DIR).filter((name) => name.endsWith(".test.ts"));
  for (const name of [
    "reflection-exit.test.ts",
    "direct-exit.test.ts",
    "todo-only.test.ts",
    "skip-only.test.ts",
    "sigkill.test.ts",
    "kill-runner.test.ts",
    "forged-summary.test.ts",
  ]) {
    assert.ok(!topLevel.includes(name), `${name} 不得出现在 core/tests 顶层`);
  }
  t.diagnostic(`evidence: suite=g416-fixture-placement top_level_hits=0`);
});
