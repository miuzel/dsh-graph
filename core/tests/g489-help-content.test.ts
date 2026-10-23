/**
 * g-489：「使用说明」弹窗重写 —— 入门第一步 + 九章分模块说明 + 工具清单分类表格。
 *
 * 覆盖面（对应目标判据 ①②③）：
 *  A. 工具分类真源：分类表 + 简称/类别文案 与**注册真源**精确相等（51 个，双向、可复算），
 *     且负向对照（漏一 / 多一 / 重名 / 缺简称 / 非法类别 / en 缺标签）逐条必红。
 *  B. 使用说明页签：入门第一步（主管技能 + 接管 claim + 可直接复制的示例提示词）与
 *     九章（看板/目标/版本管理/泳道/侧边栏/上下文卡片与项目知识库/记忆系统/子代理与 agent teams/
 *     常用设置）各带 是什么 / 怎么用 / 关键操作 三要素；文案不得是占位行，且**提到的工具名与技能名
 *     必须真实存在**，界面标签锚点必须与当前 i18n 标签一致（内容真实性）。
 *  C. 工具清单页签：按宿主分类真源渲染 **表格**（简称 / 工具名 / 用途），分类表 ≠ 注册真源时
 *     页签顶部显示红条（结构守卫的界面投影）。
 *  D. 表现契约与独立性：五个页签不变、新解释内容不用原生 title 提示、不依赖其它模块的浮层实现。
 *
 * 负向对照一律 hermetic（只在内存里变异源码/字典文本，真实文件零改动）。
 */

import { test } from "node:test";

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { apply, HELP_CATALOG_ROUTE } from "../../dist/index.js";
import { HARNESS_MODULE_IDS } from "../ops.ts";
import { ownerConnectionStub, entryHandler, createRegisterStub, OWNER_HEADER } from "./_http-auth-harness.ts";
// g-507：捕获到的注册定义（setup/fixture 内赋值；helper 经唯一门禁入口分发时读取）
let routeDefs: any[] = [];
let webServer: any = null;

const repoRoot = join(import.meta.dirname, "../..");
const distRoot = join(repoRoot, "dist");
const helpModalPath = join(repoRoot, "dsh-graph-host/lib/client/help-modal.js");
const i18nSrcPath = join(repoRoot, "dsh-graph-host/lib/client/i18n.js");
const settingsModalPath = join(repoRoot, "dsh-graph-host/lib/client/settings-modal.js");
const helpZhPromptPath = join(repoRoot, "prompts/help.zh.md");
const helpEnPromptPath = join(repoRoot, "prompts/help.en.md");

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
/** 归一化：只留数字/拉丁字母/CJK（去 emoji、空白、标点、大小写差异）⇒ 标签锚点比对不受装饰影响。 */
const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[^0-9a-z\u3400-\u9fff]+/g, "");

// ---------------------------------------------------------------- 宿主桩（注册真源：工具 + 技能）

type Capture = { registered: any[]; skills: any[]; catalog: any };

function captureHost(): Capture {
  const registered: any[] = [];
  const skills: any[] = [];
  const webServer = { register: () => () => {} };
  const ctx: any = {
    inject: () => ctx,
    effect: (fn: any) => fn(),
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "connection") return ownerConnectionStub(); // g-507：测试自有 owner 凭证夹具（门禁入口）
      if (name === "skills") return { register: (def: any) => { skills.push(def); return () => {}; } };
      return null;
    },
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
    webServer,
  };
  apply(ctx, {});
  return { registered, skills, catalog: null };
}

const captured = captureHost();
const registeredToolNames = captured.registered.map((d) => String(d?.name ?? ""));
const registeredSkillNames = captured.skills.map((d) => String(d?.name ?? ""));

// 注册真源的两条硬事实（新工具/新技能加入后本文件不会静默通过：计数与分类表守卫同时判红）。
assert.equal(registeredToolNames.length, 51, "g-489 基线：注册真源应恰有 51 个工具（新增工具需同步分类表）");
assert.ok(registeredSkillNames.includes("dsh-graph-supervisor"), "必须注册 dsh-graph-supervisor 技能");
assert.ok(registeredSkillNames.includes("dsh-graph"), "必须注册 dsh-graph 技能");

const serverI18n = await import(pathToFileURL(join(distRoot, "lib/server-i18n.js")).href);
const {
  helpToolTaxonomyProblems, TOOL_TAXONOMY, TOOL_CATEGORIES, SERVER_I18N,
}: any = serverI18n;

// ================================================================ 纯检查器（可对内存变异重放）

const CHAPTERS = ["board", "goal", "version", "lane", "sidebar", "cards", "memory", "subagents", "settings"];

