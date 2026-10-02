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
 *
 * ── g-415 的三条补洞（同一根因域：闸门可被判绿而未真正跑全）────────────────────────────
 *  P2-1「待办不算红」：`test.todo(...)` / `test(…,{todo:true},…)` 计入 `todo` 而不入 `fail`
 *       ⇒ 只判 fail/cancelled/skipped 会放行。已补 `todo === 0`（见 {@link nestedSuitePassProblems}）。
 *  P2-2「NODE_OPTIONS 选集旁路」：`cleanTestEnv()` 保留 `NODE_OPTIONS`，故 `--test-only` /
 *       `--test-name-pattern` / `--test-skip-pattern` / `--test-shard` 会让部分目标被静默排除。
 *       已补 {@link findTestSelectionOption} 供闸门 fail-closed 拒绝运行。
 *  P2-3「目标文件覆盖」：{@link parseEventChannel} 现收集**逐文件完成事件**（`test:summary` 带 `file`），
 *       闸门据此断言匹配集合 ≡ 完成事件集合 ⇒ 关闭 shard/pattern/测试内 `process.exit(0)` 早退。
 *
 * ── g-416 的收口（同一根因域在**共享 helper 层**的残余洞）──────────────────────────────────
 *  P2-3 此前只落在闸门 `scripts/run-tests.mjs` 里；**被 helper 消费**的嵌套套件仍可「断言未执行却局部判绿」：
 *  夹具注册 `test('pass',…)` + `test('fail',()=>assert.fail())` 后，在文件顶层用**反射退出**
 *  `globalThis['pro'+'cess']['ex'+'it'](0)` 早退，`runNestedArgv(…,['--test',f],…)` 得
 *  `code 0 / tests 1 / pass 1 / fail 0`，旧的 {@link nestedSuitePassProblems} **接受**。
 *  现收口三件事（全部 **fail-closed，无 opt-out**）：
 *   ① {@link nestedTargetCoverageProblems}：**目标文件集合**（helper 从调用参数推导，见
 *      {@link deriveNestedTargetTokens} → {@link expandNestedTargets}）必须与**产出逐文件
 *      `test:summary`（带 `file`）的集合**一致且 `>0`，否则判红；
 *   ② 事件通道交叉校验：`run.channel` 必须完整（summary + tally）且与人类可读汇总逐字段一致，
 *      否则人类通道视为可伪造、判红（保留既有 `code`/`fail`/`cancelled`/`skipped`/`todo`/口径断言）；
 *   ③ 目标来源：helper 自身从调用参数推导（`--test` 后的位置参数，支持多文件 / 目录 / `<dir>/*<suffix>`
 *      glob，与顶层闸门展开口径一致）；**无法推导时**退回调用方显式声明 `opts.targets`，两者都没有则
 *      **抛错 fail-closed**（选「自动推导 + 显式声明兜底 + 无声明即拒绝」而非「静默跳过检查」，理由：
 *      不存在任何能绕过覆盖断言的静默路径；消费点无需为新检查逐个开关）。
 *  事件通道经 **`NODE_OPTIONS`** 注入 `--test-reporter=…test-reporter-events.mjs` +
 *  `--test-reporter-destination=<私有临时文件>`（argv / shell 两种形态统一生效，无需改写调用方命令行）。
 *
 * ── g-417 的两条收口（g-416 复核确认的 P2 残余；同一根因域）────────────────────────────────
 *  ① **选集开关在 helper 侧未 fail-closed**：`cleanTestEnv()` 保留 `NODE_OPTIONS`，而逐文件覆盖只看
 *     **文件级**完成事件 ⇒ **用例级**选集（`--test-only` / `--test-name-pattern` / `--test-skip-pattern`
 *     / `--test-shard`）可静默排除失败用例而文件照常完成、照样判绿（实测：1 通过 + 1 失败的文件在
 *     `NODE_OPTIONS=--test-only` 下得 `tests 1 / pass 1 / fail 0`，被排除者**不计 skipped 也不计 fail**）。
 *     现由 {@link assertNoNestedTestSelection} 在**入口**（`capture` 内、spawn 之前）检测**生效**
 *     `NODE_OPTIONS`（= `process.env` 与 `opts.env` 合并后的值，与子进程实际拿到的一致），命中即**抛错
 *     拒绝执行**并**点名开关** —— 与自证闸门同口径（复用 {@link findTestSelectionOption} /
 *     {@link TEST_SELECTION_OPTION_NAMES}，不另立第二套口径）；`--no-warnings` /
 *     `--max-old-space-size=…` 等不改变选中集合的合法项照常放行。
 *  ② **含空格 `TMPDIR` 误红**：`NODE_OPTIONS` 由 Node 按空白切分，未加引号的含空格通道路径被切成两段
 *     ⇒ 通道文件写到被截断的前缀、读不到 ⇒ 覆盖断言判红（安全但**误红**）。现由
 *     {@link quoteNodeOptionsValue} 按 Node 的引号规则编码（双引号分组 + 转义 `\` 与 `"`；实测单引号
 *     不被识别、引号内 `\` 仍是转义符）⇒ 含空格（乃至 Windows 形态的反斜杠）路径下通道照常挂上。
 *
 * ── g-418 的两条收口（g-417 终局复核实测的 P1；均为**合法 API 误用即静默少跑**）──────────────
 *  ① **`opts.targets` 掩盖真实目标**：旧 `planNestedTargets` 形如 `opts.targets ?? deriveNestedTargetTokens(args)`
 *     ⇒ 只要声明非空就**不与 argv 实际集合比对**。实测 `runNestedArgv(node, ['--test', passA, reflectionExitB],
 *     {cwd, targets:[passA]})`（B = 注册失败断言后反射早退的夹具）得 `code 0 / targets [passA] / files [passA]
 *     / tests 2 / pass 2 / fail 0`，{@link nestedSuitePassProblems} 为空、{@link assertNestedSuitePassed}
 *     **接受** —— B 的失败断言从未执行。现由 {@link resolveNestedTargetPlan} 收口：**可推导时以推导集合为准**，
 *     声明必须与推导集合 realpath 归一后**精确一致**，否则抛错；**仅无法推导时**才允许使用声明。
 *  ② **`args` 内选集开关未拦**：g-417① 只查**生效 `NODE_OPTIONS`**，而 `runNestedArgv` 的 `args` 本身可携带
 *     用例级选集。实测 `runNestedArgv(node, ['--test','--test-name-pattern=vis', mix], {cwd})`（mix = 1 通过
 *     + 1 必失败）得 `code 0 / tests 1 / pass 1 / fail 0` 且目标文件**照常产出完成事件** ⇒ 覆盖断言看不出来、
 *     helper **接受**，失败用例被参数选集静默排除。现由 {@link nestedArgvTestSelectionProblem} /
 *     {@link assertNoNestedArgvTestSelection} 在**入口**（spawn 之前）拒绝并点名开关，复用 g-417 的
 *     {@link findTestSelectionOption} 同源 token 口径（`selectionOptionNameOfToken`），
 *     `--test-reporter` 等合法选项与文件路径不误拒。
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * 测试运行器注入到「测试文件进程」的环境变量。
 * 继承给孙进程会让嵌套 `node --test` 静默跳过全部文件（见文件头缺陷说明）。
 */
export const TEST_CONTEXT_VARS = ["NODE_TEST_CONTEXT", "NODE_TEST_WORKER_ID"] as const;

/**
 * g-415：`NODE_OPTIONS` 里会**改变「哪些文件/用例真的运行」**的开关（选集/分片类）。
 *
 * `cleanTestEnv()` 出于「不误伤合法用法」的考虑**保留** `NODE_OPTIONS`，于是这些开关会被原样
 * 继承给子 runner，让部分目标文件被**静默排除**而仍然 `exit 0`：
 *   - `--test-only`（配 `test.only`：只跑选集用例，其余静默不跑）；
 *   - `--test-name-pattern` / `--test-skip-pattern`（按名过滤 ⇒ 失败用例可被静默排除）；
 *   - `--test-shard`（只跑一个分片 ⇒ 其余文件静默不跑）。
 *
 * 自证闸门对四类一律 **fail-closed**（拒绝运行并 `exit≠0`），**不**采「清洗后再继续」：
 * 「清洗」要额外证明与用户显式选集**语义等价**，而「拒绝运行」不需要该论证，也不会误伤
 * 内存（`--max-old-space-size`）/告警（`--no-warnings`）/类型剥离等**不改变选中集合**的合法选项。
 */
export const TEST_SELECTION_OPTION_NAMES = [
  "--test-only",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-shard",
] as const;

/** 尽力按 shell 语义切分 `NODE_OPTIONS`（支持单/双引号与反斜杠转义）；切分不完美也不影响判定。 */
function splitNodeOptions(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && i + 1 < value.length) {
        current += value[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current !== "") tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

/**
 * 单个 token 是否为**选集/分片**开关（`--test-name-pattern=…` 归一为 `--test-name-pattern`）；
 * 不是则返回 `null`。**只有以 `-` 开头的 token 才当选项**（文件路径 / 独立取值不得误拒）。
 *
 * g-418②：这是「生效 `NODE_OPTIONS` 判定」与「传入子进程的 argv 判定」**共用**的唯一 token 级口径
 * （消费点分别见 {@link findTestSelectionOption} 与 {@link nestedArgvTestSelectionProblem}），
 * 保证两处不会各写一套、逐字漂移。
 */
function selectionOptionNameOfToken(token: string): string | null {
  if (!token.startsWith("-")) return null;
  const eq = token.indexOf("=");
  const name = eq === -1 ? token : token.slice(0, eq);
  return (TEST_SELECTION_OPTION_NAMES as readonly string[]).includes(name) ? name : null;
}

/**
 * 命中**选集/分片**开关时返回该开关名（`--test-name-pattern=…` 归一为 `--test-name-pattern`），
 * 否则返回 `null`。不改变选中集合的合法选项（内存/告警/类型剥离等）一律不受影响。
 */
export function findTestSelectionOption(nodeOptions: string | undefined | null): string | null {
  if (!nodeOptions) return null;
  for (const token of splitNodeOptions(nodeOptions)) {
    const name = selectionOptionNameOfToken(token);
    if (name !== null) return name;
  }
  return null;
}

/**
 * g-417①：嵌套运行**入口**的「生效 `NODE_OPTIONS` 选集」红因（复用 {@link findTestSelectionOption}）。
 * 命中四类选集/分片开关时返回**点名该开关**的红因文本，否则 `null`。
 *
 * 为什么必须在 helper 入口就拒绝（而不是只靠逐文件覆盖）：覆盖判据是**文件级**的，而
 * `--test-only` / `--test-name-pattern` / `--test-skip-pattern` 是**用例级**的 ——
 * 被它们排除的用例**既不计 `fail` 也不计 `skipped`**（实测「1 通过 + 1 失败」的文件在
 * `NODE_OPTIONS=--test-only` 下得 `tests 1 / pass 1 / fail 0`），文件照常产出完成事件 ⇒
 * 嵌套裁决可被环境**静默弱化**。与自证闸门同口径：**拒绝执行**，不采「清洗后继续」
 * （清洗要额外论证与用户显式选集语义等价，拒绝不需要）。
 */
export function nestedTestSelectionProblem(nodeOptions: string | undefined | null): string | null {
  const offending = findTestSelectionOption(nodeOptions);
  if (offending === null) return null;
  return (
    `NODE_OPTIONS 含测试选集/分片开关 ${offending}：嵌套子 runner 会继承它并**静默**改变「哪些用例/文件` +
    `真的跑」（用例级选集既不计 fail 也不计 skipped，逐文件完成事件照样产出 ⇒ 文件级覆盖断言看不出来）` +
    `⇒ fail-closed 拒绝嵌套执行；请从 NODE_OPTIONS 移除 ${offending}`
  );
}

/**
 * g-417①：入口守卫 —— 生效 `NODE_OPTIONS`（`process.env` 与 `opts.env` 合并后、即子进程真正拿到的值）
 * 命中选集/分片开关即抛错拒绝执行。**无 opt-out**：不存在「带着被弱化的选集继续跑」的静默路径。
 */
export function assertNoNestedTestSelection(nodeOptions: string | undefined | null, label: string): void {
  const problem = nestedTestSelectionProblem(nodeOptions);
  if (problem !== null) throw new Error(`${label}：${problem}`);
}

/**
 * g-418②：**实际传给子进程的 argv**（`runNestedArgv` 的 `args`；`runNestedCommand` 经 shell 语义
 * 切分出的等价 argv）里命中选集/分片开关时，返回**点名该开关**的红因文本，否则 `null`。
 *
 * 为什么入口必须**同时**拦 argv（不只拦生效 `NODE_OPTIONS`，g-417①）：`args` 本身就能携带用例级选集。
 * 实测 `runNestedArgv(node, ['--test','--test-name-pattern=vis', mix], {cwd})`（mix = 1 通过 + 1 必失败）
 * 得 `code 0 / tests 1 / pass 1 / fail 0`，且目标文件**照常产出完成事件** ⇒ 文件级覆盖断言看不出来，
 * helper 会**接受**（失败用例被参数选集静默排除）。
 *
 * 口径与 `NODE_OPTIONS` 判定**完全一致**：复用 {@link selectionOptionNameOfToken} /
 * {@link TEST_SELECTION_OPTION_NAMES}（`=值`、独立取值、多重空格等变体都归一为同一开关名）；
 * `--test-reporter` / `--test-reporter-destination` 等合法选项与文件路径（不以 `-` 开头）一律不受影响。
 * `--` 之后的 token 由 Node 视为**位置参数（目标文件）**，因此与 {@link deriveNestedTargetTokens}
 * 同口径地停止扫描（不把「文件名叫 `--test-only`」这种路径误判为开关）。
 */
export function nestedArgvTestSelectionProblem(argv: readonly string[]): string | null {
  for (const token of argv) {
    if (token === "--") break;
    const offending = selectionOptionNameOfToken(token);
    if (offending !== null) {
      return (
        `参数（argv）含测试选集/分片开关 ${offending}：嵌套子 runner 会按它**静默**改变「哪些用例/文件` +
        `真的跑」（用例级选集既不计 fail 也不计 skipped，逐文件完成事件照样产出 ⇒ 文件级覆盖断言看不出来）` +
        `⇒ fail-closed 拒绝嵌套执行；请从传给子进程的参数中移除 ${offending}`
      );
    }
  }
  return null;
}

/** g-418②：入口守卫 —— 传给子进程的 argv 命中选集/分片开关即抛错拒绝（**无 opt-out**）。 */
export function assertNoNestedArgvTestSelection(argv: readonly string[], label: string): void {
  const problem = nestedArgvTestSelectionProblem(argv);
  if (problem !== null) throw new Error(`${label}：${problem}`);
}

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
  /**
   * g-415：**逐文件完成事件** —— `test:summary` 携带 `file` 的那些路径（全局汇总不带 `file`，不计入）。
   * 闸门据此断言「glob/入参匹配到的文件集合」与「真正产出完成事件的文件集合」一致，
   * 从而关闭 `--test-shard` / `--test-name-pattern` / 测试内 `process.exit(0)` 早退等**静默少跑**：
   * 被排除或中途早退的文件**根本不会**产出这条带 `file` 的汇总。
   */
  files: string[];
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
  const files: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let record: { type?: unknown; counts?: unknown; file?: unknown };
    try {
      record = JSON.parse(line) as { type?: unknown; counts?: unknown; file?: unknown };
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
      // g-415：只收**带 file** 的逐文件完成事件（全局汇总不带 file ⇒ 不能充当任何文件的完成证据）。
      if (typeof record.file === "string" && record.file !== "") files.push(record.file);
      summary = summaryFromCounts(counts as Record<string, unknown>); // 逐条覆盖 ⇒ 留下最后（全局）一条
    } else if (record.type === "tally") {
      tally = summaryFromCounts(counts as Record<string, unknown>);
    } else {
      badLines += 1;
    }
  }
  return { summary, tally, summaries, files, badLines };
}

/** g-416：`node --test` 中**独立取值**（`--opt value`）的选项名 —— 其后的 token 不是目标文件。 */
export const VALUE_TAKING_TEST_OPTIONS = new Set([
  "--test-reporter",
  "--test-reporter-destination",
  "--test-concurrency",
  "--test-name-pattern",
  "--test-skip-pattern",
  "--test-shard",
  "--test-timeout",
  "--test-rerun-failures",
]);

/** 与顶层闸门 `scripts/run-tests.mjs` 同口径：只有 `<dir>/*<suffix>` 形态的 glob 被支持。 */
function expandNestedGlob(glob: string, cwd: string): string[] {
  const m = /^([^*]+)\/(\*[^/]*)$/.exec(glob);
  if (!m) {
    throw new Error(
      `nested-runner：不支持的 glob 形态（与顶层闸门同口径，只支持 <dir>/*<suffix>）：${glob} ⇒ fail-closed`,
    );
  }
  const [, dir, pattern] = m;
  const suffix = pattern.slice(1);
  const absDir = resolve(cwd, dir);
  return readdirSync(absDir)
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => join(absDir, name));
}

