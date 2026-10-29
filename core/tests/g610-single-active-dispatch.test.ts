/**
 * g-610：同一 workspace + goal 的执行派发「单活」门禁（严格拒绝策略）与可审计恢复。
 *
 * 覆盖（全部 fake subagents / 公开宿主契约，无真实 provider / 网络 / 真实宿主）：
 *  - 串行 / HTTP / 同进程 Promise.all 的重复派发：只允许唯一 child，第二个派发零副作用拒绝；
 *  - force 不绕过；不同 goal 并行不互锁；工作树 true/false 两形态都不产生第二棵树；
 *  - spawn 挂起窗口：持久 spawning 门禁可见、abandon 在在途 spawn 时拒绝；
 *  - spawn 抛错 ⇒ spawn_unknown（不能当无 child）；公开 durable 目录可证明才允许授权 abandon；
 *  - 旧数据（pending + 无 child + 无 dispatch_state）⇒ 状态未知拦截，授权 abandon 后恢复；
 *  - bind CAS 不得复活已取消/解绑的 attempt；
 *  - collector（agent:collect）不占执行绑定；
 *  - 事件写失败时 fail-closed（无 attempt 落盘、无 child），修复后可重试；
 *  - 鉴权先于派发：无 owner / 非 owner 一律 401/403，零 attempt。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  startAttempt,
  saveGoal,
  loadGoal,
  findGoalFile,
  goalDetail,
  readGoalBinding,
  abandonAttempt,
  bindAttemptChild,
  listActiveExecutionAttempts,
  transition,
  postponeGoal,
} from "../ops.ts";
import { readEvents, appendEvent } from "../events.ts";
import { apply } from "../../dist/index.js";
import { ownerConnectionStub, createRegisterStub, handlerFor, OWNER_HEADER } from "./_http-auth-harness.ts";

type SpawnMode = "immediate" | "deferred" | "throw";

function makeHarness(opts: {
  gitRepo?: boolean;
  catalog?: any[];
  registryMode?: "ok" | "throw";
  connection?: any;
  noListChildren?: boolean;
} = {}) {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g610-"));
  if (opts.gitRepo) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    writeFileSync(join(ws, "README"), "x");
    writeFileSync(join(ws, ".gitignore"), ".worktrees/\n.dsh-graph/\n");
    execFileSync("git", ["add", "."], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
  }
  const root = join(ws, ".dsh-graph");
  init(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const stub = createRegisterStub();
  const registered: any[] = [];
  const spawned: any[] = [];
  const interrupted: any[] = [];
  const catalog = [...(opts.catalog ?? [])];
  let spawnMode: SpawnMode = "immediate";
  let spawnError = "spawn boom";
  let seq = 0;
  let pendingResolve: ((v: any) => void) | null = null;
  let pendingReject: ((e: any) => void) | null = null;

  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return stub.webServer;
      if (name === "connection") return opts.connection ?? ownerConnectionStub();
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") {
        if (opts.registryMode === "throw") {
          return { get: () => { throw new Error("registry unavailable"); } };
        }
        return { get: () => ({ id: "sess-super" }) };
      }
      if (name === "subagents") {
        const svc: any = {
          list: () => ["spawn"],
          getProvider: () => ({ prepareContinuable: () => {} }),
          interruptByParent: (...args: any[]) => { interrupted.push(args); },
          startContinuable: async (o: any) => {
            spawned.push(o);
            if (spawnMode === "throw") throw new Error(spawnError);
            if (spawnMode === "deferred") {
              return await new Promise((res, rej) => { pendingResolve = res; pendingReject = rej; });
            }
            return { childId: "child-" + (++seq), parentSessionId: "sess-super" };
          },
        };
        if (!opts.noListChildren) svc.listChildren = async () => catalog;
        return svc;
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer: stub.webServer,
    tools: { register: (d: any) => { registered.push(d); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  const tools = new Map(registered.map((t: any) => [t.name, t]));
  // 会话 id 取 project.yaml 的 supervisor.session ⇒ 工具侧 abandon/unbind 以 supervisor 身份授权
  // （owner/supervisor 是既有授权模型；测试不新造权限）。
  const exec = { agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-super" } }, signal: new AbortController().signal };
  const handler = handlerFor(stub.routes);
  return {
    ws, root, tools, exec, handler, spawned, interrupted, catalog,
    setSpawnMode: (m: SpawnMode) => { spawnMode = m; },
    setSpawnError: (m: string) => { spawnError = m; },
    resolvePending: () => pendingResolve?.({ childId: "child-deferred", parentSessionId: "sess-super" }),
    rejectPending: (e: any) => pendingReject?.(e),
    hasPending: () => pendingResolve !== null,
  };
}

/** 直接构造「spawn 已结算但仍停留 spawning」的旧/失败窗口（用于 abandon 证据路径单测）。 */
function markCallSettled(root: string, goal: string, att: string): void {
  const file = join(dirname(findGoalFile(root, goal)), "attempts", att, "attempt.md");
  const doc = loadGoal(file);
  doc.meta.dispatch_call_settled = true;
  saveGoal(file, doc);
}

