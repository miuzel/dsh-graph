/** g-403：`moveGoal` 搬迁时改写 status 却不记 `goal.transition` ⇒ 事件流无法重建 status，
 *  `rebuild` 在**完全正常的排期路径**上恒报 drift（`init → createGoal → moveGoal(backlog→standalone)
 *  → rebuild` 报 `frontmatter=planning 与事件流重建=draft 不一致`）。
 *
 *  本文件钉住三件事：
 *  ① 搬迁改状态时必须与 goal.moved **同一次 commit**（事件先行）落 `goal.transition`（from/to/
 *     reason/actor），使 `replayStatuses` 能独立重建出与 frontmatter 一致的 status。形态覆盖：
 *     backlog→standalone、backlog→version（隐式泳道）、standalone→version（状态未变，不补记）、
 *     version→version（跨版本，不补记）、version→backlog（planning→draft）、delivered 保留、
 *     以及 no-op 迁移（targetFile===file）**不得**补记（否则制造「事件说变了、磁盘没变」）。
 *  ② 负向对照：把历史形态数据（有 goal.moved、无 goal.transition——即修复前的写入结果）喂给
 *     `rebuild` ⇒ 必须在「事件流重建 status」这条**实质断言**上转红（drift 非空），不是靠文案。
 *     代码回退验证见交回报文（git checkout 回退 ops.ts 后本文件相关例转红）。
 *  ③ 历史数据只给**只读诊断**（validate 报出成因与处置建议），绝不伪造补记事件、也不放宽
 *     `rebuild` 语义（断言 events.jsonl 字节与事件条数在 validate/rebuild 前后不变）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  transition,
  moveGoal,
  findGoalFile,
  loadGoal,
  rebuild,
  validate,
} from "../ops.ts";
import { readEvents, replayStatuses, appendEvent } from "../events.ts";

const ACTOR = "agent:executor";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g403-"));
  init(dir);
  return dir;
}

/** 从事件流独立重建 status（rebuild 的对账口径），与 frontmatter 对比。 */
function replayedStatus(root: string, id: string): string | undefined {
  return replayStatuses(readEvents(root)).get(id);
}

function frontmatterStatus(root: string, id: string): string {
  return String(loadGoal(findGoalFile(root, id)).meta.status);
}

/** 断言：事件流能独立重建出与 frontmatter 一致的 status，且 rebuild 无任何 drift。 */
function assertStreamRebuildsStatus(root: string, id: string): void {
  assert.equal(
    replayedStatus(root, id),
    frontmatterStatus(root, id),
    "事件流必须能独立重建出与 frontmatter 一致的 status（g-403 的核心不变量）",
  );
  assert.deepEqual(rebuild(root), [], "正常排期路径不得报 drift");
}

/** 该目标的 goal.transition 事件（按事件流顺序）。 */
function transitionsOf(root: string, id: string): any[] {
  return readEvents(root).filter((e) => e.goal === id && e.event === "goal.transition");
}

// ---------------------------------------------------------------------------
// ① 各形态：搬迁改状态 ⇒ 同一次 commit 补记 goal.transition
// ---------------------------------------------------------------------------

test("g-403①：backlog→standalone（draft→planning）补记 goal.transition，事件流可独立重建 status", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "排期进入独立目标", actor: ACTOR });
  assert.equal(frontmatterStatus(root, g), "draft");
  assert.equal(transitionsOf(root, g).length, 0, "createGoal 不得产生 transition");

  moveGoal(root, g, { to: "standalone", actor: ACTOR });

  assert.equal(frontmatterStatus(root, g), "planning");
  const ts = transitionsOf(root, g);
  assert.equal(ts.length, 1, "搬迁改状态必须补记恰好一条 goal.transition");
  const d = ts[0].details;
  assert.equal(d.from, "draft");
  assert.equal(d.to, "planning");
  assert.equal(d.actor, ACTOR, "details.actor 必须留痕");
  assert.equal(ts[0].actor, ACTOR, "事件顶层 actor 必须留痕");
  assert.ok(typeof d.reason === "string" && d.reason.length > 0, "reason 必须非空");

  // 事件顺序：goal.moved（归属变更）后紧随本次搬迁派生的 goal.transition；两者都在事件流中
  const order = readEvents(root).filter((e) => e.goal === g).map((e) => e.event);
  assert.deepEqual(order, ["goal.created", "goal.moved", "goal.transition"]);

  assertStreamRebuildsStatus(root, g);
});

test("g-403①：backlog→version（隐式泳道，draft→planning）补记 goal.transition", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "排期进入版本", actor: ACTOR });

  moveGoal(root, g, { to: "version", version: "v403-a", actor: ACTOR });

  assert.equal(frontmatterStatus(root, g), "planning");
  const ts = transitionsOf(root, g);
  assert.equal(ts.length, 1);
  assert.deepEqual([ts[0].details.from, ts[0].details.to], ["draft", "planning"]);
  // 隐式 version.created 仍是本事务第一条；transition 与 goal.moved 同批落盘
  const order = readEvents(root).filter((e) => e.goal === g).map((e) => e.event);
  assert.deepEqual(order, ["goal.created", "goal.moved", "goal.transition"]);

  assertStreamRebuildsStatus(root, g);
});

