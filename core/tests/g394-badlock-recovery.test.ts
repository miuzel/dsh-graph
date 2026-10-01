/** g-394（v0.19.0 阶段 1 交叉审查，两方独立收敛）：坏锁/读失败锁**有界自愈**。
 *
 *  修复前的两条永久性故障（同一根因：无身份 ⇒ 无回收）：
 *  ① 锁文件 0 字节 / 乱码 / 截断写 ⇒ parseInt 得 NaN ⇒ acquireLock 既进不了
 *     「持有者已死 ⇒ 抢占」分支，也不命中「同进程嵌套」分支 ⇒ 只能耗尽 lockTimeoutMs；
 *     且 releaseLock 对无法确认身份的锁保守不删 ⇒ 该 root 此后所有事务失败直到人工删锁。
 *  ② 读身份失败（EISDIR/EACCES）导致本进程残留自身 PID 锁 ⇒ 本进程生命周期内再也拿不回
 *     自己的锁（抛「同进程嵌套获取锁」或超时），同样无自动回收路径。
 *
 *  回归覆盖（判据 4）：空文件、乱码、截断写、读失败（EISDIR/EACCES）、本进程遗留自身 PID
 *  锁、真实存活 PID 锁、已死 PID 锁、两进程竞争；以及「未过阈值不得回收」的反向守卫。
 *
 *  负向对照（回退修复即红）：把 core/transaction.ts 的 g-394 自愈逻辑回退后，
 *  ①（空/乱码/截断/EISDIR/EACCES）会退化为「获取锁超时」、②（本进程遗留）会退化为
 *  「同进程嵌套获取锁——死锁」，对应断言全部转红。已按 stash 回退实测（见交付报文）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  lstatSync,
  chmodSync,
  utimesSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

import { init } from "../ops.ts";
import { withTx, type TxResult, type TxFailure } from "../transaction.ts";
import { isProcessAlive } from "../platform.ts";

const TX_PATH = fileURLToPath(new URL("../transaction.ts", import.meta.url));

/** 回拨量：远大于任何合理阈值（1 小时），使「坏锁已陈旧」与阈值具体取值解耦 ——
 *  这样把修复回退成旧算法时，本文件仍能正常加载并让**断言**转红（而不是模块加载失败）。 */
const STALE_BACKDATE_MS = 60 * 60 * 1000;

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g394-"));
  init(dir);
  return dir;
}

/** 把锁文件的 mtime 推到阈值之外（模拟「坏锁已陈旧」——进程在创建与写入之间崩溃留下的锁）。 */
function makeStale(path: string): void {
  const old = new Date(Date.now() - STALE_BACKDATE_MS);
  utimesSync(path, old, old);
}

/** 递归断言：root 内没有锁文件（.lock.*）、回收隔离文件（*.reclaim-*）或原子写临时文件。 */
function assertNoResidue(root: string): void {
  const bad: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
        continue;
      }
      if (ent.name.startsWith(".lock.") || ent.name.includes(".tmp.")) bad.push(p);
    }
  };
  walk(root);
  assert.deepEqual(bad, [], `存在锁/临时文件残留：${bad.join(", ")}`);
}

/** 取一个**已确认死亡**的 PID（spawnSync 返回时子进程已退出；PID 复用窗口内则重取）。 */
function deadPid(): number {
  for (let i = 0; i < 20; i++) {
    const pid = spawnSync(process.execPath, ["-e", "process.exit(0)"]).pid;
    if (pid && !isProcessAlive(pid)) return pid;
  }
  throw new Error("无法取得已死 PID");
}

/** 单次事务尝试：返回结果与耗时，便于断言「自愈是有界的、没有耗尽超时」。 */
function tryTx(
  root: string,
  lockName: string,
  lockTimeoutMs: number,
): { r: TxResult<string> | TxFailure; elapsedMs: number } {
  const t0 = Date.now();
  const r = withTx({ root, actor: "test" }, { lockName, lockTimeoutMs }, () => ({
    value: "ok",
    events: [],
  }));
  return { r, elapsedMs: Date.now() - t0 };
}

