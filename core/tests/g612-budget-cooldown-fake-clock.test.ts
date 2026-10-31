/**
 * g-612（用户后续裁定：保留 300s 无有效结论冷却）：**真实生产 `createCareRuntime`** +
 * 真实 0.2.1-rc.2 宿主栈 + fake adapter + 私有 workspace + **可注入假时钟**（不受系统时钟影响）。
 *
 * 调度真源只有 `careTaskDueAt`：最终可执行截止 = max(预算目标, lastCareAt+300s)；
 * 无未有效结论冷却时不额外强加 300s；预算目标更晚时不被冷却截短。
 * UI/`care/status.next_due_at` 与调度器消费同一个值（无双真源）。
 *
 * 四象限（真实公开 budget setter / subagents.sendMessage / care outcome）：
 *  1. 无前次无效提醒 + budget 120 ⇒ t0+120 到期，无额外 300；
 *  2. t30 unknown（reminders=1）后 budget 30→120、base=t0 ⇒ 预算目标 t120、实际 t330；
 *     t120/129 不发，t330 至多一次；随后三次 unknown 封顶不多发。
 *  3. t30 unknown 后 t40 真实主管消息 + budget 120 ⇒ 预算目标 t160、实际 t330，t329 前不发；
 *  4. t30 unknown 后 budget 600 ⇒ 预算目标 t600 > 冷却 t330 ⇒ 实际 t600（不被截短）；
 *  5. 有效 progress 清 reminders 后，新消息/预算不再被强加 300s；
 *  6. pause 冻结「预算与冷却形成的实际剩余」：暂停中的编辑/消息按暂停起点折算、墙钟不消耗，
 *     resume 从保存剩余接续。
 *
 * 不联网/真实 provider/用户会话；child 全程 fake adapter hold；不手造 care 状态。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { appendEvent, readEvents } from "../events.ts";
import { invalidateBoardCache } from "../cache.ts";
import {
  closeWatchers,
  getCachedBoardPayload,
  readProjectConfig,
  readSupervisorSession,
  setGoalBudget,
} from "../ops.ts";
import { createCareRuntime } from "../../dist/index.js";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean | Promise<boolean>, label: string, timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await cond()) return;
    await sleep(10);
  }
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
    for (let guard = 0; guard < 500; guard += 1) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (!due.length) break;
      const [id, v] = due[0];
      timers.delete(id);
      clock.set(v.at);
      await v.fn();
    }
    clock.set(target);
    await new Promise((r) => setImmediate(r));
  };
  return { setTimeoutFn, clearTimeoutFn, advanceTo, timers };
}

const PROJECT = "supervisor:\n  care: \"false\"\n  care_threshold_seconds: 300\n  care_recheck_seconds: 300\n";

/** 真实宿主 + 生产 createCareRuntime（假时钟）；apply 内真实 timer 因项目 care=false 不参与。 */
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
    // 独立运行时使用 care=true，项目阈值 300（goal 预算覆盖）；apply 内真实 timer 因项目 care=false 惰性。
    readProjectConfigFn: () => ({
      supervisor: { care: true, care_threshold_seconds: 300, care_recheck_seconds: 300 },
    }),
    readSupervisorSessionFn: (root: string) => readSupervisorSession(root),
    readBoardPayload: (root: string) => {
      try { return getCachedBoardPayload(root, { lazy: true })?.payload ?? null; } catch { return null; }
    },
    now: clock.now,
    setTimeoutFn: scheduler.setTimeoutFn,
    clearTimeoutFn: scheduler.clearTimeoutFn,
    appendEventFn: (root: string, ev: any) => appendEvent(root, ev),
    makeInspectionId: () => `cool-${++seq}`,
    log: () => {},
  });
  const sig = () => new AbortController().signal;
  const exec = () => ({ agent: h.parent, signal: sig() });
  const tool = (name: string) => h.tools.get(name);
  let goal = "";
  let childId = "";
  let attempt = "";
  try {
    care.start();
    await tool("graph_claim_supervisor").execute({}, exec());
    assert.equal(readSupervisorSession(h.root), h.parent.id, "真实 claim 生效");
    goal = await makeGoal(h, "g612 cooldown fake clock");
    setGoalBudget(h.root, goal, { budget_seconds: budgetSeconds, actor: "human:gui" });
    invalidateBoardCache(h.root);
    h.fake.hold("COOL-CHILD");
    const d: any = await h.dispatch(goal, "COOL-CHILD care budget", { worktree: false });
    childId = String(d.child_id ?? "");
    attempt = String(d.attempt ?? "att-001");
    assert.ok(childId);
    await waitFor(() => h.childLive(childId) === "running", "child running");
    care.armForRoot(h.root);
    await waitFor(() => (care.statusFor(h.root)?.tasks ?? []).some((t: any) => t.child === childId), "task sampled");
  } catch (e) {
    h.fake.releaseAll();
    try { await h.shutdown(); } catch { /* ignore */ }
    throw e;
  }
  const status = () => care.statusFor(h.root);
  const task = () => (status()?.tasks ?? []).find((t: any) => t.child === childId) ?? null;
  const inspections = () => readEvents(h.root).filter((e: any) => e.event === "care.inspection");
  const submit = (inspection: string, outcome: string, evidence: string) => care.submitOutcome({
    root: h.root, supervisor: h.parent.id, inspection, goal, attempt, child: childId, outcome, evidence,
  });
  const findByChild = () => {
    const st: any = status();
    return (st?.pending_inspections ?? []).find((i: any) =>
      ["queued", "delivered", "claimed"].includes(String(i.status))
      && (i.targets ?? []).some((x: any) => x.child === childId)) ?? null;
  };
  const advanceTo = async (target: number) => {
    await scheduler.advanceTo(target);
    await waitFor(() => h.parent.status !== "running", "supervisor idle after delivery");
  };
  const shutdown = async () => {
    care.dispose();
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch { /* ignore */ }
  };
  return { h, clock, scheduler, care, goal, childId, attempt, status, task, inspections, submit, findByChild, advanceTo, shutdown };
}

