/**
 * g-431：desktop 上「插件文案恒为中文 / 不跟随宿主语言」的回归守卫（Linux 上可判定，不依赖 desktop 真机）。
 *
 * 成因链（负责人 desktop 真机取证 + 代码实证，勿再推翻）：
 *  1. `dsh web` profile 里 locale 先于本插件注册 ⇒ apply 时 `optionalService(ctx,"locale")` 有值 ⇒
 *     旧写法的条件订阅照常挂上 ⇒ 语言跟随；desktop 冷启动里 locale **迟到** ⇒ 旧写法整段被跳过。
 *  2. g-425 之前那次「迟到」被一次 fiber FAILED + runner 重试**掩盖**了：第一次 apply 裸取 `ctx.locale`
 *     抛错 ⇒ entry FAILED ⇒ 依赖就绪后 runner 重试第二次 apply ⇒ 那次 localeService 有值 ⇒ 订阅被注册。
 *  3. g-425 改成受保护读取后第一次 apply 不再失败 ⇒ 重试不再发生 ⇒ `localeService === null` 恒成立 ⇒
 *     字典没注册、订阅没挂、`dgT` 停在本地中文字典降级 ⇒ 真机所见「desktop 插件文案恒为中文」
 *     （宿主自身界面照常切换 ⇒ 缺口确实在「我们从未绑到活跃 locale」，不只是事件没收到）。
 *
 * 判据覆盖（全部在 Linux 可判定）：
 *  A. 迟到绑定真发生：夹具复现 `ctx.get("locale")` 在 apply 时为 undefined（且未声明服务属性访问即抛），
 *     随后 locale 服务注册、**不发任何事件** ⇒ 翻译函数立即切到宿主语言，且广播一次
 *     `dsh-graph:locale-changed`（window 桩计数）；随后每次活跃切换继续跟随（subscribe 路径 +
 *     旧宿主 `locale/change` 回退路径各一条）。
 *  B. apply 存活（g-425 不变量）：迟到场景下 apply 不抛、slot / settings section / 右侧栏 tab 全部注册完成。
 *  C. 负向对照可证伪：把实现内联改回「`if (localeService && …)` 条件订阅」形态后，**同一断言函数实拍变红**，
 *     且红点落在「迟到绑定后文案必须跟随」这条断言上（不是崩溃、不是别的偶发异常）。
 *  D. disposal-safe：字典注册与订阅都走 `scope.effect`；作用域释放后字典被撤销、监听不再回调。
 *  E. 非浏览器环境：`window` 缺席时广播静默降级、不抛错。
 *  F. 静态守卫：`locale` 不在硬 inject；本地化回调内零裸服务属性读取（与 g-425 守卫同口径）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const repoRoot = join(import.meta.dirname, "../..");
const bundlePath = join(repoRoot, "dist", "lib", "client.js");
const pluginSrcPath = join(repoRoot, "dsh-graph-host", "lib", "client", "plugin.js");

/** 迟到绑定块在源码/bundle 里的边界锚点（build-client.sh 逐字拼接 ⇒ 与源码同形）。 */
const LATE_BIND_START = "        // g-431：**迟到绑定**";
const LATE_BIND_END = '        ctx.slots.inject("conversation.session.header.actions", () =>';
const LATE_BIND_ENTRY = '        ctx.inject?.(["locale"], (scope) => {';
/** 修复前形态（g-425 收尾时）：条件订阅——locale 缺席即整段跳过。负向对照逐字复用该形态。 */
const LEGACY_BLOCK = [
  '        if (localeService && typeof ctx.on === "function") {',
  "          ctx.on('locale/change', () => {",
  "            try {",
  "              dgT = createTranslator(localeBind || registerI18n({ locale: localeService }));",
  "              window.dispatchEvent(new CustomEvent('dsh-graph:locale-changed'));",
  "            } catch { /* 静默 */ }",
  "          });",
  "        }",
].join("\n");

const ZH_BOARD_TITLE = "看板";
const EN_BOARD_TITLE = "Kanban";
const GATE_ALLOWED = ["locale", "remote"];

const gateError = (name: string) => `cannot get property "${name}" without inject`;

// ============================================================================
// 加载器：在 vm 沙箱里求值 dist/lib/client.js，取回插件对象（手法与 g-425 同源）
// ============================================================================

