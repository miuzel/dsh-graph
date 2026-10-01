/** g-384（v0.18.0 审查 C3，P2）：状态迁移/主管绑定「先落盘、后记事件」的失败副作用。
 *
 *  被钉住的契约（core/transaction.ts `commitPrepared`）：
 *  prepare（调用方，纯内存、零文件副作用）→ event（先追加事件）→ persist（后写文件）。
 *  期望语义：event 失败 ⇒ 磁盘保持原值、错误阶段=event；persist 失败 ⇒ 事件已落盘
 *  + `tx.persist_failed` 诊断 + 错误阶段=persist + 幂等重试收敛（不宣称跨文件原子）。
 *
 *  ① 事件追加失败：goal.md / project.yaml **逐字节**保持原值，错误准确表达失败阶段；
 *  ② 事件成功而落盘失败：诊断事件 + 阶段=persist，重试后事件与 frontmatter 对账一致；
 *  ③ 正常操作：事件重放与文件对账一致（rebuild 无 drift）；
 *  ④ withTx 契约单元钉：event 失败不执行 persist；两条失败路径都释放锁、无锁/临时文件残留；
 *  ⑤ F2（主管指定必做）：取代路径「attempt.superseded 已落盘、attempt.md 落盘失败」
 *     必须补记 `attempt.supersede_failed`（否则 rebuild 不重放 attempt 事件 ⇒ 无从发现）。
 *
 *  负向对照（改坏/回退修复就会红）：
 *  - 把 transition 改回 `saveGoal` → `appendEvent`，① 的「goal.md 逐字节未变」立即失败；
 *  - 把 writeSupervisorSession 的 atomicWrite 搬回 withTx 回调内，① 的
 *    「project.yaml 逐字节未变」立即失败；
 *  - 去掉取代路径 catch 里的 `attempt.supersede_failed` 补记，⑤ 立即失败；
 *  - 把 withTx 的 `if (acquired) releaseLock` 改回无条件释放，
 *    core/tests/g383-lock-ownership.test.ts ② 立即失败（g-383 锁所有权语义未被本改动弱化）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  transition,
  findGoalFile,
  loadGoal,
  rebuild,
  writeSupervisorSession,
  readSupervisorSession,
  startAttempt,
  bindAttemptChild,
  unbindGoalChild,
} from "../ops.ts";
import { withTx, atomicWrite } from "../transaction.ts";
import { readEvents } from "../events.ts";

const ACTOR = "human:gui";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g384-"));
  init(dir);
  return dir;
}

function eio(what: string): Error {
  const e = new Error(`simulated ${what} EIO`) as Error & { code?: string };
  e.code = "EIO";
  return e;
}

/** 精确故障注入：只让 events.jsonl 的追加抛 EIO，其余 fs 行为逐字不变。 */
function failEventAppend(root: string): () => void {
  const target = join(root, "events.jsonl");
  const orig = fs.appendFileSync;
  fs.appendFileSync = ((p: unknown, ...args: unknown[]) => {
    if (String(p) === target) throw eio("events append");
    return (orig as (...a: unknown[]) => unknown)(p, ...args);
  }) as typeof fs.appendFileSync;
  syncBuiltinESMExports();
  return () => {
    fs.appendFileSync = orig;
    syncBuiltinESMExports();
  };
}

/** 精确故障注入：只让写入 dest 的 rename（atomicWrite 的落盘步骤）抛 EIO。 */
function failPersist(dest: string): () => void {
  const orig = fs.renameSync;
  fs.renameSync = ((src: unknown, to: unknown, ...rest: unknown[]) => {
    if (String(to) === dest) throw eio("persist rename");
    return (orig as (...a: unknown[]) => unknown)(src, to, ...rest);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  return () => {
    fs.renameSync = orig;
    syncBuiltinESMExports();
  };
}

/** 递归断言：无锁文件（.lock.*）与原子写临时文件（*.tmp.*）残留。 */
function assertNoResidue(root: string): void {
  const bad: string[] = [];
  const walk = (dir: string): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.startsWith(".lock.") || ent.name.includes(".tmp.")) bad.push(p);
    }
  };
  walk(root);
  assert.deepEqual(bad, [], `存在锁/临时文件残留：${bad.join(", ")}`);
}

