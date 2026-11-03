/**
 * g-612 att-009：独立 review 两个真实 public host BLOCK 的正式回归。
 *
 * ① 复查阶段（真实 progress/no-progress 后 `budgetCountdown=false`、无冷却、budget 30/recheck 300）
 *    不存在独立预算目标 ⇒ 公开 `budget_due_at` 必须 `null`（语义 = 当前不存在独立预算阶段，
 *    不是「预算已超时」）；`next_due_at`/`due_in_ms`/timer/投递仍严格 = `lastCareAt + 300s`：
 *    deadline−1s 零投递、+1s 恰一次。首次尚未关照（`lastCareAt===null`，含旧快照缺 flag）
 *    与主管真实新消息重置后的预算倒计时仍是**可证**正例，必须继续返回数字。
 *
 * ② 同一 run 初始 goal 预算 30，真实 owner 通过公开 `graph_set_goal_budget` 交替 60/120 共 33 次：
 *    32 项有界历史必须保留**真实起点 30** + 最近 31 次变化，并公开
 *    `budget_changes_truncated=true`；恰好 31 次变化不截断、32/33 次如实截断；重复同值不增变化。
 *    停止后 `budget_seconds=30`、`deviation_basis=initial`、`deviation_ms=natural_ms−30000`；
 *    正常 dispose/recreate 后同一事件真源恢复起点/变化/截断标志。
 *
 * 真实 0.2.1-rc.2 宿主栈 + 生产 createCareRuntime + fake adapter/假时钟；不联网/真实 provider。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { appendEvent, readEvents } from "../events.ts";
import { invalidateBoardCache } from "../cache.ts";
import { claimSupervisor, closeWatchers, getCachedBoardPayload, readSupervisorSession } from "../ops.ts";
import { careTaskBudgetDueAtReportable } from "../care.ts";
import { createCareRuntime } from "../../dist/index.js";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(cond: () => T | null | Promise<T | null>, label: string, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const v = await cond(); if (v) return v as T; await sleep(10); }
  throw new Error(`等待超时：${label}`);
}
function fakeClock(start = Date.now()) { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } }; }
function fakeScheduler(clock: any) {
  let seq = 0; const timers = new Map<number, { at: number; fn: () => any }>();
  const setTimeoutFn = (fn: () => any, ms: number) => { const id = ++seq; timers.set(id, { at: clock.now() + Math.max(0, Number(ms) || 0), fn }); return id; };
  const clearTimeoutFn = (id: number) => { timers.delete(id); };
  const advanceTo = async (target: number) => {
    for (let guard = 0; guard < 6000; guard += 1) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (!due.length) break;
      const [id, v] = due[0]; timers.delete(id); clock.set(v.at); await v.fn();
      if (clock.now() > target) clock.set(target);
    }
    clock.set(target); await new Promise((r) => setImmediate(r));
  };
  return { setTimeoutFn, clearTimeoutFn, advanceTo, timers };
}
const GLOBAL = () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: true, raw: "on" });
const PROJECT = (threshold: number, recheck: number) => `supervisor:\n  session: sess-super\n  care: "false"\n  care_threshold_seconds: ${threshold}\n  care_recheck_seconds: ${recheck}\n`;
const careInspections = (root: string) => readEvents(root).filter((e: any) => e.event === "care.inspection");

/** 生产 createCareRuntime + 真实宿主 + 注入假时钟（测试加速；真实 public 路径见下方实时 timer 用例）。 */
async function setup(recheck: number, idPrefix: string) {
  const h = await makeRealHost({ relativeRoot: true, projectYaml: PROJECT(30, recheck), sessionQuery: true });
  claimSupervisor(h.root, h.parent.id, `att009:${idPrefix}`);
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  let seq = 0;
  const care = createCareRuntime({
    ctx: { on: (name: string, fn: any) => h.ctx.on(name, fn), get: (name: string) => (name === "agents" ? h.reg : name === "llm" ? h.llm : undefined) },
    readGlobal: GLOBAL,
    resolveRoot: (ws: string) => join(ws, ".dsh-graph"),
    defaultWorkspace: () => h.ws,
    readProjectConfigFn: () => ({ supervisor: { care: true, care_threshold_seconds: 30, care_recheck_seconds: recheck } }),
    readSupervisorSessionFn: (root: string) => readSupervisorSession(root),
    readBoardPayload: (root: string) => { try { return getCachedBoardPayload(root, { lazy: true })?.payload ?? null; } catch { return null; } },
    now: clock.now, setTimeoutFn: scheduler.setTimeoutFn, clearTimeoutFn: scheduler.clearTimeoutFn,
    appendEventFn: (root: string, ev: any) => appendEvent(root, ev),
    makeInspectionId: () => `${idPrefix}-${++seq}`, log: () => {},
  });
  care.start();
  const goal = await makeGoal(h, `att009 ${idPrefix}`);
  invalidateBoardCache(h.root);
  h.fake.hold(`${idPrefix}-CHILD`);
  const d: any = await h.dispatch(goal, `${idPrefix}-CHILD`, { worktree: false });
  const childId = String(d.child_id ?? "");
  const attempt = String(d.attempt ?? "att-001");
  await waitFor(() => (h.childLive(childId) === "running" ? true : null), "child running");
  care.armForRoot(h.root);
  const status = () => care.statusFor(h.root);
  const task = () => (status()?.tasks ?? []).find((t: any) => t.child === childId) ?? null;
  await waitFor(() => (task() ? true : null), "task sampled");
  const shutdown = async () => { try { care.dispose(); } catch {} h.fake.releaseAll(); closeWatchers(); try { await h.shutdown(); } catch {} };
  return { h, clock, scheduler, care, goal, childId, attempt, status, task, shutdown };
}
type S = Awaited<ReturnType<typeof setup>>;