const fakeReact = () => ({
  createElement: () => ({ __el: true }),
  Fragment: "F",
  Component: class Component { props: any; constructor(p: any) { this.props = p || {}; } setState() {} forceUpdate() {} render() { return null; } },
  PureComponent: class PureComponent { props: any; constructor(p: any) { this.props = p || {}; } setState() {} forceUpdate() {} render() { return null; } },
  useState: (v: any) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {}, useLayoutEffect: () => {}, useMemo: (f: any) => f(), useCallback: (f: any) => f,
  useRef: (v: any) => ({ current: v }), useReducer: (r: any, i: any) => [typeof i === "function" ? i() : i, () => {}],
  useSyncExternalStore: (s: any, g: any) => g(), createContext: () => ({ Provider: "P", Consumer: "C" }),
  forwardRef: (f: any) => f, memo: (f: any) => f, cloneElement: (e: any) => e,
  Children: { map: () => [], toArray: () => [] },
});

interface Loaded {
  plugin: any;
  logs: string[];
  dispatched: string[];
  /** 模拟「无 DOM 环境」：加载完成后摘掉 window（`typeof window === "undefined"`）。 */
  dropWindow: () => void;
}

function loadClientPlugin(bundleCode: string): Loaded {
  const logs: string[] = [];
  const dispatched: string[] = [];
  const sandbox: any = {
    console: {
      log: (...a: any[]) => logs.push(a.join(" ")),
      warn: (...a: any[]) => logs.push("WARN " + a.join(" ")),
      error: (...a: any[]) => logs.push("ERR " + a.join(" ")),
    },
    location: { origin: "http://127.0.0.1:3091", href: "http://127.0.0.1:3091/" },
    navigator: { userAgent: "g431-late-bind-harness" },
    performance: { now: () => 0, getEntriesByType: () => [] },
    setTimeout, clearTimeout,
    requestAnimationFrame: (f: any) => setTimeout(f, 0),
    CustomEvent: class CustomEvent { type: string; constructor(t: string) { this.type = t; } },
    document: {
      querySelectorAll: () => [], querySelector: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      body: null,
    },
    __DISPATCH: dispatched,
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(
    'window = globalThis; window.addEventListener = function () {}; window.removeEventListener = function () {};' +
    'window.dispatchEvent = function (ev) { globalThis.__DISPATCH.push(ev && ev.type); return true; };' +
    'globalThis.__DSH_BOOT__ = { rev: "g431-r1", entries: [], batches: [] };' +
    'globalThis.__CAP = { reg: null };' +
    'window.__ModuleLoader__ = { load: function (r) { globalThis.__CAP.reg = r; } };',
    context,
    { filename: "g431-boot-shim.js" },
  );
  vm.runInContext(bundleCode, context, { filename: "client.js" });
  const reg = vm.runInContext("__CAP.reg", context);
  assert.ok(reg && typeof reg.factory === "function", "bundle 必须经 __ModuleLoader__.load 注册工厂");

  const seed = new Map<string, any>([
    ["react", fakeReact()],
    ["react-dom", { createRoot: () => ({ render() {}, unmount() {} }), createPortal: (n: any) => n, flushSync: (f: any) => f() }],
    ["@deepseek-ai/dsh-client-ui-primitives", { MarkdownText: function MarkdownText() {} }],
  ]);
  const plugin = reg.factory((spec: string) => {
    if (seed.has(spec)) return seed.get(spec);
    throw new Error(`client-modules: require("${spec}") missed the module table`);
  });
  return { plugin, logs, dispatched, dropWindow: () => vm.runInContext("window = undefined;", context) };
}

// ============================================================================
// locale 服务替身：register/bind/subscribe/getSnapshot 语义与宿主 Face 契约同形
// ============================================================================

interface LocaleDouble {
  register: (ns: string, dicts: Record<string, Record<string, string>>) => () => void;
  bind: (ns: string) => (key: string) => string;
  subscribe?: (fn: () => void) => () => void;
  getSnapshot: () => { active: string; locales: any[]; revision: number };
  setLocale: (id: string) => void;
  hasNamespace: (ns: string) => boolean;
  subscriberCount: () => number;
}

function makeLocaleDouble(opts: { subscribe: boolean; emitChange: (fn: () => void) => void }): LocaleDouble {
  const dicts = new Map<string, Map<string, Record<string, string>>>();
  const subs = new Set<() => void>();
  let active = "zh";
  let revision = 0;
  const publish = (notify: boolean) => { revision += 1; if (notify) for (const fn of [...subs]) fn(); };
  const svc: LocaleDouble = {
    register(ns, dictsObj) {
      let table = dicts.get(ns);
      if (!table) { table = new Map(); dicts.set(ns, table); }
      for (const locale of Object.keys(dictsObj)) {
        if (table.has(locale)) throw new Error(`locale namespace "${ns}" already has locale "${locale}"`);
      }
      for (const [locale, entries] of Object.entries(dictsObj)) table.set(locale, entries);
      publish(true);
      return () => {
        const owner = dicts.get(ns);
        if (!owner) return;
        let removed = false;
        for (const [locale, entries] of Object.entries(dictsObj)) {
          if (owner.get(locale) === entries) { owner.delete(locale); removed = true; }
        }
        if (removed) publish(true);
      };
    },
    bind(ns) {
      // 与宿主 bind 同语义：稳定引用、按**当前活跃语言**求值，未命中返回 key。
      return (key: string) => {
        const table = dicts.get(ns);
        const entries = table?.get(active) ?? table?.get("en");
        return entries && Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : key;
      };
    },
    getSnapshot: () => ({ active, locales: [{ id: "zh", label: "中文" }, { id: "en", label: "English" }], revision }),
    setLocale(id: string) {
      if (id === active) return;
      active = id;
      publish(true);
      opts.emitChange(() => {}); // 宿主：setLocale 既推进 revision，也 emit 全局 locale/change
    },
    hasNamespace: (ns: string) => (dicts.get(ns)?.size ?? 0) > 0,
    subscriberCount: () => subs.size,
  };
  if (opts.subscribe) svc.subscribe = (fn) => { subs.add(fn); return () => { subs.delete(fn); }; };
  return svc;
}

// ============================================================================
// 冷启动夹具：注入门禁 + cordis 迟到绑定语义（locale 缺席时回调被 park）
// ============================================================================

interface Boot {
  applyError: any;
  calls: string[];
  gateHits: string[];
  registeredSlots: string[];
  tabRegistrations: any[];
  effects: number;
  label: () => any;
  tabTitle: () => any;
  provideLocale: (active?: string) => void;
  replaceLocale: (active?: string) => void;
  setActive: (id: string) => void;
  broadcasts: () => number;
  disposeInjected: () => void;
  hasNamespace: (ns: string) => boolean;
  subscriberCount: () => number;
}

function makeSlots(label: string, calls: string[], registrations: any[]) {
  return {
    inject(name: string, thunk: any) { calls.push(`slots.inject@${label}:${name}`); return thunk(); },
    register(meta: any, comp: any) {
      calls.push(`slots.register@${label}:${meta?.name}`);
      registrations.push({ slotName: meta?.name, meta, comp, at: label });
      return () => {};
    },
  };
}

/** 冷启动：`inject: ["slots","sessions"]` 就绪；locale/remote 缺席（`ctx.get` 返回 undefined）；门禁代理。
 *  `prelocale` 给出时模拟 web profile：locale **先于**本插件注册（apply 时即有值）。 */
function runColdBoot(plugin: any, runtime: { dispatched: string[]; subscribe?: boolean; prelocale?: string }): Boot {
  const subscribePath = runtime.subscribe !== false;
  const calls: string[] = [];
  const gateHits: string[] = [];
  const registrations: any[] = [];
  const tabRegistrations: any[] = [];
  const changeHandlers: Array<() => void> = [];
  const scopeDisposers: Array<() => void> = [];
  let effects = 0;
  let localeCb: any = null;

  const rootSlots = makeSlots("root", calls, registrations);
  const services: Record<string, any> = {
    slots: rootSlots,
    sessions: { open: () => {}, openSubagent: () => {} },
    connection: { api: {} },
    workspaces: undefined,
    locale: undefined,
    settingsScope: undefined,
    remote: undefined,
    sidebarRightTabs: {
      register: (def: any) => { calls.push("sidebarRightTabs.register"); tabRegistrations.push(def); return () => {}; },
    },
  };

  const gated = (own: Record<string, any>, declared: string[]) => new Proxy(own, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      const name = String(prop);
      if (name === "prototype" || name === "then" || name.startsWith("_")) return Reflect.get(target, prop, receiver);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      if (declared.includes(name)) return undefined;
      gateHits.push(name);
      throw new Error(gateError(name));
    },
  });

  const makeScope = (declared: string[], extra: Record<string, any>) => gated({
    get: (name: string) => services[name],
    on: (ev: string, fn: any) => {
      calls.push(`on:${ev}`);
      const bucket = ev === "locale/change" ? changeHandlers : [];
      bucket.push(fn);
      const dispose = () => { const i = bucket.indexOf(fn); if (i >= 0) bucket.splice(i, 1); };
      scopeDisposers.push(dispose);
      return dispose;
    },
    effect: (fn: any) => {
      effects += 1;
      const dispose = fn();
      if (typeof dispose === "function") scopeDisposers.push(dispose);
      return dispose;
    },
    inject: (deps: string[], cb: any) => {
      calls.push(`inject:${deps.join(",")}`);
      if (typeof cb !== "function") return undefined;
      if (deps.includes("locale")) {
        localeCb = cb;
        if (!services.locale) return undefined; // 依赖未就绪 ⇒ park（迟到绑定）
        return cb(makeScope(["locale"], { locale: services.locale }));
      }
      if (deps.includes("remote")) return undefined; // remote 冷启动缺席 ⇒ 回调不执行
      if (deps.includes("sidebarRightTabs")) {
        const tabs = services.sidebarRightTabs;
        if (!tabs) return undefined;
        return cb(makeScope(["slots", "sessions", "sidebarRightTabs"], { slots: rootSlots, sessions: services.sessions, sidebarRightTabs: tabs }));
      }
      return cb(makeScope(["slots", "sessions"], { slots: rootSlots, sessions: services.sessions }));
    },
    ...extra,
  }, declared);

  const emitChange = () => { for (const fn of [...changeHandlers]) fn(); };

  // web profile：locale 先注册（apply 时 `ctx.get("locale")` 即有值）⇒ 走 apply 阶段立即绑定 + 迟到绑定回调同拍执行。
  if (runtime.prelocale) {
    const svc = makeLocaleDouble({ subscribe: subscribePath, emitChange });
    if (runtime.prelocale !== "zh") svc.setLocale(runtime.prelocale);
    services.locale = svc;
  }

  const ctx = makeScope(["slots", "sessions"], { slots: rootSlots, sessions: services.sessions });
  let applyError: any = null;
  try { plugin.apply(ctx); } catch (e) { applyError = e; }

  return {
    applyError, calls, gateHits, tabRegistrations,
    get registeredSlots() { return registrations.map((r) => r.slotName).sort(); },
    get effects() { return effects; },
    label: () => registrations.find((r) => r.slotName === "conversation.view")?.meta.label(),
    tabTitle: () => tabRegistrations[0]?.title(),
    provideLocale(active = "en") {
      const svc = makeLocaleDouble({ subscribe: subscribePath, emitChange });
      if (active !== "zh") svc.setLocale(active);
      services.locale = svc;
      if (typeof localeCb === "function") localeCb(makeScope(["locale"], { locale: svc }));
    },
    /** provider 重启/重放：旧作用域释放（跑 disposer）⇒ 新服务实例 ⇒ 重新执行同一 inject 回调。 */
    replaceLocale(active = "en") {
      for (const d of scopeDisposers.splice(0).reverse()) { try { d(); } catch { /* 静默 */ } }
      const svc = makeLocaleDouble({ subscribe: subscribePath, emitChange });
      if (active !== "zh") svc.setLocale(active);
      services.locale = svc;
      if (typeof localeCb === "function") localeCb(makeScope(["locale"], { locale: svc }));
    },
    setActive: (id: string) => services.locale.setLocale(id),
    broadcasts: () => runtime.dispatched.filter((type) => type === "dsh-graph:locale-changed").length,
    disposeInjected: () => { for (const d of scopeDisposers.splice(0).reverse()) { try { d(); } catch { /* 静默 */ } } },
    hasNamespace: (ns: string) => services.locale?.hasNamespace(ns) ?? false,
    subscriberCount: () => services.locale?.subscriberCount() ?? 0,
  };
}

