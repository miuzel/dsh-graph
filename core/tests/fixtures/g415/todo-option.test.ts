/**
 * core/tests/fixtures/g415/todo-option.test.ts
 *
 * g-415 专用夹具：**`{ todo: true }` 选项形态的待办用例**（与 `test.todo` 同病，`exit 0`）。
 * 用途：证明闸门对**两种形态**都判红（判据 1 要求两形态实测）。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件。
 */

import { test } from "node:test";

test("g-415 夹具：待办用例（{ todo: true } 形态）", { todo: true }, () => {});
