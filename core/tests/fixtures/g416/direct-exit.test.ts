/**
 * core/tests/fixtures/g416/direct-exit.test.ts
 *
 * g-416 负向夹具：与 reflection-exit 同形态，但用**直接** `process.exit(0)` 早退
 * （被收集集合里该形态由 g-415 结构守卫禁止；fixtures 子目录不在被收集集合内，故可用作对照）。
 *
 * 期望：helper 判据必须判红，红因点名「目标文件未产出完成事件」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

test("g-416 夹具：先注册一个必然通过的用例", () => {});

test("g-416 夹具：再注册一个必然失败的用例（早退会把它整个吞掉）", () => {
  assert.fail("G416_DIRECT_EXIT_MUST_FAIL");
});

process.exit(0);
