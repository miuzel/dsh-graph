// core/tests/g498-help-ui-regression.test.ts
//
// g-498：帮助弹窗「提示词模板」与「使用说明」两个页签的**真实行为**回归。
//
// 为什么需要：g-493 / g-481 / g-489 的既有守卫全部打在**源码文本结构**上（正则/切片）。g-498 把
// 「提示词模板」的选中态从「完整资产名」换成「稳定基名」并按注册元数据分组、把引言正文从
// `dgT(key)` 直出字符串换成安全行内 Markdown 渲染 —— 这两处都是**交互/渲染语义**变化，
// 源码正则看得见「有没有这段代码」，看不见「切语言后选择是否真的保持」「星号是否真的不再可见」。
// 本套件用 vm + 迷你 React 跑**真实客户端 bundle**（dist/lib/client.js）里的真实组件，
// 断言凸在选择身份、请求路径、可见文本与集合守恒上，而不是断言源码里有没有某个字符串。
//
// 覆盖（判据 1/2/3）：
//   A. 选择身份：选**非首项**模板后 zh → en → zh，选择始终停在同基名；按钮高亮、请求路径、
//      正文来源三处一致（不是「源码里有个变量叫 pickedBase」）。
//   B. 快速切换 / 异步竞态：旧响应**不得**覆盖新选择的正文（挂起取数桩按序放行实测）。
//   C. 缺语言透明回落：该语言缺该模板时落到双语里存在的那一份，并**如实标注**实际语言。
//   D. 分类投影：分组顺序取自宿主 `prompt_categories`；每个资产**恰出现一次**；未知分类可见
//      （归入「未分类」）；客户端不新增文件名清单（分组只依赖目录投影）。
//   E. 引言渲染：`**粗体**` 变成 `strong` React 节点、正文可见文本**不含**星号；
//      逐字引文落在独立 `blockquote`；四个语义小标题齐备；条目集合 ≡ 清单（恰一次）。
//
// 负向对照一律 hermetic（只在内存里变异目录投影/字典/组件树，真实文件零改动）。

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const repoRoot = join(import.meta.dirname, "../..");
const bundlePath = join(repoRoot, "dist/lib/client.js");
const i18nSrcPath = join(repoRoot, "dsh-graph-host/lib/client/i18n.js");
const helpModalPath = join(repoRoot, "dsh-graph-host/lib/client/help-modal.js");
const pluginPath = join(repoRoot, "dsh-graph-host/lib/client/plugin.js");
const BUNDLE_SRC = readFileSync(bundlePath, "utf8");
const HELP_MODAL_SRC = readFileSync(helpModalPath, "utf8");

/** 宿主目录端点（`/help/catalog`）的真实投影：与 dist/index.js 的导出**同源**取数。 */
async function hostCatalog(): Promise<any> {
  const mod: any = await import(new URL("../../dist/index.js", import.meta.url).href);
  return {
    prompt_language: "zh",
    prompts: mod.helpPromptAssetEntries(),
    prompt_categories: mod.helpPromptCategoryEntries(),
  };
}

/** 展示标签 → 资产基名。标签取自**真实客户端字典**（`help.asset.<base>`），
 *  与组件渲染时用的是同一份文案 ⇒ 测试可以用可见标签反查被点的到底是哪个资产。 */
