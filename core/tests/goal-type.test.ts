/** g-158：目标类型（goal type）单元测试——类型读写、旧目标兼容、回退安全、事件。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeGoalType, GOAL_TYPES, DEFAULT_GOAL_TYPE, type GoalType } from "../model.ts";
import { init, createGoal, loadGoal, findGoalFile, setGoalType, boardProjection } from "../ops.ts";
import { readEvents } from "../events.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-type-test-"));
  init(dir);
  return dir;
}

// ---- normalizeGoalType ----

test("normalizeGoalType：合法类型原样返回", () => {
  assert.equal(normalizeGoalType("feature"), "feature");
  assert.equal(normalizeGoalType("bug"), "bug");
  assert.equal(normalizeGoalType("task"), "task");
  assert.equal(normalizeGoalType("improvement"), "improvement");
});

test("normalizeGoalType：大小写不敏感", () => {
  assert.equal(normalizeGoalType("Feature"), "feature");
  assert.equal(normalizeGoalType("BUG"), "bug");
  assert.equal(normalizeGoalType("  Task  "), "task");
});

test("normalizeGoalType：非法/未知类型安全回退 task（不抛错）", () => {
  assert.equal(normalizeGoalType("unknown"), "task");
  assert.equal(normalizeGoalType(""), "task");
  assert.equal(normalizeGoalType(null), "task");
  assert.equal(normalizeGoalType(undefined), "task");
  assert.equal(normalizeGoalType(123), "task");
  assert.equal(normalizeGoalType({}), "task");
});

test("normalizeGoalType：默认值等于 task", () => {
  assert.equal(DEFAULT_GOAL_TYPE, "task");
});

// ---- GOAL_TYPES 常量完整性 ----

test("GOAL_TYPES 包含四种固定类型", () => {
  assert.deepEqual([...GOAL_TYPES], ["feature", "bug", "task", "improvement"]);
});

// ---- createGoal 默认类型 ----

test("createGoal：不指定 type 时默认 task", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "测试目标", actor: "test" });
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  assert.equal(doc.meta.type, "task");
});

test("createGoal：指定 type 时持久化", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "Feature 目标", type: "feature", actor: "test" });
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  assert.equal(doc.meta.type, "feature");
});

test("createGoal：非法 type 回退 task", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "Bad type", type: "invalid", actor: "test" });
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  assert.equal(doc.meta.type, "task");
});

// ---- 旧目标兼容（缺少 type 字段）----

test("旧目标兼容：缺少 type 字段时 boardProjection 回退 task 且不改写文件", () => {
  const root = tmpRoot();
  const id = "g-old";
  const goalDir = join(root, "goals", id);
  mkdirSync(goalDir, { recursive: true });
  const goalFile = join(goalDir, "goal.md");
  const meta = { id, title: "旧目标", status: "draft", blocked_reason: null, created_at: "2026-01-01T00:00:00+08:00", created_by: "test", version: null, depends_on: [], review: { reviewer: "human", prompt: null }, pk: { lanes: 1, sandbox: "directory" }, rules_snapshot: null, skill_refs: [] };
  // 注意：没有 type 字段
  const body = "\n## 目标描述\n\n旧目标\n\n## 质量判据\n\n（待登记）\n";
  writeFileSync(goalFile, `---\n${JSON.stringify(meta, null, 2)}\n---\n${body}`, "utf8");

  const board = boardProjection(root);
  const goal = board.standalone.find((g) => g.id === id);
  assert.ok(goal, "应找到旧目标");
  assert.equal(goal.type, "task", "缺少 type 时应回退 task");

  // 不应改写原始文件：仍无 type 字段
  const reRead = JSON.parse(readFileSync(goalFile, "utf8").split("---")[1]);
  assert.ok(!("type" in reRead), "旧目标文件不应被改写（无 type 字段）");
});

// ---- setGoalType ----

test("setGoalType：正常设置并记录 goal.type_changed 事件", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "测试目标", type: "feature", actor: "test" });
  const result = setGoalType(root, id, { type: "bug", actor: "test" });
  assert.equal(result.old_type, "feature");
  assert.equal(result.new_type, "bug");
  // 验证文件已更新
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  assert.equal(doc.meta.type, "bug");
  // 验证事件写入 events.jsonl
  const events = readEvents(root);
  const typeChangedEvent = events.find((e) => e.event === "goal.type_changed" && e.goal === id);
  assert.ok(typeChangedEvent, "应存在 goal.type_changed 事件");
  assert.equal(typeChangedEvent.details.old_type, "feature");
  assert.equal(typeChangedEvent.details.new_type, "bug");
  assert.equal(typeChangedEvent.actor, "test");
});

test("setGoalType：相同类型视为 no-op（不写事件）", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "测试目标", actor: "test" });
  const result = setGoalType(root, id, { type: "task", actor: "test" });
  assert.equal(result.old_type, "task");
  assert.equal(result.new_type, "task");
  const events = readEvents(root);
  assert.ok(!events.some((e) => e.event === "goal.type_changed"), "相同类型不应记录事件");
});

test("setGoalType：非法类型安全回退 task", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "测试目标", type: "feature", actor: "test" });
  const result = setGoalType(root, id, { type: "bogus", actor: "test" });
  assert.equal(result.old_type, "feature");
  assert.equal(result.new_type, "task");
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  assert.equal(doc.meta.type, "task");
});

// ---- boardProjection 包含 type 字段 ----

test("boardProjection：目标包含 type 字段（默认/指定）", () => {
  const root = tmpRoot();
  createGoal(root, { title: "Feature", type: "feature", actor: "test" });
  createGoal(root, { title: "Bug", type: "bug", actor: "test" });
  createGoal(root, { title: "Task", actor: "test" }); // 默认 task
  const board = boardProjection(root);
  const goals = board.backlog;
  assert.equal(goals.length, 3);
  const feature = goals.find((g) => g.title === "Feature");
  const bug = goals.find((g) => g.title === "Bug");
  const task = goals.find((g) => g.title === "Task");
  assert.ok(feature);
  assert.ok(bug);
  assert.ok(task);
  assert.equal(feature.type, "feature");
  assert.equal(bug.type, "bug");
  assert.equal(task.type, "task");
});

// ---- 类型不影响生命周期语义 ----

test("setGoalType：类型变更不改变 status/version", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "测试目标", type: "feature", version: "v-t", actor: "test" });
  const before = loadGoal(findGoalFile(root, id));
  setGoalType(root, id, { type: "improvement", actor: "test" });
  const after = loadGoal(findGoalFile(root, id));
  assert.equal(after.meta.status, before.meta.status, "status 不应变化");
  assert.equal(after.meta.version, before.meta.version, "version 不应变化");
  assert.equal(after.meta.id, before.meta.id, "id 不应变化");
  assert.equal(after.meta.type, "improvement");
});
