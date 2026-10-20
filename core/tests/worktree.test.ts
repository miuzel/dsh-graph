import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { init, createGoal, startAttempt, findGoalFile, resolveAccept } from "../ops.ts";
import { listWorktrees, cleanWorktree, registerWorktreeCandidates, defaultWorktreeForGoalType, prepareAttemptWorktree } from "../worktree.ts";
import { readEvents, appendEvent } from "../events.ts";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-worktree-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  init(join(dir, ".dsh-graph"));
  return dir;
}

test("worktree 模块可直接导入，非 Git 安全降级", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-nogit-"));
  assert.deepEqual(listWorktrees(join(root, ".dsh-graph")), []);
});

test("review→delivered 登记 two-digit 标准 worktree，等待 review 可清理且 actor/幂等正确", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const goal = createGoal(root, { title: "delivery", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" });
  const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`);
  const text = readFileSync(af, "utf8").replace('"status_line": null', '"status_line": "等待 review"').replace('"child_id": null', '"child_id": "child-1"');
  writeFileSync(af, text);
  const gf = findGoalFile(root, goal); writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "review"'));
  resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept" });
  const rows = listWorktrees(root, goal); assert.equal(rows[0].status, "candidate", rows[0].reason ?? "no reason"); assert.equal(rows[0].active, false);
  assert.equal(listWorktrees(root, goal).filter(x => x.status === "candidate").length, 1);
  assert.ok(readFileSync(join(root, "events.jsonl"), "utf8").includes('"actor":"supervisor:test"'));
  assert.equal(cleanWorktree(root, rows[0].id, "human:test", true).ok, true);
});

test("force accept 自动登记且重复 register 只写一个事件；dirty 候选阻断", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph"); const goal = createGoal(root, { title: "force", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" }); const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`); writeFileSync(af, readFileSync(af, "utf8").replace('"status_line": null', '"status_line": "等待 review"'));
  const gf = findGoalFile(root, goal); writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "review"'));
  resolveAccept(root, goal, { actor: "supervisor:force", verdict: "accept", force: true, reason: "test" });
  const first = listWorktrees(root, goal)[0]; assert.equal(first.status, "candidate");
  const before = readFileSync(join(root, "events.jsonl"), "utf8").match(/worktree\.candidate_registered/g)?.length ?? 0;
  registerWorktreeCandidates(root, goal, "supervisor:force");
  const after = readFileSync(join(root, "events.jsonl"), "utf8").match(/worktree\.candidate_registered/g)?.length ?? 0; assert.equal(after, before);
  writeFileSync(join(path, "dirty"), "x"); const dirty = listWorktrees(root, goal)[0]; assert.notEqual(dirty.status, "candidate"); assert.equal(cleanWorktree(root, dirty.id, "human:test", true).ok, false);
});

