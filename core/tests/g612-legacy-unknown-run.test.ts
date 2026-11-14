/**
 * g-612 att-010：**g506/05f 已交付版本产生的在途 run 旧快照**升级后的预算历史真相。
 *
 * 真实已交付 05f runtime 的 `care_state` 快照没有任何 run/预算字段：
 *   - task 无 `runStartedAt` / `runStartSource` / `budgetHistory` / `budgetSeconds` 等；
 *   - 整个状态无 `runs` / `dormant`。
 * 升级到候选后，同一 child 仍在 running、采样只能看到「它现在在跑」，但**无法证实**它何时开始、
 * 当时采用什么预算 ⇒ 公开 run 的 `budget_seconds`/`budget_source`/`started_at`/`start_source`/
 * `deviation_ms` 必须如实未知，绝不拿采样 now + 当前 goal/project 30s（或稍后编辑的 60s）回填。
 *
 * 断言（真宿主 + 生产 createCareRuntime + fake adapter；真实 05f runtime 跨版本红绿证据见
 * att-010 私有 probe 日志 `legacy-nohist-assert-*.log`，本文件把同一语义钉进整套件回归）：
 *   A 旧暂停快照 → 候选 resume → 同 child 自然停止 ⇒ initial/source/start/deviation 全未知；
 *   B 旧在途 run 期间真实主管消息 + 真实 owner goal 预算 60 ⇒ 当前调度生效（60/goal、可证截止），
 *     但历史 initial 仍未知、`budget_changes=[]`（后续观察不得冒充初始）；
 *   C 旧轮 natural idle 后同 child/attempt/binding 经真实主管消息 cold resume ⇒ **新 run** 由
 *     真实 `agent/status` running 事件建立可证起点与当时预算 60，旧 unknown 不污染新轮；
 *   D 正控：正常新任务起点可证 ⇒ initial 30/project_explicit 照旧记录（修复不误伤正常 run）。
 *
 * 旧快照形状来自 05f 自身持久化字段；测试用当前真实快照**删除 05f 之后才新增的字段**得到
 * 等价旧快照（与 g612 既有 legacy upgrade 夹具同一模式），不手工伪造任何旧 runtime 未写过的值。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { appendEvent, readEvents } from "../events.ts";
import { invalidateBoardCache } from "../cache.ts";
import { claimSupervisor, closeWatchers, getCachedBoardPayload, readSupervisorSession, setGoalBudget } from "../ops.ts";
import { createCareRuntime } from "../../dist/index.js";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(cond: () => T | null | Promise<T | null>, label: string, timeoutMs = 15000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const v = await cond(); if (v) return v as T; await sleep(10); }
  throw new Error(`等待超时：${label}`);
}

const PROJECT = `supervisor:\n  session: sess-super\n  care: "false"\n  care_threshold_seconds: 30\n  care_recheck_seconds: 3600\n`;
const sig = () => new AbortController().signal;

function makeCare(h: any, idPrefix: string) {
  let seq = 0;
  return createCareRuntime({
    ctx: {
      on: (name: string, fn: any) => h.ctx.on(name, fn),
      get: (name: string) => (name === "agents" ? h.reg : name === "subagents" ? h.subagents : name === "llm" ? h.llm : undefined),
    },
    readGlobal: () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: true, raw: "on" }),
    resolveRoot: (ws: string) => join(ws, ".dsh-graph"),
    defaultWorkspace: () => h.ws,
    readProjectConfigFn: () => ({ supervisor: { care: true, care_threshold_seconds: 30, care_recheck_seconds: 3600 } }),
    readSupervisorSessionFn: (root: string) => readSupervisorSession(root),
    readBoardPayload: (root: string) => { try { return getCachedBoardPayload(root, { lazy: true })?.payload ?? null; } catch { return null; } },
    appendEventFn: (root: string, ev: any) => appendEvent(root, ev),
    makeInspectionId: () => `${idPrefix}-${++seq}`,
    log: () => {},
  });
}

/** 读取最后一条 `care_state` 快照（事件真源）。 */
function lastCareState(root: string): any {
  const evs = readEvents(root);
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const c = (evs[i] as any)?.details?.care_state;
    if (c && typeof c === "object") return c;
  }
  return null;
}

