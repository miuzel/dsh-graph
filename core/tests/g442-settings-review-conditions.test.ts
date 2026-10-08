/**
 * g-442 判据机器断言：设置 UI 让 review 三项评审条件（regions / contract_paths /
 * non_product_prefixes）**可见且可编辑**，并配套稀疏 patch、保存前校验、畸形可视化与 i18n。
 *
 * 覆盖当前 attempt 的 7 条验收项：
 *  1. UI 可见三组配置的生效值与来源（缺省普适 vs 显式配置）
 *  2. 编辑保存往返：经设置面落盘后 graph_get_settings 读回同值，且 resolveReviewPolicy 立即采用
 *  3. 非法条目（空串/绝对路径/含../重复/尾随斜杠）保存前被拒并可读提示；负向：直接提交非法值不落盘、零副作用
 *  4. 保存后 YAML 注释与未知键保留、review 段以外**字节级**不变
 *  5. regions[] 显示错误并阻止提交；contract_paths[]/non_product_prefixes[] 合法且显示「显式空」，可恢复未配置(null)
 *  6. 畸形配置：invalid_fields 显示「非法/需修 project.yaml」，不作为可编辑条目回填；不含 review 段的编辑不被连带阻断
 *  7. zh/en 双语齐全、既有设置文案守卫不弱化；完整门禁 + tsc
 *
 * 断言方式：真实组件渲染（vm 里跑 `settings-modal.js` 的真实源码）+ 真实注册路由 POST
 * （`apply(ctx)` 起的 `/api/dsh-graph/settings`）与真实 `graph_get_settings` 工具，
 * 不用源码字符串匹配替代行为断言。
 *
 * 末节为 hermetic 负向对照（改坏内存副本即红，真实文件逐字未变）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";

import {
  init,
  readProjectConfig,
  writeProjectConfig,
  GraphError,
  REVIEW_LIST_FIELDS,
  reviewEffectiveProjection,
} from "../ops.ts";
import { resolveReviewPolicy, DEFAULT_REVIEW_REGIONS } from "../review-policy.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const clientDir = join(repoRoot, "dsh-graph-host/lib/client");
const distRoot = join(repoRoot, "dist");
const modalPath = join(clientDir, "settings-modal.js");
const i18nPath = join(clientDir, "i18n.js");

const readModal = (): string => readFileSync(modalPath, "utf8");
const readI18n = (): string => readFileSync(i18nPath, "utf8");

/** vm 沙箱里构造的对象/数组与测试 realm 的 prototype 不同：断言前先 JSON 往返为本地普通值。 */
const plain = (x: any): any => JSON.parse(JSON.stringify(x));

const NORM_START = "function normalizeSettingsDraft(";
const MODAL_START = "function SettingsModal(";
const REVIEW_LIST_KEYS = ["regions", "contract_paths", "non_product_prefixes"] as const;

type Dict = Record<string, string>;

/** g-442 新增的客户端可见键（双语齐全 + en 零 CJK 的断言范围）。 */
const G442_I18N_KEYS = [
  "settings.reviewConditions",
  "settings.reviewConditionsHint",
  "settings.reviewCalibrationGuide",
  "settings.reviewSourceLabel",
  "settings.reviewSourceExplicit",
  "settings.reviewSourceDefault",
  "settings.reviewSourceMalformed",
  "settings.reviewEffectiveLabel",
  "settings.reviewEffectiveEmpty",
  "settings.reviewUnsetHint",
  "settings.reviewMakeExplicit",
  "settings.reviewMakeExplicitTitle",
  "settings.reviewResetUnset",
  "settings.reviewResetUnsetTitle",
  "settings.reviewClear",
  "settings.reviewClearTitle",
  "settings.reviewExplicitEmpty",
  "settings.reviewItemsPlaceholder",
  "settings.reviewRegionsLabel",
  "settings.reviewRegionsAria",
  "settings.reviewRegionsHint",
  "settings.reviewContractPathsLabel",
  "settings.reviewContractPathsAria",
  "settings.reviewContractPathsHint",
  "settings.reviewNonProductPrefixesLabel",
  "settings.reviewNonProductPrefixesAria",
  "settings.reviewNonProductPrefixesHint",
  "settings.reviewEmptyForbidden",
  "settings.reviewMalformedField",
  "settings.reviewConfigMalformed",
  "settings.reviewSuggestedRegions",
  "settings.reviewInvalidEmpty",
  "settings.reviewInvalidReserved",
  "settings.reviewInvalidAbsolute",
  "settings.reviewInvalidTrailingSlash",
  "settings.reviewInvalidDotDot",
  "settings.reviewInvalidDuplicate",
];