/** 与顶层闸门同口径：目录型目标递归展开为 `*.test.<ext>`（避免把非测试文件当目标）。 */
const NESTED_TEST_FILE_RE = /\.test\.(?:ts|mts|cts|js|mjs|cjs)$/;
function expandNestedDir(absDir: string): string[] {
  return readdirSync(absDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && NESTED_TEST_FILE_RE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** 归一化路径：存在则取 realpath（与事件通道里的 `file` 同口径比较），否则退回绝对路径。 */
function nestedNormPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * 把目标 token 展开成**具体测试文件集合**（绝对 + realpath 归一），与顶层闸门
 * `scripts/run-tests.mjs` 的展开口径一致：目录 ⇒ 递归 `*.test.*`；glob ⇒ 仅 `<dir>/*<suffix>`。
 * 展开为空一律抛错（fail-closed），不返回空集合让调用方「看起来没事」。
 */
export function expandNestedTargets(tokens: readonly string[], cwd: string): string[] {
  const files: string[] = [];
  for (const token of tokens) {
    if (/[*?[\]]/.test(token)) {
      files.push(...expandNestedGlob(token, cwd));
      continue;
    }
    const abs = resolve(cwd, token);
    if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) files.push(...expandNestedDir(abs));
    else files.push(abs);
  }
  const unique = [...new Set(files.map(nestedNormPath))];
  if (unique.length === 0) {
    throw new Error(
      `nested-runner：目标展开后为空（tokens=${tokens.join(" ")}；cwd=${cwd}）⇒ 无法断言逐文件完成事件，fail-closed`,
    );
  }
  return unique;
}

/**
 * 从 argv / 命令行 token 里推导 `node --test` 的**目标文件 token**（不含选项）。
 * 返回 `null` ⇒ 不是 `--test` 形态或走默认文件发现（此时需调用方显式声明 `opts.targets`）。
 */
export function deriveNestedTargetTokens(args: readonly string[]): string[] | null {
  const testIndex = args.indexOf("--test");
  if (testIndex === -1) return null;
  const tokens: string[] = [];
  for (let i = testIndex + 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--") {
      tokens.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith("-")) {
      if (!arg.includes("=") && VALUE_TAKING_TEST_OPTIONS.has(arg)) i += 1; // 跳过其独立取值
      continue;
    }
    tokens.push(arg);
  }
  return tokens;
}

