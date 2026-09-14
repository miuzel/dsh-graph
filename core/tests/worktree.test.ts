import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { init, createGoal, startAttempt, findGoalFile, resolveAccept } from "../ops.ts";
import { listWorktrees, cleanWorktree, registerWorktreeCandidates, defaultWorktreeForGoalType, prepareAttemptWorktree } from "../worktree.ts";

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
