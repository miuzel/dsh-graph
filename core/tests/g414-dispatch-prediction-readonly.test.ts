/**
 * g-414 回归：attempt ID 预测只读 + 建树失败零目录残留
 *
 * 背景（终局 codex 只读复核确认的 P2）：`dsh-graph-host/index.js` 的派发路径为预测
 * `nextAttId` 先 `mkdirSync(attemptsDir, { recursive: true })` 再 `readdirSync` 计数，
 * 之后才 `prepareAttemptWorktree(…)`。⇒ 建树失败（`prepareAttemptWorktree` 抛 `GraphError`）
 * 时，空的 `<goalDir>/attempts/` 已被创建并残留，与 AGENTS.md「派发即隔离」的
 * 「失败即停零副作用」措辞不完全一致（空目录虽不在「不迁移状态/不建 attempt/不启动子代理」
 * 三项枚举内，但目标是最小化失败残留、可安全重试）。
 *
 * 本文件钉住三件事：
 *  1. 失败路径（判据 3）：非法 `baseline_commit` ⇒ `prepareAttemptWorktree` 抛错 ⇒
 *     `attempts/` 目录**未被创建**、零 `att-*` 目录、状态未迁移、未启动子代理、无 worktree 残留；
 *     且**失败后重试仍得 `att-001`**（空目录不占用编号 ⇒ 真正可重试）。
 *  2. ID 预测口径（判据 2）：目录不存在 ⇒ 首次 `att-001`；目录已存在（含非 `att-*` 杂项）⇒
 *     计数口径与既有 `count(att-*)+1` 逐字一致；隔离路径下宿主预测与 core 分配必须一致
 *     （worktree 名 att-NN ↔ 落盘 attempt id 同号）。
 *  3. 结构性守卫 + 负向对照（判据 1/3）：派发源码中 `mkdirSync(attemptsDir)` 必须恰好一处、
 *     且**晚于** `prepareAttemptWorktree`；预测必须容忍 `ENOENT`。回退成「先建目录再计数」、
 *     去掉 `ENOENT` 容忍、或删掉建树后的 mkdir 都必须被判红。
 *
 * 「计数 +1 未加锁」是**既有**语义（并发下可能撞号），本目标不改变也不扩大它——测试只钉住
 * 单线程下的口径与残留，不对并发加锁作任何断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createGoal, findGoalFile, goalDetail, init, loadGoal, setCriteria } from "../ops.ts";
import { apply } from "../../dist/index.js";

const REPO_ROOT = join(import.meta.dirname, "../..");
const DISPATCH_SOURCE = join(REPO_ROOT, "dsh-graph-host/index.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** 私有板副本 + 子代理桩（与 g-406 同构；`spawnedAt` 记录子代理是否被启动）。 */
function createHarness({ gitRepo = false } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "g414-board-"));
  if (gitRepo) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    writeFileSync(join(ws, "README"), "x");
    writeFileSync(join(ws, ".gitignore"), ".worktrees/\n.dsh-graph/\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
  }
  const root = join(ws, ".dsh-graph");
  init(root);

  const spawnedAt: string[] = [];
  const registeredTools: any[] = [];
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "subagents") {
        return {
          list: () => ["spawn"],
          getProvider: () => ({ prepareContinuable: () => {} }),
          startContinuable: async (opts: any) => {
            spawnedAt.push(opts.label);
            return { childId: "child-" + Math.random().toString(36).slice(2, 8), parentSessionId: "sess-super" };
          },
        };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registeredTools.push(def); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });

  const tools = new Map(registeredTools.map((t: any) => [t.name, t]));
  return {
    ws,
    root,
    spawnedAt,
    routes,
    dispatch: (args: any) =>
      tools.get("graph_start_attempt").execute(args, {
        agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } },
        signal: new AbortController().signal,
      }),
  };
}

function mkGoal(root: string, title: string, type: string): string {
  const goal = createGoal(root, { title, version: "v1.0", type, actor: "human:gui" });
  setCriteria(root, goal, ["判据"], "human:gui");
  return goal;
}

