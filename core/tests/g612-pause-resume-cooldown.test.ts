/**
 * g-612 返工（reviewer 实测 BLOCK ③）：**暂停冻结的未有效结论冷却**在 resume 后不能被
 * `lastCareAt+300s` 的旧绝对时刻吃掉；此后 goal 预算编辑 / 真实主管消息只重算**预算目标**，
 * 实际可执行截止始终是 `max(预算目标, 暂停调整后的冷却截止)`，`care/status.next_due_at`
 * 与调度器消费同一个最终时刻。
 *
 * reviewer 原 probe 的边界 `advanceTo(min(nextDue, frozenDeadline)+2000)` 在
 * `nextDue === frozenDeadline`（修复后的正确显示）时会越过截止再断言 0，与随后“到点恰一次”
 * 自相矛盾；本文件保留同一语义但把边界改为 **截止前 1s = 0 / 到截止后 1s = 1**，
 * 并显式断言 `next_due_at >= frozenDeadline`。原 probe 与 e900 首红日志见 tmp/rev-att005。
 *
 * 真实 0.2.1-rc.2 宿主栈 + 生产 createCareRuntime + fake adapter + 假时钟；不联网/真实 provider。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { appendEvent, readEvents } from "../events.ts";
import { invalidateBoardCache } from "../cache.ts";
import { closeWatchers, getCachedBoardPayload, readSupervisorSession } from "../ops.ts";
import { createCareRuntime } from "../../dist/index.js";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await cond()) return; await sleep(10); }
  throw new Error(`等待超时：${label}`);
}
function fakeClock(start = Date.now()) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } };
}
function fakeScheduler(clock: ReturnType<typeof fakeClock>) {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => any }>();
  const setTimeoutFn = (fn: () => any, ms: number) => {
    const id = ++seq;
    timers.set(id, { at: clock.now() + Math.max(0, Number(ms) || 0), fn });
    return id;
  };
  const clearTimeoutFn = (id: number) => { timers.delete(id); };
  const advanceTo = async (target: number) => {
    for (let guard = 0; guard < 3000; guard += 1) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (!due.length) break;
      const [id, v] = due[0];
      timers.delete(id);
      clock.set(v.at);
      await v.fn();
      if (clock.now() > target) clock.set(target);
    }
    clock.set(target);
    await new Promise((r) => setImmediate(r));
  };
  return { setTimeoutFn, clearTimeoutFn, advanceTo, timers };
}

const PROJECT = "supervisor:\n  care: \"false\"\n  care_threshold_seconds: 300\n  care_recheck_seconds: 300\n";

function makeCare(h: any, clock: any, scheduler: any, idPrefix: string) {
  let seq = 0;
  return createCareRuntime({
    ctx: {
      on: (name: string, fn: any) => h.ctx.on(name, fn),
      get: (name: string) => (name === "agents" ? h.reg : name === "subagents" ? h.subagents : name === "llm" ? h.llm : undefined),
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

async function setup(budgetSeconds: number) {
  const h = await makeRealHost({ relativeRoot: true, projectYaml: PROJECT });
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const care = makeCare(h, clock, scheduler, "g612cd");
  const sig = () => new AbortController().signal;
  const exec = () => ({ agent: h.parent, signal: sig() });
  const tool = (name: string) => h.tools.get(name);
  let goal = "";
  let childId = "";
  care.start();
  await tool("graph_claim_supervisor").execute({}, exec());
  goal = await makeGoal(h, "g612 pause resume cooldown");
  await tool("graph_set_goal_budget").execute({ goal, budget_seconds: budgetSeconds }, exec());
  invalidateBoardCache(h.root);
  h.fake.hold("G612-CD-CHILD");
  const d: any = await h.dispatch(goal, "G612-CD-CHILD", { worktree: false });
  childId = String(d.child_id ?? "");
  await waitFor(() => h.childLive(childId) === "running", "child running");
  care.armForRoot(h.root);
  await waitFor(() => (care.statusFor(h.root)?.tasks ?? []).some((t: any) => t.child === childId), "task sampled");
  const status = () => care.statusFor(h.root);
  const task = () => (status()?.tasks ?? []).find((t: any) => t.child === childId) ?? null;
  const inspections = () => readEvents(h.root).filter((e: any) => e.event === "care.inspection");
  const findByChild = () => (status()?.pending_inspections ?? []).find((i: any) =>
    ["queued", "delivered", "claimed"].includes(String(i.status))
    && (i.targets ?? []).some((x: any) => x.child === childId)) ?? null;
  const shutdown = async () => {
    care.dispose();
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch {}
  };
  return { h, clock, scheduler, care, goal, childId, exec, tool, status, task, inspections, findByChild, shutdown };
}

/** 共同前缀：t30 首次真实关照，然后真实 unknown（reminders=1、lastCare 已证）。 */
async function firstCareUnknown(s: Awaited<ReturnType<typeof setup>>) {
  const firstDue = Number(s.status()?.next_due_at);
  await s.scheduler.advanceTo(firstDue + 1000);
  await waitFor(() => s.inspections().length >= 1, "first care delivered");
  await waitFor(() => s.h.parent.status === "idle", "supervisor idle after first care", 5000);
  const inspEv: any = s.inspections().at(-1);
  const inspId = String(inspEv?.details?.inspection ?? "");
  assert.ok(inspId, "care.inspection 事件必须携带 id");
  const out: any = s.care.submitOutcome({
    root: s.h.root, supervisor: s.h.parent.id, inspection: inspId, goal: s.goal, child: s.childId,
    attempt: String(inspEv?.details?.targets?.[0]?.attempt ?? "att-001"),
    outcome: "unknown", evidence: "g612 冷却：首次关照无有效结论",
  });
  assert.equal(out.ok, true, `unknown 必须被受理：${JSON.stringify(out)}`);
  const t = s.task();
  assert.equal(t.reminders_sent, 1);
  assert.equal(t.human_locked, false);
  return { lastCare: Number(t.last_care_at) };
}

