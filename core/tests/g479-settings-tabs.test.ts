/**
 * g-479 判据机器断言：workspace 看板设置弹窗（settings-modal.js）改为**分类页签**结构。
 *
 * 覆盖质量判据 1–4：
 *  1. 结构：页签集合与「配置项 → 页签」归属表同源，且**每个配置项恰好归属一个页签**——
 *     漏项（新增控件忘了登记 / 表里删了一项）与重复（同一项挂两个页签、同一键写两遍）都必须判红；
 *     归属不靠自证：每个配置项在测试侧登记**源码锚点**，锚点必须唯一出现、且必须落在其页签的面板
 *     源码区间内（把控件搬出该页签、复制到别的页签、或删掉控件都会越界/失配 ⇒ 红）。
 *  2. 可达/可编辑：真实渲染树里每个配置项的控件都在（整棵树上找得到，与当前激活页签无关），
 *     值来自同一 form 草稿 ⇒ 跨页签编辑共享同一份草稿（不丢编辑）。
 *  3. 页签行为：每个页签恰有一个面板、默认只显示默认页签的面板；点页签按钮只切 activeTab，
 *     不触发 onClose。
 *  4. i18n：新键 zh/en 齐备、键集对称、en 侧零 CJK。
 *
 * g-488 追加（同一套件的第 5 节，与上列判据同口径）：
 *  5. 说明性文字 tooltip 化：`(?)` 由 `settingsHintIcon` **唯一构造点**产出、键盘可达（tabIndex=0）、
 *     语义可读（role="img" + aria-label 与 title 同为说明全文）；六键自动化**逐键**一条说明；搬进
 *     tooltip 的说明**零丢失**（都能在渲染树的 title/aria-label 通道里找到）。原「显示/隐藏高级设置」
 *     折叠按钮与 `showAdvanced` 派生开关已删除 ⇒ 原正向断言一律换成**等价负向断言**（键/表达式/按钮
 *     class 都不得再出现）+ 恒显结构断言。
 *
 * 「改坏即红」：末节是 hermetic 负向对照——在**内存中的副本源码**上做变异（搬走页签面板 / 删归属项 /
 * 跨页签重复登记 / 删标签键 / 搬走控件 / 破坏 `(?)` 契约），同一套检查函数必须报出问题，并断言真实
 * 仓库文件逐字未变。
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

const readModal = (): string => readFileSync(modalPath, "utf8");
const readI18n = (): string => readFileSync(i18nPath, "utf8");

type Dict = Record<string, string>;
type TabTable = {
  keys: string[];
  labels: Dict;
  items: Record<string, string[]>;
  def: string;
};

const TABLE_START = "const SETTINGS_TAB_KEYS = [";
const MODAL_START = "function SettingsModal(";
const FOOTER_ANCHOR = 'h("div", { style: { display: "flex", gap: 8, alignItems: "center", marginTop: 6 } },';
// g-488：页签栏锚点用**映射表达式本身**（不含尾随逗号）——原锚点带尾随逗号，是「映射之后还挂着
// 「显示/隐藏高级设置」按钮」这一旧形状的产物；按钮删除后表达式仍必须**恰好出现一次**（唯一真源），
// 断言强度不降（两种形状都能命中）。
const TABBAR_ANCHOR = "...SETTINGS_TAB_KEYS.map((k) => tabButton(k))";

/** g-479：需要归属的唯一 i18n 新键（页签栏 aria + 页签标签 + 本地偏好如实标注）。
 *  g-480 新增「模块」页签 ⇒ 标签键与源码真源同步扩展（只增不减）。
 *  g-488 删除「关于」页签 ⇒ `settings.tab.about` 退出清单（其标签键已从 i18n 双语删除）。 */
const TAB_I18N_KEYS = [
  "settings.tabsAria",
  "settings.tab.executor",
  "settings.tab.review",
  "settings.tab.ui",
  "settings.tab.modules",
  "settings.tab.advanced",
  "settings.tabLocalNote",
];

/** 配置项 → 源码锚点（测试侧真源，**不**从被测文件抄）。锚点必须全文件唯一，
 *  且必须落在该配置项所属页签的面板源码区间内；共享实现的锚点（三列表 / 六键自动化）由同一锚点
 *  覆盖多项——它们同属一个页签，唯一性断言因此等价于「这一处实现只属于一个页签」。 */
const REVIEW_LIST_ANCHOR = "...REVIEW_LIST_KEYS.map((key) => reviewListField(key))";
const AUTOMATION_ANCHOR = 'set(["supervisor", "automation", k], e.target.value === "" ? null : e.target.value)';
/** g-480：五个模块开关的共享渲染锚点（映射行内的唯一写入点）。 */
const MODULE_SWITCH_ANCHOR = 'onChange: (e) => set(["modules", k], e.target.checked)';
const KEY_ANCHORS: Record<string, string> = {
  "executor.provider": "onChange: (e) => onProviderChange(e.target.value)",
  "executor.model": 'set(["executor", "model"], e.target.value)',
  "executor.reasoning_effort": 'set(["executor", "reasoning_effort"], e.target.value)',
  "executor.mode": 'set(["executor", "mode"], e.target.value)',
  "review.policy": 'set(["review", "policy"], e.target.value)',
  "review.regions": REVIEW_LIST_ANCHOR,
  "review.contract_paths": REVIEW_LIST_ANCHOR,
  "review.non_product_prefixes": REVIEW_LIST_ANCHOR,
  "supervisor.agent_teams": 'set(["supervisor", "agent_teams"], e.target.checked)',
  "local.refresh_interval": "onChange: (e) => handleIntervalChange(e.target.value)",
  "local.live_display": "setLiveDisplay(e.target.checked)",
  // g-488：`defaults.review.reviewer` / `defaults.review.prompt` / `defaults.pk.lanes` /
  // `defaults.pk.sandbox` 四项**只从界面移除**（配置读兼容保留）⇒ 不再登记页签归属，其源码锚点
  // 也随之下架；「界面里确实没有这四个控件」与「归一/稀疏 patch 叶子清单仍在」由判据 1 的等价
  // 负向 + 正向断言钉住（见 §1 的 g-488 段）。
  "supervisor.automation.scope_planning": AUTOMATION_ANCHOR,
  "supervisor.automation.integration_decision": AUTOMATION_ANCHOR,
  "supervisor.automation.rework": AUTOMATION_ANCHOR,
  "supervisor.automation.memory_promotion": AUTOMATION_ANCHOR,
  "supervisor.automation.skill_proposal": AUTOMATION_ANCHOR,
  "supervisor.automation.release": AUTOMATION_ANCHOR,
  "prompt_overrides.subagent": 'promptOverride("subagent", dgT("settings.subagentPrompt"))',
  // g-488：`config.project_yaml` 不再是「页签归属的配置项」——「关于」页签已删，它是**只读展示**，
  // 迁到弹窗页脚一行（在所有面板区间之外）；其渲染/双语键/页脚位置由 §1 的专门断言钉住。
  // g-480：「模块」页签的五个开关由同一个映射行渲染（与三列表 / 六键自动化同款共享实现）⇒
  // 共享同一锚点；锚点唯一且必须落在 modules 面板内，逐模块的可达性与绑定由 g480 专项用例覆盖。
  "modules.tags": MODULE_SWITCH_ANCHOR,
  "modules.memory": MODULE_SWITCH_ANCHOR,
  "modules.shared_cards": MODULE_SWITCH_ANCHOR,
  "modules.automation_prompts": MODULE_SWITCH_ANCHOR,
  "modules.attachments": MODULE_SWITCH_ANCHOR,
};

