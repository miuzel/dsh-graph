/** 目标删除单元测试（node:test，零依赖）。g-140 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  transition,
  setCriteria,
  archiveGoal,
  unarchiveGoal,
  deleteGoal,
  findGoalFile,
  loadGoal,
  saveGoal,
  boardProjection,
  validate,
  startAttempt,
  addCard,
  GraphError,
} from "../ops.ts";
import { readEvents, replayStatuses, appendEvent } from "../events.ts";
import { serializeDoc } from "../model.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-delete-"));
  init(dir);
  return dir;
}

// ---- 前置校验 1：仅已归档目标可删除 ----

test("deleteGoal：已归档 backlog 目标可删除", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "待删除", actor: "test" });
  archiveGoal(root, id, { actor: "test" });
  // 验证归档文件存在
  const archivedFile = join(root, "backlog", "archived", `${id}.md`);
  assert.ok(existsSync(archivedFile), "归档文件应存在");
  // 删除
  deleteGoal(root, id, { actor: "test" });
  // 验证文件已删除
  assert.ok(!existsSync(archivedFile), "归档文件应已删除");
  // 验证事件
  const events = readEvents(root).filter((e) => e.event === "goal.deleted");
  assert.equal(events.length, 1);
  assert.equal(events[0].goal, id);
  assert.equal(events[0].details.id, id);
});

test("deleteGoal：已归档版本目标可删除（含目录）", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "版本目标", version: "v-t", actor: "test" });
  archiveGoal(root, id, { actor: "test" });
  // 验证归档目录存在
  const archivedDir = join(root, "versions", "v-t", "archived", id);
  assert.ok(existsSync(archivedDir), "归档目录应存在");
  // 删除
  deleteGoal(root, id, { actor: "test" });
  // 验证目录已删除
  assert.ok(!existsSync(archivedDir), "归档目录应已删除");
});

test("deleteGoal：未归档目标拒绝删除", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "未归档", actor: "test" });
  assert.throws(
    () => deleteGoal(root, id, { actor: "test" }),
    (e) => e instanceof GraphError && e.message.includes("未归档"),
    "未归档目标应拒绝删除",
  );
});

test("deleteGoal：已归档独立目标可删除", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "独立目标", version: "standalone", actor: "test" });
  transition(root, id, "planning", { actor: "test" });
  setCriteria(root, id, ["测试判据"], "test");
  transition(root, id, "in_progress", { actor: "test" });
  transition(root, id, "review", { actor: "test" });
  transition(root, id, "delivered", { actor: "test" });
  archiveGoal(root, id, { actor: "test" });
  // 验证归档目录存在
  const archivedDir = join(root, "goals", "archived", id);
  assert.ok(existsSync(archivedDir), "归档目录应存在");
  // 删除
  deleteGoal(root, id, { actor: "test" });
  // 验证目录已删除
  assert.ok(!existsSync(archivedDir), "归档目录应已删除");
});

// ---- 前置校验 2：有活跃子代理时拒绝删除 ----

test("deleteGoal：有进行中子代理（status_line 在进行）时拒绝删除", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "有子代理", version: "v-t", actor: "test" });
  // 创建一个 attempt（默认 result=pending）
  const attId = startAttempt(root, id, { executor: "test", actor: "test" });
  // 子代理 status_line 表明仍在进行（非空闲/完成）——才视为活跃
  const attFile = join(root, "versions", "v-t", "goals", id, "attempts", attId, "attempt.md");
  const adoc = loadGoal(attFile);
  adoc.meta.status_line = "正在实现目标功能";
  writeFileSync(attFile, serializeDoc(adoc), "utf8");
  // 归档（planning 可归档）
  archiveGoal(root, id, { actor: "test" });
  // 尝试删除——应拒绝
  assert.throws(
    () => deleteGoal(root, id, { actor: "test" }),
    (e) => e instanceof GraphError && e.message.includes("进行中的子代理"),
    "有进行中子代理时应拒绝删除",
  );
});

test("deleteGoal：子代理 result=pending 但 status_line 为空闲/完成时允许删除", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "子代理空闲", version: "v-t", actor: "test" });
  const attId = startAttempt(root, id, { executor: "test", actor: "test" });
  // status_line 表明已空闲/完成——不视为活跃，允许删除
  const attFile = join(root, "versions", "v-t", "goals", id, "attempts", attId, "attempt.md");
  const adoc = loadGoal(attFile);
  adoc.meta.status_line = "空闲待命";
  writeFileSync(attFile, serializeDoc(adoc), "utf8");
  archiveGoal(root, id, { actor: "test" });
  deleteGoal(root, id, { actor: "test" });
  const archivedDir = join(root, "versions", "v-t", "archived", id);
  assert.ok(!existsSync(archivedDir), "空闲子代理目标应可删除");
});

test("deleteGoal：attempt 已结束（非 pending）时可删除", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "子代理已结束", version: "v-t", actor: "test" });
  // 创建一个 attempt 并手动设为非 pending
  const attId = startAttempt(root, id, { executor: "test", actor: "test" });
  // 手动修改 attempt 的 result 为 completed（模拟子代理结束）
  const attFile = join(root, "versions", "v-t", "goals", id, "attempts", attId, "attempt.md");
  const doc = loadGoal(attFile);
  doc.meta.result = "completed";
  writeFileSync(attFile, serializeDoc(doc), "utf8");
  // 归档
  archiveGoal(root, id, { actor: "test" });
  // 删除——应成功
  deleteGoal(root, id, { actor: "test" });
  const archivedDir = join(root, "versions", "v-t", "archived", id);
  assert.ok(!existsSync(archivedDir), "归档目录应已删除");
});

// ---- 删除含卡片的目标 ----

test("deleteGoal：含卡片的目标删除时卡片目录一并删除", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "含卡片", version: "v-t", actor: "test" });
  // 添加卡片
  addCard(root, id, { title: "测试卡片", kind: "text", actor: "test" });
  // 归档
  archiveGoal(root, id, { actor: "test" });
  // 验证卡片存在
  const archivedDir = join(root, "versions", "v-t", "archived", id);
  assert.ok(existsSync(join(archivedDir, "cards")), "归档后卡片目录应存在");
  // 删除
  deleteGoal(root, id, { actor: "test" });
  // 验证整个目录（含 cards）已删除
  assert.ok(!existsSync(archivedDir), "整个归档目录（含 cards）应已删除");
});

// ---- 事件流容忍 ----

test("goal.deleted 事件被 replay 正确处理", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "测试 replay", actor: "test" });
  archiveGoal(root, id, { actor: "test" });
  deleteGoal(root, id, { actor: "test" });
  // replayStatuses 应返回 deleted 终态
  const events = readEvents(root);
  const statuses = replayStatuses(events);
  assert.equal(statuses.get(id), "deleted", "replay 应返回 deleted 终态");
});

test("goal.deleted 后的事件被忽略", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "测试忽略", actor: "test" });
  archiveGoal(root, id, { actor: "test" });
  deleteGoal(root, id, { actor: "test" });
  // 手动追加一个 transition 事件（模拟残留事件）
  appendEvent(root, { actor: "test", event: "goal.transition", goal: id, details: { from: "draft", to: "planning" } });
  // replayStatuses 应仍返回 deleted
  const events = readEvents(root);
  const statuses = replayStatuses(events);
  assert.equal(statuses.get(id), "deleted", "deleted 后的事件应被忽略");
});

// ---- validate 容忍 ----

test("validate：已删除目标不报错（目标文件已不存在）", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "校验", actor: "test" });
  archiveGoal(root, id, { actor: "test" });
  deleteGoal(root, id, { actor: "test" });
  const problems = validate(root);
  assert.equal(problems.length, 0, "已删除目标不应有校验问题");
});

// ---- boardProjection 容忍 ----

test("boardProjection：已删除目标不出现在看板", () => {
  const root = tmpRoot();
  const id1 = createGoal(root, { title: "正常目标", actor: "test" });
  const id2 = createGoal(root, { title: "待删除", actor: "test" });
  archiveGoal(root, id2, { actor: "test" });
  deleteGoal(root, id2, { actor: "test" });
  const board = boardProjection(root, { includeArchived: true });
  assert.equal(board.backlog.length, 1, "已删除目标不应出现在看板");
  assert.equal(board.backlog[0].id, id1);
});
