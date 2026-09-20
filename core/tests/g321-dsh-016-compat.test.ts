/** g-321：DSH v0.1.5-rc.2 → v0.1.6-alpha.2 API 变更的适配回归测试。
 *
 * 覆盖四类修复：
 *  1. 核心层 subagentSpawnErrorText：ACTIVATION_LIMIT_REACHED / subagent/delivery-unavailable 友好化，
 *     其余错误逐字透传（既有可追溯性不可丢失）；并且 startContinuable 抛新码时端到端上报可见文案。
 *  2. 客户端会话导航：uiWorkspace.openSession 优先，sessions.open / openSubagent 回退（双向兼容）。
 *  3. 会话激活判断：兼容 snap.current / snap.currentAddress（0.1.5）与 retainedBy.mainView（0.1.6）。
 *  4. 消息排队状态：绝不直接解构 snapshot.queue；0.1.6 走 projections.faceOf('inbox')，0.1.5 回退快照。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { init, createGoal, subagentSpawnErrorText } from "../ops.ts";
import { apply } from "../../dist/index.js";

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");
const clientRoot = join(hostRoot, "lib/client");
const distRoot = join(import.meta.dirname, "../../dist");
const readClient = (name: string) => readFileSync(join(clientRoot, `${name}.js`), "utf8");

/** 从拼接前的源模块里精确抠出一个具名 function 声明（花括号配平），供 vm 行为测试使用。 */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源模块中存在 function ${name}`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} 花括号无法配平`);
}

/** 找出**非注释上下文**里的正则匹配：源码注释里出现 `session.getSnapshot().queue` 是解释性文字，
 *  不能与真正的代码读取混为一谈——否则「禁止直读 queue」的断言会被自己的注释误伤。 */
function codeMatches(source: string, re: RegExp): string[] {
  const out: string[] = [];
  for (const line of source.split("\n")) {
    const commentAt = line.indexOf("//");
    const code = commentAt >= 0 ? line.slice(0, commentAt) : line;
    for (const m of code.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))) {
      out.push(m[0]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 1. 核心层错误映射

test("g-321 subagentSpawnErrorText：ACTIVATION_LIMIT_REACHED（含 code / details.reason / message 三种载体）给出可操作提示", () => {
  const cases: unknown[] = [
    Object.assign(new Error("subagent limit reached (active child limit: 8)"), { code: "ACTIVATION_LIMIT_REACHED" }),
    { message: "cold resume rejected", details: { reason: "ACTIVATION_LIMIT_REACHED" } },
    new Error("rejected with ACTIVATION_LIMIT_REACHED"),
  ];
  for (const e of cases) {
    const text = subagentSpawnErrorText(e);
    assert.match(text, /子代理激活已达上限/);
    assert.match(text, /8/, "提示应给出默认上限 8");
    assert.match(text, /解绑|等待/, "提示应给出可操作动作");
  }
});

test("g-321 subagentSpawnErrorText：subagent/delivery-unavailable 给出可操作提示", () => {
  const text = subagentSpawnErrorText({ code: "subagent/delivery-unavailable", message: "follow-up unavailable" });
  assert.match(text, /暂时无法送达/);
  assert.match(text, /重新派发|等待/);
});

test("g-321 subagentSpawnErrorText：未知错误逐字透传 message（不吞掉既有可追溯性）", () => {
  assert.equal(subagentSpawnErrorText(new Error("LLM quota exceeded")), "LLM quota exceeded");
  assert.equal(
    subagentSpawnErrorText(new Error("无可用 subagent provider（需 prepareContinuable 能力，已注册：无）")),
    "无可用 subagent provider（需 prepareContinuable 能力，已注册：无）",
  );
  // 非 Error 的原始值也要能降级成字符串，不得抛
  assert.equal(subagentSpawnErrorText("gateway/cancelled"), "gateway/cancelled");
});

test("g-321 host 端 start-collection：startContinuable 抛 ACTIVATION_LIMIT_REACHED 时 child_error 为友好文案且卡片不误翻 collecting", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g321-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "g321 目标", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-g321\n", "utf8");

  const subagentsService = {
    list: () => ["spawn"],
    getProvider: () => ({ prepareContinuable: () => {} }),
    startContinuable: async () => {
      throw Object.assign(new Error("subagent limit reached (active child limit: 8)"), {
        code: "ACTIVATION_LIMIT_REACHED",
      });
    },
  };
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "subagents") return subagentsService;
      if (name === "agents") return { get: () => ({ id: "sess-g321" }) };
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  const post = async (path: string, body: unknown) => {
    const handler = routes.get(path);
    assert.ok(handler, `路由 ${path} 已注册`);
    const req: any = { method: "POST", _listeners: {} as Record<string, (v?: any) => void>, on(ev: string, cb: any) { req._listeners[ev] = cb; } };
    const res: any = { _code: 0, _body: null };
    res.writeHead = (code: number) => { res._code = code; };
    res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
    const p = handler(req, res);
    req._listeners.data?.(JSON.stringify(body));
    req._listeners.end?.();
    await p;
    return res;
  };

  const add = await post("/api/dsh-graph/add-card", { goal: goalId, title: "收集卡", kind: "text", workspace: ws, scope: "goal" });
  assert.equal(add._code, 200);
  const card = add._body.card;

  const r = await post("/api/dsh-graph/start-collection", { goal: goalId, card, workspace: ws });
  assert.equal(r._code, 200);
  assert.equal(r._body.child_id, null);
  assert.ok(typeof r._body.child_error === "string" && r._body.child_error.length > 0);
  // 友好化：中文可操作提示，而不是裸英文 code
  assert.match(r._body.child_error, /子代理激活已达上限/);
  assert.match(r._body.child_error, /解绑|等待/);
  // 失败不得把卡片误翻 collecting
  const cardFile = join(root, "versions", "v-t", "goals", goalId, "cards", `${card}.md`);
  assert.notEqual(readFileSync(cardFile, "utf8").includes("status: collecting"), true);
});

