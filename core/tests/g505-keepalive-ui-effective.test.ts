/** g-505 设置面板「生效读数 / 畸形告警」**渲染层**守卫（review rev-att-003-01 注记 1+2）。
 *
 * 为什么必须渲染而不是字符串 grep（负责人 2026-10-28 明确要求）：
 *   · 旧实现把 `eff.malformed` 一刀切渲染成「已按关闭处理」——而 `project=true + 全局畸形` 时
 *     实际**开着**，界面却写「已关闭」（谎报状态）；
 *   · 生效读数复用下拉**选项**文案「强制开启/强制关闭」，于是「跟随全局 + 内置默认」被渲染成
 *     「当前生效：强制开启 · 来源：内置默认」（把继承误称强制，负责人现场困惑点）。
 * 两类错误都只在**真实组件的渲染树**上可见，纯函数/字符串断言都抓不到。
 *
 * 口径（不复制生产判定）：
 *   ① 服务端投影用**真实** `core/keepalive.ts` 的 `keepAliveEffectiveOf` + `resolveKeepAliveGlobalRaw`
 *      （宿主 `keepAliveProjectionOf` 调的就是同一条链路）；
 *   ② 渲染用**真实** `dsh-graph-host/lib/client/settings-modal.js` 的 `SettingsModal` 源码与
 *      **真实** zh/en i18n（vm 求值；h/React 为最小 stub，与 g479 / g490 同一 vm 口径）；
 *   ③ 断言只看渲染出来的文本/属性/写入，不在测试里重算「该显示哪一句」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { keepAliveEffectiveOf, resolveKeepAliveGlobalRaw } from "../keepalive.ts";

const ROOT = join(import.meta.dirname, "../..");
const MODAL_PATH = join(ROOT, "dsh-graph-host", "lib", "client", "settings-modal.js");
const I18N_PATH = join(ROOT, "dsh-graph-host", "lib", "client", "i18n.js");

type Dict = Record<string, string>;

const readModal = (): string => readFileSync(MODAL_PATH, "utf8");

function loadI18n(): { zh: Dict; en: Dict } {
  const sandbox: any = { React: {} };
  vm.runInNewContext(`${readFileSync(I18N_PATH, "utf8")}\n;this.zh = zh; this.en = en;`, sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

type Rendered = {
  /** `dg-keep-alive` 控件所在的保活小节容器（真实渲染树的节点）。 */
  block: any;
  select: any;
  /** 保活小节内所有非空文本行（含生效读数、能力/TTL 说明、畸形告警）。 */
  texts: string[];
  writes: any[];
};

