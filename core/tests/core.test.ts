/** 核心层单元测试（node:test，零依赖）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDoc,
  serializeDoc,
  sectionText,
  replaceSection,
  criteriaPresent,
} from "../model.ts";
import {
  init,
  createGoal,
  setCriteria,
  transition,
  validate,
  rebuild,
  findGoalFile,
  loadGoal,
  GraphError,
} from "../ops.ts";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-test-"));
  init(dir);
  return dir;
}

// ---- model ----

test("parseDoc/serializeDoc 往返保持正文逐字节不变", () => {
  const body = "\n## 目标描述\n\n随便什么 **正文**。\n\n## 质量判据\n\n1. 甲\n";
  const doc = parseDoc(`---\n{"id":"g-x","status":"draft"}\n---\n${body}`);
  assert.equal(doc.meta.id, "g-x");
  assert.equal(doc.body, body);
  const again = parseDoc(serializeDoc(doc));
  assert.equal(again.body, body);
  assert.deepEqual(again.meta, doc.meta);
});

test("sectionText/replaceSection/criteriaPresent", () => {
  const body = "\n## 质量判据\n\n<!-- 注释 -->\n\n## 其他\n\nx\n";
  assert.equal(criteriaPresent(body), false);
  const next = replaceSection(body, "质量判据", "\n1. 通过测试\n");
  assert.equal(criteriaPresent(next), true);
  assert.equal(sectionText(next, "其他")!.trim(), "x");
});

// ---- 状态机 ----

test("合法迁移链 draft→planning→collecting→ready", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  transition(root, id, "planning", { actor: "test" });
  transition(root, id, "collecting", { actor: "test" });
  transition(root, id, "ready", { actor: "test" });
  assert.equal(loadGoal(findGoalFile(root, id)).meta.status, "ready");
});

test("跳阶段迁移被拒绝", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  assert.throws(
    () => transition(root, id, "delivered", { actor: "test" }),
    GraphError,
  );
});

test("blocked 必须有 reason；解除只能回原状态", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  transition(root, id, "planning", { actor: "test" });
  assert.throws(
    () => transition(root, id, "blocked", { actor: "test" }),
    /reason/,
  );
  transition(root, id, "blocked", { reason: "等人", actor: "test" });
  assert.throws(
    () => transition(root, id, "collecting", { actor: "test" }),
    /原状态/,
  );
  transition(root, id, "planning", { actor: "test" }); // 回 blocked_from
  assert.equal(loadGoal(findGoalFile(root, id)).meta.status, "planning");
});

test("无判据不得进 in_progress；set-criteria 后自动快照规则版本并放行", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test", scope: ["core/"] });
  transition(root, id, "planning", { actor: "test" });
  transition(root, id, "collecting", { actor: "test" });
  transition(root, id, "ready", { actor: "test" });
  assert.throws(
    () => transition(root, id, "in_progress", { actor: "test" }),
    GraphError,
  );
  setCriteria(root, id, ["脚本通过"], "test");
  // setCriteria 自动从 rules.md 快照规则版本
  assert.equal(
    loadGoal(findGoalFile(root, id)).meta.rules_snapshot,
    "r-init",
  );
  transition(root, id, "in_progress", { actor: "test" });
});

// ---- validate ----

test("validate 发现位置不一致与非法状态", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  assert.deepEqual(validate(root), []);
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  doc.meta.status = "flying";
  writeFileSync(file, serializeDoc(doc), "utf8");
  const problems = validate(root);
  assert.ok(problems.some((p) => p.includes("非法状态")));
});

test("validate 检测依赖环", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "a", actor: "test" });
  const b = createGoal(root, { title: "b", actor: "test" });
  for (const [id, dep] of [
    [a, b],
    [b, a],
  ] as const) {
    const file = findGoalFile(root, id);
    const doc = loadGoal(file);
    doc.meta.depends_on = [{ goal: dep, consumes: ["x"] }];
    writeFileSync(file, serializeDoc(doc), "utf8");
  }
  const problems = validate(root);
  assert.ok(problems.some((p) => p.includes("依赖环")));
});

// ---- rebuild ----

test("rebuild 发现 frontmatter 被篡改的 drift", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  transition(root, id, "planning", { actor: "test" });
  assert.deepEqual(rebuild(root), []);
  const file = findGoalFile(root, id);
  const raw = readFileSync(file, "utf8");
  writeFileSync(file, raw.replace('"planning"', '"ready"'), "utf8");
  const drift = rebuild(root);
  assert.equal(drift.length, 1);
  assert.ok(drift[0].includes("不一致"));
});

test("set-criteria 对缺少质量判据小节的草稿自动追加小节", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  // 删掉模板的质量判据小节，模拟 backlog 草稿
  const file = findGoalFile(root, id);
  const doc = loadGoal(file);
  doc.body = doc.body.replace(/## 质量判据[\s\S]*?(?=## 证据台账)/, "");
  writeFileSync(file, serializeDoc(doc), "utf8");
  setCriteria(root, id, ["甲"], "test");
  const after = loadGoal(findGoalFile(root, id));
  assert.ok(after.body.includes("## 质量判据"));
  assert.ok(after.body.includes("1. 甲"));
});
