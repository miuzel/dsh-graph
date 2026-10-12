/**
 * g-490 判据机器断言：设置弹窗**呈现层**各项改动的专用守卫（与 g479 / g488 / g132 / g442 的既有守卫
 * **并存**——本次只替换「与旧呈现形状绑定」的那几条，其余一条不减）。
 *
 *  1. `(?)` 说明浮层化（替代原生 `title`）：自绘浮层 + 交互契约（悬停即时显示/离开隐藏/点击·触屏切换/
 *     Tab 聚焦可见/Esc·浮层外点击·滚动关闭/至多一个/不被弹窗裁剪 + 边界翻转）+ 语义关联
 *     （aria-label 保留全文、打开时 aria-describedby 指向 role="tooltip" 浮层）。负向：回退 `title`、
 *     删掉浮层/任一处理器 ⇒ 必红。
 *  2. 评审条件「生效值」可视化：不再是与说明文字同色的弱化文本，而是**输入框同构**的边框+底色+等宽字体
 *     （全不透明）；给出该面板全部生效值展示位清单并逐个核对。
 *  3. 主管自动化六键的**未配置**表达（负责人 2026-10-12 裁决：诚实口径、不编默认值）：只有**动作落在
 *     既有某类人工 gate 范围内**的两键（`scope_planning` / `release`）显示 `默认：human` 且**同屏**
 *     标注口径来源；其余四键只显示「未配置：保持既有指导」，不得出现任何 human/ai；客户端零硬编码副本
 *     （来源值只能来自引擎下发的 `unset_scope`）。负向：无来源的具体 human/ai、把「保持既有指导」渲染成
 *     human/ai ⇒ 必红。
 *  4. `project.yaml` 行从页脚迁到**标题栏右侧（关闭按钮左边）**：绝对路径 / 可打开 / 可复制，窄宽度与
 *     长路径下不断行错位；负向：搬回页脚或留双份 ⇒ 必红。
 *  5. （扩写）判据 7「project.yaml 行归位与说明折叠」：`editHint` 与目录来源长句（`catalogReady`）等
 *     **常驻平铺的说明性长句**一律折叠进自绘 `(?)`（文案一字未改 ⇒ 浮层正文 ≡ i18n 原文），常驻正文只留
 *     短字段提示与必读警示 / 瞬态状态读数（`FOLDED_HINT_KEYS` / `FLAT_BODY_KEEP_KEYS` 两份清单逐条钉住）；
 *     `(?)` 默认挂在 project.yaml 行内；目录说明 `(?)` **状态门控**（非就绪态不渲染，避免静态 tooltip 撒谎）。
 *     负向：`editHint` 改回常驻平铺、`(?)` 移出该行、目录说明改回平铺、必读警示被悄悄折叠 ⇒ 必红。
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

/** 引擎侧唯一真源 `AUTOMATION_UNSET_SCOPE` 的**口径**（负责人 2026-10-12 裁决：诚实口径，**不是**
 *  解析默认值）：六键里只有两键的**动作**落在既有某类人工 gate 的**范围**内 ⇒ 未配置时可显示
 *  「默认：<该 gate 的既有要求>」，且**必须同屏标注口径来源**；其余四键未配置只显示「保持既有指导」。
 *  与 `dsh-graph-host/index.js` 的 `AUTOMATION_UNSET_SCOPE` 同源（由「真源一致性」用例逐字对账）。 */
const AUTOMATION_KEYS = ["scope_planning", "integration_decision", "rework", "memory_promotion", "skill_proposal", "release"];
const AUTOMATION_UNSET_SCOPE: Record<string, { gate_scope: string; gate_requires: string }> = {
  scope_planning: { gate_scope: "version_plan", gate_requires: "human" },
  release: { gate_scope: "release", gate_requires: "human" },
};
/** 有 gate 范围来源的两键（引擎表恰含这两键，不增不减）。 */
const AUTOMATION_SCOPE_KEYS = ["scope_planning", "release"];
/** 其余四键：**不对应任何** gate ⇒ 未配置的唯一口径 = 「保持既有指导」，不得出现任何 human/ai。 */
const AUTOMATION_KEEP_GUIDANCE_KEYS = ["integration_decision", "rework", "memory_promotion", "skill_proposal"];
/** 「具体 human/ai 值」的判定（不分中英文侧）。 */
const HUMAN_AI_RE = /\b(human|ai)\b/i;

/** ===== 判据 7（扩写）：常驻平铺说明的**两份清单**（负责人 2026-10-12 增量裁决）=====
 *  设置弹窗内「常驻平铺的说明性长句」一律折叠进自绘 `(?)` 浮层（同一交互契约；`aria-label` 保留全文；
 *  文案一字未改 ⇒ 信息零丢失），常驻正文只留 ①**短字段提示** ②**必读警示 / 瞬态状态读数**。
 *  `FOLDED_HINT_KEYS` = 已折叠清单（键名 + 落点）；`FLAT_BODY_KEEP_KEYS` = 仍留正文清单（逐条附理由）。
 *  两份清单都由本文件断言逐条钉住（折叠项正文零残留；留正文项未被悄悄搬进浮层、也未从界面消失）。 */
