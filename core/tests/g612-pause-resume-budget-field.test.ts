/**
 * 公开状态投影字段语义（att-006 返工）：`budget_due_at` 只报**可证**的独立预算目标。
 *
 * 来源：att-005 独立 review 的只读 probe（`probe-pause-resume-early.test.ts`，原文件与旧红日志
 * 保留在 att-005 私有 tmp，未修改）。原 C4/C5 要求「resume 后必须返回纯预算值」——负责人已裁定
 * 改为**简化显示**：暂停/恢复后 `scheduleDueAt` 被 `max(预算剩余, 冷却剩余)` 合并、纯预算分量
 * 不可还原时，公开字段返回 `null`/未知，绝不返回混合值冒充预算；`effective_budget_seconds`、
 * `cooldown_due_at`（可证时）、`next_due_at` 和真实投递必须保持精准。因此本文件把 C4/C5 的
 * 期望改为 null 语义（保留原 ±1s 投递边界），并新增 C6/C7 正向对照（可分离时仍返回真值，
 * 不得一律 null）与 C8（暂停中正常重建 runtime 仍如实 null）。C1/C2/C3 与 reviewer 原断言一致。
 *
 * 真实 0.2.1-rc.2 宿主栈 + 生产 createCareRuntime + fake adapter + 假时钟；不联网/真实 provider。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { appendEvent, readEvents } from "../events.ts";
import { invalidateBoardCache } from "../cache.ts";
import { closeWatchers, getCachedBoardPayload, readSupervisorSession, setGoalBudget } from "../ops.ts";
import { createCareRuntime } from "../../dist/index.js";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(cond: () => Promise<T | null> | T | null, label: string, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const v = await cond(); if (v) return v as T; await sleep(10); }
  throw new Error(`等待超时：${label}`);
}
function fakeClock(start = Date.now()) { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } }; }
function fakeScheduler(clock: any) {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => any }>();
  const setTimeoutFn = (fn: () => any, ms: number) => { const id = ++seq; timers.set(id, { at: clock.now() + Math.max(0, Number(ms) || 0), fn }); return id; };
  const clearTimeoutFn = (id: number) => { timers.delete(id); };
  const advanceTo = async (target: number) => {
    for (let guard = 0; guard < 5000; guard += 1) {
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

async function setup(budgetSeconds: number) {
  const h = await makeRealHost({ relativeRoot: true, projectYaml: PROJECT });
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  let seq = 0;
  const care = createCareRuntime({
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
    makeInspectionId: () => `revpre-${++seq}`,
    log: () => {},
  });
  const sig = () => new AbortController().signal;
  const exec = () => ({ agent: h.parent, signal: sig() });
  const tool = (name: string) => h.tools.get(name);
  care.start();
  await tool("graph_claim_supervisor").execute({}, exec());
  const goal = await makeGoal(h, "review pause-resume early");
  setGoalBudget(h.root, goal, { budget_seconds: budgetSeconds, actor: "human:gui" });
  invalidateBoardCache(h.root);
  h.fake.hold("REVPRE-CHILD");
  const d: any = await h.dispatch(goal, "REVPRE-CHILD", { worktree: false });
  const childId = String(d.child_id ?? "");
  const attempt = String(d.attempt ?? "att-001");
  await waitFor(() => (h.childLive(childId) === "running" ? true : null), "child running");
  care.armForRoot(h.root);
  await waitFor(() => (care.statusFor(h.root)?.tasks ?? []).some((t: any) => t.child === childId), "task sampled");
  const status = () => care.statusFor(h.root);
  const task = () => (status()?.tasks ?? []).find((t: any) => t.child === childId) ?? null;
  const inspections = () => readEvents(h.root).filter((e: any) => e.event === "care.inspection");
  const shutdown = async () => { care.dispose(); h.fake.releaseAll(); closeWatchers(); try { await h.shutdown(); } catch {} };
  return { h, clock, scheduler, care, goal, childId, attempt, exec, tool, status, task, inspections, shutdown };
}

async function firstCareUnknown(s: Awaited<ReturnType<typeof setup>>) {
  const firstDue = Number(s.status()?.next_due_at);
  await s.scheduler.advanceTo(firstDue + 1000);
  await waitFor(() => (s.inspections().length >= 1 ? true : null), "first care delivered");
  await waitFor(() => (s.h.parent.status === "idle" ? true : null), "supervisor idle after first care");
  const inspEv: any = s.inspections().at(-1);
  const inspId = String(inspEv?.details?.inspection ?? "");
  assert.ok(inspId);
  const out: any = s.care.submitOutcome({
    root: s.h.root, supervisor: s.h.parent.id, inspection: inspId, goal: s.goal, attempt: s.attempt, child: s.childId,
    outcome: "unknown", evidence: "REVIEW unknown at first care (no valid conclusion)",
  });
  assert.equal(out.ok, true, `unknown accepted: ${JSON.stringify(out)}`);
  const t = s.task();
  assert.equal(t.reminders_sent, 1);
  assert.equal(t.human_locked, false);
  return { lastCare: Number(t.last_care_at) };
}

test("REVIEW-C1: 长暂停（两轮 pause/resume）后 goal 预算编辑：next_due_at 不得早于冻结冷却剩余", async () => {
  const s = await setup(30);
  try {
    const { lastCare } = await firstCareUnknown(s);
    await s.scheduler.advanceTo(lastCare + 10_000);
    assert.equal(s.care.control(s.h.root, "pause").ok, true);
    const frozen = Number(s.task().dueInMs);
    assert.ok(frozen >= 288_000 && frozen <= 291_000, `暂停冻结≈290s (got ${frozen})`);
    const pauseAt = s.clock.now();
    await s.scheduler.advanceTo(pauseAt + 600_000);
    assert.equal(Number(s.task().dueInMs), frozen, "暂停墙钟不得消耗关照倒计时");
    assert.equal(s.care.control(s.h.root, "resume").ok, true);
    assert.ok(Number(s.task().dueInMs) >= 288_000, "resume 保留冻结剩余");
    // 第二次 pause/resume（多次暂停不得丢剩余）
    const r1 = s.clock.now();
    await s.scheduler.advanceTo(r1 + 5_000);
    assert.equal(s.care.control(s.h.root, "pause").ok, true);
    const frozen2 = Number(s.task().dueInMs);
    assert.ok(frozen2 >= 283_000 && frozen2 <= 286_000, `第二次暂停冻结≈285s (got ${frozen2})`);
    await s.scheduler.advanceTo(s.clock.now() + 60_000);
    assert.equal(s.care.control(s.h.root, "resume").ok, true);
    const resumeAt = s.clock.now();
    const afterResume = Number(s.task().dueInMs);
    assert.ok(afterResume >= 283_000 && afterResume <= 286_000, `第二次 resume 保留冻结剩余 (got ${afterResume})`);

    const set: any = await s.tool("graph_set_goal_budget").execute({ goal: s.goal, budget_seconds: 60 }, s.exec());
    assert.equal(set.new_seconds, 60);
    s.care.notifyGoalBudgetChanged(s.h.root, s.goal, 60);
    await sleep(20);
    const st: any = s.status();
    const t: any = s.task();
    const budgetDue = Number(t.budget_due_at);
    const cooldownDue = Number(t.cooldown_due_at);
    const nextDue = Number(st.next_due_at);
    const frozenDeadline = resumeAt + afterResume;
    console.log(`[C1] resumeAt=${resumeAt} afterResume=${afterResume} budget_due=${budgetDue} cooldown_due=${cooldownDue} next_due=${nextDue} frozenDeadline=${frozenDeadline}`);
    assert.ok(Math.abs(budgetDue - (resumeAt + 45_000)) <= 3_000, `budget_due 应是纯预算目标 base+60s≈resumeAt+45s (got ${budgetDue - resumeAt})`);
    assert.ok(cooldownDue >= frozenDeadline - 1_000, `cooldown_due 必须是 resume 后恢复的冻结冷却≈resumeAt+285s (got ${cooldownDue - resumeAt})`);
    assert.equal(nextDue, Math.max(budgetDue, cooldownDue), "next_due_at 必须是预算与冷却的较晚者");
    assert.ok(nextDue >= frozenDeadline - 1_000, `next_due_at 不得早于冻结冷却剩余（早 ${(frozenDeadline - nextDue) / 1000}s）`);

    const before = s.inspections().length;
    await s.scheduler.advanceTo(frozenDeadline - 1_000);
    assert.equal(s.inspections().length, before, "冻结冷却截止前 1s 不得投递");
    await s.scheduler.advanceTo(frozenDeadline + 1_000);
    assert.equal(s.inspections().length, before + 1, "冻结冷却截止后 1s 应恰好投递一次");
  } finally { await s.shutdown(); }
});

test("REVIEW-C2: 长暂停后真实主管 sendMessage：不得退回已过去的绝对 lastCare+300 提前发", async () => {
  const s = await setup(30);
  try {
    const { lastCare } = await firstCareUnknown(s);
    await s.scheduler.advanceTo(lastCare + 10_000);
    const pauseAt = s.clock.now();
    assert.equal(s.care.control(s.h.root, "pause").ok, true);
    const frozen = Number(s.task().dueInMs);
    assert.ok(frozen >= 288_000 && frozen <= 291_000, `pause freeze≈290s (got ${frozen})`);
    await s.scheduler.advanceTo(pauseAt + 600_000);
    assert.equal(Number(s.task().dueInMs), frozen);
    assert.equal(s.care.control(s.h.root, "resume").ok, true);
    const resumeAt = s.clock.now();
    const afterResume = Number(s.task().dueInMs);
    assert.ok(afterResume >= 288_000, "resume 保留冻结剩余");

    await s.scheduler.advanceTo(resumeAt + 10_000);
    const msgAt = s.clock.now();
    const msgId = await s.h.subagents.sendMessage(s.h.parent, s.childId, [{ type: "text", text: "REVPRE post-resume steer" }], { signal: s.exec().signal });
    assert.ok(msgId);
    await waitFor(() => (Number(s.task()?.budget_base_at) >= msgAt - 1 ? true : null), "message budget base applied");
    const st: any = s.status();
    const t: any = s.task();
    const budgetDue = Number(t.budget_due_at);
    const cooldownDue = Number(t.cooldown_due_at);
    const nextDue = Number(st.next_due_at);
    const frozenDeadline = resumeAt + afterResume;
    console.log(`[C2] msgAt=${msgAt} budget_due=${budgetDue} cooldown_due=${cooldownDue} next_due=${nextDue} frozenDeadline=${frozenDeadline}`);
    assert.equal(Number(t.budget_base_at), msgAt, "主管新消息必须建立新的预算基准");
    assert.ok(Math.abs(budgetDue - (msgAt + 30_000)) <= 3_000, `budget_due≈消息基准+30s (got ${budgetDue - msgAt})`);
    assert.ok(cooldownDue >= frozenDeadline - 1_000, "消息不得用旧绝对时刻吃掉冻结冷却");
    assert.equal(nextDue, Math.max(budgetDue, cooldownDue));
    assert.ok(nextDue >= frozenDeadline - 1_000, `next_due_at 不得早于冻结冷却剩余（早 ${(frozenDeadline - nextDue) / 1000}s）`);

    const before = s.inspections().length;
    await s.scheduler.advanceTo(frozenDeadline - 1_000);
    assert.equal(s.inspections().length, before, "冻结冷却截止前 1s 不得投递");
    await s.scheduler.advanceTo(frozenDeadline + 1_000);
    assert.equal(s.inspections().length, before + 1, "冻结冷却截止后 1s 应恰好投递一次");
  } finally { await s.shutdown(); }
});

test("REVIEW-C3: 对照——无 pause / 无未答 ⇒ 不得一律强加 300s", async () => {
  const s = await setup(120);
  try {
    const t0: any = s.task();
    assert.equal(t0.reminders_sent, 0);
    assert.equal(t0.cooldown_due_at, null);
    const base = Number(t0.budget_base_at);
    const due = Number(s.status()?.next_due_at);
    console.log(`[C3] base=${base} next_due=${due} budget_due=${t0.budget_due_at} cooldown=${t0.cooldown_due_at}`);
    assert.ok(Math.abs(due - (base + 120_000)) <= 2_000, `无冷却时 actual=base+120 (got ${due})`);
    const before = s.inspections().length;
    await s.scheduler.advanceTo(due - 1_000);
    assert.equal(s.inspections().length, before, "不得提前投递");
    await s.scheduler.advanceTo(due + 1_000);
    assert.equal(s.inspections().length, before + 1, "预算到点恰好一次");
  } finally { await s.shutdown(); }
});

/**
 * 本次返工（负责人选择「简化显示」）：`budget_due_at` 是**公开投影**字段，只报**可证**的
 * 独立预算目标。暂停冻结 / 暂停恢复后被 `max(预算剩余, 冷却剩余)` 合并的锚点 ⇒ 纯预算分量
 * 不可还原 ⇒ `null`（未知），绝不把合并后的实际截止冒充预算；而 `effective_budget_seconds`、
 * `cooldown_due_at`（可证时）、`next_due_at` 与真实投递必须保持精准。
 * 可分离的正向场景（无暂停 / 无未答 / 恢复后预算分量更晚 / 暂停后新消息重算）仍返回真值。
 */

