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
  nextGoalSeq,
  listGoalFiles,
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

test("g-234 编号不回退：创建 g-005→归档 g-005→新建得 g-006", () => {
  const root = tmpRoot();
  const g1 = createGoal(root, { title: "g1", actor: "test" });
  const g2 = createGoal(root, { title: "g2", actor: "test" });
  const g3 = createGoal(root, { title: "g3", actor: "test" });
  const g4 = createGoal(root, { title: "g4", actor: "test" });
  const g5 = createGoal(root, { title: "g5", actor: "test" });

  assert.equal(g1, "g-001");
  assert.equal(g5, "g-005");

  // 归档最大编号目标 g-005
  archiveGoal(root, g5, { actor: "test" });

  // 判据 3：listGoalFiles() 默认行为不变（不含已归档）
  const activeFiles = listGoalFiles(root);
  assert.equal(activeFiles.length, 4, "默认 listGoalFiles 仅返回存活目标");
  assert.ok(!activeFiles.some((f) => f.includes("g-005")), "存活目标列表中不应包含 g-005");

  // 判据 1：nextGoalSeq() 返回值严格大于所有已存在 meta.id（含已归档）
  const nextSeq = nextGoalSeq(root);
  assert.equal(nextSeq, "g-006", "nextGoalSeq 应为 g-006，不因 g-005 归档而回退");

  // 新建目标得到 g-006，不复用已归档的 g-005
  const g6 = createGoal(root, { title: "g6", actor: "test" });
  assert.equal(g6, "g-006", "新建目标应获得 g-006");

  // 全量目标（含已归档）均无 id 重复
  const allFiles = listGoalFiles(root, { includeArchived: true });
  const allIds = allFiles.map((f) => loadGoal(f).meta.id);
  assert.equal(new Set(allIds).size, allIds.length, "所有目标 id 必须唯一无重复");
  assert.ok(allIds.includes("g-005") && allIds.includes("g-006"));
});

test("g-234 编号不回退：多个归档目标编号不连续时取全局历史最大值+1", () => {
  const root = tmpRoot();
  // 创建若干目标，分布在版本、独立目标与 backlog 中
  const g1 = createGoal(root, { title: "g1", actor: "test" }); // g-001 backlog
  const g2 = createGoal(root, { title: "g2", actor: "test" }); // g-002 backlog
  const g3 = createGoal(root, { title: "g3", version: "v1", actor: "test" }); // g-003 version
  const g4 = createGoal(root, { title: "g4", actor: "test" }); // g-004 backlog
  const g5 = createGoal(root, { title: "g5", version: "v1", actor: "test" }); // g-005 version
  const g6 = createGoal(root, { title: "g6", actor: "test" }); // g-006 backlog
  const g7 = createGoal(root, { title: "g7", actor: "test" }); // g-007 backlog
  const g8 = createGoal(root, { title: "g8", version: "standalone", actor: "test" }); // g-008 standalone

  assert.equal(g8, "g-008");

  // 归档不连续的编号：g-003(版本目标), g-005(版本目标), g-007(backlog目标)
  archiveGoal(root, g3, { actor: "test" });
  archiveGoal(root, g5, { actor: "test" });
  archiveGoal(root, g7, { actor: "test" });

  // 独立目标 g-008 经过正常流程后归档
  transition(root, g8, "planning", { actor: "test" });
  setCriteria(root, g8, ["判据1"], "test");
  transition(root, g8, "in_progress", { actor: "test" });
  transition(root, g8, "review", { actor: "test" });
  transition(root, g8, "delivered", { actor: "test" });
  archiveGoal(root, g8, { actor: "test" });

  // 此时存活目标为 g-001, g-002, g-004, g-006（存活最大编号仅为 6）
  // 已归档目标为 g-003, g-005, g-007, g-008（全局历史最大值为 8）
  const activeIds = listGoalFiles(root).map((f) => loadGoal(f).meta.id);
  assert.deepEqual(activeIds.sort(), ["g-001", "g-002", "g-004", "g-006"]);

  // 检查 nextGoalSeq：应取全局历史最大值 8 + 1 = 9
  assert.equal(nextGoalSeq(root), "g-009");

  // 新建目标验证
  const g9 = createGoal(root, { title: "g9", actor: "test" });
  assert.equal(g9, "g-009");

  // 再次验证全局无重复
  const allFiles = listGoalFiles(root, { includeArchived: true });
  const allIds = allFiles.map((f) => loadGoal(f).meta.id);
  assert.equal(new Set(allIds).size, allIds.length, "全局目标 id 唯一");
  assert.ok(allIds.includes("g-008") && allIds.includes("g-009"));
});
