#!/usr/bin/env node
/**
 * scripts/run-tests.mjs —— 「整套件真的跑了」的**自证闸门**（g-350，源自 g-407 R1；g-413 加固）。
 *
 * 缺陷 A（g-407 R1，执行者与复核者独立复现）：
 *   NODE_TEST_CONTEXT=child-v8 node --test core/tests/*.test.ts
 * 以**顶层注入**形态启动整套件时，`node --test` 打印 `skipping running files`、
 * **不加载任何测试文件**、零汇总输出并 `exit 0`。此时仓内不存在任何可自检的位置
 * （根本没有测试文件被加载）⇒「全套绿」可能是假的（false green）。
 *
 * 缺陷 B（g-413 P1-1，终局只读复核）：旧版收尾只断言 `tests>0 && fail===0 && skipped===0`，
 * **不看子进程退出码、也不看 `cancelled`** ⇒ 被取消的用例（`{timeout:1}` 内 promise 永不 resolve）
 * 计入 `cancelled` 而非 `fail`，闸门会打印 `✔ 自证通过` 并 `exit 0`（原始 `node --test` 退出非零）。
 *
 * 缺陷 C（g-413 P1-2，同一根因域）：旧版从**人类可读汇总**里数数，而测试自己的 `console.log`
 * 与 runner 汇总混在同一条 stdout 上（测试打印一行 `ℹ tests 1` 即可让 wrapper 读到更乐观的计数）。
 *
 * 本闸门是**跨平台**（纯 Node，不依赖 `env -u`、不依赖 shell 展开 glob）的统一入口：
 *   ① 自己展开测试文件清单（Windows cmd / PowerShell 下 `*.test.ts` 不会被 shell 展开）；
 *   ② 派生 runner 前经 `core/tests/fixtures/nested-runner.ts` 的 `cleanTestEnv()` 摘除
 *      `NODE_TEST_CONTEXT` / `NODE_TEST_WORKER_ID`（全仓唯一实现，不各写一份）；
 *   ③ 起 runner 时挂两条 reporter：`spec`→stdout（人类可读，观感不变，**不用于判定**）与
 *      `scripts/test-reporter-events.mjs`→私有文件（**带类型事件**的干净计数通道；测试的
 *      `console.log` 走 `test:stdout`，伪造不出 `test:summary`/`test:pass`/`test:fail`）；
 *   ④ **三方交叉校验**：事件通道里的 runner 汇总 ≡ reporter 逐事件累加 ≡ 人类可读末尾汇总；
 *   ⑤ 退出码 0 ⇔「退出码 0 且 tests>0 且 fail==0 且 skipped==0 且 cancelled==0 且计数口径自洽」，
 *      失败时打印**逐项可读红因**，成功时把汇总回显在 stdout。
 *
 * 为什么选本方案（取舍说明）：
 *   - 「测试引导处断言 `NODE_TEST_CONTEXT` 未设置」对**顶层注入**无效：注入已经发生，
 *     且没有任何测试文件被加载，断言无处执行（对「测试内再启动」形态仍由 g-407 覆盖）；
 *   - 「把文档命令整体换成统一入口」会与大量把 `node --test core/tests/*.test.ts` 当字面锚的
 *     守卫（g-335 / g-407 / 指南）分叉；本闸门**不改**既有文档命令，只在其之上叠加可自证入口，
 *     并以 `TEST_GLOB` 常量与文档共享同一字面量（守卫测试钉住，见 core/tests/g350-test-hygiene.test.ts）；
 *   - 计数**不**依赖人类可读文本（那是可伪造通道）：`node` 没有内建 json reporter（v26 仅有
 *     spec/tap/dot/junit/lcov），故自带一个只转发带类型事件的最小 reporter（本地无外部依赖）。
 *
 * 用法：node scripts/run-tests.mjs [测试文件…]     （缺省 = TEST_GLOB）
 *
 * ── g-415 的五条补洞（终局复核在 tip `0a130d0` 上实测仍可判绿）──────────────────────────
 *  ① `todo` 漏门禁：`test.todo('x')` / `test('x',{todo:true},…)` ⇒ `tests 1 / todo 1 / pass 0` 仍报
 *     `✔ 自证通过` 且 `exit 0`。现由 {@link nestedSuitePassProblems} 补 `todo === 0`。
 *  ② `NODE_OPTIONS` 选集旁路：`--test-only`（配 `.only`）/`--test-name-pattern`/`--test-skip-pattern`/
 *     `--test-shard` 被 `cleanTestEnv()` 原样继承 ⇒ 失败文件被静默排除而 `exit 0`。现 **fail-closed 拒绝运行**。
 *  ③ 目标文件覆盖：事件通道现转发逐文件 `test:summary` 的 `file`，闸门断言「匹配到的文件集合」
 *     ≡ 「真正产出完成事件的文件集合」⇒ 关闭 shard/pattern/测试内 `process.exit(0)` 早退等**静默少跑**。
 *  ④ 结构守卫（在 `core/tests/g415-gate-hardening.test.ts`）：禁止 `core/tests/*.test.ts`（被收集集合）
 *     出现选集式 `.only` 与直接 `process.exit(` / `process.exitCode`。
 *  ⑤ **管道截断**：旧版 `process.stdout.write(bigOut)` 后立即 `process.exit(0)` ⇒ 未 flush 的管道缓冲被丢弃
 *     （实测 exit 0、stdout 恰 64 KiB、自证行不可见）。现全部收尾只设 `process.exitCode`、**不调 `process.exit`**
 *     （仅极小的同步早退消息经 `writeSync(2, …)` 后退出），让运行时自然 flush 再收尾。
 *
 * ── g-416：覆盖判据下沉到**共享 helper**（同一根因域：闸门可被判绿而未真正跑全）──────────────
 *  `nestedSuitePassProblems`（被本闸门与全部嵌套消费点共用）现**自身**核对「目标文件集合 ≡ 逐文件
 *  完成事件集合且 >0」并与事件通道交叉校验；本闸门把已算好的 `targets`/`channel`/`cwd` 挂到 `run` 上，
 *  其自身的 {@link coverageProblems} 调用点**保留**（只增不减，双保险）。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 文档里那一条命令的 glob：与 AGENTS.md / 指南共用同一字面量，避免入口分叉。 */