function attemptsDirOf(root: string, goal: string): string {
  return join(dirname(findGoalFile(root, goal)), "attempts");
}
/** 目录里的 `att-*` 条目（不存在的目录视作零项，正是本目标的语义）。 */
function attEntriesOf(root: string, goal: string): string[] {
  const dir = attemptsDirOf(root, goal);
  return existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("att-")) : [];
}
function goalStatus(root: string, goal: string): string {
  return String(loadGoal(findGoalFile(root, goal)).meta.status ?? "");
}

// ============================================================================
// 判据 3：建树失败 ⇒ 零目录残留、零 attempt、状态未迁移、未启动子代理
// ============================================================================

test("g-414 判据 3：建树失败（非法 baseline_commit）不留 attempts/，状态未迁移且未启动子代理", async () => {
  const h = createHarness({ gitRepo: true });
  const goal = mkGoal(h.root, "非法基线", "feature"); // feature ⇒ 默认建树，必达 prepareAttemptWorktree
  const before = goalStatus(h.root, goal);
  assert.notEqual(before, "in_progress", "前置：派发前目标不应已在执行中");
  assert.equal(existsSync(attemptsDirOf(h.root, goal)), false, "前置：未派发时 attempts/ 不应存在");

  const error = await h.dispatch({
    goal,
    attempt_brief: "隔离执行",
    baseline_commit: "0".repeat(40), // 合法形状但不存在的 commit ⇒ prepareAttemptWorktree 抛 GraphError
  }).then(() => null, (e: unknown) => e as Error);

  assert.ok(error, "非法 baseline_commit 必须硬失败（不得静默降级为非隔离）");
  assert.match(String(error.message), /基线 commit 无效或不存在/, "错误必须可读且指向建树失败原因");

  // ① 失败路径零目录残留
  assert.equal(existsSync(attemptsDirOf(h.root, goal)), false, "建树失败不得预建 attempts/");
  assert.deepEqual(attEntriesOf(h.root, goal), [], "零 att-* 目录");
  assert.equal(existsSync(join(h.ws, ".worktrees", `${goal}-att-01`)), false, "零 worktree 残留");
  // ② 状态未迁移 + 无 attempt
  assert.equal(goalStatus(h.root, goal), before, "建树失败不得迁移状态");
  assert.equal(goalDetail(h.root, goal).attempts.length, 0, "建树失败不得创建 attempt");
  // ③ 未启动子代理
  assert.equal(h.spawnedAt.length, 0, "建树失败不得启动子代理");
});

test("g-414 判据 3（可重试）：失败后重试同一目标仍得 att-001，编号不偏移", async () => {
  const h = createHarness({ gitRepo: true });
  const goal = mkGoal(h.root, "失败后重试", "feature");

  await assert.rejects(
    () => h.dispatch({ goal, attempt_brief: "首次（非法基线）", baseline_commit: "0".repeat(40) }),
    /基线 commit 无效或不存在/,
  );
  assert.equal(existsSync(attemptsDirOf(h.root, goal)), false, "失败后仍不得留下 attempts/（否则它会占用编号）");

  const res = await h.dispatch({ goal, attempt_brief: "重试（合法基线）" });
  assert.equal(res.attempt, "att-001", "无残留目录 ⇒ 重试必须仍分配到 att-001");
  assert.equal(basename(String(res.worktree?.path ?? "")), `${goal}-att-01`, "worktree 名必须与 attempt 编号同号");
  assert.equal(goalDetail(h.root, goal).attempts.length, 1);
  assert.equal(h.spawnedAt.length, 1, "重试成功 ⇒ 子代理恰启动一次");
});

// ============================================================================
// 判据 2：ID 预测口径（不存在 / 首次 / 已存在含杂项）
// ============================================================================

