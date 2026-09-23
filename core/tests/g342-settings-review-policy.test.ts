/**
 * g-342 判据机器断言：设置弹窗补 `review.policy` 四态下拉（继承未配置 / auto / strict / none）。
 *
 * 覆盖质量判据 1–4：
 *  1. 弹窗真实渲染出四个可选项；选「继承」→ 客户端提交体 `policy: null`（core 侧清空 → 读回 null，
 *     按目标类型派生）；选三值 → 提交体直传，经 `/api/dsh-graph/settings` 写入并被 readProjectConfig 读回同值
 *  2. 脏状态三态齐备：未改动不脏 / 改动算脏 / 保存后复原；服务端 null 与表单 "" 不造成假阳性
 *  3. 保存走既有通道：原子写、保留 YAML 注释与未知键、非法值被 schema 拒绝且文件**逐字节不变**；
 *     schema 与策略判定逻辑未被削弱（`""` / 大小写 / 类型不符仍拒绝）、不新增 graph_* 工具（计数仍 44）
 *  4. 客户端 i18n zh/en 键对称（en 侧零 CJK）、`node --check dist/lib/client.js` 通过、
 *     build 产物含新控件（未 rebuild 即红）
 *
 * 「改坏即红」：本文件末节是 hermetic 负向对照——把**内存中的副本源码**改坏后，同一套检查函数必须
 * 报出问题，并断言真实仓库文件逐字未变（对照不污染工作树）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { init, readProjectConfig, GraphError } from "../ops.ts";
import { REVIEW_POLICIES } from "../review-policy.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const clientDir = join(repoRoot, "dsh-graph-host/lib/client");
const distRoot = join(repoRoot, "dist");
const modalPath = join(clientDir, "settings-modal.js");
const i18nPath = join(clientDir, "i18n.js");

const readModal = (): string => readFileSync(modalPath, "utf8");
const readI18n = (): string => readFileSync(i18nPath, "utf8");

type Dict = Record<string, string>;

/** 客户端可见的 7 个新增键（label / aria / 继承 / 三值 / 提示）。 */
const REVIEW_POLICY_I18N_KEYS = [
  "settings.reviewPolicyLabel",
  "settings.reviewPolicyAria",
  "settings.reviewPolicyInherit",
  "settings.reviewPolicyAuto",
  "settings.reviewPolicyStrict",
  "settings.reviewPolicyNone",
  "settings.reviewPolicyHint",
];

