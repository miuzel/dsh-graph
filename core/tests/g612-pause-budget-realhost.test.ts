/**
 * Reviewer C2（独立）：暂停只停关照倒计时，不消耗预算；暂停中主管消息重置冻结完整预算；
 * 暂停中改 goal 预算按「最后有效基准 + 暂停前已消费」重算剩余（不含暂停墙钟）；恢复后按剩余计时。
 * 真实 0.2.1-rc.2 公开宿主服务 + 生产 createCareRuntime + 假时钟；不联网/真实 provider。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  init, writeProjectConfig, claimSupervisor, readProjectConfig, readSupervisorSession,
  getCachedBoardPayload, closeWatchers, setGoalBudget,
} from "../ops.ts";
import { appendEvent } from "../events.ts";
import { invalidateBoardCache } from "../cache.ts";
import { initServiceInstances } from "./_host-stack.ts";
import { installRc3SubagentOwnership } from "./_rc3-subagents-stub.ts";

const TMP_BASE = realpathSync((() => { const p = join(process.cwd(), "tmp"); mkdirSync(p, { recursive: true }); return p; })());
const OWNED: string[] = [];
function ownedDir(tag: string) { const d = mkdtempSync(join(TMP_BASE, `revpause-${tag}-`)); OWNED.push(d); return d; }
test.after(() => {
  try { closeWatchers(); } catch {}
  for (const dir of OWNED.splice(0)) {
    const real = (() => { try { return realpathSync(dir); } catch { return null; } })();
    if (!real || !real.startsWith(TMP_BASE + sep)) continue;
    try { rmSync(real, { recursive: true, force: true }); } catch {}
  }
});

async function resolveHostScope() {
  const env = process.env.G505_HOST_STACK_DIR || process.env.G507_HOST_STACK_DIR || process.env.G505_HOST_STACK_DIR;
  if (env) return env;
  const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  for (const scope of [join(globalRoot, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"), join(globalRoot, "@deepseek-ai")]) {
    if (existsSync(join(scope, "dsh-llm", "lib", "index.js")) && existsSync(join(scope, "dsh-agent", "lib", "index.js"))) return scope;
  }
  throw new Error("host stack scope missing");
}
async function loadHostStack() {
  const dir = await resolveHostScope();
  const load = (pkg: string, file = "index.js") => import(pathToFileURL(join(dir, pkg, "lib", file)).href);
  return {
    Context: (await load("cordis")).Context,
    llm: await load("dsh-llm"),
    AgentRegistry: (await load("dsh-agent")).AgentRegistry,
    SessionStore: (await load("dsh-session")).SessionStore,
    SessionProjections: (await load("dsh-session-projection")).default,
    SystemPrompt: (await load("dsh-system-prompt")).SystemPrompt,
    ToolRuntime: (await load("dsh-tools")).ToolRuntime,
    AgentLoop: (await load("dsh-agent-loop")).AgentLoop,
    // g-617：0.2.2 起 tool 批次需要已装载的执行器（与宿主组合里的 native-tool-executor 同一实现）。
    NativeToolExecutor: (await load("dsh-tool-executor-native")).NativeToolExecutor,
  };
}
function makeFakeAdapter(LlmAdapter: any) {
  class Adapter extends LlmAdapter {
    calls: any[] = []; holds = new Map<string, Promise<void>>(); releases: Array<() => void> = [];
    hold(text: string) { let release!: () => void; const gate = new Promise<void>((r) => { release = () => r(); }); this.releases.push(release); this.holds.set(text, gate); }
    releaseAll() { for (const r of this.releases.splice(0)) r(); this.holds.clear(); }
    providerInfo(provider: string) { return { id: provider, name: provider, protocol: "fake" }; }
    async resolveModel(provider: string, model: string) { return { provider, id: model, name: model, inputModalities: ["text"], context: { contextWindow: 128000 }, defaultMaxTokens: 8192 }; }
    async *stream(options: any) {
      this.calls.push(options);
      const serialized = JSON.stringify(options.messages);
      for (const [text, gate] of this.holds) if (serialized.includes(text)) await gate;
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "ok" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "ok" } };
      yield { type: "finish", reason: { kind: "stop" } };
    }
  }
  return new Adapter(LlmAdapter);
}
async function makeRealHost() {
  const { Context, llm, AgentRegistry, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, AgentLoop, NativeToolExecutor } = await loadHostStack();
  const hostCtx = new Context();
  new SessionStore(hostCtx); new SessionProjections(hostCtx); new SystemPrompt(hostCtx, {}); new ToolRuntime(hostCtx, {});
  hostCtx.tools.setExecutor(new NativeToolExecutor(hostCtx));
  const reg = new AgentRegistry(hostCtx);
  const llmRuntime = new llm.LlmRuntime(hostCtx);
  const adapter = makeFakeAdapter(llm.LlmAdapter);
  llmRuntime.registerAdapter(["observed"], adapter);
  new AgentLoop(hostCtx, { agents: [], maxParallelToolCalls: 10 });
  // g-617：驱动直构服务的 `[Service.init]`（cordis 只在 ctx.plugin() 装载时自动调用）。
  await initServiceInstances([reg, hostCtx.get("agentLoop")]);
  // g-626：补 rc.3 归属面（真实宿主由 dsh-subagent 的 rootOf 提供；轻量夹具未装载它）。
  const subagents = installRc3SubagentOwnership(hostCtx, reg);
  return { hostCtx, llm, llmRuntime, reg, adapter, subagents };
}
function fakeClock(start = 1_000_000) { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } }; }
function fakeScheduler(clock: ReturnType<typeof fakeClock>) {
  let seq = 0; const timers = new Map<number, { at: number; fn: () => any }>();
  const setTimeoutFn = (fn: () => any, ms: number) => { const id = ++seq; timers.set(id, { at: clock.now() + Math.max(0, ms), fn }); return id; };
  const clearTimeoutFn = (id: number) => { timers.delete(id); };
  const advanceTo = async (target: number) => {
    for (let guard = 0; guard < 400; guard += 1) {
      const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (!due.length) break;
      const [id, v] = due[0]; timers.delete(id); clock.set(v.at); await v.fn();
    }
    clock.set(target); await new Promise((r) => setImmediate(r));
  };
  return { setTimeoutFn, clearTimeoutFn, advanceTo, timers };
}
function boardWithCare(thresholdSeconds = 300, recheckSeconds = 300) {
  const ws = ownedDir("ws"); const root = join(ws, ".dsh-graph");
  init(root); writeProjectConfig(root, { supervisor: { care: "true", care_threshold_seconds: thresholdSeconds, care_recheck_seconds: recheckSeconds } }, "human:gui");
  return { ws, root };
}
function writeRealGoal(root: string, opts: { goalId?: string; child: string; parent: string; startedAt: string; bindingVersion?: number }) {
  const goalId = opts.goalId ?? "g-001"; const attempt = "att-001"; const dir = join(root, "goals", goalId);
  mkdirSync(join(dir, "attempts", attempt), { recursive: true });
  writeFileSync(join(dir, "goal.md"), `---\n${JSON.stringify({ id: goalId, title: `probe ${goalId}`, status: "in_progress", type: "task", created_at: opts.startedAt, version: null, depends_on: [], review: { reviewer: "human", prompt: null }, pk: { lanes: 1, sandbox: "directory" }, rules_snapshot: null }, null, 2)}\n---\n\n# ${goalId}\n\n## 目标描述\n\nfixture\n`);
  writeFileSync(join(dir, "attempts", attempt, "attempt.md"), `---\n${JSON.stringify({ id: attempt, goal: goalId, executor: "agent:main", sandbox: "directory", started_at: opts.startedAt, claimed_at: null, status_line: null, status_state: null, result: "pending", child_id: opts.child, worktree: false, binding_version: opts.bindingVersion ?? 1, parent_session_id: opts.parent, detached: false }, null, 2)}\n---\n\n## 执行笔记\n\nfixture\n`);
  try { invalidateBoardCache(root); } catch {}
}
async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!cond()) { if (Date.now() > end) throw new Error(`timeout: ${label}`); await new Promise((r) => setImmediate(r)); }
}
function makeRuntime(host: any, opts: any) {
  const events: any[] = [];
  const { createCareRuntime } = opts;
  const runtime = createCareRuntime({
    ctx: { on: (n: string, h: any) => host.hostCtx.on(n, h), get: (n: string) => (n === "agents" ? host.reg : n === "subagents" ? host.subagents : undefined) },
    readGlobal: () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: true, raw: "on" }),
    resolveRoot: (ws: string) => join(ws, ".dsh-graph"),
    defaultWorkspace: () => null,
    readProjectConfigFn: readProjectConfig,
    readSupervisorSessionFn: readSupervisorSession,
    readBoardPayload: (root: string) => getCachedBoardPayload(root, { lazy: true })?.payload ?? null,
    now: opts.clock.now, setTimeoutFn: opts.scheduler.setTimeoutFn, clearTimeoutFn: opts.scheduler.clearTimeoutFn,
    appendEventFn: (root: string, ev: any) => { events.push(ev); appendEvent(root, ev); },
    makeInspectionId: (() => { let i = 0; return () => `rev-${++i}`; })(),
    armDiscoveryMaxAttempts: 0, log: () => {},
  });
  return { runtime, events };
}
function careEvents(events: any[]) { return events.filter((e: any) => String(e?.event ?? "").startsWith("care.")); }

test("REVIEW-C2 暂停不消耗预算；暂停中消息冻结完整预算；暂停中改预算按已消费重算；恢复按剩余", async () => {
  const { createCareRuntime } = await import("../../dist/index.js");
  const host: any = await makeRealHost();
  const { ws, root } = boardWithCare(300, 300);
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events } = makeRuntime(host, { clock, scheduler, createCareRuntime });
  try {
    runtime.start();
    const sup = (await host.reg.create({ sessionId: "sup-pause612", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const child = (await host.reg.create({ sessionId: "child-pause612", parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    host.adapter.hold("PAUSE612");
    child.send(host.llm.createUserMessage({ content: [{ type: "text", text: "PAUSE612" }], source: { kind: "user" } }), "next-turn", true);
    await waitFor(() => child.status === "running", "child running");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 10_000).toISOString() });
    setGoalBudget(root, "g-001", { budget_seconds: 30, actor: "human:gui" });
    invalidateBoardCache(root);
    claimSupervisor(root, sup.id, "agent:sup-pause612");
    runtime.armForRoot(root);
    let st: any = runtime.statusFor(root);
    let t: any = (st.tasks ?? []).find((x: any) => x.child === child.id);
    assert.ok(t, "running child 被采样");
    assert.equal(t.budget_source, "goal");
    assert.equal(t.effective_budget_seconds, 30);
    assert.ok(t.dueInMs > 0 && t.dueInMs <= 30_000, `初始预算倒计时 ${t.dueInMs}`);

    // ① 先真实消耗 10s，再暂停：初始剩余 20s ⇒ 冻结剩余≈10s（证明「暂停前已消费」被如实计入）
    clock.advance(10_000);
    assert.equal(runtime.control(root, "pause").ok, true);
    st = runtime.statusFor(root);
    assert.equal(st.paused, true);
    const frozen0 = (st.tasks ?? []).find((x: any) => x.child === child.id)?.dueInMs;
    assert.ok(frozen0 >= 9_000 && frozen0 <= 11_000, `暂停冻结剩余应≈10s（实得 ${frozen0}）`);
    await scheduler.advanceTo(clock.now() + 3_600_000);
    st = runtime.statusFor(root);
    assert.equal(st.paused, true);
    assert.equal((st.tasks ?? []).find((x: any) => x.child === child.id)?.dueInMs, frozen0, "暂停墙钟不得消耗关照倒计时");
    assert.equal(careEvents(events).filter((e: any) => e.event === "care.inspection").length, 0, "暂停期间不得投递巡检");

    // ② 暂停中主管真实 agent-message 到达 child inbox ⇒ 冻结刷新为完整预算，仍暂停
    child.send(host.llm.createUserMessage({
      content: [{ type: "text", text: "PAUSE612 steer" }],
      source: { kind: "agent-message", form: "relay", senderSessionId: sup.id },
    }), "next-turn", true);
    await new Promise((r) => setImmediate(r));
    st = runtime.statusFor(root);
    assert.equal(st.paused, true, "消息重置不得解除暂停");
    const frozenMsg = (st.tasks ?? []).find((x: any) => x.child === child.id)?.dueInMs;
    assert.ok(frozenMsg >= 29_000 && frozenMsg <= 30_000, `暂停中消息应冻结完整预算（实得 ${frozenMsg}）`);
    await scheduler.advanceTo(clock.now() + 3_600_000);
    st = runtime.statusFor(root);
    assert.equal((st.tasks ?? []).find((x: any) => x.child === child.id)?.dueInMs, frozenMsg, "消息重置后暂停墙钟仍不得消耗");
    assert.equal(careEvents(events).filter((e: any) => e.event === "care.inspection").length, 0);

    // ③ 暂停中改 goal 预算 30→60：按最后有效基准+已消费(0) 重算剩余=60s，仍暂停
    // 生产顺序：先在 goal.md 写预算（事件先行），再由宿主通知关照运行时立即重算。
    setGoalBudget(root, "g-001", { budget_seconds: 60, actor: "human:gui" });
    invalidateBoardCache(root);
    runtime.notifyGoalBudgetChanged(root, "g-001", 60);
    st = runtime.statusFor(root);
    assert.equal(st.paused, true);
    const frozen60 = (st.tasks ?? []).find((x: any) => x.child === child.id)?.dueInMs;
    assert.ok(frozen60 >= 59_000 && frozen60 <= 60_000, `暂停中改预算应得剩余≈60s（实得 ${frozen60}）`);
    await scheduler.advanceTo(clock.now() + 3_600_000);
    st = runtime.statusFor(root);
    assert.equal((st.tasks ?? []).find((x: any) => x.child === child.id)?.dueInMs, frozen60, "暂停中改预算后墙钟仍不得消耗");

    // ④ 恢复：按冻结的 60s 剩余计时，而不是重新计满/扣掉暂停墙钟
    const resumeAt = clock.now();
    assert.equal(runtime.control(root, "resume").ok, true);
    st = runtime.statusFor(root);
    assert.equal(st.paused, false);
    const t2: any = (st.tasks ?? []).find((x: any) => x.child === child.id);
    assert.ok(t2.dueInMs > 59_000 && t2.dueInMs <= 60_000, `恢复后应剩≈60s（实得 ${t2.dueInMs}）`);
    assert.equal(t2.budget_base_at, resumeAt - Math.max(0, 60_000 - frozen60), "基准=恢复时刻-已消费，不含暂停墙钟");
    await scheduler.advanceTo(resumeAt + 60_001);
    assert.equal(careEvents(events).filter((e: any) => e.event === "care.inspection").length, 1, "恢复后按剩余计时到期恰好投递一次");
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});
