/**
 * g-425 冷启动真因回归：客户端 `apply` 早期**不得对未声明服务做裸属性回退**。
 *
 * 为什么需要（真实成因链，已由负责人桌面端 diag 实测 + Cordis 源码实证，勿再推翻）：
 *  1. Cordis 的 Context 代理对「未在 `inject` 中声明、且 fiber 链上无实现」的属性访问**直接抛错**：
 *     `@deepseek-ai/cordis/lib/index.js:676`
 *     `throw new Error(\`cannot get property "${prop}" without inject\`)`；
 *     `ctx.get(name)`（ReflectService.get，cordis `get(name, strict = true)`）是唯一永不抛错的读取口径。
 *  2. 桌面冷启动 diag console：`+339ms apply:enter` → `+339ms apply:inject-resolved` → 该次 apply
 *     **再无任何日志**，随后 `web boot: 1 entry did not activate / dsh-graph: failed`；
 *     `+415ms` 第二次 apply 从 `apply:locale | localeService=有` 一路走完（locale 已就绪）。
 *     两次日志之间只有一条语句：`plugin.js` 的
 *     `const localeService = ctx.get?.("locale") ?? ctx.locale ?? null;`
 *     —— locale 尚未注册时 `ctx.get("locale")` 为 undefined ⇒ 求值 `?? ctx.locale` ⇒ 抛 ⇒ fiber FAILED。
 *  3. Web 壳与热启用因 locale 始终已就绪而从不触发；本套件用「注入门禁等价夹具」把它变成常驻回归。
 *
 * 判据覆盖：
 *  - 判据 12：门禁夹具（locale 未注册、未声明服务属性访问即抛）下 `apply` 必须**不抛**并通过
 *    slot / settings section / 右侧栏 tab 全部注册；locale 缺失时翻译函数仍返回可用字符串；
 *    负向对照：把该行改回 `?? ctx.locale` 的等价产物**必红**（证明用例真能鉴别本缺陷）。
 *  - 判据 13：客户端源码不再出现「针对未声明服务的裸属性回退」（静态守卫，fail-closed）；
 *    服务端半边 `resolvePromptLanguage` 的 locale 兜底必须 `ctx.get` 优先（否则兜底永久失效）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { resolvePromptLanguage } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const bundlePath = join(repoRoot, "dist", "lib", "client.js");
const clientSrcDir = join(repoRoot, "dsh-graph-host", "lib", "client");
const pluginSrcPath = join(clientSrcDir, "plugin.js");
const hostSrcPath = join(repoRoot, "dsh-graph-host", "index.js");

/** 修复后的读取行 / 缺陷版（pre-fix）读取行 —— 负向对照逐字复用真实源码形态。 */
const FIXED_LOCALE_LINE = 'const localeService = optionalService(ctx, "locale");';
const PREFIX_LOCALE_LINE = 'const localeService = ctx.get?.("locale") ?? ctx.locale ?? null;';
/** 只锚定 plugin.js `apply` 里那一处（i18n.js 的 registerI18n 也含同名行，不能只按第一处替换）。 */
const APPLY_TAIL = 'const localeBind = registerI18n({ locale: localeService });';
const FIXED_APPLY_SITE = `        ${FIXED_LOCALE_LINE}\n        ${APPLY_TAIL}`;
const PREFIX_APPLY_SITE = `        ${PREFIX_LOCALE_LINE}\n        ${APPLY_TAIL}`;

const gateError = (name: string) => `cannot get property "${name}" without inject`;

/**
 * 允许被门禁命中的「可选探测」服务名：`optionalService` 的**属性访问兜底**本身就会撞门禁，
 * 并按设计在 helper 内被 try/catch 吞掉（locale/remote 在冷启动时各命中一次）。
 * 关键不变式是这些抛错**不得逃逸**出 apply；出现名单外的命中即 fail-closed 判红。
 */
const CAUGHT_OPTIONAL_PROBES = ["locale", "remote"];

// ============================================================================
// 夹具：注入门禁等价的 Context 代理 + dist/lib/client.js 求值（手法参照 tmp/g425-diag/smoke.cjs）
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