/** 私有的干净事件通道 reporter（与闸门同一实现：NDJSON 带类型事件，测试输出伪造不进来）。 */
const EVENTS_REPORTER_URL = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "scripts", "test-reporter-events.mjs"),
).href;

/**
 * g-417②：按 Node 对 `NODE_OPTIONS` 的**引号规则**编码单个参数值。
 *
 * Node 的分词器按空白切分、并识别**双引号**分组（实测：单引号**不**被识别，会被原样当成路径字符）；
 * 双引号内 `\` 仍是转义符（实测 `"/a\b/c"` 会解析成 `/ab/c`）。故规则 = 双引号包裹 +
 * 把 `\` → `\\`、`"` → `\"`：
 *   - 含空格路径：不编码会被切成两段（通道路径被截断）⇒ 覆盖断言误红；
 *   - Windows 形态路径（`C:\Users\…`）：只加引号不转义反斜杠会把分隔符吞掉 ⇒ 同样误红。
 */
function quoteNodeOptionsValue(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/**
 * 为一次嵌套运行开一条**私有**事件通道：经 `NODE_OPTIONS` 注入 reporter（argv / shell 两形态统一生效，
 * 无需改写调用方命令行），通道文件落在系统临时目录（不写仓库、不参与任何 glob），运行结束即删。
 *
 * 必须**同时**注入 `spec → stdout`：一旦显式给出 `--test-reporter`，node 就不再挂默认 reporter，
 * 调用方在 `run.out` 上的人类可读输出（g-353/g-407 的断言对象）会被整个抹掉。
 */
function openEventChannel(env: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; eventsPath: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-nested-runner-"));
  const eventsPath = join(dir, "events.ndjson");
  const injected =
    `--test-reporter=spec --test-reporter-destination=stdout ` +
    `--test-reporter=${EVENTS_REPORTER_URL} ` +
    `--test-reporter-destination=${quoteNodeOptionsValue(eventsPath)}`;
  const inherited = env.NODE_OPTIONS?.trim();
  return {
    env: { ...env, NODE_OPTIONS: inherited ? `${inherited} ${injected}` : injected },
    eventsPath,
    close: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* 清理失败不影响判定结果 */
      }
    },
  };
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
  /** 子进程 cwd（把事件通道里的 `file` 归一化时用；g-416）。 */
  cwd: string;
  /** 本次嵌套运行的**目标文件集合**（绝对 + realpath 归一；g-416）。 */
  targets: string[];
  /** 私有**干净事件通道**的读取结果（逐文件完成事件 + 权威计数；g-416）。 */
  channel: EventChannelReading;
}