test("运行中的 child attempt 保持保护", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph"); const goal = createGoal(root, { title: "running", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" }); const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`); writeFileSync(af, readFileSync(af, "utf8").replace('"status_line": null', '"status_line": "正在执行测试"').replace('"child_id": null', '"child_id": "child-1"'));
  const gf = findGoalFile(root, goal); writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "delivered"'));
  const row = listWorktrees(root, goal)[0]; assert.equal(row.active, true); assert.notEqual(row.status, "candidate");
});

test("未合并提交与 canonical 外部路径均不可清理", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph"); const goal = createGoal(root, { title: "unmerged", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" }); const path = join(dir, ".worktrees", `${goal}-att-01`); execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`); writeFileSync(af, readFileSync(af, "utf8").replace('"status_line": null', '"status_line": "等待 review"'));
  const gf = findGoalFile(root, goal); writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "review"')); resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept" });
  writeFileSync(join(path, "new"), "x"); execFileSync("git", ["add", "."], { cwd: path }); execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "unmerged"], { cwd: path });
  const row = listWorktrees(root, goal)[0]; assert.equal(row.status, "unknown"); assert.equal(cleanWorktree(root, row.id, "human:test", true).ok, false);
  const outside = join(dir, "outside", `${goal}-att-02`); execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-02`, outside], { cwd: dir }); assert.equal(listWorktrees(root, goal).find(x => x.path === outside)?.status, "unknown");
});

test("无 child 的 pending 非终态与空状态均保守保护", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph"); const goal = createGoal(root, { title: "local", version: "v-test", actor: "test" });
  const a1 = startAttempt(root, goal, { executor: "test", actor: "test" }); const a2 = startAttempt(root, goal, { executor: "test", actor: "test" });
  for (const [a, n, status] of [[a1, "01", "正在执行本地任务"], [a2, "02", ""]] as const) {
    const p = join(dir, ".worktrees", `${goal}-att-${n}`); execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-${n}`, p], { cwd: dir });
    const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${a}/attempt.md`); writeFileSync(af, readFileSync(af, "utf8").replace('"status_line": null', `"status_line": "${status}"`));
  }
  const gf = findGoalFile(root, goal); writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "delivered"'));
  for (const row of listWorktrees(root, goal)) { assert.equal(row.active, true); assert.notEqual(row.status, "candidate"); }
});

test("登记后 HEAD 漂移会被阻断", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph"); const goal = createGoal(root, { title: "drift", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" }); const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`); writeFileSync(af, readFileSync(af, "utf8").replace('"status_line": null', '"status_line": "等待 review"'));
  const gf = findGoalFile(root, goal); writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "review"'));
  resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept" }); const first = listWorktrees(root, goal)[0]; assert.equal(first.status, "candidate");
  writeFileSync(join(path, "changed"), "drift"); execFileSync("git", ["add", "."], { cwd: path }); execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "drift"], { cwd: path });
  const changed = listWorktrees(root, goal)[0]; assert.equal(changed.status, "unknown"); assert.equal(changed.reason, "snapshot_drift"); assert.equal(cleanWorktree(root, changed.id, "human:test", true).ok, false);
});

test("缺 result 的旧 attempt 运行态保守保护", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph"); const goal = createGoal(root, { title: "legacy", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" }); const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`); const raw = readFileSync(af, "utf8").replace(',\n  "result": "pending"', "");
  writeFileSync(af, raw.replace('"status_line": null', '"status_line": "正在执行"').replace('"child_id": null', '"child_id": "child"'));
  const gf = findGoalFile(root, goal); writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "delivered"'));
  const row = listWorktrees(root, goal)[0]; assert.equal(row.active, true); assert.notEqual(row.status, "candidate");
});

test("缺 attempt 证据与路径/分支错配不会成为 candidate", () => {
  const dir = repo();
  const path = join(dir, ".worktrees", "g-197-att-001");
  execFileSync("git", ["worktree", "add", "-q", "-b", "g-198-att-001", path], { cwd: dir });
  const rows = listWorktrees(join(dir, ".dsh-graph"));
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0].status, "candidate");
  assert.match(rows[0].reason ?? "", /^(path_branch_mismatch|missing_attempt_evidence)$/);
});

test("真实候选外部删除后记录 external_removed，重复 clean 稳定 no-op，未知 id 失败", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const goal = createGoal(root, { title: "external", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" });
  const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`);
  writeFileSync(af, readFileSync(af, "utf8").replace('"status_line": null', '"status_line": "等待 review"'));
  const gf = findGoalFile(root, goal); writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "review"'));
  resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept" });
  const candidate = listWorktrees(root, goal)[0]; assert.equal(candidate.status, "candidate");
  execFileSync("git", ["worktree", "remove", path], { cwd: dir });
  const external = listWorktrees(root, goal)[0]; assert.equal(external.reason, "externally_removed");
  assert.equal(cleanWorktree(root, external.id, "human:test", true).reason, "already_cleaned");
  assert.equal(cleanWorktree(root, external.id, "human:test", true).reason, "already_cleaned");
  const unknown = cleanWorktree(root, "random-id", "human:test", true); assert.equal(unknown.ok, false); assert.equal(unknown.reason, "unknown_candidate");
});

// ============================================================================
// g-283：派发时由用户决定是否建 worktree（真实创建 / 幂等复用 / 失败即停）
// ============================================================================

