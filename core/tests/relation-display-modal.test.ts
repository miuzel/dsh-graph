/**
 * rel-display-018：目标弹窗「目标描述」小节内**直接可见的只读关系清单**。
 *
 * 背景（负责人点名的小细节）：关系此前只在看板卡片上可见——进入 goal 弹窗后必须点开
 * 「🔗 标记关系」编辑面板才能看到。本改动把清单直接渲染在描述正文下方，编辑入口保持不变。
 *
 * 分工（与仓库既有客户端测试口径一致）：
 *  - 本套件 = **真实渲染级**（vm 装载 dist/lib/client.js + 迷你 React，真组件真调用、真点击）
 *    + 源码级复用契约（唯一实现 / 禁第二套关系逻辑）+ i18n / bundle 新鲜度的机器断言；
 *  - 视觉层（有关系 / 无关系两张截图）由隔离实例（`scripts/dsh-test-web.sh`）实机核验，见证据台账。
 *
 * 断言面：
 *  A. 位置：清单渲染在「目标描述」小节**内**、描述正文**下方**（不是另起一套小节/面板）；
 *  B. 零空壳：无关系时不渲染清单、不渲染徽标、不留下任何空 div；
 *  C. 降级：悬空（未知 id / 已删除）/ 已归档 / 跨版本 文案与看板卡片逐字一致，且不抛错；
 *  D. 复用：渲染走 card.js 的 RelationBadges + RelationList（唯一实现），弹窗侧零关系/匹配逻辑
 *     （含负向对照：把弹窗侧换成内联第二套渲染 ⇒ 守卫必红）；
 *  E. i18n：清单用到的键 zh/en 齐全、键集对称、en 零 CJK（复用既有键，无需新增）；
 *  F. bundle 新鲜度：dist/lib/client.js 必须已含弹窗侧清单（未 rebuild 即红）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const root = join(import.meta.dirname, "../..");
const hostRoot = join(root, "dsh-graph-host");
const modDir = join(hostRoot, "lib/client");
const readSrc = (name: string) => readFileSync(join(modDir, `${name}.js`), "utf8");

const MODAL_SRC = readSrc("goal-modal");
const KANBAN_SRC = readSrc("kanban");
const CARD_SRC = readSrc("card");
const I18N_SRC = readSrc("i18n");
const BUNDLE_SRC = readFileSync(join(root, "dist/lib/client.js"), "utf8");

/** 客户端 i18n 字典（与 g281/g380/g381 同一装载口径）。 */
function loadClientI18n() {
  const sandbox: any = { React: {} };
  vm.runInNewContext(I18N_SRC + "; this.zh = zh; this.en = en;", sandbox);
  return { zh: sandbox.zh as Record<string, string>, en: sandbox.en as Record<string, string> };
}
const { zh, en } = loadClientI18n();

/** `DescriptionBox` 组件本体切片：从函数头到「评论组件」注释为止（关系清单落点断言只打在这里）。 */
function descriptionSlice(src: string): string {
  const start = src.indexOf("function DescriptionBox(");
  const end = src.indexOf("// g-150：评论组件", start);
  return start < 0 || end <= start ? "" : src.slice(start, end);
}

// ---------------------------------------------------------------------------
// 夹具：看板 payload（关系挂在 board 投影上，与真实服务端下发同形）
// ---------------------------------------------------------------------------
const REL_RICH = {
  outgoing: [
    { type: "supersedes", goal: "g-2", title: "对端目标" },
    { type: "extends", goal: "g-5", title: "补充目标", cross_version: true },
  ],
  incoming: [
    { type: "supersedes", goal: "g-9", title: "旧目标" },
  ],
};
const REL_DANGLING = {
  outgoing: [{ type: "supersedes", goal: "g-999", missing: true }],
  incoming: [{ type: "amends", goal: "g-777", archived: true }],
};
const REL_EMPTY = { outgoing: [], incoming: [] };

const mkGoal = (id: string, title: string, extra: any = {}) =>
  ({ id, title, status: "planning", type: "improvement", tags: [], criteria_count: 0, cards_count: 0, ...extra });

