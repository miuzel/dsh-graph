/** g-383（v0.18.0 审查 C2，P2）：withTx 获取锁失败不得释放他人/外层的锁。
 *
 *  回归目标：
 *  ① 至少两个真实子进程竞争同一把锁，证明临界区不重叠（不以同步 for 循环冒充并发）；
 *  ② 预置存活进程持有的锁 + lockTimeoutMs=0 ⇒ 返回失败但原锁仍在；
 *  ③ 同进程嵌套获取失败不误删外层锁，外层事务结束才释放自己的锁；
 *  ④ 正常成功与业务异常退出均无锁/临时文件残留。
 *
 *  负向对照（改坏就会红）：把 withTx 的 catch 分支改回无条件 releaseLock，
 *  ② 中「等待者超时后原锁仍在」、③ 中「外层临界区内锁仍在」以及 ① 的
 *  「后续进程不得与仍持锁进程重叠」三处断言都会失败。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { init } from "../ops.ts";
import {
  withTx,
  atomicWrite,
  TxError,
  type TxResult,
  type TxFailure,
} from "../transaction.ts";

const TX_PATH = fileURLToPath(new URL("../transaction.ts", import.meta.url));

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g383-"));
  init(dir);
  return dir;
}

/** 递归断言：root 内没有任何锁文件（.lock.*）或原子写临时文件（*.tmp.*）。 */
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

// ---------------------------------------------------------------------------
// 真实子进程竞争夹具
// ---------------------------------------------------------------------------

const CHILD_SOURCE = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const [, , txPath, root, lockName, holdMs, timeoutMs, logFile, tag, waitFile, failInfoFile] = process.argv;
const { withTx } = await import(pathToFileURL(txPath).href);

const log = (line) => appendFileSync(logFile, line + "\\n");
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const lockPath = join(root, ".lock." + lockName);

const r = withTx({ root, actor: "child" }, { lockName, lockTimeoutMs: Number(timeoutMs) }, () => {
  log("enter " + tag + " " + Date.now());
  if (waitFile) {
    // 握手：持锁者等到对端写出「失败标记」后再退出，holdMs 仅作上限 ——
    // 使「等待者确实在持锁期间超时」由构造保证，不依赖 wall-clock 余量
    const deadline = Date.now() + Number(holdMs);
    while (Date.now() < deadline) {
      if (existsSync(waitFile)) break;
      sleep(5);
    }
  } else {
    sleep(Number(holdMs));
  }
  log("exit " + tag + " " + Date.now());
  return { value: tag, events: [] };
});

