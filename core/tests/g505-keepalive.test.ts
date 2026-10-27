/**
 * g-505：主管会话上下文缓存智能保活的离线回归（零网络、零真实 provider、零费用）。
 *
 * 覆盖（v2，按 rev-att-002-01 BLOCK 返工）：
 *  1. 两级配置（profile 全局 / project 三态）归一、优先级、**raw+malformed 闭锁**与写侧拒绝；
 *  2. 两阶段状态机（阶段一阈值/熔断、阶段二单次 Grace、短 TTL 假设后的 AFK、未知信号 fail-safe）；
 *  3. **真实公开宿主全栈**：真实 cordis Context + 真实 `SessionStore`/`SessionProjections`/
 *     `SystemPrompt`/`ToolRuntime`/`AgentRegistry`/`AgentLoop`/`LlmRuntime` + 进程内 fake adapter
 *     + 纯假 history + 假时钟。覆盖：
 *       · B1：adapter 填 defaultMaxTokens/默认 reasoning 时，真实 loop 请求仍能建立 ready 快照；
 *         显式控制项改变 / 真正 route 改变 / 辅助 purpose / 非 loop / 自 ping 一律拒绝；
 *       · B2：两个 tmp board、各自主管、独立配置/预算/快照/状态投影/人类输入 abort 互不污染；
 *         defaultWorkspace ≠ 目标 root 时仍能自举发现；
 *       · B3：真实维护区排队/释放、人类输入 abort 本插件请求且不清 inbox、可疑 adapter 延迟释放
 *         时不提前清 inflight/不重复发请求（不声称严格 timeout 上界）；
 *  4. 失效与配置链：同 Agent 的 compaction/clear/surface replace 使快照失效；项目配置读取异常 ⇒
 *     fail-closed 投影（绝不 effective=true）；profile 全局只认当前 settings.yaml（忽略 .imported）；
 *  5. 宿主 REST / `graph_get_settings` 的 configured/effective/capable/active 投影（g507 门禁）；
 *  6. GUI 契约（客户端写入点与 zh/en 文案键对称）。
 *
 * 边界（如实声明，不冒充已验证）：未向真实 provider 发任何请求；不声明真实缓存收益；
 * 真实 GUI/Windows/真实 provider 参数与取消语义仍未验证；timeout 对不合作 adapter 无严格上界。
 *
 * 运行前需 `bash scripts/build.sh`。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  KEEP_ALIVE_MODES,
  KEEP_ALIVE_SHORT_TTL_MS,
  normalizeKeepAliveMode,
  isKeepAliveModeMalformed,
  resolveKeepAlive,
  resolveKeepAliveGlobalRaw,
  resolveKeepAliveChannel,
  keepAliveResolutionOf,
  keepAliveEffectiveOf,
  decideKeepAlive,
  defaultKeepAliveConfig,
} from "../keepalive.ts";
import { init, readProjectConfig, writeProjectConfig, settingsPostSchema, validateSchema } from "../ops.ts";
import { apply } from "../../dist/index.js";
import { ownerConnectionStub, entryHandler, createRegisterStub, OWNER_HEADER } from "./_http-auth-harness.ts";

// ─────────────────────────────── 公共夹具 ───────────────────────────────
const TMP_ROOTS: string[] = [];
function tmpDir(tag: string): string {
  const base = join(process.cwd(), "tmp");
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, `g505v2-${tag}-`));
  TMP_ROOTS.push(dir);
  return dir;
}
function makeBoard(projectYaml = ""): string {
  const root = tmpDir("board");
  init(root);
  if (projectYaml) writeFileSync(join(root, "project.yaml"), projectYaml);
  return root;
}
test.after(() => {
  for (const root of TMP_ROOTS.splice(0)) { try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } }
});

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } };
}

/** 真实宿主包解析（不写死作者机器路径、不联网安装）。 */
async function resolveHostScope(): Promise<string> {
  const env = process.env.G505_HOST_STACK_DIR || process.env.G507_HOST_STACK_DIR;
  if (env) return env;
  try {
    const { execFileSync } = await import("node:child_process");
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    for (const scope of [
      join(globalRoot, "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"),
      join(globalRoot, "@deepseek-ai"),
    ]) {
      if (existsSync(join(scope, "dsh-llm", "lib", "index.js")) && existsSync(join(scope, "dsh-agent", "lib", "index.js"))) return scope;
    }
  } catch { /* npm 不可用 ⇒ 尝试下一来源 */ }
  const { resolveHostStack } = await import("./_host-stack.ts");
  const { dir } = resolveHostStack();
  if (!existsSync(join(dir, "dsh-llm", "lib", "index.js"))) {
    throw new Error(`g505 测试需要同时包含 dsh-llm/dsh-agent 的宿主栈目录；当前解析到 ${dir} 不含它们（请设置 G505_HOST_STACK_DIR）`);
  }
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
    Context: cordis.Context,
    llm,
    AgentRegistry: agent.AgentRegistry,
    SessionStore: session.SessionStore,
    SessionProjections: projection.default,
    SystemPrompt: systemPrompt.SystemPrompt,
    ToolRuntime: tools.ToolRuntime,
    AgentLoop: loop.AgentLoop,
  };
}

/**
 * 记录型 fake adapter（进程内、零网络）。`defaults=true` 时与真实 adapter 一样在 resolveModel 里
 * 提供 `defaultMaxTokens` 与默认 reasoning —— 这正是 review B1 指出的默认填充路径。
 */
function makeFakeAdapter(LlmAdapter: any, opts: { defaults?: boolean } = {}) {
  class RecordingAdapter extends LlmAdapter {
    calls: any[] = [];
    times: Array<number | null> = [];
    behaviors: string[] = [];
    gate: any = null;
    nowFn: (() => number) | null = null;
    providerInfo(provider: string) { return { id: provider, name: provider, protocol: "fake" }; }
    async resolveModel(provider: string, model: string) {
      if (opts.defaults === false) return { provider, id: model, name: model, inputModalities: ["text"] };
      return {
        provider, id: model, name: model, inputModalities: ["text"],
        context: { contextWindow: 128000 },
        defaultMaxTokens: 8192,
        reasoning: { efforts: [{ id: "off", name: "off" }, { id: "high", name: "high" }], defaultEffort: "high" },
      };
    }
    async *stream(options: any) {
      this.calls.push(options);
      this.times.push(this.nowFn ? this.nowFn() : null);
      const behavior = this.behaviors.shift() ?? "auto";
      if (behavior === "error") {
        yield { type: "finish", reason: { kind: "error", failure: { code: "FAKE_ERROR", message: "fake failure" } } };
        return;
      }
      if (behavior === "abort-delayed") {
        const gate = this.gate;
        await new Promise((_resolve, reject) => {
          const onAbort = async () => {
            if (gate) await gate;
            reject(new Error("fake adapter delayed abort"));
          };
          if (options.signal?.aborted) { void onAbort(); return; }
          options.signal?.addEventListener("abort", () => { void onAbort(); }, { once: true });
        });
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "ping" };
      // 故意发 tool-call delta：必须完整消费但**绝不执行**工具。
      yield { type: "tool-call-delta", index: 1, id: "call-x", name: "danger", argumentsDelta: "{}" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "ping" } };
      yield { type: "usage", usage: { inputTokens: 120, outputTokens: 1, cacheReadTokens: 96 } };
      yield { type: "finish", reason: { kind: options.maxTokens === 1 ? "max-tokens" : "stop" } };
    }
  }
  return new RecordingAdapter();
}

/** 真实公开宿主全栈（无持久化、无网络、无真实 provider）。 */
async function makeRealHost(opts: { adapterDefaults?: boolean } = {}) {
  const {
    Context, llm: llmMod, AgentRegistry, SessionStore, SessionProjections, SystemPrompt, ToolRuntime, AgentLoop,
  } = await loadHostStack();
  const hostCtx = new Context();
  new SessionStore(hostCtx);
  new SessionProjections(hostCtx);
  new SystemPrompt(hostCtx, {});
  new ToolRuntime(hostCtx, {});
  const reg = new AgentRegistry(hostCtx);
  const llm = new llmMod.LlmRuntime(hostCtx);
  const adapter = makeFakeAdapter(llmMod.LlmAdapter, { defaults: opts.adapterDefaults !== false });
  llm.registerAdapter(["observed"], adapter);
  const loop = new AgentLoop(hostCtx, { agents: [], maxParallelToolCalls: 10 });
  const observed: any[] = [];
  hostCtx.on("llm/stream", (options: any, next: any) => { observed.push(options); return next(); });
  const sendTurn = async (agent: any, text: string) => {
    const message = llmMod.createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } });
    agent.send(message, "next-turn", true);
    await agent.whenIdle();
    return observed[observed.length - 1] ?? null;
  };
  return { hostCtx, llm: llmMod, llmRuntime: llm, adapter, reg, loop, sendTurn, observed };
}

async function makeAgent(host: any, id: string, root: string, options: any = { provider: "observed", model: "observed-model" }) {
  return host.loop.create(id, options, { cwd: root });
}

async function loadRuntimeFactory() {
  const mod: any = await import("../../dist/index.js");
  return mod.createKeepAliveRuntime as (opts: any) => any;
}

/** engine 侧 runtime 夹具：真实服务 + 假时钟（可注入读配置函数做异常/隔离用例）。 */
async function makeRuntime(host: any, opts: {
  clock?: ReturnType<typeof fakeClock>;
  defaultWorkspace?: () => string | null;
  readGlobal?: () => any;
  readProjectConfigFn?: (root: string) => any;
  setTimeoutFn?: any;
  clearTimeoutFn?: any;
  now?: () => number;
} = {}) {
  const createKeepAliveRuntime = await loadRuntimeFactory();
  const clock = opts.clock ?? fakeClock();
  const runtime = createKeepAliveRuntime({
    ctx: {
      on: (name: string, handler: any) => host.hostCtx.on(name, handler),
      get: (name: string) => (name === "llm" ? host.llmRuntime : name === "agents" ? host.reg : undefined),
    },
    readGlobal: opts.readGlobal ?? (() => ({ enabled: null, malformed: false, available: true, raw: "" })),
    resolveRoot: (ws: string) => ws,
    defaultWorkspace: opts.defaultWorkspace ?? (() => null),
    readProjectConfigFn: opts.readProjectConfigFn,
    now: opts.now ?? clock.now,
    setTimeoutFn: opts.setTimeoutFn ?? (() => null),
    clearTimeoutFn: opts.clearTimeoutFn ?? (() => {}),
    log: () => {},
  });
  return { runtime, clock };
}