/** 在 vm 沙箱里求值 bundle → 取回插件对象（模块求值 + factory 两步都必须成功）。 */
function loadClientPlugin(bundleCode: string) {
  const logs: string[] = [];
  const sandbox: any = {
    console: { log: (...a: any[]) => logs.push(a.join(" ")), warn: (...a: any[]) => logs.push("WARN " + a.join(" ")), error: (...a: any[]) => logs.push("ERR " + a.join(" ")) },
    location: { origin: "http://127.0.0.1:3091", href: "http://127.0.0.1:3091/" },
    navigator: { userAgent: "g425-cold-boot-harness" },
    performance: { now: () => 0, getEntriesByType: () => [] },
    setTimeout, clearTimeout,
    requestAnimationFrame: (f: any) => setTimeout(f, 0),
    CustomEvent: class CustomEvent { type: string; constructor(t: string) { this.type = t; } },
    document: {
      querySelectorAll: () => [], querySelector: () => null,
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      body: null,
    },
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(
    'window = globalThis; window.addEventListener = function () {}; window.dispatchEvent = function () {};' +
    'globalThis.__DSH_BOOT__ = { rev: "g425-r1", entries: [], batches: [] };' +
    'globalThis.__CAP = { reg: null };' +
    'window.__ModuleLoader__ = { load: function (r) { globalThis.__CAP.reg = r; } };',
    context,
    { filename: "g425-boot-shim.js" },
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
  return { plugin, logs };
}

interface ColdBoot {
  calls: string[];
  registrations: Array<{ slotName: string; meta: any; comp: any; at: string }>;
  tabRegistrations: any[];
  gateHits: string[];
  applyError: any;
}

/**
 * 冷启动夹具：
 *  - `inject: ["slots", "sessions"]`（与产品一致）两个服务**就绪**；
 *  - `ctx.get(name)` 读服务表：`locale`/`remote`/`settingsScope` 为 undefined（冷启动尚未注册）；
 *  - 门禁代理：凡访问**未在 inject 中声明**、且不是 ctx 自身方法/属性的属性 ⇒ 抛
 *    `cannot get property "<name>" without inject`（cordis/lib/index.js:676 同款；只读代理，不仿真 fiber 细节）。
 *  - deferred `ctx.inject(deps, cb)` 在依赖可选时**不回调**（remote 缺席），`sidebarRightTabs` 就绪时回调。
 */
function runColdBoot(plugin: any, opts: { sidebarPresent: boolean; remotePresent: boolean } = { sidebarPresent: true, remotePresent: false }): ColdBoot {
  const calls: string[] = [];
  const registrations: ColdBoot["registrations"] = [];
  const tabRegistrations: any[] = [];
  const gateHits: string[] = [];

  const makeSlots = (label: string) => ({
    inject(name: string, thunk: any) { calls.push(`slots.inject@${label}:${name}`); return thunk(); },
    register(meta: any, comp: any) {
      calls.push(`slots.register@${label}:${meta?.name}`);
      registrations.push({ slotName: meta?.name, meta, comp, at: label });
      return () => {};
    },
  });
  const rootSlots = makeSlots("root");

  const remoteService = opts.remotePresent ? { session: { openWorkspacePath: async () => ({ opened: true }) } } : undefined;
  const sidebarTabsService = { register: (def: any) => { calls.push("sidebarRightTabs.register"); tabRegistrations.push(def); return () => {}; } };

  /** 服务表：`ctx.get(name)` 读得到（未声明也不抛），但**属性访问**受门禁。 */
  const services: Record<string, any> = {
    slots: rootSlots,
    sessions: { open: () => {}, openSubagent: () => {} },
    connection: { api: {} },
    workspaces: undefined,
    locale: undefined,
    settingsScope: undefined,
    remote: remoteService,
    sidebarRightTabs: opts.sidebarPresent ? sidebarTabsService : undefined,
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

  const methods = {
    get: (name: string) => services[name],
    on: (ev: string) => { calls.push(`on:${ev}`); return () => {}; },
    inject: (deps: string[], cb: any) => {
      calls.push(`inject:${deps.join(",")}`);
      if (typeof cb !== "function") return undefined;
      if (deps.includes("sidebarRightTabs")) {
        if (!opts.sidebarPresent) return undefined;
        const scopeSlots = makeSlots("sidebar");
        return cb(gated({ ...methods, slots: scopeSlots, sessions: services.sessions, sidebarRightTabs: sidebarTabsService },
          ["slots", "sessions", "sidebarRightTabs"]));
      }
      if (deps.includes("remote")) {
        if (!opts.remotePresent) return undefined;
        return cb(gated({ ...methods, slots: rootSlots, sessions: services.sessions, remote: remoteService },
          ["slots", "sessions", "remote"]));
      }
      return cb(gated({ ...methods, slots: rootSlots, sessions: services.sessions }, ["slots", "sessions"]));
    },
  };

  // inject 声明的两个服务是 ctx 自身属性（cordis：已声明且已激活 ⇒ 可读）
  const ctx = gated({ ...methods, slots: rootSlots, sessions: services.sessions }, ["slots", "sessions"]);

  let applyError: any = null;
  try { plugin.apply(ctx); } catch (e) { applyError = e; }
  return { calls, registrations, tabRegistrations, gateHits, applyError };
}

// ============================================================================
// 判据 12：冷启动 apply 必须存活并完成注册
// ============================================================================

test("g-425 判据12：locale 未注册 + 未声明服务属性访问即抛时，客户端 apply 不抛且完成全部注册", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  assert.ok(bundle.includes(FIXED_LOCALE_LINE), "bundle 必须含修复后的受保护读取行（改完须 bash scripts/build.sh）");
  const { plugin } = loadClientPlugin(bundle);
  assert.deepEqual([...plugin.inject], ["slots", "sessions"], "服务依赖不得改动（本目标禁区）");

  const boot = runColdBoot(plugin);
  assert.equal(boot.applyError, null, `冷启动 apply 不得抛错：${boot.applyError?.message ?? ""}`);
  for (const hit of boot.gateHits) {
    assert.ok(CAUGHT_OPTIONAL_PROBES.includes(hit),
      `apply 期间不得触碰未声明服务的裸属性（门禁命中 ${hit}，允许集合 ${CAUGHT_OPTIONAL_PROBES.join("/")}）`);
  }
  assert.ok(boot.gateHits.includes("locale"), "夹具门禁必须真的生效（locale 探测至少命中一次）");

  const registeredSlots = boot.registrations.map((r) => r.slotName).sort();
  assert.deepEqual(registeredSlots, [
    "conversation.session.header.actions",
    "conversation.view",
    // g-453：profile 全局设置页新增两个席位（设置→内置插件 tab / 插件面板组合包配置页）
    "plugins.bundle.config",
    "settings.plugins.tab",
    "settings.section",
    "sidebar.right.pane.tab",
    "sidebar.right.pane.tab.title",
  ], "slot + settings section + 右侧栏 tab/标题 seat 必须全部注册完成");

  // 看板视图渲染函数可得：conversation.view 注册的是组件函数，且其 label thunk 可用
  const kanbanView = boot.registrations.find((r) => r.slotName === "conversation.view");
  assert.ok(kanbanView, "conversation.view 必须注册");
  assert.equal(typeof kanbanView!.comp, "function", "conversation.view 必须注册渲染函数（看板视图）");
  assert.equal(typeof kanbanView!.meta.label, "function", "label 必须是 locale-following thunk");
  assert.equal(kanbanView!.meta.id, "dsh-graph-kanban");

  const settingsSection = boot.registrations.find((r) => r.slotName === "settings.section");
  assert.ok(settingsSection, "settings.section 必须注册（设置页 section 命中）");
  assert.equal(settingsSection!.meta.id, "dsh-graph-settings");
  assert.equal(typeof settingsSection!.comp, "function");

  // g-453：三个席位**一律经 slots.inject 注册**（宿主只在对应页面挂载时才声明该 slot；
  // apply 里直接 register 会静默 no-op）。这两个新席位在冷启动夹具里也必须走 inject 回调。
  for (const seat of ["settings.section", "settings.plugins.tab", "plugins.bundle.config"]) {
    assert.ok(boot.calls.includes(`slots.inject@root:${seat}`), `${seat} 必须经 ctx.slots.inject 注册`);
  }

  // g-453 席位②：设置 → 内置插件 的 tab（id/order 稳定，label 与 section 同源 thunk）
  const pluginsTab = boot.registrations.find((r) => r.slotName === "settings.plugins.tab");
  assert.ok(pluginsTab, "settings.plugins.tab 必须注册（设置→内置插件 标签页席位）");
  assert.equal(pluginsTab!.meta.id, "dsh-graph");
  assert.equal(pluginsTab!.meta.order, 60);
  assert.equal(typeof pluginsTab!.meta.label, "function", "plugins tab label 必须是 locale-following thunk");
  assert.equal(pluginsTab!.meta.label(), settingsSection!.meta.label(), "两个席位的标签同源（dgT('settings.title')）");
  assert.equal(typeof pluginsTab!.comp, "function");

  // g-453 席位③：插件面板 → dsh-graph 组合包配置页（keyed by 包名；summary 按契约返回 null）
  const bundleConfig = boot.registrations.find((r) => r.slotName === "plugins.bundle.config");
  assert.ok(bundleConfig, "plugins.bundle.config 必须注册（组合包配置页席位）");
  assert.equal(bundleConfig!.meta.key, "dsh-graph", "组合包配置页必须按包名 dsh-graph 绑定 key");
  assert.equal(typeof bundleConfig!.comp, "function");
  assert.equal(bundleConfig!.comp({ view: "summary" }), null, "summary 视图必须返回 null（列表摘要不渲染配置表单）");
  assert.ok(bundleConfig!.comp({ view: "page" }), "page 视图必须渲染配置表单");

  // 右侧栏 tab：类型面 + 本体 seat + chip 标题 seat
  assert.equal(boot.tabRegistrations.length, 1, "sidebarRightTabs.register 必须调用一次");
  assert.equal(boot.tabRegistrations[0].id, "dsh-graph");
  assert.equal(boot.tabRegistrations[0].kind, "dsh-graph");
  const sidebarSeats = boot.registrations.filter((r) => r.at === "sidebar").map((r) => r.slotName).sort();
  assert.deepEqual(sidebarSeats, ["sidebar.right.pane.tab", "sidebar.right.pane.tab.title"]);

  // locale 缺席 ⇒ 不发生 locale/change 订阅（既有降级语义），但注册照样完成
  assert.ok(!boot.calls.includes("on:locale/change"), "locale 缺失时不得依赖 locale 服务订阅语言切换");
});

test("g-425 判据12：locale 缺失时翻译函数仍返回可用字符串（降级不抛，不回落成裸 key）", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  const { plugin } = loadClientPlugin(bundle);
  const boot = runColdBoot(plugin);
  assert.equal(boot.applyError, null);

  // dgT 是工厂作用域私有变量，只能经注册元数据的 thunk 观测（与宿主 resolveSlotLabel 同一消费路径）
  const kanbanView = boot.registrations.find((r) => r.slotName === "conversation.view")!;
  const label = kanbanView.meta.label();
  assert.equal(typeof label, "string");
  assert.ok(label.length > 0, "翻译函数必须返回非空字符串");
  assert.notEqual(label, "board.title", "locale 缺失时必须走本地字典降级，不得把 i18n key 原样吐出");

  const tabTitle = boot.tabRegistrations[0].title();
  assert.equal(typeof tabTitle, "string");
  assert.ok(tabTitle.length > 0);
  assert.notEqual(tabTitle, "sidebar.tab.title", "guide/tab thunk 同样必须走字典降级");
  assert.equal(typeof boot.tabRegistrations[0].guide[0].description(), "string");
});

test("g-425 判据12 负向对照：把该行改回 `?? ctx.locale` 裸回退的等价产物必红（注入门禁错误）", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  assert.ok(bundle.includes(FIXED_APPLY_SITE), "负向对照的锚点必须命中 plugin.js apply 里的修复行");
  const prefixBundle = bundle.replace(FIXED_APPLY_SITE, PREFIX_APPLY_SITE);
  assert.notEqual(prefixBundle, bundle, "负向对照必须真的改写了产物（否则用例空转）");
  assert.ok(!prefixBundle.includes(FIXED_APPLY_SITE), "变异产物不得再含该修复行");
  assert.ok(prefixBundle.includes(PREFIX_APPLY_SITE), "变异产物必须逐字含 pre-fix 表达式");

  const { plugin } = loadClientPlugin(prefixBundle);
  const boot = runColdBoot(plugin);
  assert.ok(boot.applyError, "pre-fix 产物在冷启动夹具下必须抛错（改回裸回退必红）");
  assert.match(String(boot.applyError.message), /cannot get property "locale" without inject/,
    "红因必须是 cordis 注入门禁错误，而不是别的偶发异常");
  assert.deepEqual(boot.gateHits, ["locale"], "门禁命中的正是未声明的 locale");
  assert.equal(boot.registrations.length, 0, "抛错发生在注册之前 ⇒ 一条注册都不该完成（fiber FAILED 的真实形态）");
});

