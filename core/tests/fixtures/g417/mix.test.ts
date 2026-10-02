/**
 * core/tests/fixtures/g417/mix.test.ts
 *
 * g-417 负向前提夹具：**1 通过 + 1 失败**。它存在的唯一目的是复现 P2 残余的「静默弱化」形态：
 * 在 `NODE_OPTIONS=--test-only` / `--test-name-pattern=vis` / `--test-skip-pattern=hid` 下，
 * 被排除的失败用例**既不计 `fail` 也不计 `skipped`**（实测 `tests 1 / pass 1 / fail 0`），
 * 而文件照常产出完成事件 ⇒ 只做**文件级**覆盖断言的旧 helper 判据会接受该运行。
 *
 * 注意：本文件**不含**选集式 only 标记（g-415 结构守卫扫描 `core/tests/**`）；且位于 fixtures
 * 子目录 ⇒ 不被顶层 glob 误收（它本身就是一个「应当报红」的文件）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

test("vis", () => {
  /* 绿色用例：被选集开关留下。 */
});

test("hid", () => {
  assert.fail("g417-mix-hidden-failure：该失败用例被选集开关静默排除时，旧判据会误判为全绿");
});
