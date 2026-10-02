/**
 * core/tests/fixtures/g413/always-skip.test.ts
 *
 * g-413 专用夹具：**必然出现被跳过用例**的套件（`skipped > 0`）。
 * 用途：证明闸门把 `skipped > 0` 判红（`exit 0` 也不能放行）。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件。
 */

import { test } from "node:test";

test("g-413 fixture：先来一个正常用例", () => {});

test("g-413 fixture：被跳过的用例", { skip: true }, () => {});
