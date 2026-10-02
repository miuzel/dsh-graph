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
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

const argv = process.argv.slice(2);
const targets = argv.length > 0 ? argv : expandGlob(TEST_GLOB);
if (targets.length === 0) {
  console.error(`[run-tests] 未展开到任何测试文件（glob=${TEST_GLOB}）⇒ 不得判绿`);
  process.exit(2);
}

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
    ...targets,
  ],
  {
    cwd: repoRoot,
    env: cleanTestEnv(), // ← 自证的前提：注入变量在此被摘除（唯一实现）
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let out = "";
let err = "";
child.stdout.on("data", (chunk) => { out += chunk; });
child.stderr.on("data", (chunk) => { err += chunk; });
child.on("error", (e) => {
  dropChannel();
  console.error(`[run-tests] 无法启动测试 runner：${e?.message ?? e}`);
  process.exit(2);
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
    command: `${process.execPath} --test ${targets.join(" ")}`,
  };

  try {
    assertNestedSuiteRan(run, "整套件自证闸门"); // 跑了没 / 零用例 / 计数口径自洽
    if (!channel.summary || !channel.tally) {
      throw new Error(
        `干净事件通道不完整（summary=${Boolean(channel.summary)} tally=${Boolean(channel.tally)}）` +
          `⇒ 计数不可信，禁止判绿（信号=${signal ?? "无"}）`,
      );
    }
    // 交叉校验红因 + 全绿判据（退出码 0 / cancelled 0 / fail 0 / skipped 0）**一次性打全**，
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
    if (problems.length > 0) {
      throw new Error(`整套件自证闸门不达标 —— ${problems.join("；")}`);
    }
  } catch (e) {
    dropChannel();
    console.error(`\n[run-tests] ✖ 自证失败：${e?.message ?? e}`);
    process.exit(1);
  }
  dropChannel();
  const s = run.summary;
  console.log(
    `\n[run-tests] ✔ 自证通过：tests=${s.tests} (>0) skipped=${s.skipped} fail=${s.fail} cancelled=${s.cancelled} ` +
      `pass=${s.pass} exit=${code} ms=${Date.now() - started} glob=${TEST_GLOB}`,
  );
  process.exit(0);
});
