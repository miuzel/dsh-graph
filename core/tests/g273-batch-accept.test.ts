import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import {
  batchAcceptButtonState,
  batchAcceptToggleId,
  batchAcceptGroupByVersion,
  batchAcceptGroupState,
  batchAcceptToggleGroup,
  runBatchAccept,
  batchAcceptSupervisorMessage,
  notifySupervisorBatchAccept,
} from "../../dsh-graph-host/lib/client/batch-accept.js";

const root = join(import.meta.dirname, "../../dsh-graph-host");
const i18nSource = readFileSync(join(root, "lib/client/i18n.js"), "utf8");
const moduleSource = readFileSync(join(root, "lib/client/batch-accept.js"), "utf8");
const kanbanSource = readFileSync(join(root, "lib/client/kanban.js"), "utf8");
const bundleSource = readFileSync(join(root, "lib/client.js"), "utf8");
const buildScript = readFileSync(join(root, "../scripts/build-client.sh"), "utf8");

function loadClientI18n() {
  const sandbox: any = { React: {} };
  vm.runInNewContext(i18nSource + "; this.zh = zh; this.en = en;", sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

const { zh, en } = loadClientI18n();
const apply = (tpl: string, params?: Record<string, any>) =>
  String(tpl).replace(/\{(\w+)\}/g, (_, k) => (params && params[k] !== undefined ? String(params[k]) : `{${k}}`));
const dgZh = (key: string, params?: Record<string, any>) => apply(zh[key] ?? key, params);
const dgEn = (key: string, params?: Record<string, any>) => apply(en[key] ?? key, params);

// ===== 1. i18n 词条：zh/en 对称、en 零 CJK =====
test("g-273: i18n batchAccept.* keys exist, zh/en symmetric, en has no CJK", () => {
  const zhBa = Object.keys(zh).filter((k) => k.startsWith("batchAccept."));
  const enBa = Object.keys(en).filter((k) => k.startsWith("batchAccept."));
  assert.ok(zhBa.length >= 10, "batchAccept.* zh keys must exist");
  assert.deepEqual(zhBa.sort(), enBa.sort(), "batchAccept.* zh/en keys must be symmetric");
  // 全字典对称（防遗漏键）
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "client i18n zh/en must have exact same keys");
  for (const k of enBa) {
    assert.doesNotMatch(String(en[k]), /[㐀-鿿]/, `en["${k}"] must have no CJK`);
  }
  // 参数占位一致性
  assert.match(zh["batchAccept.buttonWithCount"], /\{count\}/);
  assert.match(en["batchAccept.buttonWithCount"], /\{count\}/);
  assert.match(zh["batchAccept.selectedCount"], /\{selected\}/);
  assert.match(zh["batchAccept.selectedCount"], /\{total\}/);
  // att-002：组头模板（版本标签 + 该组目标数）参数占位 zh/en 一致
  assert.match(zh["batchAccept.groupHeader"], /\{label\}/);
  assert.match(zh["batchAccept.groupHeader"], /\{count\}/);
  assert.match(en["batchAccept.groupHeader"], /\{label\}/);
  assert.match(en["batchAccept.groupHeader"], /\{count\}/);
  assert.equal(zh["batchAccept.button"], "批量接受");
  assert.equal(en["batchAccept.button"], "Batch Accept");
  // att-003：组级全选/取消全选 aria-label 词条 —— zh/en 对称、含 {label} 占位、en 零 CJK
  assert.match(zh["batchAccept.selectGroup"], /\{label\}/);
  assert.match(zh["batchAccept.unselectGroup"], /\{label\}/);
  assert.match(en["batchAccept.selectGroup"], /\{label\}/);
  assert.match(en["batchAccept.unselectGroup"], /\{label\}/);
  assert.equal(zh["batchAccept.selectGroup"], "全选 {label}");
  assert.equal(zh["batchAccept.unselectGroup"], "取消全选 {label}");
  assert.equal(dgEn("batchAccept.selectGroup", { label: "v1" }), "Select all in v1");
  assert.equal(dgEn("batchAccept.unselectGroup", { label: "v1" }), "Deselect all in v1");
});

// ===== 2. 源契约：非 force、单条聚合、模块注册、看板集成 =====
test("g-273: source contracts — non-force accept body, single aggregated notify, module wiring", () => {
  // 非 force 契约：accept 请求体仅 {goal}；代码（剥离注释后）绝不允许出现 force/delivered 传参
  assert.match(moduleSource, /JSON\.stringify\(\{ goal: goalId \}\)/);
  const moduleCode = moduleSource.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  assert.doesNotMatch(moduleCode, /force/, "batch-accept.js code must never reference force");
  assert.doesNotMatch(moduleCode, /delivered/, "batch-accept.js code must never write delivered directly");
  // 聚合通知：文案构造器唯一（单条消息），queue 模式
  const markerCount = moduleSource.split("【负责人批量交付复核请求】").length - 1;
  assert.equal(markerCount, 1, "aggregated supervisor message template must be defined exactly once");
  assert.match(moduleSource, /"queue"/);
  // 看板集成：确认列列头分支 + 弹窗渲染 + 提交后刷板
  assert.match(kanbanSource, /s\.key === "confirm"/);
  assert.match(kanbanSource, /batchAcceptButtonState\(reviewGoals\.length\)/);
  assert.match(kanbanSource, /h\(BatchAcceptModal/);
  assert.match(kanbanSource, /runBatchAccept\(goalIds/);
  assert.match(kanbanSource, /notifySupervisorBatchAccept\(b\.supervisorSession/);
  assert.match(kanbanSource, /async function submitBatchAccept[\s\S]{0,2500}?load\(\);/);
  // 模块在 build 脚本中注册且位于 drag-prompts 之前（工厂作用域，组件身份稳定）
  const batchIdx = buildScript.indexOf('"batch-accept"');
  const dragIdx = buildScript.indexOf('"drag-prompts"');
  assert.ok(batchIdx > 0 && dragIdx > 0 && batchIdx < dragIdx, "batch-accept must be registered before drag-prompts");
  // 生成物纪律：bundle 已包含新模块且 ESM export 块被剥离
  assert.match(bundleSource, /function BatchAcceptModal\(props\)/);
  assert.match(bundleSource, /function batchAcceptGroupByVersion\(items, standaloneLabel\)/);
  // att-003：组级三态纯函数与 indeterminate ref 赋值已进 bundle；组级词条被模块引用
  assert.match(bundleSource, /function batchAcceptGroupState\(selected, ids\)/);
  assert.match(bundleSource, /function batchAcceptToggleGroup\(selected, ids\)/);
  assert.match(moduleSource, /el\.indeterminate = gState\.some/);
  assert.match(moduleSource, /el\.indeterminate = globalSome/);
  assert.match(moduleSource, /batchAccept\.selectGroup/);
  assert.match(moduleSource, /batchAccept\.unselectGroup/);
  assert.match(bundleSource, /function runBatchAccept\(goalIds, opts = \{\}\)/);
  assert.ok(bundleSource.includes("【负责人批量交付复核请求】"));
  assert.doesNotMatch(bundleSource, /export \{ batchAcceptButtonState/);
  assert.match(bundleSource, /⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY/);
});

// ===== 3. 按钮状态纯函数：禁用态与计数 =====
test("g-273: batchAcceptButtonState — disabled at 0 with tip, count label at >=1", () => {
  (globalThis as any).dgT = dgZh;
  try {
    const zero = batchAcceptButtonState(0);
    assert.equal(zero.disabled, true);
    assert.equal(zero.label, "批量接受");
    assert.equal(zero.title, "当前没有待确认的目标");

    const three = batchAcceptButtonState(3);
    assert.equal(three.disabled, false);
    assert.equal(three.count, 3);
    assert.equal(three.label, "批量接受 (3)");
    assert.match(three.title, /3/);

    // 非法输入安全回退为 0（禁用）
    assert.equal(batchAcceptButtonState(Number.NaN).disabled, true);
    assert.equal(batchAcceptButtonState(-2).disabled, true);

    (globalThis as any).dgT = dgEn;
    const enTwo = batchAcceptButtonState(2);
    assert.equal(enTwo.label, "Batch Accept (2)");
    assert.doesNotMatch(enTwo.label + enTwo.title, /[㐀-鿿]/);
    const enZero = batchAcceptButtonState(0);
    assert.equal(enZero.title, "No goals awaiting confirmation");
  } finally {
    delete (globalThis as any).dgT;
  }
});

// ===== 4. 勾选切换纯函数 =====
test("g-273: batchAcceptToggleId — add/remove", () => {
  assert.deepEqual(batchAcceptToggleId(["a", "b"], "c"), ["a", "b", "c"]);
  assert.deepEqual(batchAcceptToggleId(["a", "b"], "a"), ["b"]);
  assert.deepEqual(batchAcceptToggleId([], "x"), ["x"]);
});

// ===== 4b. att-002：版本分组纯函数 =====
test("g-273 att-002: batchAcceptGroupByVersion — multi-version grouping, first-seen order, counts", () => {
  const items = [
    { id: "g-1", title: "A", versionLabel: "v0.10.0" },
    { id: "g-2", title: "B", versionLabel: "v0.9.0" },
    { id: "g-3", title: "C", versionLabel: "v0.10.0" },
    { id: "g-4", title: "D", versionLabel: "" },
    { id: "g-5", title: "E" }, // 无 versionLabel 字段
    { id: "g-6", title: "F", versionLabel: "  " }, // 纯空白 → 同样归兜底组
  ];
  const groups = batchAcceptGroupByVersion(items, "独立目标");
  // 组顺序 = items 首现顺序（看板泳道顺序），组内保持 items 原序
  assert.deepEqual(groups.map((g: any) => g.label), ["v0.10.0", "v0.9.0", "独立目标"]);
  assert.deepEqual(groups[0].items.map((it: any) => it.id), ["g-1", "g-3"]);
  assert.deepEqual(groups[1].items.map((it: any) => it.id), ["g-2"]);
  // 空串 / 缺失 / 纯空白 versionLabel 一律归入独立目标兜底组
  assert.deepEqual(groups[2].items.map((it: any) => it.id), ["g-4", "g-5", "g-6"]);
});

test("g-273 att-002: batchAcceptGroupByVersion — only non-empty groups, robust to bad input", () => {
  // 只含单版本：只产出一个组，绝不产出空组占位
  const one = batchAcceptGroupByVersion(
    [{ id: "g-1", versionLabel: "v1" }, { id: "g-2", versionLabel: "v1" }],
    "独立目标",
  );
  assert.equal(one.length, 1);
  assert.equal(one[0].label, "v1");
  assert.equal(one[0].items.length, 2);
  // 空 items → 零组（弹窗零目标时不渲染任何组头）
  assert.deepEqual(batchAcceptGroupByVersion([], "独立目标"), []);
  // 非数组 / 含 null 元素 → 安全回退，不抛错
  assert.deepEqual(batchAcceptGroupByVersion(null as any, "独立目标"), []);
  assert.deepEqual(batchAcceptGroupByVersion(undefined as any, "独立目标"), []);
  const withNull = batchAcceptGroupByVersion([null, { id: "g-1" }] as any, "独立目标");
  assert.equal(withNull.length, 1);
  assert.equal(withNull[0].label, "独立目标");
  assert.deepEqual(withNull[0].items.map((it: any) => it.id), ["g-1"]);
});

// ===== 4c. att-003：组级三态与组级切换纯函数 =====
test("g-273 att-003: batchAcceptGroupState — all/some/none tri-state", () => {
  const ids = ["a", "b", "c"];
  assert.deepEqual(batchAcceptGroupState(["a", "b", "c"], ids), { all: true, some: false, none: false });
  assert.deepEqual(batchAcceptGroupState(["a", "b"], ids), { all: false, some: true, none: false });
  assert.deepEqual(batchAcceptGroupState(["a"], ids), { all: false, some: true, none: false });
  assert.deepEqual(batchAcceptGroupState([], ids), { all: false, some: false, none: true });
  assert.deepEqual(batchAcceptGroupState(["x", "y"], ids), { all: false, some: false, none: true });
  // 空组 ids → none（弹窗本就零渲染空组，语义安全回退）
  assert.deepEqual(batchAcceptGroupState(["a"], []), { all: false, some: false, none: true });
  // 非数组输入安全回退
  assert.deepEqual(batchAcceptGroupState(null as any, ids), { all: false, some: false, none: true });
  assert.deepEqual(batchAcceptGroupState(["a"], null as any), { all: false, some: false, none: true });
});

test("g-273 att-003: batchAcceptToggleGroup — selects/clears only its own group, preserves order", () => {
  const groupA = ["a1", "a2"];
  const groupB = ["b1", "b2"];
  // 组未全选 → 选中该组全部；其他组选中态原样保留
  assert.deepEqual(batchAcceptToggleGroup(["b1"], groupA), ["b1", "a1", "a2"]);
  // 部分选中 → 补齐缺失项（保持既有顺序，新项按组内 ids 顺序追加）
  assert.deepEqual(batchAcceptToggleGroup(["a2", "b1"], groupA), ["a2", "b1", "a1"]);
  // 组已全选 → 只取消该组，其他组不受影响
  assert.deepEqual(batchAcceptToggleGroup(["a1", "b1", "a2"], groupA), ["b1"]);
  // 跨组隔离：操作 A 组绝不触碰 B 组项
  assert.deepEqual(batchAcceptToggleGroup(["b1", "b2"], groupB), [], "clearing B removes only B");
  assert.deepEqual(batchAcceptToggleGroup([], groupB), ["b1", "b2"]);
  // 空组 / 非法输入安全回退
  assert.deepEqual(batchAcceptToggleGroup(["x"], []), ["x"]);
  assert.deepEqual(batchAcceptToggleGroup(null as any, groupA), ["a1", "a2"]);
});

// ===== 5. runBatchAccept：非 force 请求体、部分失败继续、并发受限 =====
test("g-273: runBatchAccept — non-force body, partial failure tolerated, concurrency capped", async () => {
  let inflight = 0;
  let maxInflight = 0;
  const calls: Array<{ url: string; init: any }> = [];
  const fetchImpl = async (url: string, init: any) => {
    inflight++;
    maxInflight = Math.max(maxInflight, inflight);
    calls.push({ url, init });
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    const body = JSON.parse(init.body);
    if (body.goal === "g-bad") {
      return { status: 400, json: async () => ({ error: "当前状态 in_progress 不允许接受操作" }) };
    }
    if (body.goal === "g-net") throw new Error("socket hang up");
    return { status: 200, json: async () => ({ pending: true, goal: body.goal }) };
  };
  const { ok, failed } = await runBatchAccept(["g-1", "g-bad", "g-2", "g-net", "g-3"], {
    concurrency: 2,
    fetchImpl: fetchImpl as any,
    urlOf: (p: string) => p,
  });
  // 部分失败不整体崩溃：3 成功 2 失败（状态冲突 + 网络错误各一）
  assert.deepEqual(ok.map((x: any) => x.goal), ["g-1", "g-2", "g-3"]);
  assert.equal(failed.length, 2);
  const failByGoal = new Map(failed.map((f: any) => [f.goal, f]));
  assert.match(String(failByGoal.get("g-bad").error), /不允许接受操作/);
  assert.equal(failByGoal.get("g-bad").status, 400);
  assert.match(String(failByGoal.get("g-net").error), /socket hang up/);
  // 并发受限：max inflight ≤ 2
  assert.ok(maxInflight <= 2, `max inflight ${maxInflight} must be ≤ concurrency 2`);
  assert.ok(maxInflight >= 2, "concurrency should actually be used");
  // 非 force 断言：每个请求体只有 goal 键，绝无 force
  assert.equal(calls.length, 5);
  for (const c of calls) {
    assert.equal(c.init.method, "POST");
    assert.deepEqual(Object.keys(JSON.parse(c.init.body)), ["goal"], "accept body must contain only {goal}");
    assert.equal(c.url, "/api/dsh-graph/accept");
  }
});

test("g-273: runBatchAccept — empty input is a no-op", async () => {
  const res = await runBatchAccept([], { fetchImpl: (() => { throw new Error("must not fetch"); }) as any });
  assert.deepEqual(res, { ok: [], failed: [] });
});

// ===== 6. 聚合主管通知：整批一条；无 supervisorSession 静默跳过 =====
test("g-273: notifySupervisorBatchAccept — exactly one queued message with goal list and count", async () => {
  const prompts: any[] = [];
  (globalThis as any).sessionsRt = {
    binding: (id: string) => (id === "sup-1" ? { session: { prompt: async (parts: any, mode: any) => { prompts.push({ parts, mode }); return { ok: true }; } } } : null),
  };
  try {
    const sent = await notifySupervisorBatchAccept("sup-1", ["g-11", "g-22"]);
    assert.equal(sent, true);
    assert.equal(prompts.length, 1, "must send exactly ONE aggregated message");
    assert.equal(prompts[0].mode, "queue");
    const text = prompts[0].parts[0].text;
    assert.match(text, /【负责人批量交付复核请求】/);
    assert.match(text, /g-11, g-22/);
    assert.match(text, /共 2 个/);
  } finally {
    delete (globalThis as any).sessionsRt;
  }
});

test("g-273: notifySupervisorBatchAccept — no supervisorSession silently skipped", async () => {
  (globalThis as any).sessionsRt = { binding: () => ({ session: { prompt: async () => { throw new Error("must not prompt"); } } }) };
  try {
    assert.equal(await notifySupervisorBatchAccept(null, ["g-1"]), false);
    assert.equal(await notifySupervisorBatchAccept(undefined, ["g-1"]), false);
    assert.equal(await notifySupervisorBatchAccept("sup-x", []), false);
  } finally {
    delete (globalThis as any).sessionsRt;
  }
  // rt 不可用 → 静默 false，不抛错（不影响接受流程）
  (globalThis as any).sessionsRt = null;
  (globalThis as any).appCtx = null;
  try {
    assert.equal(await notifySupervisorBatchAccept("sup-1", ["g-1"]), false);
  } finally {
    delete (globalThis as any).sessionsRt;
    delete (globalThis as any).appCtx;
  }
});

test("g-273: batchAcceptSupervisorMessage — list + total", () => {
  const msg = batchAcceptSupervisorMessage(["g-a"]);
  assert.match(msg, /g-a/);
  assert.match(msg, /共 1 个/);
});

// ===== 7. 弹窗行为模拟（vm + stateful React mock） =====
function makeModalSandbox(locale: "zh" | "en") {
  const h = (type: any, props: any, ...children: any[]) => ({ type, props: props || {}, children });
  const slots: any[] = [];
  let cursor = 0;
  const effectCleanups: Array<() => void> = [];
  const effects: Array<() => void> = [];
  const keydownHandlers: Array<(e: any) => void> = [];
  const React = {
    createElement: h,
    useState(init: any) {
      const i = cursor++;
      if (slots.length <= i) slots.push(typeof init === "function" ? init() : init);
      return [slots[i], (v: any) => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }];
    },
    useRef(init: any) {
      const i = cursor++;
      if (slots.length <= i) slots.push({ current: init });
      return slots[i];
    },
    useEffect(fn: any) { effects.push(fn); },
    useCallback(fn: any) { return fn; },
  };
  const dgT = locale === "zh" ? dgZh : dgEn;
  const sandbox: any = {
    React, h, dgT, console,
    S: { overlay: {}, modal: {}, close: {}, meta: {}, btn: {}, btnAccept: {} },
    // 与 helpers.js useBackdropClose 同语义的轻量复刻
    useBackdropClose: (onClose: any) => {
      let inside = false;
      return {
        onPointerDown: (e: any) => { inside = e.target !== e.currentTarget; },
        onClick: (e: any) => { if (inside) { inside = false; return; } onClose?.(); },
      };
    },
    window: {
      addEventListener: (name: string, fn: any) => { if (name === "keydown") keydownHandlers.push(fn); },
      removeEventListener: () => {},
    },
    fetch: () => { throw new Error("network forbidden: modal must be zero-side-effect until confirm"); },
    sessionsRt: null,
    appCtx: null,
    graphUrl: () => { throw new Error("graphUrl forbidden in modal render"); },
  };
  // 与 build-client.sh 一致：剥离 ESM export 块后在 vm 中作为 classic script 求值
  const moduleForVm = moduleSource.replace(/\/\/ >>>ESM-EXPORTS-START>>>[\s\S]*?\/\/ <<<ESM-EXPORTS-END<<</, "");
  vm.runInNewContext(moduleForVm + ";\nthis.BatchAcceptModal = BatchAcceptModal;", sandbox);
  const render = (props: any) => {
    cursor = 0;
    effects.length = 0;
    const vnode = sandbox.BatchAcceptModal(props);
    // 立即执行 effects（Esc 监听注册 + failures 勾选重置）
    for (const fn of effects.splice(0)) {
      const cleanup = fn();
      if (typeof cleanup === "function") effectCleanups.push(cleanup);
    }
    return vnode;
  };
  return { sandbox, render, keydownHandlers };
}

function walk(node: any, fn: (n: any) => void) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const c of node) walk(c, fn); return; }
  fn(node);
  if (Array.isArray(node.children)) for (const c of node.children) walk(c, fn);
}

function findAll(node: any, pred: (n: any) => boolean): any[] {
  const out: any[] = [];
  walk(node, (n) => { if (pred(n)) out.push(n); });
  return out;
}

function allText(node: any): string[] {
  const out: string[] = [];
  walk(node, () => {});
  const collect = (n: any) => {
    if (typeof n === "string") { out.push(n); return; }
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (Array.isArray(n.children)) n.children.forEach(collect);
  };
  collect(node);
  return out;
}

const ITEMS = [
  { id: "g-001", title: "Alpha goal", versionLabel: "v0.10.0" },
  { id: "g-002", title: "Beta goal", versionLabel: "v0.10.0" },
  { id: "g-003", title: "Gamma goal", versionLabel: "独立目标" },
];

test("g-273: modal lists id/title grouped by version, default all checked, confirm submits selection", () => {
  const { render } = makeModalSandbox("zh");
  const confirmed: string[][] = [];
  const vnode = render({ items: ITEMS, loading: false, failures: null, onConfirm: (ids: string[]) => confirmed.push(Array.from(ids)), onCancel: () => {} });
  // 清单包含 id / 标题；版本以组头形式出现（标签 + 该组目标数），组内行不重复版本列
  const texts = allText(vnode);
  for (const it of ITEMS) {
    assert.ok(texts.includes(it.id), `modal must list ${it.id}`);
    assert.ok(texts.includes(it.title), `modal must list title ${it.title}`);
  }
  assert.ok(texts.includes("v0.10.0 · 2"), "group header must show version label + group count");
  assert.ok(texts.includes("独立目标 · 1"), "standalone group header must show label + count");
  // 版本标签只在组头出现一次（行内不再有版本列）
  assert.equal(texts.filter((t) => t.includes("v0.10.0")).length, 1, "version label must appear exactly once (group header only)");
  assert.equal(texts.filter((t) => t.includes("独立目标")).length, 1, "standalone label must appear exactly once");
  assert.ok(texts.includes("批量接受 — 交付复核请求"));
  assert.ok(texts.includes("已选 3/3"), "default all checked");
  // 确认按钮（dg-btn-accept）默认可用，点击提交全部 id（跨组全局）
  const confirmBtn = findAll(vnode, (n) => n.type === "button" && String(n.props.className ?? "").includes("dg-btn-accept"))[0];
  assert.ok(confirmBtn, "confirm button must exist");
  assert.equal(confirmBtn.props.disabled, false);
  confirmBtn.props.onClick();
  assert.deepEqual(confirmed, [["g-001", "g-002", "g-003"]]);
});

test("g-273 att-002: modal group headers follow items first-seen order; absent versions render zero group nodes", () => {
  const { render } = makeModalSandbox("zh");
  const items = [
    { id: "g-a", title: "A", versionLabel: "v0.10.0" },
    { id: "g-b", title: "B", versionLabel: "v0.9.0" },
    { id: "g-c", title: "C", versionLabel: "v0.10.0" },
    { id: "g-d", title: "D" }, // 无版本 → 独立目标兜底组
  ];
  const vnode = render({ items, loading: false, failures: null, onConfirm: () => {}, onCancel: () => {} });
  const texts = allText(vnode);
  // 组头计数正确（多版本分组 + 兜底组）
  assert.ok(texts.includes("v0.10.0 · 2"));
  assert.ok(texts.includes("v0.9.0 · 1"));
  assert.ok(texts.includes("独立目标 · 1"));
  // 组顺序 = items 首现顺序（看板泳道顺序）
  const headerOrder = texts.filter((t) => / · \d+$/.test(t));
  assert.deepEqual(headerOrder, ["v0.10.0 · 2", "v0.9.0 · 1", "独立目标 · 1"]);
  // 空版本组零渲染：items 中没有的版本绝不出现组头（无空组占位、无「0 个」组）
  assert.ok(!texts.some((t) => t.includes("v0.8.0")), "absent version must not render a group header");
  assert.ok(!texts.some((t) => /· 0$/.test(t)), "no zero-count group may be rendered");
  // 组内行保持 items 原序：g-a 在 g-c 之前，且同组行连续（g-b 组头在 g-c 行之后出现）
  const flat: string[] = [];
  walk(vnode, () => {});
  (function collect(n: any) {
    if (typeof n === "string") { flat.push(n); return; }
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(collect); return; }
    if (Array.isArray(n.children)) n.children.forEach(collect);
  })(vnode);
  const idxOf = (s: string) => flat.findIndex((t) => t === s);
  assert.ok(idxOf("v0.10.0 · 2") < idxOf("g-a") && idxOf("g-a") < idxOf("g-c"), "group header precedes its rows, in-group order preserved");
  assert.ok(idxOf("g-c") < idxOf("v0.9.0 · 1"), "v0.9.0 group header comes after v0.10.0 rows (first-seen order)");
  assert.ok(idxOf("v0.9.0 · 1") < idxOf("g-b") && idxOf("g-b") < idxOf("独立目标 · 1"), "standalone group comes last (first-seen order)");
  assert.ok(idxOf("独立目标 · 1") < idxOf("g-d"), "standalone header precedes its row");
});

