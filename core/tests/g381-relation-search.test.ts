/**
 * g-381：「关系标记」面板对端选择改为搜索式（编号/关键字），复用既有搜索实现。
 *
 * 分工（与仓库既有客户端测试口径一致）：
 *  - 本套件 = 纯函数级（唯一匹配实现复用 + 规模实测）+ **真实渲染级**（vm 装载 dist/lib/client.js +
 *    迷你 React，真组件真调用、真键盘/真点击）+ i18n/降级/bundle 新鲜度 的机器断言；
 *  - 视觉层（四张截图：编号命中 / 关键字命中 / 空结果 / 选中后关系行）由隔离实例实机核验，见证据台账。
 *
 * 判别力（改坏即红，含负向对照）：
 *  - 负向对照 N1：把 kanban 的委托还原为「内联第二套匹配」⇒ 唯一实现守卫必红；
 *  - 负向对照 N2：候选上限去掉（limit 不设）⇒ 渲染节点数守卫必红；
 *  - 负向对照 N3：面板不再委托 filterCandidateMatches ⇒ 复用守卫必红。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

import {
  RELATION_PEER_LIMIT,
  normalizeSearchQuery,
  collectBoardCandidates,
  matchGoalCandidate,
  collectSearchMatches,
  filterCandidateMatches,
  goalCandidateLabel,
} from "../../dsh-graph-host/lib/client/search-match.js";

const root = join(import.meta.dirname, "../..");
const hostRoot = join(root, "dsh-graph-host");
const modDir = join(hostRoot, "lib/client");
const readSrc = (name: string) => readFileSync(join(modDir, `${name}.js`), "utf8");
const KANBAN_SRC = readSrc("kanban");
const MODAL_SRC = readSrc("goal-modal");
const MATCH_SRC = readSrc("search-match");
const I18N_SRC = readSrc("i18n");
const BUNDLE_SRC = readFileSync(join(root, "dist/lib/client.js"), "utf8");

/** `RelationMarker` 组件本体切片（与 g380 守卫同一切法：到 DescriptionBox 注释为止）。 */
function panelSlice(src: string): string {
  const start = src.indexOf("function RelationMarker(");
  const end = src.indexOf("// g-260：目标描述组件", start);
  return start < 0 || end <= start ? "" : src.slice(start, end);
}

/** 客户端 i18n 字典（与 g281/g380 同一装载口径）。 */
function loadClientI18n() {
  const sandbox: any = { React: {} };
  vm.runInNewContext(I18N_SRC + "; this.zh = zh; this.en = en;", sandbox);
  return { zh: sandbox.zh as Record<string, string>, en: sandbox.en as Record<string, string> };
}
const { zh, en } = loadClientI18n();

// ---------------------------------------------------------------------------
// 夹具：~400 目标的看板 payload（与真实规模同量级；含 released 版本 / 独立 / backlog）
// ---------------------------------------------------------------------------
interface FixtureGoal { id: string; title: string; status: string; description?: string }

function bigBoard(total = 401) {
  const mk = (i: number, kw: string) => ({
    id: `g-${i}`, title: `目标 ${i}：${kw}事项 ${i}`, status: "planning",
    description: `播种目标 ${i}（关键字：${kw}）`, tags: [], criteria_count: 0, cards_count: 0,
  });
  const versions: any[] = [];
  const perVersion = [
    { slug: "v0.17.1", name: "V0.17.1", status: "active", n: Math.min(181, total) },
    { slug: "v0.17.0", name: "V0.17.0", status: "released", n: Math.max(0, Math.min(120, total - 181)) },
  ];
  let id = 0;
  const kwOf = (i: number) => (i % 3 === 0 && i <= 180 ? "看板渲染" : ["关系标记", "搜索泳道", "并发冲突", "卡片抽屉"][i % 4]);
  for (const v of perVersion) {
    const goals = [];
    for (let k = 0; k < v.n; k++) { id++; goals.push(mk(id, kwOf(id))); }
    versions.push({ slug: v.slug, name: v.name, status: v.status, goals, goals_count: goals.length, lazy: false, loaded: true });
  }
  const standalone = [];
  for (let k = 0; k < 50 && id < total; k++) { id++; standalone.push(mk(id, "独立目标")); }
  const backlog = [];
  while (id < total) { id++; backlog.push(mk(id, "backlog")); }
  // 末位目标是**唯一关键字**目标（关键字命中用例的靶子；与真实播种 workspace 的 g-401 同形）
  const all = [...versions.flatMap((v: any) => v.goals), ...standalone, ...backlog];
  const last = all[all.length - 1];
  last.title = "星云检索哨兵：唯一关键字目标";
  last.description = "g-381 关键字命中验收：全仓唯一含「星云检索」的目标。";
  return {
    lazy: true, backlog_loaded: true, backlog_count: backlog.length,
    generated_at: "2026-10-01T00:00:00Z", supervisorSession: null,
    versions, standalone, backlog,
  };
}

const board400 = bigBoard(401);
const ALL_GOALS: FixtureGoal[] = [
  ...board400.versions.flatMap((v: any) => v.goals),
  ...board400.standalone,
  ...board400.backlog,
];
const PEER_POOL = ALL_GOALS.map((g) => ({ id: g.id, title: g.title, status: g.status })).filter((g) => g.id !== "g-1");

