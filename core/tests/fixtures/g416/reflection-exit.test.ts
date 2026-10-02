/**
 * core/tests/fixtures/g416/reflection-exit.test.ts
 *
 * g-416 负向夹具：注册「一个必然通过 + 一个必然失败」的用例后，在**文件顶层用反射退出**
 * （`globalThis['pro'+'cess']['ex'+'it'](0)`，绕过禁止 `process.exit` 字面量的文本守卫）。
 *
 * 实测形态：runner 只报文件级 subtest（`tests 1 / pass 1 / fail 0`）且 **exit 0**，
 * 失败用例的断言**从未执行**；但**逐文件完成事件**（带 `file` 的 `test:summary`）不会产出
 * ⇒ helper 的目标文件覆盖判据据此判红（g-416 判据 1）。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob 误收；一退即返回，不挂起。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

test("g-416 夹具：先注册一个必然通过的用例", () => {});

test("g-416 夹具：再注册一个必然失败的用例（早退会把它整个吞掉）", () => {
  assert.fail("G416_REFLECTION_EXIT_MUST_FAIL");
});

// 危险形态：反射调用与直接退出等价，但字面量守卫看不见。
globalThis["pro" + "cess"]["ex" + "it"](0);