test("g-414 判据 2：目录不存在时首次派发得 att-001（非隔离路径）", async () => {
  const h = createHarness({ gitRepo: true });
  const goal = mkGoal(h.root, "首次非隔离", "task"); // 干净工作区 + task ⇒ 类型默认不建树
  assert.equal(existsSync(attemptsDirOf(h.root, goal)), false);

  const res = await h.dispatch({ goal, attempt_brief: "首次派发" });
  assert.equal(res.attempt, "att-001");
  assert.equal(res.isolated, false);
  // 成功路径由 core 落盘并创建目录
  assert.ok(existsSync(join(attemptsDirOf(h.root, goal), "att-001", "attempt.md")), "att-001 记录应已落盘");
});

test("g-414 判据 2：目录不存在时首次派发得 att-001（隔离路径，宿主预测与 core 同号）", async () => {
  const h = createHarness({ gitRepo: true });
  const goal = mkGoal(h.root, "首次隔离", "feature");

  const res = await h.dispatch({ goal, attempt_brief: "首次隔离派发" });
  assert.equal(res.attempt, "att-001");
  assert.equal(res.isolated, true);
  assert.equal(basename(String(res.worktree?.path ?? "")), `${goal}-att-01`, "宿主预测的 worktree 名与 core 分配的 id 必须同号");
  assert.ok(existsSync(join(attemptsDirOf(h.root, goal), "att-001", "attempt.md")));
});

test("g-414 判据 2：目录仅有非 att-* 杂项时不计入 ⇒ 首次仍得 att-001", async () => {
  const h = createHarness({ gitRepo: true });
  const goal = mkGoal(h.root, "杂项不计数", "feature");
  const dir = attemptsDirOf(h.root, goal);
  mkdirSync(join(dir, "scratch"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "x");
  writeFileSync(join(dir, "notes.txt"), "x");

  const res = await h.dispatch({ goal, attempt_brief: "杂项在场" });
  assert.equal(res.attempt, "att-001", "计数口径 = count(att-*)+1，杂项不得计入");
  assert.equal(basename(String(res.worktree?.path ?? "")), `${goal}-att-01`);
});

test("g-414 判据 2：目录已存在 att-001/att-002 时递增得 att-003（宿主预测与 core 同号）", async () => {
  const h = createHarness({ gitRepo: true });
  const goal = mkGoal(h.root, "递增口径", "feature");
  const dir = attemptsDirOf(h.root, goal);
  mkdirSync(join(dir, "att-001"), { recursive: true });
  mkdirSync(join(dir, "att-002"), { recursive: true });

  const res = await h.dispatch({ goal, attempt_brief: "第三次派发" });
  assert.equal(res.attempt, "att-003", "count(att-*)+1 与既有口径逐字一致");
  assert.equal(basename(String(res.worktree?.path ?? "")), `${goal}-att-03`, "宿主预测与 core 分配同号");
  assert.ok(existsSync(join(dir, "att-003", "attempt.md")));
});

test("g-414 判据 2：att-* 前缀的非目录条目同样计入（口径 = count(att-*)+1，不看类型）", async () => {
  const h = createHarness({ gitRepo: true });
  const goal = mkGoal(h.root, "前缀口径", "feature");
  const dir = attemptsDirOf(h.root, goal);
  mkdirSync(join(dir, "att-001"), { recursive: true });
  mkdirSync(join(dir, "att-002"), { recursive: true });
  writeFileSync(join(dir, "att-999-not-a-dir"), "x");

  const res = await h.dispatch({ goal, attempt_brief: "第四次派发" });
  assert.equal(res.attempt, "att-004", "3 项 att-* ⇒ 4；与既有实现（core startAttempt 同公式）一致");
  assert.equal(basename(String(res.worktree?.path ?? "")), `${goal}-att-04`);
  assert.deepEqual(attEntriesOf(h.root, goal).sort(), ["att-001", "att-002", "att-004", "att-999-not-a-dir"]);
});

// ============================================================================
// 判据 1/3：结构性守卫 + 负向对照（回退即成「先建目录再计数」必红）
// ============================================================================

/** 锚点化变异：锚点必须恰好命中一次，否则报错（避免负向对照静默失效——g-348 纪律）。 */
function mutateOnce(source: string, anchor: string, replacement: string): string {
  const hits = source.split(anchor).length - 1;
  assert.equal(hits, 1, `负向对照锚点必须恰好命中一次，实际 ${hits} 次：${JSON.stringify(anchor)}`);
  return source.replace(anchor, replacement);
}

/** 只取「预测下一 attempt ID」到「g-406 隔离判定」之间的一段：本不变式的取证区域。 */
function predictionRegion(source: string): string {
  const start = source.indexOf("// 预测下一 attempt ID");
  assert.ok(start >= 0, "未找到「预测下一 attempt ID」锚点（结构已变，请同步更新本守卫）");
  const end = source.indexOf("// g-406：派发返回必须", start);
  assert.ok(end > start, "未找到预测段结束边界（结构已变，请同步更新本守卫）");
  return source.slice(start, end);
}

/**
 * 判定器：返回 `null` 表示满足「预测只读 + 建树失败零残留」；否则返回违约说明。
 * 契约：① `mkdirSync(attemptsDir…)` 恰好一处且晚于 `prepareAttemptWorktree`；
 * ② 预测的 `readdirSync(attemptsDir)` 容忍 `ENOENT`（目录不存在视作 0 项）。
 */
function predictionReadOnlyViolation(region: string): string | null {
  if (!region.includes('const attemptsDir = join(dirname(goalFile), "attempts");')) {
    return "预测段未按 attemptsDir 计算（结构已变，请同步更新本守卫）";
  }
  if ((region.split("readdirSync(attemptsDir)").length - 1) !== 1) {
    return "预测段应恰好一处 readdirSync(attemptsDir)";
  }
  if (!/catch\s*\([^)]*\)\s*\{[^}]*code\s*!==\s*"ENOENT"[^}]*throw/s.test(region)) {
    return "预测必须容忍 ENOENT（目录不存在视作 0 项），否则首次派发或非 git 环境会读目录失败";
  }
  const creates = region.split("prepareAttemptWorktree(").length - 1;
  if (creates !== 1) return `预测段应恰好一处 prepareAttemptWorktree(，实际 ${creates} 处`;
  const mkdirs = region.split("mkdirSync(attemptsDir").length - 1;
  if (mkdirs !== 1) return `mkdirSync(attemptsDir…) 应恰好一处（建树成功后才建目录），实际 ${mkdirs} 处`;
  if (region.indexOf("mkdirSync(attemptsDir") < region.indexOf("prepareAttemptWorktree(")) {
    return "attempts/ 在 prepareAttemptWorktree 之前被预建 ⇒ 建树失败会残留空目录";
  }
  return null;
}