// 目标详情（GoalModal 的 GET /api/dsh-graph/goal 回包）
const goalDetail = (id: string) => ({
  description: "g-381 验收目标描述",
  body: "## 目标描述\n\ng-381 验收目标描述\n\n## 质量判据\n\n1. 判据\n",
  meta: { id, title: "验收目标", status: "planning", type: "improvement", version: "v0.17.1", depends_on: [], relations: [] },
  cards: [], attempts: [], worktrees: { status: "ok", items: {} }, events: [],
});

// ---------------------------------------------------------------------------
// 真实渲染 harness（vm + 迷你 React；同 g352/g367 口径，只保留本目标需要的能力）
// ---------------------------------------------------------------------------
interface RenderResult { passElements: () => any[]; root: () => any }

function createHarness(opts: { board?: any; bundle?: string; failRelations?: boolean } = {}) {
  const bundle = opts.bundle ?? BUNDLE_SRC;
  const elements: any[] = [];
  const fetchLog: { url: string; init?: any }[] = [];
  let factory: any = null;
  const noop = () => {};

  const makeFakeNode = () => ({
    clientWidth: 900, scrollWidth: 0, scrollHeight: 0, scrollTop: 0, style: {}, offsetWidth: 0,
    children: [], focus: noop, select: noop, blur: noop, contains: () => false,
    addEventListener: noop, removeEventListener: noop, appendChild: noop, setAttribute: noop,
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 900, height: 10, top: 0, left: 0, right: 900 }),
  });

  const RealError = Error;
  const callerFn = () => {
    RealError.prepareStackTrace = (_e: any, frames: any) => frames;
    const frames: any = new RealError().stack;
    RealError.prepareStackTrace = undefined;
    return frames?.[1]?.getFunction?.() ?? null;
  };
  const slots = new Map<any, any[]>();
  const cursor = new Map<any, number>();
  let pendingEffects: any[] = [];
  let dirty = false;
  const depsEqual = (a: any, b: any) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const slotAt = () => {
    const fn = callerFn();
    let arr = slots.get(fn);
    if (!arr) { arr = []; slots.set(fn, arr); }
    const i = cursor.get(fn) ?? 0;
    cursor.set(fn, i + 1);
    return { arr, i };
  };

  const ReactStub: any = {
    createElement(type: any, props: any, ...children: any[]) {
      const p = props ? { ...props } : {};
      const el = { type, props: p, children };
      if (typeof type === "string" && p.ref && typeof p.ref === "object" && p.ref.current == null) p.ref.current = makeFakeNode();
      elements.push(el);
      return el;
    },
    useState(init: any) {
      const { arr, i } = slotAt();
      if (!(i in arr)) arr[i] = { value: typeof init === "function" ? init() : init };
      const s = arr[i];
      return [s.value, (v: any) => {
        const nv = typeof v === "function" ? v(s.value) : v;
        if (!Object.is(nv, s.value)) { s.value = nv; dirty = true; }
      }];
    },
    useRef(init: any) { const { arr, i } = slotAt(); if (!(i in arr)) arr[i] = { current: init }; return arr[i]; },
    useEffect(fn: any, deps: any) {
      const { arr, i } = slotAt();
      const s = arr[i] || (arr[i] = {});
      if (!s.fn || !depsEqual(s.deps, deps)) { s.fn = fn; s.deps = deps; pendingEffects.push(s); }
      else s.fn = fn;
    },
    useLayoutEffect(fn: any, deps: any) { ReactStub.useEffect(fn, deps); },
    useMemo(fn: any, deps: any) {
      const { arr, i } = slotAt();
      const s = arr[i];
      if (!s || !depsEqual(s.deps, deps)) { const v = fn(); arr[i] = { deps, value: v }; return v; }
      return s.value;
    },
    useCallback(fn: any, deps: any) { return ReactStub.useMemo(() => fn, deps); },
    useSyncExternalStore(_sub: any, getSnapshot: any) { return getSnapshot(); },
    Fragment: "Fragment",
    memo: (c: any) => c,
    Component: class { props: any; state: any; constructor(props: any) { this.props = props; this.state = {}; } setState() {} },
  };

  const json = (v: any) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => v, text: async () => JSON.stringify(v) });
  const sandbox: any = {
    console, URL, URLSearchParams, TextEncoder, TextDecoder, performance,
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    queueMicrotask, requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, key: () => null, length: 0 },
    navigator: {},
    fetch: async (url: any, init?: any) => {
      const u = String(url);
      fetchLog.push({ url: u, init });
      if (u.includes("/api/dsh-graph/goal")) return json(goalDetail(/id=(g-\d+)/.exec(u)?.[1] ?? "g-1"));
      if (u.includes("/api/dsh-graph/relations")) {
        if (opts.failRelations) return { ok: false, status: 500, headers: { get: () => null }, json: async () => ({ ok: false, error: "boom" }) };
        if (init && init.method === "POST") return json({ ok: true });
        return json({ ok: true, outgoing: [], incoming: [] });
      }
      if (u.includes("/api/dsh-graph/version-detail")) return json({ slug: "v0.17.1", goals: [], goals_count: 0 });
      if (u.includes("/api/dsh-graph/version-goals")) return json({ goals: [] });
      if (u.includes("/api/dsh-graph/backlog-goals")) return json({ goals: [] });
      if (u.includes("/api/dsh-graph/order")) return json({});
      if (u.includes("/api/dsh-graph")) return json(opts.board ?? board400);
      return json({});
    },
    ResizeObserver: class { cb: any; constructor(cb: any) { this.cb = cb; } observe() {} disconnect() {} unobserve() {} },
    document: {
      createElement: () => makeFakeNode(),
      querySelectorAll: () => [], getElementById: () => null,
      addEventListener: noop, removeEventListener: noop,
      head: { appendChild: noop }, body: { appendChild: noop, removeChild: noop },
      activeElement: null,
    },
    CustomEvent: class { type: string; constructor(type: string) { this.type = type; } },
    Event: class { type: string; constructor(type: string) { this.type = type; } },
  };
  sandbox.window = {
    __ModuleLoader__: { load: (def: any) => { factory = def.factory; } },
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(bundle, sandbox, { filename: "dist/lib/client.js" });
  assert.ok(factory, "bundle 通过 window.__ModuleLoader__.load 注册工厂");

  const requireStub = (name: string) => {
    if (name === "react") return ReactStub;
    if (name === "react-dom") return { render: noop, createPortal: (node: any) => node, createRoot: () => ({ render: noop, unmount: noop }) };
    throw new Error(`module not found: ${name}`);
  };
  const mod = factory(requireStub);
  const registered: { def: any; renderer: any }[] = [];
  const workspacesRt = { list: { getSnapshot: () => ({ items: [{ path: "/ws", sessionIds: ["s1"] }] }) } };
  const slotsObj = {
    inject: (_n: string, cb: any) => { cb?.(); return noop; },
    register: (def: any, renderer: any) => { registered.push({ def, renderer }); return noop; },
  };
  const ctx: any = {
    sessions: { list: { getSnapshot: () => ({ byId: {}, items: [], subagentsByParent: {} }) } },
    get: (n: string) => (n === "workspaces" ? workspacesRt : null),
    slots: slotsObj, on: noop, effect: (fn: any) => fn(),
    inject: (_deps: string[], cb: any) => { cb?.({ sidebarRightTabs: { register: () => noop }, slots: slotsObj }); return { dispose: noop }; },
  };
  mod.apply(ctx);
  const cv = registered.find((r) => r.def?.name === "conversation.view");
  assert.ok(cv, "conversation.view 已注册");

  let lastStart = 0;
  let passes = 0;
  async function settle(props: any = { sessionId: "s1", host: "sidebar" }, maxPasses = 30): Promise<RenderResult> {
    const KanbanView = cv!.renderer(props).type;
    assert.equal(typeof KanbanView, "function", "conversation.view renderer 产出 KanbanView 组件");
    let tree: any = null;
    for (let p = 0; p < maxPasses; p++) {
      passes++;
      dirty = false;
      cursor.clear();
      pendingEffects = [];
      lastStart = elements.length;
      tree = expandComponents(KanbanView(props));
      for (const s of pendingEffects) {
        if (typeof s.cleanup === "function") s.cleanup();
        s.cleanup = s.fn();
      }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      if (!dirty) break;
    }
    return { passElements: () => elements.slice(lastStart), root: () => tree };
  }
  return { settle, elements, fetchLog, mod };
}

