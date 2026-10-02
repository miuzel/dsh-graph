/**
 * core/tests/g417-nested-runner-selection-and-paths.test.ts
 *
 * g-417（v0.19.7 lane）：收口 g-416 复核确认的两项 P2 残余 —— 都在**共享 helper**
 * `core/tests/fixtures/nested-runner.ts`（嵌套证据的**裁决函数**）上。
 *
 * ── 残余①：helper 未对生效 `NODE_OPTIONS` 的选集/分片开关 fail-closed ──────────────────────
 * `cleanTestEnv()` 保留 `NODE_OPTIONS`，而 g-416 的覆盖判据是**文件级**的 ⇒ **用例级**选集
 * （`--test-only` / `--test-name-pattern` / `--test-skip-pattern` / `--test-shard`）可静默排除
 * 失败用例，而文件照常产出完成事件、照常判绿。本文件先钉死复现前提（`fixtures/g417/mix.test.ts`
 * = 1 通过 + 1 失败；在选集开关下得 `tests 1 / pass 1 / fail 0`，被排除者**不计 fail 也不计
 * skipped**），再断言修复后**入口 fail-closed 拒绝执行并点名开关**，最后用变异副本证明
 * 「去掉守卫 ⇒ 该形态复活为被接受」。
 *
 * ── 残余②：含空格 `TMPDIR` 误红 ───────────────────────────────────────────────────────────
 * `NODE_OPTIONS` 由 Node 按空白切分；未加引号的通道路径被切成两段 ⇒ 通道文件写到被截断的路径、
 * 读不到 ⇒ 覆盖断言判红（安全但**误红**）。修复按 Node 引号规则编码（双引号分组 + 转义 `\`/`"`；
 * 单引号**不**被识别、引号内 `\` 仍是转义符，均实测）。正向：含空格 TMPDIR、含反斜杠
 * （Windows 形态）TMPDIR 下通道照常挂上且判绿；变异对照：去掉编码 ⇒ 含空格 TMPDIR 下重新误红。
 *
 * 负向夹具都在 `fixtures/g417/`（不被顶层 glob 误收，且不含选集式 only 标记 —— g-415 结构守卫）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  TEST_SELECTION_OPTION_NAMES,
  assertNestedSuitePassed,
  cleanTestEnv,
  findTestSelectionOption,
  nestedSuitePassProblems,
  nestedTestSelectionProblem,
  runNestedArgv,
  runNestedCommand,
} from "./fixtures/nested-runner.ts";

const repoRoot = join(import.meta.dirname, "../..");
const TESTS_DIR = join(import.meta.dirname);
const FIXTURES = join(TESTS_DIR, "fixtures", "g417");
const HELPER = join(repoRoot, "core", "tests", "fixtures", "nested-runner.ts");
const REPORTER = join(repoRoot, "scripts", "test-reporter-events.mjs");

const PASS = join(FIXTURES, "pass.test.ts");
const MIX = join(FIXTURES, "mix.test.ts");

/** 四类开关的**真实可用形态**（都会被 `node --test` 接受并改变选中集合）。 */
const SELECTION_FORMS: ReadonlyArray<readonly [string, string]> = [
  ["--test-only", "--test-only"],
  ["--test-name-pattern", "--test-name-pattern=vis"],
  ["--test-skip-pattern", "--test-skip-pattern=hid"],
  ["--test-shard", "--test-shard=1/2"],
];

// ============================================================================
// 判据 1：入口 fail-closed（四类开关 × argv/shell 两形态）+ 生效 NODE_OPTIONS 继承
// ============================================================================

for (const [name, nodeOptions] of SELECTION_FORMS) {
  test(`g-417 判据1：生效 NODE_OPTIONS 含 ${name} ⇒ 入口 fail-closed 拒绝执行并点名开关`, (t) => {
    const problem = nestedTestSelectionProblem(`--no-warnings ${nodeOptions}`);
    assert.ok(problem !== null, `${name} 必须被判为红因`);
    assert.ok(problem.includes(name), `红因必须**点名**开关：${problem}`);
    assert.match(problem, /fail-closed|拒绝/, "红因必须说明 fail-closed 拒绝执行");

    // argv 形态（推荐入口）
    assert.throws(
      () => runNestedArgv(process.execPath, ["--test", MIX], { cwd: repoRoot, env: { NODE_OPTIONS: nodeOptions } }),
      new RegExp(name),
      `runNestedArgv 必须在 spawn 之前拒绝并点名 ${name}`,
    );
    // shell 形态（与 argv 共用同一 capture 入口，故必须同口径生效）
    assert.throws(
      () => runNestedCommand(`node --test ${MIX}`, { cwd: repoRoot, env: { NODE_OPTIONS: nodeOptions } }),
      new RegExp(name),
      `runNestedCommand 必须在 spawn 之前拒绝并点名 ${name}`,
    );
    t.diagnostic(`evidence: suite=g417-selection-${name} argv=refused shell=refused red=named`);
  });
}

