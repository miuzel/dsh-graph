/**
 * g-612 att008（reviewer 实测 BLOCK）：正常单用户路径里，关照暂停中 child **自然 idle**
 * （真实 agent/status，无手工改图）会让任务进入 dormant；此时 dormant 必须带走「暂停时冻结的
 * 未有效结论冷却剩余」，group resume 再把它换回 `resume 时刻 + 剩余` 的调整后截止。
 * 之后真实主管 `subagents.sendMessage` 冷唤醒同 child/attempt/bindingVersion：
 * 新消息只重算**预算基准**，实际提醒不得早于 `max(新预算截止, 调整后冷却截止)`；
 * 暂停墙钟（+600s）绝不消耗冷却，也不能在 resume 后重新计满 300s。
 *
 * 覆盖（真实 0.2.1-rc.2 宿主栈 + 生产 createCareRuntime + fake adapter + 假时钟；不联网）：
 *  A 先 resume 再真实消息冷唤醒；B 暂停中先消息再 resume；
 *  C resume 后延迟 60s 才冷唤醒（只剩 230s，不是重新 290s，也不算进暂停的 600s）；
 *  D paused→idle→runtime dispose/recreate→resume+消息（冻结剩余已持久）；
 *  E 暂停**前** child 已 idle（dormant 在未暂停时建立）→ pause→长停→resume→消息；
 *  F 三次 unknown 的 no_response_limit 人工锁跨 idle+pause+resume+冷唤醒保持且绝无第 4 次；
 *  G care.control 事件写失败 ⇒ 不应用状态（仍暂停、不丢冻结剩余）；
 *  H 无暂停无无答 budget 120 不强加 300；budget 600 晚于剩余冷却不被截短。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { appendEvent, readEvents } from "../events.ts";
import { invalidateBoardCache } from "../cache.ts";
import { claimSupervisor, closeWatchers, getCachedBoardPayload, readSupervisorSession } from "../ops.ts";
import { createCareRuntime } from "../../dist/index.js";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(cond: () => T | null | Promise<T | null>, label: string, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await cond();
    if (v) return v as T;
    await sleep(10);
  }
  throw new Error(`等待超时：${label}`);
}
function fakeClock(start = Date.now()) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } };
}
function fakeScheduler(clock: any) {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => any }>();
  const setTimeoutFn = (fn: () => any, ms: number) => {
    const id = ++seq;
    timers.set(id, { at: clock.now() + Math.max(0, Number(ms) || 0), fn });
    return id;
  };
  const clearTimeoutFn = (id: number) => { timers.delete(id); };
  const advanceTo = async (target: number) => {
    for (let guard = 0; guard < 6000; guard += 1) {
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

const projectYaml = (threshold: number, recheck: number) =>
  `supervisor:\n  care: "false"\n  care_threshold_seconds: ${threshold}\n  care_recheck_seconds: ${recheck}\n`;
const cfgFor = (threshold: number, recheck: number) =>
  ({ supervisor: { care: true, care_threshold_seconds: threshold, care_recheck_seconds: recheck } });
const GLOBAL = () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: true, raw: "on" });

function makeCare(
  h: any,
  clock: any,
  scheduler: any,
  opts: { idPrefix: string; threshold: number; recheck: number; appendEventFn?: (root: string, ev: any) => any },
) {
  let seq = 0;
  return createCareRuntime({
    ctx: {
      on: (name: string, fn: any) => h.ctx.on(name, fn),
      get: (name: string) => (name === "agents" ? h.reg : name === "llm" ? h.llm : undefined),
    },
    readGlobal: GLOBAL,
    resolveRoot: (ws: string) => join(ws, ".dsh-graph"),
    defaultWorkspace: () => h.ws,
    readProjectConfigFn: () => cfgFor(opts.threshold, opts.recheck),
    readSupervisorSessionFn: (root: string) => readSupervisorSession(root),
    readBoardPayload: (root: string) => { try { return getCachedBoardPayload(root, { lazy: true })?.payload ?? null; } catch { return null; } },
    now: clock.now,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
    appendEventFn: opts.appendEventFn ?? ((root: string, ev: any) => appendEvent(root, ev)),
    makeInspectionId: () => `${opts.idPrefix}-${++seq}`,
    log: () => {},
  });
}

async function setup(opts: {
  title?: string;
  marker?: string;
  threshold?: number;
  recheck?: number;
  idPrefix?: string;
  fake?: any;
  appendEventFn?: (root: string, ev: any) => any;
} = {}) {
  const threshold = opts.threshold ?? 30;
  const recheck = opts.recheck ?? 3600;
  const h = await makeRealHost({ relativeRoot: true, projectYaml: projectYaml(threshold, recheck), sessionQuery: true });
  claimSupervisor(h.root, h.parent.id, `test:att008:${opts.idPrefix ?? "care"}`);
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const care = makeCare(h, clock, scheduler, {
    idPrefix: opts.idPrefix ?? "g612-idle",
    threshold,
    recheck,
    appendEventFn: opts.appendEventFn,
  });
  const sig = () => new AbortController().signal;
  care.start();
  const goal = await makeGoal(h, opts.title ?? "g612 idle cold resume");
  invalidateBoardCache(h.root);
  const marker = opts.marker ?? "G612-IDLE-CHILD";
  h.fake.hold(marker);
  const d: any = await h.dispatch(goal, marker, { worktree: false });
  const childId = String(d.child_id ?? "");
  const attempt = String(d.attempt ?? "att-001");
  assert.ok(childId, "real child dispatched");
  await waitFor(() => (h.childLive(childId) === "running" ? true : null), "fake child running");
  care.armForRoot(h.root);
  const status = () => care.statusFor(h.root);
  const task = () => (status()?.tasks ?? []).find((t: any) => t.child === childId) ?? null;
  await waitFor(() => (task() ? true : null), "care task sampled");
  const inspections = () => readEvents(h.root).filter((e: any) => e.event === "care.inspection");
  const careEvents = (name: string) => readEvents(h.root).filter((e: any) => e.event === name);
  const lastCareState = (name: string) => careEvents(name).at(-1)?.details?.care_state ?? null;
  const shutdown = async () => {
    try { care.dispose(); } catch { /* disposed */ }
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch { /* disposed */ }
  };
  const sendColdResume = async (label: string) => {
    h.fake.hold(label);
    const msgAt = clock.now();
    const msgId = await h.subagents.sendMessage(h.parent, childId, [{ type: "text", text: label }], { signal: sig() });
    assert.ok(msgId, "real subagents.sendMessage accepted");
    await waitFor(() => (h.childLive(childId) === "running" ? true : null), "child cold-resumed running");
    await waitFor(() => (task() ? true : null), "task sampled after cold resume");
    assert.equal(String(task()?.child), childId, "same child resumed");
    assert.equal(String(task()?.attempt), attempt, "same attempt resumed (no new dispatch)");
    return { msgAt, msgId };
  };
  return {
    h, clock, scheduler, care, goal, childId, attempt, status, task, inspections,
    careEvents, lastCareState, sendColdResume, shutdown,
  };
}
type S = Awaited<ReturnType<typeof setup>>;