/** 把当前真实快照改写成真实 05f 的形状：删除 05f 之后才新增的持久字段（旧版本来就没有）。 */
function toLegacy05fSnapshot(snapshot: any): any {
  const tasks = (Array.isArray(snapshot.tasks) ? snapshot.tasks : []).map((t: any) => {
    const {
      budgetSeconds, budgetBaseAt, budgetCountdown, budgetEffectiveSeconds, budgetEffectiveSource,
      runStartedAt, runStartSource, runStartExact, lastObservedAt,
      budgetHistory, budgetHistoryTruncated, cooldownDueAt, frozenCooldownRemainingMs,
      ...legacy
    } = t;
    return legacy;
  });
  const { runs, dormant, ...rest } = snapshot;
  return { ...rest, version: 1, tasks, inspections: [] };
}

function assertUnknownInitial(run: any, label: string) {
  assert.ok(run, `${label}: run 必须存在`);
  assert.equal(run.budget_seconds, null, `${label}: 历史初始预算必须 null（实得 ${run.budget_seconds}）`);
  assert.equal(run.budget_source, "unknown", `${label}: 历史预算来源必须 unknown（实得 ${run.budget_source}）`);
  assert.equal(run.started_at, null, `${label}: 不可证起点必须 null（实得 ${run.started_at}）`);
  assert.equal(run.start_source, "unknown", `${label}: 起点来源必须 unknown（实得 ${run.start_source}）`);
  assert.equal(run.deviation_ms, null, `${label}: 不可证起点 ⇒ deviation 必须 null（实得 ${run.deviation_ms}）`);
  assert.equal(run.natural_ms, null, `${label}: 不可证起点 ⇒ natural 必须 null（实得 ${run.natural_ms}）`);
  assert.deepEqual(run.budget_changes, [], `${label}: 不得把后续观察冒充变化（实得 ${JSON.stringify(run.budget_changes)}）`);
  assert.equal(run.budget_changes_truncated, false, `${label}: 空历史不得标截断`);
}

/**
 * 真实 05f 等价升级：当前 runtime 采样在途任务 → pause（真实快照）→ 改写成 05f 形状并作为
 * 最后一条 care.pause 事件 → dispose → 新 runtime 加载/resume（entry.startedAt 晚于 attempt 起点
 * ⇒ run 起点不可证，与真实 05f→候选升级同分支）。
 */
