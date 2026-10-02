/**
 * core/tests/g419-nested-runner-fallback-injection.test.ts
 *
 * g-419（v0.19.7 lane）：收口终局复核在 tip `c049a00` 上实测的**第三态 P1** —— 共享 helper
 * `core/tests/fixtures/nested-runner.ts`（嵌套证据的**裁决函数**）在 **fallback** 路径上把
 * `opts.targets` 变成了 **opt-out**：
 *
 * ── 缺陷（精确 repro，私有 cwd = `pass-a.test.mjs` + `early-b.test.mjs`）──────────────────────
 * `early-b` 注册一个必然失败的用例后 `process.exit(0)`（夹具**加载即写 marker 文件** ⇒ 可证「是否被执行」）。
 * `['--test']` **没有位置目标** ⇒ g-418 的 `resolveNestedTargetPlan` 判定「无法推导」⇒ 直接采信声明
 * `[passA]`；但真正 spawn 的参数仍是 `['--test']` ⇒ Node 照旧**默认发现**，跑 A+B：early-b 早退被 Node
 * 当成**文件级 pass** ⇒ 实测 `code 0 / tests 2 / pass 2 / fail 0`，而 `channel.files=[passA]`（B 无逐文件
 * 完成事件）—— 单向覆盖只核声明集合 ⇒ `problems=[]`、`assertNestedSuitePassed` **接受**，B 的失败断言
 * **从未执行**。即：声明子集在 fallback 上等价于「默认发现 + 只核声明」。
 *
 * ── 修复（两条，全部 fail-closed、无 opt-out）────────────────────────────────────────────────
 *  ① **fallback 必须使「实际运行集 ≡ 声明集」**：`needsFallbackInjection` 判定走 fallback 时，helper 把
 *     裁决得到的目标集合**作为显式位置参数注入 spawn** —— argv 形态由
 *     `injectPositionalTargetsIntoArgv` 插到 `--test` 之后；shell 形态由
 *     `injectPositionalTargetsIntoCommand` 在 `--test` token 的**源串区间末尾**插入 shell 安全引号包裹的
 *     绝对路径（不重新拼接命令 ⇒ 引号/空格/重定向原样保留）。Node 因此**不再走默认发现**。
 *     **无法安全重写**（被启动的可执行文件不是 node、参数/命令里没有 `--test`、shell 首 token 不是 node）
 *     ⇒ **抛错 fail-closed**，绝不信任未经验证的声明；既无法推导又无声明仍抛错（既有行为保留）。
 *  ② **覆盖比对改为双向**（`nestedTargetCoverageProblems`）：任何**产出了完成事件却不在目标集合内**的
 *     文件同样判红 —— 关闭「Node 实际跑得比 helper 展开/声明更多」（glob 展开口径差异、默认发现漏网）。
 *
 * 本文件：负向（③态精确 repro 的不再被接受形态 + 全集声明 + 双向覆盖）→ 正向（fallback 注入后全绿、
 * shell 形态等价、可推导形态仍走推导路径）→ **反向变异对照**（回退①的注入 ⇒ ③态**复活**并给出实测值）
 * → 接线结构守卫。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertNestedSuitePassed,
  nestedSuitePassProblems,
  nestedTargetCoverageProblems,
  runNestedArgv,
  runNestedCommand,
} from "./fixtures/nested-runner.ts";

const repoRoot = join(import.meta.dirname, "../..");
const HELPER = join(repoRoot, "core", "tests", "fixtures", "nested-runner.ts");
const REPORTER = join(repoRoot, "scripts", "test-reporter-events.mjs");
const PASS_A = join(import.meta.dirname, "fixtures", "g416", "pass-a.test.ts");
const PASS_B = join(import.meta.dirname, "fixtures", "g416", "pass-b.test.ts");

/** 逐目标完成事件覆盖的红因特征。 */
const COVERAGE_RE = /完成事件/;
/** g-419② 反向比对（多出来的完成事件）的红因特征。 */
const EXTRA_RE = /不在目标文件集合内/;
/** 无法安全重写 ⇒ fail-closed 的红因特征。 */
const UNSAFE_RE = /无法安全重写|fail-closed/;

