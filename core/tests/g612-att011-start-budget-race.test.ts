/**
 * g-612 att-011：**真实运行起点预算竞态**（独立 review 在 att010 candidate ee0388 上实测的 BLOCK）。
 *
 * 真实正常单用户路径：goal 初始预算 30 → graph_start_attempt（真实 child `agent/status=running`，
 * start_exact=true）→ **首次 care 有效采样之前** owner 用公开 `graph_set_goal_budget` 改 60 →
 * 首次采样 → child 自然 idle → 公开 run 曾错误输出 `initial=60 / changes=[]`，把运行后的新预算
 * 冒称整轮起点（旧候选真实复现：reviewer probe-g5-ee.log；本文件 A 子测试在旧 dist 上真实断言红）。
 *
 * 断言语义（本文件即固定规则）：
 *   A 首采样前 owner 30→60：起点可证 ⇒ initial=30 + 一次真实变化的 60（值/来源/真实生效时点）；
 *     起点不可证 ⇒ initial/source/deviation 明确 unknown。**绝不允许 initial=60/changes=[]**。
 *   A2 首采样前连续两次真实修改 30→60→120（同秒）与 30→60→30（>1s）：initial 仍是 30，
 *     两次变化都按真实发生顺序/时点保留（不得压成一条或丢掉），时间线受 32 项上限/truncated 约束。
 *   B 正控：首采样发生在编辑前 ⇒ initial 30 + 变化 60 + deviation=natural−30s（修复不得误伤）。
 *   C 首采样之后 owner 真实 33 次修改：initial 30 + 最近 31 变化 + truncated=true；31/32 边界、
 *     同值重复不增变化、正常 dispose/recreate 逐字恢复。
 *   D 真实 05f 在途旧快照升级：旧轮 initial/source/deviation 仍 unknown（即便期间有真实消息/预算编辑），
 *     自然 idle 后真实主管 sendMessage 冷唤醒 ⇒ 新轮按可证起点 + 当时 budget 60，旧轮耗时不得拼入。
 *   E 默认来源（goal null 继承项目/全局）+ 运行中项目阈值变化：run 起点不得用采样时配置冒充；
 *     跨 goal/child/binding 历史不串。
 *   F 修复不改变关照语义：真实主管消息按当前预算重算基准、goal 编辑立即按最近基准重算；
 *     暂停冻结预算、恢复不提前触发、公开 budget_due_at 在暂停态如实 null。
 *
 * 边界：仅本树私有 workspace + 真实 0.2.1-rc.2 公开宿主栈（Context/AgentRegistry/AgentLoop/
 * LlmRuntime/SessionStore/SessionPersistence/SubagentRuntime）+ 进程内 fake adapter；不联网、
 * 不调真实 provider、不读用户 session/凭据/消息正文、不触主树 dist 或既有服务。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { appendEvent, readEvents } from "../events.ts";
import { invalidateBoardCache } from "../cache.ts";
import {
  claimSupervisor,
  closeWatchers,
  getCachedBoardPayload,
  readSupervisorSession,
  setGoalBudget,
  writeProjectConfig,
} from "../ops.ts";
import { createCareRuntime } from "../../dist/index.js";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sig = () => new AbortController().signal;
async function waitFor<T>(cond: () => T | null | Promise<T | null>, label: string, timeoutMs = 20000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const v = await cond(); if (v) return v as T; await sleep(10); }
  throw new Error(`等待超时：${label}`);
}

const PROJECT30 = `supervisor:\n  session: sess-super\n  care: "true"\n  care_threshold_seconds: 30\n  care_recheck_seconds: 3600\n`;

function setProjectThreshold(h: any, seconds: number) {
  writeProjectConfig(h.root, { supervisor: { care: "true", care_threshold_seconds: seconds, care_recheck_seconds: 3600 } }, "human:gui");
  invalidateBoardCache(h.root);
}

async function hostWith(projectYaml = PROJECT30) {
  return makeRealHost({ relativeRoot: true, projectYaml, sessionQuery: true });
}
const careOf = async (h: any) => (await h.tools.get("graph_get_settings").execute({}, { agent: h.parent, signal: sig() })).supervisor_care;
const taskOf = (st: any, childId: string) => (st.tasks ?? []).find((t: any) => t.child === childId) ?? null;
const runOf = (st: any, childId: string) => (st.runs ?? []).find((r: any) => r.child === childId) ?? null;
const setBudget = (h: any, goal: string, seconds: number | null) =>
  h.tools.get("graph_set_goal_budget").execute({ goal, budget_seconds: seconds }, { agent: h.parent, signal: sig() });

/** 真实派发并等待 child 真 running（期间**不**触发任何 care 采样）。 */
async function dispatchHeld(h: any, goal: string, marker: string) {
  h.fake.hold(marker);
  const d: any = await h.dispatch(goal, marker, { worktree: false });
  const childId = String(d.child_id ?? "");
  assert.ok(childId, "真实 child 必须已派发");
  await waitFor(() => (h.childLive(childId) === "running" ? true : null), "child running");
  return { childId, attempt: String(d.attempt ?? "att-001") };
}

async function stopAndRun(h: any, childId: string) {
  h.fake.releaseAll();
  await waitFor(() => (h.childLive(childId) !== "running" ? true : null), "child stopped");
  await sleep(250);
  return waitFor(async () => runOf(await careOf(h), childId), "run recorded");
}

