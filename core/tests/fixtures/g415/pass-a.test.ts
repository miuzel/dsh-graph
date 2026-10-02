/**
 * core/tests/fixtures/g415/pass-a.test.ts
 *
 * g-415 专用夹具：必然通过的套件（多文件正向覆盖对照的一半）。
 * 用途：`g415-gate-hardening.test.ts` 用 [pass-a, pass-b] 证明**多文件全绿**时
 * 目标文件覆盖断言不会误红（即覆盖断言不是「恒红」的假守卫）。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件。
 */

import { test } from "node:test";

test("g-415 夹具：pass-a 必然通过", () => {});