test("g-612 冷却四象限①：无前次无效提醒时 budget 120 ⇒ 实际 t0+120，无额外 300", async () => {
  const s = await setup(120);
  try {
    const t = s.task();
    assert.equal(t.reminders_sent, 0);
    assert.equal(t.cooldown_due_at, null, "无冷却时不得凭空给出 300s 冷却");
    const budgetDue = Number(t.budget_due_at);
    assert.ok(Math.abs(budgetDue - (Number(t.started_at) + 120_000)) <= 2_000, "预算目标=base+120");
    assert.equal(Number(t.dueAt), budgetDue, "实际截止=预算目标");
    assert.equal(Number(s.status().next_due_at), budgetDue);
    const before = s.inspections().length;
    await s.advanceTo(budgetDue - 1_000);
    assert.equal(s.inspections().length, before, "未到预算目标不得提前投递");
    await s.advanceTo(budgetDue + 1_000);
    assert.equal(s.inspections().length, before + 1, "到期恰好投递一次");
  } finally { await s.shutdown(); }
});

test("g-612 冷却四象限②：t30 unknown 后 budget 30→120（base=t0）⇒ 预算 t120、实际 t330，t120 不发；三次封顶", async () => {
  const s = await setup(30);
  try {
    const t0 = Number(s.task().budget_base_at);
    const firstDue = Number(s.status().next_due_at);
    assert.ok(Math.abs(firstDue - (t0 + 30_000)) <= 2_000);
    await s.advanceTo(firstDue + 1_000);
    assert.equal(s.inspections().length, 1, "首次关照投递一次");
    const insp = s.findByChild();
    assert.ok(insp, "首发 inspection 可观察");
    const out: any = s.submit(insp.id, "unknown", "冷却象限②：首次 unknown（真实无有效结论）");
    assert.equal(out.ok, true);
    const tAfter = s.task();
    assert.equal(tAfter.reminders_sent, 1);
    assert.equal(tAfter.human_locked, false);
    const lastCare = Number(tAfter.last_care_at);
    assert.ok(Math.abs(Number(tAfter.cooldown_due_at) - (lastCare + 300_000)) <= 1_000);

    // 预算 30→120：预算目标立即重算，但实际截止 = max(t120, t330)=t330。
    setGoalBudget(s.h.root, s.goal, { budget_seconds: 120, actor: "human:gui" });
    invalidateBoardCache(s.h.root);
    s.care.notifyGoalBudgetChanged(s.h.root, s.goal, 120);
    const tEdit = s.task();
    assert.equal(tEdit.budget_seconds, 120);
    assert.equal(tEdit.budget_countdown, true, "预算目标已立即进入倒计时");
    const budgetDue = Number(tEdit.budget_due_at);
    const cooldownDue = Number(tEdit.cooldown_due_at);
    const actual = Number(tEdit.dueAt);
    assert.ok(Math.abs(budgetDue - (t0 + 120_000)) <= 2_000, `预算目标=base+120（实得 ${budgetDue}）`);
    assert.ok(Math.abs(cooldownDue - (lastCare + 300_000)) <= 1_000);
    assert.ok(Math.abs(actual - Math.max(budgetDue, cooldownDue)) <= 1_000, "实际截止=max(预算,冷却)");
    assert.ok(Math.abs(actual - (lastCare + 300_000)) <= 1_000, "实际截止必须是 t330");
    assert.equal(Number(s.status().next_due_at), actual, "status.next_due_at 必须显示实际截止");
    assert.notEqual(Math.abs(actual - budgetDue) <= 1_000, true, "不得把预算目标 t120 伪装成实际截止");

    const before = s.inspections().length;
    await s.advanceTo(budgetDue + 1_000); // t121
    assert.equal(s.inspections().length, before, "t120 预算目标处不得投递（冷却未到）");
    await s.advanceTo(lastCare + 300_000 - 1_000); // t329
    assert.equal(s.inspections().length, before, "t329 仍不得投递");
    await s.advanceTo(lastCare + 300_000 + 1_000); // t331
    assert.equal(s.inspections().length, before + 1, "t330 至多投递一次");
    const insp2 = s.findByChild();
    assert.ok(insp2);
    s.submit(insp2.id, "unknown", "冷却象限②：第二次 unknown");
    assert.equal(s.task().reminders_sent, 2);
    // 第三次提醒后封顶，不再第 4 次（沿用 g506 已验收预算）。
    await s.advanceTo(s.clock.now() + 300_000 - 1_000);
    await s.advanceTo(s.clock.now() + 2_000);
    assert.equal(s.inspections().length, before + 2, "第三次提醒投递一次");
    const insp3 = s.findByChild();
    assert.ok(insp3);
    s.submit(insp3.id, "unknown", "冷却象限②：第三次 unknown");
    await s.advanceTo(s.clock.now() + 300_001);
    const stCap: any = s.status();
    assert.equal(stCap.phase, "awaiting_human", "三次无有效结论后停止自动提醒");
    assert.equal(stCap.next_due_at, null);
    assert.equal(s.inspections().length, before + 2, "封顶后不得第 4 次自动提醒");
    assert.equal(s.task().human_locked, true, "三次无有效结论必须进入人工等待（真实 sticky）");
    assert.equal(s.task().stagnant_rounds, 0, "unknown 绝不伪称 no-progress");
  } finally { await s.shutdown(); }
});