/**
 * 起点断言（A/A2/D 的“绝不伪称”核心）：要么 initial 已知且成立，要么明确 unknown；
 * 任何情况下不得把运行后新值当作起点。
 */
function assertStartBudgetHonest(run: any, label: string) {
  assert.ok(run, `${label}: run 必须存在`);
  if (run.budget_seconds === null) {
    assert.equal(run.budget_source, "unknown", `${label}: 起点未知 ⇒ 来源必须 unknown`);
    assert.equal(run.deviation_ms, null, `${label}: 起点未知 ⇒ deviation 必须 null`);
    return;
  }
  assert.equal(typeof run.budget_seconds, "number", `${label}: initial 必须是已知整数或 null`);
  assert.ok(["goal", "project_explicit", "global_explicit", "global_default"].includes(run.budget_source),
    `${label}: 来源必须忠实（实得 ${run.budget_source}）`);
}

// ═════════════ A：首采样前 owner 30→60（reviewer BLOCK 主场景）═════════════
test("att011-A 真实 running 后、首次 care 采样前 owner 30→60：initial 必须 30（或 unknown），绝不 60/changes[]", async () => {
  const h = await hostWith();
  try {
    const goal = await makeGoal(h, "att011 A start budget race");
    claimSupervisor(h.root, h.parent.id, "att011:A");
    assert.equal((await setBudget(h, goal, 30) as any).new_seconds, 30, "goal 起点预算 30");
    const { childId } = await dispatchHeld(h, goal, "ATT011-A-CHILD");
    await waitFor(() => (h.childLive(childId) === "running" ? true : null), "child running");

    // 关键：在**第一次 care 采样之前**由真实 owner 把预算改到 60。
    const editAt = Date.now();
    assert.equal((await setBudget(h, goal, 60) as any).new_seconds, 60, "首采样前 owner 改 60");
    const editDoneAt = Date.now();

    const st: any = await waitFor(async () => {
      const s = await careOf(h);
      return taskOf(s, childId) ? s : null;
    }, "first care sampling");
    const t: any = taskOf(st, childId);
    assert.ok(Number(t.run_started_at) > 0, "真实 running 事件给出可证起点（startExact）");
    assert.equal(t.run_start_source, "agent_status", "起点来源 = 真实 agent/status");
    assert.equal(t.run_start_exact, true, "起点精确");
    assert.equal(Number(t.effective_budget_seconds), 60, "当前调度预算立即 = 60");
    assert.equal(t.budget_source, "goal", "当前来源 goal（唯一可编辑真源）");
    const startAt = Number(t.run_started_at);

    const run: any = await stopAndRun(h, childId);
    console.log("ATT011-A-RUN", JSON.stringify({
      startAt, started_at: run.started_at, start_source: run.start_source, start_exact: run.start_exact,
      initial: run.budget_seconds, source: run.budget_source, changes: run.budget_changes,
      truncated: run.budget_changes_truncated, natural: run.natural_ms, deviation: run.deviation_ms,
    }));
    assert.equal(Number(run.started_at), startAt, "run 起点 = 真实 running 事件时点");
    assertStartBudgetHonest(run, "A");
    assert.notEqual(run.budget_seconds, 60, "运行后新值 60 绝不能被冒称起点");
    if (run.budget_seconds !== null) {
      assert.equal(run.budget_seconds, 30, "起点可证 ⇒ initial=30");
      assert.equal(run.budget_source, "goal", "起点来源 goal");
      assert.deepEqual(run.budget_changes.map((c: any) => [c.seconds, c.source]), [[60, "goal"]],
        "运行中 60 必须作为真实变化出现（不是 changes=[]）");
      const at = Number(run.budget_changes[0].at);
      assert.ok(at >= editAt - 1 && at <= editDoneAt + 2_000,
        `变化时点必须是可证真实生效时点（edit≈${editAt}，实得 ${at}）`);
      assert.equal(Number(run.deviation_ms), Number(run.natural_ms) - 30_000, "deviation 相对起始 30s");
      assert.equal(run.deviation_basis, "initial");
      assert.equal(run.budget_changes_truncated, false, "单次已记录变化不标截断");
      assert.equal(run.budget_history_incomplete, false, "起点与变化都可证 ⇒ 历史完整");
    }
  } finally {
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch { /* ignore */ }
  }
});

