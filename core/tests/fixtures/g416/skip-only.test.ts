/**
 * core/tests/fixtures/g416/skip-only.test.ts
 *
 * g-416 负向夹具：唯一「用例」被跳过（`test.skip`）—— runner 汇总 `tests 1 / pass 0 / skipped 1`
 * 且 **exit 0**，逐文件完成事件**照常产出**。
 * ⇒ 期望红因来自 `skipped === 0` 判据，不是覆盖判据。
 */

import { test } from "node:test";

test.skip("g-416 夹具：跳过不是验证", () => {});