function newGoal(root: string): string {
  const g = createGoal(root, { title: "event-first", version: "standalone", actor: ACTOR });
  setCriteria(root, g, ["契约断言"], ACTOR);
  return g;
}

// ---------------------------------------------------------------------------
// ① 事件追加失败 ⇒ 文件逐字节保持原值，错误表达失败阶段
// ---------------------------------------------------------------------------

test("g-384①：transition 事件追加失败 ⇒ goal.md 逐字节原值，阶段=event", () => {
  const root = tmpRoot();
  const g = newGoal(root);
  const file = findGoalFile(root, g);
  const before = readFileSync(file, "utf8");
  const eventsBefore = readFileSync(join(root, "events.jsonl"), "utf8");
  assert.equal(loadGoal(file).meta.status, "planning");

  const restore = failEventAppend(root);
  let err: Error | undefined;
  try {
    transition(root, g, "in_progress", { actor: ACTOR });
  } catch (e) {
    err = e as Error;
  } finally {
    restore();
  }

  assert.ok(err, "事件追加失败必须抛错（不得静默成功）");
  assert.match(err!.message, /event/);
  assert.match(err!.message, /磁盘保持原值/);
  assert.equal(readFileSync(file, "utf8"), before, "goal.md 必须逐字节保持原值（负向对照点）");
  assert.equal(loadGoal(file).meta.status, "planning", "状态不得已改变");
  assert.equal(
    readFileSync(join(root, "events.jsonl"), "utf8"),
    eventsBefore,
    "事件流不得留下半条/新记录",
  );
  assertNoResidue(root);
});

test("g-384①：writeSupervisorSession 事件追加失败 ⇒ project.yaml 原值/不产生，阶段=event", () => {
  const root = tmpRoot();
  const file = join(root, "project.yaml");
  const original = "# board config\nsupervisor:\n  session: old-session  # keep\n\nscale: 1\n";
  writeFileSync(file, original, "utf8");
  assert.equal(readSupervisorSession(root), "old-session");

  const restore = failEventAppend(root);
  let err: Error | undefined;
  try {
    writeSupervisorSession(root, "new-session", ACTOR);
  } catch (e) {
    err = e as Error;
  } finally {
    restore();
  }

  assert.ok(err, "事件追加失败必须抛错");
  assert.match(err!.message, /（event）/);
  assert.match(err!.message, /磁盘保持原值/);
  assert.equal(readFileSync(file, "utf8"), original, "project.yaml 必须逐字节保持原值（负向对照点）");
  assert.equal(readSupervisorSession(root), "old-session", "主管绑定不得已改变");

  // 文件原本不存在时同样不得被创建
  const root2 = tmpRoot();
  const file2 = join(root2, "project.yaml");
  assert.equal(existsSync(file2), false);
  const restore2 = failEventAppend(root2);
  assert.throws(() => writeSupervisorSession(root2, "s1", ACTOR), /（event）/);
  restore2();
  assert.equal(existsSync(file2), false, "事件失败不得创建 project.yaml");
  assert.equal(readSupervisorSession(root2), null);
  assertNoResidue(root2);
});

// ---------------------------------------------------------------------------
// ② 事件成功而落盘失败 ⇒ 诊断 + 阶段=persist + 重试收敛
// ---------------------------------------------------------------------------

test("g-384②：transition 落盘失败 ⇒ tx.persist_failed 诊断，重试后对账一致", () => {
  const root = tmpRoot();
  const g = newGoal(root);
  const file = findGoalFile(root, g);
  const before = readFileSync(file, "utf8");

  const restore = failPersist(file);
  let err: Error | undefined;
  try {
    transition(root, g, "in_progress", { actor: ACTOR });
  } catch (e) {
    err = e as Error;
  } finally {
    restore();
  }

  assert.ok(err, "落盘失败必须抛错");
  assert.match(err!.message, /persist 阶段/);
  assert.match(err!.message, /事件已先行落盘/);
  assert.equal(readFileSync(file, "utf8"), before, "落盘失败时文件保持原值");
  assert.equal(loadGoal(file).meta.status, "planning");

  const evs = readEvents(root);
  assert.ok(
    evs.some((e) => e.goal === g && e.event === "goal.transition" && e.details?.to === "in_progress"),
    "事件已先行落盘（真相源已前进）",
  );
  const diag = evs.filter((e) => e.event === "tx.persist_failed");
  assert.equal(diag.length, 1, "必须补记恰好一条诊断事件");
  assert.equal(diag[0].goal, g);
  assert.equal(diag[0].details?.phase, "persist");
  assert.equal(diag[0].details?.recovery, "retry");
  assert.deepEqual(diag[0].details?.events, ["goal.transition"]);
  assert.match(String(diag[0].details?.error), /EIO/);

  // 有限恢复：幂等重试同一调用即收敛，事件重放与 frontmatter 对账一致
  transition(root, g, "in_progress", { actor: ACTOR });
  assert.equal(loadGoal(file).meta.status, "in_progress");
  assert.deepEqual(
    rebuild(root).filter((d) => d.startsWith(`${g}:`)),
    [],
    "重试后事件流与 frontmatter 必须一致",
  );
  assertNoResidue(root);
});

