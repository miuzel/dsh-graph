/**
 * g-612 返工（reviewer 实测 BLOCK ②）：同一 child+attempt+binding 仍 running 时，关照 runtime
 * **正常 dispose/recreate** 必须继续关联同一条 open run（不拆成两条、不伪造 stop）；
 * 停机窗口未被观察 ⇒ 如实标 observation_interrupted + 可证空窗，elapsed 不伪称全程精确；
 * 真实 idle 仍以公开 agent/status 的精确时点收尾（同一条记录）。
 *
 * 真实 0.2.1-rc.2 宿主栈 + 生产 createCareRuntime + fake adapter + 假时钟；不联网/真实 provider。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { appendEvent } from "../events.ts";
import { invalidateBoardCache } from "../cache.ts";
import { closeWatchers, getCachedBoardPayload, readSupervisorSession, setGoalBudget } from "../ops.ts";
import { createCareRuntime } from "../../dist/index.js";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await cond()) return; await sleep(10); }
  throw new Error(`等待超时：${label}`);
}
function fakeClock(start = Date.now()) { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } }; }
function fakeScheduler(clock: any) {
  let seq = 0; const timers = new Map<number, { at: number; fn: () => any }>();
  return {
    setTimeoutFn: (fn: () => any, ms: number) => { const id = ++seq; timers.set(id, { at: clock.now() + Math.max(0, Number(ms) || 0), fn }); return id; },
    clearTimeoutFn: (id: number) => { timers.delete(id); },
    timers,
  };
}
const PROJECT = "supervisor:\n  care: \"false\"\n  care_threshold_seconds: 300\n  care_recheck_seconds: 300\n";
function makeCare(h: any, clock: any, scheduler: any, idPrefix: string) {
  let seq = 0;
  return createCareRuntime({
    ctx: {
      on: (name: string, fn: any) => h.ctx.on(name, fn),
      get: (name: string) => (name === "agents" ? h.reg : name === "llm" ? h.llm : undefined),
    },
    readGlobal: () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: true, raw: "on" }),
    resolveRoot: (ws: string) => join(ws, ".dsh-graph"),
    defaultWorkspace: () => h.ws,
    readProjectConfigFn: () => ({ supervisor: { care: true, care_threshold_seconds: 300, care_recheck_seconds: 300 } }),
    readSupervisorSessionFn: (root: string) => readSupervisorSession(root),
    readBoardPayload: (root: string) => { try { return getCachedBoardPayload(root, { lazy: true })?.payload ?? null; } catch { return null; } },
    now: clock.now,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
    appendEventFn: (root: string, ev: any) => appendEvent(root, ev),
    makeInspectionId: () => `${idPrefix}-${++seq}`,
    log: () => {},
  });
}

async function startRunningChild(h: any, title: string, marker: string) {
  const goal = await makeGoal(h, title);
  setGoalBudget(h.root, goal, { budget_seconds: 30, actor: "human:gui" });
  invalidateBoardCache(h.root);
  h.fake.hold(marker);
  const d: any = await h.dispatch(goal, marker, { worktree: false });
  const childId = String(d.child_id ?? "");
  assert.ok(childId);
  await waitFor(() => h.childLive(childId) === "running", "child running");
  return { goal, childId };
}

test("g-612 runtime recreate：child 仍 running 时同一物理 run 只有一条，观察空窗如实标注", async () => {
  const h = await makeRealHost({ relativeRoot: true, projectYaml: PROJECT });
  const clockA = fakeClock();
  const schedA = fakeScheduler(clockA);
  const careA = makeCare(h, clockA, schedA, "g612recA");
  const sig = () => new AbortController().signal;
  const exec = () => ({ agent: h.parent, signal: sig() });
  let careB: any = null;
  try {
    careA.start();
    await h.tools.get("graph_claim_supervisor").execute({}, exec());
    const { childId } = await startRunningChild(h, "g612 runtime recreate", "G612-RECREATE");
    careA.armForRoot(h.root);
    await waitFor(() => (careA.statusFor(h.root)?.tasks ?? []).some((t: any) => t.child === childId), "task sampled A");
    const tA: any = careA.statusFor(h.root).tasks.find((t: any) => t.child === childId);
    const originalStart = Number(tA.run_started_at);
    assert.ok(originalStart > 0);
    assert.equal(tA.run_start_source, "agent_status");
    assert.equal(tA.run_start_exact, true);

    // 持久化一条 care.* 快照（与真实主管消息同一路径），保证重建时能恢复 open run。
    const msgId = await h.subagents.sendMessage(h.parent, childId, [{ type: "text", text: "G612-RECREATE steer" }], { signal: sig() });
    assert.ok(msgId);
    await waitFor(() => Number(careA.statusFor(h.root)?.tasks?.find((t: any) => t.child === childId)?.budget_base_at) > 0, "message applied");

    // 正常 dispose（非 crash）；child 仍 running，且 fake 时钟前进 2s。
    careA.dispose();
    clockA.advance(1_000);
    const clockB = fakeClock(clockA.now() + 1_000);
    const schedB = fakeScheduler(clockB);
    careB = makeCare(h, clockB, schedB, "g612recB");
    careB.start();
    careB.armForRoot(h.root);
    await waitFor(() => (careB.statusFor(h.root)?.tasks ?? []).some((t: any) => t.child === childId), "task sampled B");
    const stB: any = careB.statusFor(h.root);
    const tB: any = (stB.tasks ?? []).find((t: any) => t.child === childId);
    // 同一 child+attempt+binding 仍 running ⇒ 继续同一轮（同一 run id、同一起点），不拆两轮。
    assert.equal(Number(tB.run_started_at), originalStart, "重建后必须继续同一轮起点（不得另起 unknown 轮）");
    assert.equal(tB.run_start_source, "agent_status");
    const runsB: any[] = (stB.runs ?? []).filter((r: any) => r.child === childId);
    assert.equal(runsB.length, 1, `重建后同一物理 run 只应有一条记录（实得 ${runsB.length}）`);
    assert.equal(runsB[0].stopped_at, null, "child 仍 running ⇒ 不得伪造已停止");
    assert.equal(runsB[0].stop_source, null, "不得伪造 stop source");
    assert.equal(runsB[0].observation_interrupted, true, "停机窗口未观测必须如实标注");
    assert.equal(runsB[0].natural_exact, null, "仍在运行 ⇒ elapsed 尚未可算");
    const gaps: any[] = runsB[0].observation_gaps ?? [];
    assert.equal(gaps.length, 1, "必须有且仅有一条可证观察空窗");
    assert.ok(Number(gaps[0].from) > 0 && Number(gaps[0].to) >= Number(gaps[0].from), "空窗端点必须是可证时刻");
    assert.ok(Number(gaps[0].to) - Number(gaps[0].from) >= 1_000, "空窗必须覆盖真实停机窗口（≥1s）");

    // child 自然停止：公开 agent/status 精确时点收尾，仍是同一条 run。
    h.fake.releaseAll();
    await waitFor(() => h.childLive(childId) !== "running", "child stopped");
    await sleep(200);
    clockB.advance(5_000);
    await careB.sweep();
    await sleep(100);
    const runsEnd: any[] = (careB.statusFor(h.root)?.runs ?? []).filter((r: any) => r.child === childId);
    assert.equal(runsEnd.length, 1, `同一物理 run 停止后仍只应有一条记录（实得 ${runsEnd.length}）`);
    const final = runsEnd[0];
    assert.equal(final.stop_source, "agent_status", "自然 stop 必须来自公开 agent/status");
    assert.ok(Number(final.stopped_at) >= originalStart);
    assert.equal(Number(final.natural_ms), Number(final.stopped_at) - originalStart,
      "elapsed 必须是可证起止的墙钟差（含停机空窗）");
    assert.ok(Number(final.natural_ms) >= Number(gaps[0].to) - Number(gaps[0].from) - 500,
      "elapsed 不得短于可证观察空窗");
    assert.equal(final.natural_exact, false, "跨未观测空窗的 elapsed 不得声称全程精确");
    assert.equal(final.observation_interrupted, true, "停止后仍保留观察中断标记");
  } finally {
    try { careA.dispose(); } catch {}
    try { careB?.dispose(); } catch {}
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch {}
  }
});

test("g-612 对照：全程连续观测的正常 run elapsed 仍精确", async () => {
  const h = await makeRealHost({ relativeRoot: true, projectYaml: PROJECT });
  const clock = fakeClock();
  const sched = fakeScheduler(clock);
  const care = makeCare(h, clock, sched, "g612recC");
  const sig = () => new AbortController().signal;
  const exec = () => ({ agent: h.parent, signal: sig() });
  try {
    care.start();
    await h.tools.get("graph_claim_supervisor").execute({}, exec());
    const { childId } = await startRunningChild(h, "g612 continuous run", "G612-CONTINUOUS");
    care.armForRoot(h.root);
    await waitFor(() => (care.statusFor(h.root)?.tasks ?? []).some((t: any) => t.child === childId), "task sampled");
    const t0: any = care.statusFor(h.root).tasks.find((t: any) => t.child === childId);
    h.fake.releaseAll();
    await waitFor(() => h.childLive(childId) !== "running", "child stopped");
    await sleep(200);
    const runs: any[] = (care.statusFor(h.root)?.runs ?? []).filter((r: any) => r.child === childId);
    assert.equal(runs.length, 1);
    // 连续观测的正常 run：不得被标为中断；精确起止的 elapsed 必须精确。
    assert.notEqual(runs[0].observation_interrupted, true, "连续观测不得误标中断");
    assert.notEqual(runs[0].natural_exact, false, "精确起止的连续 run elapsed 不得标为非精确");
    assert.equal(runs[0].stop_source, "agent_status");
    assert.ok(Number(runs[0].natural_ms) >= 0);
    assert.ok(t0.run_started_at > 0);
  } finally {
    try { care.dispose(); } catch {}
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch {}
  }
});