/** 真实 `SettingsModal` 渲染（React/h 为最小 stub；`advanced` 页签为保活控件所在页）。 */
function renderAdvanced(modalSrc: string, form: any, dict: Dict): Rendered {
  const h = (type: any, props: any, ...children: any[]) => ({
    type,
    props: props || {},
    children: children.flat(Infinity).filter((c: any) => c !== null && c !== undefined && c !== false),
  });
  const overrides: any[] = [];
  overrides[0] = false; // loading（已加载，避免早退渲染骨架）
  overrides[1] = form; // form
  overrides[2] = false; // saving
  overrides[3] = null; // note
  overrides[4] = null; // error
  overrides[5] = "advanced"; // activeTab（保活控件所在页签）
  overrides[6] = "/abs/path/project.yaml"; // configFile
  const writes: any[] = [];
  let idx = 0;
  const sandbox: any = {
    console,
    h,
    dgOverlay: (props: any, ...children: any[]) => h("div", props, ...children),
    settingsModalModeInstanceSeq: 0,
    dgT: (k: string) => dict[k] ?? k,
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
        let v = Object.prototype.hasOwnProperty.call(overrides, i)
          ? overrides[i]
          : (typeof init === "function" ? init() : init);
        const setter = (next: any) => {
          v = typeof next === "function" ? next(v) : next;
          // `set(...)` 的写入全部经 setForm(updater) ⇒ index 1 的更新就是「三态写入」的真实落点
          if (i === 1) writes.push(v);
        };
        return [v, setter];
      },
      useEffect: () => {},
    },
  };
  const start = modalSrc.indexOf("function normalizeSettingsDraft(");
  const modalStart = modalSrc.indexOf("function SettingsModal(");
  assert.ok(start > 0 && modalStart > start, "必须能在真实源码中定位归一化段与 SettingsModal");
  vm.runInNewContext(`${modalSrc.slice(start)}\n;this.SettingsModal = SettingsModal;`, sandbox);
  const tree = sandbox.SettingsModal({ onClose: () => {}, onSaved: () => {} });

  const nodes: any[] = [];
  const parents = new Map<any, any>();
  const walk = (n: any, parent: any) => {
    if (!n || typeof n !== "object") return;
    nodes.push(n);
    if (parent) parents.set(n, parent);
    (n.children ?? []).forEach((c: any) => walk(c, n));
  };
  walk(tree, null);

  const select = nodes.find((n) => n.type === "select" && n.props?.id === "dg-keep-alive");
  assert.ok(select, "真实渲染树必须包含 dg-keep-alive 三态下拉（源改坏/控件消失即红）");
  const block = parents.get(select);
  assert.ok(block, "保活控件必须有父容器（小节容器）");

  // 控件确实落在 `advanced` 页签面板内（防止被搬到别的页签而断言静默换面）。
  let anc = block;
  let inAdvancedPanel = false;
  while (anc) {
    if (typeof anc.props?.className === "string" && anc.props.className.includes("dg-settings-panel-advanced")) {
      inAdvancedPanel = true;
      break;
    }
    anc = parents.get(anc);
  }
  assert.ok(inAdvancedPanel, "保活控件必须位于 advanced 页签面板（真实 SettingsModal 路径）");

  const deepText = (n: any): string => {
    if (n === null || n === undefined || n === false) return "";
    if (typeof n === "string") return n;
    return (n.children ?? []).map(deepText).join("");
  };
  const blockNodes: any[] = [];
  const collect = (n: any) => { blockNodes.push(n); (n.children ?? []).forEach(collect); };
  collect(block);
  // 去重：容器节点与其唯一文本子节点会得到同一字符串（真实渲染树结构如此），断言只看文本集合。
  const texts = Array.from(new Set(blockNodes.map(deepText).filter((t) => t.trim() !== "")));
  return { block, select, texts, writes };
}

/** 与前端同源的服务端投影（真实 core 函数，不是测试自算）。 */
function projectionOf(supervisor: any, globalRaw: any) {
  const g = resolveKeepAliveGlobalRaw(globalRaw);
  return keepAliveEffectiveOf(supervisor, g.enabled, g.malformed, g.available);
}

const BASE_FORM = () => ({
  executor: { provider: "", model: "", reasoning_effort: "", mode: "" },
  review: {
    policy: "",
    regions: null,
    contract_paths: null,
    non_product_prefixes: null,
    effective: {
      regions: { value: null, source: "default", malformed: false, allow_empty: true, illegal_empty: false },
      contract_paths: { value: null, source: "default", malformed: false, allow_empty: true, illegal_empty: false },
      non_product_prefixes: { value: null, source: "default", malformed: false, allow_empty: true, illegal_empty: false },
    },
  },
  supervisor: { agent_teams: null, automation: {} },
  defaults: { review: { reviewer: "", prompt: "" }, pk: { lanes: 1, sandbox: "" } },
  modules: {},
  prompt_overrides: { subagent: { state: "default", value: null } },
});

type UiCase = {
  name: string;
  /** 项目 supervisor 读值形态（与 readProjectConfig 同形）。 */
  supervisor: any;
  globalRaw: string;
  /** select 原值（三态归一后的草稿；畸形项目 ⇒ inherit）。 */
  draft: "inherit" | "true" | "false";
  expect: {
    effective: boolean;
    source: string;
    malformed: boolean;
    /** 期望显示的告警文案**键**；null = 不得出现任何告警。 */
    warningKey: string | null;
    /** 期望的来源标签键。 */
    sourceKey: string;
  };
};

