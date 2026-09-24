/** g-330：看板右侧栏页签入口（方案 B）回归测试。
 *
 * 负责人裁定：保留 conversation.view 会话内入口不变，另加右侧栏页签（对齐 dsh-context）。
 * 覆盖判据：
 *  1. 右侧栏出现 dsh-graph 页签入口（guide 图标/标题/描述，thunk 文案），且只注册
 *     sidebarRightTabs + sidebar.right.pane.tab(.title)——无 main 面板、无 sidebar.panellist。
 *  2. 现有会话内入口零回归：conversation.view 注册块逐字未变、硬 inject 仍为 [slots, sessions]。
 *  3. 单一实现：右侧栏本体与 conversation.view 挂载的是同一个 KanbanView 组件实例。
 *  6. 降级安全：无 sidebarRightTabs / 无 ctx.inject / 注册抛异常时均不抛、不注册残留。
 *  7. 声明与构建：package.json client.inject 声明 sidebar-right；i18n 中英齐备；无版本号比较分支。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const hostRoot = join(import.meta.dirname, "../../dsh-graph-host");
const clientRoot = join(hostRoot, "lib/client");
const distRoot = join(import.meta.dirname, "../../dist");
const readClient = (name: string) => readFileSync(join(clientRoot, `${name}.js`), "utf8");

const SIDEBAR_ID = "dsh-graph";
const CONVERSATION_VIEW_BLOCK = `        ctx.slots.inject("conversation.view", () =>
          ctx.slots.register(
            {
              name: "conversation.view",
              id: "dsh-graph-kanban",
              order: 80,
              // g-230：locale-following thunk——resolveSlotLabel 对 function 求值，切语言时重算
              label: () => dgT("board.title"),
            },
            (props) => h(KanbanView, props),
          ),
        );`;

interface Loaded {
  mod: any;
  registered: { def: any; renderer: any }[];
  tabTypes: any[];
  tabDisposed: number;
  injectDeps: string[][];
}

/**
 * 在 vm 里真实装载 dist/lib/client.js 并 apply。
 * @param opts.provideSidebar 是否让 deferred inject 回调收到 sidebarRightTabs（特性探测开关）。
 * @param opts.withInjectCtx 是否给 ctx 挂 inject 方法（false → 模拟只有 slots 的旧 runner）。
 * @param opts.tabsRegisterThrows 注册表 register 抛异常（id/kind 被占的形态）。
 * @param opts.bodyRegisterThrows sidebar.right.pane.tab 的 slots.register 抛异常。
 * @param opts.slotsNotInjectable deferred scope 里的 slots 形状不符（无 register）。
 */
function loadAndApplyClient(opts: {
  provideSidebar?: boolean;
  withInjectCtx?: boolean;
  tabsRegisterThrows?: boolean;
  bodyRegisterThrows?: boolean;
  slotsNotInjectable?: boolean;
} = {}): Loaded {
  const {
    provideSidebar = true, withInjectCtx = true,
    tabsRegisterThrows = false, bodyRegisterThrows = false, slotsNotInjectable = false,
  } = opts;
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
      head: { appendChild: noop },
      body: { appendChild: noop, removeChild: noop },
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

  const ReactStub = {
    createElement: (...args: any[]) => ({ args }),
    useState: (init: any) => [typeof init === "function" ? init() : init, noop],
    useEffect: noop, useLayoutEffect: noop, useRef: (v: any) => ({ current: v }),
    useCallback: (f: any) => f, useMemo: (f: any) => f(), useReducer: (r: any, i: any) => [i, noop],
    useSyncExternalStore: (_s: any, get: any) => (typeof get === "function" ? get() : undefined),
    useTransition: () => [false, noop], Fragment: "Fragment", memo: (c: any) => c,
    Component: class { props: any; state: any; constructor(props: any) { this.props = props; this.state = {}; } setState(_s: any) {} },
  };
  const requireStub = (name: string) => {
    if (name === "react") return ReactStub;
    if (name === "react-dom") return { render: noop, createRoot: () => ({ render: noop, unmount: noop }) };
    throw new Error(`module not found: ${name}`);
  };

  const mod = factory(requireStub);
  assert.ok(mod && typeof mod.apply === "function", "工厂返回带 apply 的插件对象");

  const registered: { def: any; renderer: any }[] = [];
  const slots = {
    inject: (_name: string, cb: any) => { cb?.(); return noop; },
    register: (def: any, renderer: any) => {
      if (bodyRegisterThrows && def?.name === "sidebar.right.pane.tab") throw new Error("seat taken");
      registered.push({ def, renderer });
      return noop;
    },
  };
  const tabTypes: any[] = [];
  let tabDisposed = 0;
  const tabs = {
    register: (def: any) => {
      if (tabsRegisterThrows) throw new Error("sidebarRight: tab type id is already registered");
      tabTypes.push(def);
      return () => { tabDisposed += 1; };
    },
  };
  const injectDeps: string[][] = [];
  const ctx: any = {
    sessions: { list: { getSnapshot: () => ({ byId: {}, items: [], subagentsByParent: {} }) } },
    get: () => null,
    slots,
    on: noop,
    effect: (fn: any) => fn(),
    ...(withInjectCtx ? {
      inject: (deps: string[], cb: any) => {
        injectDeps.push([...deps]);
        if (deps.includes("sidebarRightTabs") && provideSidebar) {
          cb(slotsNotInjectable ? { sidebarRightTabs: tabs, slots: {} } : { sidebarRightTabs: tabs, slots });
        }
        return { dispose: noop };
      },
    } : {}),
  };
  mod.apply(ctx);
  return { mod, registered, tabTypes, tabDisposed, injectDeps };
}

