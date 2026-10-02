/**
 * core/tests/g415-gate-hardening.test.ts
 *
 * g-415（v0.19.7 lane）：整套件自证闸门 `scripts/run-tests.mjs` 的**五类出口 + 两道追加防线**收口。
 * 终局复核在 tip `0a130d0` 上实测确认以下形态仍可判绿，本文件逐条钉住修复：
 *
 *  ① `todo` 漏门禁：`test.todo(...)` / `test(..., { todo: true }, ...)` 计入 `todo` 而非 `fail`
 *     ⇒ 旧判据全绿。现 `nestedSuitePassProblems` 补 `todo === 0`，且计数口径须
 *     `pass + fail + cancelled + skipped + todo === tests`。
 *  ② `NODE_OPTIONS` 选集旁路：`--test-only`（配选集标记）/ `--test-name-pattern` /
 *     `--test-skip-pattern` / `--test-shard` 被 `cleanTestEnv()` 继承 ⇒ 失败文件被静默排除仍 `exit 0`。
 *     现闸门 **fail-closed 拒绝运行**（内存/告警等不改变选中集合的合法选项不受影响）。
 *  ③ 目标文件覆盖：事件通道转发**逐文件**完成事件（带 `file` 的 `test:summary`），闸门断言
 *     「匹配到的文件集合」≡「真正产出完成事件的文件集合」⇒ 关闭 shard / pattern / 测试内提前退出
 *     等**静默少跑**（附变异对照：去掉该断言 ⇒ 提前退出形态复活为绿）。
 *  ④ 结构守卫（本文件）：禁止被收集集合 `core/tests/*.test.ts` 出现**选集式 only 标记**与
 *     **直接退出进程调用**（含 hook 内同型调用，文本扫描天然覆盖）。
 *  ⑤ **管道截断**：收尾只设退出码、不硬退出；超大输出经 pipe 捕获时自证行必须可见（> 200 KB）。
 *
 * 边界（本目标明确不做，只在报文登记为残余）：被信任的单用户本地模型下，测试**蓄意**破坏闸门自身
 * （写私有事件文件、monkey-patch reporter、伪造非 Node 事件）属 owner-trusted 边界外；空哨兵/无断言
 * 用例的**语义质量**也无法由闸门证明（`t.plan` 只计 subtest 数）。
 *
 * 负向夹具都在 `fixtures/g415/`（不被顶层 glob 误收）且立即收敛，不挂起。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertNestedSuitePassed,
  cleanTestEnv,
  findTestSelectionOption,
  nestedSuitePassProblems,
  parseEventChannel,
  parseTestSummary,
  TEST_SELECTION_OPTION_NAMES,
  type NestedRunResult,
} from "./fixtures/nested-runner.ts";

const repoRoot = join(import.meta.dirname, "../..");
const GATE = join(repoRoot, "scripts", "run-tests.mjs");
const REPORTER = join(repoRoot, "scripts", "test-reporter-events.mjs");
const TESTS_DIR = join(repoRoot, "core", "tests");
const FIXTURES = join(TESTS_DIR, "fixtures", "g415");
const GUARD_FILE = join(import.meta.dirname, "g415-gate-hardening.test.ts");

const G407_PASS = join(TESTS_DIR, "fixtures", "g407", "always-pass.test.ts");
const G407_FAIL = join(TESTS_DIR, "fixtures", "g407", "always-fail.test.ts");
const TODO_CALL = join(FIXTURES, "todo-call.test.ts");
const TODO_OPTION = join(FIXTURES, "todo-option.test.ts");
const EARLY_EXIT = join(FIXTURES, "early-exit.test.ts");
const LARGE_OUTPUT = join(FIXTURES, "large-output.test.ts");
const ONLY_SAMPLE = join(FIXTURES, "only-sample.test.ts");
const PASS_A = join(FIXTURES, "pass-a.test.ts");
const PASS_B = join(FIXTURES, "pass-b.test.ts");

/** 被收集集合 = 闸门默认 glob `core/tests/*.test.ts`（顶层 `*.test.ts`，不含 fixtures 子目录）。 */
const COLLECTED_TESTS = readdirSync(TESTS_DIR)
  .filter((name) => name.endsWith(".test.ts"))
  .map((name) => join(TESTS_DIR, name))
  .sort();