/** 六键自动化的键名数组（页签归属之外，还要与**真实**审计过的键名逐个对上）。 */
const AUTOMATION_KEYS = ["scope_planning", "integration_decision", "rework", "memory_promotion", "skill_proposal", "release"];

function countOccurrences(hay: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let at = hay.indexOf(needle);
  while (at >= 0) {
    n += 1;
    at = hay.indexOf(needle, at + needle.length);
  }
  return n;
}

/** 从**真实源码**求值页签归属表（不是测试里另抄一份），使表本身也被守卫。 */
function loadTabTable(modalSrc: string): TabTable {
  const start = modalSrc.indexOf(TABLE_START);
  const end = modalSrc.indexOf(MODAL_START, start);
  assert.ok(start > 0 && end > start, "settings-modal.js 缺少页签归属表（SETTINGS_TAB_KEYS…settings-modal 之内）");
  const sandbox: any = {};
  vm.runInNewContext(
    `${modalSrc.slice(start, end)}\n` +
      `globalThis.__tabs = { keys: SETTINGS_TAB_KEYS, labels: SETTINGS_TAB_LABEL_KEYS, items: SETTINGS_TAB_ITEMS, def: SETTINGS_DEFAULT_TAB };`,
    sandbox,
  );
  return sandbox.__tabs as TabTable;
}

/** 源码里所有**字面量** `set(["a","b"], …)` 的叶子路径（含变量元素的分支由专项断言覆盖）。 */
function literalSetPaths(modalSrc: string): string[] {
  const out: string[] = [];
  const re = /set\(\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(modalSrc)) !== null) {
    const inner = m[1].trim();
    if (!/^"[^"]*"(\s*,\s*"[^"]*")*$/.test(inner)) continue;
    const names = [...inner.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    out.push(names.join("."));
  }
  return out;
}

/** 页签 → 面板源码区间 [start, end)。缺失/重复/顺序漂移都记 problem。 */
function panelRegions(modalSrc: string, keys: string[], problems: string[]): Map<string, [number, number]> {
  const mark = (k: string) => `tabPanel("${k}", [`;
  const order = keys.map((k) => ({ k, at: modalSrc.indexOf(mark(k)), n: countOccurrences(modalSrc, mark(k)) }));
  for (const o of order) {
    if (o.n === 0) problems.push(`页签 ${o.k} 没有对应的面板（缺 tabPanel("${o.k}", [）`);
    else if (o.n > 1) problems.push(`页签 ${o.k} 的面板标记出现 ${o.n} 次（必须恰好 1 个面板）`);
  }
  const seen = order.filter((o) => o.n === 1).sort((a, b) => a.at - b.at);
  const footer = modalSrc.indexOf(FOOTER_ANCHOR);
  const regions = new Map<string, [number, number]>();
  for (let i = 0; i < seen.length; i += 1) {
    const end = i + 1 < seen.length ? seen[i + 1].at : (footer > seen[i].at ? footer : modalSrc.length);
    regions.set(seen[i].k, [seen[i].at, end]);
  }
  const ordered = seen.map((o) => o.k);
  const expected = keys.filter((k) => ordered.includes(k));
  if (ordered.join(",") !== expected.join(",")) {
    problems.push(`页签面板的源码顺序与 SETTINGS_TAB_KEYS 不一致：${ordered.join(",")} ≠ ${expected.join(",")}`);
  }
  return regions;
}

