/**
 * core/tests/fixtures/g424/cancelled-same-sig.test.ts
 *
 * g-424 **cancelled 变体夹具**：用例经 `AbortController` 在启动后被**取消** ⇒ `cancelled=1`、
 * 该用例自身 `fail 0` 但进程 exit 1（`failureType: 'testAborted'`）。回调（携带签名）**从未执行**。
 * 与 `real-fail.test.ts` 一起跑时签名仍由 A 满足；旧负向裁决接受（取消的用例照常产出文件级
 * 完成事件，覆盖/通道校验看不出来）。
 *
 * 稳定构造：`abort()` 由 5ms 定时器触发，用例体只等 50ms ⇒ 不等长超时、不依赖机器负载，
 * 实测 ~90ms 完成且 `cancelled=1` 稳定。
 *
 * 位置在 `fixtures/g424/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 误收。
 */

import { test } from "node:test";

export const G424_SIGNATURE = "G424_EXPECTED_NEGATIVE_SIG";

const controller = new AbortController();

test("g-424 fixture D：被取消的意图断言（回调从不执行）", { signal: controller.signal }, async () => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  throw new Error(G424_SIGNATURE);
});

setTimeout(() => controller.abort(new Error(G424_SIGNATURE)), 5);
