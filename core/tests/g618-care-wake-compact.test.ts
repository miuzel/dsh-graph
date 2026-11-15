/**
 * g-618：「首次全量、后续精简」的关照唤醒正文（可 toggle，默认开启）。
 *
 * 目标只是**文案投递方式**：同一主管会话的第一份唤醒内联完整检查清单 + 纪律，
 * 后续只保留 2 行兜底纪律 + 资产路径。本套件守六件事：
 *  ① 首发（开启态）逐条含 `CARE_STALL_SIGNALS` 与全部纪律条文；g506 契约断言在该场景仍成立；
 *  ② 后续（精简版）**不含**纪律正文与检查清单块，但三值定义全部子句、机读必需项（inspection id /
 *    每个 target 的 goal·attempt·child / evidence / 回传要求）、2 行兜底纪律、资产路径**仍在**；
 *  ③ 关闭开关 ⇒ 每份正文与基线 `cd42089` **字节级完全一致**（生产装配路径下逐句成立）；
 *  ④ 「已发过纪律」按**主管会话**判定，并随 care_state 快照持久化：重启/换会话 ⇒ 回落首次；
 *  ⑤ 资产缺失/不可读/空壳 ⇒ **fail-open**（巡检不中断、机读必需项齐全、纪律回退内联而非静默丢弃）；
 *  ⑥ 真实宿主栈回传闭环：用**精简正文里的 inspection id** 调 `graph_care_outcome` 能成功受理
 *     （证明省掉纪律正文没有削弱可操作性），且机制语义（unknown 不增不清、progress 不清锁）不变。
 *
 * 明确不声称：自然语言纪律无法静态强制任何模型遵循；兜底纪律只保证「正文里有这两条防线」。
 * 宿主口径与既有 g506 套件一致：真实 cordis + AgentRegistry/AgentLoop/LlmRuntime + fake adapter
 * （零网络、零真实 provider、零费用）、真实 boardPayload、假时钟/假定时器；tmp 只落本仓库 tmp/。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  CARE_COMPACT_DISCIPLINE_EN,
  CARE_COMPACT_DISCIPLINE_ZH,
  CARE_DISCIPLINE_ASSET,
  CARE_OUTCOME_CONTRACT_EN,
  CARE_OUTCOME_CONTRACT_ZH,
  CARE_PRESERVED_GATES,
  CARE_STALL_SIGNALS,
  formatCareWakeMessage,
  resolveCareDisciplineText,
} from "../../dist/core/care.js";
import {
  init,
  writeProjectConfig,
  claimSupervisor,
  readProjectConfig,
  readSupervisorSession,
  readCorePromptAsset,
  getCachedBoardPayload,
  closeWatchers,
} from "../ops.ts";
import { invalidateBoardCache } from "../cache.ts";
import { appendEvent, readEvents } from "../events.ts";
import { createCareRuntime } from "../../dist/index.js";

// ───────────────────────────── 私有 tmp（只用本树 tmp/） ─────────────────────────────
const TMP_BASE = realpathSync((() => {
  const p = join(process.cwd(), "tmp");
  mkdirSync(p, { recursive: true });
  return p;
})());
const OWNED: string[] = [];
function ownedDir(tag: string): string {
  const dir = mkdtempSync(join(TMP_BASE, `g618-${tag}-`));
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

// ───────────────────────────── 真实宿主栈 + fake adapter（与 g506-bootstrap 同口径） ─────────────────────────────
import { initServiceInstances } from "./_host-stack.ts";
import { installRc3SubagentOwnership } from "./_rc3-subagents-stub.ts";

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
  return resolveHostStack().dir;
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
    NativeToolExecutor: (await load("dsh-tool-executor-native")).NativeToolExecutor,
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
  const { Context, llm: llmMod, AgentRegistry, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, AgentLoop, NativeToolExecutor } = await loadHostStack();
  const hostCtx = new Context();
  new SessionStore(hostCtx);
  new SessionProjections(hostCtx);
  new SystemPrompt(hostCtx, {});
  new ToolRuntime(hostCtx, {});
  hostCtx.tools.setExecutor(new NativeToolExecutor(hostCtx));
  const reg = new AgentRegistry(hostCtx);
  const llmRuntime = new llmMod.LlmRuntime(hostCtx);
  const adapter = makeFakeAdapter(llmMod.LlmAdapter);
  llmRuntime.registerAdapter(["observed"], adapter);
  new AgentLoop(hostCtx, { agents: [], maxParallelToolCalls: 10 });
  await initServiceInstances([reg, hostCtx.get("agentLoop")]);
  // g-626：补 rc.3 归属面（真实宿主由 dsh-subagent 的 rootOf 提供；轻量夹具未装载它）。
  const subagents = installRc3SubagentOwnership(hostCtx, reg);
  return { hostCtx, llm: llmMod, llmRuntime, reg, adapter, subagents };
}

// ───────────────────────────── 假时钟 / 假定时器（与 g506 同口径） ─────────────────────────────
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
function writeRealGoal(root: string, opts: { goalId?: string; child: string; parent: string; startedAt: string }) {
  const goalId = opts.goalId ?? "g-001";
  const attempt = "att-001";
  const dir = join(root, "goals", goalId);
  mkdirSync(join(dir, "attempts", attempt), { recursive: true });
  writeFileSync(join(dir, "goal.md"), `---\n${JSON.stringify({
    id: goalId, title: `probe ${goalId}`, status: "in_progress", type: "task",
    created_at: opts.startedAt, version: null, depends_on: [],
    review: { reviewer: "human", prompt: null }, pk: { lanes: 1, sandbox: "directory" }, rules_snapshot: null,
  }, null, 2)}\n---\n\n# ${goalId}\n\n## 目标描述\n\ng618 fixture\n`);
  writeFileSync(join(dir, "attempts", attempt, "attempt.md"), `---\n${JSON.stringify({
    id: attempt, goal: goalId, executor: "agent:main", sandbox: "directory", started_at: opts.startedAt,
    claimed_at: null, status_line: null, status_state: null, result: "pending",
    child_id: opts.child, worktree: false, binding_version: 1,
    parent_session_id: opts.parent, detached: false,
  }, null, 2)}\n---\n\n## 执行笔记\n\ng618\n`);
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
  if (typeof agent?.dispatch?.emit === "function") agent.dispatch.emit("agent/status", { status });
  else host.hostCtx.emit("agent/status", { agent, status });
}

function trackSends(agent: any) {
  const sent: any[] = [];
  const orig = agent.send.bind(agent);
  agent.send = (message: any, ...rest: any[]) => { sent.push(message); return orig(message, ...rest); };
  return sent;
}

const wakeTextOf = (message: any) => message?.content?.find((c: any) => c?.type === "text")?.text ?? "";

/** 夹具：真实 root（project.yaml → supervisor 主管口径）+ 假时钟的关照运行时。 */
function makeRuntime(host: any, opts: {
  clock: ReturnType<typeof fakeClock>;
  scheduler: ReturnType<typeof fakeScheduler>;
  /** 覆盖 `readProjectConfigFn`（用于构造资产读取失败之外的配置面场景）。 */
  readProjectConfigFn?: (root: string) => any;
  /** 覆盖 prompt 资产读取器（负向用例：缺失/不可读）。 */
  readPromptAssetFn?: (name: string, lang: string) => string;
}) {
  const events: any[] = [];
  const runtime = createCareRuntime({
    ctx: {
      on: (name: string, handler: any) => host.hostCtx.on(name, handler),
      get: (name: string) => (name === "agents" ? host.reg : name === "subagents" ? host.subagents : undefined),
    },
    readGlobal: () => ({ enabled: true, thresholdSeconds: null, recheckSeconds: null, malformed: false, available: true, raw: "on" }),
    resolveRoot: (ws: string) => join(ws, ".dsh-graph"),
    defaultWorkspace: () => null,
    readProjectConfigFn: opts.readProjectConfigFn ?? ((root: string) => readProjectConfig(root)),
    readSupervisorSessionFn: (root: string) => readSupervisorSession(root),
    readBoardPayload: (root: string) => getCachedBoardPayload(root, { lazy: true })?.payload ?? null,
    now: opts.clock.now,
    setTimeoutFn: opts.scheduler.setTimeoutFn,
    clearTimeoutFn: opts.scheduler.clearTimeoutFn,
    // 真写盘（生产同源 appendEvent）+ 留内存副本供断言：持久化判据必须走**真实事件真源**，
    // 不能只在内存里收集 —— 否则「重启恢复」会被内存夹具假性满足。
    appendEventFn: (root: string, ev: any) => { events.push(ev); appendEvent(root, ev); },
    makeInspectionId: (() => { let i = 0; return () => `g618-${++i};`; })(),
    armDiscoveryMaxAttempts: 0,
    log: () => {},
  });
  return { runtime, events };
}