test("g-414 判据 1/3 负向对照：结构性守卫钉住「预测只读 + 建树成功后才建 attempts/」", () => {
  const source = readFileSync(DISPATCH_SOURCE, "utf8");
  assert.equal(predictionReadOnlyViolation(predictionRegion(source)), null, "当前实现应满足预测只读与失败零残留");

  // 变异 A（真实缺陷形态）：恢复「先 mkdir 再计数」⇒ 预建目录 + mkdir 计数 2 ⇒ 必红
  const preCreated = mutateOnce(
    source,
    '    const attemptsDir = join(dirname(goalFile), "attempts");\n',
    '    const attemptsDir = join(dirname(goalFile), "attempts");\n    mkdirSync(attemptsDir, { recursive: true });\n',
  );
  assert.match(String(predictionReadOnlyViolation(predictionRegion(preCreated))), /mkdirSync|预建/);

  // 变异 B：去掉 ENOENT 容忍（首次派发读目录失败）⇒ 必红
  const intolerant = mutateOnce(source, 'if (e?.code !== "ENOENT") throw e;', "throw e;");
  assert.match(String(predictionReadOnlyViolation(predictionRegion(intolerant))), /ENOENT/);

  // 变异 C：删掉建树成功后的 mkdir ⇒ 必红（目录不再被准备）
  const noMkdir = mutateOnce(source, "    mkdirSync(attemptsDir, { recursive: true });\n", "");
  assert.match(String(predictionReadOnlyViolation(predictionRegion(noMkdir))), /mkdirSync/);
});