/** 在**真子进程**里跑：子进程的**进程环境**先带 NODE_OPTIONS，再由 helper 走 `cleanTestEnv` 合并。 */
function ambientScript(target: string): string {
  return `
const helper = await import(${JSON.stringify(pathToFileURL(HELPER).href)});
try {
  const run = await helper.runNestedArgv(process.execPath, ["--test", ${JSON.stringify(target)}], { cwd: ${JSON.stringify(repoRoot)} });
  const problems = helper.nestedSuitePassProblems(run);
  console.log(problems.length === 0 ? "G417-AMBIENT-GREEN" : "G417-AMBIENT-RED:" + problems.join("；"));
} catch (error) {
  console.log("G417-AMBIENT-REFUSED:" + error.message);
}
`;
}

/** 以给定 NODE_OPTIONS **继承**给子进程（不传 opts.env ⇒ 命中「生效环境变量」这条路径）。 */
function runAmbient(nodeOptions: string, target: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", ambientScript(target)], {
    cwd: repoRoot,
    env: { ...cleanTestEnv(), NODE_OPTIONS: nodeOptions },
    encoding: "utf8",
  });
}

test("g-417 判据1：继承自**进程环境**的选集开关同样被拒（不只看 opts.env）", (t) => {
  const r = runAmbient("--no-warnings --test-name-pattern=vis", MIX);
  assert.equal(r.status, 0, `探针进程本身必须正常收尾：${r.stderr.slice(-400)}`);
  assert.match(r.stdout, /G417-AMBIENT-REFUSED/, `生效 NODE_OPTIONS 必须被判红：${r.stdout}`);
  assert.match(r.stdout, /--test-name-pattern/, "红因必须点名开关");
  assert.doesNotMatch(r.stdout, /G417-AMBIENT-GREEN|G417-AMBIENT-RED/, "不得带着被弱化的选集继续跑证据");
  t.diagnostic(`evidence: suite=g417-ambient-inherited mode=process.env refused=named-selection`);
});

// ============================================================================
// 判据 2：合法 NODE_OPTIONS 不误拒（用例级 + 生效环境级）
// ============================================================================

test("g-417 判据2：合法 NODE_OPTIONS（--no-warnings / --max-old-space-size）不误拒，照常判绿", async (t) => {
  const legit = "--no-warnings --max-old-space-size=4096";
  assert.equal(nestedTestSelectionProblem(legit), null, "合法项不得被判为红因");
  assert.equal(findTestSelectionOption(legit), null, "合法项不得命中选集开关（复用 g-415 判定）");

  const run = await runNestedArgv(process.execPath, ["--test", PASS], { cwd: repoRoot, env: { NODE_OPTIONS: legit } });
  assert.deepEqual(nestedSuitePassProblems(run), [], "合法 NODE_OPTIONS 下不得判红");
  assertNestedSuitePassed(run, "合法 NODE_OPTIONS 嵌套运行");
  assert.equal(run.channel.files.length, 1, "通道必须照常挂上");

  // 生效环境级：子进程继承合法项时也必须照常跑全并判绿（证明守卫只拦选集开关）。
  const ambient = runAmbient(legit, PASS);
  assert.equal(ambient.status, 0, `探针进程必须正常收尾：${ambient.stderr.slice(-400)}`);
  assert.match(ambient.stdout, /G417-AMBIENT-GREEN/, `合法项在生效环境里必须判绿：${ambient.stdout}`);
  t.diagnostic(`evidence: suite=g417-legit-options opts_env=green ambient=green files=1`);
});

// ============================================================================
// 判据 3：含空格 / 含反斜杠 TMPDIR（引号规则编码）+ 变异对照
// ============================================================================