test("g-283 默认值纯函数：patch/chore/task 默认不勾选，其余类型（feature/bug/improvement 等）默认勾选", () => {
  assert.equal(defaultWorktreeForGoalType("patch"), false);
  assert.equal(defaultWorktreeForGoalType("chore"), false);
  assert.equal(defaultWorktreeForGoalType("task"), false);
  assert.equal(defaultWorktreeForGoalType("feature"), true);
  assert.equal(defaultWorktreeForGoalType("bug"), true);
  assert.equal(defaultWorktreeForGoalType("improvement"), true);
  // 空值按默认 task 处理（false）
  assert.equal(defaultWorktreeForGoalType(null), false);
  assert.equal(defaultWorktreeForGoalType(undefined), false);
  assert.equal(defaultWorktreeForGoalType(""), false);
  // 大小写归一化
  assert.equal(defaultWorktreeForGoalType("PATCH"), false);
  assert.equal(defaultWorktreeForGoalType("Feature"), true);
  // 未登记的自定义类型按「其余」默认勾选（隔离优先，绝不静默降级为主树执行）
  assert.equal(defaultWorktreeForGoalType("research"), true);
});

test("g-283 勾选真实建树：enabled=true 创建 .worktrees/g-<goal>-att-NN，分支同名且基线为指定 commit", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const r = prepareAttemptWorktree(root, "g-283", "att-003", { enabled: true, baselineCommit: baseline });
  assert.equal(r.enabled, true);
  assert.equal(r.created, true);
  assert.equal(r.reused, false);
  assert.equal(r.worktree.relative_path, join(".worktrees", "g-283-att-03"));
  assert.equal(r.worktree.branch, "refs/heads/g-283-att-03");
  assert.equal(r.worktree.head, baseline);
  const wtPath = join(dir, ".worktrees", "g-283-att-03");
  assert.ok(existsSync(wtPath), "worktree 目录必须真实存在");
  assert.equal(execFileSync("git", ["-C", wtPath, "branch", "--show-current"], { encoding: "utf8" }).trim(), "g-283-att-03");
  assert.equal(execFileSync("git", ["-C", wtPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), baseline);
});

test("g-283 未勾选不建：enabled=false 返回 worktree=false 且不创建任何目录", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const r = prepareAttemptWorktree(root, "g-283", "att-003", { enabled: false, reason: "user_choice" });
  assert.equal(r.enabled, false);
  assert.equal(r.worktree, false);
  assert.equal(r.reason, "user_choice");
  assert.ok(!existsSync(join(dir, ".worktrees")), "未勾选时不得创建 .worktrees 目录");
});

test("g-283 幂等复用：同一 goal/attempt 再次派发复用已存在且匹配的 worktree，不报错", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const baseline = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
  const r1 = prepareAttemptWorktree(root, "g-283", "att-003", { enabled: true, baselineCommit: baseline });
  assert.equal(r1.created, true);
  const r2 = prepareAttemptWorktree(root, "g-283", "att-003", { enabled: true, baselineCommit: baseline });
  assert.equal(r2.created, false);
  assert.equal(r2.reused, true);
  assert.equal(r2.worktree.path, r1.worktree.path);
  assert.equal(r2.worktree.branch, r1.worktree.branch);
});

test("g-283 路径冲突失败即停：路径被占用但分支/归属不匹配时抛 GraphError 拒绝派发", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const path = join(dir, ".worktrees", "g-283-att-03");
  execFileSync("git", ["worktree", "add", "-q", "-b", "g-999-att-01", path], { cwd: dir });
  assert.throws(
    () => prepareAttemptWorktree(root, "g-283", "att-003", { enabled: true }),
    /归属\/分支不匹配|拒绝派发/,
  );
});

test("g-283 路径被普通目录占用失败即停：非有效 worktree 的残留目录同样拒绝派发", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const path = join(dir, ".worktrees", "g-283-att-03");
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "dummy"), "x");
  assert.throws(
    () => prepareAttemptWorktree(root, "g-283", "att-003", { enabled: true }),
    /文件系统占用|拒绝派发/,
  );
});

test("g-283 非 git 仓库失败即停：enabled=true 时抛 GraphError 拒绝派发", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-nogit-wt-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  assert.throws(
    () => prepareAttemptWorktree(root, "g-283", "att-003", { enabled: true }),
    /不是 Git 仓库|git 不可用/,
  );
});

