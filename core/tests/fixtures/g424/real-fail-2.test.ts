/**
 * core/tests/fixtures/g424/real-fail-2.test.ts
 *
 * g-424 夹具 A′（第二个**真实失败**目标）：与 A 用**同一签名**，用于「两个文件都真实失败、无
 * skip/todo ⇒ 负向裁决必须接受」的正向对照（不得因新增口径变成恒红）。
 *
 * 位置在 `fixtures/g424/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 误收。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

export const G424_SIGNATURE = "G424_EXPECTED_NEGATIVE_SIG";

test("g-424 fixture A′：第二个真实执行并失败的断言", () => {
  assert.fail(G424_SIGNATURE);
});
