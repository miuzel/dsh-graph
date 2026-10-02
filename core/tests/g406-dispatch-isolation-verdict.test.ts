import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGoal, findGoalFile, goalDetail, init, loadGoal, setCriteria } from "../ops.ts";
import { apply } from "../../dist/index.js";

/**
 * g-406 回归：`graph_start_attempt` 的**隔离判定必须可据以判定，且必须与真实工作树状态一致**。
 *
 * 背景（主管亲历三数据点，P1 候选）：同一消息内批量派发两个 attempt 时，返回 `worktree:false`
 * 的一侧事后有时存在 `.worktrees/<goal>-att-01`、有时不存在；g-353 执行者据此以主树为 cwd 启动
 * 并一度误改主树 `scripts/build.sh`（后已恢复）。主管推断为「位置无关 ⇒ 竞态」。
 *
 * 本文件的取证结论（在**私有板副本**内 in-process 复现，非真实看板）：
 * - 返回 `worktree:false` 与「建树成功」都不依赖 batch 位置：同一类型单独派发与批量派发结果一致；
 * - 真实分野是**目标类型 × 工作区干净度**（g-283/g-289 策略）：干净工作区下 patch/chore/task 的
 *   类型默认 = 不建树（`worktree_reason=type_default`），feature/bug/improvement = 建树；
 * - 因此原缺陷是**返回语义不可判定**（`false` 同时可能是「策略豁免」与「建树失败」，且返回里
 *   没有原因字段），而非竞态：本文件把「策略豁免」与「失败」都钉死为可判定的显式字段。
 *
 * 覆盖三类不变式：
 *  1. 返回语义齐备：isolated / worktree / worktree_reason / worktree_created / worktree_reused，
 *     且 isolated === (worktree !== false)，未隔离时必须给出原因（不得只回一个 false）；
 *  2. 返回 ↔ 现实一致：批量并发 N=2 / N=5、以及单个派发对照，逐 attempt 核对
 *     `git worktree list` 注册状态 + 目录存在性 + attempt 记录（worktree / worktree_reason）；
 *  3. 无主树窗口：子代理启动的那一刻（startContinuable 回调内实拍 `git worktree list`），
 *     该 attempt 的工作树**必须已经注册**；建树失败一律抛错（零副作用，不静默降级）。
 *
 * 定性结论（本目标修复的缺陷面）：**响应构造缺陷**。派发核心 `dispatchExecutionAttempt` 的两处
 * 调用方（工具入口、HTTP/GUI 入口）都是**白名单构造**返回对象——只拷了 `worktree`，没有位置放
 * 「为何未隔离」与「创建结果」，因此无论事前事后，主管都无法从响应判定隔离；`worktree:false`
 * 本身是**如实**的（策略豁免），不是乱填、也不是竞态：本文件用启动时刻实拍与 N=2/N=5 复现排除了
 * 「创建晚于启动」与「位置相关」两种假设（见 AGENTS.md「派发即隔离」小节）。
 *
 * 负向对照（回退修复即红，判据 3）：见文件末尾「负向对照」小节——① 旧响应形状（真实事故中
 * 主管看到的那份 `{worktree:false}`）必须被判红；② 结构性守卫对「创建晚于启动 / 创建与启动之间
 * 插入 await」的锚点化变异必须报红；③ 两处响应白名单漏登记隔离判定四件套、或 4 个返回点缺
 * `...isolationReport` 必须被识别。
 */

const REPO_ROOT = join(import.meta.dirname, "../..");
const DISPATCH_SOURCE = join(REPO_ROOT, "dsh-graph-host/index.js");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
/** `git worktree list --porcelain` 的实际注册路径集合（解析绝对路径，忽略尾斜杠差异）。 */
function registeredTrees(cwd: string): string[] {
  return git(cwd, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim());
}
/** attempt.md 的落盘真源（goalDetail 的 attempt 投影不含 worktree_reason，故直接读 meta）。 */
function attemptMeta(root: string, goalId: string, attemptId: string): any {
  return loadGoal(join(dirname(findGoalFile(root, goalId)), "attempts", attemptId, "attempt.md")).meta;
}

/** 符号链接稳健的路径归一（macOS /tmp → /private/tmp 等）。 */
function canonical(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}
/** worktree 目录名契约：`.worktrees/<goal>-att-<NN>`（两位序号；g-283 既有命名规范，本目标不改）。 */
function worktreePath(ws: string, goalId: string, attemptId: string): string {
  const seq = Number(attemptId.replace(/^att-/, ""));
  return join(ws, ".worktrees", `${goalId}-att-${String(seq).padStart(2, "0")}`);
}