/**
 * 跑一次闸门。超时/启动失败一律**显式失败** —— 否则「非零退出」可能只是外部超时造成的假红。
 * 注入变量摘除**一律经唯一实现** `cleanTestEnv()`（g-407 判据 2：本文件不得自行摘除）；
 * 基线另摘掉外层 `NODE_OPTIONS`（需要时经 `extra` 显式注入），避免与选集用例互相干扰。
 */
function runGate(targets: string[], extra: NodeJS.ProcessEnv = {}, script = GATE) {
  const env = cleanTestEnv(extra);
  if (!("NODE_OPTIONS" in extra)) delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, [script, ...targets], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120_000,
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

const summaryBlock = (o: {
  tests: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo?: number;
}) =>
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
// 判据 1：todo === 0 入判据 + 计数口径自洽（两形态实测）
// ============================================================================

for (const [label, fixture] of [
  ["test.todo 形态", TODO_CALL],
  ["{ todo: true } 形态", TODO_OPTION],
] as const) {
  test(`g-415 判据1：${label} 的待办用例 ⇒ 闸门 exit≠0 且红因点名 todo`, (t) => {
    const g = runGate([fixture]);
    assert.notEqual(g.code, 0, `todo>0 不得放行（闸门 exit=${g.code}）\n${g.out.slice(-400)}`);
    assert.match(redReason(g.err), /待办|todo=1/, `红因必须点名 todo：${redReason(g.err)}`);
    assert.doesNotMatch(g.out, /✔ 自证通过/, "判红时不得回显自证通过行");
    t.diagnostic(`evidence: suite=g415-gate-todo exit=${g.code} red=todo-1 form=${label}`);
  });
}

test("g-415 判据1：nestedSuitePassProblems 把 todo 列为不达标，且计数口径含 todo 自洽", () => {
  const todoRun = syntheticRun(0, summaryBlock({ tests: 1, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 1 }));
  const problems = nestedSuitePassProblems(todoRun).join("；");
  assert.match(problems, /todo=1/, "todo 必须单列（旧版只看 fail/cancelled/skipped 会放行）");
  assert.doesNotMatch(problems, /计数口径不自洽/, "tests=pass+fail+cancelled+skipped+todo=1 必须自洽");
  assert.throws(() => assertNestedSuitePassed(todoRun, "待办形态"), /待办|todo/);

  const green = syntheticRun(0, summaryBlock({ tests: 1, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 }));
  assert.deepEqual(nestedSuitePassProblems(green), [], "正常全绿（todo=0）不得被误判");

  const incoherent = syntheticRun(0, summaryBlock({ tests: 2, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 1 }));
  assert.throws(() => assertNestedSuitePassed(incoherent, "口径不自洽"), /计数口径不自洽/, "todo 必须计入口径");
});

test("g-415 判据1：todo 夹具落在 fixtures 子目录（不被顶层 glob 误收）", () => {
  const topLevel = readdirSync(TESTS_DIR).filter((name) => name.endsWith(".test.ts"));
  for (const name of ["todo-call.test.ts", "todo-option.test.ts"]) {
    assert.ok(!topLevel.includes(name), `${name} 不得出现在 core/tests 顶层`);
  }
});

// ============================================================================
// 判据 2：NODE_OPTIONS 选集/分片开关 ⇒ fail-closed（四类逐一 + 不误伤合法用法）
// ============================================================================

const SELECTION_CASES: Array<{ name: string; nodeOptions: string; targets: string[] }> = [
  { name: "--test-only", nodeOptions: "--test-only", targets: [ONLY_SAMPLE] },
  { name: "--test-name-pattern", nodeOptions: "--test-name-pattern=pass-a", targets: [G407_PASS, G407_FAIL] },
  { name: "--test-skip-pattern", nodeOptions: "--test-skip-pattern=always-fail", targets: [G407_PASS, G407_FAIL] },
  { name: "--test-shard", nodeOptions: "--test-shard=1/2", targets: [G407_PASS, G407_FAIL] },
];

for (const c of SELECTION_CASES) {
  test(`g-415 判据2：NODE_OPTIONS 含 ${c.name} ⇒ fail-closed 拒绝运行且红因点名`, (t) => {
    const g = runGate(c.targets, { NODE_OPTIONS: c.nodeOptions });
    assert.notEqual(g.code, 0, `${c.name} 必须 fail-closed（闸门 exit=${g.code}）\n${g.out.slice(-400)}`);
    assert.match(redReason(g.err), new RegExp(c.name), `红因必须点名开关 ${c.name}：${redReason(g.err)}`);
    assert.match(redReason(g.err), /fail-closed|拒绝运行/, "红因必须说明 fail-closed");
    assert.doesNotMatch(g.out, /✔ 自证通过|ℹ tests/, "拒绝运行时不得起 runner / 回显自证通过");
    t.diagnostic(`evidence: suite=g415-nodeoptions-${c.name.slice(2)} exit=${g.code} red=selection-switch`);
  });
}

test("g-415 判据2：合法 NODE_OPTIONS（内存/告警）不得被误伤", (t) => {
  const g = runGate([G407_PASS], { NODE_OPTIONS: "--max-old-space-size=4096 --no-warnings" });
  assert.equal(g.code, 0, `合法 NODE_OPTIONS 下闸门必须照常判绿：\n${g.err.slice(-400)}`);
  assert.match(g.out, /\[run-tests\] ✔ 自证通过/, "合法 NODE_OPTIONS 仍须回显自证行");
  t.diagnostic(`evidence: suite=g415-nodeoptions-legit exit=${g.code} red=none`);
});

test("g-415 判据2：findTestSelectionOption 只命中选集/分片开关（=value / 空格 / 引号形态）", () => {
  for (const name of TEST_SELECTION_OPTION_NAMES) {
    assert.equal(findTestSelectionOption(name), name, `${name} 必须命中`);
    assert.equal(findTestSelectionOption(`${name}=value`), name, `${name}=value 必须归一命中`);
    assert.equal(findTestSelectionOption(`--no-warnings ${name} value`), name, `${name} 空格形态必须命中`);
  }
  assert.equal(findTestSelectionOption('--test-name-pattern "a b"'), "--test-name-pattern");
  assert.equal(findTestSelectionOption('--test-name-pattern="a b"'), "--test-name-pattern");
  for (const legit of [
    "",
    "--max-old-space-size=4096",
    "--no-warnings --max-old-space-size=4096",
    "--experimental-strip-types --no-warnings",
  ]) {
    assert.equal(findTestSelectionOption(legit), null, `合法选项不得被误判：${legit}`);
  }
  assert.equal(findTestSelectionOption(undefined), null);
  assert.equal(findTestSelectionOption(null), null);
});

// ============================================================================
// 判据 3：目标文件覆盖断言（含提前退出形态 + 变异对照 + 多文件正向）
// ============================================================================

test("g-415 判据3：测试内提前退出（无逐文件完成事件）⇒ 闸门 exit≠0 且红因点名覆盖", (t) => {
  const g = runGate([EARLY_EXIT]);
  assert.notEqual(g.code, 0, `提前退出形态必须判红（闸门 exit=${g.code}）\n${g.out.slice(-400)}`);
  assert.match(redReason(g.err), /未产出完成事件|目标文件/, `红因必须点名目标文件覆盖：${redReason(g.err)}`);
  assert.doesNotMatch(g.out, /✔ 自证通过/, "判红时不得回显自证通过行");
  t.diagnostic(`evidence: suite=g415-coverage-early-exit exit=${g.code} red=no-completion-event`);
});

test("g-415 判据3：多文件全绿 ⇒ 覆盖断言不得误红（覆盖不是恒红假守卫）", (t) => {
  const g = runGate([PASS_A, PASS_B]);
  assert.equal(g.code, 0, `多文件全绿必须判绿：\n${g.err.slice(-500)}`);
  assert.match(g.out, /\[run-tests\] ✔ 自证通过：tests=2/, "两个目标文件都必须真的跑");
  assert.doesNotMatch(redReason(g.err), /未产出完成事件/, "正常多文件不得报覆盖缺失");
  t.diagnostic(`evidence: suite=g415-coverage-multifile exit=${g.code} files=2`);
});

test("g-415 判据3 变异对照：去掉覆盖断言后提前退出形态复活为绿（证明覆盖是真守卫）", (t) => {
  const original = readFileSync(GATE, "utf8");
  const anchor = "    problems.push(...coverageProblems(targetFiles, channel)); // g-415 判据③：逐文件覆盖";
  const mutantSrc = original.replace(anchor, "    // mutant: coverage removed");
  assert.notEqual(mutantSrc, original, "变异锚点失效：闸门里必须存在覆盖断言那一行");
  const fixed = mutantSrc.replace(
    /const repoRoot = join\(dirname\(fileURLToPath\(import\.meta\.url\)\), "\.\."\);/,
    `const repoRoot = ${JSON.stringify(repoRoot)};`,
  );
  assert.notEqual(fixed, mutantSrc, "变异副本的 repoRoot 重写锚点失效");
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g415-mutant-"));
  try {
    const mutant = join(dir, "run-tests-mutant.mjs");
    writeFileSync(mutant, fixed);
    const g = runGate([EARLY_EXIT], {}, mutant);
    assert.equal(g.code, 0, `去掉覆盖断言后提前退出形态必须复活为绿（否则覆盖断言不是唯一判别力）\n${g.err.slice(-500)}`);
    assert.match(g.out, /✔ 自证通过/, "变异闸门必须回显自证通过（证明原闸门的判红来自覆盖断言）");
    t.diagnostic(`evidence: suite=g415-coverage-mutant exit=${g.code} red=none-coverage-removed`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-415 判据3：parseEventChannel 只把带 file 的逐文件汇总计入完成事件", () => {
  const counts = { tests: 1, suites: 0, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 };
  const ndjson = [
    JSON.stringify({ type: "summary", file: "/repo/core/tests/a.test.ts", counts }),
    JSON.stringify({ type: "summary", file: null, counts }),
    JSON.stringify({ type: "tally", counts: { ...counts, pass: 1 } }),
  ].join("\n");
  const ch = parseEventChannel(ndjson);
  assert.deepEqual(ch.files, ["/repo/core/tests/a.test.ts"], "只有带 file 的汇总才计入完成事件集合");
  assert.equal(ch.summaries, 2, "文件级 + 全局级都要计入 summaries");
});

test("g-415 判据3：干净通道结构与闸门覆盖断言（结构守卫）", () => {
  const reporter = readFileSync(REPORTER, "utf8");
  assert.match(
    reporter,
    /yield emit\(\{\s*type: "summary", file:/,
    "reporter 必须转发逐文件汇总的 file（否则覆盖断言无从比较）",
  );
  const src = readFileSync(GATE, "utf8");
  assert.match(src, /coverageProblems\(targetFiles, channel\)/, "闸门必须做目标文件覆盖断言");
  assert.match(src, /未产出完成事件/, "覆盖断言必须给出可读红因");
  assert.match(src, /const targetFiles = /, "必须显式构造「匹配到的文件集合」");
});

// ============================================================================
// 判据 4：结构守卫（选集式 only 标记 + 直接退出进程调用）
// ============================================================================

interface ScanHit {
  file: string;
  line: number;
  text: string;
}

const SCAN_EXT_RE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/** 递归列出可扫描的源码文件（供 only 结构守卫扫 `core/tests/**`）。 */
function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SCAN_EXT_RE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

// 选集式 only 标记的两种形态：①已知关键字后跟点号+only（含嵌套块）；②任意字面「点号+only(」调用。
// 模式由字符串片段拼出，避免守卫自身源码命中自己。
const ONLY_KEYWORD_RE = new RegExp(`(?:^|[^\\w$.])(?:test|it|describe|suite)\\s*\\.\\s*only\\b`);
const ONLY_CALL_RE = new RegExp(`\\.\\s*only\\s*\\(`);

/** 守卫自身所需夹具的**显式路径白名单**（唯一允许出现 only 标记的样本）。 */
const SELECTION_ONLY_ALLOW = new Set<string>([ONLY_SAMPLE, GUARD_FILE]);

/**
 * 把源码里的**注释 / 字符串 / 模板字面量**替换成空白（保留换行，行号不变），只留下真正的**代码**。
 *
 * 为什么必须这么做：结构守卫要看的是「**本测试文件自己**是否直接退出进程 / 使用选集标记」，而
 * 仓内合法用法是把子脚本写成**字符串**再 spawn（例如 `spawnSync(node, ["-e", "…"])`），
 * 字符串里的同名调用**不会**影响父测试进程。纯文本正则会把这些合法字符串误判为违规（实测三处）。
 * 说明：模板字面量的 `${…}` 插值也一并按字符串处理（对「本文件直接退出」这一威胁是保守方向；
 * 插值里写直接退出的路径属残余，见报文）。
 */
function stripNonCode(src: string): string {
  const out: string[] = [];
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === "code") {
      if (ch === "/" && next === "/") { mode = "line"; out.push("  "); i += 2; continue; }
      if (ch === "/" && next === "*") { mode = "block"; out.push("  "); i += 2; continue; }
      if (ch === "'") { mode = "single"; out.push(" "); i += 1; continue; }
      if (ch === '"') { mode = "double"; out.push(" "); i += 1; continue; }
      if (ch === "`") { mode = "template"; out.push(" "); i += 1; continue; }
      out.push(ch);
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (ch === "\n") { mode = "code"; out.push("\n"); i += 1; continue; }
      out.push(" ");
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (ch === "*" && next === "/") { mode = "code"; out.push("  "); i += 2; continue; }
      out.push(ch === "\n" ? "\n" : " ");
      i += 1;
      continue;
    }
    // 字符串 / 模板：反斜杠转义整体吞掉
    if (ch === "\\") { out.push("  "); i += 2; continue; }
    const closer = mode === "single" ? "'" : mode === "double" ? '"' : "`";
    if (ch === closer) { mode = "code"; out.push(" "); i += 1; continue; }
    out.push(ch === "\n" ? "\n" : " ");
    i += 1;
  }
  return out.join("");
}

/** 逐行扫描只含代码的文本，回传命中行。 */
function scanCodeLines(text: string, matcher: (line: string) => boolean): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  stripNonCode(text)
    .split("\n")
    .forEach((line, index) => {
      if (matcher(line)) hits.push({ line: index + 1, text: line.trim() });
    });
  return hits;
}

function scanSelectionOnly(dir: string, allow: Set<string>): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const file of listSourceFiles(dir)) {
    if (allow.has(file)) continue;
    for (const hit of scanCodeLines(readFileSync(file, "utf8"), (line) => ONLY_KEYWORD_RE.test(line) || ONLY_CALL_RE.test(line))) {
      hits.push({ file, ...hit });
    }
  }
  return hits;
}