test("g-273 att-002: modal cross-group select-all and per-item toggle stay global", () => {
  const { render } = makeModalSandbox("zh");
  const confirmed: string[][] = [];
  const props = { items: ITEMS, loading: false, failures: null, onConfirm: (ids: string[]) => confirmed.push(Array.from(ids)), onCancel: () => {} };
  let vnode = render(props);
  // 跨组单项勾选：取消 v0.10.0 组的 g-002 → 已选 2/3（跨组计数）
  const item2 = findAll(vnode, (n) => n.type === "input" && n.props["aria-label"] === "g-002")[0];
  item2.props.onChange();
  vnode = render(props);
  assert.ok(allText(vnode).includes("已选 2/3"), "selected count is global across groups");
  // 提交跨组剩余项：g-001（v0.10.0 组）+ g-003（独立目标组）
  let confirmBtn = findAll(vnode, (n) => n.type === "button" && String(n.props.className ?? "").includes("dg-btn-accept"))[0];
  confirmBtn.props.onClick();
  assert.deepEqual(confirmed, [["g-001", "g-003"]], "confirm must submit cross-group selection");
  // 全选跨组生效：部分勾选态（2/3）点全选 → 3/3；再点 → 0/3；再点 → 3/3
  const selectAll = findAll(vnode, (n) => n.type === "input" && n.props["aria-label"] === "全选")[0];
  selectAll.props.onChange();
  vnode = render(props);
  assert.ok(allText(vnode).includes("已选 3/3"), "select-all from partial state must check all groups");
  const selectAll2 = findAll(vnode, (n) => n.type === "input" && n.props["aria-label"] === "全选")[0];
  selectAll2.props.onChange();
  vnode = render(props);
  assert.ok(allText(vnode).includes("已选 0/3"), "select-all toggle must clear across all groups");
  const selectAll3 = findAll(vnode, (n) => n.type === "input" && n.props["aria-label"] === "全选")[0];
  selectAll3.props.onChange();
  vnode = render(props);
  assert.ok(allText(vnode).includes("已选 3/3"));
  confirmBtn = findAll(vnode, (n) => n.type === "button" && String(n.props.className ?? "").includes("dg-btn-accept"))[0];
  confirmBtn.props.onClick();
  assert.deepEqual(confirmed[1], ["g-001", "g-002", "g-003"]);
});