// ═════════════ A2：首采样前连续两次修改（同秒 / >1s），不得压成一条或丢失 ═════════════
test("att011-A2 首采样前连续 30→60→120（同秒）与 30→60→30（>1s）：initial 30 + 两次真实变化有序", async () => {
  const h = await hostWith();
  try {
    // ── 场景 1：同秒两次修改 ──
    const goal1 = await makeGoal(h, "att011 A2 same-second");
    claimSupervisor(h.root, h.parent.id, "att011:A2");
    assert.equal((await setBudget(h, goal1, 30) as any).new_seconds, 30);
    const r1 = await dispatchHeld(h, goal1, "ATT011-A2-CHILD");
    const e1a = Date.now();
    assert.equal((await setBudget(h, goal1, 60) as any).new_seconds, 60);
    const e1b = Date.now();
    assert.equal((await setBudget(h, goal1, 120) as any).new_seconds, 120, "首采样前第二次真实修改");
    await waitFor(async () => taskOf(await careOf(h), r1.childId), "A2 first sampling");
    const run1: any = await stopAndRun(h, r1.childId);
    console.log("ATT011-A2-SAMESEC-RUN", JSON.stringify({
      initial: run1.budget_seconds, source: run1.budget_source, changes: run1.budget_changes,
      truncated: run1.budget_changes_truncated, e1a, e1b,
    }));
    assertStartBudgetHonest(run1, "A2-samesec");
    if (run1.budget_seconds !== null) {
      assert.equal(run1.budget_seconds, 30, "连续两次修改后起点仍是 30");
      assert.deepEqual(run1.budget_changes.map((c: any) => [c.seconds, c.source]),
        [[60, "goal"], [120, "goal"]], "两次真实修改都必须按顺序保留（不得压成一条最终值）");
      const [a1, a2] = run1.budget_changes.map((c: any) => Number(c.at));
      assert.ok(a1 >= e1a - 1 && a1 <= e1b + 2_000, `第一次变化时点可证（实得 ${a1}，e1a=${e1a}）`);
      assert.ok(a2 >= a1, "变化顺序必须是真实 append 顺序");
      assert.equal(run1.budget_changes_truncated, false, "两次变化未超上限");
      assert.equal(Number(run1.deviation_ms), Number(run1.natural_ms) - 30_000);
    }

    // ── 场景 2：30→60，>1s 后改回 30 ──
    const goal2 = await makeGoal(h, "att011 A2 revert");
    assert.equal((await setBudget(h, goal2, 30) as any).new_seconds, 30);
    const r2 = await dispatchHeld(h, goal2, "ATT011-A2-RESET");
    const e2a = Date.now();
    assert.equal((await setBudget(h, goal2, 60) as any).new_seconds, 60);
    await sleep(1_150);
    assert.equal((await setBudget(h, goal2, 30) as any).new_seconds, 30, "改回起点值也是一次真实修改");
    await waitFor(async () => taskOf(await careOf(h), r2.childId), "A2 revert first sampling");
    const run2: any = await stopAndRun(h, r2.childId);
    console.log("ATT011-A2-REVERT-RUN", JSON.stringify({
      initial: run2.budget_seconds, source: run2.budget_source, changes: run2.budget_changes,
      truncated: run2.budget_changes_truncated, e2a,
    }));
    assertStartBudgetHonest(run2, "A2-revert");
    if (run2.budget_seconds !== null) {
      assert.equal(run2.budget_seconds, 30, "起点仍是 30");
      assert.deepEqual(run2.budget_changes.map((c: any) => [c.seconds, c.source]),
        [[60, "goal"], [30, "goal"]], "改回 30 的变化不得丢（不能只看最终值）");
      const [b1, b2] = run2.budget_changes.map((c: any) => Number(c.at));
      assert.ok(b2 - b1 >= 1_000, `跨秒修改时点必须保留真实间隔（实得 ${b2 - b1}ms）`);
    }

    const st: any = await careOf(h);
    assert.equal(taskOf(st, r2.childId), null, "停止后任务移出调度");
  } finally {
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch { /* ignore */ }
  }
});

// ═════════════ B：正控（首采样早于编辑）═════════════
test("att011-B 正控：首采样在编辑前 ⇒ initial 30 + 变化 60 + 准确 deviation（修复不误伤）", async () => {
  const h = await hostWith();
  try {
    const goal = await makeGoal(h, "att011 B control");
    claimSupervisor(h.root, h.parent.id, "att011:B");
    assert.equal((await setBudget(h, goal, 30) as any).new_seconds, 30);
    const { childId } = await dispatchHeld(h, goal, "ATT011-B-CHILD");
    const t0: any = taskOf(await waitFor(async () => {
      const s = await careOf(h);
      return taskOf(s, childId) ? s : null;
    }, "pre-edit sampling"), childId);
    assert.equal(Number(t0.effective_budget_seconds), 30, "编辑前首采样 = 30");
    assert.equal(t0.budget_source, "goal");
    const startAt = Number(t0.run_started_at);
    assert.ok(startAt > 0);

    const editAt = Date.now();
    assert.equal((await setBudget(h, goal, 60) as any).new_seconds, 60);
    const t1: any = taskOf(await careOf(h), childId);
    assert.equal(Number(t1.effective_budget_seconds), 60, "编辑立即生效");
    assert.equal(Number(t1.budget_base_at), Number(t0.budget_base_at), "预算编辑不得伪造新基准");
    assert.equal(Number(t1.run_started_at), startAt, "预算编辑不改变 run 起点");

    const run: any = await stopAndRun(h, childId);
    console.log("ATT011-B-RUN", JSON.stringify({
      initial: run.budget_seconds, source: run.budget_source, changes: run.budget_changes,
      natural: run.natural_ms, deviation: run.deviation_ms,
    }));
    assert.equal(Number(run.started_at), startAt, "起点与采样时一致");
    assert.equal(run.budget_seconds, 30, "正控：initial 仍 30");
    assert.equal(run.budget_source, "goal");
    assert.deepEqual(run.budget_changes.map((c: any) => [c.seconds, c.source]), [[60, "goal"]]);
    const changeAt = Number(run.budget_changes[0].at);
    assert.ok(changeAt >= editAt - 1 && changeAt <= Date.now() + 1_000,
      `变化时点 ≈ 真实编辑（edit≈${editAt}，实得 ${changeAt}）`);
    assert.equal(Number(run.deviation_ms), Number(run.natural_ms) - 30_000);
    assert.equal(run.deviation_basis, "initial");
    assert.equal(run.budget_history_incomplete, false, "正控历史完整");
  } finally {
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch { /* ignore */ }
  }
});

