/**
 * g-490 判据机器断言：设置弹窗**呈现层**四项改动的专用守卫（与 g479 / g488 / g132 / g442 的既有守卫
 * **并存**——本次只替换「与旧呈现形状绑定」的那几条，其余一条不减）。
 *
 *  1. `(?)` 说明浮层化（替代原生 `title`）：自绘浮层 + 交互契约（悬停即时显示/离开隐藏/点击·触屏切换/
 *     Tab 聚焦可见/Esc·浮层外点击·滚动关闭/至多一个/不被弹窗裁剪 + 边界翻转）+ 语义关联
 *     （aria-label 保留全文、打开时 aria-describedby 指向 role="tooltip" 浮层）。负向：回退 `title`、
 *     删掉浮层/任一处理器 ⇒ 必红。
 *  2. 评审条件「生效值」可视化：不再是与说明文字同色的弱化文本，而是**输入框同构**的边框+底色+等宽字体
 *     （全不透明）；给出该面板全部生效值展示位清单并逐个核对。
 *  3. 自动化指导默认值：**未显式配置**的键显示 `默认：<解析默认值>`（不再显示「无」），默认值只来自
 *     引擎下发的 `automation_defaults`（客户端零硬编码副本）；六键逐一核对「缺键 ⇒ 默认」「已设 ⇒ 当前值」。
 *  4. `project.yaml` 行从页脚迁到**标题栏右侧（关闭按钮左边）**：绝对路径 / 可打开 / 可复制，窄宽度与
 *     长路径下不断行错位；负向：搬回页脚或留双份 ⇒ 必红。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const repoRoot = join(import.meta.dirname, "../..");
const clientDir = join(repoRoot, "dsh-graph-host/lib/client");
const modalPath = join(clientDir, "settings-modal.js");
const i18nPath = join(clientDir, "i18n.js");
const hostPath = join(repoRoot, "dsh-graph-host/index.js");

const readModal = (): string => readFileSync(modalPath, "utf8");
const readHost = (): string => readFileSync(hostPath, "utf8");

type Dict = Record<string, string>;
const countOccurrences = (hay: string, needle: string): number => hay.split(needle).length - 1;

/** 引擎侧唯一真源：六键在未配置时的解析默认值（与 dsh-graph-host/index.js 的 AUTOMATION_DEFAULTS 同源）。 */
const AUTOMATION_KEYS = ["scope_planning", "integration_decision", "rework", "memory_promotion", "skill_proposal", "release"];
const AUTOMATION_DEFAULTS: Dict = {
  scope_planning: "human",
  integration_decision: "ai",
  rework: "ai",
  memory_promotion: "ai",
  skill_proposal: "ai",
  release: "human",
};