test("g-273 att-003: modal per-group tri-state select/deselect, cross-group isolation, global sync", () => {
  const { render } = makeModalSandbox("zh");
  const confirmed: string[][] = [];
  const props = { items: ITEMS, loading: false, failures: null, onConfirm: (ids: string[]) => confirmed.push(Array.from(ids)), onCancel: () => {} };
  const findGroupCb = (vnode: any, label: string) =>
    findAll(vnode, (n) => n.type === "input" && typeof n.props["aria-label"] === "string"
      && (n.props["aria-label"] === `全选 ${label}` || n.props["aria-label"] === `取消全选 ${label}`))[0];
  const findGlobalCb = (vnode: any) =>
    findAll(vnode, (n) => n.type === "input" && n.props["aria-label"] === "全选")[0];
  const indOf = (node: any) => { const el: any = {}; node.props.ref(el); return el.indeterminate; };

  // 初始全选：组 A 开关 = checked（取消全选 aria）、非 indeterminate；全局 = checked、非 indeterminate
  let vnode = render(props);
  let cbA = findGroupCb(vnode, "v0.10.0");
  let cbS = findGroupCb(vnode, "独立目标");
  assert.ok(cbA && cbS, "each non-empty group must render a group-level switch");
  assert.equal(cbA.props["aria-label"], "取消全选 v0.10.0");
  assert.equal(cbA.props.checked, true);
  assert.equal(indOf(cbA), false, "fully-selected group must not be indeterminate");
  assert.equal(cbS.props["aria-label"], "取消全选 独立目标");
  assert.equal(indOf(findGlobalCb(vnode)), false, "fully-selected global must not be indeterminate");
  assert.equal(findGlobalCb(vnode).props.checked, true);

  // 组已全选 → 点击取消该组全部：已选 1/3（仅剩独立目标组 g-003）——跨组隔离
  cbA.props.onChange();
  vnode = render(props);
  assert.ok(allText(vnode).includes("已选 1/3"), "deselecting group A must keep group B untouched");
  cbA = findGroupCb(vnode, "v0.10.0");
  cbS = findGroupCb(vnode, "独立目标");
  assert.equal(cbA.props["aria-label"], "全选 v0.10.0", "cleared group switches aria to select-all");
  assert.equal(cbA.props.checked, false);
  assert.equal(indOf(cbA), false, "empty-selection group must be unchecked, not indeterminate");
  assert.equal(cbS.props.checked, true, "group B selection must be unaffected (cross-group isolation)");
  assert.equal(indOf(cbS), false);
  // 全局三态联动：部分选中 → 全局 indeterminate、未 checked
  const g1 = findGlobalCb(vnode);
  assert.equal(g1.props.checked, false);
  assert.equal(indOf(g1), true, "partial global selection must render indeterminate");

  // 单项勾选 g-001 → 组 A 部分选中：组开关 indeterminate、checked=false；全局仍 indeterminate
  const item1 = findAll(vnode, (n) => n.type === "input" && n.props["aria-label"] === "g-001")[0];
  item1.props.onChange();
  vnode = render(props);
  assert.ok(allText(vnode).includes("已选 2/3"));
  cbA = findGroupCb(vnode, "v0.10.0");
  assert.equal(cbA.props["aria-label"], "全选 v0.10.0", "partially-selected group still offers select-all");
  assert.equal(cbA.props.checked, false);
  assert.equal(indOf(cbA), true, "partially-selected group must render indeterminate");
  assert.equal(indOf(findGlobalCb(vnode)), true);

  // 组未全选 → 点击选中该组全部：已选 3/3，组 A 回到全选态，全局回到 checked 非 indeterminate
  cbA.props.onChange();
  vnode = render(props);
  assert.ok(allText(vnode).includes("已选 3/3"));
  cbA = findGroupCb(vnode, "v0.10.0");
  assert.equal(cbA.props["aria-label"], "取消全选 v0.10.0");
  assert.equal(cbA.props.checked, true);
  assert.equal(indOf(cbA), false);
  const g2 = findGlobalCb(vnode);
  assert.equal(g2.props.checked, true);
  assert.equal(indOf(g2), false);
  // 组级开关也可用组头文字点击触发（与全选行一致的交互），且提交跨组全集
  const headerSpan = findAll(vnode, (n) => n.type === "span" && (n.children ?? []).includes("v0.10.0 · 2"))[0];
  assert.ok(headerSpan, "group header label must exist");
  headerSpan.props.onClick();
  vnode = render(props);
  assert.ok(allText(vnode).includes("已选 1/3"), "clicking group header label toggles the group");
  findGroupCb(vnode, "v0.10.0").props.onChange();
  vnode = render(props);
  const confirmBtn = findAll(vnode, (n) => n.type === "button" && String(n.props.className ?? "").includes("dg-btn-accept"))[0];
  confirmBtn.props.onClick();
  // 取消后重选采用追加语义：顺序为 [独立目标组, 重选的组 A]，成员仍为跨组全集
  assert.deepEqual([...confirmed[0]].sort(), ["g-001", "g-002", "g-003"], "confirm submits cross-group selection");
});