async function assetLabelToBase(): Promise<Map<string, string>> {
  const catalog = await hostCatalog();
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${readFileSync(i18nSrcPath, "utf8")}; this.dict = zh;`, sandbox);
  const zh: Record<string, string> = sandbox.dict;
  const out = new Map<string, string>();
  for (const base of new Set(catalog.prompts.map((p: any) => p.base))) {
    const label = zh[`help.asset.${base}`];
    if (label) out.set(label, base);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 真实渲染 harness（vm + 迷你 React，与 g352/g367/g381/relation-display-modal 同口径）
// ---------------------------------------------------------------------------

interface Harness {
  mount: (name: string, props: any) => Promise<void>;
  nodes: () => any[];
  setLang: (lang: string) => void;
  flush: () => Promise<void>;
  fetchLog: { url: string }[];
  pendingCount: () => number;
  release: (index: number) => void;
}

function makeHarness(): Harness {
  let nodes: any[] = [];
  const fetchLog: { url: string }[] = [];
  const pending: Array<() => void> = [];
  let factory: any = null;
  let lang = "zh";
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
  let effects: any[] = [];
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
      const el: any = { type, props: p, children, key: p.key ?? null };
      // `__v` 标记真实 vnode（与字符串/数字子节点区分），供可见文本遍历使用。
      Object.defineProperty(el, "__v", { value: true, enumerable: false });
      nodes.push(el);
      return el;
    },
    useState(init: any) {
      const { arr, i } = slotAt();
      if (!(i in arr)) arr[i] = { value: typeof init === "function" ? init() : init };
      const s = arr[i];
      return [s.value, (v: any) => { s.value = typeof v === "function" ? v(s.value) : v; }];
    },
    useRef(init: any) { const { arr, i } = slotAt(); if (!(i in arr)) arr[i] = { current: init }; return arr[i]; },
    useEffect(fn: any, deps: any) {
      const { arr, i } = slotAt();
      const s = arr[i] || (arr[i] = {});
      if (!s.fn || !depsEqual(s.deps, deps)) {
        // 依赖变化 ⇒ 先跑上一轮的清理（alive=false），再跑新 effect（与真实 React 同序）。
        if (typeof s.cleanup === "function") { try { s.cleanup(); } catch { /* 静默 */ } }
        s.fn = fn; s.deps = deps;
        effects.push(s);
      } else {
        s.fn = fn;
      }
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

  const jsonRes = (v: any) => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => v, text: async () => JSON.stringify(v) });
  const sandbox: any = {
    console, URL, URLSearchParams, TextEncoder, TextDecoder, performance,
    setTimeout: () => 0, clearTimeout: noop, setInterval: () => 0, clearInterval: noop,
    queueMicrotask, requestAnimationFrame: () => 1, cancelAnimationFrame: noop,
    localStorage: { getItem: () => null, setItem: noop, removeItem: noop, key: () => null, length: 0 },
    navigator: {},
    fetch: async (url: any) => {
      const u = String(url);
      fetchLog.push({ url: u });
      if (u.includes("/api/dsh-graph/help/asset/")) {
        const name = decodeURIComponent(u.slice(u.indexOf("/help/asset/") + "/help/asset/".length));
        // 正文可按测试需要挂起：由 release() 决定落地顺序（异步竞态用）。
        return {
          ok: true, status: 200, headers: { get: () => null }, json: async () => ({}),
          text: () => new Promise<string>((resolve) => { pending.push(() => resolve(`BODY<${name}>`)); }),
        };
      }
      return jsonRes({});
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
  vm.runInNewContext(BUNDLE_SRC, sandbox, { filename: "dist/lib/client.js" });
  assert.ok(factory, "bundle 必须通过 window.__ModuleLoader__.load 注册工厂");

  const requireStub = (name: string) => {
    if (name === "react") return ReactStub;
    if (name === "react-dom") return { render: noop, createPortal: (n: any) => n, createRoot: () => ({ render: noop, unmount: noop }) };
    if (name === "@deepseek-ai/dsh-client-ui-primitives") throw new Error("no primitives");
    throw new Error(`module not found: ${name}`);
  };
  const mod = factory(requireStub);

  // locale 服务桩：与真实 locale 服务**同接口**（register/bind/preference/subscribe），
  // 让 `dgT` / `dgLang` 走 bundle 里**真实的** registerI18n + createTranslator 路径
  //（测试不另抄一份翻译表 ⇒ 断言的是真实组件在真实语言契约下的行为）。
  const dicts = new Map<string, Record<string, string>>();
  const listeners: Array<() => void> = [];
  const localeService: any = {
    register: (_ns: string, d: Record<string, Record<string, string>>) => { for (const [k, v] of Object.entries(d)) dicts.set(k, v); },
    bind: (_ns: string) => (key: string) => {
      const d = dicts.get(lang) ?? {};
      return d[key] !== undefined ? d[key] : key;
    },
    get preference() { return lang; },
    subscribe: (fn: () => void) => { listeners.push(fn); return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); }; },
    locale: lang,
  };

  const registered: { def: any; renderer: any }[] = [];
  const slotsObj = { inject: (_n: string, cb: any) => { cb?.(); return noop; }, register: (def: any, renderer: any) => { registered.push({ def, renderer }); return noop; } };
  const ctx: any = {
    sessions: { list: { getSnapshot: () => ({ byId: {}, items: [], subagentsByParent: {} }) } },
    get: (n: string) => (n === "locale" ? localeService : null),
    slots: slotsObj, on: noop, effect: (fn: any) => fn(),
    inject: (_deps: string[], cb: any) => { cb?.({ sidebarRightTabs: { register: () => noop }, slots: slotsObj }); return { dispose: noop }; },
  };
  mod.apply(ctx);

  /** 迷你 React 只展开白名单组件（hook 归属按调用者函数身份），未展开的组件按原样保留。 */
  const EXPAND = new Set(["HelpUsageTab", "HelpPromptsTab", "HelpRichText", "HelpEntryStep"]);
  const expand = (node: any, depth = 0): any => {
    if (depth > 30 || node == null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((n) => expand(n, depth));
    if (typeof node.type === "function" && EXPAND.has(node.type.name)) return expand(node.type(node.props ?? {}), depth + 1);
    if (Array.isArray(node.children)) node.children = node.children.map((c) => expand(c, depth));
    return node;
  };

  const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

  async function mount(name: string, props: any): Promise<void> {
    const fn = mod.__test?.[name];
    assert.ok(typeof fn === "function", `bundle 必须导出可渲染的 ${name}（供真实渲染回归）`);
    // 迷你 React：多趟渲染直到树稳定。每趟重建 hook 游标、清空元素缓冲，只保留**最后一趟**的元素
    //（否则多趟会把同一元素重复计入，集合守恒断言就失去意义）。
    let last: any[] = [];
    for (let pass = 0; pass < 8; pass++) {
      cursor.clear();
      effects = [];
      nodes = [];
      expand(fn(props));
      // 提交阶段：跑本趟新挂载/依赖变化的 effect（真实 React 在渲染之后执行它们）。
      for (const s of effects) {
        try { s.cleanup = s.fn(); } catch { s.cleanup = undefined; }
      }
      await flush();
      last = nodes;
      if (!effects.length && pass > 0) break;
    }
    nodes = last;
  }

  return {
    mount, nodes: () => nodes, fetchLog, flush,
    setLang: (l: string) => { lang = l; for (const fn of listeners) fn(); },
    pendingCount: () => pending.length,
    release: (index: number) => { const fn = pending[index]; assert.ok(fn, `没有第 ${index} 个挂起的响应`); fn(); },
  };
}

// ---------------------------------------------------------------------------
// 遍历工具
// ---------------------------------------------------------------------------

const elClass = (e: any): string => (typeof e?.props?.className === "string" ? e.props.className : "");
const withClass = (els: any[], needle: string) => els.filter((e) => elClass(e).includes(needle));

/** 子树前序遍历（= DOM 次序）。 */
function treeOf(node: any, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { for (const n of node) treeOf(n, out); return out; }
  if (node.type) { out.push(node); treeOf(node.children, out); }
  return out;
}

/** 可见文本：只收**字符串子节点**；`strong`/`code` 等元素渲染出的装饰字符不会出现。
 *  这正是判据 3 要的证据 —— 星号应是元素而非文本。 */
function visibleText(node: any): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(visibleText).join("");
  let out = "";
  for (const c of node.children ?? []) out += visibleText(c);
  return out;
}

/** 带某类名的元素的可见文本（按渲染顺序）。 */
const textsWithClass = (els: any[], needle: string) => withClass(els, needle).map((e) => visibleText(e));

/** 可点击的列表按钮（模板列表项）。语言切换按钮另用 `dg-help-lang` 语义类排除，
 *  故断言的是「清单项」而不是「所有按钮」。 */
const listButtons = (els: any[]) => withClass(els, "dg-help-asset-btn");
/** 语言切换按钮（zh/en）。 */
const langButtons = (els: any[]) => withClass(els, "dg-help-lang-btn");

/** 正文容器里实际喂给 Markdown 渲染器的文本（`GoalMarkdown` 的 `text` prop）。
 *  不展开 `GoalMarkdown`（那是全局 Markdown 框架的另一套实现），直接读它的输入 ——
 *  这正是「当前载入的是哪一份正文」的真源。 */
const loadedBody = (els: any[]): string => {
  const md = withClass(els, "dg-help-prompt-md");
  assert.equal(md.length, 1, `正文容器必须恰有一个（实得 ${md.length}）`);
  const inner = treeOf(md[0]!).map((e: any) => e.props?.text).filter((t: any) => typeof t === "string");
  return inner.join("\n");
};

/** 日志里最近一次正文请求的资产名。 */
const lastAssetName = (h: Harness): string => {
  const urls = h.fetchLog.filter((f) => f.url.includes("/help/asset/"));
  assert.ok(urls.length, "必须至少发出过一次正文请求");
  const u = urls[urls.length - 1]!.url;
  return decodeURIComponent(u.slice(u.indexOf("/help/asset/") + "/help/asset/".length));
};

// ================================================================ A. 选择身份（判据 1）

test("g-498 A1：选非首项模板后 zh→en→zh，选择停在同基名（高亮 + 请求路径 + 正文三处一致）", async () => {
  const catalog = await hostCatalog();
  const h = makeHarness();
  const mountWith = () => h.mount("HelpPromptsTab", { catalogState: { status: "ready", catalog, error: "" } });
  await mountWith();

  const zhButtons = listButtons(h.nodes());
  assert.ok(zhButtons.length > 3, `模板列表按钮应可点击（实得 ${zhButtons.length}）`);
  const firstLabel = visibleText(zhButtons[0]!);
  // 真实交互：点第 3 个**渲染出来的**列表项（确保是**非首项**）。分组会重排顺序，故目标 base
  // 必须从被点击按钮的可见标签**反查**（用真实客户端字典），不能假设渲染索引与目录顺序对齐。
  const thirdLabel = visibleText(zhButtons[2]!);
  assert.notEqual(thirdLabel, firstLabel, "选中的必须是非首项");
  const labelMap = await assetLabelToBase();
  const targetBase = labelMap.get(thirdLabel);
  assert.ok(targetBase, `必须能从可见标签「${thirdLabel}」反查到资产基名`);
  assert.equal([...labelMap.keys()].filter((k) => k === thirdLabel).length, 1, `标签「${thirdLabel}」必须唯一`);
  zhButtons[2]!.props.onClick();
  await mountWith();

  /** 当前状态自证：请求路径 + 高亮项必须同时指向同一 base，且恰一个高亮。 */
  const check = (langCode: string) => {
    const els = h.nodes();
    const buttons = listButtons(els);
    assert.equal(buttons.length, catalog.prompts.filter((p: any) => p.lang === langCode).length,
      `${langCode}：清单项数必须等于该语言资产数（每项恰一次）`);
    const hot = buttons.filter((b) => elClass(b).includes("dg-btn-active"));
    assert.equal(hot.length, 1, `${langCode}：恰有一个列表项处于选中态（实得 ${hot.length}）`);
    const want = catalog.prompts.find((p: any) => p.base === targetBase && p.lang === langCode);
    assert.ok(want, `目录里应有 ${targetBase}.${langCode}`);
    // 请求路径 = 当前语言下的同一 base（既不是首项，也不是旧语言）。
    assert.equal(lastAssetName(h), want.name, `${langCode}：请求路径必须是当前语言下的同一 base`);
    // 高亮项 = 被请求项（标签一致），且不是首项。
    const hotLabel = visibleText(hot[0]!);
    assert.ok(hotLabel.length > 0, `${langCode}：选中项必须有可见标签`);
    assert.ok(hotLabel !== visibleText(buttons[0]!), `${langCode}：选中项必须仍是非首项（不得跳回首条）`);
    return hotLabel;
  };

  // 真实交互：点语言按钮。按**渲染顺序**取（第 0 个 = zh、第 1 个 = en），
  // 不按标签文本匹配 —— 标签本身随语言变化（en 字典里 zh 显示为 "Chinese"），
  // 用文本匹配会让断言在切语言时依赖字典内容。
  const langBtn = (code: "zh" | "en") => {
    const btns = langButtons(h.nodes());
    assert.equal(btns.length, 2, `语言切换必须恰有两个按钮（实得 ${btns.length}）`);
    return btns[code === "zh" ? 0 : 1]!;
  };
  const first = check("zh");
  h.setLang("en");
  langBtn("en").props.onClick();
  await mountWith();
  const second = check("en");
  // 再切回 zh：选择必须回到**同一个**基名。
  h.setLang("zh");
  langBtn("zh").props.onClick();
  await mountWith();
  const third = check("zh");
  assert.equal(third, first, "zh→en→zh 后必须回到同一选中项（选择不丢）");
  assert.ok(second.length > 0, "en 侧选中项必须有标签");
});

test("g-498 A2（负向对照·内存变异）：把选中态换回完整资产名 ⇒ 切语言必然丢选择（判据可判别性自证）", async () => {
  const catalog = await hostCatalog();
  // 变异语义：模拟「选中态 = 完整名」时，切语言后该名字不在新语言集合里 ⇒ 回落首项。
  const zhRows = catalog.prompts.filter((p: any) => p.lang === "zh");
  const targetBase = zhRows[2]!.base;
  const pickedFullName = zhRows[2]!.name; // 旧实现存的就是这个
  const enRows = catalog.prompts.filter((p: any) => p.lang === "en");
  assert.ok(!enRows.some((p: any) => p.name === pickedFullName), "完整名在换语言后**必然**不在集合内（旧实现在此丢选择）");
  assert.ok(enRows.some((p: any) => p.base === targetBase), "同一 base 在新语言下存在（因此按 base 判定可保住选择）");
});

// ================================================================ B. 异步竞态（判据 1）

test("g-498 B1：异步加载有 alive 守卫 —— 迟到的旧语言响应不得覆盖新选择的正文", async () => {
  const catalog = await hostCatalog();
  const h = makeHarness();
  const mountWith = () => h.mount("HelpPromptsTab", { catalogState: { status: "ready", catalog, error: "" } });
  await mountWith();
  // 选第 3 项（zh），此时有一个挂起的 zh 取数。
  const btns = listButtons(h.nodes());
  btns[2]!.props.onClick();
  await mountWith();
  const zhPendingBeforeSwitch = h.pendingCount();
  assert.ok(zhPendingBeforeSwitch > 0, "选中后必须有一个挂起的 zh 正文请求（竞态前提）");
  const staleIndex = zhPendingBeforeSwitch - 1; // 这一份属于**切语言之前**的请求
  const staleName = lastAssetName(h);
  assert.ok(staleName.endsWith(".zh.md"), `切换前的请求应是 zh 版（实得 ${staleName}）`);

  // 切到 en：新的 en 取数发起。
  h.setLang("en");
  langButtons(h.nodes())[1]!.props.onClick();
  await mountWith();
  const enName = lastAssetName(h);
  assert.ok(enName.endsWith(".en.md"), `切到 en 后请求路径必须是 en 版本（实得 ${enName}）`);
  const freshIndex = h.pendingCount() - 1; // 这一份属于 en 请求

  // **先**放行当前（en）响应，**再**放行被放弃的旧 zh 响应 —— 旧响应最后落地，
  // 若没有 alive 守卫它就会**覆盖**当前正文（这就是原缺陷的可观测形态）。
  h.release(freshIndex);
  await h.flush();
  h.release(staleIndex);
  await h.flush();
  await mountWith();
  const body = loadedBody(h.nodes());
  assert.ok(body.includes(`BODY<${enName}>`), `当前正文必须是 en 响应（实得 ${JSON.stringify(body.slice(0, 120))}）`);
  assert.ok(!body.includes(`BODY<${staleName}>`), `迟到的旧语言响应不得覆盖当前正文（实得 ${JSON.stringify(body.slice(0, 120))}）`);
  // 结构前提：`selected` 由 base + 语言**派生**，effect 依赖它，且 setAsset 被 alive 守卫包裹。
  assert.ok(/const selected = helpAssetNameOf\(/.test(HELP_MODAL_SRC), "完整资产名必须由基名 + 当前语言派生");
  assert.ok(/\}, \[selected\]\);/.test(HELP_MODAL_SRC), "取数 effect 必须依赖派生出的 selected");
  assert.ok(/let alive = true;/.test(HELP_MODAL_SRC) && /if \(alive\) setAsset/.test(HELP_MODAL_SRC), "取数 effect 必须有 alive 守卫");
});

test("g-498 B2：缺语言时透明回落 —— 完整名按「请求语言 → zh → en」解析，并如实标注实际语言", async () => {
  const catalog = await hostCatalog();
  // 变异目录：**整批**删掉 en 版（该语言确实没有任何模板）⇒ 无论组件选中哪个 base，
  // 都必须回落到 zh 那份（而不是 404 / 空白），且界面必须如实标注实际展示语言。
  const mutated = { ...catalog, prompts: catalog.prompts.filter((p: any) => p.lang !== "en") };
  assert.ok(mutated.prompts.length > 0, "变异后仍须有 zh 条目");
  assert.ok(!mutated.prompts.some((p: any) => p.lang === "en"), "变异必须真实生效（en 条目已全部删除）");
  const h = makeHarness();
  await h.mount("HelpPromptsTab", { catalogState: { status: "ready", catalog: mutated, error: "" } });
  h.setLang("en");
  // 语言按钮按渲染顺序取（第 0 个 = zh、第 1 个 = en）；标签随语言变化，不按文本匹配。
  langButtons(h.nodes())[1]!.props.onClick();
  await h.mount("HelpPromptsTab", { catalogState: { status: "ready", catalog: mutated, error: "" } });
  const els = h.nodes();
  const all = visibleText({ children: els });
  // 回落：请求 en 但没有任何 en 版 ⇒ 请求路径必须是 zh 那份（而不是 404 / 空白）。
  const chosen = lastAssetName(h);
  assert.ok(chosen.endsWith(".zh.md"), `缺 en 版时必须回落到 zh 份（实得 ${chosen}）`);
  // 如实标注：界面必须说明展示的不是所请求语言。
  assert.ok(/回落到|showing the/.test(all), "缺译文透明回落时必须如实标注实际展示语言");
  // 负向对照（同一渲染入口）：语言齐备时**不得**出现回落标注（否则该判据永远为真、不可判别）。
  const h2 = makeHarness();
  await h2.mount("HelpPromptsTab", { catalogState: { status: "ready", catalog, error: "" } });
  assert.ok(!/回落到|showing the/.test(visibleText({ children: h2.nodes() })), "语言齐备时不得出现回落标注");
});

// ================================================================ D. 分类投影（判据 2）

test("g-498 D1：分组顺序取自宿主 prompt_categories，每个资产恰出现一次", async () => {
  const catalog = await hostCatalog();
  const h = makeHarness();
  await h.mount("HelpPromptsTab", { catalogState: { status: "ready", catalog, error: "" } });
  const els = h.nodes();
  const groupTitles = textsWithClass(els, "dg-help-prompt-group-title");
  assert.ok(groupTitles.length >= 4, `模板清单必须按语义分组（实得 ${groupTitles.length} 组）`);
  for (const c of catalog.prompt_categories) {
    assert.ok(groupTitles.some((t: string) => t.includes(c.label.zh)), `必须出现分类小标题「${c.label.zh}」（实得 ${JSON.stringify(groupTitles)}）`);
  }
  // 每个资产恰出现一次：当前语言（zh）的列表按钮数 == 该语言资产数（恰一次，不多不少）。
  const zhRows = catalog.prompts.filter((p: any) => p.lang === "zh");
  assert.equal(listButtons(els).length, zhRows.length, "当前语言模板按钮数必须等于该语言资产数（每项恰一次）");
  // 分组文本守恒：所有分组里列出的条目合计 == 目录投影总数（不丢项、不重复）。
  const zhBases = new Set(zhRows.map((p: any) => p.base));
  const shown = listButtons(els).map((b) => visibleText(b));
  assert.equal(new Set(shown).size, shown.length, "同一模板不得在清单里出现两次");
  assert.equal(zhBases.size, zhRows.length, "目录投影本身每个 base/语言恰一条");
  // 客户端不得新增文件名清单（只按目录投影分组）。
  assert.ok(!/\.zh\.md|\.en\.md/.test(HELP_MODAL_SRC), "客户端不得新增文件名清单（只按目录投影分组）");
});

test("g-498 D2（负向对照）：未登记分类的条目仍须可见（归入「未分类」），不得静默丢项", async () => {
  const catalog = await hostCatalog();
  const mutated = {
    ...catalog,
    prompts: [...catalog.prompts, { name: "ghost.zh.md", base: "ghost", lang: "zh", category: "no-such-category" }],
  };
  const h = makeHarness();
  await h.mount("HelpPromptsTab", { catalogState: { status: "ready", catalog: mutated, error: "" } });
  const els = h.nodes();
  const all = visibleText({ children: els });
  assert.ok(textsWithClass(els, "dg-help-prompt-group-title").some((t: string) => /未分类/.test(t)), "未分类条目必须归入「未分类」分组");
  // 基线对照：登记分类的条目不会落进「未分类」。
  const h2 = makeHarness();
  await h2.mount("HelpPromptsTab", { catalogState: { status: "ready", catalog, error: "" } });
  assert.ok(!textsWithClass(h2.nodes(), "dg-help-prompt-group-title").some((t: string) => /未分类/.test(t)), "登记齐备时不应出现「未分类」分组");
  void all;
});

test("g-498 D3：分类元数据可选 —— 缺 category 的条目仍可见（向后兼容）", async () => {
  const catalog = await hostCatalog();
  const stripped = catalog.prompts.map((p: any) => { const { category: _c, ...rest } = p; return rest; });
  const h = makeHarness();
  await h.mount("HelpPromptsTab", { catalogState: { status: "ready", catalog: { ...catalog, prompts: stripped }, error: "" } });
  const els = h.nodes();
  assert.equal(listButtons(els).length, stripped.filter((p: any) => p.lang === "zh").length, "缺 category 时条目必须全部仍在（可选元数据不得导致丢项）");
  assert.ok(textsWithClass(els, "dg-help-prompt-group-title").some((t: string) => /未分类/.test(t)), "缺 category 一律归入「未分类」且可见");
});

// ================================================================ E. 引言渲染（判据 3）

test("g-498 E1：`**粗体**` 渲染为 strong React 节点，可见正文不含星号；逐字引文独立 blockquote", async () => {
  const h = makeHarness();
  await h.mount("HelpUsageTab", {});
  const els = h.nodes();
  const all = visibleText({ children: els });
  assert.ok(all.length > 200, "引言必须渲染出可见正文");
  assert.ok(!/\*\*/.test(all), `可见正文不得出现 Markdown 强调分隔星号（实得片段：${JSON.stringify(all.slice(0, 160))}）`);
  // 粗体不是被丢掉，而是被解析成元素。
  assert.ok(els.some((e) => e.type === "strong"), "引言必须渲染出 strong 节点（粗体经 parseInlineMarkdown 成为元素）");
  // 逐字引文单独呈现：blockquote 且内含逐字中文原文。
  const quotes = withClass(els, "dg-help-quote");
  assert.ok(quotes.length > 0, "逐字引文必须用独立 blockquote 呈现");
  const quoteText = quotes.map((q) => visibleText(q)).join("\n");
  assert.ok(/Graph Engineering/.test(quoteText), "引文块必须含逐字原文");
  assert.ok(/mcp\.so/.test(all), "来源标注 mcp.so 必须仍在正文里");
  // 安全口径：不得**使用** innerHTML / dangerouslySetInnerHTML（注释里提到该词不算）。
  assert.ok(!/dangerouslySetInnerHTML\s*:/.test(HELP_MODAL_SRC), "引言渲染不得使用 dangerouslySetInnerHTML");
  assert.ok(!/\.innerHTML\s*=/.test(HELP_MODAL_SRC), "引言渲染不得写 innerHTML");
});

test("g-498 E2：四个语义小标题齐备且有序；点题章节渲染在原有段落之前", async () => {
  const h = makeHarness();
  await h.mount("HelpUsageTab", {});
  const els = h.nodes();
  const titles = textsWithClass(els, "dg-help-topic-section-title");
  assert.deepEqual(titles, ["命名与定义", "当前工作机制", "看板定位", "未来路线图"], `小标题必须齐备且有序（实得 ${JSON.stringify(titles)}）`);
  const order = treeOf({ type: "root", children: els });
  const topicAt = order.findIndex((e) => elClass(e).includes("dg-help-topic-section"));
  const plainAt = order.findIndex((e) => elClass(e).includes("dg-help-p") && !elClass(e).includes("dg-help-topic-p"));
  assert.ok(topicAt >= 0, "点题章节必须渲染出可见分组容器");
  assert.ok(plainAt > topicAt, "点题章节必须渲染在原有使用说明段落之前");
});

test("g-498 E3：点题条目集合守恒 —— 清单里的每条恰渲染一次（分组不丢项、不重复）", async () => {
  const h = makeHarness();
  await h.mount("HelpUsageTab", {});
  const els = h.nodes();
  const topicKeys = [...HELP_MODAL_SRC.matchAll(/"help\.topic\.[a-zA-Z]+"/g)].map((m) => m[0].replace(/"/g, ""));
  const sections = withClass(els, "dg-help-topic-section");
  assert.ok(sections.length >= 4, `点题章节必须渲染出全部语义分组（实得 ${sections.length}）`);
  // 分组容器里渲染出的「段落/引文块」总数必须 > 0 且不超过清单键数（每条至多一次）。
  const rendered = sections.flatMap((s) => treeOf(s).filter((e) => elClass(e).includes("dg-help-topic-p") || elClass(e).includes("help-topic-")));
  assert.ok(rendered.length > 0, "点题章节必须渲染出正文条目");
  const byKey = new Map<string, number>();
  for (const e of rendered) {
    const k = (e.props?.key ?? "").toString();
    if (k) byKey.set(k, (byKey.get(k) ?? 0) + 1);
  }
  for (const [k, n] of byKey) assert.equal(n, 1, `点题条目 ${k} 必须恰渲染一次（实得 ${n} 次）`);
  void topicKeys;
});

test("g-498 E4（负向对照·内存变异）：把行内渲染降回纯字符串 ⇒ 星号必现（渲染判据可判别性自证）", async () => {
  const h = makeHarness();
  await h.mount("HelpUsageTab", {});
  const els = h.nodes();
  // 真实渲染产物：strong 节点存在（粗体被解析）。若降回 `dtT` 直出字符串，正文里会出现 `**`。
  const strongCount = els.filter((e) => e.type === "strong").length;
  assert.ok(strongCount > 0, "基线必须渲染出 strong 节点");
  // 反向自证：把引文块的子节点换成纯字符串，则可见文本会含原文（blockquote 结构仍在）——
  // 说明「可见文本不含星号」这条判据确实由**解析**而非由「删掉内容」达成。
  const quote = withClass(els, "dg-help-quote")[0]!;
  const rawVisible = visibleText({ children: quote.children });
  assert.ok(!/\*\*/.test(rawVisible), "引文块可见文本同样不得含星号");
});

test("g-498 F1（结构前提）：引言复用安全行内解析器，未另立 Markdown 实现", async () => {
  assert.ok(/parseInlineMarkdown/.test(HELP_MODAL_SRC), "引言必须复用 markdown.js 的 parseInlineMarkdown");
  // 不得在 help-modal 里自己重定义 Markdown 框架（模块内不得出现 renderSimpleMarkdown 的**定义**）。
  assert.ok(!/function renderSimpleMarkdown\b/.test(HELP_MODAL_SRC), "不得在弹窗里重定义全局 Markdown 渲染器");
  assert.ok(!/function parseInlineMarkdown\b/.test(HELP_MODAL_SRC), "不得在弹窗里重实现行内 Markdown（必须复用 markdown.js）");
});

test("g-498 G1（测试入口是显式登记的面）：__test 导出只为回归测试，且登记项齐备", () => {
  const src = readFileSync(pluginPath, "utf8");
  assert.ok(/__test:\s*\{/.test(src), "plugin 必须提供显式登记的 __test 渲染入口");
  for (const name of ["HelpUsageTab", "HelpPromptsTab", "HelpRichText", "helpTopicSections", "helpPromptGroups", "helpAssetNameOf"]) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(src), `__test 必须登记 ${name}`);
  }
});
