/**
 * g-616：长任务关照「单条定时唤醒」（方案 A）+ 合并批次逐 target 作废。
 *
 * 现场复现（`docs/evidence/g616-care-wake-timeline.md`，取自真实会话事件流
 * `session-a0f8ca99-…` 与 `dsh-subagent-ui/.dsh-graph/events.jsonl`）：
 *
 * | 投递时刻 (UTC) | goal / attempt | child      | 相邻间隔 |
 * | 01:21:38       | g-028 / att-001 | 11882505…  | —        |
 * | 01:22:33       | g-029 / att-001 | 69061b2c…  | 55 秒    |
 * | 01:27:33       | g-029 / att-001 | 69061b2c…  | 300 秒   |
 *
 * 两次投递属于**不同目标**（判据 1 指定的「相邻到期未合并」），不是同一任务被重复唤醒，
 * 也不是逐子代理计时器（本组 `nextDueAt` 一直是 `Math.min`）。
 *
 * 覆盖：
 *  1. 负向对照：旧口径（按最早到期排程）在 55 秒内产生**两次**投递；
 *  2. 正向：`careCoalescedWakeAt` 让先到期者顺延到邻居到期时**一次**投递；
 *  3. 判据 3：N 个任务合并投递后 N 个都被计账（`applyCareDelivery` 逐个推进）；
 *  4. 判据 4：`Math.min` 最早到期语义、300s 冷却、上限/人工锁、暂停冻结、`inspection_open` 短路均不变；
 *  5. 逐 target 作废：同批里一个目标结束不得作废其余目标（否则合并会丢关照）。
 *
 * 零网络、零真实 provider、零费用。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  applyCareDelivery,
  applyCareInspectionOutcome,
  careCoalesceBatch,
  careCoalescedWakeAt,
  careInspectionOpen,
  careTaskDueAt,
  createCareInspection,
  decideCare,
  expireStaleInspectionTargets,
  newCareGroupState,
  validateCareOutcome,
  CARE_COALESCE_WINDOW_MS,
  type CareGroupState,
  type CareTaskState,
} from "../care.ts";

// ───────────────────────────── 夹具 ─────────────────────────────
const NOW = 1_000_000_000_000;

function task(overrides: Partial<CareTaskState> = {}): CareTaskState {
  return {
    child: "child-a",
    attempt: "att-001",
    goal: "goal-a",
    bindingVersion: 1,
    startedAt: NOW,
    lastProgressAt: null,
    lastProgressFingerprint: null,
    stagnantRounds: 0,
    humanLocked: false,
    lastCareAt: null,
    frozenRemainingMs: null,
    ...overrides,
  };
}
function group(overrides: Partial<CareGroupState> = {}): CareGroupState {
  return { ...newCareGroupState(), ...overrides };
}
const baseInputs = {
  enabled: true,
  thresholdSeconds: 300,
  recheckSeconds: 300,
  maxStagnantRounds: 3,
  idle: true as boolean | null,
  group: group(),
};
/** 单任务下一次到期时刻（与 `decideCare` 同口径）。 */
function dueOf(t: CareTaskState, now = NOW): number {
  return careTaskDueAt(t, { thresholdSeconds: 300, recheckSeconds: 300, resetAt: null });
}