// ============================================================================
// 共享断言：正例直接调用；负向对照用同一函数捕红（红点必须落在语言跟随上）
// ============================================================================

/** g-425 不变量：迟到场景下 apply 必须存活并完成全部注册。 */
function assertColdBootSurvives(boot: Boot): void {
  assert.equal(boot.applyError, null, `冷启动 apply 不得抛错：${boot.applyError?.message ?? ""}`);
  for (const hit of boot.gateHits) {
    assert.ok(GATE_ALLOWED.includes(hit), `apply 期间不得触碰未声明服务的裸属性（门禁命中 ${hit}）`);
  }
  assert.deepEqual(boot.registeredSlots, [
    "conversation.session.header.actions",
    "conversation.view",
    // g-453（返工后）：profile 全局设置页**两个**席位（设置 → 看板设置 / 插件面板组合包配置页）；
    // 「设置 → 内置插件」标签页席位已按负责人裁定取消 ⇒ 不再出现在注册面（反向断言见下）。
    "plugins.bundle.config",
    "settings.section",
    "sidebar.right.pane.tab",
    "sidebar.right.pane.tab.title",
  ], "slot + settings section + 右侧栏 tab/标题 seat 必须全部注册完成");
  // g-453 返工反向断言：已取消的 tab 席位在**任一**冷启动/迟到绑定路径下都不得被注册或 inject；
  // 判别力自证（重加该席位必红）见文件末尾 `g-453 返工判别力自证` 用例。
  assert.ok(!boot.registeredSlots.includes("settings.plugins.tab"),
    "settings.plugins.tab 不得被注册（负责人已裁定设置面收敛为两个入口）");
  assert.ok(!boot.calls.some((c) => c.endsWith(":settings.plugins.tab")),
    "不得对 settings.plugins.tab 发起 slots.inject / register（无死代码）");
  assert.equal(boot.tabRegistrations.length, 1, "sidebarRightTabs.register 必须调用一次");
}