/** 确定性假 timer：记录绝对到期时刻，按任意相位推进并 await 回调（覆盖真实 scheduler 接线）。 */
function makeFakeScheduler(clock: ReturnType<typeof fakeClock>) {
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => any }>();
  const setTimeoutFn = (fn: () => any, ms: number) => {
    const id = ++seq;
    timers.set(id, { at: clock.now() + Math.max(0, ms), fn });
    return id;
  };
  const clearTimeoutFn = (id: number) => { timers.delete(id); };
  const pending = () => [...timers.values()].map((t) => t.at - clock.now()).sort((a, b) => a - b);
  const nextAt = () => (timers.size ? Math.min(...[...timers.values()].map((t) => t.at)) : null);
  const advanceTo = async (target: number) => {
    for (let guard = 0; guard < 500; guard += 1) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
      if (!due.length) break;
      const [id, t] = due[0];
      timers.delete(id);
      clock.set(t.at);
      await t.fn();
    }
    clock.set(target);
    await new Promise((r) => setImmediate(r));
  };
  const advance = (ms: number) => advanceTo(clock.now() + ms);
  return { setTimeoutFn, clearTimeoutFn, pending, nextAt, advance, advanceTo, timers };
}

async function waitFor(cond: () => boolean, label: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`超时等待：${label}`);
    await new Promise((r) => setImmediate(r));
  }
}

// ─────────────────────────────── 1. 配置解析 ───────────────────────────────

test("g505 配置：三态归一/畸形判定/优先级/来源投影（项目覆盖全局，缺省继承）", () => {
  assert.deepEqual([...KEEP_ALIVE_MODES], ["inherit", "true", "false"]);
  assert.equal(normalizeKeepAliveMode(true), "true");
  assert.equal(normalizeKeepAliveMode(" INHERIT "), "inherit");
  assert.equal(normalizeKeepAliveMode("yes"), "inherit");
  assert.equal(isKeepAliveModeMalformed("yes"), true);
  assert.equal(isKeepAliveModeMalformed(true), false);
  assert.equal(isKeepAliveModeMalformed(null), false);
  assert.equal(isKeepAliveModeMalformed(1), true);

  // 项目未配置 + 全局未配置 ⇒ 受控默认（尝试开启），来源 global_default
  const d = resolveKeepAlive({ mode: null }, { enabled: null });
  assert.equal(d.enabled, true);
  assert.equal(d.source, "global_default");
  // 项目 inherit + 全局显式开/关
  assert.equal(resolveKeepAlive({ mode: "inherit" }, { enabled: true }).source, "global_explicit");
  assert.equal(resolveKeepAlive({ mode: "inherit" }, { enabled: false }).enabled, false);
  // 项目显式覆盖全局
  assert.equal(resolveKeepAlive({ mode: "true" }, { enabled: false }).enabled, true);
  assert.equal(resolveKeepAlive({ mode: "false" }, { enabled: true }).enabled, false);
  assert.equal(resolveKeepAlive({ mode: "true" }, { enabled: false }).source, "project_explicit");
  // 畸形：项目坏值绝不「归一 inherit 后默认开启」；全局坏值同样 fail-closed
  const pm = resolveKeepAlive({ mode: "inherit", malformed: true }, { enabled: true });
  assert.equal(pm.enabled, false);
  assert.equal(pm.source, "project_invalid");
  assert.equal(pm.malformed, true);
  const gm = resolveKeepAlive({ mode: "inherit" }, { enabled: null, malformed: true });
  assert.equal(gm.enabled, false);
  assert.equal(gm.source, "global_invalid");

  // 负向对照：同样的输入，只要不把 malformed 传下来就会启用 ⇒ 证明断言有判别力
  assert.equal(resolveKeepAlive({ mode: "inherit" }, { enabled: null }).enabled, true);
  assert.notEqual(pm.enabled, resolveKeepAlive({ mode: "inherit" }, { enabled: true }).enabled);

  // 读侧入口必须尊重 keep_alive_malformed（而不是二次归一后丢掉坏值事实）
  const fromRead = keepAliveResolutionOf({ keep_alive: "inherit", keep_alive_malformed: true }, null);
  assert.equal(fromRead.enabled, false);
  assert.equal(fromRead.source, "project_invalid");
  const proj = keepAliveEffectiveOf({ keep_alive: "true", keep_alive_malformed: false }, null);
  assert.equal(proj.effective, true);
  assert.equal(proj.source, "project_explicit");
  assert.deepEqual([...proj.modes], ["inherit", "true", "false"]);

  // 全局原始字符串
  assert.deepEqual(resolveKeepAliveGlobalRaw("on"), { enabled: true, malformed: false, raw: "on" });
  assert.deepEqual(resolveKeepAliveGlobalRaw("off"), { enabled: false, malformed: false, raw: "off" });
  assert.deepEqual(resolveKeepAliveGlobalRaw(""), { enabled: null, malformed: false, raw: "" });
  assert.equal(resolveKeepAliveGlobalRaw("yes").malformed, true);
  assert.equal(resolveKeepAliveGlobalRaw("on").enabled, true);
});

test("g505 通道：只认公开能力与显式 TTL；未知 TTL 按短缓存有界，绝不按模型名猜长 TTL 豁免", () => {
  const allCaps = { llm: true, agents: true, status: true, maintenance: true, snapshot: true };
  const ok = resolveKeepAliveChannel(allCaps, { cacheTtlMs: null });
  assert.equal(ok.channel, "host_prepare_stream");
  assert.equal(ok.ttl, "unknown");
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.exempt, false);

  const missing = resolveKeepAliveChannel({ llm: true, agents: false, status: true, maintenance: true, snapshot: false }, null);
  assert.equal(missing.channel, "none");
  assert.equal(missing.reason, "missing_capability");
  assert.ok(missing.missing.includes("agents.registry"));
  assert.ok(missing.missing.includes("supervisor.loopSnapshot"));

  // 显式长 TTL（≥10min，且必须由调用方显式提供）才豁免 —— 这是唯一豁免路径。
  const exempt = resolveKeepAliveChannel(allCaps, { cacheTtlMs: 3_600_000 });
  assert.equal(exempt.exempt, true);
  assert.equal(exempt.reason, "exempt_long_ttl");
  // 未知/短 TTL 不豁免（包括 provider/model 名字叫 deepseek 也不参与判定：函数没有该入参）。
  assert.equal(resolveKeepAliveChannel(allCaps, { cacheTtlMs: 1_000 }).exempt, false);
  assert.equal(resolveKeepAliveChannel(allCaps, null).exempt, false);
});

// ─────────────────────────────── 2. 读侧 raw/malformed + 写侧 ───────────────────────────────

