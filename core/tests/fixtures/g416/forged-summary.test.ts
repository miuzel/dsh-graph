/**
 * core/tests/fixtures/g416/forged-summary.test.ts
 *
 * g-416 负向夹具：在**没有任何真实验证跑完**的情况下，由测试自己 `console.log` 打印一份
 * **比真实计数乐观得多**的「全绿」人类可读汇总（`ℹ tests 99`），随后反射早退。
 *
 * 期望：① 判定不得采信伪造块（`parseTestSummary` 取**末尾** = runner 真实汇总 `tests 1`；
 * 权威计数只认带类型事件通道）；② 该文件没有产出逐文件完成事件 ⇒ 覆盖判据判红。
 * 即「人工伪造人类通道」既污染不了计数，也换不来一个完成事件。
 */

import { test } from "node:test";

console.log(
  ["ℹ tests 99", "ℹ suites 0", "ℹ pass 99", "ℹ fail 0", "ℹ cancelled 0", "ℹ skipped 0", "ℹ todo 0"].join("\n"),
);

test("g-416 夹具：伪造 99 条全绿汇总后立即早退（一个真实验证都没有）", () => {});

globalThis["pro" + "cess"]["ex" + "it"](0);
