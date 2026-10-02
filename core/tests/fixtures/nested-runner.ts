/**
 * core/tests/fixtures/nested-runner.ts
 *
 * g-407：**嵌套测试运行器的唯一共用入口**。
 * 任何「测试内部再起一个测试 runner」的调用点都必须经由本模块，禁止各套件各写一份
 * `delete env.NODE_TEST_CONTEXT`。
 *
 * ── 缺陷（最小复现见 `core/tests/g407-nested-runner-context.test.ts`）──────────────
 * `node --test` 运行测试文件时会向该进程注入 `NODE_TEST_CONTEXT=child-v8`；测试内再
 * spawn 一个 `node --test` 时该变量被**继承**，子 runner 遂打印
 *
 *   (node:6) Warning: node:test run() is being called recursively within a test file.
 *   skipping running files.
 *
 * 并且 —— 关键 —— **exit 0 且零汇总输出**。于是子套件里任何「应当报红/应当通过」的断言
 * 都变成**永真**（false green），而顶层汇总只统计自己的用例（`skipped 0`），
 * 从表面完全看不出嵌套被跳过。这直接侵蚀全部测试证据的可信度。
 *
 * ── 本模块的三件事 ────────────────────────────────────────────────────────────────
 *  ① `cleanTestEnv()`：派生任何子进程前**摘掉**运行器注入变量；
 *  ② `assertNestedSuiteRan()`：把「零用例 / 被 skip / 没有汇总 / 计数口径不自洽」判为**显式失败**。
 *     理由：「子进程根本没跑用例」与「子进程跑完且全绿」在退出码上无法区分（都是 0），
 *     只看退出码的断言必然是永真 —— 必须改看**汇总输出本身**；
 *  ③ `assertNestedSuitePassed()`：全绿判据 = **退出码 0 且 cancelled 0 且 fail 0 且 skipped 0**。
 *
 * ── g-413 的两条补洞（同一根因域：闸门自身可被绕过）────────────────────────────────
 *  P1-1「取消不算红」：`node --test` 的 `cancelled`（如 `test(…,{timeout:1},()=>new Promise(()=>{}))`）
 *       不计入 `fail` ⇒ 只判 `fail === 0 && skipped === 0` 会放行被取消的用例。现已补
 *       `cancelled === 0` 与**退出码 === 0**（被取消时 `node --test` 退出非零）。
 *  P1-2「计数通道可被污染」：人类可读汇总与测试自己的 `console.log` 混在同一条 stdout 上
 *       （测试打印一行 `ℹ tests 1` 就能伪造）⇒ 文本解析无法区分来源。本模块的应对：
 *         · `parseTestSummary()` 改为**末尾匹配**（runner 汇总永远是最后一块），并给出
 *           `summaryBlocks` 块数供调用方判「该通道是否唯一/可信」；
 *         · `parseEventChannel()` 读取 `scripts/test-reporter-events.mjs` 产出的**带类型事件**通道
 *           （测试输出走 `test:stdout`，伪造不出 `test:summary`/`test:pass`/`test:fail`），权威计数只认它。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";

/**
 * 测试运行器注入到「测试文件进程」的环境变量。
 * 继承给孙进程会让嵌套 `node --test` 静默跳过全部文件（见文件头缺陷说明）。
 */
export const TEST_CONTEXT_VARS = ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID"] as const;

/**
 * 派生**任何**子进程前的干净 env：`process.env` 与 `extra` **先**合并，**再**摘掉运行器注入变量。
 * ⇒ `extra` 在摘除**之前**合并，因此调用方无法（也不应）通过 `extra` 把注入变量塞回去；
 * 反过来说，本 helper **构造不出**「带 `NODE_TEST_CONTEXT`」的 env（`extra` 里带上也会被摘除）。
 * （g-350：此处曾写成「extra 在摘除之后合并」，与实现相反；以本条为准。）
 */
export function cleanTestEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const name of TEST_CONTEXT_VARS) delete env[name];
  return env;
}