function boardWith(relOf: Record<string, any>) {
  const goals = [
    mkGoal("g-1", "关系清单验收目标", "g-1" in relOf ? { relations: relOf["g-1"] } : {}),
    mkGoal("g-2", "对端目标", "g-2" in relOf ? { relations: relOf["g-2"] } : {}),
    mkGoal("g-3", "无关系目标", "g-3" in relOf ? { relations: relOf["g-3"] } : {}),
  ];
  return {
    lazy: false, backlog_loaded: true, backlog_count: 0,
    generated_at: "2026-10-02T00:00:00Z", supervisorSession: null,
    versions: [{ slug: "v0.18.0", name: "V0.18.0", status: "active", goals, goals_count: goals.length, lazy: false, loaded: true }],
    standalone: [], backlog: [],
  };
}

/** 目标详情（GoalModal 的 GET /api/dsh-graph/goal 回包）——描述正文含目标编号，供跳转断言。 */
const goalDetail = (id: string) => ({
  description: `目标 ${id} 的描述正文`,
  body: `## 目标描述\n\n目标 ${id} 的描述正文\n`,
  meta: { id, title: `目标 ${id}`, status: "planning", type: "improvement", version: "v0.18.0", depends_on: [], relations: [] },
  cards: [], attempts: [], worktrees: { status: "ok", items: {} }, events: [],
  comments: [], directive: null,
});

// ---------------------------------------------------------------------------
// 真实渲染 harness（vm + 迷你 React；与 g352/g367/g381 同口径，仅保留本目标所需能力）
// ---------------------------------------------------------------------------
interface RenderResult { passElements: () => any[]; root: () => any }

function createHarness(opts: { relOf?: Record<string, any>; bundle?: string } = {}) {
  const bundle = opts.bundle ?? BUNDLE_SRC;
  const board = boardWith(opts.relOf ?? {});
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
        if (init && init.method === "POST") return json({ ok: true });
        return json({ ok: true, outgoing: [], incoming: [] });
      }
      if (u.includes("/api/dsh-graph/version-detail")) return json({ slug: "v0.18.0", goals: [], goals_count: 0 });
      if (u.includes("/api/dsh-graph/version-goals")) return json({ goals: [] });
      if (u.includes("/api/dsh-graph/backlog-goals")) return json({ goals: [] });
      if (u.includes("/api/dsh-graph/order")) return json({});
      if (u.includes("/api/dsh-graph")) return json(board);
      return json({});
    },
    ResizeObserver: class { constructor(_cb: any) {} observe() {} disconnect() {} unobserve() {} },
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
  async function settle(props: any = { sessionId: "s1", host: "sidebar" }, maxPasses = 30): Promise<RenderResult> {
    const KanbanView = cv!.renderer(props).type;
    let tree: any = null;
    for (let p = 0; p < maxPasses; p++) {
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

/**
 * 迷你 React 只展开白名单组件（与 g381 同机制，hook 归属按调用者函数身份）。
 * 白名单收窄到「目标详情 → 描述区 → 关系渲染」这条真实链路 + 两个既有关系渲染组件本体。
 */
const EXPAND_COMPONENTS = new Set(["GoalModal", "DescriptionBox", "RelationBadges", "RelationList", "RelationMarker"]);
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

/** 子树前序遍历（= DOM 次序）；数组子节点（`map` 结果）会被展平。 */
function treeOf(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) treeOf(n, out); return out; }
  if (node.type) { out.push(node); treeOf(node.children, out); }
  return out;
}

/** 打开目标详情弹窗（点看板卡片，与真实交互同一入口）。 */
async function openModal(h: ReturnType<typeof createHarness>, goalId = "g-1") {
  let r = await h.settle();
  const card = r.passElements().find((e) => e?.props?.["data-goal-id"] === goalId);
  assert.ok(card, `看板里存在 ${goalId} 的卡片（用于打开详情弹窗）`);
  card.props.onClick();
  r = await h.settle();
  return r;
}