test("g-273 att-003: modal group switch locked while loading; cancel paths stay zero-side-effect", () => {
  const { render, keydownHandlers } = makeModalSandbox("zh");
  let cancelled = 0;
  const vnode = render({ items: ITEMS, loading: true, failures: null, onConfirm: () => { throw new Error("must not confirm"); }, onCancel: () => { cancelled++; } });
  const groupCbs = findAll(vnode, (n) => n.type === "input" && typeof n.props["aria-label"] === "string"
    && /^(全选|取消全选) /.test(n.props["aria-label"]));
  assert.equal(groupCbs.length, 2, "one group switch per rendered group");
  for (const cb of groupCbs) {
    assert.equal(cb.props.disabled, true, "group switch must be disabled while loading");
    cb.props.onChange(); // 即便触发也不应改变任何选中态（守卫）
  }
  // 行勾选同样锁定
  const rowCb = findAll(vnode, (n) => n.type === "input" && n.props["aria-label"] === "g-001")[0];
  assert.equal(rowCb.props.disabled, true);
  // 组头文字点击同样被守卫
  const headerSpan = findAll(vnode, (n) => n.type === "span" && (n.children ?? []).includes("v0.10.0 · 2"))[0];
  headerSpan.props.onClick();
  // 取消路径仍零副作用
  const x = findAll(vnode, (n) => n.type === "span" && (n.children ?? []).includes("✕"))[0];
  x.props.onClick();
  keydownHandlers[0]({ key: "Escape", stopPropagation: () => {} });
  assert.equal(cancelled, 0, "loading must lock every close path");
});

