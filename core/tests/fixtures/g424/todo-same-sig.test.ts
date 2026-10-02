/**
 * core/tests/fixtures/g424/todo-same-sig.test.ts
 *
 * g-424 **todo 变体夹具**：`test.todo(name)` 是「**零验证**」——**根本没有回调**、该用例自身 exit 0。
 * 与 `real-fail.test.ts` 一起跑时签名仍由 A 的真实失败满足，而本文件一个断言都没执行。
 * 实测 `code 1 / tests 2 / fail 1 / todo 1`；覆盖率/通道校验都看不出来：todo 用例照常产出
 * 文件级完成事件、计数自洽。旧负向裁决接受。
 *
 * 位置在 `fixtures/g424/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 误收。
 */

import { test } from "node:test";

test.todo("g-424 fixture C：待办的意图断言（无回调，从不执行）");