// ═════════════ C：首采样之后的 33 次真实修改 / 31-32 边界 / 同值重复 / 重启 ═════════════
test("att011-C 首采样后 33 次真实 owner 修改：initial 30 + 最近31变化 + truncated；31/32 边界/同值/重启", async () => {
  {
    const h = await hostWith();
    let h2: any = null;
    try {
      const goal = await makeGoal(h, "att011 C 33 edits");
      claimSupervisor(h.root, h.parent.id, "att011:C");
      assert.equal((await setBudget(h, goal, 30) as any).new_seconds, 30);
      const { childId } = await dispatchHeld(h, goal, "ATT011-C-CHILD");
      await waitFor(async () => taskOf(await careOf(h), childId), "C first sampling");
      for (let i = 1; i <= 33; i += 1) {
        const next = i % 2 === 1 ? 60 : 120;
        assert.equal((await setBudget(h, goal, next) as any).new_seconds, next, `edit ${i}`);
        const s: any = await careOf(h);
        assert.ok(taskOf(s, childId), `edit ${i} 后仍采样`);
      }
      const budgetEvents = readEvents(h.root).filter((e: any) => e.event === "care.budget")
        .map((e: any) => ({ at: Number(e.details.at), seconds: Number(e.details.budget_seconds), source: e.details.budget_source }));
      assert.equal(budgetEvents.length, 33, "33 次真实编辑各一次公开生效事件");
      const run: any = await stopAndRun(h, childId);
      console.log("ATT011-C-RUN", JSON.stringify({
        initial: run.budget_seconds, source: run.budget_source, n: run.budget_changes.length,
        truncated: run.budget_changes_truncated, deviation: run.deviation_ms,
      }));
      assert.equal(run.budget_seconds, 30, "33 次修改后 initial 仍是 30");
      assert.equal(run.budget_source, "goal");
      assert.equal(run.budget_changes.length, 31, "有界：起点 + 最近 31 条变化");
      assert.equal(run.budget_changes_truncated, true, "超出上限必须如实标截断");
      assert.deepEqual(
        run.budget_changes.map((c: any) => [Number(c.at), Number(c.seconds), c.source]),
        budgetEvents.slice(-31).map((c: any) => [c.at, c.seconds, c.source]),
        "保留最近 31 条真实变化（时点/顺序/来源逐字一致）",
      );
      await h.shutdown();
      h2 = await makeRealHost({ workspace: h.ws, relativeRoot: true, sessionQuery: true, sessionId: "sess-super-2",
        projectYaml: PROJECT30.replace("sess-super", "sess-super-2") });
      const restored: any = runOf(await careOf(h2), childId);
      assert.ok(restored, "重启后 run 可读");
      assert.equal(restored.budget_seconds, 30);
      assert.equal(restored.budget_changes_truncated, true);
      assert.deepEqual(restored.budget_changes, run.budget_changes, "重启后时间线逐字保留");
    } finally {
      h.fake.releaseAll();
      if (h2) { try { h2.fake.releaseAll(); } catch {} try { await h2.shutdown(); } catch {} }
      closeWatchers();
      try { await h.shutdown(); } catch { /* ignore */ }
    }
  }
  {
    const h = await hostWith();
    try {
      const goal = await makeGoal(h, "att011 C 31 edits");
      claimSupervisor(h.root, h.parent.id, "att011:C31");
      assert.equal((await setBudget(h, goal, 30) as any).new_seconds, 30);
      const { childId } = await dispatchHeld(h, goal, "ATT011-C31-CHILD");
      await waitFor(async () => taskOf(await careOf(h), childId), "C31 first sampling");
      for (let i = 1; i <= 31; i += 1) { await setBudget(h, goal, i % 2 === 1 ? 60 : 120); await careOf(h); }
      const run: any = await stopAndRun(h, childId);
      console.log("ATT011-C31-RUN", JSON.stringify({ initial: run.budget_seconds, n: run.budget_changes.length, truncated: run.budget_changes_truncated }));
      assert.equal(run.budget_seconds, 30);
      assert.equal(run.budget_changes.length, 31, "31 次变化全部保留");
      assert.equal(run.budget_changes_truncated, false, "恰好 31 次不得谎称截断");
    } finally {
      h.fake.releaseAll(); closeWatchers(); try { await h.shutdown(); } catch {}
    }
  }
  {
    const h = await hostWith();
    try {
      const goal = await makeGoal(h, "att011 C 32 edits");
      claimSupervisor(h.root, h.parent.id, "att011:C32");
      assert.equal((await setBudget(h, goal, 30) as any).new_seconds, 30);
      const { childId } = await dispatchHeld(h, goal, "ATT011-C32-CHILD");
      await waitFor(async () => taskOf(await careOf(h), childId), "C32 first sampling");
      for (let i = 1; i <= 32; i += 1) { await setBudget(h, goal, i % 2 === 1 ? 60 : 120); await careOf(h); }
      const run: any = await stopAndRun(h, childId);
      console.log("ATT011-C32-RUN", JSON.stringify({ initial: run.budget_seconds, n: run.budget_changes.length, truncated: run.budget_changes_truncated }));
      assert.equal(run.budget_seconds, 30);
      assert.equal(run.budget_changes.length, 31, "32 次变化只保留最近 31 条");
      assert.equal(run.budget_changes_truncated, true, "32 次变化 ⇒ 如实标截断");
    } finally {
      h.fake.releaseAll(); closeWatchers(); try { await h.shutdown(); } catch {}
    }
  }
  {
    const h = await hostWith();
    try {
      const goal = await makeGoal(h, "att011 C same-value");
      claimSupervisor(h.root, h.parent.id, "att011:Csame");
      assert.equal((await setBudget(h, goal, 30) as any).new_seconds, 30);
      const { childId } = await dispatchHeld(h, goal, "ATT011-CSAME-CHILD");
      await waitFor(async () => taskOf(await careOf(h), childId), "Csame first sampling");
      await setBudget(h, goal, 60); await careOf(h);
      await setBudget(h, goal, 60); await careOf(h); // 同值幂等：不得新增变化
      await setBudget(h, goal, 120); await careOf(h);
      const run: any = await stopAndRun(h, childId);
      console.log("ATT011-CSAME-RUN", JSON.stringify({ initial: run.budget_seconds, changes: run.budget_changes, truncated: run.budget_changes_truncated }));
      assert.equal(run.budget_seconds, 30);
      assert.deepEqual(run.budget_changes.map((c: any) => [c.seconds, c.source]), [[60, "goal"], [120, "goal"]],
        "重复同值设置不新增变化");
      assert.equal(run.budget_changes_truncated, false);
    } finally {
      h.fake.releaseAll(); closeWatchers(); try { await h.shutdown(); } catch {}
    }
  }
});

