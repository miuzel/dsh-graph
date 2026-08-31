/** g-170：判据编辑保存（方案 A）核心测试——updateCriteria / rebuildCriteriaSection。
 *  覆盖：trim/去重/1..N 重排、注释/未知内容保留、D3 空列表按状态、D5 criteria.updated
 *  事件语义（不冒充 confirmed、不写 rules_snapshot）、D8 base_items 并发冲突与 force 覆盖。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  updateCriteria,
  transition,
  findGoalFile,
  loadGoal,
  saveGoal,
  boardProjection,
  GraphError,
  GraphConflictError,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { criteriaItems, rebuildCriteriaSection, replaceSection, sectionText } from "../model.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-crit-"));
  init(dir);
  return dir;
}

test("rebuildCriteriaSection：替换判据项行、保留注释/空行/占位", () => {
  const raw = "\n<!-- 登记说明 -->\n\n1. 甲\n2. 乙\n\n（待登记）\n";
  const next = rebuildCriteriaSection(raw, ["新甲", "新乙", "新丙"]);
  // 注释保留、占位在有实质判据时移除、判据 1..N 重排
  assert.ok(next.includes("<!-- 登记说明 -->"));
  assert.ok(!next.includes("（待登记）"));
  assert.ok(next.includes("1. 新甲\n2. 新乙\n3. 新丙"));
  // 判据顺序语义
  assert.deepEqual(criteriaItems("## 质量判据\n" + next), ["1. 新甲", "2. 新乙", "3. 新丙"]);
});

test("rebuildCriteriaSection：清空时删除判据项但保留占位/注释", () => {
  const raw = "<!-- 说明 -->\n1. 甲\n2. 乙\n";
  const next = rebuildCriteriaSection(raw, []);
  assert.ok(next.includes("<!-- 说明 -->"));
  assert.ok(!next.includes("1. 甲"));
  assert.ok(!next.includes("2. 乙"));
});

test("rebuildCriteriaSection：无既有项时文末追加新列表", () => {
  const next = rebuildCriteriaSection("<!-- 只有注释 -->\n", ["甲"]);
  assert.ok(next.includes("<!-- 只有注释 -->"));
  assert.ok(next.includes("1. 甲"));
});

test("updateCriteria：trim、丢弃空行、按 1..N 重排写入", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  updateCriteria(root, id, { items: ["  甲  ", "", " 乙 ", " 丙  "], actor: "test" });
  const doc = loadGoal(findGoalFile(root, id));
  assert.deepEqual(criteriaItems(doc.body), ["1. 甲", "2. 乙", "3. 丙"]);
});

test("updateCriteria：重复文本拒绝（trim 后精确匹配）", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  assert.throws(
    () => updateCriteria(root, id, { items: ["甲", " 甲 "], actor: "test" }),
    /重复/,
  );
});

test("updateCriteria：D3 空列表草稿允许、in_progress/review/delivered 拒绝", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  // draft 状态清空允许
  updateCriteria(root, id, { items: [], actor: "test" });
  assert.equal(criteriaItems(loadGoal(findGoalFile(root, id)).body).length, 0);
  // 进入 in_progress 后清空拒绝
  setCriteria(root, id, ["判据"], "test"); // 登记（confirm 路径；带 version 的目标初始即 planning）
  transition(root, id, "collecting", { actor: "test" });
  transition(root, id, "ready", { actor: "test" });
  transition(root, id, "in_progress", { actor: "test" });
  assert.throws(
    () => updateCriteria(root, id, { items: [], actor: "test" }),
    /不允许清空质量判据/,
  );
  // review 同样拒绝
  transition(root, id, "review", { actor: "test" });
  assert.throws(
    () => updateCriteria(root, id, { items: [], actor: "test" }),
    /不允许清空质量判据/,
  );
});

test("updateCriteria：D5 记录 criteria.updated，不冒充 criteria.confirmed，不写 rules_snapshot", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  updateCriteria(root, id, { items: ["甲"], actor: "test" });
  const events = readEvents(root).filter((e) => e.goal === id);
  const updated = events.filter((e) => e.event === "criteria.updated");
  assert.equal(updated.length, 1);
  assert.equal(updated[0].details.criteria_count, 1);
  // 绝不自动 criteria.confirmed
  assert.equal(events.some((e) => e.event === "criteria.confirmed"), false);
  // 不触碰 rules_snapshot（执行确认门槛保留给 setCriteria/accept）
  const doc = loadGoal(findGoalFile(root, id));
  assert.equal(doc.meta.rules_snapshot, null);
  // 进入 in_progress 仍被既有门槛拦截（无 confirmed 事件）
  transition(root, id, "collecting", { actor: "test" });
  transition(root, id, "ready", { actor: "test" });
  assert.throws(() => transition(root, id, "in_progress", { actor: "test" }), GraphError);
});

test("updateCriteria：既有 setCriteria（确认路径）语义不回归", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  setCriteria(root, id, ["甲"], "test");
  const events = readEvents(root).filter((e) => e.goal === id);
  assert.equal(events.some((e) => e.event === "criteria.confirmed"), true);
  assert.equal(events.some((e) => e.event === "criteria.updated"), false);
  const doc = loadGoal(findGoalFile(root, id));
  assert.ok(doc.meta.rules_snapshot !== null);
});

test("updateCriteria：D8 base_items 一致时保存成功；不一致抛 GraphConflictError", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  updateCriteria(root, id, { items: ["甲", "乙"], actor: "test" });
  const base = criteriaItems(loadGoal(findGoalFile(root, id)).body); // ["1. 甲","2. 乙"]
  // 一致 → 成功
  updateCriteria(root, id, { items: ["甲", "乙", "丙"], base_items: base, actor: "test" });
  // 不一致（base 过期）→ GraphConflictError
  assert.throws(
    () => updateCriteria(root, id, { items: ["丁"], base_items: ["1. 旧甲"], actor: "test" }),
    GraphConflictError,
  );
});

test("updateCriteria：D8 force=true 以本地内容覆盖并发变化并记 conflicted", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  updateCriteria(root, id, { items: ["服务器内容"], actor: "test" });
  const result = updateCriteria(root, id, {
    items: ["本地内容"],
    base_items: ["1. 过期内容"], // 与服务器不一致
    force: true,
    actor: "test",
  });
  assert.equal(result.conflicted, true);
  assert.deepEqual(result.items, ["1. 本地内容"]);
  const doc = loadGoal(findGoalFile(root, id));
  assert.deepEqual(criteriaItems(doc.body), ["1. 本地内容"]);
  // 事件记录 conflicted 供审计
  const updated = readEvents(root).filter((e) => e.event === "criteria.updated");
  assert.ok(updated.some((e) => e.details.conflicted === true));
});

test("updateCriteria：保留小节注释/未知内容，看板 criteria_items 同步更新", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  // 手工注入带注释的小节
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  const raw = sectionText(doc.body, "质量判据")!;
  doc.body = replaceSection(doc.body, "质量判据", raw + "\n<!-- 备注：判据需覆盖边界场景 -->\n");
  saveGoal(file, doc);
  updateCriteria(root, id, { items: ["甲", "乙"], actor: "test" });
  const after = loadGoal(file);
  assert.ok(after.body.includes("<!-- 备注：判据需覆盖边界场景 -->"));
  assert.deepEqual(criteriaItems(after.body), ["1. 甲", "2. 乙"]);
  const goal = boardProjection(root).backlog.find((g) => g.id === id);
  assert.deepEqual(goal?.criteria_items, ["1. 甲", "2. 乙"]);
  assert.equal(goal?.criteria_count, 2);
});