test("g-384②：writeSupervisorSession 落盘失败 ⇒ 诊断事件，重试可收敛", () => {
  const root = tmpRoot();
  const file = join(root, "project.yaml");
  assert.equal(existsSync(file), false);

  const restore = failPersist(file);
  let err: Error | undefined;
  try {
    writeSupervisorSession(root, "sess-2", ACTOR);
  } catch (e) {
    err = e as Error;
  } finally {
    restore();
  }

  assert.ok(err, "落盘失败必须抛错");
  assert.match(err!.message, /（persist）/);
  assert.match(err!.message, /tx\.persist_failed/);
  assert.equal(existsSync(file), false, "落盘失败不得留下半写的 project.yaml");
  assert.equal(readSupervisorSession(root), null);

  const evs = readEvents(root);
  assert.ok(evs.some((e) => e.event === "supervisor.claimed"), "supervisor.claimed 已先行落盘");
  const diag = evs.filter((e) => e.event === "tx.persist_failed");
  assert.equal(diag.length, 1);
  assert.deepEqual(diag[0].details?.events, ["supervisor.claimed"]);

  writeSupervisorSession(root, "sess-2", ACTOR);
  assert.equal(readSupervisorSession(root), "sess-2");
  assertNoResidue(root);
});

// ---------------------------------------------------------------------------
// ③ 正常操作：事件与文件对账一致
// ---------------------------------------------------------------------------

test("g-384③：正常操作事件与文件对账一致（rebuild 无 drift）", () => {
  const root = tmpRoot();
  const g = newGoal(root);
  transition(root, g, "in_progress", { actor: ACTOR });
  writeSupervisorSession(root, "sess-ok", ACTOR);

  assert.equal(loadGoal(findGoalFile(root, g)).meta.status, "in_progress");
  assert.equal(readSupervisorSession(root), "sess-ok");
  assert.deepEqual(rebuild(root), [], "正常操作后事件重放与 frontmatter 必须一致");
  assert.equal(
    readEvents(root).filter((e) => e.event === "tx.persist_failed").length,
    0,
    "正常路径不得产生诊断事件",
  );
  assertNoResidue(root);
});

// ---------------------------------------------------------------------------
// ④ withTx 契约单元钉：阶段语义、persist 不被提前执行、锁释放
// ---------------------------------------------------------------------------

test("g-384④：event 失败不执行 persist；persist 失败释放锁并落诊断", () => {
  const root = tmpRoot();

  // (a) event 阶段失败 ⇒ persist 绝不被调用，锁已释放
  let persisted = false;
  const restoreEv = failEventAppend(root);
  const r1 = withTx({ root, actor: ACTOR }, { lockName: "g384" }, () => ({
    value: "v1",
    events: [{ actor: ACTOR, event: "g384.probe", details: {} }],
    persist: () => { persisted = true; },
  }));
  restoreEv();
  assert.equal(r1.ok, false);
  if (!r1.ok) {
    assert.equal(r1.phase, "event");
    assert.match(r1.error, /磁盘保持原值/);
  }
  assert.equal(persisted, false, "event 失败不得执行 persist");
  assert.equal(existsSync(join(root, ".lock.g384")), false, "event 失败也必须释放本次持有的锁");

  // (b) persist 阶段失败 ⇒ 阶段=persist，事件 + 诊断落盘，锁已释放、无残留
  const target = join(root, "payload.txt");
  const restoreW = failPersist(target);
  const r2 = withTx({ root, actor: ACTOR }, { lockName: "g384" }, () => ({
    value: "v2",
    events: [{ actor: ACTOR, event: "g384.probe2", details: {} }],
    persist: () => atomicWrite(target, "data"),
  }));
  restoreW();
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.equal(r2.phase, "persist");
    assert.match(r2.error, /persist 阶段/);
  }
  const evs = readEvents(root);
  assert.ok(evs.some((e) => e.event === "g384.probe2"));
  assert.ok(evs.some((e) => e.event === "tx.persist_failed"));
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(join(root, ".lock.g384")), false, "persist 失败也必须释放锁");
  assertNoResidue(root);
});

