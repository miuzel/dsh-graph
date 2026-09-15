import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectWorkspaceCleanliness,
  resolveWorktreeIsolationDecision,
  defaultWorktreeForGoalType,
  type GitCleanlinessResult,
} from "../worktree.ts";

// ============================================================================
// g-289 覆盖矩阵：{干净, 脏, git失败} × {patch/chore, feature/bug} × {显式true, 显式false, 未传}
// ============================================================================

function cleanProbe(): GitCleanlinessResult {
  return { clean: true };
}

function dirtyProbe(): GitCleanlinessResult {
  return { clean: false, dirtyReason: " M core/ops.ts" };
}

function failedProbe(): GitCleanlinessResult {
  return { clean: null, error: "not a git repository" };
}

// ---- 显式参数优先级最高（规则 1） ----

test("g-289 显式 worktree=true：无论脏/干净/探测失败，patch 也返回 isolate=true reason=explicit", () => {
  for (const probe of [cleanProbe(), dirtyProbe(), failedProbe(), undefined]) {
    const d = resolveWorktreeIsolationDecision("patch", true, probe);
    assert.equal(d.isolate, true, `probe=${JSON.stringify(probe)}`);
    assert.equal(d.reason, "explicit");
  }
});

test("g-289 显式 worktree=false：无论脏/干净/探测失败，feature 也返回 isolate=false reason=explicit", () => {
  for (const probe of [cleanProbe(), dirtyProbe(), failedProbe(), undefined]) {
    const d = resolveWorktreeIsolationDecision("feature", false, probe);
    assert.equal(d.isolate, false, `probe=${JSON.stringify(probe)}`);
    assert.equal(d.reason, "explicit");
  }
});

test("g-289 显式 null 与 undefined 不算显式（回退到脏探测/类型默认）", () => {
  // null 不算显式——脏工作树仍应升级
  const dNull = resolveWorktreeIsolationDecision("patch", null, dirtyProbe());
  assert.equal(dNull.isolate, true);
  assert.equal(dNull.reason, "dirty_workspace");

  // undefined 不算显式——干净时按类型默认
  const dUndef = resolveWorktreeIsolationDecision("patch", undefined, cleanProbe());
  assert.equal(dUndef.isolate, false);
  assert.equal(dUndef.reason, "type_default");
});

// ---- 脏工作树防御（规则 2，核心增量） ----

test("g-289 脏工作树：patch/chore/task 也默认隔离，reason=dirty_workspace，含中英提示", () => {
  for (const typ of ["patch", "chore", "task"]) {
    const d = resolveWorktreeIsolationDecision(typ, undefined, dirtyProbe());
    assert.equal(d.isolate, true, `type=${typ} should isolate when dirty`);
    assert.equal(d.reason, "dirty_workspace");
    assert.ok(d.userMessage?.zh?.includes("未提交改动"), `type=${typ} should have zh message`);
    assert.ok(d.userMessage?.en?.includes("uncommitted changes"), `type=${typ} should have en message`);
    assert.ok(d.probeState && d.probeState.clean === false, "probeState attached");
  }
});

test("g-289 脏工作树：feature/bug/improvement 也返回隔离（本身默认就隔离，但 reason 应为 dirty_workspace）", () => {
  for (const typ of ["feature", "bug", "improvement"]) {
    const d = resolveWorktreeIsolationDecision(typ, undefined, dirtyProbe());
    assert.equal(d.isolate, true, `type=${typ}`);
    assert.equal(d.reason, "dirty_workspace");
    assert.ok(d.userMessage, `${typ} should have userMessage`);
  }
});

// ---- 干净工作树，按类型默认（规则 3） ----

test("g-289 干净工作树：patch/chore/task 不隔离，reason=type_default", () => {
  for (const typ of ["patch", "chore", "task"]) {
    const d = resolveWorktreeIsolationDecision(typ, undefined, cleanProbe());
    assert.equal(d.isolate, false, `type=${typ} should NOT isolate when clean`);
    assert.equal(d.reason, "type_default");
    assert.equal(d.userMessage, undefined, "clean workspace should not have hint");
  }
});

test("g-289 干净工作树：feature/bug/improvement 隔离，reason=type_default", () => {
  for (const typ of ["feature", "bug", "improvement"]) {
    const d = resolveWorktreeIsolationDecision(typ, undefined, cleanProbe());
    assert.equal(d.isolate, true, `type=${typ} should isolate (type default)`);
    assert.equal(d.reason, "type_default");
    assert.equal(d.userMessage, undefined);
  }
});

test("g-289 无 probe：等同干净，按类型默认", () => {
  assert.equal(resolveWorktreeIsolationDecision("patch", undefined, undefined).isolate, false);
  assert.equal(resolveWorktreeIsolationDecision("feature", undefined, undefined).isolate, true);
  assert.equal(resolveWorktreeIsolationDecision("patch", undefined, undefined).reason, "type_default");
});