function loadClientI18n(src = readI18n()): { zh: Dict; en: Dict } {
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${src}\n;this.zh = zh; this.en = en;`, sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

/** normalizeSettingsDraft…SettingsModal 之间的「归一化段」——与既有 g-246 行为测试同一截取口径，
 *  使本套件既能独立求值，又不依赖 g-246 的断言（两处互相印证）。 */
const NORM_START = "function normalizeSettingsDraft(";
const NORM_END = "function SettingsModal(";

function loadNormSection(modalSrc: string) {
  const start = modalSrc.indexOf(NORM_START);
  const end = modalSrc.indexOf(NORM_END, start);
  if (start < 0 || end <= start) throw new Error("settings-modal.js 缺少归一化段（normalizeSettingsDraft…SettingsModal）");
  const sandbox: any = {};
  vm.runInNewContext(
    `(function () {\n${modalSrc.slice(start, end)}\n` +
      `globalThis.__norm = normalizeSettingsDraft;` +
      `globalThis.__dirty = settingsDraftIsDirty;` +
      `globalThis.__values = REVIEW_POLICY_VALUES;` +
      `globalThis.__normalizePolicy = normalizeReviewPolicyDraft;` +
      `})()`,
    sandbox,
  );
  return {
    norm: sandbox.__norm as (form: any, refresh: string) => any,
    dirty: sandbox.__dirty as (b: any, f: any, r: string) => boolean,
    values: sandbox.__values as string[],
    normalizePolicy: sandbox.__normalizePolicy as (v: unknown) => string,
  };
}

/** 真实渲染 SettingsModal（form 已加载态），返回根元素树。
 *  仅替换 React 与 Host 依赖：加载/失败分支由 useState 覆写跳过，表单分支为真实代码路径。 */
function renderSettingsModal(modalSrc: string, snapshot: any, zh: Dict) {
  const h = (type: any, props: any, ...children: any[]) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c: any) => c !== null && c !== undefined && c !== false),
  });
  // SettingsModal 内 useState 调用序：loading, form, saving, note, error, showAdvanced, configFile, refreshIntervalInput, intervalWarn, catalog
  const overrides = [false, snapshot];
  let idx = 0;
  const sandbox: any = {
    console,
    h,
    // 与 helpers.js dgOverlay 同语义的轻量复刻：vm 沙箱无 DOM/ReactDOM，退化为裸 div
    // （弹层 portal 落点不影响本文件断言的渲染结构；断言强度不变）
    dgOverlay: (props: any, ...children: any[]) => h("div", props, ...children),
    settingsModalModeInstanceSeq: 0,
    dgT: (k: string) => zh[k] ?? k,
    S: new Proxy({}, { get: () => ({}) }),
    graphUrl: (u: string) => u,
    gConnectionApi: null,
    loadHostCatalog: async () => ({ status: "unavailable" }),
    openHostPath: async () => ({ opened: false }),
    copyText: async () => true,
    showToast: () => {},
    openErrorText: (e: any) => String(e),
    getRefreshInterval: () => 15,
    setRefreshInterval: () => 15,
    MIN_REFRESH_INTERVAL: 5,
    useLocaleRevision: () => {},
    useBackdropClose: () => ({}),
    useLiveDisplayEnabled: () => false,
    window: { confirm: () => true },
    localStorage: { getItem: () => null, setItem: () => {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    React: {
      createElement: h,
      useRef: (init: any) => ({ current: init }),
      useState: (init: any) => {
        const i = idx++;
        const v = i < overrides.length ? overrides[i] : (typeof init === "function" ? init() : init);
        return [v, () => {}];
      },
      useEffect: () => {},
    },
  };
  const start = modalSrc.indexOf(NORM_END);
  assert.ok(start > 0, "settings-modal.js 缺少 SettingsModal");
  const normStart = modalSrc.indexOf(NORM_START);
  assert.ok(normStart > 0 && normStart < start, "settings-modal.js 缺少 normalizeSettingsDraft");
  vm.runInNewContext(
    `${modalSrc.slice(normStart, start)}\n${modalSrc.slice(start)}\n;this.__SettingsModal = SettingsModal;`,
    sandbox,
  );
  return sandbox.__SettingsModal({ onClose: () => {}, onSaved: () => {} });
}

/** 深度遍历渲染树。 */
function walk(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** 取 review.policy 下拉的四个可选项（真实渲染树，非字符串自证）。 */
function reviewPolicyOptions(tree: any, zh: Dict) {
  let select: any = null;
  walk(tree, (n) => {
    if (!select && n.type === "select" && n.props?.["aria-label"] === zh["settings.reviewPolicyAria"]) select = n;
  });
  assert.ok(select, "渲染树中找到 review.policy 下拉（aria-label 绑定）");
  const options = (select.children ?? []).filter((c: any) => c.type === "option");
  return { select, options: options.map((o: any) => ({ value: o.props.value, label: o.children.join(""), style: o.props.style })) };
}

/** 运行 settings-modal.js 的 save()（真实源码），返回其 POST 到 /api/dsh-graph/settings 的提交体。 */
async function runClientSave(modalSrc: string, form: any, zh: Dict): Promise<any> {
  const helpers = readFileSync(join(clientDir, "helpers.js"), "utf8");
  const helperSrc = helpers.slice(helpers.indexOf("const REFRESH_INTERVAL_KEY"), helpers.indexOf("const LIVE_DISPLAY_KEY"));
  const normSrc = modalSrc.slice(modalSrc.indexOf(NORM_START), modalSrc.indexOf(NORM_END));
  const saveStart = modalSrc.indexOf("const save = async () => {");
  const saveEnd = modalSrc.indexOf("if (loading)", saveStart);
  assert.ok(saveStart > 0 && saveEnd > saveStart, "settings-modal.js 含完整 save 函数段");
  const saveSrc = modalSrc.slice(saveStart, saveEnd);
  const closeStart = modalSrc.indexOf("const requestClose = () => {");
  const reqCloseSrc = modalSrc.slice(closeStart, modalSrc.indexOf("const handleIntervalChange", closeStart));

  const store = new Map<string, string>([["dsh-graph.refresh-interval", "15"]]);
  const calls: any = { setNote: [], setError: [], fetch: [] };
  const sandbox: any = {
    console,
    dgT: (k: string) => zh[k] ?? k,
    graphUrl: (u: string) => u,
    window: { confirm: () => true, dispatchEvent: () => {} },
    CustomEvent: class { type: string; init: any; constructor(type: string, init: any) { this.type = type; this.init = init; } },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: any) => store.set(k, String(v)) },
    fetch: async (url: string, opts: any) => {
      calls.fetch.push({ url, opts });
      return { ok: true, status: 200, json: async () => ({ config: JSON.parse(opts.body) }) };
    },
    props: { onSaved: () => {}, onClose: () => {} },
    setSaving: () => {},
    setNote: (v: any) => calls.setNote.push(v),
    setError: (v: any) => calls.setError.push(v),
    setRefreshIntervalInput: () => {},
    setIntervalWarn: () => {},
    setForm: () => {},
  };
  vm.runInNewContext(
    `${helperSrc}\n${normSrc}\nlet form = ${JSON.stringify(form)};\nlet saving = false;\n` +
      `let refreshIntervalInput = "15";\n` +
      `let baselineRef = { current: normalizeSettingsDraft(form, String(getRefreshInterval())) };\n` +
      `${reqCloseSrc}\n${saveSrc}\n;this.__save = save;`,
    sandbox,
  );
  await sandbox.__save();
  assert.equal(calls.fetch.length, 1, "save() 发起了 1 次 POST");
  assert.equal(calls.fetch[0].url, "/api/dsh-graph/settings", "POST 走既有 settings 通道");
  return JSON.parse(calls.fetch[0].opts.body);
}

// =====================================================================================
// 判据 1：弹窗四态下拉 + 客户端提交体 + 服务端往返
// =====================================================================================

test("g-342 判据1：弹窗真实渲染出「继承 + auto/strict/none」四个可选项", () => {
  const { zh } = loadClientI18n();
  for (const snapshot of [{ review: { policy: null } }, { review: { policy: "strict" } }]) {
    const { select, options } = reviewPolicyOptions(renderSettingsModal(readModal(), snapshot, zh), zh);
    assert.deepEqual(
      options.map((o) => o.value),
      ["", ...REVIEW_POLICIES],
      "四个可选项：继承(空值) + core 真源三值",
    );
    assert.equal(options[0].label, zh["settings.reviewPolicyInherit"], "继承项文案来自 i18n");
    assert.ok(options[0].label.includes("继承"), `继承项文案应含「继承」：${options[0].label}`);
    assert.equal(options[1].label, zh["settings.reviewPolicyAuto"]);
    assert.equal(options[2].label, zh["settings.reviewPolicyStrict"]);
    assert.equal(options[3].label, zh["settings.reviewPolicyNone"]);
    assert.equal(
      select.props.value,
      snapshot.review.policy ?? "",
      "下拉选中值与服务端快照一致（null → 继承空值）",
    );
    // 每个 option 都带 g-176 主题变量（不硬编码暗色），与既有 automation 下拉同款
    for (const o of options) {
      const raw = JSON.stringify(o);
      assert.ok(raw.includes("--dsw-alias-bg-layer-3"), "选项 style 走主题变量");
    }
  }
});

test("g-342 判据1：客户端副本 REVIEW_POLICY_VALUES 与 core 真源一致，且非三值一律归一为「继承」", () => {
  const { values, normalizePolicy } = loadNormSection(readModal());
  assert.deepEqual([...values].sort(), [...REVIEW_POLICIES].sort(), "客户端副本 == core REVIEW_POLICIES");
  assert.deepEqual([...REVIEW_POLICIES], ["auto", "strict", "none"], "真源三值未变");
  for (const p of REVIEW_POLICIES) assert.equal(normalizePolicy(p), p, `${p} 原样保留`);
  for (const bad of ["", null, undefined, "AUTO", "Strict", "fast", 123, {}]) {
    assert.equal(normalizePolicy(bad), "", `${JSON.stringify(bad)} 归一为继承空值`);
  }
});

test("g-342 判据1：客户端 save() 提交体——继承写 null、三值直传、未知值回落 null", async () => {
  const { zh } = loadClientI18n();
  const base = {
    executor: { provider: "", model: "" },
    defaults: { review: { reviewer: "", prompt: null }, pk: { lanes: 1, sandbox: "" } },
    supervisor: { automation: {} },
    prompt_overrides: { subagent: { state: "default", value: null } },
  };
  const bodyFor = async (policy: unknown) =>
    runClientSave(readModal(), { ...base, review: { policy } }, zh);

  // 「继承」：客户端下拉空值 → 提交 null（写 "" 会被 schema enum 拒绝）
  for (const inherit of ["", null, undefined]) {
    const body = await bodyFor(inherit);
    assert.equal(body.review.policy, null, `继承（${JSON.stringify(inherit)}）必须提交 null`);
  }
  // 未知/非法存量值（读路径容错）不得被原样回写
  assert.equal((await bodyFor("AUTO")).review.policy, null, "大小写不符 → 继承");
  assert.equal((await bodyFor("fast")).review.policy, null, "未知取值 → 继承");
  // 三值直传
  for (const p of REVIEW_POLICIES) {
    const body = await bodyFor(p);
    assert.equal(body.review.policy, p, `${p} 直传`);
  }
  // 既有字段仍全量提交（回归：新增字段不得挤掉旧字段）
  const body = await bodyFor("auto");
  assert.deepEqual(Object.keys(body).sort(), ["defaults", "executor", "prompt_overrides", "review", "supervisor"]);
  assert.ok(body.supervisor && body.defaults && body.executor, "旧字段仍在提交体中");
});

function fakeRequest(method: string, body: unknown) {
  const req: any = { method, _listeners: {} as Record<string, (v?: any) => void>, on(ev: string, cb: (v?: any) => void) { req._listeners[ev] = cb; } };
  return req;
}
function fakeResponse() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}
/** 隔离实例：绝对 config.root → rootForReq 直接落到临时目录，绝不触达主工作区看板。 */
function setupInstance() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g342-"));
  init(root);
  const routes = new Map<string, any>();
  const toolNames: string[] = [];
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { toolNames.push(def?.name ?? ""); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  return { root, routes, toolNames };
}
const postSettings = async (routes: Map<string, any>, body: unknown) => {
  const handler = routes.get("/api/dsh-graph/settings");
  assert.ok(handler, "settings 路由已注册");
  const req = fakeRequest("POST", body);
  const res = fakeResponse();
  const p = handler(req, res);
  req._listeners.data?.(JSON.stringify(body));
  req._listeners.end?.();
  await p;
  return { code: res._code, body: res._body };
};

const CONFIG_WITH_COMMENTS = [
  "executor:",
  "  provider: openai-codex   # 行尾注释须保留",
  "unknown_block:",
  "  mystery: keep-me",
  "review:",
  "  policy: strict   # 评审策略注释须保留",
  "",
].join("\n");

test("g-342 判据1：POST /api/dsh-graph/settings 三值往返写入，继承清空后读回 null", async () => {
  const { root, routes } = setupInstance();
  writeFileSync(join(root, "project.yaml"), CONFIG_WITH_COMMENTS, "utf8");

  for (const policy of REVIEW_POLICIES) {
    const r = await postSettings(routes, { review: { policy } });
    assert.equal(r.code, 200, `${policy} 写入被接受`);
    assert.equal(readProjectConfig(root).review.policy, policy, `${policy} 被 readProjectConfig 读回同值`);
  }
  // 继承：客户端真实提交体（policy: null）走同一通道
  const inherit = await postSettings(routes, { review: { policy: null } });
  assert.equal(inherit.code, 200);
  assert.equal(readProjectConfig(root).review.policy, null, "继承（null）→ 读回 null（＝按目标类型派生）");
  const text = readFileSync(join(root, "project.yaml"), "utf8");
  assert.match(text, /provider: openai-codex   # 行尾注释须保留/, "既有注释保留");
  assert.match(text, /mystery: keep-me/, "未知键保留");
  // 清空只在值位留白（行尾注释逐字保留；残留的连续空格是既有 setScalar 的既定形态）
  assert.match(text, /^ {2}policy:\s+# 评审策略注释须保留$/m, "被清空的 policy 行仍保留原注释");
  assert.doesNotMatch(text, /^ {2}policy:\s+(auto|strict|none)\b/m, "清空后不再残留任何策略值");
});

test("g-342 判据1：partial patch——只动 review.policy 不影响既有字段", async () => {
  const { root, routes } = setupInstance();
  writeFileSync(join(root, "project.yaml"), CONFIG_WITH_COMMENTS, "utf8");
  await postSettings(routes, { review: { policy: "none" } });
  assert.equal(readProjectConfig(root).executor.provider, "openai-codex", "既有 executor.provider 不受影响");
  assert.equal(readProjectConfig(root).review.policy, "none");
});

// =====================================================================================
// 判据 2：脏状态三态 + null/"" 无假阳性
// =====================================================================================

test("g-342 判据2：未改动不脏 / 改动算脏 / 保存后复原（含 null↔\"\" 无假阳性）", () => {
  const { norm, dirty } = loadNormSection(readModal());
  const server = {
    executor: { provider: "", model: "", reasoning_effort: "", mode: "" },
    defaults: { review: { reviewer: "", prompt: null }, pk: { lanes: 1, sandbox: "" } },
    supervisor: { automation: { release: "human" } },
    prompt_overrides: { subagent: { state: "default", value: null } },
    review: { policy: null },
  };
  const baseline = norm(server, "15");

  // 三态之一：打开弹窗未改动 → 不脏
  assert.equal(dirty(baseline, server, "15"), false, "未改动不脏");
  // 服务端 null 与表单 "" → 规范化后一致（判据 2 的考点）
  const emptyForm = JSON.parse(JSON.stringify(server));
  emptyForm.review.policy = "";
  assert.equal(dirty(baseline, emptyForm, "15"), false, "null↔空串不脏（无假阳性）");
  // 读路径容错的非法存量值也不得造成假脏（归一后同为「继承」）
  const legacyForm = JSON.parse(JSON.stringify(server));
  legacyForm.review.policy = "AUTO";
  assert.equal(dirty(baseline, legacyForm, "15"), false, "非法存量值归一为继承，不假脏");

  // 三态之二：任一改动 → 脏
  for (const p of REVIEW_POLICIES) {
    const changed = JSON.parse(JSON.stringify(server));
    changed.review.policy = p;
    assert.equal(dirty(baseline, changed, "15"), true, `继承 → ${p} 算脏`);
  }
  const switched = JSON.parse(JSON.stringify(server));
  switched.review.policy = "auto";
  const baselineAuto = norm(switched, "15");
  assert.equal(dirty(baselineAuto, switched, "15"), false, "auto 基线自洽不脏");
  assert.equal(dirty(baselineAuto, server, "15"), true, "auto → 继承 算脏");

  // 三态之三：保存后复原（服务端回填最新配置后归位基线）
  const savedServer = JSON.parse(JSON.stringify(server));
  savedServer.review.policy = "none";
  const restored = norm(savedServer, "15");
  assert.equal(dirty(restored, savedServer, "15"), false, "保存后复原不脏");
  // 复原后再改回去仍然算脏（基线确实前移，不是恒 false）
  const backToInherit = JSON.parse(JSON.stringify(savedServer));
  backToInherit.review.policy = null;
  assert.equal(dirty(restored, backToInherit, "15"), true, "保存后基线已前移，再改算脏");
});

test("g-342 判据2：下拉显示值与归一化同源——不出现「显示继承但被判脏」的错位", () => {
  const { zh } = loadClientI18n();
  const { norm, dirty } = loadNormSection(readModal());
  for (const policy of [...REVIEW_POLICIES, null, "", "AUTO", "fast"]) {
    const snapshot = { executor: {}, defaults: {}, supervisor: {}, prompt_overrides: {}, review: { policy } };
    const { select } = reviewPolicyOptions(renderSettingsModal(readModal(), snapshot, zh), zh);
    const baseline = norm(snapshot, "15");
    // 表单值 = 下拉选中值；若两者归一化口径不同，这里会立刻暴露
    const form = JSON.parse(JSON.stringify(snapshot));
    form.review.policy = select.props.value;
    assert.equal(dirty(baseline, form, "15"), false, `快照 ${JSON.stringify(policy)}：下拉选中值 ${JSON.stringify(select.props.value)} 不脏`);
  }
});

// =====================================================================================
// 判据 3：既有通道 / 原子写 / 非法值拒绝且文件逐字节不变 / 工具计数 44
// =====================================================================================

test("g-342 判据3：非法值被 schema 拒绝且文件逐字节不变、零事件", async () => {
  const { root, routes } = setupInstance();
  writeFileSync(join(root, "project.yaml"), CONFIG_WITH_COMMENTS, "utf8");
  const before = readFileSync(join(root, "project.yaml"), "utf8");
  const beforeEvents = readEvents(root).length;

  const illegal: Array<[string, unknown]> = [
    ["客户端若误发空串", { review: { policy: "" } }],
    ["未知取值", { review: { policy: "fast" } }],
    ["大小写不符", { review: { policy: "AUTO" } }],
    ["类型不符", { review: { policy: 123 } }],
    ["布尔", { review: { policy: true } }],
    ["review 内未知字段", { review: { policie: "auto" } }],
    ["review 非对象", { review: "auto" }],
  ];
  for (const [label, body] of illegal) {
    const r = await postSettings(routes, body);
    assert.equal(r.code, 400, `${label} 必须被拒绝（实际 ${r.code}）`);
    assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), before, `${label}：文件必须逐字节不变`);
  }
  assert.equal(readEvents(root).length, beforeEvents, "非法值被拒后不得追加事件");
  assert.equal(readProjectConfig(root).review.policy, "strict", "既有合法值不受影响");
});

test("g-342 判据3：core 层直调同样拒绝非法值（schema 不是唯一防线）", async () => {
  const { root } = setupInstance();
  const { writeProjectConfig } = await import("../ops.ts");
  writeFileSync(join(root, "project.yaml"), CONFIG_WITH_COMMENTS, "utf8");
  const before = readFileSync(join(root, "project.yaml"), "utf8");
  for (const bad of ["", "fast", "AUTO"]) {
    assert.throws(
      () => writeProjectConfig(root, { review: { policy: bad } } as any, "human:gui"),
      (e: unknown) => e instanceof GraphError && /review\.policy/.test(String((e as Error).message)),
      `core 直调 ${JSON.stringify(bad)} 必须被拒`,
    );
  }
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), before, "拒绝后文件逐字节不变");
});

test("g-342 判据3：不新增 graph_* 工具（注册计数仍 44），且工具 hints 与控件口径一致", () => {
  const { toolNames } = setupInstance();
  const graphTools = toolNames.filter((n) => n.startsWith("graph_"));
  assert.equal(graphTools.length, 44, "graph_* 工具计数仍为 44");
  assert.equal(new Set(graphTools).size, 44, "无重名工具");
  // graph_get_settings 的 value hints 与新控件同一口径（三值 + 未配置为 null）
  const indexSrc = readFileSync(join(repoRoot, "dsh-graph-host/index.js"), "utf8");
  const start = indexSrc.indexOf('"review.policy": {');
  assert.ok(start > 0, "graph_get_settings 下发 review.policy hints");
  assert.match(indexSrc.slice(start, start + 160), /values: \[\.\.\.REVIEW_POLICIES\]/, "hints 取自 core 真源而非第二份副本");
});

test("g-342 判据3：策略判定真源未被削弱（三值与门禁清单不变）", async () => {
  const rp = await import("../review-policy.ts");
  assert.deepEqual([...rp.REVIEW_POLICIES], ["auto", "strict", "none"]);
  assert.deepEqual([...rp.FAST_TRACK_CHECKS], ["tests", "typecheck", "diff_size", "criteria_verified"]);
  assert.deepEqual([...rp.CONTRACT_PATHS], ["core/schema.ts", "schema/SCHEMA.md"]);
  // 契约路径命中仍强制 strict（mutation 防护：本目标只加客户端入口，不动判定）
  assert.equal(rp.resolveReviewPolicy({ policy: "none", type: "patch", changedPaths: ["core/schema.ts"] }).policy, "strict");
  assert.equal(rp.resolveReviewPolicy({ policy: "none", type: "feature" }).policy, "none");
});

// =====================================================================================
// 判据 4：i18n 对称 / en 零 CJK / dist 语法与产物同步
// =====================================================================================

test("g-342 判据4：客户端 i18n 新增键两语齐全、键集对称、en 侧零 CJK", () => {
  const { zh, en } = loadClientI18n();
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "zh/en 键集完全对称");
  for (const key of REVIEW_POLICY_I18N_KEYS) {
    assert.ok(zh[key], `zh 缺少 ${key}`);
    assert.ok(en[key], `en 缺少 ${key}`);
    assert.doesNotMatch(en[key], /[\u3400-\u9fff]/, `en.${key} 含 CJK：${en[key]}`);
  }
  assert.equal(zh["settings.reviewPolicyInherit"], "继承（未配置，按目标类型派生）");
});

test("g-342 判据4：node --check dist/lib/client.js 通过，且 bundle 已同步新控件（未 rebuild 即红）", () => {
  const bundlePath = join(distRoot, "lib/client.js");
  execFileSync(process.execPath, ["--check", bundlePath], { stdio: "pipe" });
  const bundle = readFileSync(bundlePath, "utf8");
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "保留 GENERATED header");
  for (const needle of ['REVIEW_POLICY_VALUES', 'dgT("settings.reviewPolicyLabel")', 'normalizeReviewPolicyDraft', 'review: { policy:']) {
    assert.ok(bundle.includes(needle), `bundle 缺少 ${needle}（源改完必须 bash scripts/build.sh）`);
  }
  assert.match(bundle, /"auto", "strict", "none"/, "bundle 内含客户端三值副本");
});

// =====================================================================================
// 「改坏即红」负向对照（hermetic：只改内存中的副本字符串，绝不触碰真实文件）
// =====================================================================================

test("g-342 负向对照：副本漂移 / 选项缺失 / 提交体回流空串 / en 混入 CJK 均必红且真实文件未变", async () => {
  const modalReal = readModal();
  const i18nReal = readI18n();
  const { zh, en } = loadClientI18n(i18nReal);

  // 基线：真实源码满足全部检查
  assert.deepEqual([...loadNormSection(modalReal).values], [...REVIEW_POLICIES], "基线不变量");

  // 改坏 1：客户端副本漂移（none → fast）
  const drift = modalReal.replace('const REVIEW_POLICY_VALUES = ["auto", "strict", "none"];', 'const REVIEW_POLICY_VALUES = ["auto", "strict", "fast"];');
  assert.notEqual(drift, modalReal, "变更确实生效");
  const driftValues = [...loadNormSection(drift).values];
  assert.notDeepEqual(driftValues.sort(), [...REVIEW_POLICIES].sort(), "副本漂移后一致性断言必红");
  assert.equal(loadNormSection(drift).normalizePolicy("none"), "", "漂移副本不再认得 none");

  // 改坏 2：继承提交体回流空串（去掉 null 映射）→ 服务端必须拒绝，证明该映射不可省
  const badPatch = modalReal.replace(
    'review: { policy: reviewPolicy === "" ? null : reviewPolicy },',
    "review: { policy: reviewPolicy },",
  );
  assert.notEqual(badPatch, modalReal, "变更确实生效");
  const badBody = await runClientSave(badPatch, { defaults: { pk: { lanes: 1 } }, review: { policy: "" } }, zh);
  assert.equal(badBody.review.policy, "", "改坏后提交体退化为空串（正是 schema 拒绝的形态）");
  const { root, routes } = setupInstance();
  writeFileSync(join(root, "project.yaml"), CONFIG_WITH_COMMENTS, "utf8");
  const before = readFileSync(join(root, "project.yaml"), "utf8");
  const rejected = await postSettings(routes, { review: { policy: "" } });
  assert.equal(rejected.code, 400, "空串被 schema 拒绝 → 等价于保存失败");
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), before, "被拒时文件逐字节不变");

  // 改坏 3：删掉「继承」选项 → 渲染检查必红
  const noInherit = modalReal.replace('h("option", { value: "", style: policyOptionStyle }, dgT("settings.reviewPolicyInherit")),', "");
  assert.notEqual(noInherit, modalReal, "变更确实生效");
  const opts = reviewPolicyOptions(renderSettingsModal(noInherit, { review: { policy: null } }, zh), zh).options;
  assert.deepEqual(opts.map((o) => o.value), [...REVIEW_POLICIES], "删掉继承项后只剩三值（四态断言必红）");

  // 改坏 4：en 文案混入 CJK
  const badI18n = i18nReal.replace("'settings.reviewPolicyNone': 'none (no review: decision recorded only, delivery not blocked)'", "'settings.reviewPolicyNone': 'none（不评审）'");
  assert.notEqual(badI18n, i18nReal, "变更确实生效");
  const badEn = loadClientI18n(badI18n).en;
  assert.match(badEn["settings.reviewPolicyNone"], /[\u3400-\u9fff]/, "改坏后 en 侧 CJK 检查必红");

  // hermetic：真实文件逐字未变
  assert.equal(readModal(), modalReal, "负向对照污染了真实 settings-modal.js");
  assert.equal(readI18n(), i18nReal, "负向对照污染了真实 i18n.js");
});
