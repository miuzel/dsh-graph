/**
 * core/tests/fixtures/g407/always-pass.test.ts
 *
 * g-407 专用夹具：**必然通过**的套件。
 * 用途（勿改）：负向对照 —— 证明 helper 的「确实跑了」判据不会把正常全绿的嵌套运行误判为红
 * （即守卫不是「恒抛」的假守卫）。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

test("g-407 fixture：必然通过的断言", () => {
  assert.equal(1 + 1, 2);
});
