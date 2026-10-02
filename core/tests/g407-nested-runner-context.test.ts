/**
 * core/tests/g407-nested-runner-context.test.ts
 *
 * g-407：`NODE_TEST_CONTEXT` 继承导致**嵌套 `node --test` 静默 skip 全部用例并 exit 0**，
 * 使「应当报红的断言」变成**永真**（false green）——直接侵蚀全部测试证据的可信度。
 *
 * 本套件把四件事钉死（每条都带负向对照，改坏即红）：
 *  ① **最小复现**：继承 `NODE_TEST_CONTEXT=child-v8` 跑一个故意失败的嵌套套件 ⇒
 *     exit 0、零汇总输出、stderr 含 `skipping running files`；同一个夹具在干净 env 下 exit≠0。
 *     并实证「只看退出码的聚合断言」在此形态下永真。
 *  ② **审计固化**：全仓唯一实现「摘除 NODE_TEST_CONTEXT」的地方必须是共用 helper
 *     （`fixtures/nested-runner.ts`），任何套件不得各写一份；嵌套 runner 必须经由 helper 启动。
 *  ③ **修复**：经 helper 启动后同一失败套件**真实报红**（非零退出 **且** 含预期错误特征），
 *     且「零用例 / 被 skip / 无汇总」是**显式失败**（回退修复即红）。
 *  ④ **判别力**：helper 不会把正常全绿的嵌套运行误判为红（守卫不是恒抛的假守卫）。
 *
 * 边界：不改 runner 选型、不引入新依赖/新框架、不改被测产品逻辑。
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  assertNestedSuiteFailed,
  assertNestedSuitePassed,
  assertNestedSuiteRan,
  cleanTestEnv,
  parseTestSummary,
  runNestedArgv,
  type NestedRunResult,
} from "./fixtures/nested-runner.ts";

const repoRoot = join(import.meta.dirname, "../..");
const FIXTURE_FAIL = join(import.meta.dirname, "fixtures/g407/always-fail.test.ts");
const FIXTURE_PASS = join(import.meta.dirname, "fixtures/g407/always-pass.test.ts");
const FAIL_MARKER = "G407_ALWAYS_FAIL_MARKER";
const HELPER_REL = "core/tests/fixtures/nested-runner.ts";
const HELPER_ABS = join(repoRoot, HELPER_REL);

/** 测试文件进程本该被宿主注入的值；缺失时（如本文件被当脚本直跑）显式注入同一形态。 */
const INHERITED_CONTEXT = process.env.NODE_TEST_CONTEXT || "child-v8";

/**
 * 缺陷的「永真」形态：聚合断言只看**退出码**。
 * 子进程「根本没跑用例」与「跑完且全绿」的退出码同为 0 ⇒ 该断言无法区分二者。
 */
const naiveLooksGreen = (code: number | null): boolean => code === 0;

/** 用**原始（不清洗）** env 跑嵌套 runner，复刻宿主继承形态。 */
function rawRun(fixture: string, env: NodeJS.ProcessEnv): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--test", fixture], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
    env,
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

const rawInheritedRun = (fixture: string) =>
  rawRun(fixture, { ...process.env, NODE_TEST_CONTEXT: INHERITED_CONTEXT });

function asResult(r: { code: number | null; out: string; err: string }, command = "(synthetic)"): NestedRunResult {
  return { ...r, command, summary: parseTestSummary(r.out, r.err) };
}

// ============================================================================
// ① 最小复现：继承 NODE_TEST_CONTEXT ⇒ 嵌套 runner 静默 skip + exit 0
// ============================================================================

test("g-407 判据 1：继承 NODE_TEST_CONTEXT 时嵌套 node --test 静默 skip 全部用例并 exit 0", (t) => {
  const inherited = asResult(rawInheritedRun(FIXTURE_FAIL), "raw(run_ctx=inherited)");
  const clean = asResult(rawRun(FIXTURE_FAIL, cleanTestEnv()), "raw(run_ctx=cleaned)");
  t.diagnostic(
    `evidence: suite=g407-repro inherited_exit=${inherited.code} inherited_summary=${inherited.summary.hasSummary} ` +
      `skipMarker=${inherited.summary.runnerSkippedFiles} cleaned_exit=${clean.code} cleaned_fail=${clean.summary.fail}`,
  );

  // 缺陷本体：一个**必然失败**的套件，在继承形态下退出码为 0、且没有任何汇总输出。
  assert.equal(
    inherited.code,
    0,
    `继承 NODE_TEST_CONTEXT 的嵌套 runner 必须复现 exit 0（实际 ${inherited.code}）\n${inherited.err.slice(-600)}`,
  );
  assert.equal(
    inherited.summary.hasSummary,
    false,
    `继承形态下不应有汇总输出（否则复现前提不成立）：\n${inherited.out.slice(-600)}`,
  );
  assert.equal(inherited.out.trim(), "", "继承形态下 stdout 应为空 —— 用例根本没跑");
  assert.equal(
    inherited.summary.runnerSkippedFiles,
    true,
    `继承形态必须打印 skipping running files（实际 stderr：${inherited.err.slice(-600)}）`,
  );

  // 「报红断言变永真」的实证：同一个夹具、同一个断言，只因为 env 不同而翻转；
  // 且「看起来绿」的那一次**一个用例都没跑**（fail 计数根本不存在）。
  assert.equal(
    naiveLooksGreen(inherited.code),
    true,
    "只看退出码的聚合断言在继承形态下会判「全绿」—— 这正是永真（false green）",
  );
  assert.equal(naiveLooksGreen(clean.code), false, "干净 env 下同一夹具必须报红，证明前述「绿」纯属跳过");
  assert.notEqual(clean.code, 0, "干净 env 下必然失败的套件必须非零退出");
  assert.equal(clean.summary.hasSummary, true, "干净 env 下必须真的有汇总输出");
  assert.ok(clean.summary.fail >= 1, `干净 env 下必须观测到真实失败用例（fail=${clean.summary.fail}）`);
});