/** t30 真实首次关照 → 真实 unknown（remindersSent=1，冷却起点已证）。 */
async function firstCareUnknown(s: S) {
  const due = Number(s.status()?.next_due_at);
  assert.ok(Number.isFinite(due), "finite first due");
  await s.scheduler.advanceTo(due + 1000);
  await waitFor(() => (s.inspections().length >= 1 ? true : null), "first care delivered");
  await waitFor(() => (s.h.parent.status === "idle" ? true : null), "supervisor idle after care");
  const inspection = String((s.inspections().at(-1) as any)?.details?.inspection ?? "");
  const out: any = s.care.submitOutcome({
    root: s.h.root, supervisor: s.h.parent.id, inspection, goal: s.goal, attempt: s.attempt, child: s.childId,
    outcome: "unknown", evidence: "g612 att008 idle cold resume: real unknown after first care",
  });
  assert.equal(out.ok, true, `unknown accepted: ${JSON.stringify(out)}`);
  const lastCare = Number(s.task()?.last_care_at);
  assert.ok(Number.isFinite(lastCare), "lastCare recorded");
  assert.equal(Number(s.task()?.reminders_sent), 1, "remindersSent=1 (cooldown active)");
  return { lastCare, inspection };
}

/** 暂停（在 lastCare+10s）→ child 自然 idle → 暂停墙钟 +600s；返回冻结冷却剩余。 */
async function pauseThenIdleThenPausedWallClock(s: S, lastCare: number) {
  await s.scheduler.advanceTo(lastCare + 10_000);
  const pauseAt = s.clock.now();
  assert.equal(s.care.control(s.h.root, "pause").ok, true, "pause ok");
  const pausedTask: any = s.task();
  assert.equal(pausedTask?.budget_due_at, null, "paused absolute budget deadline intentionally unknown");
  assert.equal(pausedTask?.cooldown_due_at, null, "paused absolute cooldown deadline intentionally unknown");
  const cooldownRemain = Math.max(0, lastCare + 300_000 - pauseAt);
  assert.ok(cooldownRemain >= 289_000 && cooldownRemain <= 291_000, `frozen cooldown≈290s (got ${cooldownRemain})`);
  s.h.fake.releaseAll();
  await waitFor(() => (s.h.childLive(s.childId) !== "running" ? true : null), "child natural idle");
  await sleep(100);
  await s.scheduler.advanceTo(pauseAt + 600_000);
  const resumeAt = s.clock.now();
  assert.equal(s.status()?.paused, true, "still paused after idle wall clock");
  assert.equal((s.status()?.tasks ?? []).some((t: any) => t.child === s.childId), false,
    "idle child is not a schedulable task while paused (dormant only)");
  return { pauseAt, resumeAt, cooldownRemain };
}

