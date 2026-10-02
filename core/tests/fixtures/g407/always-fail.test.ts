/**
 * core/tests/fixtures/g407/always-fail.test.ts
 *
 * g-407 专用夹具：**必然失败**的套件。
 * 用途（勿改）：证明「继承 NODE_TEST_CONTEXT 时嵌套 runner 静默 skip ⇒ 报红断言永真」——
 * 带继承变量的嵌套运行会 exit 0，于是「这个套件应该是红的」这一断言被恒真化。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件，只由
 * `core/tests/g407-nested-runner-context.test.ts` 显式 spawn。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

export const FAIL_MARKER = "G407_ALWAYS_FAIL_MARKER";

test("g-407 fixture：必然失败的断言（用于证明 skip 会让它永真）", () => {
  assert.equal(1 + 1, 3, FAIL_MARKER);
});
