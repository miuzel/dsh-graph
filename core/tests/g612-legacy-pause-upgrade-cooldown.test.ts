/**
 * g-612 att-007：**旧版（已交付 g506/05f）合法暂停快照升级**的冻结冷却重建（纯 core）。
 *
 * 真实已交付 05f runtime 的 pause 快照没有 `frozenCooldownRemainingMs`（字段后来才有），
 * 但真实写下 `group.pausedAt` 与 `task.lastCareAt`。修复前 resume 把调整后冷却截止写成 `now`，
 * 暂停期间流逝的墙钟被算进冷却 ⇒ 随后 goal 预算编辑（60s）或主管新消息在 resume+50/60s 提前投递，
 * 而用户选择的「暂停冻结 + 5 分钟无有效结论冷却」应至少等到 resume+真实剩余（本场景 290s）。
 *
 * 本文件把**最小修复规则**钉在纯函数上（真实旧 runtime → 新 runtime 的跨版本红绿证据见
 * att-007 私有 probe 日志，避免在仓库内再构建一份旧 dist）：
 * - 可证 `pausedAt`/`lastCareAt` ⇒ `remaining=max(0,lastCare+300s-pausedAt)`，`cooldownDueAt=now+remaining`；
 * - 绝不把旧 `frozenRemainingMs`（复查主导，实测 3590s）当冷却，也不无谓等待 1 小时；
 * - 不可证/时序不合理（正常旧版不会出现）⇒ 保守完整 300s，绝不提前；
 * - 新版有 `frozenCooldownRemainingMs` 的路径逐字不变；短暂停/二次 pause/resume/重建不丢剩余。
 *
 * 不联网、不写真实看板；纯状态变换。
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  CARE_NO_RESPONSE_COOLDOWN_MS,
  careCooldownDueAtReportable,
  careTaskBudgetDueAtReportable,
  careTaskDueAt,
  careTaskIntervalMs,
  legacyPausedCooldownRemainingMs,
  newCareGroupState,
  pauseCare,
  resumeCare,
  type CareGroupState,
  type CareTaskState,
} from "../care.ts";

const TIMING = { thresholdSeconds: 30, recheckSeconds: 3600, resetAt: null as number | null };
const COOLDOWN = CARE_NO_RESPONSE_COOLDOWN_MS;
const T0 = 1_700_000_000_000;

/** 真实 05f 快照形状：lastCareAt=T0（首次关照 unknown），暂停于 T0+10s，剩余=复查主导的 3590s。 */
function legacyTask(over: Partial<CareTaskState> = {}): CareTaskState {
  return {
    child: "child-legacy",
    attempt: "att-001",
    goal: "g-legacy",
    bindingVersion: 1,
    startedAt: T0 - 30_000,
    lastProgressAt: null,
    lastProgressFingerprint: null,
    stagnantRounds: 0,
    humanLocked: false,
    lastCareAt: T0,
    frozenRemainingMs: 3_590_000,
    scheduleDueAt: null,
    remindersSent: 1,
    awaitingReply: true,
    humanReason: null,
    budgetSeconds: null,
    budgetBaseAt: null,
    budgetCountdown: false,
    budgetEffectiveSeconds: null,
    budgetEffectiveSource: null,
    runStartedAt: T0 - 30_000,
    runStartSource: "attempt_record",
    runStartExact: false,
    // 旧版快照：没有 cooldownDueAt / frozenCooldownRemainingMs（保持 undefined，与事件恢复后一致）
    ...over,
  };
}

function legacyGroup(over: Partial<CareGroupState> = {}): CareGroupState {
  return {
    ...newCareGroupState(),
    paused: true,
    pausedAt: T0 + 10_000,
    pausedRemainingMs: 3_590_000,
    revision: 4,
    lastControl: "pause",
    lastControlAt: T0 + 10_000,
    ...over,
  };
}

function resumeLegacy(group: CareGroupState, task: CareTaskState, now: number) {
  return resumeCare(group, [task], { now, thresholdSeconds: 30, recheckSeconds: 3600 });
}

test("att007-1 旧快照 resume：用可证 pausedAt/lastCareAt 重建 290s（不是 now，也不是 3590s）", () => {
  const resumeAt = T0 + 610_000; // 暂停 600s 墙钟
  const r = resumeLegacy(legacyGroup(), legacyTask(), resumeAt);
  const t = r.tasks[0];
  assert.equal(t.lastCareAt, T0, "真实 lastCareAt 不被反推");
  assert.equal(t.frozenRemainingMs, null, "冻结剩余已消费");
  assert.equal(t.cooldownDueAt, resumeAt + 290_000, "调整后冷却截止=resume+真实剩余 290s");
  assert.equal(t.scheduleDueAt, resumeAt + 3_590_000, "预算/复查锚点仍从冻结 3590s 接续（不把冷却冒充预算）");
  const due = careTaskDueAt(t, TIMING);
  assert.equal(due, resumeAt + 3_590_000, "无预算编辑时 next_due 仍是旧冻结 3590s（既不改大也不改小）");
  assert.equal(r.group.paused, false);
  assert.equal(r.group.pausedAt, null);
});

