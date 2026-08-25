/** 目标暂缓单元测试（node:test，零依赖）。g-138 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  startAttempt,
  addCard,
  postponeGoal,
  findGoalFile,
  loadGoal,
  boardProjection,
  archiveGoal,
  validate,
  rebuild,
  GraphError,
} from "../ops.ts";
import { readEvents, replayStatuses } from "../events.ts";
import { serializeDoc } from "../model.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-postpone-"));
  init(dir);
  return dir;
}

test("postponeGoal：版本目标迁回 backlog 目录形态并置为 draft", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "暂缓版本", version: "v-t", actor: "test" });
  const before = findGoalFile(root, id);
  assert.ok(before.includes("/versions/v-t/goals/"), "迁移前在版本目录");

  postponeGoal(root, id, { actor: "test", reason: "负责人暂缓" });

  const after = findGoalFile(root, id);
  assert.ok(after.endsWith(`backlog/${id}/goal.md`), "迁移后落到 backlog 目录形态");
  assert.ok(!existsSync(before), "原文件应不存在");

  const doc = loadGoal(after);
  assert.equal(doc.meta.status, "draft");
  assert.equal(doc.meta.version, null);

  const ev = readEvents(root).filter((e) => e.event === "goal.postponed");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].goal, id);
  assert.equal(ev[0].details.reason, "负责人暂缓");
});

test("postponeGoal：独立目标迁回 backlog 目录形态", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "暂缓独立", version: "standalone", actor: "test" });

  postponeGoal(root, id, { actor: "test" });

  const after = findGoalFile(root, id);
  assert.ok(after.endsWith(`backlog/${id}/goal.md`));
  const doc = loadGoal(after);
  assert.equal(doc.meta.status, "draft");
  assert.equal(doc.meta.version, null);
});

test("postponeGoal：带卡片/attempt 的目标整体迁移到 backlog 目录", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "带附件暂缓", version: "v-t", actor: "test" });
  const card = addCard(root, id, { title: "卡片", kind: "text", actor: "test" });
  const att = startAttempt(root, id, { executor: "test", actor: "test" });

  // attempt 状态置为结束，避免被活跃检测拦截
  const attFile = join(root, "versions", "v-t", "goals", id, "attempts", att, "attempt.md");
  const adoc = loadGoal(attFile);
  adoc.meta.status_line = "完成";
  writeFileSync(attFile, serializeDoc(adoc), "utf8");

  postponeGoal(root, id, { actor: "test" });

  const after = findGoalFile(root, id);
  assert.ok(after.endsWith(`backlog/${id}/goal.md`));

  const goalDir = after.slice(0, after.length - "goal.md".length);
  assert.ok(existsSync(join(goalDir, "cards", `${card}.md`)), "卡片应随目标迁移");
  assert.ok(existsSync(join(goalDir, "attempts", att, "attempt.md")), "attempt 应随目标迁移");
});

test("postponeGoal：已在 backlog 的目标拒绝暂缓", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "backlog 目标", actor: "test" });
  assert.throws(
    () => postponeGoal(root, id, { actor: "test" }),
    (e) => e instanceof GraphError && e.message.includes("已在 backlog"),
    "backlog 目标应拒绝暂缓"
  );
});

test("postponeGoal：有进行中子代理时拒绝暂缓", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "活跃暂缓", version: "v-t", actor: "test" });
  const att = startAttempt(root, id, { executor: "test", actor: "test" });

  // 模拟子代理仍在进行中
  const attFile = join(root, "versions", "v-t", "goals", id, "attempts", att, "attempt.md");
  const adoc = loadGoal(attFile);
  adoc.meta.status_line = "正在实现";
  writeFileSync(attFile, serializeDoc(adoc), "utf8");

  assert.throws(
    () => postponeGoal(root, id, { actor: "test" }),
    (e) => e instanceof GraphError && e.message.includes("进行中的子代理"),
    "有活跃子代理时应拒绝暂缓"
  );
});

test("postponeGoal：子代理空闲/完成时允许暂缓", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "空闲暂缓", version: "v-t", actor: "test" });
  const att = startAttempt(root, id, { executor: "test", actor: "test" });

  const attFile = join(root, "versions", "v-t", "goals", id, "attempts", att, "attempt.md");
  const adoc = loadGoal(attFile);
  adoc.meta.status_line = "空闲待命";
  writeFileSync(attFile, serializeDoc(adoc), "utf8");

  postponeGoal(root, id, { actor: "test" });
  const after = findGoalFile(root, id);
  assert.ok(after.endsWith(`backlog/${id}/goal.md`));
});

test("goal.postponed 事件被 replay 正确处理为 draft", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "replay", version: "v-t", actor: "test" });
  postponeGoal(root, id, { actor: "test" });

  const events = readEvents(root);
  const statuses = replayStatuses(events);
  assert.equal(statuses.get(id), "draft", "replay 应返回 draft");
});

test("postponeGoal：rebuild 对账无 drift", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "rebuild", version: "v-t", actor: "test" });
  postponeGoal(root, id, { actor: "test" });

  const drift = rebuild(root);
  assert.deepEqual(drift, [], "rebuild 不应有 drift");
});

test("postponeGoal：validate 通过", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "validate", version: "v-t", actor: "test" });
  postponeGoal(root, id, { actor: "test" });

  const problems = validate(root);
  assert.equal(problems.length, 0, "暂缓后 validate 应通过");
});

test("postponeGoal：boardProjection 中暂缓目标出现在 backlog", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "投影测试", version: "v-t", actor: "test" });
  postponeGoal(root, id, { actor: "test" });

  const board = boardProjection(root);
  assert.equal(board.backlog.length, 1, "暂缓目标应出现在 backlog");
  assert.equal(board.backlog[0].id, id);
  assert.equal(board.backlog[0].status, "draft");
  // createGoal 会隐式创建版本泳道（version.md 存在），boardProjection 仍会返回该泳道（空 goals）
  // 只需断言该目标不在版本泳道内
  const verGoals = board.versions.find((v) => v.slug === "v-t")?.goals ?? [];
  assert.ok(!verGoals.some((g) => g.id === id), "暂缓后不应出现在版本泳道");
});

test("postponeGoal：失败时不留半迁移目录", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "失败测试", version: "v-t", actor: "test" });
  const att = startAttempt(root, id, { executor: "test", actor: "test" });

  // 模拟活跃子代理
  const attFile = join(root, "versions", "v-t", "goals", id, "attempts", att, "attempt.md");
  const adoc = loadGoal(attFile);
  adoc.meta.status_line = "正在实现";
  writeFileSync(attFile, serializeDoc(adoc), "utf8");

  assert.throws(() => postponeGoal(root, id, { actor: "test" }));

  // 原位置不变，backlog 目录不应创建
  const before = findGoalFile(root, id);
  assert.ok(before.includes("/versions/v-t/goals/"), "原位置应保留");
  assert.ok(!existsSync(join(root, "backlog", id)), "不应留下半迁移目录");
});