/** `node --test` 汇总行的机械摘要（同时兼容 spec reporter 的 `ℹ` 与 TAP 的 `#`）。 */
export interface TestSummary {
  tests: number;
  suites: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
  todo: number;
  /** 是否出现了汇总块。**为 false 就说明 runner 根本没跑到用例**（skip 的典型形态）。 */
  hasSummary: boolean;
  /** 输出里是否出现「跳过全部文件」标记 ⇒ 继承 NODE_TEST_CONTEXT 的直接证据。 */
  runnerSkippedFiles: boolean;
  /**
   * 输出里 `ℹ|# tests N` 形态的汇总块个数（g-413）。
   * 人类可读通道混有测试自己的 `console.log` ⇒ `> 1` 说明该通道含伪造/重复汇总，**不可信**；
   * 权威计数一律用 {@link parseEventChannel}（带类型事件，测试输出无法伪造）。
   */
  summaryBlocks: number;
}

const SKIP_MARKER = /skipping running files/i;
const HAS_SUMMARY_RE = /(?:^|\n)\s*(?:ℹ|#)\s*tests\s+\d+/;

/** 逐个字段收集**全部**匹配 —— 绝不能只看首个（测试自己的打印会排在 runner 汇总之前，g-413 P1-2）。 */
function allSummaryValues(text: string, label: string): number[] {
  const re = new RegExp(`(?:^|\\n)\\s*(?:ℹ|#)\\s*${label}\\s+(\\d+)`, "g");
  return [...text.matchAll(re)].map((m) => Number(m[1]));
}

/**
 * 解析**人类可读**汇总。
 *
 * 取值语义（g-413 修正）：每个字段取**最后**一个匹配 —— runner 的最终汇总永远是最后一块输出，
 * 测试自己 `console.log` 的伪造行只会排在它之前。块数见 {@link TestSummary.summaryBlocks}，
 * 调用方可据此判「该通道是否唯一」。**需要不可伪造的权威计数时请用 {@link parseEventChannel}。**
 */
export function parseTestSummary(out: string, err = ""): TestSummary {
  const text = `${out}\n${err}`;
  const last = (label: string): number => {
    const values = allSummaryValues(text, label);
    return values.length > 0 ? values[values.length - 1] : 0;
  };
  return {
    tests: last("tests"),
    suites: last("suites"),
    pass: last("pass"),
    fail: last("fail"),
    cancelled: last("cancelled"),
    skipped: last("skipped"),
    todo: last("todo"),
    hasSummary: HAS_SUMMARY_RE.test(text),
    runnerSkippedFiles: SKIP_MARKER.test(text),
    summaryBlocks: allSummaryValues(text, "tests").length,
  };
}

/** 计数口径：`tests` 必须等于各分项之和（`pass+fail+cancelled+skipped+todo`；todo=0 时即不含 todo 的形态）。 */
export function tallyOf(s: TestSummary): number {
  return s.pass + s.fail + s.cancelled + s.skipped + s.todo;
}

/**
 * **干净事件通道**（`scripts/test-reporter-events.mjs`，NDJSON）的解析结果。
 *
 * 这是 g-413 的权威计数来源：只有 runner 自产的**带类型**事件能进来（测试的 `console.log`
 * 走 `test:stdout`，本通道不转发）⇒ 伪造汇总文本**在结构上**进不了这里。
 */
export interface EventChannelReading {
  /** runner 自报的**最后一个**汇总（= 全局级）；`null` ⇒ 没有汇总（未加载 / 被杀 / 未跑完）。 */
  summary: TestSummary | null;
  /** reporter 按带类型事件**独立累加**的计数；`null` ⇒ 通道未完成（子进程被杀/崩溃）。 */
  tally: TestSummary | null;
  /** 出现过的 runner 汇总条数（文件级 + 最后一条全局级）。 */
  summaries: number;
  /** 无法解析/未知类型的行数（`> 0` ⇒ 通道被损坏或截断，计数不可信）。 */
  badLines: number;
}

/** 把 runner 汇总的 `{passed,failed}` 与 tally 的 `{pass,fail}` 归一成同一个摘要形状。 */
function summaryFromCounts(counts: Record<string, unknown>): TestSummary {
  const num = (...keys: string[]): number => {
    for (const key of keys) {
      const value = counts?.[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return 0;
  };
  return {
    tests: num("tests"),
    suites: num("suites"),
    pass: num("passed", "pass"),
    fail: num("failed", "fail"),
    cancelled: num("cancelled"),
    skipped: num("skipped"),
    todo: num("todo"),
    hasSummary: true,
    runnerSkippedFiles: false,
    summaryBlocks: 1,
  };
}

/** 解析干净事件通道的 NDJSON 文本（见 {@link EventChannelReading}）。 */
export function parseEventChannel(text: string): EventChannelReading {
  let summary: TestSummary | null = null;
  let tally: TestSummary | null = null;
  let summaries = 0;
  let badLines = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let record: { type?: unknown; counts?: unknown };
    try {
      record = JSON.parse(line) as { type?: unknown; counts?: unknown };
    } catch {
      badLines += 1;
      continue;
    }
    const counts = record?.counts;
    if (typeof record?.type !== "string" || typeof counts !== "object" || counts === null) {
      badLines += 1;
      continue;
    }
    if (record.type === "summary") {
      summaries += 1;
      summary = summaryFromCounts(counts as Record<string, unknown>); // 逐条覆盖 ⇒ 留下最后（全局）一条
    } else if (record.type === "tally") {
      tally = summaryFromCounts(counts as Record<string, unknown>);
    } else {
      badLines += 1;
    }
  }
  return { summary, tally, summaries, badLines };
}

export interface NestedRunResult {
  /** 子进程退出码（null = 被信号终止）。 */
  code: number | null;
  out: string;
  err: string;
  /** 机械摘要：判定「有没有真的跑」只看它，不看退出码。 */
  summary: TestSummary;
  /** 便于失败消息复现的完整命令行。 */
  command: string;
}

export interface NestedRunOptions {
  cwd: string;
  /** 附加环境变量（注入变量仍会被摘除）。 */
  env?: NodeJS.ProcessEnv;
  timeout?: number;
}

function finish(code: number | null, out: string, err: string, command: string): NestedRunResult {
  return { code, out, err, command, summary: parseTestSummary(out, err) };
}

function capture(
  file: string,
  args: string[],
  opts: NestedRunOptions,
  command: string,
): Promise<NestedRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: cleanTestEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.stderr?.on("data", (chunk) => (err += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve(finish(code, out, err, command)));
  });
}