async function assertFrozenCooldownPreserved(s: S, label: string, anchorAt: number, cooldownRemain: number, frozenDeadline: number) {
  const t: any = s.task();
  const st: any = s.status();
  assert.ok(Number.isFinite(Number(st?.next_due_at)), `${label}: next_due must be finite`);
  assert.ok(Number(st.next_due_at) >= frozenDeadline - 1_000,
    `${label}: next_due must not precede preserved frozen cooldown (expected >= ${frozenDeadline}, got ${st.next_due_at})`);
  assert.ok(Number(st.next_due_at) <= frozenDeadline + 1_000,
    `${label}: next_due must be the true executable deadline (expected ~${frozenDeadline}, got ${st.next_due_at})`);
  assert.equal(Number(t?.reminders_sent), 1, `${label}: no-response counter preserved`);
  assert.equal(t?.human_locked, false, `${label}: no fabricated human lock`);
  assert.equal(s.status()?.paused, false, `${label}: not paused`);
  // 相对消息时刻仍应是「resume 后仅剩的有效自然时间」，不是重新计满 300s。
  assert.ok(Number(st.next_due_at) - anchorAt <= cooldownRemain + 1_000,
    `${label}: must not restart a full 300s after the message (offset=${Number(st.next_due_at) - anchorAt}ms, remain=${cooldownRemain}ms)`);

  const before = s.inspections().length;
  await s.scheduler.advanceTo(frozenDeadline - 1_000);
  assert.equal(s.inspections().length, before,
    `${label}: no extra inspection before frozen cooldown deadline (deliveries=${s.inspections().length - before})`);
  await s.scheduler.advanceTo(frozenDeadline + 1_000);
  assert.equal(s.inspections().length, before + 1, `${label}: exactly one inspection after frozen cooldown deadline`);
}

test("g612 att008 A：pause→child自然idle→+600s→resume→真实消息冷唤醒同 binding 保留冻结290s冷却；dormant不参与调度", async () => {
  const s = await setup({ marker: "G612-IDLE-A", idPrefix: "g612A" });
  try {
    const { lastCare } = await firstCareUnknown(s);
    const { resumeAt, cooldownRemain } = await pauseThenIdleThenPausedWallClock(s, lastCare);
    // 暂停中 dormant 不显示假倒计时、不在暂停墙钟里自动投递
    const pausedInspections = s.inspections().length;
    await s.scheduler.advanceTo(resumeAt + 3_600_000);
    assert.equal(s.inspections().length, pausedInspections, "paused dormant must not auto-deliver or consume paused wall clock");
    assert.equal(s.status()?.paused, true, "still paused");
    const resumeNow = s.clock.now();
    assert.equal(s.care.control(s.h.root, "resume").ok, true, "resume ok (task is dormant)");
    assert.equal(s.status()?.paused, false, "resumed");
    // 事件先行：resume 的 care.control 快照携带调整后的 dormant 冷却截止 = resume 时刻 + 冻结剩余
    const resumeState = s.lastCareState("care.control");
    const dormant = (resumeState?.dormant ?? []).find((d: any) => d.child === s.childId) ?? null;
    assert.ok(dormant, "resume care.control snapshot carries dormant entry");
    assert.equal(Number(dormant.cooldownDueAt), resumeNow + cooldownRemain, "dormant adjusted cooldown deadline is resume+frozen");
    assert.equal(dormant.frozenCooldownRemainingMs, null, "frozen remainder consumed into adjusted deadline");

    const { msgAt } = await s.sendColdResume("G612-IDLE-A-RESUME");
    const frozenDeadline = resumeNow + cooldownRemain;
    await assertFrozenCooldownPreserved(s, "IDLE-A", msgAt, cooldownRemain, frozenDeadline);
  } finally {
    await s.shutdown();
  }
});

