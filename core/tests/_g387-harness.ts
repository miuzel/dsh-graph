// g-387 共用测试脚手架：最小 React 依赖模型 + **真实** session-hooks 源模块沙箱 + 忠实复刻 0.1.6
// 宿主 sessions 服务的桩（引用稳定的 list 快照存储 / retain 代际 / 目录投影）。
//
// 为什么 g321 已有同类脚手架还要再写一份：g321 的焦点是「保留生命周期」，其 list 桩
// `getSnapshot` 每次调用都返回**新对象**、且 retain 不联动目录——用它测不出本目标的判据：
//   ① 真实实现（dsh-client-store 的 createSnapshotStore）是 `getSnapshot: () => api.getState()`，
//      引用稳定；快照抖动只能来自真正的 `set()`。桩失真会让「目录变化触发唤醒」变成
//      「每次渲染都触发唤醒」，结论不可信；
//   ② 真实 retainScope 会在建立代际后 `publishRetention(id)`（更新 list 并通知订阅者）——
//      这正是「retain → 通知 → 再 retain」快照回环的触发源；桩里不联动就测不出回环。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");
export const clientRoot = join(hostRoot, "lib/client");
export const readClient = (name: string) => readFileSync(join(clientRoot, `${name}.js`), "utf8");

/** 从拼接前的源模块里精确抠出一个具名 function 声明（花括号配平），供 vm 行为测试使用。 */
export function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源模块中存在 function ${name}`);
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

/** g-351：子代理目录 entry 的形状探测族（沙箱注入目录读取函数时必须连同它们一并注入）。 */
export const CATALOG_SHAPE_FUNCS = ["isCatalogChildEntry", "catalogChildEntry", "catalogParentIndex", "catalogEntryMode", "catalogAddressMode"];

/** 极简 React hook 运行时：真实驱动 hook 源函数（useState/useMemo/useCallback/useEffect/
 *  useSyncExternalStore），支持 mount → 订阅触发重渲染 → unmount。 */
export function makeHookHarness(render: (R: any) => any) {
  const slots: any[] = [];
  const cleanups: any[] = [];
  let cursor = 0;
  let inRender = false;
  let dirty = false;
  let unmounted = false;
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
      slot.unsub = s.sub(() => { if (!unmounted) renderNow(); });
    }
  }

  function renderNow() {
    if (unmounted) return;
    if (inRender) { dirty = true; return; }
    do {
      dirty = false;
      cursor = 0;
      pending.effects.length = 0;
      pending.subs.length = 0;
      inRender = true;
      try {
        latest = render(R);
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
      unmounted = true;
      for (const c of cleanups) c?.();
      cleanups.length = 0;
      for (const s of slots) s?.unsub?.();
    },
  };
}

/** 让 await 链（地址解析 → reference.ready → notify → 重渲染）全部落定。 */
export const flushAsync = async () => {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
};

/** 把真实源模块里参与会话引用生命周期的函数抽到 vm 沙箱（连同其模块级私有状态），
 *  使行为断言跑在**真实实现**上而不是测试里复制的一份。 */
export function makeSessionHooksSandbox(
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

/** 可手动落定的 promise（模拟「在飞解析」）。 */
export function makeDeferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export type Sessions016 = ReturnType<typeof makeSessions016>;

/**
 * 忠实复刻 0.1.6-alpha.2 宿主 sessions 服务中**与本目标相关**的行为：
 *  - `list` 是一个 snapshot store：getSnapshot 引用稳定，只有 `set` 才换引用并通知订阅者
 *    （真实实现见 @deepseek-ai/dsh-client-store 的 createSnapshotStore）；
 *  - `retain(target)` 建立代际后像 `retainScope` 一样 `publishRetention(id)`：更新 list 并通知
 *    —— 这是「快照回环」的真实触发源，测试必须让它存在，否则回环用例形同虚设；
 *  - `release()` 归还代际（并像真实 retireScope 一样更新 list）。
 * 目录默认**为空**（复现「首次挂载时目录里还没有 child」），由测试用 `publishCatalog()` 让目录迟到。
 */
export function makeSessions016(opts: {
  parentId?: string;
  /** 'new'（0.1.7 projectionsBySession，entry 无 kind）| 'legacy'（subagentsByParent，entry 带 kind） */
  shape?: "new" | "legacy";
  /** refresh 能力（新 refreshProjections / 旧 setSubagentCatalogOpen+refreshSubagents）的行为注入；
   *  返回 pending promise 即模拟「解析在飞」。 */
  onRefresh?: (parentId: string) => unknown;
  ready?: (id: string) => Promise<unknown>;
} = {}) {
  const parentId = opts.parentId ?? "parent-1";
  const shape = opts.shape ?? "new";
  const calls = {
    retain: [] as Array<{ target: any; options: any }>,
    released: [] as string[],
    refresh: [] as string[],
    opened: [] as string[],
  };
  const addresses = new Map<string, any>();
  const sessions = new Map<string, any>();
  const eventSources = new Map<string, any>();

  const sessionFor = (id: string) => {
    let s = sessions.get(id);
    if (!s) {
      s = {
        id,
        open: async () => { calls.opened.push(id); },
        configureSubagent: () => {},
        prompt: async () => {},
        projections: { faceOf: () => null },
        getSnapshot: () => ({ running: false }),
        subscribe: () => () => {},
      };
      sessions.set(id, s);
    }
    return s;
  };
  const eventSourceFor = (id: string) => {
    let e = eventSources.get(id);
    if (!e) { e = { getSnapshot: () => ({ entries: [] }), subscribe: () => () => {} }; eventSources.set(id, e); }
    return e;
  };

  // ---- snapshot store（真实 createSnapshotStore 的最小忠实复刻）----
  let state: any = {
    ids: [parentId],
    byId: {},
    seq: 0,
    ...(shape === "legacy" ? { subagentsByParent: {} } : { projectionsBySession: {} }),
  };
  const listeners = new Set<() => void>();
  const list = {
    getSnapshot: () => state,
    subscribe: (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    set: (mutate: (draft: any) => any) => {
      state = { ...mutate(state) };
      for (const cb of [...listeners]) { try { cb(); } catch { /* 单个订阅者异常不得中断其它订阅者 */ } }
    },
  };
  /** 目录迟到：把 ids 收录进子代理目录（投影），并通知 list 订阅者。 */
  const publishCatalog = (...ids: string[]) => list.set((s) => {
    const entries = ids.map((id) => (shape === "legacy" ? { kind: "child", id, mode: "continuable" } : { id, mode: "continuable" }));
    return shape === "legacy"
      ? { ...s, seq: s.seq + 1, subagentsByParent: { ...s.subagentsByParent, [parentId]: { entries } } }
      : { ...s, seq: s.seq + 1, projectionsBySession: { ...s.projectionsBySession, [parentId]: { values: { subagentCatalog: entries } } } };
  });
  /** 会话列表快照抖动（不含目录内容变化）——用于验证「已成功 retain 后不再重 retain」。 */
  const jitter = () => list.set((s) => ({ ...s, seq: s.seq + 1 }));

  const retain = (target: any, options: any) => {
    const id = typeof target === "string" ? target : String(target?.childSessionId);
    calls.retain.push({ target, options });
    // retainScope → publishRetention(id)：更新 list 并通知（回环的真实触发源）
    list.set((s) => ({ ...s, seq: s.seq + 1, byId: { ...s.byId, [id]: { ...(s.byId[id] ?? {}), retainedBy: { "dsh-graph": 1 } } } }));
    return {
      sessionId: id,
      ready: opts.ready ? opts.ready(id) : Promise.resolve(),
      get binding() { return { sessionId: id, session: sessionFor(id), eventSource: eventSourceFor(id) }; },
      release: () => {
        calls.released.push(id);
        list.set((s) => { const byId = { ...s.byId }; delete byId[id]; return { ...s, seq: s.seq + 1, byId }; });
      },
    };
  };

  const refresh = async (p: string) => { calls.refresh.push(p); if (opts.onRefresh) await opts.onRefresh(p); };
  const rt: any = {
    list,
    retain,
    subagentAddress: (id: string) => addresses.get(id),
    refreshProjections: (p: string) => refresh(p),
    setSubagentCatalogOpen: () => {},
    refreshSubagents: (p: string) => refresh(p),
  };
  return { rt, calls, list, publishCatalog, jitter, addresses, sessionFor, eventSourceFor, current: () => state };
}
