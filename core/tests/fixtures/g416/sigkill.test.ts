/**
 * core/tests/fixtures/g416/sigkill.test.ts
 *
 * g-416 负向夹具：注册一个用例后**自杀**（SIGKILL）。
 * 期望：子进程 `code === null`（被信号终止）、干净事件通道没有逐事件计数（未收尾）
 * ⇒ helper 判红；**不挂起**（立即被信号收敛）。
 */

import { test } from "node:test";

test("g-416 夹具：注册一个用例后被 SIGKILL（跑不到它）", () => {});

process.kill(process.pid, "SIGKILL");
