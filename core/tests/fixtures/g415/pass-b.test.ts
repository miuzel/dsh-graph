/**
 * core/tests/fixtures/g415/pass-b.test.ts
 *
 * g-415 专用夹具：必然通过的套件（多文件正向覆盖对照的另一半）。见 pass-a.test.ts 说明。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件。
 */

import { test } from "node:test";

test("g-415 夹具：pass-b 必然通过", () => {});
