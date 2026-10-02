/**
 * core/tests/g418-nested-runner-strict-targets.test.ts
 *
 * g-418（v0.19.7 lane）：收口终局复核在 tip `0ea6a1b` 上实测的**两条 P1** —— 都在共享 helper
 * `core/tests/fixtures/nested-runner.ts`（嵌套证据的**裁决函数**）上，且都是「**合法 API 误用即静默少跑**」
 * （无需蓄意破坏即可判绿）：
 *
 * ── ⑧ `opts.targets` 掩盖真实目标 ──────────────────────────────────────────────────────────
 * 旧 `planNestedTargets` 形如 `opts.targets ?? deriveNestedTargetTokens(args)` ⇒ 只要声明非空就**不**与
 * argv 实际集合比对。复核实测 `runNestedArgv(node, ['--test', passA, reflectionExitB], {cwd, targets:[passA]})`
 * （B = 注册失败断言后反射早退的夹具）得 `code 0 / targets [passA] / files [passA] / tests 2 / pass 2 / fail 0`，
 * `nestedSuitePassProblems=[]`、`assertNestedSuitePassed` **接受** —— B 的失败断言从未执行。
 * 修复：**可推导时以推导集合为准**；声明必须与推导集合 realpath 归一后**精确一致**，否则抛错；
 * **仅无法推导时**才允许使用声明。
 *
 * ── ⑨ `args` 内选集开关未拦 ────────────────────────────────────────────────────────────────
 * g-417① 只查**生效 `NODE_OPTIONS`**，而 `runNestedArgv` 的 `args` 本身可携带用例级选集。复核实测
 * `runNestedArgv(node, ['--test','--test-name-pattern=vis', mix], {cwd})`（mix = 1 通过 + 1 必失败）
 * 得 `code 0 / tests 1 / pass 1 / fail 0` 且目标文件**照常产出完成事件**、helper **接受**。
 * 修复：入口（spawn 之前）拦 argv 与 shell 解析形态的 `--test-only` / `--test-name-pattern` /
 * `--test-skip-pattern` / `--test-shard`（含 `=值` / 独立取值 / 多重空格变体），点名开关并 fail-closed；
 * **复用** g-417 的 `findTestSelectionOption` 同源 token 口径，合法 `--test-reporter` 等不误拒。
 *
 * 本文件：负向（⑧ 声明子集 / 声明多、少、不同；⑨ argv + shell 两形态 × 变体）→ 正向（声明一致、
 * 顺序不同、无法推导时用声明、合法 reporter 选项、正常多文件）→ **反向变异对照**（分别回退两守卫 ⇒
 * ⑧⑨ 复活为「被接受」，给实测值）→ 接线结构守卫。
 *
 * 注（g-419，v0.19.7 lane）：⑧ 的**不可推导**分支已被 g-419 进一步收紧 —— 无法推导时 helper 会把声明
 * 目标**注入 spawn**（argv 插到 `--test` 之后 / shell 等价重写），使「实际运行集 ≡ 声明集」；因此
 * 「声明一个同目录之外的正常文件」不再判红（它会被真的跑），判据改由「注入可观测 + 声明里的早退文件
 * 仍然无完成事件 ⇒ 红」保证（见本文件 判据1 正向 的第二段断言与 `g419-nested-runner-fallback-injection`）。
 * 可推导分支（本文件 ⑧ 的负向主体）语义与守卫不变。
 *
 * 复用既有夹具（都在 fixtures 子目录，不被顶层 glob 误收）：
 * `fixtures/g416/{pass-a,pass-b,reflection-exit}.test.ts`、`fixtures/g417/mix.test.ts`。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  TEST_SELECTION_OPTION_NAMES,
  assertNestedSuitePassed,
  findTestSelectionOption,
  nestedArgvTestSelectionProblem,
  nestedSuitePassProblems,
  runNestedArgv,
  runNestedCommand,
} from "./fixtures/nested-runner.ts";

const repoRoot = join(import.meta.dirname, "../..");
const TESTS_DIR = join(import.meta.dirname);
const HELPER = join(repoRoot, "core", "tests", "fixtures", "nested-runner.ts");
const REPORTER = join(repoRoot, "scripts", "test-reporter-events.mjs");

const PASS_A = join(TESTS_DIR, "fixtures", "g416", "pass-a.test.ts");
const PASS_B = join(TESTS_DIR, "fixtures", "g416", "pass-b.test.ts");
const REFLECTION_EXIT = join(TESTS_DIR, "fixtures", "g416", "reflection-exit.test.ts");
const MIX = join(TESTS_DIR, "fixtures", "g417", "mix.test.ts");

/** 声明集合与推导集合不一致（⑧）的红因特征。 */
const MISMATCH_RE = /不一致|精确一致/;
/** argv 选集开关（⑨）的红因特征。 */
const ARGV_SELECTION_RE = /选集\/分片开关/;
/** 逐目标文件完成事件（覆盖）判据的红因特征。 */
const COVERAGE_RE = /完成事件/;