test("g-273 att-003: modal group switches absent when no groups (empty items render zero group nodes)", () => {
  const { render } = makeModalSandbox("zh");
  const vnode = render({ items: [], loading: false, failures: null, onConfirm: () => {}, onCancel: () => {} });
  const groupCbs = findAll(vnode, (n) => n.type === "input" && typeof n.props["aria-label"] === "string"
    && /^(全选|取消全选) /.test(n.props["aria-label"]));
  assert.equal(groupCbs.length, 0, "no group switch may render without groups");
  assert.ok(!allText(vnode).some((t) => / · \d+$/.test(t)), "no group header may render");
});

test("g-273 att-003: modal group switch aria-labels are localized (zh/en, en zero CJK)", () => {
  const { render: renderEn } = makeModalSandbox("en");
  const enItems = [
    { id: "g-001", title: "Alpha goal", versionLabel: "v0.10.0" },
    { id: "g-002", title: "Beta goal", versionLabel: "Standalone" },
  ];
  let vnode = renderEn({ items: enItems, loading: false, failures: null, onConfirm: () => {}, onCancel: () => {} });
  const findGroupCb = (vn: any, label: string) =>
    findAll(vn, (n) => n.type === "input" && typeof n.props["aria-label"] === "string" && n.props["aria-label"].includes(label))[0];
  let cb = findGroupCb(vnode, "v0.10.0");
  assert.equal(cb.props["aria-label"], "Deselect all in v0.10.0");
  assert.doesNotMatch(cb.props["aria-label"], /[㐀-鿿]/);
  cb.props.onChange();
  vnode = renderEn({ items: enItems, loading: false, failures: null, onConfirm: () => {}, onCancel: () => {} });
  cb = findGroupCb(vnode, "v0.10.0");
  assert.equal(cb.props["aria-label"], "Select all in v0.10.0");
  assert.doesNotMatch(cb.props["aria-label"], /[㐀-鿿]/);
});

