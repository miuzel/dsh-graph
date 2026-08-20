/** 上下文卡片单元测试（node:test，零依赖）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  init,
  createGoal,
  startAttempt,
  addCard,
  fillCard,
  reviewCard,
  validate,
  rebuild,
  findGoalFile,
  loadGoal,
  GraphError,
} from "../ops.ts";
import { serializeDoc } from "../model.ts";
import { readEvents } from "../events.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-cards-"));
  init(dir);
  return dir;
}

test("add-card 建卡并按序登记 context_cards", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  const c1 = addCard(root, id, { title: "甲", kind: "text", actor: "test" });
  const c2 = addCard(root, id, { title: "乙", kind: "data", actor: "test" });
  const meta = loadGoal(findGoalFile(root, id)).meta;
  assert.deepEqual(meta.context_cards, [c1, c2]);
  const card = loadGoal(
    join(root, "versions", "v-t", "goals", id, "cards", `${c1}.md`),
  );
  assert.equal(card.meta.status, "empty");
  assert.equal(card.meta.goal, id);
});

test("非法 kind 与 backlog 目标建卡被拒绝", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  assert.throws(
    () => addCard(root, id, { title: "x", kind: "video", actor: "test" }),
    GraphError,
  );
  const bid = createGoal(root, { title: "b", actor: "test" }); // backlog 平铺
  assert.throws(
    () => addCard(root, bid, { title: "x", kind: "text", actor: "test" }),
    /先排期/,
  );
});

test("fill-card / review-card 生命周期与事件", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  const c = addCard(root, id, { title: "甲", kind: "text", actor: "test" });
  // 未填充不能复核
  assert.throws(
    () => reviewCard(root, id, c, { by: "human:a", actor: "test" }),
    /filled/,
  );
  fillCard(root, id, c, { text: "内容", by: "human:a", actor: "test" });
  reviewCard(root, id, c, { by: "human:b", actor: "test" });
  const card = loadGoal(
    join(root, "versions", "v-t", "goals", id, "cards", `${c}.md`),
  );
  assert.equal(card.meta.status, "reviewed");
  assert.equal(card.meta.filled_by, "human:a");
  assert.ok(card.body.includes("内容"));
  const events = readEvents(root).map((e) => e.event);
  assert.ok(events.includes("card.created"));
  assert.ok(events.includes("card.filled"));
  assert.ok(events.includes("card.reviewed"));
});

test("validate 发现悬空卡片引用；卡片事件不干扰 rebuild", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  const c = addCard(root, id, { title: "甲", kind: "text", actor: "test" });
  fillCard(root, id, c, { text: "x", by: "human:a", actor: "test" });
  assert.deepEqual(validate(root), []);
  assert.deepEqual(rebuild(root), []);
  // 塞入悬空引用
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  doc.meta.context_cards.push("card-ghost");
  writeFileSync(file, serializeDoc(doc), "utf8");
  const problems = validate(root);
  assert.ok(problems.some((p) => p.includes("悬空卡片引用")));
});

test("start-attempt / report-status 生命周期与事件", async () => {
  const { startAttempt, reportStatus } = await import("../ops.ts");
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  const att = startAttempt(root, id, { executor: "agent:test", actor: "test" });
  assert.equal(att, "att-001");
  reportStatus(root, id, att, "正在实现", "test");
  const file = join(root, "versions", "v-t", "goals", id, "attempts", att, "attempt.md");
  const meta = loadGoal(file).meta;
  assert.equal(meta.status_line, "正在实现");
  assert.throws(() => reportStatus(root, id, att, "  ", "test"), GraphError);
  assert.throws(() => reportStatus(root, id, "att-999", "x", "test"), GraphError);
  const events = readEvents(root).map((e) => e.event);
  assert.ok(events.includes("attempt.started"));
  assert.ok(events.includes("attempt.status_reported"));
});

test("boardProjection：版本/独立/backlog + status_line 投影", async () => {
  const { boardProjection, reportStatus } = await import("../ops.ts");
  const root = tmpRoot();
  const id = createGoal(root, { title: "目标甲", version: "v-t", actor: "test" });
  const att = startAttempt(root, id, { executor: "agent:t", actor: "test" });
  reportStatus(root, id, att, "正在写投影", "test");
  createGoal(root, { title: "暂存乙", actor: "test" });
  const b = boardProjection(root);
  assert.equal(b.versions.length, 1);
  assert.equal(b.versions[0].goals[0].status_line, "正在写投影");
  assert.equal(b.versions[0].goals[0].reviewer, "human");
  assert.equal(b.backlog.length, 1);
  assert.equal(b.standalone.length, 0);
});