/** 反复 settle 直到谓词成立（用于 await 链：跳转 → GET goal → setState）。 */
async function waitFor(h: ReturnType<typeof createHarness>, pred: (r: RenderResult) => boolean, tries = 10) {
  let r = await h.settle();
  for (let i = 0; i < tries; i++) {
    if (pred(r)) return r;
    for (let k = 0; k < 4; k++) await new Promise((res) => setImmediate(res));
    r = await h.settle();
  }
  return r;
}

/** 关系渲染节点（清单 / 徽标）——不含「🔗 标记关系」入口按钮（dg-relation-mark-btn）。 */
const isRelationNode = (e: any) => /dg-relation-(list|badge)/.test(elClass(e));

/**
 * 弹窗「目标描述」小节：容器 + 子树（DOM 次序）。
 * 描述正文的两层祖先 = body 容器 → 小节（避免把 body 容器当成小节）。
 */
function descriptionSection(els: any[]) {
  const descMd = els.find((e) => e?.type?.name === "GoalMarkdown");
  assert.ok(descMd, "弹窗描述正文组件存在（GoalMarkdown）");
  const bodyWrap = els.find((e) => Array.isArray(e.children) && e.children.includes(descMd));
  assert.ok(bodyWrap, "描述正文位于既有 body 容器内");
  const section = els.find((e) => Array.isArray(e.children) && e.children.includes(bodyWrap));
  assert.ok(section, "body 容器位于「目标描述」小节内");
  return { descMd, bodyWrap, section, subtree: treeOf(section) };
}

/** 小节作用域内取只读清单（避免误命中看板卡片上的同名清单）。 */
function modalRelationLists(els: any[]) {
  const info = descriptionSection(els);
  return { ...info, lists: info.subtree.filter((e) => elClass(e).includes("dg-relation-list")) };
}

// ===========================================================================
// 判据 A：有关系时，清单直接渲染在「目标描述」小节内、描述正文正下方
// ===========================================================================
test("rel-display-018 A（渲染级）：有关系时清单渲染在描述正文下方，出向/入向与徽标同现", async () => {
  const t0 = performance.now();
  const h = createHarness({ relOf: { "g-1": REL_RICH } });
  const r = await openModal(h);
  const els = r.passElements();

  // 未点开「🔗 标记关系」面板（无面板节点）也能看到清单 ⇒ 修复「必须点开面板才可见」
  assert.equal(withClass(els, "dg-relation-marker").length, 0, "默认不展开编辑面板（清单不依赖面板）");
  assert.equal(withClass(els, "dg-relation-peer-input").length, 0, "编辑面板未打开");

  const { subtree, bodyWrap } = modalRelationLists(els);
  const lists = subtree.filter((e) => elClass(e).includes("dg-relation-list"));
  assert.equal(lists.length, 1, "「目标描述」小节内存在唯一只读关系清单（.dg-relation-list）");
  const badges = subtree.filter((e) => elClass(e).includes("dg-relation-badge"));
  assert.equal(badges.length, 1, "既有关系徽标同现（入向 supersedes）");
  assert.ok(elClass(badges[0]).includes("dg-relation-supersedes"), "徽标沿用既有 className 语义");

  // 文案：清单标题 + 行（既有 i18n 键，出向 → / 入向 ←）
  const txt = treeText(lists[0]);
  assert.match(txt, new RegExp(zh["card.relationsTitle"]), "清单带既有标题（card.relationsTitle）");
  assert.match(txt, new RegExp(`${zh["card.relType.supersedes"]} →`), "出向行：既有类型文案 + →");
  assert.match(txt, new RegExp(`${zh["card.relType.extends"]} →`), "出向 extends 行");
  assert.match(txt, new RegExp(`${zh["card.relType.supersedes"]} ←`), "入向行：既有类型文案 + ←");
  assert.match(txt, /g-2\s+对端目标/, "出向对端显示「编号 标题」");
  assert.match(txt, new RegExp(zh["card.relationCrossVersion"]), "跨版本标记沿用既有键");
  assert.match(treeText(badges[0]), /已被 g-9 取代/, "徽标文案 = 既有 card.superseded 词条");

  // 位置：同一个「目标描述」小节内、描述正文**下方**（DOM 次序：描述 → 徽标 → 清单）
  const iBody = subtree.indexOf(bodyWrap);
  const iBadge = subtree.indexOf(badges[0]);
  const iList = subtree.indexOf(lists[0]);
  assert.ok(iBody >= 0 && iBadge > iBody, `徽标必须在描述正文下方（body=${iBody} badge=${iBadge}）`);
  assert.ok(iList > iBody, `清单必须在描述正文下方（body=${iBody} list=${iList}）`);
  assert.ok(iList > iBadge, "清单在徽标之后（与看板卡片同一节点次序）");
  const section = descriptionSection(els).section;
  assert.ok(section.children.includes(lists[0]), "清单是「目标描述」小节的直接内容（不是另起小节/面板）");

  console.log(`evidence: rel-display-018 A rows=3 badges=1 body=${iBody} badge=${iBadge} list=${iList} ms=${(performance.now() - t0).toFixed(1)}`);
});

