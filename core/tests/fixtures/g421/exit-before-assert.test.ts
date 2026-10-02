/**
 * core/tests/fixtures/g421/exit-before-assert.test.ts
 *
 * g-421 **精确 repro 夹具**（终局 codex 复核实测的负向裁决 P1）：
 *   ① 输出 sentinel（用 `writeSync(2, …)` 保证早退前**确实落到 stderr**，等价于复核者的 `console.error`）；
 *   ② 注册一个**必然失败**的断言用例（`assert.fail(sentinel)`）；
 *   ③ 随即在文件顶层 `process.exit(1)` —— 断言**从未执行**，但退出码非零且输出含 sentinel。
 *
 * 实测（复核实测值）：`runNestedArgv` 得 `code 1 / tests 1 / fail 1`，而
 * **`channel.files = []`**（没有任何逐文件 `test:summary` 完成事件）。
 * 旧 `assertNestedSuiteFailed` 只看「非零退出 + 输出正则」⇒ **接受** ⇒ 可把「进程早退」
 * 冒充「预期失败」（false-positive test evidence）。修复后必须因覆盖/证据不足**拒绝**。
 *
 * 位置在 `fixtures/g421/` 子目录 ⇒ 不被顶层 glob（`core/tests/*.test.ts`）误收。
 */

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { test } from "node:test";

const SENTINEL = "G421_EXPECTED_NEGATIVE_SENTINEL";

// 同步写 fd 2：`process.exit` 会丢弃管道上未 flush 的异步日志，sentinel 必须确实可达。
writeSync(2, `${SENTINEL}\n`);

test("g-421 夹具：注册必然失败的断言（随后立即早退，断言不会执行）", () => {
  assert.fail(SENTINEL);
});

process.exit(1);