const byName = (l: Loaded, name: string) => l.registered.filter((r) => r.def?.name === name);

// ---------------------------------------------------------------- 1. 注册形态（方案 B）

test("g-330 判据1：右侧栏注册类型（id/kind 带命名空间、thunk 文案、guide 图标+标题+描述）", () => {
  const { tabTypes } = loadAndApplyClient();
  assert.equal(tabTypes.length, 1, "恰好注册一个右侧栏 tab 类型");
  const def = tabTypes[0];
  assert.equal(def.id, SIDEBAR_ID, "id 用包名（全局唯一）");
  assert.equal(def.kind, SIDEBAR_ID, "kind 必须带命名空间，不得用朴素 graph/kanban/context");
  assert.notEqual(def.kind, "graph");
  assert.notEqual(def.kind, "kanban");
  assert.notEqual(def.kind, "context");
  assert.equal(typeof def.title, "function", "页签标题必须是 thunk（切语言重算）");
  assert.equal(typeof def.title({}), "string");
  assert.ok(Array.isArray(def.guide) && def.guide.length === 1, "guide 页恰好一条入口");
  const entry = def.guide[0];
  assert.equal(entry.id, SIDEBAR_ID);
  assert.equal(entry.order, 20, "排在宿主内置 Files 条目（order 10）之后");
  assert.equal(typeof entry.title, "function", "guide 标题必须是 thunk");
  assert.equal(typeof entry.description, "function", "guide 描述必须是 thunk");
  assert.equal(typeof entry.icon, "function", "guide 条目必须带图标组件");
  assert.ok(entry.title().length > 0 && entry.description().length > 0);
});

test("g-330 判据1：本体/标题 seat 的 key 与类型 id 一致，且不存在 main 面板或 sidebar.panellist 注册", () => {
  const l = loadAndApplyClient();
  const bodies = byName(l, "sidebar.right.pane.tab");
  const titles = byName(l, "sidebar.right.pane.tab.title");
  assert.equal(bodies.length, 1, "本体 seat 恰好注册一次");
  assert.equal(titles.length, 1, "标题 seat 恰好注册一次");
  assert.equal(bodies[0].def.key, SIDEBAR_ID, "本体 seat 的 key = 类型 id");
  assert.equal(titles[0].def.key, SIDEBAR_ID, "标题 seat 的 key = 类型 id");
  assert.equal(bodies[0].def.locale, "dsh-graph", "本体 seat 带 locale 命名空间");
  // 明确排除方案 A/C：不得出现全局页面或左/右侧栏 panellist 入口
  const names = l.registered.map((r) => r.def?.name);
  assert.deepEqual(names.filter((n) => n === "main" || n === "sidebar.panellist"), []);
  assert.deepEqual(names.filter((n) => n === "sidebar.right.pane.tab" || n === "sidebar.right.pane.tab.title").length, 2);
});