function loadClientI18n(src = readI18n()): { zh: Dict; en: Dict } {
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${src}\n;this.zh = zh; this.en = en;`, sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

/** 在 vm 里求值「归一化段…SettingsModal」之间的**真实源码**，暴露 g-442 关心的函数（缺名即抛错 ⇒ 改坏即红）。 */
const HELPER_NAMES = [
  "normalizeSettingsDraft",
  "settingsDraftIsDirty",
  "normalizePromptOverrideDraft",
  "buildSettingsPatch",
  "settingsPatchIsEmpty",
  "collectReviewListErrors",
  "validateReviewListItems",
  "normalizeReviewListDraft",
  "isReviewFieldMalformed",
  "reviewListEffective",
];

function loadClientHelpers(modalSrc: string): any {
  const start = modalSrc.indexOf(NORM_START);
  const end = modalSrc.indexOf(MODAL_START, start);
  assert.ok(start > 0 && end > start, "settings-modal.js 含「归一化段…SettingsModal」");
  const sandbox: any = {};
  vm.runInNewContext(
    `(function () {\n${modalSrc.slice(start, end)}\n` +
      `globalThis.__h = { ${HELPER_NAMES.map((n) => `${n}: ${n}`).join(", ")}, REVIEW_LIST_KEYS: REVIEW_LIST_KEYS };\n})()`,
    sandbox,
  );
  return sandbox.__h;
}

const h = (type: any, props: any, ...children: any[]) => ({
  type,
  props: props || {},
  children: children.flat(Infinity).filter((c: any) => c !== null && c !== undefined && c !== false),
});

function walk(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}
function collectText(tree: any): string {
  const out: string[] = [];
  const rec = (n: any): void => {
    if (typeof n === "string") { out.push(n); return; }
    if (typeof n === "number") { out.push(String(n)); return; }
    if (!n || typeof n !== "object") return;
    for (const c of n.children ?? []) rec(c);
  };
  rec(tree);
  return out.join(" | ");
}
function nodesOfType(tree: any, type: string): any[] {
  const out: any[] = [];
  walk(tree, (n) => { if (n.type === type) out.push(n); });
  return out;
}
function textareaByAria(tree: any, aria: string): any {
  const found = nodesOfType(tree, "textarea").find((t) => t.props?.["aria-label"] === aria) ?? null;
  assert.ok(found, `渲染树中存在 textarea[aria-label=${aria}]`);
  return found;
}
const REVIEW_ARIA_KEYS = ["settings.reviewRegionsAria", "settings.reviewContractPathsAria", "settings.reviewNonProductPrefixesAria"];

/** 只统计 review 三组的编辑框（避免把 prompt_overrides 的 textarea 算进来）。 */
function reviewTextareas(tree: any, zh: Dict): any[] {
  const arias = REVIEW_ARIA_KEYS.map((k) => zh[k]);
  return nodesOfType(tree, "textarea").filter((t) => arias.includes(t.props?.["aria-label"]));
}
const badge = (zh: Dict, kind: "Explicit" | "Default" | "Malformed") =>
  zh["settings.reviewSourceLabel"] + "：" + zh[`settings.reviewSource${kind}`];

function buttonByText(tree: any, text: string): any {
  const found = nodesOfType(tree, "button").find((b) => (b.children ?? []).join("") === text) ?? null;
  assert.ok(found, `渲染树中存在按钮「${text}」`);
  return found;
}

/** 真实渲染 SettingsModal（form 已加载态）；hook 序：loading, form, saving, note, error,
 *  showAdvanced, configFile, refreshIntervalInput, intervalWarn, catalog, suggestedRegions。 */
function renderSettingsModal(modalSrc: string, snapshot: any, zh: Dict, opts: { suggestedRegions?: string[] | null } = {}) {
  const overrides: any[] = [false, snapshot];
  overrides[10] = opts.suggestedRegions ?? null;
  let idx = 0;
  const sandbox: any = {
    console,
    h,
    dgOverlay: (props: any, ...children: any[]) => h("div", props, ...children),
    settingsModalModeInstanceSeq: 0,
    dgT: (k: string, params?: any) => {
      let t = zh[k] ?? k;
      if (params) t = t.replace(/\{(\w+)\}/g, (_: string, key: string) => (params[key] !== undefined ? String(params[key]) : "{" + key + "}"));
      return t;
    },
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
        const v = i < overrides.length && overrides[i] !== undefined ? overrides[i] : (typeof init === "function" ? init() : init);
        return [v, () => {}];
      },
      useEffect: () => {},
    },
  };
  const start = modalSrc.indexOf(MODAL_START);
  assert.ok(start > 0, "settings-modal.js 缺少 SettingsModal");
  const normStart = modalSrc.indexOf(NORM_START);
  assert.ok(normStart > 0 && normStart < start, "settings-modal.js 缺少 normalizeSettingsDraft");
  vm.runInNewContext(
    `${modalSrc.slice(normStart, start)}\n${modalSrc.slice(start)}\n;this.__SettingsModal = SettingsModal;`,
    sandbox,
  );
  return sandbox.__SettingsModal({ onClose: () => {}, onSaved: () => {} });
}

/** 运行 settings-modal.js 的**真实 save()**，返回 POST 载荷与副作用观测。 */
async function runClientSave(
  modalSrc: string,
  form: any,
  baselineForm: any,
  zh: Dict,
  opts: { refreshIntervalInput?: string; initialInterval?: number; fetchError?: Error; invalidFields?: any; effective?: any } = {},
) {
  const helpers = readFileSync(join(clientDir, "helpers.js"), "utf8");
  const helperSrc = helpers.slice(helpers.indexOf("const REFRESH_INTERVAL_KEY"), helpers.indexOf("const LIVE_DISPLAY_KEY"));
  const normSrc = modalSrc.slice(modalSrc.indexOf(NORM_START), modalSrc.indexOf(MODAL_START));
  const saveStart = modalSrc.indexOf("const save = async () => {");
  const saveEnd = modalSrc.indexOf("if (loading)", saveStart);
  assert.ok(saveStart > 0 && saveEnd > saveStart, "settings-modal.js 含完整 save 函数段");
  const saveSrc = modalSrc.slice(saveStart, saveEnd);
  const closeStart = modalSrc.indexOf("const requestClose = () => {");
  const reqCloseSrc = modalSrc.slice(closeStart, modalSrc.indexOf("const handleIntervalChange", closeStart));

  const store = new Map<string, string>([["dsh-graph.refresh-interval", String(opts.initialInterval ?? 15)]]);
  const calls: any = { setNote: [], setError: [], setSaving: [], fetch: [], onClose: 0, onSaved: 0, setForm: [] };
  const sandbox: any = {
    console,
    dgT: (k: string, params?: any) => {
      let t = zh[k] ?? k;
      if (params) t = t.replace(/\{(\w+)\}/g, (_: string, key: string) => (params[key] !== undefined ? String(params[key]) : "{" + key + "}"));
      return t;
    },
    graphUrl: (u: string) => u,
    window: { confirm: () => true, dispatchEvent: () => {} },
    CustomEvent: class { type: string; init: any; constructor(type: string, init: any) { this.type = type; this.init = init; } },
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: any) => { store.set(k, String(v)); } },
    fetch: async (url: string, o: any) => {
      calls.fetch.push({ url, opts: o });
      if (opts.fetchError) throw opts.fetchError;
      return { ok: true, status: 200, json: async () => ({ config: JSON.parse(o.body) }) };
    },
    props: { onSaved: () => { calls.onSaved++; }, onClose: () => { calls.onClose++; } },
    suggestedRegions: null,
    setSuggestedRegions: () => {},
    setSaving: (v: any) => calls.setSaving.push(v),
    setNote: (v: any) => calls.setNote.push(v),
    setError: (v: any) => calls.setError.push(v),
    setRefreshIntervalInput: () => {},
    setIntervalWarn: () => {},
    setForm: (v: any) => calls.setForm.push(v),
  };
  vm.runInNewContext(
    `${helperSrc}\n${normSrc}\nlet form = ${JSON.stringify(form)};\nlet saving = false;\n` +
      `let refreshIntervalInput = ${JSON.stringify(opts.refreshIntervalInput ?? "15")};\n` +
      `let baselineRef = { current: normalizeSettingsDraft(${JSON.stringify(baselineForm)}, String(getRefreshInterval())) };\n` +
      `${reqCloseSrc}\n${saveSrc}\n;this.__save = save;`,
    sandbox,
  );
  await sandbox.__save();
  return {
    fetchCalls: calls.fetch,
    body: calls.fetch.length > 0 ? JSON.parse(calls.fetch[0].opts.body) : null,
    notes: calls.setNote,
    onClose: calls.onClose,
    onSaved: calls.onSaved,
    store,
  };
}

// ---------------------------------------------------------------------------
// 隔离实例 + 真实工具/路由（绝对 config.root ⇒ 绝不触达主工作区看板）
// ---------------------------------------------------------------------------
function setupInstance(rootOverride?: string) {
  const root = rootOverride ?? mkdtempSync(join(tmpdir(), "dsh-graph-g442-"));
  init(root);
  const routes = new Map<string, any>();
  const registered: any[] = [];
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (d: any) => { registered.push(d); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, { root });
  const byName = new Map(registered.map((d: any) => [d.name, d]));
  return { root, routes, byName };
}

/** 私有 workspace 布局夹具：graph 根为 `<base>/ws/.dsh-graph` ⇒ 只读目录建议应指向 `<base>/ws`。 */
function setupNestedInstance() {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-g442-ws-"));
  const ws = join(base, "ws");
  for (const name of ["core", "docs", "dsh-graph-host", "node_modules", "dist", "tmp", ".git"]) {
    mkdirSync(join(ws, name), { recursive: true });
  }
  writeFileSync(join(ws, "README.md"), "not a directory\n", "utf8");
  const root = join(ws, ".dsh-graph");
  return { base, ws, ...setupInstance(root) };
}

function fakeResponse() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}
async function request(routes: Map<string, any>, method: string, body?: unknown) {
  const handler = routes.get("/api/dsh-graph/settings");
  assert.ok(handler, "settings 路由已注册");
  const req: any = { method, url: "/api/dsh-graph/settings", _l: {} as Record<string, (v?: any) => void>, on(ev: string, cb: (v?: any) => void) { req._l[ev] = cb; } };
  const res = fakeResponse();
  const p = handler(req, res);
  if (body !== undefined) req._l.data?.(JSON.stringify(body));
  req._l.end?.();
  await p;
  return { code: res._code, body: res._body };
}
const postSettings = (routes: Map<string, any>, body: unknown) => request(routes, "POST", body);
const getSettings = (routes: Map<string, any>) => request(routes, "GET");

async function callTool(byName: Map<string, any>, name: string, args: Record<string, unknown> = {}) {
  const def = byName.get(name);
  assert.ok(def, `工具 ${name} 已注册`);
  return def.execute(args, { agent: undefined, signal: new AbortController().signal });
}

/** 一份「引号 / 特殊空格 / 未知键 / 注释 / 空行」齐备的 project.yaml 夹具（字节级保真的载体）。 */
const RICH_YAML = [
  "# 顶层注释：必须逐字节保留",
  "name: rich-fixture",
  "unknown_top: keep-me # 未知顶层键",
  "",
  "executor:",
  "  provider: \"openai-codex\"   # 行尾注释须保留",
  "  model: 'gpt-5   spaced'",
  "",
  "defaults:",
  "  pk:",
  "    lanes: 2",
  "    sandbox: \"  padded  \"",
  "",
  "supervisor:",
  "  automation:",
  "    release: human",
  "",
  "prompt_overrides:",
  "  subagent: \"多行\\n文本\"",
  "",
  "review:",
  "  policy: auto   # 策略注释须保留",
  "  unknown_sub: keep-me-too # review 内未知键",
  "",
].join("\n");

/** 服务端读回快照的形状（与 GET/POST 下发一致）——供客户端 patch/草稿链路使用。 */
function snapshotOf(root: string) {
  return readProjectConfig(root);
}

// =====================================================================================
// 验收 1：UI 可见三组配置的生效值与来源（缺省普适 vs 显式配置）
// =====================================================================================

test("g-442 验收1：未配置时三组均展示「缺省（普适）」生效值，且不进入可写草稿", () => {
  const { root } = setupInstance();
  writeFileSync(join(root, "project.yaml"), RICH_YAML, "utf8");
  const { zh } = loadClientI18n();
  const snapshot = snapshotOf(root);
  const tree = renderSettingsModal(readModal(), snapshot, zh, { suggestedRegions: ["core", "docs", "scripts"] });
  const text = collectText(tree);

  assert.ok(text.includes(zh["settings.reviewConditions"]), "渲染出「评审条件」区块标题");
  for (const key of REVIEW_LIST_KEYS) {
    const label = zh[`settings.review${key === "regions" ? "Regions" : key === "contract_paths" ? "ContractPaths" : "NonProductPrefixes"}Label`];
    assert.ok(text.includes(label), `渲染出 ${key} 的标签`);
  }
  // 三组来源标注全为「缺省（普适）」（用完整徽标串计数：提示文案里也含该词）
  const occurrences = text.split(badge(zh, "Default")).length - 1;
  assert.equal(occurrences, 3, `三组来源标注均为「缺省（普适）」（实际 ${occurrences}）`);
  assert.equal(text.includes(badge(zh, "Explicit")), false, "未配置时不得出现「显式配置」标注");

  // 生效值来自服务端投影（core 同源），不是客户端自备副本
  const eff = snapshot.review.effective;
  assert.deepEqual([...eff.regions.value], [...DEFAULT_REVIEW_REGIONS], "regions 生效值为 core 普适缺省");
  assert.ok(text.includes(eff.regions.value.join(", ")), "regions 生效值逐条可见");
  assert.ok(text.includes(eff.non_product_prefixes.value.join(", ")), "non_product_prefixes 生效值逐条可见");
  assert.ok(text.includes(zh["settings.reviewEffectiveEmpty"]), "contract_paths 未配置且缺省为空 ⇒ 显示（空）");

  // 未配置 ⇒ 只读文本 + 「改为显式配置」，**没有**可编辑 textarea（缺省值绝不物化为显式配置）
  assert.equal(reviewTextareas(tree, zh).length, 0, "未配置态无可编辑 textarea（缺省值不写进可写草稿）");
  assert.ok(nodesOfType(tree, "textarea").length > 0, "对照组：夹具里 prompt_overrides 的编辑框确实存在（scoping 有效）");
  buttonByText(tree, zh["settings.reviewMakeExplicit"]);
  assert.ok(text.includes(zh["settings.reviewUnsetHint"]), "标注「未写入 project.yaml」的缺省说明");
  assert.ok(text.includes(zh["settings.reviewEmptyForbidden"]), "regions 明示不允许显式空列表");

  // 只读目录建议（非自动写入）
  assert.ok(text.includes(zh["settings.reviewSuggestedRegions"] + "core, docs, scripts"), "按项目目录结构的只读建议可见");
  assert.match(zh["settings.reviewSuggestedRegions"], /只读|不会自动写入/, "建议文案明确标注只读/不自动写入");
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), RICH_YAML, "渲染/查看不产生任何写入（零副作用）");
});

test("g-442 验收1：显式值等于缺省值仍报「显式配置」，与未配置(null)严格区分", () => {
  const { root } = setupInstance();
  // 显式登记了与普适缺省完全相同的 regions
  writeFileSync(join(root, "project.yaml"), `review:\n  regions:\n${DEFAULT_REVIEW_REGIONS.map((r) => `    - ${r}`).join("\n")}\n`, "utf8");
  const { zh } = loadClientI18n();
  const snapshot = snapshotOf(root);
  assert.deepEqual(snapshot.review.regions, [...DEFAULT_REVIEW_REGIONS], "文件读回确为显式列表");
  assert.equal(snapshot.review.effective.regions.source, "explicit", "投影来源为 explicit（不是 default）");

  const tree = renderSettingsModal(readModal(), snapshot, zh);
  const text = collectText(tree);
  assert.equal(text.split(badge(zh, "Explicit")).length - 1, 1, "regions 显式来源标注出现一次");
  assert.equal(text.split(badge(zh, "Default")).length - 1, 2, "另两组仍未配置 ⇒ 缺省标注（不得混同「显式配置」）");
  const area = textareaByAria(tree, zh["settings.reviewRegionsAria"]);
  assert.equal(area.props.value, DEFAULT_REVIEW_REGIONS.join("\n"), "显式列表进入可编辑草稿");
});

test("g-442 验收1：畸形字段显示「非法/需修 project.yaml」，不作为可编辑条目回填", () => {
  const { root } = setupInstance();
  writeFileSync(join(root, "project.yaml"), "review:\n  policy: auto\n  regions: 123\n  contract_paths: [src, null]\n", "utf8");
  const { zh } = loadClientI18n();
  const snapshot = snapshotOf(root);
  assert.equal(snapshot.review.config_malformed, true);
  const tree = renderSettingsModal(readModal(), snapshot, zh);
  const text = collectText(tree);
  assert.ok(text.includes(zh["settings.reviewConfigMalformed"]), "段级 config_malformed 给出明确提示");
  const malformedCount = text.split(badge(zh, "Malformed")).length - 1;
  assert.equal(malformedCount, 2, "regions 与 contract_paths 两个畸形字段各标注一次（未命中的第三组不锁）");
  assert.equal(text.split(badge(zh, "Default")).length - 1, 1, "未被 invalid_fields 命中的字段仍按缺省展示");
  assert.ok(text.includes(String(snapshot.review.invalid_fields.regions)), "逐字段原因指向 project.yaml");
  // 畸形字段不可编辑、不回填原始值
  assert.equal(reviewTextareas(tree, zh).length, 0, "畸形态不提供任何编辑入口");
  assert.equal(text.includes(String(snapshot.review.regions)), false, "原始值不作为条目回填（只给 invalid_fields 原因与修正指引）");
  assert.match(String(snapshot.review.invalid_fields.regions), /请修正 project\.yaml/, "原因文案给出「需修 project.yaml」的可读指引");
});

// =====================================================================================
// 验收 2：编辑保存往返（真实 UI patch → 真实路由 → 工具读回 → 策略层立即采用）
// =====================================================================================

test("g-442 验收2：UI 草稿 → 稀疏 patch → 真实 POST → graph_get_settings 读回同值 + resolveReviewPolicy 立即采用", async () => {
  const { root, routes, byName } = setupInstance();
  writeFileSync(join(root, "project.yaml"), RICH_YAML, "utf8");
  const { zh } = loadClientI18n();
  const helpers = loadClientHelpers(readModal());
  const baseline = snapshotOf(root);

  // 模拟用户：点「改为显式配置」→ 编辑 textarea → 再加一条
  const tree = renderSettingsModal(readModal(), baseline, zh);
  const draft = JSON.parse(JSON.stringify(baseline));
  buttonByText(tree, zh["settings.reviewMakeExplicit"]).props.onClick(); // 真实按钮存在（点击在 React 外部，草稿在此显式构造）
  draft.review.regions = [...baseline.review.effective.regions.value];
  draft.review.contract_paths = ["core/schema.ts"];
  draft.review.non_product_prefixes = ["docs", "test-fixtures"];

  const patch = helpers.buildSettingsPatch(draft, baseline);
  assert.deepEqual([...Object.keys(patch)], ["review"], "只改 review ⇒ 载荷只含 review 段");
  assert.deepEqual([...Object.keys(patch.review)].sort(), ["contract_paths", "non_product_prefixes", "regions"], "只含变化的三组叶子");

  const posted = await postSettings(routes, patch);
  assert.equal(posted.code, 200, `真实路由接受该 patch：${JSON.stringify(posted.body)}`);

  // graph_get_settings 读回同值（工具面与 HTTP 面同源）
  const tool: any = await callTool(byName, "graph_get_settings");
  assert.deepEqual(tool.config.review.regions, [...DEFAULT_REVIEW_REGIONS]);
  assert.deepEqual(tool.config.review.contract_paths, ["core/schema.ts"]);
  assert.deepEqual(tool.config.review.non_product_prefixes, ["docs", "test-fixtures"]);
  assert.equal(tool.config.review.effective.regions.source, "explicit");
  assert.equal(tool.config.review.effective.contract_paths.source, "explicit");
  assert.deepEqual(tool.schema_hints["review.lists"].regions.allow_empty, false, "约束随工具同源下发");

  // resolveReviewPolicy 立即采用该配置
  const hit = resolveReviewPolicy({
    policy: tool.config.review.policy,
    type: "patch",
    changedPaths: ["core/schema.ts"],
    contractPaths: tool.config.review.contract_paths,
  });
  assert.equal(hit.policy, "strict", "未配置的 contract_paths 默认不触发 M1");
  assert.deepEqual(hit.strictReasons, ["contract_change"], "登记后立即按项目配置触发 M1");

  const knownRegion = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    changedPaths: ["src/a.ts"],
    regions: tool.config.review.regions,
  });
  assert.equal(knownRegion.strictReasons.includes("unknown_region"), false, "显式登记的区域即刻生效（src 已登记）");
  const unknownRegion = resolveReviewPolicy({
    policy: "auto",
    type: "patch",
    changedPaths: ["dsh-graph-host/index.js"],
    regions: tool.config.review.regions,
  });
  assert.equal(
    unknownRegion.strictReasons.includes("unknown_region"),
    true,
    "未登记区域仍 fail-closed（证明用的是项目配置，而不是已废弃的旧闭集 REVIEW_REGIONS）",
  );
});

// =====================================================================================
// 验收 3：保存前校验（客户端） + 负向（API 直接提交非法值不落盘、零副作用）
// =====================================================================================

test("g-442 验收3：非法条目在保存前被拒并可读提示（真实 save()，不发起 POST、零副作用）", async () => {
  const { root } = setupInstance();
  writeFileSync(join(root, "project.yaml"), RICH_YAML, "utf8");
  const { zh } = loadClientI18n();
  const baseline = snapshotOf(root);
  const before = readFileSync(join(root, "project.yaml"), "utf8");
  const eventsBefore = readEvents(root).length;

  const cases: Array<[string, string[]]> = [
    ["空串", ["", "valid"]],
    ["绝对路径", ["/abs/path"]],
    ["Windows 盘符绝对路径", ["C:\\Users\\source"]],
    ["含 ..", ["a/../b"]],
    ["重复", ["dup", "dup"]],
    ["归一后重复", ["./dup", "dup"]],
    ["尾随斜杠", ["trail/slash/"]],
    ["内部保留前缀", ["invalid:1"]],
  ];
  for (const [label, regions] of cases) {
    const draft = JSON.parse(JSON.stringify(baseline));
    draft.review.regions = regions;
    const r = await runClientSave(readModal(), draft, baseline, zh);
    assert.equal(r.fetchCalls.length, 0, `${label}：保存前被拒，绝不发起 POST`);
    assert.equal(r.onClose, 0, `${label}：弹窗不关闭（草稿保留）`);
    const msg = r.notes.map((n: any) => n?.text ?? "").join(" | ");
    assert.ok(r.notes.some((n: any) => n?.kind === "err"), `${label}：给出 err 提示`);
    assert.ok(msg.includes(zh["settings.reviewRegionsLabel"]), `${label}：提示包含字段名（可读）`);
  }
  // 逐条错误文案（真实 save 的提示里能看到具体原因）
  const dupDraft = JSON.parse(JSON.stringify(baseline));
  dupDraft.review.regions = ["dup", "dup"];
  const dupRun = await runClientSave(readModal(), dupDraft, baseline, zh);
  assert.match(String(dupRun.notes.at(-1).text), /重复/, "重复条目提示可读");

  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), before, "校验失败后文件逐字节不变（零副作用）");
  assert.equal(readEvents(root).length, eventsBefore, "校验失败后零事件");
});

test("g-442 验收3（负向）：API 直接提交非法条目被拒、文件逐字节不变、零事件", async () => {
  const { root, routes } = setupInstance();
  writeFileSync(join(root, "project.yaml"), RICH_YAML, "utf8");
  const before = readFileSync(join(root, "project.yaml"), "utf8");
  const eventsBefore = readEvents(root).length;

  const illegal: Array<[string, unknown]> = [
    ["空串", { review: { regions: ["", "valid"] } }],
    ["绝对路径", { review: { regions: ["/abs"] } }],
    ["Windows 盘符", { review: { regions: ["C:\\Users\\x"] } }],
    ["含 ..", { review: { regions: ["a/../b"] } }],
    ["重复", { review: { regions: ["dup", "dup"] } }],
    ["尾随斜杠", { review: { regions: ["x/"] } }],
    ["invalid: 前缀", { review: { regions: ["invalid:1"] } }],
    ["非字符串元素", { review: { regions: [123] } }],
    ["regions 显式空列表", { review: { regions: [] } }],
    ["畸形回填（读侧元信息）", { review: { effective: {} } }],
    ["畸形回填（invalid_fields）", { review: { invalid_fields: { regions: "x" } } }],
  ];
  for (const [label, body] of illegal) {
    const r = await postSettings(routes, body);
    assert.equal(r.code, 400, `${label} 必须被拒（实际 ${r.code}）`);
    assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), before, `${label}：文件逐字节不变`);
  }
  assert.equal(readEvents(root).length, eventsBefore, "全部拒绝后零事件");
  assert.equal(readProjectConfig(root).review.regions, null, "既有配置未受影响");
});

test("g-442 验收3：客户端校验与 core 写侧**行为等价**（同一组输入两端接受/拒绝一致）", async () => {
  const { zh } = loadClientI18n();
  const helpers = loadClientHelpers(readModal());
  const cases: string[][] = [
    ["src", "lib"],
    ["lib/client"],
    [],
    ["./src"],
    [" src "],
    [""],
    [" "],
    ["/abs"],
    ["C:\\x"],
    ["a/../b"],
    [".."],
    ["x/"],
    ["dup", "dup"],
    ["./dup", "dup"],
    ["invalid:1"],
    ["a/b", "a/b/c"],
  ];
  for (const items of cases) {
    // 客户端：真实收集函数
    const snapshot: any = { review: { regions: items, effective: { regions: { value: [], source: "explicit", malformed: false, allow_empty: false } } } };
    const clientRejects = helpers.collectReviewListErrors(snapshot).length > 0;
    // core：真实写侧
    const { root } = setupInstance();
    let apiRejects = false;
    try {
      writeProjectConfig(root, { review: { regions: items } }, "t");
    } catch (e) {
      if (!(e instanceof GraphError)) throw e;
      apiRejects = true;
    }
    assert.equal(
      clientRejects,
      apiRejects,
      `两端对 ${JSON.stringify(items)} 的裁决必须一致（客户端 ${clientRejects} / core ${apiRejects}）`,
    );
  }
  void zh;
});

test("g-442 验收3：regions[] 在 UI 阻止提交、在 API 拒绝；另两组显式空列表合法且显示「显式空」", async () => {
  const { root, routes } = setupInstance();
  writeFileSync(join(root, "project.yaml"), RICH_YAML, "utf8");
  const { zh } = loadClientI18n();
  const baseline = snapshotOf(root);

  // UI：regions 清空 ⇒ 保存前被拒，不发 POST
  const regionsEmpty = JSON.parse(JSON.stringify(baseline));
  regionsEmpty.review.regions = [];
  const r1 = await runClientSave(readModal(), regionsEmpty, baseline, zh);
  assert.equal(r1.fetchCalls.length, 0, "regions=[] 保存前被拒");
  assert.match(String(r1.notes.at(-1).text), /regions 不允许显式空列表/, "可读提示指明 regions 不允许空列表");

  // UI：另两组清空 ⇒ 正常提交（显式空列表）
  const bothEmpty = JSON.parse(JSON.stringify(baseline));
  bothEmpty.review.contract_paths = [];
  bothEmpty.review.non_product_prefixes = [];
  const r2 = await runClientSave(readModal(), bothEmpty, baseline, zh);
  assert.equal(r2.fetchCalls.length, 1, "contract_paths/non_product_prefixes=[] 可以保存");
  assert.deepEqual(r2.body, { review: { contract_paths: [], non_product_prefixes: [] } }, "载荷为显式空列表（不是 null）");

  // API：接受显式空列表并读回「显式空」（与 null 区分）
  const posted = await postSettings(routes, r2.body);
  assert.equal(posted.code, 200);
  const cfg = readProjectConfig(root);
  assert.deepEqual(cfg.review.contract_paths, [], "读回显式空列表");
  assert.equal(cfg.review.effective.contract_paths.source, "explicit");
  assert.equal(cfg.review.effective.contract_paths.value.length, 0);
  const tree = renderSettingsModal(readModal(), cfg, zh);
  const text = collectText(tree);
  assert.ok(text.includes(zh["settings.reviewExplicitEmpty"]), "UI 标注「显式空列表」（不等于未配置）");

  // 恢复未配置：提交 null，读回 null + 来源回到「缺省（普适）」
  const patch = loadClientHelpers(readModal()).buildSettingsPatch({ ...cfg, review: { ...cfg.review, contract_paths: null } }, cfg);
  assert.deepEqual(plain(patch), { review: { contract_paths: null } }, "恢复未配置提交 null（不是默认数组）");
  assert.equal((await postSettings(routes, patch)).code, 200);
  const after = readProjectConfig(root);
  assert.equal(after.review.contract_paths, null, "往返后回到未配置");
  assert.equal(after.review.effective.contract_paths.source, "default");
  assert.match(readFileSync(join(root, "project.yaml"), "utf8"), /^ {2}contract_paths:\s*$/m, "字段被清空（不残留 []）");
});

// =====================================================================================
// 验收 4：稀疏 patch —— 字节级保真 + 空 patch 不 POST + 改回原值不提交
// =====================================================================================

/** 计算两段文本「最长公共前缀/后缀」之外的**连续变更窗口**（逐行）。 */
function changedWindow(before: string, after: string) {
  const b = before.split("\n");
  const a = after.split("\n");
  let p = 0;
  while (p < b.length && p < a.length && b[p] === a[p]) p++;
  let s = 0;
  while (s < b.length - p && s < a.length - p && b[b.length - 1 - s] === a[a.length - 1 - s]) s++;
  return { prefix: p, suffix: s, removed: b.slice(p, b.length - s), added: a.slice(p, a.length - s) };
}

test("g-442 验收4：只改一组 ⇒ 载荷只含该叶子；review 段以外与未改字段**字节级**不变", async () => {
  const { root, routes } = setupInstance();
  // 夹具在 review 内已有一段 regions（含注释与引号/特殊空格），以便断言「替换列表」时的保真
  const fixture = RICH_YAML.replace(
    "  unknown_sub: keep-me-too # review 内未知键",
    [
      "  regions: # regions 注释须保留",
      "    # 条目前注释须保留",
      "    - \"old-a\"",
      "    - old-b",
      "  unknown_sub: keep-me-too # review 内未知键",
    ].join("\n"),
  );
  writeFileSync(join(root, "project.yaml"), fixture, "utf8");
  const before = readFileSync(join(root, "project.yaml"), "utf8");
  const helpers = loadClientHelpers(readModal());
  const baseline = snapshotOf(root);

  const draft = JSON.parse(JSON.stringify(baseline));
  draft.review.regions = ["src", "lib/client"];
  const patch = helpers.buildSettingsPatch(draft, baseline);
  assert.deepEqual(plain(patch), { review: { regions: ["src", "lib/client"] } }, "载荷只含变化的 regions 叶子");
  // 不再携带任何未改段/未改字段
  for (const absent of ["executor", "defaults", "supervisor", "prompt_overrides"]) {
    assert.equal(absent in patch, false, `载荷不得携带未改段 ${absent}`);
  }
  assert.equal("policy" in patch.review, false, "载荷不得携带未改的 review.policy");
  assert.equal("contract_paths" in patch.review, false, "载荷不得携带未改的 contract_paths");

  assert.equal((await postSettings(routes, patch)).code, 200);
  const after = readFileSync(join(root, "project.yaml"), "utf8");
  const win = changedWindow(before, after);
  // 变更窗口只允许落在 regions 列表体（条目行 / 列表内独立注释行）
  const listBody = /^\s*(#|-\s)/;
  assert.ok(win.removed.every((l) => listBody.test(l)), `窗口内不得混入非 regions 列表行：${JSON.stringify(win.removed)}`);
  assert.ok(win.added.every((l) => listBody.test(l)), `窗口内不得混入非 regions 列表行：${JSON.stringify(win.added)}`);
  assert.deepEqual(win.removed.filter((l) => l.includes("- ")), ['    - "old-a"', "    - old-b"], "被替换的旧条目仅这两条");
  assert.deepEqual(win.added.filter((l) => l.includes("- ")), ['    - "src"', '    - "lib/client"'], "只新增新的条目行");
  assert.ok(after.includes("  regions: # regions 注释须保留"), "regions 头行及其行尾注释逐字节保留");
  assert.ok(after.includes("    # 条目前注释须保留"), "列表内独立注释不丢失（可能随条目重排）");

  // 字节级：变更窗口之外的所有行逐字节相同（引号/特殊空格/未知键/注释/空行都在窗口之外）
  const b = before.split("\n");
  const a = after.split("\n");
  for (let i = 0; i < win.prefix; i++) assert.equal(a[i], b[i], `第 ${i} 行必须逐字节不变`);
  for (let i = 1; i <= win.suffix; i++) {
    assert.equal(a[a.length - i], b[b.length - i], `倒数第 ${i} 行必须逐字节不变`);
  }
  for (const needle of [
    "# 顶层注释：必须逐字节保留",
    "unknown_top: keep-me # 未知顶层键",
    '  provider: "openai-codex"   # 行尾注释须保留',
    "  model: 'gpt-5   spaced'",
    "    sandbox: \"  padded  \"",
    "  subagent: \"多行\\n文本\"",
    "  policy: auto   # 策略注释须保留",
    "  regions: # regions 注释须保留",
    "    # 条目前注释须保留",
    "  unknown_sub: keep-me-too # review 内未知键",
  ]) {
    assert.ok(after.includes(needle), `保真：${needle}`);
  }
});

test("g-442 验收4：改回原值不提交；无任何变化 ⇒ 空 patch 且 save 不 POST", async () => {
  const { root } = setupInstance();
  writeFileSync(join(root, "project.yaml"), RICH_YAML, "utf8");
  const { zh } = loadClientI18n();
  const helpers = loadClientHelpers(readModal());
  const baseline = snapshotOf(root);

  // 改回原值 ⇒ 无差异 ⇒ 空 patch
  const flipped = JSON.parse(JSON.stringify(baseline));
  flipped.review.regions = ["src", "lib"];
  const withChange = helpers.buildSettingsPatch(flipped, baseline);
  assert.deepEqual(plain(withChange), { review: { regions: ["src", "lib"] } });
  const back = JSON.parse(JSON.stringify(baseline));
  assert.equal(helpers.settingsPatchIsEmpty(helpers.buildSettingsPatch(back, baseline)), true, "改回原值 ⇒ 空 patch");

  // 真实 save()：缺省打开、未改动 ⇒ 不 POST、零副作用、直接关闭
  const before = readFileSync(join(root, "project.yaml"), "utf8");
  const eventsBefore = readEvents(root).length;
  const r = await runClientSave(readModal(), baseline, baseline, zh, { refreshIntervalInput: "15", initialInterval: 15 });
  assert.equal(r.fetchCalls.length, 0, "空 patch 不 POST");
  assert.equal(r.onClose, 1, "无变化保存直接关闭弹窗");
  assert.equal(r.onSaved, 0, "无变化不触发 onSaved");
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), before, "零副作用（文件不变）");
  assert.equal(readEvents(root).length, eventsBefore, "零副作用（无事件）");
  assert.equal(r.store.get("dsh-graph.refresh-interval"), "15", "刷新间隔未被改写");
});

test("g-442 验收4：稀疏 patch 的假脏防护——规范化后 null/\"\" 等等价形态不产生脏叶子", () => {
  const helpers = loadClientHelpers(readModal());
  const { zh } = loadClientI18n();
  void zh;
  const server = {
    executor: { provider: "", model: "", reasoning_effort: "", mode: "" },
    defaults: { review: { reviewer: "", prompt: null }, pk: { lanes: 1, sandbox: "" } },
    supervisor: { automation: { scope_planning: null, release: "human" } },
    prompt_overrides: { subagent: { state: "default", value: null } },
    review: { policy: null, regions: null, contract_paths: null, non_product_prefixes: null },
  };
  const baseline = helpers.normalizeSettingsDraft(server, "15");
  assert.equal(helpers.settingsDraftIsDirty(baseline, server, "15"), false, "缺省打开无假脏");
  // lanes 数字↔字符串、prompt null↔""、列表 undefined↔null 都不算脏，也就不产生叶子
  const variants = JSON.parse(JSON.stringify(server));
  variants.defaults.pk.lanes = "1";
  variants.defaults.review.prompt = "";
  variants.review.regions = null;
  assert.equal(helpers.settingsDraftIsDirty(baseline, variants, "15"), false, "规范化等价形态不脏");
  assert.equal(helpers.settingsPatchIsEmpty(helpers.buildSettingsPatch(variants, baseline)), true, "等价形态不产生叶子");
});

// =====================================================================================
// 验收 6：畸形配置不连带阻断 + regions[]/空列表语义的 API 侧双拒
// =====================================================================================

test("g-442 验收6：畸形文件上「不含 review 段」的合法 patch 仍成功，畸形行原样保留", async () => {
  const { root, routes, byName } = setupInstance();
  writeFileSync(join(root, "project.yaml"), "review:\n  policy: auto\n  regions: 123\n  contract_paths: 5\nunknown: keep\n", "utf8");
  const before = readFileSync(join(root, "project.yaml"), "utf8");

  const r = await postSettings(routes, { executor: { model: "m-2" } });
  assert.equal(r.code, 200, "不含 review 段的合法 patch 必须成功（不被畸形连带阻断）");
  const after = readFileSync(join(root, "project.yaml"), "utf8");
  assert.match(after, /^ {2}regions: 123$/m, "畸形行原样保留，不被静默改写");
  assert.match(after, /^ {2}contract_paths: 5$/m, "第二个畸形行同样保留");
  assert.match(after, /unknown: keep/, "未知键保留");
  const win = changedWindow(before, after);
  assert.deepEqual(win.removed, [], "未删除任何既有行（executor 段整体新增）");
  assert.deepEqual(win.added, ["executor:", "  model: m-2"], "变更窗口只含新增的 executor.model 行");
  const bLines = before.split("\n");
  const aLines = after.split("\n");
  for (let i = 0; i < win.prefix; i++) assert.equal(aLines[i], bLines[i], `第 ${i} 行必须逐字节不变`);
  for (let i = 1; i <= win.suffix; i++) assert.equal(aLines[aLines.length - i], bLines[bLines.length - i], `倒数第 ${i} 行必须逐字节不变`);

  // 工具面同样读回畸形元信息（供 UI 显示「非法/需修 project.yaml」）
  const tool: any = await callTool(byName, "graph_get_settings");
  assert.equal(tool.config.review.config_malformed, true);
  assert.equal(tool.config.review.effective.regions.malformed, true);
  assert.equal(tool.config.review.effective.regions.source, "default", "畸形时策略层回落缺省（fail-closed 由 strict 承担）");
});

test("g-442 验收6：目录建议只读——来自真实 workspace 布局、排除隐藏/生成物、任何读取都不写入", async () => {
  const { ws, root, routes, byName } = setupNestedInstance();
  writeFileSync(join(root, "project.yaml"), RICH_YAML, "utf8");
  const before = readFileSync(join(root, "project.yaml"), "utf8");
  const eventsBefore = readEvents(root).length;

  const expected = ["core", "docs", "dsh-graph-host"];
  const tool: any = await callTool(byName, "graph_get_settings");
  assert.deepEqual([...tool.review_suggested_regions], expected, "建议 = workspace 一级目录（排除隐藏/依赖/生成物/非目录）");
  assert.equal(tool.review_suggested_regions.includes("node_modules"), false, "排除 node_modules");
  assert.equal(tool.review_suggested_regions.includes("dist"), false, "排除 dist");
  assert.equal(tool.review_suggested_regions.includes("tmp"), false, "排除 tmp");
  assert.equal(tool.review_suggested_regions.includes(".git"), false, "排除隐藏目录");
  assert.equal(tool.review_suggested_regions.includes("README.md"), false, "只取目录，不取文件");
  assert.ok(ws.endsWith("ws"), "夹具确实是嵌套 workspace 布局（只读建议取自 graph 根的父目录）");

  const get = await getSettings(routes);
  assert.equal(get.code, 200);
  assert.deepEqual([...get.body.review_suggested_regions], expected, "HTTP GET 与工具面同源下发建议");

  // 只读：查看/读取不产生任何写入（建议绝不自动落盘）
  assert.equal(readFileSync(join(root, "project.yaml"), "utf8"), before, "读取建议后 project.yaml 逐字节不变");
  assert.equal(readEvents(root).length, eventsBefore, "读取建议零事件");
  const cfg = readProjectConfig(root);
  assert.equal(cfg.review.regions, null, "建议未被自动登记为显式 regions");
  assert.equal(cfg.review.effective.regions.source, "default", "来源仍为缺省（普适）");

  // 渲染树：建议行是纯文本，不带任何可点击的写入入口
  const { zh } = loadClientI18n();
  const tree = renderSettingsModal(readModal(), { ...cfg, review_suggested_regions: tool.review_suggested_regions }, zh, {
    suggestedRegions: tool.review_suggested_regions,
  });
  const suggestion = nodesOfType(tree, "div").filter((d: any) => String((d.children ?? []).join("")).includes(zh["settings.reviewSuggestedRegions"]));
  assert.equal(suggestion.length, 1, "恰好一行只读建议");
  assert.equal(suggestion[0].props.onClick, undefined, "建议行不可点击（无 onClick ⇒ 不可能自动写入）");
  assert.equal(reviewTextareas(tree, zh).length, 0, "未配置态 regions 仍无编辑框");
});

test("g-442 验收5/6：写侧约束由 core REVIEW_LIST_FIELDS 单一真源驱动（regions 不可空，另两组可空）", () => {
  const spec = Object.fromEntries(REVIEW_LIST_FIELDS.map((f) => [f.key, f]));
  assert.equal(spec.regions.allowEmpty, false, "regions 不允许显式空列表");
  assert.equal(spec.contract_paths.allowEmpty, true);
  assert.equal(spec.non_product_prefixes.allowEmpty, true);
  assert.deepEqual([...spec.regions.defaultValues], [...DEFAULT_REVIEW_REGIONS]);
  // 投影与策略层默认值同源（绝无第二份副本）
  const proj = reviewEffectiveProjection({ regions: null, contract_paths: null, non_product_prefixes: null });
  assert.deepEqual(proj.regions.value, [...DEFAULT_REVIEW_REGIONS]);
  assert.equal(proj.regions.allow_empty, false);
  assert.equal(proj.contract_paths.source, "default");
});

// =====================================================================================
// 验收 7：i18n 双语齐全 + 既有设置文案守卫不弱化 + dist 同步
// =====================================================================================

test("g-442 验收7：新增键 zh/en 齐全、键集对称、en 零 CJK；既有 review 文案守卫不弱化", () => {
  const { zh, en } = loadClientI18n();
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), "zh/en 键集完全对称");
  for (const key of G442_I18N_KEYS) {
    assert.ok(zh[key], `zh 缺少 ${key}`);
    assert.ok(en[key], `en 缺少 ${key}`);
    assert.doesNotMatch(en[key], /[\u3400-\u9fff]/, `en.${key} 含 CJK：${en[key]}`);
  }
  // 关键语义文案（缺省/显式/显式空列表/恢复未配置/regions 不允许空列表）两语齐备
  assert.match(zh["settings.reviewSourceDefault"], /缺省（普适）/);
  assert.match(zh["settings.reviewSourceExplicit"], /显式配置/);
  assert.match(zh["settings.reviewExplicitEmpty"], /\[\]/);
  assert.match(zh["settings.reviewEmptyForbidden"], /regions/);
  assert.match(en["settings.reviewSourceDefault"], /default \(generic\)/i);
  // 既有 g-342 文案未被改写（守卫不弱化）
  assert.equal(zh["settings.reviewPolicyInherit"], "继承（未配置，按目标类型派生）");
  assert.equal(en["settings.reviewPolicyHint"].startsWith("When unset, the policy is derived"), true);
});

test("g-442 验收7：i18n 变量占位符与错误渲染自洽（{field}/{index}/{item} 全部被替换）", () => {
  const { zh } = loadClientI18n();
  for (const key of ["settings.reviewInvalidEmpty", "settings.reviewInvalidAbsolute", "settings.reviewInvalidTrailingSlash", "settings.reviewInvalidDotDot", "settings.reviewInvalidDuplicate", "settings.reviewInvalidReserved"]) {
    assert.match(zh[key], /\{field\}/, `${key} 含 {field}`);
    assert.match(zh[key], /\{index\}/, `${key} 含 {index}`);
  }
  assert.match(zh["settings.reviewEmptyForbidden"], /regions/);
});

test("g-442 验收7：与 g-435 指南「项目校准流程」口径一致（指南真源交叉核对）", () => {
  const { zh, en } = loadClientI18n();
  const guideZh = readFileSync(join(repoRoot, "dsh-graph-host/supervisor-guide.zh.md"), "utf8");
  const guideEn = readFileSync(join(repoRoot, "dsh-graph-host/supervisor-guide.en.md"), "utf8");
  // 指南真源确实存在该小节（不是 UI 自造的说法）
  assert.ok(guideZh.includes("### Review 严格度校准（项目专属）"), "zh 指南含校准小节");
  assert.ok(guideEn.includes("### Review Strictness Calibration (Project-Specific)"), "en 指南含校准小节");
  assert.ok(guideZh.includes("`graph_get_settings`") && guideZh.includes("`graph_update_settings`"), "指南给出同源工具面");
  // 指南同时指向本设置面板（g-442 反向接线：文档不是单向的「UI 指向指南」）
  assert.ok(guideZh.includes("设置面板"), "zh 指南提及设置面板可视化编辑");
  assert.ok(guideEn.includes("Settings-panel"), "en 指南提及设置面板可视化编辑");
  // UI 文案指向同一小节 + 同一工具面（口径一致，而非另立一套说法）
  assert.ok(zh["settings.reviewCalibrationGuide"].includes("Review 严格度校准（项目专属）"), "zh UI 指向指南小节标题");
  assert.ok(zh["settings.reviewCalibrationGuide"].includes("graph_get_settings"), "zh UI 给出 graph_get_settings");
  assert.ok(zh["settings.reviewCalibrationGuide"].includes("graph_update_settings"), "zh UI 给出 graph_update_settings");
  assert.ok(en["settings.reviewCalibrationGuide"].includes("Review Strictness Calibration (Project-Specific)"), "en UI 指向同一小节");
  assert.ok(en["settings.reviewCalibrationGuide"].includes("graph_get_settings"), "en UI 给出 graph_get_settings");
  // 渲染树里确实出现（真实渲染，不是仅字典里存在）
  const { root } = setupInstance();
  writeFileSync(join(root, "project.yaml"), RICH_YAML, "utf8");
  const text = collectText(renderSettingsModal(readModal(), snapshotOf(root), zh));
  assert.ok(text.includes(zh["settings.reviewCalibrationGuide"]), "渲染树含指南指向文案");
  assert.ok(text.includes(zh["settings.reviewConditionsHint"]), "「主管按项目目录结构设置」说明仍在");
  assert.match(zh["settings.reviewConditionsHint"], /主管按项目目录结构设置/, "字段说明逐字保留");
});

test("g-442 验收7：dist/lib/client.js 同步含新控件（未 rebuild 即红）且语法有效", () => {
  const bundle = readFileSync(join(distRoot, "lib/client.js"), "utf8");
  assert.ok(bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"), "保留 GENERATED header");
  for (const needle of [
    "REVIEW_LIST_KEYS",
    "buildSettingsPatch(form, baseline)",
    "settingsPatchIsEmpty",
    "collectReviewListErrors",
    "dgT(\"settings.reviewConditions\")",
    "dgT(\"settings.reviewSourceDefault\")",
    "dgT(\"settings.reviewConfigMalformed\")",
  ]) {
    assert.ok(bundle.includes(needle), `bundle 缺少 ${needle}（源改完必须 bash scripts/build.sh）`);
  }
});

// =====================================================================================
// 「改坏即红」负向对照（hermetic：只改内存副本，绝不触碰真实文件）
// =====================================================================================

test("g-442 负向对照：全表 patch 回归 / 缺省物化 / 空列表放行 / 畸形回填 / 建议自动写入 均必红且真实文件未变", async () => {
  const modalReal = readModal();
  const i18nReal = readI18n();
  const { zh } = loadClientI18n(i18nReal);
  void zh;

  const baseline = {
    executor: { provider: "", model: "", reasoning_effort: "", mode: "" },
    defaults: { review: { reviewer: "", prompt: null }, pk: { lanes: 1, sandbox: "" } },
    supervisor: { automation: { release: "human" } },
    prompt_overrides: { subagent: { state: "default", value: null } },
    review: { policy: null, regions: null, contract_paths: null, non_product_prefixes: null },
  };

  // 基线：真实源码的下述不变量成立
  const okHelpers = loadClientHelpers(modalReal);
  assert.equal(okHelpers.settingsPatchIsEmpty(okHelpers.buildSettingsPatch(baseline, baseline)), true, "基线：无变化 ⇒ 空 patch");

  // 改坏 1：buildSettingsPatch 退回全表（忽略 baseline）⇒ 空 patch 不变量必红
  const fullTable = modalReal.replace(
    "        const from = getLeafPath(base, path);\n        if (JSON.stringify(to) === JSON.stringify(from)) return;",
    "        const from = getLeafPath(base, path);\n        if (false && JSON.stringify(to) === JSON.stringify(from)) return;",
  );
  assert.notEqual(fullTable, modalReal, "变更 1 确实生效");
  const bad = loadClientHelpers(fullTable);
  assert.equal(bad.settingsPatchIsEmpty(bad.buildSettingsPatch(baseline, baseline)), false, "改坏后无变化也会产出全表 patch（必红）");

  // 改坏 2：regions 空列表放行（allowEmpty 恒 true）⇒ UI 阻止提交不变量必红
  const allow = modalReal.replace(
    "const allowEmpty = eff ? eff.allow_empty !== false : key !== \"regions\";",
    "const allowEmpty = true;",
  );
  assert.notEqual(allow, modalReal, "变更 2 确实生效");
  const allowHelpers = loadClientHelpers(allow);
  const emptyDraft: any = JSON.parse(JSON.stringify(baseline));
  emptyDraft.review.regions = [];
  emptyDraft.review.effective = { regions: { value: [], source: "explicit", malformed: false, allow_empty: false } };
  assert.equal(okHelpers.collectReviewListErrors(emptyDraft).length, 1, "基线：regions=[] 必被拒");
  assert.equal(allowHelpers.collectReviewListErrors(emptyDraft).length, 0, "改坏后 regions=[] 被放行（必红）");

  // 改坏 3：invalid_fields 归因失效 ⇒ 畸形字段被当成可编辑（回填提交必被 400）
  const noMalformed = modalReal.replace(
    "      if (hasInvalidMap) return Boolean(inv[key]) || Boolean(inv.review);",
    "      if (hasInvalidMap) return false;",
  );
  assert.notEqual(noMalformed, modalReal, "变更 3 确实生效");
  const malformedForm: any = JSON.parse(JSON.stringify(baseline));
  malformedForm.review.regions = 123;
  malformedForm.review.invalid_fields = { regions: "review.regions 取值非法", contract_paths: "review.contract_paths 取值非法" };
  assert.equal(okHelpers.isReviewFieldMalformed(malformedForm, "regions"), true, "基线：invalid_fields 命中 ⇒ 锁");
  assert.equal(okHelpers.isReviewFieldMalformed(malformedForm, "non_product_prefixes"), false, "基线：未命中字段不锁");
  assert.equal(loadClientHelpers(noMalformed).isReviewFieldMalformed(malformedForm, "regions"), false, "改坏后畸形字段被当成可编辑（必红）");
  // 防御性回退：只有段级 config_malformed、无逐字段归因 ⇒ 无法判定，保守全锁
  const blindForm: any = JSON.parse(JSON.stringify(baseline));
  blindForm.review.config_malformed = true;
  assert.equal(okHelpers.isReviewFieldMalformed(blindForm, "regions"), true, "基线：无归因时保守全锁");

  // 改坏 4：en 文案混入 CJK
  const badI18n = i18nReal.replace(
    "'settings.reviewSourceDefault': 'default (generic)'",
    "'settings.reviewSourceDefault': '缺省（普适）'",
  );
  assert.notEqual(badI18n, i18nReal, "变更 4 确实生效");
  const badEn = loadClientI18n(badI18n).en;
  assert.match(badEn["settings.reviewSourceDefault"], /[\u3400-\u9fff]/, "改坏后 en 侧 CJK 检查必红");

  // 改坏 5：目录建议被自动写入（渲染期调用 set，副作用）
  const autoWrite = modalReal.replace(
    "h(\"div\", { style: metaStyle }, dgT(\"settings.reviewSuggestedRegions\") + suggestedRegions.join(\", \"))",
    "h(\"div\", { style: metaStyle, onClick: () => set([\"review\", \"regions\"], suggestedRegions) }, dgT(\"settings.reviewSuggestedRegions\") + suggestedRegions.join(\", \"))",
  );
  assert.notEqual(autoWrite, modalReal, "变更 5 确实生效");
  assert.ok(autoWrite.includes("onClick: () => set([\"review\", \"regions\"], suggestedRegions)"), "建议变成可写入（守卫需依赖只读断言）");
  const autoTree = renderSettingsModal(autoWrite, { ...baseline, review: { ...baseline.review, effective: reviewEffectiveProjection({}) } }, loadClientI18n().zh, { suggestedRegions: ["core"] });
  const suggestion = nodesOfType(autoTree, "div").find((d: any) => String((d.children ?? []).join("")).includes(loadClientI18n().zh["settings.reviewSuggestedRegions"]));
  assert.ok(suggestion, "找到建议节点");
  assert.equal(typeof suggestion.props.onClick, "function", "改坏后建议节点带 onClick（真实源码无 onClick ⇒ 该断言在基线上为 false）");

  // hermetic：真实文件逐字未变
  assert.equal(readModal(), modalReal, "负向对照污染了真实 settings-modal.js");
  assert.equal(readI18n(), i18nReal, "负向对照污染了真实 i18n.js");
});