test("g-403①：standalone→version 状态未变（planning）⇒ 不补记 transition，仍无 drift", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "状态未变", actor: ACTOR });
  moveGoal(root, g, { to: "standalone", actor: ACTOR });
  const before = transitionsOf(root, g).length;

  moveGoal(root, g, { to: "version", version: "v403-b", actor: ACTOR });

  assert.equal(frontmatterStatus(root, g), "planning", "位置变更不改状态");
  assert.equal(transitionsOf(root, g).length, before, "状态未变不得凭空补记 transition");
  assert.equal(
    readEvents(root).filter((e) => e.goal === g && e.event === "goal.moved").length,
    2,
  );
  assertStreamRebuildsStatus(root, g);
});

test("g-403①：version→version（跨版本）不补记 transition，仍无 drift", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "跨版本", version: "v403-c1", actor: ACTOR });
  const before = transitionsOf(root, g).length; // 带 version 创建 ⇒ 初始即 planning

  moveGoal(root, g, { to: "version", version: "v403-c2", actor: ACTOR });

  assert.equal(frontmatterStatus(root, g), "planning");
  assert.equal(transitionsOf(root, g).length, before, "跨版本状态不变，不得补记 transition");
  assertStreamRebuildsStatus(root, g);
});

test("g-403①：version→backlog（planning→draft）补记 transition，事件流可独立重建 status", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "退回 backlog", version: "v403-d", actor: ACTOR });
  assert.equal(frontmatterStatus(root, g), "planning");

  moveGoal(root, g, { to: "backlog", actor: ACTOR });

  assert.equal(frontmatterStatus(root, g), "draft");
  const ts = transitionsOf(root, g);
  assert.equal(ts.length, 1, "回退 backlog 改状态同样必须补记");
  assert.deepEqual([ts[0].details.from, ts[0].details.to], ["planning", "draft"]);
  assert.equal(join(root, "backlog", `${g}.md`), findGoalFile(root, g));
  assertStreamRebuildsStatus(root, g);
});

test("g-403①：delivered 状态在 standalone↔version 迁移中保留（不补记）+ rebuild 无 drift", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "delivered 保留", actor: ACTOR });
  moveGoal(root, g, { to: "standalone", actor: ACTOR }); // draft→planning（补记 1 条）
  const afterFirst = transitionsOf(root, g).length;
  assert.equal(afterFirst, 1);

  // 正常推进到 delivered（g-147 场景）
  setCriteria(root, g, ["测试判据"], ACTOR);
  transition(root, g, "collecting", { actor: ACTOR });
  transition(root, g, "ready", { actor: ACTOR });
  transition(root, g, "in_progress", { actor: ACTOR });
  transition(root, g, "review", { actor: ACTOR });
  transition(root, g, "delivered", { actor: ACTOR });
  const afterDelivered = transitionsOf(root, g).length;

  // delivered → version / version → standalone：状态保留 ⇒ 不补记 transition
  moveGoal(root, g, { to: "version", version: "v403-e", actor: ACTOR });
  assert.equal(frontmatterStatus(root, g), "delivered");
  moveGoal(root, g, { to: "standalone", actor: ACTOR });
  assert.equal(frontmatterStatus(root, g), "delivered");
  assert.equal(transitionsOf(root, g).length, afterDelivered, "delivered 迁移不改状态 ⇒ 不补记");
  assertStreamRebuildsStatus(root, g);
});

test("g-403①：no-op 迁移（targetFile===file）不得补记 transition（否则制造新 drift）", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "no-op", version: "v403-f", actor: ACTOR });
  const file = findGoalFile(root, g);
  const before = transitionsOf(root, g).length;
  const bytes = readFileSync(file, "utf8");

  moveGoal(root, g, { to: "version", version: "v403-f", actor: ACTOR }); // 同一位置：no-op

  assert.equal(findGoalFile(root, g), file, "no-op 迁移位置不变");
  assert.equal(readFileSync(file, "utf8"), bytes, "no-op 迁移 frontmatter 逐字节原值");
  assert.equal(transitionsOf(root, g).length, before, "no-op 未落盘状态改变 ⇒ 不得记事件");
  assertStreamRebuildsStatus(root, g);
});

// ---------------------------------------------------------------------------
// ② 负向对照：历史形态（有 goal.moved、无 goal.transition）⇒ rebuild 必红
// ---------------------------------------------------------------------------

/** 复刻**修复前** moveGoal 的写入结果：保留 goal.moved，抹掉该搬迁派生的 goal.transition。
 *  （对修复前的代码，本函数抹不掉任何东西——数据本就是该形态。） */