test("g-425 判据12：sidebarRightTabs 缺席（精简 profile/旧宿主）时同样必须不抛、注册照旧降级", () => {
  const bundle = readFileSync(bundlePath, "utf8");
  const { plugin } = loadClientPlugin(bundle);
  const boot = runColdBoot(plugin, { sidebarPresent: false, remotePresent: false });
  assert.equal(boot.applyError, null, "右侧栏服务缺席不得拖垮 apply");
  for (const hit of boot.gateHits) assert.ok(CAUGHT_OPTIONAL_PROBES.includes(hit), `门禁命中不得越界：${hit}`);
  assert.deepEqual(boot.registrations.map((r) => r.slotName).sort(),
    // g-453：设置页三个席位与右侧栏 tab 无关 ⇒ 右侧栏缺席时照旧全注册
    ["conversation.session.header.actions", "conversation.view", "plugins.bundle.config", "settings.plugins.tab", "settings.section"]);
  assert.equal(boot.tabRegistrations.length, 0);
});

// ============================================================================
// 判据 13：静态守卫 —— 客户端源码不得再出现未声明服务的裸属性回退
// ============================================================================

/** Cordis Context 自身的方法/属性面（不走服务门禁，见 cordis `ReflectService` 的 mixin 列表）。 */
const CTX_SURFACE = new Set([
  "get", "set", "provide", "accessor", "mixin", "runtime", "effect",
  "inject", "plugin", "on", "once", "parallel", "emit", "serial", "bail", "waterfall",
  "scope", "fiber", "reflect", "logger",
]);