async function firstCareAndOutcome(s: S, kind: "progress" | "no-progress") {
  const due = Number(s.status()?.next_due_at);
  assert.ok(Number.isFinite(due), "首次预算目标必须是数字");
  await s.scheduler.advanceTo(due + 1000);
  await waitFor(() => (careInspections(s.h.root).length >= 1 ? true : null), "first care delivered");
  await waitFor(() => (s.h.parent.status === "idle" ? true : null), "supervisor idle after care");
  const inspection = String((careInspections(s.h.root).at(-1) as any)?.details?.inspection ?? "");
  assert.ok(inspection, "inspection id");
  const out: any = s.care.submitOutcome({
    root: s.h.root, supervisor: s.h.parent.id, inspection, goal: s.goal, attempt: s.attempt, child: s.childId,
    outcome: kind, evidence: `att009 real ${kind}`,
  });
  assert.equal(out.ok, true, `${kind} accepted: ${JSON.stringify(out)}`);
  await sleep(20);
  return { due, inspection };
}

for (const kind of ["progress", "no-progress"] as const) {
  test(`att009-FIELD1 ${kind}：复查阶段 budget_due_at=null，next_due=lastCare+300 且投递边界不变`, async () => {
    const s = await setup(300, `f1-${kind}`);
    try {
      // 正控 A：首次尚未关照（lastCareAt===null）时仍有可证的独立预算目标。
      const t0: any = s.task();
      const dispatchBase = Number(t0.budget_base_at ?? t0.started_at);
      assert.equal(Number(t0.effective_budget_seconds), 30, "生效预算=项目阈值 30");
      assert.equal(t0.budget_source, "project_explicit", "预算来源=项目显式");
      assert.equal(Number(t0.budget_due_at), dispatchBase + 30_000, "首次未关照 ⇒ 可证预算目标=base+30s");
      assert.equal(Number(s.status()?.next_due_at), dispatchBase + 30_000, "首次实际截止=预算目标");

      const { due } = await firstCareAndOutcome(s, kind);
      const t: any = s.task();
      const st: any = s.status();
      assert.equal(Number(t.last_care_at), due, "lastCare=真实首次关照时点");
      assert.equal(t.budget_countdown, false, "关照后回到复查阶段");
      assert.equal(t.cooldown_due_at, null, "有效结论清冷却（progress/no-progress）");
      assert.equal(Number(t.reminders_sent), 0, "有效结论清零未回复计数");
      assert.equal(t.awaiting_reply, false, "有效结论已回答");
      assert.equal(Number(t.effective_budget_seconds), 30, "预算时长仍可见");
      assert.equal(t.budget_source, "project_explicit", "预算来源仍可见");
      const recheckDue = Number(t.last_care_at) + 300_000;
      assert.equal(Number(st.next_due_at), recheckDue, "next_due_at 仍是 lastCare+recheck");
      assert.equal(Number(t.dueAt), recheckDue, "task dueAt 仍是 lastCare+recheck");
      assert.equal(t.budget_due_at, null,
        "复查阶段没有独立预算目标 ⇒ budget_due_at 必须 null（不得把 lastCare+recheck 冒充预算）");

      // 投递边界：deadline−1s 零次、+1s 恰一次（调度/计时不受展示修复影响）。
      const before = careInspections(s.h.root).length;
      await s.scheduler.advanceTo(recheckDue - 1000);
      assert.equal(careInspections(s.h.root).length, before, "复查截止前 1s 不得投递");
      await s.scheduler.advanceTo(recheckDue + 1000);
      assert.equal(careInspections(s.h.root).length, before + 1, "复查截止后 1s 恰投递一次");

      // 正控 B：主管真实新消息重置后重新进入可证预算倒计时（仍必须返回数字）。
      const msgAt = s.clock.now();
      const msgId = await s.h.subagents.sendMessage(s.h.parent, s.childId, [{ type: "text", text: `att009 real steer ${kind}` }], { signal: new AbortController().signal });
      assert.ok(msgId, "真实主管消息被接受");
      await waitFor(() => (Number(s.task()?.budget_base_at) >= msgAt - 1 ? true : null), "message budget base applied");
      const tm: any = s.task();
      assert.equal(tm.budget_countdown, true, "新消息建立预算倒计时");
      assert.ok(Number.isFinite(Number(tm.budget_due_at)), "新消息后独立预算目标必须可证（不得一律 null）");
      assert.equal(Number(tm.budget_due_at), Number(tm.budget_base_at) + 30_000, "budget_due=消息基准+30s");
    } finally { await s.shutdown(); }
  });
}