test("REVIEW-C4：resume 后不可分离 ⇒ budget_due_at=null（未知），next_due_at/冷却/预算时长仍精准", async () => {
  const s = await setup(30);
  try {
    const { lastCare } = await firstCareUnknown(s);
    await s.scheduler.advanceTo(lastCare + 10_000);
    assert.equal(s.care.control(s.h.root, "pause").ok, true);
    const frozen = Number(s.task().dueInMs);
    assert.ok(frozen >= 288_000 && frozen <= 291_000, `暂停冻结≈290s（实得 ${frozen}）`);
    // 暂停中：没有可证的未来预算/冷却绝对时刻（真值是冻结剩余），不得伪造未来时间。
    const pt: any = s.task();
    const pst: any = s.status();
    assert.equal(pst.paused, true);
    assert.equal(pt.budget_due_at, null, "暂停中不得伪造未来预算截止");
    assert.equal(pt.cooldown_due_at, null, "暂停中不得伪造未来冷却截止");
    assert.equal(pst.next_due_at, null, "暂停中不得显示会触发的倒计时");
    assert.equal(Number(pt.dueInMs), frozen, "暂停中真值仍是冻结剩余");

    await s.scheduler.advanceTo(s.clock.now() + 600_000);
    const resumeAt = s.clock.now();
    assert.equal(s.care.control(s.h.root, "resume").ok, true);
    const t: any = s.task();
    const st: any = s.status();
    const cooldownDue = Number(t.cooldown_due_at);
    const nextDue = Number(st.next_due_at);
    const frozenDeadline = resumeAt + frozen;
    console.log(`[C4] resumeAt=${resumeAt} frozen=${frozen} base=${t.budget_base_at} eff=${t.effective_budget_seconds} countdown=${t.budget_countdown} budget_due=${t.budget_due_at} cooldown_due=${cooldownDue} next_due=${nextDue}`);
    assert.equal(t.budget_due_at, null,
      "resume 锚点=now+max(预算剩余,冷却剩余) ⇒ 纯预算目标不可证 ⇒ 必须 null，不得返回合并值冒充预算");
    assert.equal(Number(t.effective_budget_seconds), 30, "预算时长仍必须可见");
    assert.ok(Math.abs(cooldownDue - frozenDeadline) <= 1_000, `cooldown_due 必须是 resume 后恢复的冻结冷却≈${frozenDeadline}（实得 ${cooldownDue}）`);
    assert.equal(nextDue, cooldownDue, "next_due_at 必须仍=真实可执行截止（不因预算未知而变 null）");
    const before = s.inspections().length;
    await s.scheduler.advanceTo(frozenDeadline - 1_000);
    assert.equal(s.inspections().length, before, "最终截止前 1s 不得投递");
    await s.scheduler.advanceTo(frozenDeadline + 1_000);
    assert.equal(s.inspections().length, before + 1, "最终截止后 1s 恰好投递一次");
  } finally { await s.shutdown(); }
});