// ---------------------------------------------------------------------------
// ① 身份不可解析的坏锁（0 字节 / 乱码 / 截断写）⇒ 陈旧后有界自愈
// ---------------------------------------------------------------------------

test("g-394①：自愈阈值必须有限且可解释（不得长到等于永久）", async () => {
  const mod = (await import("../transaction.ts")) as Record<string, unknown>;
  const ms = mod.STALE_BAD_LOCK_MS;
  assert.equal(typeof ms, "number", "应导出 STALE_BAD_LOCK_MS 作为唯一自愈阈值");
  assert.ok(
    (ms as number) > 5000 && (ms as number) <= 5 * 60 * 1000,
    `阈值应有界且不至于等于永久等待，实际 ${String(ms)}ms`,
  );
});

test("g-394①：0 字节锁文件（越阈值）有界自愈，不耗尽 lockTimeoutMs", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.zero");
  writeFileSync(lockPath, "", "utf8");
  makeStale(lockPath);

  const { r, elapsedMs } = tryTx(root, "zero", 3000);
  assert.equal(r.ok, true, `0 字节陈旧锁应自愈：${r.ok ? "" : r.error}`);
  // 自愈必须发生在超时之前（回退修复后此处转为「获取锁超时」⇒ 红）
  assert.ok(elapsedMs < 1500, `应快速自愈而非耗尽超时，实际 ${elapsedMs}ms`);
  assert.equal(existsSync(lockPath), false, "事务结束后锁应被释放");
  assertNoResidue(root);
});

test("g-394①：乱码锁文件（越阈值）有界自愈", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.garbage");
  writeFileSync(lockPath, "\u0000\u0000not-a-pid%%%$\n", "utf8");
  makeStale(lockPath);

  const { r } = tryTx(root, "garbage", 3000);
  assert.equal(r.ok, true, `乱码陈旧锁应自愈：${r.ok ? "" : r.error}`);
  assert.equal(existsSync(lockPath), false);
  assertNoResidue(root);
});

test("g-394①：截断写（半截 UTF-8 字节，越阈值）有界自愈", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.truncated");
  writeFileSync(lockPath, Buffer.from([0xe4, 0xb8])); // 写一半被打断的多字节序列
  makeStale(lockPath);

  const { r } = tryTx(root, "truncated", 3000);
  assert.equal(r.ok, true, `截断陈旧锁应自愈：${r.ok ? "" : r.error}`);
  assert.equal(existsSync(lockPath), false);
  assertNoResidue(root);
});

test("g-394①：残留的非法数字 ID（parseInt 边界值 0）走已死 PID 路径立即自愈", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.zeroid");
  writeFileSync(lockPath, "0", "utf8"); // 可解析但非合法进程（isProcessAlive(0) === false）

  const { r } = tryTx(root, "zeroid", 0); // timeout=0：必须立即抢占，不许等
  assert.equal(r.ok, true, `非法数字 ID 锁应立即抢占：${r.ok ? "" : r.error}`);
  assert.equal(existsSync(lockPath), false);
  assertNoResidue(root);
});

test("g-394①：越界数字（超出 process.kill 的 int32 范围）陈旧后有界自愈", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.overflow");
  // 例如两次写入拼接出的 14+ 位数字：parseInt 可解析，但 process.kill 会抛
  // ERR_OUT_OF_RANGE（不是 ESRCH/EPERM）⇒ 若把抛错当「保守判存活」就永久不可回收
  writeFileSync(lockPath, "99999999999999999999", "utf8");
  makeStale(lockPath);

  const { r } = tryTx(root, "overflow", 3000);
  assert.equal(r.ok, true, `越界数字陈旧锁应自愈：${r.ok ? "" : r.error}`);
  assert.equal(existsSync(lockPath), false);
  assertNoResidue(root);
});