test("g-612 冷却四象限③：t30 unknown 后 t40 主管真实 sendMessage + budget 120 ⇒ 预算 t160、实际 t330", async () => {
  const s = await setup(30);
  try {
    const t0 = Number(s.task().budget_base_at);
    await s.advanceTo(t0 + 30_000 + 1_000);
    assert.equal(s.inspections().length, 1);
    const insp = s.findByChild();
    s.submit(insp.id, "unknown", "冷却象限③：首次 unknown");
    const lastCare = Number(s.task().last_care_at);
    // 到 t40：goal 预算 30→120（预算目标立即重算），随后真实主管→child 新消息（running steer）
    await s.advanceTo(t0 + 40_000);
    setGoalBudget(s.h.root, s.goal, { budget_seconds: 120, actor: "human:gui" });
    invalidateBoardCache(s.h.root);
    s.care.notifyGoalBudgetChanged(s.h.root, s.goal, 120);
    const before = s.inspections().length;
    const msgAt = s.clock.now();
    const msgId = await s.h.subagents.sendMessage(s.h.parent, s.childId, [{ type: "text", text: "COOL message steer" }], { signal: new AbortController().signal });
    assert.ok(msgId);
    await waitFor(() => Number(s.task()?.budget_base_at) >= msgAt - 1, "message budget base applied");
    const tMsg = s.task();
    assert.equal(tMsg.budget_countdown, true, "新消息重设预算倒计时");
    const budgetDue = Number(tMsg.budget_due_at);
    const cooldownDue = Number(tMsg.cooldown_due_at);
    const actual = Number(tMsg.dueAt);
    assert.ok(Math.abs(budgetDue - (msgAt + 120_000)) <= 2_000, `预算目标=messageAt+120（实得 ${budgetDue}）`);
    assert.ok(Math.abs(cooldownDue - (lastCare + 300_000)) <= 1_000);
    assert.ok(Math.abs(actual - Math.max(budgetDue, cooldownDue)) <= 1_000);
    assert.ok(actual > budgetDue + 1_000, "实际截止必须晚于预算目标（冷却优先）");
    assert.equal(Number(s.status().next_due_at), actual);
    await s.advanceTo(budgetDue + 1_000);
    assert.equal(s.inspections().length, before, "t160 预算目标处不得投递");
    await s.advanceTo(lastCare + 300_000 - 1_000);
    assert.equal(s.inspections().length, before, "冷却前不得投递");
    await s.advanceTo(lastCare + 300_000 + 1_000);
    assert.equal(s.inspections().length, before + 1, "冷却到点后投递一次");
  } finally { await s.shutdown(); }
});