test("g612 att008 B：暂停中先真实消息冷唤醒再 resume 同 binding 结果相同；暂停期间不投递", async () => {
  const s = await setup({ marker: "G612-IDLE-B", idPrefix: "g612B" });
  try {
    const { lastCare } = await firstCareUnknown(s);
    const { resumeAt, cooldownRemain } = await pauseThenIdleThenPausedWallClock(s, lastCare);
    await s.sendColdResume("G612-IDLE-B-RESUME");
    assert.equal(s.status()?.paused, true, "message while paused keeps group paused (no auto resume)");
    const frozen = Number(s.task()?.dueInMs);
    assert.ok(frozen >= 289_000 && frozen <= 291_000, `paused frozen remainder after message ≈290s (got ${frozen})`);
    const beforeResume = s.inspections().length;
    await s.scheduler.advanceTo(resumeAt + 600_000);
    assert.equal(s.inspections().length, beforeResume, "no inspection while paused even after message cold wake");
    const resumeNow = s.clock.now();
    assert.equal(s.care.control(s.h.root, "resume").ok, true, "resume ok after message");
    // B 的关照基准是暂停中的真实消息时点，但冷却从 resume 时刻接续（暂停墙钟不消耗）。
    await assertFrozenCooldownPreserved(s, "IDLE-B", resumeNow, cooldownRemain, resumeNow + cooldownRemain);
  } finally {
    await s.shutdown();
  }
});

test("g612 att008 C：resume 后延迟 60s 才冷唤醒 ⇒ 只剩 290−60=230s，不重计满、不算进暂停600s", async () => {
  const s = await setup({ marker: "G612-IDLE-C", idPrefix: "g612C" });
  try {
    const { lastCare } = await firstCareUnknown(s);
    const { resumeAt, cooldownRemain } = await pauseThenIdleThenPausedWallClock(s, lastCare);
    assert.equal(s.care.control(s.h.root, "resume").ok, true, "resume ok");
    await s.scheduler.advanceTo(resumeAt + 60_000);
    const { msgAt } = await s.sendColdResume("G612-IDLE-C-RESUME");
    assert.ok(msgAt >= resumeAt + 59_000, "message really sent 60s of natural time after resume");
    const frozenDeadline = resumeAt + cooldownRemain;
    assert.ok(frozenDeadline - msgAt >= 229_000 && frozenDeadline - msgAt <= 231_000,
      `only 230s of the frozen cooldown remain at message time (got ${frozenDeadline - msgAt}ms)`);
    await assertFrozenCooldownPreserved(s, "IDLE-C", msgAt, cooldownRemain - 60_000, frozenDeadline);
  } finally {
    await s.shutdown();
  }
});