function mkGoal(h: ReturnType<typeof makeHarness>, title = "g610 目标", type = "task"): string {
  const goal = createGoal(h.root, {
    title, version: "v1.0", type, actor: "human:gui",
    description: "g-610 单活门禁测试目标（描述非空）",
  });
  setCriteria(h.root, goal, ["判据"], "human:gui");
  return goal;
}

function post(h: any, path: string, body: any, headers: Record<string, string> = { [OWNER_HEADER]: "1" }) {
  const listeners: Record<string, Function> = {};
  const req: any = {
    headers, method: "POST",
    url: path + "?workspace=" + encodeURIComponent(h.ws),
    on: (e: string, fn: Function) => { listeners[e] = fn; },
    _emit: () => { listeners.data?.(JSON.stringify(body)); listeners.end?.(); },
  };
  const res: any = { _code: 0, _body: null };
  res.writeHead = (c: number) => { res._code = c; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  const p = h.handler(req, res);
  req._emit();
  return Promise.resolve(p).then(() => res);
}

const start = (h: any, args: any) => h.tools.get("graph_start_attempt").execute(args, h.exec);

test("g-610 判据1：串行重复派发严格拒绝，force 不绕过，零新 attempt/worktree/spawn", async () => {
  const h = makeHarness({ gitRepo: true });
  const goal = mkGoal(h, "串行重复派发", "feature");
  const r1: any = await start(h, { goal, attempt_brief: "first" });
  assert.ok(r1.child_id);
  assert.equal(r1.isolated, true);
  const treesBefore = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: h.ws, encoding: "utf8" })
    .split(/\r?\n/).filter((l) => l.startsWith("worktree ")).sort();
  const attemptsBefore = goalDetail(h.root, goal).attempts.length;
  const spawnsBefore = h.spawned.length;

  for (const extra of [{}, { force: true }]) {
    await assert.rejects(
      () => start(h, { goal, attempt_brief: "second", ...extra }),
      (e: any) => {
        assert.equal(e.code, "EXECUTION_ALREADY_ACTIVE");
        assert.match(String(e.message), /^\[EXECUTION_ALREADY_ACTIVE\]/);
        return true;
      },
      "同一 goal 第二次派发必须拒绝（force 不绕过）",
    );
  }
  assert.equal(goalDetail(h.root, goal).attempts.length, attemptsBefore);
  assert.equal(h.spawned.length, spawnsBefore, "被拒绝的派发不得 spawn");
  const treesAfter = execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: h.ws, encoding: "utf8" })
    .split(/\r?\n/).filter((l) => l.startsWith("worktree ")).sort();
  assert.deepEqual(treesAfter, treesBefore, "被拒绝的派发不得创建第二棵工作树");
});

test("g-610 判据1：HTTP 重复派发返回 409 + 稳定 code/activity，且不泄露 binding token", async () => {
  const h = makeHarness();
  const goal = mkGoal(h, "HTTP 重复派发");
  const ok = await post(h, "/api/dsh-graph/start-execution", { goal, attempt_brief: "first" });
  assert.equal(ok._code, 200);
  const binding = readGoalBinding(h.root, goal)!;
  assert.ok(binding.binding_token, "前提：首个 attempt 已绑定 token");
  const dup = await post(h, "/api/dsh-graph/start-execution", { goal, attempt_brief: "second", force: true });
  assert.equal(dup._code, 409);
  assert.equal(dup._body.code, "EXECUTION_ALREADY_ACTIVE");
  assert.ok(Array.isArray(dup._body.activity) && dup._body.activity.length === 1);
  assert.equal(dup._body.activity[0].attempt, "att-001");
  assert.ok(dup._body.recovery.includes("graph_unbind_goal_child"));
  const raw = JSON.stringify(dup._body);
  assert.ok(!raw.includes(binding.binding_token), "错误体不得泄露 binding token");
  assert.equal(goalDetail(h.root, goal).attempts.length, 1);
  assert.equal(h.spawned.length, 1);
});