interface ReproDir {
  dir: string;
  passA: string;
  earlyB: string;
  /** early-b **被加载**就会写下的 marker ⇒ 「early-b 从未被执行」的可观测证据。 */
  marker: string;
}

/** 私有 cwd：pass-a（正常通过）+ early-b（注册失败断言后早退，且**加载即写 marker**）。 */
function makeReproDir(): ReproDir {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g419-repro-"));
  const passA = join(dir, "pass-a.test.mjs");
  const earlyB = join(dir, "early-b.test.mjs");
  const marker = join(dir, "early-b-ran.marker");
  writeFileSync(passA, 'import { test } from "node:test";\ntest("g-419 pass-a：正常通过", () => {});\n');
  writeFileSync(
    earlyB,
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { writeFileSync } from "node:fs";\n' +
      `writeFileSync(${JSON.stringify(marker)}, "ran");\n` +
      'test("g-419 early-b：注册一个必然失败的用例（早退会把它整个吞掉）", () => {\n' +
      '  assert.fail("G419_EARLY_B_MUST_FAIL");\n});\n' +
      "process.exit(0);\n",
  );
  return { dir, passA, earlyB, marker };
}

// ============================================================================
// 判据 1 + 判据 3（负向）：③态精确 repro 不再被接受（B 未被真实执行，或直接抛错）
// ============================================================================

test("g-419 判据1（负向③态 repro，argv）：['--test'] + targets:[pass-a] ⇒ 只跑 pass-a，early-b 从未被执行", async (t) => {
  const repro = makeReproDir();
  try {
    const run = await runNestedArgv(process.execPath, ["--test"], { cwd: repro.dir, targets: [repro.passA] });
    // 1) B 从未被执行：夹具「加载即写 marker」⇒ marker 不存在是**可观测证据**（不是靠计数推断）。
    assert.equal(existsSync(repro.marker), false, "early-b 必须**从未被加载**（marker 不存在）");
    assert.equal(run.summary.tests, 1, "只跑了声明的 1 个文件（旧形态是 tests 2 —— 默认发现把 B 也跑了）");
    assert.equal(run.summary.pass, 1);
    assert.equal(run.summary.fail, 0);
    // 2) 声明集 ≡ 实际运行集：注入后命令行里出现声明目标，事件通道与目标集合逐一对应。
    assert.equal(run.targets.length, 1);
    assert.equal(run.channel.files.length, 1);
    assert.match(run.command, /--test\s/, "命令里必须仍有 --test");
    assert.ok(run.command.includes(repro.passA), "声明目标必须被**注入**到实际命令行");
    assert.deepEqual(nestedSuitePassProblems(run), [], "注入后声明集即运行集 ⇒ 判绿（B 的失败断言不在声明内）");
    assertNestedSuitePassed(run, "g-419 fallback 注入（argv）");
    t.diagnostic(
      `evidence: suite=g419-repro-argv code=${run.code} tests=${run.summary.tests} pass=${run.summary.pass} fail=${run.summary.fail} targets=${run.targets.length} files=${run.channel.files.length} early_b_ran=0`,
    );
  } finally {
    rmSync(repro.dir, { recursive: true, force: true });
  }
});

test("g-419 判据1（负向③态 repro，shell）：`<node> --test` + targets:[pass-a] ⇒ 等价重写，early-b 从未被执行", async (t) => {
  const repro = makeReproDir();
  try {
    const run = await runNestedCommand(`${process.execPath} --test`, { cwd: repro.dir, targets: [repro.passA] });
    assert.equal(existsSync(repro.marker), false, "early-b 必须**从未被加载**（shell 形态同样注入）");
    assert.equal(run.summary.tests, 1, "shell 形态同样只跑声明目标");
    assert.ok(run.command.includes(repro.passA), "等价重写后的命令必须带上声明目标");
    assert.deepEqual(nestedSuitePassProblems(run), [], "shell 形态注入后同样判绿");
    assertNestedSuitePassed(run, "g-419 fallback 注入（shell）");
    t.diagnostic(
      `evidence: suite=g419-repro-shell code=${run.code} tests=${run.summary.tests} files=${run.channel.files.length} early_b_ran=0`,
    );
  } finally {
    rmSync(repro.dir, { recursive: true, force: true });
  }
});