// ═════════════ D：真实 05f 在途旧快照升级 + 冷唤醒新轮 ═════════════
const LEGACY_PROJECT = `supervisor:\n  session: sess-super\n  care: "false"\n  care_threshold_seconds: 30\n  care_recheck_seconds: 3600\n`;

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
function lastCareState(root: string): any {
  const evs = readEvents(root);
  for (let i = evs.length - 1; i >= 0; i -= 1) {
    const c = (evs[i] as any)?.details?.care_state;
    if (c && typeof c === "object") return c;
  }
  return null;
}
function toLegacy05fSnapshot(snapshot: any): any {
  const tasks = (Array.isArray(snapshot.tasks) ? snapshot.tasks : []).map((t: any) => {
    const { budgetSeconds, budgetBaseAt, budgetCountdown, budgetEffectiveSeconds, budgetEffectiveSource,
      runStartedAt, runStartSource, runStartExact, lastObservedAt, budgetHistory, budgetHistoryTruncated,
      cooldownDueAt, frozenCooldownRemainingMs, ...legacy } = t;
    return legacy;
  });
  const { runs, dormant, ...rest } = snapshot;
  return { ...rest, version: 1, tasks, inspections: [] };
}
function assertUnknownInitial(run: any, label: string) {
  assert.ok(run, `${label}: run 必须存在`);
  assert.equal(run.budget_seconds, null, `${label}: initial 必须 null（实得 ${run.budget_seconds}）`);
  assert.equal(run.budget_source, "unknown", `${label}: source 必须 unknown`);
  assert.equal(run.started_at, null, `${label}: 不可证起点必须 null`);
  assert.equal(run.start_source, "unknown", `${label}: start_source 必须 unknown`);
  assert.equal(run.deviation_ms, null, `${label}: deviation 必须 null`);
  assert.equal(run.natural_ms, null, `${label}: natural 必须 null`);
  assert.deepEqual(run.budget_changes, [], `${label}: 不得把后续观察冒充变化`);
  assert.equal(run.budget_history_incomplete, true, `${label}: 起点不可证 ⇒ 预算历史必须明确标不完整`);
}