async function legacyUpgrade() {
  const h = await makeRealHost({ relativeRoot: true, projectYaml: PROJECT, sessionQuery: true });
  claimSupervisor(h.root, h.parent.id, "att010:legacy");
  const marker = "G612-LEGACY-CHILD";
  const care = makeCare(h, "g612-legacy-1");
  care.start();
  const goal = await makeGoal(h, "g612 legacy unknown run");
  invalidateBoardCache(h.root);
  h.fake.hold(marker);
  const d: any = await h.dispatch(goal, marker, { worktree: false });
  const childId = String(d.child_id ?? "");
  const attempt = String(d.attempt ?? "att-001");
  assert.ok(childId, "real child dispatched");
  await waitFor(() => (h.childLive(childId) === "running" ? true : null), "child running");
  care.armForRoot(h.root);
  const task1 = () => (care.statusFor(h.root)?.tasks ?? []).find((t: any) => t.child === childId) ?? null;
  await waitFor(() => task1(), "task sampled");

  const pauseAt = Date.now();
  assert.equal(care.control(h.root, "pause").ok, true, "pause ok");
  const snap = lastCareState(h.root);
  assert.ok(snap && Array.isArray(snap.tasks) && snap.tasks.length > 0, "存在真实 paused care_state 快照");
  const snapTask = snap.tasks.find((t: any) => t.child === childId);
  assert.ok(snapTask, "真实快照包含在途任务");
  assert.ok(Number.isFinite(Number(snapTask.runStartedAt)), "前置：候选真实快照本来有 run 起点");
  const legacy = toLegacy05fSnapshot(snap);
  const legacyTask = legacy.tasks.find((t: any) => t.child === childId);
  assert.equal(legacyTask.runStartedAt, undefined, "等价 05f 快照没有 runStartedAt");
  assert.equal(legacyTask.budgetHistory, undefined, "等价 05f 快照没有 budgetHistory");
  assert.equal(legacyTask.budgetSeconds, undefined, "等价 05f 快照没有 budgetSeconds");
  appendEvent(h.root, { actor: "system:att010-legacy-fixture", event: "care.pause", details: { care_state: legacy } });
  care.dispose();

  // 新 runtime = 正常升级（同一真实 child 仍在 running）。
  const care2 = makeCare(h, "g612-legacy-2");
  care2.start();
  care2.armForRoot(h.root);
  assert.equal(care2.control(h.root, "resume").ok, true, "resume ok");
  care2.armForRoot(h.root);
  const status = () => care2.statusFor(h.root);
  const task = () => (status()?.tasks ?? []).find((t: any) => t.child === childId) ?? null;
  const runs = () => status()?.runs ?? [];
  await waitFor(() => (task() ? true : null), "legacy task restored after upgrade");
  assert.equal(Number(task().effective_budget_seconds), 30, "当前调度仍用项目默认 30（历史 unknown ≠ 停止关照）");
  assert.equal(task().run_started_at, null, "升级后旧 run 起点如实未知");
  assert.equal(task().run_start_source, "unknown", "升级后旧 run 起点来源 unknown");

  const shutdown = async () => {
    try { care2.dispose(); } catch {}
    try { care.dispose(); } catch {}
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch {}
  };
  return { h, goal, childId, attempt, marker, care2, pauseAt, status, task, runs, shutdown };
}
type L = Awaited<ReturnType<typeof legacyUpgrade>>;

test("g612 att010 A：真实05f在途快照升级后自然停止 ⇒ initial/source/start/deviation 全未知", async () => {
  const l = await legacyUpgrade();
  try {
    l.h.fake.releaseAll();
    await waitFor(() => (l.h.childLive(l.childId) !== "running" ? true : null), "child stopped");
    await sleep(300);
    const run: any = l.runs().find((r: any) => r.child === l.childId);
    console.log("ATT010-A-RUN", JSON.stringify(run ? {
      budget_seconds: run.budget_seconds, budget_source: run.budget_source, start_source: run.start_source,
      started_at: run.started_at, deviation_ms: run.deviation_ms, changes: run.budget_changes,
    } : null));
    assertUnknownInitial(run, "A");
  } finally { await l.shutdown(); }
});

