/**
 * core/tests/fixtures/g416/kill-runner.test.ts
 *
 * g-416 负向夹具：让**运行器子进程**被信号杀死（`process.ppid` = helper 派生的 `node --test`）。
 * 期望：helper 侧 `code === null`（被信号终止）、干净事件通道没有任何汇总与 tally
 * ⇒ 判红（绝不能因「没有汇总 = 看起来 0 失败」而放行）。
 *
 * 与 `sigkill.test.ts` 的区别：后者只杀死**测试文件进程**（runner 仍正常收尾，报 fail=1）；
 * 本夹具杀死 runner 本身，覆盖「通道未收尾」形态。位置在 fixtures/ 子目录 ⇒ 不被顶层 glob 误收。
 */

import { test } from "node:test";

test("g-416 夹具：杀死运行器进程（模拟被信号终止的子 runner）", () => {
  process.kill(process.ppid, "SIGKILL");
});
