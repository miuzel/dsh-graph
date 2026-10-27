/**
 * g-505：主管会话上下文缓存智能保活的离线回归（零网络、零真实 provider、零费用）。
 *
 * 覆盖：
 *  1. 两级配置（profile 全局 / project 三态）的归一、优先级、**raw+malformed 闭锁**与写侧拒绝；
 *  2. 两阶段状态机（阶段一阈值/熔断、阶段二单次 Grace、短 TTL 假设后的 AFK、未知信号 fail-safe）；
 *  3. 真实公开宿主接线（真实 `@deepseek-ai/cordis` Context + 真实 `LlmRuntime` + 真实 `AgentRegistry`
 *     + 进程内 fake adapter + 假时钟）：首次自举、loop 快照捕获、真实 prepareCall/stream 手工保活、
 *     route 取自**所观察请求**、maintenance 互斥、人类输入/子回报只 abort 本插件控制器、失败不续期、
 *     stage2 单次 + AFK、快照失效（agent/session/route/待观察）；
 *  4. 宿主 REST / `graph_get_settings` 的 effective/capable/active 投影（g507 公开 admit + owner 门禁）；
 *  5. GUI 契约（客户端写入点与 zh/en 文案键对称）。
 *
 * 边界（如实声明，不冒充已验证）：
 *  - 未向真实 provider 发任何请求（负责人未给成本授权）；不声明真实缓存收益；
 *  - 未启动完整 `AgentLoop` 全栈：Agent 公开面形状按 0.2.1-rc.2 公共类型实现（status/inbox/
 *    runMaintenance/send/cancel），维护互斥语义由夹具按公开契约模拟；真实 `AgentLoop` 的完整
 *    driver 时序（checkpoint、pre-step 准入、排队释放）**未**在本文件证明；
 *  - 不声称 max_tokens:1 等于一 token 费用。
 *
 * 运行前需 `bash scripts/build.sh`（本文件同时读 dist/index.js 与真实宿主包）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
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

function tmpDir(tag: string): string {
  const base = join(process.cwd(), "tmp");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `g505-${tag}-`));
}

/** 建一个最小 board root（init 骨架 + 可选 project.yaml）。 */
function makeBoard(projectYaml = ""): string {
  const root = tmpDir("board");
  init(root);
  if (projectYaml) writeFileSync(join(root, "project.yaml"), projectYaml);
  return root;
}

/** 假时钟（可注入 runtime，测试时间窗口而不 sleep）。 */
function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; }, set: (v: number) => { t = v; } };
}

/**
 * 真实宿主包解析（不写死作者机器路径、**不联网安装**）：
 *   ① `G505_HOST_STACK_DIR` / `G507_HOST_STACK_DIR` 显式指定 `node_modules/@deepseek-ai`；
 *   ② `npm root -g` 下的已安装 DSH（本机由 fnm 安装；只读定位，不安装）；
 *   ③ 最后才用 g507 的私有副本解析器（它可能只含三个固定包，缺 dsh-llm 时**显式失败**）。
 */