/** 暂停在 lastCare+10s ⇒ 冻结剩余≈290s；长暂停 600s 后 resume。 */
async function pauseLongResume(s: Awaited<ReturnType<typeof setup>>) {
  const { lastCare } = await firstCareUnknown(s);
  await s.scheduler.advanceTo(lastCare + 10_000);
  const pauseAt = s.clock.now();
  assert.equal(s.care.control(s.h.root, "pause").ok, true);
  const frozen = Number(s.task().dueInMs);
  assert.ok(frozen >= 288_000 && frozen <= 291_000, `暂停冻结实际剩余≈290s（实得 ${frozen}）`);
  const before = s.inspections().length;
  await s.scheduler.advanceTo(pauseAt + 600_000);
  assert.equal(Number(s.task().dueInMs), frozen, "暂停墙钟不得消耗冻结剩余");
  assert.equal(s.inspections().length, before, "暂停 600s 不得投递");
  const resumeAt = s.clock.now();
  assert.equal(s.care.control(s.h.root, "resume").ok, true);
  const afterResume = Number(s.task().dueInMs);
  assert.ok(afterResume >= 288_000 && afterResume <= 291_000, `resume 保留冻结剩余（实得 ${afterResume}）`);
  return { lastCare, pauseAt, resumeAt, afterResume, frozen, before };
}

/** 实际投递边界：截止前 1s 必须 0 次；到截止后 1s 恰好 1 次（不是原 probe 的 +2000 越界断言）。 */
async function assertNoEarlyAndExactlyOnce(s: Awaited<ReturnType<typeof setup>>, args: {
  resumeAt: number; afterResume: number; nextDue: number; label: string;
}) {
  const frozenDeadline = args.resumeAt + args.afterResume;
  assert.ok(args.nextDue >= frozenDeadline,
    `${args.label}：next_due_at 必须是最终可执行截止（>= 冻结截止 ${frozenDeadline}，实得 ${args.nextDue}）`);
  const before = s.inspections().length;
  await s.scheduler.advanceTo(frozenDeadline - 1_000);
  assert.equal(s.inspections().length, before,
    `${args.label}：冻结冷却截止前 1s 不得投递（next_due_at=${args.nextDue}）`);
  await s.scheduler.advanceTo(frozenDeadline + 1_000);
  assert.equal(s.inspections().length, before + 1, `${args.label}：冻结冷却到点后恰好投递一次`);
}