export const TEST_GLOB = "core/tests/*.test.ts";

// 唯一实现复用：绝不在此另写一份注入变量摘除（`NODE_TEST_CONTEXT` 的清理只能来自该 helper，g-407 判据 2）。
const {
  cleanTestEnv,
  parseTestSummary,
  parseEventChannel,
  assertNestedSuiteRan,
  nestedSuitePassProblems,
  findTestSelectionOption,
} = await import(pathToFileURL(join(repoRoot, "core/tests/fixtures/nested-runner.ts")).href);

/** 干净计数通道的 reporter（NDJSON 带类型事件；唯一实现见该文件头）。 */
const eventsReporter = pathToFileURL(join(repoRoot, "scripts/test-reporter-events.mjs")).href;

/** 只支持 `<dir>/*<suffix>` 形态（本仓唯一用到的形态）；其余形态显式报错，不静默判绿。 */
function expandGlob(glob) {
  const m = /^([^*]+)\/(\*[^/]*)$/.exec(glob);
  if (!m) throw new Error(`不支持的 glob 形态（只支持 <dir>/*<suffix>）：${glob}`);
  const [, dir, pattern] = m;
  const suffix = pattern.slice(1);
  return readdirSync(join(repoRoot, dir))
    .filter((name) => name.endsWith(suffix))
    .sort()
    .map((name) => `${dir}/${name}`);
}

/**
 * g-415：极小的**同步**早退消息 —— `writeSync(2, …)` 写 fd 之后 `process.exit` 不会丢字节。
 * 大输出（子 runner 的 stdout/stderr）**绝不**走这条路径，见下面 `close` 收尾只设 `process.exitCode`。
 */
function exitNow(message, code) {
  writeSync(2, `${message}\n`);
  process.exit(code);
}