test("att007-2 旧快照 resume 后 goal 预算编辑 60：next_due=max(base+60, resume+290)，不提前也不等 3590s", () => {
  const resumeAt = T0 + 610_000;
  const resumed = resumeLegacy(legacyGroup(), legacyTask(), resumeAt).tasks[0];
  const budgetBase = Number(resumed.budgetBaseAt);
  assert.equal(budgetBase, resumeAt - 10_000, "已消费关照时间（不含暂停段）=10s");
  // 与生产 applyBudgetChangeToTask（非暂停 + forced）逐字同形：
  const edited: CareTaskState = {
    ...resumed,
    budgetSeconds: 60,
    budgetEffectiveSeconds: 60,
    budgetEffectiveSource: "goal",
    budgetCountdown: true,
    scheduleDueAt: budgetBase + 60_000,
  };
  const budgetDue = careTaskDueAt(edited, TIMING);
  assert.equal(budgetDue, resumeAt + 290_000, "next_due 取较晚者（冻结冷却 290s）");
  assert.ok(budgetDue > budgetBase + 60_000, "不得提前到 base+60s");
  assert.ok(budgetDue < resumeAt + 3_590_000 - 60_000, "不得被旧 3590s 拖动");
  // 公开字段：预算目标可证（严格早于冷却截止），冷却真值可证。
  assert.equal(careTaskBudgetDueAtReportable(edited, TIMING), budgetBase + 60_000, "budget_due_at=base+60s");
  assert.equal(careCooldownDueAtReportable(edited, { now: resumeAt }), resumeAt + 290_000, "cooldown_due_at=resume+290s");
  // 恢复锚点尚是旧混合值时，纯预算不可分离 ⇒ null（不谎报）。
  assert.equal(careTaskBudgetDueAtReportable(resumed, TIMING), null, "resume 锚点>=冷却截止 ⇒ 预算目标未知");
});

test("att007-3 旧快照 resume 后 goal 预算 600（晚于冷却）⇒ 不截短，仍按预算", () => {
  const resumeAt = T0 + 610_000;
  const resumed = resumeLegacy(legacyGroup(), legacyTask(), resumeAt).tasks[0];
  const budgetBase = Number(resumed.budgetBaseAt);
  const edited: CareTaskState = {
    ...resumed,
    budgetSeconds: 600,
    budgetEffectiveSeconds: 600,
    budgetEffectiveSource: "goal",
    budgetCountdown: true,
    scheduleDueAt: budgetBase + 600_000,
  };
  assert.equal(careTaskDueAt(edited, TIMING), budgetBase + 600_000, "预算 600s 晚于冷却 ⇒ next_due=预算");
  assert.ok(careTaskDueAt(edited, TIMING) > resumeAt + 290_000, "冷却不得截短更晚的预算目标");
});

test("att007-4 短暂停同样不消耗冷却（暂停 60s 与 600s 剩余一致），且二次 pause/resume 不丢剩余", () => {
  const shortResume = T0 + 70_000;
  const a = resumeLegacy(legacyGroup(), legacyTask(), shortResume).tasks[0];
  const b = resumeLegacy(legacyGroup(), legacyTask(), T0 + 610_000).tasks[0];
  assert.equal(Number(a.cooldownDueAt) - shortResume, Number(b.cooldownDueAt) - (T0 + 610_000));
  assert.equal(Number(a.cooldownDueAt) - shortResume, 290_000, "暂停墙钟不消耗冻结冷却");

  // 二次暂停（长暂停 resume 后 +100s）⇒ 冻结剩余=190s；再 resume ⇒ 从 190s 接续。
  const base = T0 + 610_000;
  const pause2At = base + 100_000;
  const p2 = pauseCare(
    { ...newCareGroupState() },
    [{ ...b, budgetSeconds: 60, budgetEffectiveSeconds: 60, budgetCountdown: true, scheduleDueAt: Number(b.budgetBaseAt) + 60_000 }],
    { now: pause2At, thresholdSeconds: 30, recheckSeconds: 3600 },
  );
  assert.equal(Number(p2.tasks[0].cooldownDueAt), base + 290_000, "暂停不改变真实调整后截止");
  assert.ok(Math.abs(Number(p2.tasks[0].frozenCooldownRemainingMs) - 190_000) <= 1, "冻结冷却剩余=190s");
  const resume2At = pause2At + 600_000;
  const r2 = resumeCare(p2.group, p2.tasks, { now: resume2At, thresholdSeconds: 30, recheckSeconds: 3600 });
  assert.equal(Number(r2.tasks[0].cooldownDueAt) - resume2At, 190_000, "二次 resume 从 190s 接续（暂停墙钟不消耗）");
  const due2 = careTaskDueAt(r2.tasks[0], TIMING);
  assert.ok(due2 >= resume2At + 190_000 - 1, "next_due 不早于二次冻结冷却");
});