test("g-612 暂停冷却①：长暂停后 goal 预算编辑不得让冻结冷却提前失效（预算目标更早也不提前发）", async () => {
  const s = await setup(30);
  try {
    const { resumeAt, afterResume, frozen } = await pauseLongResume(s);
    const set: any = await s.tool("graph_set_goal_budget").execute({ goal: s.goal, budget_seconds: 60 }, s.exec());
    assert.equal(set.new_seconds, 60);
    // 独立 fake-clock runtime 才是被驱动的那个；镜像生产包装的公开 runtime 调用。
    s.care.notifyGoalBudgetChanged(s.h.root, s.goal, 60);
    await sleep(20);
    const t: any = s.task();
    const nextDue = Number(s.status()?.next_due_at);
    const budgetDue = Number(t.budget_due_at);
    const cooldownDue = Number(t.cooldown_due_at);
    assert.ok(budgetDue < resumeAt + afterResume, "预算目标（new base+60）确实早于冻结冷却");
    assert.ok(cooldownDue >= resumeAt + afterResume - 1_000,
      `冷却截止必须保留暂停剩余（实得 ${cooldownDue - resumeAt}ms）`);
    assert.equal(nextDue, Math.max(budgetDue, cooldownDue), "next_due_at 必须=两者较晚者");
    await assertNoEarlyAndExactlyOnce(s, { resumeAt, afterResume, nextDue, label: "预算编辑" });
    assert.ok(frozen > 0);
  } finally { await s.shutdown(); }
});

test("g-612 暂停冷却②：长暂停后真实主管 sendMessage 同样不得提前发（消息只重算预算基准）", async () => {
  const s = await setup(30);
  try {
    const { resumeAt, afterResume } = await pauseLongResume(s);
    await s.scheduler.advanceTo(resumeAt + 10_000);
    const msgAt = s.clock.now();
    const msgId = await s.h.subagents.sendMessage(s.h.parent, s.childId, [{ type: "text", text: "G612 post-resume steer" }], { signal: s.exec().signal });
    assert.ok(msgId);
    await waitFor(() => Number(s.task()?.budget_base_at) >= msgAt - 1, "message budget base applied");
    const t: any = s.task();
    const nextDue = Number(s.status()?.next_due_at);
    const budgetDue = Number(t.budget_due_at);
    const cooldownDue = Number(t.cooldown_due_at);
    assert.ok(budgetDue < resumeAt + afterResume, "消息后的预算目标确实早于冻结冷却");
    assert.ok(cooldownDue >= resumeAt + afterResume - 1_000, "冷却截止必须保留暂停剩余");
    assert.equal(nextDue, Math.max(budgetDue, cooldownDue), "next_due_at 必须=两者较晚者");
    await assertNoEarlyAndExactlyOnce(s, { resumeAt, afterResume, nextDue, label: "主管消息" });
  } finally { await s.shutdown(); }
});

test("g-612 暂停冷却③：无暂停/无未答 ⇒ 不得一律强加 300s", async () => {
  const s = await setup(120);
  try {
    const t0: any = s.task();
    assert.equal(t0.reminders_sent, 0);
    assert.equal(t0.cooldown_due_at, null);
    const base = Number(t0.budget_base_at);
    const due = Number(s.status()?.next_due_at);
    assert.ok(Math.abs(due - (base + 120_000)) <= 2_000, `无冷却时 actual=base+120（实得 ${due}）`);
    const before = s.inspections().length;
    await s.scheduler.advanceTo(due - 1_000);
    assert.equal(s.inspections().length, before, "预算到点前不得投递");
    await s.scheduler.advanceTo(due + 1_000);
    assert.equal(s.inspections().length, before + 1, "预算到点恰好一次");
  } finally { await s.shutdown(); }
});

