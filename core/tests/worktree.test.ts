import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { init, createGoal, startAttempt, findGoalFile, resolveAccept } from "../ops.ts";
import { listWorktrees, cleanWorktree, registerWorktreeCandidates } from "../worktree.ts";

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