test("g612 att010 B：旧在途run真实消息+goal预算60 ⇒ 当前调度生效但历史 initial 仍未知", async () => {
  const l = await legacyUpgrade();
  try {
    const msgAt = Date.now();
    const msgId = await l.h.subagents.sendMessage(l.h.parent, l.childId, [{ type: "text", text: "ATT010-B supervisor msg" }], { signal: sig() });
    assert.ok(msgId, "真实 subagents.sendMessage accepted");
    await sleep(100);
    l.care2.armForRoot(l.h.root);
    await waitFor(() => (l.task() ? true : null), "task sampled after message");
    assert.equal(l.task().last_care_at, null, "从未关照：不伪造 lastCareAt / 冷却");
    const set = setGoalBudget(l.h.root, l.goal, { budget_seconds: 60, actor: "human:gui" });
    assert.equal(set.new_seconds, 60, "真实 owner 修改 goal 预算 60");
    invalidateBoardCache(l.h.root);
    l.care2.armForRoot(l.h.root);
    const t: any = l.task();
    assert.ok(t, "task still sampled");
    assert.equal(Number(t.effective_budget_seconds), 60, "当前生效预算 = 用户 60");
    assert.equal(t.budget_source, "goal", "当前预算来源 = goal");
    assert.ok(Number.isFinite(Number(t.budget_due_at)), "真实消息基准 + 新预算 ⇒ 可证预算截止");
    assert.ok(Number(t.budget_due_at) >= msgAt, "预算截止不得早于消息基准");
    assert.ok(Number(t.budget_due_at) <= Date.now() + 61_000, "预算截止 ≈ 消息基准 + 60s");
    l.h.fake.releaseAll();
    await waitFor(() => (l.h.childLive(l.childId) !== "running" ? true : null), "child stopped");
    await sleep(400);
    const mine = l.runs().filter((r: any) => r.child === l.childId);
    console.log("ATT010-B-RUNS", JSON.stringify(mine.map((r: any) => ({
      started_at: r.started_at, start_source: r.start_source, budget_seconds: r.budget_seconds,
      budget_source: r.budget_source, changes: r.budget_changes, deviation_ms: r.deviation_ms,
    }))));
    const unknownRuns = mine.filter((r: any) => r.started_at === null);
    assert.equal(unknownRuns.length, 1, "旧在途 run 恰一条未可证起点的历史");
    assertUnknownInitial(unknownRuns[0], "B");
  } finally { await l.shutdown(); }
});

test("g612 att010 C：旧轮idle后真实消息cold resume ⇒ 新run按可证起点+当时预算60，旧unknown不污染", async () => {
  const l = await legacyUpgrade();
  try {
    l.h.fake.releaseAll();
    await waitFor(() => (l.h.childLive(l.childId) !== "running" ? true : null), "old run natural idle");
    await sleep(200);
    const oldRun: any = l.runs().find((r: any) => r.child === l.childId);
    assertUnknownInitial(oldRun, "C-old");
    l.care2.armForRoot(l.h.root);
    assert.equal((l.status()?.tasks ?? []).some((t: any) => t.child === l.childId), false, "idle 后不再参与调度");
    const set = setGoalBudget(l.h.root, l.goal, { budget_seconds: 60, actor: "human:gui" });
    assert.equal(set.new_seconds, 60);
    invalidateBoardCache(l.h.root);
    const label = "ATT010-C cold resume msg";
    l.h.fake.hold(label);
    const msgAt = Date.now();
    const msgId = await l.h.subagents.sendMessage(l.h.parent, l.childId, [{ type: "text", text: label }], { signal: sig() });
    assert.ok(msgId, "真实 subagents.sendMessage accepted");
    await waitFor(() => (l.h.childLive(l.childId) === "running" ? true : null), "child cold-resumed running");
    await waitFor(() => (l.task() ? true : null), "new task sampled after cold resume");
    const nt: any = l.task();
    assert.equal(String(nt.child), l.childId, "same child");
    assert.equal(nt.attempt, l.attempt, "same attempt (no new dispatch)");
    assert.equal(Number(nt.effective_budget_seconds), 60, "新轮按当时生效 goal 预算 60");
    assert.equal(nt.budget_source, "goal", "新轮预算来源 goal");
    assert.ok(Number(nt.run_started_at) >= msgAt - 1000, "新轮起点由本次冷唤醒的真实 running 事件证明");
    assert.equal(nt.run_start_source, "agent_status", "新轮起点来源 = 真实 agent/status");
    const newStartedAt = Number(nt.run_started_at);
    l.h.fake.releaseAll();
    await waitFor(() => (l.h.childLive(l.childId) !== "running" ? true : null), "new run natural idle");
    await sleep(400);
    const mine = l.runs().filter((r: any) => r.child === l.childId);
    console.log("ATT010-C-RUNS", JSON.stringify(mine.map((r: any) => ({
      started_at: r.started_at, start_source: r.start_source, budget_seconds: r.budget_seconds,
      budget_source: r.budget_source, natural_ms: r.natural_ms, deviation_ms: r.deviation_ms,
    }))));
    assertUnknownInitial(mine.find((r: any) => r.started_at === null), "C-old-after");
    const fresh: any = mine.find((r: any) => r.started_at === newStartedAt);
    assert.ok(fresh, "新 run 必须按可证起点记录");
    assert.equal(fresh.budget_seconds, 60, "新 run 初始预算 = 冷唤醒时生效的 60");
    assert.equal(fresh.budget_source, "goal", "新 run 初始来源 = goal");
    assert.equal(fresh.start_source, "agent_status", "新 run 起点来源 = 真实 running 事件");
    assert.ok(Number(fresh.natural_ms) >= 0 && Number(fresh.natural_ms) < 15_000,
      `新 run 自然耗时不得拼入旧 unknown 轮（实得 ${fresh.natural_ms}）`);
    assert.equal(fresh.deviation_ms, Number(fresh.natural_ms) - 60_000, "新 run 偏差相对其起始 60s");
    assert.deepEqual(fresh.budget_changes, [], "新 run 初始即 60，无变化时间线");
  } finally { await l.shutdown(); }
});

