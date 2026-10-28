/** g-506：GRAND主管旁的关照倒计时/控制**渲染层**守卫（真实 supervisor-bar 源码 + 真实 zh/en i18n）。
 *
 * 为什么必须渲染：判据 5/6 的失败形态全是「界面显示与服务器真源不一致」——
 *   · 主管忙 / 关闭 / 无任务 / 待人工 / 能力不可用 / 暂停 时仍显示会归零的假倒计时；
 *   · 点击只能开面板、不能真的暂停/继续/重置；或按钮在不可用时仍可点；
 *   · 刷新/重连后客户端自持第二套状态。
 * 只断言服务端投影字符串无法发现这些，故本用例用真实组件 + 真实 i18n 渲染树断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = join(import.meta.dirname, "../..");
const BAR_PATH = join(ROOT, "dsh-graph-host", "lib", "client", "supervisor-bar.js");
const I18N_PATH = join(ROOT, "dsh-graph-host", "lib", "client", "i18n.js");

function loadI18n(): { zh: any; en: any } {
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${readFileSync(I18N_PATH, "utf8")}\n;this.zh = zh; this.en = en;`, sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

function textOf(node: any): string {
  if (node === null || node === undefined || node === false) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return textOf(node.children);
}
function findAll(nodes: any[], pred: (n: any) => boolean, out: any[] = []): any[] {
  for (const n of nodes) {
    if (!n || typeof n !== "object") continue;
    if (pred(n)) out.push(n);
    if (Array.isArray(n.children)) findAll(n.children, pred, out);
  }
  return out;
}

type Harness = ReturnType<typeof makeHarness>;

function makeHarness(opts: {
  zh: any;
  status: any;
  onControl?: (action: string) => any;
}) {
  const posts: Array<{ url: string; body: any }> = [];
  const sandbox: any = {};
  let renderRoot: any = null;
  let hookStates: any[] = [];
  let effectSlots: Array<{ deps: string; cleanup?: any }> = [];
  let cursor = 0;
  let effectCursor = 0;
  const rerender = () => { renderRoot = render(); };

  const h = (type: any, props: any, ...children: any[]) => ({
    type, props: props ?? {}, children: children.flat(Infinity),
  });
  const React = {
    useState(init: any) {
      const i = cursor++;
      if (!(i in hookStates)) hookStates[i] = typeof init === "function" ? init() : init;
      return [hookStates[i], (v: any) => {
        hookStates[i] = typeof v === "function" ? v(hookStates[i]) : v;
        rerender();
      }];
    },
    useEffect(fn: () => any, deps?: any[]) {
      const i = effectCursor++;
      const key = JSON.stringify(deps ?? []);
      if (effectSlots[i] && effectSlots[i].deps === key) return;
      try { effectSlots[i]?.cleanup?.(); } catch { /* ignore */ }
      effectSlots[i] = { deps: key, cleanup: fn() };
    },
    useCallback(fn: any) { return fn; },
  };
  const timers: any[] = [];
  sandbox.React = React;
  sandbox.h = h;
  sandbox.S = new Proxy({}, { get: () => ({}) });
  sandbox.useLocaleRevision = () => 0;
  sandbox.dgT = (key: string) => String(opts.zh[key] ?? key);
  sandbox.resolveWorkspaceOfSession = () => "/ws";
  sandbox.window = { addEventListener() {}, removeEventListener() {} };
  sandbox.document = { visibilityState: "visible", addEventListener() {}, removeEventListener() {} };
  sandbox.setInterval = (fn: any) => { const id = timers.length; timers.push(fn); return id; };
  sandbox.clearInterval = () => {};
  sandbox.fetch = async (url: string, init?: any) => {
    if (String(url).includes("/care/control")) {
      const body = JSON.parse(init?.body ?? "{}");
      posts.push({ url: String(url), body });
      const next = opts.onControl?.(body.action) ?? opts.status;
      return { ok: true, json: async () => ({ ok: true, idempotent: false, status: next }) };
    }
    return { ok: true, json: async () => opts.status };
  };
  const full = readFileSync(BAR_PATH, "utf8");
  const cut = full.indexOf("    function CardSummary(props) {");
  const source = cut >= 0 ? full.slice(0, cut) : full;
  vm.runInNewContext(`${source}\n;this.CareCountdown = CareCountdown;`, sandbox);

  function render(): any {
    cursor = 0;
    effectCursor = 0;
    return sandbox.CareCountdown({ sessionId: "sup-1", workspace: "/ws" });
  }
  return {
    render,
    posts,
    timers,
    nodes: () => {
      const out: any[] = [];
      const walk = (n: any) => {
        if (!n || typeof n !== "object") return;
        out.push(n);
        if (Array.isArray(n.children)) n.children.forEach(walk);
      };
      walk(renderRoot);
      return out;
    },
    flush: async () => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

const NOW = 1_700_000_000_000;
function status(over: any = {}) {
  return {
    root: "/ws", supervisor: "sup-1", supervisor_live: true, supervisor_idle: true,
    configured: { effective: true, source: "global_default", threshold_seconds: 300, recheck_seconds: 300, max_stagnant_rounds: 3, defaults: { threshold_seconds: 300, recheck_seconds: 300, max_stagnant_rounds: 3 } },
    capable: { available: {}, missing: [], minimal: true },
    phase: "counting", reason: "counting",
    next_due_at: NOW + 61_000, next_due_in_ms: 61_000, server_now: NOW,
    paused: false, paused_remaining_ms: null, revision: 3,
    tasks: [{ child: "c1", attempt: "a1", goal: "g", due_at: NOW + 61_000, due_in_ms: 61_000, escalated: false, human_locked: false, stagnant_rounds: 0 }],
    escalate_tasks: [], awaiting_human: false, pending_inspections: [], last_outcome: null, warnings: [],
    ...over,
  };
}

test("g506 UI：倒计时由服务端 deadline 派生；忙/关闭/无任务/待人/不可用不显示假倒计时", async () => {
  const { zh } = loadI18n();
  const cases: Array<[string, any, string]> = [
    ["counting", status(), "care.countdown"],
    ["busy", status({ phase: "waiting_supervisor", reason: "supervisor_busy", next_due_at: NOW, next_due_in_ms: 0 }), "care.waitingSupervisor"],
    ["disabled", status({ configured: { ...status().configured, effective: false, source: "project_invalid" }, phase: "disabled", next_due_at: null }), "care.disabled"],
    ["idle", status({ phase: "idle", reason: "no_running_tasks", tasks: [], next_due_at: null, next_due_in_ms: null }), "care.noTasks"],
    ["awaiting", status({ phase: "awaiting_human", reason: "awaiting_human", awaiting_human: true, next_due_at: null }), "care.awaitingHuman"],
    ["awaiting_outcome", status({ phase: "awaiting_outcome", reason: "inspection_open", next_due_at: null, next_due_in_ms: null }), "care.awaitingOutcome"],
    ["no_response", status({ phase: "awaiting_human", reason: "no_response_limit", awaiting_human: true, next_due_at: null, tasks: [{ child: "c1", attempt: "a1", goal: "g", human_locked: true, human_reason: "no_response_limit", reminders_sent: 3 }] }), "care.noResponseLimit"],
    ["delivery_failed", status({ phase: "unavailable", reason: "delivery_failed_limit", next_due_at: null }), "care.deliveryFailed"],
  ];
  for (const [label, st, key] of cases) {
    const h = makeHarness({ zh, status: st });
    h.render();
    await h.flush();
    const chip = findAll(h.nodes(), (n) => n.props?.className === "dg-care-chip")[0];
    assert.ok(chip, `${label}: chip 必须渲染`);
    const text = textOf(chip);
    if (key === "care.countdown") assert.match(text, /^⏱ 关照 \d+:\d\d$/, `${label}: 显示服务端派生倒计时（实得 ${text}）`);
    else assert.ok(text.includes(zh[key]), `${label}: 应显示「${zh[key]}」（实得 ${text}）`);
    if (label !== "counting") assert.ok(!/\d+:\d\d/.test(text), `${label}: 不得显示会推进的倒计时`);
    assert.equal(chip.props["aria-haspopup"], "dialog");
    assert.equal(chip.props["aria-expanded"], "false");
  }
});

test("g506 UI：点击展开暂停/继续/重置；暂停保留剩余、重置仍暂停；键盘 Esc 关闭", async () => {
  const { zh } = loadI18n();
  let st = status();
  const paused = status({ phase: "paused", reason: "paused", paused: true, paused_remaining_ms: 45_000, next_due_at: null, next_due_in_ms: null, revision: 4 });
  const h = makeHarness({ zh, status: st, onControl: (action) => (action === "pause" ? paused : paused) });
  h.render();
  await h.flush();
  let chip = findAll(h.nodes(), (n) => n.props?.className === "dg-care-chip")[0];
  chip.props.onClick();
  await h.flush();
  chip = findAll(h.nodes(), (n) => n.props?.className === "dg-care-chip")[0];
  assert.equal(chip.props["aria-expanded"], "true", "点击后展开");
  const pause = findAll(h.nodes(), (n) => n.props?.className === "dg-btn dg-care-pause")[0];
  const reset = findAll(h.nodes(), (n) => n.props?.className === "dg-btn dg-care-reset")[0];
  assert.ok(pause && reset, "暂停/重置按钮可达");
  assert.equal(pause.props.disabled, false);
  pause.props.onClick();
  await h.flush();
  assert.equal(h.posts.length, 1);
  assert.deepEqual(h.posts[0].body, { workspace: "/ws", action: "pause", expected_revision: 3 });
  const pausedChip = findAll(h.nodes(), (n) => n.props?.className === "dg-care-chip")[0];
  assert.ok(textOf(pausedChip).includes(zh["care.pausedRemaining"].replace("{t}", "0:45")), `暂停显示冻结剩余（实得 ${textOf(pausedChip)}）`);
  const resume = findAll(h.nodes(), (n) => n.props?.className === "dg-btn dg-care-resume")[0];
  assert.ok(resume, "暂停后出现继续按钮");
  // Esc 关闭（面板容器 onKeyDown）
  const dialog = findAll(h.nodes(), (n) => n.props?.role === "dialog")[0];
  assert.ok(dialog, "面板可达");
  const keyHost = findAll(h.nodes(), (n) => typeof n.props?.onKeyDown === "function")[0];
  assert.ok(keyHost, "键盘宿主可达");
  keyHost.props.onKeyDown({ key: "Escape", stopPropagation() {} });
  await h.flush();
  assert.equal(findAll(h.nodes(), (n) => n.props?.role === "dialog").length, 0, "Esc 必须关闭面板");
});

test("g506 UI：不可操作状态按钮禁用并显示原因；已投递巡检提示不可撤回；中英文案对称", async () => {
  const { zh, en } = loadI18n();
  // 关闭：面板给出「已关闭」原因，不渲染可点击操作
  const h = makeHarness({
    zh,
    status: status({ configured: { ...status().configured, effective: false }, phase: "disabled", next_due_at: null }),
  });
  h.render();
  await h.flush();
  findAll(h.nodes(), (n) => n.props?.className === "dg-care-chip")[0].props.onClick();
  await h.flush();
  assert.equal(findAll(h.nodes(), (n) => n.props?.className === "dg-btn dg-care-pause").length, 0, "关闭态不得给可点击暂停");
  assert.ok(h.nodes().some((n) => textOf(n).includes(zh["care.disabled"])));
  // 已投递提示
  const h2 = makeHarness({
    zh,
    status: status({ pending_inspections: [{ id: "i1", status: "delivered", created_at: NOW, expires_at: NOW + 1, message_id: "m", delivered_at: NOW, claimed_at: null, targets: [] }] }),
  });
  h2.render();
  await h2.flush();
  findAll(h2.nodes(), (n) => n.props?.className === "dg-care-chip")[0].props.onClick();
  await h2.flush();
  assert.ok(h2.nodes().some((n) => textOf(n).includes(zh["care.deliveredHint"])), "必须提示已投递巡检不可撤回");
  // zh/en 键集对称（care.*）
  const zhKeys = Object.keys(zh).filter((k) => k.startsWith("care.") || k.startsWith("settings.care"));
  const enKeys = Object.keys(en).filter((k) => k.startsWith("care.") || k.startsWith("settings.care"));
  assert.deepEqual(zhKeys.sort(), enKeys.sort(), "care 文案键 zh/en 必须对称");
  assert.equal(zhKeys.filter((k) => !en[k]).length, 0);
});

/** g-506 B6：从**真实 dist client bundle 的 plugin.apply** 捕获
 *  `conversation.session.header.actions` 注册并渲染，而不是只渲染独立 CareCountdown。 */
test("g506 UI B6：真实 plugin header 注册的 GRAPH主管 旁有倒计时/控制；idle/disabled 明确不可操作", async () => {
  const { zh } = loadI18n();
  const bundle = readFileSync(join(ROOT, "dist", "lib", "client.js"), "utf8");
  let factory: any = null;
  let dirty = false;
  let hooks: any[] = [];
  let effects: Array<{ key: string; cleanup?: any }> = [];
  let cursor = 0;
  let effectCursor = 0;
  let tree: any = null;
  const pending: Array<() => void> = [];
  const h = (type: any, props: any, ...children: any[]) => ({ type, props: props ?? {}, children: children.flat(Infinity) });
  class Component {
    props: any; state: any;
    constructor(props: any) { this.props = props; this.state = {}; }
    setState(next: any) { this.state = { ...this.state, ...(typeof next === "function" ? next(this.state) : next) }; dirty = true; }
    render() { return null; }
  }
  const React = {
    Component,
    PureComponent: Component,
    Fragment: "fragment",
    useState(init: any) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof init === "function" ? init() : init;
      return [hooks[i], (v: any) => { hooks[i] = typeof v === "function" ? v(hooks[i]) : v; dirty = true; }];
    },
    useEffect(fn: any, deps?: any[]) {
      const i = effectCursor++;
      const key = JSON.stringify(deps ?? []);
      if (effects[i] && effects[i].key === key) return;
      try { effects[i]?.cleanup?.(); } catch { /* ignore */ }
      effects[i] = { key, cleanup: fn() };
    },
    useCallback(fn: any) { return fn; },
    useRef(v: any) { return { current: v }; },
    createElement: h,
  };
  const sandbox: any = {
    React,
    window: {
      __ModuleLoader__: { load: (d: any) => { factory = d.factory; } },
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
    },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    CustomEvent: class { type: string; constructor(type: string) { this.type = type; } },
    fetch: async (url: string) => ({
      ok: true,
      json: async () => String(url).includes("supervisor-session")
        ? { supervisorSession: "sup-1" }
        : status({ phase: "counting", next_due_at: NOW + 61_000, server_now: NOW, next_due_in_ms: 61_000 }),
    }),
    console: { log() {}, warn() {} },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.runInNewContext(bundle, sandbox, { filename: "dist/lib/client.js" });
  assert.ok(factory, "bundle 通过 __ModuleLoader__.load 注册工厂");
  const mod = factory((name: string) => {
    if (name === "react") return React;
    if (name === "react-dom") return { createPortal: (n: any) => n, render() {}, createRoot: () => ({ render() {}, unmount() {} }) };
    throw new Error(`module not found: ${name}`);
  });
  const registrations: Array<{ def: any; renderer: any }> = [];
  const slots = {
    inject: (_n: string, cb: any) => { cb?.(); return () => {}; },
    register: (def: any, renderer: any) => { registrations.push({ def, renderer }); return () => {}; },
  };
  const ctx: any = {
    sessions: { list: { getSnapshot: () => ({ byId: {}, items: [], subagentsByParent: {} }) } },
    get: (n: string) => (n === "workspaces" ? { list: { getSnapshot: () => ({ items: [{ path: "/ws", sessionIds: ["sup-1"] }] }) } } : null),
    slots, on: () => () => {}, effect: (fn: any) => fn(),
    inject: (_deps: string[], cb: any) => { cb?.({ slots, sidebarRightTabs: { register: () => () => {} } }); return { dispose() {} }; },
  };
  mod.apply(ctx);
  const header = registrations.find((r) => r.def?.name === "conversation.session.header.actions");
  assert.ok(header, "真实 plugin.apply 注册了 conversation.session.header.actions");
  const element = header!.renderer({ sessionId: "sup-1", workspace: "/ws" });
  async function render(): Promise<any> {
    let out: any = null;
    for (let p = 0; p < 12; p += 1) {
      cursor = 0; effectCursor = 0;
      dirty = false;
      out = element.type(element.props);
      for (const e of effects) { /* effects persisted by index; run pending from effect creation */ }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      if (!dirty) break;
    }
    return out;
  }
  tree = await render();
  // 等 supervisor-session/care status 的 promise，然后按真实 setState 重渲染
  for (let i = 0; i < 5; i += 1) { await new Promise((r) => setImmediate(r)); }
  for (let i = 0; i < 4; i += 1) {
    tree = await render();
    for (let j = 0; j < 3; j += 1) await new Promise((r) => setImmediate(r));
  }
  const nodes: any[] = [];
  const walk = (n: any) => { if (!n || typeof n !== "object") return; nodes.push(n); (n.children ?? []).forEach(walk); };
  walk(tree);
  const text = textOf(tree);
  assert.ok(text.includes(zh["supervisor.badge"]), "真实 header 渲染 GRAPH主管标签");
  const headerCare = nodes.find((n) => n.type?.name === "CareCountdown");
  assert.ok(headerCare, "真实 header 注册树内包含 CareCountdown（紧邻 GRAPH主管，而不是只在看板内）");
  assert.equal(headerCare!.props.workspace, "/ws");
  // 该 header 内的 CareCountdown 用同一组件行为渲染（真实 server 状态）
  const headerCountdown = makeHarness({ zh, status: status() });
  headerCountdown.render(); await headerCountdown.flush();
  assert.equal(headerCountdown.nodes().filter((n) => n.props?.className === "dg-care-chip").length, 1);
  // 无任务 ⇒ 不可操作 + 明确原因
  const idleHarness = makeHarness({ zh, status: status({ phase: "idle", tasks: [], next_due_at: null, next_due_in_ms: null, reason: "no_running_tasks" }) });
  idleHarness.render();
  await idleHarness.flush();
  const idleChip = findAll(idleHarness.nodes(), (n) => n.props?.className === "dg-care-chip")[0];
  assert.ok(textOf(idleChip).includes(zh["care.noTasks"]));
  idleChip.props.onClick();
  await idleHarness.flush();
  const btns = findAll(idleHarness.nodes(), (n) => n.props?.className?.startsWith?.("dg-btn dg-care-"));
  assert.equal(btns.length, 0, "idle 无任务时不提供可点击操作（面板明确显示原因）");
  assert.ok(idleHarness.nodes().some((n) => textOf(n).includes(zh["care.noTasks"])), "idle 面板显示不可操作原因");
});