/** 每章必须真实引用的界面标签锚点：[i18n 键, zh 锚点, en 锚点]（锚点必须先证明是该键文案的一部分）。 */
const CHAPTER_ANCHORS: Record<string, Array<[string, string, string]>> = {
  board: [["help.btn", "使用说明", "help"], ["memory.btn", "记忆", "memory"], ["shared.title", "项目知识库", "projectknowledgebase"], ["settings.title", "设置", "settings"]],
  goal: [["section.description", "目标描述", "goaldescription"], ["section.criteria", "质量判据", "qualitycriteria"], ["section.infoCollect", "信息收集", "informationcollection"]],
  version: [["versionDrawer.title", "版本管理", "versionmanagement"], ["versionDrawer.showAll", "显示全部", "showall"], ["versionDrawer.showActive", "仅活跃版本", "activeonly"]],
  lane: [["stage.describe", "描述", "describe"], ["stage.collect", "收集", "collect"], ["stage.execute", "执行", "execute"], ["stage.confirm", "确认", "confirm"], ["stage.deliver", "交付", "deliver"]],
  sidebar: [["sidebar.tab.title", "看板", "kanban"]],
  cards: [["shared.title", "项目知识库", "projectknowledgebase"], ["section.infoCollect", "信息收集", "informationcollection"]],
  memory: [["memory.btn", "记忆", "memory"], ["memory.title", "记忆管理", "memorymanagement"]],
  subagents: [["settings.tab.executor", "模型与执行", "modelexecution"]],
  settings: [["settings.tab.executor", "模型与执行", "modelexecution"], ["settings.tab.review", "评审与质量", "reviewquality"], ["settings.tab.ui", "界面与刷新", "uirefresh"], ["settings.tab.modules", "模块", "modules"], ["settings.tab.advanced", "高级", "advanced"]],
};