// ============================================================================
// ③ 修复：经共用 helper 启动 ⇒ 真实报红（双断言）+ 零用例/被 skip 显式失败
// ============================================================================

test("g-407 判据 3：共用 helper 清除 NODE_TEST_CONTEXT 后，同一失败套件必须真实报红（双断言）", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", FIXTURE_FAIL], { cwd: repoRoot });
  t.diagnostic(
    `evidence: suite=g407-helper exit=${run.code} pass=${run.summary.pass} fail=${run.summary.fail} ` +
      `skipped=${run.summary.skipped} hasSummary=${run.summary.hasSummary} skipMarker=${run.summary.runnerSkippedFiles}`,
  );

  // 双断言：非零退出 **且** 输出含预期错误特征 —— 单点永真被消除。
  assertNestedSuiteFailed(run, "g-407 helper 嵌套失败套件", new RegExp(FAIL_MARKER));
  assert.equal(run.summary.runnerSkippedFiles, false, "经 helper 启动不得再出现 skipping running files");
  assert.ok(run.summary.fail >= 1, `经 helper 启动必须观测到真实失败用例（fail=${run.summary.fail}）`);
});

test("g-407 判据 3（判别力对照）：helper 不会把正常全绿的嵌套运行误判为红", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", FIXTURE_PASS], { cwd: repoRoot });
  t.diagnostic(`evidence: suite=g407-helper-green exit=${run.code} pass=${run.summary.pass} fail=${run.summary.fail}`);
  assertNestedSuitePassed(run, "g-407 helper 嵌套通过套件");
});

test("g-407 判据 3：零用例 / 被 skip / 无汇总 ⇒ 显式失败（回退修复即红）", (t) => {
  // (a) 真实继承形态的输出喂进守卫 ⇒ 必须红，且红因点名 skip（这就是「回退修复」的形态：
  //     一旦 helper 不再清洗 env，调用方拿到的就是这份结果，守卫立刻变红）。
  const inherited = asResult(rawInheritedRun(FIXTURE_FAIL), "raw(run_ctx=inherited)");
  assert.throws(
    () => assertNestedSuiteRan(inherited, "回退修复（继承 NODE_TEST_CONTEXT）"),
    /skipping running files|跳过了全部用例/,
    "继承形态（= 回退修复后）必须被守卫判红，否则修复不可验证",
  );

  // (b) 没有任何汇总的「空输出」⇒ 红（退出码 0 也不能放行）。
  assert.throws(
    () => assertNestedSuiteRan(asResult({ code: 0, out: "", err: "" }), "零输出"),
    /没有输出任何汇总行/,
    "没有汇总行 ⇒ 用例根本没跑，必须判红",
  );

  // (c) 汇总存在但用例总数为 0 ⇒ 红（「零测试通过」是显式失败）。
  const zero = asResult({ code: 0, out: "ℹ tests 0\nℹ pass 0\nℹ fail 0\n", err: "" }, "zero-tests");
  assert.equal(zero.summary.hasSummary, true, "前提：该合成输出含汇总块");
  assert.throws(
    () => assertNestedSuiteRan(zero, "零用例"),
    /零用例/,
    "零用例必须判红（零测试通过 = 失败）",
  );
  t.diagnostic("evidence: suite=g407-zero-or-skip-guard red_on_skip=1 red_on_no_summary=1 red_on_zero_tests=1");
});