/** 页签结构不变式（真实源码 / 变异副本共用同一套检查 ⇒ 负向对照与正向裁决同口径）。 */
function tabStructureProblems(modalSrc: string, tabs: TabTable): string[] {
  const problems: string[] = [];
  // ① 页签集合与标签键
  if (!Array.isArray(tabs.keys) || tabs.keys.length === 0) problems.push("SETTINGS_TAB_KEYS 为空");
  if (new Set(tabs.keys).size !== tabs.keys.length) problems.push("SETTINGS_TAB_KEYS 有重复页签");
  if (!tabs.keys.includes(tabs.def)) problems.push(`SETTINGS_DEFAULT_TAB=${tabs.def} 不在 SETTINGS_TAB_KEYS 内`);
  for (const k of tabs.keys) if (!tabs.labels?.[k]) problems.push(`页签 ${k} 缺标签键（SETTINGS_TAB_LABEL_KEYS）`);
  const labelKeys = tabs.keys.map((k) => tabs.labels?.[k]);
  if (new Set(labelKeys).size !== labelKeys.length) problems.push("两个页签共用同一标签键（文案不可区分）");
  for (const k of Object.keys(tabs.labels ?? {})) if (!tabs.keys.includes(k)) problems.push(`SETTINGS_TAB_LABEL_KEYS 含未知页签 ${k}`);
  for (const k of Object.keys(tabs.items ?? {})) if (!tabs.keys.includes(k)) problems.push(`SETTINGS_TAB_ITEMS 含未知页签 ${k}`);
  // ② 每个配置项恰好归属一个页签
  const owners = new Map<string, string[]>();
  for (const k of tabs.keys) {
    const items = tabs.items?.[k];
    if (!Array.isArray(items) || items.length === 0) {
      problems.push(`页签 ${k} 没有任何配置项归属（空页签）`);
      continue;
    }
    if (new Set(items).size !== items.length) problems.push(`页签 ${k} 内部有重复配置项`);
    for (const it of items) {
      if (!owners.has(it)) owners.set(it, []);
      owners.get(it)!.push(k);
    }
  }
  for (const [it, own] of owners) {
    if (own.length !== 1) problems.push(`配置项 ${it} 归属 ${own.length} 个页签（必须恰好 1 个）：${own.join("+")}`);
  }
  // ③ 页签栏与面板
  if (countOccurrences(modalSrc, TABBAR_ANCHOR) !== 1) {
    problems.push("页签栏未按唯一真源渲染（…SETTINGS_TAB_KEYS.map((k) => tabButton(k)) 必须恰好出现一次）");
  }
  const regions = panelRegions(modalSrc, tabs.keys, problems);
  // ④ 每个配置项：锚点唯一 + 落在所属页签面板内
  for (const [it, own] of owners) {
    if (own.length !== 1) continue;
    const anchor = KEY_ANCHORS[it];
    if (!anchor) {
      problems.push(`配置项 ${it} 未登记源码锚点（守卫无法验证其页签归属）`);
      continue;
    }
    const n = countOccurrences(modalSrc, anchor);
    if (n !== 1) {
      problems.push(`配置项 ${it} 的源码锚点出现 ${n} 次（必须恰好 1 次）：${anchor}`);
      continue;
    }
    const region = regions.get(own[0]);
    if (!region) continue;
    const at = modalSrc.indexOf(anchor);
    if (!(at >= region[0] && at < region[1])) {
      problems.push(`配置项 ${it} 的控件不在「${own[0]}」页签面板内（被搬走 / 落到别的页签）`);
    }
  }
  // ⑤ 完整性：真实源码写过的字面量叶子路径都必须有归属（新增控件忘了登记 ⇒ 红）
  for (const key of literalSetPaths(modalSrc)) {
    if (!owners.has(key)) problems.push(`源码写入了未登记归属的配置项 ${key}`);
  }
  // ⑥ 六键自动化：键名数组必须与登记项逐个对上
  for (const k of AUTOMATION_KEYS) {
    if (!modalSrc.includes(`"${k}"`)) problems.push(`自动化键名 ${k} 未出现在设置弹窗源码中`);
    if (!owners.has(`supervisor.automation.${k}`)) problems.push(`自动化键 ${k} 未登记配置项归属`);
  }
  return problems;
}

/** g-488：说明性文字 tooltip（`(?)`）契约不变式——真实源码 / 变异副本共用（负向对照同口径）。
 *  ① `(?)` 必须由**唯一构造点** `settingsHintIcon` 产出，且该构造点自带完整可读性契约
 *     （role=img / tabIndex=0 / aria-label=title=说明全文）——scoped span 必须只有 `(?)` 这一个字面量，
 *     说明文字只能走属性通道，不得又内联回正文（否则「tooltip 化」名不副实）；
 *  ② 六键自动化必须**逐键**一条说明映射（漏一键即红），键名与 AUTOMATION_KEYS 逐个对上。 */
function hintContractProblems(modalSrc: string): string[] {
  const problems: string[] = [];
  if (countOccurrences(modalSrc, 'const settingsHintIcon = (text) => h("span", {') !== 1) {
    problems.push("`(?)` 图标必须有且只有一个构造点 settingsHintIcon");
  }
  if (countOccurrences(modalSrc, 'className: "dg-settings-hint"') !== 1) {
    problems.push("`(?)` 图标的 class 必须恰好出现一次（构造点唯一）");
  }
  const contract: Array<[string, string]> = [
    ['role: "img"', "读屏须按「有名字的元素」播报（不是无意义的 (?)）"],
    ["tabIndex: 0", "图标必须键盘可达（可 Tab 聚焦）"],
    ['"aria-label": text', "图标必须有可读名（说明全文）"],
    ["title: text", "图标必须有悬停说明（说明全文）"],
  ];
  for (const [needle, why] of contract) {
    if (countOccurrences(modalSrc, needle) !== 1) {
      problems.push(`\`(?)\` 图标契约缺失或重复：${needle}（${why}）`);
    }
  }
  if (countOccurrences(modalSrc, "}, SETTINGS_HINT_ICON);") !== 1) {
    problems.push("`(?)` 的可视字面量必须恰好一处（SETTINGS_HINT_ICON）");
  }
  if (countOccurrences(modalSrc, "const AUTOMATION_HINT_KEYS = {") !== 1) {
    problems.push("AUTOMATION_HINT_KEYS（六键逐键说明映射）必须恰好定义一次");
  }
  for (const k of AUTOMATION_KEYS) {
    if (!modalSrc.includes(`      ${k}: "settings.automationWhat.${k}",`)) {
      problems.push(`自动化键 ${k} 缺逐键说明映射（AUTOMATION_HINT_KEYS）`);
    }
  }
  return problems;
}