// ===========================================================================
// 判据 A2：跳转对端复用既有 onOpen（弹窗内切到对端详情）；悬空行不跳转
// ===========================================================================
test("rel-display-018 A2（渲染级）：点清单行跳转对端（复用 kanban 既有 setModalGoal 通道）", async () => {
  const h = createHarness({ relOf: { "g-1": REL_RICH } });
  let r = await openModal(h);
  const { lists } = modalRelationLists(r.passElements());
  assert.equal(lists.length, 1, "小节内清单存在");
  // 行内可点对端 = 带 onClick 的 span（textDecoration underline / cursor pointer）
  const clickable = treeOf(lists[0]).filter((e) => e?.props?.onClick);
  const targetSpan = clickable.find((s) => treeText(s).includes("g-2"));
  assert.ok(targetSpan, "出向行有可点击的对端节点（跳转对端能力）");
  assert.match(String(targetSpan.props.title), /g-2/, "悬停提示沿用既有 card.relationJump 词条");

  const before = h.fetchLog.filter((f) => f.url.includes("/api/dsh-graph/goal")).length;
  targetSpan.props.onClick({ stopPropagation() {} });
  const showsPeer = (rr: RenderResult) =>
    (rr.passElements().find((e) => e?.type?.name === "GoalMarkdown")?.props?.text ?? "") === "目标 g-2 的描述正文";
  r = await waitFor(h, showsPeer);
  const asked = h.fetchLog.filter((f) => f.url.includes("/api/dsh-graph/goal")).slice(before);
  assert.ok(asked.some((f) => f.url.includes("id=g-2")), `点击对端必须打开 g-2 详情（实得 ${asked.map((f) => f.url).join(",")}）`);
  assert.ok(showsPeer(r), "弹窗正文已切到对端目标（GoalMarkdown.text == 对端描述）");

  // 悬空对端：不可点击（不跳转、不抛错）
  const h2 = createHarness({ relOf: { "g-1": REL_DANGLING } });
  const r2 = await openModal(h2);
  const { lists: lists2 } = modalRelationLists(r2.passElements());
  assert.equal(lists2.length, 1, "悬空时清单仍在（降级为不可点，不消失）");
  const missingSpan = treeOf(lists2[0]).filter((e) => e?.props?.onClick).find((s) => treeText(s).includes("g-999"));
  assert.ok(missingSpan, "悬空对端节点存在（但降级为不可跳转）");
  const before2 = h2.fetchLog.length;
  missingSpan.props.onClick({ stopPropagation() {} }); // 不抛错即为不白屏
  const r2b = await waitFor(h2, (rr) => rr.passElements().some((e) => treeText(e).includes("未知 id / 已删除")));
  assert.equal(h2.fetchLog.slice(before2).filter((f) => f.url.includes("id=g-999")).length, 0, "悬空对端不得发起跳转请求");
  const after = modalRelationLists(r2b.passElements());
  assert.equal(after.lists.length, 1, "降级后弹窗与清单均完整（不白屏）");
  assert.match(treeText(after.lists[0]), /g-999（未知 id \/ 已删除）/, "降级文案可见");
});