function loadClientI18n(src = readFileSync(i18nPath, "utf8")): { zh: Dict; en: Dict } {
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${src}\n;this.zh = zh; this.en = en;`, sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

/** 从**真实源码**取一个模块级/组件内函数并求值（不复制算法 ⇒ 不会与实现漂移）。 */
function extractFn(modalSrc: string, decl: string, endMarker: string, name: string, deps: Record<string, any> = {}): any {
  const start = modalSrc.indexOf(decl);
  assert.ok(start > 0, `源码必须含：${decl}`);
  const end = modalSrc.indexOf(endMarker, start);
  assert.ok(end > start, `能定位 ${name} 的结束标记：${endMarker}`);
  const slice = modalSrc.slice(start, end + endMarker.length);
  const keys = Object.keys(deps);
  return new Function(...keys, `${slice}\nreturn ${name};`)(...keys.map((k) => deps[k]));
}

/** 从 `{` 处按花括号配平取出一个样式块（用于核对弹窗/遮罩容器样式）。 */
function braceBlock(src: string, openIdx: number): string {
  assert.ok(openIdx > 0, "能定位样式块起始");
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx, i + 1);
    }
  }
  return "";
}

// ===== 真实渲染（与 g479 同一 vm 口径：仅替换 React 与 Host 依赖）=====

type Rendered = { nodes: any[] };

function renderModal(modalSrc: string, form: any, zh: Dict, opts: { tab?: string; openHint?: string | null } = {}): Rendered {
  const h = (type: any, props: any, ...children: any[]) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c: any) => c !== null && c !== undefined && c !== false),
  });
  const overrides: any[] = [false, form, false, null, null];
  overrides[5] = opts.tab ?? "executor";
  overrides[6] = "/abs/path/project.yaml";
  if (opts.openHint !== undefined) overrides[12] = opts.openHint;
  let idx = 0;
  const sandbox: any = {
    console,
    h,
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
        // hasOwnProperty：稀疏覆写留下的"洞"视为未覆盖（回落组件初始值），不得注入 undefined
        const v = Object.prototype.hasOwnProperty.call(overrides, i) ? overrides[i] : (typeof init === "function" ? init() : init);
        return [v, () => {}];
      },
      useEffect: () => {},
    },
  };
  const start = modalSrc.indexOf("function SettingsModal(");
  const normStart = modalSrc.indexOf("function normalizeSettingsDraft(");
  assert.ok(start > 0 && normStart > 0 && normStart < start, "能定位归一化段与 SettingsModal 组件源码");
  // 切片须从 normalizeSettingsDraft 起（模块级常量段 SETTINGS_TAB_KEYS / SETTINGS_DEFAULT_TAB /
  // AUTOMATION_HINT_KEYS 等都在这两段之间），与 g479 夹具同口径。
  vm.runInNewContext(`${modalSrc.slice(normStart)}\n;this.SettingsModal = SettingsModal;`, sandbox);
  const tree = sandbox.SettingsModal({ onClose: () => {}, onSaved: () => {} });
  const nodes: any[] = [];
  const walk = (n: any) => { if (!n || typeof n !== "object") return; nodes.push(n); (n.children ?? []).forEach(walk); };
  walk(tree);
  return { nodes };
}

/** 递归文本（容器节点的直接子节点是元素，需递归）。 */
const deepTextOf = (n: any): string => {
  if (n === null || n === undefined || n === false) return "";
  if (typeof n === "string") return n;
  return (n.children ?? []).map(deepTextOf).join("");
};

const REVIEW_LIST_KEYS = ["regions", "contract_paths", "non_product_prefixes"];
const effective = (value: string[], extra: Dict = {}) => ({ value, source: "explicit", malformed: false, allow_empty: true, illegal_empty: false, ...extra });

const SNAPSHOT = {
  executor: { provider: "prov-a", model: "mod-a", reasoning_effort: "high", mode: "standard" },
  review: {
    policy: "auto",
    regions: ["core"],
    contract_paths: ["core/ops.ts"],
    non_product_prefixes: ["docs"],
    effective: {
      regions: effective(["core"], { source: "explicit" }),
      contract_paths: effective(["core/ops.ts"], { source: "default" }),
      non_product_prefixes: effective([], { source: "default" }),
    },
  },
  supervisor: { agent_teams: true, automation: {} },
  defaults: { review: { reviewer: "rev-1", prompt: "prm-1" }, pk: { lanes: 3, sandbox: "sdbx" } },
  modules: { tags: true, memory: false, shared_cards: true, automation_prompts: true, attachments: false },
  prompt_overrides: { subagent: { state: "default", value: null } },
};

// ========== 判据 1：`(?)` 说明浮层化 ==========

test("g-490 判据1：`(?)` 自绘浮层替代原生 title——交互契约齐备、语义关联可达、至多一个", () => {
  const src = readModal();
  const { zh } = loadClientI18n();

  // 唯一构造点 + 可视字面量
  assert.equal(countOccurrences(src, "const settingsHintIcon = (text) => {"), 1, "`(?)` 必须有唯一构造点");
  assert.equal(countOccurrences(src, "}, SETTINGS_HINT_ICON)"), 1, "`(?)` 可视字面量必须恰好一处");
  assert.equal(countOccurrences(src, 'const SETTINGS_HINT_ICON = "(?)"'), 1, "字面量必须由常量承载");
  // 至多一个：唯一 openHint 状态
  assert.equal(countOccurrences(src, "const [openHint, setOpenHint] = React.useState(null)"), 1, "唯一浮层状态（同屏至多一个）");
  // 交互契约（逐条）
  for (const [needle, why] of [
    ["onMouseEnter: (e) => { hintLastEnterRef.current = Date.now(); openHintAt(tipId, e.currentTarget); },", "悬停即时显示"],
    ["onMouseLeave: () => closeHintIf(tipId),", "离开即隐藏"],
    ["if (open && Date.now() - (hintLastEnterRef.current || 0) < 700) return;", "点击/触屏切换（抑制 mouseenter→click 双触发）"],
    ["onFocus: (e) => openHintAt(tipId, e.currentTarget),", "Tab 聚焦可见"],
    ["onBlur: () => closeHintIf(tipId),", "失焦隐藏"],
    ['onKeyDown: (e) => { if (e.key === "Escape") setOpenHint(null); },', "聚焦态 Esc 关闭"],
    ['if (e && e.key === "Escape") setOpenHint(null);', "全局 Esc 兜底"],
    ['t.closest(".dg-settings-tip")', "浮层外点击关闭（浮层内点击不关）"],
    ['window.addEventListener("scroll", onScroll, true)', "滚动关闭"],
    ['position: "fixed", zIndex: 100001', "固定定位（不被弹窗 overflow 裁剪）"],
    ["const above = geom ? (geom.top > 180 || vh === 0) : true;", "视口边界翻转"],
    ['role: "tooltip"', "浮层语义"],
    ['"aria-describedby": open ? tipId : undefined', "打开时语义关联"],
    ['"aria-label": text', "可读名保留说明全文（零信息丢失）"],
    ["tabIndex: 0", "键盘可达"],
  ] as Array<[string, string]>) {
    assert.equal(countOccurrences(src, needle), 1, `交互/语义契约必须恰好一处（${why}）：${needle}`);
  }
  // 弹窗与遮罩不得引入 transform/backdrop-filter 祖先（否则 position:fixed 浮层会被包含块裁剪）
  const helpersSrc = readFileSync(join(clientDir, "helpers.js"), "utf8");
  for (const key of ["modal", "overlay"]) {
    const at = helpersSrc.indexOf(`\n      ${key}: {`);
    const block = braceBlock(helpersSrc, helpersSrc.indexOf("{", at));
    assert.ok(block.length > 0, `能取出 S.${key} 样式块`);
    assert.doesNotMatch(block, /transform|backdropFilter|WebkitBackdropFilter/, `S.${key} 不得引入 transform / backdrop-filter（会裁剪 fixed 浮层）`);
  }
  assert.doesNotMatch(src, /transform|backdropFilter/, "设置弹窗源码不得引入 transform / backdrop-filter（会裁剪 fixed 浮层）");

  // 负向：构造点内不得回退原生 title
  const hintFn = src.slice(src.indexOf("const settingsHintIcon = (text) => {"), src.indexOf("React.useEffect(", src.indexOf("const settingsHintIcon = (text) => {")));
  assert.ok(hintFn.length > 0, "能定位 `(?)` 构造点源码区间");
  assert.doesNotMatch(hintFn, /\btitle:/, "`(?)` 构造点内不得出现原生 title（回退即红）");

  // 行为：稳定 id（同文案 → 同 id；不同文案 → 不同 id；前缀固定）
  const idFor = extractFn(src, "const settingsHintIdFor = (text) => {", "\n    };", "settingsHintIdFor");
  const text = zh["settings.automationHint"];
  assert.equal(idFor(text), idFor(text), "同一文案必须得到同一 id（aria-describedby 可靠）");
  assert.notEqual(idFor(text), idFor(zh["settings.reviewPolicyHint"]), "不同文案必须得到不同 id");
  assert.match(idFor(text), /^dg-settings-tip-[0-9a-z]+$/, "id 形态稳定（前缀 + 36 进制哈希）");

  // 渲染树：默认（未打开）无浮层、无 title；打开态恰好一个浮层且正文=说明全文
  const base = renderModal(src, SNAPSHOT, zh, { tab: "executor" });
  const hints = base.nodes.filter((n) => String(n.props?.className ?? "") === "dg-settings-hint");
  assert.ok(hints.length >= 10, `\`(?)\` 图标应覆盖各小节（≥10），实得 ${hints.length}`);
  for (const n of hints) {
    assert.equal(n.props.title, undefined, "渲染树里不得再出现原生 title（说明由浮层承载）");
    assert.equal(typeof n.props["aria-label"], "string", "aria-label 必须保留说明全文");
    assert.equal(n.props["aria-describedby"], undefined, "未打开时不得有 aria-describedby（不悬空引用）");
  }
  assert.equal(base.nodes.filter((n) => n.props?.role === "tooltip").length, 0, "未打开时不得渲染浮层");
  const opened = renderModal(src, SNAPSHOT, zh, { tab: "executor", openHint: idFor(text) });
  const pops = opened.nodes.filter((n) => n.props?.role === "tooltip");
  assert.equal(pops.length, 1, "打开态恰好一个浮层（至多一个）");
  assert.equal(pops[0].props.id, idFor(text), "浮层 id = 文案派生 id");
  assert.equal(deepTextOf(pops[0]), text, "浮层正文 = 说明全文（零信息丢失）");
  assert.equal(opened.nodes.filter((n) => n.props?.["aria-describedby"] === idFor(text)).length, 1, "打开态触发器必须恰好一处关联该浮层");
});