export interface NestedRunOptions {
  cwd: string;
  /** 附加环境变量（注入变量仍会被摘除）。 */
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  /**
   * g-416：**显式声明**本次嵌套运行的目标文件（相对 `cwd` 或绝对；支持多文件 / 目录 / `<dir>/*<suffix>`）。
   *
   * g-418①（语义收紧）：**仅在 helper 无法从参数推导目标时**（走默认文件发现、或命令形态非 `node --test`）
   * 才被采用；**`args` 可推导时必须以推导集合为准**，此时若同时声明本项，必须与推导集合**精确一致**
   * （realpath 归一后集合相等），否则**抛错拒绝执行**（声明子集不得掩盖真实目标）。
   * 两者都没有 ⇒ helper 抛错 fail-closed（不存在「跳过覆盖断言」的静默路径）。
   */
  targets?: string[];
}

function finish(
  code: number | null,
  out: string,
  err: string,
  command: string,
  cwd: string,
  targets: string[],
  channel: EventChannelReading,
): NestedRunResult {
  return { code, out, err, command, cwd, targets, channel, summary: parseTestSummary(out, err) };
}

function capture(
  file: string,
  args: string[],
  opts: NestedRunOptions,
  command: string,
  targets: string[],
): Promise<NestedRunResult> {
  const baseEnv = cleanTestEnv(opts.env);
  // g-417①：入口 fail-closed —— 生效 NODE_OPTIONS 含选集/分片开关就拒绝执行（不做「清洗后继续」）。
  assertNoNestedTestSelection(baseEnv.NODE_OPTIONS, `嵌套运行入口（${command}）`);
  const events = openEventChannel(baseEnv);
  return new Promise((resolveRun, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: events.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: opts.timeout,
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk) => (out += String(chunk)));
    child.stderr?.on("data", (chunk) => (err += String(chunk)));
    child.on("error", (e) => {
      events.close();
      reject(e);
    });
    child.on("close", (code) => {
      let eventsText = "";
      try {
        eventsText = readFileSync(events.eventsPath, "utf8");
      } catch {
        eventsText = ""; // 通道文件缺失 = 通道未完成 ⇒ 覆盖断言据此判红
      }
      events.close();
      resolveRun(finish(code, out, err, command, opts.cwd, targets, parseEventChannel(eventsText)));
    });
  });
}