test("g-610 判据2：同进程 Promise.all 只允许一个成功，另一路在门禁处零副作用拒绝", async () => {
  const h = makeHarness();
  const goal = mkGoal(h, "并发派发");
  const results = await Promise.allSettled([
    start(h, { goal, attempt_brief: "c1" }),
    start(h, { goal, attempt_brief: "c2" }),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const bad = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1, "恰好一路成功");
  assert.equal(bad.length, 1, "另一路必须拒绝");
  assert.match(String((bad[0] as PromiseRejectedResult).reason?.code), /^EXECUTION_(STARTING|ALREADY_ACTIVE)$/);
  assert.equal(goalDetail(h.root, goal).attempts.length, 1, "只允许一个 attempt");
  assert.equal(h.spawned.length, 1, "只允许一个 child");
});

test("g-610 判据2：不同 goal 并行不互锁；collector attempt 不占执行绑定", async () => {
  const h = makeHarness();
  const g1 = mkGoal(h, "并行业务 A");
  const g2 = mkGoal(h, "并行业务 B");
  const [a, b] = await Promise.all([
    start(h, { goal: g1, attempt_brief: "a" }),
    start(h, { goal: g2, attempt_brief: "b" }),
  ]);
  assert.ok(a.child_id && b.child_id, "不同 goal 必须可并行");
  assert.notEqual(a.child_id, b.child_id);

  // 纯收集子代理（executor=agent:collect）不应占用执行绑定
  const g3 = mkGoal(h, "collector 排除");
  const coll = startAttempt(h.root, g3, { executor: "agent:collect", actor: "human:gui" });
  assert.equal(listActiveExecutionAttempts(h.root, g3).length, 0, "collector attempt 不得被枚举为执行占用");
  const r = await start(h, { goal: g3, attempt_brief: "executor after collector" });
  assert.ok(r.child_id, "collector 在场时执行派发仍应允许");
  assert.ok(coll.startsWith("att-"));
});

test("g-610 判据2：spawn 挂起时持久 spawning 门禁可见；abandon 在途一律拒绝；结算后可绑定", async () => {
  const h = makeHarness();
  const goal = mkGoal(h, "挂起 spawn");
  h.setSpawnMode("deferred");
  const p = start(h, { goal, attempt_brief: "deferred" });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(h.spawned.length, 1);
  const meta = loadGoal(join(dirname(findGoalFile(h.root, goal)), "attempts", "att-001", "attempt.md")).meta;
  assert.equal(meta.dispatch_state, "spawning");
  assert.equal(meta.child_id, null);

  await assert.rejects(
    () => start(h, { goal, attempt_brief: "during pending" }),
    (e: any) => e.code === "EXECUTION_STARTING",
    "启动窗口内的第二次派发必须被持久状态拦住",
  );
  await assert.rejects(
    () => h.tools.get("graph_abandon_attempt").execute({ goal, attempt: "att-001", reason: "race" }, h.exec),
    /spawn Promise 尚未结算|尚未结算/,
    "在途 spawn 时 abandon 必须拒绝（不能靠 fire-and-forget 当已停稳）",
  );
  const still = loadGoal(join(dirname(findGoalFile(h.root, goal)), "attempts", "att-001", "attempt.md")).meta;
  assert.equal(still.result, "pending");
  assert.equal(still.dispatch_state, "spawning");

  h.resolvePending();
  const done: any = await p;
  assert.ok(done.child_id);
  const bound = loadGoal(join(dirname(findGoalFile(h.root, goal)), "attempts", "att-001", "attempt.md")).meta;
  assert.equal(bound.dispatch_state, "bound");
  assert.equal(bound.child_id, done.child_id);
});

test("g-610 判据2（待裁决限制）：spawn 从未结算且目录无 child 时不可 abandon，错误明确标注无安全复位", async () => {
  const h = makeHarness({ catalog: [] });
  const goal = mkGoal(h, "崩溃窗口限制");
  // 模拟宿主崩溃：attempt.md 落在 spawning，没有 call_settled 标志/事件，也没有 in-flight（重启后）
  startAttempt(h.root, goal, {
    executor: "agent:x", actor: "human:gui",
    dispatchState: "spawning", dispatchOwnerPid: 999999, parentSessionId: "sess-super",
  });
  assert.equal(listActiveExecutionAttempts(h.root, goal)[0]?.reason, "spawning");
  await assert.rejects(
    async () => h.tools.get("graph_abandon_attempt").execute(
      { goal, attempt: "att-001", reason: "尝试复位" }, h.exec,
    ),
    (e: any) => {
      assert.match(String(e.message), /待裁决限制/);
      assert.match(String(e.message), /未观察到.*结算|无法.*安全证明/);
      return true;
    },
    "无停稳证据时必须 fail-closed 且如实标注限制（不提供 force/attestation）",
  );
  const meta = loadGoal(join(dirname(findGoalFile(h.root, goal)), "attempts", "att-001", "attempt.md")).meta;
  assert.equal(meta.result, "pending");
  assert.equal(meta.dispatch_state, "spawning");
  await assert.rejects(
    () => start(h, { goal, attempt_brief: "new" }),
    (e: any) => e.code === "EXECUTION_STARTING",
  );
  assert.equal(h.spawned.length, 0);
});

test("g-610 判据2/3：spawn 抛错按 unknown 拦截；公开目录不可得时 abandon fail-closed；可得且无 child 时授权恢复", async () => {
  // 无 listChildren：无法证明，abandon 必须拒绝
  const hNo = makeHarness({ noListChildren: true });
  const gNo = mkGoal(hNo, "无目录能力");
  hNo.setSpawnMode("throw");
  const failed: any = await start(hNo, { goal: gNo, attempt_brief: "boom" });
  assert.equal(failed.child_id, null);
  const fmeta = loadGoal(join(dirname(findGoalFile(hNo.root, gNo)), "attempts", "att-001", "attempt.md")).meta;
  assert.equal(fmeta.dispatch_state, "spawn_unknown");
  assert.equal(fmeta.dispatch_call_settled, true);
  await assert.rejects(
    () => hNo.tools.get("graph_abandon_attempt").execute({ goal: gNo, attempt: "att-001", reason: "no catalog" }, hNo.exec),
    /无法通过公开子代理目录/,
    "目录能力不可得时必须 fail-closed",
  );
  await assert.rejects(
    () => start(hNo, { goal: gNo, attempt_brief: "retry" }),
    (e: any) => e.code === "EXECUTION_STATE_UNKNOWN",
  );

  // 有 listChildren（空目录，代表从未发布 child）：授权 owner 可 abandon，然后重试成功
  const h = makeHarness({ catalog: [] });
  const g = mkGoal(h, "有目录能力");
  h.setSpawnMode("throw");
  await start(h, { goal: g, attempt_brief: "boom" });
  h.setSpawnMode("immediate");
  const ab: any = await h.tools.get("graph_abandon_attempt").execute(
    { goal: g, attempt: "att-001", reason: "公开目录无该 child 且 spawn 已结算" }, h.exec,
  );
  assert.equal(ab.abandoned, true);
  const abEv = readEvents(h.root).find((e) => e.event === "attempt.abandoned" && e.details.attempt === "att-001")!;
  assert.equal(abEv.details.dispatch_state, "spawn_unknown");
  assert.deepEqual(abEv.details.spawn_evidence.matched, []);
  const retry: any = await start(h, { goal: g, attempt_brief: "after recovery" });
  assert.ok(retry.child_id);
  assert.equal(retry.attempt, "att-002");
});

test("g-610 判据3：旧数据 pending 无 child 无 dispatch_state 一律 unknown 拦截，授权 abandon 后合法重开", async () => {
  const h = makeHarness();
  const goal = mkGoal(h, "旧数据");
  const legacy = startAttempt(h.root, goal, { executor: "agent:legacy", actor: "human:gui" });
  assert.equal(legacy, "att-001");
  assert.equal(listActiveExecutionAttempts(h.root, goal)[0]?.reason, "unknown");
  await assert.rejects(
    () => start(h, { goal, attempt_brief: "after legacy" }),
    (e: any) => e.code === "EXECUTION_STATE_UNKNOWN",
  );
  const ab: any = await h.tools.get("graph_abandon_attempt").execute(
    { goal, attempt: legacy, reason: "旧数据：确认无 child 后放弃" }, h.exec,
  );
  assert.equal(ab.abandoned, true);
  const r: any = await start(h, { goal, attempt_brief: "after legacy recovery" });
  assert.ok(r.child_id);
});

test("g-610 判据2：bind CAS 不得复活已取消/解绑 attempt", async () => {
  const h = makeHarness();
  const goal = mkGoal(h, "CAS 复活防护");
  const att = startAttempt(h.root, goal, {
    executor: "agent:x", actor: "human:gui",
    dispatchState: "spawning", dispatchOwnerPid: process.pid,
  });
  markCallSettled(h.root, goal, att);
  // 模拟人工已处理（取消 + detached）
  abandonAttempt(h.root, goal, {
    actor: "human:gui", attempt: att, reason: "cancel before bind",
    spawnEvidence: { supported: true, parent_session_id: "sess-super", children: [] },
  });
  assert.throws(
    () => bindAttemptChild(h.root, goal, att, "child-late", "human:gui", "sess-super", null, null, null, null, null, {
      dispatchState: "spawning", parentSessionId: "sess-super",
    }),
    /拒绝复活|已解绑|取消/,
  );
  const meta = loadGoal(join(dirname(findGoalFile(h.root, goal)), "attempts", att, "attempt.md")).meta;
  assert.equal(meta.result, "cancelled");
  assert.equal(meta.detached, true);
  assert.equal(meta.child_id, undefined, "晚到 child 不得写回已取消 attempt");
});

test("g-610 判据2：registry 不可用时只用于诊断，绝不放行新派发", async () => {
  const h = makeHarness({ registryMode: "throw" });
  const goal = mkGoal(h, "registry 不可用");
  const r1: any = await start(h, { goal, attempt_brief: "first" });
  assert.ok(r1.child_id);
  // registry 查不到/抛错不等于 gone：unbind/abandon 与派发门禁都必须继续拒绝
  const binding = readGoalBinding(h.root, goal)!;
  await assert.rejects(
    async () => h.tools.get("graph_unbind_goal_child").execute(
      { goal, attempt: binding.attempt, token: binding.binding_token, reason: "unknown registry" }, h.exec,
    ),
    /无法确认子代理状态/,
  );
  await assert.rejects(
    () => start(h, { goal, attempt_brief: "second" }),
    (e: any) => e.code === "EXECUTION_ALREADY_ACTIVE",
  );
});

test("g-610 判据2：不同 workspace/root 互不互锁（同号 goal 可并行）", async () => {
  const hA = makeHarness();
  const hB = makeHarness();
  const gA = mkGoal(hA, "workspace A");
  const gB = mkGoal(hB, "workspace B");
  assert.equal(gA, gB, "两个独立看板从同一起点编号 ⇒ 同号前提成立");
  const [a, b] = await Promise.all([
    start(hA, { goal: gA, attempt_brief: "ws A" }),
    start(hB, { goal: gB, attempt_brief: "ws B" }),
  ]);
  assert.ok(a.child_id && b.child_id, "不同 workspace 的派发不得互锁");
  assert.equal(goalDetail(hA.root, gA).attempts.length, 1);
  assert.equal(goalDetail(hB.root, gB).attempts.length, 1);
});

test("g-610 判据2：已绑定 child 自然 idle/gone 也不自动释放门禁（严格策略）", async () => {
  const h = makeHarness();
  const goal = mkGoal(h, "idle 也不放行");
  const r: any = await start(h, { goal, attempt_brief: "first" });
  assert.ok(r.child_id);
  // 模拟 child 已结束（写 subagent/end 事件）——attempt 仍 pending+bound，门禁必须继续拦
  appendEvent(h.root, {
    actor: "system:subagent/end", event: "subagent/end", goal,
    details: { id: r.child_id, stopReason: "completed" },
  });
  await assert.rejects(
    () => start(h, { goal, attempt_brief: "second after end" }),
    (e: any) => e.code === "EXECUTION_ALREADY_ACTIVE",
    "child 自然结束不等于旧 attempt 已被授权处理，仍须显式 unbind",
  );
});

test("g-610 判据2：事件流已记录 spawn 结算（attempt.md 持久化失败）时可作为结算证据，但仍需目录证据", async () => {
  const h = makeHarness({ catalog: [] });
  const goal = mkGoal(h, "事件结算证据");
  // 手工构造：attempt.md 停在 spawning（模拟 persist 失败），但事件已记录 call_settled
  startAttempt(h.root, goal, {
    executor: "agent:x", actor: "human:gui",
    dispatchState: "spawning", dispatchOwnerPid: process.pid, parentSessionId: "sess-super",
  });
  appendEvent(h.root, {
    actor: "system:dispatch", event: "attempt.dispatch_failed", goal,
    details: { attempt: "att-001", state: "spawn_unknown", dispatch_call_settled: true },
  });
  const ab: any = await h.tools.get("graph_abandon_attempt").execute(
    { goal, attempt: "att-001", reason: "事件已记录结算，公开目录无该 child" }, h.exec,
  );
  assert.equal(ab.abandoned, true);
  const ev = readEvents(h.root).find((e) => e.event === "attempt.abandoned" && e.details.attempt === "att-001")!;
  assert.equal(ev.details.spawn_evidence?.settled_from_event, true);
});

test("g-610 判据2：startAttempt 事件写失败时零 attempt 落盘，修复后可重试同一编号", async () => {
  const h = makeHarness();
  const goal = mkGoal(h, "事件写失败");
  // 只读掉写权限 ⇒ appendEvent 写失败，但读事件流仍可用（admission 读取不受影响）
  const eventsPath = join(h.root, "events.jsonl");
  const backup = readFileSync(eventsPath, "utf8");
  chmodSync(eventsPath, 0o444);
  try {
    await assert.rejects(
      () => start(h, { goal, attempt_brief: "event failure" }),
      /事件追加失败/,
    );
    assert.equal(goalDetail(h.root, goal).attempts.length, 0, "事件失败不得留下 attempt");
    assert.equal(h.spawned.length, 0, "事件失败不得启动 child");
  } finally {
    chmodSync(eventsPath, 0o644);
    writeFileSync(eventsPath, backup);
  }
  const ok: any = await start(h, { goal, attempt_brief: "retry after event fix" });
  assert.equal(ok.attempt, "att-001", "编号不得偏移");
  assert.ok(ok.child_id);
});

test("g-610 判据4：鉴权先于派发——匿名 401 / 非 owner 403，零 attempt", async () => {
  for (const [rejection, expected] of [[401, 401], [403, 403]] as const) {
    const h = makeHarness({
      connection: {
        admit: () => ({ rejection }),
      },
    });
    const goal = mkGoal(h, "鉴权");
    const res = await post(h, "/api/dsh-graph/start-execution", { goal });
    assert.equal(res._code, expected);
    assert.equal(goalDetail(h.root, goal).attempts.length, 0);
    assert.equal(h.spawned.length, 0);
  }
});

test("g-610 判据2：spawning attempt 让 postpone 判活跃；显式 abandon 后才可暂缓", async () => {
  const h = makeHarness();
  const goal = mkGoal(h, "暂缓门禁");
  startAttempt(h.root, goal, {
    executor: "agent:x", actor: "human:gui",
    dispatchState: "spawning", dispatchOwnerPid: process.pid,
  });
  markCallSettled(h.root, goal, "att-001");
  transition(h.root, goal, "in_progress", { actor: "human:gui", reason: "fixture" });
  assert.throws(() => postponeGoal(h.root, goal, { actor: "human:gui" }), /进行中的子代理/);
  abandonAttempt(h.root, goal, {
    actor: "human:gui", attempt: "att-001", reason: "confirm settled",
    spawnEvidence: { supported: true, parent_session_id: "sess-super", children: [] },
  });
  postponeGoal(h.root, goal, { actor: "human:gui" });
  assert.equal(loadGoal(findGoalFile(h.root, goal)).meta.status, "draft");
});