/** g-431 判据 A：迟到注册（不发事件）即跟随；此后每次 locale/change 继续跟随且广播。 */
function assertLateBindFollows(boot: Boot): void {
  assert.equal(boot.applyError, null, `apply 不得抛错：${boot.applyError?.message ?? ""}`);
  const before = boot.broadcasts();

  // ① 服务迟到注册，**不发任何语言切换事件** ⇒ 文案必须立刻切到宿主语言（desktop 真机缺口正在此）。
  boot.provideLocale("en");
  const late = boot.label();
  assert.equal(late, EN_BOARD_TITLE, `g431:late-bind 服务迟到注册（无事件）后必须切到宿主语言 en（期望 ${EN_BOARD_TITLE}，实际 ${String(late)}）`);
  assert.equal(boot.broadcasts(), before + 1, "迟到绑定必须立即广播一次 dsh-graph:locale-changed（已挂载容器需要重渲染）");

  // ② 活跃语言切换继续跟随（切走 → 切回），每次都广播重渲染。
  boot.setActive("zh");
  assert.equal(boot.label(), ZH_BOARD_TITLE, "g431:late-bind locale/change 后必须跟随切回 zh");
  boot.setActive("en");
  assert.equal(boot.label(), EN_BOARD_TITLE, "g431:late-bind locale/change 后必须继续跟随切到 en");
  assert.equal(boot.broadcasts(), before + 3, "每次语言切换都必须广播重渲染事件");

  // ③ 右侧栏 chip 标题 seat 走同一 dgT，必须同步（顶层 slot 的文案一致跟随）。
  assert.equal(boot.tabTitle(), EN_BOARD_TITLE, "g431:late-bind 右侧栏 tab 标题必须同步跟随");
}

