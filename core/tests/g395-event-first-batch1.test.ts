/** g-395（第一批）：3.4 残余「先落盘、后记事件」写点的分批收敛——5 处。
 *
 *  被收敛的写点（排序 = 调用频率 × 失败后状态错位严重度，见 goal g-395 审计）：
 *  1. `startAttempt`（F5×S4）：事件失败曾留下「无事件的孤儿 attempt 目录」，且孤儿被
 *     `count(att-*)+1` 计入 ⇒ 重试换号；rebuild 不重放 attempt 事件 ⇒ 完全不可诊断。
 *  2. `moveGoal`（F3×S5）：迁移已发生而无 `goal.moved`；rebuild 不重放该事件、也不比对位置 ⇒ 静默。
 *  3. `bindAttemptChild`（F5×S3）：attempt.md 已绑 child 而事件流无 `attempt.bound`。
 *  4. `archiveGoal`（F2×S5）：目标已搬进 archived/ 而无 `goal.archived`；归档目标已不在
 *     listGoalFiles 中 ⇒ rebuild 事后连对账对象都没有。
 *  5. `reportStatus`（F5×S2）：最高频写点（每次心跳/阶段转变），状态履历缺最新一条。
 *
 *  钉住的契约（g-384 的 `commitPrepared`）：event 失败 ⇒ 磁盘逐字节原值 + `phase="event"`；
 *  persist 失败 ⇒ 事件已先行 + `tx.persist_failed` 诊断 + 重试同一调用收敛（不宣称跨文件原子）。
 *
 *  负向对照（实跑）：把 core/ops.ts 回退到本批修复前（`git stash push core/ops.ts`），
 *  本文件 5 处 ①（事件失败）断言全部转红——「先落盘后记事件」下注入 EIO 后磁盘已被改动。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  findGoalFile,
  loadGoal,
  rebuild,
  startAttempt,
  bindAttemptChild,
  reportStatus,
  moveGoal,
  archiveGoal,
} from "../ops.ts";
import { readEvents } from "../events.ts";

const ACTOR = "agent:executor";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g395-"));
  init(dir);
  return dir;
}

function eio(what: string): Error {
  const e = new Error(`simulated ${what} EIO`) as Error & { code?: string };
  e.code = "EIO";
  return e;
}

/** 精确故障注入：只让 events.jsonl 的 append 抛 EIO，其余 fs 行为逐字不变。 */
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