function loadClientI18n(src = readI18n()): { zh: Dict; en: Dict } {  const sandbox: any = { React: {} };
  vm.runInNewContext(`${src}\n;this.zh = zh; this.en = en;`, sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

// ===== 真实渲染（同一 vm 口径，仅替换 React 与 Host 依赖）=====

type Rendered = { tree: any; nodes: any[]; calls: Record<number, any>; closeCalls: () => number };

function renderSettingsModal(modalSrc: string, form: any, zh: Dict, opts: { tab?: string; configFile?: string | null } = {}): Rendered {
  const h = (type: any, props: any, ...children: any[]) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c: any) => c !== null && c !== undefined && c !== false),
  });
  // useState 槽位序（与源码一致）：0 loading, 1 form, 2 saving, 3 note, 4 error, 5 activeTab,
  // 6 configFile, 7 refreshIntervalInput, 8 intervalWarn, 9 catalog, 10 suggestedRegions
  const overrides: any[] = [false, form, false, null, null];
  overrides[5] = opts.tab ?? "executor";
  overrides[6] = opts.configFile === undefined ? "/abs/path/project.yaml" : opts.configFile;
  let idx = 0;
  const calls: Record<number, any> = {};
  let closes = 0;
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
        const v = i < overrides.length ? overrides[i] : (typeof init === "function" ? init() : init);
        return [v, (nv: any) => { calls[i] = nv; }];
      },
      useEffect: () => {},
    },
  };
  const start = modalSrc.indexOf(MODAL_START);
  const normStart = modalSrc.indexOf("function normalizeSettingsDraft(");
  assert.ok(start > 0 && normStart > 0 && normStart < start, "settings-modal.js 缺少归一化段或 SettingsModal");
  vm.runInNewContext(
    `${modalSrc.slice(normStart, start)}\n${modalSrc.slice(start)}\n;this.__SettingsModal = SettingsModal;`,
    sandbox,
  );
  const tree = sandbox.__SettingsModal({ onClose: () => { closes += 1; }, onSaved: () => {} });
  const nodes: any[] = [];
  (function walk(n: any) {
    if (!n || typeof n !== "object") return;
    nodes.push(n);
    for (const c of n.children ?? []) walk(c);
  })(tree);
  return { tree, nodes, calls, closeCalls: () => closes };
}

function textOf(node: any): string {
  return (node?.children ?? []).filter((c: any) => typeof c === "string").join("");
}

const SNAPSHOT = {
  executor: { provider: "prov-a", model: "mod-a", reasoning_effort: "high", mode: "standard" },
  review: { policy: "auto", regions: ["core"], contract_paths: [], non_product_prefixes: [] },
  supervisor: { agent_teams: true, automation: { scope_planning: "human" } },
  defaults: { review: { reviewer: "rev-1", prompt: "prm-1" }, pk: { lanes: 3, sandbox: "sdbx" } },
  prompt_overrides: { subagent: { state: "override", value: "OVERRIDE_TEXT" } },
};

// ===== 判据 1：结构守卫 =====

test("g-479 判据1：设置弹窗改为分类页签——每个配置项恰好归属一个页签（漏项/重复即红）", () => {
  const src = readModal();
  const tabs = loadTabTable(src);
  const problems = tabStructureProblems(src, tabs);
  assert.deepEqual(problems, [], "页签结构不变式必须全绿：\n" + problems.join("\n"));
  // 页签集合非平凡：分类结构真实存在（不是把全部配置项塞进一个页签）
  assert.ok(tabs.keys.length >= 4, `页签数应 ≥4，实得 ${tabs.keys.length}`);
  assert.ok(Object.keys(KEY_ANCHORS).length >= 20, "配置项锚点表应覆盖全部可编辑配置项");
  // 归属表覆盖的配置项数 == 锚点表（测试侧无漏登记）
  const items = tabs.keys.flatMap((k) => tabs.items[k]);
  assert.deepEqual([...items].sort(), Object.keys(KEY_ANCHORS).sort(), "归属表与锚点表必须逐项一致");
  // 模块级真源与渲染实现同源
  assert.match(src, /const SETTINGS_TAB_KEYS = \["executor", "review", "ui", "modules", "advanced"\]/);
  assert.match(src, /const \(activeTab, setActiveTab\) = React\.useState\(SETTINGS_DEFAULT_TAB\)|const \[activeTab, setActiveTab\] = React\.useState\(SETTINGS_DEFAULT_TAB\)/);
  // g-488：原 `showAdvanced` 派生开关 + 「显示/隐藏高级设置」折叠按钮已删除（高级设置本身即页签，
  // 页签内不再有第二层显隐开关）⇒ 原正向断言换成**等价负向断言**（表达式/按钮 class 都不得再出现）
  // + **恒显**结构断言（高级页签内容不因折叠状态被隐藏）。
  assert.equal(countOccurrences(src, 'const showAdvanced = activeTab === "advanced";'), 0, "showAdvanced 派生开关必须已删除");
  assert.equal(countOccurrences(src, 'display: showAdvanced ?'), 0, "不得再有 showAdvanced 显隐三元");
  assert.equal(countOccurrences(src, "dg-settings-advanced-toggle"), 0, "折叠按钮 class 必须已删除");
  assert.ok(
    !/display: (activeTab === "advanced"|showAdvanced)/.test(src),
    "高级页签内容必须恒显（可见性只由页签选择决定）",
  );
  // g-488：四项默认值键**只从界面移除**、配置读兼容保留：不得再有编辑入口，但归一/稀疏 patch 的
  // 叶子清单（`leaf([...])`）必须逐字仍在（不可编辑 ⇒ 恒等于基线 ⇒ 永不出现在 patch，也不会误伤其它键）。
  assert.equal(countOccurrences(src, 'set(["defaults",'), 0, "四项默认值键不得再有界面编辑入口");
  for (const leaf of [
    'leaf(["defaults", "review", "reviewer"]);',
    'leaf(["defaults", "review", "prompt"], (v) =>',
    'leaf(["defaults", "pk", "lanes"]);',
    'leaf(["defaults", "pk", "sandbox"]);',
  ]) {
    assert.ok(src.includes(leaf), `配置读兼容不得丢失叶子：${leaf}`);
  }
  // g-488：「关于」页签删除，配置文件只读展示迁到**页脚一行**——必须在页脚按钮行之后，且不属于
  // 任何页签面板区间（否则「搬到页脚」只是换了说法，实际仍寄生在某个页签里）。
  assert.equal(countOccurrences(src, 'tabPanel("about", ['), 0, "「关于」页签面板必须已删除");
  const yamlAt = src.indexOf('dgT("settings.projectYaml")');
  const footerAt = src.indexOf(FOOTER_ANCHOR);
  assert.ok(yamlAt > 0 && footerAt > 0 && yamlAt > footerAt, "project.yaml 入口必须位于页脚按钮行之后");
  const regionsForFooter = panelRegions(src, tabs.keys, []);
  for (const [k, [s0, e0]] of regionsForFooter) {
    assert.ok(!(yamlAt >= s0 && yamlAt < e0), `project.yaml 入口不得落在「${k}」页签面板内`);
  }
});