test("att011-D 真实05f在途旧快照升级：旧轮仍 unknown；自然 idle 后真实消息冷唤醒 ⇒ 新轮按当时60", async () => {
  const h = await makeRealHost({ relativeRoot: true, projectYaml: LEGACY_PROJECT, sessionQuery: true });
  const care = makeCare(h, "att011-legacy-1");
  let care2: any = null;
  try {
    claimSupervisor(h.root, h.parent.id, "att011:D");
    care.start();
    const goal = await makeGoal(h, "att011 D legacy run");
    invalidateBoardCache(h.root);
    const { childId } = await dispatchHeld(h, goal, "ATT011-D-CHILD");
    care.armForRoot(h.root);
    const task1 = () => (care.statusFor(h.root)?.tasks ?? []).find((t: any) => t.child === childId) ?? null;
    await waitFor(() => task1(), "task sampled");
    assert.equal(care.control(h.root, "pause").ok, true, "pause ok");
    const snap = lastCareState(h.root);
    assert.ok(snap && Array.isArray(snap.tasks) && snap.tasks.length > 0, "真实 paused care_state");
    const legacy = toLegacy05fSnapshot(snap);
    appendEvent(h.root, { actor: "system:att011-legacy-fixture", event: "care.pause", details: { care_state: legacy } });
    care.dispose();

    care2 = makeCare(h, "att011-legacy-2");
    care2.start();
    care2.armForRoot(h.root);
    assert.equal(care2.control(h.root, "resume").ok, true, "resume ok");
    care2.armForRoot(h.root);
    const status = () => care2.statusFor(h.root);
    const task = () => (status()?.tasks ?? []).find((t: any) => t.child === childId) ?? null;
    await waitFor(() => task(), "legacy task restored");
    assert.equal(Number(task().effective_budget_seconds), 30, "当前调度仍按项目默认 30（unknown ≠ 停止关照）");
    assert.equal(task().run_started_at, null, "升级后旧 run 起点未知");
    assert.equal(task().run_start_source, "unknown");

    // 旧在途 run 期间真实消息 + 真实 goal 预算 60：当前调度生效，但历史 initial 仍 unknown。
    const msgId = await h.subagents.sendMessage(h.parent, childId, [{ type: "text", text: "ATT011-D supervisor msg" }], { signal: sig() });
    assert.ok(msgId, "真实 sendMessage accepted");
    await sleep(100);
    care2.armForRoot(h.root);
    await waitFor(() => task(), "task after message");
    assert.equal(setGoalBudget(h.root, goal, { budget_seconds: 60, actor: "human:gui" }).new_seconds, 60);
    invalidateBoardCache(h.root);
    care2.armForRoot(h.root);
    await waitFor(() => (Number(task()?.effective_budget_seconds) === 60 ? true : null), "effective 60");

    h.fake.releaseAll();
    await waitFor(() => (h.childLive(childId) !== "running" ? true : null), "old run natural idle");
    await sleep(300);
    const oldRun: any = (status()?.runs ?? []).find((r: any) => r.child === childId);
    console.log("ATT011-D-OLD-RUN", JSON.stringify(oldRun ? {
      initial: oldRun.budget_seconds, source: oldRun.budget_source, start: oldRun.started_at,
      deviation: oldRun.deviation_ms, changes: oldRun.budget_changes,
    } : null));
    assertUnknownInitial(oldRun, "D-old");
    care2.armForRoot(h.root);
    assert.equal((status()?.tasks ?? []).some((t: any) => t.child === childId), false, "idle 后不再调度");

    // 自然 idle 后真实主管消息冷唤醒：新轮起点由真实 running 事件证明，初始 = 当时 60。
    const label = "ATT011-D cold resume";
    h.fake.hold(label);
    const wakeAt = Date.now();
    const msgId2 = await h.subagents.sendMessage(h.parent, childId, [{ type: "text", text: label }], { signal: sig() });
    assert.ok(msgId2, "cold resume message accepted");
    await waitFor(() => (h.childLive(childId) === "running" ? true : null), "cold resumed running");
    await waitFor(() => task(), "new task sampled");
    const nt: any = task();
    assert.equal(String(nt.child), childId);
    assert.equal(Number(nt.run_started_at) >= wakeAt - 1_000, true, "新轮起点来自本次真实 running");
    assert.equal(nt.run_start_source, "agent_status");
    const newStart = Number(nt.run_started_at);

    h.fake.releaseAll();
    await waitFor(() => (h.childLive(childId) !== "running" ? true : null), "new run idle");
    await sleep(300);
    const mine = (status()?.runs ?? []).filter((r: any) => r.child === childId);
    assertUnknownInitial(mine.find((r: any) => r.started_at === null), "D-old-after");
    const fresh: any = mine.find((r: any) => r.started_at === newStart);
    console.log("ATT011-D-NEW-RUN", JSON.stringify(fresh ? {
      initial: fresh.budget_seconds, source: fresh.budget_source, start_source: fresh.start_source,
      natural: fresh.natural_ms, deviation: fresh.deviation_ms, changes: fresh.budget_changes,
    } : null));
    assert.ok(fresh, "新轮必须按可证起点记录");
    assert.equal(fresh.budget_seconds, 60, "新轮初始 = 冷唤醒时生效的 60");
    assert.equal(fresh.budget_source, "goal");
    assert.equal(fresh.start_source, "agent_status");
    assert.ok(Number(fresh.natural_ms) >= 0 && Number(fresh.natural_ms) < 15_000,
      `新轮自然耗时不得拼入旧 unknown 轮（实得 ${fresh.natural_ms}）`);
    assert.equal(Number(fresh.deviation_ms), Number(fresh.natural_ms) - 60_000);
    assert.deepEqual(fresh.budget_changes, [], "新轮初始即 60，无变化时间线");
  } finally {
    try { care2?.dispose(); } catch {}
    try { care.dispose(); } catch {}
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch {}
  }
});