// ========== 判据 2：评审条件生效值可视化 ==========

/** 生效值展示位清单（该面板**全部**生效值展示点，逐个核对呈现形状）。 */
const EFFECTIVE_SITES = [
  { site: "regions 生效值", key: "regions" },
  { site: "contract_paths 生效值", key: "contract_paths" },
  { site: "non_product_prefixes 生效值", key: "non_product_prefixes" },
];

/** 未配置态快照：三张列表都未写入 project.yaml（生效值来自引擎投影）——这正是原「弱化文本」出现的位置。 */
const unsetReviewForm = () => {
  const f: any = JSON.parse(JSON.stringify(SNAPSHOT));
  for (const k of REVIEW_LIST_KEYS) f.review[k] = null;
  return f;
};

test("g-490 判据2：评审条件生效值以「输入框同构」呈现（边框/底色/全不透明），3 个展示位逐一核对", () => {
  const src = readModal();
  const { zh } = loadClientI18n();
  assert.equal(countOccurrences(src, 'className: "dg-settings-effective-value"'), 1, "生效值框必须由唯一构造点产出（三张列表共用同一形状，不各写一份）");

  // 生效值展示位清单（未配置态）：三张列表各一行只读生效值——由引擎投影驱动
  const { nodes } = renderModal(src, unsetReviewForm(), zh, { tab: "review" });
  const boxes = nodes.filter((n) => String(n.props?.className ?? "") === "dg-settings-effective-value");
  assert.equal(boxes.length, EFFECTIVE_SITES.length, `渲染树里生效值框必须恰好 ${EFFECTIVE_SITES.length} 个（三张列表各一）`);
  const label = zh["settings.reviewEffectiveLabel"];
  for (const site of EFFECTIVE_SITES) {
    assert.ok(boxes.some((n) => deepTextOf(n).startsWith(label + "：")), `展示位缺失：${site.site}`);
  }
  for (const box of boxes) {
    const style = box.props.style ?? {};
    assert.ok(String(style.border ?? "").includes("1px solid"), "生效值必须有实边框（输入框同构）");
    assert.ok(style.background, "生效值必须有底色（输入框同构）");
    assert.equal(style.borderRadius, 4, "生效值必须圆角同构");
    assert.equal(style.opacity, undefined, "生效值不得再是弱化（opacity）文本——必须全不透明");
    assert.match(String(style.fontFamily ?? ""), /monospace/, "生效值必须是等宽字体（与输入框同构、与说明文字可分）");
    assert.equal(style.wordBreak, "break-all", "长值必须折行（不得撑破面板）");
    // 标签与取值必须在**同一节点**且紧邻（不让「生效值：」与值被拆到两处）
    const text = deepTextOf(box);
    assert.ok(text.startsWith(label + "："), `生效值文案必须以「${label}：」开头，实得：${text}`);
    assert.ok(text.length > label.length + 1, "生效值不得为空串（空列表必须显式标注）");
    // 与相邻说明文字（S.meta = 弱化文本）必须**不是**同一形状：弱化文本是 opacity:.65 的小字
    assert.notEqual(style.opacity, 0.65, "生效值不得与说明文字同色/同透明度");
  }
  // 三个键的投影取值都能看到（与引擎生效值一致）
  const all = boxes.map(deepTextOf).join("\n");
  assert.ok(all.includes("core"), "regions 生效值必须可见");
  assert.ok(all.includes("core/ops.ts"), "contract_paths 生效值必须可见");
  assert.ok(all.includes(zh["settings.reviewEffectiveEmpty"]), "空列表必须显式标注为「空」而不是留白");

  // 展示位清单（同一面板的其余两处）：显式配置态由**可编辑输入框**承载（值在 textarea 里，不再是只读读数）
  const ariaKeys = (() => {
    const at = src.indexOf("const REVIEW_LIST_ARIA_KEYS = {");
    assert.ok(at > 0, "settings-modal.js 必须含 REVIEW_LIST_ARIA_KEYS（否则无法定位列表输入框）");
    const block = braceBlock(src, src.indexOf("{", at));
    return new Function(`return ${block};`)() as Dict;
  })();
  const explicit = renderModal(src, SNAPSHOT, zh, { tab: "review" });
  assert.equal(
    explicit.nodes.filter((n) => String(n.props?.className ?? "") === "dg-settings-effective-value").length,
    0,
    "显式配置态不再渲染只读生效值行（值已在输入框里，避免两处重复读数）",
  );
  for (const key of REVIEW_LIST_KEYS) {
    const area = explicit.nodes.filter((n) => n.type === "textarea" && n.props?.["aria-label"] === zh[ariaKeys[key]]);
    assert.equal(area.length, 1, `显式配置态的输入框必须恰好一处：${key}`);
    assert.equal(area[0].props.value, (SNAPSHOT.review as any)[key].join("\n"), `输入框必须承载当前显式取值：${key}`);
  }
  // review.policy 的生效值由 <select>（输入控件）承载——同样是「非弱化文本」
  assert.ok(
    explicit.nodes.some((n) => n.type === "select" && (n.children ?? []).some((o: any) => o?.props?.value === "auto")),
    "review.policy 生效值必须由输入控件（select）承载",
  );
  // 负向：生效值退回说明文字样式（...S.meta）必红
  assert.doesNotMatch(src, /className: "dg-settings-effective-value", style: \{ \.\.\.S\.meta/, "生效值不得退回说明文字样式");
});

// ========== 判据 3：自动化指导默认值 ==========

test("g-490 判据3：未配置的自动化键显示「默认：<解析默认值>」，默认值只来自引擎下发（零客户端硬编码）", () => {
  const src = readModal();
  const { zh, en } = loadClientI18n();
  assert.equal(zh["settings.automationDefaultPrefix"], "默认：", "zh 默认值前缀键必须存在");
  assert.equal(en["settings.automationDefaultPrefix"], "Default: ", "en 默认值前缀键必须存在（对称）");
  // 客户端不得硬编码 human/ai 的键级默认值副本（唯一真源是服务端下发的 automation_defaults）
  for (const k of AUTOMATION_KEYS) {
    assert.doesNotMatch(src, new RegExp(`${k}\\s*:\\s*"(human|ai)"`), `客户端不得硬编码 ${k} 的默认值`);
  }
  assert.match(src, /const automationDefaults = form\.automation_defaults \?\? \{\};/, "默认值只能取自服务端下发的 automation_defaults");
  // 保存后回填必须保留该展示元数据（否则保存一次后退回「无」）
  assert.match(src, /setForm\(data\.config\s*\n?\s*\? \{ \.\.\.data\.config, automation_defaults: data\.automation_defaults \?\? form\.automation_defaults \}/, "POST 回填必须保留 automation_defaults（显示层不得因保存而退化）");

  // 双向：缺键 ⇒ 默认；已设 ⇒ 当前值（六键逐一）
  const formUnset = JSON.parse(JSON.stringify(SNAPSHOT));
  formUnset.supervisor.automation = {};
  formUnset.automation_defaults = { ...AUTOMATION_DEFAULTS };
  const unset = renderModal(src, formUnset, zh, { tab: "supervisor" });
  for (const k of AUTOMATION_KEYS) {
    const row = automationRow(unset.nodes, k);
    assert.ok(row, `必须能定位自动化键 ${k} 的行`);
    assert.equal(row.select.props.value, "", `${k} 未配置时 select 必须停在占位项（值为空串）`);
    assert.equal(deepTextOf(row.select.children[0]), zh["settings.automationDefaultPrefix"] + AUTOMATION_DEFAULTS[k], `${k} 未配置时必须显示「默认：<解析默认值>」`);
    assert.notEqual(deepTextOf(row.select.children[0]), zh["common.none"], `${k} 未配置时不得再显示「无」`);
  }

  const formSet = JSON.parse(JSON.stringify(SNAPSHOT));
  formSet.supervisor.automation = Object.fromEntries(AUTOMATION_KEYS.map((k) => [k, AUTOMATION_DEFAULTS[k] === "human" ? "ai" : "human"]));
  formSet.automation_defaults = { ...AUTOMATION_DEFAULTS };
  const set = renderModal(src, formSet, zh, { tab: "supervisor" });
  for (const k of AUTOMATION_KEYS) {
    const row = automationRow(set.nodes, k);
    assert.ok(row, `必须能定位自动化键 ${k} 的行（已配置）`);
    assert.equal(row.select.props.value, formSet.supervisor.automation[k], `${k} 已配置时必须显示当前值`);
    assert.equal(deepTextOf(row.select.children[0]), zh["settings.automationDefaultPrefix"] + AUTOMATION_DEFAULTS[k], `${k} 已配置时仍须能看到解析默认值（占位项不丢）`);
  }

  // 旧服务端（缺 automation_defaults）：退化为既有「无」，绝不伪造默认值
  const formLegacy = JSON.parse(JSON.stringify(SNAPSHOT));
  formLegacy.supervisor.automation = {};
  const legacy = renderModal(src, formLegacy, zh, { tab: "supervisor" });
  for (const k of AUTOMATION_KEYS) {
    const row = automationRow(legacy.nodes, k);
    assert.ok(row, `必须能定位自动化键 ${k} 的行（缺 automation_defaults）`);
    assert.equal(deepTextOf(row.select.children[0]), zh["common.none"], `缺 automation_defaults 时必须退化为「无」（不得伪造默认值）：${k}`);
  }

  // en 侧同样按服务端默认值渲染（不是硬编码中文/固定 human）
  const enUnset = renderModal(src, formUnset, en, { tab: "supervisor" });
  const enRow = automationRow(enUnset.nodes, "release");
  assert.ok(enRow, "必须能定位自动化键 release 的行（en）");
  assert.equal(deepTextOf(enRow.select.children[0]), en["settings.automationDefaultPrefix"] + "human", "en 侧同样显示解析默认值");
});

/** 在渲染树里定位「自动化键 k」那一行：行内同时含 select 与仅含键名的标签容器。
 *  标签容器是 `h("div", …, h("label", …, k), settingsHintIcon(…))` ⇒ 其递归文本为 `k + "(?)"`，
 *  故用 includes 判定；键名之间无子串关系（逐个核对过），不会互相误配。 */
function automationRow(nodes: any[], k: string): { select: any } | null {
  for (const n of nodes) {
    if (n.type !== "div") continue;
    const kids = n.children ?? [];
    const sel = kids.find((c: any) => c?.type === "select");
    if (!sel) continue;
    const labelled = kids.some((c: any) => c?.type !== "select" && deepTextOf(c).includes(k));
    if (labelled) return { select: sel };
  }
  return null;
}

// ========== 判据 4：project.yaml 行迁到标题栏右侧 ==========

test("g-490 判据4：`project.yaml` 行位于标题栏右侧（关闭按钮左边）——绝对路径 + 可打开 + 可复制", () => {
  const src = readModal();
  const { zh } = loadClientI18n();
  const { nodes } = renderModal(src, SNAPSHOT, zh, { tab: "executor" });
  // 结构：标题栏容器 = 标题 + project.yaml 行（两行同容器 ⇒ 视觉同一行右端）
  const titleBar = nodes.find(
    (n) => n.type === "div" && (n.children ?? []).some((c: any) => String(c?.props?.className ?? "") === "dg-settings-configfile"),
  );
  assert.ok(titleBar, "标题栏必须承载 project.yaml 行（同一容器）");
  assert.ok(deepTextOf(titleBar).includes(zh["settings.title"]), "承载行必须就是标题栏（同容器含标题）");
  assert.ok(deepTextOf(titleBar).includes("/abs/path/project.yaml"), "必须显示绝对路径全文");
  const row = (titleBar!.children ?? []).find((c: any) => String(c?.props?.className ?? "") === "dg-settings-configfile");
  const buttons = (row.children ?? []).filter((c: any) => c?.type === "button");
  assert.equal(buttons.length, 2, "必须有「打开」与「复制路径」两个按钮");
  assert.equal(buttons[0].props.title, zh["settings.openConfigTooltip"], "打开按钮必须有提示（按钮 title 属既有形态，不在 `(?)` 路径内）");
  assert.equal(buttons[1].props.title, zh["settings.copyProjectPath"], "复制按钮必须有提示");
  const style = row.props.style ?? {};
  assert.equal(style.minWidth, 0, "窄宽度：行内容必须允许收缩（minWidth:0）");
  assert.equal(style.flexWrap, "wrap", "窄宽度：必须允许换行而不是溢出裁切");
  assert.equal(style.marginLeft, "auto", "必须靠右（关闭按钮左边）");
  assert.equal(style.justifyContent, "flex-end", "内容右对齐");
  const pathSpan = (row.children ?? []).find((c: any) => String(c?.props?.style?.wordBreak ?? "") === "break-all");
  assert.ok(pathSpan, "路径必须以 break-all 呈现（长路径不撑破布局）");
  assert.equal(pathSpan.props.style.minWidth, 0, "路径必须允许收缩到 0（长路径场景）");
  // 页脚不得再有第二份
  const footer = nodes.find((n) => n.type === "div" && (n.children ?? []).some((c: any) => deepTextOf(c) === zh["settings.closeBtn"]));
  assert.ok(footer, "必须能找到页脚按钮行");
  assert.ok(!deepTextOf(footer).includes("/abs/path/project.yaml"), "页脚不得残留 project.yaml（迁移≠复制）");
  // 标题栏必须给右上角关闭按钮留出空间（否则窄宽度下会被盖住）
  const header = nodes.find((n) => n.props?.style?.paddingRight === 34);
  assert.ok(header, "标题栏必须预留 paddingRight:34（给右上角关闭按钮让位）");
  // 源码负向：页脚锚点之后不得再出现 projectYaml
  const footerAt = src.indexOf('h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },');
  assert.ok(footerAt > 0, "能定位页脚锚点");
  assert.doesNotMatch(src.slice(footerAt), /settings\.projectYaml/, "页脚之后不得再出现 project.yaml 文案");
});

// ========== 引擎真源 ↔ 客户端消费 一致性 ==========

test("g-490 真源一致性：AUTOMATION_DEFAULTS（引擎）↔ settings API 下发 ↔ schema_hints ↔ 客户端消费", () => {
  const host = readHost();
  const decl = host.slice(host.indexOf("const AUTOMATION_DEFAULTS = {"), host.indexOf("};", host.indexOf("const AUTOMATION_DEFAULTS = {")) + 2);
  const engineDefaults: Dict = new Function(`${decl}\nreturn AUTOMATION_DEFAULTS;`)();
  assert.deepEqual(Object.keys(engineDefaults).sort(), [...AUTOMATION_KEYS].sort(), "引擎默认值必须六键齐备（不增不减）");
  assert.deepEqual(engineDefaults, AUTOMATION_DEFAULTS, "测试侧登记的默认值必须与引擎真源逐键一致（本断言即对账）");
  for (const k of AUTOMATION_KEYS) {
    assert.ok(["human", "ai"].includes(engineDefaults[k]), `${k} 的默认值必须是 human/ai 之一`);
  }
  // 下发：GET / POST 两个响应都必须带上该字段（缺一个 ⇒ 打开面板/保存后行为不一致）
  assert.equal(countOccurrences(host, "automation_defaults: AUTOMATION_DEFAULTS"), 2, "GET 与 POST 响应必须都下发 automation_defaults");
  assert.equal(countOccurrences(host, "defaults: AUTOMATION_DEFAULTS,"), 1, "schema_hints 必须复用同一真源（不复制一份字面量）");
  // 引擎不得把默认值写进配置本体（读侧仍返回 null ⇒ 既有 deepEqual 契约与「未配置保持既有指导」语义不变）
  const modal = readModal();
  assert.doesNotMatch(modal, /scope_planning: "human"/, "客户端不得内联六键默认值字面量");
});

// ========== 末节：hermetic 负向对照（在内存副本上变异，四项都必须「改坏即红」） ==========

/** 四项改动的契约检查（同一组谓词同时用于正向与负向：正向必须无问题、变异体必须报出问题）。 */
function presentationProblems(modalSrc: string, zh: Dict): string[] {
  const problems: string[] = [];
  // ---- 判据 1：`(?)` 浮层契约 ----
  const hintAt = modalSrc.indexOf("const settingsHintIcon = (text) => {");
  if (hintAt < 0) problems.push("判据1：缺少 `(?)` 构造点");
  else {
    // 浮层契约横跨「几何测量/定位 + 触发器 + 浮层」三小段（定位样式在前）⇒ 取整段到下一个 useEffect 之前
    const regionStart = modalSrc.indexOf("const hintGeometryOf = ") >= 0 ? modalSrc.indexOf("const hintGeometryOf = ") : hintAt;
    const hintFn = modalSrc.slice(regionStart, modalSrc.indexOf("React.useEffect(", hintAt));
    if (/\btitle:/.test(hintFn)) problems.push("判据1：`(?)` 回退原生 title（说明由浮层承载）");
    for (const [needle, why] of [
      ['"aria-label": text', "缺少可读名"],
      ['role: "tooltip"', "缺少浮层语义"],
      ["onMouseEnter", "缺少悬停显示"],
      ["onMouseLeave", "缺少离开隐藏"],
      ["onClick", "缺少点击/触屏切换"],
      ["onFocus", "缺少键盘聚焦显示"],
      ["onBlur", "缺少失焦隐藏"],
      ["Escape", "缺少 Esc 关闭"],
      ['position: "fixed"', "缺少固定定位（会被弹窗裁剪）"],
      ["const above = ", "缺少边界翻转"],
    ] as Array<[string, string]>) {
      if (!hintFn.includes(needle)) problems.push(`判据1：${why}（${needle}）`);
    }
  }
  if (!modalSrc.includes("const [openHint, setOpenHint] = React.useState(null)")) problems.push("判据1：缺少唯一浮层状态");
  // ---- 判据 2：生效值输入框同构 ----
  const unset = renderModal(modalSrc, unsetReviewForm(), zh, { tab: "review" });
  const boxes = unset.nodes.filter((n) => String(n.props?.className ?? "") === "dg-settings-effective-value");
  if (boxes.length !== EFFECTIVE_SITES.length) problems.push(`判据2：生效值展示位应为 ${EFFECTIVE_SITES.length} 个，实得 ${boxes.length}`);
  for (const box of boxes) {
    const st = box.props.style ?? {};
    if (!String(st.border ?? "").includes("1px solid")) problems.push("判据2：生效值缺边框（退回弱化文本）");
    if (!st.background) problems.push("判据2：生效值缺底色（退回弱化文本）");
    if (st.opacity !== undefined) problems.push("判据2：生效值带 opacity（仍是弱化文本）");
    if (!/monospace/.test(String(st.fontFamily ?? ""))) problems.push("判据2：生效值非等宽字体（与输入框不同构）");
    if (!deepTextOf(box).startsWith(zh["settings.reviewEffectiveLabel"] + "：")) problems.push("判据2：生效值文案形状不对");
  }
  // ---- 判据 3：未配置键显示解析默认值、客户端零硬编码 ----
  for (const k of AUTOMATION_KEYS) {
    if (new RegExp(`${k}\\s*:\\s*"(human|ai)"`).test(modalSrc)) problems.push(`判据3：客户端硬编码了 ${k} 的默认值`);
  }
  const form = unsetAllAutomation();
  const tree = renderModal(modalSrc, form, zh, { tab: "supervisor" });
  for (const k of AUTOMATION_KEYS) {
    const row = automationRow(tree.nodes, k);
    if (!row) { problems.push(`判据3：找不到自动化键 ${k} 的行`); continue; }
    const want = zh["settings.automationDefaultPrefix"] + AUTOMATION_DEFAULTS[k];
    if (deepTextOf(row.select.children[0]) !== want) problems.push(`判据3：${k} 未配置时未显示「${want}」，实得「${deepTextOf(row.select.children[0])}」`);
  }
  // ---- 判据 4：project.yaml 行在标题栏右侧、页脚无残留 ----
  const rendered = renderModal(modalSrc, SNAPSHOT, zh, { tab: "executor" });
  const titleBar = rendered.nodes.find(
    (n) => n.type === "div" && (n.children ?? []).some((c: any) => String(c?.props?.className ?? "") === "dg-settings-configfile"),
  );
  if (!titleBar || !deepTextOf(titleBar).includes("/abs/path/project.yaml")) problems.push("判据4：project.yaml 行不在标题栏（可能被搬回页脚）");
  const footer = rendered.nodes.find((n) => n.type === "div" && (n.children ?? []).some((c: any) => deepTextOf(c) === zh["settings.closeBtn"]));
  if (footer && deepTextOf(footer).includes("/abs/path/project.yaml")) problems.push("判据4：页脚仍残留 project.yaml（迁移≠复制）");
  return problems;
}

const unsetAllAutomation = () => {
  const f: any = JSON.parse(JSON.stringify(SNAPSHOT));
  f.supervisor.automation = {};
  f.automation_defaults = { ...AUTOMATION_DEFAULTS };
  return f;
};

test("g-490 改坏即红：四项契约在内存变异下逐项报红，且真实源文件零改动", () => {
  const before = readFileSync(modalPath, "utf8");
  const { zh } = loadClientI18n();
  assert.deepEqual(presentationProblems(before, zh), [], "正向：真实源码四项契约必须全部成立（谓词本身不作假红）");

  const mutants: Array<{ name: string; src: string; expect: RegExp }> = [
    { name: "回退原生 title", src: before.replace('"aria-label": text', "title: text"), expect: /回退原生 title/ },
    { name: "删掉浮层语义 role=tooltip", src: before.replace('role: "tooltip"', 'role: "note"'), expect: /缺少浮层语义/ },
    { name: "删掉悬停显示", src: before.replace(/onMouseEnter: \(e\) => \{[^}]*\},/, ""), expect: /缺少悬停显示/ },
    { name: "删掉浮层状态（不再至多一个）", src: before.replace("const [openHint, setOpenHint] = React.useState(null)", "const openHint = null"), expect: /缺少唯一浮层状态/ },
    { name: "生效值退回弱化文本（去边框）", src: before.replace('border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))",', ""), expect: /生效值缺边框/ },
    { name: "生效值退回弱化文本（加 opacity）", src: before.replace('fontSize: 11, marginTop: 2, padding: "3px 7px", borderRadius: 4, display: "block",', 'fontSize: 11, marginTop: 2, padding: "3px 7px", borderRadius: 4, display: "block", opacity: 0.65,'), expect: /生效值带 opacity/ },
    { name: "未配置键不显示默认值", src: before.replace("automationOptions(auto[k], automationDefaults[k] ?? null)", "automationOptions(auto[k], null)"), expect: /未配置时未显示/ },
    { name: "客户端硬编码默认值副本", src: before.replace("const automationDefaults = form.automation_defaults ?? {};", 'const automationDefaults = form.automation_defaults ?? {};\n      const HARDCODED = { scope_planning: "human" };'), expect: /硬编码了 scope_planning/ },
    { name: "project.yaml 行搬离标题栏", src: before.replace("            projectYamlRow),\n", "            ),\n"), expect: /不在标题栏/ },
  ];
  for (const m of mutants) {
    assert.notEqual(m.src, before, `变异体「${m.name}」必须真的改动了源码（否则是空变异）`);
    const got = presentationProblems(m.src, zh).join(" | ");
    assert.match(got, m.expect, `变异体「${m.name}」必须被同一组谓词报红，实得问题：${got || "（无）"}`);
  }
  // 页脚残留的负向对照：把行同时塞回页脚 ⇒ 判据4 必须点名「页脚残留」
  const duplicated = before.replace(
    "            note ? h(\"span\",",
    "            projectYamlRow,\n            note ? h(\"span\",",
  );
  assert.notEqual(duplicated, before, "页脚复制变异必须真的改动了源码");
  assert.match(
    presentationProblems(duplicated, zh).join(" | "),
    /页脚仍残留/,
    "行被复制回页脚必须报「页脚残留」（迁移不得变成双份）",
  );
  assert.equal(readFileSync(modalPath, "utf8"), before, "负向对照只在内存副本上进行：真实源文件必须逐字未变");
});