test("REVIEW-C5：暂停中主管消息后 resume 同语义 ⇒ budget_due_at=null，预算时长/冷却/实际截止精准", async () => {
  const s = await setup(30);
  try {
    const { lastCare } = await firstCareUnknown(s);
    await s.scheduler.advanceTo(lastCare + 10_000);
    assert.equal(s.care.control(s.h.root, "pause").ok, true);
    const msgId = await s.h.subagents.sendMessage(s.h.parent, s.childId, [{ type: "text", text: "C5 paused steer" }], { signal: s.exec().signal });
    assert.ok(msgId);
    await waitFor(() => (Number(s.task()?.budget_base_at) > 0 ? true : null), "message applied while paused");
    const pt: any = s.task();
    assert.equal(pt.budget_due_at, null, "暂停中（即使刚有主管消息）不得伪造未来预算截止");
    assert.equal(pt.cooldown_due_at, null, "暂停中不得伪造未来冷却截止");
    assert.equal(Number(pt.effective_budget_seconds), 30, "预算时长可见");
    await s.scheduler.advanceTo(s.clock.now() + 600_000);
    const resumeAt = s.clock.now();
    assert.equal(s.care.control(s.h.root, "resume").ok, true);
    const t: any = s.task();
    const st: any = s.status();
    const cooldownDue = Number(t.cooldown_due_at);
    const nextDue = Number(st.next_due_at);
    console.log(`[C5] resumeAt=${resumeAt} base=${t.budget_base_at} eff=${t.effective_budget_seconds} countdown=${t.budget_countdown} budget_due=${t.budget_due_at} cooldown_due=${cooldownDue} next_due=${nextDue}`);
    assert.equal(t.budget_countdown, true, "消息后应处于预算倒计时");
    assert.equal(t.budget_due_at, null, "暂停中消息 + resume 的合并锚点同样不可分离 ⇒ null");
    assert.equal(Number(t.effective_budget_seconds), 30, "预算时长仍必须可见");
    assert.ok(cooldownDue >= resumeAt + 288_000, `cooldown_due 仍保留暂停冻结剩余（实得 ${cooldownDue - resumeAt}ms）`);
    assert.equal(nextDue, Math.max(Number(t.budget_due_at ?? 0), cooldownDue), "next_due_at = 预算(未知按0)与冷却的较晚者");
    assert.ok(nextDue >= resumeAt + 288_000, "next_due_at 不得早于冻结冷却");
    const before = s.inspections().length;
    await s.scheduler.advanceTo(nextDue - 1_000);
    assert.equal(s.inspections().length, before, "最终截止前 1s 不得投递");
    await s.scheduler.advanceTo(nextDue + 1_000);
    assert.equal(s.inspections().length, before + 1, "最终截止后 1s 恰好投递一次");
  } finally { await s.shutdown(); }
});