const FOLDED_HINT_KEYS: Array<{ key: string; site: string }> = [
  { key: "settings.editHint", site: "标题栏 project.yaml 行内（📄 project.yaml 标签右侧）" },
  { key: "settings.catalogReady", site: "「执行模式」标签右侧（**仅目录就绪态**渲染该 `(?)`）" },
];
const FLAT_BODY_KEEP_KEYS: Array<{ key: string; why: string }> = [
  { key: "settings.reviewUnsetHint", why: "必读警示：缺省值并非按本项目校准（g479 亦钉住「未配置提示须一眼可见」）" },
  { key: "settings.catalogLoadingMsg", why: "瞬态状态读数（目录加载中）" },
  { key: "settings.catalogUnavailableMsg", why: "降级警示（目录不可用，已存值仍可保存）" },
  { key: "settings.reviewSuggestedRegions", why: "数据行引导语（后接只读建议值，非说明性长句）" },
  { key: "settings.inheritPrompt", why: "短字段提示（15 字）" },
  { key: "settings.disabledPrompt", why: "短字段提示（9 字）" },
];

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

function renderModal(modalSrc: string, form: any, zh: Dict, opts: { tab?: string; openHint?: string | null; catalog?: any } = {}): Rendered {
  const h = (type: any, props: any, ...children: any[]) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c: any) => c !== null && c !== undefined && c !== false),
  });
  const overrides: any[] = [false, form, false, null, null];
  overrides[5] = opts.tab ?? "executor";
  overrides[6] = "/abs/path/project.yaml";
  if (opts.openHint !== undefined) overrides[12] = opts.openHint;
  // 判据 7 扩写：目录三态（loading / ready / unavailable）驱动 `catalogReady` 的**状态门控**折叠 ⇒
  // 夹具必须能直接给定该状态（useState 序：9 = catalog）。
  if (opts.catalog !== undefined) overrides[9] = opts.catalog;
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

