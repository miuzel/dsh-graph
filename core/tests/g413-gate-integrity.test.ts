/**
 * core/tests/g413-gate-integrity.test.ts
 *
 * g-413（v0.19.7 lane）：整套件自证闸门 `scripts/run-tests.mjs` 的两条 false-green 洞 + 共用 helper 收口。
 *
 *  P1-1 **取消不算红**：旧收尾只断言 `tests>0 && fail===0 && skipped===0`，不看**子进程退出码**、
 *       也不看 `cancelled` ⇒ `test(…,{timeout:1},()=>new Promise(()=>{}))` 产出
 *       `tests 2 / pass 1 / fail 0 / cancelled 1 / skipped 0`，闸门仍打印 `✔ 自证通过` 并 `exit 0`。
 *  P1-2 **计数通道可被污染**：旧 `parseTestSummary` 取**首个**匹配行，测试自己的 `console.log`
 *       会排在 runner 汇总之前 ⇒ 伪造 `ℹ tests 1 / skipped 0` 即可让 `skipped>0` 的套件显示全绿。
 *
 * 本套件把「六种负向形态必须 exit≠0」+「正向不回归」+「干净通道的三方交叉校验」逐条钉死，
 * 并用**回退对照**（把 `cleanTestEnv()` 换回 `{...process.env}` 的变异副本）证明检测力不是恒真。
 * 边界：不动产品逻辑；负向夹具都在 `fixtures/g413/`（不被顶层 glob 误收）且靠 `timeout`/自杀收敛，不挂起。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertNestedSuitePassed,
  nestedSuitePassProblems,
  parseEventChannel,
  parseTestSummary,
  type NestedRunResult,
} from "./fixtures/nested-runner.ts";

const repoRoot = join(import.meta.dirname, "../..");
const GATE = join(repoRoot, "scripts", "run-tests.mjs");
const REPORTER = join(repoRoot, "scripts", "test-reporter-events.mjs");
const FIXTURES = join(repoRoot, "core", "tests", "fixtures");

const PASS_FIXTURE = join(FIXTURES, "g407", "always-pass.test.ts");
const FAIL_FIXTURE = join(FIXTURES, "g407", "always-fail.test.ts");
const CANCEL_FIXTURE = join(FIXTURES, "g413", "always-cancel.test.ts");
const SKIP_FIXTURE = join(FIXTURES, "g413", "always-skip.test.ts");
const FORGED_FIXTURE = join(FIXTURES, "g413", "forged-summary.test.ts");
const KILL_FIXTURE = join(FIXTURES, "g413", "kill-runner.test.ts");
const SUITE_FIXTURE = join(FIXTURES, "g413", "with-suite.test.ts");

/**
 * 跑一次闸门。超时/启动失败一律**显式失败** —— 否则「非零退出」可能只是外部超时造成的假红，
 * 负向对照就成了永真。
 */