test("att009-FIELD1 旧快照首次未关照 budgetCountdown=false 仍按预算阶段（纯函数正控）", () => {
  const timing = { thresholdSeconds: 30, recheckSeconds: 300, resetAt: null, thresholdSource: "project_explicit" as const };
  const legacyFirst = { startedAt: 1_000, lastCareAt: null, budgetCountdown: false, budgetSeconds: null };
  assert.equal(careTaskBudgetDueAtReportable(legacyFirst as any, timing), 31_000,
    "lastCareAt===null 的首次纯预算阶段即使旧快照 flag=false 也仍可证");
  const postCare = { startedAt: 1_000, lastCareAt: 61_000, budgetCountdown: false, budgetSeconds: null };
  assert.equal(careTaskBudgetDueAtReportable(postCare as any, timing), null,
    "已关照后的复查阶段没有独立预算目标 ⇒ null");
});

test("att009-FIELD1 real public timer + graph_care_outcome：progress 后 budget_due_at=null", async () => {
  const h = await makeRealHost({ sessionQuery: true, projectYaml: "supervisor:\n  session: sess-super\n  care: \"true\"\n  care_threshold_seconds: 30\n  care_recheck_seconds: 300\n" });
  const sig = () => new AbortController().signal;
  const exec = () => ({ agent: h.parent, signal: sig() });
  const getCare = async () => (await h.tools.get("graph_get_settings").execute({}, exec())).supervisor_care;
  try {
    assert.equal((await h.tools.get("graph_claim_supervisor").execute({}, exec())).supervisor_session, h.parent.id);
    const goal = await makeGoal(h, "att009 field1b real public status");
    h.fake.hold("ATT009-F1B-CHILD");
    const d: any = await h.dispatch(goal, "ATT009-F1B-CHILD", { worktree: false });
    const childId = String(d.child_id ?? "");
    const attempt = String(d.attempt ?? "att-001");
    await waitFor(() => h.childLive(childId) === "running", "child running");
    // 真实宿主 timer：等待真实 t30 care inspection（public production path，不注入时钟）。
    await waitFor(() => careInspections(h.root).length >= 1 ? true : null, "real t30 care inspection", 45000);
    await waitFor(() => h.parent.status === "idle", "supervisor idle after care", 15000);
    const inspection = String((careInspections(h.root).at(-1) as any)?.details?.inspection ?? "");
    assert.ok(inspection, "inspection id");
    const out: any = await h.tools.get("graph_care_outcome").execute({
      inspection, goal, attempt, child: childId, outcome: "progress", evidence: "att009 FIELD-1b real public progress",
    }, exec());
    assert.equal(out.ok, true, `real graph_care_outcome accepted: ${JSON.stringify(out)}`);
    const st: any = await getCare();
    const t: any = (st.tasks ?? []).find((x: any) => x.child === childId);
    assert.ok(t, "public task present");
    const recheckDue = Number(t.last_care_at) + 300_000;
    assert.equal(t.budget_countdown, false, "真实 progress 后回到复查阶段");
    assert.equal(t.cooldown_due_at, null, "有效结论清冷却");
    assert.equal(Number(t.effective_budget_seconds), 30, "预算时长仍可见");
    assert.equal(Number(st.next_due_at), recheckDue, "public next_due = lastCare+recheck");
    assert.equal(Number(t.dueAt), recheckDue, "public dueAt = lastCare+recheck");
    assert.equal(t.budget_due_at, null, "public budget_due_at 必须 null（不得冒充复查截止）");
  } finally {
    try { h.fake.releaseAll(); } catch {}
    try { await h.shutdown(); } catch {}
  }
});

