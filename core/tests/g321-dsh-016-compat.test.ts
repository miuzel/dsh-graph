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

/**
 * g-351：子代理目录 entry 的**形状探测**族。子会话地址构造（subagentAddressOf）与
 * 谱系反查（catalogParentIndex）都依赖它们，沙箱注入目录读取函数时必须连同这族一并注入。
 */
const CATALOG_SHAPE_FUNCS = ["isCatalogChildEntry", "catalogChildEntry", "catalogParentIndex", "catalogEntryMode", "catalogAddressMode"];

/** 从拼接前的源模块里精确抠出一个具名 function 声明（花括号配平），供 vm 行为测试使用。 */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源模块中存在 function ${name}`);
  // async 函数：`function ` 紧跟在 `async ` 之后，抽取时必须带上限定符，
  // 否则 await 落在非 async 函数里 → SyntaxError（0.1.6 的地址解析是 async）。
  const asyncPrefix = source.slice(Math.max(0, start - 6), start) === "async " ? "async " : "";
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return asyncPrefix + source.slice(start, i + 1);
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

// ============================================================================
// 6. g-321 会话引用生命周期（0.1.6 先 retain 再借用 / 0.1.5 被动回退）
//
// 0.1.6-alpha.2 的客户端会话引用模型：ClientSessions.binding(id) 只借用**已存在**的保留代际
// （实测宿主源码 scopes.get(id)?.binding），不再按需 materialize scope——无任何 retain 时恒
// undefined。于是渲染期被动 binding() 拿不到会话：session=null → LiveStrip 落「⚠️ 会话未接入
// （不在会话列表）」占位（D1），useProjectionValue(null,"modelSelection") 恒 undefined →
// selection===undefined 被当成「模型目录不可用」（D2）。
// 0.1.5-rc.2 / 0.1.6-alpha.1 的 binding(id) 是 resolve(id)?.binding（resolve 会按需
// materialize），被动调用仍可用——因此只能特性探测（typeof retain === "function"），
// 禁止版本号分支。
//
// 下面用**行为**驱动真实源模块中的 useSessionBinding / useBoundSession，断言 retain/release
// 严格配平、降级不崩、地址优先与 g-224 门控；文本契约作为第二重保险。
// ============================================================================

/** 极简 React hook 运行时：真实驱动 hook 源函数（useState/useMemo/useCallback/useEffect/
 *  useSyncExternalStore），支持 mount → 订阅触发重渲染 → unmount，用于断言保留代际生命周期。 */
function makeHookHarness(render: (R: any) => any) {
  const slots: any[] = [];
  const cleanups: any[] = [];
  let cursor = 0;
  let inRender = false;
  let dirty = false;
  let latest: any;

  const sameDeps = (a: unknown[] | undefined, b: unknown[] | undefined) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  const R: any = {
    useState(init: any) {
      const i = cursor++;
      const slot = slots[i] ?? (slots[i] = {});
      if (!("value" in slot)) slot.value = typeof init === "function" ? init() : init;
      return [slot.value, (next: any) => { slot.value = typeof next === "function" ? next(slot.value) : next; renderNow(); }];
    },
    useRef(v: any) { const i = cursor++; return slots[i] ?? (slots[i] = { current: v }); },
    useMemo(f: any, deps: any) {
      const i = cursor++;
      const slot = slots[i] ?? (slots[i] = {});
      if (!("value" in slot) || !sameDeps(slot.deps, deps)) { slot.value = f(); slot.deps = deps; }
      return slot.value;
    },
    useCallback(f: any, deps: any) { return R.useMemo(() => f, deps); },
    useEffect(f: any, deps: any) { const i = cursor++; pending.effects.push({ i, f, deps }); },
    useSyncExternalStore(sub: any, get: any) {
      const i = cursor++;
      pending.subs.push({ i, sub });
      return get();
    },
  };
  const pending: { effects: any[]; subs: any[] } = { effects: [], subs: [] };

  function commit() {
    for (const e of pending.effects) {
      const slot = slots[e.i] ?? (slots[e.i] = {});
      if (sameDeps(slot.effectDeps, e.deps)) continue;
      cleanups[e.i]?.();
      // 先落 deps 再执行 effect：effect 内 setState 触发的重提交不得把同一 effect 再跑一次
      slot.effectDeps = e.deps;
      const c = e.f();
      cleanups[e.i] = typeof c === "function" ? c : undefined;
    }
    for (const s of pending.subs) {
      const slot = slots[s.i] ?? (slots[s.i] = {});
      if (slot.sub === s.sub) continue;
      slot.unsub?.();
      slot.sub = s.sub;
      slot.unsub = s.sub(() => renderNow());
    }
  }

  function renderNow() {
    if (inRender) { dirty = true; return; }
    do {
      dirty = false;
      cursor = 0;
      pending.effects.length = 0;
      pending.subs.length = 0;
      inRender = true;
      try {
        latest = render(R);
        // 提交阶段视同「渲染中」：effect 内 setState 被批处理（不递归重入），由外层循环收口
        commit();
      } finally {
        inRender = false;
      }
    } while (dirty);
  }

  return {
    render: renderNow,
    value: () => latest,
    unmount() {
      for (const c of cleanups) c?.();
      cleanups.length = 0;
      for (const s of slots) s?.unsub?.();
    },
  };
}

/** 让 await 链（地址解析 → reference.ready → notify → 重渲染）全部落定。 */
const flushAsync = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/** 把真实源模块里参与会话引用生命周期的函数抽到 vm 沙箱（连同其模块级私有状态），
 *  使行为断言跑在**真实实现**上而不是测试里复制的一份。 */
function makeSessionHooksSandbox(
  sessionsRt: unknown,
  opts: { liveDisplay?: boolean; console?: unknown } = {},
) {
  const hooks = readClient("session-hooks");
  const helpers = readClient("helpers");
  const names = [
    "bindIdentity", "ensureBindingEntry", "notifyBinding", "subagentAddressFromCatalog",
    "resolveSessionRetainTarget", "startRetainedBinding", "releaseBinding", "useSessionBinding",
    "setupBoundSession", "openBoundSessionStream", "useSessionsList", "useBoundSession",
  ];
  const code = [
    "var sessionsRt = __rt;",
    "var NOOP_UNSUB = () => () => {};",
    "var dgT = (k) => k;",
    "var boundSetup = new Map();",
    "var boundModes = new Map();",
    "var boundOpened = new Map();",
    "var retainedBindings = new Map();",
    "var LIVE_DISPLAY_KEY = 'dsh-graph.live-display';",
    ...names.map((n) => extractFunction(hooks, n)),
    // g-351：目录读取/刷新改为 helpers 里的形状与能力探测实现，沙箱需连同其定义注入
    //（断言与语义均不变，仅随实现位置补齐依赖）。
    extractFunction(helpers, "subagentCatalogEntries"),
    extractFunction(helpers, "subagentAddressOf"),
    extractFunction(helpers, "refreshSubagentCatalog"),
    ...CATALOG_SHAPE_FUNCS.map((n) => extractFunction(helpers, n)),
    extractFunction(helpers, "getLiveDisplay"),
    extractFunction(helpers, "useLiveDisplayEnabled"),
    "this.parts = { useSessionBinding, useBoundSession, retainedBindings, boundModes };",
  ].join("\n");
  const sandbox: any = {
    __rt: sessionsRt,
    React: null,
    console: opts.console ?? console,
    localStorage: { getItem: () => (opts.liveDisplay === false ? "0" : "1"), setItem: () => {}, removeItem: () => {} },
    window: { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(code, sandbox, { filename: "session-hooks-subset" });
  return sandbox as { React: any; parts: any };
}

/** 0.1.6 形态的 sessions 服务桩：目录收录 child-1，retain 返回可释放的代际。 */
function makeRetainRuntime(overrides: Record<string, unknown> = {}) {
  const calls = { retain: [] as any[], released: [] as string[], opened: [] as string[] };
  const session = { open: async () => { calls.opened.push("open"); }, projections: { faceOf: () => null } };
  const eventSource = { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} };
  const snapshot = {
    ids: ["parent-1", "child-1"],
    byId: {},
    subagentsByParent: { "parent-1": { entries: [{ kind: "child", id: "child-1", mode: "continuable" }] } },
    seq: 0,
  };
  const reference = {
    sessionId: "child-1",
    ready: Promise.resolve(),
    get binding() { return { sessionId: "child-1", session, eventSource }; },
    release: () => { calls.released.push("child-1"); },
  };
  const rt: any = {
    list: {
      subscribe: () => () => {},
      getSnapshot: () => { snapshot.seq += 1; return { ...snapshot, seq: snapshot.seq }; },
    },
    retain: (target: any, options: any) => { calls.retain.push({ target, options }); return reference; },
    subagentAddress: () => undefined,
    setSubagentCatalogOpen: () => {},
    refreshSubagents: async () => {},
    ...overrides,
  };
  return { rt, calls, session, eventSource, reference };
}

// ---- (a) 有 retain 的 0.1.6 路径：effect 内 retain、卸载 release、严格配平 ----

test("g-321 0.1.6 retain 路径：子代理以 SubagentAddress retain（源 contract 含单参 source），卸载后 release", async () => {
  const box0 = makeRetainRuntime();
  const box = makeSessionHooksSandbox(box0.rt);
  const harness = makeHookHarness((R) => { box.React = R; return box.parts.useBoundSession("parent-1", "child-1"); });
  harness.render();
  await flushAsync();

  // 渲染期绝不 retain：未跑 effect 前一次都不能发生
  assert.equal(box0.calls.retain.length, 1, "effect 内必须恰好 retain 一次");
  // 子代理优先 SubagentAddress（resolveTarget 对地址不校验存在性，且会写入 manager.addresses
  // 使 session.prompt 走 subagents 路由），避免 sessions.retain: unknown session
  assert.deepEqual(
    { ...box0.calls.retain[0].target },
    { parentSessionId: "parent-1", childSessionId: "child-1", mode: "continuable" },
    "子代理必须用子代理地址形态 retain，而不是裸 childId 字符串",
  );
  assert.equal(box0.calls.retain[0].options.source, "dsh-graph", "retain 必须带 source 标记（可追溯的保留来源）");

  // 借到 binding：session / eventSource 语义不变
  assert.equal(harness.value().session, box0.session, "retain 后必须借到 session（D1：不再落未接入占位）");
  assert.equal(harness.value().eventSource, box0.eventSource, "eventSource 仍来自 binding.eventSource（g-217 形状不变）");
  assert.equal(box0.calls.released.length, 0, "未卸载不得释放代际");

  harness.unmount();
  await flushAsync();
  assert.equal(box0.calls.released.length, 1, "卸载必须 release 归还代际（retain/release 严格配平）");
});

test("g-321 retain 引用计数：同一 childId 在 SessionPanel + 内嵌 LiveStrip 多处消费只 retain 一次，计数归零才 release", async () => {
  const box0 = makeRetainRuntime();
  const box = makeSessionHooksSandbox(box0.rt);
  const a = makeHookHarness((R) => { box.React = R; return box.parts.useBoundSession("parent-1", "child-1"); });
  const b = makeHookHarness((R) => { box.React = R; return box.parts.useBoundSession("parent-1", "child-1"); });
  a.render();
  b.render();
  await flushAsync();
  assert.equal(box0.calls.retain.length, 1, "同组件树重复消费同一 target 不得重复 retain（否则计数泄漏）");

  a.unmount();
  await flushAsync();
  assert.equal(box0.calls.released.length, 0, "仍有消费者时不得归还代际");
  b.unmount();
  await flushAsync();
  assert.equal(box0.calls.released.length, 1, "计数归零才 release，且只 release 一次");
});

test("g-321 retain 不随会话列表快照抖动重复 retain（规避 retain→publishRetention→再 retain 死循环）", async () => {
  let listCb: (() => void) | null = null;
  const snap = { subagentsByParent: { "parent-1": { entries: [{ kind: "child", id: "child-1", mode: "continuable" }] } }, seq: 0 };
  const box0 = makeRetainRuntime({
    list: {
      subscribe: (cb: () => void) => { listCb = cb; return () => { listCb = null; }; },
      getSnapshot: () => ({ ...snap, seq: ++snap.seq }),
    },
  });
  const box = makeSessionHooksSandbox(box0.rt);
  const harness = makeHookHarness((R) => { box.React = R; return box.parts.useBoundSession("parent-1", "child-1"); });
  harness.render();
  await flushAsync();
  assert.equal(box0.calls.retain.length, 1);

  // 0.1.6 的 publishRetention 会因我们自己的 retain 更新 list 快照；若把 list 快照放进 effect
  // 依赖，就会 retain→通知→再 retain 无限循环。这里连续抖动 5 次验证不会。
  for (let i = 0; i < 5; i++) listCb?.();
  await flushAsync();
  assert.equal(box0.calls.retain.length, 1, "list 快照抖动不得引发重复 retain");
  assert.equal(box0.calls.released.length, 0, "也不得引发 release 抖动（不得反复开关保留代际）");
  harness.unmount();
});

// ---- (b) 无 retain 的 0.1.5 路径：保持被动 binding 回退，不得退化 ----

test("g-321 0.1.5 回退：sessions 无 retain 时仍走渲染期被动 binding(id)，不因缺 retain 而退化", async () => {
  const legacySession = { open: async () => {}, projections: { faceOf: () => null } };
  const bindingCalls: string[] = [];
  const rt: any = {
    list: { subscribe: () => () => {}, getSnapshot: () => ({ items: [], byId: {}, subagentsByParent: {} }) },
    // 0.1.5-rc.2：binding(id) === resolve(id)?.binding（resolve 会按需 materialize）
    binding: (id: string) => { bindingCalls.push(id); return id === "child-1" ? { session: legacySession, eventSource: null } : null; },
  };
  assert.equal(typeof rt.retain, "undefined", "0.1.5 面确实没有 retain（测试不得自身失真）");

  const box = makeSessionHooksSandbox(rt);
  const harness = makeHookHarness((R) => { box.React = R; return box.parts.useBoundSession("parent-1", "child-1"); });
  harness.render();
  await flushAsync();
  assert.ok(bindingCalls.includes("child-1"), "0.1.5 路径必须仍调用被动 binding(childId)");
  assert.equal(harness.value().session, legacySession, "0.1.5 被动解析结果必须照常返回（不得退化）");
  // 无 retain 时不得进入保留代际缓存
  assert.equal(box.parts.retainedBindings.size, 0, "回退路径不得创建保留代际条目");
  harness.unmount();
  await flushAsync();
});

test("g-321 客户端源契约：retain 只经特性探测分流，禁止版本号分支", () => {
  const hooks = readClient("session-hooks");
  assert.match(hooks, /const canRetain = typeof sessionsRt\?\.retain === "function";/);
  // 禁止版本号分支（0.1.5/0.1.6 判定不得靠版本字符串；注释里的版本说明不算代码）
  assert.deepEqual(codeMatches(hooks, /0\.1\.[56]/), [], "代码中不得出现版本号分支");
  assert.deepEqual(codeMatches(hooks, /[Vv]ersion/), [], "代码中不得按版本号分流");
  // useBoundSession / useSessionModel 都必须改为消费同一个生命周期 hook
  assert.match(hooks, /function useBoundSession\(parentId, childId\)/);
  assert.match(hooks, /const binding = useSessionBinding\(childId, \{ parentId: parentId \?\? null, childId: childId \?\? null \}\);/);
  const live = readClient("live-panel");
  assert.match(live, /const binding = useSessionBinding\(sessionId, \{ parentId: parentId \?\? null, childId: sessionId \?\? null \}\);/);
  // retain 必须发生在 effect 内（绝不在渲染期 retain），cleanup 里 release 配平
  assert.match(hooks, /React\.useEffect\(\(\) => \{[\s\S]*?entry\.started = true[\s\S]*?return \(\) => \{[\s\S]*?releaseBinding\(identity\);/);
  // 依赖栏写全（含身份与能力），且不含 list 快照（否则死循环）
  assert.match(hooks, /\}, \[canRetain, enabled, identity, parentId, childId\]\);/);
});

// ---- (c) retain 抛 unknown session：降级为未接入、不崩、不刷 console ----

test("g-321 未知会话降级：retain 抛 sessions.retain: unknown session 时返回未接入、不抛错、不刷 console", async () => {
  const logs: unknown[][] = [];
  const consoleStub = { warn: (...a: unknown[]) => logs.push(["warn", ...a]), error: (...a: unknown[]) => logs.push(["error", ...a]), log: () => {} };
  const box0 = makeRetainRuntime({
    // 地址可解析（目录/地址已收录）→ 会真的调用 retain → 宿主持有该 id 但未实例化时抛 unknown session
    subagentAddress: () => ({ parentSessionId: "parent-1", childSessionId: "child-9", mode: "continuable" }),
    retain: () => { throw new Error("sessions.retain: unknown session child-9"); },
  });
  const box = makeSessionHooksSandbox(box0.rt, { console: consoleStub });
  const harness = makeHookHarness((R) => { box.React = R; return box.parts.useBoundSession("parent-1", "child-9"); });
  harness.render();
  await flushAsync();
  // 未接入占位（看板不崩），而不是把异常抛给渲染
  assert.equal(harness.value().session, null);
  assert.equal(harness.value().eventSource, null);
  assert.deepEqual(logs, [], "降级路径不得刷 console（unknown session 是预期内的未收录状态）");
  harness.unmount();
  await flushAsync();
  assert.equal(box0.calls.released.length, 0, "retain 未成功建立代际时不得调用 release");
});

test("g-321 目录未收录降级：拿不到地址且刷新后仍未收录 → 空绑定且完全不 retain（不抛错、不刷 console）", async () => {
  const logs: unknown[][] = [];
  const consoleStub = { warn: (...a: unknown[]) => logs.push(["warn", ...a]), error: (...a: unknown[]) => logs.push(["error", ...a]), log: () => {} };
  let refreshed = 0;
  let catalogOpened = 0;
  const box0 = makeRetainRuntime({
    list: { subscribe: () => () => {}, getSnapshot: () => ({ subagentsByParent: {} }) },
    setSubagentCatalogOpen: () => { catalogOpened += 1; },
    refreshSubagents: async () => { refreshed += 1; },
  });
  const box = makeSessionHooksSandbox(box0.rt, { console: consoleStub });
  const harness = makeHookHarness((R) => { box.React = R; return box.parts.useBoundSession("parent-1", "child-9"); });
  harness.render();
  await flushAsync();
  assert.equal(catalogOpened, 1, "拿不到地址时必须先 setSubagentCatalogOpen(parentId, true)");
  assert.equal(refreshed, 1, "并 await refreshSubagents(parentId) 再试一次");
  assert.equal(box0.calls.retain.length, 0, "仍未收录时降级为空绑定——不得用裸 childId 去 retain（会 unknown session）");
  assert.equal(harness.value().session, null, "保留未接入占位");
  assert.deepEqual(logs, [], "降级路径不得刷 console");
  harness.unmount();
});

test("g-321 ready 拒绝（宿主 open 失败）时降级为未接入并归还代际，不崩", async () => {
  const box0 = makeRetainRuntime();
  const readyRejection = Promise.reject(new Error("open aborted"));
  void readyRejection.catch(() => {}); // 与真实 ClientSessionReference 构造函数一致的吞并（避免未处理拒绝）
  const rejected: any = {
    sessionId: "child-1",
    ready: readyRejection,
    get binding() { throw new Error('Session reference "child-1" is released'); },
    release: () => { box0.calls.released.push("child-1"); },
  };
  box0.rt.retain = (target: any, options: any) => { box0.calls.retain.push({ target, options }); return rejected; };
  const box = makeSessionHooksSandbox(box0.rt, { console: { warn: () => {}, error: () => {}, log: () => {} } });
  const harness = makeHookHarness((R) => { box.React = R; return box.parts.useBoundSession("parent-1", "child-1"); });
  harness.render();
  await flushAsync();
  assert.equal(harness.value().session, null, "ready 失败 → 未接入占位，不崩");
  harness.unmount();
  await flushAsync();
  assert.equal(box0.calls.released.length, 1, "已建立的代际即使 ready 失败也必须归还");
});

// ---- (d) g-224 红线：关闭实时显示时不得 session.open()、不得订阅 eventSource ----

test("g-321 g-224 门控（行为）：关闭实时显示时不调用 session.open()，开启时才打开输出流窗口", async () => {
  // 关闭：localStorage live-display = "0"
  const off0 = makeRetainRuntime();
  const offBox = makeSessionHooksSandbox(off0.rt, { liveDisplay: false });
  const offHarness = makeHookHarness((R) => { offBox.React = R; return offBox.parts.useBoundSession("parent-1", "child-1"); });
  offHarness.render();
  await flushAsync();
  assert.equal(off0.calls.opened.length, 0, "g-224：实时显示关闭时不得 session.open()（不得打开输出流窗口）");
  assert.equal(offHarness.value().session, off0.session, "低频状态仍要保留（session 照常接入，running/token/ctx 可用）");
  offHarness.unmount();
  await flushAsync();

  // 开启：localStorage live-display = "1"
  const on0 = makeRetainRuntime();
  const onBox = makeSessionHooksSandbox(on0.rt, { liveDisplay: true });
  const onHarness = makeHookHarness((R) => { onBox.React = R; return onBox.parts.useBoundSession("parent-1", "child-1"); });
  onHarness.render();
  await flushAsync();
  assert.equal(on0.calls.opened.length, 1, "开启实时显示时照常打开窗口（证明上面的门控不是恒不调用）");
  onHarness.unmount();
  await flushAsync();
});

test("g-321 g-224 门控（源契约）：output 流订阅仍受 getLiveDisplay() 门控，retain 路径本身不 open", () => {
  const hooks = readClient("session-hooks");
  const live = readClient("live-panel");
  const helpers = readClient("helpers");
  // 唯一的 session.open() 调用点仍是受门控的 openBoundSessionStream
  assert.match(hooks, /if \(!getLiveDisplay\(\)\) return Promise\.resolve\(false\);/);
  // 实时显示关闭时 eventSource 事件源完全不被当成 feed（订阅停止）
  assert.match(hooks, /const feed = liveEnabled \? \(eventSource \?\? null\) : null;/);
  // retain 生命周期路径本身不得出现 session.open()（retain 只为取得 binding 与投影）
  const retainBlock = hooks.slice(
    hooks.indexOf("const retainedBindings = new Map();"),
    hooks.indexOf("// 子代理地址配置（路由 prompt/history 到 subagents.*）。"),
  );
  assert.doesNotMatch(retainBlock, /session\.open\(/, "retain 路径不得自行打开会话窗口");
  assert.doesNotMatch(retainBlock, /\.subscribe\(/, "retain 路径不得订阅输出流/事件源");
  // LiveStrip（定义在 session-hooks）仍是唯一 eventSource 消费方，且经 useLiveStripState 门控
  assert.match(hooks, /function useLiveStripState\(session, eventSource, intervalMs = 200\)/);
  assert.match(hooks, /const \{ session, eventSource \} = useBoundSession\(props\.parentId, props\.childId\);/);
  assert.match(hooks, /\{ snap, line, running \} = useLiveStripState\(session, eventSource, 200\);/);
  // 低频状态（running / token / ctx 投影）不依赖实时开关
  assert.match(hooks, /useProjectionValue\(session, "tokenUsage"\)/);
  assert.match(hooks, /useProjectionValue\(session, "contextPressure"\)/);
  assert.match(helpers, /LIVE_DISPLAY_KEY = "dsh-graph\.live-display"/);
});

// ---- D2：模型行错误语义（未接入 → 中性回落，不得显示「模型目录不可用」）----

test("g-321 D2 模型语义（源契约）：未接入/未 ready 时回落中性状态，不用父会话模型冒充（g-109）", () => {
  const live = readClient("live-panel");
  // modelErr 只在「会话已接入、投影却缺失」时才成立
  assert.match(live, /modelErr: session && selection === undefined \? dgT\("live\.modelUnavailable"\) : null,/);
  assert.match(live, /modelPending: !session,/);
  assert.match(live, /if \(modelPending\) return dgT\("live\.modelPending"\);/);
  // 与 useBoundSession 复用同一份保留 binding（同一 childId 不重复 retain）
  assert.match(live, /useSessionBinding\(sessionId, \{ parentId: parentId \?\? null, childId: sessionId \?\? null \}\)/);
  // g-109：模型只来自**已保留的子会话**的 modelSelection 投影，绝不取父会话 binding 冒充
  const modelFn = extractFunction(live, "useSessionModel");
  assert.match(modelFn, /useProjectionValue\(session, "modelSelection"\)/);
  assert.doesNotMatch(modelFn, /binding\(\s*parentId/, "g-109：不得用父会话模型冒充子代理模型");
  assert.doesNotMatch(modelFn, /binding\(\s*parentSessionId/);
  // 中性文案 zh/en 对称且英文无 CJK
  const i18nSource = readFileSync(join(clientRoot, "i18n.js"), "utf8");
  const sandbox: any = { React: {} };
  vm.runInNewContext(i18nSource + "; this.zh = zh; this.en = en;", sandbox);
  assert.equal(sandbox.zh["live.modelPending"], "模型信息待接入");
  assert.equal(sandbox.en["live.modelPending"], "Model info pending");
  assert.doesNotMatch(sandbox.en["live.modelPending"], /[\u3400-\u9fff]/);
});

test("g-321 模型行行为：未接入时 formatModelDisplay 给中性文案（不是「模型目录不可用」）", () => {
  const live = readClient("live-panel");
  const i18nSource = readFileSync(join(clientRoot, "i18n.js"), "utf8");
  const sandbox: any = { console };
  vm.runInNewContext(
    i18nSource
    + "\n" + extractFunction(live, "formatModelDisplay")
    + "\nvar dgT = (k, p) => { var s = (zh[k] !== undefined ? zh[k] : k); "
    + "if (p) for (var key in p) s = s.split('{' + key + '}').join(p[key]); return s; };"
    + "\nthis.formatModelDisplay = formatModelDisplay;",
    sandbox,
  );
  const fmt = sandbox.formatModelDisplay as (...a: unknown[]) => string;
  // 未接入（model/modelErr 均为空、modelPending 为真）→ 中性「模型信息待接入」
  assert.equal(fmt(null, null, null, null, null, null, true), "模型信息待接入");
  // 未接入但服务端已下发静态路由 → 照常显示真实路由（g-194），不留白
  assert.equal(fmt(null, "deepseek-official", "deepseek-v4-flash", null, null, null, true), "deepseek-official/deepseek-v4-flash");
  // 已接入但投影缺失 → 仍如实报「模型目录不可用」
  assert.equal(fmt(null, null, null, null, null, "模型目录不可用", false), "不可用：模型目录不可用");
});

// ============================================================================
// 7. 端到端（沙箱）：真实 dist/lib/client.js 产物 + 忠实 0.1.6-alpha.2 宿主契约模拟
//
// 说明（如实标注）：本沙箱**无法**访问 3082 实机页面（dsh web 的 /api 由 authority 绑定的
// 签名 cookie 门控，激活密钥只随 `dsh web` 打印的 URL 下发，沙箱内拿不到），且 3082 的 profile
// 把 dsh-graph 指向**主工作树**的 dist/（本 attempt 禁止改主工作树）。因此这里做**次强**验证：
// 用**真实构建产物** dist/lib/client.js，在忠实复刻实测宿主契约（见下）的模拟器上渲染真实
// LiveStrip / useSessionModel，断言用户可见文案与保留代际配平。实机 3082 结论见交付摘要。
// ============================================================================

/** 忠实复刻实测的 0.1.6-alpha.2 宿主契约（来源：全局安装的
 *  @deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/{service,manager}.js）：
 *   - `binding(id)` === `scopes.get(id)?.binding` —— 只借用**已存在**的保留代际，不再按需
 *     materialize（0.1.6-alpha.1/0.1.5 的 `binding(id)` 是 `resolve(id)?.binding`，会 materialize）；
 *   - `retain(target, {source})` → SessionReference{ sessionId, binding(getter，释放后抛错),
 *     ready: Promise<SessionBinding>, release() }，内部 retainScope 计数 + 触发 open；
 *   - `resolveTarget`：字符串 id 在「未实例化 && 不在 summaries && 无导航地址」时抛
 *     `sessions.retain: unknown session <id>`；SubagentAddress 不校验存在性且写入 addresses；
 *   - `manager.subagentAddress(id)`：已保留地址或已打开目录（entries[{kind:'child',id,mode}]）反查。
 *  `legacyBinding: true` 复现 0.1.5 / 0.1.6-alpha.1 的按需 materialize 语义作为对照。 */
function makeHost016(opts: { catalog?: boolean; summaries?: string[]; legacyBinding?: boolean } = {}) {
  const sessions = new Map<string, any>();
  const scopes = new Map<string, any>();
  const addresses = new Map<string, any>();
  const catalogs = new Map<string, any>();
  const summaries = new Set(opts.summaries ?? []);
  const listListeners = new Set<() => void>();
  const calls = { retain: [] as any[], release: [] as string[], open: [] as string[], promptRoute: [] as string[] };

  const makeEventSource = (id: string) => ({ getSnapshot: () => ({ entries: [{ id }] }), subscribe: () => () => {} });
  const makeSession = (id: string) => ({
    open: async () => { calls.open.push(id); },
    getSnapshot: () => ({ sessionId: id, running: true }),
    subscribe: () => () => {},
    projections: {
      faceOf: (key: string) => (key === "modelSelection"
        ? { getSnapshot: () => ({ next: { provider: "deepseek-official", model: "deepseek-v4-flash" } }), subscribe: () => () => {} }
        : null),
    },
    prompt: async () => {
      calls.promptRoute.push(addresses.has(id) ? "subagents.prompt" : "session.prompt");
      return { ok: true };
    },
  });

  function materialize(id: string) {
    let record = scopes.get(id);
    if (record) return record;
    if (!sessions.has(id)) sessions.set(id, makeSession(id));
    record = { live: true, session: sessions.get(id), binding: { sessionId: id, session: sessions.get(id), eventSource: makeEventSource(id) }, retention: 0 };
    scopes.set(id, record);
    return record;
  }

  function navigationAddress(id: string) {
    if (addresses.has(id)) return addresses.get(id);
    for (const [parentSessionId, catalog] of catalogs) {
      const child = (catalog.entries ?? []).find((e: any) => e.kind === "child" && e.id === id);
      if (child) return { parentSessionId, childSessionId: id, mode: child.mode };
    }
    return undefined;
  }

  function resolveTarget(target: any) {
    const id = typeof target === "string" ? target : target.childSessionId;
    const address = typeof target === "string" ? navigationAddress(id) : target;
    if (typeof target === "string" && !sessions.has(id) && !summaries.has(id) && address === undefined) {
      throw new Error(`sessions.retain: unknown session ${id}`);
    }
    if (address !== undefined) addresses.set(id, address);
    return id;
  }

  const rt: any = {
    manager: { subagentAddress: (id: string) => navigationAddress(id) },
    list: {
      subscribe: (cb: () => void) => { listListeners.add(cb); return () => { listListeners.delete(cb); }; },
      getSnapshot: () => ({
        ids: [...sessions.keys()],
        byId: {},
        // 目录只在 setSubagentCatalogOpen(true) + refreshSubagents 之后才可见（实测语义）
        subagentsByParent: Object.fromEntries([...catalogs].map(([p, c]) => [p, c])),
      }),
    },
    subagentAddress: (id: string) => navigationAddress(id),
    setSubagentCatalogOpen: (parentSessionId: string) => { catalogs.set(parentSessionId, { entries: opts.catalog ? [{ kind: "child", id: "child-1", mode: "continuable" }] : [] }); },
    refreshSubagents: async (parentSessionId: string) => { catalogs.set(parentSessionId, { entries: opts.catalog ? [{ kind: "child", id: "child-1", mode: "continuable" }] : [] }); },
    // 0.1.6-alpha.2：只借用已存在的保留代际；无 retain 时恒 undefined
    binding: (id: string) => (opts.legacyBinding ? materialize(id).binding : scopes.get(id)?.binding),
    retain: (target: any, options: any) => {
      calls.retain.push({ target, options });
      const id = resolveTarget(target);
      const record = materialize(id);
      record.retention += 1;
      let released = false;
      const ready = makeSession(id).open().then(() => undefined);
      return {
        sessionId: id,
        ready,
        get binding() {
          if (released) throw new Error(`Session reference "${id}" is released`);
          return record.binding;
        },
        release: () => {
          if (released) return;
          released = true;
          record.retention -= 1;
          calls.release.push(id);
          if (record.retention === 0) { record.live = false; scopes.delete(id); }
          for (const cb of [...listListeners]) cb();
        },
      };
    },
  };
  return { rt, calls, makeSession };
}

/** 渲染真实 LiveStrip（从构建产物里抽真实实现），返回其全部可见文本。 */
function renderLiveStrip(rt: unknown, props: Record<string, unknown>, liveDisplay = true) {
  const bundle = readFileSync(join(distRoot, "lib/client.js"), "utf8");
  const i18nSource = readFileSync(join(clientRoot, "i18n.js"), "utf8");
  const names = [
    "bindIdentity", "ensureBindingEntry", "notifyBinding", "subagentAddressFromCatalog",
    "resolveSessionRetainTarget", "startRetainedBinding", "releaseBinding", "useSessionBinding",
    "setupBoundSession", "openBoundSessionStream", "useSessionsList", "useBoundSession",
    "useProjectionValue", "lastStreamLine", "useThrottledLiveSession",
    "deriveLive", "toolDetail", "pickLiveLine", "useLiveStripState", "fmtElapsed", "liveMeter",
    "LiveStrip",
  ];
  const code = [
    i18nSource,
    "var sessionsRt = __rt;",
    "var NOOP_UNSUB = () => () => {};",
    "var S = {};",
    "var h = (tag, p, ...kids) => ({ tag, props: p, children: kids });",
    "var openChildSession = () => {};",
    "var boundSetup = new Map();",
    "var boundModes = new Map();",
    "var boundOpened = new Map();",
    "var retainedBindings = new Map();",
    "var LIVE_DISPLAY_KEY = 'dsh-graph.live-display';",
    "var dgT = (k, p) => { var s = (zh[k] !== undefined ? zh[k] : k); if (p) for (var key in p) s = s.split('{' + key + '}').join(p[key]); return s; };",
    ...names.map((n) => extractFunction(bundle, n)),
    // g-351：目录读取/刷新改为形状与能力探测实现（同上，补齐沙箱依赖，断言不变）。
    extractFunction(bundle, "subagentCatalogEntries"),
    extractFunction(bundle, "subagentAddressOf"),
    extractFunction(bundle, "refreshSubagentCatalog"),
    ...CATALOG_SHAPE_FUNCS.map((n) => extractFunction(bundle, n)),
    extractFunction(bundle, "getLiveDisplay"),
    extractFunction(bundle, "useLiveDisplayEnabled"),
    extractFunction(bundle, "formatStatusWithLifecycle"),
    "this.api = { LiveStrip, useSessionBinding, retainedBindings, getLiveDisplay };",
    "this.zh = zh;",
  ].join("\n");
  const sandbox: any = {
    __rt: rt,
    React: null,
    console: { warn: () => {}, error: () => {}, log: () => {} },
    localStorage: { getItem: () => (liveDisplay ? "1" : "0"), setItem: () => {}, removeItem: () => {} },
    window: { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  vm.runInNewContext(code, sandbox, { filename: "dist/lib/client.js#LiveStrip" });

  const harness = makeHookHarness((R) => { sandbox.React = R; return sandbox.api.LiveStrip(props); });
  harness.render();
  return { harness, sandbox, text: () => collectText(harness.value()).join(" ") };
}

function collectText(node: any, out: string[] = []): string[] {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const c of node) collectText(c, out); return out; }
  if (typeof node === "object" && "children" in node) { for (const c of node.children) collectText(c, out); }
  return out;
}

test("g-321 根因复现：0.1.6 语义下未 retain 时 binding(childId) 恒 undefined（D1/D2 的机制）", () => {
  const host = makeHost016({ catalog: true });
  // 被动借用：没有任何 retain → 恒 undefined（这正是 att-001 渲染期被动 binding() 拿不到会话的原因）
  assert.equal(host.rt.binding("child-1"), undefined, "无 retain 时 binding(id) 必须为 undefined（0.1.6 语义）");
  // 先 retain 再借用 → 拿得到（修复方向）
  const reference = host.rt.retain({ parentSessionId: "parent-1", childSessionId: "child-1", mode: "continuable" }, { source: "dsh-graph" });
  assert.ok(host.rt.binding("child-1"), "retain 之后 binding(id) 才可借到");
  reference.release();
  assert.equal(host.rt.binding("child-1"), undefined, "计数归零后保留代际被回收");
  // 对照：0.1.5 / 0.1.6-alpha.1 的按需 materialize 语义下，被动调用仍可用（所以只能特性探测）
  const legacy = makeHost016({ catalog: true, legacyBinding: true });
  assert.ok(legacy.rt.binding("child-1"), "0.1.5 的 binding(id) 按需 materialize，被动调用可用（不得退化）");
});

test("g-321 端到端（真实产物）：0.1.6 语义下 LiveStrip 不再渲染「⚠️ 会话未接入」且正常显示运行态", async () => {
  const host = makeHost016({ catalog: true });
  const r = renderLiveStrip(host.rt, { parentId: "parent-1", childId: "child-1", statusLine: "工作中" });
  await flushAsync();
  const text = r.text();
  const unconnected = r.sandbox.zh["live.unconnected"];
  assert.ok(unconnected.includes("会话未接入"), "i18n 基线：占位文案确为「会话未接入」");
  assert.equal(text.includes("会话未接入"), false, `0.1.6 下不得出现「⚠️ 会话未接入（不在会话列表）」；实际渲染：${text}`);
  assert.ok(host.calls.retain.length >= 1, "确实走了 retain 生命周期路径");
  assert.match(text, /🟢|⚪/, "运行态低频状态仍要显示");
  assert.match(text, /工作中/, "status_line 仍要显示");
  r.harness.unmount();
  await flushAsync();
  assert.ok(host.calls.release.length >= 1, "卸载后必须归还保留代际");
});

test("g-321 端到端（真实产物）：未收录子代理仍然只保留占位、不崩、不刷 console", async () => {
  const host = makeHost016({ catalog: false }); // 目录里没有 child-1
  const r = renderLiveStrip(host.rt, { parentId: "parent-1", childId: "child-1" });
  await flushAsync();
  const text = r.text();
  assert.equal(text.includes("会话未接入"), true, "确实拿不到地址时保留占位（降级而非崩）");
  assert.equal(host.calls.retain.length, 0, "未收录时不得用裸 childId 去 retain");
  r.harness.unmount();
  await flushAsync();
});

test("g-321 端到端（真实产物）：0.1.6 语义下 useSessionModel 拿得到真实模型，未接入时回落中性（不报「模型目录不可用」）", async () => {
  const bundle = readFileSync(join(distRoot, "lib/client.js"), "utf8");
  const i18nSource = readFileSync(join(clientRoot, "i18n.js"), "utf8");
  const names = [
    "bindIdentity", "ensureBindingEntry", "notifyBinding", "subagentAddressFromCatalog",
    "resolveSessionRetainTarget", "startRetainedBinding", "releaseBinding", "useSessionBinding",
    "useSessionModel", "useProjectionValue", "useSessionsList",
  ];
  const build = (rt: unknown) => {
    const sandbox: any = {
      __rt: rt, React: null, console: { warn: () => {}, error: () => {}, log: () => {} },
      localStorage: { getItem: () => "1" }, window: { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => {} },
    };
    vm.runInNewContext([
      i18nSource,
      "var sessionsRt = __rt;",
      "var NOOP_UNSUB = () => () => {};",
      "var retainedBindings = new Map();",
      "var dgT = (k) => (zh[k] !== undefined ? zh[k] : k);",
      ...names.map((n) => extractFunction(bundle, n)),
      // g-351：补齐目录形状/能力探测实现（沙箱依赖，断言不变）。
      extractFunction(bundle, "subagentCatalogEntries"),
      extractFunction(bundle, "subagentAddressOf"),
      extractFunction(bundle, "refreshSubagentCatalog"),
      ...CATALOG_SHAPE_FUNCS.map((n) => extractFunction(bundle, n)),
      "this.useSessionModel = useSessionModel;",
    ].join("\n"), sandbox, { filename: "dist/lib/client.js#useSessionModel" });
    return sandbox;
  };

  // 已接入：拿到子代理的真实模型（不是父会话模型，也不报不可用）
  const host = makeHost016({ catalog: true });
  const box = build(host.rt);
  const harness = makeHookHarness((R) => { box.React = R; return box.useSessionModel("child-1", "parent-1"); });
  harness.render();
  await flushAsync();
  const bound = harness.value();
  assert.equal(bound.modelErr, null, "已接入时不得报「模型目录不可用」");
  assert.equal(bound.modelPending, false);
  assert.deepEqual({ ...bound.model }, { provider: "deepseek-official", model: "deepseek-v4-flash" }, "模型来自子会话 modelSelection 投影");
  harness.unmount();
  await flushAsync();

  // 未接入（unbound）：中性回落，绝不显示「模型目录不可用」
  const empty = makeHost016({ catalog: false });
  const box2 = build(empty.rt);
  const harness2 = makeHookHarness((R) => { box2.React = R; return box2.useSessionModel("child-1", "parent-1"); });
  harness2.render();
  await flushAsync();
  const pending = harness2.value();
  assert.equal(pending.model, null);
  assert.equal(pending.modelErr, null, "未接入时绝不得显示「模型目录不可用」");
  assert.equal(pending.modelPending, true, "未接入时回落中性状态（live.modelPending）");
  harness2.unmount();
  await flushAsync();
});