// ── 1. 负向对照：旧口径（按最早到期排程）在 55 秒内产生两次投递 ──────────────
test("g-616 负向对照：按「最早到期」排程复现 55 秒内两次投递（旧行为必红）", () => {
  // 现场：g-028 startedAt=09:16:38，g-029 startedAt=09:17:33 ⇒ 首次到期相差 55 秒。
  const t028 = task({ child: "11882505", goal: "g-028", startedAt: NOW });
  const t029 = task({ child: "69061b2c", goal: "g-029", startedAt: NOW + 55_000 });

  // ① 09:21:38 —— g-028 到期，g-029 还有 55 秒
  const atFirst = NOW + 300_000;
  const first = decideCare({ ...baseInputs, now: atFirst, tasks: [t028, t029] }, true);
  assert.equal(first.deliver, true, "第一次到期必须投递");
  assert.equal(first.nextDueAt, dueOf(t028), "全组最早到期 = g-028（Math.min 语义不变）");

  // 旧口径：宿主按 `nextDueAt`(=最早) 排程 ⇒ 投递后立刻按 g-029 的到期再排一次
  const only028 = applyCareDelivery(first.group, [t028, t029], atFirst, [{ child: "11882505", attempt: "att-001" }]);
  assert.equal(dueOf(only028.tasks[1]), NOW + 55_000 + 300_000, "g-029 的下一次到期比 g-028 晚 55 秒");

  // ② 55 秒后 —— 第二次投递（这正是负责人看到的「连续唤醒」）
  const atSecond = atFirst + 55_000;
  const second = decideCare({ ...baseInputs, now: atSecond, group: only028.group, tasks: only028.tasks }, true);
  assert.equal(second.deliver, true, "旧口径必然在 55 秒内再投递一次 ⇒ 两次唤醒");

  // 负向断言：两次投递的目标确实不同（判据 1：不是重复唤醒同一任务）
  assert.notEqual(t028.goal, t029.goal);
});

// ── 2. 正向：一次唤醒把宽限内的邻居并入同一批 ─────────────────────────────
test("g-616 合并唤醒：careCoalesceBatch 把 55 秒邻居并入同一批（一次投递两个目标）", () => {
  const t028 = task({ child: "11882505", goal: "g-028", startedAt: NOW });
  const t029 = task({ child: "69061b2c", goal: "g-029", startedAt: NOW + 55_000 });

  // 单条定时器：触发时刻仍是全组最早到期（不引入第二条计时器）
  const wakeAt = careCoalescedWakeAt([dueOf(t028), dueOf(t029)], NOW);
  assert.equal(wakeAt, dueOf(t028), "定时器按全组最早到期触发");

  // 在 g-028 到期的这一刻（09:21:38），宽限 60s 内的 g-029 被**一并**纳入本批
  const atFirst = NOW + 300_000;
  const schedules = [
    { child: "11882505", goal: "g-028", attempt: "att-001", dueAt: dueOf(t028) },
    { child: "69061b2c", goal: "g-029", attempt: "att-001", dueAt: dueOf(t029) },
  ];
  const batch = careCoalesceBatch(schedules, atFirst);
  assert.deepEqual(batch.map((b) => b.goal).sort(), ["g-028", "g-029"], "55 秒邻居被合并进同一批");
  assert.equal(batch.length, 2, "一次投递同时覆盖两个目标 ⇒ 不再有 55 秒后的第二次打断");

  // 宽限之外：不会无限凑合（先到期者绝不被无限饿死）
  const farSchedules = [
    { child: "c1", goal: "g-1", attempt: "att-001", dueAt: atFirst },
    { child: "c2", goal: "g-2", attempt: "att-001", dueAt: atFirst + CARE_COALESCE_WINDOW_MS + 1 },
  ];
  const limited = careCoalesceBatch(farSchedules, atFirst);
  assert.deepEqual(limited.map((b) => b.goal), ["g-1"], "超出宽限的邻居留给下一次唤醒");

  // 边界：恰好落在宽限端点仍纳入
  const edge = careCoalesceBatch(
    [{ child: "c1", goal: "g-1", attempt: "att-001", dueAt: atFirst + CARE_COALESCE_WINDOW_MS }],
    atFirst,
  );
  assert.equal(edge.length, 1, "宽限端点为闭区间");

  // 空集/无倒计时任务不入选
  assert.deepEqual(careCoalesceBatch([], atFirst), []);
  assert.deepEqual(careCoalesceBatch([{ child: "c", goal: "g", attempt: "a", dueAt: null }], atFirst), []);
  assert.equal(careCoalescedWakeAt([], NOW), null);
  assert.equal(careCoalescedWakeAt([NOW + 10, NOW + 20], NOW), NOW + 10, "定时器仍取全组最早");
});