/** 内联变异：把「按服务实例去重」的注册守卫换回「只在首个实例注册」（provider 重启后字典缺失）。 */
const REGISTER_GUARD_ENTRY = "if (localeRegisteredOn !== svc) {";
const REGISTER_GUARD_LEGACY = "if (!localeBind) {";

/** 服务实例更换后的重新注册断言（locale **先就绪**的 profile + provider 重启；正例与变异负向对照共用）。 */
function assertReregistersAfterRestart(boot: Boot): void {
  assertColdBootSurvives(boot);
  assert.equal(boot.hasNamespace("dsh-graph"), true, "apply 阶段（locale 先就绪）必须已注册字典");
  assert.equal(boot.label(), EN_BOARD_TITLE, "apply 阶段即绑定宿主语言 en");

  boot.replaceLocale("en"); // 旧作用域释放 + 新服务实例 + 同一 inject 回调重放
  assert.equal(boot.hasNamespace("dsh-graph"), true,
    "g431:reregister 新服务实例上必须重新注册字典（apply 阶段那次的实例已随 provider 下线，新实例缺命名空间 ⇒ 翻译退回本地中文字典）");
  assert.equal(boot.subscriberCount(), 1, "g431:reregister 新实例上订阅必须恰好一条（旧实例监听已随作用域释放）");
  boot.setActive("zh");
  assert.equal(boot.label(), ZH_BOARD_TITLE, "g431:reregister 新实例上语言切换必须继续跟随");
}