test("g-330 判据1：页签标题组件渲染图标 + 当前语言文案，并订阅语言切换事件", () => {
  const l = loadAndApplyClient();
  const renderer = byName(l, "sidebar.right.pane.tab.title")[0].renderer;
  // seat renderer 是宿主调用的包装：{ args: [GraphTabTitle, props] }，再手动渲染组件本体。
  const TitleComponent = renderer({ hooks: {} }).args[0];
  assert.equal(typeof TitleComponent, "function");
  const el = TitleComponent({});
  // h(React.Fragment, null, icon, label) → stub 记成 { args: [Fragment, null, icon, label] }
  const [, , icon, label] = el.args;
  assert.ok(icon, "标题组件渲染了图标元素");
  assert.equal(label.args[0], "span");
  assert.equal(label.args[2], "看板", "无 locale 服务时回退中文字典");
  // 语言切换重算依赖 useLocaleRevision（订阅 dsh-graph:locale-changed）
  const src = readClient("plugin");
  assert.match(src, /function GraphTabTitle\(\)[\s\S]{0,200}useLocaleRevision\(\)/);
});

// ---------------------------------------------------------------- 2/3. 零回归 + 单一实现

test("g-330 判据2：conversation.view 注册块逐字未变，硬 inject 仍为 [slots, sessions]", () => {
  const src = readClient("plugin");
  assert.ok(src.includes(CONVERSATION_VIEW_BLOCK), "conversation.view 注册块必须逐字保持");
  assert.match(src, /inject: \["slots", "sessions"\]/);
  // 可选能力绝不进硬 inject
  assert.doesNotMatch(src, /inject: \[[^\]]*"sidebarRightTabs"[^\]]*\]/);
  assert.doesNotMatch(src, /inject: \[[^\]]*"remote"[^\]]*\]/);
  const { mod } = loadAndApplyClient();
  assert.deepEqual(Array.from(mod.inject), ["slots", "sessions"]);
});