/** 在 TMPDIR 被临时改写的窗口内跑（helper 的私有通道目录就建在该 tmpdir 下）。 */
async function withTmpdir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
  }
}

/** 外层（无空格）+ 内层（含空格/反斜杠）：截断产物留在外层目录里，随清理一并删除。 */
function makeNestedTmpdir(label: string): { base: string; inner: string } {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-g417-paths-"));
  const inner = mkdtempSync(join(base, label));
  return { base, inner };
}

test("g-417 判据3：TMPDIR 含空格 ⇒ 通道注入按引号规则编码，嵌套运行仍被覆盖判定且判绿", async (t) => {
  const { base, inner } = makeNestedTmpdir("spaced tmp-");
  assert.ok(inner.includes(" "), `前提：临时目录必须含空格（实际 ${inner}）`);
  try {
    const run = await withTmpdir(inner, () =>
      runNestedArgv(process.execPath, ["--test", PASS], { cwd: repoRoot }),
    );
    assert.equal(run.code, 0, `含空格 TMPDIR 下必须照常退出 0：\n${run.err.slice(-500)}`);
    assert.equal(run.channel.files.length, 1, "通道必须挂上并产出逐文件完成事件（否则覆盖断言误红）");
    assert.deepEqual(nestedSuitePassProblems(run), [], "含空格 TMPDIR 不得误红");
    assertNestedSuitePassed(run, "含空格 TMPDIR 嵌套运行");
    t.diagnostic(`evidence: suite=g417-tmpdir-space exit=${run.code} files=1 spaced=1`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("g-417 判据3：TMPDIR 含反斜杠（Windows 形态路径）⇒ 编码必须转义 \\，不得吞分隔符", async (t) => {
  const { base, inner } = makeNestedTmpdir("back\\slash tmp-");
  assert.ok(inner.includes("\\"), `前提：临时目录必须含反斜杠（实际 ${inner}）`);
  try {
    const run = await withTmpdir(inner, () =>
      runNestedArgv(process.execPath, ["--test", PASS], { cwd: repoRoot }),
    );
    assert.equal(run.code, 0, `含反斜杠 TMPDIR 下必须照常退出 0：\n${run.err.slice(-500)}`);
    assert.equal(run.channel.files.length, 1, "只加引号不转义反斜杠会破坏路径 ⇒ 通道挂不上（本断言钉住转义）");
    assert.deepEqual(nestedSuitePassProblems(run), [], "含反斜杠 TMPDIR 不得误红");
    t.diagnostic(`evidence: suite=g417-tmpdir-backslash exit=${run.code} files=1 escaped=1`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 4：变异对照（去掉入口守卫 / 去掉引号编码 ⇒ 各自复活为红/被接受）
// ============================================================================

const SELECTION_GUARD_ANCHOR =
  "  assertNoNestedTestSelection(baseEnv.NODE_OPTIONS, `嵌套运行入口（${command}）`);";
const QUOTING_ANCHOR = "--test-reporter-destination=${quoteNodeOptionsValue(eventsPath)}";

/** 生成与被测 helper **同相对深度**的私有副本（reporter 路径由 `import.meta.url` 推导）。 */
async function loadMutantHelper(
  transform: (src: string) => string,
): Promise<{ helper: typeof import("./fixtures/nested-runner.ts"); dir: string }> {
  const original = readFileSync(HELPER, "utf8");
  const mutantSrc = transform(original);
  assert.notEqual(mutantSrc, original, "变异锚点失效：helper 源码必须命中该锚点");
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g417-mutant-"));
  const fixturesDir = join(dir, "core", "tests", "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  symlinkSync(REPORTER, join(dir, "scripts", "test-reporter-events.mjs"));
  const mutantPath = join(fixturesDir, "nested-runner-mutant.ts");
  writeFileSync(mutantPath, mutantSrc);
  const helper = (await import(pathToFileURL(mutantPath).href)) as typeof import("./fixtures/nested-runner.ts");
  return { helper, dir };
}

test("g-417 判据1 变异对照：去掉入口选集守卫 ⇒ 用例级选集复活为「被接受」", async (t) => {
  const { helper: mutant, dir } = await loadMutantHelper((src) =>
    src.replace(SELECTION_GUARD_ANCHOR, "  // mutant: entry selection guard removed"),
  );
  try {
    for (const name of ["--test-only", "--test-name-pattern", "--test-skip-pattern"] as const) {
      const nodeOptions = SELECTION_FORMS.find(([n]) => n === name)![1];
      const run = await mutant.runNestedArgv(process.execPath, ["--test", MIX], {
        cwd: repoRoot,
        env: { NODE_OPTIONS: nodeOptions },
      });
      // 复现前提：被排除的失败用例既不计 fail 也不计 skipped ⇒ 旧判据全绿接受。
      assert.equal(run.summary.fail, 0, `${name}：被排除的失败用例不计 fail（复现前提）`);
      assert.equal(run.summary.tests, 1, `${name}：只剩 1 个通过用例被统计`);
      assert.deepEqual(
        mutant.nestedSuitePassProblems(run),
        [],
        `${name}：去掉守卫后旧判据必须重新接受该运行（复活）`,
      );
    }
    // `--test-shard` 属**文件级**选集（另有逐文件覆盖把关）：此处只钉「变异副本不再入口拒绝」。
    const shard = await mutant.runNestedArgv(process.execPath, ["--test", MIX], {
      cwd: repoRoot,
      env: { NODE_OPTIONS: "--test-shard=1/2" },
    });
    assert.match(shard.command, /--test/, "--test-shard：变异副本必须真的执行（拒绝只可能来自入口守卫）");
    t.diagnostic(`evidence: suite=g417-selection-mutant revived=3 shard_executed=1`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-417 判据3 变异对照：去掉引号编码 ⇒ 含空格 TMPDIR 下通道重新挂不上、覆盖判据误红", async (t) => {
  const { helper: mutant, dir } = await loadMutantHelper((src) =>
    src.replace(QUOTING_ANCHOR, "--test-reporter-destination=${eventsPath}"),
  );
  const { base, inner } = makeNestedTmpdir("spaced mutant tmp-");
  try {
    const run = await withTmpdir(inner, () =>
      mutant.runNestedArgv(process.execPath, ["--test", PASS], { cwd: repoRoot }),
    );
    assert.equal(run.channel.files.length, 0, "去掉编码 ⇒ 通道文件写到被截断路径、读不到（复现误红根因）");
    assert.notDeepEqual(
      mutant.nestedSuitePassProblems(run),
      [],
      "变异副本必须重新误红（证明引号编码就是判别力来源）",
    );
    // 同一 TMPDIR 下真实 helper 必须判绿（对照，排除「该 TMPDIR 本身就跑不了」的解释）。
    const real = await withTmpdir(inner, () =>
      runNestedArgv(process.execPath, ["--test", PASS], { cwd: repoRoot }),
    );
    assert.deepEqual(nestedSuitePassProblems(real), [], "真实 helper 在同条件下必须判绿");
    t.diagnostic(`evidence: suite=g417-quoting-mutant mutant_files=0 mutant_red=1 real=green`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 4：接线结构守卫 + 夹具位置（接线不是死代码）
// ============================================================================

test("g-417 判据4：入口守卫与引号编码都在 helper 内且被真正调用（复用 g-415 判定）", (t) => {
  const src = readFileSync(HELPER, "utf8");
  assert.match(
    src,
    /assertNoNestedTestSelection\(baseEnv\.NODE_OPTIONS/,
    "入口必须对**生效** NODE_OPTIONS（cleanTestEnv 合并后的值）判守卫",
  );
  assert.doesNotMatch(src, /findTestSelectionOption\(opts\.env/, "不得只看 opts.env（继承形态会漏判）");
  assert.match(src, /export function nestedTestSelectionProblem/, "红因必须有唯一实现");
  assert.match(src, /findTestSelectionOption\(nodeOptions\)/, "必须复用 g-415 的选集判定（不另立口径）");
  assert.match(
    src,
    /--test-reporter-destination=\$\{quoteNodeOptionsValue\(eventsPath\)\}/,
    "通道路径必须经引号规则编码",
  );
  assert.equal(TEST_SELECTION_OPTION_NAMES.length, 4, "四类开关口径不变（复用同一常量）");

  const topLevel = readdirSync(TESTS_DIR).filter((name) => name.endsWith(".test.ts"));
  for (const name of ["pass.test.ts", "mix.test.ts"]) {
    assert.ok(!topLevel.includes(name), `${name} 不得出现在 core/tests 顶层（否则会被顶层 glob 误收）`);
  }
  t.diagnostic(`evidence: suite=g417-wiring entry_guard=1 quoting=unique_impl fixtures=nested`);
});