// ---------------------------------------------------------------- 2. 会话导航 / 激活判断（源契约）

test("g-321 客户端导航：uiWorkspace.openSession 优先，回退 sessions.openSubagent / sessions.open", () => {
  const plugin = readClient("plugin");
  // 特性探测取得 uiWorkspace（绝不做硬 inject，否则旧 profile 的 client apply 会被阻断）
  assert.match(plugin, /function uiWorkspaceRt\(\)/);
  assert.match(plugin, /appCtx\?\.get\?\.\("uiWorkspace"\)/);
  assert.match(plugin, /function openSessionTarget\(target, legacyFn\)/);
  assert.match(plugin, /typeof uw\.openSession === "function"/);
  // 子会话：address 形态在两版共用，0.1.5 回退 openSubagent
  assert.match(plugin, /uiWorkspace\.openSession\(address\)|openSessionTarget\(address,/);
  assert.match(plugin, /typeof rt\.openSubagent === "function" \? \(\) => rt\.openSubagent\(address\) : null/);
  // 父会话退化路径同样走兼容层
  assert.match(plugin, /openSessionTarget\(parentSessionId, typeof rt\?\.open === "function"/);
  // 其它跳转点（主管会话）也不得再直连 sessions.open
  for (const mod of ["goal-actions", "drag-prompts", "supervisor-bar"]) {
    const src = readClient(mod);
    assert.doesNotMatch(src, /(?<!openSessionTarget\()\brt\?\.open\?\.\(/, `${mod} 不得残留 sessions.open 直连`);
    assert.doesNotMatch(src, /sessionsRt\?\.open\?\.\(/, `${mod} 不得残留 sessions.open 直连`);
  }
});

test("g-321 会话激活判断：兼容 0.1.5 的 current/currentAddress 与 0.1.6 的 retainedBy.mainView", () => {
  const plugin = readClient("plugin");
  assert.match(plugin, /snap\.current/);
  assert.match(plugin, /snap\.currentAddress\?\.childSessionId/);
  // 0.1.6：SessionListState 移除了 current/currentAddress，当前激活会话 = retainedBy.mainView > 0 那一行
  assert.match(plugin, /s\.retainedBy\?\.mainView \?\? 0/);
  // 兼容 byId 记录与旧 items 数组两种快照形状
  assert.match(plugin, /Array\.isArray\(snap\.items\)/);
  assert.match(plugin, /Object\.values\(snap\.byId\)/);
});

// ---------------------------------------------------------------- 2b. 导航兼容层行为矩阵

function makeNavigationSandbox() {
  const plugin = readClient("plugin");
  const sandbox: any = { console, appCtx: null };
  vm.runInNewContext(
    `${extractFunction(plugin, "uiWorkspaceRt")}\n`
    + `${extractFunction(plugin, "openSessionTarget")}\n`
    + `this.openSessionTarget = openSessionTarget;`,
    sandbox,
  );
  return sandbox as { appCtx: any; openSessionTarget: (t: any, legacyFn: any) => boolean };
}

test("g-321 openSessionTarget：0.1.6 有 uiWorkspace.openSession 时优先调用，绝不重复走 legacy", () => {
  const box = makeNavigationSandbox();
  const calls: any[] = [];
  box.appCtx = { get: (n: string) => (n === "uiWorkspace" ? { openSession: (t: any) => calls.push(["uw", t]) } : undefined) };
  const ok = box.openSessionTarget("child-1", () => { calls.push(["legacy"]); });
  assert.equal(ok, true);
  assert.deepEqual(calls, [["uw", "child-1"]]);
});

test("g-321 openSessionTarget：0.1.5 无 uiWorkspace 时回退 legacy（sessions.open/openSubagent）", () => {
  const box = makeNavigationSandbox();
  const calls: any[] = [];
  box.appCtx = { get: () => undefined };
  const ok = box.openSessionTarget({ parentSessionId: "p", childSessionId: "c", mode: "continuable" }, () => { calls.push(["legacy"]); });
  assert.equal(ok, true);
  assert.deepEqual(calls, [["legacy"]]);
});

test("g-321 openSessionTarget：新版 openSession 抛错时降级到 legacy，不把异常抛给调用方", () => {
  const box = makeNavigationSandbox();
  const calls: any[] = [];
  box.appCtx = { get: (n: string) => (n === "uiWorkspace" ? { openSession: () => { throw new Error("navigation superseded"); } } : undefined) };
  const ok = box.openSessionTarget("s-1", () => { calls.push(["legacy"]); });
  assert.equal(ok, true);
  assert.deepEqual(calls, [["legacy"]], "新版失败必须回退旧版，保证 0.1.6 下仍能跳转");
});

test("g-321 openSessionTarget：两版 API 都缺失时返回 false 且不抛（降级为不动，不崩看板）", () => {
  const box = makeNavigationSandbox();
  box.appCtx = { get: () => undefined };
  assert.equal(box.openSessionTarget("s-1", null), false);
  // appCtx 尚未注入（apply 之前）也不得抛
  box.appCtx = null;
  assert.equal(box.openSessionTarget("s-1", () => false), false);
});

// ---------------------------------------------------------------- 3. 排队状态：行为测试（两条版本路径）
function makeQueueSandbox() {
  const helpers = readClient("helpers");
  const sandbox: any = { dgT: (key: string) => key, console };
  vm.runInNewContext(
    `${extractFunction(helpers, "sessionQueueState")}\nthis.sessionQueueState = sessionQueueState;`,
    sandbox,
  );
  return sandbox.sessionQueueState as (s: any) => { pendingCount: number; queued: number; steering: number; source: string | null };
}

test("g-321 sessionQueueState：0.1.6 走 inbox 投影（next-turn + next-step）", () => {
  const sessionQueueState = makeQueueSandbox();
  const session = {
    projections: {
      faceOf: (key: string) => (key === "inbox"
        ? { getSnapshot: () => ({ "next-turn": [{ id: 1 }, { id: 2 }], "next-step": [{ id: 3 }] }) }
        : null),
    },
    getSnapshot: () => ({}),
  };
  // vm 跨 realm 的对象原型不同，逐个字段比对（deepEqual 会因原型不等而失败）
  assert.deepEqual({ ...sessionQueueState(session) }, { pendingCount: 3, queued: 2, steering: 1, source: "inbox" });
});

test("g-321 sessionQueueState：0.1.6 快照无 queue 也不得抛（旧的直接解构会 TypeError）", () => {
  const sessionQueueState = makeQueueSandbox();
  // 真实的 0.1.6 SessionSnapshot：没有 queue 字段，只有 pendingSubmissions 等
  const session = {
    projections: { faceOf: () => undefined },
    getSnapshot: () => ({ sessionId: "s", running: false, pendingSubmissions: [], blank: false }),
  };
  assert.deepEqual({ ...sessionQueueState(session) }, { pendingCount: 0, queued: 0, steering: 0, source: null });
});

test("g-321 sessionQueueState：投影缺失/抛错时回退 0.1.5 快照 queue（数组与 items 容器两种形状）", () => {
  const sessionQueueState = makeQueueSandbox();
  const noProjections = (queue: unknown) => ({ getSnapshot: () => ({ queue }) });
  assert.equal(sessionQueueState(noProjections([{ id: 1 }])).pendingCount, 1);
  assert.equal(sessionQueueState(noProjections([{ id: 1 }])).source, "snapshot");
  assert.equal(sessionQueueState(noProjections({ items: [{ id: 1 }, { id: 2 }] })).pendingCount, 2);
  // 投影 faceOf 抛错（未激活/未 seed）→ 不得冒泡
  const throwing = {
    projections: { faceOf: () => { throw new Error("face unavailable"); } },
    getSnapshot: () => ({ queue: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
  };
  assert.equal(sessionQueueState(throwing).pendingCount, 3);
  // 空 session / null 安全
  assert.equal(sessionQueueState(null).pendingCount, 0);
});

test("g-321 客户端源契约：排队状态只经 sessionQueueState，绝不直接解构 snapshot.queue", () => {
  for (const mod of ["helpers", "live-panel", "goal-actions", "session-hooks"]) {
    const src = readClient(mod);
    assert.deepEqual(codeMatches(src, /getSnapshot\(\)\.queue/), [], `${mod} 不得直接读 snapshot.queue`);
    assert.deepEqual(codeMatches(src, /const\s*\{[^}]*\bqueue\b[^}]*\}\s*=\s*[^;]*getSnapshot/), [], `${mod} 不得解构 snapshot.queue`);
  }
  const live = readClient("live-panel");
  assert.match(live, /useSessionQueueDepth\(session\)/);
  assert.match(live, /sessionQueueState\(session\)\.pendingCount/);
  const actions = readClient("goal-actions");
  assert.match(actions, /sessionQueueState\(session\)\.pendingCount/);
  assert.match(actions, /subagentDispatchErrorText\(res\?\.error\)/);
  const hooks = readClient("session-hooks");
  assert.match(hooks, /function useSessionQueueDepth\(session\)/);
  assert.match(hooks, /projections\?\.faceOf\?\.\("inbox"\)/);
  // getSnapshot 必须返回按值稳定的原语，否则 useSyncExternalStore 无限重渲染
  assert.match(hooks, /sessionQueueState\(session\)\.pendingCount, \[session\]/);
  // 组件构建顺序：helpers（定义）必须先于 session-hooks / live-panel / goal-actions
  const script = readFileSync(join(import.meta.dirname, "../../scripts/build-client.sh"), "utf8");
  const order = ["helpers", "session-hooks", "live-panel", "goal-actions", "plugin"].map((p) => script.indexOf(`"${p}"`));
  assert.ok(order.every((i) => i > 0), "build-client PARTS 含全部相关模块");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "PARTS 顺序保证 helpers 在消费方之前");
});

// ---------------------------------------------------------------- 5. bundle 装载 + apply 冒烟（双版本 API 面）

/** 在 vm 里真实装载 dist/lib/client.js，取出工厂并 apply —— 捕获 bundle 级引用/TDZ 错误，
 *  这是 `node --check` 与源契约断言都覆盖不到的一层。 */
function loadAndApplyClient(surface: { uiWorkspace?: unknown; sessions: unknown }) {
  const bundle = readFileSync(join(distRoot, "lib/client.js"), "utf8");
  let factory: any = null;
  const noop = () => {};
  const sandbox: any = {
    console,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
    requestAnimationFrame: (cb: any) => { cb?.(); return 1; },
    cancelAnimationFrame: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
    navigator: {},
    fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }),
    document: {
      createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, addEventListener: noop, remove: noop, click: noop }),
      querySelectorAll: () => [],
      getElementById: () => null,
      addEventListener: noop,
      removeEventListener: noop,
      body: { appendChild: noop, removeChild: noop },
    },
    CustomEvent: class { constructor(type: string) { this.type = type; } },
    Event: class { constructor(type: string) { this.type = type; } },
  };
  sandbox.window = {
    __ModuleLoader__: { load: (def: any) => { factory = def.factory; } },
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  vm.runInNewContext(bundle, sandbox, { filename: "dist/lib/client.js" });
  assert.ok(factory, "bundle 通过 window.__ModuleLoader__.load 注册工厂");

  const ReactStub = {
    createElement: (...args: any[]) => ({ args }),
    useState: (init: any) => [typeof init === "function" ? init() : init, noop],
    useEffect: noop, useLayoutEffect: noop, useRef: (v: any) => ({ current: v }),
    useCallback: (f: any) => f, useMemo: (f: any) => f(), useReducer: (r: any, i: any) => [i, noop],
    useSyncExternalStore: (_s: any, get: any) => (typeof get === "function" ? get() : undefined),
    useTransition: () => [false, noop], Fragment: "Fragment", memo: (c: any) => c,
    // 客户端有 MarkdownErrorBoundary extends React.Component（错误边界）
    Component: class { props: any; state: any; constructor(props: any) { this.props = props; this.state = {}; } setState(_s: any) {} },
  };
  const requireStub = (name: string) => {
    if (name === "react") return ReactStub;
    if (name === "react-dom") return { render: noop, createRoot: () => ({ render: noop, unmount: noop }) };
    throw new Error(`module not found: ${name}`);
  };

  const mod = factory(requireStub);
  assert.ok(mod && typeof mod.apply === "function", "工厂返回带 apply 的插件对象");
  // vm 跨 realm 的数组原型不同，转成宿主数组再比对
  assert.deepEqual(Array.from(mod.inject), ["slots", "sessions"], "uiWorkspace 绝不能被列为硬 inject");

  const registered: any[] = [];
  const ctx: any = {
    sessions: surface.sessions,
    get: (name: string) => {
      if (name === "uiWorkspace") return surface.uiWorkspace;
      if (name === "sessions") return surface.sessions;
      if (name === "connection" || name === "workspaces" || name === "locale") return null;
      return undefined;
    },
    // 真实 runner 在槽目标就绪时会调用 inject 的回调；这里同步触发，以便覆盖 register 路径
    slots: { inject: (_name: string, cb: any) => { cb?.(); }, register: (def: any) => { registered.push(def); return noop; } },
    on: noop,
    effect: (fn: any) => fn(),
  };
  mod.apply(ctx);
  return { mod, registered };
}

test("g-321 bundle 冒烟：0.1.6 API 面（只有 uiWorkspace.openSession，sessions 无 open/openSubagent）下 client apply 不抛", () => {
  const uiWorkspace = { openSession: () => {} };
  const sessions = {
    list: { getSnapshot: () => ({ ids: ["s1"], byId: { s1: { id: "s1", retainedBy: { mainView: 1 } } }, subagentsByParent: {} }) },
    binding: () => undefined,
    setSubagentCatalogOpen: () => {},
    refreshSubagents: async () => {},
    retainInfo: () => ({ getSnapshot: () => ({ referenceCount: 1, retainedBy: { mainView: 1 } }) }),
  };
  // 明确断言新版面确实没有旧 API，避免测试自身失真
  assert.equal(typeof (sessions as any).open, "undefined");
  assert.equal(typeof (sessions as any).openSubagent, "undefined");
  const { mod, registered } = loadAndApplyClient({ uiWorkspace, sessions });
  assert.equal(mod.name, "dsh-graph");
  assert.ok(registered.length >= 1, "至少注册了看板 conversation.view 槽");
});

test("g-321 bundle 冒烟：0.1.5 API 面（无 uiWorkspace，sessions 有 open/openSubagent）下 client apply 不抛（向下兼容）", () => {
  const sessions = {
    list: { getSnapshot: () => ({ current: "s1", items: [{ sessionId: "s1", cwd: "/tmp" }], subagentsByParent: {} }) },
    open: () => {}, openSubagent: () => {}, binding: () => undefined,
    setSubagentCatalogOpen: () => {}, refreshSubagents: async () => {},
  };
  const { mod, registered } = loadAndApplyClient({ uiWorkspace: undefined, sessions });
  assert.equal(mod.name, "dsh-graph");
  assert.ok(registered.length >= 1);
});

test("g-321 bundle 冒烟：sessions 服务整体缺失（最小 profile）时 apply 仍不抛", () => {
  const { mod } = loadAndApplyClient({ uiWorkspace: undefined, sessions: undefined });
  assert.equal(mod.name, "dsh-graph");
});

// ---------------------------------------------------------------- 4. 生成产物与 i18n

test("g-321 bundle 落地：dist/lib/client.js 含兼容层与 inbox 探测，且无 snapshot.queue 直读", () => {
  const bundle = readFileSync(join(distRoot, "lib/client.js"), "utf8");
  assert.match(bundle, /function openSessionTarget\(target, legacyFn\)/);
  assert.match(bundle, /retainedBy\?\.mainView/);
  assert.match(bundle, /function sessionQueueState\(session\)/);
  assert.match(bundle, /"inbox"/);
  assert.deepEqual(codeMatches(bundle, /getSnapshot\(\)\.queue/), [], "bundle 不得直读 snapshot.queue");
});

test("g-321 i18n：新键 zh/en 严格对称，en 无 CJK", () => {
  const i18nSource = readFileSync(join(clientRoot, "i18n.js"), "utf8");
  const sandbox: any = { React: {} };
  vm.runInNewContext(i18nSource + "; this.zh = zh; this.en = en;", sandbox);
  const { zh, en } = sandbox;
  const added = [
    "criteria.feedbackQueuedDepth",
    "live.queueDepth",
    "live.queuedDepth",
    "live.activationLimit",
    "live.deliveryUnavailable",
  ];
  for (const key of added) {
    assert.ok(zh[key], `zh 缺失 ${key}`);
    assert.ok(en[key], `en 缺失 ${key}`);
    assert.doesNotMatch(en[key], /[\u3400-\u9fff]/, `en ${key} 不得含 CJK`);
  }
  assert.match(zh["live.queueDepth"], /\{n\}/, "排队深度文案需保留 {n} 占位");
  assert.match(en["live.queueDepth"], /\{n\}/);
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "client i18n zh/en 键必须完全对称");
});

test("g-321 host 源契约：三处 startContinuable 捕获全部改走 subagentSpawnErrorText", () => {
  const host = readFileSync(join(hostRoot, "index.js"), "utf8");
  assert.match(host, /subagentSpawnErrorText,/);
  const uses = host.match(/subagentSpawnErrorText\(e\)/g) ?? [];
  assert.equal(uses.length, 3, "spawnChild / dispatchExecutionAttempt / 收集入口三处均需友好化");
  // 不得再有裸 String(e?.message ?? e) 作为 startContinuable 失败结果
  assert.doesNotMatch(host, /child_error: String\(e\?\.message \?\? e\)/);
});