/**
 * g-418①：realpath 归一的**集合相等**（{@link expandNestedTargets} 已去重；顺序无关，元素必须逐一对应）。
 * 声明集合与推导集合的比对与既有覆盖判据**同一口径**（`nestedNormPath` ⇒ realpath）。
 */
function sameNestedTargetSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((entry) => set.has(entry));
}

/**
 * g-418①：目标集合的**唯一裁决**（`opts.targets` 语义收紧）——
 *   ① **可推导时必须以推导集合为准**，显式声明只能与推导集合**精确一致**（realpath 归一）；
 *      不一致 ⇒ **抛错拒绝执行**（不得静默取其一，否则声明子集可掩盖真实目标、让早退目标不被覆盖）；
 *   ② **仅无法推导时**才允许使用声明集合（该集合仍受逐目标完成事件覆盖约束）；
 *   ③ 两者皆无 ⇒ 抛错（不存在「跳过覆盖断言」的静默路径）。
 */
function resolveNestedTargetPlan(
  derived: string[] | null,
  declared: string[] | null,
  source: string,
  cwd: string,
): string[] {
  if (derived === null && declared === null) {
    throw new Error(
      `${source}：无法推导嵌套运行的目标文件（未给 --test 目标 / 走默认文件发现），调用方也未显式声明 ` +
        `opts.targets ⇒ fail-closed 拒绝执行。请显式传 opts.targets（相对 cwd 或绝对；支持多文件、目录、` +
        `<dir>/*<suffix>）。`,
    );
  }
  if (derived === null) return declared as string[];
  if (declared === null) return derived;
  if (!sameNestedTargetSet(derived, declared)) {
    const show = (files: readonly string[]): string => {
      const shown = files.slice(0, 5).map((f) => relative(cwd, f));
      return `${shown.join("、")}${files.length > 5 ? ` …(+${files.length - 5})` : ""}`;
    };
    throw new Error(
      `${source}：显式声明的 opts.targets 与从参数**推导**出的目标集合不一致（realpath 归一后集合不相等）` +
        `⇒ fail-closed 拒绝执行：可推导时必须以推导集合为准，声明不得掩盖真实目标。` +
        `推导集合 ${derived.length} 个 [${show(derived)}]；声明集合 ${declared.length} 个 [${show(declared)}]。`,
    );
  }
  return derived;
}