/** 私有板副本 + 双子代理桩；`spawnedAt` 记录「子代理启动那一刻」的真实工作树注册状态。 */
function createHarness({ gitRepo = false, providers = ["spawn"], providerHasPrepareContinuable = true, spawnError = null } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "g406-board-"));
  if (gitRepo) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    writeFileSync(join(ws, "README"), "x");
    // 与真实仓库同构：.worktrees/ 与 .dsh-graph/ 均被忽略，不得污染「工作区是否脏」的判定。
    writeFileSync(join(ws, ".gitignore"), ".worktrees/\n.dsh-graph/\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
  }
  const root = join(ws, ".dsh-graph");
  init(root);

  const spawnedAt: Array<{ label: string; trees: string[] }> = [];
  const registeredTools: any[] = [];
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "subagents") {
        if (!providers.length) return undefined;
        return {
          list: () => providers,
          getProvider: () => (providerHasPrepareContinuable ? { prepareContinuable: () => {} } : {}),
          startContinuable: async (opts: any) => {
            // 实拍：子代理被启动的这一刻，工作树是否已经注册（主树窗口的结构性取证）。
            spawnedAt.push({ label: opts.label, trees: registeredTrees(ws) });
            if (spawnError) throw new Error(spawnError);
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

  return {
    ws,
    root,
    spawnedAt,
    routes,
    dispatch: (args: any) =>
      new Map(registeredTools.map((t) => [t.name, t])).get("graph_start_attempt").execute(args, {
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

/**
 * 判定器（本目标修复后的返回契约）：返回 `null` 表示通过，否则返回违约说明。
 * 契约：`isolated` 必为 boolean；`worktree_reason` 字段必须存在（未隔离时为原因字符串）；
 * `worktree_created`/`worktree_reused` 必为 boolean；`isolated === (worktree !== false)`；
 * 隔离时 `worktree.path` 必为绝对路径字符串。
 * 该判定器**正是负向对照的被测对象**：旧响应形状（无 isolated / 无 worktree_reason）必被判红。
 */
function isolationVerdictViolation(res: any): string | null {
  if (!res || typeof res !== "object") return "返回不是对象";
  if (typeof res.isolated !== "boolean") return "缺少 boolean 字段 isolated（无法判定是否隔离）";
  if (!("worktree_reason" in res)) return "缺少 worktree_reason（无法判定为何隔离/未隔离）";
  if (typeof res.worktree_created !== "boolean") return "缺少 boolean 字段 worktree_created";
  if (typeof res.worktree_reused !== "boolean") return "缺少 boolean 字段 worktree_reused";
  const hasWorktree = res.worktree !== false && res.worktree != null;
  if (res.isolated !== hasWorktree) return `isolated=${res.isolated} 与 worktree=${hasWorktree ? "对象" : false} 不一致`;
  if (res.isolated) {
    if (typeof res.worktree?.path !== "string" || !res.worktree.path) return "隔离时应返回 worktree.path";
    if (res.worktree_created === res.worktree_reused) return "created/reused 必须恰好一真（创建或复用其一）";
  } else {
    if (typeof res.worktree_reason !== "string" || !res.worktree_reason) {
      return "未隔离时必须给出非空 worktree_reason（否则与建树失败混淆）";
    }
    if (res.worktree !== false) return "未隔离时 worktree 必须为 false";
  }
  return null;
}

/** 判定器 + 现实核对：返回逐 attempt 的取证记录（供断言与证据引用）。 */
function checkAgainstReality(h: ReturnType<typeof createHarness>, goalId: string, type: string, res: any) {
  const violation = isolationVerdictViolation(res);
  assert.equal(violation, null, `${goalId}(${type}) 返回语义违约：${violation}`);

  const attemptId = res.attempt;
  const path = worktreePath(h.ws, goalId, attemptId);
  const exists = existsSync(path);
  const registered = registeredTrees(h.ws).map(canonical).includes(canonical(path));
  const spawn = h.spawnedAt.find((s) => s.label === `graph:${goalId}/${attemptId}`);

  // attempt 记录（落盘真源）必须与返回一致
  const rec = goalDetail(h.root, goalId).attempts.find((a: any) => a.id === attemptId);
  assert.ok(rec, `${goalId} 应有 attempt 记录`);
  const meta = attemptMeta(h.root, goalId, attemptId);

  if (res.isolated) {
    assert.equal(exists, true, `${goalId} isolated=true 时目录必须真实存在：${path}`);
    assert.equal(registered, true, `${goalId} isolated=true 时必须是注册工作树`);
    assert.equal(rec.worktree?.path, res.worktree.path, "attempt 记录的 worktree 路径必须与返回一致");
    assert.equal(rec.worktree?.head, res.worktree.head, "attempt 记录的 worktree head 必须与返回一致");
    assert.equal(meta.worktree_reason, undefined, "isolated=true 时记录不应有豁免原因");
    // 无主树窗口：子代理启动那一刻工作树已注册
    assert.ok(spawn, `${goalId} 应记录到子代理启动时刻`);
    assert.ok(spawn.trees.map(canonical).includes(canonical(path)), `${goalId} 子代理启动时工作树必须已注册（否则存在主树窗口）`);
  } else {
    assert.equal(res.worktree, false, `${goalId} 未隔离时 worktree 必须为 false`);
    assert.equal(exists, false, `${goalId} 未隔离时不得创建目录：${path}`);
    assert.equal(registered, false, `${goalId} 未隔离时不得注册工作树`);
    assert.equal(res.worktree_created, false);
    assert.equal(res.worktree_reused, false);
    // 未隔离必须给出可判定原因，且与 attempt 记录同值
    assert.ok(["explicit", "type_default", "dirty_workspace", "type_default_unknown"].includes(res.worktree_reason),
      `${goalId} worktree_reason 必须是稳定枚举，实际：${res.worktree_reason}`);
    assert.equal(meta.worktree_reason, res.worktree_reason, "attempt 记录的 worktree_reason 必须与返回一致");
    assert.equal(meta.worktree, false);
  }
  return { goal: goalId, type, attempt: attemptId, isolated: res.isolated, reason: res.worktree_reason ?? null, path: res.isolated ? path : null, registered_at_spawn: spawn ? spawn.trees.map(canonical).includes(canonical(path)) : null };
}

const MIX_N2 = [
  { type: "chore", expectIsolated: false },
  { type: "feature", expectIsolated: true },
];
const MIX_N5 = [
  { type: "chore", expectIsolated: false },
  { type: "task", expectIsolated: false },
  { type: "patch", expectIsolated: false },
  { type: "feature", expectIsolated: true },
  { type: "bug", expectIsolated: true },
];

// ============================================================================
// 判据 1/2：批量并发 N=2 / N=5 —— 逐 attempt 返回语义 ↔ 真实工作树状态一致
// ============================================================================

test("g-406 判据 1/2：批量并发 N=2（两种顺序）返回语义与实际工作树逐条一致，且与位置无关", async () => {
  for (const order of [MIX_N2, [...MIX_N2].reverse()]) {
    const h = createHarness({ gitRepo: true });
    const entries = order.map((spec, i) => ({ ...spec, goal: mkGoal(h.root, `批量 N2 目标 ${i + 1}`, spec.type) }));
    const responses = await Promise.all(entries.map((e, i) => h.dispatch({ goal: e.goal, attempt_brief: `批量派发 ${i + 1}` })));

    const evidence = entries.map((e, i) => checkAgainstReality(h, e.goal, e.type, responses[i]));
    // 隔离与否只由「类型 × 干净度」决定，不由 batch 位置决定
    entries.forEach((e, i) => assert.equal(responses[i].isolated, e.expectIsolated,
      `${e.type} 在位置 ${i + 1} 的隔离判定应与类型默认一致`));
    assert.ok(evidence.length === 2);
    // 主树不得被改动（无遗留污染）
    assert.equal(git(h.ws, ["status", "--porcelain"]), "");
  }
});

test("g-406 判据 1/2：批量并发 N=5（chore/task/patch/feature/bug）逐 attempt 一致，隔离型启动前已注册", async () => {
  const h = createHarness({ gitRepo: true });
  const entries = MIX_N5.map((spec, i) => ({ ...spec, goal: mkGoal(h.root, `批量 N5 目标 ${i + 1}`, spec.type) }));
  const responses = await Promise.all(entries.map((e, i) => h.dispatch({ goal: e.goal, attempt_brief: `批量派发 ${i + 1}` })));

  entries.forEach((e, i) => {
    checkAgainstReality(h, e.goal, e.type, responses[i]);
    assert.equal(responses[i].isolated, e.expectIsolated, `${e.type} 隔离判定应与类型默认一致`);
  });
  // 5 个子代理全部启动，且隔离型都在「启动时已注册」
  assert.equal(h.spawnedAt.length, 5);
  assert.equal(git(h.ws, ["status", "--porcelain"]), "");
});

test("g-406 判据 1/2（对照）：单个派发与批量派发结果一致 ⇒ 该现象并非「仅批量触发」", async () => {
  const h = createHarness({ gitRepo: true });
  const entries = MIX_N2.map((spec, i) => ({ ...spec, goal: mkGoal(h.root, `单发对照 ${i + 1}`, spec.type) }));
  const responses = [];
  for (const e of entries) {
    responses.push(await h.dispatch({ goal: e.goal, attempt_brief: "单独派发" }));
  }
  entries.forEach((e, i) => {
    checkAgainstReality(h, e.goal, e.type, responses[i]);
    assert.equal(responses[i].isolated, e.expectIsolated, `单发 ${e.type} 判定应与类型默认一致`);
    if (e.expectIsolated) {
      assert.equal(responses[i].worktree_reason, null, "已隔离时不应带豁免原因");
    } else {
      assert.equal(responses[i].worktree_reason, "type_default", "干净工作区 + 未显式传参 ⇒ type_default");
    }
  });
});

// ============================================================================
// 判据 2：建树失败硬失败（零副作用、不静默降级为非隔离）
// ============================================================================

test("g-406 判据 2：隔离型在非 git 工作区建树失败 ⇒ 抛错硬失败，不返回 worktree:false", async () => {
  const h = createHarness({ gitRepo: false }); // 非 git 仓库
  const goal = mkGoal(h.root, "无法建树", "feature");
  await assert.rejects(() => h.dispatch({ goal, attempt_brief: "隔离执行" }), /不是 Git 仓库|git 不可用/);
  assert.equal(goalDetail(h.root, goal).attempts.length, 0, "硬失败：不得创建 attempt");
  assert.equal(h.spawnedAt.length, 0, "硬失败：不得启动子代理");
});

// ============================================================================
// 判据 2：四条返回分支都必须带隔离判定（全路径覆盖，不只成功分支）
// ============================================================================

test("g-406 判据 2：四条返回分支均携带隔离判定字段（成功 / 无 provider / spawn 失败 / 无 subagents 服务）", async () => {
  // ① 成功分支（隔离型）：非 git 无法建树，这里用非隔离型 + git 仓库覆盖成功分支字段
  const okH = createHarness({ gitRepo: true });
  const okGoal = mkGoal(okH.root, "成功分支", "task");
  const okRes = await okH.dispatch({ goal: okGoal, attempt_brief: "x" });
  assert.equal(isolationVerdictViolation(okRes), null);
  assert.equal(okRes.isolated, false);

  // ② 无可用 provider（providerError 分支）
  const noProvH = createHarness({ gitRepo: true, providerHasPrepareContinuable: false });
  const noProvGoal = mkGoal(noProvH.root, "无 provider", "feature");
  const noProvRes = await noProvH.dispatch({ goal: noProvGoal, attempt_brief: "x" });
  assert.ok(noProvRes.child_error, "应报 provider 缺失");
  assert.equal(isolationVerdictViolation(noProvRes), null);
  assert.equal(noProvRes.isolated, true, "建树仍应发生（失败的是子代理，不是隔离）");

  // ③ spawn 抛错（catch 分支）
  const spawnH = createHarness({ gitRepo: true, spawnError: "boom" });
  const spawnGoal = mkGoal(spawnH.root, "spawn 失败", "bug");
  const spawnRes = await spawnH.dispatch({ goal: spawnGoal, attempt_brief: "x" });
  assert.ok(spawnRes.child_error, "应报 spawn 失败");
  assert.equal(isolationVerdictViolation(spawnRes), null);
  assert.equal(spawnRes.isolated, true);

  // ④ subagents 服务不可用（else 分支）
  const noSvcH = createHarness({ gitRepo: true, providers: [] });
  const noSvcGoal = mkGoal(noSvcH.root, "无 subagents 服务", "task");
  const noSvcRes = await noSvcH.dispatch({ goal: noSvcGoal, attempt_brief: "x" });
  assert.ok(String(noSvcRes.note ?? "").includes("subagents 服务不可用"), "应走无服务分支");
  assert.equal(isolationVerdictViolation(noSvcRes), null);
});

function fakeReq(method: string, query: string, body: any) {
  const listeners: Record<string, Function> = {};
  return {
    method,
    url: query,
    on: (e: string, fn: Function) => { listeners[e] = fn; },
    _emit: () => { listeners.data?.(JSON.stringify(body)); listeners.end?.(); },
  };
}
function fakeRes() {
  const res: any = { _code: 0, _body: null, writeHead: (c: number) => { res._code = c; }, end: (b: string) => { res._body = b ? JSON.parse(b) : null; } };
  return res;
}

// ============================================================================
// 判据 2（第二处白名单）：HTTP/GUI 入口同样必须回传隔离判定
// ============================================================================

test("g-406 判据 2：HTTP/GUI 入口（第二处响应白名单）同样回传隔离判定四件套", async () => {
  const h = createHarness({ gitRepo: true });
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goal = mkGoal(h.root, "HTTP 入口隔离", "feature");
  const handler = h.routes.get("/api/dsh-graph/start-execution");
  assert.ok(handler, "应注册 /api/dsh-graph/start-execution 路由");
  const req = fakeReq("POST", "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(h.ws), { goal, attempt_brief: "HTTP 派发" });
  const res = fakeRes();
  const p = handler(req, res);
  req._emit();
  await p;
  assert.equal(res._code, 200, `HTTP 应 200，实际 ${res._code}`);
  assert.equal(isolationVerdictViolation(res._body), null, "HTTP 响应必须可据以判定隔离");
  assert.equal(res._body.isolated, true, "feature 默认建树");
  assert.equal(res._body.worktree_created, true);
  assert.equal(res._body.worktree_reused, false);
});

// ============================================================================
// 负向对照（判据 3）：回退修复即红
// ============================================================================

test("g-406 判据 3 负向对照①：真实事故中的旧响应形状 {worktree:false} 必须被判红", () => {
  // 事故现场（主管三数据点）主管看到的就是这份：worktree:false，无 isolated、无 worktree_reason。
  // 修复前它「看起来像一个可判定的结论」，实际既可能是策略豁免、也可能是建树未完成 ⇒ 不可判定。
  const legacyResponse = { ok: true, attempt: "att-001", child_id: "c6ec0120", child_error: null, worktree: false };
  const violation = isolationVerdictViolation(legacyResponse);
  assert.ok(violation, "旧响应形状必须被判红（否则本回归守卫无判别力）");
  assert.match(violation, /isolated|worktree_reason/);
  // 修复后的形状必须判绿（同一判定器同一输入维度）
  assert.equal(isolationVerdictViolation({ ok: true, attempt: "att-001", worktree: false, isolated: false, worktree_reason: "type_default", worktree_created: false, worktree_reused: false }), null);
});

/** 锚点化变异：锚点必须恰好命中一次，否则报错（避免负向对照静默失效——g-348 纪律）。 */
function mutateOnce(source: string, anchor: string, replacement: string): string {
  const hits = source.split(anchor).length - 1;
  assert.equal(hits, 1, `负向对照锚点必须恰好命中一次，实际 ${hits} 次：${JSON.stringify(anchor)}`);
  return source.replace(anchor, replacement);
}

/**
 * 结构性守卫 A（主树窗口）：统一派发函数 `dispatchExecutionAttempt` 内必须
 * 「先建树（创建并注册）→ 再启动子代理」，且两者之间不得有 await
 * （同一同步临界区 ⇒ 并发批量派发无法把创建推迟到启动之后）。
 * 只在派发函数区域内取证：文件里其它子代理启动点（收集/其它入口）不属于本不变式。
 */
function dispatchRegion(source: string): string {
  const start = source.indexOf("const dispatchExecutionAttempt = async (");
  assert.ok(start >= 0, "未找到 dispatchExecutionAttempt（结构已变，请同步更新本守卫）");
  const end = source.indexOf("\n  const tools = [", start);
  assert.ok(end > start, "未找到 dispatchExecutionAttempt 的结束边界（结构已变，请同步更新本守卫）");
  return source.slice(start, end);
}

function isolationOrderingViolation(region: string): string | null {
  const creates = region.split("const wtResult = prepareAttemptWorktree(").length - 1;
  const spawns = region.split("await subagents.startContinuable(").length - 1;
  if (creates !== 1) return `派发区域内 prepareAttemptWorktree 调用点应恰好 1 处，实际 ${creates} 处（结构已变，请同步更新本守卫）`;
  if (spawns !== 1) return `派发区域内 startContinuable 调用点应恰好 1 处，实际 ${spawns} 处（结构已变，请同步更新本守卫）`;
  const create = region.indexOf("const wtResult = prepareAttemptWorktree(");
  const spawn = region.indexOf("await subagents.startContinuable(");
  if (create > spawn) return "工作树创建晚于子代理启动 ⇒ 存在主树运行窗口";
  if (/\bawait\b/.test(region.slice(create, spawn))) return "工作树创建与子代理启动之间存在 await ⇒ 并发下可被交错";
  return null;
}

/**
 * 结构性守卫 B（响应构造）：工具入口与 HTTP/GUI 入口都是**白名单构造**，
 * 两处都必须显式登记隔离判定四件套；漏登记 ⇒ 主管拿到的响应不可判定（本次事故的根因之一）。
 */
const VERDICT_WHITELIST_TOKENS = [
  "isolated: execRes.isolated,",
  "worktree_reason: execRes.worktree_reason ?? null,",
  "worktree_created: execRes.worktree_created === true,",
  "worktree_reused: execRes.worktree_reused === true,",
];
function isolationWhitelistViolation(source: string): string | null {
  for (const token of VERDICT_WHITELIST_TOKENS) {
    const hits = source.split(token).length - 1;
    if (hits !== 2) return `响应白名单应恰好 2 处登记 ${JSON.stringify(token)}（工具入口 + HTTP 入口），实际 ${hits} 处`;
  }
  return null;
}

test("g-406 判据 3 负向对照②：结构性守卫钉住「创建并注册完成后才启动子代理」，两种回退变异必红", () => {
  const source = readFileSync(DISPATCH_SOURCE, "utf8");
  assert.equal(isolationOrderingViolation(dispatchRegion(source)), null, "当前派发实现应满足「先建树后启动」");

  // 变异 A：在创建与启动之间插入 await（并发交错窗口，即事故里「返回时尚未建树」的形态）
  const withAwait = mutateOnce(source, "    const prompt = formatAttemptPrompt({", "    await Promise.resolve();\n    const prompt = formatAttemptPrompt({");
  assert.match(String(isolationOrderingViolation(dispatchRegion(withAwait))), /await/);

  // 变异 B：把「创建 + 隔离判定」整块挪到子代理启动之后（主树窗口回归）
  const createBlock = source.slice(
    source.indexOf("const wtResult = prepareAttemptWorktree("),
    source.indexOf("    const prompt = formatAttemptPrompt({"),
  );
  assert.match(createBlock, /prepareAttemptWorktree/, "锚点块应包含创建语句");
  // 锚点取「子代理启动语句结束之后」的位置：把创建块挪到启动之后 ⇒ 子代理先于建树启动
  const moved = mutateOnce(
    source,
    "        });\n\n        try {\n          bindAttemptChild(",
    "        });\n\n" + createBlock + "        try {\n          bindAttemptChild(",
  ).replace(createBlock, "");
  assert.match(String(isolationOrderingViolation(dispatchRegion(moved))), /晚于子代理启动/);
});

test("g-406 判据 3 负向对照③：两处响应白名单必须登记隔离判定，删掉任一处即红", () => {
  const source = readFileSync(DISPATCH_SOURCE, "utf8");
  assert.equal(isolationWhitelistViolation(source), null, "工具与 HTTP 两处白名单都应登记隔离判定");
  // 负向对照：抹掉工具入口的 isolated 登记 ⇒ 命中数 1 ⇒ 判红
  const oneStripped = mutateOnce(source, "\n          isolated: execRes.isolated,\n", "");
  assert.match(String(isolationWhitelistViolation(oneStripped)), /isolated: execRes\.isolated/);
  // 负向对照：返回点必须携带隔离判定块，删掉即红（派发函数内 4 个返回点）
  const spread = (source.match(/worktree: wtResult\.worktree,\s*\n\s*\.\.\.isolationReport,/g) ?? []).length;
  const returns = (source.match(/worktree: wtResult\.worktree,/g) ?? []).length;
  assert.equal(returns, 5, "应恰好 5 处 worktree: wtResult.worktree,（1 处 startAttempt opts + 4 处返回）");
  assert.equal(spread, 4, "4 个返回点必须各自携带 ...isolationReport,（新增返回点请同步本守卫）");
  assert.equal((source.replace(/\.\.\.isolationReport,/g, "").match(/worktree: wtResult\.worktree,\s*\n\s*\.\.\.isolationReport,/g) ?? []).length, 0);
});