test("g612 att008 D：paused→idle→runtime dispose/recreate 后 resume+消息仍从持久冻结剩余接续", async () => {
  const s = await setup({ marker: "G612-IDLE-D", idPrefix: "g612D" });
  let careB: any = null;
  try {
    const { lastCare } = await firstCareUnknown(s);
    const { resumeAt, cooldownRemain } = await pauseThenIdleThenPausedWallClock(s, lastCare);
    // 持久化快照里 dormant 必须已带冻结剩余与全部计数（run metadata 快照为真源）
    const idleState = s.lastCareState("care.run");
    const dormant = (idleState?.dormant ?? []).find((d: any) => d.child === s.childId) ?? null;
    assert.ok(dormant, "idle→dormant is persisted in care.run snapshot");
    assert.ok(Number(dormant.frozenCooldownRemainingMs) >= 289_000 && Number(dormant.frozenCooldownRemainingMs) <= 291_000,
      "persisted dormant keeps pause-frozen cooldown remainder");
    assert.equal(Number(dormant.remindersSent), 1, "persisted dormant keeps remindersSent");
    assert.equal(dormant.awaitingReply, false, "persisted dormant keeps awaitingReply");
    assert.equal(dormant.humanLocked, false, "persisted dormant keeps humanLocked");

    s.care.dispose();
    careB = makeCare(s.h, s.clock, s.scheduler, { idPrefix: "g612D-r", threshold: 30, recheck: 3600 });
    careB.start();
    careB.armForRoot(s.h.root);
    const statusB = () => careB.statusFor(s.h.root);
    assert.equal(statusB()?.paused, true, "recreated runtime restores paused group from events");
    assert.equal((statusB()?.tasks ?? []).some((t: any) => t.child === s.childId), false, "dormant stays out of scheduling");
    const resumeNow = s.clock.now();
    assert.equal(careB.control(s.h.root, "resume").ok, true, "resume ok after recreate");
    s.h.fake.hold("G612-IDLE-D-RESUME");
    const msgAt = s.clock.now();
    await s.h.subagents.sendMessage(s.h.parent, s.childId, [{ type: "text", text: "G612-IDLE-D-RESUME" }], { signal: new AbortController().signal });
    await waitFor(() => (s.h.childLive(s.childId) === "running" ? true : null), "child cold-resumed running after recreate");
    const taskB = () => (statusB()?.tasks ?? []).find((t: any) => t.child === s.childId) ?? null;
    await waitFor(() => (taskB() ? true : null), "task sampled after recreate cold resume");
    const frozenDeadline = resumeNow + cooldownRemain;
    const st: any = statusB();
    assert.ok(Number(st?.next_due_at) >= frozenDeadline - 1_000 && Number(st?.next_due_at) <= frozenDeadline + 1_000,
      `recreated runtime keeps frozen cooldown (expected ~${frozenDeadline}, got ${st?.next_due_at})`);
    assert.equal(Number(taskB()?.reminders_sent), 1, "reminders preserved after recreate");
    const before = s.inspections().length;
    await s.scheduler.advanceTo(frozenDeadline - 1_000);
    assert.equal(s.inspections().length, before, "no delivery before frozen deadline after recreate");
    await s.scheduler.advanceTo(frozenDeadline + 1_000);
    assert.equal(s.inspections().length, before + 1, "exactly one delivery at frozen deadline after recreate");
    assert.ok(msgAt >= resumeNow, "message time is real");
  } finally {
    try { careB?.dispose?.(); } catch { /* disposed */ }
    await s.shutdown();
  }
});

test("g612 att008 E：暂停前 child 已 idle（dormant 在未暂停时建立）→pause→长停→resume→消息仍保留冷却", async () => {
  const s = await setup({ marker: "G612-IDLE-E", idPrefix: "g612E" });
  try {
    const { lastCare } = await firstCareUnknown(s);
    // child 在**暂停之前**自然 idle（真实 agent/status；不手工改图）
    s.h.fake.releaseAll();
    await waitFor(() => (s.h.childLive(s.childId) !== "running" ? true : null), "child idle before pause");
    await sleep(100);
    // 让 runtime 把已关闭任务对账进 dormant（未暂停：只有绝对冷却截止，无冻结分量）
    s.status();
    await s.scheduler.advanceTo(lastCare + 10_000);
    const pauseAt = s.clock.now();
    assert.equal(s.care.control(s.h.root, "pause").ok, true, "pause ok after task already idle");
    const pauseState = s.lastCareState("care.control");
    const dormant = (pauseState?.dormant ?? []).find((d: any) => d.child === s.childId) ?? null;
    assert.ok(dormant, "pause care.control snapshot carries idle dormant entry");
    assert.ok(Number(dormant.frozenCooldownRemainingMs) >= 289_000 && Number(dormant.frozenCooldownRemainingMs) <= 291_000,
      "pause folds the pre-existing dormant cooldown into frozen remainder");
    const cooldownRemain = Number(dormant.frozenCooldownRemainingMs);
    const pausedInspections = s.inspections().length;
    await s.scheduler.advanceTo(pauseAt + 600_000);
    assert.equal(s.inspections().length, pausedInspections, "paused wall clock does not consume cooldown / no delivery");
    const resumeNow = s.clock.now();
    assert.equal(s.care.control(s.h.root, "resume").ok, true, "resume ok");
    const { msgAt } = await s.sendColdResume("G612-IDLE-E-RESUME");
    await assertFrozenCooldownPreserved(s, "IDLE-E", msgAt, cooldownRemain - (msgAt - resumeNow), resumeNow + cooldownRemain);
  } finally {
    await s.shutdown();
  }
});