const CASES: UiCase[] = [
  {
    name: "inherit + 合法全局 on",
    supervisor: { keep_alive: null },
    globalRaw: "on",
    draft: "inherit",
    expect: { effective: true, source: "global_explicit", malformed: false, warningKey: null, sourceKey: "settings.keepAliveSrcGlobal" },
  },
  {
    name: "inherit + 合法全局 off",
    supervisor: { keep_alive: null },
    globalRaw: "off",
    draft: "inherit",
    expect: { effective: false, source: "global_explicit", malformed: false, warningKey: null, sourceKey: "settings.keepAliveSrcGlobal" },
  },
  {
    name: "inherit + 全局缺省（受控默认）",
    supervisor: { keep_alive: null },
    globalRaw: "",
    draft: "inherit",
    expect: { effective: true, source: "global_default", malformed: false, warningKey: null, sourceKey: "settings.keepAliveSrcDefault" },
  },
  {
    name: "项目畸形（project_invalid）⇒ 关闭 + 关闭警示",
    supervisor: { keep_alive: "yes", keep_alive_malformed: true },
    globalRaw: "on",
    draft: "inherit",
    expect: { effective: false, source: "project_invalid", malformed: true, warningKey: "settings.keepAliveMalformed", sourceKey: "settings.keepAliveSrcProjectInvalid" },
  },
  {
    name: "全局畸形（global_invalid）+ inherit ⇒ 关闭 + 关闭警示",
    supervisor: { keep_alive: null },
    globalRaw: "maybe",
    draft: "inherit",
    expect: { effective: false, source: "global_invalid", malformed: true, warningKey: "settings.keepAliveMalformed", sourceKey: "settings.keepAliveSrcGlobalInvalid" },
  },
  {
    name: "项目 true + 全局畸形 ⇒ 开启 + 只报「全局无效、项目覆盖生效」",
    supervisor: { keep_alive: "true" },
    globalRaw: "maybe",
    draft: "true",
    expect: { effective: true, source: "project_explicit", malformed: true, warningKey: "settings.keepAliveMalformedOverridden", sourceKey: "settings.keepAliveSrcProject" },
  },
  {
    name: "项目 false + 全局畸形 ⇒ 关闭 + 明确覆盖（不得说成「按关闭处理」）",
    supervisor: { keep_alive: "false" },
    globalRaw: "maybe",
    draft: "false",
    expect: { effective: false, source: "project_explicit", malformed: true, warningKey: "settings.keepAliveMalformedOverridden", sourceKey: "settings.keepAliveSrcProject" },
  },
  {
    name: "项目显式 true + 合法全局 off ⇒ 开启、来源项目、无告警",
    supervisor: { keep_alive: "true" },
    globalRaw: "off",
    draft: "true",
    expect: { effective: true, source: "project_explicit", malformed: false, warningKey: null, sourceKey: "settings.keepAliveSrcProject" },
  },
];

const FORCE_LABEL_KEYS = ["settings.keepAliveOn", "settings.keepAliveOff"];
const WARNING_KEYS = [
  "settings.keepAliveMalformed",
  "settings.keepAliveMalformedOverridden",
  "settings.keepAliveMalformedUnknown",
];

