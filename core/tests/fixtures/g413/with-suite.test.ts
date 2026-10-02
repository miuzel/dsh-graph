/**
 * core/tests/fixtures/g413/with-suite.test.ts
 *
 * g-413 专用夹具：**含 `describe()` 聚合块的全绿套件**。
 * 用途：`describe` 块也会收到 `test:pass`（`details.type === "suite"`），node 汇总把它计进
 * `suites` 而**不是** `tests`。事件 tally 若不区分，就会把 `tests` 多算（全量实测 1883 + 9），
 * 使闸门的「三方计数一致」交叉校验误红 ⇒ 本夹具把这条语义钉住（闸门须报告 tests=2，不是 3）。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件。
 */

import { describe, it } from "node:test";

describe("g-413 fixture：describe 聚合块（不得被计成用例）", () => {
  it("子用例 a", () => {});
  it("子用例 b", () => {});
});
