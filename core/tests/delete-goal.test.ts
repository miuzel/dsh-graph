/** 目标删除单元测试（node:test，零依赖）。g-140 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  resolveAccept,
  GraphError,
} from "../ops.ts";
import { listWorktrees, cleanWorktree, registerWorktreeCandidates } from "../worktree.ts";
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
  // g-287：独立目标创建即 planning，无需补 planning 迁移
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
  addCard(root, id, { title: "测试卡片", kind: "text", actor: "test", scope: "goal" });
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

// ============================================================================
// g-500 判据 1：删除前检测关联 worktree，未清理则阻断（防目标删除制造孤儿）
// ============================================================================

/** g-500：真 Git 仓库 + 已交付目标 + 一棵真实可清理 worktree（含候选登记）。
 *
 *  g-500 att-002：本夹具**必须**复刻真实宿主的 `attempt.started` 载荷形状
 *  （`worktree: { path, relative_path, branch, canonical_root, head }`，逐字对齐
 *  `.dsh-graph/events.jsonl` 实况）。此前夹具只靠 `startAttempt` 隐式事件（**不带** worktree 字段），
 *  因此「宿主形态载荷会命中 gate 3」这一真实死锁在单测里根本不可见 —— 这正是它逃逸到线上的原因。 */
function repoWithDeliverableWorktree() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-delete-wt-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  const root = join(dir, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "带工作树", version: "v-t", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" });
  const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  // 真实宿主形状：att-001 的死锁正是因为夹具缺这一段而与线上脱节。
  appendEvent(root, {
    actor: "core", event: "attempt.started", goal,
    details: {
      attempt,
      worktree: { path, relative_path: `.worktrees/${goal}-att-01`, branch: `refs/heads/${goal}-att-01`, canonical_root: root, head },
    },
  });
  const af = join(root, "versions", "v-t", "goals", goal, "attempts", attempt, "attempt.md");
  writeFileSync(af, readFileSync(af, "utf8").replace('"status_line": null', '"status_line": "等待 review"'));
  const gf = findGoalFile(root, goal);
  writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "review"'));
  resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept" });
  registerWorktreeCandidates(root, goal, "test");
  return { dir, root, goal, attempt, path, gf };
}

test("g-500 判据1：关联未清理 worktree 时 deleteGoal 阻断，且目标目录零破坏", () => {
  const { root, goal, path } = repoWithDeliverableWorktree();
  assert.equal(listWorktrees(root, goal)[0].status, "candidate", "前置：树应为可清理候选");
  archiveGoal(root, goal, { actor: "test" });
  const archivedDir = join(root, "versions", "v-t", "archived", goal);
  assert.ok(existsSync(archivedDir), "前置：归档目录存在");
  // 负向对照：有未清理树 ⇒ 必须抛 GraphError，理由点名路径并给出可执行指引
  assert.throws(
    () => deleteGoal(root, goal, { actor: "test" }),
    (e: any) => e instanceof GraphError && e.message.includes(path) && e.message.includes("graph_clean_worktree"),
    "有未清理 worktree 时应阻断删除并给出可执行指引",
  );
  // 阻断必须发生在**任何**破坏性动作之前：目标目录与工作树原样保留，且未记 goal.deleted
  assert.ok(existsSync(archivedDir), "阻断后目标目录必须零破坏");
  assert.ok(existsSync(path), "阻断后工作树必须原样保留");
  assert.equal(readEvents(root).filter((e) => e.event === "goal.deleted").length, 0, "阻断时不得记 goal.deleted");
});

test("g-500 判据1：清理 worktree 后 deleteGoal 放行（正向前后对照）", () => {
  const { root, goal, path } = repoWithDeliverableWorktree();
  archiveGoal(root, goal, { actor: "test" });
  const c = listWorktrees(root, goal)[0];
  assert.equal(cleanWorktree(root, c.id, "human:test", true).ok, true, "先清理应成功");
  assert.ok(!existsSync(path), "清理后工作树目录应消失");
  // 残留清空 ⇒ 阻塞解除 ⇒ 删除成功
  deleteGoal(root, goal, { actor: "test" });
  assert.ok(!existsSync(join(root, "versions", "v-t", "archived", goal)), "无残留树时目标应可删除");
  assert.equal(readEvents(root).filter((e) => e.event === "goal.deleted").length, 1);
});

