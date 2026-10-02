/**
 * core/tests/fixtures/g416/todo-only.test.ts
 *
 * g-416 负向夹具：唯一「用例」是待办（`test.todo`）—— runner 汇总 `tests 1 / pass 0 / todo 1`
 * 且 **exit 0**，逐文件完成事件**照常产出**（文件确实跑完了）。
 * ⇒ 期望红因来自 `todo === 0` 判据，**不是**覆盖判据（据此证明两条判据互不掩盖）。
 */

import { test } from "node:test";

test.todo("g-416 夹具：待办不是验证");