/** 内联变异：把迟到绑定整段换回修复前的「条件订阅」形态（逐字复用旧实现）。 */
function mutateToLegacyBundle(bundle: string): string {
  const start = bundle.indexOf(LATE_BIND_START);
  const end = bundle.indexOf(LATE_BIND_END);
  assert.ok(start > 0, "负向对照锚点：迟到绑定块起点必须在 bundle 中命中（改完须 bash scripts/build.sh）");
  assert.ok(end > start, "负向对照锚点：迟到绑定块终点必须在起点之后");
  const mutated = bundle.slice(0, start) + LEGACY_BLOCK + "\n" + bundle.slice(end);
  assert.notEqual(mutated, bundle, "负向对照必须真的改写了产物（否则用例空转）");
  assert.ok(!mutated.includes(LATE_BIND_ENTRY), "变异产物不得再含迟到绑定入口");
  assert.ok(mutated.includes('if (localeService && typeof ctx.on === "function")'), "变异产物必须逐字含修复前形态");
  return mutated;
}

function captureThrows(fn: () => void): any {
  try { fn(); } catch (e) { return e; }
  return null;
}

// ============================================================================
// 判据 A / B：迟到绑定真发生 + apply 存活
// ============================================================================

test("g-431 判据A/B：locale 迟到注册（无事件）即绑定，活跃切换继续跟随，且 apply 完成全部注册", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  assert.ok(bundle.includes(LATE_BIND_START) && bundle.includes(LATE_BIND_ENTRY),
    "bundle 必须含迟到绑定实现（改完须 bash scripts/build.sh）");
  assert.ok(bundle.includes("'board.title': 'Kanban'"), "bundle 必须带 en 字典（断言值来自真实字典）");
  const loaded = loadClientPlugin(bundle);
  assert.deepEqual([...loaded.plugin.inject], ["slots", "sessions"], "服务依赖声明不得改动（本目标禁区）");

  const boot = runColdBoot(loaded.plugin, { dispatched: loaded.dispatched });
  assertColdBootSurvives(boot);
  assert.ok(boot.calls.includes("inject:locale"), "必须声明迟到绑定 ctx.inject([\"locale\"], …)");
  assertLateBindFollows(boot);
  assert.ok(boot.effects >= 2, "字典注册与订阅都必须走 scope.effect（disposal-safe）");
});

test("g-431 判据A（web profile 等价路径）：locale 先就绪时不得重复注册字典、订阅仍恰好一条", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  const loaded = loadClientPlugin(bundle);
  const boot = runColdBoot(loaded.plugin, { dispatched: loaded.dispatched, prelocale: "en" });
  assertColdBootSurvives(boot);
  assert.equal(boot.label(), EN_BOARD_TITLE, "locale 先就绪时 apply 阶段即绑定宿主语言");
  // 迟到绑定回调与 apply 阶段都持同一服务：字典若重复注册会抛 `already has locale`，
  // 且该抛错发生在订阅之前 ⇒ subscriberCount 会掉到 0（这条断言正是钉住该重复注册陷阱）。
  assert.equal(boot.hasNamespace("dsh-graph"), true, "字典必须注册恰好一次（不得重复注册）");
  assert.equal(boot.subscriberCount(), 1, "订阅必须恰好一条（apply 阶段与回调不得各挂一条）");
  boot.setActive("zh");
  assert.equal(boot.label(), ZH_BOARD_TITLE, "web profile 上语言切换必须继续跟随（不退化）");
  assert.equal(boot.tabTitle(), ZH_BOARD_TITLE, "web profile 上右侧栏标题同样跟随");
});