test("g-612 冷却四象限④：t30 unknown 后 budget 600 晚于冷却 ⇒ 实际 t600（不被 300 截短）", async () => {
  const s = await setup(30);
  try {
    const t0 = Number(s.task().budget_base_at);
    await s.advanceTo(t0 + 30_000 + 1_000);
    const insp = s.findByChild();
    s.submit(insp.id, "unknown", "冷却象限④：首次 unknown");
    const lastCare = Number(s.task().last_care_at);
    setGoalBudget(s.h.root, s.goal, { budget_seconds: 600, actor: "human:gui" });
    invalidateBoardCache(s.h.root);
    s.care.notifyGoalBudgetChanged(s.h.root, s.goal, 600);
    const t = s.task();
    const cooldownDue = Number(t.cooldown_due_at);
    const actual = Number(t.dueAt);
    // 预算目标（base+600）晚于冷却截止：该状态与旧版 resume 的混合锚点在状态上**不可区分**，
    // 按负责人裁定「不能可靠区分就未知」⇒ 公开 budget_due_at 返回 null，绝不谎报纯预算；
    // 预算时长仍可见，真实 next_due/投递必须完全不受显示修复影响（本测试后半段钉住）。
    assert.equal(t.budget_due_at, null, "晚于冷却的预算目标不可严格证明为纯预算 ⇒ null");
    assert.equal(Number(t.effective_budget_seconds), 600, "预算时长仍必须可见（600s）");
    assert.ok(cooldownDue < actual, "实际截止必须晚于冷却");
    assert.ok(Math.abs(actual - (t0 + 600_000)) <= 1_000, "实际截止必须取更晚预算，不被 300 截短");
    assert.equal(Number(s.status().next_due_at), actual, "next_due_at 仍显示真实可执行截止");
    const before = s.inspections().length;
    await s.advanceTo(cooldownDue + 1_000);
    assert.equal(s.inspections().length, before, "冷却到点但预算未到 ⇒ 不得提前投递");
    await s.advanceTo(actual - 1_000);
    assert.equal(s.inspections().length, before);
    await s.advanceTo(actual + 1_000);
    assert.equal(s.inspections().length, before + 1, "预算到点投递一次");
  } finally { await s.shutdown(); }
});

test("g-612 冷却四象限⑤：有效 progress 清 reminders 后，新消息/预算不被强加 300s", async () => {
  const s = await setup(30);
  try {
    const t0 = Number(s.task().budget_base_at);
    await s.advanceTo(t0 + 30_000 + 1_000);
    const insp = s.findByChild();
    s.submit(insp.id, "unknown", "冷却象限⑤：先 unknown（进入未答预算）");
    assert.equal(s.task().reminders_sent, 1);
    const insp2 = s.findByChild();
    // 同一条 inspection 已 resolved，不能再二次结论；等待下一次提醒后由真实有效 progress 清零。
    await s.advanceTo(Number(s.task().last_care_at) + 300_000 + 1_000);
    const inspNext = s.findByChild();
    assert.ok(inspNext, "冷却后再次提醒");
    const prog: any = s.submit(inspNext.id, "progress", "冷却象限⑤：有真实新增进展（有效结论）");
    assert.equal(prog.ok, true);
    assert.equal(prog.counted, true);
    const t = s.task();
    assert.equal(t.reminders_sent, 0, "有效 progress 必须按既有 g506 规则清零");
    assert.equal(t.awaiting_reply, false);
    assert.equal(t.cooldown_due_at, null, "有效结论后不得再强加 300s 冷却");
    // 新消息 budget 120：不再有冷却，实际截止=预算目标。
    const msgAt = s.clock.now();
    await s.h.subagents.sendMessage(s.h.parent, s.childId, [{ type: "text", text: "COOL after progress" }], { signal: new AbortController().signal });
    await waitFor(() => Number(s.task()?.budget_base_at) >= msgAt - 1, "message applied");
    const t2 = s.task();
    assert.equal(t2.cooldown_due_at, null);
    assert.ok(Math.abs(Number(t2.dueAt) - Number(t2.budget_due_at)) <= 1_000, "无冷却 ⇒ 实际=预算目标");
  } finally { await s.shutdown(); }
});