/**
 * 目标推导的统一出口：**推导优先** → 一致声明只作校验 → 无法推导时才用声明 → 不一致 / 两者皆无则抛错
 * （fail-closed，无 opt-out）。入口先拦 argv 选集/分片开关（g-418②），全部发生在 spawn 之前。
 */
function planNestedTargets(args: readonly string[], opts: NestedRunOptions, source: string): string[] {
  // g-418②：**spawn 之前**拦 argv（argv 形态即 `args`；shell 形态为 shell 语义切分出的等价 argv）。
  assertNoNestedArgvTestSelection(args, source);

  // g-418①：可推导 ⇒ 采用**推导集合**；`opts.targets` 只在与之一致时被校验，仅无法推导时才被采用。
  const derivedTokens = deriveNestedTargetTokens(args);
  const derived =
    derivedTokens !== null && derivedTokens.length > 0 ? expandNestedTargets(derivedTokens, opts.cwd) : null;
  const declared =
    opts.targets !== undefined && opts.targets.length > 0 ? expandNestedTargets(opts.targets, opts.cwd) : null;

  return resolveNestedTargetPlan(derived, declared, source, opts.cwd);
}

/**
 * 跑一条**嵌套测试**命令（shell 形态，供 `package.json` 里取到的脚本文本直接用）。
 * env 一律经 {@link cleanTestEnv} 清洗；生效 `NODE_OPTIONS` 命中选择集/分片开关则**抛错拒绝执行**
 * （{@link assertNoNestedTestSelection}，g-417①）；**shell 语义切分出的等价 argv** 命中选集/分片开关
 * 同样在 spawn 前抛错拒绝（{@link assertNoNestedArgvTestSelection}，g-418②）；目标不一致 / 无法推导同样抛错
 * （g-418① / g-416）。
 */