const GOAL_BUDGET_PROJECT = "supervisor:\n  session: sess-super\n  care: \"true\"\n  care_threshold_seconds: 300\n";
async function field2Host() {
  const h = await makeRealHost({ sessionQuery: true, projectYaml: GOAL_BUDGET_PROJECT });
  const sig = () => new AbortController().signal;
  const getCare = async (host: any) => (await host.tools.get("graph_get_settings").execute({}, { agent: host.parent, signal: sig() })).supervisor_care;
  const goal = await makeGoal(h, "att009 field2 initial budget");
  const set = (seconds: number) => h.tools.get("graph_set_goal_budget").execute({ goal, budget_seconds: seconds }, { agent: h.parent, signal: sig() });
  assert.equal((await set(30) as any).new_seconds, 30, "initial goal budget 30");
  h.fake.hold("ATT009-F2-CHILD");
  const d: any = await h.dispatch(goal, "ATT009-F2-CHILD", { worktree: false });
  const childId = String(d.child_id ?? "");
  await waitFor(() => h.childLive(childId) === "running", "child running");
  const st0: any = await getCare(h);
  const t0: any = (st0.tasks ?? []).find((x: any) => x.child === childId);
  assert.ok(t0, "task sampled");
  assert.equal(Number(t0.effective_budget_seconds), 30, "run starts at 30");
  return { h, getCare, goal, set, childId };
}

async function stopAndRun(h: any, getCare: any, childId: string) {
  h.fake.releaseAll();
  await waitFor(() => h.childLive(childId) !== "running", "child stopped");
  await sleep(200);
  const st: any = await getCare(h);
  return (st.runs ?? []).find((r: any) => r.child === childId) ?? null;
}