test("REVIEW-C6（正向对照）：无暂停但处于冷却的新消息 ⇒ 预算目标真实可证，不得一律 null", async () => {
  const s = await setup(30);
  try {
    const { lastCare } = await firstCareUnknown(s);
    await s.scheduler.advanceTo(lastCare + 10_000);
    const msgAt = s.clock.now();
    const msgId = await s.h.subagents.sendMessage(s.h.parent, s.childId, [{ type: "text", text: "C6 steer no pause" }], { signal: s.exec().signal });
    assert.ok(msgId);
    await waitFor(() => (Number(s.task()?.budget_base_at) >= msgAt - 1 ? true : null), "message base applied");
    const t: any = s.task();
    const st: any = s.status();
    const budgetDue = Number(t.budget_due_at);
    const cooldownDue = Number(t.cooldown_due_at);
    console.log(`[C6] msgAt=${msgAt} budget_due=${budgetDue} cooldown_due=${cooldownDue} next_due=${st.next_due_at}`);
    assert.ok(Math.abs(budgetDue - (msgAt + 30_000)) <= 2_000, `纯预算目标可证：base+30s（实得 ${budgetDue - msgAt}ms）`);
    assert.ok(cooldownDue >= lastCare + 299_000 - 1_000, "冷却仍是 lastCare+300s");
    assert.equal(Number(st.next_due_at), Math.max(budgetDue, cooldownDue), "next_due_at 取较晚者");
    const before = s.inspections().length;
    await s.scheduler.advanceTo(Number(st.next_due_at) - 1_000);
    assert.equal(s.inspections().length, before, "截止前 1s 不得投递（预算更早也不提前）");
    await s.scheduler.advanceTo(Number(st.next_due_at) + 1_000);
    assert.equal(s.inspections().length, before + 1, "截止后 1s 恰好投递一次");
  } finally { await s.shutdown(); }
});