/** 对**已渲染**结果逐项核对（真实断言；负向变异测试故意让它抛错）。 */
function checkCase(rendered: Rendered, dict: Dict, ui: UiCase): void {
  const projection = projectionOf(ui.supervisor, ui.globalRaw);
  assert.equal(projection.effective, ui.expect.effective, `${ui.name}: 服务端投影 effective 与用例期望不一致`);
  assert.equal(projection.source, ui.expect.source, `${ui.name}: 服务端投影 source 与用例期望不一致`);
  assert.equal(projection.malformed, ui.expect.malformed, `${ui.name}: 服务端投影 malformed 与用例期望不一致`);

  const prefix = dict["settings.keepAliveEffective"].split("{v}")[0];
  const readout = rendered.texts.find((t) => t.startsWith(prefix));
  assert.ok(readout, `${ui.name}: 必须渲染「当前生效」读数（否则用户无法判断 inherit 落点）`);
  const neutral = ui.expect.effective ? dict["settings.keepAliveEffectiveOn"] : dict["settings.keepAliveEffectiveOff"];
  assert.ok(readout.includes(neutral), `${ui.name}: 生效读数必须是中性「${neutral}」，实得「${readout}」`);
  for (const key of FORCE_LABEL_KEYS) {
    assert.ok(!readout.includes(dict[key]), `${ui.name}: 生效读数不得复用选项文案「${dict[key]}」（把继承/默认误称强制），实得「${readout}」`);
  }
  const sourceLabel = dict[ui.expect.sourceKey];
  assert.ok(sourceLabel, `${ui.name}: 来源标签键 ${ui.expect.sourceKey} 必须存在于 i18n`);
  assert.ok(readout.includes(sourceLabel), `${ui.name}: 生效读数必须如实标注来源「${sourceLabel}」，实得「${readout}」`);

  const warnings = rendered.texts.filter((t) => WARNING_KEYS.some((k) => t === dict[k]));
  if (ui.expect.warningKey === null) {
    assert.deepEqual(warnings, [], `${ui.name}: 合法配置不得出现任何畸形告警（实得 ${JSON.stringify(warnings)}）`);
  } else {
    assert.deepEqual(warnings, [dict[ui.expect.warningKey]], `${ui.name}: 畸形告警必须恰好是 ${ui.expect.warningKey}`);
  }
  // 分层口径：项目覆盖畸形全局时，绝不能出现「已按关闭处理」这句（实际可能开着）。
  if (ui.expect.warningKey === "settings.keepAliveMalformedOverridden") {
    assert.ok(!warnings.includes(dict["settings.keepAliveMalformed"]), `${ui.name}: 覆盖场景不得显示「按关闭处理」`);
  }

  // 三态 select：原值与选项文案（写入意图）保持不变。
  assert.equal(rendered.select.props.value, ui.draft, `${ui.name}: select 原值必须为 ${ui.draft}`);
  const options = (rendered.select.children ?? []).filter((c: any) => c?.type === "option");
  assert.deepEqual(options.map((o: any) => o.props.value), ["inherit", "true", "false"], `${ui.name}: 三态选项集合/顺序不得变化`);
  assert.deepEqual(
    options.map((o: any) => (o.children ?? []).join("")),
    [dict["settings.keepAliveInherit"], dict["settings.keepAliveOn"], dict["settings.keepAliveOff"]],
    `${ui.name}: 选项文案（跟随全局/强制开启/强制关闭）不得变化`,
  );

  // 写入路径：真实 onChange → set → setForm(updater)，三态值必须原样落在 supervisor.keep_alive。
  const lastWrite = () => rendered.writes[rendered.writes.length - 1];
  rendered.select.props.onChange({ target: { value: "inherit" } });
  assert.equal(lastWrite()?.supervisor?.keep_alive, null, `${ui.name}: 选 inherit 必须写 null（清空叶子）`);
  rendered.select.props.onChange({ target: { value: "true" } });
  assert.equal(lastWrite()?.supervisor?.keep_alive, "true", `${ui.name}: 选强制开启必须写 "true"`);
  rendered.select.props.onChange({ target: { value: "false" } });
  assert.equal(lastWrite()?.supervisor?.keep_alive, "false", `${ui.name}: 选强制关闭必须写 "false"`);
}

const renderFor = (modalSrc: string, dict: Dict, ui: UiCase): Rendered => {
  const form: any = BASE_FORM();
  form.supervisor = { ...form.supervisor, keep_alive: ui.supervisor.keep_alive ?? null, keep_alive_effective: projectionOf(ui.supervisor, ui.globalRaw) };
  return renderAdvanced(modalSrc, form, dict);
};