function treeOf(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) treeOf(n, out); return out; }
  if (node.type) { out.push(node); treeOf(node.children, out); }
  return out;
}

/**
 * 迷你 React 只把 `h(KanbanView, ...)` 的**根组件**展开（KanbanView 由 renderer 直接产出），
 * 内层 `h(GoalModal/DescriptionBox/RelationMarker, ...)` 若不展开就只是 vnode、不是渲染结果。
 * 这里按白名单把「目标详情 → 描述区 → 关系标记面板」这条真实链路显式调用（hook 归属按调用者
 * 函数身份，与真实 React 的 fiber 归属同口径），使断言打在真正渲染出来的元素树上。
 * 白名单刻意收窄：不惊动其它宿主组件（避免无关组件需要真实 DOM/上下文而抛错）。
 */
const EXPAND_COMPONENTS = new Set(["GoalModal", "DescriptionBox", "RelationMarker"]);
function expandComponents(node: any, depth = 0): any {
  if (depth > 24 || node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((n) => expandComponents(n, depth));
  if (typeof node.type === "function" && EXPAND_COMPONENTS.has(node.type.name)) {
    return expandComponents(node.type(node.props ?? {}), depth + 1);
  }
  if (Array.isArray(node.children)) node.children = node.children.map((c) => expandComponents(c, depth));
  return node;
}
const elClass = (e: any): string => (typeof e?.props?.className === "string" ? e.props.className : "");
const withClass = (els: any[], needle: string) => els.filter((e) => elClass(e).includes(needle));
function treeText(node: any): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(treeText).join(" ");
  if (node.children) return treeText(node.children);
  return "";
}

/** 反复 settle 直到谓词成立（用于 await 链：submit = tokensFor → POST → json → setNote → load）。 */
async function waitFor(h: ReturnType<typeof createHarness>, pred: (r: RenderResult) => boolean, tries = 10) {
  let r = await h.settle();
  for (let i = 0; i < tries; i++) {
    if (pred(r)) return r;
    for (let k = 0; k < 4; k++) await new Promise((res) => setImmediate(res));
    r = await h.settle();
  }
  return r;
}

