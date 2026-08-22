/** 目标归档/取消归档单元测试（node:test，零依赖）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  transition,
  setCriteria,
  archiveGoal,
  unarchiveGoal,
  findGoalFile,
  loadGoal,
  boardProjection,
  validate,
  GraphError,
} from "../ops.ts";
import { readEvents } from "../events.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-archive-"));
  init(dir);
  return dir;
}

test("archiveGoal：draft 状态可归档，移动到正确位置", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "测试归档", actor: "test" });
  // draft 状态可归档
  archiveGoal(root, id, { actor: "test" });
  // 验证文件移动到 backlog/archived/
  const archivedFile = join(root, "backlog", "archived", `${id}.md`);
  assert.ok(existsSync(archivedFile), "归档文件应存在");
  // 验证原位置不存在
  const originalFile = join(root, "backlog", `${id}.md`);
  assert.ok(!existsSync(originalFile), "原文件不应存在");
  // 验证 meta.archived = true
  const doc = loadGoal(archivedFile);
  assert.equal(doc.meta.archived, true, "应标记为已归档");
  // 验证事件
  const events = readEvents(root).filter((e) => e.event === "goal.archived");
  assert.equal(events.length, 1);
  assert.equal(events[0].goal, id);
});

test("archiveGoal：planning 状态可归档（版本目标）", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "版本目标", version: "v-t", actor: "test" });
  // planning 状态可归档
  archiveGoal(root, id, { actor: "test" });
  // 验证文件移动到 versions/v-t/archived/
  const archivedFile = join(root, "versions", "v-t", "archived", id, "goal.md");
  assert.ok(existsSync(archivedFile), "归档文件应存在");
  const doc = loadGoal(archivedFile);
  assert.equal(doc.meta.archived, true);
});

test("archiveGoal：delivered 状态可归档（独立目标）", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "独立目标", version: "standalone", actor: "test" });
  transition(root, id, "planning", { actor: "test" });
  setCriteria(root, id, ["测试判据"], "test");
  transition(root, id, "in_progress", { actor: "test" });
  transition(root, id, "review", { actor: "test" });
  transition(root, id, "delivered", { actor: "test" });
  // delivered 状态可归档
  archiveGoal(root, id, { actor: "test" });
  // 验证文件移动到 goals/archived/
  const archivedFile = join(root, "goals", "archived", id, "goal.md");
  assert.ok(existsSync(archivedFile), "归档文件应存在");
  const doc = loadGoal(archivedFile);
  assert.equal(doc.meta.archived, true);
});

test("archiveGoal：非 draft/planning/delivered 状态拒绝归档", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "测试拒绝", version: "v-t", actor: "test" });
  // planning → collecting
  transition(root, id, "collecting", { actor: "test" });
  // collecting 状态不可归档
  assert.throws(
    () => archiveGoal(root, id, { actor: "test" }),
    (e) => e instanceof GraphError && e.message.includes("只有 draft/planning/delivered 可归档"),
    "collecting 状态应拒绝归档"
  );
});

test("unarchiveGoal：取消归档移回原位置，状态保持", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "测试取消归档", version: "v-t", actor: "test" });
  // 归档
  archiveGoal(root, id, { actor: "test" });
  const archivedFile = join(root, "versions", "v-t", "archived", id, "goal.md");
  assert.ok(existsSync(archivedFile));
  // 取消归档
  unarchiveGoal(root, id, { actor: "test" });
  // 验证文件移回原位置
  const restoredFile = join(root, "versions", "v-t", "goals", id, "goal.md");
  assert.ok(existsSync(restoredFile), "恢复文件应存在");
  assert.ok(!existsSync(archivedFile), "归档文件不应存在");
  // 验证 meta.archived = false
  const doc = loadGoal(restoredFile);
  assert.equal(doc.meta.archived, false, "应清除归档标记");
  // 验证事件
  const events = readEvents(root).filter((e) => e.event === "goal.unarchived");
  assert.equal(events.length, 1);
});

test("unarchiveGoal：未归档目标拒绝取消归档", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "未归档目标", actor: "test" });
  assert.throws(
    () => unarchiveGoal(root, id, { actor: "test" }),
    (e) => e instanceof GraphError && e.message.includes("未归档"),
    "未归档目标应拒绝取消归档"
  );
});

test("boardProjection：默认不含已归档目标", () => {
  const root = tmpRoot();
  const id1 = createGoal(root, { title: "正常目标", actor: "test" });
  const id2 = createGoal(root, { title: "归档目标", actor: "test" });
  archiveGoal(root, id2, { actor: "test" });
  // 默认不含归档
  const board = boardProjection(root);
  assert.equal(board.backlog.length, 1, "默认应只显示 1 个目标");
  assert.equal(board.backlog[0].id, id1);
  assert.equal(board.backlog[0].archived, false);
});

test("boardProjection：includeArchived=true 包含已归档目标并标记", () => {
  const root = tmpRoot();
  const id1 = createGoal(root, { title: "正常目标", actor: "test" });
  const id2 = createGoal(root, { title: "归档目标", actor: "test" });
  archiveGoal(root, id2, { actor: "test" });
  // 包含归档
  const board = boardProjection(root, { includeArchived: true });
  assert.equal(board.backlog.length, 2, "应显示 2 个目标");
  const archivedGoal = board.backlog.find((g) => g.id === id2);
  assert.ok(archivedGoal, "归档目标应存在");
  assert.equal(archivedGoal.archived, true, "应标记为已归档");
  const normalGoal = board.backlog.find((g) => g.id === id1);
  assert.ok(normalGoal);
  assert.equal(normalGoal.archived, false);
});

test("validate：归档目标通过校验", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "归档校验", version: "v-t", actor: "test" });
  archiveGoal(root, id, { actor: "test" });
  const problems = validate(root);
  assert.equal(problems.length, 0, "归档目标不应有校验问题");
});
