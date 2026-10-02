#!/usr/bin/env node
/**
 * scripts/test-reporter-events.mjs —— g-413：`node --test` 的**不可被测试输出污染**的计数通道。
 *
 * 缺陷（g-413 P1-2）：runner 的人类可读汇总（`ℹ tests 2` 等）与**测试自己的 `console.log`**
 * 混在同一条 stdout 上，`parseTestSummary` 无论取首个还是末尾匹配，都无法从**通道**上区分
 * 「测试打印的伪造行」与「runner 自产的汇总」。
 *
 * 本 reporter 只转发**带类型的事件**，因此可以区分：
 *   - `test:summary`：runner 自产的汇总（`data.counts = {tests,passed,failed,cancelled,skipped,todo,…}`）；
 *   - `test:pass` / `test:fail`：逐用例结果（`skip` / `todo` / `details.error.failureType`）。
 * 测试的 `console.log` 走 `test:stdout` 事件 —— 本 reporter **不转发**它，故伪造文本进不了本通道。
 *
 * 输出（NDJSON，一行一个对象）：
 *   {"type":"summary","file":<string|null>,"counts":{…}} 每个 runner 汇总一条（文件级带 `file`，
 *                                    最后一条全局级 `file` 为 `null`）
 *   {"type":"tally","counts":{…},…}  reporter 自行按事件累加的独立计数（source 耗尽时才产，
 *                                    因此**子进程被杀死 ⇒ 没有 tally 行**，可判「通道未完成」）
 *
 * 用法（由 scripts/run-tests.mjs 拼装，勿单独依赖）：
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *     --test-reporter=<本文件> --test-reporter-destination=<私有文件> <测试文件…>
 */

/** 一行 NDJSON；只输出结构化记录，绝不回显测试输出。 */
const emit = (obj) => `${JSON.stringify(obj)}\n`;

export default async function* reporter(source) {
  /** 逐事件独立累加（不读任何文本，故不可被测试输出影响）。 */
  const tally = { tests: 0, suites: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  let summaries = 0;

  for await (const ev of source) {
    if (!ev || typeof ev.type !== "string") continue;

    if (ev.type === "test:summary") {
      const counts = ev.data?.counts;
      if (counts) {
        summaries += 1;
        // g-415：带上 `file`（逐文件汇总才有；最后的全局汇总没有）⇒ 闸门可断言「每个目标文件都产出了完成事件」。
        yield emit({ type: "summary", file: typeof ev.data?.file === "string" ? ev.data.file : null, counts });
      }
      continue;
    }

    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const data = ev.data ?? {};
    // `describe()` 块的聚合事件（`details.type === "suite"`）**不是用例**：node 汇总把它计进
    // `suites` 而不是 `tests`。不区分会在含 describe 的套件上把 tally 多算（实测全量 1883 + 9）。
    if (data.details?.type === "suite") {
      tally.suites += 1;
      continue;
    }
    tally.tests += 1;
    const failureType = data.details?.error?.failureType;
    if (ev.type === "test:fail" && failureType === "testTimeoutFailure") {
      // 超时收敛 = node 汇总里的 cancelled（不是 fail）。
      tally.cancelled += 1;
    } else if (ev.type === "test:fail") {
      tally.fail += 1;
    } else if (data.skip) {
      tally.skipped += 1;
    } else if (data.todo) {
      tally.todo += 1;
    } else {
      tally.pass += 1;
    }
  }

  // source 正常耗尽才产出的「通道完成」标记：被杀 / 崩溃 ⇒ 没有这一行。
  yield emit({ type: "tally", counts: tally, summaries });
}
