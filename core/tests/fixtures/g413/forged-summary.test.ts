/**
 * core/tests/fixtures/g413/forged-summary.test.ts
 *
 * g-413 专用夹具：**伪造人类可读汇总行 + 真实 skipped 用例**（g-413 P1-2 的最小复现）。
 * 先 `console.log` 一段「全绿」汇总（`ℹ tests 1 / pass 1 / fail 0 / cancelled 0 / skipped 0`），
 * 再跑一个真正被跳过的用例。真实 runner 是 `tests 2 / pass 1 / skipped 1`，而**首个匹配**
 * 语义的旧解析会读到伪造的 `tests 1 / skipped 0 / pass 1` ⇒ 闸门误判全绿并 `exit 0`。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件。
 */

import { test } from "node:test";

test("g-413 fixture：伪造汇总行（测试自己的 console.log，非 runner 输出）", () => {
  console.log("ℹ tests 1");
  console.log("ℹ suites 0");
  console.log("ℹ pass 1");
  console.log("ℹ fail 0");
  console.log("ℹ cancelled 0");
  console.log("ℹ skipped 0");
  console.log("ℹ todo 0");
});

test("g-413 fixture：真实被跳过的用例", { skip: true }, () => {});