// ============================================================================
// 判据 1（负向⑧）：声明集合与推导集合「少一个 / 多一个 / 不同」一律抛错拒绝
// ============================================================================

test("g-418 判据1（负向⑧）：声明子集掩盖真实目标（argv 还有反射早退目标）⇒ 抛错拒绝，不得静默取声明", (t) => {
  // 复现前提：argv 里确有 2 个目标（passA + 反射早退 B），⑧ 却只声明 passA。
  assert.throws(
    () => runNestedArgv(process.execPath, ["--test", PASS_A, REFLECTION_EXIT], { cwd: repoRoot, targets: [PASS_A] }),
    MISMATCH_RE,
    "声明子集必须被拒绝：旧实现会静默取声明并接受该运行（B 的失败断言从未执行）",
  );
  const message = (() => {
    try {
      runNestedArgv(process.execPath, ["--test", PASS_A, REFLECTION_EXIT], { cwd: repoRoot, targets: [PASS_A] });
      return "";
    } catch (error) {
      return (error as Error).message;
    }
  })();
  assert.match(message, /推导集合 2 个/, `红因必须给出推导集合规模：${message}`);
  assert.match(message, /声明集合 1 个/, `红因必须给出声明集合规模：${message}`);
  assert.match(message, /fail-closed|拒绝/, "红因必须说明 fail-closed 拒绝执行");
  t.diagnostic(`evidence: suite=g418-declared-subset refused=1 derived=2 declared=1 named=counts`);
});

for (const [label, targets] of [
  ["少一个", [PASS_A]],
  ["多一个", [PASS_A, PASS_B, REFLECTION_EXIT]],
  ["不同", [PASS_A, REFLECTION_EXIT]],
] as const) {
  test(`g-418 判据1（负向⑧）：声明集合与推导集合${label} ⇒ 抛错拒绝`, (t) => {
    assert.throws(
      () => runNestedArgv(process.execPath, ["--test", PASS_A, PASS_B], { cwd: repoRoot, targets: [...targets] }),
      MISMATCH_RE,
      `声明集合${label}必须被拒绝（realpath 归一后集合必须精确相等）`,
    );
    t.diagnostic(`evidence: suite=g418-declared-mismatch case=${label} refused=1 derived=2`);
  });
}

// ============================================================================
// 判据 1（正向）：声明一致 / 顺序不同 ⇒ 采用推导集合并判绿；不一致才是拒绝
// ============================================================================

test("g-418 判据1（正向）：声明集合与推导集合一致（含顺序不同）⇒ 以推导集合为准且全绿", async (t) => {
  const same = await runNestedArgv(process.execPath, ["--test", PASS_A], { cwd: repoRoot, targets: [PASS_A] });
  assert.deepEqual(nestedSuitePassProblems(same), [], "声明与推导一致 ⇒ 必须通过（逃生口仍可用）");
  assertNestedSuitePassed(same, "g-418 一致声明");
  assert.equal(same.targets.length, 1);

  // 多文件 + 顺序不同：集合相等 ⇒ 接受，且 run.targets 是**推导集合**（顺序随 argv）。
  const reordered = await runNestedArgv(process.execPath, ["--test", PASS_A, PASS_B], {
    cwd: repoRoot,
    targets: [PASS_B, PASS_A],
  });
  assert.deepEqual(nestedSuitePassProblems(reordered), [], "顺序不同的同一集合不得被误拒");
  assertNestedSuitePassed(reordered, "g-418 顺序不同的同一集合");
  assert.equal(reordered.targets.length, 2, "可推导时采用的是推导集合（2 个文件）");
  assert.equal(reordered.channel.files.length, 2, "两个文件都必须产出完成事件");
  t.diagnostic(`evidence: suite=g418-declared-consistent accepted=1 reordered=accepted targets=2 files=2`);
});

