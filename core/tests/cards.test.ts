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