// ========== 正向：真实组件 + 真实 i18n + 真实 core 投影 ==========

test("g505 UI：zh/en 八组状态的真实渲染读数与告警分层（含 inherit/默认/两端非法/项目覆盖）", () => {
  const modalSrc = readModal();
  const { zh, en } = loadI18n();
  for (const dict of [zh, en]) {
    for (const ui of CASES) {
      checkCase(renderFor(modalSrc, dict, ui), dict, ui);
    }
  }
});

test("g505 UI：新增读/告警键 zh/en 成对且英语侧零 CJK（不允许只改一侧）", () => {
  const { zh, en } = loadI18n();
  for (const key of [
    "settings.keepAliveEffectiveOn",
    "settings.keepAliveEffectiveOff",
    "settings.keepAliveMalformedOverridden",
    "settings.keepAliveMalformedUnknown",
  ]) {
    assert.equal(typeof zh[key], "string", `zh 缺 ${key}`);
    assert.equal(typeof en[key], "string", `en 缺 ${key}`);
    assert.doesNotMatch(en[key], /[\u4e00-\u9fff]/, `en ${key} 不得含 CJK：${en[key]}`);
  }
});

// ========== 负向对照（变异必须真的判红，不允许空变异） ==========

/** 变异 A：把旧的「eff.malformed 一律按关闭」判断放回真实源码。 */
function mutateOldMalformedLogic(src: string): string {
  const pattern = /const keepAliveMalformedKey = \(eff\) => \{[\s\S]*?\n {4}\};/;
  assert.match(src, pattern, "源码必须含 keepAliveMalformedKey（变异锚点）");
  const mutated = src.replace(pattern, 'const keepAliveMalformedKey = (eff) => (eff && eff.malformed === true ? "settings.keepAliveMalformed" : null);');
  assert.notEqual(mutated, src, "变异必须真实改写源码（拒绝空变异）");
  return mutated;
}

/** 变异 B：把中性生效读数换回选项文案「强制开启/强制关闭」。 */
function mutateForceReadout(src: string): string {
  const pattern = /on: "settings\.keepAliveEffectiveOn",\n\s*off: "settings\.keepAliveEffectiveOff",/;
  assert.match(src, pattern, "源码必须含中性生效读数键映射（变异锚点）");
  const mutated = src.replace(pattern, 'on: "settings.keepAliveOn",\n      off: "settings.keepAliveOff",');
  assert.notEqual(mutated, src, "变异必须真实改写源码（拒绝空变异）");
  return mutated;
}

test("负向对照：把旧的一刀切畸形判断放回 ⇒ 真实渲染断言必红（项目 true + 畸形全局被误报已关闭）", () => {
  const { zh } = loadI18n();
  const mutated = mutateOldMalformedLogic(readModal());
  const ui = CASES.find((c) => c.name.startsWith("项目 true + 全局畸形"));
  assert.ok(ui, "用例必须存在");
  assert.throws(
    () => checkCase(renderFor(mutated, zh, ui), zh, ui),
    /项目 true \+ 全局畸形.*畸形告警必须恰好是 settings\.keepAliveMalformedOverridden/,
    "旧实现把「覆盖生效」谎报成「已按关闭」时，渲染层断言必须判红",
  );
});

test("负向对照：生效读数换回「强制开启/强制关闭」⇒ 真实渲染断言必红（把继承误称强制）", () => {
  const { zh } = loadI18n();
  const mutated = mutateForceReadout(readModal());
  const ui = CASES.find((c) => c.name.startsWith("inherit + 全局缺省"));
  assert.ok(ui, "用例必须存在");
  assert.throws(
    () => checkCase(renderFor(mutated, zh, ui), zh, ui),
    /生效读数不得复用选项文案/,
    "读数复用「强制开启」时必须判红（这正是负责人看到的「强制开启 · 来源：内置默认」）",
  );
});