test("g-415 判据4：core/tests/** 不得出现选集式 only 标记（白名单外零命中）", (t) => {
  const hits = scanSelectionOnly(TESTS_DIR, SELECTION_ONLY_ALLOW);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}`),
    [],
    `白名单外不得出现选集式 only 标记：${hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("；")}`,
  );
  assert.ok(SELECTION_ONLY_ALLOW.has(ONLY_SAMPLE), "白名单必须显式列出 only 样本夹具");
  assert.ok(SELECTION_ONLY_ALLOW.has(GUARD_FILE), "白名单必须显式列出守卫自身");
  t.diagnostic(`evidence: suite=g415-only-guard hits=0 allow=${SELECTION_ONLY_ALLOW.size}`);
});

test("g-415 判据4 负向对照：摘掉白名单后 only 样本必须被判红（含嵌套块与字面调用两形态）", (t) => {
  const production = scanSelectionOnly(TESTS_DIR, new Set());
  const fixtureHits = production.filter((h) => h.file === ONLY_SAMPLE);
  assert.ok(fixtureHits.length >= 3, `only 样本必须被检出至少 3 处（test/describe/it）：${fixtureHits.length}`);

  // 字面「点号+only(」形态（无已知关键字）也必须被检出；片段拼接避免守卫自身命中。
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g415-only-"));
  try {
    const literal = join(dir, "literal.test.ts");
    writeFileSync(literal, `${"customObj"}${"." + "only" + "("}x);\n`);
    const nested = join(dir, "nested.test.ts");
    writeFileSync(nested, readFileSync(ONLY_SAMPLE, "utf8"));
    const hits = scanSelectionOnly(dir, new Set());
    assert.ok(hits.some((h) => h.file === literal), "字面 only( 调用形态必须被检出");
    assert.ok(hits.filter((h) => h.file === nested).length >= 3, "嵌套 describe 块形态必须被检出");
    t.diagnostic(`evidence: suite=g415-only-negative-control flagged=${hits.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 直接退出进程调用（含 exitCode 赋值 / hook 内同型调用 —— 文本扫描天然覆盖）。
const PROCESS_REF = "process";
const EXIT_REF_RE = new RegExp(`\\b${PROCESS_REF}\\s*\\.\\s*(?:exit\\s*\\(|exitCode\\b)`);

function scanDirectExit(files: string[]): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const file of files) {
    for (const hit of scanCodeLines(readFileSync(file, "utf8"), (line) => EXIT_REF_RE.test(line))) {
      hits.push({ file, ...hit });
    }
  }
  return hits;
}

