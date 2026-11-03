/**
 * g-612：goal 级预计任务预算（唯一可编辑真源）+ 预算倒计时 + 暂停冻结 + 运行墙钟分离。
 *
 * 边界：纯 core + 私有 tmp；不联网、不访问真实 provider、不写主树。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";

import {
  applyCareDelivery,
  applyCareInspectionOutcome,
  careStatusProjection,
  careTaskBudgetDueAt,
  careTaskDueAt,
  careTaskIntervalMs,
  careCooldownDueAt,
  createCareInspection,
  newCareGroupState,
  pauseCare,
  resumeCare,
  validateCareOutcome,
  type CareTaskState,
} from "../care.ts";
import {
  createGoal,
  findGoalFile,
  goalDetail,
  init,
  setGoalBudget,
  setCriteria,
} from "../ops.ts";
import { readEvents } from "../events.ts";

const TMP = mkdtempSync(join(process.cwd(), "tmp", "g612-core-"));
test.after(() => {
  const real = (() => { try { return realpathSync(TMP); } catch { return null; } })();
  const base = join(process.cwd(), "tmp") + sep;
  if (!real || !real.startsWith(base)) return;
  try { rmSync(real, { recursive: true, force: true }); } catch { /* ignore */ }
});

function rootWithGoal() {
  const ws = join(TMP, `ws-${Math.random().toString(36).slice(2)}`);
  mkdirSync(ws, { recursive: true });
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "g612 budget", version: "v1.0", type: "task", actor: "human:gui" });
  setCriteria(root, goal, ["预算与调度判据"], "human:gui");
  return { root, goal };
}

function task(now: number, over: Partial<CareTaskState> = {}): CareTaskState {
  return {
    child: "child-1",
    attempt: "att-1",
    goal: "g-1",
    bindingVersion: 1,
    startedAt: now - 30_000,
    lastProgressAt: null,
    lastProgressFingerprint: null,
    stagnantRounds: 0,
    humanLocked: false,
    lastCareAt: null,
    frozenRemainingMs: null,
    scheduleDueAt: null,
    budgetSeconds: 120,
    budgetBaseAt: now - 30_000,
    budgetCountdown: true,
    budgetEffectiveSeconds: 120,
    budgetEffectiveSource: "goal",
    runStartedAt: now - 30_000,
    runStartSource: "attempt_record",
    runStartExact: false,
    remindersSent: 0,
    awaitingReply: false,
    humanReason: null,
    ...over,
  };
}

test("g-612 goal 预算：写入事件先行、合法范围/清空、非法值零写入零事件", () => {
  const { root, goal } = rootWithGoal();
  const before = readEvents(root).length;
  const set = setGoalBudget(root, goal, { budget_seconds: 120, actor: "human:gui" });
  assert.deepEqual(set, { old_seconds: null, new_seconds: 120 });
  const events = readEvents(root);
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1)?.event, "goal.budget_set");
  assert.equal(events.at(-1)?.details?.old_seconds, null);
  assert.equal(events.at(-1)?.details?.new_seconds, 120);
  assert.equal(goalDetail(root, goal).meta.task_budget_seconds, 120);

  // 同值幂等：不重复写事件
  const beforeSame = readEvents(root).length;
  setGoalBudget(root, goal, { budget_seconds: 120, actor: "human:gui" });
  assert.equal(readEvents(root).length, beforeSame);

  // 非法值：写前拒绝、goal.md 逐字节不变、零事件
  const file = findGoalFile(root, goal);
  const bytes = readFileSync(file);
  const beforeBad = readEvents(root).length;
  for (const bad of [29, 86_401, 1.5, "120", Number.NaN]) {
    assert.throws(() => setGoalBudget(root, goal, { budget_seconds: bad, actor: "human:gui" }));
  }
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(readEvents(root).length, beforeBad);

  // null = 清空并继承
  const cleared = setGoalBudget(root, goal, { budget_seconds: null, actor: "human:gui" });
  assert.deepEqual(cleared, { old_seconds: 120, new_seconds: null });
  assert.equal(goalDetail(root, goal).meta.task_budget_seconds, undefined);
});

test("g-612 预算有效区间：goal > 项目/全局阈值；投递后回复查；到期基准可寻", () => {
  const now = 1_000_000;
  const timing = { thresholdSeconds: 300, recheckSeconds: 300, thresholdSource: "project_explicit" as const };
  const t = task(now);
  assert.equal(careTaskIntervalMs(t, timing), 120_000);
  assert.equal(careTaskDueAt(t, { ...timing, resetAt: null }), t.startedAt + 120_000);
  // 继承（null）⇒ 项目/全局阈值
  assert.equal(careTaskIntervalMs({ ...t, budgetSeconds: null, budgetEffectiveSeconds: 300, budgetBaseAt: t.startedAt }, timing), 300_000);
  // 已投递 ⇒ 按复查间隔，不按 goal 预算反复提醒
  const delivered = applyCareDelivery(newCareGroupState(), [t], now).tasks[0];
  assert.equal(delivered.budgetCountdown, false);
  assert.equal(careTaskIntervalMs(delivered, timing), 300_000);
});

