/**
 * g-506 返工 att-004（联合候选）：**同一现场**的真实宿主联合回归 —— g505 保活 × g506 关照 × g610 单活。
 *
 * 为什么需要这个文件：g610 的单活/管理保护与 g506 的关照调度此前各自有自己的真实宿主套件，
 * 「拼两个单测」不能证明它们在同一真实 Context/Registry/AgentLoop/SubagentRuntime 上不会互相
 * 把对方的状态判错。本文件把三者放进**同一个**真实 0.2.1-rc.2 宿主栈 + fake adapter + 假时钟：
 *
 *   ① 真实 `graph_claim_supervisor` 成功 claim 后，关照运行时由**自然 turn-end 事件**自举布防
 *      （不手工 sweep / 不读设置页 / 不调 armForRoot），假时钟到期由服务自身 timer 投递**恰好一次**
 *      真实 `agent.send`（source.kind = dsh-graph-care）；
 *   ② 同一 goal 的第二个 `graph_start_attempt` 在已绑定运行中 child 时被 g610 拒绝且零新 attempt；
 *      running child 时 `graph_postpone_goal` 被 g610 拒绝且零移动（管理保护不误伤 g506 已绑定场景）；
 *   ③ g505 保活运行时在同一 workspace 观察到的 care 消息**不是 human 活动**，保活 sweep 不产生关照；
 *   ④ g610 的 `dispatch_in_flight`/attempt 新状态不会让 g506 视为「无任务」：真实 boardPayload 的
 *      attempt_binding 仍被采样，`next_due_at`/`tasks[]` 如实投影；
 *   ⑤ 已投递巡检的 `unknown` 回传不递增 no-progress；连续 3 次未获有效结论后转入等待人工，
 *      不再发出第 4 次自动提醒；重置不清人工锁，dispose + 重建后锁仍在（事件持久）；
 *   ⑥ 子代理自然结束后，派发与管理动作按既有 human gate 恢复（postpone→move→重新派发）；
 *   ⑦ 私有 workspace 的晚 claim：apply 内部**真实**关照运行时在 claim 工具后由真实 timer 投递，
 *      窄工具 `graph_care_outcome` 真实受理 unknown，另一个私有 workspace 的看板零串扰。
 *
 * 边界：不联网、不访问真实 provider / 3110 / 主树 dist；不读凭据；所有 tmp 落在本树 tmp/ 内。
 * 真实模型判断、真实 interrupt/续轮干预、GUI 视觉仍未验证（另行授权）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

import {
  CRITERIA_VERIFIED_MARK,
  bindAttemptChild,
  setGoalDescription,
  startAttempt,
  transition,
  closeWatchers,
  createGoal,
  findGoalFile,
  getCachedBoardPayload,
  goalDetail,
  init,
  readProjectConfig,
  readSupervisorSession,
  setCriteria,
  writeProjectConfig,
} from "../ops.ts";
import { appendEvent, readEvents } from "../events.ts";
import { invalidateBoardCache } from "../cache.ts";
import { createCareRuntime, createKeepAliveRuntime } from "../../dist/index.js";
import { makeRealHost } from "./_g610-real-host.ts";

// ───────────────────────────── 私有 tmp（只用本树 tmp/） ─────────────────────────────
const TMP_BASE = realpathSync((() => {
  const p = join(process.cwd(), "tmp");
  mkdirSync(p, { recursive: true });
  return p;
})());
const OWNED: string[] = [];
function ownedDir(tag: string): string {
  const dir = mkdtempSync(join(TMP_BASE, `g506comb-${tag}-`));
  OWNED.push(dir);
  return dir;
}
test.after(() => {
  try { closeWatchers(); } catch { /* ignore */ }
  for (const dir of OWNED.splice(0)) {
    const real = (() => { try { return realpathSync(dir); } catch { return null; } })();
    if (!real || !real.startsWith(TMP_BASE + sep)) continue; // 绝不清理 tmp 外的路径
    try { rmSync(real, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ───────────────────────────── 假时钟 / 假定时器（与既有 g506 套件同口径） ─────────────────────────────
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, label: string, timeoutMs = 6000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(20);
  }
  assert.fail(`等待超时：${label}`);
}
/** 真实 agent/status turn-end 事件（生产自举触发点，不用手工 emit）。 */
function onceIdle(h: any, agent: any, timeoutMs = 6000) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { off?.(); reject(new Error("agent idle timeout")); }, timeoutMs);
    const off = h.ctx.on("agent/status", (p: any) => {
      if (p?.agent?.id !== agent.id || p?.status !== "idle") return;
      clearTimeout(timer); off?.(); resolve();
    });
  });
}
async function runTurn(h: any, agent: any, text: string) {
  const msg = h.modules.llm.createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
  const idle = onceIdle(h, agent);
  agent.send(msg, "next-turn", true);
  await idle;
}
function runTool(h: any, name: string, args: any, agent: any) {
  return h.tools.get(name).execute(args, { agent, signal: new AbortController().signal });
}
function makeGoalIn(root: string, title: string, version: string) {
  const goal = createGoal(root, { title, version, type: "task", actor: "human:gui" });
  setCriteria(root, goal, [`判据：联合真实宿主路径 ${CRITERIA_VERIFIED_MARK}`], "human:gui");
  return goal;
}
function trackSends(agent: any) {
  const sent: any[] = [];
  const orig = agent.send.bind(agent);
  agent.send = (message: any, ...rest: any[]) => { sent.push(message); return orig(message, ...rest); };
  return sent;
}