test("g-273: modal select-all and per-item toggle drive selection", () => {
  const { render } = makeModalSandbox("zh");
  const confirmed: string[][] = [];
  const props = { items: ITEMS, loading: false, failures: null, onConfirm: (ids: string[]) => confirmed.push(Array.from(ids)), onCancel: () => {} };
  let vnode = render(props);
  // 全选取消 → 已选 0/3，确认按钮禁用
  const selectAll = findAll(vnode, (n) => n.type === "input" && n.props["aria-label"] === "全选")[0];
  assert.ok(selectAll, "select-all checkbox must exist");
  selectAll.props.onChange();
  vnode = render(props);
  assert.ok(allText(vnode).includes("已选 0/3"));
  let confirmBtn = findAll(vnode, (n) => n.type === "button" && String(n.props.className ?? "").includes("dg-btn-accept"))[0];
  assert.equal(confirmBtn.props.disabled, true, "confirm must be disabled when nothing selected");
  confirmBtn.props.onClick();
  assert.equal(confirmed.length, 0, "disabled confirm must not submit");
  // 单项勾选 g-002 → 提交仅 g-002
  const item2 = findAll(vnode, (n) => n.type === "input" && n.props["aria-label"] === "g-002")[0];
  item2.props.onChange();
  vnode = render(props);
  assert.ok(allText(vnode).includes("已选 1/3"));
  confirmBtn = findAll(vnode, (n) => n.type === "button" && String(n.props.className ?? "").includes("dg-btn-accept"))[0];
  assert.equal(confirmBtn.props.disabled, false);
  confirmBtn.props.onClick();
  assert.deepEqual(confirmed, [["g-002"]]);
  // 再次全选 → 3/3
  const selectAll2 = findAll(vnode, (n) => n.type === "input" && n.props["aria-label"] === "全选")[0];
  selectAll2.props.onChange();
  vnode = render(props);
  assert.ok(allText(vnode).includes("已选 3/3"));
});

