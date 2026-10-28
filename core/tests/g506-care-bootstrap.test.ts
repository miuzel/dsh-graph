/**
 * g-506 返工（att-003）：**晚 claim / 晚加入 workspace 的自举布防**回归。
 *
 * 真实缺口（3110 现场 + 独立私有 probe）：插件 apply 时默认 workspace 为空或指向别的 root，
 * 主管在**之后**才 claim（只写 project.yaml，不产生 Cordis 事件），目标 root 从未被布防 ⇒
 * 到阈值也永不投递 care 巡检。旧路径能"通过"的只是「旧实现仍然 0 投递」，绝不能当验收。
 *
 * 本文件因此把私有 probe 的**事件顺序**保留下来，但断言方向翻转为：
 *   ① 旧路径（无 claim 钩子 / 无事件自举 / 无发现）在生产顺序下**仍然零投递** —— 负向对照，
 *      证明下面的正向结果确实来自新增的自举机制，而不是测试夹具/手工 sweep 的副作用；
 *   ② 新机制（成功 claim 链 armForRoot / 自然 agent/status / 有界发现）各自都能布防并**自然 timer**
 *      到期投递恰好一次 —— 不调用 `sweep()`、不读设置页、不做 post-claim `statusFor`；
 *   ③ 生产路径（真实 apply + 真实 graph_claim_supervisor 工具）与绕过工具的直写形成正/负对照；
 *   ④ 安全边界：多 workspace 不串根、非主管/foreign agent/未登记主管不布防、
 *      一 root 单 timer 幂等、主管更替、暂停与人工锁跨晚布防/HMR 保留。
 *
 * 宿主口径与既有 g506 套件一致：真实 cordis + Session/AgentRegistry/AgentLoop/LlmRuntime +
 * fake adapter（零网络、零真实 provider、零费用）、真实 boardPayload（真实 goal.md/attempt.md）、
 * 真实 owned running child、假时钟/假定时器。所有 tmp 只落在本仓库 tmp/ 内。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  init,
  writeProjectConfig,
  claimSupervisor,
  readProjectConfig,
  readSupervisorSession,
  getCachedBoardPayload,
  closeWatchers,
} from "../ops.ts";
import { appendEvent, readEvents } from "../events.ts";
import { invalidateBoardCache } from "../cache.ts";
import { apply, createCareRuntime } from "../../dist/index.js";
import { createRegisterStub } from "./_http-auth-harness.ts";

// ───────────────────────────── 私有 tmp（只用本树 tmp/） ─────────────────────────────
const TMP_BASE = realpathSync((() => {
  const p = join(process.cwd(), "tmp");
  mkdirSync(p, { recursive: true });
  return p;
})());
const OWNED: string[] = [];

function ownedDir(tag: string): string {
  const dir = mkdtempSync(join(TMP_BASE, `g506boot-${tag}-`));
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

// ───────────────────────────── 真实宿主栈 + fake adapter ─────────────────────────────
async function resolveHostScope(): Promise<string> {
  const env = process.env.G505_HOST_STACK_DIR || process.env.G507_HOST_STACK_DIR;
  if (env) return env;
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    for (const scope of [
      join(globalRoot, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"),
      join(globalRoot, "@deepseek-ai"),
    ]) {
      if (existsSync(join(scope, "dsh-llm", "lib", "index.js")) && existsSync(join(scope, "dsh-agent", "lib", "index.js"))) return scope;
    }
  } catch { /* npm 不可用 ⇒ 走 helper */ }
  const { resolveHostStack } = await import("./_host-stack.ts");
  const { dir } = resolveHostStack();
  return dir;
}

async function loadHostStack() {
  const dir = await resolveHostScope();
  const load = (pkg: string, file = "index.js") => import(pathToFileURL(join(dir, pkg, "lib", file)).href);
  const cordis = await load("cordis");
  const llm = await load("dsh-llm");
  const agent = await load("dsh-agent");
  const session = await load("dsh-session");
  const projection = await load("dsh-session-projection");
  const systemPrompt = await load("dsh-system-prompt");
  const tools = await load("dsh-tools");
  const loop = await load("dsh-agent-loop");
  return {
    Context: cordis.Context, llm,
    AgentRegistry: agent.AgentRegistry,
    SessionStore: session.SessionStore,
    SessionProjections: projection.default,
    SystemPrompt: systemPrompt.SystemPrompt,
    ToolRuntime: tools.ToolRuntime,
    AgentLoop: loop.AgentLoop,
  };
}

function makeFakeAdapter(LlmAdapter: any) {
  class RecordingAdapter extends LlmAdapter {
    calls: any[] = [];
    holds = new Map<string, Promise<void>>();
    releases: Array<() => void> = [];
    hold(text: string) {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = () => r(); });
      this.releases.push(release);
      this.holds.set(text, gate);
    }
    releaseAll() { for (const r of this.releases.splice(0)) r(); this.holds.clear(); }
    providerInfo(provider: string) { return { id: provider, name: provider, protocol: "fake" }; }
    async resolveModel(provider: string, model: string) {
      return { provider, id: model, name: model, inputModalities: ["text"], context: { contextWindow: 128000 }, defaultMaxTokens: 8192 };
    }
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
  return new RecordingAdapter();
}