/**
 * 手工关照运行时（假时钟）：与生产 apply 内运行时**同一实现**（`createCareRuntime`），
 * 仅注入 fake clock / 受控项目阈值。真实项目阈值保持 300s，使 apply 内的真实 timer 在测试
 * 窗口内保持惰性（不会与假时钟运行时双投递）。
 */
function makeCare(host: any, opts: {
  clock: ReturnType<typeof fakeClock>;
  scheduler: ReturnType<typeof fakeScheduler>;
  root: string;
  ws: string;
  idPrefix: string;
  projectConfig?: (root: string) => any;
  appendEventFn?: (root: string, ev: any) => any;
  agents?: any;
}) {
  const runtime = createCareRuntime({
    ctx: {
      on: (name: string, h: any) => host.ctx.on(name, h),
      get: (name: string) => (name === "agents" ? (opts.agents ?? host.reg) : name === "llm" ? host.llm : name === "subagents" ? host.subagents : undefined),
    },
    readGlobal: () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: true, raw: "on" }),
    resolveRoot: (ws: string) => join(ws, ".dsh-graph"),
    defaultWorkspace: () => opts.ws,
    readProjectConfigFn: opts.projectConfig ?? ((root: string) => (root === opts.root
      ? { supervisor: { care: true, care_threshold_seconds: 30, care_recheck_seconds: 300 } }
      : { supervisor: { care: false } })),
    readSupervisorSessionFn: (root: string) => readSupervisorSession(root),
    readBoardPayload: (root: string) => {
      try { return getCachedBoardPayload(root, { lazy: true })?.payload ?? null; } catch { return null; }
    },
    now: opts.clock.now,
    setTimeoutFn: opts.scheduler.setTimeoutFn,
    clearTimeoutFn: opts.scheduler.clearTimeoutFn,
    appendEventFn: opts.appendEventFn ?? ((root: string, ev: any) => appendEvent(root, ev)),
    makeInspectionId: (() => { let i = 0; return () => `${opts.idPrefix}-${++i}`; })(),
    log: () => {},
  });
  return runtime;
}
function makeKeep(host: any, opts: {
  clock: ReturnType<typeof fakeClock>;
  scheduler: ReturnType<typeof fakeScheduler>;
  ws: string;
}) {
  return createKeepAliveRuntime({
    ctx: {
      on: (name: string, h: any) => host.ctx.on(name, h),
      get: (name: string) => (name === "agents" ? host.reg : name === "llm" ? host.llm : name === "subagents" ? host.subagents : undefined),
    },
    readGlobal: () => ({ enabled: true, malformed: false, available: true, raw: "on" }),
    resolveRoot: (ws: string) => join(ws, ".dsh-graph"),
    defaultWorkspace: () => opts.ws,
    readProjectConfigFn: (root: string) => {
      try { return readProjectConfig(root); } catch { return null; }
    },
    readSupervisorSessionFn: (root: string) => readSupervisorSession(root),
    now: opts.clock.now,
    setTimeoutFn: opts.scheduler.setTimeoutFn,
    clearTimeoutFn: opts.scheduler.clearTimeoutFn,
    log: () => {},
  });
}

