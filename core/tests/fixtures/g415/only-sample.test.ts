/**
 * core/tests/fixtures/g415/only-sample.test.ts
 *
 * g-415 专用夹具：**选集式 only 标记样本**。三种形态同置一处，供结构守卫做负向对照
 * （把白名单摘掉 ⇒ 守卫必须红），并作为 `NODE_OPTIONS=--test-only` 旁路的复现件
 * （`--test-only` 下只有带 only 标记的用例运行，必然失败的普通用例被静默排除 ⇒ `exit 0`）。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件；
 * 本文件由结构守卫**显式路径白名单**放行（守卫自身所需的样本）。
 */

import { describe, it, test } from "node:test";
import assert from "node:assert/strict";

test.only("g-415 夹具：only 标记（test）", () => {});

describe.only("g-415 夹具：only 标记（describe）", () => {
  it("子用例", () => {});
});

it.only("g-415 夹具：only 标记（it）", () => {});

test("g-415 夹具：非选集用例必失败（被选集静默排除即为漏洞）", () => {
  assert.fail("G415_ONLY_EXCLUDED_MUST_FAIL");
});
