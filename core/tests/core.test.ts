/** 核心层单元测试（node:test，零依赖）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseDoc,
  serializeDoc,
  sectionText,
  replaceSection,
  criteriaPresent,
} from "../model.ts";
import { readEvents } from "../events.ts";
import {
  init,
  createGoal,
  setCriteria,
  transition,
  validate,
  rebuild,
  findGoalFile,
  loadGoal,
  moveGoal,
  addCard,
  readSupervisorSession,
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

test("无收集需求时 planning→ready 直达合法", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  transition(root, id, "planning", { actor: "test" });
  transition(root, id, "ready", { actor: "test" });
  assert.equal(loadGoal(findGoalFile(root, id)).meta.status, "ready");
});

test("readExecutorModel 读取 executor.provider/model，缺失返回 null", async () => {
  const { readExecutorModel } = await import("../ops.ts");
  const root = tmpRoot();
  assert.deepEqual(readExecutorModel(root), { provider: null, model: null });
  writeFileSync(
    join(root, "project.yaml"),
    "name: t\nexecutor:\n  provider: kimi-coding   # 注释\n  model: kimi-for-coding\n",
  );
  assert.deepEqual(readExecutorModel(root), {
    provider: "kimi-coding",
    model: "kimi-for-coding",
  });
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

test("createGoal 连号 id：读 frontmatter，跳过随机 id 与 slug 目录名", () => {
  const root = tmpRoot();
  const a = createGoal(root, { title: "a", actor: "test" });
  const b = createGoal(root, { title: "b", actor: "test" });
  assert.equal(a, "g-001");
  assert.equal(b, "g-002");
  // 历史随机 id（含全数字的 8 位 hex）不影响连号序列
  writeFileSync(
    join(root, "backlog", "g-a92e1406.md"),
    serializeDoc({ meta: { id: "g-a92e1406", status: "draft" }, body: "" }),
    "utf8",
  );
  writeFileSync(
    join(root, "backlog", "g-77647351.md"),
    serializeDoc({ meta: { id: "g-77647351", status: "draft" }, body: "" }),
    "utf8",
  );
  // 真实仓库惯例（发现#24）：目录/文件用 slug 名，g-id 只在 frontmatter
  mkdirSync(join(root, "versions", "v9", "goals", "session-embed"), {
    recursive: true,
  });
  writeFileSync(
    join(root, "versions", "v9", "goals", "session-embed", "goal.md"),
    serializeDoc({ meta: { id: "g-107", status: "review" }, body: "" }),
    "utf8",
  );
  const c = createGoal(root, { title: "c", actor: "test" });
  assert.equal(c, "g-108");
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

test("move-goal：backlog↔standalone↔version，带附件拒绝回 backlog", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" }); // backlog 平铺
  transition(root, id, "planning", { actor: "test" });
  moveGoal(root, id, { to: "standalone", actor: "test" });
  let doc = loadGoal(findGoalFile(root, id));
  assert.equal(doc.meta.version, null);
  moveGoal(root, id, { to: "version", version: "v-x", actor: "test" });
  doc = loadGoal(findGoalFile(root, id));
  assert.equal(doc.meta.version, "v-x");
  assert.deepEqual(validate(root), []);
  // 带上 cards 附件后拒绝回 backlog
  addCard(root, id, { title: "c", kind: "text", actor: "test" });
  assert.throws(() => moveGoal(root, id, { to: "backlog", actor: "test" }), /附件/);
  const events = readEvents(root).filter((e) => e.event === "goal.moved");
  assert.equal(events.length, 2);
});

// ---- project.yaml supervisor.session（g-108） ----

test("readSupervisorSession：读 supervisor.session，去注释/引号，缺失返回 null", () => {
  const root = tmpRoot();
  assert.equal(readSupervisorSession(root), null); // 无 project.yaml
  writeFileSync(
    join(root, "project.yaml"),
    'name: t\nsupervisor:\n  session: session-abc123   # 主管会话\n  automation:\n    release: human\n',
  );
  assert.equal(readSupervisorSession(root), "session-abc123");
  // 引号形态
  writeFileSync(join(root, "project.yaml"), 'supervisor:\n  session: "session-quoted"\n');
  assert.equal(readSupervisorSession(root), "session-quoted");
  // 别的块的 session 不算
  writeFileSync(join(root, "project.yaml"), 'other:\n  session: nope\n');
  assert.equal(readSupervisorSession(root), null);
});
