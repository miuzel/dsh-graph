/**
 * core/tests/fixtures/g413/always-cancel.test.ts
 *
 * g-413 专用夹具：**必然出现「被取消」用例**的套件（`{timeout:1}` 内 promise 永不 resolve）。
 * 用途：证明闸门把 `cancelled > 0` 判红 —— 旧版闸门只看 `fail === 0 && skipped === 0`，
 * 会把这个形态放行成 `✔ 自证通过`（g-413 P1-1）。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件；
 * 取消靠 `timeout` 收敛 ⇒ **不会挂起**套件。
 */

import { test } from "node:test";

test("g-413 fixture：先来一个正常用例", () => {});

test("g-413 fixture：被取消的用例（timeout 内永不 resolve）", { timeout: 1 }, () => new Promise(() => {}));