test("REVIEW-C7（保守未知）：恢复后预算分量更晚 ⇒ budget_due_at=null，但 next_due/投递仍按预算", async () => {
  const s = await setup(600);
  try {
    const { lastCare } = await firstCareUnknown(s);
    await s.scheduler.advanceTo(lastCare + 10_000);
    const msgAt = s.clock.now();
    const msgId = await s.h.subagents.sendMessage(s.h.parent, s.childId, [{ type: "text", text: "C7 long budget" }], { signal: s.exec().signal });
    assert.ok(msgId);
    await waitFor(() => (Number(s.task()?.budget_base_at) >= msgAt - 1 ? true : null), "message base applied");
    assert.equal(s.care.control(s.h.root, "pause").ok, true);
    const frozen = Number(s.task().dueInMs);
    assert.ok(frozen >= 599_000 && frozen <= 601_000, `冻结≈600s（预算分量更晚，实得 ${frozen}）`);
    await s.scheduler.advanceTo(s.clock.now() + 600_000);
    const resumeAt = s.clock.now();
    assert.equal(s.care.control(s.h.root, "resume").ok, true);
    const t: any = s.task();
    const st: any = s.status();
    const cooldownDue = Number(t.cooldown_due_at);
    const frozenDeadline = resumeAt + frozen;
    console.log(`[C7] resumeAt=${resumeAt} frozen=${frozen} eff=${t.effective_budget_seconds} budget_due=${t.budget_due_at} cooldown_due=${cooldownDue} next_due=${st.next_due_at}`);
    assert.equal(Number(t.effective_budget_seconds), 600, "预算时长=600s 仍必须可见");
    // 「预算分量更晚」的恢复锚点与旧版 resume 的混合锚点在现有状态上不可区分 ⇒ 保守未知。
    assert.equal(t.budget_due_at, null, "预算分量更晚的恢复锚点不可严格证明为纯预算 ⇒ null（不谎报）");
    assert.ok(Number.isFinite(cooldownDue) && cooldownDue < frozenDeadline, "冷却分量仍更早");
    assert.equal(Number(st.next_due_at), frozenDeadline, "next_due_at 仍是较晚者（=冻结后的预算截止）");
    const before = s.inspections().length;
    await s.scheduler.advanceTo(resumeAt + 289_000);
    assert.equal(s.inspections().length, before, "冷却到点不得提前投递（被更晚预算挡住）");
    await s.scheduler.advanceTo(frozenDeadline - 1_000);
    assert.equal(s.inspections().length, before, "预算截止前 1s 不得投递");
    await s.scheduler.advanceTo(frozenDeadline + 1_000);
    assert.equal(s.inspections().length, before + 1, "预算截止后 1s 恰好投递一次");
  } finally { await s.shutdown(); }
});