test("g-394①反向守卫：未越阈值的越界数字锁同样不得被抢占", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.overflow-fresh");
  writeFileSync(lockPath, "99999999999999999999", "utf8");

  const { r } = tryTx(root, "overflow-fresh", 200);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /获取锁超时/);
  assert.equal(readFileSync(lockPath, "utf8"), "99999999999999999999", "不得改写其内容");
  rmSync(root, { recursive: true, force: true });
});

test("g-394①反向守卫：未越阈值的坏锁不得被抢占（拒绝过度回收）", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.fresh");
  writeFileSync(lockPath, "", "utf8"); // 新鲜坏锁：可能是别的进程刚建好、内容还没落盘

  const { r } = tryTx(root, "fresh", 200);
  assert.equal(r.ok, false, "未越阈值的坏锁不得被回收");
  if (!r.ok) {
    assert.equal(r.phase, "read");
    assert.match(r.error, /获取锁超时/);
  }
  assert.equal(existsSync(lockPath), true, "未越阈值的坏锁必须原样保留");
  assert.equal(readFileSync(lockPath, "utf8"), "", "不得改写其内容");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ② 读身份失败（EISDIR / EACCES）⇒ 陈旧后有界自愈，新鲜不得删
// ---------------------------------------------------------------------------

test("g-394②：读身份失败 EISDIR（锁路径变目录，越阈值）有界自愈", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.eisdir");
  mkdirSync(lockPath);
  makeStale(lockPath);

  const { r } = tryTx(root, "eisdir", 3000);
  assert.equal(r.ok, true, `EISDIR 陈旧锁应自愈：${r.ok ? "" : r.error}`);
  assert.equal(existsSync(lockPath), false, "隔离后的目录锁应被清除，且事务结束后释放锁");
  assertNoResidue(root);
});

test("g-394②：读身份失败 EACCES（mode 000，越阈值）有界自愈", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.eacces");
  writeFileSync(lockPath, String(process.pid), "utf8"); // 内容是本进程 PID，但读不到
  chmodSync(lockPath, 0o000);
  makeStale(lockPath);

  const { r } = tryTx(root, "eacces", 3000);
  assert.equal(r.ok, true, `不可读的陈旧锁（含本进程自身 PID）应自愈：${r.ok ? "" : r.error}`);
  assert.equal(existsSync(lockPath), false);
  assertNoResidue(root);
});

test("g-394②反向守卫：未越阈值的 EISDIR 不得被删除（拒绝「读不到就删」）", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.eisdir-fresh");
  mkdirSync(lockPath); // 新鲜：身份不可确认，但年龄不够 ⇒ 只能保守等待

  const { r } = tryTx(root, "eisdir-fresh", 200);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /获取锁超时/);
  assert.equal(existsSync(lockPath), true, "读不到身份不等于可以盲删");
  assert.equal(lstatSync(lockPath).isDirectory(), true, "原路径形态必须保持");
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// ③ 本进程遗留孤儿锁 vs 真·同进程嵌套持有（held-set 区分）
// ---------------------------------------------------------------------------

test("g-394③：本进程遗留自身 PID 锁（进程内未持有）立即自愈，不得再报嵌套死锁", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.own-leftover");
  writeFileSync(lockPath, String(process.pid), "utf8"); // 上次残留：内容是本进程 PID

  const { r } = tryTx(root, "own-leftover", 0); // timeout=0：遗留锁必须立即回收
  assert.equal(r.ok, true, `本进程遗留锁应被回收而非死锁：${r.ok ? "" : r.error}`);
  if (!r.ok) assert.doesNotMatch(r.error, /嵌套/);
  assert.equal(existsSync(lockPath), false);
  assertNoResidue(root);
});