test("g-500 判据2（集合对齐）：事件流记 cleaned 但树实测仍在 ⇒ 不得放行删除（阻断集合 ⊇ 残留集合）", () => {
  // 死胡同复现（att-002）：`listGoalWorktrees` 曾只看事件流里的 `worktree.cleaned` 就判 cleaned
  // ⇒ deleteGoal 放行；而 `cleanWorktree` 因树实测仍在（注册漂移 ⇒ reuse_suspected）恒拒绝。
  // 两边集合错位的结果：目标被删、树却既没清也再无人能清 —— 正是本目标要消除的死锁。
  const { dir, root, goal, path } = repoWithDeliverableWorktree();
  const cand = listWorktrees(root, goal)[0];
  assert.equal(cleanWorktree(root, cand.id, "human:test", true).ok, true, "前置：先真实清理一次");
  assert.ok(!existsSync(path), "前置：树已移除");
  // 让树「回来」（模拟注册漂移 / 同名树被重建），此时事件流仍留着上一次的 worktree.cleaned
  execFileSync("git", ["worktree", "add", "-q", "-b", "tmp-recreated", path], { cwd: dir });
  assert.ok(existsSync(path), "前置：树已重新出现");
  assert.ok(
    readEvents(root).some((e) => e.event === "worktree.cleaned"),
    "前置：事件流仍留有 cleaned 留痕（这正是误判来源）",
  );
  // 核心不变式：树实测存在 ⇒ 删除必须被阻断，绝不能放行后制造无法清理的孤儿
  archiveGoal(root, goal, { actor: "test" });
  assert.throws(
    () => deleteGoal(root, goal, { actor: "test" }),
    (e: any) => e instanceof GraphError && e.message.includes(path),
    "树仍实测存在时，deleteGoal 必须阻断（不得因陈旧 cleaned 事件放行）",
  );
  assert.ok(existsSync(path), "阻断后树必须原样保留");
  assert.equal(readEvents(root).filter((e) => e.event === "goal.deleted").length, 0, "阻断时不得记 goal.deleted");
});

test("g-500 判据2（集合对齐）：真已清空的树不得反过来永久阻断删除", () => {
  // 反向不变式：上一条修的是「不该放行却放行」，这条钉住「该放行却阻断」。
  // 只有「事件记 cleaned」**且**「树不在实测列表里」才算真出清 ⇒ 必须放行。
  const { root, goal, path } = repoWithDeliverableWorktree();
  const cand = listWorktrees(root, goal)[0];
  assert.equal(cleanWorktree(root, cand.id, "human:test", true).ok, true);
  assert.ok(!existsSync(path), "前置：树已真实移除");
  archiveGoal(root, goal, { actor: "test" });
  // 不抛 = 放行；已出清的树不得把删除永久锁死
  deleteGoal(root, goal, { actor: "test" });
  assert.ok(!existsSync(join(root, "versions", "v-t", "archived", goal)), "已出清时目标应可删除");
  assert.equal(readEvents(root).filter((e) => e.event === "goal.deleted").length, 1);
});

test("g-500 判据1：无关联 worktree 的目标照常可删（既有行为不回归）", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-delete-nowt-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  const root = join(dir, ".dsh-graph"); init(root);
  const goal = createGoal(root, { title: "无树", version: "v-t", actor: "test" });
  archiveGoal(root, goal, { actor: "test" });
  deleteGoal(root, goal, { actor: "test" });
  assert.ok(!existsSync(join(root, "versions", "v-t", "archived", goal)));
});

test("g-500 判据1：非 Git 工作区不因探测失败锁死删除（降级放行）", () => {
  const root = tmpRoot(); // 非 Git 仓库：不可能存在可清理工作树
  const id = createGoal(root, { title: "非git", actor: "test" });
  archiveGoal(root, id, { actor: "test" });
  deleteGoal(root, id, { actor: "test" });
  assert.ok(!existsSync(join(root, "backlog", "archived", `${id}.md`)), "非 Git 环境下删除不得被阻断");
});