/**
 * 把注释替换成空白（保留换行与行号）。`keepStrings` 为真时保留字符串/模板字面量原样
 * （用于「服务端源码里带字符串字面量的语句顺序」这类断言；默认 false ⇒ 字符串也一并抹平）。
 */
function stripNonCode(src: string, keepStrings = false): string {
  const out: string[] = [];
  let mode: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (mode === "code") {
      if (ch === "/" && next === "/") { mode = "line"; out.push("  "); i += 2; continue; }
      if (ch === "/" && next === "*") { mode = "block"; out.push("  "); i += 2; continue; }
      if (keepStrings) { out.push(ch); i += 1; continue; }
      if (ch === "'") { mode = "single"; out.push(" "); i += 1; continue; }
      if (ch === '"') { mode = "double"; out.push(" "); i += 1; continue; }
      if (ch === "`") { mode = "template"; out.push(" "); i += 1; continue; }
      out.push(ch); i += 1; continue;
    }
    if (mode === "line") { if (ch === "\n") { mode = "code"; out.push("\n"); i += 1; continue; } out.push(" "); i += 1; continue; }
    if (mode === "block") {
      if (ch === "*" && next === "/") { mode = "code"; out.push("  "); i += 2; continue; }
      out.push(ch === "\n" ? "\n" : " "); i += 1; continue;
    }
    if (ch === "\\") { out.push("  "); i += 2; continue; }
    const closer = mode === "single" ? "'" : mode === "double" ? '"' : "`";
    if (ch === closer) { mode = "code"; out.push(" "); i += 1; continue; }
    out.push(ch === "\n" ? "\n" : " "); i += 1;
  }
  return out.join("");
}