for (const window of ['append-eio', 'disposed', 'sampling']) {
  for (const outcome of ['progress', 'no-progress', 'unknown']) {
    test(`g628 ${window} persisted inspection rejects ${outcome}`, async () => {
      const h = await makeRealHost({ relativeRoot: true, sessionQuery: true, skipApply: true });
      const clock = fakeClock(); const scheduler = fakeScheduler(clock); const sup = h.parent;
      const sent = trackSends(sup); let failures = 0; let unavailable = false; let sampleFailures = 0; let sampleTaskFailures = 0; let childId = '';
      const agents = new Proxy(h.reg, { get(target, prop) {
        if (prop === 'get') return (id: string) => { if (unavailable && id === childId) { sampleFailures++; const error = new Error('injected registry unavailable'); if (/\bsampleTasks\b/.test(error.stack ?? '')) sampleTaskFailures++; throw error; } return target.get(id); };
        const value = Reflect.get(target, prop, target); return typeof value === 'function' ? value.bind(target) : value;
      } });
      let care = makeCare(h, { clock, scheduler, root: h.root, ws: h.ws, agents, idPrefix: `${window}-${outcome}`, appendEventFn: (root, ev) => {
        if (window === 'append-eio' && ev.event === 'care.inspection.expired') { failures++; throw Object.assign(new Error('injected EIO'), { code: 'EIO' }); }
        return appendEvent(root, ev);
      } });
      let restarted: any;
      try {
        assert.equal(JSON.parse(readFileSync(join(h.modules.S, '..', '..', 'package.json'), 'utf8')).version, '0.2.2-rc.3');
        const goal = makeGoalIn(h.root, `window ${window} ${outcome}`, 'v1.0');
        setGoalDescription(h.root, goal, 'real managed child binding', 'human:gui');
        transition(h.root, goal, 'ready', { actor: 'human:gui' });
        transition(h.root, goal, 'in_progress', { actor: 'human:gui' });
        const attempt = startAttempt(h.root, goal, { executor: 'spawn', actor: 'human:gui' });
        h.fake.hold('fixture child');
        const spawned = await h.startChild('window');
        const d = { child_id: spawned.childId, attempt }; childId = d.child_id;
        bindAttemptChild(h.root, goal, attempt, d.child_id, 'human:gui', sup.id);
        await waitFor(() => h.childLive(d.child_id) === 'running', 'managed child running');
        care.start(); care.armForRoot(h.root); await runTurn(h, sup, 'sample window child');
        const initial: any = care.statusFor(h.root);
        await scheduler.advanceTo(Number(initial.next_due_at) + 1000);
        const inspection = readEvents(h.root).filter((e: any) => e.event === 'care.inspection').at(-1)?.details?.inspection;
        assert.ok(inspection); await waitFor(() => sup.status === 'idle', 'inspection delivered');
        const lastSnapshot = () => readEvents(h.root).filter((e: any) => e.details?.care_state).at(-1)?.details?.care_state;
        assert.equal(lastSnapshot().root, h.root);
        const issued = lastSnapshot().inspections.find((i: any) => i.id === inspection);
        assert.equal(issued.status, 'queued');
        assert.deepEqual(issued.targets.map((t: any) => [t.goal, t.attempt, t.child]), [[goal, attempt, d.child_id]]);
        if (window === 'disposed') care.dispose();
        if (window === 'sampling') unavailable = true;
        h.fake.releaseAll(); await waitFor(() => h.childLive(d.child_id) === 'gone', 'child gone');
        if (window === 'append-eio') {
          await waitFor(() => failures > 0, 'expiry EIO injection');
          assert.equal(care.entryOfRoot(h.root).inspections.get(inspection).status, 'expired');
          const lastCare = readEvents(h.root).filter((e: any) => e.details?.care_state).at(-1);
          assert.equal(lastCare.event, 'care.run');
          assert.equal(lastCare.details.care_state.inspections.find((i: any) => i.id === inspection).status, 'claimed');
          assert.equal(readEvents(h.root).filter((e: any) => e.event === 'care.inspection.expired').length, 0);
          care.dispose();
        }
        if (window === 'sampling') {
          assert.ok(sampleFailures > 0, 'registry lookup must fail during natural child termination');
          care.statusFor(h.root);
          assert.ok(sampleTaskFailures > 0, 'sampleTasks registry_error branch must actually be reached');
          unavailable = false;
          care.dispose();
        }
        assert.equal(lastSnapshot().inspections.find((i: any) => i.id === inspection).status, window === 'disposed' ? 'queued' : 'claimed');
        await h.reg.resume({ resumeSessionId: d.child_id, agentOptions: { provider: 'fake', model: 'fake-model' } });
        const resumed = h.reg.get(d.child_id);
        assert.throws(() => h.subagents.rootOf(resumed), /active runtime owner|UNAUTHORIZED/);
        h.fake.hold('WINDOW-RESUME');
        resumed.send(h.modules.llm.createUserMessage({ content: [{ type: 'text', text: 'WINDOW-RESUME' }], source: { kind: 'user' } }), 'next-turn', true);
        await waitFor(() => resumed.status === 'running', 'resumed running');
        restarted = makeCare(h, { clock, scheduler, root: h.root, ws: h.ws, idPrefix: 'restart' });
        restarted.start(); restarted.armForRoot(h.root);
        const recovered = restarted.entryOfRoot(h.root).inspections.get(inspection);
        assert.ok(recovered, 'reconstructed runtime must retain the actual inspection');
        // loadCareState normalizes persisted queued to delivered on recovery.
        assert.equal(recovered.status, window === 'disposed' ? 'delivered' : 'claimed');
        const before = structuredClone(restarted.statusFor(h.root));
        const entry = restarted.entryOfRoot(h.root);
        const outcomeState = () => structuredClone({ tasks: [...entry.tasks.values()], group: entry.group, lastOutcome: entry.lastOutcome, inspection: entry.inspections.get(inspection) });
        const beforeOutcome = outcomeState();
        const events = readEvents(h.root).filter((e: any) => e.event === 'care.outcome'); const inbox = sent.length;
        const result = restarted.submitOutcome({ root: h.root, supervisor: sup.id, inspection, goal, attempt: d.attempt, child: d.child_id, outcome, evidence: 'stale real inspection' });
        assert.deepEqual(result, { ok: false, code: 'ownership_unknown' });
        assert.deepEqual(restarted.statusFor(h.root), before);
        assert.deepEqual(outcomeState(), beforeOutcome, 'outcome must not change counts, lock, budgets or inspection');
        assert.deepEqual(readEvents(h.root).filter((e: any) => e.event === 'care.outcome'), events);
        assert.equal(sent.length, inbox);
      } finally { care.dispose(); restarted?.dispose(); h.fake.releaseAll(); await h.shutdown(); }
    });
  }
}

