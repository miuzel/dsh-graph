/**
 * g-615：客户端组件的**真实渲染 harness**（vm 装载 dist/lib/client.js + 迷你 React 渲染器）。
 *
 * 为什么需要它（而不是继续写源码正则断言）：
 *   实时面板的身份切换竞态、首帧残留、延迟乱序、follow 资源清理，本质都是**提交顺序**问题——
 *   「第 N 次提交时树里看到什么」「effect 何时 cleanup / abort」。源码正则只能看代码顺序，
 *   无法证明运行时的帧序列，也无法做真注入（延迟、乱序、断开）。
 *
 * 关键性质（也是它能测「首帧」的原因）：
 *  ① hook 槽按**组件实例**归属（每个实例一个 Node ≈ React fiber），互不串味；
 *  ② 渲染同步、可丢弃：渲染期 setState 只入队，**不改写本帧读到的值**；
 *  ③ **提交后才跑 effect**；cleanup 在同一槽的下一次 effect 或卸载时执行（与 React 一致）；
 *  ④ 实例**跨帧复用**：同一位置的组件重渲染时沿用旧实例 ⇒ hook 状态与订阅跨帧保留，
 *     这正是「同一组件持续挂载、会话身份变化」的竞态形态（而非每次重建整棵树）；
 *  ⑤ 每次 `flush` 产出一个**已提交帧**快照，可断言「切换后的第一帧看到什么」；
 *  ⑥ `unmount` 递归跑 cleanup，可断言残留：定时器 / window 监听器 / 未 abort 的请求。
 *
 * 被驱动的是**真实生产代码**：vm 内跑构建产物 dist/lib/client.js（全部源模块拼接），
 * RecentRecords / PromptBox / LiveStrip / SessionPanel 都是真实现。
 *
 * 计时：setTimeout / setInterval 用假时钟（可 tick、可断言在飞数量）；AbortController 用真实实现。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

export type HookSlot = { value?: any; deps?: any[]; cleanup?: any };
export type Instance = {
  type: any;
  key: any;
  props: any;
  slots: HookSlot[];
  cursor: number;
  pending: { slotIndex: number; value: any }[];
  pendingEffects: { slotIndex: number; fn: any }[];
  mounted: boolean;
  label: string;
  children: Instance[];
};
export type SnapElement = { type: any; label: string; props: any; children: SnapElement[]; key: any; instance?: Instance };

export type HarnessOptions = {
  bundle?: string;
  localStorage?: Record<string, string>;
  sessions?: any;
  services?: Record<string, any>;
  fetch?: (url: string, init?: any) => any;
};

export function createClientHarness(opts: HarnessOptions = {}) {
  const bundle = opts.bundle ?? readFileSync(join(import.meta.dirname, "../../../dist/lib/client.js"), "utf8");
  const clock = { t: 1_000_000 };
  const timeouts = new Map<any, any>();
  const intervals = new Map<any, any>();
  const windowListeners = new Map<string, Set<any>>();
  const localStorageData = { ...(opts.localStorage ?? {}) };
  let idSeq = 0;

  const fakeSetTimeout = (fn: any) => { const id = { n: ++idSeq }; timeouts.set(id, fn); return id; };
  const fakeSetInterval = (fn: any) => { const id = { n: ++idSeq }; intervals.set(id, fn); return id; };
  const fakeClear = (id: any) => { timeouts.delete(id); intervals.delete(id); };

  // ---------------- 迷你 React ----------------
  let current: Instance | null = null;
  const dirty = new Set<Instance>();
  // (state 更新排队计数不再需要)

  const hook = (): HookSlot => {
    const node = current;
    assert.ok(node, "hook 只能在组件渲染期间调用");
    const i = node.cursor++;
    if (!node.slots[i]) node.slots[i] = {};
    return node.slots[i];
  };
  const depsEqual = (a?: any[], b?: any[]) =>
    Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

  /**
   * 应用上一轮排队的 state 更新（≈ React 渲染前的 update queue 套用）。
   * 只改 slot.value，不清 deps/cleanup —— deps 变化与 cleanup 由渲染阶段的 useEffect 判定。
   */
  const instance_flushPending = (inst: Instance) => {
    if (!inst.pending.length) return;
    const items = inst.pending;
    inst.pending = [];
    for (const it of items) inst.slots[it.slotIndex] = { ...(inst.slots[it.slotIndex] ?? {}), value: it.value };
  };

  const ReactStub: any = {
    createElement(type: any, props: any, ...children: any[]) { return { type, props: props ?? {}, children }; },
    Fragment: "Fragment",
    memo: (c: any) => c,
    Component: class { props: any; state: any; constructor(props: any) { this.props = props; this.state = {}; } setState() {} },
    useRef(init: any) {
      const s = hook();
      if (s.value === undefined) s.value = { current: init };
      return s.value;
    },
    useState(init: any) {
      const node = current!;
      const i = node.cursor++;
      if (!node.slots[i]) node.slots[i] = { value: typeof init === "function" ? init() : init };
      const slot = node.slots[i];
      const setState = (v: any) => {
        // 函数式更新相对「最新排队值」求解（同槽多次 set 以最后一次为准，与 React 一致）。
        const queued = node.pending.filter((p) => p.slotIndex === i);
        const base = queued.length ? queued[queued.length - 1].value : slot.value;
        const nv = typeof v === "function" ? v(base) : v;
        if (Object.is(nv, base)) return;
        node.pending.push({ slotIndex: i, value: nv });
        dirty.add(node);
      };
      return [slot.value, setState];
    },
    useReducer(reducer: any, initArg: any, initFn?: any) {
      const [state, setState] = ReactStub.useState(() => (initFn ? initFn(initArg) : initArg));
      return [state, (action: any) => setState((s: any) => reducer(s, action))];
    },
    useEffect(fn: any, deps?: any[]) {
      const node = current!;
      const i = node.cursor++;
      if (!node.slots[i]) node.slots[i] = {};
      const s = node.slots[i];
      if (!deps || !depsEqual(s.deps, deps)) {
        s.deps = deps;
        node.pendingEffects = node.pendingEffects.filter((e) => e.slotIndex !== i);
        node.pendingEffects.push({ slotIndex: i, fn });
      }
    },
    useLayoutEffect(fn: any, deps?: any[]) { ReactStub.useEffect(fn, deps); },
    useInsertionEffect(fn: any, deps?: any[]) { ReactStub.useEffect(fn, deps); },
    useMemo(fn: any, deps?: any[]) {
      const s = hook();
      if (!("value" in s) || !depsEqual(s.deps, deps)) { s.value = fn(); s.deps = deps; }
      return s.value;
    },
    useCallback(fn: any, deps?: any[]) { return ReactStub.useMemo(() => fn, deps); },
    useSyncExternalStore(subscribe: any, getSnapshot: any) {
      // 渲染期直接读快照（与 React 一致）；订阅在 effect 建立、cleanup 撤销。
      const snapshot = getSnapshot();
      // 关键：订阅回调归属**建立订阅的那个实例**。若在回调里读渲染期的 `current`（模块级可变
      // 游标），订阅触发时 `current` 早已是别的实例或 null ⇒ 唤醒错节点（或静默丢更新）。
      // 因此这里在渲染期就把节点捕获进闭包（= React 把回调绑到对应 fiber）。
      const owner = current;
      ReactStub.useEffect(() => {
        const unsub = subscribe(() => {
          if (owner && !Object.is(getSnapshot(), snapshot)) dirty.add(owner);
        });
        return typeof unsub === "function" ? unsub : undefined;
      }, [subscribe, getSnapshot]);
      return snapshot;
    },
  };

  // ---------------- 沙箱 ----------------
  let factory: any = null;
  const sandbox: any = {
    console, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal, Error, TypeError, RangeError,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClear, setInterval: fakeSetInterval, clearInterval: fakeClear,
    queueMicrotask, requestAnimationFrame: (fn: any) => fakeSetTimeout(fn), cancelAnimationFrame: fakeClear,
    Date: class extends Date {
      constructor(...args: any[]) { if (args.length === 0) super(clock.t); else super(...(args as [])); }
      static now() { return clock.t; }
    },
    localStorage: {
      getItem: (k: string) => (Object.prototype.hasOwnProperty.call(localStorageData, k) ? localStorageData[k] : null),
      setItem: (k: string, v: string) => { localStorageData[k] = String(v); },
      removeItem: (k: string) => { delete localStorageData[k]; },
      key: () => null, length: 0,
    },
    navigator: {},
    document: {
      createElement: () => ({ style: {}, appendChild() {}, setAttribute() {}, addEventListener() {}, removeEventListener() {} }),
      querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
      addEventListener() {}, removeEventListener() {},
      head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} },
      activeElement: null,
    },
    CustomEvent: class { type: string; detail: any; constructor(type: string, init?: any) { this.type = type; this.detail = init?.detail; } },
    Event: class { type: string; constructor(type: string) { this.type = type; } },
    fetch: opts.fetch ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })),
  };
  sandbox.window = {
    __ModuleLoader__: { load: (def: any) => { factory = def.factory; } },
    addEventListener(type: string, fn: any) { const s = windowListeners.get(type) ?? new Set(); s.add(fn); windowListeners.set(type, s); },
    removeEventListener(type: string, fn: any) { windowListeners.get(type)?.delete(fn); },
    dispatchEvent(ev: any) { for (const fn of [...(windowListeners.get(ev?.type) ?? [])]) fn(ev); return true; },
    location: { href: "http://localhost/" },
    localStorage: sandbox.localStorage,
    setTimeout: fakeSetTimeout, clearTimeout: fakeClear, setInterval: fakeSetInterval, clearInterval: fakeClear,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(bundle, sandbox, { filename: "dist/lib/client.js" });
  assert.ok(factory, "dist/lib/client.js 通过 window.__ModuleLoader__.load 注册工厂");

  const requireStub = (name: string) => {
    if (name === "react") return ReactStub;
    if (name === "react-dom") return { render() {}, createPortal: (n: any) => n, createRoot: () => ({ render() {}, unmount() {} }) };
    throw new Error(`module not found: ${name}`);
  };
  const mod = factory(requireStub);

  const noop = () => {};
  const sessionsRt = opts.sessions ?? { list: { getSnapshot: () => ({ byId: {}, items: [], subagentsByParent: {} }), subscribe: () => noop } };
  const registered: { def: any; renderer: any }[] = [];
  const slotsObj = { inject: (_n: string, cb: any) => { cb?.(); return noop; }, register: (def: any, renderer: any) => { registered.push({ def, renderer }); return noop; } };
  const ctx: any = {
    sessions: sessionsRt,
    get: (n: string) => (opts.services ?? {})[n] ?? null,
    slots: slotsObj, on: noop, effect: (fn: any) => fn(),
    inject: (deps: string[], cb: any) => {
      // 与真实 cordis 一致：只有**已就绪**的服务才会触发 deferred inject 回调。
      // 关键：`["remote"]` 的回调会把 appCtx 升级成注入 scope —— 若在 remote 未就绪时也调用，
      // appCtx 会被换成没有 get() 的 scope，`appCtx.get("remote.session")` 恒为 null
      //（真实宿主里 remote 缺席时同样不调用，故这是对宿主语义的忠实模拟）。
      const ready = deps.every((d) => d === "slots" || d === "sessions" || (opts.services ?? {})[d] != null);
      if (!ready) return { dispose: noop };
      cb?.({
        slots: slotsObj,
        sessions: sessionsRt,
        get: (n: string) => (opts.services ?? {})[n] ?? null,
      });
      return { dispose: noop };
    },
  };
  mod.apply(ctx);

  // ---------------- 核心：渲染（实例按位置复用） ----------------
  let mountSeq = 0;
  const makeInstance = (type: any, props: any, key: any): Instance => ({
    type, key, props, slots: [], cursor: 0, pending: [], pendingEffects: [], mounted: false,
    label: `${type.name || type} #${++mountSeq}`, children: [],
  });

  /**
   * 渲染一个元素。`prevInst` 是上一帧同位置的旧组件实例（可复用，= React fiber 复用）。
   * 返回该元素渲染出的快照列表（一般为 1 项），并在快照上挂 `instance` 引用。
   *
   * 对位规则（与 React 一致的关键点）：
   *  · 组件实例按其**渲染结果**里的子元素顺序对齐（而不是数组下标）：
   *    每个组件元素占一个 prevKids 位，宿主元素自身不占位。
   *  · 宿主元素不持实例，但其 children 继续按同一套规则与 prevInst 的 children 对齐。
   */
  /**
   * 渲染一个元素。位置对齐模型（与 React fiber 的 sibling 顺序一致）：
   *   · 调用方传入一个 **positional cursor**（`ctx`），它指向「父级渲染结果里当前应消费的组件位」；
   *   · 只有**组件元素**消费一个组件位（prevKids[pos++]）；宿主元素与文本不消费；
   *   · 宿主元素的 children 继续用**同一个** cursor 往下走 ⇒ 宿主元素其实不打断兄弟序，
   *     这正是 SessionPanel 这种「根 div 里平铺 [LiveStrip, 模型行, PromptBox, …]」能跨帧复用的原因。
   */
  const renderEl = (el: any, ctx: { kids: Instance[]; pos: number }): SnapElement[] => {
    if (el === undefined || el === null || typeof el === "boolean") return [];
    if (typeof el === "string" || typeof el === "number") {
      return [{ type: "#text", label: String(el), props: {}, children: [], key: null }];
    }
    if (Array.isArray(el)) {
      const out: SnapElement[] = [];
      for (const item of el) out.push(...renderEl(item, ctx));
      return out;
    }
    if (typeof el !== "object" || !el.type) return [];
    const key = el.props?.key ?? null;
    const kidsSrc = (Array.isArray(el.children) && el.children.length) ? el.children : (el.props?.children ?? []);
    if (typeof el.type === "string") {
      // 宿主元素：不消费组件位，children 沿用同一 cursor
      const kids: SnapElement[] = [];
      for (const item of (Array.isArray(kidsSrc) ? kidsSrc : [kidsSrc])) kids.push(...renderEl(item, ctx));
      return [{ type: el.type, label: el.type, props: el.props ?? {}, children: kids, key }];
    }
    // 组件元素：消费一个组件位
    const prevInst = ctx.kids[ctx.pos] ?? null;
    ctx.pos++;
    const reusable = !!prevInst && prevInst.type === el.type;
    const inst: Instance = reusable ? prevInst! : makeInstance(el.type, el.props ?? {}, key);
    inst.props = el.props ?? {};
    inst.mounted = true;
    if (!reusable) dirty.add(inst);
    instance_flushPending(inst);
    inst.cursor = 0;
    const prev = current;
    current = inst;
    let rendered: any;
    try { rendered = el.type(inst.props); } finally { current = prev; }
    inst.cursor = 0;
    // 子级用**本实例**上一帧的直接子实例列表作为 cursor 源
    const childCtx = { kids: inst.children ?? [], pos: 0 };
    const kids: SnapElement[] = [];
    const renderedList = Array.isArray(rendered) ? rendered : [rendered];
    // 先按 cursor 顺序渲染出全部子元素，再据此登记「直接子实例」
    const renderedSnaps: SnapElement[][] = [];
    for (const item of renderedList) renderedSnaps.push(renderEl(item, childCtx));
    const directKids: Instance[] = [];
    const collectDirect = (snap: SnapElement) => {
      // 该元素在渲染结果里的直接实例：组件元素自身，或宿主元素内第一层组件实例
      if (snap.instance) { if (!directKids.includes(snap.instance)) directKids.push(snap.instance); return; }
      for (const c of snap.children ?? []) collectDirect(c);
    };
    for (const group of renderedSnaps) {
      for (const s of group) { collectDirect(s); kids.push(s); }
    }
    inst.children = directKids;
    return [{ type: el.type, label: inst.label, props: inst.props, children: kids, key, instance: inst }];
  };


  /** 提交阶段：按「先父后子」执行本帧排期的 effect（先跑同槽旧 cleanup，再跑新 effect）。 */
  const runEffects = (inst: Instance) => {
    const effects = inst.pendingEffects;
    inst.pendingEffects = [];
    for (const e of effects) {
      const slot = inst.slots[e.slotIndex] ?? (inst.slots[e.slotIndex] = {});
      if (typeof slot.cleanup === "function") { try { slot.cleanup(); } catch { /* ignore */ } }
      const ret = e.fn();
      slot.cleanup = typeof ret === "function" ? ret : undefined;
    }
    for (const child of inst.children) runEffects(child);
  };

  /** 卸载：按「先子后父、槽位逆序」跑 cleanup（与 React 的销毁顺序同向）。 */
  const cleanupTree = (inst: Instance) => {
    for (const child of [...inst.children].reverse()) cleanupTree(child);
    for (const slot of [...inst.slots].reverse()) {
      if (typeof slot.cleanup === "function") { try { slot.cleanup(); } catch { /* ignore */ } }
      slot.cleanup = undefined;
    }
    inst.mounted = false;
  };

  /** 递归收集实例（调试/断言用）。 */
  const collect = (inst: Instance, out: Instance[] = []): Instance[] => {
    out.push(inst);
    for (const c of inst.children) collect(c, out);
    return out;
  };

  /**
   * 挂载一个根组件并保持实例跨帧（= 组件持续挂载）。返回驱动器：
   *   flush(props?) —— 渲染 + 提交（effect 在提交后执行），返回该帧已提交快照
   *   unmount()     —— 递归跑 cleanup
   */
  const mount = (rootType: any, initialProps: any) => {
    let props = initialProps;
    let rootInst: Instance | null = null;
    const frames: SnapElement[][] = [];
    return {
      frames,
      get props() { return props; },
      instances: () => (rootInst ? collect(rootInst) : []),
      flush(nextProps?: any) {
        if (nextProps !== undefined) props = nextProps;
        // 根组件位于「无兄弟」的顶层位置：cursor 为空、组件位只有它自己（由 renderEl 内部复用 rootInst）。
        const snap = renderEl({ type: rootType, props, children: [] }, { kids: rootInst ? [rootInst] : [], pos: 0 });
        rootInst = snap[0]?.instance ?? null;
        if (rootInst) runEffects(rootInst);
        frames.push(snap);
        return snap;
      },
      unmount() { if (rootInst) cleanupTree(rootInst); rootInst = null; dirty.clear(); },
    };
  };

  return {
    mod, ReactStub, registered, mount,
    clock, timeouts, intervals, windowListeners,
    resources: () => ({
      timeouts: timeouts.size,
      intervals: intervals.size,
      listeners: [...windowListeners.values()].reduce((a, s) => a + s.size, 0),
    }),
    clearDirty: () => dirty.clear(),
    dirtyCount: () => dirty.size,
    /** 推进假时钟：执行全部在飞 timeout 与 interval 回调各一次 */
    tickAll() {
      for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn(); }
      for (const fn of [...intervals.values()]) fn();
    },
    /** 只推进 timeout（interval 不动），用于验收节流 trailing flush */
    tickTimeouts() {
      for (const [id, fn] of [...timeouts]) { timeouts.delete(id); fn(); }
    },
  };
}

/** 快照里递归抽取全部文本 */
export function snapText(node: any): string {
  if (node === undefined || node === null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(snapText).join(" ");
  if (node.type === "#text") return String(node.label);
  return (node.children ?? []).map(snapText).join(" ");
}

/** 快照里递归收集满足条件的节点 */
export function snapFind(node: any, pred: (n: SnapElement) => boolean, out: SnapElement[] = []): SnapElement[] {
  if (node === undefined || node === null || typeof node !== "object" || typeof node === "string") return out;
  if (Array.isArray(node)) { for (const n of node) snapFind(n, pred, out); return out; }
  if (pred(node)) out.push(node);
  for (const c of node.children ?? []) snapFind(c, pred, out);
  return out;
}