test("g-418 判据1（正向）：无法推导目标时才采用 opts.targets，且仍被覆盖判据校验", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g418-nonderive-"));
  try {
    const only = join(dir, "only.test.ts");
    writeFileSync(only, 'import { test } from "node:test";\ntest("g-418 默认发现夹具：通过", () => {});\n');
    // `['--test']`（无位置参数）⇒ 推导失败（默认文件发现），此时声明是**唯一**来源。
    const run = await runNestedArgv(process.execPath, ["--test"], { cwd: dir, targets: [only] });
    assert.deepEqual(nestedSuitePassProblems(run), [], "无法推导时声明集合必须被采用且判绿");
    assert.equal(run.targets.length, 1, "采用的就是声明的 1 个目标");
    assert.equal(run.channel.files.length, 1, "声明集合的文件必须产出完成事件（声明集合被真正校验）");
    assertNestedSuitePassed(run, "g-418 无法推导时用声明");

    // g-419①（本文件的这一断言在 g-419 上被收紧）：无法推导 ⇒ helper 把声明目标**注入 spawn**，
    // 声明集即实际运行集；因此「声明一个同目录之外的正常文件」不再判红（它会被真的跑），
    // 「声明不是橡皮图章」改由下面两条更强的不变式保证：注入可观测 + 声明里的早退文件仍判红。
    assert.match(run.command, new RegExp(only.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "声明目标必须出现在实际命令行里（注入 spawn）");
    const early = join(dir, "early.test.ts");
    writeFileSync(
      early,
      'import { test } from "node:test";\nimport assert from "node:assert/strict";\n' +
        'test("g-418 早退夹具：注册失败断言后立即退出", () => { assert.fail("G418_EARLY_MUST_FAIL"); });\n' +
        "process.exit(0);\n",
    );
    const withEarly = await runNestedArgv(process.execPath, ["--test"], { cwd: dir, targets: [only, early] });
    assert.match(
      nestedSuitePassProblems(withEarly).join("；"),
      COVERAGE_RE,
      "声明集合里含早退文件 ⇒ 它没有完成事件，必须判红（声明只提供集合，不豁免覆盖断言）",
    );
    t.diagnostic(`evidence: suite=g418-nonderive declared=used green=1 injected=1 early_declared=red`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 2（负向⑨）：argv / shell 两形态 × 四类开关 × =值 / 独立取值 / 多重空格
// ============================================================================

const ARGV_SELECTION_FORMS: ReadonlyArray<readonly [string, string[], string]> = [
  ["--test-only", ["--test", "--test-only", MIX], `node --test --test-only ${MIX}`],
  ["--test-name-pattern", ["--test", "--test-name-pattern=vis", MIX], `node --test --test-name-pattern=vis ${MIX}`],
  [
    "--test-name-pattern（独立取值）",
    ["--test", "--test-name-pattern", "vis", MIX],
    `node --test   --test-name-pattern     vis ${MIX}`,
  ],
  ["--test-skip-pattern", ["--test", "--test-skip-pattern=hid", MIX], `node --test --test-skip-pattern=hid ${MIX}`],
  ["--test-skip-pattern（独立取值）", ["--test", "--test-skip-pattern", "hid", MIX], `node --test --test-skip-pattern hid ${MIX}`],
  ["--test-shard", ["--test", "--test-shard=1/2", MIX], `node --test --test-shard=1/2 ${MIX}`],
  ["--test-shard（独立取值）", ["--test", "--test-shard", "1/2", MIX], `node --test --test-shard  1/2 ${MIX}`],
];

for (const [name, argv, shellCommand] of ARGV_SELECTION_FORMS) {
  test(`g-418 判据2（负向⑨）：argv/shell 含 ${name} ⇒ spawn 之前拒绝并点名开关`, (t) => {
    const switchName = name.replace(/（.*$/, "");
    // 纯函数口径：与 NODE_OPTIONS 判定同源（复用同一 token 级函数 / 同一常量）。
    const problem = nestedArgvTestSelectionProblem(argv);
    assert.ok(problem !== null, `${name} 必须被判为红因`);
    assert.ok(problem.includes(switchName), `红因必须**点名**开关：${problem}`);
    assert.equal(findTestSelectionOption(argv.join(" ")), switchName, "argv 与 NODE_OPTIONS 判定必须同口径");

    assert.throws(
      () => runNestedArgv(process.execPath, argv, { cwd: repoRoot }),
      ARGV_SELECTION_RE,
      `runNestedArgv 必须在 spawn 之前拒绝 ${name}`,
    );
    assert.throws(
      () => runNestedArgv(process.execPath, argv, { cwd: repoRoot }),
      new RegExp(switchName),
      `argv 红因必须点名 ${switchName}`,
    );
    assert.throws(
      () => runNestedCommand(shellCommand, { cwd: repoRoot }),
      new RegExp(switchName),
      `runNestedCommand 必须在 spawn 之前拒绝并点名 ${switchName}（shell 解析形态同口径）`,
    );
    t.diagnostic(`evidence: suite=g418-argv-selection form=${switchName} argv=refused shell=refused named=1`);
  });
}

test("g-418 判据2（负向⑨）：shell 引号包裹形态同样被拦（引号/双引号不得成为旁路）", (t) => {
  for (const cmd of [`node --test '--test-only' ${MIX}`, `node --test "--test-shard=1/2" ${MIX}`]) {
    assert.throws(() => runNestedCommand(cmd, { cwd: repoRoot }), ARGV_SELECTION_RE, `引号形态必须被拦：${cmd}`);
  }
  t.diagnostic(`evidence: suite=g418-shell-quoted refused=2`);
});

// ============================================================================
// 判据 2（正向）：合法选项与文件路径不误拒（复用同一常量，口径不漂移）
// ============================================================================

test("g-418 判据2（正向）：合法选项（--test-reporter[-destination] / --test-concurrency）与文件路径不误拒", async (t) => {
  for (const argv of [
    ["--test", "--test-reporter=spec", MIX],
    ["--test", "--test-reporter", "spec", MIX],
    ["--test", "--test-reporter-destination=/dev/null", MIX],
    ["--test", "--test-concurrency", "2", MIX],
    ["--test", MIX],
    ["--test", "--", "--test-only"], // `--` 之后是**位置参数（目标文件）**，不是开关
  ] as const) {
    assert.equal(nestedArgvTestSelectionProblem([...argv]), null, `合法形态不得被误判为选集：${argv.join(" ")}`);
  }
  assert.equal(TEST_SELECTION_OPTION_NAMES.length, 4, "四类开关口径不变（复用同一常量）");

  // 合法 reporter 选项必须**穿过守卫**（await 未抛错 ⇒ 已到 spawn；Node 自身对
  // `--test-reporter` 与 `--test-reporter-destination` 的**数量配对**约束不属于本守卫的拒绝范围）。
  const reporterRun = await runNestedArgv(process.execPath, ["--test", "--test-reporter=spec", PASS_A], { cwd: repoRoot });
  assert.ok(reporterRun.command.includes("--test-reporter=spec"), "合法 reporter 选项必须真的进入子进程命令行");
  assert.doesNotMatch(`${reporterRun.out}\n${reporterRun.err}`, ARGV_SELECTION_RE, "不得被本守卫误拒");

  // 完全不冲突的合法选项 ⇒ 照常全绿（证明守卫只拦选区/分片开关）。
  const run = await runNestedArgv(process.execPath, ["--test", "--test-concurrency=2", PASS_A], { cwd: repoRoot });
  assert.deepEqual(nestedSuitePassProblems(run), [], "合法 --test-concurrency 不得误拒/误红");
  assertNestedSuitePassed(run, "g-418 合法 --test-concurrency 嵌套运行");
  assert.equal(run.targets.length, 1, "合法选项不得被当成目标文件");
  assert.equal(run.channel.files.length, 1, "事件通道必须照常挂上");
  t.diagnostic(`evidence: suite=g418-legit-options rejected=0 reporter_spawned=1 concurrency_green=1 files=1`);
});

test("g-418 判据2（正向）：正常多文件全绿不受新守卫影响", async (t) => {
  const run = await runNestedArgv(process.execPath, ["--test", PASS_A, PASS_B], { cwd: repoRoot });
  assert.deepEqual(nestedSuitePassProblems(run), [], "正常多文件必须全绿");
  assertNestedSuitePassed(run, "g-418 正常多文件");
  assert.equal(run.targets.length, 2);
  assert.equal(run.channel.files.length, 2);
  assert.equal(run.summary.tests, 2, "两个文件的用例都必须真的跑");
  t.diagnostic(`evidence: suite=g418-multifile exit=${run.code} targets=2 files=2 tests=2`);
});

// ============================================================================
// 判据 3：反向变异对照（分别回退两守卫 ⇒ ⑧⑨ 复活为「被接受」，给实测值）
// ============================================================================

const STRICT_PLAN_ANCHOR = "  return resolveNestedTargetPlan(derived, declared, source, opts.cwd);";
const ARGV_GUARD_ANCHOR = "  assertNoNestedArgvTestSelection(args, source);";

/** 生成与被测 helper **同相对深度**的私有副本（reporter 路径由 `import.meta.url` 推导）。 */
async function loadMutantHelper(
  transform: (src: string) => string,
): Promise<{ helper: typeof import("./fixtures/nested-runner.ts"); dir: string }> {
  const original = readFileSync(HELPER, "utf8");
  const mutantSrc = transform(original);
  assert.notEqual(mutantSrc, original, "变异锚点失效：helper 源码必须命中该锚点");
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g418-mutant-"));
  const fixturesDir = join(dir, "core", "tests", "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  symlinkSync(REPORTER, join(dir, "scripts", "test-reporter-events.mjs"));
  const mutantPath = join(fixturesDir, "nested-runner-mutant.ts");
  writeFileSync(mutantPath, mutantSrc);
  const helper = (await import(pathToFileURL(mutantPath).href)) as typeof import("./fixtures/nested-runner.ts");
  return { helper, dir };
}

test("g-418 判据3 变异对照：回退①「声明优先」⇒ ⑧ 复活为被接受（实测 code/tests/pass/fail/problems）", async (t) => {
  const { helper: mutant, dir } = await loadMutantHelper((src) =>
    src.replace(
      STRICT_PLAN_ANCHOR,
      "  if (declared !== null) return declared;\n" +
        "  if (derived !== null) return derived;\n" +
        '  throw new Error(`${source}：无法推导嵌套运行的目标文件 ⇒ fail-closed 拒绝执行。`);',
    ),
  );
  try {
    // 前提：真实 helper 拒绝该形态。
    assert.throws(
      () => runNestedArgv(process.execPath, ["--test", PASS_A, REFLECTION_EXIT], { cwd: repoRoot, targets: [PASS_A] }),
      MISMATCH_RE,
      "前提：真实 helper 必须拒绝声明子集",
    );

    // 变异副本：声明子集被静默采信 ⇒ ⑧ 的接受形态复活。
    const run = await mutant.runNestedArgv(process.execPath, ["--test", PASS_A, REFLECTION_EXIT], {
      cwd: repoRoot,
      targets: [PASS_A],
    });
    assert.equal(run.code, 0, "变异形态必须 exit 0");
    assert.equal(run.summary.tests, 2, "变异形态只报 2 个用例（B 的失败断言从未执行）");
    assert.equal(run.summary.pass, 2, "变异形态 pass 2");
    assert.equal(run.summary.fail, 0, "变异形态 fail 0 —— 旧判据据此放行");
    assert.deepEqual(run.targets, [PASS_A], "变异形态的 targets 只剩声明子集");
    assert.equal(run.channel.files.length, 1, "只有 passA 产出完成事件（B 反射早退）");
    assert.deepEqual(
      mutant.nestedSuitePassProblems(run),
      [],
      "回退①后旧判据必须重新接受该运行（⑧ 复活）",
    );
    mutant.assertNestedSuitePassed(run, "变异 helper（声明优先）");
    t.diagnostic(
      `evidence: suite=g418-mutant-targets revived=1 code=${run.code} tests=${run.summary.tests} pass=${run.summary.pass} fail=${run.summary.fail} problems=0 files=${run.channel.files.length}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-418 判据3 变异对照：回退②argv 选集守卫 ⇒ ⑨ 复活为被接受（argv + shell 两形态）", async (t) => {
  const { helper: mutant, dir } = await loadMutantHelper((src) =>
    src.replace(ARGV_GUARD_ANCHOR, "  // mutant: argv selection guard removed"),
  );
  try {
    // 前提：真实 helper 对 argv / shell 两形态都拒绝。
    assert.throws(
      () => runNestedArgv(process.execPath, ["--test", "--test-name-pattern=vis", MIX], { cwd: repoRoot }),
      ARGV_SELECTION_RE,
      "前提：真实 helper 必须拒绝 argv 选集",
    );
    assert.throws(
      () => runNestedCommand(`node --test --test-name-pattern=vis ${MIX}`, { cwd: repoRoot }),
      ARGV_SELECTION_RE,
      "前提：真实 helper 必须拒绝 shell 选集",
    );

    // 变异副本：argv 形态复活（失败用例被参数选集静默排除，文件照常完成）。
    const argvRun = await mutant.runNestedArgv(process.execPath, ["--test", "--test-name-pattern=vis", MIX], {
      cwd: repoRoot,
    });
    assert.equal(argvRun.code, 0, "变异 argv 形态必须 exit 0");
    assert.equal(argvRun.summary.tests, 1, "只剩被选集留下的 1 个通过用例");
    assert.equal(argvRun.summary.pass, 1);
    assert.equal(argvRun.summary.fail, 0, "被排除的失败用例既不计 fail 也不计 skipped");
    assert.equal(argvRun.channel.files.length, 1, "目标文件照常产出完成事件 ⇒ 文件级覆盖看不出来");
    assert.deepEqual(
      mutant.nestedSuitePassProblems(argvRun),
      [],
      "回退②后旧判据必须重新接受 argv 选集形态（⑨ 复活）",
    );

    // 变异副本：shell 形态同样复活（同一 capture 入口）。
    const shellRun = await mutant.runNestedCommand(`node --test --test-name-pattern=vis ${MIX}`, { cwd: repoRoot });
    assert.equal(shellRun.code, 0, "变异 shell 形态必须 exit 0");
    assert.equal(shellRun.summary.tests, 1);
    assert.equal(shellRun.summary.fail, 0);
    assert.deepEqual(mutant.nestedSuitePassProblems(shellRun), [], "shell 形态同样复活为被接受");
    t.diagnostic(
      `evidence: suite=g418-mutant-argv revived=1 argv(code=${argvRun.code},tests=${argvRun.summary.tests},pass=${argvRun.summary.pass},fail=${argvRun.summary.fail},problems=0) shell(code=${shellRun.code},tests=${shellRun.summary.tests},fail=${shellRun.summary.fail},problems=0)`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 4：接线结构守卫（守卫不是死代码）+ 夹具位置
// ============================================================================

test("g-418 判据4：两处守卫都在 helper 内被真正调用，且共用唯一 token 口径（不另立第二套）", (t) => {
  const src = readFileSync(HELPER, "utf8");
  // ① 目标语义收紧
  assert.doesNotMatch(src, /const tokens = opts\.targets/, "旧「声明优先」写法必须消失");
  assert.match(src, /return resolveNestedTargetPlan\(derived, declared, source, opts\.cwd\)/, "必须由推导集合裁决");
  assert.match(src, /sameNestedTargetSet\(derived, declared\)/, "声明必须与推导集合（realpath 归一）比对");
  assert.match(src, /derivedTokens !== null && derivedTokens\.length > 0/, "仅非空推导集合才算「可推导」");
  assert.match(src, /opts\.targets !== undefined && opts\.targets\.length > 0/, "空声明视同未声明");
  // ② argv 选集守卫
  assert.match(src, /assertNoNestedArgvTestSelection\(args, source\)/, "入口必须在 spawn 前拦 argv 选集开关");
  assert.match(src, /export function nestedArgvTestSelectionProblem/, "argv 红因必须有唯一实现");
  assert.match(src, /selectionOptionNameOfToken\(token\)/, "argv 与 NODE_OPTIONS 必须共用 token 级口径");
  assert.match(src, /findTestSelectionOption\(nodeOptions\)/, "NODE_OPTIONS 判定仍走同一实现（g-417 未削弱）");
  assert.equal(TEST_SELECTION_OPTION_NAMES.length, 4, "四类开关口径不变（复用同一常量）");

  const topLevel = readdirSync(TESTS_DIR).filter((name) => name.endsWith(".test.ts"));
  for (const name of ["only.test.ts", "mix.test.ts", "reflection-exit.test.ts", "pass-a.test.ts"]) {
    assert.ok(!topLevel.includes(name), `${name} 不得出现在 core/tests 顶层（否则会被顶层 glob 误收）`);
  }
  t.diagnostic(`evidence: suite=g418-wiring strict_plan=1 argv_guard=1 shared_token_rule=1 fixtures=nested`);
});