test("g612 att008 F：三次 unknown 的 no_response_limit 人工锁跨 idle+pause+resume+冷唤醒保持，绝无第 4 次", async () => {
  const s = await setup({ marker: "G612-IDLE-F", idPrefix: "g612F", recheck: 30 });
  try {
    const { lastCare } = await firstCareUnknown(s);
    // 第 2、3 次真实巡检（间隔=max(复查30s, 未答冷却300s)=300s），全部 unknown
    for (let round = 2; round <= 3; round += 1) {
      const nextDue = Number(s.status()?.next_due_at);
      await s.scheduler.advanceTo(nextDue + 1000);
      await waitFor(() => (s.inspections().length >= round ? true : null), `care inspection #${round}`);
      await waitFor(() => (s.h.parent.status === "idle" ? true : null), `supervisor idle after care #${round}`);
      const inspection = String((s.inspections().at(-1) as any)?.details?.inspection ?? "");
      const out: any = s.care.submitOutcome({
        root: s.h.root, supervisor: s.h.parent.id, inspection, goal: s.goal, attempt: s.attempt, child: s.childId,
        outcome: "unknown", evidence: `g612 att008 F: real unknown round ${round}`,
      });
      assert.equal(out.ok, true, `unknown #${round} accepted`);
    }
    const lockedTask: any = s.task();
    assert.equal(lockedTask?.human_locked, true, "3 consecutive unanswered reminders lock for human");
    assert.equal(lockedTask?.human_reason, "no_response_limit");
    assert.equal(Number(lockedTask?.reminders_sent), 3);
    // 自然 idle → dormant 保留全部锁/计数
    s.h.fake.releaseAll();
    await waitFor(() => (s.h.childLive(s.childId) !== "running" ? true : null), "child natural idle (locked task)");
    await sleep(100);
    await s.scheduler.advanceTo(lastCare + 300_000 + 600_000);
    const idleState = s.lastCareState("care.run");
    const dormant = (idleState?.dormant ?? []).find((d: any) => d.child === s.childId) ?? null;
    if (dormant) {
      assert.equal(dormant.humanLocked, true, "dormant keeps human lock");
      assert.equal(dormant.humanReason, "no_response_limit", "dormant keeps human reason");
      assert.equal(Number(dormant.remindersSent), 3, "dormant keeps remindersSent");
      assert.equal(dormant.awaitingReply, false, "dormant keeps awaitingReply");
    }
    // 暂停 → 暂停墙钟 → resume → 真实冷唤醒：锁仍 sticky，绝不第 4 次
    const pauseNow = s.clock.now();
    assert.equal(s.care.control(s.h.root, "pause").ok, true, "pause ok with locked dormant");
    await s.scheduler.advanceTo(pauseNow + 600_000);
    assert.equal(s.care.control(s.h.root, "resume").ok, true, "resume ok with locked dormant");
    const before = s.inspections().length;
    assert.equal(before, 3, "still exactly three inspections before cold wake");
    s.h.fake.hold("G612-IDLE-F-RESUME");
    await s.h.subagents.sendMessage(s.h.parent, s.childId, [{ type: "text", text: "G612-IDLE-F-RESUME" }], { signal: new AbortController().signal });
    await waitFor(() => (s.h.childLive(s.childId) === "running" ? true : null), "locked child cold-resumed");
    await waitFor(() => (s.task() ? true : null), "locked task sampled after cold resume");
    assert.equal(s.task()?.human_locked, true, "cold resume must not clear the human lock");
    assert.equal(s.task()?.human_reason, "no_response_limit", "cold resume must not clear human reason");
    assert.equal(Number(s.task()?.reminders_sent), 3, "cold resume must not reset unanswered counter");
    await s.scheduler.advanceTo(s.clock.now() + 3_600_000);
    assert.equal(s.inspections().length, before, "locked task must never produce a 4th inspection");
  } finally {
    await s.shutdown();
  }
});