for (const outcome of ["progress", "no-progress", "unknown"]) {
  test(`g628 issued inspection rejects independently resumed child: ${outcome}`, async () => {
    const h = await makeRealHost({ relativeRoot: true, sessionQuery: true, projectYaml: "supervisor:\n  care: 'true'\n  care_threshold_seconds: 300\n  care_recheck_seconds: 300\n" });
    const clock = fakeClock();
    const scheduler = fakeScheduler(clock);
    const sup = h.parent;
    const sent = trackSends(sup);
    const care = makeCare(h, { clock, scheduler, root: h.root, ws: h.ws, idPrefix: `stale-${outcome}` });
    try {
      const version = JSON.parse(readFileSync(join(h.modules.S, '..', '..', 'package.json'), 'utf8')).version;
      assert.equal(version, '0.2.2-rc.3');
      await runTool(h, 'graph_claim_supervisor', {}, sup);
      const goal = makeGoalIn(h.root, `stale ${outcome}`, 'v1.0');
      h.fake.hold('STALE-CHILD');
      const dispatched: any = await runTool(h, 'graph_start_attempt', { goal, attempt_brief: 'STALE-CHILD', worktree: false }, sup);
      await waitFor(() => h.childLive(dispatched.child_id) === 'running', 'managed child running');
      care.start(); care.armForRoot(h.root);
      await runTurn(h, sup, 'sample managed child');
      const initial: any = care.statusFor(h.root);
      assert.equal(initial.tasks[0].child, dispatched.child_id);
      await scheduler.advanceTo(Number(initial.next_due_at) + 1000);
      const inspection = readEvents(h.root).filter((e: any) => e.event === 'care.inspection').at(-1)?.details?.inspection;
      assert.ok(inspection, 'inspection must actually be issued');
      await waitFor(() => sup.status === 'idle', 'inspection delivered');
      h.fake.releaseAll();
      await waitFor(() => h.childLive(dispatched.child_id) === 'gone', 'managed registry entry gone');
      await waitFor(() => readEvents(h.root).some((e: any) => e.event === 'attempt.results_written' && e.details?.attempt === dispatched.attempt), 'natural completion persisted');
      const naturalBinding = goalDetail(h.root, goal).attempts.find((a: any) => a.id === dispatched.attempt);
      assert.equal(naturalBinding.child_id, dispatched.child_id, 'natural completion retains disk binding');
      assert.equal(naturalBinding.parent_session_id, sup.id);
      await h.reg.resume({ resumeSessionId: dispatched.child_id, agentOptions: { provider: 'fake', model: 'fake-model' } });
      const resumed = h.reg.get(dispatched.child_id);
      assert.equal(resumed.session.header.parentSession, sup.id);
      assert.throws(() => h.subagents.rootOf(resumed), /active runtime owner|UNAUTHORIZED/);
      h.fake.hold('RESUMED-HOLD');
      resumed.send(h.modules.llm.createUserMessage({ content: [{ type: 'text', text: 'RESUMED-HOLD' }], source: { kind: 'user' } }), 'next-turn', true);
      await waitFor(() => resumed.status === 'running', 'resumed child running');
      assert.equal(goalDetail(h.root, goal).attempts.find((a: any) => a.id === dispatched.attempt).child_id, dispatched.child_id, 'independent resume retains natural binding');
      assert.throws(() => h.subagents.rootOf(resumed), /active runtime owner|UNAUTHORIZED/);
      const before = structuredClone(care.statusFor(h.root));
      const entry = care.entryOfRoot(h.root);
      const oldInspection = structuredClone(entry.inspections.get(inspection));
      assert.ok(oldInspection, 'issued inspection must remain in the actual runtime');
      // This observation follows independent resume; it does not establish when expiry persisted.
      assert.equal(oldInspection.status, 'expired');
      const events = readEvents(h.root).filter((e: any) => e.event === 'care.outcome');
      const inbox = sent.length;
      const result: any = care.submitOutcome({ root: h.root, supervisor: sup.id, inspection, goal, attempt: dispatched.attempt, child: dispatched.child_id, outcome, evidence: '实证旧 inspection 回传应被拒绝' });
      assert.deepEqual(result, { ok: false, code: 'ownership_unknown' });
      assert.deepEqual(care.statusFor(h.root), before);
      assert.deepEqual(entry.inspections.get(inspection), oldInspection);
      assert.deepEqual(readEvents(h.root).filter((e: any) => e.event === 'care.outcome'), events);
      assert.equal(sent.length, inbox);
    } finally { care.dispose(); h.fake.releaseAll(); await h.shutdown(); }
  });
}