/** 从 plugin.js 的硬 inject 声明里取「已声明服务」集合（唯一真源，守卫不维护第二份）。 */
function declaredServices(pluginSrc: string): string[] {
  const match = /^\s*inject:\s*\[([^\]]*)\]/m.exec(pluginSrc);
  if (!match) throw new Error("找不到 plugin.js 的 inject 声明（守卫 fail-closed：声明面格式变了）");
  return match[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

const BARE_FALLBACK_RE = /(?:\?\?|\|\|)\s*(?:ctx|appCtx|scope|sctx|injected)\s*\??\.\s*([A-Za-z_$][\w$]*)/g;

/** 返回裸回退命中：文件:行 → 属性名（fail-closed，无豁免开关）。 */
function bareServiceFallbacks(files: Array<{ file: string; code: string }>, declared: string[]): string[] {
  const safe = new Set([...CTX_SURFACE, ...declared]);
  const findings: string[] = [];
  for (const { file, code } of files) {
    const lines = stripNonCode(code).split("\n");
    lines.forEach((line, index) => {
      BARE_FALLBACK_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = BARE_FALLBACK_RE.exec(line)) !== null) {
        if (!safe.has(m[1])) findings.push(`${file}:${index + 1} → ${m[1]}`);
      }
    });
  }
  return findings;
}

function readClientSources(): Array<{ file: string; code: string }> {
  return readdirSync(clientSrcDir).filter((n) => n.endsWith(".js")).sort()
    .map((n) => ({ file: `lib/client/${n}`, code: readFileSync(join(clientSrcDir, n), "utf8") }));
}

test("g-425 判据13：客户端源码零「未声明服务裸回退」（含修复行 / helper 定义钉住）", () => {
  const sources = readClientSources();
  assert.ok(sources.length > 20, `必须真的扫到客户端模块（实际 ${sources.length} 个）`);
  const declared = declaredServices(readFileSync(pluginSrcPath, "utf8"));
  assert.deepEqual(declared, ["slots", "sessions"], "本目标不得改动服务依赖声明");

  const findings = bareServiceFallbacks(sources, declared);
  assert.deepEqual(findings, [], "不得再出现 `?? ctx.<未声明服务>` 裸属性回退（一律走 optionalService）");

  const helpers = readFileSync(join(clientSrcDir, "helpers.js"), "utf8");
  assert.match(helpers, /function optionalService\(ctx, name\) \{[\s\S]*?ctx\?\.get\?\.\(name\)[\s\S]*?\} catch \{ return null; \}/,
    "helpers.js 必须定义受保护读取 helper（ctx.get 优先 + 属性访问兜 try/catch）");
  const pluginSrc = readFileSync(pluginSrcPath, "utf8");
  assert.ok(pluginSrc.includes(FIXED_LOCALE_LINE), "plugin.js apply 必须用 optionalService 读 locale");
  assert.doesNotMatch(stripNonCode(pluginSrc), /\?\?\s*ctx\s*\.\s*locale/,
    "plugin.js 代码里不得再出现 `?? ctx.locale` 裸回退（注释里的历史说明不算）");
});