test("g-431 判据A（旧宿主回退路径）：服务无 subscribe 时订阅退回全局 locale/change，行为不变", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  const loaded = loadClientPlugin(bundle);
  const boot = runColdBoot(loaded.plugin, { dispatched: loaded.dispatched, subscribe: false });
  assertColdBootSurvives(boot);
  assertLateBindFollows(boot);
  assert.ok(boot.calls.includes("on:locale/change"), "无 subscribe 的旧宿主必须退回 `scope.on('locale/change', …)`");
});

// ============================================================================
// 判据 C：负向对照 —— 改回条件订阅必红（同一断言函数实拍变红）
// ============================================================================

test("g-431 判据C 负向对照：内联改回「if (localeService) 条件订阅」后同一断言必红", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  const mutated = mutateToLegacyBundle(bundle);
  const loaded = loadClientPlugin(mutated);
  const boot = runColdBoot(loaded.plugin, { dispatched: loaded.dispatched });

  // 形态回退不影响 apply 存活（与真机一致：g-425 之后 apply 照常完成）⇒ 红点必须落在语言跟随，而不是崩溃。
  assertColdBootSurvives(boot);
  assert.ok(!boot.calls.includes("inject:locale"), "变异产物不得再有迟到绑定入口");

  const red = captureThrows(() => assertLateBindFollows(boot));
  assert.ok(red, "改回条件订阅后，迟到绑定断言必须实拍变红（否则用例空转、鉴别力为零）");
  assert.match(String(red?.message), /g431:late-bind/,
    `红点必须落在「迟到绑定后文案必须跟随」这条断言上，实际：${String(red?.message)}`);
  assert.equal(boot.label(), ZH_BOARD_TITLE, "变异形态下翻译函数停在本地中文字典降级（真机缺口复现）");
  assert.equal(boot.broadcasts(), 0, "变异形态下迟到注册不广播（已挂载容器不会重渲染）");
});

// ============================================================================
// 判据 D：disposal-safe（作用域释放后字典撤销、监听不再回调）
// ============================================================================

test("g-431 判据D：字典注册与订阅随作用域释放（不重复注册、不泄漏监听）", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  const loaded = loadClientPlugin(bundle);
  const boot = runColdBoot(loaded.plugin, { dispatched: loaded.dispatched });
  assertColdBootSurvives(boot);
  boot.provideLocale("en");
  assert.equal(boot.hasNamespace("dsh-graph"), true, "迟到绑定必须真的注册 dsh-graph 命名空间");
  assert.equal(boot.subscriberCount(), 1, "订阅必须恰好挂一条（subscribe 与 locale/change 不得同时挂）");

  const before = boot.broadcasts();
  boot.disposeInjected();
  assert.equal(boot.hasNamespace("dsh-graph"), false, "作用域释放后字典注册必须被撤销");
  assert.equal(boot.subscriberCount(), 0, "作用域释放后订阅必须被移除");
  boot.setActive("zh");
  assert.equal(boot.broadcasts(), before, "作用域释放后不得再收到订阅回调（无监听泄漏）");
});

// ============================================================================
// 判据 E：非浏览器环境（window 缺席）广播静默降级、不抛错
// ============================================================================

test("g-431 判据D2：provider 重启（服务实例更换）后字典必须重新注册、语言仍跟随（含变异负向对照）", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  assert.ok(bundle.includes(REGISTER_GUARD_ENTRY), "bundle 必须含「按服务实例去重」的注册守卫");
  const loaded = loadClientPlugin(bundle);
  assertReregistersAfterRestart(runColdBoot(loaded.plugin, { dispatched: loaded.dispatched, prelocale: "en" }));

  // 变异：把「按实例去重」改回「只在首个实例注册」⇒ 新实例上字典缺失、翻译退回本地中文字典 ⇒ 必红。
  const mutated = bundle.replace(REGISTER_GUARD_ENTRY, REGISTER_GUARD_LEGACY);
  assert.notEqual(mutated, bundle, "负向对照必须真的改写了产物（否则用例空转）");
  const loadedMut = loadClientPlugin(mutated);
  const red = captureThrows(() => assertReregistersAfterRestart(runColdBoot(loadedMut.plugin, { dispatched: loadedMut.dispatched, prelocale: "en" })));
  assert.ok(red, "改回 `!localeBind` 守卫后 D2 必须实拍变红（否则该断言没有鉴别力）");
  assert.match(String(red?.message), /g431:reregister/, `红点必须落在重新注册断言上，实际：${String(red?.message)}`);
});