test("g-612 暂停冷却④：暂停冻结跨 runtime 正常重建与二次 pause/resume 均不丢失", async () => {
  const s = await setup(30);
  let care2: any = null;
  try {
    const { lastCare } = await firstCareUnknown(s);
    await s.scheduler.advanceTo(lastCare + 10_000);
    assert.equal(s.care.control(s.h.root, "pause").ok, true);
    const frozen = Number(s.task().dueInMs);
    assert.ok(frozen >= 288_000 && frozen <= 291_000);
    await s.scheduler.advanceTo(s.clock.now() + 600_000);

    // 正常 dispose/recreate 关照 runtime（不是 crash）：paused + 冻结剩余必须从事件真源恢复。
    s.care.dispose();
    const clock2 = fakeClock(s.clock.now());
    const sched2 = fakeScheduler(clock2);
    care2 = makeCare(s.h, clock2, sched2, "g612cd2");
    care2.start();
    care2.armForRoot(s.h.root);
    const status2 = () => care2.statusFor(s.h.root);
    const task2 = () => (status2()?.tasks ?? []).find((t: any) => t.child === s.childId) ?? null;
    await waitFor(() => task2() !== null, "task restored after runtime recreate");
    assert.equal(status2().paused, true, "runtime 重建后仍是暂停");
    assert.equal(Number(task2().dueInMs), frozen, "runtime 重建后冻结剩余不丢");

    // 首次 resume：从冻结剩余接续；冷却调整后截止必须落在 resume+剩余。
    const resumeAt = clock2.now();
    assert.equal(care2.control(s.h.root, "resume").ok, true);
    const afterResume = Number(task2().dueInMs);
    assert.ok(afterResume >= 288_000 && afterResume <= 291_000);
    assert.ok(Number(task2().cooldown_due_at) >= resumeAt + afterResume - 1_000,
      "resume 后 cooldown_due_at 必须保留暂停剩余");

    // 二次 pause/resume：冻结 100s 后恢复，冷却剩余仍按新 now 续上。
    const pause2 = clock2.now();
    assert.equal(care2.control(s.h.root, "pause").ok, true);
    const frozen2 = Number(task2().dueInMs);
    assert.ok(frozen2 >= afterResume - 1_000, "二次暂停按当前剩余冻结");
    await sched2.advanceTo(pause2 + 100_000);
    assert.equal(Number(task2().dueInMs), frozen2, "二次暂停墙钟不消耗");
    const resume2At = clock2.now();
    assert.equal(care2.control(s.h.root, "resume").ok, true);
    const afterResume2 = Number(task2().dueInMs);
    assert.equal(afterResume2, frozen2, "二次 resume 按冻结剩余接续");
    assert.ok(Number(task2().cooldown_due_at) >= resume2At + frozen2 - 1_000,
      "二次 resume 后冷却调整截止不丢");

    // resume 后编辑 goal 预算 60：预算目标更早，但实际截止仍取调整后冷却。
    await toolSet(s, care2, 60);
    const nextDue = Number(status2().next_due_at);
    assert.ok(nextDue >= resume2At + frozen2 - 1_000,
      `二次 resume+预算编辑后 next_due_at 必须不早于冻结冷却（实得 ${nextDue - resume2At}ms）`);
    assert.equal(nextDue, Math.max(Number(task2().budget_due_at), Number(task2().cooldown_due_at)));
  } finally {
    try { care2?.dispose?.(); } catch {}
    await s.shutdown();
  }
});

async function toolSet(s: Awaited<ReturnType<typeof setup>>, runtime: any, seconds: number) {
  const out: any = await s.tool("graph_set_goal_budget").execute({ goal: s.goal, budget_seconds: seconds }, s.exec());
  runtime.notifyGoalBudgetChanged(s.h.root, s.goal, seconds);
  return out;
}