/** 打开目标详情 → 展开「🔗 标记关系」面板，返回面板内的可交互元素。 */
async function openRelationPanel(h: ReturnType<typeof createHarness>, goalId = "g-1") {
  let r = await h.settle();
  const card = r.passElements().find((e) => e?.props?.["data-goal-id"] === goalId);
  assert.ok(card, `看板里存在 ${goalId} 的卡片（用于打开详情弹窗）`);
  card.props.onClick();
  r = await h.settle();
  const markBtn = r.passElements().find((e) => elClass(e).includes("dg-relation-mark-btn"));
  assert.ok(markBtn, "「🔗 标记关系」入口存在");
  markBtn.props.onClick();
  r = await h.settle();
  const input = r.passElements().find((e) => elClass(e).includes("dg-relation-peer-input"));
  assert.ok(input, "对端搜索输入框存在（下拉已被替换）");
  return { r, input };
}

const optionsOf = (els: any[]) => withClass(els, "dg-relation-peer-option");
const inputOf = (els: any[]) => els.find((e) => elClass(e).includes("dg-relation-peer-input"));

// ===========================================================================
// 判据 2：复用既有搜索实现（唯一匹配/排序；禁第二套）
// ===========================================================================
test("g-381 判据2：匹配判定全仓唯一实现（search-match.js），kanban 与关系面板同源委托", () => {
  // ① 唯一匹配语义只有一处定义
  const definingModules = readdirSync(modDir).filter((f) => f.endsWith(".js"))
    .filter((f) => /function matchGoalCandidate\s*\(/.test(readFileSync(join(modDir, f), "utf8")));
  assert.deepEqual(definingModules, ["search-match.js"], "matchGoalCandidate 只能有一处定义（禁第二套匹配）");

  // ② kanban 搜索泳道委托同一实现，且不再内联匹配
  assert.match(KANBAN_SRC, /collectSearchMatches\(b, q, \{ fullText: isFullText, snippetOf: extractMatchSnippet \}\)/,
    "kanban executeSearch 必须委托唯一实现");
  assert.doesNotMatch(KANBAN_SRC, /\.toLowerCase\(\)\.includes\(lowerQ\)/, "kanban 不得残留内联匹配判定");

  // ③ 关系面板委托同一实现（编号/关键字过滤 + 候选上限），不得自带第二套匹配/排序
  const panel = panelSlice(MODAL_SRC);
  assert.ok(panel.length > 0, "RelationMarker 组件存在");
  assert.match(panel, /filterCandidateMatches\(peerPool, query, \{ limit: RELATION_PEER_LIMIT \}\)/,
    "关系面板必须调用 search-match.js 的 filterCandidateMatches");
  assert.doesNotMatch(panel, /\.toLowerCase\(\)\.includes\(/, "关系面板不得自带 includes 匹配（第二套）");
  assert.doesNotMatch(panel, /\.sort\(\s*\(a, b\)\s*=>\s*String\(a\.id\)\.localeCompare/, "关系面板不得自带第二套排序");
  assert.doesNotMatch(panel, /searchMatches/, "关系面板不得自建命中集合");

  // ④ 泳道 key 唯一真源仍只有 versionLaneKey（候选构造已随唯一实现迁移）
  assert.match(MATCH_SRC, /laneKey: versionLaneKey\(v\),/);
  assert.doesNotMatch(MATCH_SRC, /"rellane-"/, "候选构造不得内联泳道 key 字面量");
});

test("g-381 判据2：匹配语义与既有搜索一致（编号子串 / 标题子串 / 大小写不敏感 / 去首尾空白）", () => {
  // 大小写与前缀归一：g-380 / G-380 / 380 都命中同一目标（既有 includes 语义）
  for (const q of ["g-101", "G-101", "101", "  g-101  ", "g-10"]) {
    const hit = filterCandidateMatches(PEER_POOL, q, { limit: 10 }).items;
    assert.ok(hit.some((g) => g.id === "g-101"), `查询「${q}」应命中 g-101（既有子串/大小写语义）`);
  }
  // 关键字（标题片段）：唯一关键字目标恰命中 1 条
  assert.equal(filterCandidateMatches(PEER_POOL, "星云检索", {}).total, 1, "唯一关键字命中恰 1 条");
  const kw = filterCandidateMatches(PEER_POOL, "看板渲染", {}).total;
  assert.ok(kw >= 50, `关键字命中应达到上限量级（实得 ${kw}）`);
  // 空查询不做关键字匹配（空串不是关键字）
  assert.equal(matchGoalCandidate({ id: "g-1", title: "x" }, "   ").matched, false);
  assert.equal(normalizeSearchQuery("  g-1  "), "g-1");

  // 与看板搜索泳道**逐条同源**：同一 board、同一查询 ⇒ id 序列完全一致
  const board = board400;
  for (const q of ["g-1", "看板渲染", "关系标记", "V0.17", "zzz-无此目标"]) {
    const viaKanban: string[] = collectSearchMatches(board, q, {}).map((m: any) => m.id);
    const pool = collectBoardCandidates(board).map((c: any) => ({ id: c.id, title: c.title, status: c.status }));
    const viaPanel = filterCandidateMatches(pool, q, { limit: 100000 }).items.map((c: any) => c.id);
    assert.deepEqual(viaPanel, viaKanban, `查询「${q}」：关系面板候选次序必须与看板搜索命中次序一致`);
  }
  // fullText 语义：仅 isFullText 时描述命中
  const descBoard = { versions: [{ slug: "v1", name: "V1", status: "active", goals: [{ id: "g-900", title: "无关", description: "独有关键字xyzzy" }] }], standalone: [], backlog: [] };
  assert.equal(collectSearchMatches(descBoard, "xyzzy", { fullText: false }).length, 0);
  assert.equal(collectSearchMatches(descBoard, "xyzzy", { fullText: true }).length, 1);
  // snippet 仍由既有 extractMatchSnippet 提供（注入式，非复制）
  const snip = collectSearchMatches(descBoard, "xyzzy", { fullText: true, snippetOf: (t: any, q: string) => `[${t}:${q}]` });
  assert.equal(snip[0].snippet, "[独有关键字xyzzy:xyzzy]", "snippet 由注入的既有实现产出");
});

test("g-381 判据2 负向对照：把 kanban 还原为内联第二套匹配 / 面板自带匹配 ⇒ 守卫必红", () => {
  const checker = (kanban: string, panel: string) => {
    const problems: string[] = [];
    if (!/collectSearchMatches\(b, q, \{ fullText: isFullText, snippetOf: extractMatchSnippet \}\)/.test(kanban)) problems.push("kanban 未委托唯一实现");
    if (/\.toLowerCase\(\)\.includes\(lowerQ\)/.test(kanban)) problems.push("kanban 残留内联匹配");
    if (!/filterCandidateMatches\(peerPool, query, \{ limit: RELATION_PEER_LIMIT \}\)/.test(panel)) problems.push("面板未委托唯一实现");
    if (/\.toLowerCase\(\)\.includes\(/.test(panel)) problems.push("面板自带第二套匹配");
    return problems;
  };
  assert.deepEqual(checker(KANBAN_SRC, panelSlice(MODAL_SRC)), [], "真实源码必须零问题");

  const backToInline = KANBAN_SRC.replace(
    "const matches = collectSearchMatches(b, q, { fullText: isFullText, snippetOf: extractMatchSnippet });",
    "const lowerQ = q.toLowerCase();\n        const matches = [];\n        for (const c of candidates) { if (String(c.title).toLowerCase().includes(lowerQ)) matches.push(c); }",
  );
  assert.notEqual(backToInline, KANBAN_SRC, "变异锚点必须存在");
  assert.ok(checker(backToInline, panelSlice(MODAL_SRC)).length > 0, "还原内联匹配必须判红");

  const panelOwnMatch = MODAL_SRC.replace(
    "filterCandidateMatches(peerPool, query, { limit: RELATION_PEER_LIMIT })",
    "peerPool.filter((p) => String(p.title).toLowerCase().includes(query.toLowerCase()))",
  );
  assert.notEqual(panelOwnMatch, MODAL_SRC, "变异锚点必须存在");
  assert.ok(checker(KANBAN_SRC, panelSlice(panelOwnMatch)).length > 0, "面板自带匹配必须判红");
});

// ===========================================================================
// 判据 3：规模与响应（~400 目标根下的**实测数字**）
// ===========================================================================
test("g-381 判据3（实测）：400 目标池逐键过滤耗时 + 渲染节点数上限（确定性候选上限）", () => {
  // ① 纯过滤实测：模拟 20 次逐键输入（每键一次完整过滤），记录单次耗时
  const queries = ["g", "g-", "g-1", "g-10", "g-101", "看", "看板", "看板渲", "看板渲染", "关", "关系", "关系标", "关系标记", "z", "zz", "zzz", "g-4", "g-40", "g-401", "星云检索"];
  const samples: number[] = [];
  for (const q of queries) {
    const t0 = performance.now();
    const res = filterCandidateMatches(PEER_POOL, q, { limit: RELATION_PEER_LIMIT });
    samples.push(performance.now() - t0);
    assert.ok(res.items.length <= RELATION_PEER_LIMIT, `候选上限必须生效（实得 ${res.items.length}）`);
    assert.ok(res.total >= res.items.length, "total 是真实命中数（截断只影响渲染集合）");
  }
  const max = Math.max(...samples);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  assert.ok(avg < 5, `单键过滤均耗应 <5ms（实测 ${avg.toFixed(3)}ms）`);
  assert.ok(max < 25, `单键过滤最坏应 <25ms（实测 ${max.toFixed(3)}ms）`);

  // ② 候选上限的确定性语义
  const capped = filterCandidateMatches(PEER_POOL, "看板渲染", { limit: RELATION_PEER_LIMIT });
  assert.equal(capped.items.length, RELATION_PEER_LIMIT, "命中数超上限时渲染集合恰为上限");
  assert.equal(capped.limited, true);
  assert.ok(capped.total > RELATION_PEER_LIMIT);
  const uncapped = filterCandidateMatches(PEER_POOL, "看板渲染", { limit: 0 });
  assert.equal(uncapped.items.length, uncapped.total, "limit=0 ⇒ 不截断（仅用于对照/测试）");
  // 空查询首屏也有上限（打开面板不挂载 400 项）
  const blank = filterCandidateMatches(PEER_POOL, "", { limit: RELATION_PEER_LIMIT });
  assert.equal(blank.items.length, RELATION_PEER_LIMIT);
  assert.equal(blank.total, PEER_POOL.length);
  assert.equal(blank.limited, true);

  console.log(`evidence: g381 filter-400 peers=${PEER_POOL.length} keys=${queries.length} avg=${avg.toFixed(3)}ms max=${max.toFixed(3)}ms cap=${RELATION_PEER_LIMIT}`);
});

test("g-381 判据3（渲染级实测）：~400 目标根下逐键输入，单次渲染 option 节点数 ≤ 上限", async () => {
  const h = createHarness();
  const { input } = await openRelationPanel(h);
  assert.ok(PEER_POOL.length >= 400, `候选池规模约 400（实得 ${PEER_POOL.length}）`);

  const keys = ["g", "g-", "g-1", "g-10", "看板", "看板渲染"];
  const nodeCounts: number[] = [];
  const costs: number[] = [];
  let cur = input;
  for (const k of keys) {
    const t0 = performance.now();
    cur.props.onChange({ target: { value: k } });
    const r = await h.settle();
    costs.push(performance.now() - t0);
    const opts = optionsOf(r.passElements());
    nodeCounts.push(opts.length);
    assert.ok(opts.length <= RELATION_PEER_LIMIT,
      `按键「${k}」单次渲染 option 节点数必须 ≤${RELATION_PEER_LIMIT}（实得 ${opts.length}，全量 400 会卡）`);
    assert.ok(opts.length > 0, `按键「${k}」应有候选`);
    cur = inputOf(r.passElements())!;
    assert.ok(cur, `按键「${k}」后输入框仍在（不崩）`);
  }
  const maxNodes = Math.max(...nodeCounts);
  const maxCost = Math.max(...costs);
  assert.ok(maxNodes <= RELATION_PEER_LIMIT, `单次渲染节点数上限（实测 ${maxNodes}）`);
  console.log(`evidence: g381 render-400 keys=${keys.length} maxOptNodes=${maxNodes} maxKeyToPaint=${maxCost.toFixed(1)}ms cap=${RELATION_PEER_LIMIT}`);

  // 负向对照 N2：不设上限 ⇒ 渲染节点数暴涨，守卫必红
  const unlimited = filterCandidateMatches(PEER_POOL, "看板渲染", { limit: 0 });
  assert.ok(unlimited.items.length > RELATION_PEER_LIMIT,
    `去掉上限后命中数远超上限（${unlimited.items.length}）⇒ 「≤${RELATION_PEER_LIMIT}」断言必然不成立（红）`);
});

// ===========================================================================
// 判据 1：搜索输入框 + 键盘可达 + 既有 add 流程
// ===========================================================================
test("g-381 判据1（渲染级）：编号命中 / 关键字命中 / 空结果态 / Esc 关闭", async () => {
  const h = createHarness();
  const { input } = await openRelationPanel(h);

  // ① 编号命中（大小写归一：输入 G-401）
  input.props.onChange({ target: { value: "G-401" } });
  let r = await h.settle();
  let opts = optionsOf(r.passElements());
  assert.equal(opts.length, 1, `编号查询应精确命中 1 条（实得 ${opts.length}）`);
  assert.match(treeText(opts[0]), /g-401/, "命中项显示编号");
  assert.match(treeText(opts[0]), /星云检索/, "命中项显示标题（编号+标题标签）");

  // ② 关键字命中（唯一关键字）
  inputOf(r.passElements()).props.onChange({ target: { value: "星云检索" } });
  r = await h.settle();
  opts = optionsOf(r.passElements());
  assert.equal(opts.length, 1, "关键字查询命中唯一目标");
  assert.match(treeText(opts[0]), /g-401/);

  // ③ 空结果态（可读文案，不白屏）
  inputOf(r.passElements()).props.onChange({ target: { value: "zzz-绝不存在" } });
  r = await h.settle();
  assert.equal(optionsOf(r.passElements()).length, 0, "零命中不渲染候选");
  const empty = withClass(r.passElements(), "dg-relation-peer-empty");
  assert.equal(empty.length, 1, "零命中必须有可读空态");
  assert.equal(treeText(empty[0]), zh["relation.noMatch"], "空态走 i18n 词条");

  // ④ Esc 关闭（列表收起；不崩）
  inputOf(r.passElements()).props.onChange({ target: { value: "g-1" } });
  r = await h.settle();
  assert.ok(optionsOf(r.passElements()).length > 0, "列表已展开");
  let prevented = 0;
  inputOf(r.passElements()).props.onKeyDown({ key: "Escape", preventDefault: () => { prevented++; } });
  r = await h.settle();
  assert.equal(optionsOf(r.passElements()).length, 0, "Esc 后列表关闭");
  assert.ok(prevented > 0, "Esc 必须 preventDefault");
});

test("g-381 判据1（渲染级）：↑↓ 选择 / Enter 确认 ⇒ 复用既有 add 流程（POST + base_relations 语义不变）", async () => {
  const h = createHarness();
  const { input } = await openRelationPanel(h);

  input.props.onChange({ target: { value: "看板渲染" } });
  let r = await h.settle();
  let opts = optionsOf(r.passElements());
  assert.ok(opts.length >= 2, "多条候选用于键盘导航");
  assert.equal(opts[0].props["aria-selected"], "true", "默认高亮第一项");

  // ↓ 移动高亮
  let prevented = 0;
  inputOf(r.passElements()).props.onKeyDown({ key: "ArrowDown", preventDefault: () => { prevented++; } });
  r = await h.settle();
  opts = optionsOf(r.passElements());
  assert.equal(opts[1].props["aria-selected"], "true", "↓ 后高亮第二项");
  // ↑ 回到第一项
  inputOf(r.passElements()).props.onKeyDown({ key: "ArrowUp", preventDefault: () => {} });
  r = await h.settle();
  assert.equal(optionsOf(r.passElements())[0].props["aria-selected"], "true", "↑ 后回到第一项");
  assert.ok(prevented > 0, "方向键必须 preventDefault（不滚动页面）");

  // Enter 确认 ⇒ 选中 + 列表收起 + 可读「已选」
  const targetId = String(optionsOf(r.passElements())[0].props.id).replace("dg-relation-peer-opt-", "");
  inputOf(r.passElements()).props.onKeyDown({ key: "Enter", preventDefault: () => { prevented++; } });
  r = await h.settle();
  const selected = withClass(r.passElements(), "dg-relation-peer-selected");
  assert.equal(selected.length, 1, "选中后出现「已选」行");
  assert.match(treeText(selected[0]), new RegExp(targetId), "已选行显示所选目标");
  assert.equal(optionsOf(r.passElements()).length, 0, "确认后列表收起");

  // 点「添加标记」⇒ 走既有 add 流程（POST /api/dsh-graph/relations + base_relations）
  const addBtn = r.passElements().filter((e) => e?.type === "button" && treeText(e) === zh["relation.addBtn"]).pop();
  assert.ok(addBtn, "「添加标记」按钮存在");
  const before = h.fetchLog.length;
  addBtn.props.onClick();
  r = await waitFor(h, (rr) => rr.passElements().some((e) => treeText(e).includes(zh["relation.saved"])));
  const posts = h.fetchLog.slice(before).filter((f) => f.url.includes("/api/dsh-graph/relations") && f.init?.method === "POST");
  assert.equal(posts.length, 1, "选中后必须走既有 POST 通道（无旁路）");
  const body = JSON.parse(String(posts[0].init.body));
  assert.equal(body.action, "add");
  assert.equal(body.target, targetId, "POST target == 键盘选中的目标");
  assert.equal(body.goal, "g-1");
  assert.ok(Array.isArray(body.base_relations), "base_relations 乐观并发基准语义不变");
  assert.ok(typeof body.type === "string" && body.type.length > 0);

  // 选中后关系行即时反映（一次成功回包后重取，非轮询）
  const okNote = r.passElements().find((e) => treeText(e).includes(zh["relation.saved"]));
  assert.ok(okNote, "成功回包后有可见成功提示（重取一次）");
  // 读取次数是**确定的 3 次**：挂载 1 + 写入前取 base_relations 1 + 成功回包后重取 1（非轮询）
  const relationGets = h.fetchLog.filter((f) => f.url.includes("/api/dsh-graph/relations") && !f.init?.method).length;
  assert.equal(relationGets, 3, "关系读取恰 3 次（挂载 / base_relations / 成功后重取），无第 4 次即非轮询");
});

test("g-381 判据1：未选中就对端为空时，仍给可操作提示（既有语义不变）", async () => {
  const h = createHarness();
  const { input } = await openRelationPanel(h);
  input.props.onChange({ target: { value: "星云检索" } });
  let r = await h.settle();
  assert.equal(optionsOf(r.passElements()).length, 1);
  // 只输入不确认 ⇒ 不构成选中
  const addBtn = r.passElements().filter((e) => e?.type === "button" && treeText(e) === zh["relation.addBtn"]).pop();
  const before = h.fetchLog.length;
  addBtn.props.onClick();
  r = await h.settle();
  assert.equal(h.fetchLog.slice(before).filter((f) => f.init?.method === "POST").length, 0, "未选中不得发起写入");
  assert.ok(r.passElements().some((e) => treeText(e).includes(zh["relation.needTarget"])), "给出「请先选择对端目标」提示");
});

test("g-381 判据4（渲染级）：非法输入不崩；零命中/上限提示可读；请求失败不白屏", async () => {
  const h = createHarness();
  const { input } = await openRelationPanel(h);
  let r = await h.settle();
  let cur = input;
  for (const bad of [undefined, null, "", "   ", "###", "%", "g-".repeat(400), "🙂🔗", "\u0000\u0007"]) {
    cur.props.onChange({ target: { value: bad as any } });
    r = await h.settle();
    assert.ok(optionsOf(r.passElements()).length <= RELATION_PEER_LIMIT,
      `非法输入 ${String(bad).slice(0, 12)} 渲染不得超上限`);
    cur = inputOf(r.passElements())!;
    assert.ok(cur, "非法输入后面板仍完整（不崩）");
  }
  // 上限提示：命中数 > 上限 ⇒ 可读提示（含真实命中数与上限）
  inputOf(r.passElements()).props.onChange({ target: { value: "看板渲染" } });
  r = await h.settle();
  const limit = withClass(r.passElements(), "dg-relation-peer-limit");
  assert.equal(limit.length, 1, "命中超上限必须有可读提示（不静默截断）");
  const txt = treeText(limit[0]);
  assert.match(txt, new RegExp(String(RELATION_PEER_LIMIT)), "提示含上限数字");
  assert.match(txt, /共 \d+ 项/, "提示含真实命中数");

  // 请求失败不白屏：relations GET 返回失败 ⇒ 面板仍完整渲染 + 可见 loadFail 文案
  const h2 = createHarness({ failRelations: true });
  const { r: r0 } = await openRelationPanel(h2);
  assert.ok(inputOf(r0.passElements()), "关系读取失败时面板仍渲染（不白屏）");
  const visible = r0.passElements().map((e) => treeText(e)).join(" ");
  assert.ok(visible.includes(zh["relation.loadFail"]), `失败必须可见（缺 ${zh["relation.loadFail"]}）`);
  const fails = h2.fetchLog.filter((f) => f.url.includes("/api/dsh-graph/relations"));
  assert.equal(fails.length, 1, "面板只在挂载时读取关系一次（非轮询）");
  assert.equal(fails.filter((f) => f.init?.method === "POST").length, 0, "读取失败不得触发写入");
});

test("g-381 判据4：无新增 setInterval/setTimeout/watchFile/fs.watch/EventSource/WebSocket（面板内）", () => {
  const panel = panelSlice(MODAL_SRC);
  assert.ok(panel.length > 0);
  assert.doesNotMatch(panel, /\bsetInterval\b/, "面板不得引入 setInterval（轮询）");
  assert.doesNotMatch(panel, /\bsetTimeout\b/, "面板不得引入 setTimeout（节流/防抖定时器）");
  assert.doesNotMatch(panel, /watchFile|fs\.watch|EventSource|new WebSocket|requestAnimationFrame/,
    "面板不得引入 watcher/长连接/rAF");
  // 规模手段是**确定性**候选上限（而非节流）
  assert.match(panel, /RELATION_PEER_LIMIT/, "规模靠确定性候选上限");
});

test("g-381 判据4：i18n zh/en 对称、新增键 en 零 CJK、占位符两语齐全", () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "client i18n zh/en 键集必须对称");
  const added = ["relation.searchHint", "relation.noMatch", "relation.limitHint", "relation.selected", "relation.addTargetPlaceholder"];
  for (const k of added) {
    assert.ok(zh[k] && zh[k].length > 0, `zh ${k} 缺失`);
    assert.ok(en[k] && en[k].length > 0, `en ${k} 缺失`);
    assert.doesNotMatch(en[k], /[\u3400-\u9fff]/, `en ${k} 含 CJK：${en[k]}`);
  }
  assert.match(zh["relation.limitHint"], /\{limit\}/);
  assert.match(zh["relation.limitHint"], /\{count\}/);
  assert.match(en["relation.limitHint"], /\{limit\}/);
  assert.match(en["relation.limitHint"], /\{count\}/);
  assert.match(zh["relation.selected"], /\{label\}/);
  assert.match(en["relation.selected"], /\{label\}/);
  assert.match(zh["relation.addTargetPlaceholder"], /搜索|输入/);
  assert.match(en["relation.addTargetPlaceholder"], /search/i);
  // 面板用到的键两语齐全（含动态拼接之外的全部字面键）
  const panel = panelSlice(MODAL_SRC);
  for (const key of new Set([...panel.matchAll(/dgT\("([^"]+)"/g)].map((m) => m[1]))) {
    if (key.startsWith("card.relType.")) continue;
    assert.notEqual(zh[key], undefined, `zh 缺少面板用到的键 ${key}`);
    assert.notEqual(en[key], undefined, `en 缺少面板用到的键 ${key}`);
    assert.doesNotMatch(en[key], /[\u3400-\u9fff]/, `en.${key} 含 CJK`);
  }
});

test("g-381 判据5：dist bundle 已同步搜索式对端选择（未 rebuild 即红），且无第三方搜索/虚拟列表库", () => {
  for (const needle of ["dg-relation-peer-input", "dg-relation-peer-list", "dg-relation-peer-option", "filterCandidateMatches", "RELATION_PEER_LIMIT", "relation.noMatch"]) {
    assert.ok(BUNDLE_SRC.includes(needle), `dist/lib/client.js 未含 ${needle}（需 rebuild）`);
  }
  assert.ok(!BUNDLE_SRC.includes("dg-relation-peer-select-fallback"), "不得保留旧下拉回退通道");
  for (const lib of ["react-window", "react-virtualized", "virtuoso", "fuse.js", "fuzzy-search", "downshift", "cmdk", "select2", "choices.js"]) {
    assert.ok(!MODAL_SRC.includes(lib) && !MATCH_SRC.includes(lib), `不得引入第三方搜索/虚拟列表库（命中 ${lib}）`);
  }
  // build 接线：新模块必须进 PARTS（否则真机 ReferenceError）
  const buildScript = readFileSync(join(root, "scripts/build-client.sh"), "utf8");
  assert.match(buildScript, /"search-match"/, "build-client PARTS 必须收录 search-match");
  const parts = [...buildScript.slice(buildScript.indexOf("PARTS=("), buildScript.indexOf("\n)", buildScript.indexOf("PARTS=("))).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const modules = readdirSync(modDir).filter((f) => f.endsWith(".js")).map((f) => f.slice(0, -3));
  assert.deepEqual([...parts].sort(), [...modules].sort(), "PARTS 必须覆盖全部客户端模块");
  assert.ok(parts.indexOf("search-match") > parts.indexOf("search-groups"), "search-match 依赖 search-groups 的 versionLaneKey，必须排在其后");
});

test("g-381：goalCandidateLabel 与既有下拉文案同形（编号 + 标题，标题等于编号时不重复）", () => {
  assert.equal(goalCandidateLabel({ id: "g-1", title: "标题" }), "g-1 标题");
  assert.equal(goalCandidateLabel({ id: "g-1", title: "g-1" }), "g-1");
  assert.equal(goalCandidateLabel({ id: "g-1" }), "g-1");
  assert.equal(goalCandidateLabel(null), "");
});