test("g-612 暂停冻结：继续后按各自冻结剩余接续；暂停期间真实墙钟不进入关照倒计时", () => {
  const now = 2_000_000;
  const t = task(now);
  const paused = pauseCare(newCareGroupState(), [t], {
    now, thresholdSeconds: 300, recheckSeconds: 300, thresholdSource: "project_explicit",
  });
  assert.equal(paused.group.paused, true);
  assert.equal(paused.tasks[0].frozenRemainingMs, 90_000);
  // 暂停期间过去 1 小时
  const later = now + 3_600_000;
  const resumed = resumeCare(paused.group, paused.tasks, {
    now: later, thresholdSeconds: 300, recheckSeconds: 300, thresholdSource: "project_explicit",
  });
  assert.equal(resumed.group.paused, false);
  assert.equal(resumed.tasks[0].scheduleDueAt, later + 90_000);
  // 预算变更后的 consumed 基准 = 120s - 90s = 30s（不含暂停墙钟）
  assert.equal(resumed.tasks[0].budgetBaseAt, later - 30_000);
  assert.equal(careTaskDueAt(resumed.tasks[0], {
    thresholdSeconds: 300, recheckSeconds: 300, resetAt: null, thresholdSource: "project_explicit",
  }), later + 90_000);
});

test("g-612 投影：预算来源/基准/倒计时与本轮 run 字段、历史一并如实下发", () => {
  const now = 3_000_000;
  const t = task(now, {
    budgetSeconds: null,
    budgetEffectiveSeconds: 300,
    budgetEffectiveSource: "project_explicit",
    budgetBaseAt: now - 10_000,
    runStartedAt: now - 20_000,
    runStartSource: "agent_status",
    runStartExact: true,
  });
  const projection = careStatusProjection({
    now,
    root: "/tmp/g612",
    supervisor: "sup",
    supervisorLive: true,
    supervisorIdle: false,
    configured: {
      threshold_seconds: 300, threshold_source: "project_explicit",
      recheck_seconds: 300, recheck_source: "project_explicit",
    } as any,
    capable: { available: true, unverified: [], reasons: [] } as any,
    decision: {
      phase: "countdown", reason: "waiting", deliver: false,
      nextDueAt: now + 1000, nextDueInMs: 1000, tasks: [{
        goal: "g-1", attempt: "att-1", child: "child-1", elapsedMs: 30_000,
        lastCareAgoMs: null, stagnantRounds: 0, maxStagnantRounds: 3, humanLocked: false,
      }], escalateTasks: [],
    },
    group: newCareGroupState(),
    tasks: [t],
    pendingInspections: [],
    lastOutcome: null,
    runs: [{
      id: "r1", goal: "g-1", attempt: "att-1", child: "child-1",
      startedAt: now - 50_000, startSource: "agent_status", startExact: true,
      stoppedAt: now - 40_000, stopSource: "agent_status", stopExact: true,
      budgetSeconds: 120, budgetSource: "goal", naturalMs: 10_000, deviationMs: -110_000, overBudget: false,
    }],
  });
  const shown = projection.tasks[0];
  assert.equal(shown.budget_seconds, null);
  assert.equal(shown.effective_budget_seconds, 300);
  assert.equal(shown.budget_source, "project_explicit");
  assert.equal(shown.budget_countdown, true);
  assert.equal(shown.run_started_at, now - 20_000);
  assert.equal(shown.run_start_source, "agent_status");
  assert.equal(shown.run_natural_ms, 20_000);
  assert.equal(projection.runs.length, 1);
  assert.equal(projection.run_history_limit > 0, true);
});

