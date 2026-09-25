/**
 * g-329 回归：已放弃（abandon）/ 已解绑（detach）的 attempt 其 worktree 必须判为 candidate。
 *
 * 现象：`graph_list_worktrees` 把早已正确放弃的 attempt 的 worktree 判为 `active`，
 * 以 `protected / attempt_active` 永久拒绝清理，`graph_clean_worktree` 随之拒绝执行。
 * 根因：`core/worktree.ts` 的 `isActive()` 终态白名单漏了放弃路径实际写入的 result 取值。
 *
 * 本测试刻意走**真实放弃路径**（`abandonAttempt`）而非手改 YAML，使「写入值」与
 * 「活跃判定读取值」的约定一致性被真正验证（判据 1），而不是只测一个手写常量。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { init, createGoal, startAttempt, findGoalFile, resolveAccept, abandonAttempt } from "../ops.ts";
import { listWorktrees, cleanWorktree } from "../worktree.ts";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "dsh-g329-worktree-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  init(join(dir, ".dsh-graph"));
  return dir;
}

function attemptFile(root: string, goal: string, attempt: string): string {
  return findGoalFile(root, goal).replace(/goal\.md$/, `attempts/${attempt}/attempt.md`);
}

/** 场景：worktree 与 main 同 HEAD（merged=true）、工作区干净（clean=true）、目标 delivered。
 *  唯一变量是 attempt 的活跃性判定。 */
test("g-329 abandonAttempt 后 worktree 判为 candidate，且 cleanWorktree 可执行（不再 protected/attempt_active）", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const goal = createGoal(root, { title: "abandoned", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" });
  const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });

  // 真实放弃路径：写 result="cancelled" + detached=true，并记 attempt.abandoned 事件
  abandonAttempt(root, goal, { actor: "test", attempt, reason: "派发后首个 step 即失败" });

  // 判据 1：放弃路径写入的 result 取值就是判定侧必须认识的终态值
  const raw = readFileSync(attemptFile(root, goal, attempt), "utf8");
  assert.match(raw, /"result": "cancelled"/, "放弃路径必须写 result=cancelled");
  assert.match(raw, /"detached": true/);

  // 交付目标（交付后本路径不再允许放弃，故顺序为先放弃后交付，与 g-321 实例一致）
  const gf = findGoalFile(root, goal);
  writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "review"'));
  resolveAccept(root, goal, { actor: "supervisor:test", verdict: "accept" });

  // 判据 2：已放弃 attempt 的 worktree 必须是候选项，而不是 protected/attempt_active
  const row = listWorktrees(root, goal)[0];
  assert.equal(row.active, false, `abandoned attempt 不得判为活跃（reason=${row.reason}）`);
  assert.equal(row.status, "candidate", `应可清理（reason=${row.reason}）`);
  assert.equal(row.reason, null);
  // 工具侧清理不再被拒绝（现象：graph_clean_worktree 拒绝执行）
  assert.equal(cleanWorktree(root, row.id, "human:test", true).ok, true);
});

/** 判据 4：与 attempt.detached 语义对齐——受控解绑写入的 result="detached" 亦为终态。
 *  （写入点：core/ops.ts unbindGoalChild 在 result=pending 时置 result="detached"。） */
test("g-329 受控解绑写入的 result=detached 亦判为非活跃", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const goal = createGoal(root, { title: "detached", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" });
  const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });

  const file = attemptFile(root, goal, attempt);
  writeFileSync(file, readFileSync(file, "utf8")
    .replace('"result": "pending"', '"result": "detached"'));

  const gf = findGoalFile(root, goal);
  writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "delivered"'));

  const row = listWorktrees(root, goal)[0];
  assert.equal(row.active, false, `detached attempt 不得判为活跃（reason=${row.reason}）`);
  assert.equal(row.status, "candidate", `reason=${row.reason}`);
});

/** 判据 3：pending 分支语义不得回归——非终态仍保守视为活跃。 */
test("g-329 pending 非终态仍保守判为活跃（不回归）", () => {
  const dir = repo(); const root = join(dir, ".dsh-graph");
  const goal = createGoal(root, { title: "still-running", version: "v-test", actor: "test" });
  const attempt = startAttempt(root, goal, { executor: "test", actor: "test" });
  const path = join(dir, ".worktrees", `${goal}-att-01`);
  execFileSync("git", ["worktree", "add", "-q", "-b", `${goal}-att-01`, path], { cwd: dir });

  const file = attemptFile(root, goal, attempt);
  writeFileSync(file, readFileSync(file, "utf8").replace('"status_line": null', '"status_line": "正在执行测试"'));

  const gf = findGoalFile(root, goal);
  writeFileSync(gf, readFileSync(gf, "utf8").replace('"status": "planning"', '"status": "delivered"'));

  const row = listWorktrees(root, goal)[0];
  assert.equal(row.active, true);
  assert.notEqual(row.status, "candidate");
});