/**
 * 跑一条**嵌套测试**命令（shell 形态，供 `package.json` 里取到的脚本文本直接用）。
 * env 一律经 {@link cleanTestEnv} 清洗。
 */
export function runNestedCommand(cmd: string, opts: NestedRunOptions): Promise<NestedRunResult> {
  return capture("bash", ["-c", cmd], opts, cmd);
}

/**
 * 跑一个**嵌套测试**进程（argv 形态，跨平台；`node --test …` 的推荐入口）。
 * env 一律经 {@link cleanTestEnv} 清洗。
 */
export function runNestedArgv(
  file: string,
  args: string[],
  opts: NestedRunOptions,
): Promise<NestedRunResult> {
  return capture(file, args, opts, `${file} ${args.join(" ")}`);
}

function tail(run: NestedRunResult, n = 600): string {
  return `${run.out}`.slice(-n);
}

/**
 * 断言「嵌套子进程**确实跑了用例**」。
 *
 * 判据（任一不满足即**显式失败**，绝不静默放行）：
 *  ① 输出含 `skipping running files` ⇒ runner 跳过了全部文件（继承 NODE_TEST_CONTEXT 的直证）；
 *  ② 没有汇总块 ⇒ 根本没跑到用例（此时 exit 0 与「全绿」不可区分，任何断言都永真）；
 *  ③ 汇总里的用例总数为 0 ⇒ 零测试通过 = 失败；
 *  ④ **计数口径不自洽**（g-413）⇒ `tests !== pass+fail+cancelled+skipped+todo` 说明解析到的不是
 *     runner 的完整汇总（截断/污染），计数不可信，同样不得判绿。
 *
 * 注意：`pass === 0` **不**单独判红 —— 「唯一用例就是负向对照且如期失败」是合法形态，
 * 此类调用请用 {@link assertNestedSuiteFailed}。
 */