test("att007-5 正常 runtime 重建：持久状态重算得到同一截止（不重置、不重复轮次）", () => {
  const resumeAt = T0 + 610_000;
  const resumed = resumeLegacy(legacyGroup(), legacyTask(), resumeAt).tasks[0];
  const edited: CareTaskState = {
    ...resumed,
    budgetSeconds: 60,
    budgetEffectiveSeconds: 60,
    budgetCountdown: true,
    scheduleDueAt: Number(resumed.budgetBaseAt) + 60_000,
  };
  const clone = structuredClone(edited) as CareTaskState;
  assert.equal(careTaskDueAt(clone, TIMING), careTaskDueAt(edited, TIMING), "重建后到期时刻不变");
  assert.equal(careTaskDueAt(clone, TIMING), resumeAt + 290_000);
  assert.equal(careCooldownDueAtReportable(clone, { now: resumeAt }), resumeAt + 290_000);
});

test("att007-6 新版带 frozenCooldownRemainingMs 的路径不变（优先冻结分量，忽略旧公式来源）", () => {
  const resumeAt = T0 + 610_000;
  // 与旧快照同样的 lastCareAt/pausedAt，但新版写入了明确的冻结冷却分量。
  for (const frozenCooldown of [0, 123_456, 290_000]) {
    const r = resumeLegacy(
      legacyGroup(),
      legacyTask({ frozenCooldownRemainingMs: frozenCooldown, cooldownDueAt: T0 + 300_000 }),
      resumeAt,
    );
    assert.equal(r.tasks[0].cooldownDueAt, resumeAt + frozenCooldown, `新版按冻结分量 ${frozenCooldown} 恢复`);
  }
});

test("att007-7 不可证/时序不合理 ⇒ 保守完整 300s（绝不提前，上限 300s）", () => {
  const resumeAt = T0 + 610_000;
  const cases: Array<[string, CareGroupState, CareTaskState]> = [
    ["pausedAt 缺失", legacyGroup({ pausedAt: null }), legacyTask()],
    ["lastCareAt 缺失", legacyGroup(), legacyTask({ lastCareAt: null })],
    ["pausedAt < lastCareAt", legacyGroup({ pausedAt: T0 - 5_000 }), legacyTask()],
    ["pausedAt > now", legacyGroup({ pausedAt: resumeAt + 5_000 }), legacyTask()],
    ["非有限数", legacyGroup({ pausedAt: Number.NaN }), legacyTask()],
  ];
  for (const [label, group, task] of cases) {
    const r = resumeLegacy(group, task, resumeAt);
    assert.equal(r.tasks[0].cooldownDueAt, resumeAt + COOLDOWN, `${label} ⇒ 保守 now+300s`);
    assert.ok(careTaskDueAt(r.tasks[0], TIMING) >= resumeAt + COOLDOWN - 1, `${label} ⇒ next_due 不早于保守冷却`);
  }
});

test("att007-8 暂停前冷却已过期 ⇒ 剩余 0，不额外强加 300s", () => {
  const resumeAt = T0 + 900_000;
  const r = resumeLegacy(legacyGroup({ pausedAt: T0 + 400_000 }), legacyTask(), resumeAt);
  assert.equal(r.tasks[0].cooldownDueAt, resumeAt, "已过期 ⇒ 调整后截止=resume（无有效结论冷却已满足）");
  const budgeted: CareTaskState = {
    ...r.tasks[0],
    budgetBaseAt: resumeAt,
    budgetCountdown: true,
    budgetSeconds: 120,
    budgetEffectiveSeconds: 120,
    scheduleDueAt: resumeAt + 120_000,
  };
  assert.equal(careTaskDueAt(budgeted, TIMING), resumeAt + 120_000, "无额外 300s 强加");
});

test("att007-9 暂停中 reset（旧版只留 resetAt）按既有「刷新满 300s」语义，不提前", () => {
  const resumeAt = T0 + 610_000;
  const during = legacyGroup({ resetAt: T0 + 60_000 }); // reset 发生在暂停中
  assert.equal(legacyPausedCooldownRemainingMs(legacyTask(), during.pausedAt, { now: resumeAt, resetAt: during.resetAt }), 300_000);
  const r = resumeLegacy(during, legacyTask(), resumeAt);
  assert.equal(r.tasks[0].cooldownDueAt, resumeAt + COOLDOWN, "reset 刷新满 300s（clip，不无限延长）");
  // reset 发生在暂停前：只取可证下界，仍 ≤300s。
  const before = legacyGroup({ resetAt: T0 + 5_000 });
  assert.equal(legacyPausedCooldownRemainingMs(legacyTask(), before.pausedAt, { now: resumeAt, resetAt: before.resetAt }), 295_000);
});

test("att007-10 careTaskIntervalMs 仍把 300s 冷却并入复查区间（旧口径不乱）", () => {
  assert.equal(careTaskIntervalMs(legacyTask(), { thresholdSeconds: 30, recheckSeconds: 3600 }), 3_600_000);
  assert.equal(careTaskIntervalMs(legacyTask(), { thresholdSeconds: 30, recheckSeconds: 30 }), COOLDOWN);
  assert.equal(careTaskIntervalMs(legacyTask({ remindersSent: 0, awaitingReply: false }), { thresholdSeconds: 30, recheckSeconds: 30 }), 30_000);
});