// ===========================================================================
// 判据 B：无关系时描述下方零渲染（无清单 / 无徽标 / 无空壳 div）
// ===========================================================================
test("rel-display-018 B（渲染级）：无关系时描述下方零渲染（无清单、无徽标、无空壳）", async () => {
  for (const [label, relOf] of [
    ["缺 relations 字段", {}],
    ["空 relations 数组", { "g-1": REL_EMPTY }],
  ] as Array<[string, Record<string, any>]>) {
    const h = createHarness({ relOf });
    const r = await openModal(h);
    const els = r.passElements();
    const { subtree, section } = modalRelationLists(els);

    // 无关系目标：看板卡片与弹窗内都不该有关系节点
    assert.equal(withClass(els, "dg-relation-list").length, 0, `${label}：任何位置都不得渲染关系清单`);
    assert.equal(withClass(els, "dg-relation-badge").length, 0, `${label}：任何位置都不得渲染关系徽标`);
    assert.equal(subtree.filter(isRelationNode).length, 0, `${label}：描述小节内零关系渲染节点`);

    // 零空壳：小节**直接子节点**内不得出现「既无文本、又无任何子元素」的 div
    // （内联第二套渲染 / 空包裹层 `h("div", null, null)` 都会命中这条）
    const shells = section.children.filter((c: any) =>
      c && typeof c.type === "string" && c.type === "div"
      && treeText(c).trim() === "" && treeOf(c).length === 1);
    assert.equal(shells.length, 0, `${label}：描述小节内不得留下空壳 div（实得 ${shells.length}）`);
    // 小节成员与未改动前完全一致：标题 + 描述 body 容器 + extra(AcceptFeedback) 三个非 null 子节点
    const nonNull = section.children.filter((c: any) => c != null);
    assert.equal(nonNull.length, 3, `${label}：小节内非空子节点数不变（标题 + 描述 + extra），实得 ${nonNull.length}`);
  }
});

// ===========================================================================
// 判据 C：悬空 / 归档 / 跨版本降级（与卡片逐字一致，且不抛错）
// ===========================================================================
test("rel-display-018 C（渲染级）：悬空/归档降级文案与看板卡片逐字一致，不抛错", async () => {
  const h = createHarness({ relOf: { "g-1": REL_DANGLING } });
  const r = await openModal(h);
  const { lists } = modalRelationLists(r.passElements());
  assert.equal(lists.length, 1, "悬空/归档关系仍渲染清单");
  const txt = treeText(lists[0]);
  assert.match(txt, /g-999（未知 id \/ 已删除）/, `悬空对端走既有降级文案（${zh["card.relationMissing"]}）`);
  assert.match(txt, /g-777（已归档）/, `已归档对端走既有降级文案（${zh["card.relationArchived"]}）`);
  assert.equal(zh["card.relationMissing"].replace("{id}", "g-999"), "g-999（未知 id / 已删除）");
  assert.equal(zh["card.relationArchived"].replace("{id}", "g-777"), "g-777（已归档）");
  // 与卡片同一渲染实现 ⇒ 弹窗侧不另写降级文案（真源仍在 card.js）
  assert.ok(CARD_SRC.includes("card.relationMissing") && CARD_SRC.includes("card.relationArchived"),
    "降级文案真源仍在 card.js（弹窗侧未另写一套）");
  // 归档对端保留跳转能力（既有语义：只有 missing 才不可点）
  const archivedSpan = treeOf(lists[0]).filter((e) => e?.props?.onClick).find((s) => treeText(s).includes("g-777"));
  assert.ok(archivedSpan, "已归档对端保留跳转能力（既有语义）");
  console.log(`evidence: rel-display-018 C missing="${zh["card.relationMissing"]}" archived="${zh["card.relationArchived"]}"`);
});