test("g-425 判据13 负向对照：守卫对裸回退样本必报红，对声明服务/方法面样本零命中", () => {
  const declared = ["slots", "sessions"];
  const sample = (code: string) => bareServiceFallbacks([{ file: "sample.js", code }], declared);

  // 负向：这正是被修掉的缺陷形态（含注释干扰项：注释里的裸回退不得被算作命中）
  assert.deepEqual(sample("const a = x ?? ctx.locale;\n"), ["sample.js:1 → locale"]);
  assert.deepEqual(sample("const a = ctx.get?.('remote') ?? ctx?.remote; // ?? ctx.locale 只是注释\n"), ["sample.js:1 → remote"]);
  assert.equal(sample("const a = x || appCtx.uiWorkspace;\n").length, 1);

  // 正向：已声明服务与 ctx 方法面（get/on/slots/inject…）不得误报
  assert.deepEqual(sample("const a = x ?? ctx.slots;\n"), []);
  assert.deepEqual(sample("const a = x ?? appCtx?.get;\n"), []);
  assert.deepEqual(sample("const a = x ?? sctx.sessions;\n"), []);
  assert.deepEqual(sample("const a = x ?? scope.on;\n"), []);
});

/**
 * g-453 判据 1/2：「能力判定不得用版本号字符串」的**语义**守卫（Lane B 复核 P2）。
 *
 * 为什么名字式断言不够（复核给的最小复现）：`const hostVersion = "0.2.0-rc.2"; if (hostVersion >= "0.2") {}`
 * 是**真实的版本比较**，却不含任何 `compareVersion*` 字样 —— 只按标识符名字（`/\bversion\b/`）判定时它照样全绿。
 * 故按**语义形态**判定（调用方先抹注释、**保留字符串字面量**——版本号本身就是字符串），命中即点名原因：
 *   ① 与**版本样式字面量**比较（`"0.2"` / `"0.2.0-rc.2"` / `"v1.2.3"`），比较符两侧任一侧；
 *   ② semver 命名空间调用（`semver.satisfies(...)` / `semver.coerce(...)` / `semver.gte(...)`）；
 *   ③ 版本比较/解析/范围判定调用（`compareVersions(...)` / `parseVersion(...)` / `satisfiesRange(...)` …）；
 *   ④ **版本样式标识符**参与比较（`hostVersion >= …` / `apiVersion === …` / `pkg.version < …`）。
 * ④ 只在**能力判定路径**（`settings.js` / `helpers.js` / `plugin.js`）上断言：看板里合法的**展示型**比较
 * （如 `batch-accept.js` 的 `versionLabel === …` —— 版本泳道标签，与宿主能力无关）不在本判据范围内。
 */