// ═════════════════ 1. 同一真实宿主：g505 × g506 × g610 联合主场景 ═════════════════
test("g506×g610×g505 联合真实宿主：claim 自举→自然 timer 一次投递→单活/管理保护→保活不互唤醒→未知3次锁→自然结束后恢复", async () => {
  // 真实项目配置：care 开启但阈值保持生产默认 300s（apply 内真实 timer 在测试窗口内惰性）。
  const h = await makeRealHost({
    relativeRoot: true,
    projectYaml: "supervisor:\n  care: 'true'\n  care_threshold_seconds: 300\n  care_recheck_seconds: 300\n",
  });
  const ws1 = h.ws;
  const root1 = h.root;
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const sup = h.parent;
  const sent = trackSends(sup);
  h.fake.hold("CHILD-A");
  const care = makeCare(h, { clock, scheduler, root: root1, ws: ws1, idPrefix: "comb" });
  let careRestarted: any = null;
  let keep: any = null;
  try {
    // ① 关照运行时先启动（晚 claim 现场），尚未 claim ⇒ 不布防、零投递。
    care.start();
    // dormant 条目允许有「配置复核」timer（不是投递 timer），但绝不得判到期投递。
    assert.notEqual(care.statusFor(root1)?.phase, "deliver", "未 claim 前不得判到期投递");
    assert.equal(care.statusFor(root1)?.supervisor, null);
    assert.equal(readEvents(root1).filter((e) => e.event === "care.inspection").length, 0);

    // ② 真实 claim 工具（生产 GUI/CLI 同一入口）+ 自然 turn-end 事件自举。
    const claimed: any = await runTool(h, "graph_claim_supervisor", {}, sup);
    assert.equal(claimed.supervisor_session, sup.id);
    assert.equal(readSupervisorSession(root1), sup.id);
    await runTurn(h, sup, "claim-done");
    const entry = care.entryOfRoot(root1);
    assert.ok(entry, "自然 turn-end 后必须已建立 root 条目");
    assert.notEqual(entry.timer, null, "已 claim 的主管 root 必须装 timer（晚 claim 自举）");

    // ③ 真实目标 + 判据 + 真实派发（g610 派发路径），child 保持在跑。
    const goal = makeGoalIn(root1, "combined single host", "v1.0");
    const d1: any = await runTool(h, "graph_start_attempt", {
      goal, attempt_brief: "联合场景受控子任务 CHILD-A（care/g610/keepalive）", worktree: false,
    }, sup);
    assert.ok(d1.child_id, "首次派发必须真实启动 child");
    await waitFor(() => h.childLive(d1.child_id) === "running", "child A running");
    const binding = goalDetail(root1, goal).attempts.find((a: any) => a.id === d1.attempt);
    assert.equal(binding.child_id, d1.child_id);
    assert.equal(binding.parent_session_id, sup.id, "真实 owner 绑定（parent_session_id=主管）");

    // ④ g610 新字段/attempt 状态不得让 g506 视为「无任务」。
    await runTurn(h, sup, "after-dispatch");
    const st1: any = care.statusFor(root1);
    assert.ok(st1, "关照状态必须可投影");
    assert.equal(st1.supervisor, sup.id);
    assert.equal(st1.tasks.length, 1, "真实 boardPayload 的 attempt_binding 必须被采样");
    assert.equal(st1.tasks[0].goal, goal);
    assert.equal(st1.tasks[0].attempt, d1.attempt);
    assert.equal(st1.tasks[0].child, d1.child_id);
    assert.ok(Number.isFinite(st1.next_due_at), "未到阈值前必须给出服务端真实 next_due_at");
    assert.ok(st1.next_due_at > clock.now() - 1);

    // ⑤ g505 保活运行时在**同一 workspace**观察（care 投递前创建）。
    keep = makeKeep(h, { clock, scheduler, ws: ws1 });
    keep.start();
    const callsBefore = h.fake.calls;
    const beforeEvents = readEvents(root1).filter((e) => e.event === "care.inspection").length;

    // ⑥ 假时钟到期：服务自身 timer 投递（不手工 sweep）。以服务端 next_due_at 为唯一计时真源，
    // 不靠「假时钟起点 + 30s」猜（宿主/夹具启动耗时会让 started_at 晚于时钟起点）。
    await scheduler.advanceTo(Number(st1.next_due_at) + 1_000);
    const inspections = (): any[] => readEvents(root1).filter((e) => e.event === "care.inspection");
    assert.equal(inspections().length, beforeEvents + 1, "到期必须恰好投递一次");
    const inspEv = inspections().at(-1);
    assert.equal(inspEv.details?.supervisor, sup.id);
    assert.equal(inspEv.details?.targets?.[0]?.goal, goal);
    assert.equal(inspEv.details?.targets?.[0]?.attempt, d1.attempt);
    assert.equal(inspEv.details?.targets?.[0]?.child, d1.child_id);
    const careMsgs = sent.filter((m: any) => m?.source?.kind === "dsh-graph-care");
    assert.equal(careMsgs.length, 1, "真实 agent.send 恰好一次 care 消息");
    assert.ok(String(careMsgs[0]?.content?.[0]?.text ?? "").includes(goal), "关照正文必须带真实任务标识");
    await waitFor(() => h.fake.calls > callsBefore, "主管关照回合真实模型调用");
    await waitFor(() => sup.status === "idle", "主管关照回合结束");

    // ⑦ g505：care source 不是 human；保活不产生关照，且不形成互唤醒循环。
    const kb: any = keep.stateForWorkspace(ws1);
    assert.ok(kb, "保活必须已采样该 workspace");
    assert.equal(kb.lastHumanAt, null, "care 消息不得被当成人输入");
    assert.notEqual(kb.lastLlmAt, null, "主管正常回合仍应被观察为 LLM 活动");
    const careBefore = inspections().length;
    clock.advance(60_000);
    await keep.sweep();
    await new Promise((r) => setImmediate(r));
    assert.equal(inspections().length, careBefore, "保活 sweep 不得唤醒关照");
    assert.equal(sent.filter((m: any) => m?.source?.kind === "dsh-graph-care").length, 1, "不得重复投递 care");

    // ⑧ g610：同一 goal 第二派发必拒且零新 attempt（g506 已绑定 child 条件下不误伤）。
    const attemptsBefore = goalDetail(root1, goal).attempts.length;
    await assert.rejects(
      async () => runTool(h, "graph_start_attempt", { goal, attempt_brief: "second dispatch", worktree: false }, sup),
      /仍在运行/,
      "同 goal 运行中第二派发必须拒绝",
    );
    assert.equal(goalDetail(root1, goal).attempts.length, attemptsBefore, "拒绝不得新增 attempt");

    // ⑨ g610：running child 时管理动作（postpone）必拒且零移动。
    const goalFileBefore = findGoalFile(root1, goal);
    await assert.rejects(
      async () => runTool(h, "graph_postpone_goal", { goal, reason: "should be blocked" }, sup),
      /运行|活跃|child/,
      "running child 时 postpone 必须拒绝",
    );
    assert.equal(findGoalFile(root1, goal), goalFileBefore, "拒绝不得移动目标文件");

    // ⑩ 窄结论面：unknown 不递增 no-progress（不伪称卡死）。
    const inspectionId = inspEv.details.inspection;
    const out1: any = care.submitOutcome({
      root: root1, supervisor: sup.id, inspection: inspectionId, goal,
      attempt: d1.attempt, child: d1.child_id, outcome: "unknown",
      evidence: "证据：只看到同一路径的重复 tool 调用，仍不足以判定僵局。",
    });
    assert.equal(out1.ok, true, `unknown 结论应被受理（实得 ${JSON.stringify(out1)}）`);
    assert.equal(out1.counted, false, "unknown 不得计入 no-progress");
    const stOut: any = care.statusFor(root1);
    assert.equal(stOut.tasks[0].stagnant_rounds, 0, "unknown 后无进展计数保持 0");
    assert.equal(stOut.tasks[0].human_locked, false);
    assert.equal(stOut.tasks[0].reminders_sent, 1);

    // ⑪ 连续 3 次未获有效结论（unknown） ⇒ 停止自动提醒并等待人工；不得发第 4 次。
    for (let round = 2; round <= 3; round += 1) {
      await scheduler.advanceTo(clock.now() + 300_000);
      assert.equal(inspections().length, round, `第 ${round} 次到期必须投递一次`);
      await waitFor(() => sup.status === "idle", "主管回合结束");
      const ev = inspections().at(-1);
      const res: any = care.submitOutcome({
        root: root1, supervisor: sup.id, inspection: ev.details.inspection, goal,
        attempt: d1.attempt, child: d1.child_id, outcome: "unknown",
        evidence: `证据：第 ${round} 次巡检仍无法判断。`,
      });
      assert.equal(res.ok, true);
      assert.equal(res.counted, false, "unknown 永不递增");
    }
    await scheduler.advanceTo(clock.now() + 300_000);
    const stLock: any = care.statusFor(root1);
    assert.equal(stLock.tasks[0].human_locked, true, "3 次未获有效结论必须转入等待人工");
    assert.equal(stLock.phase, "awaiting_human");
    assert.equal(stLock.next_due_at, null, "等待人工时不得再显示自动巡检倒计时");
    assert.equal(inspections().length, 3, "封顶后不得发出第 4 次自动提醒");
    assert.equal(stLock.tasks[0].stagnant_rounds, 0, "未回复绝不能伪称 no-progress");

    // ⑫ 重置只重设计时，不清人工锁；dispose + 重建（重启）后锁仍在（事件持久）。
    const resetRes: any = care.control(root1, "reset", { expectedRevision: stLock.revision, actor: "human" });
    assert.equal(resetRes.ok, true, `reset 应受理（实得 ${JSON.stringify(resetRes)}）`);
    const stReset: any = care.statusFor(root1);
    assert.equal(stReset.tasks[0].human_locked, true, "reset 不得解除人工锁");
    assert.equal(stReset.phase, "awaiting_human");
    care.dispose();
    careRestarted = makeCare(h, { clock, scheduler, root: root1, ws: ws1, idPrefix: "comb2" });
    careRestarted.start();
    await runTurn(h, sup, "after-restart");
    const stRestart: any = careRestarted.statusFor(root1);
    assert.ok(stRestart, "重建后状态必须可投影");
    assert.equal(stRestart.tasks[0].human_locked, true, "重启后人工锁必须保持");
    assert.equal(stRestart.phase, "awaiting_human");

    // ⑬ 子代理自然结束 ⇒ 派发与管理动作按既有 human gate 恢复。
    h.fake.releaseAll();
    await waitFor(() => h.childLive(d1.child_id) !== "running", "child A stopped");
    await waitFor(() => readEvents(root1).some((e) => e.event === "attempt.results_written" && e.details?.attempt === d1.attempt),
      "subagent/end 自然结束事件");
    await waitFor(() => (careRestarted.statusFor(root1)?.tasks?.length ?? 0) === 0, "结束后不再有关照任务");
    const idleSt: any = careRestarted.statusFor(root1);
    assert.equal(idleSt.phase, "idle");
    assert.equal(idleSt.next_due_at, null, "无运行任务时不得显示虚假倒计时");

    // 自然结束 ≠ 自动授权管理：必须先按既有授权流程解绑（真实 token），管理动作才放行。
    const endedRow = goalDetail(root1, goal).attempts.find((a: any) => a.id === d1.attempt);
    await runTool(h, "graph_unbind_goal_child", {
      goal, attempt: d1.attempt, token: endedRow.binding_token, reason: "natural end",
    }, sup);
    await runTool(h, "graph_postpone_goal", { goal, reason: "child naturally ended" }, sup);
    assert.ok(!existsSync(goalFileBefore), "自然结束+授权解绑后 postpone 必须真实移动目标");
    await runTool(h, "graph_move_goal", { goal, to: "version", version: "v1.0" }, sup);
    const d2: any = await runTool(h, "graph_start_attempt", {
      goal, attempt_brief: "authorized re-dispatch after natural end", worktree: false,
    }, sup);
    assert.ok(d2.child_id, `自然结束后可合法重新派发（result=${JSON.stringify(d2)}）`);
    assert.notEqual(d2.attempt, d1.attempt);
    assert.equal(goalDetail(root1, goal).attempts.length, attemptsBefore + 1);
  } finally {
    try { keep?.dispose(); } catch { /* ignore */ }
    try { care.dispose(); } catch { /* ignore */ }
    try { careRestarted?.dispose(); } catch { /* ignore */ }
    h.fake.releaseAll();
    try { await h.shutdown(); } catch { /* ignore */ }
  }
});

