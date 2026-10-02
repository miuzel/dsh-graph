/**
 * core/tests/fixtures/g415/large-output.test.ts
 *
 * g-415 专用夹具：**超大 stdout 输出**（`console.log('X'.repeat(200000))`）。
 * 用途（P1-⑥）：闸门旧版在 `process.stdout.write(out)` 之后立刻 `process.exit(0)`，经 **pipe** 捕获时
 * 未 flush 的缓冲被丢弃 —— 实测 exit 0、stdout 恰 65536 字节、尾部全是 X、**没有自证行**。
 * 本夹具让「闸门收尾必须 flush 管道」成为可实测断言（自证行必须可见且输出 > 200 KB）。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件。
 */

import { test } from "node:test";

test("g-415 夹具：超大输出（验证闸门经 pipe 捕获时不丢自证行）", () => {
  console.log("X".repeat(200_000));
});