test("g-273: modal cancel paths (✕ / cancel button / backdrop / Esc) are zero-side-effect", () => {
  for (const path of ["close-x", "cancel-btn", "backdrop", "esc"] as const) {
    const { render, keydownHandlers } = makeModalSandbox("zh");
    let cancelled = 0;
    const vnode = render({ items: ITEMS, loading: false, failures: null, onConfirm: () => { throw new Error("must not confirm"); }, onCancel: () => { cancelled++; } });
    if (path === "close-x") {
      const x = findAll(vnode, (n) => n.type === "span" && (n.children ?? []).includes("✕"))[0];
      x.props.onClick();
    } else if (path === "cancel-btn") {
      const btn = findAll(vnode, (n) => n.type === "button" && (n.children ?? []).includes("取消"))[0];
      btn.props.onClick();
    } else if (path === "backdrop") {
      // 遮罩点击：pointerdown 起点在遮罩自身 → click 触发 onCancel
      const overlay = findAll(vnode, (n) => n.props.onPointerDown && n.props.onClick)[0];
      const evt = { target: "OVERLAY", currentTarget: "OVERLAY" };
      overlay.props.onPointerDown(evt);
      overlay.props.onClick(evt);
    } else {
      assert.ok(keydownHandlers.length >= 1, "Esc keydown listener must be registered");
      let stopped = false;
      keydownHandlers[0]({ key: "Escape", stopPropagation: () => { stopped = true; } });
      assert.ok(stopped, "Esc handler must stopPropagation");
    }
    assert.equal(cancelled, 1, `${path} must trigger onCancel exactly once (zero network, zero state change)`);
  }
  // 内容区起点拖拽到遮罩松手（g-181 误关保护）：不关闭
  const { render } = makeModalSandbox("zh");
  let cancelled = 0;
  const vnode = render({ items: ITEMS, loading: false, failures: null, onConfirm: () => {}, onCancel: () => { cancelled++; } });
  const overlay = findAll(vnode, (n) => n.props.onPointerDown && n.props.onClick)[0];
  overlay.props.onPointerDown({ target: "INNER", currentTarget: "OVERLAY" });
  overlay.props.onClick({ target: "OVERLAY", currentTarget: "OVERLAY" });
  assert.equal(cancelled, 0, "inside-origin drag-release on backdrop must not close");
});

