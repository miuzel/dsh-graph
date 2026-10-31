/**
 * g-612 返工（原 reviewer E 的修正版）：goal 预算编辑器必须消费 **goal 唯一真源**
 * `meta.task_budget_seconds`（goalDetail 直接下发 `doc.meta`），不得新增可编辑镜像。
 *
 * 真实 0.2.1-rc.2 宿主 + 真实 owner HTTP（`/api/dsh-graph/goal` 与 `/set-goal-budget`）+
 * **真实客户端 `GoalBudgetEditor` 源码**（真实 React hooks 状态/effect/回调，vm 渲染）：
 *  ① 保存 120 ⇒ 服务端 goal detail `task_budget_seconds=120`（且无 `meta.budget_seconds` 镜像）；
 *  ② 组件保存回调触发真实 `load()` 重取 ⇒ 输入框显示 120；关闭重开（新渲染）仍 120；
 *  ③ 清空 ⇒ 真实 POST `budget_seconds:null` ⇒ goal 继承（meta 无值），运行中任务 effective=项目默认 300；
 *  ④ 非法值（29/86401）零请求零写入；匿名/伪造/跨站拒绝且零状态变更；
 *  ⑤ 负向对照：把组件读取字段变异回 `meta.budget_seconds` ⇒ 同一渲染断言必红（证明非空转）。
 *
 * 边界：不打开真实 3080/3120/3130 浏览器、不新起 replacement server；真实 GUI 视觉未验，
 * 本用例断言的是**真实客户端组件逻辑 + 真实 HTTP 服务端真源**。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

import { goalDetail } from "../ops.ts";
import { makeGoal, makeRealHost } from "./_g610-real-host.ts";

const ROOT = join(import.meta.dirname, "../..");
const MODAL_PATH = join(ROOT, "dsh-graph-host", "lib", "client", "goal-modal.js");
const I18N_PATH = join(ROOT, "dsh-graph-host", "lib", "client", "i18n.js");
const ROUTE = "/api/dsh-graph/set-goal-budget";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 从真实源码里按花括号提取一个函数（跳过字符串/注释，避免把字面量花括号算进去）。 */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `源码必须含 function ${name}`);
  const i = source.indexOf("{", start);
  assert.ok(i > start, `${name} 必须有函数体`);
  let depth = 0;
  let mode: "code" | "line" | "block" | "'" | '"' | "`" = "code";
  for (let j = i; j < source.length; j += 1) {
    const c = source[j];
    const next = source[j + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") { mode = "line"; j += 1; continue; }
      if (c === "/" && next === "*") { mode = "block"; j += 1; continue; }
      if (c === "'" || c === '"' || c === "`") { mode = c as any; continue; }
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(start, j + 1);
      }
      continue;
    }
    if (mode === "line") { if (c === "\n") mode = "code"; continue; }
    if (mode === "block") { if (c === "*" && next === "/") { mode = "code"; j += 1; } continue; }
    if (c === "\\") { j += 1; continue; }
    if (c === mode) mode = "code";
  }
  throw new Error(`无法提取 ${name} 函数体`);
}