test("att009-FIELD2 33 次真实 owner 预算修改：保留真实起点 30 + 最近31变化 + 截断标志", async () => {
  const { h, getCare, set, childId } = await field2Host();
  let h2: any = null;
  try {
    for (let i = 1; i <= 33; i += 1) {
      const next = i % 2 === 1 ? 60 : 120;
      const r: any = await set(next);
      assert.equal(r.new_seconds, next, `edit ${i} accepted`);
      const st: any = await getCare(h); // 显式公开 reconcile，顺序确定
      const t: any = (st.tasks ?? []).find((x: any) => x.child === childId);
      assert.ok(t, `task still sampled after edit ${i}`);
      assert.equal(Number(t.effective_budget_seconds), next, `effective budget after edit ${i}`);
    }
    const budgetEvents = readEvents(h.root).filter((e: any) => e.event === "care.budget")
      .map((e: any) => ({ at: Number(e.details.at), seconds: Number(e.details.budget_seconds), source: e.details.budget_source }));
    assert.equal(budgetEvents.length, 33, "33 次真实 owner 修改各产生一次公开生效事件");
    const run: any = await stopAndRun(h, getCare, childId);
    assert.ok(run, "stopped run record exists");
    assert.equal(Number(run.budget_seconds), 30, "run.budget_seconds 必须是真实起点 30");
    assert.equal(run.budget_source, "goal", "起点来源 goal");
    assert.equal(run.budget_changes.length, 31, "上限 32 = 起点 + 最近 31 条变化");
    assert.equal(run.budget_changes_truncated, true, "33 次变化淘汰中间条目 ⇒ 必须标截断");
    assert.deepEqual(
      run.budget_changes.map((c: any) => [Number(c.at), Number(c.seconds), c.source]),
      budgetEvents.slice(-31).map((c: any) => [c.at, c.seconds, c.source]),
      "保留的是最近 31 次真实变化（顺序/时点/source 逐字一致）",
    );
    assert.equal(run.deviation_basis, "initial", "偏差口径仍是起始预算");
    assert.equal(Number(run.deviation_ms), Number(run.natural_ms) - 30_000, "deviation=natural−起始30s");

    // 正常 dispose/recreate：起点/变化/截断标志必须由同一事件真源恢复。
    await h.shutdown();
    h2 = await makeRealHost({
      workspace: h.ws, sessionQuery: true, sessionId: "sess-super-2",
      projectYaml: GOAL_BUDGET_PROJECT.replace("sess-super", "sess-super-2"),
    });
    const restored: any = (await getCare(h2)).runs.find((r: any) => r.child === childId);
    assert.ok(restored, "重启后 run 历史可读");
    assert.equal(Number(restored.budget_seconds), 30, "重启后起点仍是 30");
    assert.equal(restored.budget_changes_truncated, true, "重启后截断标志仍在");
    assert.deepEqual(restored.budget_changes, run.budget_changes, "重启后变化时间线逐字保留");
  } finally {
    try { h.fake.releaseAll(); } catch {}
    try { await h.shutdown(); } catch {}
    if (h2) { try { h2.fake.releaseAll(); } catch {} try { await h2.shutdown(); } catch {} }
  }
});

test("att009-FIELD2 边界：31 次变化不截断、32 次截断、重复同值不增变化", async () => {
  {
    const { h, getCare, set, childId } = await field2Host();
    try {
      for (let i = 1; i <= 31; i += 1) {
        assert.equal((await set(i % 2 === 1 ? 60 : 120) as any).new_seconds, i % 2 === 1 ? 60 : 120);
        await getCare(h);
      }
      const run: any = await stopAndRun(h, getCare, childId);
      assert.equal(run.budget_changes.length, 31, "31 次变化全部保留");
      assert.equal(run.budget_changes_truncated, false, "恰好 31 次变化不得谎称截断");
      assert.equal(Number(run.budget_seconds), 30, "起点仍 30");
    } finally { try { h.fake.releaseAll(); } catch {} try { await h.shutdown(); } catch {} }
  }
  {
    const { h, getCare, set, childId } = await field2Host();
    try {
      for (let i = 1; i <= 32; i += 1) {
        assert.equal((await set(i % 2 === 1 ? 60 : 120) as any).new_seconds, i % 2 === 1 ? 60 : 120);
        await getCare(h);
      }
      const run: any = await stopAndRun(h, getCare, childId);
      assert.equal(run.budget_changes.length, 31, "32 次变化只保留最近 31 条");
      assert.equal(run.budget_changes_truncated, true, "32 次变化 ⇒ 如实标截断");
      assert.equal(Number(run.budget_seconds), 30, "起点仍 30");
    } finally { try { h.fake.releaseAll(); } catch {} try { await h.shutdown(); } catch {} }
  }
  {
    const { h, getCare, set, childId } = await field2Host();
    try {
      await set(60);
      await getCare(h);
      await set(60); // 同值重复：不得新增变化
      await getCare(h);
      await set(120);
      await getCare(h);
      const run: any = await stopAndRun(h, getCare, childId);
      assert.deepEqual(run.budget_changes.map((c: any) => [c.seconds, c.source]), [[60, "goal"], [120, "goal"]],
        "重复同值设置不新增变化");
      assert.equal(run.budget_changes_truncated, false);
      assert.equal(Number(run.budget_seconds), 30);
    } finally { try { h.fake.releaseAll(); } catch {} try { await h.shutdown(); } catch {} }
  }
});