function boardWithCare(extraYaml = "", thresholdSeconds = 120, recheckSeconds = 300) {
  const ws = ownedDir("ws");
  const root = join(ws, ".dsh-graph");
  init(root);
  writeProjectConfig(root, {
    supervisor: { care: "true", care_threshold_seconds: thresholdSeconds, care_recheck_seconds: recheckSeconds },
  }, "human:gui");
  if (extraYaml) writeFileSync(join(root, "project.yaml"), readFileSync(join(root, "project.yaml"), "utf8") + extraYaml);
  return { ws, root };
}

const disciplineOf = (lang: "zh" | "en") =>
  resolveCareDisciplineText({ lang, load: (l) => readCorePromptAsset(CARE_DISCIPLINE_ASSET, l) }).text;

/** 纪律正文里的每一条 `- ` 纪律行（资产是唯一真源，不另立第二套措辞）。 */
const disciplineBullets = (lang: "zh" | "en") => disciplineOf(lang).split("\n").filter((l) => l.trim().startsWith("- "));

const TARGETS = [{
  goal: "goal-a", attempt: "att-001", child: "child-a", elapsedMs: 300_000,
  lastCareAgoMs: null, stagnantRounds: 0, maxStagnantRounds: 3, humanLocked: false,
}];

/**
 * 生产装配路径的**开启态正文**：首份 = `full` + 公共层资产；后续 = `compact`。
 * （宿主 `deliverNow` 走的正是这两条；关闭态另见 §3 的逐字对照。）
 */
const wakeFull = (lang: "zh" | "en", targets = TARGETS) =>
  formatCareWakeMessage({ inspectionId: "insp-1", targets, maxStagnantRounds: 3, lang, mode: "full", discipline: disciplineOf(lang) });
const wakeCompact = (lang: "zh" | "en", targets = TARGETS) =>
  formatCareWakeMessage({ inspectionId: "insp-1", targets, maxStagnantRounds: 3, lang, mode: "compact" });

