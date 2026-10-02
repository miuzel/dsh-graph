/**
 * core/tests/fixtures/g424/real-fail.test.ts
 *
 * g-424 夹具 A（**真实失败**目标）：一次真正执行的 `assert.fail(<签名>)` ⇒ 产出带 `file` 的逐文件
 * 完成事件 + 一条 test 级真实失败事件（其 error 文本携带签名）。这是「如期报红」的**合法**一半。
 *
 * 位置在 `fixtures/g424/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 误收，只由
 * `core/tests/g424-negative-verdict-skip-todo.test.ts` 显式 spawn。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

export const G424_SIGNATURE = "G424_EXPECTED_NEGATIVE_SIG";

test("g-424 fixture A：真实执行并失败的断言", () => {
  assert.fail(G424_SIGNATURE);
});
