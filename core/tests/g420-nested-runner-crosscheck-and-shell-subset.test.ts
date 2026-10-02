/**
 * core/tests/g420-nested-runner-crosscheck-and-shell-subset.test.ts
 *
 * g-420（v0.19.7 lane）：终局复核在 tip `f495c09` 上给出的两项 **P2**（均**非假绿**：无 false-green，
 * 但「文档声明与实现不一致」/「安全误红」）。本文件把两项修复都钉死，并给出**负向 + 变异对照**。
 *
 * ── ① `nestedSuitePassProblems` 的交叉校验不对称（文档说「三方交叉校验」，实现只比两条腿）───────
 * 旧实现只逐字段比较 `channel.summary` ↔ 人类可读 `run.summary`，**不比较 `channel.tally`
 * ↔ `channel.summary`**；而顶层 `scripts/run-tests.mjs` 的 `crossCheckProblems` 两者都比（`COUNT_FIELDS`）。
 * 复核者未找到 Node 26 上能让 tally/summary 分歧且仍全绿的真实事件形态 ⇒ 定级 P2，但声明为假。
 * 现由 `nestedChannelCrossCheckProblems` 按**同口径**补齐：逐字段（tests/pass/fail/cancelled/skipped/todo）
 * 双向比对 + 两侧各自计数口径自洽。
 *
 * ── ② `runNestedCommand` 的 shell 分词把未加引号的反斜杠当普通字符（先跑后红）─────────────────
 * `node --test /path/space\ name.test.mjs` 被切成两个 token ⇒ 幻觉出两个缺失目标 + 一个额外完成事件，
 * **先真的跑起来再判红**；重定向/管道等含元字符的命令同样如此。现把支持的 shell 子集显式化
 * （`NESTED_SHELL_SUBSET`），其余形态**在 spawn 之前 fail-closed 拒绝**（无副作用：未创建通道、
 * 未启动进程、未产生 marker）。
 *
 * ── ③ 复合 shell 真 P1（终局复核在 `c8aa8a3`/`f495c09` 上实测，追加硬要求）──────────────────
 * `node --test; node --test pass.test.mjs` 两段都是**合法 shell compound**、两段也都真跑了，但两段
 * **共用同一 events 文件**、后者截断覆盖前者 ⇒ 第一段真实 fail / 非零退出码被完全隐藏，helper 实测
 * 接受 `code 0 / tests 1 / pass 1 / fail 0 / problems []`（粘连 `--test>/dev/null;` 变体更强）。
 * 收口：①**粘连控制符**按**字符**识别（`--test;` / `--test>/dev/null` / `--test|cat` / `--test&&…`
 * 连同换行一律拒绝）；②**强制单一 runner**（`node` 调用数或 `--test` 次数 > 1 即拒绝）。
 * **③（已被终局复核纠正、刻意放弃）**「汇总块数 ≠ 1 判红」—— 合法消费点 g353 的嵌套运行
 * `channel.summaries === 2`；改用人类可读 `summaryBlocks` 也会因外层 `NODE_OPTIONS` 注入被内层继承
 * 而误红（实测嵌套 g353 即被判红）。本文件用「反误红」用例把该放弃决定钉住。
 *
 * 铁律（与 g-416/g-417/g-418/g-419 同）：**只增不减** —— 既有比较与断言一条都不削弱。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertNestedSuitePassed,
  NESTED_SHELL_SUBSET,
  nestedChannelCrossCheckProblems,
  nestedSuitePassProblems,
  parseEventChannel,
  runNestedCommand,
  type NestedRunResult,
} from "./fixtures/nested-runner.ts";

const repoRoot = join(import.meta.dirname, "../..");
const HELPER = join(repoRoot, "core", "tests", "fixtures", "nested-runner.ts");
const REPORTER = join(repoRoot, "scripts", "test-reporter-events.mjs");
const AGENTS = join(repoRoot, "AGENTS.md");
const PASS_A = join(import.meta.dirname, "fixtures", "g416", "pass-a.test.ts");

/** 计数通道分歧的红因特征。 */
const TALLY_RE = /事件通道内部不一致|计数口径不自洽/;
/** 入口 fail-closed 的红因特征。 */
const REFUSED_RE = /fail-closed/;