function runGate(targets: string[], env: NodeJS.ProcessEnv = { ...process.env }, script = GATE) {
  const r = spawnSync(process.execPath, [script, ...targets], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
  assert.equal(r.error, undefined, `闸门不得超时/启动失败：${r.error?.message ?? ""}`);
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

/** 闸门 stderr 里的红因行（`[run-tests] ✖ …`）。 */
function redReason(err: string): string {
  return err.split("\n").find((line) => line.includes("[run-tests] ✖")) ?? "";
}

function syntheticRun(code: number | null, out: string): NestedRunResult {
  return { code, out, err: "", summary: parseTestSummary(out, ""), command: "(synthetic)" };
}

const summaryBlock = (o: { tests: number; pass: number; fail: number; cancelled: number; skipped: number; todo?: number }) =>
  [
    `ℹ tests ${o.tests}`,
    "ℹ suites 0",
    `ℹ pass ${o.pass}`,
    `ℹ fail ${o.fail}`,
    `ℹ cancelled ${o.cancelled}`,
    `ℹ skipped ${o.skipped}`,
    `ℹ todo ${o.todo ?? 0}`,
  ].join("\n");

// ============================================================================
// 判据 3：六种负向形态 ⇒ 闸门必须 exit≠0 且红因可读
// ============================================================================

test("g-413 判据3①：被取消用例（cancelled>0，exit 非零）⇒ 闸门 exit≠0 且红因点名取消", (t) => {
  const g = runGate([CANCEL_FIXTURE]);
  assert.notEqual(g.code, 0, `被取消的用例必须判红（闸门 exit=${g.code}）\n${g.out.slice(-400)}`);
  assert.match(redReason(g.err), /取消|cancelled/, `红因必须点名 cancelled：${redReason(g.err)}`);
  assert.doesNotMatch(g.out, /✔ 自证通过/, "判红时不得回显自证通过行");
  t.diagnostic(`evidence: suite=g413-gate-cancel exit=${g.code} red=cancelled`);
});

test("g-413 判据3②：失败用例 ⇒ 闸门 exit≠0 且红因点名 fail", (t) => {
  const g = runGate([FAIL_FIXTURE]);
  assert.notEqual(g.code, 0, `失败用例必须判红（闸门 exit=${g.code}）`);
  assert.match(redReason(g.err), /失败用例|fail=/, `红因必须点名失败用例：${redReason(g.err)}`);
  t.diagnostic(`evidence: suite=g413-gate-fail exit=${g.code} red=fail`);
});

test("g-413 判据3③：skipped>0（exit 0 的形态）⇒ 闸门 exit≠0 且红因点名跳过", (t) => {
  const g = runGate([SKIP_FIXTURE]);
  assert.notEqual(g.code, 0, `skipped>0 不得放行（闸门 exit=${g.code}）`);
  assert.match(redReason(g.err), /跳过|skipped=1/, `红因必须点名 skipped：${redReason(g.err)}`);
  t.diagnostic(`evidence: suite=g413-gate-skip exit=${g.code} red=skipped`);
});

test("g-413 判据3④：伪造汇总行（测试 console.log 先打印全绿汇总）⇒ 绝不报成功，且计数与真实 runner 一致", (t) => {
  const g = runGate([FORGED_FIXTURE]);
  assert.notEqual(g.code, 0, `伪造汇总行必须被识破（闸门 exit=${g.code}）\n${g.out.slice(-600)}`);
  assert.doesNotMatch(g.out, /✔ 自证通过/, "伪造汇总不得让闸门回显自证通过");
  const red = redReason(g.err);
  assert.match(red, /skipped=1/, `红因必须给出与真实 runner 一致的计数（真实 skipped=1）：${red}`);
  assert.match(red, /跳过|汇总块/, `红因必须指出跳过/汇总块不唯一：${red}`);
  t.diagnostic(`evidence: suite=g413-gate-forged exit=${g.code} red=counts-consistent-and-ambiguous`);
});

test("g-413 判据3⑤：未加载用例（NODE_TEST_CONTEXT 顶层注入形态）⇒ 回退修复即红的变异闸门必须 exit≠0", (t) => {
  // 原闸门对该形态的防线是 cleanTestEnv() 摘除注入变量（见下一条正向用例）；这里把那一行**变异回**
  // `{...process.env}`（= 回退 g-407 修复），注入形态下 runner 会 `skipping running files` 且 exit 0
  // ⇒ 闸门必须判红，证明「未加载用例」不是恒绿。
  const original = readFileSync(GATE, "utf8");
  const mutantSrc = original.replace("env: cleanTestEnv(),", "env: { ...process.env },");
  assert.notEqual(mutantSrc, original, "变异锚点失效：闸门里必须存在 `env: cleanTestEnv(),`");
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g413-mutant-"));
  try {
    const fixed = mutantSrc.replace(
      /const repoRoot = join\(dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\."\);/,
      `const repoRoot = ${JSON.stringify(repoRoot)};`,
    );
    assert.notEqual(fixed, mutantSrc, "变异副本的 repoRoot 重写锚点失效");
    const mutant = join(dir, "run-tests-mutant.mjs");
    writeFileSync(mutant, fixed);
    const g = runGate([PASS_FIXTURE], { ...process.env, NODE_TEST_CONTEXT: "child-v8" }, mutant);
    assert.notEqual(g.code, 0, "回退「摘除注入变量」后，未加载用例形态必须被判红（否则自证永真）");
    assert.match(
      redReason(g.err),
      /跳过了全部用例|没有输出任何汇总行|零用例/,
      `红因必须红在「用例根本没跑」：${redReason(g.err)}`,
    );
    t.diagnostic(`evidence: suite=g413-gate-unloaded exit=${g.code} red=no-summary-or-skip`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-413 判据3⑥：子 runner 被信号杀死（SIGKILL）⇒ 闸门 exit≠0 且红因可读", (t) => {
  const g = runGate([KILL_FIXTURE]);
  assert.notEqual(g.code, 0, `被信号杀死的 runner 必须判红（闸门 exit=${g.code}）`);
  assert.match(
    redReason(g.err),
    /没有输出任何汇总行|没有逐事件计数|信号|exit=null/,
    `红因必须说明通道未完成：${redReason(g.err)}`,
  );
  t.diagnostic(`evidence: suite=g413-gate-signal exit=${g.code} red=channel-incomplete`);
});

// ============================================================================
// 判据 4：正向不回归（含注入形态下的自证）
// ============================================================================

test("g-413 判据4：正向路径（必然通过）⇒ 闸门 exit 0 并回显自证行（tests>0/cancelled=0）", (t) => {
  const g = runGate([PASS_FIXTURE]);
  assert.equal(g.code, 0, `正向路径必须判绿：\n${g.err.slice(-800)}`);
  assert.match(g.out, /\[run-tests\] ✔ 自证通过：tests=1 \(>0\) skipped=0 fail=0 cancelled=0/, "必须回显完整自证行");
  t.diagnostic(`evidence: suite=g413-gate-green exit=${g.code} echo=selftest-line`);
});

test("g-413 判据4：顶层注入形态下闸门仍真跑用例并判绿（cleanTestEnv 防线不回归）", (t) => {
  const g = runGate([PASS_FIXTURE], { ...process.env, NODE_TEST_CONTEXT: "child-v8" });
  assert.equal(g.code, 0, `注入形态下闸门必须先摘除注入变量再真跑：\n${g.err.slice(-800)}`);
  assert.match(g.out, /\[run-tests\] ✔ 自证通过：tests=1/, "注入形态下仍必须回显「真跑」的自证行");
  assert.doesNotMatch(g.out, /skipping running files/, "闸门内部不得残留 skip 标记");
  t.diagnostic(`evidence: suite=g413-gate-injected exit=${g.code} tests=1`);
});

test("g-413 判据1（回归）：describe 聚合事件不得被计成用例（tally 与 runner 汇总必须一致）", (t) => {
  // 全量套件实测过：不区分 `details.type === "suite"` 会把 tally 多算 9（= suites 数）⇒ 交叉校验误红。
  const g = runGate([SUITE_FIXTURE]);
  assert.equal(g.code, 0, `含 describe 的全绿套件必须判绿（tally 不得把 suite 事件计成用例）：\n${g.err.slice(-700)}`);
  assert.match(
    g.out,
    /\[run-tests\] ✔ 自证通过：tests=2 \(>0\) skipped=0 fail=0 cancelled=0/,
    "闸门必须报告 tests=2（两个子用例），不得把 describe 聚合事件也算成用例",
  );
  t.diagnostic(`evidence: suite=g413-gate-describe exit=${g.code} tests=2`);
});

// ============================================================================
// 判据 1/2：干净计数通道 + 共用 helper 判据（单元 + 结构守卫）
// ============================================================================

test("g-413 判据2：parseTestSummary 取**末尾**汇总，靠前的伪造行不再能覆盖真实计数", () => {
  const forged = `${summaryBlock({ tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0 })}\n✔ forged\n﹣ skipped # SKIP\n${summaryBlock({ tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 1 })}`;
  const s = parseTestSummary(forged, "");
  assert.equal(s.tests, 2, "必须取 runner 的最终汇总（真实 tests=2），不是伪造的 tests=1");
  assert.equal(s.skipped, 1, "真实 skipped=1 不得被伪造的 skipped=0 覆盖");
  assert.equal(s.pass, 1);
  assert.equal(s.summaryBlocks, 2, "两块汇总必须可数（供调用方判通道唯一性）");
});

test("g-413 判据2：parseEventChannel 只认带类型事件；人类可读文本进不了干净通道", () => {
  const clean = [
    JSON.stringify({ type: "summary", counts: { tests: 2, suites: 0, passed: 1, failed: 0, cancelled: 0, skipped: 1, todo: 0 } }),
    JSON.stringify({ type: "tally", counts: { tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 1, todo: 0 } }),
  ].join("\n");
  const r = parseEventChannel(clean);
  assert.equal(r.summary?.skipped, 1, "事件汇总必须解析出真实 skipped");
  assert.equal(r.tally?.tests, 2, "逐事件累加必须解析出来");
  assert.equal(r.summaries, 1);
  assert.equal(r.badLines, 0);

  const textOnly = parseEventChannel(`${summaryBlock({ tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0 })}\n`);
  assert.equal(textOnly.summary, null, "纯文本汇总在事件通道里只能算无法解析的行");
  assert.equal(textOnly.tally, null);
  assert.equal(textOnly.badLines, 7, "7 行人类可读文本必须全部被计为 badLines");
});

test("g-413 判据2：共用 helper 的全绿判据含 code/cancelled/skipped + 计数口径（取消不再被放行）", () => {
  const cancelled = syntheticRun(1, summaryBlock({ tests: 2, pass: 1, fail: 0, cancelled: 1, skipped: 0 }));
  const cancelledProblems = nestedSuitePassProblems(cancelled).join("；");
  assert.match(cancelledProblems, /退出码/, "退出码非零必须列入不达标项");
  assert.match(cancelledProblems, /cancelled=1/, "cancelled 必须单列（旧版只看 fail 会放行）");
  assert.throws(() => assertNestedSuitePassed(cancelled, "取消形态"), /取消|cancelled/);

  const skipped = syntheticRun(0, summaryBlock({ tests: 2, pass: 1, fail: 0, cancelled: 0, skipped: 1 }));
  assert.match(nestedSuitePassProblems(skipped).join("；"), /skipped=1/);
  assert.throws(() => assertNestedSuitePassed(skipped, "跳过形态"), /跳过|skipped/);

  const green = syntheticRun(0, summaryBlock({ tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0 }));
  assert.deepEqual(nestedSuitePassProblems(green), [], "正常全绿不得被误判为不达标");
  assertNestedSuitePassed(green, "绿色形态");

  const incoherent = syntheticRun(0, summaryBlock({ tests: 3, pass: 1, fail: 0, cancelled: 0, skipped: 0 }));
  assert.throws(() => assertNestedSuitePassed(incoherent, "口径不自洽"), /计数口径不自洽/);
});

test("g-413 判据1/2：闸门从干净事件通道取数并与人类汇总/退出码交叉校验（结构守卫）", () => {
  const src = readFileSync(GATE, "utf8");
  assert.match(src, /--test-reporter=spec/, "必须保留人类可读通道（观感不变）");
  assert.match(src, /test-reporter-events\.mjs/, "必须挂上干净事件通道 reporter");
  assert.match(src, /\bparseEventChannel\s*\(/, "计数必须来自事件通道解析");
  assert.match(src, /\bassertNestedSuiteRan\s*\(/, "必须保留「真的跑了」自证");
  assert.match(src, /\bnestedSuitePassProblems\s*\(/, "全绿判据必须复用 helper 的唯一实现");
  assert.match(src, /交叉校验|crossCheckProblems/, "必须做三方交叉校验");
  assert.equal(
    /const TEST_GLOB = "([^"]+)"/.exec(src)?.[1],
    "core/tests/*.test.ts",
    "默认 glob 必须与文档命令逐字相同（入口不分叉）",
  );

  const reporter = readFileSync(REPORTER, "utf8");
  assert.match(reporter, /ev\.type === "test:summary"/, "reporter 必须只转发带类型事件");
  // 结构性保证：reporter **只**产出 runner 自产的 summary/tally 记录 —— 测试 stdout 无法被转发进来。
  const emitted = [...reporter.matchAll(/yield\s+emit\(\{\s*type:\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(
    [...new Set(emitted)],
    ["summary", "tally"],
    `reporter 只允许产出 summary/tally（实际：${emitted.join(",")}）⇒ 伪造汇总进不了干净通道`,
  );
  assert.doesNotMatch(reporter, /ev\.type\s*===\s*"test:stdout"/, "reporter 不得按 test:stdout 分流测试输出");
});

test("g-413 判据5：负向夹具都在 fixtures 子目录（不被顶层 glob 误收）且不挂起", () => {
  const topLevel = readdirSync(join(repoRoot, "core", "tests")).filter((name) => name.endsWith(".test.ts"));
  for (const name of ["always-cancel.test.ts", "always-skip.test.ts", "forged-summary.test.ts", "kill-runner.test.ts", "with-suite.test.ts"]) {
    assert.ok(!topLevel.includes(name), `${name} 不得出现在 core/tests 顶层（会被顶层 glob 误收作正式套件）`);
    assert.ok(existsSync(join(FIXTURES, "g413", name)), `负向夹具必须存在：core/tests/fixtures/g413/${name}`);
  }
  // 取消形态靠 `timeout` 收敛（不漏成挂起）：夹具必须显式带上 timeout 选项。
  const cancelSrc = readFileSync(CANCEL_FIXTURE, "utf8");
  assert.match(cancelSrc, /\{\s*timeout:\s*\d+\s*\}/, "取消夹具必须用 timeout 收敛，不得让套件挂起");
});