// ── 3. 判据 3：N 个任务合并投递后 N 个都被计账 ─────────────────────────────
test("g-616 绝不漏关照：N 个任务合并投递后 N 个都推进 lastCareAt", () => {
  const N = 5;
  // N 个任务的到期时刻都落在同一个宽限内（现场「几乎同时到期」的形态）
  const tasks = Array.from({ length: N }, (_, i) =>
    task({ child: `c${i}`, attempt: `att-00${i}`, goal: `g-0${i}`, startedAt: NOW + i * 5_000 }));

  const schedules = tasks.map((t) => ({ child: t.child, attempt: t.attempt, goal: t.goal, dueAt: dueOf(t) }));
  const firstDue = Math.min(...schedules.map((s) => s.dueAt));
  const now = firstDue; // 第一个到期的那一刻
  const batch = careCoalesceBatch(schedules, now);
  assert.equal(batch.length, N, `宽限内 ${N} 个任务必须合并进同一批`);

  const decision = decideCare({ ...baseInputs, now, tasks }, true);
  assert.equal(decision.deliver, true, "第一个任务到期 ⇒ 触发一次投递");

  // 投递后逐个计账：每个任务都被推进、提醒数 +1（绝不因合并跳过）
  const applied = applyCareDelivery(
    decision.group, tasks, now,
    batch.map((b) => ({ child: b.child, attempt: b.attempt })),
  );
  assert.equal(applied.tasks.length, N);
  for (const t of applied.tasks) {
    assert.equal(t.lastCareAt, now, `任务 ${t.child} 必须被计账（不得因合并跳过）`);
    assert.equal(t.remindersSent, 1);
    assert.equal(t.awaitingReply, true);
  }
  // 负向对照：若只投递第一个（旧「只认最早」的实现），则其余 N-1 个漏账
  const onlyFirst = applyCareDelivery(decision.group, tasks, now, [{ child: "c0", attempt: "att-000" }]);
  assert.equal(onlyFirst.tasks.filter((t) => t.lastCareAt === now).length, 1, "漏账形态可被区分");
});

// ── 4. 判据 4：既有语义不变 ───────────────────────────────────────────────
test("g-616 语义不变：最早到期/冷却/上限/人工锁/暂停/巡检在途短路", () => {
  // Math.min 最早到期语义（判据 4）
  const a = task({ child: "c1", attempt: "a1", startedAt: NOW - 100_000 });
  const b = task({ child: "c2", attempt: "a2", startedAt: NOW - 200_000 });
  const multi = decideCare({ ...baseInputs, now: NOW, tasks: [a, b] }, true);
  assert.equal(multi.nextDueAt, dueOf(b), "nextDueAt 仍取全组最早");

  // 人工锁 / 升限任务不参与合并排程（不得因凑邻居提前唤醒）
  const locked = task({ child: "c3", attempt: "a3", startedAt: NOW - 900_000, humanLocked: true });
  const withLocked = decideCare({ ...baseInputs, now: NOW, tasks: [a, locked] }, true);
  assert.deepEqual(withLocked.escalateTasks, ["c3"]);
  const dueAts = withLocked.tasks.filter((s) => !s.escalated).map((s) => s.dueAt as number);
  assert.equal(careCoalescedWakeAt(dueAts, NOW), dueOf(a), "升限任务不参与合并时刻");

  // 300s 冷却：已提醒未回复时复查间隔不得短于 300s
  const reminded = task({ child: "c4", attempt: "a4", startedAt: NOW - 900_000, lastCareAt: NOW - 10_000, remindersSent: 1, awaitingReply: true });
  assert.ok(dueOf(reminded) > NOW, "未有效结论冷却内不得到期");

  // 暂停：冻结剩余，不产生倒计时
  const paused = decideCare({
    ...baseInputs, now: NOW, tasks: [a], group: group({ paused: true, pausedRemainingMs: 12_000 }),
  }, true);
  assert.equal(paused.phase, "paused");
  assert.equal(paused.nextDueAt, null, "暂停不得显示会推进的倒计时");

  // inspection_open 短路：在途巡检未结束 ⇒ 不另发第二条唤醒（单条定时唤醒）
  const dueA = task({ child: "c1", attempt: "a1", startedAt: NOW - 400_000 });
  const dueB = task({ child: "c2", attempt: "a2", startedAt: NOW - 400_000 });
  const open = decideCare({ ...baseInputs, now: NOW, tasks: [dueA, dueB], openInspection: true }, true);
  assert.equal(open.deliver, false);
  assert.equal(open.reason, "inspection_open");
  assert.equal(open.nextDueAt, null);
  // 但被顺延的到期目标必须被点名（不丢关照）
  assert.deepEqual((open.deferredTasks ?? []).slice().sort(), ["c1", "c2"]);
});