test("REVIEW-C8：暂停中正常重建 runtime 后仍如实 null；resume 后预算 null、冷却真值；预算编辑后恢复真值", async () => {
  const s = await setup(30);
  let care2: any = null;
  try {
    const { lastCare } = await firstCareUnknown(s);
    await s.scheduler.advanceTo(lastCare + 10_000);
    assert.equal(s.care.control(s.h.root, "pause").ok, true);
    const frozen = Number(s.task().dueInMs);
    await s.scheduler.advanceTo(s.clock.now() + 600_000);
    s.care.dispose();
    const clock2 = fakeClock(s.clock.now());
    const sched2 = fakeScheduler(clock2);
    care2 = makeCare2(s.h, clock2, sched2, "revpre2");
    care2.start();
    care2.armForRoot(s.h.root);
    const status2 = () => care2.statusFor(s.h.root);
    const task2 = () => (status2()?.tasks ?? []).find((t: any) => t.child === s.childId) ?? null;
    await waitFor(() => task2() !== null, "task restored after runtime recreate");
    const p2: any = task2();
    assert.equal(status2().paused, true, "重建后仍暂停");
    assert.equal(Number(p2.dueInMs), frozen, "重建后冻结剩余不丢");
    assert.equal(p2.budget_due_at, null, "重建后暂停中同样不得伪造未来预算截止");
    assert.equal(p2.cooldown_due_at, null, "重建后暂停中同样不得伪造未来冷却截止");
    assert.equal(status2().next_due_at, null, "重建后暂停中无倒计时");

    const resumeAt = clock2.now();
    assert.equal(care2.control(s.h.root, "resume").ok, true);
    const t: any = task2();
    assert.equal(t.budget_due_at, null, "resume 后合并锚点不可分离 ⇒ null");
    assert.ok(Number(t.cooldown_due_at) >= resumeAt + 288_000, "冷却真值仍在（不因重建丢失）");
    assert.equal(Number(status2().next_due_at), Math.max(Number(t.budget_due_at ?? 0), Number(t.cooldown_due_at)));
    const before = s.inspections().length;
    await sched2.advanceTo(resumeAt + 289_000);
    assert.equal(s.inspections().length, before, "最终截止前不得投递");
    await sched2.advanceTo(resumeAt + frozen + 1_000);
    assert.equal(s.inspections().length, before + 1, "最终截止后恰好投递一次");
  } finally {
    try { care2?.dispose?.(); } catch {}
    await s.shutdown();
  }
});

/** C8 用：以新假时钟重建生产 care runtime（与 setup 内部构造等价，仅换时钟/调度器）。 */
function makeCare2(h: any, clock: any, scheduler: any, idPrefix: string) {
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

// ===== 正常 legacy upgrade/HMR 恢复的旧快照（不是手工破坏：字段来自旧版本本身） =====

/** 读取最后一条 `care_state` 快照（事件真源）。 */
function lastCareState(root: string): any {
  const evs = readEvents(root);
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const c = (evs[i] as any)?.details?.care_state;
    if (c && typeof c === "object") return c;
  }
  return null;
}

/**
 * 把**当前真实快照**改写成「g506 旧版升级形状」：删除 086 之后才新增的持久字段
 * `cooldownDueAt` / `frozenCooldownRemainingMs`（旧版本本来就没有这两个字段），
 * 其余字段（lastCareAt / remindersSent / frozenRemainingMs / scheduleDueAt / budgetBaseAt）原样保留。
 */
function toLegacySnapshot(snapshot: any, patch: { task: (t: any) => any; group?: (g: any) => any }): any {
  const tasks = (Array.isArray(snapshot.tasks) ? snapshot.tasks : []).map((t: any) => {
    const { cooldownDueAt, frozenCooldownRemainingMs, ...legacy } = t;
    return patch.task(legacy);
  });
  return {
    ...snapshot,
    version: 1, // CARE_STATE_VERSION（旧版本同为 1）
    tasks,
    group: patch.group ? { ...snapshot.group, ...patch.group(snapshot.group) } : snapshot.group,
    inspections: [],
  };
}