// ===========================================================================
// 判据 D：复用唯一实现（禁第二套关系逻辑；含负向对照）
// ===========================================================================
test("rel-display-018 D（源码级）：清单复用 card.js 唯一实现，弹窗描述区零第二套关系逻辑", () => {
  // ① RelationList / RelationBadges 全仓唯一实现（客户端模块内恰一处定义）
  for (const fn of ["RelationList", "RelationBadges"]) {
    const defining = readdirSync(modDir).filter((f) => f.endsWith(".js"))
      .filter((f) => new RegExp(`function ${fn}\\s*\\(`).test(readFileSync(join(modDir, f), "utf8")));
    assert.deepEqual(defining, ["card.js"], `${fn} 只能有一处定义（禁第二套关系行渲染）`);
  }

  // ② 弹窗描述区：直接渲染既有两个组件，数据只用看板投影透传的 relations
  const desc = descriptionSlice(MODAL_SRC);
  assert.ok(desc.length > 0, "DescriptionBox 组件存在");
  assert.match(desc, /h\(RelationBadges, \{ g: \{ relations \}, onOpen: onOpenGoal \}\)/,
    "描述区必须复用既有 RelationBadges（徽标）");
  assert.match(desc, /h\(RelationList, \{ g: \{ relations \}, onOpen: onOpenGoal \}\)/,
    "描述区必须复用既有 RelationList（行清单）");

  // ③ 弹窗描述区不得自带任何关系提取/匹配/排序（第二套逻辑），也不得新增关系数据通道
  for (const bad of [/\.relations\.(outgoing|incoming)/, /data\.(outgoing|incoming)/, /card\.relType\./, /\.filter\(\(r\)/, /\.find\(\(r\)/, /relationPeerLabel/, /relationIncoming/]) {
    assert.doesNotMatch(desc, bad, `描述区不得出现第二套关系逻辑：${bad}`);
  }
  assert.doesNotMatch(desc, /\bsetInterval\b|\bsetTimeout\b|fs\.watch|EventSource|new WebSocket|requestAnimationFrame/,
    "描述区不得引入轮询/定时器/watcher（判据同 g-380）");
  assert.doesNotMatch(desc, /api\/dsh-graph\/relations/,
    "只读清单不得新增关系数据通道/请求（数据来自看板投影透传）");

  // ④ 数据通道：kanban 侧把 board 投影的 relations 与既有 setModalGoal 透传（同一份派生数据）
  assert.match(KANBAN_SRC, /relations: modalGoalData\?\.relations,/, "kanban 必须透传 board 投影的 relations");
  assert.match(KANBAN_SRC, /onOpenGoal: setModalGoal,/, "跳转对端复用既有 setModalGoal");
  assert.match(MODAL_SRC, /relations: props\.relations, onOpenGoal: props\.onOpenGoal,/,
    "GoalModal → DescriptionBox 透传 relations/onOpenGoal");

  // 负向对照：把描述区换成内联第二套渲染/自带提取 ⇒ 守卫必红
  const checker = (src: string) => {
    const d = descriptionSlice(src);
    const problems: string[] = [];
    if (!/h\(RelationList, \{ g: \{ relations \}, onOpen: onOpenGoal \}\)/.test(d)) problems.push("未复用 RelationList");
    if (/\.relations\.(outgoing|incoming)/.test(d)) problems.push("自带关系提取（第二套）");
    if (/card\.relType\./.test(d)) problems.push("自带行渲染（第二套）");
    return problems;
  };
  assert.deepEqual(checker(MODAL_SRC), [], "真实源码必须零问题");

  const inline = MODAL_SRC.replace(
    "h(RelationBadges, { g: { relations }, onOpen: onOpenGoal }),\n        h(RelationList, { g: { relations }, onOpen: onOpenGoal }),",
    "h(\"div\", null, (relations?.outgoing ?? []).map((r) => h(\"div\", null, dgT(\"card.relType.\" + r.type) + \" → \" + r.goal))),",
  );
  assert.notEqual(inline, MODAL_SRC, "变异锚点必须存在（复用行被找到）");
  assert.ok(checker(inline).length > 0, "内联第二套渲染必须判红");
});

// ===========================================================================
// 判据 E：i18n —— 清单用到的键 zh/en 齐全、键集对称、en 零 CJK（无需新增键）
// ===========================================================================
test("rel-display-018 E（i18n）：清单用到的键 zh/en 齐全且 en 零 CJK，键集对称", () => {
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "client i18n zh/en 键集必须对称");
  // 清单渲染真源（card.js 的两个组件）用到的键 —— 本次改动**未新增任何键**，全部复用
  const relSrc = (() => {
    const start = CARD_SRC.indexOf("function RelationBadges(");
    const end = CARD_SRC.indexOf("// g-125：所有卡片统一用标题左侧小三角", start);
    return CARD_SRC.slice(start, end);
  })();
  assert.ok(relSrc.includes("RelationList"), "关系渲染真源切片有效");
  const used = [...relSrc.matchAll(/dgT\('([^']+)'/g)].map((m) => m[1])
    .filter((k) => !k.endsWith(".")); // 动态键前缀 `card.relType.` 由下面的显式枚举覆盖
  assert.match(relSrc, /dgT\('card\.relType\.' \+ r\.type\)/, "行类型文案走 card.relType.* 动态键");
  for (const t of ["supersedes", "amends", "extends", "related"]) used.push("card.relType." + t);
  for (const key of new Set(used)) {
    assert.ok(zh[key] !== undefined, `zh 缺少清单用到的键 ${key}`);
    assert.ok(en[key] !== undefined, `en 缺少清单用到的键 ${key}`);
    assert.doesNotMatch(en[key], /[\u3400-\u9fff]/, `en.${key} 含 CJK：${en[key]}`);
  }
  // 关键字面钉住（与负责人点名文案一致）
  assert.match(zh["card.relationMissing"], /未知 id \/ 已删除/);
  assert.match(zh["card.relationArchived"], /已归档/);
  assert.match(zh["card.superseded"], /已被 \{id\} 取代/);
  console.log(`evidence: rel-display-018 E keys=${new Set(used).size} zh/en-symmetric=ok en-cjk=0`);
});

// ===========================================================================
// 判别力（渲染级负向对照）：把弹窗侧清单从 bundle 里摘掉 ⇒ A/B 的渲染断言必红
// ===========================================================================
test("rel-display-018 负向对照（渲染级）：移除弹窗侧清单渲染 ⇒ 同一断言必红", async () => {
  const LIST_LINE = "h(RelationList, { g: { relations }, onOpen: onOpenGoal }),";
  const BADGE_LINE = "h(RelationBadges, { g: { relations }, onOpen: onOpenGoal }),";
  assert.equal(BUNDLE_SRC.indexOf(LIST_LINE), BUNDLE_SRC.lastIndexOf(LIST_LINE),
    "弹窗侧清单渲染在 bundle 中唯一（锚点可用）");

  // ① 只摘清单 ⇒ 有关系目标的小节内清单消失（A 必红），徽标仍在
  const noList = createHarness({ relOf: { "g-1": REL_RICH }, bundle: BUNDLE_SRC.replace(LIST_LINE, "") });
  const r1 = await openModal(noList);
  assert.equal(modalRelationLists(r1.passElements()).lists.length, 0, "摘掉清单后小节内不得再有清单 ⇒ A 的「清单在描述下方」必红");
  assert.equal(modalRelationLists(r1.passElements()).subtree.filter(isRelationNode).length, 1, "仅余徽标（对照：徽标未受影响）");

  // ② 两个都摘 ⇒ 无关系目标的「零渲染」不再有判别对象（A/B 的节点断言必红）
  const none = createHarness({ relOf: { "g-1": REL_RICH }, bundle: BUNDLE_SRC.replace(BADGE_LINE, "").replace(LIST_LINE, "") });
  const r2 = await openModal(none);
  assert.equal(modalRelationLists(r2.passElements()).subtree.filter(isRelationNode).length, 0, "摘掉两者后小节内零关系节点 ⇒ A 必红");
});

// ===========================================================================
// 判据 F：dist bundle 新鲜度（未 rebuild 即红）
// ===========================================================================
test("rel-display-018 F：dist bundle 已同步弹窗侧清单（未 rebuild 即红）", () => {
  assert.ok(BUNDLE_SRC.includes("h(RelationList, { g: { relations }, onOpen: onOpenGoal })"),
    "dist/lib/client.js 未含弹窗侧只读清单（需 rebuild）");
  assert.ok(BUNDLE_SRC.includes("rel-display-018"), "dist/lib/client.js 未含本次改动注释标记（需 rebuild）");
  assert.ok(BUNDLE_SRC.includes("relations: modalGoalData?.relations,"), "dist 未含 kanban 侧透传（需 rebuild）");
});