/** 把真实运行的 `channel.tally` 换成给定计数（其余一律不动 ⇒ 判红只可能来自 ① 的校验）。 */
function withTally(run: NestedRunResult, patch: Record<string, number>): NestedRunResult {
  const tally = run.channel.tally;
  assert.ok(tally, "前提：真实全绿运行的通道必须有 tally");
  return { ...run, channel: { ...run.channel, tally: { ...tally, ...patch } } };
}

// ============================================================================
// 判据 1：channel.tally ↔ channel.summary 逐字段交叉校验（+ 计数口径自洽）
// ============================================================================

test("g-420 判据1（正向前提）：真实嵌套全绿的 tally 与 summary 逐字段一致，判据不得误红", async (t) => {
  const run = await runNestedCommand(`node --test ${PASS_A}`, { cwd: repoRoot });
  const tally = run.channel.tally;
  const summary = run.channel.summary;
  assert.ok(tally && summary, "前提：真实全绿运行的通道必须同时有 tally 与 summary");
  for (const field of ["tests", "pass", "fail", "cancelled", "skipped", "todo"] as const) {
    assert.equal(tally[field], summary[field], `前提：真实运行 ${field} 必须一致（否则该判据无从谈起）`);
  }
  assert.deepEqual(nestedChannelCrossCheckProblems(tally, summary), [], "一致 ⇒ 不得判红");
  assert.deepEqual(nestedSuitePassProblems(run), [], "真实全绿运行不得被 ① 的校验误红");
  t.diagnostic(
    `evidence: suite=g420-crosscheck-premise code=${run.code} tests=${summary.tests} pass=${summary.pass} xcheck=[]`,
  );
});