// ── 5. 逐 target 作废：合并批里一个目标结束不得作废其余 ─────────────────────
test("g-616 逐 target 作废：同批一个目标结束，其余目标仍可回传结论", () => {
  const ins = createCareInspection({
    id: "insp-1", root: "/r", supervisor: "sup", now: NOW, revision: 1, recheckSeconds: 300,
    targets: [
      { goal: "g-028", attempt: "att-001", child: "c028", bindingVersion: 1 },
      { goal: "g-029", attempt: "att-001", child: "c029", bindingVersion: 1 },
    ],
  });
  // c028 结束（不在 live 表里）；c029 仍活
  const live = new Map([["c029\u0000att-001", 1]]);
  const r = expireStaleInspectionTargets(ins, live, NOW + 1_000);
  assert.equal(r.changed, true);
  assert.equal(r.inspection.status !== "expired", true, "整条巡检不得因一个 target 结束而作废");
  assert.equal(careInspectionOpen(r.inspection, NOW + 1_000), true, "其余目标仍开放");

  // 已作废的 target 拒绝回传；仍活的目标正常受理
  const rejected = validateCareOutcome({
    inspection: r.inspection, now: NOW + 2_000, root: "/r", supervisor: "sup",
    goal: "g-028", attempt: "att-001", child: "c028", bindingVersion: 1,
    outcome: "progress", evidenceDigest: "d1",
  });
  assert.deepEqual(rejected.ok === false && rejected.code, "target_expired");

  const accepted = validateCareOutcome({
    inspection: r.inspection, now: NOW + 2_000, root: "/r", supervisor: "sup",
    goal: "g-029", attempt: "att-001", child: "c029", bindingVersion: 1,
    outcome: "progress", evidenceDigest: "d2",
  });
  assert.equal(accepted.ok, true, "同批仍活目标的结论必须被受理（判据 3）");

  // 全部 target 都作废 ⇒ 整条巡检才转 expired
  const all = expireStaleInspectionTargets(ins, new Map(), NOW + 1_000);
  assert.equal(all.inspection.status, "expired");
  assert.equal(careInspectionOpen(all.inspection, NOW + 1_000), false);

  // 负向对照：旧「任一 target 陈旧 ⇒ 整条 expired」会让 c029 的结论被拒（漏关照形态）
  const legacyBatchExpired = { ...ins, status: "expired" as const };
  const lost = validateCareOutcome({
    inspection: legacyBatchExpired, now: NOW + 2_000, root: "/r", supervisor: "sup",
    goal: "g-029", attempt: "att-001", child: "c029", bindingVersion: 1,
    outcome: "progress", evidenceDigest: "d2",
  });
  assert.deepEqual(lost.ok === false && lost.code, "inspection_not_open", "旧形态漏关照可被区分");
});

test("g-616 逐 target 作废与结论回填协同：已 resolved 的目标不被再作废", () => {
  const ins0 = createCareInspection({
    id: "insp-2", root: "/r", supervisor: "sup", now: NOW, revision: 1, recheckSeconds: 300,
    targets: [
      { goal: "g-1", attempt: "att-001", child: "c1", bindingVersion: 1 },
      { goal: "g-2", attempt: "att-001", child: "c2", bindingVersion: 1 },
    ],
  });
  const ins1 = applyCareInspectionOutcome(ins0, {
    goal: "g-1", attempt: "att-001", child: "c1", kind: "progress", evidenceDigest: "d1", now: NOW + 10,
  });
  // c1 之后结束：已回填结论的目标不应被标作废（结论已计账）
  const r = expireStaleInspectionTargets(ins1, new Map([["c2\u0000att-001", 1]]), NOW + 20);
  assert.equal(r.expiredTargets.length, 0, "已 resolved 的 target 不参与作废");
  assert.equal(r.changed, false);
  assert.equal(careInspectionOpen(r.inspection, NOW + 20), true);
});