test("g-612 暂停：预算与冷却形成的实际剩余被冻结，暂停中编辑/消息按暂停起点折算，resume 从剩余接续", async () => {
  const s = await setup(30);
  try {
    const t0 = Number(s.task().budget_base_at);
    // 首次关照 + unknown，进入冷却（lastCare≈t30）
    await s.advanceTo(t0 + 30_000 + 1_000);
    const insp = s.findByChild();
    s.submit(insp.id, "unknown", "暂停：先建立未有效结论冷却");
    const lastCare = Number(s.task().last_care_at);
    // t40 暂停：实际剩余 = lastCare+300 - t40 = 290s
    await s.advanceTo(t0 + 40_000);
    const pauseAt = s.clock.now();
    assert.equal(s.care.control(s.h.root, "pause").ok, true);
    let st: any = s.status();
    assert.equal(st.paused, true);
    const frozen0 = Number(s.task().dueInMs);
    assert.ok(Math.abs(frozen0 - (lastCare + 300_000 - pauseAt)) <= 1_000, `暂停冻结实际剩余≈290s（实得 ${frozen0}）`);
    // 暂停墙钟走 1 小时：冻结剩余绝不消耗
    await s.advanceTo(pauseAt + 3_600_000);
    st = s.status();
    assert.equal(Number(s.task().dueInMs), frozen0, "暂停墙钟不得消耗冷却/预算剩余");
    assert.equal(s.inspections().length, 1, "暂停期间不得投递");
    // 暂停中 edit budget 600：预算剩余按暂停起点折算（t0..pauseAt=40s ⇒ 560s），与冷却剩余取较晚=560s
    setGoalBudget(s.h.root, s.goal, { budget_seconds: 600, actor: "human:gui" });
    invalidateBoardCache(s.h.root);
    s.care.notifyGoalBudgetChanged(s.h.root, s.goal, 600);
    const frozen600 = Number(s.task().dueInMs);
    assert.ok(Math.abs(frozen600 - 560_000) <= 2_000, `暂停中编辑预算按 pause 前已消费折算（实得 ${frozen600}）`);
    await s.advanceTo(s.clock.now() + 3_600_000);
    assert.equal(Number(s.task().dueInMs), frozen600, "编辑后暂停墙钟仍不得消耗");
    // 暂停中真实主管消息 budget 600：冻结完整新预算，墙钟仍不消耗
    const msgWall = s.clock.now();
    await s.h.subagents.sendMessage(s.h.parent, s.childId, [{ type: "text", text: "COOL paused steer" }], { signal: new AbortController().signal });
    await waitFor(() => Number(s.task()?.budget_base_at) >= msgWall - 1, "paused message applied");
    assert.equal(s.task().budget_countdown, true);
    assert.equal(s.status().paused, true, "消息不得解除暂停");
    const frozenMsg = Number(s.task().dueInMs);
    assert.ok(frozenMsg >= 599_000 && frozenMsg <= 600_000, `暂停中消息冻结完整 600s 新预算（实得 ${frozenMsg}）`);
    await s.advanceTo(s.clock.now() + 3_600_000);
    assert.equal(Number(s.task().dueInMs), frozenMsg, "消息后暂停墙钟仍不得消耗");
    // resume：按保存剩余接续；未到剩余前不投递，到点恰好一次
    const resumeAt = s.clock.now();
    assert.equal(s.care.control(s.h.root, "resume").ok, true);
    const afterResume = Number(s.task().dueInMs);
    assert.ok(afterResume >= 599_000 && afterResume <= 600_000, `resume 后剩余≈600s（实得 ${afterResume}）`);
    const before = s.inspections().length;
    await s.advanceTo(resumeAt + afterResume - 1_000);
    assert.equal(s.inspections().length, before, "resume 剩余未到不得投递");
    await s.advanceTo(resumeAt + afterResume + 1_000);
    assert.equal(s.inspections().length, before + 1, "resume 剩余到点投递一次");
  } finally { await s.shutdown(); }
});