/** 构造「事件通道」的分歧形态：runner 汇总与逐事件累加是**两个独立来源**，此处让二者分歧。 */
function craftedChannel(tallyCounts: Record<string, number>) {
  const counts = { tests: 1, suites: 0, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
  return parseEventChannel(
    [
      JSON.stringify({ type: "summary", file: PASS_A, counts }),
      JSON.stringify({ type: "summary", file: null, counts }),
      JSON.stringify({ type: "tally", counts: tallyCounts }),
    ].join("\n"),
  );
}

test("g-420 判据1（负向）：事件通道里 tally 与 summary 分歧（两侧各自自洽）⇒ 判红并点名分歧字段", async (t) => {
  const run = await runNestedCommand(`node --test ${PASS_A}`, { cwd: repoRoot });
  // 内部自洽的「偷换」：tests 不变，pass 少 1、skipped 多 1 ⇒ 只可能被**逐字段比对**抓到。
  const tampered = withTally(run, { pass: 0, skipped: 1 });
  const problems = nestedSuitePassProblems(tampered).join("；");
  assert.match(problems, /事件通道内部不一致/, `必须点名通道内部不一致：${problems}`);
  assert.match(problems, /pass 0 ≠ 1/, `必须点名分歧字段 pass 及其两侧取值：${problems}`);
  assert.match(problems, /skipped 1 ≠ 0/, `必须点名分歧字段 skipped 及其两侧取值：${problems}`);
  assert.doesNotMatch(problems, /计数口径不自洽/, "该形态两侧各自自洽 ⇒ 红因不得来自口径检查（判别力隔离）");
  assert.throws(() => assertNestedSuitePassed(tampered, "tally/summary 分歧"), /事件通道内部不一致/);
  t.diagnostic(`evidence: suite=g420-crosscheck-fields red=1 named_fields=pass,skipped selfconsistent=1`);
});

test("g-420 判据1（负向）：tally 自身计数口径不自洽 ⇒ 判红并点名口径", async (t) => {
  const run = await runNestedCommand(`node --test ${PASS_A}`, { cwd: repoRoot });
  const tampered = withTally(run, { tests: 2 });
  const problems = nestedSuitePassProblems(tampered).join("；");
  assert.match(problems, /计数口径不自洽/, `必须点名口径：${problems}`);
  assert.match(problems, /tests=2 ≠ pass\+fail\+cancelled\+skipped\+todo=1/, `必须给出两侧数字：${problems}`);
  assert.throws(() => assertNestedSuitePassed(tampered, "tally 口径不自洽"), /计数口径不自洽/);
  t.diagnostic(`evidence: suite=g420-crosscheck-incoherent red=1 named=逐事件计数（tally）`);
});

test("g-420 判据1（负向）：直接构造 tally/summary 分歧的事件通道 NDJSON ⇒ 判红", (t) => {
  // tally：tests 1 / pass 0 / todo 1（自洽），summary：tests 1 / pass 1 / todo 0（自洽）⇒ 分歧在 pass/todo。
  const channel = craftedChannel({ tests: 1, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 1 });
  assert.ok(channel.summary && channel.tally, "构造的通道必须同时含 summary 与 tally");
  const problems = nestedChannelCrossCheckProblems(channel.tally, channel.summary).join("；");
  assert.match(problems, /事件通道内部不一致/, `必须判红：${problems}`);
  assert.match(problems, /pass/, "必须点名 pass");
  assert.match(problems, /todo/, "必须点名 todo");
  assert.doesNotMatch(problems, /口径不自洽/, "两侧各自自洽 ⇒ 红因只来自逐字段比对");
  t.diagnostic(`evidence: suite=g420-crosscheck-ndjson red=1 fields=pass,todo selfconsistent=1`);
});

// ============================================================================
// 判据 1 变异对照：去掉该交叉校验 ⇒ 分歧形态复活为「被接受」
// ============================================================================

const CROSSCHECK_ANCHOR =
  "    problems.push(...nestedChannelCrossCheckProblems(channel.tally, channel.summary));";

/** 生成与被测 helper **同相对深度**的私有副本（与 g-418/g-419 的变异口径一致）。 */
async function loadMutantHelper(
  transform: (src: string) => string,
): Promise<{ helper: typeof import("./fixtures/nested-runner.ts"); dir: string }> {
  const original = readFileSync(HELPER, "utf8");
  const mutantSrc = transform(original);
  assert.notEqual(mutantSrc, original, "变异锚点失效：helper 源码必须命中该锚点");
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g420-mutant-"));
  const fixturesDir = join(dir, "core", "tests", "fixtures");
  mkdirSync(fixturesDir, { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  symlinkSync(REPORTER, join(dir, "scripts", "test-reporter-events.mjs"));
  const mutantPath = join(fixturesDir, "nested-runner-mutant.ts");
  writeFileSync(mutantPath, mutantSrc);
  const helper = (await import(pathToFileURL(mutantPath).href)) as typeof import("./fixtures/nested-runner.ts");
  return { helper, dir };
}

test("g-420 判据1 变异对照：摘掉 tally↔summary 校验 ⇒ 分歧形态复活为被接受（证明它真在判红）", async (t) => {
  const { helper: mutant, dir } = await loadMutantHelper((src) => {
    const mutantSrc = src.replace(
      CROSSCHECK_ANCHOR,
      "    // mutant: g-420 tally↔summary cross-check removed",
    );
    return mutantSrc;
  });
  try {
    const run = await runNestedCommand(`node --test ${PASS_A}`, { cwd: repoRoot });
    const tampered = withTally(run, { pass: 0, skipped: 1 });

    // 前提：真实 helper 判红（判别力来源是该校验本身）。
    assert.match(nestedSuitePassProblems(tampered).join("；"), /事件通道内部不一致/, "前提：真实 helper 必须判红");

    // 变异副本：同样的运行被接受 ⇒ 去掉校验即复活，证明它不是恒红假守卫。
    assert.deepEqual(
      mutant.nestedSuitePassProblems(tampered),
      [],
      "摘掉 ① 的校验后，分歧形态必须复活为「被接受」",
    );
    mutant.assertNestedSuitePassed(tampered, "变异 helper（无 tally↔summary 校验）");
    t.diagnostic(`evidence: suite=g420-crosscheck-mutant revived=1 real_red=1 mutant_problems=0`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 2：shell 支持子集 / 不支持形态 spawn 前 fail-closed（含无副作用证据）
// ============================================================================

interface ShellProbe {
  dir: string;
  /** 含空格的目录（反斜杠转义复现用）。 */
  spacedDir: string;
  /** 空格路径下的夹具（被真的加载时会写出 marker）。 */
  spacedFixture: string;
  /** 普通夹具。 */
  fixture: string;
  /** 子进程一旦真跑就会创建的 marker。 */
  marker: string;
}

function makeShellProbe(): ShellProbe {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g420-shell-"));
  const body = (marker: string): string =>
    `import { test } from "node:test";\n` +
    `import { writeFileSync } from "node:fs";\n` +
    `writeFileSync(${JSON.stringify(marker)}, "ran");\n` +
    `test("g-420 probe", () => {});\n`;
  const marker = join(dir, "ran.marker");
  const fixture = join(dir, "target.test.ts");
  writeFileSync(fixture, body(marker));
  const spacedDir = join(dir, "sp ace");
  mkdirSync(spacedDir);
  const spacedFixture = join(spacedDir, "target.test.ts");
  writeFileSync(spacedFixture, body(marker));
  return { dir, spacedDir, spacedFixture, fixture, marker };
}

/**
 * 给定目录里的**事件通道**目录数（`openEventChannel` 用
 * `mkdtempSync(join(tmpdir(), "dsh-graph-nested-runner-"))` 创建，收尾即删）。入口门禁在 `capture()`
 * **之前**抛出 ⇒ 该计数必须纹丝不动。
 *
 * g-423：`root` **必须**是本用例**私有**的 TMPDIR —— 直接数全局 `tmpdir()` 会与其他并发测试文件
 * （各自创建/删除同前缀的嵌套运行工作目录）互相干扰 ⇒ 随机**假红**（实测闸门里 `4 !== 5`，
 * 而同一次加固包装全量却全绿）。
 */
function openChannelDirs(root: string): number {
  return readdirSync(root).filter((name) => name.startsWith("dsh-graph-nested-runner-")).length;
}

/**
 * g-423：把 `TMPDIR` 指向本用例私有目录后执行 `fn`，并把「**私有**通道目录计数」交给它。
 * `os.tmpdir()` 每次调用都读 `TMPDIR` ⇒ helper 若真的在 `capture()` 里建了通道，必然落在该私有目录内,
 * 判据**不失真**；同时**自校验**隔离生效（计数起点必须为 0，否则说明 `TMPDIR` 未被采纳 —— 立刻
 * fail-closed 报错，而不是静默退回带竞态的全局计数）。
 */
function withPrivateTmpdir<T>(fn: (channels: () => number) => T): T {
  const privateTmp = mkdtempSync(join(tmpdir(), "g420-negative-tmp-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = privateTmp;
  const channels = (): number => openChannelDirs(privateTmp);
  try {
    assert.equal(channels(), 0, "私有 TMPDIR 必须被 os.tmpdir() 采纳（否则通道计数仍受并发干扰 ⇒ 假红）");
    return fn(channels);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    rmSync(privateTmp, { recursive: true, force: true });
  }
}

test("g-420 判据2（负向）：各不支持形态 ⇒ spawn 之前 fail-closed 拒绝，且零副作用（无通道 / 无进程 / 无 marker）", (t) => {
  const probe = makeShellProbe();
  const { dir, fixture, spacedFixture, marker } = probe;
  // 复现原缺陷的关键形态：空格路径用**未加引号的反斜杠**转义（POSIX 下合法，但旧分词把它当普通字符）。
  const backslashForm = `node --test ${spacedFixture.replace("sp ace", "sp\\ ace")}`;
  const forms: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["未加引号的反斜杠转义", backslashForm, /反斜杠/],
    ["输出重定向 >", `node --test ${fixture} > ${join(dir, "out.txt")}`, /重定向/],
    ["输入重定向 <", `node --test ${fixture} < ${fixture}`, /重定向/],
    ["管道 |", `node --test ${fixture} | cat`, /管道/],
    ["分号 ;", `node --test ${fixture} ; echo hi`, /分号|命令分隔符/],
    ["逻辑与 &&", `node --test ${fixture} && echo hi`, /逻辑|分隔符/],
    ["后台 &", `node --test ${fixture} & echo hi`, /后台|分隔符/],
    ["子 shell ( )", `( node --test ${fixture} )`, /子 shell/],
    ["变量展开 $VAR", `node --test $TARGET`, /变量展开/],
    ["命令替换 $( )", `node --test $(echo ${fixture})`, /命令替换/],
    ["命令替换 反引号", `node --test \`echo ${fixture}\``, /命令替换/],
    ["cd 前缀", `cd ${dir}`, /前缀命令/],
    ["env 前缀", `env node --test ${fixture}`, /前缀命令/],
    ["FOO=1 前缀", `FOO=1 node --test ${fixture}`, /环境变量赋值/],
    ["非 node 首 token", `bash -c "node --test ${fixture}"`, /首 token 不是 node/],
    ["缺 --test", `node -e "1"`, /没有 --test/],
    // g-420②（终局复核 P1）：多段 runner 的结构不变式（粘连控制符已被上面各形态拦下，这里守住计数兜底）。
    ["--test 出现两次", `node --test ${fixture} --test`, /多段 runner/],
    ["node 调用两次", `node node --test ${fixture}`, /多段 runner/],
    ["换行分隔两条命令", `node --test ${fixture}\nnode --test ${fixture}`, /换行|命令分隔符/],
  ];
  try {
    withPrivateTmpdir((channels) => {
      const channelsBefore = channels();
      for (const [label, cmd, reasonRe] of forms) {
        // 同步抛出即「未返回 Promise」⇒ 必然发生在 capture()（唯一创建通道处）之前。
        assert.throws(
          () => runNestedCommand(cmd, { cwd: dir }),
          REFUSED_RE,
          `${label} 必须在 spawn 之前 fail-closed 拒绝：${cmd}`,
        );
        assert.throws(
          () => runNestedCommand(cmd, { cwd: dir }),
          reasonRe,
          `${label} 的红因必须点名该形态：${cmd}`,
        );
        assert.equal(existsSync(marker), false, `${label} 拒绝时不得真的跑起夹具（marker 出现即已 spawn）`);
        assert.equal(
          channels(),
          channelsBefore,
          `${label} 拒绝时不得创建事件通道（私有 TMPDIR 里的通道目录数必须不变）`,
        );
      }
    });
    t.diagnostic(
      `evidence: suite=g420-shell-refused forms=${forms.length} spawn_before=1 marker=absent channel_created=0`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 判据 2（终局复核 P1）：复合 shell / 多段 runner —— spawn 前拒绝 + 无副作用 + 变异对照
// ============================================================================

interface CompoundRepro {
  dir: string;
  /** 第一段默认发现到的必失败夹具（加载即写 marker ⇒ 可证明「第一段确实跑过」）。 */
  firstFails: string;
  firstMarker: string;
  /** 第二段目标（通过）。 */
  pass: string;
  passMarker: string;
}

function makeCompoundRepro(): CompoundRepro {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g420-compound-"));
  const firstMarker = join(dir, "first-ran.marker");
  const firstFails = join(dir, "first-fails.test.mjs");
  writeFileSync(
    firstFails,
    `import { test } from "node:test";\nimport assert from "node:assert/strict";\n` +
      `import { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(firstMarker)}, "ran");\n` +
      `test("compound first MUST FAIL", () => { assert.fail("COMPOUND_FIRST_MUST_FAIL"); });\n`,
  );
  const passMarker = join(dir, "pass-ran.marker");
  const pass = join(dir, "pass.test.mjs");
  writeFileSync(
    pass,
    `import { test } from "node:test";\nimport { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(passMarker)}, "ran");\n` +
      `test("compound pass", () => {});\n`,
  );
  return { dir, firstFails, firstMarker, pass, passMarker };
}

/** 复合 shell 红因特征（控制符 / 多 runner 任一口径）。 */
const COMPOUND_RE = /多段 runner|命令分隔符|重定向/;

test("g-420 判据2（P1 负向）：复合 shell（`;` / 粘连 `>/dev/null` / 带 opts.targets）⇒ spawn 前拒绝且零副作用", (t) => {
  const repro = makeCompoundRepro();
  try {
    const forms: ReadonlyArray<readonly [string, string, { targets?: string[] }]> = [
      ["无声明 `;` 版", `node --test; node --test ${repro.pass}`, {}],
      ["粘连 `>/dev/null` 版", `node --test>/dev/null; node --test ${repro.pass}`, {}],
      ["带 opts.targets 版", `node --test; node --test ${repro.pass}`, { targets: [repro.pass] }],
      ["换行分隔（无控制符）版", `node --test\nnode --test ${repro.pass}`, {}],
    ];
    withPrivateTmpdir((channels) => {
      const channelsBefore = channels();
      for (const [label, cmd, extra] of forms) {
        assert.throws(() => runNestedCommand(cmd, { cwd: repro.dir, ...extra }), REFUSED_RE, `${label} 必须拒绝`);
        assert.throws(() => runNestedCommand(cmd, { cwd: repro.dir, ...extra }), COMPOUND_RE, `${label} 红因须点名`);
        assert.equal(existsSync(repro.firstMarker), false, `${label}：第一段必失败夹具**不得加载**（marker 出现即已跑）`);
        assert.equal(existsSync(repro.passMarker), false, `${label}：任何一段都不得跑`);
        assert.equal(channels(), channelsBefore, `${label}：拒绝时不得创建事件通道（私有 TMPDIR 计数不变）`);
      }
    });
    t.diagnostic(`evidence: suite=g420-compound-refused forms=${forms.length} first_segment_ran=0 marker=absent`);
  } finally {
    rmSync(repro.dir, { recursive: true, force: true });
  }
});

const GUARD_ANCHOR = "  const spans = assertSupportedNestedShellCommand(cmd, source);";

/** 放宽入口门禁（只保留严格分词）—— 用于证明「拒绝」的判别力确实来自该门禁。 */
const bypassGuard = (src: string): string =>
  src.replace(GUARD_ANCHOR, "  const spans = scanNestedShellCommand(cmd).spans; // mutant: shell subset guard removed");

test("g-420 判据2（P1 变异对照）：摘掉入口门禁 ⇒ 复合 shell 复活为 `code 0 / tests 1 / pass 1 / fail 0 / problems []`", async (t) => {
  const reproSemi = makeCompoundRepro();
  const reproDevNull = makeCompoundRepro();
  const { helper: mutant, dir } = await loadMutantHelper(bypassGuard);
  try {
    // 前提：真实 helper 拒绝这些形态。
    assert.throws(() => runNestedCommand(`node --test; node --test ${reproSemi.pass}`, { cwd: reproSemi.dir }), REFUSED_RE);
    assert.throws(
      () => runNestedCommand(`node --test>/dev/null; node --test ${reproDevNull.pass}`, { cwd: reproDevNull.dir }),
      REFUSED_RE,
    );

    // A. `;` 版：门禁去掉后 P1 现象**完全复活**（终局复核报告的形态）；第一段**确实跑过**（marker 在）。
    const revived = await mutant.runNestedCommand(`node --test; node --test ${reproSemi.pass}`, { cwd: reproSemi.dir });
    assert.equal(revived.code, 0, "复现：整体退出码 0（第一段的非零被第二段覆盖）");
    assert.equal(revived.summary.tests, 1, "复现：只留下最后一段的 tests=1");
    assert.equal(revived.summary.pass, 1, "复现：pass 1");
    assert.equal(revived.summary.fail, 0, "复现：第一段的 fail 被覆盖 ⇒ 0");
    assert.deepEqual(revived.targets, [reproSemi.pass], "复现：目标只推导出最后一段");
    assert.equal(existsSync(reproSemi.firstMarker), true, "复现：第一段**确实跑了**（这正是 P1，不是假想）");
    assert.deepEqual(
      mutant.nestedSuitePassProblems(revived),
      [],
      "复现：problems=[] ⇒ helper 接受（终局复核报告的确切形态）",
    );

    // B. `>/dev/null` 粘连版：第一段失败被重定向 + 覆盖双重隐藏，同样完全复活。
    const revivedDevNull = await mutant.runNestedCommand(`node --test>/dev/null; node --test ${reproDevNull.pass}`, {
      cwd: reproDevNull.dir,
    });
    assert.equal(revivedDevNull.code, 0, "复现（>/dev/null）：整体退出码 0");
    assert.equal(revivedDevNull.summary.tests, 1, "复现（>/dev/null）：tests=1");
    assert.equal(revivedDevNull.summary.pass, 1, "复现（>/dev/null）：pass 1");
    assert.equal(revivedDevNull.summary.fail, 0, "复现（>/dev/null）：fail 0");
    assert.equal(existsSync(reproDevNull.firstMarker), true, "复现（>/dev/null）：第一段确实跑了");
    assert.deepEqual(
      mutant.nestedSuitePassProblems(revivedDevNull),
      [],
      "复现（>/dev/null）：problems=[] ⇒ helper 接受",
    );
    t.diagnostic(
      `evidence: suite=g420-compound-mutant revived=2 problems=0 semi_blocks=${revived.summary.summaryBlocks} ` +
        `devnull_blocks=${revivedDevNull.summary.summaryBlocks} code=${revived.code} tests=${revived.summary.tests} ` +
        `pass=${revived.summary.pass} fail=${revived.summary.fail} first_ran=1`,
    );
  } finally {
    rmSync(reproSemi.dir, { recursive: true, force: true });
    rmSync(reproDevNull.dir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-420 判据2（反误红，终局复核修正）：合法全绿运行出现多个汇总块 ⇒ **不得**判红（⑨ 已放弃）", async (t) => {
  const repro = mkdtempSync(join(tmpdir(), "dsh-graph-g420-multiblock-"));
  const marker = join(repro, "ran.marker");
  const echo = join(repro, "echo-summary.test.mjs");
  // 合法用例：加载即写 marker、**故意打印两行伪造汇总**（模拟「合法运行 stdout 里出现多个 `ℹ tests N`」），
  // 然后正常通过。终局复核实测的真实场景是「外层 NODE_OPTIONS 注入被内层继承 ⇒ 目标 stdout 汇总加倍」。
  writeFileSync(
    echo,
    `import { test } from "node:test";\nimport { writeFileSync } from "node:fs";\n` +
      `writeFileSync(${JSON.stringify(marker)}, "ran");\n` +
      `test("multi-block legit", () => { console.log("ℹ tests 999"); console.log("ℹ pass 999"); });\n`,
  );
  try {
    const run = await runNestedCommand(`node --test ${echo}`, { cwd: repro });
    assert.equal(run.code, 0, `合法运行必须判绿：\n${run.out.slice(-400)}`);
    assert.ok(
      run.summary.summaryBlocks > 1,
      `前提：人类可读通道确实有多个汇总块（实测 ${run.summary.summaryBlocks}）`,
    );
    assert.deepEqual(
      nestedSuitePassProblems(run),
      [],
      "多个汇总块**不得**成为红因（否则会误伤真实消费点，如嵌套 g353 的合法全绿运行）",
    );
    assertNestedSuitePassed(run, "g-420 反误红（多汇总块合法运行）");
    assert.equal(existsSync(marker), true, "前提：该运行确实执行了用例");

    // 真实消费点形态的实测钉子：g353 的 check:dist 站点（单文件）⇒ 事件通道 `summaries === 2`
    // （1 个逐文件完成事件 + 1 个全局汇总），helper 必须判绿。
    const consumer = await runNestedCommand(`node --test ${join("core", "tests", "dist-freshness-g312.test.ts")}`, {
      cwd: repoRoot,
    });
    assert.equal(consumer.code, 0, `真实消费点形态必须判绿：\n${consumer.out.slice(-400)}`);
    assert.equal(consumer.channel.summaries, 2, "实测：合法单文件嵌套运行的通道摘要数就是 2（复核者的数据点）");
    assert.equal(consumer.channel.files.length, 1, "逐文件完成事件恰 1 个");
    assert.deepEqual(nestedSuitePassProblems(consumer), [], "真实消费点不得被任何摘要块数口径判红");
    t.diagnostic(
      `evidence: suite=g420-no-false-red fake_blocks=${run.summary.summaryBlocks} fake_problems=0 ` +
        `consumer_summaries=${consumer.channel.summaries} consumer_files=${consumer.channel.files.length} ` +
        `consumer_problems=0 code=${consumer.code}`,
    );
  } finally {
    rmSync(repro, { recursive: true, force: true });
  }
});

test("g-420 判据2（正向）：受支持子集照常判绿——含空格路径必须用引号包裹（旧缺陷的合法替代）", async (t) => {
  const probe = makeShellProbe();
  const { dir, spacedFixture, marker } = probe;
  try {
    const quotedForms = [
      ["单引号", `node --test '${spacedFixture}'`],
      ["双引号", `node --test "${spacedFixture}"`],
      ["多重空格", `node --test   '${spacedFixture}'`],
    ] as const;
    for (const [label, cmd] of quotedForms) {
      const run = await runNestedCommand(cmd, { cwd: dir });
      assert.equal(run.code, 0, `${label} 形态必须判绿：${cmd}\n${run.out.slice(-500)}`);
      assert.deepEqual(nestedSuitePassProblems(run), [], `${label} 形态不得被 ② 的校验误红：${cmd}`);
      assertNestedSuitePassed(run, `g-420 正向（${label}）`);
    }
    assert.equal(existsSync(marker), true, "正向形态必须真的跑起夹具");
    t.diagnostic(`evidence: suite=g420-shell-accepted forms=3 quoted=1 spaced_path=1 green=1`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-420 判据2（正向）：g-419 fallback 注入形态（`<node> --test` + 声明 targets）仍被支持", async (t) => {
  const probe = makeShellProbe();
  const { dir, fixture, marker } = probe;
  try {
    const run = await runNestedCommand(`${process.execPath} --test`, { cwd: dir, targets: [fixture] });
    assert.equal(run.code, 0, `fallback 注入形态必须判绿：\n${run.out.slice(-500)}`);
    assert.ok(run.command.includes(fixture), "等价重写后的命令必须带上声明目标");
    assert.deepEqual(nestedSuitePassProblems(run), [], "fallback 注入形态不得被 ② 的校验误红");
    assertNestedSuitePassed(run, "g-420 fallback 注入（shell）");
    assert.equal(existsSync(marker), true, "注入后声明目标必须真的被执行");
    t.diagnostic(`evidence: suite=g420-shell-fallback-injected code=${run.code} targets=1 green=1`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// 结构守卫：口径落到 AGENTS.md 与文件头；入口门禁确实在 capture() 之前
// ============================================================================

test("g-420 判据2/3（结构守卫）：helper 文件头与 AGENTS.md 同步「三方交叉校验 + shell 支持子集」口径", (t) => {
  const helperSrc = readFileSync(HELPER, "utf8");
  assert.match(helperSrc, /nestedChannelCrossCheckProblems/, "helper 必须暴露 ① 的交叉校验实现");
  assert.match(helperSrc, /NESTED_SHELL_SUBSET/, "helper 必须显式给出 shell 支持子集");
  assert.match(NESTED_SHELL_SUBSET, /--test/, "子集表述必须点名 --test");
  assert.match(NESTED_SHELL_SUBSET, /反斜杠/, "子集表述必须点名反斜杠转义不受支持");

  // 接线顺序：入口门禁必须在会创建事件通道的 capture() **之前**（spawn 前 fail-closed 的结构性保证）。
  const body = helperSrc.slice(helperSrc.indexOf("export function runNestedCommand("));
  const bodyEnd = body.indexOf("\n}");
  const fnBody = body.slice(0, bodyEnd === -1 ? body.length : bodyEnd);
  const guardAt = fnBody.indexOf("assertSupportedNestedShellCommand(cmd, source)");
  const captureAt = fnBody.indexOf("return capture(");
  assert.notEqual(guardAt, -1, "runNestedCommand 必须调用 shell 子集门禁");
  assert.notEqual(captureAt, -1, "runNestedCommand 必须经 capture() 启动");
  assert.ok(guardAt < captureAt, "shell 子集门禁必须在 capture()（创建通道）之前");

  const agents = readFileSync(AGENTS, "utf8");
  assert.match(agents, /三方交叉校验/, "AGENTS.md 必须保留「三方交叉校验」声明");
  assert.match(agents, /shell 支持子集|shell 子集/, "AGENTS.md 必须同步「shell 支持子集」口径");
  // 保留不替换：原命令与同一 glob 表述必须逐字仍在。
  assert.match(agents, /node scripts\/run-tests\.mjs/, "AGENTS.md 不得替换原自证闸门命令");
  assert.match(agents, /core\/tests\/\*\.test\.ts/, "AGENTS.md 必须保留同一 glob 表述");
  t.diagnostic(`evidence: suite=g420-doc-sync helper_header=1 agents=1 guard_before_capture=1`);
});