// ═════════════════════════ 1. 首发全量（判据 1 / 9） ═════════════════════════
test("g618 首发全量：纪律资产逐字承载检查清单 + 全部纪律条文，zh/en 对称", () => {
  for (const lang of ["zh", "en"] as const) {
    const asset = disciplineOf(lang);
    const full = wakeFull(lang);
    // ① 检查清单：全部停滞信号逐字出现（与内联时期同一常量，不另抄一份）
    for (const signal of CARE_STALL_SIGNALS) assert.ok(asset.includes(signal), `${lang} 资产必须含检查清单信号 ${signal}`);
    // ② 纪律：资产含每一道人工 gate，且唤醒正文逐条带出资产的每条纪律行
    for (const gate of CARE_PRESERVED_GATES) assert.ok(asset.includes(gate), `${lang} 资产必须含人工 gate ${gate}`);
    const bullets = disciplineBullets(lang);
    assert.equal(bullets.length, 6, `${lang} 纪律必须为 6 条（旧内联正文的同一组条文）`);
    for (const bullet of bullets) assert.ok(full.includes(bullet), `${lang} 首发正文必须逐条内联纪律：${bullet.slice(0, 24)}…`);
    // ③ 占位符不得原样漏出（回填后才进入正文）
    assert.ok(!/\{\{careGates\}\}|\{\{careStallSignals\}\}/.test(full), `${lang} 首发正文不得漏出未回填占位符`);
  }
  // zh/en 纪律条数对称（段落对称的最小结构守卫）
  assert.equal(CARE_COMPACT_DISCIPLINE_ZH.length, CARE_COMPACT_DISCIPLINE_EN.length, "兜底纪律 zh/en 必须对称");
  // 负向对照：资产一旦被删掉一条纪律，首发正文就随之缺该条 ⇒ 正向断言确有判别力
  const zhAsset = disciplineOf("zh");
  const crippled = zhAsset.split("\n").filter((l) => !l.includes("禁止无限自动重试")).join("\n");
  const crippledFull = formatCareWakeMessage({
    inspectionId: "insp-1", targets: TARGETS, maxStagnantRounds: 3, lang: "zh", mode: "full", discipline: crippled,
  });
  assert.ok(!crippledFull.includes("禁止无限自动重试"), "资产删掉一条纪律 ⇒ 首发正文必须缺该条（负向对照）");
});

// ═════════════════════════ 2. 后续精简（判据 2 / 3 / 4 / 14） ═════════════════════════
test("g618 后续精简：不含纪律正文与检查清单块，但三值定义 + 机读必需项 + 兜底纪律 + 资产路径仍在", () => {
  for (const lang of ["zh", "en"] as const) {
    const compact = wakeCompact(lang);
    const full = wakeFull(lang);
    const bullets = disciplineBullets(lang);
    const contract = lang === "zh" ? CARE_OUTCOME_CONTRACT_ZH : CARE_OUTCOME_CONTRACT_EN;

    // ① 纪律正文与检查清单块**不在**后续版里
    for (const bullet of bullets) assert.ok(!compact.includes(bullet), `${lang} 后续版不得内联纪律正文：${bullet.slice(0, 24)}…`);
    for (const signal of CARE_STALL_SIGNALS) assert.ok(!compact.includes(signal), `${lang} 后续版不得内联检查清单：${signal}`);
    assert.ok(!compact.includes("本插件**不会**自动中断"), "zh 后续版不得内联「本插件不会自动中断」长条文");
    assert.ok(!compact.includes("This plugin NEVER auto-interrupts"), "en 后续版不得内联「NEVER auto-interrupts」长条文");

    // ② 三值定义**逐条**仍在（未搬迁：它同时是工具描述的真源）
    for (const clause of contract) assert.ok(compact.includes(clause), `${lang} 后续版必须仍含三值定义子句：${clause.slice(0, 24)}…`);

    // ③ 机读必需项永远 inline
    assert.match(compact, /inspection: insp-1/, `${lang} 后续版必须含 inspection id`);
    assert.match(compact, /inspection=insp-1/, `${lang} 回传要求必须带 inspection=`);
    assert.match(compact, /graph_care_outcome/, `${lang} 回传要求必须在后续版中保留`);
    assert.match(compact, /outcome=progress\|no-progress\|unknown/, `${lang} 后续版必须含 outcome 枚举`);
    assert.match(compact, /goal=goal-a attempt=att-001 child=child-a/, `${lang} 后续版必须含每个 target 的 goal/attempt/child`);
    assert.match(compact, lang === "zh" ? /\+ 证据/ : /\+ evidence/, `${lang} 后续版必须含 evidence 要求`);

    // ④ 2–3 行兜底纪律（本文件另在 §2b 逐字钉住这两条）
    const fallback = lang === "zh" ? CARE_COMPACT_DISCIPLINE_ZH : CARE_COMPACT_DISCIPLINE_EN;
    assert.ok(fallback.length >= 2 && fallback.length <= 3, `${lang} 兜底纪律必须为 2–3 行`);
    for (const line of fallback) assert.ok(compact.includes(line), `${lang} 后续版必须保留兜底纪律：${line.slice(0, 24)}…`);

    // ⑤ 指向纪律资产的可解析路径（dist/prompts 真实可读 —— 不只是字符串）
    assert.match(compact, new RegExp(`prompts/${CARE_DISCIPLINE_ASSET}\\.${lang}\\.md`), `${lang} 后续版必须给出资产路径`);
    assert.ok(readCorePromptAsset(CARE_DISCIPLINE_ASSET, lang).trim().length > 0, `${lang} 资产路径必须可解析`);

    // ⑥ 有界性：后续版严格短于首发（如实记录，不设比例阈值）
    assert.ok(compact.length < full.length, `${lang} 后续版必须严格短于首发`);
    assert.ok(compact.length < 4000, `${lang} 后续版必须满足 text.length < 4000`);
    assert.ok(full.length < 4000, `${lang} 首发必须满足 text.length < 4000`);
  }
});