function loadTranslator(): (key: string, params?: any) => string {
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${readFileSync(I18N_PATH, "utf8")}\n;this.zh = zh; this.en = en; this.createTranslator = createTranslator;`, sandbox);
  return sandbox.createTranslator(null);
}

type Mounted = {
  render: () => any;
  flush: (iter?: number) => Promise<any>;
  nodes: () => any[];
  requests: Array<{ method: string; path: string; body: any; status: number }>;
  value: () => string;
  text: () => string;
  updateMeta: (meta: any) => Promise<void>;
  clickSave: () => Promise<void>;
  clickInherit: () => Promise<void>;
  input: (value: string) => Promise<void>;
};

/** 真实 React hooks（useState/useEffect 持久化于组件实例）+ 真实组件源码 + 真实 HTTP fetch。 */
function mountEditor(opts: {
  source: string;
  meta: any;
  goalId: string;
  ws: string;
  origin: () => string;
  cookie: string;
  request: (method: string, path: string, headers: Record<string, string>, body?: unknown) => Promise<{ status: number; body: any }>;
  onChange?: () => any;
}): Mounted {
  const t = loadTranslator();
  const requests: Mounted["requests"] = [];
  const h = (type: any, props: any, ...children: any[]) => ({
    type, props: props ?? {}, children: children.flat(Infinity),
  });
  const hooks: any[] = [];
  const effects: Array<{ deps: string; cleanup?: any }> = [];
  let cursor = 0;
  let effectCursor = 0;
  let dirty = false;
  const React: any = {
    createElement: h,
    Fragment: "fragment",
    useState(init: any) {
      const i = cursor++;
      if (!(i in hooks)) hooks[i] = typeof init === "function" ? init() : init;
      return [hooks[i], (v: any) => {
        const next = typeof v === "function" ? v(hooks[i]) : v;
        if (!Object.is(next, hooks[i])) { hooks[i] = next; dirty = true; }
      }];
    },
    useEffect(fn: any, deps?: any[]) {
      const i = effectCursor++;
      const key = JSON.stringify(deps ?? []);
      if (effects[i] && effects[i].deps === key) return;
      try { effects[i]?.cleanup?.(); } catch { /* ignore */ }
      effects[i] = { deps: key, cleanup: fn() };
    },
    useRef(v: any) { return { current: v }; },
    useCallback(fn: any) { return fn; },
  };
  const graphUrl = (path: string, extra: Record<string, string> = {}) => {
    const p = new URLSearchParams(extra);
    p.set("workspace", opts.ws);
    return `${opts.origin()}${path}?${p.toString()}`;
  };
  const fetchFn = async (url: string, init: any = {}) => {
    const u = new URL(url);
    const method = String(init.method ?? "GET");
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    const res = await opts.request(method, u.pathname + u.search, {
      cookie: opts.cookie, "content-type": "application/json", "sec-fetch-site": "same-origin", ...(init.headers ?? {}),
    }, body);
    requests.push({ method, path: u.pathname + u.search, body, status: res.status });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, json: async () => res.body };
  };
  const sandbox: any = {
    React, h, S: { meta: {}, promptInput: {}, btn: {} }, graphUrl, fetch: fetchFn, dgT: t,
    showToast() {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${extractFunction(opts.source, "GoalBudgetEditor")}\n;this.GoalBudgetEditor = GoalBudgetEditor;`, sandbox);
  const props: any = { goalId: opts.goalId, meta: opts.meta, onChange: opts.onChange };
  let tree: any = null;
  const render = () => {
    cursor = 0; effectCursor = 0; dirty = false;
    tree = sandbox.GoalBudgetEditor(props);
    return tree;
  };
  const flush = async (iter = 80) => {
    for (let i = 0; i < iter; i += 1) {
      await sleep(10);
      if (dirty) render();
    }
    return tree;
  };
  const nodes = (): any[] => {
    const out: any[] = [];
    const walk = (n: any) => {
      if (!n || typeof n !== "object") return;
      out.push(n);
      for (const c of n.children ?? []) walk(c);
    };
    walk(tree);
    return out;
  };
  const value = () => String(nodes().find((n) => n.type === "input")?.props?.value ?? "");
  const text = () => {
    const parts: string[] = [];
    const walk = (n: any) => {
      if (typeof n === "string" || typeof n === "number") parts.push(String(n));
      else if (n && typeof n === "object") for (const c of n.children ?? []) walk(c);
    };
    walk(tree);
    return parts.join("");
  };
  const findButton = (label: string) => nodes().find((n) => n.type === "button"
    && (n.children ?? []).some((c: any) => String(c) === label));
  const updateMeta = async (meta: any) => { props.meta = meta; dirty = true; render(); await flush(); };
  const input = async (v: string) => {
    const inp = nodes().find((n) => n.type === "input");
    assert.ok(inp, "必须渲染预算输入框");
    inp.props.onChange({ target: { value: v } });
    await flush(2);
  };
  const clickSave = async () => {
    const btn = findButton(t("budget.save"));
    assert.ok(btn, "必须渲染保存按钮");
    btn.props.onClick();
    await flush();
  };
  const clickInherit = async () => {
    const btn = findButton(t("budget.inherit"));
    assert.ok(btn, "必须渲染继承按钮（有值时）");
    btn.props.onClick();
    await flush();
  };
  render();
  return { render, flush, nodes, requests, value, text, updateMeta, clickSave, clickInherit, input };
}