export function runNestedCommand(cmd: string, opts: NestedRunOptions): Promise<NestedRunResult> {
  const targets = planNestedTargets(splitNodeOptions(cmd), opts, `runNestedCommand(${cmd})`);
  return capture("bash", ["-c", cmd], opts, cmd, targets);
}

/**
 * 跑一个**嵌套测试**进程（argv 形态，跨平台；`node --test …` 的推荐入口）。
 * env 一律经 {@link cleanTestEnv} 清洗；生效 `NODE_OPTIONS` 命中选择集/分片开关则**抛错拒绝执行**
 * （{@link assertNoNestedTestSelection}，g-417①）；`args` 命中选集/分片开关同样在 spawn 前抛错拒绝
 * （{@link assertNoNestedArgvTestSelection}，g-418②）；目标不一致 / 无法推导同样抛错（g-418① / g-416）。
 */
export function runNestedArgv(
  file: string,
  args: string[],
  opts: NestedRunOptions,
): Promise<NestedRunResult> {
  const targets = planNestedTargets(args, opts, `runNestedArgv(${file} ${args.join(" ")})`);
  return capture(file, args, opts, `${file} ${args.join(" ")}`, targets);
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
 * 判据：**退出码 0** 且 `cancelled === 0` 且 `fail === 0` 且 `skipped === 0` 且 `todo === 0`
 * （`tests > 0` 由 {@link assertNestedSuiteRan} 保证）。
 *
 * 为什么 `cancelled` 必须单列：`node --test` 把被取消（如 timeout）的用例计入 `cancelled` 而**不是** `fail`，
 * 只看 `fail === 0` 会把它放行（g-413 P1-1 的 false-green 洞）。
 *
 * 为什么 `todo` 必须单列（g-415）：`test.todo('x')` / `test('x',{todo:true},…)` 产出
 * `tests 1 / pass 0 / fail 0 / cancelled 0 / skipped 0 / todo 1` 且 **exit 0** —— 旧的
 * `fail/cancelled/skipped` 三判全部放行，于是「零个真实验证」被当成「全绿」。待办**不是**验证。
 *
 * 与 {@link assertNestedSuitePassed} **共用同一实现**：闸门需要把交叉校验红因与这些不达标项
 * 一次性打全，故单独暴露非抛错形态，避免两处各写一份判据。
 *
 * ── g-416 追加（**只增不减**，全部 fail-closed、无 opt-out）──────────────────────────────
 *  ⑥ 事件通道交叉校验：`run.channel` 必须完整（有 runner 汇总 + 逐事件计数），且与人类可读汇总
 *     逐字段一致；人类可读通道混有测试自己的 `console.log`（可打印伪造的 `ℹ tests 1`），不可单独采信；
 *  ⑦ **逐目标文件完成事件覆盖**（{@link nestedTargetCoverageProblems}）：目标文件集合 ≡ 产出
 *     逐文件 `test:summary`（带 `file`）的集合且 `>0`，否则判红 —— 关闭「注册用例后反射/直接早退」
 *     这类「断言未执行却局部判绿」（P2-3 此前只落在闸门，被 helper 消费的嵌套套件仍可绕过）。
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
  if (s.todo > 0) problems.push(`有**待办**用例（todo=${s.todo}）——待办不是验证，不得判绿`);
  const channel = run.channel;
  if (!channel || !channel.summary || !channel.tally) {
    problems.push(
      "干净事件通道不完整（缺 runner 汇总或逐事件计数）⇒ 人类可读汇总可被测试打印伪造，计数不可信，fail-closed 判红",
    );
  } else {
    for (const field of CROSS_CHECK_FIELDS) {
      if (channel.summary[field] !== s[field]) {
        problems.push(
          `人类可读汇总与事件通道不一致：${field} ${s[field]} ≠ ${channel.summary[field]}（人类通道可能被伪造）`,
        );
      }
    }
  }
  problems.push(...nestedTargetCoverageProblems(run.targets, channel, run.cwd));
  return problems;
}