test("g505 配置读侧：project.yaml raw 畸形不得归一 inherit 后默认启用；写侧拒绝隐式形态", () => {
  const cases: Array<[string, string | null, boolean]> = [
    ["", null, false],
    ["supervisor:\n  keep_alive: true\n", "true", false],
    ["supervisor:\n  keep_alive: false\n", "false", false],
    ["supervisor:\n  keep_alive: inherit\n", "inherit", false],
    // YAML 1.2 把裸 yes 解析为字符串 "yes"（不是布尔）⇒ 无法判定为三态 ⇒ 畸形
    ["supervisor:\n  keep_alive: yes\n", "inherit", true],
    ["supervisor:\n  keep_alive: on\n", "inherit", true],
    ["supervisor:\n  keep_alive: 1\n", "inherit", true],
    ["supervisor:\n  keep_alive: [true]\n", "inherit", true],
  ];
  for (const [yaml, mode, malformed] of cases) {
    const root = makeBoard(yaml);
    try {
      const cfg = readProjectConfig(root);
      assert.equal(cfg.supervisor.keep_alive, mode, `读值：${JSON.stringify(yaml)}`);
      assert.equal(cfg.supervisor.keep_alive_malformed ?? false, malformed, `畸形标记：${JSON.stringify(yaml)}`);
      // 端到端：畸形 ⇒ effective 必须关闭；false ⇒ 关闭；true/inherit(全局未配置) ⇒ 开启。
      const eff = keepAliveEffectiveOf(cfg.supervisor, null);
      const expectedEffective = malformed ? false : mode === "false" ? false : true;
      assert.equal(eff.effective, expectedEffective, `生效值：${JSON.stringify(yaml)}`);
      if (malformed) assert.equal(eff.source, "project_invalid");
      if (mode === "false") assert.equal(eff.source, "project_explicit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  // 整档 YAML 语法错误 ⇒ 无法确认 supervisor 配置 ⇒ fail-closed
  const brokenRoot = makeBoard("supervisor: [unclosed\n");
  try {
    const cfg = readProjectConfig(brokenRoot);
    assert.equal(cfg.supervisor.keep_alive_malformed, true);
    assert.equal(keepAliveEffectiveOf(cfg.supervisor, null).effective, false);
  } finally {
    rmSync(brokenRoot, { recursive: true, force: true });
  }

  // 写侧：true/false 落布尔字面量；inherit/null 清空；非法形态被 settings schema 拒绝。
  const root = makeBoard("");
  try {
    writeProjectConfig(root, { supervisor: { keep_alive: "true" } }, "human:test");
    assert.match(readFileSync(join(root, "project.yaml"), "utf8"), /keep_alive: true/);
    assert.equal(readProjectConfig(root).supervisor.keep_alive, "true");
    writeProjectConfig(root, { supervisor: { keep_alive: "false" } }, "human:test");
    assert.equal(readProjectConfig(root).supervisor.keep_alive, "false");
    writeProjectConfig(root, { supervisor: { keep_alive: null } }, "human:test");
    assert.equal(readProjectConfig(root).supervisor.keep_alive, null);
    assert.doesNotMatch(readFileSync(join(root, "project.yaml"), "utf8"), /keep_alive:/);
    for (const bad of ["yes", "on", 1, true]) {
      const v = validateSchema({ supervisor: { keep_alive: bad } }, settingsPostSchema);
      assert.equal(v.valid, false, `写侧必须拒绝隐式形态：${JSON.stringify(bad)}`);
    }
    for (const good of ["inherit", "true", "false", null]) {
      const v = validateSchema({ supervisor: { keep_alive: good } }, settingsPostSchema);
      assert.equal(v.valid, true, `写侧必须接受三态/null：${JSON.stringify(good)}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ─────────────────────────────── 3. 状态机 ───────────────────────────────

const HOST_CHANNEL = { channel: "host_prepare_stream", reason: "host_channel", exempt: false, ttl: "unknown", missing: [] } as const;
const STAGE1 = 210_000;
const GRACE = 240_000;

function inputs(over: Record<string, unknown> = {}) {
  return {
    now: 1_000_000,
    lastLlmAt: 1_000_000,
    runningChildren: 1,
    idle: true,
    pingsInWindow: 0,
    stage2Used: false,
    lastPingAt: null,
    lastActivityAt: 1_000_000,
    inflight: false,
    pendingInput: false,
    ...over,
  } as any;
}

test("g505 状态机：阶段一阈值/熔断、阶段二 Grace 单次、短 TTL 后 AFK、未知信号 fail-safe", () => {
  const cfg = defaultKeepAliveConfig(true);
  // 阶段一：未到阈值等待
  const wait = decideKeepAlive(inputs({ now: 1_000_000 + STAGE1 - 1 }), cfg, HOST_CHANNEL);
  assert.equal(wait.ping, false);
  assert.equal(wait.reason, "active_children_wait");
  assert.equal(wait.nextEligibleInMs, 1);
  // 到阈值 ⇒ ping，并计数 +1
  const ping = decideKeepAlive(inputs({ now: 1_000_000 + STAGE1 }), cfg, HOST_CHANNEL);
  assert.equal(ping.ping, true);
  assert.equal(ping.reason, "stage1_ping");
  assert.equal(ping.pingsInWindow, 1);
  // 达上限 ⇒ 熔断（不再 ping）
  const fused = decideKeepAlive(inputs({ now: 1_000_000 + STAGE1 * 5, pingsInWindow: cfg.stage1MaxPings }), cfg, HOST_CHANNEL);
  assert.equal(fused.ping, false);
  assert.equal(fused.reason, "stage1_fused");
  assert.equal(fused.phase, "stage1");

  // 阶段二：子代理全部结束，未到 Grace 等待；到 Grace ⇒ 单次 ping
  const s2wait = decideKeepAlive(inputs({ runningChildren: 0, now: 1_000_000 + GRACE - 1 }), cfg, HOST_CHANNEL);
  assert.equal(s2wait.ping, false);
  assert.equal(s2wait.reason, "stage2_wait");
  const s2ping = decideKeepAlive(inputs({ runningChildren: 0, now: 1_000_000 + GRACE }), cfg, HOST_CHANNEL);
  assert.equal(s2ping.ping, true);
  assert.equal(s2ping.reason, "stage2_ping");
  // 唯一机会已用：短 TTL 内等待（不 ping）
  const usedWait = decideKeepAlive(inputs({ runningChildren: 0, now: 1_000_000 + GRACE + 1_000, stage2Used: true, lastPingAt: 1_000_000 + GRACE }), cfg, HOST_CHANNEL);
  assert.equal(usedWait.ping, false);
  assert.equal(usedWait.phase, "stage2");
  // 短 TTL 届满且负责人无交互 ⇒ AFK 终态
  const afk = decideKeepAlive(inputs({ runningChildren: 0, now: 1_000_000 + GRACE + KEEP_ALIVE_SHORT_TTL_MS, stage2Used: true, lastPingAt: 1_000_000 + GRACE }), cfg, HOST_CHANNEL);
  assert.equal(afk.ping, false);
  assert.equal(afk.phase, "afk");
  assert.equal(afk.afk, true);
  assert.equal(afk.reason, "stage2_afk");
  // 短 TTL 内负责人有交互（活动晚于 ping）⇒ 不判 AFK
  const active = decideKeepAlive(inputs({
    runningChildren: 0,
    now: 1_000_000 + GRACE + KEEP_ALIVE_SHORT_TTL_MS,
    stage2Used: true,
    lastPingAt: 1_000_000 + GRACE,
    lastActivityAt: 1_000_000 + GRACE + 1_000,
  }), cfg, HOST_CHANNEL);
  assert.equal(active.afk, false);
  assert.equal(active.phase, "stage2");

  // fail-safe：任一关键信号未知 ⇒ 不保活
  assert.equal(decideKeepAlive(inputs({ idle: null }), cfg, HOST_CHANNEL).reason, "state_unknown");
  assert.equal(decideKeepAlive(inputs({ runningChildren: null }), cfg, HOST_CHANNEL).reason, "state_unknown");
  assert.equal(decideKeepAlive(inputs({ lastLlmAt: null }), cfg, HOST_CHANNEL).reason, "state_unknown");
  // 忙 / 待处理输入 / 在途 ⇒ 不插队
  assert.equal(decideKeepAlive(inputs({ idle: false }), cfg, HOST_CHANNEL).reason, "busy");
  assert.equal(decideKeepAlive(inputs({ pendingInput: true }), cfg, HOST_CHANNEL).reason, "pending_input");
  assert.equal(decideKeepAlive(inputs({ inflight: true }), cfg, HOST_CHANNEL).reason, "inflight");
  // 配置关闭 / 通道缺失 / 豁免
  assert.equal(decideKeepAlive(inputs(), defaultKeepAliveConfig(false), HOST_CHANNEL).reason, "disabled_by_config");
  assert.equal(decideKeepAlive(inputs(), cfg, { channel: "none", reason: "missing_capability", exempt: false, ttl: "unknown", missing: ["x"] }).reason, "capability_missing");
  assert.equal(decideKeepAlive(inputs(), cfg, { channel: "none", reason: "exempt_long_ttl", exempt: true, ttl: "explicit", missing: [] }).reason, "channel_exempt");
});


// ─────────────────────────────── 4. 真实公开宿主全栈（B1/B2/B3） ───────────────────────────────

test("B1 默认填充：adapter 提供 defaultMaxTokens/默认 reasoning 时，真实 loop 请求仍建立 ready 快照并在 240s 后真实 ping", async () => {
  const host = await makeRealHost({ adapterDefaults: true });
  const root = makeBoard();
  const supId = "sup-b1";
  const agent = await makeAgent(host, supId, root);
  writeFileSync(join(root, "project.yaml"), `supervisor:\n  session: ${supId}\n`);
  const { runtime, clock } = await makeRuntime(host, { defaultWorkspace: () => root });
  runtime.start();
  try {
    await runtime.sweep();
    const observed = await host.sendTurn(agent, "hello-B1");
    assert.ok(observed, "必须观察到正常 loop 请求");
    // 真实 prepareCall 默认填充（B1 的根因）：proposed 只有 provider/model，observed 是 resolved 值。
    assert.equal(observed.maxTokens, 8192, "adapter defaultMaxTokens 必须出现在 resolved options 中");
    assert.equal(observed.reasoningEffort, "high", "adapter 默认 reasoning 必须出现在 resolved options 中");

    const board = runtime.stateFor(root);
    assert.equal(runtime.snapshotProblem(agent), null, "默认填充不得让快照永远 route_changed");
    assert.equal(runtime.statusFor(root).active.snapshot, "ready");
    assert.equal(board.snapshot.messages, observed.messages, "快照引用同一份已观察 messages");
    // 存的是 resolved route（含 adapter 默认），不是 proposed 缺失对象/executor seed
    assert.equal(board.snapshot.route.maxTokens, 8192);
    assert.equal(board.snapshot.route.reasoningEffort, "high");

    // 无子代理 ⇒ 阶段二 Grace=240s 才是真正 eligible（不用「未到期无 ping」作证据）
    clock.advance(240_000);
    await runtime.sweep();
    assert.equal(host.adapter.calls.length, 2, "loop 1 次 + 真正保活 1 次");
    const ping = host.adapter.calls[1];
    assert.equal(ping.maxTokens, 1);
    assert.equal(ping.reasoningEffort, "high", "resolved 控制项要延续（只替换 maxTokens/signal）");
    assert.equal(ping.messages, observed.messages);
    assert.equal(ping.sessionId, agent.session.id);
    assert.equal(ping.purpose, undefined, "绝不伪造 purpose");
    assert.equal(board.lastOutcome, "success");
    assert.equal(board.pingsInWindow, 1);
  } finally {
    runtime.dispose();
  }
});

test("B1 拒绝面：显式控制项改变 / 真正 route 改变 / 辅助 purpose / 非 loop / 自 ping 均不被当快照", async () => {
  const host = await makeRealHost({ adapterDefaults: true });
  const root = makeBoard();
  const supId = "sup-b1-neg";
  const agent = await makeAgent(host, supId, root);
  writeFileSync(join(root, "project.yaml"), `supervisor:\n  session: ${supId}\n`);
  const { runtime, clock } = await makeRuntime(host, { defaultWorkspace: () => root });
  runtime.start();
  const drain = async (options: any) => { for await (const _ of host.llmRuntime.stream(options)) { /* consume */ } };
  const pending = async (config: any) => {
    await host.hostCtx.waterfall(host.hostCtx, "agent/request", { agent, turn: 9, step: 1, signal: new AbortController().signal }, async () => config);
  };
  try {
    await runtime.sweep();
    const observed = await host.sendTurn(agent, "hello-neg");
    assert.equal(runtime.snapshotProblem(agent), null);

    // ① 显式控制项改变：proposed 显式 maxTokens=4096，但 observed=8192 ⇒ 不是同一请求
    await pending({ provider: "observed", model: "observed-model", maxTokens: 4096 });
    await drain(Object.freeze({
      provider: "observed", model: "observed-model", maxTokens: 8192,
      messages: observed.messages, sessionId: agent.session.id, signal: new AbortController().signal,
    }));
    assert.equal(runtime.snapshotProblem(agent), "config_changed");

    // ② 真正 route 改变：proposed=observed-model，但实际 resolved options 是 other-model ⇒ route_changed
    await host.sendTurn(agent, "hello-neg-2");
    await pending({ provider: "observed", model: "observed-model" });
    await drain(Object.freeze({
      provider: "observed", model: "other-model", maxTokens: 8192,
      messages: observed.messages, sessionId: agent.session.id, signal: new AbortController().signal,
    }));
    assert.equal(runtime.snapshotProblem(agent), "route_changed");

    // ③ 辅助 purpose（compaction/session-title）即使同 route/session 也不能当正常 loop 快照
    await host.sendTurn(agent, "hello-neg-3");
    await pending({ provider: "observed", model: "observed-model" });
    await drain(Object.freeze({
      provider: "observed", model: "observed-model", maxTokens: 8192, purpose: "compaction",
      messages: observed.messages, sessionId: agent.session.id, signal: new AbortController().signal,
    }));
    assert.notEqual(runtime.snapshotProblem(agent), null, "辅助 purpose 不得建立 ready 快照");

    // ④ 非 loop（无 pending 的手搓请求）不得覆盖已有快照
    await host.sendTurn(agent, "hello-neg-4");
    const before = runtime.stateFor(root).snapshot;
    assert.ok(before);
    await drain(Object.freeze({
      provider: "observed", model: "observed-model", maxTokens: 8192,
      messages: observed.messages, sessionId: agent.session.id, signal: new AbortController().signal,
    }));
    assert.equal(runtime.stateFor(root).snapshot, before, "非 loop 请求不得覆盖快照");

    // ⑤ 自 ping 不得被当成快照：成功 ping 之后快照仍是 loop 请求的 resolved route（maxTokens=8192）
    clock.advance(240_000);
    await runtime.sweep();
    assert.equal(runtime.stateFor(root).lastOutcome, "success");
    assert.equal(runtime.stateFor(root).snapshot.route.maxTokens, 8192, "自 ping（maxTokens=1）不得覆盖快照 route");
    assert.equal(runtime.snapshotProblem(agent), null);
  } finally {
    runtime.dispose();
  }
});

test("B3 真实维护区：输入排队、abort 本插件请求且不清 inbox，维护结束后正常轮才执行", async () => {
  const host = await makeRealHost({ adapterDefaults: true });
  const root = makeBoard();
  const supId = "sup-b3";
  const agent = await makeAgent(host, supId, root);
  writeFileSync(join(root, "project.yaml"), `supervisor:\n  session: ${supId}\n`);
  const { runtime, clock } = await makeRuntime(host, { defaultWorkspace: () => root });
  runtime.start();
  try {
    await runtime.sweep();
    await host.sendTurn(agent, "hello-b3");
    clock.advance(240_000);

    const gate = Promise.withResolvers<void>();
    host.adapter.gate = gate.promise;
    host.adapter.behaviors.push("abort-delayed");
    const cancelCalls: any[] = [];
    const originalCancel = agent.cancel.bind(agent);
    agent.cancel = (...args: any[]) => { cancelCalls.push(args); return originalCancel(...args); };

    const sweeps = runtime.sweep();
    await waitFor(() => host.adapter.calls.length === 2, "保活请求进入 adapter");
    assert.equal(agent.status, "idle", "维护区公开 status 仍为 idle");
    assert.equal(runtime.stateFor(root).inflight, true);

    // 维护区内送人类输入：宿主必须排队（不打断维护、不清 inbox）
    const queued = host.llm.createUserMessage({ content: [{ type: "text", text: "queued-during-maintenance" }], source: { kind: "user" } });
    agent.send(queued, "next-turn", true);
    assert.equal(agent.inbox.nextTurn.length, 1, "维护区内输入必须排队等待");
    assert.equal(runtime.stateFor(root).inflight, true);
    assert.equal(host.adapter.calls.length, 2, "维护未结束前不得启动正常轮");
    assert.equal(host.adapter.calls[1].maxTokens, 1);

    gate.resolve();
    await sweeps;
    assert.equal(runtime.stateFor(root).lastOutcome, "aborted_input", "人类输入只 abort 本插件请求");
    await agent.whenIdle();
    assert.equal(agent.inbox.nextTurn.length, 0, "维护结束后排队的正常轮必须被执行（inbox 清空由宿主正常流程完成）");
    assert.equal(host.adapter.calls.length, 3, "排队的人类轮必须真实执行");
    assert.notEqual(host.adapter.calls[2].maxTokens, 1, "正常轮不是保活请求");
    const surfaceText = JSON.stringify(agent.session.deriveMessages());
    assert.ok(surfaceText.includes("queued-during-maintenance"), "会话历史必须包含排队的人类输入");
    assert.equal(cancelCalls.length, 0, "绝不能 agent.cancel（会清 inbox）");
  } finally {
    runtime.dispose();
  }
});

test("B3 可疑 adapter 延迟释放：timeout 不提前清 inflight、不重复发请求，释放后才结算（不声称严格上界）", async () => {
  const host = await makeRealHost({ adapterDefaults: true });
  const root = makeBoard();
  const supId = "sup-b3-timeout";
  const agent = await makeAgent(host, supId, root);
  writeFileSync(join(root, "project.yaml"), `supervisor:\n  session: ${supId}\n`);
  const timeoutFns: Array<{ fn: () => void; ms: number }> = [];
  const { runtime, clock } = await makeRuntime(host, {
    defaultWorkspace: () => root,
    setTimeoutFn: (fn: () => void, ms: number) => { timeoutFns.push({ fn, ms }); return timeoutFns.length; },
    clearTimeoutFn: () => {},
  });
  runtime.start();
  try {
    await runtime.sweep();
    await host.sendTurn(agent, "hello-timeout");
    clock.advance(240_000);

    const gate = Promise.withResolvers<void>();
    host.adapter.gate = gate.promise;
    host.adapter.behaviors.push("abort-delayed");
    const sweeps = runtime.sweep();
    await waitFor(() => host.adapter.calls.length === 2, "保活请求进入 adapter");
    const pingTimeout = timeoutFns.find((t) => t.ms === 45_000);
    assert.ok(pingTimeout, "必须设置请求级 timeout（45s）");

    pingTimeout!.fn(); // 模拟超时：只 abort 本插件控制器
    await new Promise((r) => setImmediate(r));
    assert.equal(runtime.stateFor(root).inflight, true, "iterator 未释放前不得提前清 inflight");
    const callsWhilePending = host.adapter.calls.length;
    await runtime.sweep(); // 在途时再次扫描：不得叠加第二次保活
    assert.equal(host.adapter.calls.length, callsWhilePending, "在途时不得重复发保活请求");
    assert.equal(runtime.stateFor(root).inflight, true);

    gate.resolve();
    await sweeps;
    assert.equal(runtime.stateFor(root).lastOutcome, "timeout");
    assert.equal(runtime.stateFor(root).inflight, false);
    assert.equal(host.adapter.calls.length, 2, "整个超时过程中只允许一次保活请求");
    assert.equal(runtime.stateFor(root).stage2Used, true, "阶段二失败仍已消耗唯一一次机会");
    assert.equal(runtime.stateFor(root).lastPingAt, null, "失败不得写成功时间");
    assert.equal(runtime.stateFor(root).lastSuccessAt, null);
    clock.advance(300_000);
    await runtime.sweep();
    assert.equal(host.adapter.calls.length, 2, "阶段二失败后不得重试");
    assert.equal(runtime.statusFor(root).active.phase, "afk", "阶段二失败后按短 TTL 窗口进入 AFK");
    assert.notEqual(runtime.stateFor(root).lastOutcome, "success");
  } finally {
    runtime.dispose();
  }
});

test("B2 多 board：defaultWorkspace≠目标 root 仍自举；配置/预算/快照/状态投影/人类输入 abort 互不污染", async () => {
  const host = await makeRealHost({ adapterDefaults: true });
  const rootA = makeBoard("supervisor:\n  session: sup-A\n  keep_alive: true\n");
  const rootB = makeBoard("supervisor:\n  session: sup-B\n  keep_alive: false\n");
  const rootC = makeBoard(""); // 默认 workspace：没有 supervisor，也不是目标 board
  const agentA = await makeAgent(host, "sup-A", rootA);
  const agentB = await makeAgent(host, "sup-B", rootB);
  const { runtime, clock } = await makeRuntime(host, { defaultWorkspace: () => rootC });
  runtime.start();
  try {
    // 首次自举：默认 workspace=rootC，但两个 live 主管的 board 必须被发现
    await runtime.sweep();
    assert.equal(runtime.stateFor(rootA)?.supervisorId, "sup-A");
    assert.equal(runtime.stateFor(rootB)?.supervisorId, "sup-B");
    const statusC = runtime.statusFor(rootC);
    assert.equal(statusC.active.supervisor_session, null);
    assert.equal(statusC.active.snapshot, "no_supervisor");

    const obsA = await host.sendTurn(agentA, "A-hello");
    const obsB = await host.sendTurn(agentB, "B-hello");
    const boardA = runtime.stateFor(rootA);
    const boardB = runtime.stateFor(rootB);
    assert.equal(runtime.snapshotProblem(agentA), null);
    assert.equal(runtime.snapshotProblem(agentB), null);
    assert.notEqual(boardA.snapshot.messages, boardB.snapshot.messages, "两 board 快照必须各自独立");
    assert.ok(JSON.stringify(boardA.snapshot.messages).includes("A-hello"));
    assert.ok(JSON.stringify(boardB.snapshot.messages).includes("B-hello"));

    // 配置投影互不污染
    assert.equal(runtime.statusFor(rootA).effective.effective, true);
    assert.equal(runtime.statusFor(rootA).effective.source, "project_explicit");
    assert.equal(runtime.statusFor(rootB).effective.effective, false);
    assert.equal(runtime.statusFor(rootB).effective.source, "project_explicit");

    // 同一时刻 sweep：A 真正 eligible（240s, 无 child）→ ping；B 显式关闭 → 不 ping
    clock.advance(240_000);
    await runtime.sweep();
    const callsAfterFirst = host.adapter.calls.length;
    assert.equal(callsAfterFirst, 3, "A loop + B loop + A keepalive");
    const pings = host.adapter.calls.filter((c: any) => c.maxTokens === 1);
    assert.equal(pings.length, 1);
    assert.equal(pings[0].sessionId, agentA.session.id, "只有 A board 发保活");
    assert.equal(boardA.pingsInWindow, 1);
    assert.equal(boardB.pingsInWindow, 0, "B 的预算不得被 A 污染");

    // 人类输入 abort 只影响目标 board
    await host.sendTurn(agentA, "A-again");
    clock.advance(240_000);
    const gate = Promise.withResolvers<void>();
    host.adapter.gate = gate.promise;
    host.adapter.behaviors.push("abort-delayed");
    const beforePingCalls = host.adapter.calls.length;
    const sweepA = runtime.sweep();
    await waitFor(() => host.adapter.calls.length > beforePingCalls, "A 的保活请求进入 adapter");
    assert.equal(runtime.stateFor(rootA).inflight, true);
    const aHumanBefore = runtime.stateFor(rootA).lastHumanAt;

    // B 的人类输入只更新 B 状态，不得 abort/污染 A 的在途请求
    const bMsg = host.llm.createUserMessage({ content: [{ type: "text", text: "B-human" }], source: { kind: "user" } });
    agentB.send(bMsg, "next-turn", true);
    assert.equal(runtime.stateFor(rootA).lastHumanAt, aHumanBefore, "B 的人类输入不得改 A 的 lastHumanAt");
    assert.equal(runtime.stateFor(rootA).inflight, true, "B 的输入不得 abort A 的在途请求");
    assert.equal(runtime.stateFor(rootB).lastHumanAt !== null, true);
    await agentB.whenIdle();

    // A 的人类输入才 abort A 的请求；释放后 A 排队轮正常执行
    const aMsg = host.llm.createUserMessage({ content: [{ type: "text", text: "A-human-abort" }], source: { kind: "user" } });
    agentA.send(aMsg, "next-turn", true);
    gate.resolve();
    await sweepA;
    await agentA.whenIdle();
    assert.equal(runtime.stateFor(rootA).lastOutcome, "aborted_input");
    assert.equal(runtime.stateFor(rootA).inflight, false);
    assert.ok(JSON.stringify(agentA.session.deriveMessages()).includes("A-human-abort"));
  } finally {
    runtime.dispose();
  }
});

test("失效与配置链：surface replace/compaction 失效快照；配置读取异常 fail-closed；append 不误失效", async () => {
  const host = await makeRealHost({ adapterDefaults: true });
  const root = makeBoard();
  const supId = "sup-invalid";
  const agent = await makeAgent(host, supId, root);
  writeFileSync(join(root, "project.yaml"), `supervisor:\n  session: ${supId}\n`);
  const { runtime } = await makeRuntime(host, { defaultWorkspace: () => root });
  runtime.start();
  try {
    await runtime.sweep();
    await host.sendTurn(agent, "surface-hello");
    assert.equal(runtime.snapshotProblem(agent), null);

    // 正常 append（宿主真实 normal turn 已发生过）不失效
    assert.equal(runtime.snapshotProblem(agent), null, "append 不是 surface 替换，不得误失效");

    // 同 Agent 的真实 surface replacement（compaction 使用的公开 surfaceOp=replace）⇒ 快照必须失效
    const log = agent.session.log;
    const target = log.find((e: any) => e.type === "user/message" && e.surfaceOp === "append");
    assert.ok(target, "真实会话里必须有可替换的 surface 节点");
    const replacement = host.llm.createUserMessage({ content: [{ type: "text", text: "replacement" }], source: { kind: "user" } });
    agent.session.append("user/message", replacement, {
      surfaceOp: { op: "replace", startSeq: target.seq, endSeq: target.seq },
      sourceEventSeqs: [target.seq],
    });
    assert.equal(runtime.snapshotProblem(agent), "surface_replaced");
    assert.equal(runtime.statusFor(root).active.snapshot, "surface_replaced");

    // 同 Agent 的 clear/compact 生命周期（agent/created source）同样使快照失效
    await host.sendTurn(agent, "after-surface");
    assert.equal(runtime.snapshotProblem(agent), null);
    host.hostCtx.emit("agent/created", { agent, source: "compact" });
    assert.equal(runtime.snapshotProblem(agent), "agent_replaced");

    // 配置读取异常 ⇒ fail-closed（不得 effective=true）
    const { runtime: broken } = await makeRuntime(host, {
      defaultWorkspace: () => root,
      readProjectConfigFn: () => { throw new Error("config boom"); },
    });
    broken.start();
    const st = broken.statusFor(root);
    assert.equal(st.effective.effective, false, "读配置异常必须 fail-closed");
    assert.equal(st.configured.config_error, true);
    assert.ok(st.capable.missing.includes("project.config"));
    assert.equal(st.active.snapshot, "config_unavailable");
    broken.dispose();
  } finally {
    runtime.dispose();
  }
});

test("生命周期：start 幂等、每 board 单 timer、dispose/HMR 清 timer，重复 dispose 与 dispose 后 sweep 均安全", async () => {
  const root = makeBoard();
  const fakeHost = { hostCtx: { on: () => () => {} }, llmRuntime: null, reg: null } as any;
  const clock = fakeClock();
  const timers = new Map<number, number>();
  let seq = 0;
  const { runtime } = await makeRuntime(fakeHost, {
    clock,
    defaultWorkspace: () => root,
    setTimeoutFn: (_fn: any, ms: number) => { const id = ++seq; timers.set(id, clock.now() + ms); return id; },
    clearTimeoutFn: (id: number) => { timers.delete(id); },
  });
  runtime.start();
  runtime.start();
  assert.equal(timers.size, 1, "start 幂等且每 board 恰一个 deadline timer");
  runtime.dispose();
  runtime.dispose();
  assert.equal(timers.size, 0, "dispose 必须清掉全部 board timer 且幂等");
  await runtime.sweep(); // dispose 后 safe no-op
  const st = runtime.statusFor(root);
  assert.equal(typeof st.effective.effective, "boolean");
});

test("B1 失败与维护忙：失败 finish 不推进 lastLlmAt；真维护占用时 runMaintenance 同步拒绝且不发请求", async () => {
  const host = await makeRealHost({ adapterDefaults: true });
  const root = makeBoard();
  const supId = "sup-b1-fail";
  const agent = await makeAgent(host, supId, root);
  writeFileSync(join(root, "project.yaml"), `supervisor:\n  session: ${supId}\n`);
  const { runtime, clock } = await makeRuntime(host, { defaultWorkspace: () => root });
  runtime.start();
  try {
    await runtime.sweep();
    await host.sendTurn(agent, "hello-fail");
    const beforeLastLlm = runtime.stateFor(root).lastLlmAt;
    clock.advance(240_000);
    host.adapter.behaviors.push("error");
    await runtime.sweep();
    assert.equal(runtime.stateFor(root).lastOutcome, "adapter_error");
    assert.equal(runtime.stateFor(root).lastLlmAt, beforeLastLlm, "失败 finish 绝不能推进 lastLlmAt");
    assert.equal(runtime.stateFor(root).pingsInWindow, 1, "尝试仍计入有界预算");
    const callsAfterError = host.adapter.calls.length;

    // 新活动重置阶段二机会（失败尝试已消耗一次 Grace，不能拿它冒充「维护忙」分支）
    await host.sendTurn(agent, "hello-busy");
    clock.advance(240_000);
    const callsBeforeBusy = host.adapter.calls.length;
    // 真维护占用：公开 runMaintenance 同步 throw ⇒ 不发请求、不计预算
    let release: (() => void) | null = null;
    const holding = agent.runMaintenance(async () => { await new Promise<void>((r) => { release = r; }); });
    await runtime.sweep();
    assert.equal(runtime.stateFor(root).lastOutcome, "maintenance_busy");
    assert.equal(host.adapter.calls.length, callsBeforeBusy, "维护忙时不得发保活请求");
    assert.equal(runtime.stateFor(root).pingsInWindow, 0, "未发请求不计新预算");
    release!();
    await holding;
  } finally {
    runtime.dispose();
  }
});

test("B1 配置门禁（真实宿主）：项目畸形/全局关闭时不发请求且投影 fail-closed", async () => {
  // 项目畸形
  {
    const host = await makeRealHost({ adapterDefaults: true });
    const root = makeBoard("supervisor:\n  session: sup-bad\n  keep_alive: yes\n");
    const agent = await makeAgent(host, "sup-bad", root);
    const { runtime, clock } = await makeRuntime(host, { defaultWorkspace: () => root });
    runtime.start();
    try {
      await runtime.sweep();
      await host.sendTurn(agent, "hello-bad");
      clock.advance(240_000);
      await runtime.sweep();
      assert.equal(host.adapter.calls.length, 1, "畸形配置不得保活");
      const st = runtime.statusFor(root);
      assert.equal(st.effective.effective, false);
      assert.equal(st.effective.source, "project_invalid");
      assert.equal(st.configured.project_malformed, true);
    } finally { runtime.dispose(); }
  }
  // 全局显式关闭 + 项目 inherit
  {
    const host = await makeRealHost({ adapterDefaults: true });
    const root = makeBoard("supervisor:\n  session: sup-off\n");
    const agent = await makeAgent(host, "sup-off", root);
    const { runtime, clock } = await makeRuntime(host, {
      defaultWorkspace: () => root,
      readGlobal: () => ({ enabled: false, malformed: false, available: true, raw: "off" }),
    });
    runtime.start();
    try {
      await runtime.sweep();
      await host.sendTurn(agent, "hello-off");
      clock.advance(240_000);
      await runtime.sweep();
      assert.equal(host.adapter.calls.length, 1, "全局关闭时不得保活");
      assert.equal(runtime.statusFor(root).effective.effective, false);
      assert.equal(runtime.statusFor(root).effective.source, "global_explicit");
    } finally { runtime.dispose(); }
  }
});

// ─────────────────────────────── 4b. B4/B6 真实 deadline 调度（假 clock + 真 timer 接线） ───────────────────────────────

test("B4 任意相位：单 board 在 240s 真实 deadline 精确 ping（60s 配置检查不改变到期时刻）并按时进入 AFK", async () => {
  const host = await makeRealHost({ adapterDefaults: true });
  const root = makeBoard("supervisor:\n  session: sup-b4a\n  keep_alive: true\n");
  const agent = await makeAgent(host, "sup-b4a", root);
  const clock = fakeClock(1_234_567); // 故意不落在任何整数 tick
  const sched = makeFakeScheduler(clock);
  host.adapter.nowFn = clock.now;
  const { runtime } = await makeRuntime(host, {
    clock,
    defaultWorkspace: () => root,
    setTimeoutFn: sched.setTimeoutFn,
    clearTimeoutFn: sched.clearTimeoutFn,
  });
  runtime.start();
  try {
    const t0 = clock.now();
    await host.sendTurn(agent, "b4-phase");
    assert.equal(host.adapter.calls.length, 1);

    await sched.advanceTo(t0 + 209_999);
    assert.equal(host.adapter.calls.length, 1, "209999ms 不得 ping（阶段二 240s）");
    await sched.advanceTo(t0 + 239_999);
    assert.equal(host.adapter.calls.length, 1, "239999ms 不得 ping");
    await sched.advanceTo(t0 + 240_000);
    assert.equal(host.adapter.calls.length, 2, "240000ms 必须真实 ping");
    assert.equal(host.adapter.times[1], t0 + 240_000, "timer 到期即 ping，不得被 105/60s 轮询相位推迟");

    await sched.advanceTo(t0 + 540_000);
    assert.equal(host.adapter.calls.length, 2, "阶段二单次后不得再 ping");
    assert.equal(runtime.statusFor(root).active.phase, "afk");
    assert.equal(runtime.statusFor(root).active.reason, "stage2_afk");
  } finally {
    runtime.dispose();
  }
});

test("B4 多 board 不同相位/并发到期：各自 deadline 精确，互不串扰", async () => {
  const host = await makeRealHost({ adapterDefaults: true });
  const rootA = makeBoard("supervisor:\n  session: sup-b4-A\n  keep_alive: true\n");
  const rootB = makeBoard("supervisor:\n  session: sup-b4-B\n  keep_alive: true\n");
  const agentA = await makeAgent(host, "sup-b4-A", rootA);
  const agentB = await makeAgent(host, "sup-b4-B", rootB);
  const clock = fakeClock(2_000_000);
  const sched = makeFakeScheduler(clock);
  host.adapter.nowFn = clock.now;
  const { runtime } = await makeRuntime(host, {
    clock,
    defaultWorkspace: () => rootA,
    setTimeoutFn: sched.setTimeoutFn,
    clearTimeoutFn: sched.clearTimeoutFn,
  });
  runtime.start();
  try {
    const t0 = clock.now();
    await host.sendTurn(agentA, "A-b4");
    await sched.advance(50_000);
    await host.sendTurn(agentB, "B-b4");
    const tB = t0 + 50_000;
    assert.equal(host.adapter.calls.length, 2);

    await sched.advanceTo(t0 + 240_000);
    assert.equal(host.adapter.calls.length, 3, "A 到期只应 A ping");
    assert.equal(host.adapter.calls[2].sessionId, agentA.session.id);
    assert.equal(host.adapter.times[2], t0 + 240_000);

    await sched.advanceTo(tB + 239_999);
    assert.equal(host.adapter.calls.length, 3, "B 未到期不得 ping");
    await sched.advanceTo(tB + 240_000);
    assert.equal(host.adapter.calls.length, 4, "B 在自身 240s 到期时 ping");
    assert.equal(host.adapter.calls[3].sessionId, agentB.session.id);
    assert.equal(host.adapter.times[3], tB + 240_000);

    // 并发到期：新窗口让两 board 同一时刻到期，两个 timer 都必须执行
    await host.sendTurn(agentA, "A-b4-2");
    await host.sendTurn(agentB, "B-b4-2");
    const concurrentAt = clock.now() + 240_000;
    await sched.advanceTo(concurrentAt);
    const pings = host.adapter.calls.filter((c: any) => c.maxTokens === 1);
    assert.ok(pings.some((c: any) => c.sessionId === agentA.session.id));
    assert.ok(pings.some((c: any) => c.sessionId === agentB.session.id));
  } finally {
    runtime.dispose();
  }
});

test("B4 活动重置 deadline；配置关闭经 60s 检查上界生效；dispose 清 timer；maintenance busy 有界重排", async () => {
  // 活动重置
  {
    const host = await makeRealHost({ adapterDefaults: true });
    const root = makeBoard("supervisor:\n  session: sup-b4-reset\n  keep_alive: true\n");
    const agent = await makeAgent(host, "sup-b4-reset", root);
    const clock = fakeClock(3_000_000);
    const sched = makeFakeScheduler(clock);
    host.adapter.nowFn = clock.now;
    const { runtime } = await makeRuntime(host, {
      clock, defaultWorkspace: () => root, setTimeoutFn: sched.setTimeoutFn, clearTimeoutFn: sched.clearTimeoutFn,
    });
    runtime.start();
    try {
      const t0 = clock.now();
      await host.sendTurn(agent, "reset-1");
      await sched.advance(100_000);
      await host.sendTurn(agent, "reset-2");
      const t1 = t0 + 100_000;
      await sched.advanceTo(t0 + 240_000);
      assert.equal(host.adapter.calls.length, 2, "活动后旧 deadline 不得 ping");
      await sched.advanceTo(t1 + 240_000);
      assert.equal(host.adapter.calls.length, 3, "活动后新 deadline 精确 ping");
      assert.equal(host.adapter.times[2], t1 + 240_000);
    } finally { runtime.dispose(); }
  }
  // 配置关闭 + dispose
  {
    const host = await makeRealHost({ adapterDefaults: true });
    const root = makeBoard("supervisor:\n  session: sup-b4-off\n  keep_alive: true\n");
    const agent = await makeAgent(host, "sup-b4-off", root);
    const clock = fakeClock(4_000_000);
    const sched = makeFakeScheduler(clock);
    host.adapter.nowFn = clock.now;
    const { runtime } = await makeRuntime(host, {
      clock, defaultWorkspace: () => root, setTimeoutFn: sched.setTimeoutFn, clearTimeoutFn: sched.clearTimeoutFn,
    });
    runtime.start();
    try {
      const t0 = clock.now();
      await host.sendTurn(agent, "off-1");
      writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sup-b4-off\n  keep_alive: false\n");
      await sched.advanceTo(t0 + 240_000);
      assert.equal(host.adapter.calls.length, 1, "配置关闭后不得 ping（配置检查上界 60s）");
      assert.equal(runtime.statusFor(root).effective.effective, false);
      runtime.dispose();
      assert.equal(sched.pending().length, 0, "dispose/HMR 必须清掉本 board timer");
      await sched.advanceTo(t0 + 600_000);
      assert.equal(host.adapter.calls.length, 1, "dispose 后不得再 ping");
    } finally { runtime.dispose(); }
  }
  // maintenance busy：同步拒绝、不发请求、不计预算，15s 后重排
  {
    const host = await makeRealHost({ adapterDefaults: true });
    const root = makeBoard("supervisor:\n  session: sup-b4-busy\n  keep_alive: true\n");
    const agent = await makeAgent(host, "sup-b4-busy", root);
    const clock = fakeClock(5_000_000);
    const sched = makeFakeScheduler(clock);
    host.adapter.nowFn = clock.now;
    const { runtime } = await makeRuntime(host, {
      clock, defaultWorkspace: () => root, setTimeoutFn: sched.setTimeoutFn, clearTimeoutFn: sched.clearTimeoutFn,
    });
    runtime.start();
    try {
      const t0 = clock.now();
      await host.sendTurn(agent, "busy-1");
      let release: (() => void) | null = null;
      const holding = agent.runMaintenance(async () => { await new Promise<void>((r) => { release = r; }); });
      await sched.advanceTo(t0 + 240_000);
      assert.equal(host.adapter.calls.length, 1, "维护忙时不得发请求");
      assert.equal(runtime.stateFor(root).pingsInWindow, 0, "未发请求不计预算");
      assert.equal(runtime.stateFor(root).lastOutcome, "maintenance_busy");
      const due = runtime.stateFor(root).timerDueAt;
      assert.equal(due, t0 + 240_000 + 15_000, "维护忙必须 15s 有界重排，不得 busy-spin");
      release!();
      await holding;
      await sched.advanceTo(t0 + 240_000 + 15_000);
      assert.equal(host.adapter.calls.length, 2, "维护释放后 15s 重排应真实 ping");
      assert.equal(runtime.stateFor(root).pingsInWindow, 1);
    } finally { runtime.dispose(); }
  }
});

test("B4 计时器触发的维护中人类输入：只取消本插件 ping，排队轮随后执行，不重复请求", async () => {
  const host = await makeRealHost({ adapterDefaults: true });
  const root = makeBoard("supervisor:\n  session: sup-b4-abort\n  keep_alive: true\n");
  const agent = await makeAgent(host, "sup-b4-abort", root);
  const clock = fakeClock(9_000_000);
  const sched = makeFakeScheduler(clock);
  host.adapter.nowFn = clock.now;
  const { runtime } = await makeRuntime(host, {
    clock, defaultWorkspace: () => root, setTimeoutFn: sched.setTimeoutFn, clearTimeoutFn: sched.clearTimeoutFn,
  });
  runtime.start();
  try {
    const t0 = clock.now();
    await host.sendTurn(agent, "abort-b4");
    const gate = Promise.withResolvers<void>();
    host.adapter.gate = gate.promise;
    host.adapter.behaviors.push("abort-delayed");
    const advancing = sched.advanceTo(t0 + 240_000);
    await waitFor(() => host.adapter.calls.length === 2, "timer 到期进入 ping");
    assert.equal(runtime.stateFor(root).inflight, true);

    const queued = host.llm.createUserMessage({ content: [{ type: "text", text: "timer-abort-human" }], source: { kind: "user" } });
    agent.send(queued, "next-turn", true);
    assert.equal(agent.inbox.nextTurn.length, 1);
    assert.equal(runtime.stateFor(root).inflight, true, "输入只 abort 控制器，iterator 未释放前仍 inflight");
    gate.resolve();
    await advancing;
    await agent.whenIdle();
    assert.equal(runtime.stateFor(root).lastOutcome, "aborted_input");
    assert.equal(host.adapter.calls.length, 3, "只允许一次 ping + 排队正常轮");
    assert.equal(JSON.stringify(agent.session.deriveMessages()).includes("timer-abort-human"), true);
    // 取消不是成功：不得写成功时间；活动重置后按新 lastLlm 重新计时
    assert.equal(runtime.stateFor(root).lastOutcome !== "success", true);
    assert.equal(runtime.stateFor(root).inflight, false);
  } finally { runtime.dispose(); }
});

test("B6 阶段一失败：lastLlm/lastPing 不推进，独立 lastAttemptAt + 指数退避，4 次预算仍封顶", async () => {
  const host = await makeRealHost({ adapterDefaults: true });
  const root = makeBoard("supervisor:\n  session: sup-b6-fail\n  keep_alive: true\n");
  const agent = await makeAgent(host, "sup-b6-fail", root);
  const child = { id: "child-b6", status: "running", session: { id: "child-b6", header: { cwd: root } }, inbox: { nextTurn: [], nextStep: [] } } as any;
  host.reg.enter(child, agent);
  const clock = fakeClock(6_000_000);
  const sched = makeFakeScheduler(clock);
  host.adapter.nowFn = clock.now;
  host.adapter.behaviors.push("error", "error", "error", "error");
  const { runtime } = await makeRuntime(host, {
    clock, defaultWorkspace: () => root, setTimeoutFn: sched.setTimeoutFn, clearTimeoutFn: sched.clearTimeoutFn,
  });
  runtime.start();
  try {
    const t0 = clock.now();
    await host.sendTurn(agent, "fail-1");
    const llmBefore = runtime.stateFor(root).lastLlmAt;
    await sched.advanceTo(t0 + 210_000);
    assert.equal(host.adapter.calls.length, 2);
    assert.equal(runtime.stateFor(root).lastOutcome, "adapter_error");
    assert.equal(runtime.stateFor(root).lastLlmAt, llmBefore, "失败不得推进 lastLlmAt");
    assert.equal(runtime.stateFor(root).lastPingAt, null, "失败不得写 lastPingAt");
    assert.equal(runtime.stateFor(root).lastSuccessAt, null);
    assert.equal(runtime.stateFor(root).lastAttemptAt, t0 + 210_000);
    assert.equal(runtime.stateFor(root).timerDueAt, t0 + 240_000, "失败后 30s 退避（非立刻重试）");
    await sched.advanceTo(t0 + 239_999);
    assert.equal(host.adapter.calls.length, 2, "退避未到不得重复失败");
    await sched.advanceTo(t0 + 240_000);
    assert.equal(host.adapter.calls.length, 3, "30s 后允许一次重试");
    assert.equal(host.adapter.times[2], t0 + 240_000);
    await sched.advanceTo(t0 + 300_000);
    assert.equal(host.adapter.calls.length, 4, "第二次失败后 60s 退避");
    await sched.advanceTo(t0 + 420_000);
    assert.equal(host.adapter.calls.length, 5, "第三次失败后 120s 退避");
    assert.equal(runtime.stateFor(root).pingsInWindow, 4, "4 次尝试后熔断");
    await sched.advanceTo(t0 + 2_000_000);
    assert.equal(host.adapter.calls.length, 5, "熔断后不得再发");
    assert.equal(runtime.statusFor(root).active.reason, "stage1_fused");
  } finally { runtime.dispose(); }
});

test("B6 阶段一成功/阶段二成功：成功时间与 attempt 分开；stage1 4 次上限、stage2 单次", async () => {
  // 阶段一 4 次成功 + 熔断
  {
    const host = await makeRealHost({ adapterDefaults: true });
    const root = makeBoard("supervisor:\n  session: sup-b6-ok\n  keep_alive: true\n");
    const agent = await makeAgent(host, "sup-b6-ok", root);
    host.reg.enter({ id: "child-ok", status: "running", session: { id: "child-ok", header: { cwd: root } }, inbox: { nextTurn: [], nextStep: [] } }, agent);
    const clock = fakeClock(7_000_000);
    const sched = makeFakeScheduler(clock);
    host.adapter.nowFn = clock.now;
    const { runtime } = await makeRuntime(host, {
      clock, defaultWorkspace: () => root, setTimeoutFn: sched.setTimeoutFn, clearTimeoutFn: sched.clearTimeoutFn,
    });
    runtime.start();
    try {
      const t0 = clock.now();
      await host.sendTurn(agent, "ok-1");
      for (const at of [210_000, 420_000, 630_000, 840_000]) {
        await sched.advanceTo(t0 + at);
      }
      assert.equal(host.adapter.calls.length, 5, "loop + 4 次真实 ping");
      assert.equal(runtime.stateFor(root).pingsInWindow, 4);
      assert.equal(runtime.stateFor(root).lastPingAt, t0 + 840_000);
      assert.equal(runtime.stateFor(root).lastSuccessAt, t0 + 840_000);
      assert.equal(runtime.stateFor(root).lastLlmAt, t0 + 840_000);
      await sched.advanceTo(t0 + 1_500_000);
      assert.equal(host.adapter.calls.length, 5, "第 4 次后熔断");
    } finally { runtime.dispose(); }
  }
  // 阶段二成功仅一次；之后 AFK
  {
    const host = await makeRealHost({ adapterDefaults: true });
    const root = makeBoard("supervisor:\n  session: sup-b6-s2\n  keep_alive: true\n");
    const agent = await makeAgent(host, "sup-b6-s2", root);
    const clock = fakeClock(8_000_000);
    const sched = makeFakeScheduler(clock);
    host.adapter.nowFn = clock.now;
    const { runtime } = await makeRuntime(host, {
      clock, defaultWorkspace: () => root, setTimeoutFn: sched.setTimeoutFn, clearTimeoutFn: sched.clearTimeoutFn,
    });
    runtime.start();
    try {
      const t0 = clock.now();
      await host.sendTurn(agent, "s2-1");
      await sched.advanceTo(t0 + 240_000);
      assert.equal(host.adapter.calls.length, 2);
      assert.equal(runtime.stateFor(root).stage2Used, true);
      assert.equal(runtime.stateFor(root).lastPingAt, t0 + 240_000);
      await sched.advanceTo(t0 + 540_000);
      assert.equal(host.adapter.calls.length, 2, "阶段二只能一次");
      assert.equal(runtime.statusFor(root).active.phase, "afk");
    } finally { runtime.dispose(); }
  }
});

test("B5 显式可信长 TTL：完整 provider+model 匹配才豁免；未知/不匹配/畸形走原短策略", async () => {
  // 匹配 ⇒ 豁免，不 ping
  {
    const host = await makeRealHost({ adapterDefaults: true });
    const root = makeBoard("supervisor:\n  session: sup-ttl-ok\n  keep_alive: true\n  keep_alive_ttl:\n    provider: observed\n    model: observed-model\n    ttl_ms: 900000\n");
    const agent = await makeAgent(host, "sup-ttl-ok", root);
    const { runtime, clock } = await makeRuntime(host, { defaultWorkspace: () => root });
    runtime.start();
    try {
      await host.sendTurn(agent, "SECRET-MESSAGE-XYZ");
      const st = runtime.statusFor(root);
      assert.equal(st.capable.ttl, "explicit");
      assert.equal(st.capable.reason, "exempt_long_ttl");
      assert.equal(st.configured.route_ttl_matched, true);
      assert.deepEqual(st.configured.route_ttl, { provider: "observed", model: "observed-model", ttl_ms: 900000 });
      assert.equal(runtime.snapshotProblem(agent), null, "TTL 豁免不得破坏快照可用性");
      assert.equal(JSON.stringify(st).includes("SECRET-MESSAGE-XYZ"), false, "状态投影不得泄漏会话内容/messages");
      clock.advance(240_000);
      await runtime.sweep();
      assert.equal(host.adapter.calls.length, 1, "显式长 TTL 匹配时不得 ping");
      assert.equal(runtime.stateFor(root).lastOutcome, null);
    } finally { runtime.dispose(); }
  }
  // 不匹配 ⇒ unknown，按原策略 ping
  {
    const host = await makeRealHost({ adapterDefaults: true });
    const root = makeBoard("supervisor:\n  session: sup-ttl-no\n  keep_alive: true\n  keep_alive_ttl:\n    provider: observed\n    model: other-model\n    ttl_ms: 900000\n");
    const agent = await makeAgent(host, "sup-ttl-no", root);
    const { runtime, clock } = await makeRuntime(host, { defaultWorkspace: () => root });
    runtime.start();
    try {
      await host.sendTurn(agent, "ttl-no");
      const st = runtime.statusFor(root);
      assert.equal(st.capable.ttl, "unknown");
      assert.equal(st.configured.route_ttl_matched, false);
      clock.advance(240_000);
      await runtime.sweep();
      assert.equal(host.adapter.calls.length, 2, "不匹配 ⇒ 未知 TTL 原策略照常 ping");
    } finally { runtime.dispose(); }
  }
  // 畸形 ⇒ malformed + unknown，不豁免
  {
    const host = await makeRealHost({ adapterDefaults: true });
    const root = makeBoard("supervisor:\n  session: sup-ttl-bad\n  keep_alive: true\n  keep_alive_ttl:\n    provider: observed\n    model: observed-model\n    ttl_ms: 1000\n");
    const agent = await makeAgent(host, "sup-ttl-bad", root);
    const { runtime, clock } = await makeRuntime(host, { defaultWorkspace: () => root });
    runtime.start();
    try {
      await host.sendTurn(agent, "ttl-bad");
      const st = runtime.statusFor(root);
      assert.equal(st.configured.route_ttl_malformed, true);
      assert.equal(st.capable.ttl, "unknown");
      clock.advance(240_000);
      await runtime.sweep();
      assert.equal(host.adapter.calls.length, 2);
    } finally { runtime.dispose(); }
  }
  // schema / 写入 / 清理
  {
    const root = makeBoard("supervisor:\n  session: sup-ttl-schema\n");
    assert.equal(validateSchema({ supervisor: { keep_alive_ttl: { provider: "p", model: "m", ttl_ms: 1000 } } }, settingsPostSchema).valid, false, "小于豁免阈值必须拒绝");
    assert.equal(validateSchema({ supervisor: { keep_alive_ttl: { provider: "p", model: "m" } } }, settingsPostSchema).valid, false, "缺 ttl_ms 必须拒绝");
    writeProjectConfig(root, { supervisor: { keep_alive_ttl: { provider: "observed", model: "observed-model", ttl_ms: 900000 } } }, "g505-test");
    let cfg = readProjectConfig(root);
    assert.deepEqual(cfg.supervisor.keep_alive_ttl, { provider: "observed", model: "observed-model", ttl_ms: 900000 });
    writeProjectConfig(root, { supervisor: { keep_alive_ttl: null } }, "g505-test");
    cfg = readProjectConfig(root);
    assert.equal(cfg.supervisor.keep_alive_ttl, null);
    assert.equal(existsSync(join(root, "project.yaml")), true);
  }
});

// ─────────────────────────────── 5. REST / 工具 / GUI 契约 ───────────────────────────────

function fakeRes() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}

/** apply 级夹具：真实唯一 prefix 注册 + g507 owner admit（测试自有凭证），服务缺失如实降级。 */
function makeApplyHarness(root: string, extraGet: (name: string) => any = () => undefined, settingsService: any = null) {
  const stub = createRegisterStub();
  const registered: any[] = [];
  const cleanups: Array<() => void> = [];
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return stub.webServer;
      if (name === "connection") return ownerConnectionStub();
      if (name === "sandboxPolicy") return { workspaceRoot: root };
      return extraGet(name);
    },
    effect: (fn: () => unknown) => { const d = fn(); if (typeof d === "function") cleanups.push(d as any); return d; },
    webServer: stub.webServer,
    tools: { register: (d: any) => { registered.push(d); return () => {}; }, get: () => undefined },
    // 可选：模拟宿主 `ctx.inject(["settings"])` 的公开服务注入（用于证明设置服务是现真源）
    ...(settingsService
      ? {
          inject: (_deps: string[], cb: (sctx: any) => void) => {
            cb({ settings: settingsService, effect: () => {}, on: () => () => {}, get: ctx.get });
          },
        }
      : {}),
  };
  apply(ctx, { root });
  const byName = new Map(registered.map((d: any) => [d.name, d]));
  const call = async (method: string, path: string, body?: unknown) => {
    const handler = entryHandler(stub.routes);
    assert.equal(typeof handler, "function", "插件必须注册唯一的受保护 prefix 入口");
    const req: any = {
      headers: { [OWNER_HEADER]: "1" },
      method,
      url: path,
      _l: {} as Record<string, (v?: any) => void>,
      on(ev: string, cb: (v?: any) => void) { req._l[ev] = cb; },
    };
    const res = fakeRes();
    const p = handler(req, res);
    if (method === "POST") { req._l.data?.(JSON.stringify(body)); req._l.end?.(); }
    await p;
    return { code: res._code, body: res._body };
  };
  return { ctx, byName, call, cleanups, routes: stub.routes };
}

test("g505 REST/工具：project 三态写读、effective 与 capable/active 如实下发（缺失能力不报成功）", async () => {
  const root = makeBoard("");
  const h = makeApplyHarness(root);
  try {
    const get1 = await h.call("GET", "/api/dsh-graph/settings");
    assert.equal(get1.code, 200);
    // GET 直接展开项目配置（POST 才包 { ok, config }）
    const eff1 = get1.body.supervisor.keep_alive_effective;
    assert.equal(eff1.effective, true, "默认：项目 inherit + 全局未配置 ⇒ 受控默认尝试开启");
    assert.equal(eff1.source, "global_default");
    // 本夹具没有 llm/agents 服务：能力必须如实缺失，绝不显示「正在保活」
    const status1 = get1.body.supervisor.keep_alive_status;
    assert.ok(status1.capable.missing.includes("llm.prepareCall/stream"));
    assert.equal(status1.capable.host_channel, false);
    assert.equal(status1.capable.ttl, "unknown");

    // 写 project 显式 true ⇒ 落盘 + 读回生效值/来源一致
    const post = await h.call("POST", "/api/dsh-graph/settings", { supervisor: { keep_alive: "true" } });
    assert.equal(post.code, 200);
    assert.match(readFileSync(join(root, "project.yaml"), "utf8"), /keep_alive: true/);
    assert.equal(post.body.config.supervisor.keep_alive_effective.effective, true);
    assert.equal(post.body.config.supervisor.keep_alive_effective.source, "project_explicit");

    // 隐式形态被 schema 拒绝
    const badPost = await h.call("POST", "/api/dsh-graph/settings", { supervisor: { keep_alive: "yes" } });
    assert.equal(badPost.code, 400);

    // 工具面同源投影
    const tool = h.byName.get("graph_get_settings");
    assert.ok(tool, "graph_get_settings 必须已注册");
    const out = await tool.execute({}, { agent: undefined, signal: new AbortController().signal });
    assert.equal(out.supervisor_keep_alive.effective.effective, true);
    assert.equal(out.supervisor_keep_alive.effective.source, "project_explicit");
    assert.deepEqual(out.schema_hints["supervisor.keep_alive"].values, ["inherit", "true", "false", null]);
  } finally {
    for (const d of h.cleanups.splice(0)) { try { d(); } catch { /* ignore */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test("g505 REST：project.yaml 畸形与 profile 原始坏值端到端闭锁（坏值不归一 inherit 后启用）", async () => {
  // ① project 原始坏值（直接手写 YAML，绕过写侧 schema）
  const root = makeBoard("supervisor:\n  keep_alive: yes\n");
  const h = makeApplyHarness(root);
  try {
    const got = await h.call("GET", "/api/dsh-graph/settings");
    assert.equal(got.code, 200);
    const eff = got.body.supervisor.keep_alive_effective;
    assert.equal(eff.effective, false);
    assert.equal(eff.source, "project_invalid");
    assert.equal(eff.malformed, true);
    const status = got.body.supervisor.keep_alive_status;
    assert.equal(status.configured.project_malformed, true);
    assert.equal(status.effective.effective, false);
  } finally {
    for (const d of h.cleanups.splice(0)) { try { d(); } catch { /* ignore */ } }
    rmSync(root, { recursive: true, force: true });
  }

  // ② profile 全局原始坏值（settings.yaml 手写 yes；settings 服务缺失，靠 raw 读取闭锁）
  const root2 = makeBoard("");
  const home = tmpDir("home");
  writeFileSync(join(home, "settings.yaml"), "dsh-graph-host:\n  supervisorKeepAlive: yes\n");
  const h2 = makeApplyHarness(root2, (name: string) => (name === "profileContext" ? { home, dir: home } : undefined));
  try {
    const got = await h2.call("GET", "/api/dsh-graph/settings");
    assert.equal(got.code, 200);
    const eff = got.body.supervisor.keep_alive_effective;
    assert.equal(eff.effective, false, "全局坏值必须 fail-closed 关闭（不得归一 inherit 后默认开启）");
    assert.equal(eff.source, "global_invalid");
    assert.equal(eff.malformed, true);
    assert.equal(got.body.supervisor.keep_alive_status.configured.global_malformed, true);
    assert.equal(got.body.supervisor.keep_alive_status.configured.global_raw, "yes");
  } finally {
    for (const d of h2.cleanups.splice(0)) { try { d(); } catch { /* ignore */ } }
    rmSync(root2, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("g505 REST：profile 全局只认当前 settings.yaml，迁移遗留 settings.yaml.imported 不得覆盖现真源", async () => {
  const root = makeBoard("");
  const home = tmpDir("home");
  writeFileSync(join(home, "settings.yaml"), "dsh-graph-host:\n  supervisorKeepAlive: \"\"\n");
  writeFileSync(join(home, "settings.yaml.imported"), "dsh-graph-host:\n  supervisorKeepAlive: yes\ndsh-graph:\n  supervisorKeepAlive: \"on\"\n");
  const h = makeApplyHarness(root, (name: string) => (name === "profileContext" ? { home, dir: home } : undefined));
  try {
    const got = await h.call("GET", "/api/dsh-graph/settings");
    assert.equal(got.code, 200);
    const eff = got.body.supervisor.keep_alive_effective;
    assert.equal(eff.effective, true, "当前设置未配置 ⇒ 受控默认；不得被 .imported 坏值污染");
    assert.equal(eff.malformed, false);
    assert.equal(got.body.supervisor.keep_alive_status.configured.global_malformed, false);
    assert.equal(eff.source, "global_default", "旧节/imported 的 keepalive 不得被迁移成显式全局值");
  } finally {
    for (const d of h.cleanups.splice(0)) { try { d(); } catch { /* ignore */ } }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("g505 REST：公开 settings 服务的显式值是现真源，优先于 settings.yaml 的陈旧/坏值", async () => {
  const root = makeBoard("");
  const home = tmpDir("home");
  // 当前文件里是坏值 yes；但公开设置服务返回显式合法 "off" ⇒ 以服务为准（不误判 malformed）。
  writeFileSync(join(home, "settings.yaml"), "dsh-graph-host:\n  supervisorKeepAlive: yes\n");
  const svc = {
    describe: () => [{ ns: "dsh-graph-host", value: { supervisorKeepAlive: "off" }, user: { supervisorKeepAlive: "off" }, revision: 1 }],
    configure: () => {},
  };
  const h = makeApplyHarness(
    root,
    (name: string) => (name === "profileContext" ? { home, dir: home } : undefined),
    svc,
  );
  try {
    const got = await h.call("GET", "/api/dsh-graph/settings");
    assert.equal(got.code, 200);
    const eff = got.body.supervisor.keep_alive_effective;
    assert.equal(eff.effective, false);
    assert.equal(eff.source, "global_explicit");
    assert.equal(eff.malformed, false, "公开服务显式合法值不得被文件坏值误判");
    assert.equal(got.body.supervisor.keep_alive_status.configured.global_raw, "off");
  } finally {
    for (const d of h.cleanups.splice(0)) { try { d(); } catch { /* ignore */ } }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("B5 REST：keep_alive_ttl 在 settings 投影中与项目配置同源，默认 null=未知", async () => {
  const root = makeBoard("supervisor:\n  session: sup-ttl-rest\n  keep_alive: true\n  keep_alive_ttl:\n    provider: observed\n    model: observed-model\n    ttl_ms: 900000\n");
  const h = makeApplyHarness(root);
  try {
    const got = await h.call("GET", "/api/dsh-graph/settings");
    assert.equal(got.code, 200);
    assert.deepEqual(got.body.supervisor.keep_alive_ttl, { provider: "observed", model: "observed-model", ttl_ms: 900000 });
    const status = got.body.supervisor.keep_alive_status;
    assert.deepEqual(status.configured.route_ttl, { provider: "observed", model: "observed-model", ttl_ms: 900000 });
    assert.equal(status.configured.route_ttl_malformed, false);
    assert.equal(status.configured.route_ttl_matched, false, "无观察 route 时不得假装匹配豁免");
    assert.equal(status.capable.ttl, "unknown", "默认未知路径仍原样投影");
  } finally {
    for (const d of h.cleanups.splice(0)) { try { d(); } catch { /* ignore */ } }
    rmSync(root, { recursive: true, force: true });
  }
});

test("g505 GUI 契约：客户端三态写入点/生效读数与 zh/en 文案键对称", () => {
  const client = readFileSync(new URL("../../dsh-graph-host/lib/client/settings-modal.js", import.meta.url), "utf8");
  assert.match(client, /const KEEP_ALIVE_MODES = \["inherit", "true", "false"\]/);
  assert.match(client, /set\(\["supervisor", "keep_alive"\], e\.target\.value === "inherit" \? null : e\.target\.value\)/);
  assert.match(client, /form\.supervisor\?\.keep_alive_effective/);
  assert.match(client, /dg-keep-alive/);
  assert.match(client, /keep_alive_status/);
  const i18n = readFileSync(new URL("../../dsh-graph-host/lib/client/i18n.js", import.meta.url), "utf8");
  for (const key of [
    "settings.keepAliveLabel", "settings.keepAliveHint", "settings.keepAliveAria",
    "settings.keepAliveInherit", "settings.keepAliveOn", "settings.keepAliveOff",
    "settings.keepAliveEffective", "settings.keepAliveMalformed", "settings.keepAliveTtlUnknown",
    "settings.keepAliveCapability", "settings.keepAliveUnavailable",
    "settings.keepAliveSrcProject", "settings.keepAliveSrcGlobal", "settings.keepAliveSrcDefault",
    "settings.keepAliveSrcProjectInvalid", "settings.keepAliveSrcGlobalInvalid",
  ]) {
    assert.equal(i18n.split(`'${key}':`).length - 1, 2, `zh/en 必须各有一份 ${key}`);
  }
  // dist bundle 必须已包含该控件（源改完未构建即红）
  const bundle = readFileSync(new URL("../../dist/lib/client.js", import.meta.url), "utf8");
  assert.ok(bundle.includes("dg-keep-alive"), "dist/lib/client.js 缺少保活控件（源改完必须 bash scripts/build.sh）");
  assert.ok(bundle.includes("supervisor.keep_alive_effective") || bundle.includes("keep_alive_effective"));
});