test("REVIEW-C9（legacy upgrade）：旧版未暂停快照（缺 cooldownDueAt）⇒ budget_due_at=null，next_due/投递按旧规则", async () => {
  const s = await setup(30);
  let care2: any = null;
  try {
    const { lastCare } = await firstCareUnknown(s);
    const snap = lastCareState(s.h.root);
    assert.ok(snap && Array.isArray(snap.tasks) && snap.tasks.length > 0, "存在真实 care_state 快照");
    // 旧版 resume 写下的混合锚点（任何旧 resume 都 ≥ lastCare+300）
    const legacyAnchor = lastCare + 500_000;
    const legacy = toLegacySnapshot(snap, {
      task: (t: any) => ({ ...t, scheduleDueAt: legacyAnchor, frozenRemainingMs: null, budgetCountdown: false, budgetBaseAt: lastCare }),
      group: () => ({ paused: false, pausedAt: null, pausedRemainingMs: null, resetAt: null }),
    });
    appendEvent(s.h.root, { actor: "system:care-legacy-fixture", event: "care.resume", details: { care_state: legacy } });
    s.care.dispose();
    const clock2 = fakeClock(s.clock.now());
    const sched2 = fakeScheduler(clock2);
    care2 = makeCare2(s.h, clock2, sched2, "revpreleg1");
    care2.start();
    care2.armForRoot(s.h.root);
    const status2 = () => care2.statusFor(s.h.root);
    const task2 = () => (status2()?.tasks ?? []).find((t: any) => t.child === s.childId) ?? null;
    await waitFor(() => task2() !== null, "legacy task restored");
    const t: any = task2();
    const st: any = status2();
    const cooldownFallback = lastCare + 300_000;
    const expectedNext = Math.max(legacyAnchor, cooldownFallback);
    console.log(`[C9] legacyAnchor=${legacyAnchor} cooldown=${t.cooldown_due_at} budget_due=${t.budget_due_at} next_due=${st.next_due_at}`);
    assert.equal(t.budget_due_at, null, "旧快照锚点可能是旧 resume 的 max ⇒ 纯预算不可证 ⇒ null（不谎报）");
    assert.equal(Number(t.effective_budget_seconds), 30, "预算时长仍必须可见");
    assert.equal(Number(st.next_due_at), expectedNext, "next_due 仍按旧规则 = max(锚点, 回退冷却)，不因显示修复改变");
    const before = s.inspections().length;
    await sched2.advanceTo(expectedNext - 1_000);
    assert.equal(s.inspections().length, before, "旧快照截止前 1s 不得投递");
    await sched2.advanceTo(expectedNext + 1_000);
    assert.equal(s.inspections().length, before + 1, "旧快照截止后 1s 恰好投递一次");
  } finally {
    try { care2?.dispose?.(); } catch {}
    await s.shutdown();
  }
});

test("REVIEW-C10（legacy upgrade）：旧版暂停快照（缺冻结冷却分量）长暂停后 resume ⇒ budget=null，next_due/投递不变", async () => {
  const s = await setup(30);
  let care2: any = null;
  try {
    const { lastCare } = await firstCareUnknown(s);
    await s.scheduler.advanceTo(lastCare + 10_000);
    assert.equal(s.care.control(s.h.root, "pause").ok, true);
    const frozen = Number(s.task().dueInMs);
    assert.ok(frozen >= 288_000 && frozen <= 291_000, `冻结≈290s（实得 ${frozen}）`);
    const snap = lastCareState(s.h.root);
    const pausedAt = s.clock.now();
    const legacy = toLegacySnapshot(snap, {
      task: (t: any) => ({ ...t, frozenRemainingMs: frozen, scheduleDueAt: null }),
      group: () => ({ paused: true, pausedAt, pausedRemainingMs: frozen }),
    });
    appendEvent(s.h.root, { actor: "system:care-legacy-fixture", event: "care.pause", details: { care_state: legacy } });
    await s.scheduler.advanceTo(pausedAt + 600_000);
    s.care.dispose();
    const clock2 = fakeClock(s.clock.now());
    const sched2 = fakeScheduler(clock2);
    care2 = makeCare2(s.h, clock2, sched2, "revpreleg2");
    care2.start();
    care2.armForRoot(s.h.root);
    const status2 = () => care2.statusFor(s.h.root);
    const task2 = () => (status2()?.tasks ?? []).find((t: any) => t.child === s.childId) ?? null;
    await waitFor(() => task2() !== null, "legacy paused task restored");
    const pt: any = task2();
    assert.equal(status2().paused, true, "旧版暂停快照恢复后仍暂停");
    assert.equal(Number(pt.dueInMs), frozen, "旧快照的冻结剩余如实保留（不伪造）");
    assert.equal(pt.budget_due_at, null, "暂停中不得伪造未来预算截止");
    assert.equal(pt.cooldown_due_at, null, "暂停中不得伪造未来冷却截止");

    const resumeAt = clock2.now();
    assert.equal(care2.control(s.h.root, "resume").ok, true);
    const r: any = task2();
    const st: any = status2();
    console.log(`[C10] resumeAt=${resumeAt} frozen=${frozen} budget_due=${r.budget_due_at} cooldown=${r.cooldown_due_at} next_due=${st.next_due_at}`);
    assert.equal(r.budget_due_at, null, "旧版 resume 的 max 锚点不可分离 ⇒ 纯预算 null");
    assert.equal(Number(r.effective_budget_seconds), 30, "预算时长仍可见");
    assert.equal(Number(st.next_due_at), resumeAt + frozen, "next_due 仍是冻结剩余接续（旧规则，未被显示修复拖动）");
    // 旧快照缺 frozen 冷却分量 ⇒ 相对时间规则会补一个等于恢复时刻的回退值；它已不是未来的
    // 冷却截止（历史歧义，no claim）⇒ 公开投影如实返回 null，不写假冷却截止。
    assert.equal(r.cooldown_due_at, null, "旧快照回退补值不是可证的未来冷却截止 ⇒ null");
    const before = s.inspections().length;
    await sched2.advanceTo(resumeAt + frozen - 1_000);
    assert.equal(s.inspections().length, before, "旧快照最终截止前 1s 不得投递");
    await sched2.advanceTo(resumeAt + frozen + 1_000);
    assert.equal(s.inspections().length, before + 1, "旧快照最终截止后 1s 恰好投递一次");
  } finally {
    try { care2?.dispose?.(); } catch {}
    await s.shutdown();
  }
});