/** 人类可读汇总与事件通道必须逐字段一致的计数字段（`suites` 不在内：`describe` 聚合口径不同，g-415 已单独校验）。 */
const CROSS_CHECK_FIELDS = ["tests", "pass", "fail", "cancelled", "skipped", "todo"] as const;

/**
 * g-416：**逐目标文件完成事件覆盖**的判据（非抛错形态；空数组 = 覆盖成立）。
 *
 * 判据：`targets`（helper 从调用参数推导 / 调用方显式声明）**非空**，且其中每个文件都出现在
 * 事件通道的**逐文件完成事件**（带 `file` 的 `test:summary`）里。
 * 为什么用「逐文件汇总」而不是文件级 `test:pass`：后者在测试内提前退出时**仍会发出**，
 * 无法区分「跑完」与「刚注册就退出」；被排除/中途早退的文件**不会**产出逐文件汇总。
 *
 * fail-closed：目标集合为空（无法推导且未声明）同样判红 —— 不存在跳过该检查的静默路径。
 */
export function nestedTargetCoverageProblems(
  targets: readonly string[] | null | undefined,
  channel: EventChannelReading | null | undefined,
  cwd: string,
): string[] {
  const problems: string[] = [];
  if (!targets || targets.length === 0) {
    problems.push(
      "无法确定嵌套运行的目标文件集合（helper 未能从参数推导，调用方也未显式声明 targets）⇒ 无法证明跑全，fail-closed 判红",
    );
    return problems;
  }
  const completed = new Set((channel?.files ?? []).map((f) => nestedNormPath(resolve(cwd, f))));
  const missing = targets.map(nestedNormPath).filter((t) => !completed.has(t));
  if (missing.length === 0) return problems;
  const shown = missing.slice(0, 5).map((f) => relative(cwd, f)).join("、");
  problems.push(
    `目标文件未产出完成事件（被选集/分片静默排除，或测试内提前退出）${missing.length}/${targets.length} 个` +
      `${completed.size === 0 ? "（事件通道里一条逐文件完成事件都没有：未挂干净 reporter 或测试内提前退出）" : ""}` +
      `：${shown}${missing.length > 5 ? " …" : ""}`,
  );
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
