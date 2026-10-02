/**
 * core/tests/fixtures/g415/early-exit.test.ts
 *
 * g-415 专用夹具：**测试文件内顶层 `process.exit(0)` 早退**（P1-⑦ 的危险形态）。
 * 注册「一个通过 + 一个必然失败」的用例后立即退出 ⇒ runner 只报**文件级 subtest**
 * （`tests 1 / pass 1`）、自定义 reporter 仍发汇总与 tally，**两条断言都没执行**；
 * 但**逐文件完成事件**（带 `file` 的 `test:summary`）不会产出 ⇒ 闸门的目标文件覆盖断言据此判红。
 *
 * 位置在 `fixtures/` 子目录 ⇒ **不在被收集集合**（`core/tests/*.test.ts`）内：
 * 结构守卫（`core/tests/g415-gate-hardening.test.ts`）禁止收集集合出现这种直接退出，
 * 本夹具则用来复现该形态、证明闸门/守卫的判别力。
 * 运行器一退即返回，**不会挂起**。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

test("g-415 夹具：先注册一个必然通过的用例", () => {});

test("g-415 夹具：再注册一个必然失败的用例（早退会把它整个吞掉）", () => {
  assert.fail("G415_EARLY_EXIT_MUST_FAIL");
});

// 危险形态：注册完用例后立即退出进程 —— 逐文件完成事件永远不会产出。
process.exit(0);
