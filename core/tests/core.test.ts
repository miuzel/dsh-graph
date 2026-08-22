/** 核心层单元测试（node:test，零依赖）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  bindCardChild,
  readSupervisorSession,
  writeSupervisorSession,
  generateHandoff,
  writeHandoff,
  claimSupervisor,
  requestAcceptReview,
  resolveAccept,
  readAcceptStatus,
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

// ---- g-109 卡片收集绑定（bindCardChild） ----

test("bindCardChild 写 card.collecting 事件并绑定 child_id/status", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  const card = addCard(root, id, { title: "c", kind: "text", actor: "test" });
  bindCardChild(root, id, card, { childId: "child-abc", parentSessionId: "session-x", actor: "human:gui" });
  // 事件先行：card.collecting 已记
  const ev = readEvents(root).filter((e) => e.event === "card.collecting");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.card, card);
  assert.equal(ev[0].details.child_id, "child-abc");
  // 卡片文件 meta 更新：child_id / parent_session_id / status=collecting
  const cardFile = join(dirname(findGoalFile(root, id)), "cards", `${card}.md`);
  const meta = loadGoal(cardFile).meta;
  assert.equal(meta.child_id, "child-abc");
  assert.equal(meta.parent_session_id, "session-x");
  assert.equal(meta.status, "collecting");
});

test("bindCardChild 不存在的卡片抛错", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  assert.throws(() => bindCardChild(root, id, "card-nope", { childId: "c1", actor: "test" }), /卡片不存在/);
});

// ---- g-109 接受机制（requestAcceptReview / resolveAccept / readAcceptStatus） ----

test("requestAcceptReview 写 review.requested 事件并返回 pending", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  const r = requestAcceptReview(root, id, "human:gui");
  assert.equal(r.pending, true);
  assert.equal(r.goal, id);
  const ev = readEvents(root).filter((e) => e.event === "review.requested");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.targetStage, "draft");
  assert.equal(ev[0].details.what, "描述");
});

test("resolveAccept accept 按阶段映射追加事件", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", version: "v-t", actor: "test" });
  transition(root, id, "planning", { actor: "test" });
  requestAcceptReview(root, id, "human:gui");
  resolveAccept(root, id, { actor: "supervisor:k3", verdict: "accept" });
  const ev = readEvents(root);
  assert.ok(ev.some((e) => e.event === "description.confirmed"));
});

test("resolveAccept object 写 review.objected", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  requestAcceptReview(root, id, "human:gui");
  resolveAccept(root, id, { actor: "supervisor:k3", verdict: "object", objection: "描述不够清晰" });
  const ev = readEvents(root);
  assert.ok(ev.some((e) => e.event === "review.objected" && e.details.objection === "描述不够清晰"));
  const st = readAcceptStatus(root, id);
  assert.equal(st.state, "objection");
});

test("resolveAccept force 直接生效并记录理由", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  resolveAccept(root, id, { actor: "human:gui", verdict: "accept", force: true, reason: "紧急上线" });
  const ev = readEvents(root);
  assert.ok(ev.some((e) => e.event === "goal.amended" && e.details.note.includes("紧急上线")));
  assert.ok(ev.some((e) => e.event === "description.confirmed"));
});

test("readAcceptStatus 状态流转：none → pending → resolved", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  assert.equal(readAcceptStatus(root, id).state, "none");
  requestAcceptReview(root, id, "human:gui");
  assert.equal(readAcceptStatus(root, id).state, "pending");
  resolveAccept(root, id, { actor: "supervisor:k3", verdict: "accept" });
  assert.equal(readAcceptStatus(root, id).state, "resolved");
});

test("ready 状态下 resolveAccept(accept) 写 criteria.confirmed 且不抛异常、状态仍 ready", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "t", actor: "test" });
  transition(root, id, "planning", { actor: "test" });
  transition(root, id, "collecting", { actor: "test" });
  transition(root, id, "ready", { actor: "test" });
  requestAcceptReview(root, id, "human:gui");
  // 不应抛异常
  resolveAccept(root, id, { actor: "supervisor:k3", verdict: "accept" });
  // 状态仍应为 ready
  assert.equal(loadGoal(findGoalFile(root, id)).meta.status, "ready");
  // 应有 criteria.confirmed 事件
  const ev = readEvents(root);
  assert.ok(ev.some((e) => e.event === "criteria.confirmed"));
  // readAcceptStatus 应返回 resolved
  assert.equal(readAcceptStatus(root, id).state, "resolved");
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

// ---- g-117：supervisor 会话交接（graph_handoff / graph_claim_supervisor） ----

test("writeSupervisorSession：替换值保留注释与其他键，原子写 + 记 supervisor.claimed", () => {
  const root = tmpRoot();
  writeFileSync(
    join(root, "project.yaml"),
    'name: t\nsupervisor:\n  session: old-session   # 主管会话\n  automation:\n    release: human\nexecutor:\n  provider: deepseek-official\n',
  );
  writeSupervisorSession(root, "session-new", "agent:s");
  const text = readFileSync(join(root, "project.yaml"), "utf8");
  assert.match(text, /session: session-new/);
  assert.match(text, /# 主管会话/); // 行尾注释保留
  assert.match(text, /release: human/); // 其他键保留
  assert.match(text, /provider: deepseek-official/);
  assert.equal(readSupervisorSession(root), "session-new");
  const claimed = readEvents(root).filter((e) => e.event === "supervisor.claimed");
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].actor, "agent:s");
  assert.equal(claimed[0].details.supervisor_session, "session-new");
});

test("writeSupervisorSession：无 supervisor 块时文末新建；有块无 session 键时插入", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "project.yaml"), "name: t\ndescription: x\n");
  writeSupervisorSession(root, "s-1", "agent:s");
  assert.equal(readSupervisorSession(root), "s-1");
  assert.match(readFileSync(join(root, "project.yaml"), "utf8"), /supervisor:\n  session: s-1/);
  // 有块无 session 键：插入且保留其他键
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  automation:\n    release: human\n");
  writeSupervisorSession(root, "s-2", "agent:s");
  assert.equal(readSupervisorSession(root), "s-2");
  assert.match(readFileSync(join(root, "project.yaml"), "utf8"), /release: human/);
});

test("generateHandoff：board 投影 + 环境事实 + 长期记忆，不依赖会话上下文", () => {
  const root = tmpRoot();
  const id = createGoal(root, { title: "交接测试目标", version: "v-t", actor: "test" });
  writeFileSync(join(root, "memory", "long-term", "mem-x.md"), "内容");
  const content = generateHandoff(root);
  assert.match(content, /# HANDOFF（换会话交接）/);
  assert.match(content, /交接测试目标/);
  assert.match(content, /deepseek-official/);
  assert.match(content, /mem-x\.md/);
  assert.match(content, new RegExp(id)); // 目标 id 出现在看板段
  // 产物不依赖会话：同一 root 两次生成内容一致（除时间戳行）
  const content2 = generateHandoff(root);
  assert.match(content2, /交接测试目标/);
});

test("generateHandoff(opts.write)：落盘 HANDOFF.md 且内容与返回值一致", () => {
  const root = tmpRoot();
  createGoal(root, { title: "写盘目标", version: "v-t", actor: "test" });
  const content = generateHandoff(root, { write: true });
  assert.equal(readFileSync(join(root, "HANDOFF.md"), "utf8"), content);
});

test("claimSupervisor：更新 session + 记事件（幂等）+ 返回 HANDOFF 全文", () => {
  const root = tmpRoot();
  createGoal(root, { title: "claim 目标", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: old-session\n");
  const r1 = claimSupervisor(root, "session-new", "agent:new");
  assert.equal(r1.supervisor_session, "session-new");
  assert.equal(readSupervisorSession(root), "session-new");
  assert.match(r1.handoff, /# HANDOFF（换会话交接）/);
  assert.match(r1.handoff, /claim 目标/);
  assert.equal(readEvents(root).filter((e) => e.event === "supervisor.claimed").length, 1);
  // 幂等：同会话重复调用不重复记事件
  const r2 = claimSupervisor(root, "session-new", "agent:new");
  assert.equal(readEvents(root).filter((e) => e.event === "supervisor.claimed").length, 1);
  assert.ok(r2.handoff.length > 0);
  // 缺 session id 抛错
  assert.throws(() => claimSupervisor(root, "", "agent:new"), GraphError);
});

// ---- g-121：HANDOFF 旧版归档 ----

test("generateHandoff(opts.write) g-121：首写无归档；二次写内容不同时旧文件归档（内容/时间戳/目录）", () => {
  const root = tmpRoot();
  createGoal(root, { title: "归档目标", version: "v-t", actor: "test" });
  // 首写：无旧文件，不产生归档
  const c1 = generateHandoff(root, { write: true });
  assert.equal(readFileSync(join(root, "HANDOFF.md"), "utf8"), c1);
  assert.equal(existsSync(join(root, "handoffs")), false, "首写不应创建归档目录");
  // 二次写：board 变化（新增目标）→ 内容不同 → 旧版归档
  createGoal(root, { title: "归档目标2", version: "v-t", actor: "test" });
  const c2 = generateHandoff(root, { write: true });
  assert.notEqual(c1, c2, "board 变化后内容应不同");
  const files = readdirSync(join(root, "handoffs")).filter((f) => f.startsWith("HANDOFF-"));
  assert.equal(files.length, 1, "应恰好归档一份旧文件");
  assert.match(files[0], /^HANDOFF-\d{8}-\d{6}-\d{3}\.md$/, "归档文件名应带时间戳");
  // 归档内容 = 旧 HANDOFF.md 内容
  assert.equal(readFileSync(join(root, "handoffs", files[0]), "utf8"), c1);
  // 新文件内容 = 新生成的 HANDOFF
  assert.equal(readFileSync(join(root, "HANDOFF.md"), "utf8"), c2);
});

test("writeHandoff g-121：内容相同不归档（幂等写盘）", () => {
  const root = tmpRoot();
  writeHandoff(root, "v1");
  assert.equal(existsSync(join(root, "handoffs")), false);
  writeHandoff(root, "v1"); // 内容相同 → 不归档
  assert.equal(existsSync(join(root, "handoffs")), false, "内容相同不应归档");
  writeHandoff(root, "v2"); // 内容不同 → 归档
  const files = readdirSync(join(root, "handoffs")).filter((f) => f.startsWith("HANDOFF-"));
  assert.equal(files.length, 1);
  assert.equal(readFileSync(join(root, "handoffs", files[0]), "utf8"), "v1");
  assert.equal(readFileSync(join(root, "HANDOFF.md"), "utf8"), "v2");
});

test("claimSupervisor g-121：返回 HANDOFF 时同时落盘（写盘走归档逻辑）", () => {
  const root = tmpRoot();
  createGoal(root, { title: "claim 归档目标", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: old-session\n");
  // 首次 claim：无旧 HANDOFF，不归档，直接落盘
  const r1 = claimSupervisor(root, "session-new", "agent:new");
  assert.equal(readFileSync(join(root, "HANDOFF.md"), "utf8"), r1.handoff, "claim 返回时应同时落盘");
  assert.equal(existsSync(join(root, "handoffs")), false, "首写不归档");
  // 二次 claim：board 变化 → 旧 HANDOFF 归档
  createGoal(root, { title: "claim 归档目标2", version: "v-t", actor: "test" });
  const r2 = claimSupervisor(root, "session-new", "agent:new");
  const files = readdirSync(join(root, "handoffs")).filter((f) => f.startsWith("HANDOFF-"));
  assert.equal(files.length, 1, "二次 claim 应归档旧版");
  assert.equal(readFileSync(join(root, "handoffs", files[0]), "utf8"), r1.handoff);
  assert.equal(readFileSync(join(root, "HANDOFF.md"), "utf8"), r2.handoff);
  // 幂等（事件）不受影响：仍只记一条
  assert.equal(readEvents(root).filter((e) => e.event === "supervisor.claimed").length, 1);
});

test("g-121：归档目录不进 git（仓库根 .gitignore 排除 handoffs/）", () => {
  const root = tmpRoot();
  writeHandoff(root, "v1");
  writeHandoff(root, "v2"); // 触发归档 → <root>/handoffs/
  assert.equal(existsSync(join(root, "handoffs")), true);
  // 仓库根 .gitignore 断言（相对于测试文件定位仓库根）
  const repoRoot = join(dirname(new URL(import.meta.url).pathname), "..", "..");
  const gi = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  assert.match(gi, /handoffs\//, "仓库根 .gitignore 应排除 handoffs/ 目录");
});