test("g-419 判据3（负向）：全集声明 [pass-a, early-b] ⇒ both 真跑，早退者无完成事件 ⇒ 判红", async (t) => {
  const repro = makeReproDir();
  try {
    const run = await runNestedArgv(process.execPath, ["--test"], {
      cwd: repro.dir,
      targets: [repro.passA, repro.earlyB],
    });
    assert.equal(existsSync(repro.marker), true, "全集声明 ⇒ early-b **确实被跑**（marker 存在），这正是判红的场景");
    assert.equal(run.targets.length, 2);
    assert.equal(run.channel.files.length, 1, "early-b 提前退出 ⇒ 只有 pass-a 产出逐文件完成事件");
    const problems = nestedSuitePassProblems(run);
    assert.match(problems.join("；"), COVERAGE_RE, "声明集合里含早退文件 ⇒ 必须判红（声明不豁免覆盖断言）");
    assert.throws(() => assertNestedSuitePassed(run, "g-419 全集声明"), COVERAGE_RE, "全绿断言必须拒绝该运行");
    t.diagnostic(
      `evidence: suite=g419-full-declaration code=${run.code} tests=${run.summary.tests} targets=2 files=1 problems=${problems.length} red=1`,
    );
  } finally {
    rmSync(repro.dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 2（负向）：覆盖比对双向 —— 多出来的完成事件同样判红
// ============================================================================

test("g-419 判据2（负向）：产出完成事件却不在目标集合内 ⇒ 判红（关闭「Node 跑得比 helper 展开更多」）", async (t) => {
  // 用**真实**两文件运行拿到的干净事件通道，再把目标集合缩到 1 个 ⇒ 单向旧逻辑为空、双向必须报红。
  const two = await runNestedArgv(process.execPath, ["--test", PASS_A, PASS_B], { cwd: repoRoot });
  assert.deepEqual(nestedSuitePassProblems(two), [], "前提：两文件全绿");
  assert.equal(two.channel.files.length, 2, "前提：两个文件都产出了完成事件");

  const narrowed = nestedTargetCoverageProblems([PASS_A], two.channel, repoRoot);
  assert.ok(
    narrowed.some((p) => EXTRA_RE.test(p)),
    `缩小目标集合后必须因「多出来的完成事件」判红：${narrowed.join("；")}`,
  );
  assert.ok(
    !narrowed.some((p) => /未产出完成事件/.test(p)),
    "红因必须来自**反向**比对（单向旧逻辑在这里恰好是空的 ⇒ 旧判据会放行）",
  );

  // 公开 API 上该形态已被 g-418 的裁决提前拒绝（不可达）；反向比对是第二道防线。
  assert.throws(
    () => runNestedArgv(process.execPath, ["--test", PASS_A, PASS_B], { cwd: repoRoot, targets: [PASS_A] }),
    /不一致|精确一致/,
    "可推导时缩小声明必须被拒绝（g-418 未削弱）",
  );
  t.diagnostic(
    `evidence: suite=g419-bidirectional files=2 narrowed_targets=1 extra_red=1 missing_red=0 derived_mismatch_refused=1`,
  );
});

test("g-419 判据2（负向，纯函数）：事件通道有而目标集合没有 / 目标集合有而事件通道没有，两个方向都判红", (t) => {
  const channel = (files: string[]) => ({ summary: null, tally: null, summaries: files.length, files, badLines: 0 });
  const dir = "/tmp/g419-coverage-pure";
  const missing = nestedTargetCoverageProblems([join(dir, "a.test.mjs")], channel([join(dir, "b.test.mjs")]), dir);
  assert.equal(missing.length, 2, "双向都要报：目标未完成 + 多出完成事件");
  assert.ok(missing.some((p) => /未产出完成事件/.test(p)));
  assert.ok(missing.some((p) => EXTRA_RE.test(p)));
  assert.deepEqual(
    nestedTargetCoverageProblems([join(dir, "a.test.mjs")], channel([join(dir, "a.test.mjs")]), dir),
    [],
    "集合相等 ⇒ 无红因",
  );
  t.diagnostic(`evidence: suite=g419-bidirectional-pure problems_missing=${missing.length} equal=0`);
});

// ============================================================================
// 判据 1 + 判据 3（正向）：注入后判绿；可推导形态仍走 g-418 推导路径
// ============================================================================

test("g-419 判据3（正向）：['--test'] + 完整正常文件声明 ⇒ 全绿；默认发现在 repoRoot 下被真正关闭", async (t) => {
  const repro = makeReproDir();
  try {
    const second = join(repro.dir, "pass-c.test.mjs");
    writeFileSync(second, 'import { test } from "node:test";\ntest("g-419 pass-c：正常通过", () => {});\n');
    const run = await runNestedArgv(process.execPath, ["--test"], { cwd: repro.dir, targets: [repro.passA, second] });
    assert.deepEqual(nestedSuitePassProblems(run), [], "完整正常文件声明 ⇒ 必须全绿");
    assertNestedSuitePassed(run, "g-419 fallback 完整声明");
    assert.equal(run.targets.length, 2);
    assert.equal(run.channel.files.length, 2, "两个声明文件都必须产出完成事件");

    // repoRoot 是「默认发现会展开几百个测试文件」的目录：声明 1 个文件却只跑 1 个 ⇒ 默认发现确已关闭。
    const narrowed = await runNestedArgv(process.execPath, ["--test"], { cwd: repoRoot, targets: [PASS_A] });
    assert.equal(narrowed.channel.files.length, 1, "repoRoot 下声明 1 个目标 ⇒ 只应有 1 条完成事件（无默认发现）");
    assert.equal(narrowed.summary.tests, 1, "只跑声明的那 1 个文件");
    assert.deepEqual(nestedSuitePassProblems(narrowed), [], "注入后目标集 ≡ 运行集 ⇒ 判绿");
    t.diagnostic(
      `evidence: suite=g419-positive declared_green=1 targets=2 files=2 repoRoot_narrowed_files=${narrowed.channel.files.length}`,
    );
  } finally {
    rmSync(repro.dir, { recursive: true, force: true });
  }
});

test("g-419 判据3（正向）：可推导形态仍走推导路径（不重复注入、声明仍须精确一致）", async (t) => {
  const derived = await runNestedArgv(process.execPath, ["--test", PASS_A, PASS_B], { cwd: repoRoot });
  assert.deepEqual(nestedSuitePassProblems(derived), [], "可推导形态必须全绿");
  assertNestedSuitePassed(derived, "g-419 可推导形态");
  assert.equal(derived.targets.length, 2, "采用推导集合");
  assert.equal(derived.channel.files.length, 2);
  assert.equal(derived.command.split(PASS_A).length - 1, 1, "可推导形态**不得**重复注入目标（每文件一次）");
  assert.equal(derived.command.split(PASS_B).length - 1, 1);

  // 声明与推导一致（顺序不同）⇒ 接受且仍以推导集合为准；不一致 ⇒ 抛错（g-418 语义未削弱）。
  const reordered = await runNestedArgv(process.execPath, ["--test", PASS_A, PASS_B], {
    cwd: repoRoot,
    targets: [PASS_B, PASS_A],
  });
  assert.deepEqual(nestedSuitePassProblems(reordered), []);
  assert.throws(
    () => runNestedArgv(process.execPath, ["--test", PASS_A], { cwd: repoRoot, targets: [PASS_B] }),
    /不一致|精确一致/,
    "可推导时声明不一致仍必须拒绝",
  );
  t.diagnostic(`evidence: suite=g419-derived ok=1 reordered=accepted mismatch_refused=1 single_injection=1`);
});

// ============================================================================
// 判据 1（负向）：无法安全重写 ⇒ 抛错 fail-closed（绝不信任未经验证的声明）
// ============================================================================

test("g-419 判据1（负向）：无法安全重写（非 node / 无 --test / shell 首 token 非 node）⇒ 抛错 fail-closed", async (t) => {
  const repro = makeReproDir();
  try {
    // argv 形态：被启动的可执行文件不是 node（注入会改变非测试进程语义）。
    assert.throws(
      () => runNestedArgv("bash", ["-c", "node --test"], { cwd: repro.dir, targets: [repro.passA] }),
      UNSAFE_RE,
      "文件不是 node ⇒ 必须抛错",
    );
    // argv 形态：参数里没有 --test（无法定位注入点）。
    assert.throws(
      () => runNestedArgv(process.execPath, ["-e", "console.log(1)"], { cwd: repro.dir, targets: [repro.passA] }),
      UNSAFE_RE,
      "参数里没有 --test ⇒ 必须抛错",
    );
    // shell 形态：首 token 不是 node。
    assert.throws(
      () => runNestedCommand(`bash -c "${process.execPath} --test"`, { cwd: repro.dir, targets: [repro.passA] }),
      UNSAFE_RE,
      "shell 首 token 不是 node ⇒ 必须抛错",
    );
    // shell 形态：命令里没有 --test token。
    assert.throws(
      () => runNestedCommand(`${process.execPath} -e "1"`, { cwd: repro.dir, targets: [repro.passA] }),
      UNSAFE_RE,
      "命令里没有 --test ⇒ 必须抛错",
    );
    // 既无法推导又无声明（既有行为保留）。
    assert.throws(
      () => runNestedArgv(process.execPath, ["--test"], { cwd: repro.dir }),
      /fail-closed|显式传 opts\.targets/,
      "既无法推导又无声明 ⇒ 必须抛错",
    );
    assert.throws(
      () => runNestedCommand(`${process.execPath} --test`, { cwd: repro.dir }),
      /fail-closed|显式传 opts\.targets/,
      "shell 形态同样不得静默跳过",
    );
    assert.equal(existsSync(repro.marker), false, "全部 fail-closed 路径都不得真的跑起 early-b");
    t.diagnostic(`evidence: suite=g419-fail-closed argv_not_node=1 argv_no_test=1 shell_not_node=1 shell_no_test=1 none=2`);
  } finally {
    rmSync(repro.dir, { recursive: true, force: true });
  }
});

test("g-419 判据1（正向边界）：`['--test','--']` + 声明 ⇒ 注入点仍正确（目标注入到 `--` 之前）", async (t) => {
  const repro = makeReproDir();
  try {
    const run = await runNestedArgv(process.execPath, ["--test", "--"], { cwd: repro.dir, targets: [repro.passA] });
    assert.equal(existsSync(repro.marker), false, "early-b 仍不得被执行");
    assert.equal(run.summary.tests, 1);
    assert.deepEqual(nestedSuitePassProblems(run), [], "`--` 形态注入后照常判绿");
    t.diagnostic(`evidence: suite=g419-dashdash code=${run.code} tests=${run.summary.tests} files=${run.channel.files.length}`);
  } finally {
    rmSync(repro.dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 3：反向变异对照（回退①的注入 ⇒ ③态复活，给实测 code/tests/pass/fail/problems/files）
// ============================================================================

/** 变异锚点：argv 形态的注入调用（回退成「不注入」即旧行为）。 */
const INJECTION_ANCHOR =
  "  const argv = needsFallbackInjection(args) ? injectPositionalTargetsIntoArgv(file, args, targets, source) : [...args];";

/** 生成与被测 helper **同相对深度**的私有副本（reporter 路径由 `import.meta.url` 推导）。 */
async function loadMutantHelper(
  transform: (src: string) => string,
): Promise<{ helper: typeof import("./fixtures/nested-runner.ts"); dir: string }> {
  const original = readFileSync(HELPER, "utf8");
  const mutantSrc = transform(original);
  assert.notEqual(mutantSrc, original, "变异锚点失效：helper 源码必须命中该锚点");
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g419-mutant-"));
  const fixturesDir = join(dir, "core", "tests", "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  symlinkSync(REPORTER, join(dir, "scripts", "test-reporter-events.mjs"));
  const mutantPath = join(fixturesDir, "nested-runner-mutant.ts");
  writeFileSync(mutantPath, mutantSrc);
  const helper = (await import(pathToFileURL(mutantPath).href)) as typeof import("./fixtures/nested-runner.ts");
  return { helper, dir };
}

test("g-419 判据3 变异对照：回退①「fallback 注入」⇒ ③态复活为被接受（实测 code/tests/pass/fail/problems/files）", async (t) => {
  const { helper: mutant, dir } = await loadMutantHelper((src) =>
    src.replace(INJECTION_ANCHOR, "  const argv = [...args];"),
  );
  const repro = makeReproDir();
  try {
    // 前提：真实 helper 对同一 cwd 判绿**且 early-b 从未被执行**。
    const real = await runNestedArgv(process.execPath, ["--test"], { cwd: repro.dir, targets: [repro.passA] });
    assert.equal(existsSync(repro.marker), false, "前提：真实 helper 下 early-b 从未被执行");
    assert.equal(real.summary.tests, 1, "前提：真实 helper 只跑声明的 1 个文件");

    // 变异副本（不注入）⇒ Node 默认发现跑 A+B，B 早退被当成文件级 pass，单向+双向覆盖都看不见。
    const run = await mutant.runNestedArgv(process.execPath, ["--test"], { cwd: repro.dir, targets: [repro.passA] });
    const problems = mutant.nestedSuitePassProblems(run);
    assert.equal(run.code, 0, "变异形态必须 exit 0");
    assert.equal(run.summary.tests, 2, "变异形态跑满 2 个用例（默认发现把 early-b 也跑了）");
    assert.equal(run.summary.pass, 2);
    assert.equal(run.summary.fail, 0, "early-b 的失败断言从未执行 ⇒ fail 0");
    assert.equal(run.targets.length, 1, "vari 形态 targets 仍是声明的 1 个");
    assert.equal(run.channel.files.length, 1, "只有 pass-a 产出完成事件（early-b 早退）");
    assert.deepEqual(problems, [], "回退注入后旧判据（含双向覆盖）必须重新接受该运行 ⇒ ③态复活");
    mutant.assertNestedSuitePassed(run, "变异 helper（无 fallback 注入）");
    assert.equal(existsSync(repro.marker), true, "变异形态下 early-b **确实被执行过**（marker 存在）—— 与真实 helper 的可观测差异");
    t.diagnostic(
      `evidence: suite=g419-mutant revived=1 code=${run.code} tests=${run.summary.tests} pass=${run.summary.pass} fail=${run.summary.fail} problems=${problems.length} files=${run.channel.files.length} early_b_ran=1`,
    );
  } finally {
    rmSync(repro.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 4：接线结构守卫（注入与双向覆盖不是死代码；g-418 裁决未削弱）
// ============================================================================

test("g-419 判据4：helper 内 fallback 注入 + 双向覆盖 + 非 node fail-closed 都被真正接线", (t) => {
  const src = readFileSync(HELPER, "utf8");
  // ① fallback 注入（argv / shell 两形态）
  assert.match(src, /function needsFallbackInjection/, "fallback 判定必须有唯一实现");
  assert.match(src, /tokens === null \|\| tokens\.length === 0/, "fallback 判定必须与推导口径同源");
  assert.match(
    src,
    /needsFallbackInjection\(args\) \? injectPositionalTargetsIntoArgv\(file, args, targets, source\)/,
    "argv 形态必须真的注入（不是死代码）",
  );
  assert.match(
    src,
    /needsFallbackInjection\(argv\) \? injectPositionalTargetsIntoCommand\(cmd, targets, source\)/,
    "shell 形态必须真的等价重写",
  );
  assert.match(src, /function isNodeBinary/, "非 node 必须 fail-closed（有唯一判定）");
  assert.match(src, /splice\(testIndex \+ 1, 0, \.\.\.targetPaths\)/, "argv 注入点必须在 --test 之后");
  assert.match(src, /tokenizeShellWithSpans/, "shell 重写必须用带区间的分词（不重新拼接命令）");
  // ② 双向覆盖
  assert.match(src, /const extra = \[\.\.\.completed\]\.filter\(\(f\) => !targetSet\.has\(f\)\)/, "必须存在反向比对");
  assert.match(src, /不在目标文件集合内/, "反向比对必须产出红因");
  // ③ g-418 的推导优先裁决仍在（未被 g-419 侵蚀）
  assert.match(src, /return resolveNestedTargetPlan\(derived, declared, source, opts\.cwd\)/, "推导优先裁决仍在");
  assert.match(src, /if \(!sameNestedTargetSet\(derived, declared\)\)/, "声明须精确一致的裁决仍在");
  t.diagnostic(`evidence: suite=g419-wiring fallback_inject=2 bidirectional=1 non_node_fail_closed=1 g418_plan=1`);
});