test("g-490 判据6：未配置口径诚实——两键显示「默认：human」并同屏标注来源，其余四键只显示「未配置：保持既有指导」", () => {
  const src = readModal();
  const { zh, en } = loadClientI18n();
  assert.equal(zh["settings.automationDefaultPrefix"], "默认：", "zh 默认值前缀键必须存在");
  assert.equal(en["settings.automationDefaultPrefix"], "Default: ", "en 默认值前缀键必须存在（对称）");
  assert.equal(zh["settings.automationUnsetKeep"], "未配置：保持既有指导", "zh 未配置口径键必须存在（权威口径逐字）");
  assert.equal(en["settings.automationUnsetKeep"], "Unset: keeps the existing guidance", "en 未配置口径键必须存在（对称）");
  for (const k of AUTOMATION_SCOPE_KEYS) {
    const gate = AUTOMATION_UNSET_SCOPE[k].gate_scope;
    assert.ok(zh["settings.gateScope." + gate], `zh 必须本地化 gate 名：${gate}`);
    assert.ok(en["settings.gateScope." + gate], `en 必须本地化 gate 名：${gate}`);
    assert.doesNotMatch(en["settings.gateScope." + gate], /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/, `en gate 名不得含 CJK：${gate}`);
  }
  assert.doesNotMatch(en["settings.automationUnsetKeep"] + en["settings.automationDefaultScopeNotePrefix"] + en["settings.automationDefaultScopeNoteSuffix"], /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/, "en 未配置口径与来源标注不得含 CJK");
  // 客户端不得硬编码 human/ai 的键级副本（唯一真源是服务端下发的 automation_unset_scope）
  for (const k of AUTOMATION_KEYS) {
    assert.doesNotMatch(src, new RegExp(`${k}\\s*:\\s*"(human|ai)"`), `客户端不得硬编码 ${k} 的键级 human/ai`);
  }
  assert.doesNotMatch(src, /automationDefaultPrefix"\)\s*\+\s*"human"/, "客户端不得把「默认：human」写死（取值必须来自服务端的 gate_requires）");
  assert.doesNotMatch(src, /\b(engineDefaults|AUTOMATION_DEFAULTS|automation_defaults)\b/, "客户端不得再引用「解析默认值」命名（口径已改判为来源引用）");
  assert.match(src, /const automationUnsetScope = form\.automation_unset_scope \?\? \{\};/, "口径来源只能取自服务端下发的 automation_unset_scope");
  // 保存后回填必须保留该展示元数据（否则保存一次后退回「未配置：保持既有指导」，属显示层退化）
  assert.match(src, /setForm\(data\.config\s*\n?\s*\? \{ \.\.\.data\.config, automation_unset_scope: data\.automation_unset_scope \?\? form\.automation_unset_scope \}/, "POST 回填必须保留 automation_unset_scope（显示层不得因保存而退化）");

  // 未配置态：两键 ⇒ 「默认：human」+ 同屏来源；其余四键 ⇒ 唯一「保持既有指导」
  const formUnset = JSON.parse(JSON.stringify(SNAPSHOT));
  formUnset.supervisor.automation = {};
  formUnset.automation_unset_scope = JSON.parse(JSON.stringify(AUTOMATION_UNSET_SCOPE));
  const unset = renderModal(src, formUnset, zh, { tab: "supervisor" });
  for (const k of AUTOMATION_KEYS) {
    const row = automationRow(unset.nodes, k);
    assert.ok(row, `必须能定位自动化键 ${k} 的行`);
    assert.equal(row.select.props.value, "", `${k} 未配置时 select 必须停在占位项（值为空串）`);
    const placeholder = deepTextOf(row.select.children[0]);
    assert.notEqual(placeholder, zh["common.none"], `${k} 未配置时不得再显示「无」（无信息的空对话术已废弃）`);
    if (AUTOMATION_SCOPE_KEYS.includes(k)) {
      const scope = AUTOMATION_UNSET_SCOPE[k];
      assert.equal(placeholder, zh["settings.automationDefaultPrefix"] + scope.gate_requires, `${k} 未配置时必须显示「默认：<该 gate 的既有要求>」`);
      assert.ok(row.note, `${k} 出现具体 human/ai ⇒ 必须**同屏**渲染口径来源标注`);
      const note = deepTextOf(row.note);
      for (const [needle, why] of [
        ["《主管指南》", "须点明来源权威文档"],
        [zh["settings.gateScope." + scope.gate_scope], `须点明所属 gate「${zh["settings.gateScope." + scope.gate_scope]}」`],
        ["非引擎解析默认值", "须声明这不是引擎解析默认值"],
        ["沿用既有指导", "须与 `(?)` 提示的「未配置 = 沿用既有指导」同口径"],
        ["需负责人确认", "须说明该动作仍在该人工 gate 范围内"],
      ] as Array<[string, string]>) {
        assert.ok(note.includes(needle), `${k} 的口径来源标注${why}：${note}`);
      }
    } else {
      assert.equal(placeholder, zh["settings.automationUnsetKeep"], `${k} 不对应任何 gate ⇒ 未配置时只能显示「未配置：保持既有指导」`);
      assert.ok(!HUMAN_AI_RE.test(placeholder), `${k} 的未配置文案不得出现任何 human/ai`);
      assert.equal(row.note ?? null, null, `${k} 无对应 gate 范围 ⇒ 不得伪造口径来源标注`);
    }
  }

  // 已配置态：select 显示当前值；未配置项口径不因已配置而变形（占位项不丢、不换口径）
  const formSet = JSON.parse(JSON.stringify(SNAPSHOT));
  formSet.supervisor.automation = Object.fromEntries(AUTOMATION_KEYS.map((k) => [k, AUTOMATION_UNSET_SCOPE[k] ? "ai" : "human"]));
  formSet.automation_unset_scope = JSON.parse(JSON.stringify(AUTOMATION_UNSET_SCOPE));
  const set = renderModal(src, formSet, zh, { tab: "supervisor" });
  for (const k of AUTOMATION_KEYS) {
    const row = automationRow(set.nodes, k);
    assert.ok(row, `必须能定位自动化键 ${k} 的行（已配置）`);
    assert.equal(row.select.props.value, formSet.supervisor.automation[k], `${k} 已配置时必须显示当前值`);
    const want = AUTOMATION_SCOPE_KEYS.includes(k)
      ? zh["settings.automationDefaultPrefix"] + AUTOMATION_UNSET_SCOPE[k].gate_requires
      : zh["settings.automationUnsetKeep"];
    assert.equal(deepTextOf(row.select.children[0]), want, `${k} 已配置时占位项口径不变（占位项不丢）`);
  }

  // 旧服务端（缺 automation_unset_scope）：六键一律「未配置：保持既有指导」，绝不伪造 human/ai
  const formLegacy = JSON.parse(JSON.stringify(SNAPSHOT));
  formLegacy.supervisor.automation = {};
  const legacy = renderModal(src, formLegacy, zh, { tab: "supervisor" });
  for (const k of AUTOMATION_KEYS) {
    const row = automationRow(legacy.nodes, k);
    assert.ok(row, `必须能定位自动化键 ${k} 的行（缺 automation_unset_scope）`);
    assert.equal(deepTextOf(row.select.children[0]), zh["settings.automationUnsetKeep"], `缺 automation_unset_scope 时必须退化为「未配置：保持既有指导」（不得伪造 human/ai）：${k}`);
    assert.equal(row.note ?? null, null, `缺 automation_unset_scope 时不得渲染来源标注：${k}`);
  }

  // en 侧同口径（gate 要求来自服务端，gate 名走本地化，非硬编码中文/固定 human）
  const enUnset = renderModal(src, formUnset, en, { tab: "supervisor" });
  const enScope = automationRow(enUnset.nodes, "release");
  assert.ok(enScope, "必须能定位自动化键 release 的行（en）");
  assert.equal(deepTextOf(enScope.select.children[0]), en["settings.automationDefaultPrefix"] + AUTOMATION_UNSET_SCOPE.release.gate_requires, "en 侧两键同样显示「Default: human」");
  assert.ok(deepTextOf(enScope.note).includes("Supervisor Guide") && deepTextOf(enScope.note).includes(en["settings.gateScope.release"]), "en 侧同屏标注口径来源（含本地化 gate 名）");
  const enKeep = automationRow(enUnset.nodes, "rework");
  assert.equal(deepTextOf(enKeep.select.children[0]), en["settings.automationUnsetKeep"], "en 侧其余四键只显示未配置口径");
  assert.ok(!HUMAN_AI_RE.test(deepTextOf(enKeep.select.children[0])), "en 侧其余四键的未配置文案不得出现 human/ai");
});

/** 在渲染树里定位「自动化键 k」那一行：行内同时含 select 与仅含键名的标签容器。
 *  标签容器是 `h("div", …, h("label", …, k), settingsHintIcon(…))` ⇒ 其递归文本为 `k + "(?)"`，
 *  故用 includes 判定；键名之间无子串关系（逐个核对过），不会互相误配。
 *  `note` = 该行的**同屏口径来源标注**节点（`dg-settings-automation-scope-note`，无则 null）。 */
function automationRow(nodes: any[], k: string): { select: any; note?: any } | null {
  for (const n of nodes) {
    if (n.type !== "div") continue;
    const kids = n.children ?? [];
    const sel = kids.find((c: any) => c?.type === "select");
    if (!sel) continue;
    const labelled = kids.some((c: any) => c?.type !== "select" && deepTextOf(c).includes(k));
    if (labelled) return { select: sel, note: kids.find((c: any) => String(c?.props?.className ?? "") === "dg-settings-automation-scope-note") };
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

// ========== 判据 7（扩写）：常驻平铺说明折叠 ==========

/** 目录**就绪**态夹具（`catalog.status === "ready"` ⇒ 渲染就绪说明的 `(?)`；空 providers/groups 即可）。 */
const READY_CATALOG = { status: "ready", providers: [], groups: [] };

test("g-490 判据7（扩写）：editHint / catalogReady 折叠进 (?)——正文零残留、浮层正文 ≡ i18n 原文、目录态门控不撒谎", () => {
  const src = readModal();
  const { zh } = loadClientI18n();
  const idFor = extractFn(src, "const settingsHintIdFor = (text) => {", "\n    };", "settingsHintIdFor");
  // ① 已折叠清单：源码层「恰好一处 `(?)`」+ 常驻正文零残留（谓词与负向对照同源）
  for (const { key, site } of FOLDED_HINT_KEYS) {
    assert.deepEqual(foldedHintProblems(src, key), [], `已折叠项 ${key}（落点：${site}）`);
  }
  assert.deepEqual(editHintSiteProblems(src), [], "editHint 的 `(?)` 必须挂在 project.yaml 行内");
  // ② 仍留正文清单：未被悄悄折叠、且仍在界面里（零丢失）
  for (const { key, why } of FLAT_BODY_KEEP_KEYS) {
    assert.equal(countOccurrences(src, `settingsHintIcon(dgT("${key}"))`), 0, `仍留正文项 ${key} 不得折叠（理由：${why}）`);
    assert.ok(countOccurrences(src, `dgT("${key}")`) >= 1, `仍留正文项 ${key} 不得从界面消失`);
  }
  // ③ 渲染树（关闭态）：触发器保留说明全文（aria-label）；常驻正文里**找不到**该全文（已折叠）
  const closed = renderModal(src, SNAPSHOT, zh, { tab: "executor" });
  const editText = zh["settings.editHint"];
  const editTriggers = closed.nodes.filter((n) => n.props?.["aria-label"] === editText);
  assert.equal(editTriggers.length, 1, "`(?)` 触发器必须保留 editHint 全文（aria-label，零信息丢失）");
  assert.equal(editTriggers[0].props.className, "dg-settings-hint", "该触发器必须是 `(?)` 图标本体");
  assert.ok(!closed.nodes.map((n) => deepTextOf(n)).join("\n").includes(editText), "关闭态常驻正文不得出现 editHint（须仅在 `(?)` 浮层内）");
  // ④ 渲染树（展开态）：浮层正文 ≡ i18n 原文（逐字）
  const opened = renderModal(src, SNAPSHOT, zh, { tab: "executor", openHint: idFor(editText) });
  const pops = opened.nodes.filter((n) => n.props?.role === "tooltip");
  assert.equal(pops.length, 1, "展开态恰好一个浮层（至多一个）");
  assert.equal(deepTextOf(pops[0]), editText, "折叠后浮层正文必须与 i18n 真源逐字一致（信息零丢失、不得悄悄改字）");
  // 「≡」断言必须有牙（非空对照）：折叠文案改字后，同一断言必须不再成立
  const mutatedText = editText + "（已简化）";
  const tampered = src.replace('settingsHintIcon(dgT("settings.editHint"))', 'settingsHintIcon(dgT("settings.editHint") + "（已简化）")');
  assert.notEqual(tampered, src, "改字变异必须真的改动源码");
  assert.notDeepEqual(foldedHintProblems(tampered, "settings.editHint"), [], "改字后「恰好经 (?) 承载一次」谓词必须报红");
  const tamperedPop = renderModal(tampered, SNAPSHOT, zh, { tab: "executor", openHint: idFor(mutatedText) })
    .nodes.filter((n) => n.props?.role === "tooltip");
  assert.equal(tamperedPop.length, 1, "改字变异体仍能打开其浮层（对照有效）");
  assert.notEqual(deepTextOf(tamperedPop[0]), editText, "改字后「浮层正文 ≡ i18n 原文」必须判红（断言非空）");
  // ⑤ 目录态门控：非就绪态**不得**渲染就绪说明的 `(?)`（静态 tooltip 会撒谎），降级读数仍在正文
  const unavailable = renderModal(src, SNAPSHOT, zh, { tab: "executor", catalog: { status: "unavailable" } });
  assert.equal(unavailable.nodes.filter((n) => n.props?.["aria-label"] === zh["settings.catalogReady"]).length, 0, "目录非就绪态不得渲染就绪说明的 `(?)`");
  assert.ok(unavailable.nodes.map((n) => deepTextOf(n)).join("\n").includes(zh["settings.catalogUnavailableMsg"]), "目录不可用读数必须留在正文（一眼可见）");
  const loading = renderModal(src, SNAPSHOT, zh, { tab: "executor", catalog: { status: "loading" } });
  assert.equal(loading.nodes.filter((n) => n.props?.["aria-label"] === zh["settings.catalogReady"]).length, 0, "目录加载中态同样不得渲染就绪说明的 `(?)`");
  assert.ok(loading.nodes.map((n) => deepTextOf(n)).join("\n").includes(zh["settings.catalogLoadingMsg"]), "目录加载中读数必须留在正文");
  // ⑥ 就绪态：长句说明进 `(?)`（正文零残留），浮层正文 ≡ i18n 原文
  const ready = renderModal(src, SNAPSHOT, zh, { tab: "executor", catalog: READY_CATALOG });
  const readyText = zh["settings.catalogReady"];
  assert.equal(ready.nodes.filter((n) => n.props?.["aria-label"] === readyText).length, 1, "就绪态必须渲染目录说明的 `(?)`");
  assert.ok(!ready.nodes.map((n) => deepTextOf(n)).join("\n").includes(readyText), "就绪态正文不得再出现目录说明长句");
  const readyPop = renderModal(src, SNAPSHOT, zh, { tab: "executor", catalog: READY_CATALOG, openHint: idFor(readyText) })
    .nodes.filter((n) => n.props?.role === "tooltip");
  assert.equal(readyPop.length, 1, "就绪态展开后恰好一个浮层");
  assert.equal(deepTextOf(readyPop[0]), readyText, "目录说明浮层正文 ≡ i18n 原文");
});

// ========== 引擎真源 ↔ 客户端消费 一致性 ==========

test("g-490 真源一致性：AUTOMATION_UNSET_SCOPE（引擎口径来源）↔ settings API 下发 ↔ schema_hints ↔ 客户端消费", () => {
  const host = readHost();
  const { zh: zh0 } = loadClientI18n();
  const decl = host.slice(host.indexOf("const AUTOMATION_UNSET_SCOPE = {"), host.indexOf("};", host.indexOf("const AUTOMATION_UNSET_SCOPE = {")) + 2);
  const engineScope: Record<string, { gate_scope: string; gate_requires: string }> = new Function(`${decl}\nreturn AUTOMATION_UNSET_SCOPE;`)();
  // ① 引擎表**不是**解析默认值：只登记两键的 gate 范围来源，不增不减（其余四键**没有** human/ai 值）
  assert.deepEqual(Object.keys(engineScope).sort(), [...AUTOMATION_SCOPE_KEYS].sort(), "引擎口径来源表恰含两键（其余四键不得有 human/ai 值）");
  assert.deepEqual(engineScope, AUTOMATION_UNSET_SCOPE, "测试侧登记的口径必须与引擎真源逐字一致（本断言即对账）");
  for (const k of AUTOMATION_SCOPE_KEYS) {
    assert.ok(engineScope[k].gate_scope, `${k} 必须登记所属 gate 的稳定 id（口径来源可追溯）`);
    assert.ok(["human", "ai"].includes(engineScope[k].gate_requires), `${k} 的 gate_requires 必须是该人工 gate 的既有要求`);
    assert.ok(zh0[`settings.gateScope.${engineScope[k].gate_scope}`], `${k} 的 gate id 必须有本地化展示名：${engineScope[k].gate_scope}`);
  }
  for (const k of AUTOMATION_KEEP_GUIDANCE_KEYS) {
    assert.ok(!(k in engineScope), `${k} 不对应任何 gate ⇒ 引擎表不得登记它的任何 human/ai 值`);
  }
  // ② 权威注释不回退：仍然明说「不是一一映射」，且口径来源不得被写成「键 = gate」
  assert.match(host, /六键与四类人工 gate \*\*不是一一映射\*\*/, "权威注释（六键 ≠ 四类 gate）不得回退");
  assert.match(host, /\*\*弱\*\*关系/, "口径来源必须自述为「**弱**关系」（不得写成「键 = gate」）");
  assert.doesNotMatch(host, /gate 的对应键/, "不得把键写成「某 gate 的对应键」（弱关系 ≠ 等同；旧自推注释回退即红）");
  assert.doesNotMatch(host, /AUTOMATION_DEFAULTS|automation_defaults/, "「解析默认值」命名必须整体消失（engine/下发/schema_hints）");
  assert.match(host, /\*\*不是\*\*引擎解析默认值/, "引擎必须显式声明该表**不是**引擎解析默认值（诚实口径）");
  assert.doesNotMatch(host, /时的解析默认值|解析默认值 —— \*\*单一真源\*\*/, "引擎不得再自称存在「解析默认值」");
  // ③ 下发：GET / POST 两个响应都必须带上该字段（缺一个 ⇒ 打开面板/保存后行为不一致）
  assert.equal(countOccurrences(host, "automation_unset_scope: AUTOMATION_UNSET_SCOPE"), 2, "GET 与 POST 响应必须都下发 automation_unset_scope");
  assert.equal(countOccurrences(host, "unset_scope: AUTOMATION_UNSET_SCOPE,"), 1, "schema_hints 必须复用同一真源（不复制一份字面量）");
  // ④ 引擎不得把「默认值」写进配置本体（读侧仍返回 null ⇒ 既有 deepEqual 契约与「未配置保持既有指导」语义不变）
  const modal = readModal();
  assert.doesNotMatch(modal, /scope_planning: "human"/, "客户端不得内联六键 human/ai 字面量");
  assert.doesNotMatch(modal, /automation_unset_scope:\s*\{\s*scope_planning/, "客户端不得内联口径来源表");
});

// ========== 末节：hermetic 负向对照（在内存副本上变异，逐项都必须「改坏即红」） ==========

/** 各判据的契约检查（同一组谓词同时用于正向与负向：正向必须无问题、变异体必须报出问题）。
 *  判据 6（未配置口径）的谓词含**两条新增负例**：①未配置文案出现无来源的具体 human/ai ⇒ 报红；
 *  ②把「保持既有指导」渲染成 human/ai ⇒ 报红。 */
/** 判据 7（扩写）：给定 i18n 键的说明文案「**只经 `(?)` 浮层承载一次、常驻正文零残留**」不变式
 *  （正向与负向对照共用同一组谓词）。常驻正文渲染面 = 作为 `h(...)` 的**子节点实参**直接渲染
 *  （`…, dgT("key"))`）、作为三元分支直接渲染（`? / : dgT("key")`），或既有专用平铺行形状。 */
function foldedHintProblems(modalSrc: string, key: string): string[] {
  const problems: string[] = [];
  const esc = key.replace(/\./g, "\\.");
  const call = `settingsHintIcon(dgT("${key}"))`;
  const n = countOccurrences(modalSrc, call);
  if (n !== 1) problems.push(`判据7：${key} 必须恰好经 (?) 承载一次（零丢失且不重复），实得 ${n} 次`);
  if (new RegExp(`,\\s*dgT\\("${esc}"\\)\\)`).test(modalSrc) || new RegExp(`[?:]\\s*dgT\\("${esc}"\\)`).test(modalSrc)) {
    problems.push(`判据7：${key} 不得出现在常驻正文渲染面（须仅在 (?) 浮层内）`);
  }
  if (modalSrc.includes(`h("div", { style: S.meta }, dgT("${key}"))`)) {
    problems.push(`判据7：${key} 不得作为常驻平铺行渲染（须仅在 (?) 浮层内）`);
  }
  return problems;
}

/** 判据 7（扩写）：`editHint` 的 `(?)` 必须落在 `projectYamlRow` 定义块内（不孤挂在标题旁、不下沉正文）。 */
function editHintSiteProblems(modalSrc: string): string[] {
  const problems: string[] = [];
  const rowAt = modalSrc.indexOf("const projectYamlRow = configFile");
  const rowEndAt = rowAt >= 0 ? modalSrc.indexOf(": null;", rowAt) : -1;
  const iconAt = modalSrc.indexOf('settingsHintIcon(dgT("settings.editHint"))');
  if (rowAt < 0 || rowEndAt < 0) problems.push("判据7：找不到 project.yaml 行定义块");
  else if (iconAt < 0 || !(iconAt > rowAt && iconAt < rowEndAt)) {
    problems.push("判据7：editHint 的 (?) 必须挂在 project.yaml 行内（不得移出该行或下沉正文）");
  }
  return problems;
}

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
  // ---- 判据 6：未配置口径诚实（两键可显示「默认：human」但必须同屏标注来源；其余四键不得出现 human/ai）----
  for (const k of AUTOMATION_KEYS) {
    if (new RegExp(`${k}\\s*:\\s*"(human|ai)"`).test(modalSrc)) problems.push(`判据6：客户端硬编码了 ${k} 的键级 human/ai`);
  }
  const form = unsetAllAutomation();
  const tree = renderModal(modalSrc, form, zh, { tab: "supervisor" });
  for (const k of AUTOMATION_KEYS) {
    const row = automationRow(tree.nodes, k);
    if (!row) { problems.push(`判据6：找不到自动化键 ${k} 的行`); continue; }
    const placeholder = deepTextOf(row.select.children[0]);
    const note = row.note ? deepTextOf(row.note) : "";
    if (AUTOMATION_SCOPE_KEYS.includes(k)) {
      const scope = AUTOMATION_UNSET_SCOPE[k];
      const want = zh["settings.automationDefaultPrefix"] + scope.gate_requires;
      if (placeholder !== want) problems.push(`判据6：${k} 未配置时未显示「${want}」，实得「${placeholder}」`);
      if (!note) problems.push(`判据6：${k} 的「${want}」无口径来源标注（未配置文案出现无来源的具体 human/ai）`);
      else {
        for (const [needle, why] of [
          ["《主管指南》", "未点明来源权威文档"],
          [zh["settings.gateScope." + scope.gate_scope], `未点明所属 gate「${zh["settings.gateScope." + scope.gate_scope]}」`],
          ["非引擎解析默认值", "未声明这不是引擎解析默认值"],
          ["沿用既有指导", "与 `(?)` 提示的「未配置 = 沿用既有指导」口径不一致"],
        ] as Array<[string, string]>) {
          if (!note.includes(needle)) problems.push(`判据6：${k} 的口径来源标注${why}`);
        }
      }
    } else {
      const want = zh["settings.automationUnsetKeep"];
      if (placeholder !== want) problems.push(`判据6：${k} 无对应 gate，未配置时未显示「${want}」，实得「${placeholder}」`);
      if (HUMAN_AI_RE.test(placeholder) || HUMAN_AI_RE.test(note)) {
        problems.push(`判据6：${k} 无对应 gate，未配置文案不得出现任何 human/ai（实得「${placeholder}${note}」）`);
      }
      if (note) problems.push(`判据6：${k} 无对应 gate，不得伪造口径来源标注`);
    }
  }
  // ---- 判据 4：project.yaml 行在标题栏右侧、页脚无残留 ----
  const rendered = renderModal(modalSrc, SNAPSHOT, zh, { tab: "executor" });
  const titleBar = rendered.nodes.find(
    (n) => n.type === "div" && (n.children ?? []).some((c: any) => String(c?.props?.className ?? "") === "dg-settings-configfile"),
  );
  if (!titleBar || !deepTextOf(titleBar).includes("/abs/path/project.yaml")) problems.push("判据4：project.yaml 行不在标题栏（可能被搬回页脚）");
  const footer = rendered.nodes.find((n) => n.type === "div" && (n.children ?? []).some((c: any) => deepTextOf(c) === zh["settings.closeBtn"]));
  if (footer && deepTextOf(footer).includes("/abs/path/project.yaml")) problems.push("判据4：页脚仍残留 project.yaml（迁移≠复制）");
  // ---- 判据 7（扩写）：常驻平铺说明折叠 + project.yaml 行内 `(?)` 落点 ----
  for (const { key } of FOLDED_HINT_KEYS) problems.push(...foldedHintProblems(modalSrc, key));
  problems.push(...editHintSiteProblems(modalSrc));
  for (const { key, why } of FLAT_BODY_KEEP_KEYS) {
    if (countOccurrences(modalSrc, `settingsHintIcon(dgT("${key}"))`) !== 0) {
      problems.push(`判据7：${key} 属「仍留正文」清单（${why}），不得折叠进 (?)`);
    }
    if (countOccurrences(modalSrc, `dgT("${key}")`) < 1) {
      problems.push(`判据7：${key} 在「仍留正文」清单里却已从界面消失（信息丢失）`);
    }
  }
  return problems;
}

const unsetAllAutomation = () => {
  const f: any = JSON.parse(JSON.stringify(SNAPSHOT));
  f.supervisor.automation = {};
  f.automation_unset_scope = JSON.parse(JSON.stringify(AUTOMATION_UNSET_SCOPE));
  return f;
};

test("g-490 改坏即红：各判据契约在内存变异下逐项报红（含两条未配置口径新增负例），且真实源文件零改动", () => {
  const before = readFileSync(modalPath, "utf8");
  const { zh } = loadClientI18n();
  assert.deepEqual(presentationProblems(before, zh), [], "正向：真实源码各判据契约必须全部成立（谓词本身不作假红）");

  const mutants: Array<{ name: string; src: string; expect: RegExp }> = [
    { name: "回退原生 title", src: before.replace('"aria-label": text', "title: text"), expect: /回退原生 title/ },
    { name: "删掉浮层语义 role=tooltip", src: before.replace('role: "tooltip"', 'role: "note"'), expect: /缺少浮层语义/ },
    { name: "删掉悬停显示", src: before.replace(/onMouseEnter: \(e\) => \{[^}]*\},/, ""), expect: /缺少悬停显示/ },
    { name: "删掉浮层状态（不再至多一个）", src: before.replace("const [openHint, setOpenHint] = React.useState(null)", "const openHint = null"), expect: /缺少唯一浮层状态/ },
    { name: "生效值退回弱化文本（去边框）", src: before.replace('border: "1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4))",', ""), expect: /生效值缺边框/ },
    { name: "生效值退回弱化文本（加 opacity）", src: before.replace('fontSize: 11, marginTop: 2, padding: "3px 7px", borderRadius: 4, display: "block",', 'fontSize: 11, marginTop: 2, padding: "3px 7px", borderRadius: 4, display: "block", opacity: 0.65,'), expect: /生效值带 opacity/ },
    { name: "未配置键不显示口径来源默认值", src: before.replace("automationOptions(auto[k], automationUnsetScope[k] ?? null)", "automationOptions(auto[k], null)"), expect: /未配置时未显示/ },
    { name: "客户端硬编码键级 human/ai 副本", src: before.replace("const automationUnsetScope = form.automation_unset_scope ?? {};", 'const automationUnsetScope = form.automation_unset_scope ?? {};\n      const HARDCODED = { scope_planning: "human" };'), expect: /硬编码了 scope_planning/ },
    // g-490 负例①：抽掉同屏口径来源标注 ⇒ 未配置文案里出现**无来源**的具体 human/ai
    { name: "未配置文案出现无来源的具体 human/ai", src: before.replace("automationUnsetScope[k] ? automationUnsetScopeNote(automationUnsetScope[k]) : null", "null"), expect: /无口径来源标注/ },
    // g-490 负例②：把「保持既有指导」渲染成 human/ai（无 gate 范围的键不得出现任何 human/ai）
    { name: "把「保持既有指导」渲染成 human/ai", src: before.replace('unsetScope ? dgT("settings.automationDefaultPrefix") + unsetScope.gate_requires : dgT("settings.automationUnsetKeep")', 'dgT("settings.automationUnsetKeep") + " (human)"'), expect: /不得出现任何 human\/ai/ },
    { name: "project.yaml 行搬离标题栏", src: before.replace("            projectYamlRow),\n", "            ),\n"), expect: /不在标题栏/ },
    // g-490 判据 7（扩写）负例①：editHint 改回**常驻平铺**渲染 ⇒ 必红（说明必须只经 `(?)` 承载）
    { name: "editHint 改回常驻平铺", src: before.replace('settingsHintIcon(dgT("settings.editHint"))', 'h("span", { style: S.meta }, dgT("settings.editHint"))'), expect: /不得出现在常驻正文渲染面/ },
    // g-490 判据 7（扩写）负例②：`(?)` 移出 project.yaml 行（孤挂在标题旁）⇒ 必红
    { name: "editHint 的 (?) 移出 project.yaml 行", src: before.replace('settingsHintIcon(dgT("settings.editHint"))', "null").replace("            projectYamlRow),\n", "            projectYamlRow),\n          settingsHintIcon(dgT(\"settings.editHint\")),\n"), expect: /必须挂在 project.yaml 行内/ },
    // g-490 判据 7（扩写）负例③：目录就绪说明改回常驻平铺 ⇒ 必红
    { name: "目录就绪说明改回常驻平铺", src: before.replace('catReady ? settingsHintIcon(dgT("settings.catalogReady")) : null', 'catReady ? dgT("settings.catalogReady") : null'), expect: /不得出现在常驻正文渲染面/ },
    // g-490 判据 7（扩写）负例④：把「仍留正文」的必读警示（reviewUnsetHint）悄悄折叠 ⇒ 必红
    { name: "必读警示 reviewUnsetHint 被悄悄折叠", src: before.replace('h("div", { style: metaStyle }, dgT("settings.reviewUnsetHint")),', 'settingsHintIcon(dgT("settings.reviewUnsetHint")),'), expect: /属「仍留正文」清单/ },
  ];
  assert.ok(mutants.length >= 15, `变异负向对照只增不减（实得 ${mutants.length} 项：11 项既有 + 4 项判据 7 扩写新增）`);
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