/** 客户端结构检查器（文本进、问题清单出）。 */
function modalProblems(modal: string): string[] {
  const problems: string[] = [];
  // ① 九章清单（顺序即展示顺序）。
  const block = (modal.match(/const HELP_MODULE_CHAPTERS = \[([\s\S]*?)\];/) ?? [])[1] ?? "";
  const chapters = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
  if (JSON.stringify(chapters) !== JSON.stringify(CHAPTERS)) {
    problems.push(`HELP_MODULE_CHAPTERS 必须恰是九章 ${CHAPTERS.join("/")}（实得 ${JSON.stringify(chapters)}）`);
  }
  if (!/HELP_MODULE_CHAPTERS\.map\(/.test(modal)) problems.push("九章必须由 HELP_MODULE_CHAPTERS 驱动（写死子集 ⇒ 新增章节界面不显示）");
  // ② 章内三要素（是什么 / 怎么用 / 关键操作）。
  const fieldsBlock = (modal.match(/const HELP_CHAPTER_FIELDS = \[([\s\S]*?)\];/) ?? [])[1] ?? "";
  const fieldKeys = [...fieldsBlock.matchAll(/key: "([a-z]+)"/g)].map((m) => m[1]!);
  if (JSON.stringify(fieldKeys) !== JSON.stringify(["what", "how", "ops"])) {
    problems.push(`HELP_CHAPTER_FIELDS 必须恰是 what/how/ops（实得 ${JSON.stringify(fieldKeys)}）`);
  }
  for (const key of ["what", "how", "ops"]) {
    if (!fieldsBlock.includes(`labelKey: "help.mod.${key}"`)) problems.push(`三要素 ${key} 缺标签键 help.mod.${key}`);
  }
  if (!/HELP_CHAPTER_FIELDS\.map\(/.test(modal)) problems.push("三要素必须由 HELP_CHAPTER_FIELDS 驱动");
  // ③ 入门第一步：主管技能 + 可直接复制的示例提示词（示例文本走 i18n，本模块零工具名字面量）。
  // g-496 att-007：示例提示词正文由字典迁入**宿主只读资产** ⇒ 源码面改判为
  // 「经共享读取器按资产名异步取用」，且**不得**再出现 `dgT("help.entry.prompt")`（唯一事实源 = 资产）。
  for (const needle of ['dgT("help.entry.title")', 'dgT("help.entry.body")', 'dgT("help.entry.promptLabel")', 'dgT("help.entry.copy")', 'className: "dg-help-entry-prompt"']) {
    if (!modal.includes(needle)) problems.push(`入门第一步缺 ${needle}`);
  }
  if (!modal.includes('loadGuiPromptAsset("gui-help-takeover-example")')) {
    problems.push('入门第一步的示例提示词必须经 loadGuiPromptAsset("gui-help-takeover-example") 取资产');
  }
  if (modal.includes('dgT("help.entry.prompt")')) {
    problems.push("示例提示词不得再从字典取（dgT(\"help.entry.prompt\") 应已无常量副本）");
  }
  // 资产未就绪/读取失败时必须禁用复制入口（绝不复制空串或半截文本）。
  if (!/const promptReady = typeof prompt === "string" && prompt\.length > 0/.test(modal)) {
    problems.push("示例提示词必须有 promptReady 就绪判定（未就绪不得可复制）");
  }
  if (!/disabled: !promptReady/.test(modal)) problems.push("复制按钮必须以 !promptReady 禁用（防复制空串）");
  if (!/if \(!promptReady\) return;/.test(modal)) problems.push("复制回调必须自行再判 promptReady（防竞态）");
  if (!/await copyText\(prompt\)/.test(modal)) problems.push("示例提示词必须复用工厂作用域的 copyText 复制实现");
  if (!/dgT\("help\.entry\.copied"\)/.test(modal) || !/dgT\("help\.entry\.copyFail"\)/.test(modal)) {
    problems.push("复制必须给出成功/失败的可读反馈（copied / copyFail）");
  }
  // ④ 工具清单：分类表格（简称 / 工具名 / 用途），分类与红条都来自宿主目录。
  for (const needle of ['dgT("help.tools.colShort")', 'dgT("help.tools.colName")', 'dgT("help.tools.colUse")', 'catalog.categories', 'catalog.taxonomy_problems', 'h("table"', 'h("thead"', 'h("tbody"']) {
    if (!modal.includes(needle)) problems.push(`工具清单表格缺 ${needle}`);
  }
  if (!/helpCatalogText\(t\.short/.test(modal)) problems.push("简称列必须渲染目录里的 short（不得另抄清单）");
  if (!/helpCatalogText\(t\.description/.test(modal)) problems.push("用途列必须渲染目录里的 description");
  if (!/dgT\("help\.tools\.problems"\)/.test(modal)) problems.push("分类表与注册真源不一致时必须有红条（help.tools.problems）");
  if (!/dgT\("help\.tools\.orphan"\)/.test(modal)) problems.push("未归类的工具也必须可见（不得静默丢项）");
  // ⑤ 新解释内容不得用原生 title 提示（悬停才可见 = 不可发现）。
  const newRegion = modal.slice(modal.indexOf("function HelpEntryStep"), modal.indexOf("function HelpFaqTab"));
  if (newRegion.length < 2000) problems.push("新内容区块切片异常（HelpEntryStep → HelpFaqTab）");
  if (/\btitle:/.test(newRegion)) problems.push("新的解释内容不得使用原生 title（须可见文本）");
  // ⑥ 表现契约：五个页签（usage/prompts/tools/faq/design）不变。
  const tabsBlock = (modal.match(/const HELP_TABS = \[([\s\S]*?)\];/) ?? [])[1] ?? "";
  const tabKeys = [...tabsBlock.matchAll(/key: "([a-z]+)"/g)].map((m) => m[1]!);
  if (JSON.stringify(tabKeys) !== JSON.stringify(["usage", "prompts", "tools", "faq", "design"])) {
    problems.push(`五个页签不得增删或换序（实得 ${JSON.stringify(tabKeys)}）`);
  }
  // ⑦ 独立性：不依赖其它客户端模块的浮层/设置实现（本目标须能独立合入）。
  if (/settings-modal|settingsHintIcon|settings-tab/.test(modal)) problems.push("使用说明弹窗不得依赖设置弹窗/其它浮层实现");
  return problems;
}

/** 文案检查器（字典进、问题清单出）。 */
function copyProblems(zh: Record<string, string>, en: Record<string, string>, tools: Set<string>, skills: Set<string>, assets?: Map<string, string>): string[] {
  const problems: string[] = [];
  const pairs = (key: string): [string, string] => [zh[key] ?? "", en[key] ?? ""];
  // ① 入门第一步：技能名 + 接管（claim）这一步 + 真实工具名。
  const [entryBody, entryBodyEn] = pairs("help.entry.body");
  // g-496 att-007：示例提示词正文由字典迁入**宿主只读资产**（按界面语言择一）。
  // 断言面同步迁移（强度不降：仍要求 zh/en 双份、仍要求含技能名与接管工具名、
  // 仍要求 zh≠en），只是取值来源换成唯一事实源。`assets` 缺省时回退查字典，
  // 使负向变异对照（内存注入假字典）仍可独立驱动本检查器。
  const assetText = (name: string) => assets?.get(name) ?? "";
  const [entryPrompt, entryPromptEn] = assets
    ? [assetText("gui-help-takeover-example.zh.md"), assetText("gui-help-takeover-example.en.md")]
    : pairs("help.entry.prompt");
  for (const [label, text, extra] of [["help.entry.body", entryBody, /接管/], ["help.entry.body(en)", entryBodyEn, /claim/i]] as Array<[string, string, RegExp]>) {
    if (!text.includes("dsh-graph-supervisor")) problems.push(`${label} 必须点名 dsh-graph-supervisor 技能`);
    if (!/dsh-graph(?![-\w])/.test(text)) problems.push(`${label} 必须提到 dsh-graph 技能作为并列选项`);
    if (!extra.test(text)) problems.push(`${label} 必须写明「接管/claim」这一步`);
    if (!text.includes("graph_claim_supervisor")) problems.push(`${label} 必须给出接管用的工具名 graph_claim_supervisor`);
  }
  if (!entryPrompt.trim() || !entryPromptEn.trim()) problems.push("示例提示词必须 zh/en 都有（可直接复制）");
  if (!entryPrompt.includes("dsh-graph-supervisor") || !entryPrompt.includes("graph_claim_supervisor")) {
    problems.push("zh 示例提示词必须含技能名与接管工具名");
  }
  if (!entryPromptEn.includes("dsh-graph-supervisor") || !entryPromptEn.includes("graph_claim_supervisor")) {
    problems.push("en 示例提示词必须含技能名与接管工具名");
  }
  if (norm(entryPrompt) === norm(entryPromptEn)) problems.push("示例提示词 zh/en 不得逐字相同（en 必须是真英文）");
  // en 示例提示词不得混 CJK（与九章 en 文案同口径；原字典形态由「en 无 CJK」通用扫描兜住，
  // 迁入资产后必须显式补上 —— 否则本判据在资产载体上会退化）。
  if (CJK.test(entryPromptEn)) problems.push("示例提示词 en 文案含 CJK");
  // ② 九章：三要素齐全、非占位、非重复、en 零 CJK、锚点真实。
  const seenText = new Set<string>();
  for (const chapter of CHAPTERS) {
    const fields: Array<[string, string, string]> = [
      ["title", ...pairs(`help.mod.${chapter}.title`)],
      ["what", ...pairs(`help.mod.${chapter}.what`)],
      ["how", ...pairs(`help.mod.${chapter}.how`)],
      ["ops", ...pairs(`help.mod.${chapter}.ops`)],
    ];
    for (const [field, zhText, enText] of fields) {
      const where = `help.mod.${chapter}.${field}`;
      if (!zhText.trim() || !enText.trim()) { problems.push(`${where} 必须 zh/en 都有`); continue; }
      if (field !== "title") {
        // 标题本身就是短标签；三要素（是什么/怎么用/关键操作）必须是成句的实内容。
        if (zhText.trim().length < 20) problems.push(`${where} 的中文过短（<20 字），疑似占位行`);
        if (enText.trim().length < 30) problems.push(`${where} 的英文过短（<30 字符），疑似占位行`);
      }
      if (CJK.test(enText)) problems.push(`${where} 的 en 文案含 CJK`);
      if (/^(待补充|TODO|TBD)/i.test(zhText.trim())) problems.push(`${where} 是占位行`);
      if (field !== "title") {
        if (seenText.has(zhText.trim())) problems.push(`${where} 与其它章节正文重复（复制粘贴占位）`);
        seenText.add(zhText.trim());
      }
    }
    const joinedZh = [zh[`help.mod.${chapter}.what`], zh[`help.mod.${chapter}.how`], zh[`help.mod.${chapter}.ops`]].join("\n");
    const joinedEn = [en[`help.mod.${chapter}.what`], en[`help.mod.${chapter}.how`], en[`help.mod.${chapter}.ops`]].join("\n");
    for (const [key, zhToken, enToken] of CHAPTER_ANCHORS[chapter] ?? []) {
      // 先证明锚点确实是该 i18n 文案的一部分（锚点不得凭空捏造），再要求本章正文引用它。
      if (!norm(zh[key]).includes(norm(zhToken))) problems.push(`锚点自证失败：${zhToken} 不是 zh ${key} 的一部分`);
      if (!norm(en[key]).includes(norm(enToken))) problems.push(`锚点自证失败：${enToken} 不是 en ${key} 的一部分`);
      if (!norm(joinedZh).includes(norm(zhToken))) problems.push(`章节 ${chapter} 的正文未引用真实界面标签「${zhToken}」（${key}）`);
      if (!norm(joinedEn).includes(norm(enToken))) problems.push(`章节 ${chapter} 的英文正文未引用真实界面标签「${enToken}」（${key}）`);
    }
  }
  // ③ 真实性：正文里出现的每个工具名/技能名都必须真实注册（不得杜撰）。
  const allCopy = [...CHAPTERS.flatMap((c) => ["title", "what", "how", "ops"].map((f) => `${zh[`help.mod.${c}.${f}`] ?? ""}\n${en[`help.mod.${c}.${f}`] ?? ""}`)), entryBody, entryPrompt, entryBodyEn, entryPromptEn].join("\n");
  for (const m of allCopy.matchAll(/\bgraph_[a-z_]+\b/g)) {
    if (!tools.has(m[0])) problems.push(`使用说明提到未注册的工具名：${m[0]}`);
  }
  for (const m of allCopy.matchAll(/\bdsh-graph(?:-[a-z]+)*\b/g)) {
    if (!skills.has(m[0])) problems.push(`使用说明提到未注册的技能名：${m[0]}`);
  }
  // ④ 设置章节必须与当前实现一致：五个页签标题全在、且不得再提已下线的「关于」页签。
  for (const tabKey of ["executor", "review", "ui", "modules", "advanced"]) {
    const label = zh[`settings.tab.${tabKey}`];
    if (!label) { problems.push(`实现侧缺 settings.tab.${tabKey}（章节引用了不存在的页签）`); continue; }
    if (!norm(zh[`help.mod.settings.what`]).includes(norm(label))) problems.push(`设置章节未列出页签「${label}」`);
  }
  if (/关于页签|About tab/.test(`${zh["help.mod.settings.what"]}\n${en["help.mod.settings.what"]}`)) {
    problems.push("设置弹窗已无「关于」页签，说明不得再提");
  }
  return problems;
}

const readModal = () => readFileSync(helpModalPath, "utf8");

/** i18n.js 是工厂作用域片段（无 import/export）⇒ 直接在独立 vm 上下文里求值取 zh/en（同 g-481 口径）。 */
function readDicts(): [Record<string, string>, Record<string, string>] {
  const sandbox: any = { React: {} };
  vm.runInNewContext(readFileSync(i18nSrcPath, "utf8") + "; this.zh = zh; this.en = en;", sandbox);
  return [sandbox.zh as Record<string, string>, sandbox.en as Record<string, string>];
}

/** g-496 att-007：宿主专属层资产目录（示例提示词等 GUI 模板正文的唯一事实源）。 */
const hostPromptsDir = join(repoRoot, "dsh-graph-host/prompts");
/** 读入宿主层资产（名字 → 正文）；缺文件即为空串，由下方断言点名判红。 */
function readHostAssets(): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of ["gui-help-takeover-example.zh.md", "gui-help-takeover-example.en.md"]) {
    const p = join(hostPromptsDir, name);
    out.set(name, existsSync(p) ? readFileSync(p, "utf8") : "");
  }
  return out;
}

// ================================================================ A. 分类真源 ≡ 注册真源（+ 负向对照）

test("g-489 A1：分类表 + 简称/类别文案 ≡ 注册真源（51，双向相等），且目录端点把分类/简称/红因都投给客户端", async () => {
  assert.deepEqual(helpToolTaxonomyProblems(registeredToolNames), [], "生产守卫必须全绿（分类表 ≡ 注册真源）");
  assert.equal(Object.keys(TOOL_TAXONOMY).length, 51, "分类表条目数必须等于注册真源工具数");
  assert.equal(new Set(TOOL_CATEGORIES).size, TOOL_CATEGORIES.length, "类别键不得重复");
  // 双向：分类表里没有注册真源之外的工具，注册真源也没有漏项。
  assert.deepEqual(Object.keys(TOOL_TAXONOMY).sort(), [...registeredToolNames].sort(), "分类表与注册真源必须逐项相等");
  const counts = TOOL_CATEGORIES.map((key: string) => Object.values(TOOL_TAXONOMY).filter((v) => v === key).length);
  assert.equal(counts.reduce((a: number, b: number) => a + b, 0), 51, "八个类别必须覆盖全部 51 个工具");
  assert.ok(counts.every((n: number) => n > 0), `每个类别至少要有一个工具（实得 ${JSON.stringify(counts)}）`);
  // 简称：2–6 字（zh），en 为短标签且零 CJK。
  for (const name of Object.keys(TOOL_TAXONOMY)) {
    const zhShort = SERVER_I18N.zh[`toolShort.${name}`];
    const enShort = SERVER_I18N.en[`toolShort.${name}`];
    assert.ok(zhShort && zhShort.length >= 2 && zhShort.length <= 6, `${name} 的 zh 简称须为 2–6 字（实得 ${JSON.stringify(zhShort)}）`);
    assert.ok(enShort && enShort.length >= 2 && enShort.length <= 24, `${name} 的 en 简称须为短标签（实得 ${JSON.stringify(enShort)}）`);
    assert.doesNotMatch(enShort, CJK, `${name} 的 en 简称不得含 CJK`);
  }
  // 目录端点：分类 + 每条工具的 category/short/description + taxonomy_problems。
  const { routes } = captureHostRoutes();
  // g-507：业务定义不再逐条注册 —— 目录端点经唯一受保护入口分发（入口覆盖整个命名空间）
  const route = { path: HELP_CATALOG_ROUTE, handler: entryHandler(routes) };
  assert.ok(route.handler, `宿主必须注册 ${HELP_CATALOG_ROUTE}（经唯一受保护入口分发）`);
  const body = await callRoute(route);
  assert.equal(body.taxonomy_problems.length, 0, "目录端点的运行期守卫必须为空");
  assert.equal(body.tools.length, 51, "目录端点的工具条目数必须等于注册真源");
  assert.deepEqual(body.categories.map((c: any) => c.key), TOOL_CATEGORIES, "目录端点的分类顺序必须来自分类真源");
  for (const t of body.tools) {
    assert.ok(TOOL_CATEGORIES.includes(t.category), `${t.name} 的 category 必须合法（实得 ${t.category}）`);
    assert.ok(t.short && t.short.zh && t.short.en, `${t.name} 必须带 zh/en 简称`);
    assert.ok(t.description && t.description.zh && t.description.en, `${t.name} 必须带 zh/en 用途`);
  }
  const grouped = body.categories.reduce((acc: number, c: any) => acc + body.tools.filter((t: any) => t.category === c.key).length, 0);
  assert.equal(grouped, 51, "每个工具都必须被某个分类收下（页签不许丢项）");
});

test("g-489 A2（负向对照）：漏一 / 多一 / 重名 / 缺简称 / 非法类别 / en 缺标签 ⇒ 守卫逐条必红", () => {
  const taxonomyClone = { ...TOOL_TAXONOMY } as Record<string, string>;
  const dropName = registeredToolNames[0]!;
  delete taxonomyClone[dropName];
  assert.ok(helpToolTaxonomyProblems(registeredToolNames, { taxonomy: taxonomyClone }).some((p: string) => p.includes("漏一")), "分类表漏项必须报「漏一」");
  const addClone = { ...TOOL_TAXONOMY, graph_not_implemented: "diag" } as Record<string, string>;
  assert.ok(helpToolTaxonomyProblems(registeredToolNames, { taxonomy: addClone }).some((p: string) => p.includes("多一")), "分类表多项必须报「多一」");
  assert.ok(helpToolTaxonomyProblems([...registeredToolNames, registeredToolNames[0]!]).some((p: string) => p.includes("重复")), "注册真源重名必须报红");
  const zhClone = { ...SERVER_I18N.zh };
  delete zhClone[`toolShort.${dropName}`];
  assert.ok(helpToolTaxonomyProblems(registeredToolNames, { dicts: { zh: zhClone, en: SERVER_I18N.en } }).some((p: string) => p.includes("缺 zh 简称")), "缺 zh 简称必须报红");
  const enClone = { ...SERVER_I18N.en };
  delete enClone[`toolShort.${dropName}`];
  assert.ok(helpToolTaxonomyProblems(registeredToolNames, { dicts: { zh: SERVER_I18N.zh, en: enClone } }).some((p: string) => p.includes("缺 en 简称")), "缺 en 简称必须报红");
  const badCat = { ...TOOL_TAXONOMY, [dropName]: "nope" } as Record<string, string>;
  assert.ok(helpToolTaxonomyProblems(registeredToolNames, { taxonomy: badCat }).some((p: string) => p.includes("类别非法")), "非法类别必须报红");
  const catClone = { ...SERVER_I18N.en };
  delete catClone[`toolCategory.${TOOL_CATEGORIES[0]}`];
  assert.ok(helpToolTaxonomyProblems(registeredToolNames, { dicts: { zh: SERVER_I18N.zh, en: catClone } }).some((p: string) => p.includes("缺 en 标签")), "类别缺 en 标签必须报红");
  const orphanClone = { ...SERVER_I18N.zh, "toolShort.graph_deleted_long_ago": "残留" };
  assert.ok(helpToolTaxonomyProblems(registeredToolNames, { dicts: { zh: orphanClone, en: SERVER_I18N.en } }).some((p: string) => p.includes("残留")), "无主简称键必须报红");
  // 负向对照不得污染真实真源。
  assert.deepEqual(helpToolTaxonomyProblems(registeredToolNames), [], "负向对照后生产守卫必须仍为绿（hermetic）");
});

// ================================================================ B. 使用说明：入门第一步 + 九章三要素

test("g-489 B1：客户端由清单驱动渲染入门第一步与九章三要素（结构断言全绿）", () => {
  assert.ok(existsSync(helpModalPath), "客户端必须有 help-modal.js");
  assert.deepEqual(modalProblems(readModal()), [], "客户端结构断言必须全绿");
});

test("g-489 B2：文案 zh/en 对称、真实（锚点指向现存界面标签）、非占位，且提到的工具/技能真实注册", () => {
  const [zh, en] = readDicts();
  const problems = copyProblems(zh, en, new Set(registeredToolNames), new Set(registeredSkillNames), readHostAssets());
  assert.deepEqual(problems, [], "文案断言必须全绿");
  // 红线条（g-495 改判）：help.*.md 不再声明**工具**数（改为功能模块清单 + 当前开关状态），
  // 故计数真源从「注册工具数」改判为「引擎模块注册表长度」。工具侧不变：注册真源仍须 == 51。
  const zhPrompt = readFileSync(helpZhPromptPath, "utf8");
  const enPrompt = readFileSync(helpEnPromptPath, "utf8");
  assert.equal(registeredToolNames.length, 51, "g-489 基线：注册真源应恰有 51 个工具");
  const zhModules = [...zhPrompt.matchAll(/共\s*(\d+)\s*个功能模块/g)].map((m) => Number(m[1]));
  assert.equal(zhModules.length, 1, "help.zh.md 必须保留一处模块计数表述（共 N 个功能模块）");
  for (const n of zhModules) assert.equal(n, HARNESS_MODULE_IDS.length, `help.zh.md 的模块计数必须是 ${HARNESS_MODULE_IDS.length}`);
  const enModules = [...enPrompt.matchAll(/(\d+)\s+feature modules/g)].map((m) => Number(m[1]));
  assert.equal(enModules.length, 1, "help.en.md 必须保留一处模块计数表述");
  for (const n of enModules) assert.equal(n, HARNESS_MODULE_IDS.length, `help.en.md 的模块计数必须是 ${HARNESS_MODULE_IDS.length}`);
  // 负向对照（内存变异）：模块数写错必红（守卫不得恒真）。
  assert.notEqual(
    Number(zhPrompt.replace(/共\s*\d+\s*个功能模块/, "共 4 个功能模块").match(/共\s*(\d+)\s*个功能模块/)![1]),
    HARNESS_MODULE_IDS.length,
    "模块数改成 4 时判据必须变红",
  );
});

test("g-489 B2b（负向对照·内存变异）：占位行 / 缺三要素 / 编造工具名 / 编造技能名 / en 混 CJK ⇒ 文案断言逐条必红", () => {
  const [zh, en] = readDicts();
  const tools = new Set(registeredToolNames);
  const skills = new Set(registeredSkillNames);
  const assets = readHostAssets();
  assert.deepEqual(copyProblems(zh, en, tools, skills, assets), [], "基线必须为绿");
  // 资产侧负向对照（g-496 att-007）：示例提示词迁入资产后，**资产本身**也必须受同一组判据约束
  // —— 缺一份 / 清空 / en 是中文照抄 ⇒ 逐条必红（证明断言真的在读资产，而非恒真）。
  const mutatedAssets: Array<[string, Map<string, string>, string]> = [
    ["资产缺 en", new Map([...assets].filter(([n]) => !n.endsWith(".en.md"))), "示例提示词必须 zh/en 都有"],
    ["资产 en 被清空", new Map([...assets].map(([n, v]) => [n, n.endsWith(".en.md") ? "" : v] as [string, string])), "示例提示词必须 zh/en 都有"],
    ["资产 en 照抄 zh", new Map([...assets].map(([n, v]) => [n, n.endsWith(".en.md") ? assets.get("gui-help-takeover-example.zh.md")! : v] as [string, string])), "不得逐字相同"],
    ["资产删掉技能名", new Map([...assets].map(([n, v]) => [n, v.replace("dsh-graph-supervisor", "dsh-graph")] as [string, string])), "必须含技能名与接管工具名"],
  ];
  for (const [label, mAssets, expect] of mutatedAssets) {
    const got = copyProblems(zh, en, tools, skills, mAssets);
    assert.ok(got.some((p) => p.includes(expect)), `资产变异「${label}」必须报红并点名「${expect}」，实际：${JSON.stringify(got)}`);
  }
  type Mut = [string, Record<string, string>, Record<string, string>, string];
  const base = { ...zh };
  const mutations: Mut[] = [
    ["某章正文变占位行", { ...zh, "help.mod.lane.ops": "待补充" }, en, "疑似占位行"],
    ["某章缺 en 文案", { ...zh, "help.mod.memory.what": "" }, en, "必须 zh/en 都有"],
    ["删掉技能名", { ...zh, "help.entry.body": "dsh-graph 的看板由主管 Agent 维护。" }, en, "dsh-graph-supervisor"],
    ["编造工具名", { ...zh, "help.mod.subagents.ops": "用 graph_fake_tool 派发。" }, en, "未注册的工具名"],
    ["编造技能名", { ...zh, "help.entry.body": "请加载 dsh-graph-magic 技能。" }, en, "未注册的技能名"],
    ["en 混 CJK", zh, { ...en, "help.mod.board.what": "The board 看板" }, "含 CJK"],
    ["章节不再引用真实标签", { ...zh, "help.mod.version.how": "在版本抽屉里看看就好，标题就在这里。" }, en, "未引用真实界面标签"],
    ["复制粘贴两章同文", { ...zh, "help.mod.goal.what": zh["help.mod.board.what"]! }, en, "重复"],
  ];
  for (const [label, mzh, men, expect] of mutations) {
    assert.ok(mzh !== base || men !== en, `负向对照「${label}」必须真实改变输入`);
    const got = copyProblems(mzh, men, tools, skills, assets);
    assert.ok(got.some((p) => p.includes(expect)), `变异「${label}」必须报红并点名「${expect}」，实际：${JSON.stringify(got)}`);
  }
  assert.deepEqual([readDicts()[0]["help.mod.board.what"]], [zh["help.mod.board.what"]], "负向对照必须 hermetic（真实文件零改动）");
});

// ================================================================ C. 工具清单表格 + 结构守卫红条

test("g-489 C1（负向对照·内存变异）：拿掉表格 / 拿掉红条 / 拿掉未归类兜底 / 新内容用原生 title ⇒ 结构断言必红", () => {
  const real = readModal();
  assert.deepEqual(modalProblems(real), [], "基线必须为绿");
  const mutations: Array<[string, string, string]> = [
    ["工具清单改为列表（去掉表格）", real.replace('h("table", {', 'h("div", {'), "工具清单表格缺"],
    ["拿掉分类表红条", real.replace('dgT("help.tools.problems")', 'dgT("help.tools.colUse")'), "红条"],
    ["拿掉未归类兜底", real.replace('dgT("help.tools.orphan")', 'dgT("help.tools.colUse")'), "未归类"],
    ["九章写死少一章", real.replace('      "board", "goal", "version", "lane", "sidebar", "cards", "memory", "subagents", "settings",\n', '      "board",\n'), "HELP_MODULE_CHAPTERS"],
    ["三要素少了关键操作", real.replace('{ key: "ops", labelKey: "help.mod.ops" },\n', ""), "HELP_CHAPTER_FIELDS"],
    ["新内容改用原生 title", real.replace('className: "dg-help-chapter-title",', 'className: "dg-help-chapter-title", title: "x",'), "不得使用原生 title"],
    ["新增第六个页签", real.replace('{ key: "design", labelKey: "help.tab.design" },', '{ key: "design", labelKey: "help.tab.design" },\n      { key: "extra", labelKey: "help.tab.extra" },'), "五个页签"],
  ];
  for (const [label, mutated, expect] of mutations) {
    assert.notEqual(mutated, real, `负向对照「${label}」必须真实改变输入`);
    const got = modalProblems(mutated);
    assert.ok(got.some((p) => p.includes(expect)), `变异「${label}」必须报红并点名「${expect}」，实际：${JSON.stringify(got)}`);
  }
  assert.equal(readModal(), real, "负向对照必须 hermetic（真实文件零改动）");
});

// ================================================================ D. 表现契约：设置弹窗五页签未被本目标改动

test("g-489 D1：看板设置仍是五个页签（无「关于」），说明文案与实现同源", () => {
  const settings = readFileSync(settingsModalPath, "utf8");
  // 页签键在 settings-modal.js 里以 `executor: "settings.tab.executor"` 形态登记。
  const tabKeys = [...settings.matchAll(/^\s{0,10}([a-z]+): "(settings\.tab\.[a-z]+)",/gm)].map((m) => m[2]!);
  assert.deepEqual(
    tabKeys,
    ["settings.tab.executor", "settings.tab.review", "settings.tab.ui", "settings.tab.modules", "settings.tab.advanced"],
    "看板设置必须仍是这五个页签（本目标不得改动设置弹窗结构）",
  );
  assert.doesNotMatch(settings, /settings\.tab\.about/, "设置弹窗不得有「关于」页签");
  const [zh, en] = readDicts();
  for (const key of tabKeys) {
    assert.ok(zh[key], `实现引用的页签键 ${key} 必须有 zh 文案`);
    assert.ok(en[key], `实现引用的页签键 ${key} 必须有 en 文案`);
  }
  // 说明文案与实现同源：设置章节必须列出这五个真实页签。
  for (const key of tabKeys) {
    assert.ok(norm(zh["help.mod.settings.what"]).includes(norm(zh[key])), `设置章节必须列出页签「${zh[key]}」`);
  }
});

// ---------------------------------------------------------------- 路由桩（A1 用）

function captureHostRoutes(): { routes: any[] } {
  const routes = new Map<string, any>();
  { const stub = createRegisterStub(); routeDefs = stub.routes; webServer = stub.webServer; }
  const ctx: any = {
    inject: () => ctx,
    effect: (fn: any) => fn(),
    get: (name: string) => (name === "webServer" ? webServer : name === "connection" ? ownerConnectionStub() : null),
    tools: { register: () => () => {}, get: () => ({}) },
    webServer,
  };
  apply(ctx, {});
  return { routes: routeDefs };
}

async function callRoute(route: any): Promise<any> {
  let body: any = null;
  const res: any = {
    writeHead() {},
    end(b: any) { body = b; },
  };
  await route.handler({ method: "GET", url: HELP_CATALOG_ROUTE, headers: { [OWNER_HEADER]: "1" } }, res);
  return JSON.parse(String(body));
}