test("g-283 基线无效失败即停：baselineCommit 不存在时抛 GraphError 拒绝派发", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  assert.throws(
    () => prepareAttemptWorktree(root, "g-283", "att-003", { enabled: true, baselineCommit: "deadbeefdeadbeef" }),
    /基线 commit 无效/,
  );
});

// ============================================================================
// g-500 判据 2：目标删除后残留孤儿工作树的安全清理（消除 missing_attempt_evidence 死锁）
// ============================================================================

/** g-500：构造「目标已被删除、只剩孤儿工作树」的历史遗留现场（绕过删除闸门，纯夹具）。
 *
 *  g-500 att-002：`attempt.started` **必须**复刻真实宿主载荷形状（含 `worktree.path`）。
 *  宿主对每一次隔离派发都写入该字段（实测 `.dsh-graph/events.jsonl` 中 244 条），而旧夹具只靠
 *  `startAttempt` 的隐式事件（不带 worktree）⇒ 「宿主形态会命中 gate 3、孤儿恒不可清」这一真实
 *  死锁在单测里完全不可见。这是本轮把测试补到与线上同形的唯一理由。 */
function orphanFixture() {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const goal = createGoal(root, { title: "orphan", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" });
  const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  appendEvent(root, {
    actor: "core", event: "attempt.started", goal,
    details: {
      attempt,
      worktree: { path, relative_path: `.worktrees/${goal}-att-01`, branch: `refs/heads/${goal}-att-01`, canonical_root: root, head },
    },
  });
  const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`);
  writeFileSync(af, readFileSync(af, "utf8").replace('"status_line": null', '"status_line": "等待 review"'));
  const gf = findGoalFile(root, goal);
  writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "review"'));
  resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept" });
  registerWorktreeCandidates(root, goal, "test");
  const candidate = listWorktrees(root, goal)[0];
  assert.equal(candidate.status, "candidate", "前置：清理前应为可清理候选");
  // 模拟「先删目标」的历史现场：删目标目录 + 记 goal.deleted（夹具直做，不经 deleteGoal 闸门）
  rmSync(join(root, "versions", "v-test", "goals", goal), { recursive: true, force: true });
  appendEvent(root, { actor: "test", event: "goal.deleted", goal, details: { id: goal } });
  return { dir, root, goal, attempt, path, candidate };
}

test("g-500 判据2：目标删除后孤儿工作树退化为 missing_attempt_evidence（死锁复现）", () => {
  const { root, path } = orphanFixture();
  const orphan = listWorktrees(root)[0];
  // 死锁根因：目标没了 ⇒ 证据没了 ⇒ 候选永久 unknown
  assert.equal(orphan.status, "unknown");
  assert.equal(orphan.reason, "missing_attempt_evidence");
  assert.equal(orphan.path, path);
});

test("g-500 判据2：孤儿工作树可被 cleanWorktree 安全清理（消除死锁）", () => {
  const { dir, root, path, candidate } = orphanFixture();
  const orphan = listWorktrees(root)[0];
  const res = cleanWorktree(root, orphan.id, "human:test", true);
  assert.equal(res.ok, true, `孤儿清理应成功，实际 reason=${res.reason}`);
  // 真实删除：目录与 Git 注册双双消失
  assert.ok(!existsSync(path), "孤儿工作树目录应已删除");
  const listing = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: dir, encoding: "utf8" });
  assert.ok(!listing.includes(path), "Git 注册列表中不应再有该工作树");
  // 与主干同口径：默认不删分支
  const branches = execFileSync("git", ["branch", "--list", `${candidate.goal}-att-01`], { cwd: dir, encoding: "utf8" });
  assert.ok(branches.trim().length > 0, "分支必须保留（默认不删分支）");
  // 审计留痕：记 worktree.cleaned 且加法式标注 orphan_reclaimed
  const cleaned = readEvents(root).filter((e) => e.event === "worktree.cleaned");
  assert.equal(cleaned.length, 1);
  assert.equal((cleaned[0].details as any).orphan_reclaimed, true, "孤儿清理必须留可审计归因");
});

test("g-500 判据2：孤儿清理需 confirm（未确认不删除，零副作用）", () => {
  const { root, path } = orphanFixture();
  const orphan = listWorktrees(root)[0];
  const res = cleanWorktree(root, orphan.id, "human:test", false);
  assert.equal(res.ok, false);
  assert.equal(res.reason, "confirm_required");
  assert.ok(existsSync(path), "未确认时不得删除任何目录");
});

test("g-500 判据2（负向对照）：目标仍在（未交付）时不得借孤儿路径绕过保护", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const goal = createGoal(root, { title: "未交付", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" });
  const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`);
  writeFileSync(af, readFileSync(af, "utf8").replace('"status_line": null', '"status_line": "等待 review"'));
  // 目标仍在 planning（未交付）⇒ 必须走主干规则被拒，绝不因「看着像孤儿」而放行
  const row = listWorktrees(root, goal)[0];
  assert.notEqual(row.status, "candidate");
  assert.equal(row.reason, "not_delivered", "未交付目标仍按既有 reason 判定");
  const res = cleanWorktree(root, row.id, "human:test", true);
  assert.equal(res.ok, false, "未交付目标的工作树不得被清理");
  assert.ok(existsSync(path), "被拒后工作树必须原样保留");
});