test("g-612 UI 文案：预算编辑器 zh/en 齐全可读，en 不含 CJK", () => {
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${readFileSync(I18N_PATH, "utf8")}\n;this.zh = zh; this.en = en;`, sandbox);
  const keys = ["budget.label", "budget.placeholder", "budget.unit", "budget.save",
    "budget.inherit", "budget.invalid", "budget.saveFail", "budget.saved"];
  for (const k of keys) {
    assert.ok(typeof sandbox.zh[k] === "string" && sandbox.zh[k].trim(), `zh 缺少/空: ${k}`);
    assert.ok(typeof sandbox.en[k] === "string" && sandbox.en[k].trim(), `en 缺少/空: ${k}`);
    assert.doesNotMatch(sandbox.en[k], /[\u3400-\u9fff]/, `en ${k} 不得含 CJK`);
  }
});

test("g-612 UI：真实 goal detail 字段 + 真实客户端渲染/回调 —— 保存120、重开120、清空继承、非法零写、鉴权", async () => {
  const h = await makeRealHost({
    http: true,
    projectYaml: "supervisor:\n  session: sess-super\n  care: \"true\"\n  care_threshold_seconds: 300\n",
  });
  const sig = () => new AbortController().signal;
  const care = async () => (await h.tools.get("graph_get_settings").execute({}, { agent: h.parent, signal: sig() })).supervisor_care;
  try {
    const goal = await makeGoal(h, "g612 ui budget");
    const cookie = h.http.mintOwnerCookie();
    const origin = () => h.http.origin();
    const source = readFileSync(MODAL_PATH, "utf8");
    const detail = async () => {
      const r = await h.http.request("GET", `/api/dsh-graph/goal?id=${encodeURIComponent(goal)}`, {
        cookie, "sec-fetch-site": "same-origin",
      });
      assert.equal(r.status, 200, `goal detail 必须 200（实得 ${r.status}）`);
      return r.body;
    };
    const mount = (meta: any, src = source, onChange?: () => any) => mountEditor({
      source: src, meta, goalId: goal, ws: h.ws, origin, cookie,
      request: (m, p, headers, body) => h.http.request(m, p, headers, body),
      onChange,
    });

    // ① 鉴权：匿名/伪造/跨站拒绝，且零写入。
    const post = (headers: Record<string, string>, body: unknown) =>
      h.http.request("POST", ROUTE, { "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers }, JSON.stringify(body));
    const payload = { goal, budget_seconds: 120 };
    assert.ok([401, 403].includes((await post({}, payload)).status), "匿名必须 401/403");
    assert.ok([401, 403].includes((await post({ cookie: "dsh_auth=forged" }, payload)).status), "伪造 cookie 必须 401/403");
    assert.equal((await post({ cookie, "sec-fetch-site": "cross-site" }, payload)).status, 403, "跨站必须 403");
    assert.equal(goalDetail(h.root, goal).meta.task_budget_seconds, undefined, "拒绝路径不得写入");

    // ② 真源：初始无预算，且 goalDetail 不存在 `meta.budget_seconds` 镜像。
    let d = await detail();
    assert.equal(d.meta.task_budget_seconds, undefined);
    assert.equal(d.meta.budget_seconds, undefined, "不得新增可编辑镜像 budget_seconds");

    // ③ 真实客户端渲染 + 输入 + 保存（组件内部 fetch 打到真实 HTTP；onChange=真实 load() 重取）。
    let harness: Mounted;
    const onChange = async () => { const fresh = await detail(); await harness.updateMeta(fresh.meta); };
    harness = mount((await detail()).meta, source, onChange);
    assert.equal(harness.value(), "", "未设置预算时输入框为空（继承）");
    await harness.input("120");
    await harness.clickSave();
    const postReqs = harness.requests.filter((r) => r.method === "POST" && r.path.startsWith(ROUTE));
    assert.equal(postReqs.length, 1, "保存必须恰好一次真实 POST");
    assert.equal(postReqs[0].body?.goal, goal);
    assert.equal(postReqs[0].body?.budget_seconds, 120);
    d = await detail();
    assert.equal(d.meta.task_budget_seconds, 120, "服务端唯一真源已保存 120");
    assert.equal(harness.value(), "120", "onChange→真实 load() 重取后输入框显示 120");

    // ④ 关闭重开：新渲染实例（新组件状态）从真实 goal detail 重新构造 ⇒ 仍显示 120。
    const reopened = mount((await detail()).meta);
    assert.equal(reopened.value(), "120", "关闭重开后必须显示已保存的 120（不是空）");

    // ⑤ 非法值：29/86401 ⇒ 组件拒发、服务端零写。
    await reopened.input("29");
    await reopened.clickSave();
    assert.equal(reopened.requests.filter((r) => r.method === "POST").length, 0, "非法预算不得发请求");
    assert.match(reopened.text(), /30–86400/, "非法值必须给出可见提示");
    await reopened.input("86401");
    await reopened.clickSave();
    assert.equal(reopened.requests.filter((r) => r.method === "POST").length, 0, "越界预算不得发请求");
    assert.equal(goalDetail(h.root, goal).meta.task_budget_seconds, 120, "非法值不得改服务端真源");

    // ⑥ 运行中任务生效预算 = goal 120；清空后必须继承项目默认 300（服务端真实 re-eval）。
    h.fake.hold("G612-UI-CHILD");
    const dispatched: any = await h.dispatch(goal, "G612-UI-CHILD budget", { worktree: false });
    const childId = String(dispatched.child_id ?? "");
    assert.ok(childId);
    const taskOf = async () => {
      const end = Date.now() + 10_000;
      while (Date.now() < end) {
        const st: any = await care();
        const t = (st.tasks ?? []).find((x: any) => x.child === childId);
        if (t) return t;
        await sleep(20);
      }
      throw new Error("等待 care task 超时");
    };
    const tGoal = await taskOf();
    assert.equal(tGoal.budget_seconds, 120, "运行中任务读取 goal 真源");
    assert.equal(tGoal.effective_budget_seconds, 120);

    const reopened2 = mount((await detail()).meta);
    assert.equal(reopened2.value(), "120", "重开后仍是 120（运行中）");
    await reopened2.clickInherit();
    const clearedReqs = reopened2.requests.filter((r) => r.method === "POST");
    assert.equal(clearedReqs.length, 1);
    assert.equal(clearedReqs[0].body?.budget_seconds, null, "清空必须以 null 请求（继承），不是空串/0");
    d = await detail();
    assert.equal(d.meta.task_budget_seconds, undefined, "清空后 goal 恢复继承（meta 无值）");
    const tInherit = await taskOf();
    assert.equal(tInherit.budget_seconds, null, "任务读取继承（null）");
    assert.equal(tInherit.effective_budget_seconds, 300, "继承项目 care_threshold_seconds=300");
    assert.equal(tInherit.budget_source, "project_explicit");
    assert.equal(reopened2.value(), "", "清空后编辑器可见为空（继承默认）");

    // ⑦ 负向对照：把组件读取的字段变异回 `meta.budget_seconds` ⇒ 同一渲染断言必红。
    const mutated = source.replace("props.meta?.task_budget_seconds", "props.meta?.budget_seconds");
    assert.notEqual(mutated, source, "变异必须命中真实读取字段");
    const before = mount({ task_budget_seconds: 120 }, mutated);
    assert.equal(before.value(), "", "旧字段读取在真实 meta 上只能得到空值（证明渲染断言非空转）");
  } finally {
    h.fake.releaseAll();
    try { await h.shutdown(); } catch { /* ignore */ }
  }
});