// ===== 判据 2：可达 / 可编辑 =====

test("g-479 判据2：真实渲染树里每个配置项的控件都在（与激活页签无关），且绑定同一份 form 草稿", () => {
  const src = readModal();
  const { zh } = loadClientI18n();
  const { nodes } = renderSettingsModal(src, SNAPSHOT, zh, { tab: "executor" });
  const selects = nodes.filter((n) => n.type === "select");
  const byAria = (k: string) => nodes.filter((n) => n.props?.["aria-label"] === zh[k]);
  const byId = (id: string) => nodes.filter((n) => n.props?.id === id);
  const selectByValue = (v: any) => nodes.filter((n) => n.type === "select" && n.props?.value === v);
  const inputByValue = (v: any) => nodes.filter((n) => n.type === "input" && n.props?.value === v);
  const labelTexts = nodes.filter((n) => n.type === "label").map(textOf);

  // 模型与执行（4）
  assert.equal(selectByValue("prov-a").length, 1, "provider 下拉保留已存值");
  assert.equal(selectByValue("mod-a").length, 1, "model 下拉保留已存值");
  assert.equal(byAria("settings.reasoningEffortAria").length, 1, "reasoning_effort 下拉可达");
  assert.equal(selectByValue("high").length, 1, "reasoning_effort 绑定已存值");
  assert.equal(byAria("settings.modeAria").length, 1, "executor.mode 下拉可达");
  // 评审与质量（5）
  assert.equal(byAria("settings.reviewPolicyAria").length, 1, "review.policy 下拉可达");
  assert.equal(selectByValue("auto").length, 1, "review.policy 绑定已存值");
  for (const k of ["settings.reviewRegionsAria", "settings.reviewContractPathsAria", "settings.reviewNonProductPrefixesAria"]) {
    assert.equal(byAria(k).length, 1, `评审条件三列表可达（${k}）`);
  }
  assert.equal(byId("dg-agent-teams").length, 1, "supervisor.agent_teams 开关可达");
  assert.equal(byId("dg-agent-teams")[0].props.checked, true, "agent_teams 绑定已存值");
  assert.ok(labelTexts.includes(zh["settings.agentTeams"]));
  // 界面与刷新（2，本地偏好）
  assert.equal(byId("dg-live-display").length, 1, "live display 开关可达");
  assert.equal(nodes.filter((n) => n.type === "input" && n.props.type === "number" && n.props.min === 5).length, 1, "刷新间隔输入可达");
  // g-488：本地偏好如实标注改用 `(?)` tooltip 承载（正文只留主体）⇒ 断言改走属性通道，仍在树上。
  assert.ok(
    nodes.some((n) => n.props?.["aria-label"] === zh["settings.tabLocalNote"]),
    "本地偏好如实标注必须渲染（g-488 起由 `(?)` tooltip 承载）",
  );
  // 高级（7）
  // g-488：原四个 defaults.* 输入框已下架 ⇒ 等价负向断言（值仍出现在 SNAPSHOT 里，界面不得再渲染它们）。
  assert.equal(inputByValue("rev-1").length, 0, "defaults.review.reviewer 输入必须已从界面移除");
  assert.equal(inputByValue("prm-1").length, 0, "defaults.review.prompt 输入必须已从界面移除");
  assert.equal(inputByValue(3).length, 0, "defaults.pk.lanes 输入必须已从界面移除");
  assert.equal(inputByValue("sdbx").length, 0, "defaults.pk.sandbox 输入必须已从界面移除");
  for (const k of AUTOMATION_KEYS) assert.ok(labelTexts.includes(k), `supervisor.automation.${k} 选择器可达`);
  assert.ok(nodes.some((n) => n.type === "textarea" && n.props.value === "OVERRIDE_TEXT"), "prompt_overrides.subagent 覆盖文本框可达");
  assert.ok(selects.length >= 11, `下拉总数应 ≥11（4 主下拉 + 6 自动化 + 1 评审策略），实得 ${selects.length}`);
  // 页脚（1，g-488：自「关于」页签迁入的**只读**展示——与激活页签无关，恒在树上）
  assert.ok(nodes.some((n) => textOf(n) === zh["settings.projectYaml"]), "project.yaml 标签可达（页脚一行）");
  assert.equal(nodes.filter((n) => n.type === "button" && textOf(n) === zh["tab.openFile"]).length, 1, "打开入口可达");
  assert.equal(nodes.filter((n) => n.type === "button" && textOf(n) === zh["tab.copyPath"]).length, 1, "复制入口可达");
  assert.ok(
    nodes.some((n) => (n.children ?? []).includes("/abs/path/project.yaml")),
    "project.yaml 绝对路径明文展示（仍是 children 字符串，未降级为 tooltip）",
  );
});

// ===== 判据 3：页签行为 =====