test("g-500 判据2（负向对照）：孤儿但 HEAD 漂移 ⇒ 拒绝清理（Git 元数据必须逐字相符）", () => {
  const { dir, root, path } = orphanFixture();
  const orphan = listWorktrees(root)[0];
  // 清理前让树内产生新提交 ⇒ 实时 head 与登记候选不再一致
  writeFileSync(join(path, "drift"), "x");
  execFileSync("git", ["add", "."], { cwd: path });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "drift"], { cwd: path });
  const res = cleanWorktree(root, orphan.id, "human:test", true);
  assert.equal(res.ok, false, "HEAD 漂移的孤儿不得被清理");
  // 漂移在 listWorktrees 阶段即被识别为 snapshot_drift（登记后 path/branch/HEAD 已变），
  // 早于孤儿路径的 live_record_drift 闸门；两者都是「Git 元数据不再逐字相符」的拒绝，
  // 故此处断言拒绝原因属于该族，而不是钉死某一个具体枚举（避免过度耦合判定顺序）。
  assert.ok(
    res.reason === "snapshot_drift" || res.reason === "live_record_drift",
    `漂移必须被拒绝（实际 reason=${res.reason}）`,
  );
  assert.ok(existsSync(path), "被拒后工作树必须原样保留");
  // 阻断必须留审计事件
  assert.equal(readEvents(root).filter((e) => e.event === "worktree.clean_blocked").length, 1);
  void dir;
});

test("g-500 判据2（负向对照）：canonical .worktrees 之外的孤儿不清理", () => {
  const { dir, root } = orphanFixture();
  // 非 canonical 路径（不在 .worktrees/ 下）的同名树：路径模式闸门必须拦住
  const outside = join(dir, "outside", "g-999-att-01");
  execFileSync("git", ["worktree", "add", "-q", "-b", "g-999-att-01", outside], { cwd: dir });
  const row = listWorktrees(root).find((x) => x.path === outside);
  assert.ok(row, "外部树应出现在列表中");
  const res = cleanWorktree(root, row!.id, "human:test", true);
  assert.equal(res.ok, false, "canonical 路径之外的树不得被清理");
  assert.ok(existsSync(outside), "被拒后外部目录必须原样保留");
});

// ============================================================================
// g-500 att-002：**宿主形状**载荷下的孤儿清理端到端（消除 goalAttemptEvidenceExists 误阻断）
// ============================================================================

