/** renameGoal 单元测试（node:test，零依赖）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renameGoal, init, createGoal, findGoalFile, loadGoal, GraphError } from "../ops.ts";
import { readEvents } from "../events.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-rename-"));
  init(dir);
  return dir;
}

test("正常重命名：更新 title + 记录事件", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "旧标题", actor: "test" });
  const result = renameGoal(root, id, { title: "新标题", actor: "test" });
  assert.equal(result.old_title, "旧标题");
  assert.equal(result.new_title, "新标题");

  // 验证 goal.md 已更新
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  assert.equal(doc.meta.title, "新标题");

  // 验证事件流
  const events = readEvents(root);
  const renamed = events.find(e => e.goal === id && e.event === "goal.renamed");
  assert.ok(renamed);
  assert.equal(renamed.details.old_title, "旧标题");
  assert.equal(renamed.details.new_title, "新标题");
});

test("标题去首尾空白", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "旧标题", actor: "test" });
  const result = renameGoal(root, id, { title: "  新标题  ", actor: "test" });
  assert.equal(result.new_title, "新标题");

  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  assert.equal(doc.meta.title, "新标题");
});

test("标题为空抛 GraphError", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "旧标题", actor: "test" });
  assert.throws(() => {
    renameGoal(root, id, { title: "", actor: "test" });
  }, GraphError);
  assert.throws(() => {
    renameGoal(root, id, { title: "   ", actor: "test" });
  }, GraphError);
});

test("相同标题为 no-op（不记事件）", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "相同标题", actor: "test" });
  const result = renameGoal(root, id, { title: "相同标题", actor: "test" });
  assert.equal(result.old_title, "相同标题");
  assert.equal(result.new_title, "相同标题");

  // 验证没有 goal.renamed 事件
  const events = readEvents(root);
  const renamed = events.filter(e => e.goal === id && e.event === "goal.renamed");
  assert.equal(renamed.length, 0);
});

test("目标不存在抛 GraphError", () => {
  const root = tmpRoot();
  assert.throws(() => {
    renameGoal(root, "g-999", { title: "新标题", actor: "test" });
  }, GraphError);
});

test("多次重命名：每次正确记录旧/新标题", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "初始标题", actor: "test" });

  renameGoal(root, id, { title: "第二次标题", actor: "test" });
  renameGoal(root, id, { title: "第三次标题", actor: "test" });

  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  assert.equal(doc.meta.title, "第三次标题");

  const events = readEvents(root);
  const renamedEvents = events.filter(e => e.goal === id && e.event === "goal.renamed");
  assert.equal(renamedEvents.length, 2);
  assert.equal(renamedEvents[0].details.old_title, "初始标题");
  assert.equal(renamedEvents[0].details.new_title, "第二次标题");
  assert.equal(renamedEvents[1].details.old_title, "第二次标题");
  assert.equal(renamedEvents[1].details.new_title, "第三次标题");
});