test("g-612 旧巡检被显式事件取代：晚到结论 stale（只审计、一次性幂等），其他 target 不受影响", () => {
  const now = 4_000_000;
  const insp = createCareInspection({
    id: "ins-1", root: "/tmp/g612", supervisor: "sup", now, revision: 1, recheckSeconds: 300,
    targets: [
      { goal: "g-a", attempt: "att-1", child: "child-a", bindingVersion: 1 },
      { goal: "g-b", attempt: "att-1", child: "child-b", bindingVersion: 1 },
    ],
  });
  assert.equal(insp.status, "queued");
  // 显式事件（消息 id / 预算编辑）只按事件顺序标记；绝不靠毫秒时间戳比较。
  const marked = {
    ...insp,
    status: "delivered" as const,
    deliveredAt: now,
    targets: insp.targets.map((t) => t.child === "child-a"
      ? { ...t, staleReason: "superseded_by_message" as const, staleAt: now + 1, supersededBy: "msg-1" }
      : t),
  };
  const base = {
    inspection: marked, now: now + 2_000, root: "/tmp/g612", supervisor: "sup",
    attempt: "att-1", bindingVersion: 1, outcome: "unknown" as const, evidenceDigest: "d1",
  };
  const vA = validateCareOutcome({ ...base, goal: "g-a", child: "child-a" });
  assert.equal(vA.ok, true);
  assert.equal(vA.ok && vA.stale, true, "被消息取代的 target 必须标 stale");
  assert.equal(vA.ok && vA.idempotent, false);
  const vB = validateCareOutcome({ ...base, goal: "g-b", child: "child-b" });
  assert.equal(vB.ok, true);
  assert.equal(vB.ok && vB.stale, false, "同批其他 target 不得被误标 stale");

  // 受理后 target 记 resolved，但 stale metadata 保留（宿主据此只记审计、不改任务状态）。
  const after = applyCareInspectionOutcome(marked, {
    goal: "g-a", attempt: "att-1", child: "child-a", kind: "unknown", evidenceDigest: "d1", now: now + 2_000,
  });
  const ta = after.targets.find((t) => t.child === "child-a");
  assert.equal(ta?.outcome, "unknown");
  assert.equal(ta?.staleReason, "superseded_by_message");
  assert.equal(ta?.supersededBy, "msg-1");
  assert.equal(after.status, "delivered", "同批其他 target 未回传 ⇒ 整条巡检不得提前 resolved");

  // 同结论 + 同证据重放 ⇒ 幂等且仍标 stale（宿主不二次应用/不二次计数）。
  const idem = validateCareOutcome({
    ...base, inspection: after, goal: "g-a", child: "child-a", now: now + 3_000,
  });
  assert.equal(idem.ok, true);
  assert.equal(idem.ok && idem.idempotent, true);
  assert.equal(idem.ok && idem.stale, true);
});

test("g-612 300s 冷却单一真源：实际截止=max(预算目标,lastCare+300)；无冷却不加 300；晚预算不截短；暂停冻结实际剩余", () => {
  const timing = { thresholdSeconds: 300, recheckSeconds: 300, resetAt: null as number | null, thresholdSource: "project_explicit" as const };
  const now = 5_000_000;
  // 预算目标 t=base+120；冷却是 lastCare+300（更晚）⇒ 实际取冷却。
  const t = task(now, {
    startedAt: now - 200_000, lastCareAt: now - 30_000, remindersSent: 1, awaitingReply: false,
    budgetSeconds: 120, budgetEffectiveSeconds: 120, budgetBaseAt: now - 60_000, budgetCountdown: true,
    scheduleDueAt: null,
  });
  const budgetDue = careTaskBudgetDueAt(t, timing);
  const cooldownDue = careCooldownDueAt(t);
  assert.equal(budgetDue, now + 60_000, "预算目标=base+120");
  assert.equal(cooldownDue, now + 270_000, "冷却截止=lastCare+300");
  assert.equal(careTaskDueAt(t, timing), now + 270_000, "实际截止=较晚冷却（反变异：去掉 max 会得 t120）");
  // 无冷却 ⇒ 不额外强加 300，也不看 lastCare。
  const noCooldown = { ...t, remindersSent: 0, awaitingReply: false };
  assert.equal(careCooldownDueAt(noCooldown), null);
  assert.equal(careTaskDueAt(noCooldown, timing), now + 60_000, "无冷却时实际=预算目标");
  // 预算 600 晚于冷却 ⇒ 取预算，不被 300 截短。
  const later = { ...t, budgetSeconds: 600, budgetEffectiveSeconds: 600 };
  assert.ok(careTaskBudgetDueAt(later, timing) > cooldownDue);
  assert.equal(careTaskDueAt(later, timing), careTaskBudgetDueAt(later, timing), "预算更晚时不得被冷却截短");
  // 未回复（awaitingReply=true 但 reminders=0 的合法状态）同样进入冷却判据。
  assert.equal(careCooldownDueAt({ ...t, remindersSent: 0, awaitingReply: true }), now + 270_000);
  // 无可证 lastCareAt ⇒ 冷却为 null（绝不伪造 now 作为冷却起点）。
  assert.equal(careCooldownDueAt({ ...t, lastCareAt: null }), null);

  // 暂停冻结「实际剩余」=270s；暂停墙钟 1 小时不消耗；resume 按剩余接续。
  const g = newCareGroupState();
  const paused = pauseCare(g, [t], { now, thresholdSeconds: 300, recheckSeconds: 300 });
  assert.equal(paused.tasks[0].frozenRemainingMs, 270_000, "暂停冻结 max(预算,冷却) 实际剩余");
  const resumed = resumeCare(paused.group, paused.tasks, { now: now + 3_600_000, thresholdSeconds: 300, recheckSeconds: 300 });
  assert.equal(careTaskDueAt(resumed.tasks[0], { ...timing, resetAt: resumed.group.resetAt }), now + 3_600_000 + 270_000, "resume 从剩余接续（不吃暂停墙钟）");
  assert.equal(resumed.tasks[0].frozenRemainingMs, null);
});