test("g-394③：真·同进程嵌套持有仍按死锁语义拒绝，外层锁不得被误删", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.nested");
  let inner: TxResult<null> | TxFailure | undefined;

  const outer = withTx({ root, actor: "test" }, { lockName: "nested" }, () => {
    assert.equal(existsSync(lockPath), true, "外层临界区内锁必须在");
    assert.equal(readFileSync(lockPath, "utf8").trim(), String(process.pid));
    inner = withTx({ root, actor: "test" }, { lockName: "nested", lockTimeoutMs: 10 }, () => ({
      value: null,
      events: [],
    }));
    assert.equal(existsSync(lockPath), true, "嵌套失败后外层锁不得消失");
    return { value: "outer", events: [] };
  });

  assert.equal(outer.ok, true);
  assert.equal(inner!.ok, false, "真·嵌套持有必须失败（held-set 命中）");
  if (!inner!.ok) {
    assert.equal(inner!.phase, "read");
    assert.match(inner!.error, /同进程嵌套获取锁/);
  }
  assert.equal(existsSync(lockPath), false, "外层结束后才释放自己的锁");
  assertNoResidue(root);
});

test("g-394③：releaseLock 删不掉自己的锁时，进程内记录必须清除 ⇒ 下次获取立即回收", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.rm-blocked");

  // 临界区内把 root 目录置为不可写 ⇒ releaseLock 的 unlink 被拒（非 root 下确定性发生），
  // 锁文件会以「本进程 PID」的形式残留 —— 这正是 g-394 要消灭的永久锁形态。
  const first = withTx({ root, actor: "test" }, { lockName: "rm-blocked" }, () => {
    chmodSync(root, 0o500);
    return { value: "first", events: [] };
  });
  chmodSync(root, 0o700); // 先恢复权限再断言/清理

  assert.equal(first.ok, true);
  const residual = existsSync(lockPath);
  if (residual) {
    assert.equal(readFileSync(lockPath, "utf8").trim(), String(process.pid));
  }
  // 无论 unlink 是否真的被拒（root 用户下会成功），下一次获取都必须成功：
  // residual=true 时只有「heldLocks 记录已清除 + 本进程遗留锁可回收」两条同时成立才可能绿。
  const second = withTx(
    { root, actor: "test" },
    { lockName: "rm-blocked", lockTimeoutMs: residual ? 0 : 1000 },
    () => ({ value: "second", events: [] }),
  );
  assert.equal(second.ok, true, `残留自身 PID 锁必须可回收：${second.ok ? "" : second.error}`);
  assert.equal(existsSync(lockPath), false, "第二次事务结束后不得留下锁");
  assertNoResidue(root);
});

// ---------------------------------------------------------------------------
// ④ 所有权语义：存活 PID 绝不抢占；已死 PID 立即抢占
// ---------------------------------------------------------------------------

test("g-394④：可解析 PID 且进程存活的锁绝不被抢占——即使 mtime 远超阈值", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.alive");
  writeFileSync(lockPath, String(process.ppid), "utf8"); // ppid 必然存活
  makeStale(lockPath); // 陈旧不是抢占存活持有者的理由

  const { r } = tryTx(root, "alive", 300);
  assert.equal(r.ok, false, "存活持有者的锁不得被抢占");
  if (!r.ok) {
    assert.equal(r.phase, "read");
    assert.match(r.error, /获取锁超时/);
  }
  assert.equal(existsSync(lockPath), true, "锁必须原样保留");
  assert.equal(readFileSync(lockPath, "utf8").trim(), String(process.ppid), "内容不得被改写");
  rmSync(root, { recursive: true, force: true });
});

test("g-394④：已死 PID 的锁立即抢占（既有语义保留）", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.dead");
  writeFileSync(lockPath, String(deadPid()), "utf8");

  const { r } = tryTx(root, "dead", 0); // timeout=0：已死持有者必须立即让位
  assert.equal(r.ok, true, `已死 PID 锁应立即抢占：${r.ok ? "" : r.error}`);
  assert.equal(existsSync(lockPath), false);
  assertNoResidue(root);
});

// ---------------------------------------------------------------------------
// ⑤ 两进程竞争：陈旧坏锁被自愈后，临界区不得重叠
// ---------------------------------------------------------------------------

