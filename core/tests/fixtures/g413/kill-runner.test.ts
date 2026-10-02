/**
 * core/tests/fixtures/g413/kill-runner.test.ts
 *
 * g-413 专用夹具：**让 runner 子进程被信号杀死**（`process.ppid` = `node --test` 运行器）。
 * 用途：证明「子 runner 被 SIGKILL」这一形态下闸门 `exit≠0`：
 *   退出码为 `null`（`close(code=null, signal=SIGKILL)`）、事件通道没有任何汇总与 tally、
 *   人类可读通道也没有汇总行 ⇒ 必须判红，绝不能因「没有汇总 = 看起来 0 失败」而放行。
 *
 * 位置在 `fixtures/` 子目录 ⇒ 不被顶层 glob `core/tests/*.test.ts` 收作正式套件；
 * 运行器一死即返回，**不会挂起**（实测 spawnSync 立即结束）。
 */

import { test } from "node:test";

test("g-413 fixture：杀死运行器进程（模拟被信号终止的子 runner）", () => {
  process.kill(process.ppid, "SIGKILL");
});