// ═════════════════ 2. 私有 workspace 晚 claim：真实运行时 timer + 窄工具回传 + 跨看板隔离 ═════════════════
test("g506 晚 claim 联合真实宿主：私有 workspace 由真实 timer 恰好投递一次，窄工具受理 unknown，另一看板零串扰", async () => {
  // 主 workspace 的空看板（无 supervisor）；第二个私有 workspace 走晚 claim。
  const h = await makeRealHost({
    relativeRoot: true,
    projectYaml: "supervisor:\n  care: 'true'\n  care_threshold_seconds: 300\n  care_recheck_seconds: 300\n",
  });
  const ws2 = ownedDir("ws2");
  const root2 = join(ws2, ".dsh-graph");
  init(root2);
  writeProjectConfig(root2, { supervisor: { care: "true", care_threshold_seconds: 30, care_recheck_seconds: 300 } }, "human:gui");
  const sup2 = (await h.reg.create({
    sessionId: "sess-care-ws2",
    agentOptions: { provider: "fake", model: "fake-model" },
    meta: { cwd: ws2 },
  })).agent;
  const sent2 = trackSends(sup2);
  h.fake.hold("CHILD-B");
  try {
    // ① 先 claim（apply 内部真实关照运行时 armForRoot），此时看板还没有任务。
    const claim1: any = await runTool(h, "graph_claim_supervisor", {}, sup2);
    assert.equal(claim1.supervisor_session, sup2.id);
    assert.equal(readSupervisorSession(root2), sup2.id);

    // ② 真实派发（g610）到私有 workspace；child 保持 running。
    const goal2 = makeGoalIn(root2, "late claim private ws", "standalone");
    const d2: any = await runTool(h, "graph_start_attempt", {
      goal: goal2, attempt_brief: "私有 workspace 晚 claim 受控子任务 CHILD-B", worktree: false,
    }, sup2);
    assert.ok(d2.child_id, `私有 ws 派发（result=${JSON.stringify(d2)}）`);
    await waitFor(() => h.childLive(d2.child_id) === "running", "child B running");

    // ③ 把真实 attempt 的 started_at 回拨到阈值之外（等价于「任务已持续工作」），保持真实 board 文件。
    const attFile = join(dirname(findGoalFile(root2, goal2)), "attempts", d2.attempt, "attempt.md");
    const oldIso = new Date(Date.now() - 40_000).toISOString();
    const md = readFileSync(attFile, "utf8");
    writeFileSync(attFile, md.replace(/("started_at":\s*")[^"]+(")/, `$1${oldIso}$2`), "utf8");
    invalidateBoardCache(root2);
    const payload: any = getCachedBoardPayload(root2, { lazy: true })?.payload;
    assert.ok(payload, "真实 boardPayload 必须可读");
    assert.equal(readProjectConfig(root2)?.supervisor?.care_threshold_seconds, 30, "项目阈值真实落盘");

    // ④ 再次 claim（幂等；生产 claim 入口会显式 armForRoot）⇒ 真实 timer 立即到期并投递一次。
    await runTool(h, "graph_claim_supervisor", {}, sup2);
    await waitFor(() => readEvents(root2).some((e) => e.event === "care.inspection"), "真实定时器投递 care.inspection", 8000);
    const insp: any[] = readEvents(root2).filter((e) => e.event === "care.inspection");
    assert.equal(insp.length, 1, "同一 root 只投递一次（单 timer，不双发）");
    assert.equal(insp[0].details?.supervisor, sup2.id);
    assert.equal(insp[0].details?.targets?.[0]?.goal, goal2);
    const careMsgs = sent2.filter((m: any) => m?.source?.kind === "dsh-graph-care");
    assert.equal(careMsgs.length, 1, "晚 claim 现场必须真实发到主管");

    // ⑤ 窄结果工具（生产唯一回传入口）：unknown 受理且不计 no-progress。
    const outcome: any = await runTool(h, "graph_care_outcome", {
      inspection: insp[0].details.inspection, goal: goal2, attempt: d2.attempt, child: d2.child_id,
      outcome: "unknown", evidence: "证据：私有 workspace 子任务仍在跑，暂无法判断。",
    }, sup2);
    assert.equal(outcome.ok, true, `窄工具必须真实受理（实得 ${JSON.stringify(outcome)}）`);
    assert.equal(outcome.counted, false, "unknown 不得递增 no-progress");
    const outcomeEv = readEvents(root2).filter((e) => e.event === "care.outcome");
    assert.equal(outcomeEv.length, 1);
    assert.equal(outcomeEv[0].details?.outcome, "unknown");
    assert.ok(!readEvents(root2).some((e) => e.event === "care.escalated"), "unknown 不得升级人工");

    // ⑥ 非相关看板零串扰：主 workspace 的 root 无 care.* 事件、也未被采样到 ws2 的任务。
    assert.equal(readEvents(h.root).filter((e) => String(e.event).startsWith("care.")).length, 0, "主看板不得出现私有 ws 的 care 事件");
    const mainPayload: any = getCachedBoardPayload(h.root, { lazy: true })?.payload;
    const mainGoals = [...(mainPayload?.standalone ?? []), ...((mainPayload?.versions ?? []).flatMap((v: any) => v.goals ?? []))];
    assert.equal(mainGoals.some((g: any) => g.id === goal2), false, "私有 ws 的目标不得出现在主看板");

    // ⑦ 身份边界：另一个 session 用窄工具回传必须被拒且零事件。
    const supForeign = (await h.reg.create({
      sessionId: "sess-foreign", agentOptions: { provider: "fake", model: "fake-model" }, meta: { cwd: ws2 },
    })).agent;
    const beforeForeign = readEvents(root2).length;
    const foreign: any = await runTool(h, "graph_care_outcome", {
      inspection: insp[0].details.inspection, goal: goal2, attempt: d2.attempt, child: d2.child_id,
      outcome: "progress", evidence: "伪造：非登记主管。",
    }, supForeign);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, "wrong_identity");
    assert.equal(readEvents(root2).length, beforeForeign, "身份拒绝不得写事件");
  } finally {
    h.fake.releaseAll();
    try { await h.shutdown(); } catch { /* ignore */ }
  }
});