/** 归一化路径：存在则取 realpath（消解 macOS `/tmp` 等符号链接差异），否则退回绝对路径。 */
function normPath(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** 目录型入参展开为 node 会运行的测试文件（本仓测试均为 `*.test.<ext>`），否则无法做逐文件覆盖断言。 */
const TEST_FILE_RE = /\.test\.(?:ts|mts|cts|js|mjs|cjs)$/;
function expandDir(absDir) {
  return readdirSync(absDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && TEST_FILE_RE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/**
 * g-415 判据③：**目标文件覆盖** —— 「glob/入参匹配到的文件集合」必须与「真正产出完成事件的文件集合」
 * （事件通道里带 `file` 的 `test:summary`）**一致**，且文件数 > 0。
 *
 * 完成事件用的是**逐文件汇总**（不是文件级 `test:pass`/`test:complete`：那两者在测试内
 * `process.exit(0)` 早退时**仍会发出**，无法区分「跑完」与「刚注册就退出」）。被 shard/pattern 排除、
 * 或中途早退的文件**不会**产出逐文件汇总 ⇒ 必然在这里报红。
 */
function coverageProblems(targetFiles, channel) {
  const problems = [];
  if (targetFiles.length === 0) {
    problems.push("未匹配到任何目标文件（glob/入参展开为空）⇒ 不得判绿");
    return problems;
  }
  const completed = new Set((channel.files ?? []).map((f) => normPath(resolve(repoRoot, f))));
  const missing = targetFiles.filter((f) => !completed.has(f));
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).map((f) => relative(repoRoot, f)).join("、");
    problems.push(
      `目标文件未产出完成事件（被选集/分片静默排除，或测试内提前退出）` +
        `${missing.length}/${targetFiles.length} 个：${shown}${missing.length > 5 ? " …" : ""}`,
    );
  }
  return problems;
}

const argv = process.argv.slice(2);
const targets = argv.length > 0 ? argv : expandGlob(TEST_GLOB);
if (targets.length === 0) {
  exitNow(`[run-tests] 未展开到任何测试文件（glob=${TEST_GLOB}）⇒ 不得判绿`, 2);
}

// ── g-415 判据②：NODE_OPTIONS 含测试选集/分片开关 ⇒ fail-closed（拒绝运行，绝不静默少跑）──────
const selectionOffender = findTestSelectionOption(process.env.NODE_OPTIONS);
if (selectionOffender) {
  exitNow(
    `[run-tests] ✖ 自证失败：NODE_OPTIONS 含测试选集/分片开关 ${selectionOffender} ⇒ ` +
      `它会让部分目标文件/用例被静默排除，闸门无法自证「跑全」；fail-closed 拒绝运行` +
      `（请从 NODE_OPTIONS 移除该开关；内存/告警/类型剥离等不改变选中集合的合法选项不受影响）`,
    1,
  );
}

// 目录入参展开成具体文件（并把基准目录固定为 repoRoot）⇒ 覆盖断言有确定的「匹配集合」可比。
const spawnTargets = [];
for (const t of targets) {
  const abs = resolve(repoRoot, t);
  if (statSync(abs, { throwIfNoEntry: false })?.isDirectory()) spawnTargets.push(...expandDir(abs));
  else spawnTargets.push(t);
}
if (spawnTargets.length === 0) {
  exitNow(`[run-tests] 目标展开后没有任何测试文件（glob=${TEST_GLOB}）⇒ 不得判绿`, 2);
}
const targetFiles = [...new Set(spawnTargets.map((t) => normPath(resolve(repoRoot, t))))];

const started = Date.now();
// 私有计数通道落在外面的临时目录：不写仓库、不参与 glob、不留给下一次运行。
const channelDir = mkdtempSync(join(tmpdir(), "dsh-graph-run-tests-"));
const eventsPath = join(channelDir, "events.ndjson");
const dropChannel = () => {
  try {
    rmSync(channelDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判定结果 */
  }
};

const child = spawn(
  process.execPath,
  [
    "--test",
    // 人类可读通道：与 `node --test core/tests/*.test.ts` 同样的观感（仅供阅读，不用于判定）。
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    // 干净计数通道（判定只认它）：带类型事件，测试输出无法伪造。
    `--test-reporter=${eventsReporter}`,
    `--test-reporter-destination=${eventsPath}`,
    ...spawnTargets,
  ],
  {
    cwd: repoRoot,
    env: cleanTestEnv(), // ← 自证的前提：注入变量在此被摘除（唯一实现）
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let out = "";
let err = "";
let finished = false;
child.stdout.on("data", (chunk) => { out += chunk; });
child.stderr.on("data", (chunk) => { err += chunk; });
child.on("error", (e) => {
  if (finished) return;
  finished = true;
  dropChannel();
  console.error(`[run-tests] 无法启动测试 runner：${e?.message ?? e}`);
  process.exitCode = 2; // g-415：不调 process.exit，让缓冲自然 flush
});

/** 需要逐字段对齐的计数字段（含 `suites`：`describe` 聚合事件必须与 runner 汇总一致，见 reporter 的 tally）。 */
const COUNT_FIELDS = ["tests", "suites", "pass", "fail", "cancelled", "skipped", "todo"];

/**
 * 三方交叉校验（事件汇总 / 逐事件累加 / 人类可读末尾汇总），返回**全部**不一致项（空数组 = 一致）。
 * 只报告、不抛错：调用方把红因一次性打全，便于定位是哪一条通道出问题。
 */
function crossCheckProblems({ summary, tally, human, code, summaries, badLines }) {
  const problems = [];
  if (badLines > 0) {
    problems.push(`事件通道有 ${badLines} 行无法解析或类型未知 ⇒ 通道损坏，计数不可信`);
  }
  if (summaries === 0) {
    problems.push("事件通道没有任何 runner 汇总（未加载用例 / runner 未跑完）");
  }
  if (!tally) {
    problems.push("事件通道没有逐事件计数（tally）⇒ runner 未正常收尾（疑似被信号终止）");
  }
  const compare = (other, name) => {
    if (!summary || !other) return;
    for (const field of COUNT_FIELDS) {
      if (summary[field] !== other[field]) {
        problems.push(`${name}与事件汇总不一致：${field} ${other[field]} ≠ ${summary[field]}`);
      }
    }
  };
  compare(tally, "逐事件计数");
  compare(human, "人类可读汇总");
  if (human.summaryBlocks > 1) {
    problems.push(
      `人类可读通道含 ${human.summaryBlocks} 个汇总块（不唯一）⇒ 其中可能有测试打印的伪造行，判定只认事件通道`,
    );
  }
  if (summary && code === 0 && (summary.fail > 0 || summary.cancelled > 0)) {
    problems.push(`退出码 0 却报告 fail=${summary.fail} / cancelled=${summary.cancelled}（退出码与计数互相矛盾）`);
  }
  return problems;
}

child.on("close", (code, signal) => {
  if (finished) return;
  finished = true;
  // g-415 P1-⑥：这里**只写流、不 process.exit** —— 出口统一设 `process.exitCode`，由运行时把
  // 未 flush 的管道缓冲写完后自然收尾（旧版 write 后立刻 exit(0) 会把大输出截在 64 KiB）。
  process.stdout.write(out);
  process.stderr.write(err);

  let eventsText = "";
  try {
    eventsText = readFileSync(eventsPath, "utf8");
  } catch {
    eventsText = ""; // 通道文件缺失 = 通道未完成，下面按「没有逐事件计数」判红
  }
  const channel = parseEventChannel(eventsText);
  const human = parseTestSummary(out, err);
  // 权威摘要优先取干净事件通道；通道缺失时退回人类可读摘要，好让 assertNestedSuiteRan 给出可读红因。
  const run = {
    code,
    signal,
    out,
    err,
    summary: channel.summary ?? human,
    command: `${process.execPath} --test ${spawnTargets.join(" ")}`,
    // g-416：共享 helper 的判据现要求「目标文件集合 ≡ 逐文件完成事件集合」与事件通道交叉校验，
    // 故把闸门已算好的目标集合 / 通道 / cwd 挂到 run 上（同一份数据，不另起一套口径）。
    cwd: repoRoot,
    targets: targetFiles,
    channel,
  };

  try {
    assertNestedSuiteRan(run, "整套件自证闸门"); // 跑了没 / 零用例 / 计数口径自洽
    if (!channel.summary || !channel.tally) {
      throw new Error(
        `干净事件通道不完整（summary=${Boolean(channel.summary)} tally=${Boolean(channel.tally)}）` +
          `⇒ 计数不可信，禁止判绿（信号=${signal ?? "无"}）`,
      );
    }
    // 交叉校验红因 + 全绿判据（退出码 0 / cancelled 0 / fail 0 / skipped 0 / todo 0）**一次性打全**，
    // 便于一眼定位是「计数通道不可信」还是「套件真的没全绿」。
    const problems = crossCheckProblems({
      summary: channel.summary,
      tally: channel.tally,
      human,
      code,
      summaries: channel.summaries,
      badLines: channel.badLines,
    });
    problems.push(...nestedSuitePassProblems(run));
    problems.push(...coverageProblems(targetFiles, channel)); // g-415 判据③：逐文件覆盖
    if (problems.length > 0) {
      throw new Error(`整套件自证闸门不达标 —— ${problems.join("；")}`);
    }
  } catch (e) {
    dropChannel();
    console.error(`\n[run-tests] ✖ 自证失败：${e?.message ?? e}`);
    process.exitCode = 1;
    return;
  }
  dropChannel();
  const s = run.summary;
  console.log(
    `\n[run-tests] ✔ 自证通过：tests=${s.tests} (>0) skipped=${s.skipped} fail=${s.fail} cancelled=${s.cancelled} ` +
      `todo=${s.todo} pass=${s.pass} exit=${code} ms=${Date.now() - started} glob=${TEST_GLOB}`,
  );
  process.exitCode = 0;
});