function stripMoveTransitions(root: string, id: string): void {
  const evFile = join(root, "events.jsonl");
  const kept = readFileSync(evFile, "utf8")
    .split("\n")
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        const ev = JSON.parse(line);
        return !(ev.goal === id && ev.event === "goal.transition");
      } catch {
        return true;
      }
    });
  writeFileSync(evFile, kept.join("\n") + "\n", "utf8");
}

test("g-403②（负向对照）：缺 goal.transition 的搬迁 ⇒ rebuild 在「事件流重建 status」上转红", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "历史形态", actor: ACTOR });
  moveGoal(root, g, { to: "standalone", actor: ACTOR });
  stripMoveTransitions(root, g); // ← 还原修复前的数据形态

  const replayed = replayedStatus(root, g);
  assert.equal(replayed, "draft", "缺事件 ⇒ 事件流只能重建出 draft（诚实反映缺失）");
  assert.notEqual(replayed, frontmatterStatus(root, g), "frontmatter=planning（搬迁改过）");

  const drift = rebuild(root).filter((d) => d.startsWith(`${g}:`));
  assert.equal(drift.length, 1, "重建与 frontmatter 的不一致必须被报出，不得被容忍");
  assert.match(
    drift[0],
    /与事件流重建=draft 不一致/,
    "红点必须落在「事件流重建 status」这条实质断言上",
  );
});

// ---------------------------------------------------------------------------
// ③ 历史数据：只读诊断，不伪造补记、不放宽 rebuild
// ---------------------------------------------------------------------------

test("g-403③：历史缺事件搬迁只给只读诊断；validate/rebuild 零写入、零伪造补记", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "历史数据诊断", actor: ACTOR });
  moveGoal(root, g, { to: "version", version: "v403-g", actor: ACTOR });
  stripMoveTransitions(root, g); // 还原修复前的数据形态

  const evFile = join(root, "events.jsonl");
  const digest = (): string => createHash("sha256").update(readFileSync(evFile)).digest("hex");
  const beforeHash = digest();
  const beforeCount = readEvents(root).length;

  const problems = validate(root);
  const hit = problems.filter((p) => p.startsWith(`${g}:`) && p.includes("goal.transition"));
  assert.equal(hit.length, 1, "validate 必须报出该历史搬迁的成因诊断");
  assert.match(hit[0], /只读诊断/);
  assert.match(hit[0], /不自动补记事件/);
  assert.match(hit[0], /frontmatter=planning 与事件流重建=draft/);

  const drift = rebuild(root).filter((d) => d.startsWith(`${g}:`));
  assert.match(drift[0] ?? "", /与事件流重建=draft 不一致/, "rebuild 语义不得被放宽来容忍");

  assert.equal(digest(), beforeHash, "诊断/对账不得写事件流（禁止伪造补记）");
  assert.equal(readEvents(root).length, beforeCount, "事件条数不得变化");
  assert.equal(transitionsOf(root, g).length, 0, "不得凭空补出 goal.transition");
});

test("g-403③：正常搬迁后的看板不再触发该只读诊断（修复后不制造新历史数据）", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "正常路径", actor: ACTOR });
  moveGoal(root, g, { to: "standalone", actor: ACTOR });
  moveGoal(root, g, { to: "version", version: "v403-h", actor: ACTOR });

  assert.deepEqual(
    validate(root).filter((p) => p.includes("goal.transition")),
    [],
    "修复后的搬迁带事件，不得被误报为历史缺事件",
  );
  assert.equal(replayedStatus(root, g), frontmatterStatus(root, g));
});

test("g-403③：事件先行下的 persist 滞后（事件已记）不得被误报为「缺 goal.transition」", () => {
  const root = tmpRoot();
  const g = createGoal(root, { title: "persist 滞后", actor: ACTOR });
  // 复刻 winB 形态：goal.moved + goal.transition 都已先行落盘，但文件仍停在 backlog/draft
  appendEvent(root, {
    actor: ACTOR,
    event: "goal.moved",
    goal: g,
    details: { from: `backlog/${g}.md`, to: `goals/${g}/goal.md` },
  });
  appendEvent(root, {
    actor: ACTOR,
    event: "goal.transition",
    goal: g,
    details: { from: "draft", to: "planning", reason: "move-goal → standalone：位置变更附带的状态调整", actor: ACTOR },
  });
  assert.equal(frontmatterStatus(root, g), "draft", "persist 未跟上：磁盘仍是 draft");
  assert.equal(replayedStatus(root, g), "planning", "事件流已记 planning");

  assert.deepEqual(
    validate(root).filter((p) => p.startsWith(`${g}:`) && p.includes("缺 goal.transition")),
    [],
    "事件流已记录该 status ⇒ 是落盘滞后（tx.persist_failed 负责），不是缺事件",
  );
  // 通用 drift 仍须如实报出（不放宽 rebuild）
  assert.match(
    rebuild(root).find((d) => d.startsWith(`${g}:`)) ?? "",
    /与事件流重建=planning 不一致/,
  );
});