test("g612 att008 G：care.control 事件写失败 ⇒ 不应用 resume（仍暂停、冻结剩余不丢）", async () => {
  let failControl = false;
  const s = await setup({
    marker: "G612-IDLE-G",
    idPrefix: "g612G",
    appendEventFn: (root: string, ev: any) => {
      if (failControl && ev?.event === "care.control") throw new Error("simulated care.control write failure");
      return appendEvent(root, ev);
    },
  });
  try {
    const { lastCare } = await firstCareUnknown(s);
    const { resumeAt, cooldownRemain } = await pauseThenIdleThenPausedWallClock(s, lastCare);
    failControl = true;
    const failed: any = s.care.control(s.h.root, "resume");
    assert.equal(failed.ok, false, "resume must fail when care.control cannot be persisted");
    assert.equal(failed.code, "event_append_failed");
    assert.equal(s.status()?.paused, true, "memory state not applied before event commit (still paused)");
    failControl = false;
    await s.scheduler.advanceTo(resumeAt + 1_000_000); // 失败后继续暂停 1000s：冻结剩余不得被吃掉
    const resumeNow = s.clock.now();
    assert.equal(s.care.control(s.h.root, "resume").ok, true, "resume ok on retry");
    const { msgAt } = await s.sendColdResume("G612-IDLE-G-RESUME");
    // 若失败那次曾把冻结剩余换成 resumeAt+290，本次 retry 就会沿用早已过期的 deadline（提前投递）。
    await assertFrozenCooldownPreserved(s, "IDLE-G", msgAt, cooldownRemain, resumeNow + cooldownRemain);
  } finally {
    await s.shutdown();
  }
});

test("g612 att008 H：无暂停无无答 budget120 不强加300；budget600 晚于剩余冷却不被截短", async () => {
  const s120 = await setup({ marker: "G612-IDLE-H120", idPrefix: "g612H120", threshold: 120, recheck: 120 });
  try {
    const t: any = s120.task();
    const started = Number(t.started_at);
    const due = Number(s120.status()?.next_due_at);
    assert.ok(Number.isFinite(due) && Number.isFinite(started));
    assert.ok(due - started >= 119_000 && due - started <= 121_000,
      `budget 120 must not be forced to 300s (got offset ${due - started}ms)`);
    const before = s120.inspections().length;
    await s120.scheduler.advanceTo(due - 1_000);
    assert.equal(s120.inspections().length, before, "no inspection before budget 120 deadline");
    await s120.scheduler.advanceTo(due + 1_000);
    assert.equal(s120.inspections().length, before + 1, "exactly one at budget 120 deadline");
  } finally {
    await s120.shutdown();
  }

  const s = await setup({ marker: "G612-IDLE-H600", idPrefix: "g612H600" });
  try {
    const { lastCare } = await firstCareUnknown(s);
    const exec = () => ({ agent: s.h.parent, signal: new AbortController().signal });
    await s.h.tools.get("graph_set_goal_budget").execute({ goal: s.goal, budget_seconds: 600 }, exec());
    const due = Number(s.status()?.next_due_at);
    const base = Number(s.task()?.run_started_at ?? s.task()?.started_at);
    assert.ok(Number.isFinite(due));
    // 600s 预算 > 剩余约 300s 冷却 ⇒ 不被冷却截短
    assert.ok(due - lastCare >= 569_000 && due - lastCare <= 571_000,
      `budget 600 must stay later than remaining cooldown (due-lastCare=${due - lastCare}ms)`);
    assert.ok(due - base <= 601_000, "budget 600 applied from the message/dispatch base (~600s)");
    const before = s.inspections().length;
    await s.scheduler.advanceTo(due - 1_000);
    assert.equal(s.inspections().length, before, "no inspection before budget 600 deadline");
    await s.scheduler.advanceTo(due + 1_000);
    assert.equal(s.inspections().length, before + 1, "exactly one at budget 600 deadline");
  } finally {
    await s.shutdown();
  }
});
