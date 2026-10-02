/**
 * core/tests/fixtures/g417/pass.test.ts
 *
 * g-417 正向夹具：唯一用例全绿。用于「合法 NODE_OPTIONS 不误拒」与「含空格/反斜杠 TMPDIR 下
 * 事件通道照常挂上」的正向实测。位于 fixtures 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 误收。
 */

import { test } from "node:test";

test("g417-pass", () => {
  /* 无需断言的绿色用例：本夹具只提供「真的跑了且全绿」这一事实。 */
});