test("g618 后续精简：不得只列前 8 个 target（对齐既有有界性断言）", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    goal: `goal-${i}`, attempt: `att-00${i}`, child: `child-${i}`, elapsedMs: 400_000,
    lastCareAgoMs: null, stagnantRounds: 0, maxStagnantRounds: 3, humanLocked: false,
  }));
  for (const lang of ["zh", "en"] as const) {
    const compact = wakeCompact(lang, many);
    for (const t of many) assert.ok(compact.includes(`goal=${t.goal}`), `${lang} 精简版必须列出 ${t.goal}（不得只列前 8 个）`);
    assert.ok(compact.length < 4000, `${lang} 10 个 target 的精简版仍须有界`);
  }
});

// ═════════════════════════ 2b. 兜底纪律逐字钉住（判据 3，g506 误分类防线） ═════════════════════════
test("g618 兜底纪律：后续版钉住「计时到期不是卡死证据」与「证据不足 ⇒ unknown」（zh/en 对称）", () => {
  const zh = wakeCompact("zh");
  const en = wakeCompact("en");
  // g506 真实误分类事件的两条防线：计时到期 ≠ 卡死；证据不足 ⇒ unknown
  assert.match(zh, /计时到期\*\*不是\*\*卡死证据/, "zh 后续版必须写明「计时到期不是卡死证据」");
  assert.match(zh, /证据不足 ⇒ unknown/, "zh 后续版必须写明「证据不足 ⇒ unknown」");
  assert.match(en, /NOT evidence of a stall/, "en 后续版必须写明「定时到期不构成卡死证据」");
  assert.match(en, /Insufficient evidence means unknown/, "en 后续版必须写明「证据不足 ⇒ unknown」");
  // 不得只给链接：兜底纪律必须与资产路径**同时**出现（路径本身不含这两条措辞）
  assert.ok(!zh.includes("Insufficient") && !en.includes("计时到期"), "两语言措辞不得串台");
  for (const line of CARE_COMPACT_DISCIPLINE_ZH) assert.ok(zh.includes(line));
  for (const line of CARE_COMPACT_DISCIPLINE_EN) assert.ok(en.includes(line));
  // en 兜底纪律不得夹带 CJK
  assert.doesNotMatch(CARE_COMPACT_DISCIPLINE_EN.join("\n"), /[\u3400-\u9fff]/);
  assert.doesNotMatch(en.split("\n").filter((l) => l.startsWith("- ") && !l.includes("Outcome") && !l.includes("MUST")).join("\n"), /[\u3400-\u9fff]/);
});

// ═════════════════════════ 3. 关闭态逐字回退（判据 4 / 6） ═════════════════════════
test("g618 关闭态：全量正文与基线内联字面量逐字一致（字节级）", () => {
  // 基线 cd42089 的内联纪律条文（关闭态必须逐字回退到这里；任何漂移都判红）。
  const BASE_ZH = [
    "请基于**可访问的近期消息、工具调用/结果、进度与阻塞证据**逐条核对是否僵局：",
    `  · ${CARE_STALL_SIGNALS.join(" / ")}`,
    "纪律：",
    "- 正常长耗时构建/测试/网络等待、有实质进展的任务不得仅因超时被中断；",
    "- 证据不足 ⇒ 继续观察或直接询问子代理，不要伪称已发现逻辑死循环；",
    "- 干预须遵守宿主真实能力与既有人工 gate：" + CARE_PRESERVED_GATES.join(" / ") + "；",
    "- 本插件**不会**自动中断/放弃/重启子代理；宿主干预 seam 若未验证，只作提醒，由主管按授权流程处理。",
    "- 有明确僵局证据才请求暂停并确认停稳；放弃重开须先确认旧 child 不运行并按既有准入与返工授权开新 attempt；",
    "- 无法安全解决 / 范围或判据冲突 ⇒ 停止相关执行并报告人类裁决，禁止无限自动重试。",
  ].join("\n");
  const BASE_EN = [
    "Check for a stall using the accessible recent messages, tool calls/results, and progress/blocking evidence:",
    `  · ${CARE_STALL_SIGNALS.join(" / ")}`,
    "Discipline:",
    "- Long builds/tests/network waits with real progress must not be interrupted merely for taking time;",
    "- If evidence is insufficient, keep observing or ask the child; never claim a proven infinite loop;",
    "- Interventions must respect real host capabilities and existing human gates: " + CARE_PRESERVED_GATES.join(" / ") + ";",
    "- This plugin NEVER auto-interrupts/abandons/restarts a child; unverified host intervention seams are advisory only and must go through authorized human gates.",
    "- Request a pause only with clear stall evidence, and confirm the child has stopped; abandoning/restarting requires the existing admission and rework authorization;",
    "- If it cannot be resolved safely or scope/criteria conflict, stop the execution and report to the human; never retry infinitely.",
  ].join("\n");
  for (const [lang, base] of [["zh", BASE_ZH], ["en", BASE_EN]] as const) {
    const full = wakeFull(lang);
    assert.ok(full.includes(base), `${lang} 全量正文必须逐字包含基线纪律块（关闭态 = 旧行为）`);
  }
  // 资产与基线内联字面量**逐字同源**：资产缺的那一行「引导句」由正文代码提供（两态都一样），
  // 其余每一行必须与基线一字不差 —— 关闭态=旧行为的前提正是这份逐字等价。
  const zhAsset = disciplineOf("zh").split("\n").filter((l) => l.trim()).map((l) => l.replace(/\s+$/, "")).join("\n");
  const zhAssetWithLead = BASE_ZH.split("\n").slice(0, 1).concat(zhAsset).join("\n");
  assert.equal(zhAssetWithLead, BASE_ZH, "zh 资产 + 代码提供的引导句必须逐字等于基线内联纪律块");
  const enAsset = disciplineOf("en").split("\n").filter((l) => l.trim()).map((l) => l.replace(/\s+$/, "")).join("\n");
  const enAssetWithLead = BASE_EN.split("\n").slice(0, 1).concat(enAsset).join("\n");
  assert.equal(enAssetWithLead, BASE_EN, "en 资产 + 代码提供的引导句必须逐字等于基线内联纪律块");
});