test("g-431 判据E：window 缺席时迟到绑定与切换均不抛错（广播静默降级）", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  const loaded = loadClientPlugin(bundle);
  loaded.dropWindow();
  const boot = runColdBoot(loaded.plugin, { dispatched: loaded.dispatched });
  assert.equal(boot.applyError, null, "无 DOM 环境 apply 不得抛错");
  boot.provideLocale("en");
  assert.equal(boot.label(), EN_BOARD_TITLE, "无 DOM 环境仍须完成迟到绑定与语言跟随");
  boot.setActive("zh");
  assert.equal(boot.label(), ZH_BOARD_TITLE, "无 DOM 环境切换仍须跟随");
  assert.equal(boot.broadcasts(), 0, "无 window 时不得广播（静默降级）");
});

// ============================================================================
// 判据 F：静态守卫（locale 不进硬 inject；本地化回调内零裸服务属性读取）
// ============================================================================

test("g-431 判据F：locale 不在硬 inject；迟到绑定回调内零裸服务属性读取", () => {
  const src = readFileSync(pluginSrcPath, "utf8");
  const injectDecl = /^\s*inject:\s*\[([^\]]*)\]/m.exec(src);
  assert.ok(injectDecl, "找不到 plugin.js 的 inject 声明（守卫 fail-closed）");
  const declared = injectDecl![1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  assert.deepEqual(declared, ["slots", "sessions"], "locale 绝不得进硬 inject（g-425 教训：整块 apply 会被阻断）");

  assert.ok(src.includes(LATE_BIND_ENTRY), "plugin.js 必须有迟到绑定入口 ctx.inject?.([\"locale\"], …)");
  assert.match(src, /ctx\.inject\?\.\(\["locale"\], \(scope\) => \{[\s\S]*?optionalService\(scope, "locale"\)/,
    "迟到绑定回调内必须走受保护读取 optionalService(scope, \"locale\")");
  assert.doesNotMatch(src, /\?\?\s*scope\s*\.\s*locale/, "回调内不得出现 `?? scope.locale` 裸回退");
  assert.doesNotMatch(src, /svc\s*=\s*scope\.locale\b/, "回调内不得裸取 scope.locale");
  assert.match(src, /typeof window !== "undefined"/, "广播必须有 `typeof window !== \"undefined\"` 保护");

  // 负向样本：守卫真的在鉴别（`if (localeService && …)` 形态不得再出现于源码）
  assert.equal(/if\s*\(\s*localeService\s*&&\s*typeof\s+ctx\.on\s*===\s*"function"\s*\)/.test(src), false,
    "源码里不得再有「有值才订阅」的条件订阅形态（这正是 desktop 语言不跟随的形态）");
});

// ============================================================================
// g-453 返工：已取消席位（settings.plugins.tab）的判别力自证（g431 面）
// ============================================================================

test("g-453 返工判别力自证：把 tab 席位重加回产物后，两席位清单与反向断言必红（合成变异对照）", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  // 合成变异（仅内存字符串）：锚点是保留席位 plugins.bundle.config 的 inject 调用，与已取消席位同处
  // `registerGraphSettingsSection(ctx)` 作用域 ⇒ ctx / dgT / h / GraphSettingsSection 均可解析。
  const anchor = 'ctx.slots.inject("plugins.bundle.config"';
  const snippet = [
    'ctx.slots.inject("settings.plugins.tab", () =>',
    '  ctx.slots.register({ name: "settings.plugins.tab", id: "dsh-graph", order: 60, label: () => dgT("settings.title") },',
    '    () => h(GraphSettingsSection, {})));',
    "",
  ].join("\n") + "        ";
  assert.ok(bundle.includes(anchor), "变异锚点必须命中产物（改完须 bash scripts/build.sh）");
  const mutated = bundle.replace(anchor, snippet + anchor);
  assert.notEqual(mutated, bundle, "变异必须真的改写产物（否则对照空转）");
  const loaded = loadClientPlugin(mutated);
  const boot = runColdBoot(loaded.plugin, { dispatched: loaded.dispatched });
  assert.ok(boot.registeredSlots.includes("settings.plugins.tab"), "变异产物必须真的注册了 tab 席位");
  const red = captureThrows(() => assertColdBootSurvives(boot));
  assert.ok(red, "重加 tab 席位后 assertColdBootSurvives（两席位清单 + 反向断言）必须实拍变红");
});