test("g-479 判据3：每个页签恰一个面板、默认只显示默认页签、点页签只切 activeTab（不改关闭语义）", () => {
  const src = readModal();
  const { zh } = loadClientI18n();
  const tabs = loadTabTable(src);

  const panelOf = (nodes: any[], k: string) => nodes.filter((n) => String(n.props?.className ?? "").includes(`dg-settings-panel-${k}`));
  for (const tab of tabs.keys) {
    const r = renderSettingsModal(src, SNAPSHOT, zh, { tab });
    for (const k of tabs.keys) {
      const panels = panelOf(r.nodes, k);
      assert.equal(panels.length, 1, `页签 ${k} 应恰有 1 个面板（实得 ${panels.length}）`);
      const shown = panels[0].props.style.display === "block";
      assert.equal(shown, k === tab, `激活页签=${tab} 时面板 ${k} 的可见性应为 ${k === tab}`);
    }
    // 面板一律常驻（不因非激活而消失）⇒ 跨页签编辑共用同一 form
    assert.ok(r.nodes.some((n) => n.props?.id === "dg-agent-teams"), "非激活页签的控件仍在树上（无卸载重挂）");
    // 每个页签按钮都在，且文案来自 i18n
    const tabButtons = r.nodes.filter((n) => n.type === "button" && String(n.props?.className ?? "").includes("dg-settings-tab"));
    assert.equal(tabButtons.length, tabs.keys.length, "页签按钮数应等于页签数");
    for (const k of tabs.keys) {
      assert.equal(tabButtons.filter((b) => textOf(b) === zh[tabs.labels[k]]).length, 1, `页签按钮「${zh[tabs.labels[k]]}」应恰有 1 个`);
    }
    // 点击页签只切 activeTab；不触发关闭
    for (const k of tabs.keys) {
      const btn = tabButtons.find((b) => textOf(b) === zh[tabs.labels[k]])!;
      btn.props.onClick();
      assert.equal(r.calls[5], k, `点击页签 ${k} 应只把 activeTab 切到 ${k}`);
    }
    assert.equal(r.closeCalls(), 0, "切页签不得触发 onClose");
  }

  // 高级（g-488）：内容**恒显**——原 `showAdvanced` 显隐三元已删，故改为「与激活页签无关」断言：
  // 只要在树上，就不得带任何 display 隐藏；且原「显示/隐藏高级设置」按钮与双语键都已下架。
  const advanced = renderSettingsModal(src, SNAPSHOT, zh, { tab: "advanced" });
  const adv = advanced.nodes.filter((n) => n.props?.["aria-label"] === zh["settings.automationHint"]);
  assert.equal(adv.length, 1, "自动化总说明 `(?)` 可达");
  assert.equal(adv[0].props.style.display, undefined, "自动化说明不再受 showAdvanced 显隐三元控制");
  const grid = advanced.nodes.filter((n) => n.props?.style?.gridTemplateColumns === "repeat(2, 1fr)");
  assert.equal(grid.length, 1, "自动化六键网格可达");
  assert.equal(grid[0].props.style.display, "grid", "自动化网格是 grid 布局（layout display，非显隐开关）");
  const other = renderSettingsModal(src, SNAPSHOT, zh, { tab: "review" });
  const advOther = other.nodes.filter((n) => n.props?.["aria-label"] === zh["settings.automationHint"]);
  assert.equal(advOther.length, 1, "非激活页签时高级区内容仍在树上（面板常驻，不卸载）");
  assert.equal(advOther[0].props.style.display, undefined, "非激活页签也不得用 showAdvanced 三元隐藏内容");
  // 关键：非激活页签下网格**依然可见**（旧实现的 showAdvanced 三元在此处会取 "none"）⇒ 恒显已被钉住
  const gridOther = other.nodes.filter((n) => n.props?.style?.gridTemplateColumns === "repeat(2, 1fr)");
  assert.equal(gridOther.length, 1, "非激活页签时自动化网格仍在树上");
  assert.equal(gridOther[0].props.style.display, "grid", "非激活页签时网格 display 仍为 grid（不再被 showAdvanced 置 none）");

  // g-488：折叠按钮与它的双语键都已删除 ⇒ 原「点击在高级 ↔ 默认页签之间切换」的正向用例换成
  // **等价负向断言**（源码 + 渲染树两条腿都不得再出现该按钮）。
  const normal = renderSettingsModal(src, SNAPSHOT, zh, { tab: "executor" });
  const advBtnNodes = (r: Rendered) => r.nodes.filter((n) => String(n.props?.className ?? "").includes("dg-settings-advanced-toggle"));
  assert.equal(advBtnNodes(normal).length, 0, "渲染树上不得再有「显示/隐藏高级设置」按钮");
  assert.equal(advBtnNodes(advanced).length, 0, "高级页签内同样不得再有折叠按钮");
  assert.equal(countOccurrences(src, "dg-settings-advanced-toggle"), 0, "源码不得再有折叠按钮");
  // 页签按钮数仍恒等于页签数（折叠按钮此前混在页签栏里，删除后页签栏必须刚好只有页签）
  const tabButtonsNormal = normal.nodes.filter((n) => n.type === "button" && String(n.props?.className ?? "").includes("dg-settings-tab"));
  assert.equal(tabButtonsNormal.length, tabs.keys.length, "页签栏必须恰好只有页签按钮（无折叠按钮残留）");
  assert.equal(normal.closeCalls() + advanced.closeCalls(), 0, "页签切换不得触发 onClose");
});

// ===== 判据 4：i18n =====