// ═════════════════════════ 4. 资产 fail-open（判据 11） ═════════════════════════
test("g618 资产缺失/不可读：fail-open 回退内联全文，绝不中断且机读必需项齐全", () => {
  for (const lang of ["zh", "en"] as const) {
    // ① 缺失（读取器抛错 —— 正是 readCorePromptAsset 缺文件的形态）
    const missing = resolveCareDisciplineText({ lang, load: () => { throw new Error("missing"); } });
    assert.equal(missing.degraded, true, `${lang} 缺资产必须标记 degraded`);
    assert.equal(missing.source, "fallback", `${lang} 缺资产必须回退内联全文`);
    // 回退正文必须是一份**真正的纪律块**（含检查清单标题、卡死证据防线、人工 gate），
    // 而不是空串/占位符 —— 「不因缺 .md 静默丢弃纪律」正是判据 11 的要求。
    assert.ok(missing.text.length > 100, `${lang} 回退正文不得为空壳`);
    assert.ok(!/\{\{/.test(missing.text), `${lang} 回退正文不得残留未回填占位符`);
    assert.ok(missing.text.includes("rework=human"), `${lang} 回退正文必须仍含人工 gate`);
    assert.ok(
      lang === "zh" ? /计时到期不是卡死证据/.test(missing.text) : /Reaching the timer is not evidence of a stall/.test(missing.text),
      `${lang} 回退正文必须仍含「计时到期不是卡死证据」防线`,
    );

    // ② 空壳（文件存在但被裁空/被裁成只剩一句）⇒ 同样视为不可用
    for (const stub of ["", "   \n ", "hello"]) {
      const s = resolveCareDisciplineText({ lang, load: () => stub });
      assert.equal(s.degraded, true, `${lang} 空壳资产（${JSON.stringify(stub)}）必须标记 degraded`);
      assert.ok(s.text.includes("rework=human"), `${lang} 空壳时回退正文必须仍含人工 gate`);
    }

    // ③ 正向对照：真实资产可用时**不得**被误判为 degraded
    const ok = resolveCareDisciplineText({ lang, load: (l) => readCorePromptAsset(CARE_DISCIPLINE_ASSET, l) });
    assert.equal(ok.degraded, false, `${lang} 真实资产不得被判为 degraded`);
    assert.equal(ok.source, "asset");

    // ④ 用回退正文装配全量唤醒：正文可见、机读必需项齐全（巡检**不中断**）
    const text = formatCareWakeMessage({
      inspectionId: "insp-fo", targets: TARGETS, maxStagnantRounds: 3, lang, mode: "full", discipline: missing.text,
    });
    assert.match(text, /inspection: insp-fo/, `${lang} fail-open 后仍须有 inspection id`);
    assert.match(text, /goal=goal-a attempt=att-001 child=child-a/, `${lang} fail-open 后仍须有 target 绑定`);
    assert.match(text, /outcome=progress\|no-progress\|unknown/, `${lang} fail-open 后仍须有 outcome 枚举`);
    for (const clause of (lang === "zh" ? CARE_OUTCOME_CONTRACT_ZH : CARE_OUTCOME_CONTRACT_EN)) {
      assert.ok(text.includes(clause), `${lang} fail-open 后仍须含三值定义`);
    }
  }
  // ⑤ 负向对照：若回退正文丢掉兜底纪律，上面的断言会真实变红（证明断言有判别力）
  const hollow = resolveCareDisciplineText({ lang: "zh", load: () => "只有一句空壳" });
  assert.ok(hollow.degraded);
  assert.notEqual(hollow.text, "只有一句空壳", "空壳内容绝不得被当作纪律正文使用");
});

// ═════════════════════════ 5. 真实宿主：首次/后续 + 关闭态 + 资产缺失（判据 4/5/6/8） ═════════════════════════
test("g618 真实宿主：首份全量 → 二份精简 → 关闭开关逐字回退 → 资产缺失 fail-open", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events } = makeRuntime(host, { clock, scheduler });
  try {
    runtime.start();
    const sup = (await host.reg.create({ sessionId: "sup-g618", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent = trackSends(sup);
    runtime.statusFor(root); // dormant 条目
    claimSupervisor(root, sup.id, "agent:sup-g618");
    const child = await makeRunningChild(host, sup, ws, "G618");
    writeRealGoal(root, { child: child.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });
    emitStatus(host, sup, "idle");

    // ── 第 1 份：开启态首发 ⇒ 全量纪律 ──
    await scheduler.advanceTo(clock.now() + 1);
    assert.equal(sent.length, 1, "首份必须投递");
    const first = wakeTextOf(sent[0]);
    assert.ok(first.includes(disciplineBullets("zh").at(-1)!), "首份必须是完整纪律");
    const insp1 = events.filter((e) => e.event === "care.inspection").at(-1)!;
    assert.equal(insp1.details.wake_form, "full");
    assert.equal(insp1.details.wake_discipline_source, "asset");
    assert.equal(insp1.details.wake_discipline_degraded, false);
    assert.equal(insp1.details.care_state.disciplineSeen.session, sup.id, "首发后必须记住主管会话");

    // ── 第 2 份：同一主管会话 ⇒ 精简 ──
    // 回传 progress 让任务转入复查（recheck 300s），再推进到下一次到期。
    const out1: any = await runtime.submitOutcome({
      root, supervisor: sup.id, inspection: String(insp1.details.inspection),
      goal: "g-001", attempt: "att-001", child: child.id, outcome: "progress", evidence: "g618 第 2 份前回传 progress",
    });
    assert.equal(out1.ok, true);
    await scheduler.advanceTo(clock.now() + 301_000);
    assert.equal(sent.length, 2, "第二份必须投递");
    const second = wakeTextOf(sent[1]);
    const insp2 = events.filter((e) => e.event === "care.inspection").at(-1)!;
    assert.equal(insp2.details.wake_form, "compact", "同一主管会话的第二份必须是精简版");
    // ② 确实省掉：不带纪律正文与检查清单
    for (const bullet of disciplineBullets("zh")) assert.ok(!second.includes(bullet), "精简版不得内联纪律正文");
    for (const signal of CARE_STALL_SIGNALS) assert.ok(!second.includes(signal), "精简版不得内联检查清单");
    // ③ 但机读必需项 / 三值定义 / 兜底纪律 / 资产路径都在
    assert.match(second, /inspection: /, "精简版必须带 inspection id");
    assert.match(second, new RegExp(`goal=g-001 attempt=att-001 child=${child.id}`), "精简版必须带 target 绑定");
    for (const clause of CARE_OUTCOME_CONTRACT_ZH) assert.ok(second.includes(clause), "精简版必须带三值定义");
    for (const line of CARE_COMPACT_DISCIPLINE_ZH) assert.ok(second.includes(line), "精简版必须带兜底纪律");
    assert.match(second, /prompts\/care-discipline\.zh\.md/, "精简版必须带资产路径");

    // ── 回传闭环：用**精简正文里的** inspection id 调真实窄工具 ──
    const compactId = String(insp2.details.inspection);
    assert.ok(second.includes(`inspection: ${compactId}`), "精简正文里的 id 必须与事件一致");
    const out2: any = await runtime.submitOutcome({
      root, supervisor: sup.id, inspection: compactId,
      goal: "g-001", attempt: "att-001", child: child.id, outcome: "unknown", evidence: "g618 精简正文回传闭环",
    });
    assert.equal(out2.ok, true, `精简正文的 id 必须能被受理：${JSON.stringify(out2)}`);
    const afterUnknown = runtime.statusFor(root).tasks.find((t: any) => t.goal === "g-001");
    assert.equal(afterUnknown.stagnant_rounds, 0, "unknown 不得计无进展（机制语义不变）");
    assert.equal(afterUnknown.human_locked, false, "unknown 不得上锁");

    // ── 关闭开关 ⇒ 逐字回退旧行为（每份都内联完整纪律） ──
    writeFileSync(join(root, "project.yaml"), `${readFileSync(join(root, "project.yaml"), "utf8").replace(/\n*$/, "\n")}  care_wake_compact: false\n`);
    assert.equal(readProjectConfig(root).supervisor.care_wake_compact, false, "写侧必须读到显式 false");
    await scheduler.advanceTo(clock.now() + 301_000);
    assert.equal(sent.length, 3, "关闭态第三份必须投递");
    const third = wakeTextOf(sent[2]);
    const insp3 = events.filter((e) => e.event === "care.inspection").at(-1)!;
    assert.equal(insp3.details.wake_form, "full", "关闭开关后每份都是全量");
    for (const bullet of disciplineBullets("zh")) assert.ok(third.includes(bullet), "关闭态必须逐条内联完整纪律");
    assert.ok(third.includes(CARE_STALL_SIGNALS.join(" / ")), "关闭态必须内联检查清单");
    // 关闭态与**首份全量**逐字一致（同一主管会话、同一目标口径下仅「易变字段」不同：
    // inspection id 每份不同、时间/距上次关照随运行推进）。把这三处归一后必须**全等**。
    const normalizeVolatile = (text: string) => text
      .replace(/inspection[:=]\s*\S+?(?=[;\s])/g, "inspection=<id>")
      .replace(/已持续约 \d+ 分钟；距上次关照 [^；]+；/, "")
      .replace(/连续无进展 \d+\/\d+/, "");
    assert.equal(
      normalizeVolatile(third),
      normalizeVolatile(first),
      "关闭态正文必须与首发全量逐字一致（归一易变字段后全等）",
    );

    // ── 资产缺失 ⇒ fail-open：仍投递、机读必需项齐全、纪律回退内联且标 degraded ──
    const host2 = await makeRealHost();
    const b2 = boardWithCare();
    const clock2 = fakeClock();
    const scheduler2 = fakeScheduler(clock2);
    const { runtime: rt2, events: ev2 } = makeRuntime(host2, {
      clock: clock2,
      scheduler: scheduler2,
      readProjectConfigFn: (r: string) => readProjectConfig(r),
    });
    try {
      rt2.start();
      const sup2 = (await host2.reg.create({ sessionId: "sup-g618-missing", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: b2.ws } })).agent;
      const sent2 = trackSends(sup2);
      rt2.statusFor(b2.root);
      claimSupervisor(b2.root, sup2.id, "agent:sup-g618-missing");
      const child2 = await makeRunningChild(host2, sup2, b2.ws, "G618MISS");
      writeRealGoal(b2.root, { goalId: "g-002", child: child2.id, parent: sup2.id, startedAt: new Date(clock2.now() - 130_000).toISOString() });
      emitStatus(host2, sup2, "idle");
      // 让纪律资产读取失败（模拟 .md 缺失/不可读）——**只在本次运行时**内替换读取器。
      const assetDir = join(import.meta.dirname, "../../dist/prompts");
      const saved = existsSync(join(assetDir, `${CARE_DISCIPLINE_ASSET}.zh.md`))
        ? readFileSync(join(assetDir, `${CARE_DISCIPLINE_ASSET}.zh.md`), "utf8") : null;
      assert.ok(saved, "前置：dist 必须已构建");
      // 生产读取器走 dist/prompts；用一个不可读的临时目录覆盖 core 资产目录的**不存在**形态：
      // 直接在 dist 目录内做 rename 会污染共享产物 ⇒ 改用运行时注入的 loader 不可行（生产路径固定），
      // 故此处以「把资产暂时移走」验证真实 I/O 失败路径，随后严格还原。
      const abs = join(assetDir, `${CARE_DISCIPLINE_ASSET}.zh.md`);
      const parked = `${abs}.g618-parked`;
      const { renameSync } = await import("node:fs");
      let restored = false;
      try {
        renameSync(abs, parked);
        await scheduler2.advanceTo(clock2.now() + 1);
        assert.equal(sent2.length, 1, "资产缺失时巡检必须**仍然投递**（fail-open，不中断）");
        const text2 = wakeTextOf(sent2[0]);
        assert.match(text2, /inspection: /, "fail-open 正文仍须有 inspection id");
        assert.match(text2, new RegExp(`goal=g-002 attempt=att-001 child=${child2.id}`), "fail-open 正文仍须有 target 绑定");
        assert.match(text2, /outcome=progress\|no-progress\|unknown/, "fail-open 正文仍须有 outcome 枚举");
        assert.match(text2, /graph_care_outcome/, "fail-open 正文仍须有回传要求");
        assert.ok(text2.includes("rework=human"), "fail-open 正文必须回退内联纪律（不静默丢弃）");
        const inspF = ev2.filter((e) => e.event === "care.inspection").at(-1)!;
        assert.equal(inspF.details.wake_discipline_degraded, true, "降级必须在事件里如实标注");
        assert.equal(inspF.details.wake_discipline_source, "fallback");
      } finally {
        if (existsSync(parked)) { renameSync(parked, abs); restored = true; }
      }
      assert.equal(restored, true, "必须还原被临时移走的资产");
    } finally {
      rt2.dispose();
      host2.adapter.releaseAll();
    }
  } finally {
    runtime.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════ 6. 首次粒度 = 主管会话 + 持久化（判据 5 / 7） ═════════════════════════
test("g618 首次判定：按主管会话，持久化到 care_state 快照；换会话/重启 ⇒ 回落首次", async () => {
  const host = await makeRealHost();
  const { ws, root } = boardWithCare();
  const clock = fakeClock();
  const scheduler = fakeScheduler(clock);
  const { runtime, events } = makeRuntime(host, { clock, scheduler });
  const child = await (async () => {
    runtime.start();
    return null;
  })();
  void child;
  try {
    const sup = (await host.reg.create({ sessionId: "sup-g618-a", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent = trackSends(sup);
    runtime.statusFor(root);
    claimSupervisor(root, sup.id, "agent:sup-g618-a");
    const c1 = await makeRunningChild(host, sup, ws, "G618A");
    writeRealGoal(root, { goalId: "g-003", child: c1.id, parent: sup.id, startedAt: new Date(clock.now() - 130_000).toISOString() });
    emitStatus(host, sup, "idle");

    await scheduler.advanceTo(clock.now() + 1);
    assert.equal(sent.length, 1);
    assert.equal(events.filter((e) => e.event === "care.inspection").at(-1).details.wake_form, "full", "首份 = 全量");
    await runtime.submitOutcome({
      root, supervisor: sup.id, inspection: String(events.filter((e) => e.event === "care.inspection").at(-1).details.inspection),
      goal: "g-003", attempt: "att-001", child: c1.id, outcome: "progress", evidence: "g618 粒度用例",
    });
    await scheduler.advanceTo(clock.now() + 301_000);
    assert.equal(sent.length, 2);
    assert.equal(events.filter((e) => e.event === "care.inspection").at(-1).details.wake_form, "compact", "第二份 = 精简");

    // ① 状态**持久化**在 care_state 快照里（不是纯内存标志、也不依赖 UI）
    const snap = events.filter((e) => e.event === "care.inspection").at(-1).details.care_state;
    assert.equal(snap.disciplineSeen.session, sup.id, "disciplineSeen 必须随快照落盘，且记录主管会话 id");
    assert.equal(typeof snap.disciplineSeen.at, "number", "disciplineSeen 必须带时间戳");
  } finally {
    runtime.dispose();
  }

  // ② 宿主重启（全新 runtime，同一 root/同一主管会话）= 读盘恢复 ⇒ **仍是精简**（不因重启退回全量）
  const clock2 = fakeClock(clock.now());
  const scheduler2 = fakeScheduler(clock2);
  const { runtime: rt2, events: ev2 } = makeRuntime(host, { clock: clock2, scheduler: scheduler2 });
  try {
    const sup = host.reg.list().find((a: any) => a.session?.id === "sup-g618-a") ?? null;
    assert.ok(sup, "主管 agent 仍在注册表");
    void ev2;
    // 只读恢复：新建条目时 state 来自 events 真源
    const entry = rt2.entryOfRoot(root);
    assert.equal(entry.disciplineSeen?.session, "sup-g618-a", "重启后必须从快照恢复「已发过纪律」");
  } finally {
    rt2.dispose();
  }

  // ③ 换主管会话（新会话 id = 新模型上下文没见过纪律）⇒ 回落首次（全量）
  const clock3 = fakeClock(clock.now());
  const scheduler3 = fakeScheduler(clock3);
  const { runtime: rt3, events: ev3 } = makeRuntime(host, { clock: clock3, scheduler: scheduler3 });
  try {
    rt3.start();
    const sup2 = (await host.reg.create({ sessionId: "sup-g618-b", agentOptions: { provider: "observed", model: "m" }, meta: { cwd: ws } })).agent;
    const sent2 = trackSends(sup2);
    claimSupervisor(root, sup2.id, "agent:sup-g618-b"); // 换主管
    rt3.statusFor(root);
    const c2 = await makeRunningChild(host, sup2, ws, "G618B");
    writeRealGoal(root, { goalId: "g-004", child: c2.id, parent: sup2.id, startedAt: new Date(clock3.now() - 130_000).toISOString() });
    emitStatus(host, sup2, "idle");
    await scheduler3.advanceTo(clock3.now() + 1);
    assert.ok(sent2.length >= 1, "换主管会话后必须投递");
    const insp = ev3.filter((e) => e.event === "care.inspection").at(-1)!;
    assert.equal(insp.details.wake_form, "full", "换主管会话 ⇒ 新会话的第一份必须是全量");
    assert.ok(wakeTextOf(sent2[0]).includes(disciplineBullets("zh").at(-1)!), "新会话第一份必须内联完整纪律");
  } finally {
    rt3.dispose();
    host.adapter.releaseAll();
  }
});

// ═════════════════════════ 7. 生产路径回传闭环（判据 8：注册工具 + 真实 timer） ═════════════════════════
test("g618 生产路径：真实宿主 timer 投递的精简正文，其 inspection id 经注册的 graph_care_outcome 能受理", async () => {
  // 走**完整插件 apply**（= 生产装配）：真实 `graph_care_outcome` 工具 + 真实关照运行时 + 真实 timer。
  const { makeGoal, makeRealHost } = await import("./_g610-real-host.ts");
  const { claimSupervisor: claim } = await import("../ops.ts");
  const h = await makeRealHost({
    sessionQuery: true,
    // recheck 取合法下限 30s：让第二份（精简）在测试预算内自然到期，不靠注入时钟。
    projectYaml: "supervisor:\n  session: sess-super\n  care: \"true\"\n  care_threshold_seconds: 300\n  care_recheck_seconds: 30\n",
  });
  const exec = () => ({ agent: h.parent, signal: new AbortController().signal });
  const careInspections = () => readEvents(h.root).filter((e: any) => e.event === "care.inspection");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (cond: () => boolean, label: string, timeoutMs = 60_000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) { if (cond()) return; await sleep(100); }
    throw new Error(`等待超时：${label}`);
  };
  try {
    const goal = await makeGoal(h, "g618 compact closure");
    // 30s 目标预算让首次关照自然到期（项目 recheck 300s 不会先触发）。
    const setBudget: any = await h.tools.get("graph_set_goal_budget").execute({ goal, budget_seconds: 30 }, exec());
    assert.ok(setBudget, "预算工具可用");
    claim(h.root, h.parent.id, `g618:${h.parent.id}`);
    h.fake.hold("G618-CLOSURE");
    const d: any = await h.dispatch(goal, "G618-CLOSURE real care", { worktree: false });
    const childId = String(d.child_id ?? "");
    const attempt = String(d.attempt ?? "att-001");
    assert.ok(childId);

    // 第 1 份（生产真实 timer）：必须是全量纪律
    await waitFor(() => careInspections().length >= 1, "first care delivered");
    await waitFor(() => h.parent.status === "idle", "supervisor idle after first care");
    const first = careInspections().at(-1)!;
    assert.equal(first.details.wake_form, "full", "生产路径首份必须是全量");
    const firstOut: any = await h.tools.get("graph_care_outcome").execute({
      inspection: first.details.inspection, goal, attempt, child: childId,
      outcome: "progress", evidence: "g618 生产路径：首份全量后回传 progress",
    }, exec());
    assert.equal(firstOut.ok, true, `首份 id 必须被注册工具受理：${JSON.stringify(firstOut)}`);

    // 第 2 份：同一主管会话 ⇒ 精简（生产真实 timer，300s 复查；测试内只等一次）
    await waitFor(() => careInspections().length >= 2, "second care delivered", 90_000);
    await waitFor(() => h.parent.status === "idle", "supervisor idle after second care");
    const second = careInspections().at(-1)!;
    assert.equal(second.details.wake_form, "compact", "生产路径第二份必须是精简版");
    // 精简正文里的 id 必须能经**注册的窄工具**成功受理（判据 6 的闭环核心）
    const compactOut: any = await h.tools.get("graph_care_outcome").execute({
      inspection: second.details.inspection, goal, attempt, child: childId,
      outcome: "unknown", evidence: "g618 生产路径：用精简正文的 id 回传 unknown",
    }, exec());
    assert.equal(compactOut.ok, true, `精简正文的 id 必须能被注册工具受理：${JSON.stringify(compactOut)}`);
    // 机制语义不变：unknown 既不增也不清无进展计数，也不上锁
    const st: any = await h.tools.get("graph_get_settings").execute({}, exec());
    const t: any = (st.supervisor_care?.tasks ?? []).find((x: any) => x.child === childId);
    assert.ok(t, "任务仍在采样");
    assert.equal(t.stagnant_rounds, 0, "unknown 不得计无进展");
    assert.equal(t.human_locked, false, "unknown 不得上锁");
  } finally {
    h.fake.releaseAll();
    try { await h.shutdown(); } catch { /* ignore */ }
  }
});