const VERSION_LITERAL_RE = String.raw`["']v?\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.\-]+)?["']`;
const COMPARISON_OP_RE = String.raw`(?:===|!==|==|!=|>=|<=|>|<)`;
const CAPABILITY_PATH_SOURCES = ["settings.js", "helpers.js", "plugin.js"];
const VERSION_COMPARISON_SIGNS: Array<{ reason: string; re: RegExp }> = [
  { reason: "版本样式字面量在比较符右侧", re: new RegExp(`${COMPARISON_OP_RE}\\s*${VERSION_LITERAL_RE}`) },
  { reason: "版本样式字面量在比较符左侧", re: new RegExp(`${VERSION_LITERAL_RE}\\s*${COMPARISON_OP_RE}`) },
  { reason: "semver 命名空间调用", re: /\bsemver\s*\.\s*[A-Za-z_$][\w$]*\s*\(/ },
  {
    reason: "版本比较/解析/范围判定调用",
    re: /\b(?:compareVersions?|compareSemver|versionCompare|versionSatisfies|satisfiesVersion|satisfiesRange|parseVersion|coerceVersion|isVersion(?:Gte|Lte|AtLeast|AtMost)|checkVersion|assertVersion|minVersion)\s*\(/,
  },
  {
    reason: "版本样式标识符参与比较",
    re: new RegExp(String.raw`\b(?:host|plugin|dsh|core|api|schema|engine|client|server)?[Vv]ersion\w*\s*${COMPARISON_OP_RE}`),
  },
];

/** 返回命中原因列表（空 = 未发现任何版本号比较的语义形态）。 */
function versionComparisonFindings(code: string): string[] {
  return VERSION_COMPARISON_SIGNS.filter(({ re }) => re.test(code)).map(({ reason }) => reason);
}

test("g-453：设置 scope 能力探测只用 inject/ctx.get（点分名零属性回退、零版本号比较），三席位全走 slots.inject", () => {
  const settings = readFileSync(join(clientSrcDir, "settings.js"), "utf8");
  // 保留字符串字面量（断言里的服务名/席位名本身是字符串），只抹注释
  const code = stripNonCode(settings, true);
  // ① 点分服务名 `remote.settings` 只走 optionalServicePath（纯 ctx.get）；经 optionalService 的属性
  //    回退在 0.2.0-rc.2 上会抛 `cannot get property "remote.settings" without inject`（实测真因）
  assert.match(code, /optionalServicePath\(ctx, "remote\.settings"\)/);
  assert.doesNotMatch(code, /optionalService\([^)]*"remote\.settings"/,
    "点分服务名不得经 optionalService（其属性回退会撞 cordis 注入门禁）");
  // ② helper 语义钉住：optionalServicePath 只有 ctx.get，**没有**属性回退
  const helpers = stripNonCode(readFileSync(join(clientSrcDir, "helpers.js"), "utf8"), true);
  const helperStart = helpers.indexOf("function optionalServicePath(ctx, name)");
  assert.ok(helperStart >= 0, "helpers.js 必须定义 optionalServicePath（点分服务名读取口径）");
  const helperBody = helpers.slice(helperStart, helpers.indexOf("\n    }", helperStart));
  assert.ok(helperBody.includes("ctx?.get?.(name)"), "optionalServicePath 必须经 ctx.get 读取");
  assert.ok(!helperBody.includes("ctx?.[name]"), "optionalServicePath 不得含属性回退");
  // ③ 迟到绑定：两个服务键各自 inject 探测（宿主没有该服务 ⇒ 回调不触发、零报错）
  assert.match(code, /const GRAPH_SETTINGS_SERVICE_KEYS = \["settingsScope", "remote\.settings"\]/);
  assert.match(code, /ctx\?\.inject\?\.\(\[key\]/);
  // ④ 同一组件的三个席位一律经 ctx.slots.inject（直接 register 在宿主未声明 slot 时静默 no-op）
  for (const seat of ["settings.section", "settings.plugins.tab", "plugins.bundle.config"]) {
    assert.match(code, new RegExp(`ctx\\.slots\\.inject\\("${seat.replace(/\./g, "\\.")}"`),
      `${seat} 必须经 ctx.slots.inject 注册`);
  }
  // ⑤ 能力判定禁止比对宿主版本号（dsh-market 的 `settingsScope`→`settings` 改名即静默失效教训）
  //    5a. 语义判定（新增，覆盖真实版本比较的各种写法）—— 能力判定路径三个模块逐一扫描
  for (const name of CAPABILITY_PATH_SOURCES) {
    const src = readFileSync(join(clientSrcDir, name), "utf8");
    assert.deepEqual(versionComparisonFindings(stripNonCode(src, true)), [],
      `${name} 出现版本号比较的语义形态（能力判定只允许「服务能否取到 / 能否 inject」）`);
  }
  //    5b. 名字式判定（**原有断言逐字保留，只增不减**）：设置模块连 version 字样都不该有
  assert.doesNotMatch(code, /\bversion\b/i, "设置能力判定不得出现版本号比较（只允许服务/inject 探测）");
});

test("g-453 判据1/2 判别力自检：版本比较的语义形态必命中、合法写法不误红（负向对照实测）", () => {
  const hit = (src: string) => versionComparisonFindings(stripNonCode(src, true));

  // 正向：**必须命中** —— 复核给的最小复现 + 各类真实版本比较写法
  const mustHit: Array<[string, string]> = [
    ["复核最小复现（标识符 + 字面量比较）", `const hostVersion = "0.2.0-rc.2"; if (hostVersion >= "0.2") { }`],
    ["属性路径版本比较", `if (sctx.settings.version >= "0.1.7") {}`],
    ["字面量在左侧", `if ("0.2" <= hostVersion) {}`],
    ["三等号比较版本字面量", `if (pkg.version === "0.19.8-alpha") {}`],
    ["v 前缀版本字面量", `const ok = "v1.2.3" !== apiVersion;`],
    ["semver.satisfies 范围判定", `if (semver.satisfies(hostVersion, ">=0.2")) {}`],
    ["semver.coerce 解析", `if (semver.coerce(v)) {}`],
    ["semver.gte 比较", `if (semver.gte(a, b)) {}`],
    ["compareVersions 调用", `if (compareVersions(a, b) >= 0) {}`],
    ["parseVersion 调用", `const ok = parseVersion(host) >= 0;`],
    ["版本样式标识符参与比较", `if (apiVersion < "0.2") {}`],
  ];
  for (const [label, src] of mustHit) {
    assert.ok(hit(src).length > 0, `正向样本必须命中：${label}（实际零命中 = 守卫失效）`);
  }

  // 合法：**必须不命中** —— 注释里的 version 字样、仅用于展示的 pluginVersion、与版本无关的比较
  const mustMiss: Array<[string, string]> = [
    ["注释里的 version 字样", `// host version 0.2.0 不需要比较\nconst a = 1;`],
    ["仅用于展示的 pluginVersion（不参与比较）", `const pluginVersion = PLUGIN_VERSION;\nrenderLabel(pluginVersion);`],
    ["普通字符串比较（服务名）", `if (name === "remote.settings") {}`],
    ["普通数值比较", `if (revision >= 3) {}`],
    ["字符串包含版本样式片段但不作比较", `if (note.includes("0.2.0")) {}`],
    ["版本号仅出现在文案里", `const hint = "宿主 0.2.0 起设置服务改名";`],
  ];
  for (const [label, src] of mustMiss) {
    assert.deepEqual(hit(src), [], `合法样本不得误红：${label}`);
  }
  // 原有的名字式口径对「展示型 pluginVersion / 注释」同样不误红（两个口径在合法样本上一致）
  for (const [, src] of mustMiss.slice(0, 2)) {
    assert.doesNotMatch(stripNonCode(src), /\bversion\b/i, "名字式口径对合法样本不得误红");
  }

  // 负向对照（在**真实源码的副本**上做变异）：插进 `hostVersion >= "0.2"` ⇒ 判定必须报红
  const real = readFileSync(join(clientSrcDir, "settings.js"), "utf8");
  assert.deepEqual(versionComparisonFindings(stripNonCode(real, true)), [], "未变异：真实源码零命中");
  const anchor = "const GRAPH_SETTINGS_NS_CANDIDATES";
  assert.ok(real.includes(anchor), "变异锚点必须存在（fail-closed：锚点消失即报错，不得静默跳过对照）");
  const mutated = real.replace(anchor,
    `const hostVersion = "0.2.0-rc.2";\n  if (hostVersion >= "0.2") { }\n  ${anchor}`);
  assert.notEqual(mutated, real, "变异必须真的落在源码文本上");
  assert.ok(versionComparisonFindings(stripNonCode(mutated, true)).length > 0,
    "把复核的最小复现插进真实源码副本后判定必须报红（否则守卫无判别力）");
});

test("g-425 判据13（服务端半边）：resolvePromptLanguage 的 locale 兜底必须 ctx.get 优先且门禁下可用", () => {
  // 门禁 ctx：`get` 是 ctx 自身方法（可读）；`locale` 是可经 get 取到的服务，
  // 但**属性访问**在未声明时抛错（cordis 门禁等价）——正是修复前的失效形态。
  const services: Record<string, any> = { locale: { getLocale: () => ({ active: "en" }) } };
  const gate = new Proxy({ get: (name: string) => services[name] }, {
    get(target: any, prop, receiver) {
      if (typeof prop === "symbol" || String(prop).startsWith("_") || prop === "then") return Reflect.get(target, prop, receiver);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      throw new Error(gateError(String(prop)));
    },
  });
  assert.equal(resolvePromptLanguage("follow", gate), "en",
    "locale 属性访问受门禁时，必须经 ctx.get('locale') 兜底返回 en（顺序写反则该分支永久失效，只返回 zh）");

  // 源码顺序钉住（防止再次写反）：只抹注释、保留字符串字面量，断言真实代码语句
  assert.match(stripNonCode(readFileSync(hostSrcPath, "utf8"), true),
    /const locale = ctx\?\.get\?\.\("locale"\) \?\? ctx\?\.locale;/,
    "服务端 locale 兜底必须是 `ctx?.get?.(\"locale\") ?? ctx?.locale`（ctx.get 优先）");

  // 反向样本：裸回退优先时同一门槛夹具只能降级到 zh —— 证明上面那断言真的在鉴别顺序
  const reverseGate = new Proxy({ get: () => undefined }, {
    get(target: any, prop, receiver) {
      if (typeof prop === "symbol" || String(prop).startsWith("_") || prop === "then") return Reflect.get(target, prop, receiver);
      if (Reflect.has(target, prop)) return Reflect.get(target, prop, receiver);
      throw new Error(gateError(String(prop)));
    },
  });
  assert.equal(resolvePromptLanguage("follow", reverseGate), "zh");
});