test("g-479 判据4：页签 i18n 键 zh/en 齐备、键集对称、en 零 CJK", () => {
  const { zh, en } = loadClientI18n();
  for (const k of TAB_I18N_KEYS) {
    assert.ok(typeof zh[k] === "string" && zh[k] !== "", `zh 缺键 ${k}`);
    assert.ok(typeof en[k] === "string" && en[k] !== "", `en 缺键 ${k}`);
    assert.doesNotMatch(en[k], /[\u4e00-\u9fff]/, `en 侧不得含中文：${k}`);
    assert.notEqual(en[k], k, `en 侧不得退化为键名：${k}`);
  }
  // 全局键集对称（与 g272/g342 同口径，只增不减）
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  // 标签键与真源一致
  const tabs = loadTabTable(readModal());
  for (const k of tabs.keys) assert.ok(TAB_I18N_KEYS.includes(tabs.labels[k]), `页签 ${k} 的标签键 ${tabs.labels[k]} 未登记在 i18n 清单`);
  // 源码只经 dgT 取文案（不得内联中文）
  assert.match(readModal(), /dgT\(SETTINGS_TAB_LABEL_KEYS\[tabKey\]\)/);
  // g-488：随控件一起下架的键必须在**双语**里一并删除（残留 = 死键，且会掩盖「已删除」的事实）
  for (const k of ["settings.tab.about", "settings.showAdvanced", "settings.hideAdvanced", "settings.pkLanesError"]) {
    assert.equal(k in zh, false, `zh 不得再含已下架键 ${k}`);
    assert.equal(k in en, false, `en 不得再含已下架键 ${k}`);
  }
  // g-488：六键自动化的**逐键**说明键 zh/en 齐备、对称、en 零 CJK、且不退化为键名
  for (const k of AUTOMATION_KEYS) {
    const key = `settings.automationWhat.${k}`;
    assert.ok(typeof zh[key] === "string" && zh[key] !== "", `zh 缺键 ${key}`);
    assert.ok(typeof en[key] === "string" && en[key] !== "", `en 缺键 ${key}`);
    assert.doesNotMatch(en[key], /[\u4e00-\u9fff]/, `en 侧不得含中文：${key}`);
    assert.notEqual(en[key], key, `en 侧不得退化为键名：${key}`);
    assert.notEqual(zh[key], en[key], `zh/en 文案不得逐字相同（未翻译）：${key}`);
    // 「管什么 + human/ai 两种取值的含义」：两种取值都必须被讲到
    assert.match(zh[key], /human/, `zh 说明须讲清 human 的含义：${key}`);
    assert.match(zh[key], /ai/, `zh 说明须讲清 ai 的含义：${key}`);
    assert.match(en[key], /human/, `en 说明须讲清 human 的含义：${key}`);
    assert.match(en[key], /\bai\b/, `en 说明须讲清 ai 的含义：${key}`);
  }
});

// ===== 判据 5（g-488）：说明性文字 tooltip 化 =====

test("g-488 判据5：说明文字 tooltip 化——`(?)` 键盘可达且语义可读、六键逐键说明、零信息丢失", () => {
  const src = readModal();
  const { zh } = loadClientI18n();
  const problems = hintContractProblems(src);
  assert.deepEqual(problems, [], "`(?)` tooltip 契约必须全绿：\n" + problems.join("\n"));

  const { nodes } = renderSettingsModal(src, SNAPSHOT, zh, { tab: "executor" });
  const hints = nodes.filter((n) => String(n.props?.className ?? "").includes("dg-settings-hint"));
  assert.ok(hints.length >= 10, `\`(?)\` 图标应覆盖各小节标题（≥10），实得 ${hints.length}`);
  for (const node of hints) {
    assert.equal(node.props.role, "img", "`(?)` 必须是 role=img（读屏播报其名字而非字面量）");
    assert.equal(node.props.tabIndex, 0, "`(?)` 必须键盘可达");
    assert.equal(typeof node.props["aria-label"], "string", "`(?)` 必须有 aria-label");
    assert.ok(String(node.props["aria-label"]).length > 0, "`(?)` 的 aria-label 不得为空");
    assert.equal(node.props.title, node.props["aria-label"], "title 与 aria-label 必须同为说明全文");
    assert.equal(node.children.length, 1, "`(?)` 只承载可视字面量，说明文字只走属性通道");
    // 说明不得又内联回正文（否则「tooltip 化」名不副实、正文重复）
    assert.equal(typeof node.props["aria-label"], "string");
  }

  // 六键自动化：**逐键**一条说明，且互不相同（不得六键共用一条泛泛而谈）
  for (const k of AUTOMATION_KEYS) {
    const text = zh[`settings.automationWhat.${k}`];
    assert.equal(hints.filter((n) => n.props["aria-label"] === text).length, 1, `自动化键 ${k} 应恰有一个专属 \`(?)\``);
  }
  const automationTexts = AUTOMATION_KEYS.map((k) => zh[`settings.automationWhat.${k}`]);
  assert.equal(new Set(automationTexts).size, automationTexts.length, "六键说明不得互相重复");

  // 零信息丢失：搬进 tooltip 的**每一条**说明都能在渲染树里找到（属性通道），且文案逐字保留
  const titles = hints.map((n) => String(n.props.title));
  const movedKeys = [
    "settings.reviewPolicyHint",
    "settings.reviewConditionsHint",
    "settings.reviewCalibrationGuide",
    "settings.tabLocalNote",
    "settings.minInterval",
    "settings.liveDisabledHint",
    "settings.modulesNote",
    "settings.modulesScopeNote",
    "settings.automationHint",
    "settings.agentTeamsHint",
    "settings.reviewRegionsHint",
    "settings.reviewContractPathsHint",
    "settings.reviewNonProductPrefixesHint",
    "settings.moduleHint.tags",
    "settings.moduleHint.memory",
    "settings.moduleHint.sharedCards",
    "settings.moduleHint.automationPrompts",
    "settings.moduleHint.attachments",
  ];
  for (const key of movedKeys) {
    const text = zh[key];
    assert.ok(typeof text === "string" && text !== "", `缺少待搬迁说明文案：${key}`);
    assert.ok(titles.some((t) => t.includes(text)), `说明 ${key} 在 tooltip 化后丢失（渲染树里找不到其文案）`);
  }
  // 目录三态说明随状态切换仍走 tooltip（本渲染下目录不可用 ⇒ 等的是 Waiting 文案）
  assert.ok(
    titles.some((t) => t.includes(zh["profileSettings.effortHintWaiting"])),
    "推理档位说明（等待目录态）必须随状态进入 tooltip，而非被静态写死",
  );
  // 状态类读数**不得**进 tooltip：生效值来源徽标、未配置提示仍须在正文（一眼可见）
  // 正文 = 渲染树里所有节点的直接字符串子节点（含 span/div 的文本），排除 `(?)` 的说明通道。
  const bodyText = nodes
    .filter((n) => !String(n.props?.className ?? "").includes("dg-settings-hint"))
    .map((n) => textOf(n))
    .join("\n");
  assert.ok(bodyText.includes(zh["settings.reviewSourceLabel"]), "来源徽标必须留在正文（状态读数不进 tooltip）");
  // 状态类读数**逐键**钉住「不得进 tooltip」——它们随状态变化，塞进 tooltip 会撒谎。
  // （「某读数在正文里确实可见」的正面腿由 g442 的正文专用收集器断言，两处同口径、互不替代。）
  for (const key of [
    "settings.reviewUnsetHint",
    "settings.reviewIllegalEmpty",
    "settings.reviewSourceIllegalEmpty",
    "settings.reviewEffectiveBlank",
    "settings.catalogReady",
    "settings.catalogLoadingMsg",
    "settings.catalogUnavailableMsg",
    "settings.intervalWarn",
    "settings.reviewSuggestedRegions",
  ]) {
    assert.ok(!titles.some((t) => t.includes(zh[key])), `状态读数 ${key} 不得进 tooltip（必须留在正文）`);
  }
  // 禁用按钮残留检查：`(?)` 不得把整段说明同时留在正文（双份即信息重复）
  assert.equal(countOccurrences(src, "settingsHintIcon(dgT(\"settings.tabLocalNote\"))"), 1, "页级说明只经 tooltip 承载一次");
});