// ---- 探测失败回退（规则 4，fail-closed 降级策略） ----

test("g-289 探测失败（clean=null）：patch/chore/task 回退按类型默认（不隔离），reason=type_default", () => {
  for (const typ of ["patch", "chore", "task"]) {
    const d = resolveWorktreeIsolationDecision(typ, undefined, failedProbe());
    assert.equal(d.isolate, false, `type=${typ} should NOT force-isolate on probe failure`);
    assert.equal(d.reason, "type_default");
    assert.equal(d.userMessage, undefined, "probe failure should not have dirty hint");
    assert.ok(d.probeState && d.probeState.clean === null, "probeState attached");
  }
});

test("g-289 探测失败（clean=null）：feature/bug 回退按类型默认（隔离），reason=type_default", () => {
  for (const typ of ["feature", "bug"]) {
    const d = resolveWorktreeIsolationDecision(typ, undefined, failedProbe());
    assert.equal(d.isolate, true, `type=${typ} should isolate (type default)`);
    assert.equal(d.reason, "type_default");
    assert.equal(d.userMessage, undefined);
  }
});

// ---- probeState 传播 ----

test("g-289 probeState 在各决策路径中正确传播", () => {
  const d1 = resolveWorktreeIsolationDecision("patch", true, dirtyProbe());
  assert.deepEqual(d1.probeState, dirtyProbe());

  const d2 = resolveWorktreeIsolationDecision("patch", false, cleanProbe());
  assert.deepEqual(d2.probeState, cleanProbe());

  const d3 = resolveWorktreeIsolationDecision("patch", undefined, failedProbe());
  assert.deepEqual(d3.probeState, failedProbe());

  const d4 = resolveWorktreeIsolationDecision("patch", undefined, undefined);
  assert.equal(d4.probeState, undefined);
});

// ============================================================================
// detectWorkspaceCleanliness 纯函数测试（可注入 gitRunner）
// ============================================================================

test("g-289 detectWorkspaceCleanliness：干净仓库返回 clean=true", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-g289-clean-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });

  const r = detectWorkspaceCleanliness(dir);
  assert.equal(r.clean, true);
});

test("g-289 detectWorkspaceCleanliness：有未提交改动返回 clean=false 且含 dirtyReason", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-g289-dirty-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "README"), "x");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  // 制造脏状态
  writeFileSync(join(dir, "uncommitted.txt"), "dirty");

  const r = detectWorkspaceCleanliness(dir);
  assert.equal(r.clean, false);
  assert.ok("dirtyReason" in r, "dirty result must have dirtyReason");
  assert.ok(r.dirtyReason!.length > 0, "dirtyReason must be non-empty");
});

test("g-289 detectWorkspaceCleanliness：非 git 目录返回 clean=null", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-g289-nogit-"));
  const r = detectWorkspaceCleanliness(dir);
  assert.equal(r.clean, null);
  assert.ok("error" in r, "null result must have error field");
});

test("g-289 detectWorkspaceCleanliness：可注入 gitRunner 模拟成功/失败", () => {
  const fakeWs = "/tmp/fake";
  // 干净
  const cleanRunner = (_cwd: string, _args: string[]) => "";
  assert.deepEqual(detectWorkspaceCleanliness(fakeWs, cleanRunner), { clean: true });

  // 脏
  const dirtyRunner = (_cwd: string, _args: string[]) => " M file.ts\n?? new.ts\n";
  const dirty = detectWorkspaceCleanliness(fakeWs, dirtyRunner);
  assert.equal(dirty.clean, false);
  assert.ok(dirty.dirtyReason.includes("file.ts"));

  // 失败
  const failRunner = (_cwd: string, _args: string[]) => { throw new Error("git not found"); };
  const failed = detectWorkspaceCleanliness(fakeWs, failRunner);
  assert.equal(failed.clean, null);
  assert.ok(failed.error.includes("git not found"));
});

test("g-289 detectWorkspaceCleanliness：dirtyReason 摘要截断（>3 行）", () => {
  const runner = (_cwd: string, _args: string[]) =>
    " M a.ts\n M b.ts\n M c.ts\n M d.ts\n M e.ts\n";
  const r = detectWorkspaceCleanliness("/tmp/fake", runner);
  assert.equal(r.clean, false);
  assert.ok(r.dirtyReason.includes("... (+2 more)"), "should truncate with count");
});

// ============================================================================
// 与 defaultWorktreeForGoalType 的对齐验证
// ============================================================================