export function assertNestedSuiteRan(run: NestedRunResult, label: string): void {
  const s = run.summary;
  if (s.runnerSkippedFiles) {
    assert.fail(
      `${label}：嵌套运行器**跳过了全部用例**（输出含 "skipping running files"）——` +
        `这是继承 NODE_TEST_CONTEXT 的典型征兆；此刻任何「期望报红/期望通过」的断言都永真。` +
        `命令：${run.command}`,
    );
  }
  if (!s.hasSummary) {
    assert.fail(
      `${label}：嵌套运行器**没有输出任何汇总行**（exit=${run.code}）⇒ 用例根本没跑，` +
        `退出码不可作为证据。命令：${run.command}\n输出尾部：${tail(run)}`,
    );
  }
  if (s.tests === 0 || tallyOf(s) === 0) {
    assert.fail(
      `${label}：嵌套运行器报告**零用例**（tests=${s.tests}）⇒ 零测试通过必须视为失败。` +
        `命令：${run.command}\n输出尾部：${tail(run)}`,
    );
  }
  if (tallyOf(s) !== s.tests) {
    assert.fail(
      `${label}：汇总**计数口径不自洽**（tests=${s.tests} ≠ pass+fail+cancelled+skipped+todo=${tallyOf(s)}）` +
        `⇒ 计数不可信（解析截断或通道被污染），不得判绿。命令：${run.command}\n输出尾部：${tail(run)}`,
    );
  }
}

/**
 * 全绿判据的**非抛错**形态：返回**全部**不达标项（空数组 = 达标）。
 * 判据：**退出码 0** 且 `cancelled === 0` 且 `fail === 0` 且 `skipped === 0`
 * （`tests > 0` 由 {@link assertNestedSuiteRan} 保证）。
 *
 * 为什么 `cancelled` 必须单列：`node --test` 把被取消（如 timeout）的用例计入 `cancelled` 而**不是** `fail`，
 * 只看 `fail === 0` 会把它放行（g-413 P1-1 的 false-green 洞）。
 *
 * 与 {@link assertNestedSuitePassed} **共用同一实现**：闸门需要把交叉校验红因与这些不达标项
 * 一次性打全，故单独暴露非抛错形态，避免两处各写一份判据。
 */
export function nestedSuitePassProblems(run: NestedRunResult): string[] {
  const s = run.summary;
  const problems: string[] = [];
  if (run.code !== 0) {
    problems.push(`子 runner 退出码 ≠ 0（exit=${run.code}${run.code === null ? "：被信号终止" : ""}）`);
  }
  if (s.cancelled > 0) problems.push(`有被**取消**的用例（cancelled=${s.cancelled}）`);
  if (s.fail > 0) problems.push(`有**失败**用例（fail=${s.fail}）`);
  if (s.skipped > 0) problems.push(`有用例被**跳过**（skipped=${s.skipped}）`);
  return problems;
}

/** 断言嵌套运行「真的跑了」且**全绿**（g-413 补全判据，见 {@link nestedSuitePassProblems}）。 */
export function assertNestedSuitePassed(run: NestedRunResult, label: string): void {
  assertNestedSuiteRan(run, label);
  const problems = nestedSuitePassProblems(run);
  if (problems.length > 0) {
    assert.fail(`${label}：期望全绿的嵌套运行不达标 —— ${problems.join("；")}\n${tail(run, 1500)}`);
  }
}

/**
 * 断言嵌套运行「真的跑了」且**如期报红** —— **双断言**：非零退出码 **且** 输出含预期错误特征。
 * 单看退出码会留下单点永真（子进程从未运行、或为了别的原因失败，都会被误读为「负向对照成立」）。
 */
export function assertNestedSuiteFailed(
  run: NestedRunResult,
  label: string,
  signature: RegExp,
): void {
  assertNestedSuiteRan(run, label);
  assert.notEqual(run.code, 0, `${label}：期望失败的嵌套运行必须非零退出（exit=${run.code}）\n${tail(run, 1500)}`);
  assert.match(
    `${run.out}\n${run.err}`,
    signature,
    `${label}：期望失败的嵌套运行必须输出预期错误特征 ${signature}（只判退出码会留下单点永真）`,
  );
}