// ---------------------------------------------------------------------------
// ⑤ F2（主管指定必做）：取代路径「事件已落盘、attempt.md 落盘失败」必须可诊断
// ---------------------------------------------------------------------------

/** 同目标两个 attempt：旧（child-old，稍后被取代）+ 最新（child-new）。 */
function twoBoundAttempts(): { root: string; goal: string; oldAtt: string; newAtt: string } {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g384-supersede-"));
  init(root);
  const goal = createGoal(root, { title: "g-384 F2", version: "v0.19.0", actor: ACTOR });
  setCriteria(root, goal, ["取代失败必须可诊断"], ACTOR);
  const oldAtt = startAttempt(root, goal, { executor: "agent:exec-old", actor: ACTOR });
  bindAttemptChild(root, goal, oldAtt, "child-old", ACTOR, "sess-old");
  const newAtt = startAttempt(root, goal, { executor: "agent:exec-new", actor: ACTOR });
  bindAttemptChild(root, goal, newAtt, "child-new", ACTOR, "sess-new");
  return { root, goal, oldAtt, newAtt };
}

test("g-384⑤ F2：superseded 事件已落盘而 attempt.md 落盘失败 ⇒ 补记 attempt.supersede_failed", () => {
  const { root, goal, oldAtt, newAtt } = twoBoundAttempts();
  const attDir = join(dirname(findGoalFile(root, goal)), "attempts");
  const oldFile = join(attDir, oldAtt, "attempt.md");
  const newFile = join(attDir, newAtt, "attempt.md");
  const oldBefore = readFileSync(oldFile, "utf8");
  const token = String(loadGoal(newFile).meta.binding_token);

  const restore = failPersist(oldFile);
  let res: ReturnType<typeof unbindGoalChild> | undefined;
  let err: Error | undefined;
  try {
    res = unbindGoalChild(root, goal, {
      actor: ACTOR,
      attempt: newAtt,
      token,
      liveCheck: () => "idle",
    });
  } catch (e) {
    err = e as Error;
  } finally {
    restore();
  }

  assert.equal(err, undefined, "旧 attempt 取代失败不得让本次解绑整体失败（不改变既有语义）");
  assert.equal(res?.detached, true, "selector 选中的最新 attempt 已正常解绑");

  // 危险窗口：事件流已宣称 superseded（真相源已前进），文件却仍绑定
  const superseded = readEvents(root).filter((e) => e.event === "attempt.superseded" && e.goal === goal);
  assert.equal(superseded.length, 1);
  assert.equal(superseded[0].details?.child_id, "child-old");
  assert.equal(readFileSync(oldFile, "utf8"), oldBefore, "落盘失败 ⇒ 旧 attempt 文件逐字节原值（仍绑定）");
  assert.equal(loadGoal(oldFile).meta.child_id, "child-old");

  // 必须留下显式诊断（无此事件则该窗口既无对账也无从发现——负向对照点）
  const failed = readEvents(root).filter((e) => e.event === "attempt.supersede_failed" && e.goal === goal);
  assert.equal(failed.length, 1, "必须补记恰好一条 attempt.supersede_failed");
  assert.equal(failed[0].details?.attempt, oldAtt);
  assert.equal(failed[0].details?.child_id, "child-old");
  assert.equal(failed[0].details?.event_written, true);
  assert.equal(failed[0].details?.phase, "persist");
  assert.match(String(failed[0].details?.error), /EIO/);
  assertNoResidue(root);
});