test("g-407 判据 3：双断言各自独立生效（单点永真被消除）", () => {
  const ranButNoSignature = asResult({
    code: 1,
    out: "✔ unrelated\nℹ tests 1\nℹ pass 0\nℹ fail 1\n",
    err: "",
  });
  assert.throws(
    () => assertNestedSuiteFailed(ranButNoSignature, "退出码红但无预期特征", new RegExp(FAIL_MARKER)),
    /必须输出预期错误特征/,
    "只有非零退出、没有预期错误特征 ⇒ 不足以证明负向对照成立，必须判红",
  );

  const signatureButZeroExit = asResult({
    code: 0,
    out: `ℹ tests 1\nℹ pass 1\nℹ fail 0\n${FAIL_MARKER}\n`,
    err: "",
  });
  assert.throws(
    () => assertNestedSuiteFailed(signatureButZeroExit, "有特征但零退出", new RegExp(FAIL_MARKER)),
    /必须非零退出/,
    "只有错误特征、退出码为 0 ⇒ 必须判红（否则仍是单点永真）",
  );
});

// ============================================================================
// ② 全仓审计固化为结构守卫
// ============================================================================

test("g-407 判据 2：摘除 NODE_TEST_CONTEXT 的唯一实现必须在共用 helper（禁各写一份）", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(join(repoRoot, "core", "tests"))) {
    if (!name.endsWith(".ts")) continue;
    const rel = `core/tests/${name}`;
    const abs = join(repoRoot, "core", "tests", name);
    if (abs === HELPER_ABS) continue;
    const src = readFileSync(abs, "utf8");
    // 本套件自身在注释/夹具里会提到该变量名，只禁「自行摘除」的实现形态。
    if (/delete\s+[\w.$]*\[\s*["'`]NODE_TEST_CONTEXT|delete\s+[\w.$]+\.NODE_TEST_CONTEXT/.test(src)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下套件自行摘除 NODE_TEST_CONTEXT（必须改用 ${HELPER_REL} 的 cleanTestEnv，唯一实现）：${offenders.join(", ")}`,
  );
  const helper = readFileSync(HELPER_ABS, "utf8");
  assert.match(helper, /export function cleanTestEnv/, "helper 必须导出 cleanTestEnv");
  assert.match(helper, /export function assertNestedSuiteRan/, "helper 必须导出 assertNestedSuiteRan");
  assert.ok(
    !HELPER_REL.endsWith(".test.ts"),
    "helper 不得以 .test.ts 命名（否则会被顶层 glob 收作正式套件重复执行）",
  );
});

test("g-407 判据 2：嵌套 runner 必须经 helper 启动（spawn 里出现 --test 字面量即须导入 helper）", () => {
  const offenders: string[] = [];
  for (const name of readdirSync(join(repoRoot, "core", "tests"))) {
    if (!name.endsWith(".test.ts")) continue;
    const rel = `core/tests/${name}`;
    const src = readFileSync(join(repoRoot, "core", "tests", name), "utf8");
    if (/from\s+["'`]\.\/fixtures\/nested-runner\.ts["'`]/.test(src)) continue;
    // 只看 spawn 调用点附近的文本窗口，避免把「文档里提到 node --test」误判为调用。
    for (const m of src.matchAll(/\b(?:spawn|spawnSync|execFile|execFileSync|execSync)\s*\(/g)) {
      const window = src.slice(m.index, m.index + 400);
      if (/--test\b/.test(window)) {
        offenders.push(`${rel}@${src.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `以下调用点在 spawn 里直接起测试 runner 却未导入 ${HELPER_REL}：${offenders.join(", ")}`,
  );
});

test("g-407 判据 2：已审计的唯一受影响站点（g-353 check:dist）确实接到 helper 上（修复已接线，非死代码）", () => {
  const rel = "core/tests/g353-build-chain-boundaries.test.ts";
  const src = readFileSync(join(repoRoot, rel), "utf8");
  assert.match(
    src,
    /from\s+["'`]\.\/fixtures\/nested-runner\.ts["'`]/,
    `${rel} 必须导入共用 helper（它是全仓唯一经子进程跑嵌套 runner 的站点）`,
  );
  assert.match(src, /\brunNestedCommand\s*\(/, `${rel} 的 check:dist 嵌套运行必须走 helper 的 runNestedCommand`);
  assert.match(src, /\bassertNestedSuiteRan\s*\(/, `${rel} 必须在嵌套运行后断言「确实跑了用例」`);
  assert.ok(
    !/delete\s+env\.NODE_TEST_CONTEXT/.test(src),
    `${rel} 不得再自行摘除 NODE_TEST_CONTEXT（唯一实现已收归 helper）`,
  );
  assert.match(
    src,
    /\bassertNestedSuiteRan\(\s*redStale/,
    "陈旧产物负向对照也必须先断言「确实跑了用例」，否则该报红断言仍可能永真",
  );
  assert.match(
    src,
    /\bassertNestedSuiteRan\(\s*redModule/,
    "漏模块负向对照也必须先断言「确实跑了用例」，否则该报红断言仍可能永真",
  );
});