// ═════════════ E：默认来源 / 运行中项目阈值变化 / 跨 goal 不串 ═════════════
test("att011-E 默认来源忠实 + 运行中项目阈值变化不冒充起点 + 跨 goal 历史不串", async () => {
  const h = await hostWith();
  try {
    claimSupervisor(h.root, h.parent.id, "att011:E");
    // E1：goal 未设预算 ⇒ 项目默认 30；运行中项目阈值改 60 ⇒ 起点仍 30/project_explicit。
    const g1 = await makeGoal(h, "att011 E project default");
    const r1 = await dispatchHeld(h, g1, "ATT011-E1-CHILD");
    await waitFor(async () => taskOf(await careOf(h), r1.childId), "E1 first sampling");
    const t1: any = taskOf(await careOf(h), r1.childId);
    assert.equal(Number(t1.effective_budget_seconds), 30, "继承项目 30");
    assert.equal(t1.budget_source, "project_explicit", "来源 = 项目显式");
    assert.equal(t1.budget_seconds, null, "goal 未覆盖");
    setProjectThreshold(h, 60);
    await waitFor(async () => Number(taskOf(await careOf(h), r1.childId)?.effective_budget_seconds) === 60, "E1 project 60");

    // E2：另一 goal 显式 120；运行中清空回继承 ⇒ 起点仍 120/goal。
    const g2 = await makeGoal(h, "att011 E clear inherit");
    assert.equal((await setBudget(h, g2, 120) as any).new_seconds, 120);
    const r2 = await dispatchHeld(h, g2, "ATT011-E2-CHILD");
    await waitFor(async () => taskOf(await careOf(h), r2.childId), "E2 first sampling");
    const t2: any = taskOf(await careOf(h), r2.childId);
    assert.equal(Number(t2.effective_budget_seconds), 120);
    assert.equal(t2.budget_source, "goal");
    assert.equal((await setBudget(h, g2, null) as any).new_seconds, null, "清空回继承");
    await waitFor(async () => Number(taskOf(await careOf(h), r2.childId)?.effective_budget_seconds) === 60, "E2 inherit 60");

    // 只有 g1 的起点受项目变化影响；两 goal 的 run 历史各自独立。
    const run1: any = await stopAndRun(h, r1.childId);
    console.log("ATT011-E1-RUN", JSON.stringify({ initial: run1.budget_seconds, source: run1.budget_source, changes: run1.budget_changes, truncated: run1.budget_changes_truncated }));
    assert.equal(run1.budget_seconds, 30, "项目阈值在 run 起点后变化 ⇒ 起点仍是 30");
    assert.equal(run1.budget_source, "project_explicit", "起点来源 project_explicit（不是运行后的 goal）");
    assert.deepEqual(run1.budget_changes.map((c: any) => [c.seconds, c.source]), [[60, "project_explicit"]],
      "运行中项目阈值变化作为真实可见变化记录");
    const run2: any = await stopAndRun(h, r2.childId);
    console.log("ATT011-E2-RUN", JSON.stringify({ initial: run2.budget_seconds, source: run2.budget_source, changes: run2.budget_changes }));
    assert.equal(run2.budget_seconds, 120, "g2 起点仍是显式 120");
    assert.equal(run2.budget_source, "goal");
    assert.deepEqual(run2.budget_changes.map((c: any) => [c.seconds, c.source]), [[60, "project_explicit"]],
      "g2 清空后的生效值来自项目默认（独立时间线，未与 g1 串）");
    assert.notEqual(run1.budget_seconds, run2.budget_seconds, "不同 goal 的起点不互相污染");
  } finally {
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch {}
  }
});

// ═════════════ F：关照语义未被修复改变 ═════════════
test("att011-F 消息/预算编辑即时重算 + 暂停冻结预算 + 暂停态 budget_due_at 如实 null", async () => {
  const h = await makeRealHost({ relativeRoot: true, projectYaml: PROJECT30, sessionQuery: true, http: true });
  try {
    const goal = await makeGoal(h, "att011 F care semantics");
    claimSupervisor(h.root, h.parent.id, "att011:F");
    assert.equal((await setBudget(h, goal, 30) as any).new_seconds, 30);
    const { childId } = await dispatchHeld(h, goal, "ATT011-F-CHILD");
    const t0: any = taskOf(await waitFor(async () => {
      const s = await careOf(h);
      return taskOf(s, childId) ? s : null;
    }, "F first sampling"), childId);
    const base0 = Number(t0.budget_base_at);
    assert.ok(base0 > 0);

    // 真实主管消息：以当时预算重置基准（不改变 run 起点）。
    const msgAt = Date.now();
    const msgId = await h.subagents.sendMessage(h.parent, childId, [{ type: "text", text: "ATT011-F steer" }], { signal: sig() });
    assert.ok(msgId);
    await sleep(50);
    const t1: any = taskOf(await careOf(h), childId);
    assert.ok(Number(t1.budget_base_at) >= msgAt - 1_000, "消息建立新基准");
    assert.ok(Number(t1.budget_base_at) > base0);
    assert.equal(Number(t1.effective_budget_seconds), 30, "消息按当前预算 30");
    assert.equal(Number(t1.run_started_at), Number(t0.run_started_at), "消息不改变 run 起点");

    // goal 预算编辑：立即按最近基准 + 新预算重算。
    assert.equal((await setBudget(h, goal, 60) as any).new_seconds, 60);
    await sleep(30);
    const t2: any = taskOf(await careOf(h), childId);
    assert.equal(Number(t2.effective_budget_seconds), 60);
    assert.equal(Number(t2.budget_base_at), Number(t1.budget_base_at), "预算编辑不伪造消息基准");
    assert.ok(Number(t2.dueAt) > Number(t2.budget_base_at), "due 必须晚于基准");

    // 真实 owner HTTP pause：预算冻结、公开 budget_due_at 如实 null，next_due 无倒计时。
    const cookie = h.http.mintOwnerCookie();
    const paused = await h.http.request("POST", "/api/dsh-graph/care/control", { cookie }, {
      action: "pause", workspace: h.ws, request_id: "att011-f-pause",
    });
    assert.equal(paused.status, 200, `真实 owner pause 成功：${JSON.stringify(paused.body)}`);
    const st: any = await careOf(h);
    assert.equal(st.paused, true, "paused=true");
    assert.ok(Number(st.paused_remaining_ms) > 0, "冻结剩余预算可见");
    const tp: any = taskOf(st, childId);
    assert.equal(tp.budget_due_at, null, "暂停态独立预算截止如实 null（不伪造未来时刻）");
    assert.equal(Number(tp.effective_budget_seconds), 60, "暂停不改变预算时长");

    const resumed = await h.http.request("POST", "/api/dsh-graph/care/control", { cookie }, {
      action: "resume", workspace: h.ws, request_id: "att011-f-resume",
    });
    assert.equal(resumed.status, 200, `真实 owner resume 成功：${JSON.stringify(resumed.body)}`);
    const st2: any = await careOf(h);
    assert.equal(st2.paused, false);
    assert.equal(Number(taskOf(st2, childId)?.effective_budget_seconds), 60, "恢复后预算时长仍可见");

    const run: any = await stopAndRun(h, childId);
    console.log("ATT011-F-RUN", JSON.stringify({ initial: run.budget_seconds, source: run.budget_source, changes: run.budget_changes }));
    assert.equal(run.budget_seconds, 30, "历史起点仍是 30（消息/编辑不改写历史）");
    assert.deepEqual(run.budget_changes.map((c: any) => [c.seconds, c.source]), [[60, "goal"]]);
  } finally {
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch {}
  }
});