async function makeRealHost() {
  const { Context, llm: llmMod, AgentRegistry, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, AgentLoop } = await loadHostStack();
  const hostCtx = new Context();
  new SessionStore(hostCtx);
  new SessionProjections(hostCtx);
  new SystemPrompt(hostCtx, {});
  new ToolRuntime(hostCtx, {});
  const reg = new AgentRegistry(hostCtx);
  const llmRuntime = new llmMod.LlmRuntime(hostCtx);
  const adapter = makeFakeAdapter(llmMod.LlmAdapter);
  llmRuntime.registerAdapter(["observed"], adapter);
  new AgentLoop(hostCtx, { agents: [], maxParallelToolCalls: 10 });
  return { hostCtx, llm: llmMod, llmRuntime, reg, adapter };
}

// ───────────────────────────── 假时钟 / 假定时器 ─────────────────────────────
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } };
}
function fakeScheduler(clock: ReturnType<typeof fakeClock>) {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => any }>();
  const setTimeoutFn = (fn: () => any, ms: number) => {
    const id = ++seq;
    timers.set(id, { at: clock.now() + Math.max(0, ms), fn });
    return id;
  };
  const clearTimeoutFn = (id: number) => { timers.delete(id); };
  const advanceTo = async (target: number) => {
    for (let guard = 0; guard < 400; guard += 1) {
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

// ───────────────────────────── 夹具：真实 goal/attempt + 运行中 child ─────────────────────────────
function writeRealGoal(root: string, opts: {
  goalId?: string; status?: string; child: string; parent: string; startedAt: string; bindingVersion?: number;
}) {
  const goalId = opts.goalId ?? "g-001";
  const attempt = "att-001";
  const dir = join(root, "goals", goalId);
  mkdirSync(join(dir, "attempts", attempt), { recursive: true });
  writeFileSync(join(dir, "goal.md"), `---\n${JSON.stringify({
    id: goalId, title: `probe ${goalId}`, status: opts.status ?? "in_progress", type: "task",
    created_at: opts.startedAt, version: null, depends_on: [],
    review: { reviewer: "human", prompt: null }, pk: { lanes: 1, sandbox: "directory" }, rules_snapshot: null,
  }, null, 2)}\n---\n\n# ${goalId}\n\n## 目标描述\n\nbootstrap fixture\n`);
  writeFileSync(join(dir, "attempts", attempt, "attempt.md"), `---\n${JSON.stringify({
    id: attempt, goal: goalId, executor: "agent:main", sandbox: "directory", started_at: opts.startedAt,
    claimed_at: null, status_line: null, status_state: null, result: "pending",
    child_id: opts.child, worktree: false, binding_version: opts.bindingVersion ?? 1,
    parent_session_id: opts.parent, detached: false,
  }, null, 2)}\n---\n\n## 执行笔记\n\nbootstrap\n`);
  // 生产里目标写入都经 ops（内部失效看板缓存）；夹具直写文件，必须同样失效，否则读到旧载荷。
  try { invalidateBoardCache(root); } catch { /* ignore */ }
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting: ${label}`);
    await new Promise((r) => setImmediate(r));
  }
}

async function makeRunningChild(host: any, sup: any, ws: string, tag: string) {
  const child = (await host.reg.create({
    sessionId: `child-${tag}`, parentAgent: sup, agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws },
  })).agent;
  host.adapter.hold(`CHILD-${tag}`);
  child.send(host.llm.createUserMessage({ content: [{ type: "text", text: `CHILD-${tag}` }], source: { kind: "user" } }), "next-turn", true);
  await waitFor(() => child.status === "running", `child ${tag} running`);
  return child;
}

function emitStatus(host: any, agent: any, status: string) {
  // 真实宿主契约：agentEvents 把 `{...payload, agent}` 融合后交给 ctx.on("agent/status")。
  if (typeof agent?.dispatch?.emit === "function") agent.dispatch.emit("agent/status", { status });
  else host.hostCtx.emit("agent/status", { agent, status });
}

function trackSends(agent: any) {
  const sent: any[] = [];
  const orig = agent.send.bind(agent);
  agent.send = (message: any, ...rest: any[]) => { sent.push(message); return orig(message, ...rest); };
  return sent;
}

function careEvents(events: any[]) {
  return events.filter((e) => String(e?.event ?? "").startsWith("care."));
}

// ───────────────────────────── 夹具：createCareRuntime（假时钟） ─────────────────────────────
function makeRuntime(host: any, opts: {
  clock: ReturnType<typeof fakeClock>;
  scheduler: ReturnType<typeof fakeScheduler>;
  defaultWorkspace?: () => string | null;
  agentsService?: () => any;
  discoveryMaxAttempts?: number;
  discoveryIntervalMs?: number;
  idPrefix?: string;
}) {
  const events: any[] = [];
  const inserted: any[] = [];
  host.hostCtx.on("agent/inbox/inserted", (p: any) => inserted.push(p));
  const runtime = createCareRuntime({
    ctx: {
      on: (name: string, handler: any) => host.hostCtx.on(name, handler),
      get: (name: string) => (name === "agents" ? (opts.agentsService ? opts.agentsService() : host.reg) : undefined),
    },
    readGlobal: () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: true, raw: "on" }),
    resolveRoot: (ws: string) => join(ws, ".dsh-graph"),
    defaultWorkspace: opts.defaultWorkspace ?? (() => null),
    readProjectConfigFn: (root: string) => readProjectConfig(root),
    readSupervisorSessionFn: (root: string) => readSupervisorSession(root),
    readBoardPayload: (root: string) => getCachedBoardPayload(root, { lazy: true })?.payload ?? null,
    now: opts.clock.now,
    setTimeoutFn: opts.scheduler.setTimeoutFn,
    clearTimeoutFn: opts.scheduler.clearTimeoutFn,
    appendEventFn: (root: string, ev: any) => { events.push(ev); appendEvent(root, ev); },
    makeInspectionId: (() => { let i = 0; const p = opts.idPrefix ?? "boot"; return () => `${p}-${++i}`; })(),
    armDiscoveryMaxAttempts: opts.discoveryMaxAttempts,
    armDiscoveryIntervalMs: opts.discoveryIntervalMs,
    log: () => {},
  });
  return { runtime, events, inserted };
}

// 动态绑定 ops（避免顶部循环依赖写法；真实函数与生产同源）。
/** 一个可直接驱动的「claim 前 statusFor + 真实 claim」现场（3110 事件顺序）。 */
function boardWithCare(thresholdSeconds = 120, recheckSeconds = 300) {
  const ws = ownedDir("ws");
  const root = join(ws, ".dsh-graph");
  init(root);
  writeProjectConfig(root, { supervisor: { care: "true", care_threshold_seconds: thresholdSeconds, care_recheck_seconds: recheckSeconds } }, "human:gui");
  return { ws, root };
}

// ═════════════════════════════ 1. 旧路径负向（新机制缺失时必须仍为零投递） ═════════════════════════════
test("g506 bootstrap 旧路径负向：默认根为空 + claim 前 statusFor + 真实 claim + 运行 child，无自举 ⇒ 零投递", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  // 有界发现关闭 = 模拟旧实现（没有 claim 钩子、没有事件自举、没有发现）。
  const { runtime, events } = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 0 });
  try {
    runtime.start();
    assert.equal(runtime.states().length, 0, "无默认 workspace ⇒ 不布防任何 root");

    const sup = (await host.reg.create({ sessionId: "sup-old", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    assert.equal(runtime.stateForWorkspace(ws), null, "claim 前的 agent/created 不建条目");
    const sent = trackSends(sup);

    // 生产顺序：设置面板保存 ⇒ statusFor 建 dormant 条目（supervisorId=null，无 timer）
    const pre = runtime.statusFor(root);
    const entry = runtime.entryOfRoot(root);
    assert.equal(pre.supervisor, null);
    assert.equal(entry.supervisorId, null);
    assert.equal(entry.timer, null);

    // 真实 claim：只写 project.yaml，不产生 Cordis 事件
    claimSupervisor(root, sup.id, "agent:sup-old");
    assert.equal(readSupervisorSession(root), sup.id);

    // 真实运行中 child + 真实 boardPayload（130s 已超 120s 阈值）
    const child = await makeRunningChild(host, sup, ws, "OLD");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });
    const goal = getCachedBoardPayload(root, { lazy: true })?.payload?.standalone?.find((g: any) => g.id === "g-001");
    assert.ok(goal, "真实 boardPayload 必须暴露 standalone 目标");
    assert.equal(goal.attempt_binding?.child_id, child.id);
    assert.equal(goal.attempt_binding?.parent_session_id, sup.id);

    // 不 sweep、不 post-claim statusFor、不发 status 事件；推进 360s
    await scheduler.advanceTo(clock.now() + 360_000);
    assert.equal(entry.timer, null, "旧路径不得凭空布防");
    assert.equal(sent.length, 0, "零投递");
    assert.equal(careEvents(events).length, 0, "零 care.* 事件");
    assert.equal(child.status, "running", "child 在假时间内持续运行");
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════════ 2. 成功 claim 链 → armForRoot → 自然 timer ═════════════════════════════
test("g506 bootstrap claim 事件链：成功 claim 后 armForRoot 布防，自然 timer 到期恰好投递一次（不 sweep/不读 status）", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events, inserted } = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 0 });
  try {
    runtime.start();
    const sup = (await host.reg.create({ sessionId: "sup-claim", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent = trackSends(sup);
    runtime.statusFor(root); // claim 前的设置读（dormant）
    claimSupervisor(root, sup.id, "agent:sup-claim");

    const child = await makeRunningChild(host, sup, ws, "CLAIM");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });

    // 这是 graph_claim_supervisor 工具在 claim 成功后的同一调用（runtime API 同名同参）。
    const armed = runtime.armForRoot(root);
    assert.ok(armed, "claim 链必须返回已绑定条目");
    assert.equal(armed.supervisorId, sup.id);
    assert.notEqual(armed.timer, null, "目标 root 必须有真实 timer");

    await scheduler.advanceTo(clock.now() + 1);
    assert.equal(careEvents(events).length, 1, "自然 timer 恰好投递一次 care.inspection");
    assert.equal(events[0].event, "care.inspection");
    assert.equal(sent.length, 1, "恰好一次真实 agent.send");
    const msg = sent[0];
    assert.equal(msg.role, "user");
    assert.equal(msg.source?.kind, "dsh-graph-care", "绝不冒充 human/user source");
    assert.equal(msg.source?.inspectionId, "boot-1");
    assert.ok(inserted.some((p) => p?.message?.source?.kind === "dsh-graph-care"), "真实 inbox 插入可观测");
    assert.deepEqual(msg.source?.targets?.map((t: any) => t.child), [child.id]);

    // 未回传结论 ⇒ 30s 复核周期内不重复投递
    await scheduler.advanceTo(clock.now() + 30_000);
    assert.equal(careEvents(events).length, 1, "同一巡检不得重复发送");
    assert.equal(sent.length, 1);
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════════ 3. 自然 agent/status 自举（不依赖 claim 钩子） ═════════════════════════════
test("g506 bootstrap 自然 agent/status：claim 后首次 turn-end 即自举布防（即便绕过 claim 钩子）", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events } = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 0 });
  try {
    runtime.start();
    const sup = (await host.reg.create({ sessionId: "sup-status", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent = trackSends(sup);
    runtime.statusFor(root); // dormant
    claimSupervisor(root, sup.id, "agent:sup-status"); // 例：由外部进程直写 project.yaml
    const child = await makeRunningChild(host, sup, ws, "STATUS");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });

    const entry = runtime.entryOfRoot(root);
    assert.equal(entry.timer, null, "claim 本身不产生事件 ⇒ 仍未布防");
    emitStatus(host, sup, "idle"); // 真实 turn-end
    assert.equal(entry.supervisorId, sup.id, "只读身份校验后同步身份");
    assert.notEqual(entry.timer, null, "自然 status 事件必须自举布防");

    await scheduler.advanceTo(clock.now() + 1);
    assert.equal(careEvents(events).length, 1, "自然 timer 投递一次");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].source?.kind, "dsh-graph-care");
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════════ 4. 有界发现（无任何事件）+ 上界负向 ═════════════════════════════
test("g506 bootstrap 有界发现：无事件且默认根为空时，晚 claim 在有界窗口内自举；窗口耗尽后不再扫描", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events } = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 3, discoveryIntervalMs: 30_000 });
  try {
    runtime.start();
    const sup = (await host.reg.create({ sessionId: "sup-disc", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent = trackSends(sup);
    assert.equal(scheduler.timers.size, 1, "冷启动无布防 ⇒ 只挂一个发现 timer（零模型请求）");

    claimSupervisor(root, sup.id, "agent:sup-disc");
    const child = await makeRunningChild(host, sup, ws, "DISC");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });

    // 只推进假时间：发现 tick 自己布防并交付（无 status 事件、无 claim 钩子、无 sweep）
    await scheduler.advanceTo(clock.now() + 30_000);
    assert.equal(careEvents(events).length, 1, "有界发现自举后自然到期投递一次");
    assert.equal(sent.length, 1);
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }

  // 上界负向：窗口耗尽后不再扫描；晚 claim 且无事件 ⇒ 不投递（证明有界，不是无限轮询）
  // 注：新 Agent 创建会把有界窗口重开一次（可能是尚未 claim 的主管），故 Agent 必须在窗口前建好。
  const host2 = await makeRealHost();
  const b2 = boardWithCare();
  const clock2 = fakeClock();
  const scheduler2 = fakeScheduler(clock2);
  const { runtime: rt2, events: ev2 } = makeRuntime(host2, { clock: clock2, scheduler: scheduler2, defaultWorkspace: () => null, discoveryMaxAttempts: 2, discoveryIntervalMs: 30_000 });
  try {
    const sup2 = (await host2.reg.create({ sessionId: "sup-bound", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: b2.ws } })).agent;
    const sent2 = trackSends(sup2);
    const child2 = await makeRunningChild(host2, sup2, b2.ws, "BOUND");
    writeRealGoal(b2.root, { child: child2.id, parent: sup2.id, startedAt: new Date(clock2.now() - 130_000).toISOString() });
    rt2.start();
    await scheduler2.advanceTo(clock2.now() + 90_000); // 3 个间隔 > 上限 2
    assert.equal(scheduler2.timers.size, 0, "窗口耗尽后不得再挂发现 timer（有界，不无限扫描）");
    claimSupervisor(b2.root, sup2.id, "agent:sup-bound"); // 无工具、无事件
    await scheduler2.advanceTo(clock2.now() + 360_000);
    assert.equal(sent2.length, 0, "窗口已耗尽且无事件 ⇒ 不布防（此时由 claim 钩子/真实事件覆盖）");
    assert.equal(careEvents(ev2).length, 0);
  } finally {
    rt2.dispose();
    host2.adapter.releaseAll();
  }
});

// ═════════════════════════════ 5. 晚到服务（agents 服务在 start 后就绪） ═════════════════════════════
test("g506 bootstrap 晚到服务：agents 服务在 start 后才就绪，仍在有界窗口内布防", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  let serviceReady = false;
  const { runtime, events } = makeRuntime(host, {
    clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 5, discoveryIntervalMs: 10_000,
    agentsService: () => (serviceReady ? host.reg : undefined),
  });
  try {
    runtime.start(); // registry 服务尚未就绪
    const sup = (await host.reg.create({ sessionId: "sup-late", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent = trackSends(sup);
    claimSupervisor(root, sup.id, "agent:sup-late");
    const child = await makeRunningChild(host, sup, ws, "LATE");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });

    await scheduler.advanceTo(clock.now() + 20_000); // 两次 tick 均因服务缺失放弃
    assert.equal(careEvents(events).length, 0, "服务未就绪时不得凭空布防/投递");
    serviceReady = true;
    await scheduler.advanceTo(clock.now() + 40_000);
    assert.equal(careEvents(events).length, 1, "服务就绪后的发现 tick 布防并投递一次");
    assert.equal(sent.length, 1);
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════════ 6. 多 workspace 隔离 / 跨根不串 ═════════════════════════════
test("g506 bootstrap 多 workspace：各 root 只布防自己的主管，foreign agent 不能为别的 root 布防", async () => {
  const host = await makeRealHost();
  const a = boardWithCare();
  const b = boardWithCare();
  const c = ownedDir("ws-c");
  const rootC = join(c, ".dsh-graph");
  init(rootC);
  writeProjectConfig(rootC, { supervisor: { care: "true", care_threshold_seconds: 120 } }, "human:gui");

  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events } = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => a.ws, discoveryMaxAttempts: 0 });
  try {
    const supA = (await host.reg.create({ sessionId: "sup-A", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: a.ws } })).agent;
    const sentA = trackSends(supA);
    claimSupervisor(a.root, supA.id, "agent:sup-A");
    runtime.start();
    assert.notEqual(runtime.entryOfRoot(a.root).timer, null, "默认根 A 布防（启动时已是 live 主管）");

    // B 的主管在 start 之后才出现/claim ⇒ start 的 registry 扫描看不到它
    const supB = (await host.reg.create({ sessionId: "sup-B", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: b.ws } })).agent;
    const sentB = trackSends(supB);
    claimSupervisor(b.root, supB.id, "agent:sup-B");
    assert.equal(runtime.stateForWorkspace(b.ws), null, "claim 本身不产生事件 ⇒ B 尚无条目");

    const childB = await makeRunningChild(host, supB, b.ws, "B");
    writeRealGoal(b.root, { child: childB.id, parent: supB.id, startedAt: new Date(clock.now() - 130_000).toISOString() });

    runtime.armForRoot(b.root); // 生产 claim 钩子
    assert.notEqual(runtime.entryOfRoot(b.root).timer, null, "B 布防");

    // rootC 的 project.yaml 被写成「另一个 workspace 的 live 主管」（跨根伪造/错配）
    claimSupervisor(rootC, supB.id, "human:gui");
    const armedC = runtime.armForRoot(rootC);
    assert.ok(armedC, "条目可存在");
    assert.equal(armedC.supervisorId, null, "foreign agent 不得被当成 C 的主管");
    assert.equal(armedC.timer, null, "跨根错配绝不装 timer");

    await scheduler.advanceTo(clock.now() + 1);
    assert.equal(sentB.length, 1, "B 的真实任务只唤醒 B 的主管");
    assert.equal(sentA.length, 0, "A 无任务不得被 B 的到期牵连");
    const delivered = careEvents(events);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].details?.care_state?.root, b.root, "care 事件归属 B root");
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════════ 7. 非主管 / 未登记主管 / 无主管 ═════════════════════════════
test("g506 bootstrap 身份安全：child 事件、未登记主管、无主管一律不布防", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events } = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 0 });
  try {
    runtime.start();
    const sup = (await host.reg.create({ sessionId: "sup-safety", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const child = await makeRunningChild(host, sup, ws, "SAFETY");
    const sent = trackSends(sup);

    // 1) 未 claim：child/supervisor 的 status 都不建条目、不装 timer
    emitStatus(host, sup, "idle");
    emitStatus(host, child, "running");
    assert.equal(runtime.stateForWorkspace(ws), null, "未 claim 时不得创建条目");
    assert.equal(scheduler.timers.size, 0);

    // 2) 未登记主管（project.yaml 指向 registry 里不存在的会话）⇒ 不布防
    claimSupervisor(root, "ghost-session", "human:gui");
    emitStatus(host, sup, "idle");
    const ghost = runtime.armForRoot(root);
    assert.ok(ghost);
    assert.equal(ghost.supervisorId, null, "无可信 live 主管时绝不写入身份（只读校验后直接返回）");
    assert.equal(ghost.timer, null, "未登记主管绝不装 timer（无 live Agent 可唤醒）");

    // 3) 真实 claim 后，child 的 status 事件不得抢绑/生成第二条目
    claimSupervisor(root, sup.id, "agent:sup-safety");
    const before = runtime.states().length;
    emitStatus(host, child, "idle");
    assert.equal(runtime.states().length, before, "child 事件不得新增条目");
    assert.equal(runtime.entryOfRoot(root).timer, null, "child 事件不得布防主管 root");

    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });
    await scheduler.advanceTo(clock.now() + 360_000);
    assert.equal(sent.length, 0, "未布防 ⇒ 零投递");
    assert.equal(careEvents(events).length, 0);
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════════ 8. 幂等：一 root 单 timer、恰好一次投递 ═════════════════════════════
test("g506 bootstrap 幂等：重复 claim/status/arm 只保留单 timer 且只投递一次", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events } = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 0 });
  try {
    runtime.start();
    const sup = (await host.reg.create({ sessionId: "sup-idem", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent = trackSends(sup);
    claimSupervisor(root, sup.id, "agent:sup-idem");
    const child = await makeRunningChild(host, sup, ws, "IDEM");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });

    for (let i = 0; i < 5; i += 1) {
      runtime.armForRoot(root);
      emitStatus(host, sup, i % 2 === 0 ? "idle" : "running");
      claimSupervisor(root, sup.id, "agent:sup-idem"); // 重复 claim（同值幂等）
    }
    assert.equal(scheduler.timers.size, 1, "一 root 单 timer（重复 arm/status/claim 不叠加）");
    assert.equal(runtime.states().length, 1, "不得生成重复条目");

    await scheduler.advanceTo(clock.now() + 1);
    assert.equal(careEvents(events).length, 1, "重复事件下仍只投递一次");
    assert.equal(sent.length, 1);
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════════ 9. 主管更替（重复 claim 到新 live 主管） ═════════════════════════════
test("g506 bootstrap 主管更替：新 claim 后只唤醒新主管，旧 pending 巡检过期", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events } = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 0 });
  try {
    runtime.start();
    const sup1 = (await host.reg.create({ sessionId: "sup-1st", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent1 = trackSends(sup1);
    const child1 = await makeRunningChild(host, sup1, ws, "SW1");
    writeRealGoal(root, { child: child1.id, parent: sup1.id, startedAt: new Date(clock.now() - 130_000).toISOString() });
    claimSupervisor(root, sup1.id, "agent:sup-1st");
    runtime.armForRoot(root);
    await scheduler.advanceTo(clock.now() + 1);
    assert.equal(sent1.length, 1, "首位主管收到一次");

    // 换主管（同 workspace，另一个 live 会话）
    const sup2 = (await host.reg.create({ sessionId: "sup-2nd", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent2 = trackSends(sup2);
    const child2 = await makeRunningChild(host, sup2, ws, "SW2");
    writeRealGoal(root, { goalId: "g-002", child: child2.id, parent: sup2.id, startedAt: new Date(clock.now() - 130_000).toISOString() });
    claimSupervisor(root, sup2.id, "agent:sup-2nd");
    runtime.armForRoot(root);

    const entry = runtime.entryOfRoot(root);
    assert.equal(entry.supervisorId, sup2.id, "身份切到新主管");
    assert.ok([...entry.inspections.values()].every((i: any) => i.status !== "delivered" && i.status !== "queued"), "旧 pending 巡检必须过期");

    await scheduler.advanceTo(clock.now() + 1);
    assert.equal(sent2.length, 1, "新主管收到属于新绑定的巡检");
    assert.equal(sent1.length, 1, "旧主管不得再收到");
    assert.equal(careEvents(events).length, 2);
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════════ 10. 暂停/人工锁跨晚布防与 HMR 保留 ═════════════════════════════
test("g506 bootstrap 保留暂停：点 dormant 条目暂停后晚布防仍暂停；继续后按真实状态投递", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events } = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 0 });
  try {
    runtime.start();
    const sup = (await host.reg.create({ sessionId: "sup-pause", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent = trackSends(sup);
    runtime.statusFor(root);
    claimSupervisor(root, sup.id, "agent:sup-pause");
    const child = await makeRunningChild(host, sup, ws, "PAUSE");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });

    const paused = runtime.control(root, "pause", { requestId: "p-1" });
    assert.equal(paused.ok, true, "live 主管在场即可暂停");
    assert.equal(runtime.entryOfRoot(root).group.paused, true);

    runtime.armForRoot(root);
    await scheduler.advanceTo(clock.now() + 360_000);
    assert.equal(sent.length, 0, "暂停期间晚布防也不得投递");
    assert.equal(careEvents(events).filter((e) => e.event === "care.inspection").length, 0);

    const resumed = runtime.control(root, "resume", { requestId: "r-1" });
    assert.equal(resumed.ok, true);
    const resumedAt = clock.now();
    await scheduler.advanceTo(resumedAt + 1_000);
    assert.equal(sent.length, 1, "继续后按真实到期状态投递一次（不再按已过的 360s 连发）");
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});

test("g506 bootstrap 保留人工锁：3 次新鲜 no-progress（timer 驱动）锁跨 dispose+重建+晚布防保持，不自动解除", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare(120, 30); // 复查 30s：让三轮提醒都由真实 timer 驱动
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const first = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 0 });
  let supId = "";
  try {
    first.runtime.start();
    const sup = (await host.reg.create({ sessionId: "sup-lock", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    supId = sup.id;
    const child = await makeRunningChild(host, sup, ws, "LOCK");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });
    claimSupervisor(root, sup.id, "agent:sup-lock");
    first.runtime.armForRoot(root);

    const submitNoProgress = (inspection: string) => first.runtime.submitOutcome({
      root, supervisor: sup.id, inspection, goal: "g-001", attempt: "att-001", child: child.id,
      outcome: "no-progress", evidence: `same failing test (${inspection})`,
    });

    // 三轮：全部由自然 timer 到期产生巡检（无手动 sweep）；id 由夹具 makeInspectionId 递增为 boot-N
    for (let round = 1; round <= 3; round += 1) {
      await scheduler.advanceTo(clock.now() + (round === 1 ? 1 : 31_000));
      const inspections = first.events.filter((e) => e.event === "care.inspection");
      assert.equal(inspections.length, round, `第 ${round} 轮由 timer 投递`);
      const res = submitNoProgress(`boot-${round}`);
      assert.equal(res.ok, true, `第 ${round} 轮结论受理`);
      assert.equal(res.counted, true);
      if (round < 3) await waitFor(() => sup.status === "idle", `supervisor idle after round ${round}`, 3000);
    }
    assert.equal(first.runtime.statusFor(root).phase, "awaiting_human");
    assert.equal(first.runtime.statusFor(root).tasks[0].human_locked, true);
    assert.equal(first.runtime.statusFor(root).tasks[0].stagnant_rounds, 3);
    assert.ok(first.events.some((e) => e.event === "care.escalated"), "升级必须留事件");
  } finally {
    first.runtime.dispose();
    host.adapter.releaseAll();
  }

  // HMR/重启：新 runtime 从事件真源恢复，再过晚布防不得解除锁、不得自动投递
  const clock2 = fakeClock(clock.now());
  const scheduler2 = fakeScheduler(clock2);
  const second = makeRuntime(host, { clock: clock2, scheduler: scheduler2, defaultWorkspace: () => null, discoveryMaxAttempts: 0 });
  const host2sent: any[] = [];
  try {
    second.runtime.start();
    const sup = host.reg.get(supId);
    const orig = sup.send.bind(sup);
    sup.send = (m: any, ...rest: any[]) => { host2sent.push(m); return orig(m, ...rest); };
    second.runtime.armForRoot(root);
    const st = second.runtime.statusFor(root);
    assert.equal(st.phase, "awaiting_human", "人工锁跨重启保持（晚布防不得重置）");
    assert.equal(st.tasks[0].human_locked, true);
    assert.equal(st.tasks[0].stagnant_rounds, 3, "无进展计数不被布防清零");
    await scheduler2.advanceTo(clock2.now() + 360_000);
    assert.equal(host2sent.length, 0, "等待人工裁决期间绝不自动唤醒");
  } finally {
    second.runtime.dispose();
  }
});

// ═════════════════════════════ 11. HMR/dispose 清 timer 与发现、重启重布防不重发 ═════════════════════════════
test("g506 bootstrap HMR：dispose 清掉全部 timer/发现，重建后重新自举且不重发已投递巡检", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const first = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 5, discoveryIntervalMs: 10_000 });
  // 注意：child 的 hold 必须保持到重启验证之后（否则重启时没有真实 running 任务可采样）。
  {
    first.runtime.start();
    const sup = (await host.reg.create({ sessionId: "sup-hmr", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const child = await makeRunningChild(host, sup, ws, "HMR");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });
    claimSupervisor(root, sup.id, "agent:sup-hmr");
    first.runtime.armForRoot(root);
    assert.equal(scheduler.timers.size, 1, "一个 care timer（发现已停止：有 root 布防）");
    await scheduler.advanceTo(clock.now() + 1);
    assert.equal(first.events.filter((e) => e.event === "care.inspection").length, 1);

    first.runtime.dispose();
    assert.equal(scheduler.timers.size, 0, "dispose 必须清掉 care timer 与发现 timer");
  }

  const clock2 = fakeClock(clock.now() + 1000);
  const scheduler2 = fakeScheduler(clock2);
  const second = makeRuntime(host, { clock: clock2, scheduler: scheduler2, defaultWorkspace: () => null, discoveryMaxAttempts: 5, discoveryIntervalMs: 10_000, idPrefix: "hmr" });
  try {
    second.runtime.start();
    second.runtime.armForRoot(root);
    // 恢复口径：重启前已投递未回传 ⇒ 一律 delivered，绝不重发**同一条**巡检
    const restoredAt = clock2.now();
    await scheduler2.advanceTo(restoredAt + 1_000);
    assert.equal(second.events.filter((e) => e.event === "care.inspection").length, 0, "重启后不得立即重发已投递巡检");
    const restored = second.runtime.statusFor(root);
    assert.equal(restored.phase, "awaiting_outcome");
    assert.equal(restored.pending_inspections.length, 1);
    assert.equal(restored.pending_inspections[0].id, "boot-1", "恢复的是同一条巡检（不是新 id）");
    assert.equal(restored.pending_inspections[0].status, "delivered");

    // 新鲜度过期后允许一条**新 id** 的有界提醒（仍受 3 次未回复预算约束），绝不是重发同一条
    await scheduler2.advanceTo(clock2.now() + 301_000);
    const again = second.events.filter((e) => e.event === "care.inspection");
    assert.equal(again.length, 1, "过期后一条有界提醒");
    const pendingIds = second.runtime.statusFor(root).pending_inspections.map((i: any) => String(i.id));
    assert.ok(pendingIds.includes("boot-1"), "原巡检记录保留（不注册新状态）");
    assert.ok(pendingIds.includes("hmr-1"), "新提醒必须是新 id（绝不重发同一条）");
    assert.equal(new Set(pendingIds).size, pendingIds.length, "同一 id 不得重复登记");
  } finally {
    second.runtime.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════════ 12. 无运行 child ⇒ 禁发；child 结束后陈旧提醒失效 ═════════════════════════════
test("g506 bootstrap 无运行 child：已布防也不投递；真实 child 起来后按期投递，结束后不再提醒", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events } = makeRuntime(host, { clock, scheduler, defaultWorkspace: () => null, discoveryMaxAttempts: 0 });
  try {
    runtime.start();
    const sup = (await host.reg.create({ sessionId: "sup-nochild", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent = trackSends(sup);
    claimSupervisor(root, sup.id, "agent:sup-nochild");
    runtime.armForRoot(root);
    assert.notEqual(runtime.entryOfRoot(root).timer, null, "无 child 也允许布防（主管已可信）");

    await scheduler.advanceTo(clock.now() + 360_000);
    assert.equal(sent.length, 0, "没有真实运行中关联子代理 ⇒ 绝不投递");
    assert.equal(events.filter((e) => e.event === "care.inspection").length, 0);

    const child = await makeRunningChild(host, sup, ws, "NOCHILD");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });
    await scheduler.advanceTo(clock.now() + 31_000);
    assert.equal(events.filter((e) => e.event === "care.inspection").length, 1, "真实 child 起来后按期投递一次");
    assert.equal(sent.length, 1);

    // 任务结束 ⇒ 未回传的提醒按真实运行态失效，不得继续自动唤醒
    host.adapter.releaseAll();
    await waitFor(() => child.status !== "running", "child finished", 3000);
    const before = events.filter((e) => e.event === "care.inspection").length;
    await scheduler.advanceTo(clock.now() + 400_000);
    assert.equal(events.filter((e) => e.event === "care.inspection").length, before, "任务结束后陈旧提醒失效，不再提醒");
    assert.equal(sent.length, 1);
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════════ 13. 生产路径：真实 apply + 真实 graph_claim_supervisor 工具 ═════════════════════════════
type ApplyHarness = {
  ctx: any; cleanups: Array<() => void>;
  invoke: (name: string, args: any, ex: any) => Promise<any>;
};

function makeApplyHarness(opts: { config?: any; sandboxWorkspace: string; extraGet?: (name: string) => any; settingsService?: any }): ApplyHarness {
  const registered: any[] = [];
  const cleanups: Array<() => void> = [];
  const stub = createRegisterStub();
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return stub.webServer;
      if (name === "connection") return null;
      if (name === "sandboxPolicy") return { workspaceRoot: opts.sandboxWorkspace };
      return opts.extraGet?.(name);
    },
    effect: (fn: () => unknown) => { const d = fn(); if (typeof d === "function") cleanups.push(d as any); return d; },
    tools: { register: (d: any) => { registered.push(d); return () => {}; }, get: () => undefined },
    ...(opts.settingsService
      ? { inject: (_deps: string[], cb: (sctx: any) => void) => { cb({ settings: opts.settingsService, effect: () => {}, on: () => () => {}, get: ctx.get }); } }
      : {}),
  };
  apply(ctx, opts.config ?? {});
  const invoke = async (name: string, args: any, ex: any) => {
    const tool = registered.find((t) => t.name === name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool.execute(args, ex);
  };
  return { ctx, cleanups, invoke };
}

const careSettingsStub = {
  describe: () => [{
    ns: "dsh-graph-host",
    value: { supervisorCare: "on", supervisorCareThresholdSeconds: "120", supervisorCareRecheckSeconds: "300" },
    user: { supervisorCare: "on", supervisorCareThresholdSeconds: "120", supervisorCareRecheckSeconds: "300" },
    revision: 1,
  }],
  configure: () => {},
};

test("g506 生产路径：默认 workspace 指向别的 root 时，真实 graph_claim_supervisor 工具成功 claim 即布防并真实投递", async () => {
  const host = await makeRealHost();
  const target = boardWithCare(120);
  const otherWs = ownedDir("ws-default-other");
  init(join(otherWs, ".dsh-graph"));

  // 目标 workspace 的 claim 前状态：project.yaml 已有 care 配置但无 supervisor（3110 现场）
  assert.equal(readSupervisorSession(target.root), null);
  const sup = (await host.reg.create({ sessionId: "sup-prod", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: target.ws } })).agent;
  const child = await makeRunningChild(host, sup, target.ws, "PROD");
  writeRealGoal(target.root, { child: child.id, parent: sup.id, startedAt: new Date(Date.now() - 130_000).toISOString() });
  const sent = trackSends(sup);

  // 默认 workspace = 别的 root（sandboxPolicy），config.root 不是绝对路径 ⇒ 启动不布防目标 root
  const h = makeApplyHarness({ sandboxWorkspace: otherWs, extraGet: (n) => (n === "agents" ? host.reg : n === "llm" ? host.llmRuntime : undefined), settingsService: careSettingsStub });
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(readEvents(target.root).filter((e: any) => e.event === "care.inspection").length, 0, "启动时默认根不是目标 root ⇒ 尚未投递");

    // 真实工具链：graph_claim_supervisor（GUI/CLI 同一个工具入口）
    const res = await h.invoke("graph_claim_supervisor", {}, { agent: sup });
    assert.equal(res.supervisor_session, sup.id);
    assert.equal(readSupervisorSession(target.root), sup.id);

    // 不读设置页、不 sweep、不轮询 status：只等真实 setTimeout 到期
    await waitFor(() => readEvents(target.root).some((e: any) => e.event === "care.inspection"), "real care.inspection", 5000);
    const careEv = readEvents(target.root).filter((e: any) => e.event === "care.inspection");
    assert.equal(careEv.length, 1, "成功 claim 后真实 timer 恰好投递一次");
    assert.equal(careEv[0].details?.care_state?.supervisor, sup.id);
    assert.equal(sent.length, 1, "真实 agent.send 一次");
    assert.equal(sent[0].source?.kind, "dsh-graph-care");
    assert.equal(sent[0].role, "user");
  } finally {
    host.adapter.releaseAll();
    for (const fn of h.cleanups) { try { fn(); } catch { /* ignore */ } }
    try { await sup.whenIdle?.(); } catch { /* ignore */ }
  }
});

test("g506 生产路径负向：绕过 claim 工具直写 project.yaml 且无事件 ⇒ 不布防（钩子就是触发器）", async () => {
  const host = await makeRealHost();
  const target = boardWithCare(120);
  const otherWs = ownedDir("ws-default-other2");
  init(join(otherWs, ".dsh-graph"));
  const sup = (await host.reg.create({ sessionId: "sup-prod-neg", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: target.ws } })).agent;
  const child = await makeRunningChild(host, sup, target.ws, "PRODNEG");
  writeRealGoal(target.root, { child: child.id, parent: sup.id, startedAt: new Date(Date.now() - 130_000).toISOString() });
  const sent = trackSends(sup);

  const h = makeApplyHarness({ sandboxWorkspace: otherWs, extraGet: (n) => (n === "agents" ? host.reg : n === "llm" ? host.llmRuntime : undefined), settingsService: careSettingsStub });
  try {
    // 直写 project.yaml（不经工具、无 Cordis 事件；有界发现窗口 30s 远未到）
    claimSupervisor(target.root, sup.id, "human:gui");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(readEvents(target.root).filter((e: any) => e.event === "care.inspection").length, 0, "无工具/无事件 ⇒ 不布防、不投递");
    assert.equal(sent.length, 0);
  } finally {
    host.adapter.releaseAll();
    for (const fn of h.cleanups) { try { fn(); } catch { /* ignore */ } }
    try { await sup.whenIdle?.(); } catch { /* ignore */ }
  }
});
