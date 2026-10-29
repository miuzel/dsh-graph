/**
 * g-610：真实 0.2.1-rc.2 宿主栈下的单活派发与系统动作边界。
 *
 * 覆盖负责人确认的正常场景：同 goal 串行/Promise.all 只允许 1 个 child；await spawn 窗口
 * 的第二路拒绝；不同 goal/workspace 可并行；running child 时 postpone 实际不执行；
 * 自然结束（subagent/end 事件）后可正常重派；attempt/owner 绑定与事件一致。
 * 不覆盖：手工篡改、崩溃后 spawn 未结算的极端自动恢复（标未证，走既有 abandon）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { init, createGoal, setCriteria } from "../ops.ts";
import { readEvents } from "../events.ts";
import { transition, loadGoal, saveGoal, findGoalFile, listWorktrees, startAttempt, abandonAttempt, bindAttemptChild, settleAttemptDispatchInFlight, assertNoActiveExecutionChild } from "../ops.ts";
import { existsSync, mkdtempSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeRealHost, makeGoal } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn: () => boolean, label: string, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fn()) return;
    await sleep(25);
  }
  assert.fail(`等待超时：${label}`);
}

test("g-610 真实宿主：同 goal 串行只允许 1 child，running 时第二路明确拒绝且零新增", async () => {
  const h = await makeRealHost();
  try {
    const goal = await makeGoal(h, "serial single active");
    const first: any = await h.dispatch(goal, "first");
    assert.ok(first.child_id, "首次必须真实启动 child");
    const row = h.attempts(goal).find((a: any) => a.id === first.attempt);
    assert.equal(row.child_id, first.child_id, "attempt 绑定的 child 与返回一致");
    assert.equal(row.parent_session_id, "sess-super", "owner/parent 绑定来自真实 parent");
    assert.ok(row.binding_token, "绑定 token 已落盘");
    await waitFor(() => h.childLive(first.child_id) === "running", "first child running");

    const before = h.attempts(goal).length;
    await assert.rejects(
      () => h.dispatch(goal, "second"),
      (e: any) => /仍在运行/.test(String(e?.message ?? e)) && /child/.test(String(e?.message ?? e)),
      "同 goal 第二路必须拒绝",
    );
    assert.equal(h.attempts(goal).length, before, "拒绝不得新增 attempt");

    // force 不绕过
    await assert.rejects(() => h.dispatch(goal, "force", { force: true }), /仍在运行/);

    // 自然结束（真实 subagent/end）后允许重派
    h.fake.release();
    await waitFor(() => h.attempts(goal).some((a: any) => a.result === "pending")
      && readEvents(h.root).some((e) => e.event === "attempt.results_written"
        && e.details?.attempt === first.attempt && e.details?.source === "subagent/end"), "subagent/end 事件");
    const third: any = await h.dispatch(goal, "after natural end");
    assert.equal(third.child_id?.length > 0, true, "自然结束后可重派");
    assert.equal(h.attempts(goal).length, before + 1);
  } finally {
    h.fake.release();
    await h.shutdown();
  }
});

test("g-610 真实宿主：Promise.all 同 goal 只有 1 个 child，另一路在 spawn 窗口被拒", async () => {
  const h = await makeRealHost();
  try {
    const goal = await makeGoal(h, "promise all single active");
    const results = await Promise.allSettled([h.dispatch(goal, "a"), h.dispatch(goal, "b")]);
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1, "只能有 1 个成功派发");
    assert.equal(bad.length, 1, "另一路必须被拒");
    assert.match(String(bad[0].reason?.message ?? bad[0].reason), /dispatch_in_flight|仍在运行|启动尚未结算/);
    assert.equal(h.attempts(goal).length, 1, "只落 1 个 attempt");
    assert.equal(ok[0].value.child_id?.length > 0, true);
    assert.equal(h.childLive(ok[0].value.child_id), "running");
  } finally {
    h.fake.release();
    await h.shutdown();
  }
});

test("g-610 真实宿主：不同 goal 可并行启动（锁按 goal 隔离）", async () => {
  const h = await makeRealHost();
  try {
    const g1 = await makeGoal(h, "parallel goal one");
    const g2 = await makeGoal(h, "parallel goal two");
    const [r1, r2] = await Promise.all([h.dispatch(g1, "one"), h.dispatch(g2, "two")]);
    assert.ok(r1.child_id && r2.child_id, "两个 goal 各自启动 child");
    assert.notEqual(r1.child_id, r2.child_id);
    // 两路都在首个子代理尚未结束时完成派发（证明没有跨 goal 的全局锁；运行进度由宿主调度）。
    assert.equal(h.attempts(g1).length, 1);
    assert.equal(h.attempts(g2).length, 1);
  } finally {
    h.fake.release();
    await h.shutdown();
  }
});

test("g-610 真实宿主：running child 时 postpone 实际不执行；自然结束后才允许", async () => {
  const h = await makeRealHost();
  try {
    const goal = await makeGoal(h, "postpone while running");
    const first: any = await h.dispatch(goal, "running");
    await waitFor(() => h.childLive(first.child_id) === "running", "child running");
    const postpone = h.tools.get("graph_postpone_goal");
    assert.ok(postpone, "graph_postpone_goal 必须注册");
    const beforeEvents = readEvents(h.root).length;
    await assert.rejects(
      async () => postpone.execute({ goal, reason: "running should block" }, { agent: h.parent, signal: new AbortController().signal }),
      (e: any) => /拒绝暂缓目标/.test(String(e?.message ?? e)) && /仍在运行/.test(String(e?.message ?? e)),
      "running 时 postpone 必须拒绝",
    );
    assert.equal(readEvents(h.root).length, beforeEvents, "拒绝不得写事件");
    assert.equal(h.attempts(goal).length, 1, "拒绝不得改 attempt");

    h.fake.release();
    await waitFor(() => readEvents(h.root).some((e) => e.event === "attempt.results_written"
      && e.details?.attempt === first.attempt && e.details?.source === "subagent/end"), "natural end event");
    // 自然结束后按既有授权流程解绑（正常完成 → 有权处理 → 继续管理动作）
    const att = h.attempts(goal).find((a: any) => a.id === first.attempt);
    const unbind = h.tools.get("graph_unbind_goal_child");
    assert.ok(unbind, "graph_unbind_goal_child 必须注册");
    const ur: any = await unbind.execute(
      { goal, attempt: first.attempt, token: att.binding_token, reason: "natural end" },
      { agent: h.parent, signal: new AbortController().signal },
    );
    assert.equal(ur.ok, true);
    const res: any = await postpone.execute({ goal, reason: "after authorized unbind" }, { agent: h.parent, signal: new AbortController().signal });
    assert.equal(res.ok, true, "自然结束+授权解绑后允许暂缓");
  } finally {
    h.fake.release();
    await h.shutdown();
  }
});


test("g-610 真实宿主：running child 时 archive/delete 不执行；自然结束+授权解绑后可继续", async () => {
  const h = await makeRealHost();
  try {
    const exec = { agent: h.parent, signal: new AbortController().signal };
    const archive = h.tools.get("graph_archive_goal");
    const del = h.tools.get("graph_delete_goal");
    const abandon = h.tools.get("graph_abandon_attempt");
    assert.ok(archive && del && abandon);

    // ① 遗留 active（已交付但 child 仍 running）：archive/delete 门禁必须拒绝且不执行
    const g1 = await makeGoal(h, "legacy delivered running", "task", true);
    const a1: any = await h.dispatch(g1, "running");
    await waitFor(() => h.childLive(a1.child_id) === "running", "child running");
    transition(h.root, g1, "review", { actor: "human:gui" });
    transition(h.root, g1, "delivered", { actor: "human:gui" });
    await assert.rejects(async () => archive.execute({ goal: g1 }, exec),
      (e: any) => /拒绝归档目标/.test(String(e?.message ?? e)) && /仍在运行/.test(String(e?.message ?? e)));
    // delete 的既有 metadata 闸门先看 status_line；置为完成以把断言推进到 live 门禁
    const af1 = join(dirname(findGoalFile(h.root, g1)), "attempts", a1.attempt, "attempt.md");
    const d1 = loadGoal(af1); d1.meta.status_line = "完成"; saveGoal(af1, d1);
    const gf1 = findGoalFile(h.root, g1); const gd1 = loadGoal(gf1); gd1.meta.archived = true; saveGoal(gf1, gd1);
    const beforeEv = readEvents(h.root).length;
    await assert.rejects(async () => del.execute({ goal: g1 }, exec),
      (e: any) => /拒绝删除目标/.test(String(e?.message ?? e)) && /仍在运行/.test(String(e?.message ?? e)));
    assert.equal(readEvents(h.root).length, beforeEv, "delete 拒绝不得写事件");

    // ② 正常完成：child 自然结束 → 在 in_progress 阶段授权解绑 → 交付 → archive/delete 成功
    const g2 = await makeGoal(h, "normal completed then archive", "task", true);
    const a2: any = await h.dispatch(g2, "normal");
    await waitFor(() => h.childLive(a2.child_id) === "running", "child2 running");
    h.fake.release();
    await waitFor(() => readEvents(h.root).some((e) => e.event === "attempt.results_written"
      && e.details?.attempt === a2.attempt && e.details?.source === "subagent/end"), "child2 end event");
    await waitFor(() => h.childLive(a2.child_id) !== "running", "child2 stopped");
    const att2 = h.attempts(g2).find((a: any) => a.id === a2.attempt);
    await h.tools.get("graph_unbind_goal_child").execute(
      { goal: g2, attempt: a2.attempt, token: att2.binding_token, reason: "natural end" }, exec,
    );
    transition(h.root, g2, "review", { actor: "human:gui" });
    transition(h.root, g2, "delivered", { actor: "human:gui" });
    const ar: any = await archive.execute({ goal: g2 }, exec);
    assert.equal(ar.ok, true, "结束+解绑后允许归档");
    const dr: any = await del.execute({ goal: g2 }, exec);
    assert.equal(dr.ok, true, "归档后允许删除");
  } finally {
    h.fake.release();
    await h.shutdown();
  }
});

test("g-610 真实宿主：running child 时 cleanWorktree 不执行；自然结束+解绑后允许清理", async () => {
  const h = await makeRealHost({ gitRepo: true });
  try {
    const exec = { agent: h.parent, signal: new AbortController().signal };
    const clean = h.tools.get("graph_clean_worktree");
    assert.ok(clean);

    // ① 遗留 active（delivered + status_line=完成 使 metadata isActive=false，但 registry 仍 running）
    const g1 = await makeGoal(h, "legacy delivered clean", "feature", true);
    const a1: any = await h.dispatch(g1, "running", { worktree: true });
    assert.ok(a1.worktree?.path, "feature 建树");
    await waitFor(() => h.childLive(a1.child_id) === "running", "child running");
    const af1 = join(dirname(findGoalFile(h.root, g1)), "attempts", a1.attempt, "attempt.md");
    const d1 = loadGoal(af1); d1.meta.status_line = "完成"; saveGoal(af1, d1);
    transition(h.root, g1, "review", { actor: "human:gui" });
    transition(h.root, g1, "delivered", { actor: "human:gui" });
    const row1 = listWorktrees(h.root, g1).find((c) => c.attempt === a1.attempt);
    assert.ok(row1);
    const out1: any = await clean.execute({ id: row1!.id, confirm: true }, exec);
    assert.equal(out1.ok, false, "running 时不得清理");
    assert.match(String(out1.reason ?? ""), /仍在运行/);

    // ② 正常完成：child 结束 → in_progress 解绑 → 交付 → clean 成功
    const g2 = await makeGoal(h, "normal completed clean", "feature", true);
    const a2: any = await h.dispatch(g2, "normal", { worktree: true });
    await waitFor(() => h.childLive(a2.child_id) === "running", "child2 running");
    h.fake.release();
    await waitFor(() => readEvents(h.root).some((e) => e.event === "attempt.results_written"
      && e.details?.attempt === a2.attempt && e.details?.source === "subagent/end"), "child2 end event");
    await waitFor(() => h.childLive(a2.child_id) !== "running", "child2 stopped");
    const att2 = h.attempts(g2).find((a: any) => a.id === a2.attempt);
    await h.tools.get("graph_unbind_goal_child").execute(
      { goal: g2, attempt: a2.attempt, token: att2.binding_token, reason: "natural end" }, exec,
    );
    transition(h.root, g2, "review", { actor: "human:gui" });
    transition(h.root, g2, "delivered", { actor: "human:gui" });
    const row2 = listWorktrees(h.root, g2).find((c) => c.attempt === a2.attempt);
    assert.ok(row2);
    const out2: any = await clean.execute({ id: row2!.id, confirm: true }, exec);
    assert.equal(out2.ok, true, "结束+解绑后允许清理");
  } finally {
    h.fake.release();
    await h.shutdown();
  }
});


test("g-610：另一写入者遗留的 dispatch_in_flight 拒绝派发与普通 abandon；凭已确认无 child 结算后可恢复", async () => {
  const h = await makeRealHost();
  try {
    const goal = await makeGoal(h, "durable inflight marker");
    const att = startAttempt(h.root, goal, { executor: "agent:executor", actor: "human:gui", dispatchInFlight: true });
    const before = h.attempts(goal).length;
    await assert.rejects(
      () => h.dispatch(goal, "blocked by durable marker"),
      (e: any) => /dispatch_in_flight/.test(String(e?.message ?? e)) && /首次子代理启动尚未结算/.test(String(e?.message ?? e)),
    );
    assert.equal(h.attempts(goal).length, before, "拒绝不得新增 attempt");
    // 不提供调用方声明放行：普通 abandon 在标记存在时同样拒绝
    await assert.rejects(
      async () => abandonAttempt(h.root, goal, { actor: "human:gui", attempt: att, reason: "not proven stopped" }),
      /首次子代理启动尚未结算/,
    );
    // 已确认无 child 的前置失败由 settle 正常结算（正常恢复路径，不是人工 attestation）
    settleAttemptDispatchInFlight(h.root, goal, att, { actor: "human:gui", error: "confirmed pre-spawn failure" });
    const ok: any = await h.dispatch(goal, "after confirmed settlement");
    assert.ok(ok.child_id, "确认无 child 的失败结算后可派发");
  } finally {
    h.fake.release();
    await h.shutdown();
  }
});

test("g-610 rev-02 真实宿主：spawn await 窗口普通 abandon 必拒；第二派发零新 attempt；原 spawn 只 bind 一次", async () => {
  const h = await makeRealHost({ holdPrepare: true });
  try {
    const goal = await makeGoal(h, "rev2 inflight abandon race");
    const exec = { agent: h.parent, signal: new AbortController().signal };
    const first = h.dispatch(goal, "first-held");
    await waitFor(() => {
      const a = h.attempts(goal)[0];
      if (!a) return false;
      const f = join(dirname(findGoalFile(h.root, goal)), "attempts", a.id, "attempt.md");
      return existsSync(f) && loadGoal(f).meta.dispatch_in_flight === true && !loadGoal(f).meta.child_id;
    }, "attempt 持久 in_flight 且 child_id=null");

    const att = h.attempts(goal)[0];
    const beforeEvents = readEvents(h.root).length;
    await assert.rejects(
      async () => h.tools.get("graph_abandon_attempt").execute({ goal, attempt: att.id, reason: "normal race" }, exec),
      (e: any) => /首次子代理启动尚未结算/.test(String(e?.message ?? e)),
      "在途窗口普通 abandon 必须拒绝",
    );
    assert.equal(readEvents(h.root).length, beforeEvents, "拒绝不得写事件");
    assert.equal(h.attempts(goal).length, 1, "拒绝不得新增 attempt");
    const beforeSecond = readEvents(h.root).length;
    await assert.rejects(() => h.dispatch(goal, "second"), /dispatch_in_flight/, "第二派发必须拒绝");
    assert.equal(h.attempts(goal).length, 1, "第二派发不得新增 attempt");
    assert.equal(readEvents(h.root).length, beforeSecond, "第二派发不得写图事件");

    h.fake.hold();
    h.releasePrepare();
    const ok: any = await first;
    assert.ok(ok.child_id, "原 spawn 正常完成 bind");
    await waitFor(() => h.childLive(ok.child_id) === "running", "original child running");
    assert.equal(h.attempts(goal).length, 1);
    assert.equal(readEvents(h.root).filter((e) => e.event === "attempt.bound" && e.details?.attempt === att.id).length, 1, "只允许一次 bound");
    assert.equal(readEvents(h.root).some((e) => e.event === "attempt.abandoned" && e.details?.attempt === att.id), false, "不得出现 abandoned");

    // 已 bind 后再次用派发 CAS 绑定同一 attempt 必须拒绝且零事件（简单防倒置）
    const beforeDup = readEvents(h.root).length;
    assert.throws(
      () => bindAttemptChild(h.root, goal, att.id, ok.child_id, "human:gui", "sess-super", null, null, null, null, null, { dispatchInFlight: true, parentSessionId: "sess-super" }),
      /不处于首次启动窗口/,
    );
    assert.equal(readEvents(h.root).length, beforeDup, "重复 bind 不得写事件");

    // 自然结束 + 既有授权解绑后合法返工
    h.fake.release();
    await waitFor(() => readEvents(h.root).some((e) => e.event === "attempt.results_written"
      && e.details?.attempt === att.id && e.details?.source === "subagent/end"), "natural end");
    await waitFor(() => h.childLive(ok.child_id) !== "running", "child stopped");
    const row = h.attempts(goal).find((a: any) => a.id === att.id);
    await h.tools.get("graph_unbind_goal_child").execute({ goal, attempt: att.id, token: row.binding_token, reason: "natural end" }, exec);
    const retry: any = await h.dispatch(goal, "authorized retry");
    assert.ok(retry.child_id, "正常结束+授权解绑后可返工");
    assert.equal(h.attempts(goal).length, 2);
  } finally {
    h.fake.release();
    h.releasePrepare();
    await h.shutdown();
  }
});

test("g-610 rev-02 真实 HTTP owner 路径：401/403 先于业务；在途 abandon 409；第二 start 409 且零新 attempt", async () => {
  const h = await makeRealHost({ holdPrepare: true, http: true });
  try {
    const goal = await makeGoal(h, "rev2 http inflight race");
    const path = "/api/dsh-graph/start-execution";
    const body = { goal, workspace: h.ws, attempt_brief: "http first" };
    const anon = await h.http.request("POST", path, {}, body);
    assert.ok([401, 403].includes(anon.status), `匿名必须先 401/403，实得 ${anon.status}`);
    assert.equal(h.attempts(goal).length, 0, "匿名请求零业务副作用");

    const cookie = h.http.mintOwnerCookie();
    const firstP = h.http.request("POST", path, { cookie }, body);
    await waitFor(() => {
      const a = h.attempts(goal)[0];
      if (!a) return false;
      const f = join(dirname(findGoalFile(h.root, goal)), "attempts", a.id, "attempt.md");
      return existsSync(f) && loadGoal(f).meta.dispatch_in_flight === true && !loadGoal(f).meta.child_id;
    }, "HTTP attempt in_flight");
    const att = h.attempts(goal)[0];

    const ab = await h.http.request("POST", "/api/dsh-graph/abandon-attempt", { cookie }, { goal, attempt: att.id, reason: "http normal race", workspace: h.ws });
    assert.notEqual(ab.status, 200, "在途 HTTP abandon 必须拒绝");
    assert.match(String(ab.body?.error ?? ab.body), /首次子代理启动尚未结算/);
    assert.equal(h.attempts(goal).length, 1, "HTTP abandon 拒绝不得新增 attempt");

    const second = await h.http.request("POST", path, { cookie }, { goal, workspace: h.ws, attempt_brief: "http second" });
    assert.equal(second.status, 409, `第二 HTTP start 必须 409，实得 ${second.status} ${JSON.stringify(second.body)}`);
    assert.equal(h.attempts(goal).length, 1, "第二 HTTP start 不得新增 attempt");

    h.fake.hold();
    h.releasePrepare();
    const first: any = await firstP;
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.ok(first.body?.child_id, "原 HTTP spawn 正常 bind");
    await waitFor(() => h.childLive(first.body.child_id) === "running", "HTTP child running");
    assert.equal(h.attempts(goal).length, 1);
    assert.equal(readEvents(h.root).filter((e) => e.event === "attempt.bound" && e.details?.attempt === att.id).length, 1);
  } finally {
    h.fake.release();
    h.releasePrepare();
    await h.shutdown();
  }
});


test("g-610 rev-02：registry=idle 但 result 仍 pending 且无结束事件 ⇒ 拒绝；终态/结束事件才放行", () => {
  const h = { root: mkdtempSync(join(process.cwd(), "tmp", "g610", "idle-")) };
  init(h.root);
  const goal = createGoal(h.root, { title: "idle gate", version: "v1.0", type: "task", actor: "human:gui" });
  setCriteria(h.root, goal, ["判据"], "human:gui");
  const att = startAttempt(h.root, goal, { executor: "agent:executor", actor: "human:gui" });
  bindAttemptChild(h.root, goal, att, "idle-child", "human:gui", "sess-super");
  assert.throws(
    () => assertNoActiveExecutionChild(h.root, goal, { liveCheck: () => "idle", action: "派发执行", includeLocalActive: true }),
    /idle 只代表.*已登记未终结/,
  );
  const f = join(dirname(findGoalFile(h.root, goal)), "attempts", att, "attempt.md");
  const doc = loadGoal(f); doc.meta.result = "completed"; saveGoal(f, doc);
  assert.doesNotThrow(() => assertNoActiveExecutionChild(h.root, goal, { liveCheck: () => "idle", action: "派发执行", includeLocalActive: true }));
});