test("g612 att010 D 正控：正常新任务起点可证 ⇒ initial 30/project_explicit 照旧记录", async () => {
  const h = await makeRealHost({ relativeRoot: true, projectYaml: PROJECT, sessionQuery: true });
  claimSupervisor(h.root, h.parent.id, "att010:fresh");
  const care = makeCare(h, "g612-fresh");
  care.start();
  try {
    const goal = await makeGoal(h, "g612 fresh run control");
    invalidateBoardCache(h.root);
    h.fake.hold("G612-FRESH-CHILD");
    const d: any = await h.dispatch(goal, "G612-FRESH-CHILD", { worktree: false });
    const childId = String(d.child_id ?? "");
    await waitFor(() => (h.childLive(childId) === "running" ? true : null), "fresh child running");
    care.armForRoot(h.root);
    const task = () => (care.statusFor(h.root)?.tasks ?? []).find((t: any) => t.child === childId) ?? null;
    await waitFor(() => (task() ? true : null), "fresh task sampled");
    assert.ok(Number(task().run_started_at) > 0, "正常新任务起点可证");
    assert.equal(Number(task().effective_budget_seconds), 30, "当前预算 = 项目默认 30");
    h.fake.releaseAll();
    await waitFor(() => (h.childLive(childId) !== "running" ? true : null), "fresh child stopped");
    await sleep(300);
    const run: any = (care.statusFor(h.root)?.runs ?? []).find((r: any) => r.child === childId);
    assert.ok(run, "正常 run 必须记录");
    assert.equal(run.budget_seconds, 30, "起点可证 ⇒ 初始预算 30 照旧记录（修复不误伤正控）");
    assert.equal(run.budget_source, "project_explicit", "初始来源 = 项目默认");
    assert.equal(run.start_source === "agent_status" || run.start_source === "attempt_record", true,
      `起点来源必须来自真实证据（实得 ${run.start_source}）`);
    assert.ok(Number(run.started_at) > 0);
    assert.ok(Number(run.natural_ms) >= 0 && Number(run.natural_ms) < 15_000);
    assert.equal(run.deviation_ms, Number(run.natural_ms) - 30_000, "偏差相对起点预算 30s");
    assert.equal(run.deviation_basis, "initial");
    assert.deepEqual(run.budget_changes, [], "无预算变更");
  } finally {
    try { care.dispose(); } catch {}
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch {}
  }
});
