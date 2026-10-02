/**
 * core/tests/fixtures/g415/todo-call.test.ts
 *
 * g-415 专用夹具：**`test.todo(...)` 形态的待办用例**（`todo > 0` 且 `exit 0`）。
 * 用途：证明闸门把 `todo > 0` 判红 —— 旧判据只看 `fail/cancelled/skipped`，
 * 会把这个形态放行成 `✔ 自证通过`（`tests 1 / pass 0 / todo 1`，「零个真实验证」被当成全绿）。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件；
 * 待办用例不执行函数体，**不会挂起**套件。
 */

import { test } from "node:test";

test.todo("g-415 夹具：待办用例（test.todo 形态）");