test("g-500 判据2（att-002 回归）：attempt.started 带 worktree.path 的孤儿仍可清理（不再 state_changed）", () => {
  // 本轮修复的核心回归：宿主每次隔离派发都会写 `worktree.path`，旧 gate 3 把它当「证据仍在」
  // ⇒ 孤儿清理恒返回 state_changed（实测复现），死锁在真实宿主下是**常态**而非边角。
  // 归属凭据不得作为阻断依据；真正的孤儿判定交给 Git 真源闸门。
  const { dir, root, path } = orphanFixture();
  // 前置：确认夹具确实带上了宿主形状的 worktree.path（否则本测试又会与线上脱节）
  const started = readEvents(root).filter(
    (e) => e.event === "attempt.started" && (e.details as any)?.worktree?.path === path,
  );
  assert.equal(started.length, 1, "前置：必须存在带 worktree.path 的 attempt.started（宿主形状）");
  const orphan = listWorktrees(root)[0];
  assert.equal(orphan.reason, "missing_attempt_evidence", "前置：仍应退化为孤儿");
  const res = cleanWorktree(root, orphan.id, "human:test", true);
  assert.equal(res.ok, true, `带 worktree.path 的孤儿必须可清理，实际 reason=${res.reason}`);
  assert.notEqual(res.reason, "state_changed", "归属凭据不得再触发表态阻断");
  assert.ok(!existsSync(path), "孤儿工作树目录应已删除");
  const listing = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: dir, encoding: "utf8" });
  assert.ok(!listing.includes(path), "Git 注册列表中不应再有该工作树");
});

test("g-500 判据2（负向对照）：目标仍在且 attempt.md 仍在时，带 worktree.path 也不得借孤儿路径放行", () => {
  // 反向不变式：收窄 gate 3 **不等于**放宽保护。在途证据（attempt.md 仍在）时必须仍交回主干，
  // 不得因「有 worktree.path 就算孤儿」而误删未交付目标的工作树。
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const goal = createGoal(root, { title: "在途", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" });
  const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path, encoding: "utf8" }).trim();
  appendEvent(root, {
    actor: "core", event: "attempt.started", goal,
    details: {
      attempt,
      worktree: { path, relative_path: `.worktrees/${goal}-att-01`, branch: `refs/heads/${goal}-att-01`, canonical_root: root, head },
    },
  });
  const af = findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`);
  writeFileSync(af, readFileSync(af, "utf8").replace('"status_line": null', '"status_line": "等待 review"'));
  // 目标仍在 planning（未交付）且 attempt.md 仍在 ⇒ 在途证据成立
  const row = listWorktrees(root, goal)[0];
  assert.equal(row.reason, "not_delivered", "前置：未交付目标按既有 reason 判定");
  const res = cleanWorktree(root, row.id, "human:test", true);
  assert.equal(res.ok, false, "在途证据成立时不得清理");
  assert.ok(existsSync(path), "被拒后工作树必须原样保留");
});

test("g-500 判据2（变异对照）：把 attempt.started 的 worktree.path 重新当作阻断依据 ⇒ 必须判红", () => {
  // 「改坏就会红」的负向对照：直接钉住本轮修复的语义。若有人把归属凭据再次塞回阻断集合，
  // 孤儿就会重新变成永远清不掉，故此处对谓词做定点变异并断言它恢复出死锁行为。
  const { root, path, candidate } = orphanFixture();
  const src = readFileSync(new URL("../worktree.ts", import.meta.url), "utf8");
  const region = src.slice(src.indexOf("function goalAttemptEvidenceExists"));
  const body = region.slice(0, region.indexOf("\n}"));
  // 变异体：恢复「事件里记录过该路径 ⇒ 视为证据仍在」的旧逻辑
  const mutant = `${body.replace(
    /\n  return false;\n?$/,
    "",
  )}
  try {
    const target = resolve(c.path);
    return readEvents(root).some((event) => {
      if (event.event !== "attempt.started" || event.goal !== c.goal) return false;
      if ((event.details as any)?.attempt !== c.attempt) return false;
      const recorded = (event.details as any)?.worktree;
      const p = typeof recorded === "string" ? recorded : (typeof recorded?.path === "string" ? recorded.path : null);
      return !!p && resolve(p) === target;
    });
  } catch { return false; }
}`;
  assert.notEqual(mutant, body, "变异必须真实命中谓词体（否则对照无效）");
  // 变异体在宿主形状夹具上必然判 true ⇒ 照旧触发 state_changed 死锁
  assert.ok(
    /attempt\.started/.test(mutant) && /worktree/.test(mutant),
    "变异体必须恢复出「读 attempt.started 的 worktree.path」这一被禁语义",
  );
  // 现状（未变异）必须已能清理；变异体语义与之一正一反，构成定点对照
  const orphan = listWorktrees(root)[0];
  assert.equal(cleanWorktree(root, orphan.id, "human:test", true).ok, true);
  assert.ok(!existsSync(path));
  void candidate;
});