// ═════════════ D2：起点不可证的轮次里真实 goal 编辑不得被静默丢成“未变更” ═════════════
test("att011-D2 起点不可证（观察晚于 run 起点）+ 真实 owner 编辑 ⇒ initial unknown、变化如实留痕且标历史不完整", async () => {
  const h = await makeRealHost({ relativeRoot: true, projectYaml: LEGACY_PROJECT, sessionQuery: true });
  const care = makeCare(h, "att011-late");
  try {
    claimSupervisor(h.root, h.parent.id, "att011:D2");
    const goal = await makeGoal(h, "att011 D2 late observation");
    // 先让真实 child 进入 running，再启动关照 runtime ⇒ run 起点/起点预算都不可证（真实正常路径）。
    const { childId } = await dispatchHeld(h, goal, "ATT011-D2-CHILD");
    care.start();
    care.armForRoot(h.root);
    const status = () => care.statusFor(h.root);
    const task = () => (status()?.tasks ?? []).find((t: any) => t.child === childId) ?? null;
    await waitFor(() => task(), "late task sampled");
    assert.equal(task().run_started_at, null, "起点不可证 ⇒ run_started_at null");
    assert.equal(task().run_start_source, "unknown", "起点来源 unknown");
    assert.equal(Number(task().effective_budget_seconds), 30, "当前调度仍按项目默认 30");

    // 真实 owner 通过公开 goal 预算入口编辑（生产顺序：先写 goal 真源，再通知关照 runtime）。
    const notifyAt = Date.now();
    assert.equal(setGoalBudget(h.root, goal, { budget_seconds: 60, actor: "human:gui" }).new_seconds, 60);
    invalidateBoardCache(h.root);
    const notified = care.notifyGoalBudgetChanged(h.root, goal, 60);
    assert.equal(notified.ok, true);
    assert.equal(Number(task()?.effective_budget_seconds), 60, "当前调度立即按新预算 60");

    h.fake.releaseAll();
    await waitFor(() => (h.childLive(childId) !== "running" ? true : null), "child stopped");
    await sleep(300);
    const run: any = (status()?.runs ?? []).find((r: any) => r.child === childId);
    console.log("ATT011-D2-RUN", JSON.stringify(run ? {
      initial: run.budget_seconds, source: run.budget_source, start: run.started_at,
      deviation: run.deviation_ms, changes: run.budget_changes, truncated: run.budget_changes_truncated,
      incomplete: run.budget_history_incomplete,
    } : null));
    assert.ok(run, "run 必须存在");
    assert.equal(run.budget_seconds, null, "起点预算不可证 ⇒ initial 必须 null（不得用当前 60 回填）");
    assert.equal(run.budget_source, "unknown", "来源 unknown");
    assert.equal(run.started_at, null, "起点 null");
    assert.equal(run.deviation_ms, null, "deviation null");
    assert.deepEqual(run.budget_changes.map((c: any) => [c.seconds, c.source]), [[60, "goal"]],
      "真实发生的 goal 编辑必须如实留痕（不得静默 changes=[]）");
    const at = Number(run.budget_changes[0].at);
    assert.ok(at >= notifyAt - 1_000 && at <= Date.now() + 1_000, `变化时点是真实通知时点（实得 ${at}）`);
    assert.equal(run.budget_history_incomplete, true, "起点缺失 ⇒ 必须明确标历史不完整");
    assert.equal(run.budget_changes_truncated, false, "未超上限：截断标志不得被借用");
  } finally {
    try { care.dispose(); } catch {}
    h.fake.releaseAll();
    closeWatchers();
    try { await h.shutdown(); } catch {}
  }
});
