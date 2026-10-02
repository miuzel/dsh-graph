/**
 * core/tests/fixtures/g421/wrap-failure.test.ts
 *
 * g-421 **第二形态精确 repro 夹具**（终局复核第二轮实测）：一个**良性通过**的用例 + 输出期望签名 +
 * 文件末尾 `process.exitCode = 1` ⇒ Node **正常产出文件级完成事件**（覆盖/通道校验都能过），
 * 但**本该失败的断言 subtest 从未执行**；`fail 1` 只是**文件包装**因退出码被判失败。
 *
 * 实测（复核者原值，本夹具待复测）：`code 1 / tests 2 / pass 1 / fail 1`，`assertNestedSuiteFailed`
 * 此前**接受**。「非零退出 + 文件级 summary + 输出正则」不足以证明「确有一次真实断言失败」。
 *
 * 位置在 `fixtures/g421/` 子目录 ⇒ 不被顶层 glob（`core/tests/*.test.ts`）误收。
 */

import { writeSync } from "node:fs";
import { test } from "node:test";

const SENTINEL = "G421_WRAP_EXIT_SENTINEL";

writeSync(2, `${SENTINEL}\n`);

test("g-421 夹具：良性通过的用例（本该失败的断言从未执行）", () => {});

// 只把**退出码**置 1：没有 test 级失败事件，失败只是「文件包装 subtest」。
process.exitCode = 1;
