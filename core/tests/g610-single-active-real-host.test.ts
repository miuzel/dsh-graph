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
import { readEvents } from "../events.ts";
import { transition, loadGoal, saveGoal, findGoalFile, listWorktrees, startAttempt, abandonAttempt } from "../ops.ts";
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


test("g-610：另一写入者遗留的 dispatch_in_flight 持久标记会拒绝派发；授权 abandon 后可恢复", async () => {
  const h = await makeRealHost();
  try {
    const goal = await makeGoal(h, "durable inflight marker");
    // 模拟另一进程已落盘 attempt 但尚未 bind：本进程/另一进程都必须看到持久标记
    const att = startAttempt(h.root, goal, { executor: "agent:executor", actor: "human:gui", dispatchInFlight: true });
    const before = h.attempts(goal).length;
    await assert.rejects(
      () => h.dispatch(goal, "blocked by durable marker"),
      (e: any) => /dispatch_in_flight/.test(String(e?.message ?? e)) && /首次子代理启动尚未结算/.test(String(e?.message ?? e)),
    );
    assert.equal(h.attempts(goal).length, before, "拒绝不得新增 attempt");
    // 既有授权 abandon（owner）清除标记后可正常重派
    abandonAttempt(h.root, goal, { actor: "human:gui", attempt: att, reason: "explicit recovery" });
    const ok: any = await h.dispatch(goal, "after explicit recovery");
    assert.ok(ok.child_id, "显式恢复后可派发");
  } finally {
    h.fake.release();
    await h.shutdown();
  }
});