const CHILD_SOURCE = `
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [, , txPath, root, lockName, holdMs, timeoutMs, logFile, tag] = process.argv;
const { withTx } = await import(pathToFileURL(txPath).href);
const log = (line) => appendFileSync(logFile, line + "\\n");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const r = withTx({ root, actor: "child" }, { lockName, lockTimeoutMs: Number(timeoutMs) }, () => {
  log("enter " + tag + " " + Date.now());
  sleep(Number(holdMs));
  log("exit " + tag + " " + Date.now());
  return { value: tag, events: [] };
});
process.stdout.write(JSON.stringify({ tag, ok: r.ok, phase: r.ok ? null : r.phase, error: r.ok ? null : r.error }) + "\\n");
`;

interface ChildRun {
  tag: string;
  ok: boolean;
  phase: string | null;
  error: string | null;
}

test("g-394⑤：陈旧 0 字节锁被 A 自愈后，B 必须等待其临界区结束（不重叠）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-g394-proc-"));
  const root = join(base, "root");
  mkdirSync(root, { recursive: true });
  init(root);
  const lockPath = join(root, ".lock.heal-race");
  writeFileSync(lockPath, "", "utf8");
  makeStale(lockPath);

  const logFile = join(base, "critical.log");
  writeFileSync(logFile, "", "utf8");
  const childScript = join(base, "child.mjs");
  writeFileSync(childScript, CHILD_SOURCE, "utf8");

  const logLines = (): string[] =>
    readFileSync(logFile, "utf8").split("\n").filter((l) => l.trim() !== "");
  const waitForLog = async (prefix: string, timeoutMs: number): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (logLines().some((l) => l.startsWith(prefix))) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`等待日志 ${prefix} 超时；当前：${JSON.stringify(logLines())}`);
  };
  const spawnChild = (tag: string, holdMs: number, timeoutMs: number) => {
    const proc: ChildProcess = spawn(
      process.execPath,
      [childScript, TX_PATH, root, "heal-race", String(holdMs), String(timeoutMs), logFile, tag],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const done = new Promise<ChildRun>((resolve, reject) => {
      let out = "";
      let err = "";
      proc.stdout!.on("data", (d: Buffer) => { out += d.toString("utf8"); });
      proc.stderr!.on("data", (d: Buffer) => { err += d.toString("utf8"); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        try {
          const line = out.split("\n").filter((l) => l.trim() !== "").pop();
          assert.ok(line, `子进程 ${tag} 无 stdout（exit=${code}, stderr=${err}）`);
          resolve(JSON.parse(line) as ChildRun);
        } catch (e) { reject(e); }
      });
    });
    return { proc, done };
  };

  // A 先启动：它必须自愈那把陈旧坏锁（旧算法下 A 会超时失败 ⇒ 本用例红）
  const a = spawnChild("A", 300, 5000);
  await waitForLog("enter A", 5000);
  assert.equal(existsSync(lockPath), true, "A 自愈后应持有自己的锁");
  assert.equal(readFileSync(lockPath, "utf8").trim(), String(a.proc.pid));

  // B 在 A 持锁期间竞争：必须等待，不得与 A 重叠
  const b = spawnChild("B", 50, 5000);
  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.ok, true, `A 应成功：${ra.error}`);
  assert.equal(rb.ok, true, `B 应成功（等 A 释放后取得锁）：${rb.error}`);

  const open = new Map<string, number>();
  const intervals: { tag: string; enter: number; exit: number }[] = [];
  for (const line of logLines()) {
    const [kind, tag, ts] = line.split(" ");
    if (kind === "enter") open.set(tag, Number(ts));
    if (kind === "exit") intervals.push({ tag, enter: open.get(tag)!, exit: Number(ts) });
  }
  assert.equal(intervals.length, 2, `应有两条完整临界区记录：${JSON.stringify(intervals)}`);
  const sorted = [...intervals].sort((x, y) => x.enter - y.enter);
  assert.equal(sorted[0].tag, "A");
  assert.equal(sorted[1].tag, "B");
  assert.ok(sorted[1].enter >= sorted[0].exit, `临界区重叠：${JSON.stringify(sorted)}`);

  assert.equal(existsSync(lockPath), false, "全部事务结束后锁应被释放");
  assertNoResidue(root);
  rmSync(base, { recursive: true, force: true });
});