test("g-415 判据4(P1-⑦)：被收集集合不得出现直接退出进程调用（结构守卫）", (t) => {
  const hits = scanDirectExit(COLLECTED_TESTS);
  assert.deepEqual(
    hits.map((h) => `${h.file}:${h.line}`),
    [],
    `被收集集合（core/tests/*.test.ts）不得直接退出进程（会让断言静默不执行）：` +
      hits.map((h) => `${h.file}:${h.line}: ${h.text}`).join("；"),
  );
  assert.ok(COLLECTED_TESTS.includes(GUARD_FILE), "守卫自身必须在被收集集合内（否则守卫空转）");
  t.diagnostic(`evidence: suite=g415-exit-guard scanned=${COLLECTED_TESTS.length} hits=0`);
});

test("g-415 判据4(P1-⑦) 负向对照：危险形态样本（真实夹具 + exitCode 合成件）必须被判红", (t) => {
  const real = scanDirectExit([EARLY_EXIT]);
  assert.ok(
    real.length >= 1 && real[0].file === EARLY_EXIT,
    `fixtures 里的提前退出样本必须被守卫检出：${JSON.stringify(real)}`,
  );

  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g415-exit-"));
  try {
    const callFile = join(dir, "call.test.ts");
    writeFileSync(callFile, `${PROCESS_REF}.exit(0);\n`);
    const codeFile = join(dir, "code.test.ts");
    writeFileSync(codeFile, `${PROCESS_REF}.exitCode = 0;\n`);
    const hits = scanDirectExit([callFile, codeFile]);
    assert.ok(hits.some((h) => h.file === callFile), "调用形态必须被检出");
    assert.ok(hits.some((h) => h.file === codeFile), "exitCode 赋值形态必须被检出");
    t.diagnostic(`evidence: suite=g415-exit-negative-control flagged=${hits.length} real=${real.length}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-415 判据4：only 样本与提前退出夹具都在 fixtures 子目录（不被顶层 glob 误收）", () => {
  const topLevel = readdirSync(TESTS_DIR).filter((name) => name.endsWith(".test.ts"));
  for (const name of ["only-sample.test.ts", "early-exit.test.ts", "large-output.test.ts"]) {
    assert.ok(!topLevel.includes(name), `${name} 不得出现在 core/tests 顶层`);
  }
});

// ============================================================================
// 判据 5（P1-⑥）：管道 flush + 正向不回归 + 文档口径
// ============================================================================

test("g-415 判据5(P1-⑥)：超大输出经 pipe 捕获时自证行必须可见（flush 不回归）", (t) => {
  const g = runGate([LARGE_OUTPUT]);
  assert.equal(g.code, 0, `超大输出套件必须判绿：\n${g.err.slice(-400)}`);
  assert.ok(
    g.out.length > 200_000,
    `pipe 捕获必须拿到完整输出（实际 ${g.out.length} 字节；旧版被硬退出截在 65536）`,
  );
  assert.match(g.out, /\[run-tests\] ✔ 自证通过/, "自证行必须在 pipe 捕获中可见（旧版被硬退出丢弃）");
  t.diagnostic(`evidence: suite=g415-pipe-flush exit=${g.code} stdout_bytes=${g.out.length} selftest=visible`);
});

test("g-415 判据5：正向路径回显含 todo=0 / cancelled=0 / skipped=0", (t) => {
  const g = runGate([G407_PASS]);
  assert.equal(g.code, 0, `正向路径必须判绿：\n${g.err.slice(-400)}`);
  assert.match(g.out, /\[run-tests\] ✔ 自证通过/, "必须回显自证行");
  assert.match(g.out, /todo=0/, "自证行必须含 todo=0");
  assert.match(g.out, /cancelled=0/, "自证行必须含 cancelled=0");
  assert.match(g.out, /skipped=0/, "自证行必须含 skipped=0");
  t.diagnostic(`evidence: suite=g415-gate-green exit=${g.code} echo=todo0-cancelled0-skipped0`);
});

test("g-415 判据5：闸门结构（不替换原命令、共用 glob、flush 用 exitCode）+ AGENTS.md 同步", () => {
  const src = readFileSync(GATE, "utf8");
  assert.equal(
    /const TEST_GLOB = "([^"]+)"/.exec(src)?.[1],
    "core/tests/*.test.ts",
    "默认 glob 必须与文档命令逐字相同（入口不分叉）",
  );
  assert.match(src, new RegExp(`${PROCESS_REF}\\.exitCode = 0`), "收尾必须设退出码而不是硬退出（pipe flush 前提）");

  const agents = readFileSync(join(repoRoot, "AGENTS.md"), "utf8");
  assert.ok(agents.includes("node --test core/tests/*.test.ts"), "AGENTS.md 必须保留原有全量命令（不替换）");
  assert.ok(agents.includes("scripts/run-tests.mjs"), "AGENTS.md 必须登记自证闸门入口");
  assert.ok(agents.includes("todo == 0"), "AGENTS.md 必须声明 todo==0 判据");
  assert.ok(agents.includes("--test-shard"), "AGENTS.md 必须登记 NODE_OPTIONS 选集 fail-closed");
  assert.ok(agents.includes("完成事件"), "AGENTS.md 必须登记目标文件覆盖断言");
  assert.ok(agents.includes("g415-gate-hardening.test.ts"), "AGENTS.md 必须登记 g-415 结构守卫");
  assert.ok(agents.includes(`${PROCESS_REF}.exitCode`), "AGENTS.md 必须登记 pipe flush 收尾口径");
});