test("REVIEW-C11（legacy upgrade）：预算占大头的旧快照（frozen 3600s）resume 后改预算 60 ⇒ next_due 不被拖成 3600", async () => {
  const s = await setup(30);
  let care2: any = null;
  try {
    const { lastCare } = await firstCareUnknown(s);
    await s.scheduler.advanceTo(lastCare + 10_000);
    assert.equal(s.care.control(s.h.root, "pause").ok, true);
    const snap = lastCareState(s.h.root);
    const pausedAt = s.clock.now();
    const frozenSynthetic = 3_600_000; // 旧版 pause 时预算/复查占大头
    const legacy = toLegacySnapshot(snap, {
      task: (t: any) => ({ ...t, frozenRemainingMs: frozenSynthetic, scheduleDueAt: null }),
      group: () => ({ paused: true, pausedAt, pausedRemainingMs: frozenSynthetic }),
    });
    appendEvent(s.h.root, { actor: "system:care-legacy-fixture", event: "care.pause", details: { care_state: legacy } });
    await s.scheduler.advanceTo(pausedAt + 600_000);
    s.care.dispose();
    const clock2 = fakeClock(s.clock.now());
    const sched2 = fakeScheduler(clock2);
    care2 = makeCare2(s.h, clock2, sched2, "revpreleg3");
    care2.start();
    care2.armForRoot(s.h.root);
    const status2 = () => care2.statusFor(s.h.root);
    const task2 = () => (status2()?.tasks ?? []).find((t: any) => t.child === s.childId) ?? null;
    await waitFor(() => task2() !== null, "legacy big-frozen task restored");
    assert.equal(Number(task2().dueInMs), frozenSynthetic, "旧快照 3600s 冻结如实保留");
    const resumeAt = clock2.now();
    assert.equal(care2.control(s.h.root, "resume").ok, true);
    const legacyS = Number(task2().dueAt);
    assert.ok(legacyS >= resumeAt + frozenSynthetic - 1_000, "resume 先按旧规则从 3600s 冻结接续");

    // 显式 goal 预算编辑 60：公开实际 next_due 必须按「base+60 与冷却较晚者」，不得被冻结 3600 拖动。
    const base = Number(task2().budget_base_at);
    const set: any = await s.tool("graph_set_goal_budget").execute({ goal: s.goal, budget_seconds: 60 }, s.exec());
    assert.equal(set.new_seconds, 60);
    care2.notifyGoalBudgetChanged(s.h.root, s.goal, 60);
    await sleep(30);
    const t: any = task2();
    const st: any = status2();
    const expectedBudget = base + 60_000;
    console.log(`[C11] resumeAt=${resumeAt} base=${base} legacyS=${legacyS} budget_due=${t.budget_due_at} cooldown=${t.cooldown_due_at} next_due=${st.next_due_at} expectedBudget=${expectedBudget}`);
    assert.ok(Number(st.next_due_at) <= expectedBudget + 2_000,
      `next_due 必须回到 base+60s 口径（≤${expectedBudget + 2_000}），不得被冻结 3600s 拖成 ${legacyS}`);
    assert.ok(Number(st.next_due_at) < resumeAt + frozenSynthetic - 60_000, "next_due 不得仍是 3600s 冻结");
    // 旧快照的调整后冷却本身不可证（回退补值）⇒ 即使显式编辑已把预算锚点重写为纯 base+60s，
    // 状态仍无法排除「与旧混合来源不可区分」⇒ 公开预算目标保守 null；当前版本状态下编辑后为
    // 数字（C1/g612-d1 覆盖）。真实 next_due 已在上面钉住不被 3600 拖动。
    assert.equal(t.budget_due_at, null, "旧快照下编辑后仍无法严格证明 ⇒ 保守 null（不谎报）");
    assert.equal(Number(s.status()?.next_due_at ?? st.next_due_at), Number(st.next_due_at));
  } finally {
    try { care2?.dispose?.(); } catch {}
    await s.shutdown();
  }
});