// ===== 改坏即红（hermetic 负向对照）=====

test("g-479 负向对照：搬走页签面板 / 删归属项 / 跨页签重复登记 / 删标签键 / 破坏 `(?)` 契约 均必红且真实文件未变", () => {
  const real = readModal();
  const before = readFileSync(modalPath);
  const mut = (from: string, to: string, label: string) => {
    const src = real.replace(from, to);
    assert.notEqual(src, real, `变异未生效（找不到锚点）：${label}`);
    const problems = tabStructureProblems(src, loadTabTable(src));
    assert.ok(problems.length > 0, `变异「${label}」必须报红，实得 0 个问题`);
    return problems;
  };

  // ① 把「模型与执行」面板改名 ⇒ 面板缺失 + 归属项全部越界
  const p1 = mut('tabPanel("executor", [', 'tabPanel("Executor", [', "搬走执行页签面板");
  assert.ok(p1.some((s) => s.includes("executor")), "应点名缺失的 executor 面板");

  // ② 从归属表删掉一项 ⇒ 漏项（源码写了该配置项却无归属）
  const p2 = mut('"executor.model", "executor.reasoning_effort"', '"executor.reasoning_effort"', "删掉 executor.model 归属");
  assert.ok(p2.some((s) => s.includes("executor.model")), "应点名未登记归属的 executor.model");

  // ③ 把同一配置项登记到两个页签 ⇒ 重复
  const p3 = mut('"review.policy", "review.regions"', '"review.policy", "executor.mode", "review.regions"', "重复登记 executor.mode");
  assert.ok(p3.some((s) => s.includes("executor.mode") && s.includes("必须恰好 1 个")), "应点名声明的重复归属");

  // ④ 删掉一个页签标签键 ⇒ 缺键 + 文案不可区分
  const p4 = mut('advanced: "settings.tab.advanced",', "", "删掉高级页签标签键");
  assert.ok(p4.some((s) => s.includes("缺标签键")), "应点名缺标签键");

  // ⑤ 把某配置项的控件复制到另一个页签 ⇒ 锚点不唯一 / 越界
  const p5 = mut(
    "          tabPanel(\"review\", [",
    "          tabPanel(\"review\", [\n            " + KEY_ANCHORS["supervisor.agent_teams"] + ",",
    "把 agent_teams 控件复制到评审页签",
  );
  assert.ok(p5.some((s) => s.includes("supervisor.agent_teams")), "应点名复制导致的锚点不唯一");

  // ⑥ 把某配置项的控件**搬到**另一个页签（剪切粘贴：锚点仍唯一，但落到别的页签面板内）⇒ 越界判红。
  //    g-488：agent_teams 已归位「模型与执行」⇒ 越界点名必须是「executor」（不再容忍指向旧页签）。
  const movedSrc = real
    .replace(/ *onChange: \(e\) => set\(\["supervisor", "agent_teams"\], e\.target\.checked\),\n/, "")
    .replace(
      '          tabPanel("advanced", [\n',
      '          tabPanel("advanced", [\n            set(["supervisor", "agent_teams"], e.target.checked),\n',
    );
  assert.notEqual(movedSrc, real, "变异未生效：搬迁 agent_teams 控件");
  const p6 = tabStructureProblems(movedSrc, loadTabTable(movedSrc));
  assert.ok(
    p6.some((s) => s.includes("supervisor.agent_teams") && s.includes("不在「executor」页签面板内")),
    `把 agent_teams 搬到高级页签必须判红并点名越界到 executor，实得：${p6.join(" / ") || "（无问题）"}`,
  );

  // ⑦ g-488：破坏 `(?)` 的可读性契约（删掉 aria-label）⇒ tooltip 契约检查必红且点名该属性
  const hintMut = (from: string, to: string, label: string) => {
    const src = real.replace(from, to);
    assert.notEqual(src, real, `变异未生效（找不到锚点）：${label}`);
    const problems = hintContractProblems(src);
    assert.ok(problems.length > 0, `变异「${label}」必须报红，实得 0 个问题`);
    return problems;
  };
  const h1 = hintMut('      "aria-label": text,\n', "", "删掉 `(?)` 的 aria-label");
  assert.ok(h1.some((s) => s.includes('"aria-label": text')), `应点名缺失的可读名契约，实得：${h1.join(" / ")}`);
  const h2 = hintMut("      tabIndex: 0,\n", "", "删掉 `(?)` 的键盘可达性");
  assert.ok(h2.some((s) => s.includes("tabIndex: 0")), `应点名键盘可达性缺失，实得：${h2.join(" / ")}`);

  // ⑧ g-488：六键自动化漏掉一键的逐键说明 ⇒ 必红且点名该键
  const h3 = hintMut('      rework: "settings.automationWhat.rework",\n', "", "删掉 rework 的逐键说明映射");
  assert.ok(h3.some((s) => s.includes("rework")), `应点名缺失的逐键说明，实得：${h3.join(" / ")}`);

  assert.deepEqual(readFileSync(modalPath), before, "负向对照不得改动真实仓库文件");
});