async function resolveHostScope(): Promise<string> {
  const env = process.env.G505_HOST_STACK_DIR || process.env.G507_HOST_STACK_DIR;
  if (env) return env;
  try {
    const { execFileSync } = await import("node:child_process");
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    // 已安装 DSH 的宿主包通常嵌套在 `@deepseek-ai/dsh/node_modules/@deepseek-ai` 下
    // （本机 fnm 全局安装即如此）；两个候选都探测，命中同时含 dsh-llm/dsh-agent 的那个。
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
  const load = (pkg: string, file: string) => import(pathToFileURL(join(dir, pkg, "lib", file)).href);
  const cordis = await load("cordis", "index.js");
  const llm = await load("dsh-llm", "index.js");
  const agent = await load("dsh-agent", "index.js");
  return { Context: cordis.Context, llm, AgentRegistry: agent.AgentRegistry };
}

/**
 * 记录型 fake adapter：**进程内**、零网络。按 `behaviors` 队列决定每次调用的结局：
 *  auto（默认）/ error / abort-on-signal；并记录完整 options 供参数级断言。
 */
function makeFakeAdapter(LlmAdapter: any) {
  class RecordingAdapter extends LlmAdapter {
    calls: any[] = [];
    behaviors: string[] = [];
    providerInfo(provider: string) { return { id: provider, name: provider, protocol: "fake" }; }
    async resolveModel(provider: string, model: string) { return { provider, id: model, name: model }; }
    async *stream(options: any) {
      this.calls.push(options);
      const behavior = this.behaviors.shift() ?? "auto";
      if (behavior === "error") {
        yield { type: "finish", reason: { kind: "error", failure: { code: "FAKE_ERROR", message: "fake failure" } } };
        return;
      }
      if (behavior === "abort-on-signal") {
        await new Promise((_resolve, reject) => {
          const onAbort = () => reject(new Error("fake adapter abort"));
          if (options.signal?.aborted) { onAbort(); return; }
          options.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: "ping" };
      // 故意发一个 tool-call delta：本实现必须完整消费但**绝不执行**工具。
      yield { type: "tool-call-delta", index: 1, id: "call-x", name: "danger", argumentsDelta: "{}" };
      yield { type: "block-end", index: 0, block: { type: "text", text: "ping" } };
      yield { type: "usage", usage: { inputTokens: 120, outputTokens: 1, cacheReadTokens: 96 } };
      yield { type: "finish", reason: { kind: options.maxTokens === 1 ? "max-tokens" : "stop" } };
    }
  }
  return new RecordingAdapter();
}

/** 按 0.2.1-rc.2 公开 Agent 契约构造夹具（status / inbox / runMaintenance / cancel）。 */
function makeAgent(hostCtx: any, id: string, root: string, status = "idle") {
  const agent: any = {
    id,
    status,
    session: { id, header: { cwd: root } },
    ctx: hostCtx,
    // 只是 seed：真实 route 由所观察的 loop 请求决定（测试用不同值证明不误用）。
    options: { provider: "executor-provider", model: "executor-model" },
    inbox: { nextTurn: [] as any[], nextStep: [] as any[] },
    cancelCalls: [] as any[],
    maintenanceCalls: 0,
    busy: false,
    runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => {
      // 公开契约：被轮次或另一维护占用时**同步** throw；真 idle 才进入维护。
      if (agent.busy || agent.status !== "idle") throw new Error("agent is not idle");
      agent.maintenanceCalls += 1;
      const ctrl = new AbortController();
      agent.currentMaintenanceSignal = ctrl.signal;
      try {
        return await task(ctrl.signal);
      } finally {
        agent.currentMaintenanceSignal = null;
      }
    },
    cancel: (...args: any[]) => { agent.cancelCalls.push(args); },
  };
  return agent;
}

async function loadRuntimeFactory() {
  const mod: any = await import("../../dist/index.js");
  return mod.createKeepAliveRuntime as (opts: any) => any;
}

/** 真实宿主栈 + 假时钟 + 假 adapter 的 runtime 夹具。 */
async function makeRuntimeFixture(opts: {
  projectKeepAlive?: string;
  settingsYaml?: string;
  globalState?: { enabled: boolean | null; malformed?: boolean; available?: boolean; raw?: string };
  children?: boolean;
} = {}) {
  const { Context, llm: llmMod, AgentRegistry } = await loadHostStack();
  const root = makeBoard("");
  const hostCtx = new Context();
  const llm = new llmMod.LlmRuntime(hostCtx);
  const adapter = makeFakeAdapter(llmMod.LlmAdapter);
  llm.registerAdapter(["observed"], adapter);
  const reg = new AgentRegistry(hostCtx);
  const clock = fakeClock();
  const createKeepAliveRuntime = await loadRuntimeFactory();
  const runtime = createKeepAliveRuntime({
    ctx: {
      on: (name: string, handler: any) => hostCtx.on(name, handler),
      get: (name: string) => (name === "llm" ? llm : name === "agents" ? reg : undefined),
    },
    readGlobal: () => opts.globalState ?? { enabled: null, malformed: false, available: true, raw: "" },
    resolveRoot: () => root,
    defaultWorkspace: () => root,
    now: clock.now,
    setIntervalFn: () => null,
    clearIntervalFn: () => {},
    setTimeoutFn: () => null,
    clearTimeoutFn: () => {},
    log: () => {},
  });
  const supId = "sup-1";
  const sup = makeAgent(hostCtx, supId, root, "idle");
  // supervisor 段唯一：keep_alive 原值（可为畸形手写值）+ 主管会话 id
  writeFileSync(
    join(root, "project.yaml"),
    `supervisor:\n${opts.projectKeepAlive === undefined ? "" : `  keep_alive: ${opts.projectKeepAlive}\n`}  session: ${supId}\n`,
  );
  const detachers: Array<() => void> = [];
  let supDetach: any = null;
  const registerSup = async (agent: any = sup) => {
    const detach = await reg.register(agent);
    supDetach = detach;
    detachers.push(() => { try { detach?.(); } catch { /* ignore */ } });
  };
  const detachSupervisor = async () => {
    const d = supDetach;
    supDetach = null;
    if (typeof d === "function") { try { await d(); } catch { /* ignore */ } }
  };
  if (opts.children !== false) {
    const child = makeAgent(hostCtx, "child-1", root, "running");
    const detachChild = reg.enter(child, sup);
    detachers.push(() => { try { detachChild(); } catch { /* ignore */ } });
  }
  runtime.start();
  const observeLoop = async (route: any = { provider: "observed", model: "observed-model", maxTokens: 4096 }, messages: any[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }], agent: any = sup) => {
    await hostCtx.waterfall(hostCtx, "agent/request", { agent, turn: 1, step: 1, signal: new AbortController().signal }, async () => route);
    const options = llmMod.markAgentLoopRequest({
      provider: route.provider,
      model: route.model,
      messages,
      tools: [{ name: "t1", description: "tool", parameters: {} }],
      sessionId: agent.session.id,
      maxTokens: route.maxTokens,
    });
    for await (const _chunk of llm.stream(options)) { /* 完整消费 */ }
    return options;
  };
  const dispose = () => {
    try { runtime.dispose(); } catch { /* ignore */ }
    for (const d of detachers.splice(0)) d();
  };
  return { root, hostCtx, llm, llmMod, adapter, reg, clock, runtime, sup, supId, registerSup, detachSupervisor, observeLoop, dispose };
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

test("g505 生命周期：start 幂等、dispose 清 timer/监听/在途，重复 dispose 与 dispose 后 sweep 均安全", async () => {
  const { Context, llm: llmMod, AgentRegistry } = await loadHostStack();
  const root = makeBoard("supervisor:\n  session: sup-life\n");
  const hostCtx = new Context();
  const llm = new llmMod.LlmRuntime(hostCtx);
  const adapter = makeFakeAdapter(llmMod.LlmAdapter);
  llm.registerAdapter(["observed"], adapter);
  const reg = new AgentRegistry(hostCtx);
  const clock = fakeClock();
  const createKeepAliveRuntime = await loadRuntimeFactory();
  let timers = 0;
  let cleared = 0;
  const runtime = createKeepAliveRuntime({
    ctx: { on: (n: string, h: any) => hostCtx.on(n, h), get: (n: string) => (n === "llm" ? llm : n === "agents" ? reg : undefined) },
    readGlobal: () => ({ enabled: null, malformed: false, available: true, raw: "" }),
    resolveRoot: () => root,
    defaultWorkspace: () => root,
    now: clock.now,
    setIntervalFn: () => { timers += 1; return 123; },
    clearIntervalFn: () => { cleared += 1; },
    setTimeoutFn: () => null,
    clearTimeoutFn: () => {},
    log: () => {},
  });
  runtime.start();
  runtime.start();
  assert.equal(timers, 1, "start 必须幂等（不得重复注册定时器/监听）");
  assert.equal(runtime.state.disposed, false);
  const statusAfterDisposeEvents: any[] = [];
  runtime.dispose();
  runtime.dispose();
  assert.equal(cleared, 1, "dispose 必须清理定时器且幂等");
  assert.equal(runtime.state.disposed, true);
  assert.equal(runtime.state.snapshotStatus, "disposed");
  // dispose 后事件监听已解绑：即使宿主再发事件也只有 0 条监听命中（状态不再变化）
  hostCtx.emit("agent/status", { agent: { session: { id: "sup-life" } }, status: "running" });
  assert.equal(runtime.state.lastActivityAt, null);
  // dispose 后 sweep 安全 no-op（不抛错、不发请求）
  await runtime.sweep();
  assert.equal(adapter.calls.length, 0);
  assert.deepEqual(statusAfterDisposeEvents, []);
  rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────── 4. 真实宿主接线（离线） ───────────────────────────────

test("g505 宿主：首次自举 + loop 快照捕获 + 真实 prepareCall/stream 手工保活（route 取自所观察请求）", async () => {
  const f = await makeRuntimeFixture({ children: true });
  try {
    // 冷启动：runtime 已 start 但主管尚未 live ⇒ 不自举失败、无 ping
    assert.equal(f.adapter.calls.length, 0);
    assert.equal(f.runtime.statusFor(f.root).active.snapshot, "no_supervisor");

    // 主管上线（真实 AgentRegistry 发布；agent/created 事件由真实注册表发出）
    await f.registerSup();
    assert.equal(f.runtime.state.supervisorId, f.supId, "晚到的主管必须被自举发现（不要求启动时已有 id）");

    // 观察一次正常 loop 请求：agent/request 给 config，llm/stream 给完整公共 options
    const observed = await f.observeLoop();
    assert.equal(f.runtime.snapshotProblem(f.sup), null);
    assert.equal(f.runtime.statusFor(f.root).active.snapshot, "ready");
    assert.equal(f.runtime.state.snapshot.messages, observed.messages, "快照必须引用同一份公共 messages（A 方案）");

    // 到阶段一阈值：真实 runMaintenance 抢占 + 真实 prepareCall/stream 单次调用
    f.clock.advance(STAGE1);
    await f.runtime.sweep();
    assert.equal(f.adapter.calls.length, 2, "loop 请求 1 次 + 保活 1 次");
    const ping = f.adapter.calls[1];
    assert.equal(ping.maxTokens, 1, "保活请求 maxTokens 必须为 1");
    assert.equal(ping.provider, "observed", "route 必须取自所观察请求，而不是 executor/seed");
    assert.equal(ping.model, "observed-model");
    assert.equal(ping.purpose, undefined, "绝不伪造 purpose（公开只见 compaction/session-title）");
    assert.equal(ping.sessionId, f.supId, "保留观察到的 sessionId（允许宿主正常 checkpoint；不新增对话消息）");
    assert.equal(ping.messages, observed.messages, "必须复用同一份已观察前缀 messages");
    assert.equal(ping.tools, observed.tools);
    assert.equal(f.sup.cancelCalls.length, 0, "保活绝不调用 agent.cancel（那会清 inbox）");
    assert.equal(f.runtime.state.lastOutcome, "success");
    assert.ok(f.runtime.state.lastLlmAt >= f.clock.now(), "成功 finish 才推进 lastLlmAt");
    assert.equal(f.runtime.statusFor(f.root).active.pings_in_window, 1);
    assert.equal(f.runtime.state.snapshot.agent, f.sup, "快照绑定精确 live Agent 对象");
  } finally {
    f.dispose();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("g505 宿主：失败 finish / maintenance 忙 / 人类输入 abort 均不冒充成功且不清 inbox", async () => {
  const f = await makeRuntimeFixture({ children: true });
  try {
    await f.registerSup();
    await f.observeLoop();

    // ① adapter 失败 finish ⇒ 不推进 lastLlmAt（失败不算续期成功），仍在有界次数内
    f.adapter.behaviors.push("error");
    f.clock.advance(STAGE1);
    const beforeLastLlm = f.runtime.state.lastLlmAt;
    await f.runtime.sweep();
    assert.equal(f.runtime.state.lastOutcome, "adapter_error");
    assert.equal(f.runtime.state.lastLlmAt, beforeLastLlm, "失败 finish 绝不能推进 lastLlmAt");
    assert.equal(f.runtime.state.pingsInWindow, 1, "尝试计入有界次数（成本上限）");

    // ② runMaintenance 同步拒绝（主管已被轮次占用）⇒ maintenance_busy，无请求、无计数
    f.sup.busy = true;
    const callsBeforeBusy = f.adapter.calls.length;
    f.clock.advance(STAGE1);
    await f.runtime.sweep();
    assert.equal(f.runtime.state.lastOutcome, "maintenance_busy");
    assert.equal(f.adapter.calls.length, callsBeforeBusy, "维护被占时不得发请求");
    f.sup.busy = false;

    // ③ 人类输入到达 ⇒ 只 abort 本插件控制器；不 agent.cancel、不清 inbox
    f.adapter.behaviors.push("abort-on-signal");
    const sweepPromise = f.runtime.sweep();
    const deadline = Date.now() + 2_000;
    while (f.adapter.calls.length < callsBeforeBusy + 1 && Date.now() < deadline) {
      await new Promise((r) => setImmediate(r));
    }
    const humanMessage = { source: { kind: "user" } };
    f.hostCtx.emit("agent/inbox/inserted", { agent: f.sup, message: humanMessage });
    await sweepPromise;
    assert.equal(f.runtime.state.lastOutcome, "aborted_input");
    assert.equal(f.sup.cancelCalls.length, 0, "绝不能 agent.cancel（会清 inbox）");
    assert.equal(f.sup.inbox.nextTurn.length + f.sup.inbox.nextStep.length, 0, "不清 inbox：夹具 inbox 保持原样");
    assert.ok(f.runtime.state.lastHumanAt !== null, "人类交互时刻被记录（阶段二窗口基准）");
  } finally {
    f.dispose();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("g505 宿主：阶段二单次 Grace 后短 TTL 无交互 ⇒ AFK 终止；新交互可复位", async () => {
  const f = await makeRuntimeFixture({ children: false });
  try {
    await f.registerSup();
    await f.observeLoop();
    // 全部子代理已结束 + 闲置满 Grace ⇒ 单次 Grace ping
    f.clock.advance(GRACE);
    await f.runtime.sweep();
    assert.equal(f.runtime.state.lastOutcome, "success");
    assert.equal(f.runtime.statusFor(f.root).active.phase, "stage2");
    assert.equal(f.runtime.statusFor(f.root).active.stage2_used, true);
    const callsAfterGrace = f.adapter.calls.length;

    // 短 TTL 届满且无交互 ⇒ AFK，不再产生任何请求
    f.clock.advance(KEEP_ALIVE_SHORT_TTL_MS);
    await f.runtime.sweep();
    assert.equal(f.runtime.statusFor(f.root).active.phase, "afk");
    assert.equal(f.runtime.statusFor(f.root).active.reason, "stage2_afk");
    f.clock.advance(GRACE);
    await f.runtime.sweep();
    assert.equal(f.runtime.statusFor(f.root).active.phase, "afk");
    assert.equal(f.adapter.calls.length, callsAfterGrace, "AFK 之后绝不发保活请求");

    // 新的人类交互/新一轮 loop 请求 ⇒ 复位（阶段二机会复原、AFK 解除）
    f.hostCtx.emit("agent/inbox/inserted", { agent: f.sup, message: { source: { kind: "user" } } });
    assert.equal(f.runtime.state.afk, false);
    assert.equal(f.runtime.state.stage2Used, false);
    await f.observeLoop();
    f.clock.advance(GRACE);
    const callsAfterNewLoop = f.adapter.calls.length;
    await f.runtime.sweep();
    assert.equal(f.adapter.calls.length, callsAfterNewLoop + 1, "复位后允许（且仅允许一次）新的 Grace ping");
  } finally {
    f.dispose();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("g505 宿主：快照已知失效（新请求未观察/主管替换/route 变化）时明确不可用且不发请求", async () => {
  const f = await makeRuntimeFixture({ children: true });
  try {
    await f.registerSup();
    const observed = await f.observeLoop();
    assert.equal(f.runtime.snapshotProblem(f.sup), null);

    // ① 新请求的 config 已到但完整 options 尚未观察 ⇒ pending_observation，旧快照立即失效
    await f.hostCtx.waterfall(f.hostCtx, "agent/request", { agent: f.sup, turn: 2, step: 1, signal: new AbortController().signal }, async () => ({ provider: "observed", model: "observed-model", maxTokens: 4096 }));
    assert.equal(f.runtime.snapshotProblem(f.sup), "pending_observation");
    f.clock.advance(STAGE1);
    const callsBefore = f.adapter.calls.length;
    await f.runtime.sweep();
    assert.equal(f.adapter.calls.length, callsBefore, "无可确认快照时绝不发请求");
    assert.equal(f.runtime.statusFor(f.root).active.snapshot, "pending_observation");

    // ② 观察完成后恢复可用
    const options = f.llmMod.markAgentLoopRequest({
      provider: "observed", model: "observed-model", messages: observed.messages,
      tools: observed.tools, sessionId: f.supId, maxTokens: 4096,
    });
    for await (const _c of f.llm.stream(options)) { /* consume */ }
    assert.equal(f.runtime.snapshotProblem(f.sup), null);

    // ③ 主管 Agent 对象被替换（clear/compact/resume 的公共信号）⇒ 旧快照失效
    const replacement = makeAgent(f.hostCtx, f.supId, f.root, "idle");
    // 真实注册表不允许同 id 重复注册：先真实卸载旧 entry（注册表会发出 agent/disposed）
    await f.detachSupervisor();
    await f.registerSup(replacement);
    // 替换路径可能是「先 disposed 再 created」⇒ 具体原因可为 agent_replaced 或 no_snapshot，
    // 但都必须是**明确不可用**（绝不是 ready）。
    assert.notEqual(f.runtime.snapshotProblem(replacement), null);
    assert.notEqual(f.runtime.statusFor(f.root).active.snapshot, "ready");
    f.clock.advance(STAGE1);
    const callsBeforeReplace = f.adapter.calls.length;
    await f.runtime.sweep();
    assert.equal(f.adapter.calls.length, callsBeforeReplace, "Agent 替换后不得用旧前缀发请求");
    // 替换后的新观察才恢复
    await f.observeLoop({ provider: "observed", model: "observed-model", maxTokens: 4096 }, undefined, replacement);
    assert.equal(f.runtime.snapshotProblem(replacement), null);
  } finally {
    f.dispose();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("g505 宿主：坏配置/全局关闭/显式长 TTL 的调度门禁（坏值不默认启用）", async () => {
  // 项目畸形：effective 关闭 + 状态如实标 malformed，不发请求
  const bad = await makeRuntimeFixture({ children: true, projectKeepAlive: "yes" });
  try {
    await bad.registerSup();
    await bad.observeLoop();
    bad.clock.advance(STAGE1);
    await bad.runtime.sweep();
    assert.equal(bad.adapter.calls.length, 1, "仅 loop 请求；畸形配置不得保活");
    const status = bad.runtime.statusFor(bad.root);
    assert.equal(status.effective.effective, false);
    assert.equal(status.effective.source, "project_invalid");
    assert.equal(status.configured.project_malformed, true);
  } finally {
    bad.dispose();
    rmSync(bad.root, { recursive: true, force: true });
  }

  // 全局显式关闭 ⇒ 项目 inherit 时关闭
  const off = await makeRuntimeFixture({ children: true, globalState: { enabled: false, malformed: false, available: true, raw: "off" } });
  try {
    await off.registerSup();
    await off.observeLoop();
    off.clock.advance(STAGE1);
    await off.runtime.sweep();
    assert.equal(off.adapter.calls.length, 1);
    assert.equal(off.runtime.statusFor(off.root).effective.source, "global_explicit");
  } finally {
    off.dispose();
    rmSync(off.root, { recursive: true, force: true });
  }

  // 项目显式 true 覆盖全局关闭
  const forced = await makeRuntimeFixture({
    children: true,
    projectKeepAlive: "true",
    globalState: { enabled: false, malformed: false, available: true, raw: "off" },
  });
  try {
    await forced.registerSup();
    await forced.observeLoop();
    forced.clock.advance(STAGE1);
    await forced.runtime.sweep();
    assert.equal(forced.adapter.calls.length, 2, "项目显式 true 必须覆盖全局关闭");
    assert.equal(forced.runtime.statusFor(forced.root).effective.source, "project_explicit");
  } finally {
    forced.dispose();
    rmSync(forced.root, { recursive: true, force: true });
  }
});

test("g505 宿主：未知 TTL 如实投影（短 TTL 有界假设），不声明净收益/严格 timeout 上界", async () => {
  const f = await makeRuntimeFixture({ children: true });
  try {
    await f.registerSup();
    await f.observeLoop();
    const status = f.runtime.statusFor(f.root);
    assert.equal(status.capable.ttl, "unknown");
    assert.equal(status.capable.short_ttl_bound_ms, KEEP_ALIVE_SHORT_TTL_MS);
    assert.equal(status.capable.host_channel, true);
    assert.equal(status.active.snapshot, "ready");
    assert.equal(status.active.inflight, false);
    // 投影只含元数据，不含会话正文/提示词
    const json = JSON.stringify(status);
    assert.ok(!json.includes("hello"), "投影不得携带对话正文");
    assert.ok(!json.includes("description"), "投影不得携带工具正文");
  } finally {
    f.dispose();
    rmSync(f.root, { recursive: true, force: true });
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
function makeApplyHarness(root: string, extraGet: (name: string) => any = () => undefined) {
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