test("g-289 resolveWorktreeIsolationDecision 与 defaultWorktreeForGoalType 在无 probe 时完全对齐", () => {
  const types = ["patch", "chore", "task", "feature", "bug", "improvement", null, undefined, "", "research"];
  for (const t of types) {
    const expected = defaultWorktreeForGoalType(t);
    const actual = resolveWorktreeIsolationDecision(t, undefined, undefined);
    assert.equal(actual.isolate, expected, `type=${JSON.stringify(t)}: decision should match default`);
    assert.equal(actual.reason, "type_default");
  }
});

// ============================================================================
// prepareAttemptWorktree reason 透传（g-289 不再默认 "user_choice"）
// ============================================================================

test("g-289 prepareAttemptWorktree：enabled=false 时 reason 透传调用方值，不再默认 user_choice", async () => {
  // 动态导入以避免循环引用
  const { prepareAttemptWorktree } = await import("../worktree.ts");
  const { init } = await import("../ops.ts");
  const dir = mkdtempSync(join(tmpdir(), "dsh-g289-reason-"));
  const root = join(dir, ".dsh-graph");
  init(root);

  const r1 = prepareAttemptWorktree(root, "g-289", "att-01", { enabled: false, reason: "type_default" });
  assert.equal(r1.reason, "type_default");

  const r2 = prepareAttemptWorktree(root, "g-289", "att-02", { enabled: false, reason: "dirty_workspace" });
  assert.equal(r2.reason, "dirty_workspace");

  const r3 = prepareAttemptWorktree(root, "g-289", "att-03", { enabled: false });
  assert.equal(r3.reason, null, "未传 reason 时应为 null，不再默认 user_choice");
});

// ============================================================================
// 完整覆盖矩阵汇总（测试命名即文档）
// ============================================================================

test("g-289 矩阵汇总：dirty+patch+显式false → explicit+不隔离", () => {
  const d = resolveWorktreeIsolationDecision("patch", false, dirtyProbe());
  assert.equal(d.isolate, false);
  assert.equal(d.reason, "explicit");
});

test("g-289 矩阵汇总：dirty+patch+显式true → explicit+隔离", () => {
  const d = resolveWorktreeIsolationDecision("patch", true, dirtyProbe());
  assert.equal(d.isolate, true);
  assert.equal(d.reason, "explicit");
});

test("g-289 矩阵汇总：dirty+patch+未传 → dirty_workspace+隔离", () => {
  const d = resolveWorktreeIsolationDecision("patch", undefined, dirtyProbe());
  assert.equal(d.isolate, true);
  assert.equal(d.reason, "dirty_workspace");
});

test("g-289 矩阵汇总：clean+feature+未传 → type_default+隔离", () => {
  const d = resolveWorktreeIsolationDecision("feature", undefined, cleanProbe());
  assert.equal(d.isolate, true);
  assert.equal(d.reason, "type_default");
});

test("g-289 矩阵汇总：clean+task+未传 → type_default+不隔离", () => {
  const d = resolveWorktreeIsolationDecision("task", undefined, cleanProbe());
  assert.equal(d.isolate, false);
  assert.equal(d.reason, "type_default");
});

test("g-289 矩阵汇总：gitFailed+chore+未传 → type_default+不隔离", () => {
  const d = resolveWorktreeIsolationDecision("chore", undefined, failedProbe());
  assert.equal(d.isolate, false);
  assert.equal(d.reason, "type_default");
});

test("g-289 矩阵汇总：gitFailed+bug+未传 → type_default+隔离", () => {
  const d = resolveWorktreeIsolationDecision("bug", undefined, failedProbe());
  assert.equal(d.isolate, true);
  assert.equal(d.reason, "type_default");
});

test("g-289 矩阵汇总：gitFailed+task+显式true → explicit+隔离", () => {
  const d = resolveWorktreeIsolationDecision("task", true, failedProbe());
  assert.equal(d.isolate, true);
  assert.equal(d.reason, "explicit");
});

test("g-289 矩阵汇总：clean+bug+显式false → explicit+不隔离", () => {
  const d = resolveWorktreeIsolationDecision("bug", false, cleanProbe());
  assert.equal(d.isolate, false);
  assert.equal(d.reason, "explicit");
});

test("g-289 矩阵汇总：dirty+improvement+显式true → explicit+隔离", () => {
  const d = resolveWorktreeIsolationDecision("improvement", true, dirtyProbe());
  assert.equal(d.isolate, true);
  assert.equal(d.reason, "explicit");
});

test("g-289 矩阵汇总：clean+chore+显式true → explicit+隔离", () => {
  const d = resolveWorktreeIsolationDecision("chore", true, cleanProbe());
  assert.equal(d.isolate, true);
  assert.equal(d.reason, "explicit");
});

test("g-289 矩阵汇总：gitFailed+feature+显式false → explicit+不隔离", () => {
  const d = resolveWorktreeIsolationDecision("feature", false, failedProbe());
  assert.equal(d.isolate, false);
  assert.equal(d.reason, "explicit");
});