test("g-273: modal loading locks confirm/cancel/✕/backdrop/Esc (no double submit)", () => {
  const { render, keydownHandlers } = makeModalSandbox("zh");
  let cancelled = 0;
  let confirmed = 0;
  const vnode = render({ items: ITEMS, loading: true, failures: null, onConfirm: () => { confirmed++; }, onCancel: () => { cancelled++; } });
  const confirmBtn = findAll(vnode, (n) => n.type === "button" && String(n.props.className ?? "").includes("dg-btn-accept"))[0];
  assert.equal(confirmBtn.props.disabled, true, "confirm locked while loading");
  confirmBtn.props.onClick();
  assert.equal(confirmed, 0);
  const cancelBtn = findAll(vnode, (n) => n.type === "button" && (n.children ?? []).includes("取消"))[0];
  assert.equal(cancelBtn.props.disabled, true, "cancel locked while loading");
  cancelBtn.props.onClick();
  const x = findAll(vnode, (n) => n.type === "span" && (n.children ?? []).includes("✕"))[0];
  x.props.onClick();
  const overlay = findAll(vnode, (n) => n.props.onPointerDown && n.props.onClick)[0];
  overlay.props.onPointerDown({ target: "O", currentTarget: "O" });
  overlay.props.onClick({ target: "O", currentTarget: "O" });
  keydownHandlers[0]({ key: "Escape", stopPropagation: () => {} });
  assert.equal(cancelled, 0, "all close paths must be locked while loading");
  // loading 文案
  assert.ok(allText(vnode).includes("提交中…"));
});

test("g-273: modal partial-failure list renders reasons and resets selection to failed", () => {
  const { render } = makeModalSandbox("zh");
  const failures = [{ goal: "g-002", error: "当前状态 in_progress 不允许接受操作" }];
  const props = { items: ITEMS, loading: false, failures, onConfirm: () => {}, onCancel: () => {} };
  let vnode = render(props);
  let texts = allText(vnode);
  assert.ok(texts.includes("以下目标接受失败（其余已正常提交）："));
  assert.ok(texts.some((t) => t.includes("g-002") && t.includes("不允许接受操作")), "failure reason must be listed");
  // failures useEffect 重置勾选为失败项 → 重渲染后 已选 1/3
  vnode = render(props);
  texts = allText(vnode);
  assert.ok(texts.includes("已选 1/3"), "selection must reset to failed goals for retry");
});

test("g-273: modal en locale renders with zero CJK", () => {
  const { render } = makeModalSandbox("en");
  const enItems = [
    { id: "g-001", title: "Alpha goal", versionLabel: "v0.10.0" },
    { id: "g-002", title: "Beta goal", versionLabel: "Standalone" },
  ];
  const vnode = render({ items: enItems, loading: false, failures: null, onConfirm: () => {}, onCancel: () => {} });
  const texts = allText(vnode);
  assert.ok(texts.includes("Batch Accept — Delivery Review Request"));
  assert.ok(texts.includes("Select all"));
  assert.ok(texts.includes("Selected 2/2"));
  // att-002：组头按版本分组渲染（en 模板同样含 label + count）
  assert.ok(texts.includes("v0.10.0 · 1"));
  assert.ok(texts.includes("Standalone · 1"));
  for (const t of texts) {
    assert.doesNotMatch(t, /[㐀-鿿]/, `en modal text "${t}" must have no CJK`);
  }
});