/** 精确故障注入：只让 `rename(_, dest)` 抛 EIO（atomicWrite 的落盘步 / 目录搬迁步）。 */
function failRenameTo(dest: string): () => void {
  const orig = fs.renameSync;
  fs.renameSync = ((src: unknown, to: unknown, ...rest: unknown[]) => {
    if (String(to) === dest) throw eio("rename");
    return (orig as (...a: unknown[]) => unknown)(src, to, ...rest);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  return () => {
    fs.renameSync = orig;
    syncBuiltinESMExports();
  };
}

function newStandaloneGoal(root: string, title = "g395"): string {
  const g = createGoal(root, { title, version: "standalone", actor: ACTOR });
  setCriteria(root, g, ["契约断言"], ACTOR);
  return g;
}

function diagnostics(root: string): ReturnType<typeof readEvents> {
  return readEvents(root).filter((e) => e.event === "tx.persist_failed");
}

function withFail<T>(restore: () => void, fn: () => T): { err?: Error; value?: T } {
  try {
    return { value: fn() };
  } catch (e) {
    return { err: e as Error };
  } finally {
    restore();
  }
}

// ---------------------------------------------------------------------------
// ① startAttempt：事件失败 ⇒ 零文件副作用（无孤儿 attempt 目录），重试同号收敛
// ---------------------------------------------------------------------------

test("g-395①：startAttempt 事件失败 ⇒ 不建 attempts/、不建 attempt.md、阶段=event", () => {
  const root = tmpRoot();
  const g = newStandaloneGoal(root);
  const attemptsDir = join(dirname(findGoalFile(root, g)), "attempts");
  const before = readFileSync(findGoalFile(root, g), "utf8");

  const { err } = withFail(failEventAppend(root), () =>
    startAttempt(root, g, { executor: ACTOR, actor: ACTOR }),
  );

  assert.ok(err, "事件追加失败必须抛错");
  assert.match(err!.message, /event 阶段/);
  assert.match(err!.message, /磁盘保持原值/);
  assert.equal(existsSync(attemptsDir), false, "事件失败时不得创建 attempts/ 目录");
  assert.equal(readFileSync(findGoalFile(root, g), "utf8"), before, "goal.md 逐字节原值");
  assert.equal(
    readEvents(root).filter((e) => e.event === "attempt.started").length,
    0,
    "不得留下 attempt.started 事件",
  );

  // 重试同一调用：编号必须与首次尝试一致（不得因孤儿目录换号）
  const attId = startAttempt(root, g, { executor: ACTOR, actor: ACTOR });
  assert.equal(attId, "att-001");
  assert.ok(existsSync(join(attemptsDir, attId, "attempt.md")), "重试后 attempt.md 落盘");
  assert.equal(
    readEvents(root).filter((e) => e.event === "attempt.started" && e.details?.attempt === attId).length,
    1,
  );
});

test("g-395①：startAttempt 落盘失败 ⇒ 事件先行 + 诊断 + 清理半成品，重试同号收敛", () => {
  const root = tmpRoot();
  const g = newStandaloneGoal(root);
  const attemptsDir = join(dirname(findGoalFile(root, g)), "attempts");
  const attFile = join(attemptsDir, "att-001", "attempt.md");

  const { err } = withFail(failRenameTo(attFile), () =>
    startAttempt(root, g, { executor: ACTOR, actor: ACTOR }),
  );

  assert.ok(err, "落盘失败必须抛错");
  assert.match(err!.message, /persist 阶段/);
  assert.match(err!.message, /事件已先行落盘/);
  const evs = readEvents(root);
  assert.ok(
    evs.some((e) => e.event === "attempt.started" && e.details?.attempt === "att-001"),
    "attempt.started 已先行落盘",
  );
  assert.equal(diagnostics(root).length, 1, "必须补记恰好一条 tx.persist_failed");
  assert.equal(existsSync(attFile), false, "落盘失败不得留下半写 attempt.md");
  assert.deepEqual(
    existsSync(attemptsDir) ? readdirSync(attemptsDir) : [],
    [],
    "本次调用新建的半成品 attempt 目录必须清理（否则重试换号）",
  );

  const attId = startAttempt(root, g, { executor: ACTOR, actor: ACTOR });
  assert.equal(attId, "att-001", "重试必须收敛到同一编号");
  assert.equal(loadGoal(attFile).meta.id, "att-001");
});

// ---------------------------------------------------------------------------
// ② moveGoal：事件失败 ⇒ 位置与 frontmatter 都不动
// ---------------------------------------------------------------------------

test("g-395②：moveGoal 事件失败 ⇒ 目标留在原位、frontmatter 逐字节原值、阶段=event", () => {
  const root = tmpRoot();
  // 用 standalone(planning) → version 的迁移：状态不变，rebuild 对账才不含
  // 「moveGoal 改状态却不记 goal.transition」这一既有（与本批无关的）噪声。
  const g = createGoal(root, { title: "m", version: "standalone", actor: ACTOR });
  const before = findGoalFile(root, g);
  const beforeText = readFileSync(before, "utf8");
  const target = join(root, "versions", "v-395", "goals", g, "goal.md");

  const { err } = withFail(failEventAppend(root), () =>
    moveGoal(root, g, { to: "version", version: "v-395", actor: ACTOR }),
  );

  assert.ok(err, "事件追加失败必须抛错");
  assert.match(err!.message, /event 阶段/);
  assert.equal(findGoalFile(root, g), before, "事件失败时不得发生任何搬迁");
  assert.equal(existsSync(target), false, "事件失败时目标位置不得出现文件");
  assert.equal(readFileSync(before, "utf8"), beforeText, "原位 frontmatter 逐字节原值");
  assert.equal(
    readEvents(root).filter((e) => e.event === "goal.moved").length,
    0,
    "不得留下 goal.moved 事件",
  );

  // 重试收敛
  moveGoal(root, g, { to: "version", version: "v-395", actor: ACTOR });
  assert.equal(findGoalFile(root, g), target);
  assert.equal(loadGoal(target).meta.version, "v-395");
  assert.equal(loadGoal(target).meta.status, "planning");
  assert.equal(readEvents(root).filter((e) => e.event === "goal.moved").length, 1);
  assert.deepEqual(rebuild(root).filter((d) => d.startsWith(`${g}:`)), []);
});

test("g-395②：moveGoal 落盘两窗口（写 frontmatter / 搬迁）任一失败都可重试收敛", () => {
  for (const window of ["frontmatter", "relocate"] as const) {
    const root = tmpRoot();
    const g = createGoal(root, { title: "m", version: "standalone", actor: ACTOR });
    const before = findGoalFile(root, g);
    const target = join(root, "versions", "v-395", "goals", g, "goal.md");
    // frontmatter 窗口：注入原位 atomicWrite 的落盘；relocate 窗口：注入目录搬迁的目标父目录
    const restore = failRenameTo(window === "frontmatter" ? before : dirname(target));

    const { err } = withFail(restore, () =>
      moveGoal(root, g, { to: "version", version: "v-395", actor: ACTOR }),
    );
    assert.ok(err, `[${window}] 落盘失败必须抛错`);
    assert.match(err!.message, /persist 阶段/);
    assert.equal(diagnostics(root).length, 1, `[${window}] 必须补记诊断事件`);
    assert.ok(
      readEvents(root).some((e) => e.event === "goal.moved"),
      `[${window}] goal.moved 已先行落盘`,
    );

    moveGoal(root, g, { to: "version", version: "v-395", actor: ACTOR });
    assert.equal(findGoalFile(root, g), target, `[${window}] 重试后必须收敛到目标位置`);
    assert.equal(loadGoal(target).meta.version, "v-395");
    assert.equal(loadGoal(target).meta.status, "planning");
  }
});

// ---------------------------------------------------------------------------
// ③ bindAttemptChild：事件失败 ⇒ attempt.md 不绑定
// ---------------------------------------------------------------------------

test("g-395③：bindAttemptChild 事件失败 ⇒ attempt.md 逐字节原值（不留静默绑定）", () => {
  const root = tmpRoot();
  const g = newStandaloneGoal(root);
  const attId = startAttempt(root, g, { executor: ACTOR, actor: ACTOR });
  const attFile = join(dirname(findGoalFile(root, g)), "attempts", attId, "attempt.md");
  const before = readFileSync(attFile, "utf8");

  const { err } = withFail(failEventAppend(root), () =>
    bindAttemptChild(root, g, attId, "child-1", ACTOR, "sess-parent"),
  );

  assert.ok(err, "事件追加失败必须抛错");
  assert.match(err!.message, /event 阶段/);
  assert.equal(readFileSync(attFile, "utf8"), before, "attempt.md 逐字节原值");
  assert.equal(loadGoal(attFile).meta.child_id, null);
  assert.equal(
    readEvents(root).filter((e) => e.event === "attempt.bound").length,
    0,
    "不得留下 attempt.bound 事件",
  );

  bindAttemptChild(root, g, attId, "child-1", ACTOR, "sess-parent");
  assert.equal(loadGoal(attFile).meta.child_id, "child-1");
  assert.equal(loadGoal(attFile).meta.binding_version, 1);
  assert.equal(readEvents(root).filter((e) => e.event === "attempt.bound").length, 1);
});

// ---------------------------------------------------------------------------
// ④ archiveGoal：事件失败 ⇒ 目标仍在原位且未标记归档
// ---------------------------------------------------------------------------

test("g-395④：archiveGoal 事件失败 ⇒ 仍在原位、archived 未置位、阶段=event", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "a", actor: ACTOR }); // backlog 平铺（draft 可归档）
  const before = findGoalFile(root, g);
  const beforeText = readFileSync(before, "utf8");
  const target = join(root, "backlog", "archived", `${g}.md`);

  const { err } = withFail(failEventAppend(root), () =>
    archiveGoal(root, g, { actor: ACTOR }),
  );

  assert.ok(err, "事件追加失败必须抛错");
  assert.match(err!.message, /event 阶段/);
  assert.equal(findGoalFile(root, g), before, "事件失败时不得搬迁");
  assert.equal(existsSync(target), false, "事件失败时归档位置不得出现文件");
  assert.equal(readFileSync(before, "utf8"), beforeText, "原位 frontmatter 逐字节原值");
  assert.equal(loadGoal(before).meta.archived, undefined, "archived 不得被置位");
  assert.equal(
    readEvents(root).filter((e) => e.event === "goal.archived").length,
    0,
    "不得留下 goal.archived 事件",
  );

  archiveGoal(root, g, { actor: ACTOR });
  assert.equal(findGoalFile(root, g), target);
  assert.equal(loadGoal(target).meta.archived, true);
  assert.equal(readEvents(root).filter((e) => e.event === "goal.archived").length, 1);
});