test("g-330 判据3：右侧栏本体与 conversation.view 挂载同一个 KanbanView（同一实现、同一数据源）", () => {
  const l = loadAndApplyClient();
  const conversation = byName(l, "conversation.view")[0].renderer({});
  const sidebar = byName(l, "sidebar.right.pane.tab")[0].renderer({});
  assert.equal(sidebar.args[0], conversation.args[0], "两侧必须是同一个组件实例");
  assert.equal(sidebar.args[1].host, "sidebar", "右侧栏本体额外传 host: sidebar（仅作挂载点标识；att-005 起不再门控渲染）");
  assert.equal(conversation.args[1].host, undefined, "conversation.view 不传 host（两侧渲染结果一致）");
  // 单一实现：客户端源模块里只有一个 KanbanView 定义
  const defs = ["drag-prompts", "kanban", "plugin"].flatMap((m) => [...readClient(m).matchAll(/function KanbanView\(/g)].length);
  assert.equal(defs.reduce((a, b) => a + b, 0), 1, "不得存在第二套看板渲染实现");
});

// ---------------------------------------------------------------- 5. 窄宽度适配（g-352 取代 g-330 最小适配）

// g-352 取代说明：g-330 的判据 5 是「头部放开换行」那条纯 CSS
// 最小适配；g-352 改为「以看板根容器实测宽度分档 + 工具条折叠进下拉容器 + 单泳道档」；
// g-356 把单泳道阈值由 <360px 抬到 <480px（与折叠档同界）。
// g-352 att-005（负责人 2026-09-25 人工 gate「两侧完全一致」）再次改写：**拆掉 host 门控**——
// 会话页看板页签与右侧栏渲染同一份头部/工具条实现（同一个 KanbanView），两侧行为完全一致；
// 判据 5 的新口径是 ①「会话内看板页签 == 侧栏（同一组件/同一逻辑）」+ ②「对话本体零新增差异」。
// 本段只保留**共用实现**的源契约，两侧一致性的渲染级逐字断言见 g352-narrow-width.test.ts。
test("g-352 att-005 取代 g-330 判据5：断点/折叠是同一份共用实现（零 host 门控），两侧共用 .dg-head 兜底", () => {
  const src = readClient("kanban");
  const css = readClient("constants");
  const narrow = readClient("narrow-width");
  // ① 零 host 门控：客户端源模块里不得再有 sidebarHost / props.host 的渲染分叉
  for (const mod of ["kanban", "constants", "narrow-width", "plugin"]) {
    assert.doesNotMatch(readClient(mod), /sidebarHost/, `${mod} 不得再有 sidebarHost 门控`);
  }
  assert.doesNotMatch(src, /props\?\.host/, "kanban 渲染路径不得再读 host 分叉");
  // 断点真源 = 看板根容器实测宽度（ResizeObserver 观测 boardRootRef），不是 window 宽度
  assert.match(src, /new ResizeObserver\(measure\)/);
  assert.match(src, /ro\.observe\(el\)/);
  assert.match(src, /const w = typeof el\.clientWidth === "number" && el\.clientWidth > 0/);
  assert.doesNotMatch(src, /window\.innerWidth|matchMedia/);
  // 阈值与分档集中在 narrow-width.js 纯函数模块（测试断言同一实现，不是复制一份常量）
  assert.match(narrow, /const NARROW_TOOLBAR_MAX_WIDTH = 480;/);
  assert.match(narrow, /const NARROW_SINGLE_VERSION_MAX_WIDTH = 480;/);
  assert.match(src, /const widthTier = boardWidthTier\(boardWidth\);/);
  // 窄档判定两侧同口径（不再 `sidebarHost && …`）
  assert.match(src, /const narrowActive = widthTier !== "wide";/);
  assert.match(src, /const narrowSingleTier = isSingleVersionTier\(boardWidth\);/);
  // 头部：style 仍是 S.head **本体**（无额外样式键、无对象拷贝）+ 两个宿主共用的 .dg-head class
  assert.match(src, /h\("div", \{ style: S\.head, className: "dg-head", ref: headRef \}/);
  // 共用布局兜底（换行 + 子项/按钮不压缩不折行），且不得把样式键写成 props 顶层
  //（那会渲染成 lowercase DOM 属性 flexwrap="wrap"，样式根本不生效）
  assert.match(css, /\.dg-head \{ flex-wrap: wrap; \}/);
  assert.match(css, /\.dg-head > \* \{ flex-shrink: 0; \}/);
  assert.match(css, /\.dg-head > \*, \.dg-head button \{ white-space: nowrap; \}/);
  assert.doesNotMatch(src, /style: S\.head, \.\.\./, "禁止把样式键漏成 props 顶层（会渲染成 lowercase DOM 属性）");
  // 取代关系：g-330 的纯 CSS 放开换行已删除；且绝不给头部全部按钮加 min-width:0
  //（那会把按钮压到十几像素、文字反而逐字竖排 —— 负责人 1585px 截图上的缺陷形态）
  assert.doesNotMatch(css, /dg-head-sidebar/, "旧 class 已彻底消失（不留死选择器）");
  assert.doesNotMatch(readClient("kanban"), /dg-head-sidebar/, "kanban 源码不得再出现旧 class");
  assert.doesNotMatch(css, /\.dg-head \.dg-btn \{ min-width: 0; \}/);
  // 根因兜底（判据 2）：折叠触发按钮自身也要 min-width:0 + text-overflow:ellipsis，否则仍会越框
  assert.match(css, /\.dg-narrow-head-btn \{ min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; \}/);
  assert.match(src, /minWidth: 0, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"/);
  // 根容器仍是同一个 S.wrap（其中已含 overflowX: auto → 极端窄宽度可横向滚动）
  assert.match(src, /style: S\.wrap/);
  // 网格模板仍只有同一份派生（顶部表头 + released 泳道共用 gridCols），未按 host 分叉出第二套列宽
  assert.equal([...src.matchAll(/gridTemplateColumns: /g)].length, 3, "网格模板数量不变（无 host 分叉）");
  // 「装不下就折叠六项工具条」的实测判定也是共用实现（纯函数唯一真源）
  assert.match(narrow, /function headNaturalWidth\(childWidths, gap\)/);
  assert.match(narrow, /function fitCollapseState\(input\)/);
  assert.match(src, /const toolbarCollapsed = shouldCollapseToolbar\(boardWidth\) \|\| toolbarCollapsedByFit;/);
});

// ---------------------------------------------------------------- 6. 降级安全

test("g-330 判据6：宿主无 sidebarRightTabs（回调不触发）时不注册、不抛、无残留", () => {
  const l = loadAndApplyClient({ provideSidebar: false });
  assert.equal(l.tabTypes.length, 0, "无能力时不注册 tab 类型");
  assert.deepEqual(l.registered.map((r) => r.def?.name).filter((n) => String(n).startsWith("sidebar.right")), []);
  // 会话内入口照旧
  assert.equal(byName(l, "conversation.view").length, 1);
  assert.ok(l.injectDeps.some((d) => d.includes("sidebarRightTabs")), "确实尝试过 deferred inject");
});

test("g-330 判据6：旧 runner 无 ctx.inject 时 apply 不抛（可选项不得拖垮 apply）", () => {
  const l = loadAndApplyClient({ withInjectCtx: false });
  assert.equal(l.tabTypes.length, 0);
  assert.equal(byName(l, "conversation.view").length, 1);
});

test("g-330 判据6：deferred scope 的 slots 形状不符时静默降级（不注册类型，也不注册半套 seat）", () => {
  const l = loadAndApplyClient({ slotsNotInjectable: true });
  // 类型注册发生在 seat 之前：形状检查必须在 tabs.register 之前，才能做到零残留。
  assert.equal(l.tabTypes.length, 0, "形状不符时连类型都不注册");
  assert.deepEqual(l.registered.map((r) => r.def?.name).filter((n) => String(n).startsWith("sidebar.right")), []);
});

test("g-330 判据6：注册表抛异常（id/kind 被占）时不冒泡，且不留下半套注册", () => {
  const l = loadAndApplyClient({ tabsRegisterThrows: true });
  assert.equal(l.tabTypes.length, 0);
  assert.deepEqual(l.registered.map((r) => r.def?.name).filter((n) => String(n).startsWith("sidebar.right")), []);
  assert.equal(byName(l, "conversation.view").length, 1, "会话内看板不受影响");
});

test("g-330 判据6：本体 seat 注册失败时撤销已成功的类型注册（不留半套）", () => {
  const l = loadAndApplyClient({ bodyRegisterThrows: true });
  assert.equal(l.tabTypes.length, 1, "类型先注册成功");
  assert.equal(l.tabDisposed, 1, "随后失败必须撤销已成功的部分注册");
  assert.deepEqual(l.registered.map((r) => r.def?.name).filter((n) => String(n).startsWith("sidebar.right")), []);
});

// ---------------------------------------------------------------- 7. 声明 / i18n / 无版本分支

test("g-330 判据7：package.json 的 dsh.client.inject 声明 sidebar-right，硬 inject 未被改写", () => {
  const pkg = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
  const inject: string[] = pkg.dsh.client.inject;
  assert.ok(inject.includes("@deepseek-ai/dsh-client-ui-sidebar-right"), "必须声明右侧栏客户端包");
  assert.ok(inject.includes("@deepseek-ai/dsh-client-ui-primitives"), "既有声明不得丢失");
  assert.equal(pkg.dsh.client.platform, "web");
});

test("g-330 判据7：i18n 页签/guide 文案中英齐备且英文无 CJK", () => {
  const src = readClient("i18n");
  for (const key of ["sidebar.tab.title", "sidebar.guide.description"]) {
    assert.equal([...src.matchAll(new RegExp(`'${key.replace(/\./g, "\\.")}':`, "g"))].length, 2, `${key} 必须在 zh/en 各出现一次`);
  }
  assert.match(src, /'sidebar\.tab\.title': '看板'/);
  assert.match(src, /'sidebar\.tab\.title': 'Kanban'/);
  // 英文条目必须是无 CJK 的英文串（中文条目在 zh 段，分开断言，避免自伤）
  assert.match(src, /'sidebar\.guide\.description': 'View and manage the goal board in this session'/);
  const enBlock = src.slice(src.indexOf("const en = {"));
  for (const key of ["sidebar.tab.title", "sidebar.guide.description"]) {
    const m = enBlock.match(new RegExp(`'${key.replace(/\./g, "\\.")}': '([^']*)'`));
    assert.ok(m, `en 缺少 ${key}`);
    assert.doesNotMatch(m[1], /[\u3400-\u9fff]/, `en ${key} 不得含 CJK`);
  }
});

test("g-330 判据7：右侧栏注册块只做特性探测，不引入版本号比较分支", () => {
  const src = readClient("plugin");
  const start = src.indexOf("g-330：右侧栏页签（方案 B）");
  const end = src.indexOf('console.log("[dsh-graph-host] client apply');
  assert.ok(start > 0 && end > start, "定位右侧栏注册块");
  const block = src.slice(start, end);
  assert.match(block, /ctx\.inject\?\.\(\["sidebarRightTabs"\]/);
  assert.doesNotMatch(block, /0\.1\.\d|semver|compareVersion|versionCompare|PLUGIN_VERSION/, "不得按版本号分支");
});
