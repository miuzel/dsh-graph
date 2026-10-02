/**
 * core/tests/fixtures/g424/skip-same-sig.test.ts
 *
 * g-424 **精确 repro 夹具 B**（终局复核在 tip `7121112` 实测的新 P1）：一个 `test.skip(...)` 用例，
 * 其回调**携带与 A 相同的签名**但**从不执行**。与 `real-fail.test.ts` 一起跑时实测
 * `code 1 / tests 2 / fail 1 / skipped 1 / files=[A,B]`，
 * 而旧负向裁决（只核「证据核心 + ≥1 test 级失败事件 + 签名匹配」）**接受** ——
 * 签名由 A 的真实失败满足，B 的意图断言**从未执行**。
 *
 * 位置在 `fixtures/g424/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 误收。
 */

import { test } from "node:test";

export const G424_SIGNATURE = "G424_EXPECTED_NEGATIVE_SIG";

test.skip("g-424 fixture B：被跳过的意图断言（回调从不执行）", () => {
  throw new Error(G424_SIGNATURE);
});