test("g-395④：archiveGoal 落盘两窗口任一失败都可重试收敛", () => {
  for (const window of ["frontmatter", "relocate"] as const) {
    const root = tmpRoot();
    const g = createGoal(root, { title: "a", actor: ACTOR });
    const before = findGoalFile(root, g);
    const target = join(root, "backlog", "archived", `${g}.md`);
    const restore = failRenameTo(window === "frontmatter" ? before : target);

    const { err } = withFail(restore, () => archiveGoal(root, g, { actor: ACTOR }));
    assert.ok(err, `[${window}] 落盘失败必须抛错`);
    assert.match(err!.message, /persist 阶段/);
    assert.equal(diagnostics(root).length, 1, `[${window}] 必须补记诊断事件`);
    assert.ok(readEvents(root).some((e) => e.event === "goal.archived"), `[${window}] 事件已先行`);

    archiveGoal(root, g, { actor: ACTOR });
    assert.equal(findGoalFile(root, g), target, `[${window}] 重试后收敛到归档位置`);
    assert.equal(loadGoal(target).meta.archived, true);
  }
});

// ---------------------------------------------------------------------------
// ⑤ reportStatus：最高频写点
// ---------------------------------------------------------------------------

test("g-395⑤：reportStatus 事件失败 ⇒ attempt.md 逐字节原值，重试收敛", () => {
  const root = tmpRoot();
  const g = newStandaloneGoal(root);
  const attId = startAttempt(root, g, { executor: ACTOR, actor: ACTOR });
  const attFile = join(dirname(findGoalFile(root, g)), "attempts", attId, "attempt.md");
  const before = readFileSync(attFile, "utf8");

  const { err } = withFail(failEventAppend(root), () =>
    reportStatus(root, g, attId, "开工：审计中", ACTOR, "working"),
  );

  assert.ok(err, "事件追加失败必须抛错");
  assert.match(err!.message, /event 阶段/);
  assert.equal(readFileSync(attFile, "utf8"), before, "attempt.md 逐字节原值");
  assert.equal(loadGoal(attFile).meta.status_line, null);
  assert.equal(
    readEvents(root).filter((e) => e.event === "attempt.status_reported").length,
    0,
    "不得留下 attempt.status_reported 事件",
  );

  reportStatus(root, g, attId, "开工：审计中", ACTOR, "working");
  const doc = loadGoal(attFile);
  assert.equal(doc.meta.status_line, "开工：审计中");
  assert.equal(doc.meta.status_state, "working");
  assert.equal(readEvents(root).filter((e) => e.event === "attempt.status_reported").length, 1);
});

test("g-395⑤：reportStatus 落盘失败 ⇒ 事件先行 + 诊断 + 重试收敛", () => {
  const root = tmpRoot();
  const g = newStandaloneGoal(root);
  const attId = startAttempt(root, g, { executor: ACTOR, actor: ACTOR });
  const attFile = join(dirname(findGoalFile(root, g)), "attempts", attId, "attempt.md");

  const { err } = withFail(failRenameTo(attFile), () =>
    reportStatus(root, g, attId, "阻塞：等授权", ACTOR, "blocked"),
  );

  assert.ok(err, "落盘失败必须抛错");
  assert.match(err!.message, /persist 阶段/);
  assert.ok(
    readEvents(root).some(
      (e) => e.event === "attempt.status_reported" && e.details?.status === "阻塞：等授权",
    ),
    "事件已先行落盘",
  );
  assert.equal(diagnostics(root).length, 1);
  assert.equal(loadGoal(attFile).meta.status_line, null, "落盘失败时 status_line 未改");

  reportStatus(root, g, attId, "阻塞：等授权", ACTOR, "blocked");
  assert.equal(loadGoal(attFile).meta.status_line, "阻塞：等授权");
  assert.equal(loadGoal(attFile).meta.status_state, "blocked");
});