if (!r.ok && failInfoFile) {
  // 失败者在自己失败的那一刻记录锁现状：此刻持锁者仍在临界区内（它在等这份标记）
  let lockExists = false;
  let lockHolder = null;
  try {
    lockExists = existsSync(lockPath);
    if (lockExists) lockHolder = readFileSync(lockPath, "utf8").trim();
  } catch { /* 读不到就只记录存在性 */ }
  writeFileSync(failInfoFile, JSON.stringify({ tag, ok: false, phase: r.phase, error: r.error, lockExists, lockHolder }));
}
process.stdout.write(JSON.stringify({ tag, ok: r.ok, phase: r.ok ? null : r.phase, error: r.ok ? null : r.error }) + "\\n");
`;

interface ChildRun {
  tag: string;
  ok: boolean;
  phase: string | null;
  error: string | null;
  pid: number | undefined;
}

interface Fixture {
  root: string;
  logFile: string;
  lockPath: string;
  childScript: string;
  spawn: (
    tag: string,
    holdMs: number,
    timeoutMs: number,
    opts?: { waitFile?: string; failInfoFile?: string },
  ) => { proc: ChildProcess; done: Promise<ChildRun> };
  logLines: () => string[];
  waitForLog: (prefix: string, timeoutMs: number) => Promise<void>;
  intervals: () => { tag: string; enter: number; exit: number }[];
}

function makeFixture(lockName: string): Fixture {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-g383-proc-"));
  const root = join(base, "root");
  mkdirSync(root, { recursive: true });
  init(root);
  const logFile = join(base, "critical.log");
  writeFileSync(logFile, "", "utf8");
  const childScript = join(base, "child.mjs");
  writeFileSync(childScript, CHILD_SOURCE, "utf8");

  const logLines = (): string[] =>
    readFileSync(logFile, "utf8").split("\n").filter((l) => l.trim() !== "");

  return {
    root,
    logFile,
    lockPath: join(root, `.lock.${lockName}`),
    childScript,
    spawn(tag, holdMs, timeoutMs, opts) {
      const proc = spawn(
        process.execPath,
        [
          childScript, TX_PATH, root, lockName, String(holdMs), String(timeoutMs), logFile, tag,
          opts?.waitFile ?? "", opts?.failInfoFile ?? "",
        ],
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
            assert.ok(line, `子进程 ${tag} 无 stdout 结果（exit=${code}, stderr=${err}）`);
            resolve({ ...(JSON.parse(line) as ChildRun), pid: proc.pid });
          } catch (e) { reject(e); }
        });
      });
      return { proc, done };
    },
    logLines,
    async waitForLog(prefix, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (logLines().some((l) => l.startsWith(prefix))) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`等待日志 ${prefix} 超时；当前日志：${JSON.stringify(logLines())}`);
    },
    intervals() {
      const open = new Map<string, number>();
      const out: { tag: string; enter: number; exit: number }[] = [];
      for (const line of logLines()) {
        const [kind, tag, ts] = line.split(" ");
        if (kind === "enter") open.set(tag, Number(ts));
        if (kind === "exit") {
          const enter = open.get(tag);
          assert.notEqual(enter, undefined, `未见 ${tag} 的 enter 行`);
          out.push({ tag, enter: enter!, exit: Number(ts) });
        }
      }
      return out;
    },
  };
}

/** 临界区两两不重叠（按进入时间排序后，后者的进入不得早于前者的退出）。 */
function assertNoOverlap(iv: { tag: string; enter: number; exit: number }[]): void {
  const sorted = [...iv].sort((a, b) => a.enter - b.enter);
  for (let i = 1; i < sorted.length; i++) {
    assert.ok(
      sorted[i].enter >= sorted[i - 1].exit,
      `临界区重叠：${sorted[i - 1].tag}[${sorted[i - 1].enter},${sorted[i - 1].exit}] 与 ` +
        `${sorted[i].tag}[${sorted[i].enter},${sorted[i].exit}]`,
    );
  }
}

// ---------------------------------------------------------------------------
// ① 真实子进程竞争：临界区不重叠
// ---------------------------------------------------------------------------

test("g-383①：两个真实子进程竞争同一把锁，临界区不重叠", async () => {
  const fx = makeFixture("race");
  // A 先进临界区，B 在其持锁期间启动并竞争（确定性竞争窗口，非靠调度碰运气）
  const a = fx.spawn("A", 300, 5000);
  await fx.waitForLog("enter A", 5000);
  const b = fx.spawn("B", 50, 5000);

  const [ra, rb] = await Promise.all([a.done, b.done]);
  assert.equal(ra.ok, true, `A 应成功：${ra.error}`);
  assert.equal(rb.ok, true, `B 应成功（等待 A 释放后取得锁）：${rb.error}`);

  const iv = fx.intervals();
  assert.equal(iv.length, 2, `应有两条完整临界区记录，实际 ${JSON.stringify(iv)}`);
  assertNoOverlap(iv);
  // B 确实是在 A 之后进入（证明真实竞争而非各自独立跑完）
  const [first, second] = [...iv].sort((x, y) => x.enter - y.enter);
  assert.equal(first.tag, "A");
  assert.equal(second.tag, "B");
  assert.ok(second.enter >= first.exit, "B 必须等 A 退出临界区后才进入");

  assert.equal(existsSync(fx.lockPath), false, "全部事务结束后锁应被释放");
  assertNoResidue(fx.root);
});

// ---------------------------------------------------------------------------
// ② 等待者超时不得删除原持有者的锁（核心修复点）
// ---------------------------------------------------------------------------

test("g-383②：等待者超时不得删除存活进程持有的锁（预置活进程锁 + timeout=0）", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.review");
  writeFileSync(lockPath, String(process.ppid), "utf8"); // ppid 必然存活

  const tx = withTx({ root, actor: "test" }, { lockName: "review", lockTimeoutMs: 0 }, () => {
    throw new Error("临界区不得被执行");
  });

  assert.equal(tx.ok, false);
  if (tx.ok) return;
  assert.equal(tx.phase, "read");
  assert.match(tx.error, /获取锁超时/);
  assert.equal(existsSync(lockPath), true, "获取锁失败者不得删除原持有者的锁");
  assert.equal(readFileSync(lockPath, "utf8").trim(), String(process.ppid), "锁持有者标识不得被改写");
  rmSync(root, { recursive: true, force: true });
});

test("g-383②：真实子进程等待超时后，仍持锁进程的锁必须还在，且后来者不得闯入其临界区", async () => {
  const fx = makeFixture("busy");
  // g-394 顺带项：把本用例改成**握手式**，消除对 wall-clock 余量的依赖
  // （原实现靠 holdMs=800 覆盖 B 的 120ms 超时，余量约 3x，并行 CI 有触红风险）：
  // A 持锁并轮询等待 B 写出「失败标记」后才退出，holdMs 仅作 30s 上限
  // ⇒「B 在 A 持锁期间超时失败」由构造保证，与机器快慢无关。
  const failMarker = join(dirname(fx.logFile), "b-failed.json");
  const a = fx.spawn("A", 30_000, 5000, { waitFile: failMarker });
  await fx.waitForLog("enter A", 5000);

  // B 在 A 持锁期间等待，120ms 后超时失败——其 finally 不得删除 A 的锁
  const b = fx.spawn("B", 0, 120, { failInfoFile: failMarker });
  const rb = await b.done;
  assert.equal(rb.ok, false, "B 应在 A 持锁时超时失败");
  assert.equal(rb.phase, "read");
  assert.match(String(rb.error), /获取锁超时/);

  // 锁现状由 B 在**自己失败的那一刻**记录（此时 A 仍在临界区内等这份标记），
  // 因此断言不再有「A 可能已释放」的竞态窗口。
  const failInfo = JSON.parse(readFileSync(failMarker, "utf8")) as {
    tag: string;
    lockExists: boolean;
    lockHolder: string | null;
  };
  assert.equal(failInfo.tag, "B");
  assert.equal(failInfo.lockExists, true, "等待超时者不得删除存活持有者的锁");
  assert.equal(failInfo.lockHolder, String(a.proc.pid), "锁仍应属于 A");
  assert.equal(fx.logLines().some((l) => l.startsWith("enter B")), false, "B 不得进入临界区");

  // C 在 A 仍持锁时启动；修复前 B 已删锁，C 会与 A 重叠 → 本条在负向对照下必红
  const c = fx.spawn("C", 0, 5000);
  const [ra, rc] = await Promise.all([a.done, c.done]);
  assert.equal(ra.ok, true, `A 应成功：${ra.error}`);
  assert.equal(rc.ok, true, `C 应成功（等 A 释放后取得锁）：${rc.error}`);

  const iv = fx.intervals();
  assert.equal(iv.length, 2, `应只有 A、C 两条临界区，实际 ${JSON.stringify(iv)}`);
  assertNoOverlap(iv);
  assert.equal(existsSync(fx.lockPath), false, "最终锁应被释放");
  assertNoResidue(fx.root);
});

// ---------------------------------------------------------------------------
// ③ 同进程嵌套获取失败不得误删外层锁
// ---------------------------------------------------------------------------

test("g-383③：同进程嵌套获取失败不误删外层锁，外层结束才释放自己的锁", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.nested");
  let inner: TxResult<null> | TxFailure | undefined;
  let lockPresentInCritical = false;
  let holderInCritical = "";

  const outer = withTx({ root, actor: "test" }, { lockName: "nested" }, (ctx) => {
    // 外层临界区内：锁文件必须仍在，且持有者就是本进程
    lockPresentInCritical = existsSync(lockPath);
    holderInCritical = lockPresentInCritical ? readFileSync(lockPath, "utf8").trim() : "";

    inner = withTx(ctx, { lockName: "nested", lockTimeoutMs: 10 }, () => ({
      value: null,
      events: [],
    }));

    // 内层失败返回后，外层锁仍必须存在（修复前此处已被内层误删）
    assert.equal(existsSync(lockPath), true, "嵌套获取失败后外层锁不得消失");
    return { value: "outer", events: [] };
  });

  assert.equal(inner!.ok, false, "同进程嵌套获取应失败（死锁检测）");
  if (!inner!.ok) {
    assert.equal(inner!.phase, "read");
    assert.match(inner!.error, /嵌套/);
  }
  assert.equal(lockPresentInCritical, true, "外层临界区内必须持有锁");
  assert.equal(holderInCritical, String(process.pid), "持有者应为外层事务所在进程");
  assert.equal(outer.ok, true, "外层事务应正常成功");
  assert.equal(existsSync(lockPath), false, "外层事务结束后才释放自己的锁");
  assertNoResidue(root);
});

// ---------------------------------------------------------------------------
// ④ 正常成功 / 业务异常退出：无锁与临时文件残留
// ---------------------------------------------------------------------------

test("g-383④：正常成功不残留锁与临时文件", () => {
  const root = tmpRoot();
  const r = withTx({ root, actor: "test" }, { lockName: "clean-ok" }, () => ({
    value: "ok",
    events: [],
  }));
  assert.equal(r.ok, true);
  assert.equal(existsSync(join(root, ".lock.clean-ok")), false);
  // 原子写成功路径同样不留 .tmp.
  atomicWrite(join(root, "payload.txt"), "hello");
  assert.equal(readFileSync(join(root, "payload.txt"), "utf8"), "hello");
  assertNoResidue(root);
});

test("g-383④：业务异常退出只释放本次持有的锁，不残留锁/临时文件", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.clean-err");

  const r1 = withTx({ root, actor: "test" }, { lockName: "clean-err" }, () => {
    throw new Error("业务异常");
  });
  assert.equal(r1.ok, false);
  assert.equal(existsSync(lockPath), false, "异常退出应释放本次持有的锁");

  const r2 = withTx({ root, actor: "test" }, { lockName: "clean-err" }, () => {
    throw new TxError("阶段异常", "mutate", true);
  });
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.phase, "mutate");
  assert.equal(existsSync(lockPath), false);

  // 原子写失败路径（父目录不存在）不得留下 .tmp.
  assert.throws(() => atomicWrite(join(root, "no-such-dir", "x.txt"), "x"));
  assertNoResidue(root);
});

// ---------------------------------------------------------------------------
// ⑤ 锁被他人接管时不得盲删（持有者标识校验）
// ---------------------------------------------------------------------------

test("g-383⑤：锁已被他人接管时，本进程释放不得删除其锁", () => {
  const root = tmpRoot();
  const lockPath = join(root, ".lock.taken");
  let hijacked = false;

  const r = withTx({ root, actor: "test" }, { lockName: "taken" }, () => {
    // 模拟「过期抢占」竞态：临界区内锁被另一进程用 flag:"w" 覆写接管
    writeFileSync(lockPath, String(process.pid + 99999), "utf8");
    hijacked = true;
    return { value: null, events: [] };
  });

  assert.equal(hijacked, true);
  assert.equal(r.ok, true);
  assert.equal(existsSync(lockPath), true, "已被他人接管的锁不得被本进程删除");
  assert.equal(readFileSync(lockPath, "utf8").trim(), String(process.pid + 99999));
  rmSync(root, { recursive: true, force: true });
});
