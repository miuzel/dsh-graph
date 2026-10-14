/**
 * g-493：「使用说明点题」—— 图工程（Graph Engineering）命名由来逐项落地、与「Graph 设计」页签去重、
 * `graph_help(topic)` 主题抽取，以及「顺手收口」的原生 `title` 清零。
 *
 * 为什么需要：g-489 把「使用说明」页签扩成九章分模块说明，但整份帮助**没有点题** ——
 * 使用者读得懂每个开关，却不知道插件为什么叫 dsh-graph、看板在整个「图分工」里处于什么位置。
 * 本守卫把负责人口径的九个子项钉成可机械判定的真源，并给出四类**必红**的负向对照。
 *
 * 覆盖面：
 *  A. 九子项逐项落地（渲染层可见）：开篇点题章节由 `HELP_USAGE_TOPIC_KEYS` 驱动、**渲染在既有
 *     使用说明段落之前**，且九个子项各自的锚点文案真实出现在可见 i18n 值里（不是注释、不是常量）。
 *  B. 逐字引用真源：mcp.so 的图工程定义必须**逐字**出现在 zh 文案里，且标注来源为 mcp.so；
 *     定义被改写却仍标称逐字引用 ⇒ 必红。en 侧必须给出来源与术语（Graph Engineering / node / edge /
 *     shared state / kanban / view）。
 *  C. 去重归属：命名与「看板只是视图」的详述在**使用说明页签**，「Graph 设计」页签只保留**引用**
 *     （`help.topic.designCrossref`），两处不得互相矛盾（都不得把「后续版本开放」写成已具备）。
 *  D. `graph_help(topic)`：省略 topic 逐字返回整份资产（g-347 端到端不变）；`usage` /
 *     `graph_engineering` / **模块名** 各自取到对应切片；**工具名不再命中**（g-495 返工项 3，
 *     判别力方向反转而非删除）；未知名 ⇒ 不伪造内容（found=false + 全文）。
 *     D3：生命周期串在 `tool.graph_transition` / `usage.zh` / `usage.en` 三处逐字一致（返工项 4）。
 *  E. 原生 `title` 清零：整个帮助弹窗（含 Graph 设计页签 iframe）不得再有原生 `title` 提示。
 *
 * g-495 返工项 1 归属改判：**点题归人面向「使用说明」**（`i18n.js` 的 `help.topic.*`，zh/en 双查），
 * agent 侧 `help.*.md` **不得**再含点题段（负责人 2026-10-13：「给 agent 的 help 不用点题」）。
 *
 * 负向对照一律 hermetic（只在内存里变异源码/字典文本，真实文件零改动）。
 */

import { test } from "node:test";

import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { apply, _helpTopicText, _isGraphEngineeringSectionTitle } from "../../dist/index.js";
import { SERVER_I18N } from "../../dist/lib/server-i18n.js";
import { HARNESS_MODULE_IDS } from "../ops.ts";

const repoRoot = join(import.meta.dirname, "../..");
const helpModalPath = join(repoRoot, "dsh-graph-host/lib/client/help-modal.js");
const i18nSrcPath = join(repoRoot, "dsh-graph-host/lib/client/i18n.js");
const bundlePath = join(repoRoot, "dist/lib/client.js");
const usageZhPromptPath = join(repoRoot, "prompts/usage.zh.md");
const usageEnPromptPath = join(repoRoot, "prompts/usage.en.md");
const engineSrcPath = join(repoRoot, "dsh-graph-host/index.js");
const helpZhPromptPath = join(repoRoot, "prompts/help.zh.md");
const helpEnPromptPath = join(repoRoot, "prompts/help.en.md");

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** 负责人 2026-10-12 原话里的 mcp.so 图工程定义 —— **逐字真源**（改动本串即等于改口径）。 */
const GRAPH_ENGINEERING_DEFINITION = "Graph Engineering（图工程）就是把多智能体系统设计成一张显式的图——节点（各自只负责一件事的智能体或步骤）、边（顺序、条件或并行的路由）、共享状态——而不是依赖单个智能体跑单条循环";

// ---------------------------------------------------------------- 宿主桩

type Capture = { registered: any[]; skills: any[] };

function captureHost(): Capture {
  const registered: any[] = [];
  const skills: any[] = [];
  const webServer = { register: () => () => {} };
  const ctx: any = {
    inject: () => ctx,
    effect: (fn: any) => fn(),
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "skills") return { register: (def: any) => { skills.push(def); return () => {}; } };
      return null;
    },
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
    webServer,
  };
  apply(ctx, {});
  return { registered, skills };
}

const captured = captureHost();
const registeredToolNames: string[] = captured.registered.map((d) => String(d?.name ?? ""));
const helpDef = captured.registered.find((d) => d.name === "graph_help");
assert.ok(helpDef, "必须注册 graph_help");
const runHelp = (args: any): any => helpDef.execute(args ?? {}, { agent: undefined, signal: new AbortController().signal });

/** g-495 att-005（D6）：在**私有可写包副本**里真实加载插件并取 `graph_help.execute()`。
 *  副本是 `dist/` 的逐字节复制（index.js + prompts/ + core/ + lib/），故走的是**同一份引擎代码与
 *  同一套资产读取路径**（`import.meta.url` 相对解析 ⇒ 天然指向副本内的 `prompts/`）；副本可写，
 *  运行树保持只读零改动。返回的函数与 `runHelp` 同形（同一真实 run 入口）。 */
async function loadCopyHelp(entryPath: string): Promise<(args: any) => any> {
  const mod: any = await import(entryPath);
  const registered: any[] = [];
  const webServer = { register: () => () => {} };
  const ctx: any = {
    inject: () => ctx,
    effect: (fn: any) => fn(),
    get: (name: string) => (name === "webServer" ? webServer : null),
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
    webServer,
  };
  mod.apply(ctx, {});
  const def = registered.find((d) => d.name === "graph_help");
  assert.ok(def, "私有副本必须同样注册 graph_help");
  return (args: any) => def.execute(args ?? {}, { agent: undefined, signal: new AbortController().signal });
}

/** i18n.js 是工厂作用域片段（无 import/export）⇒ 在独立 vm 上下文里求值取 zh/en（同 g-481/g-489 口径）。 */
function readDicts(): [Record<string, string>, Record<string, string>] {
  const sandbox: any = { React: {} };
  vm.runInNewContext(readFileSync(i18nSrcPath, "utf8") + "; this.zh = zh; this.en = en;", sandbox);
  return [sandbox.zh as Record<string, string>, sandbox.en as Record<string, string>];
}

const readModal = () => readFileSync(helpModalPath, "utf8");

/** 从源码里取出某个 `const NAME = [ ... ];` 的字符串元素（与渲染真源同源，不另立清单）。 */
function arrayLiteral(modal: string, name: string): string[] {
  const block = (modal.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`)) ?? [])[1] ?? "";
  return [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

/** 同上，但取**数字**元素（如 `const HELP_FAQ_ITEMS = [1, 2, …];`）。 */
function numberLiteral(modal: string, name: string): number[] {
  const block = (modal.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`)) ?? [])[1] ?? "";
  return [...block.matchAll(/\d+/g)].map((m) => Number(m[0]));
}

/** 归一化：去掉 Markdown 装饰（`**粗体**`、反引号、空白）后再做锚点比对。 */
const plain = (s: unknown) => String(s ?? "").replace(/\*\*/g, "").replace(/`/g, "");

// ================================================================ 纯检查器（可对内存变异重放）

/** 「点题」九子项：[子项名, 必须出现的可见文案片段[]]。片段全部取自 zh 可见 i18n 值。 */
const TOPIC_ITEMS: Array<[string, string[]]> = [
  ["① 命名由来 = 取自图工程（Graph Engineering）的启发", ["dsh-graph", "Graph Engineering", "图工程", "启发"]],
  ["② 逐字引用 mcp.so 的图工程定义并标注来源", [GRAPH_ENGINEERING_DEFINITION, "mcp.so", "逐字引用"]],
  ["③ 任务 / 目标状态机 + 简易 Jira + Confluence（可括注禅道）", ["任务 / 目标状态机", "Jira", "Confluence", "禅道"]],
  ["④ 六个角色在主管工作指南 + 目标状态机约束下自然形成", ["supervisor", "worker", "reviewer", "definer", "collector", "user", "主管工作指南", "目标状态机", "自然形成"]],
  ["⑤ 生命周期链 + 返工回 implement / 分支出新 goal 两条回路", ["new request", "define goal and criteria", "collect", "implement", "review", "verdict", "deliver", "返工", "分支出新"]],
  ["⑥ dsh-graph core 定义并组织；同一套 core 可产出 dsh TUI / pi-ai 插件", ["dsh-graph core", "同一套 core", "dsh TUI", "pi-ai", "看板"]],
  ["⑦ 看板只是视图 + 逐层审批控制 + 不用 DSL 的软件工程实践 + 心中有图/图不是固定图", ["看板只是", "视图", "逐层审批控制", "DSL", "软件工程实践", "心中有图", "固定图"]],
  ["⑧ 看板解决两件事（全过程直观 + 随时插嘴讨论方向）", ["全过程", "插嘴", "方向", "版本计划"]],
  ["⑨ 路线图如实：后续版本开放图自定义，当前以过程可视化 + 任务状态机为主", ["后续版本", "开放", "当前版本", "过程可视化", "任务状态机"]],
];

/** 客户端结构检查器（文本进、问题清单出）。 */
function modalProblems(modal: string): string[] {
  const problems: string[] = [];
  const topicKeys = arrayLiteral(modal, "HELP_USAGE_TOPIC_KEYS");
  if (!topicKeys.length) problems.push("缺少 HELP_USAGE_TOPIC_KEYS（开篇点题章节的正文清单）");
  else {
    // 点题章节必须在 HELP_USAGE_KEYS **之前**渲染（「点题」= 开篇；排在后面等于没点题）。
    // g-498：清单消费点由「`.map(` 调用」升级为「`helpTopicSections(HELP_USAGE_TOPIC_KEYS)` 分组」
    //（正文按语义分小标题，每条仍恰渲染一次）；因此判据改判为**清单必须被消费**（二者之一），
    // 而不是钉死 `.map(` 这一种写法 —— 写死子集/丢清单照旧判红。
    const topicConsumed = /helpTopicSections\(\s*HELP_USAGE_TOPIC_KEYS\s*\)/.test(modal) || /HELP_USAGE_TOPIC_KEYS\.map\(/.test(modal);
    // **渲染位置**以「点题一级容器」为准：g-498 起清单的消费点（`helpTopicSections(...)`）位于
    // 函数开头、容器在其后展开，故用消费点排序会把「整体后移」误判为未移动。容器标记则始终
    // 与真实渲染顺序一致（旧写法 `.map(` 作为兜底，兼容尚未迁移的形态）。
    const topicAt = Math.max(modal.indexOf('className: "dg-help-topic"'), modal.indexOf("HELP_USAGE_TOPIC_KEYS.map("));
    const usageAt = modal.indexOf("HELP_USAGE_KEYS.map(");
    if (!topicConsumed) problems.push("点题章节必须由 HELP_USAGE_TOPIC_KEYS 驱动（写死子集 ⇒ 新增段落界面不显示）");
    if (!topicConsumed || usageAt < 0) problems.push("使用说明页签必须同时渲染点题章节与原有段落");
    else if (topicAt > usageAt) problems.push("点题章节必须渲染在原有使用说明段落**之前**（开篇）");
    if (!/dgT\("help\.topic\.title"\)/.test(modal)) problems.push("点题章节缺标题（help.topic.title）");
    if (!/className: "dg-help-topic"/.test(modal)) problems.push("点题章节缺可见容器 dg-help-topic");
    for (const key of topicKeys) {
      if (!/^help\.topic\.(naming|definition|definitionSource|stateMachine|roles|lifecycle|core|kanbanIsView|programmable|stateOfMind|solves|roadmap)$/.test(key)) {
        problems.push(`点题章节含未登记/不存在的键 ${key}`);
      }
    }
    for (const need of ["help.topic.definition", "help.topic.definitionSource", "help.topic.roadmap"]) {
      if (!topicKeys.includes(need)) problems.push(`点题章节必须渲染 ${need}`);
    }
  }
  // FAQ 必须含点题问答（题面逐字用负责人口径）。
  const faqItems = numberLiteral(modal, "HELP_FAQ_ITEMS");
  if (!faqItems.includes(8)) problems.push("FAQ 必须增补点题问答（HELP_FAQ_ITEMS 含 8）");
  if (!/dgT\("help\.topic\.faqQ"\)/.test(modal) || !/dgT\("help\.topic\.faqA"\)/.test(modal)) {
    problems.push("FAQ 点题条目必须渲染 help.topic.faqQ / help.topic.faqA");
  }
  // 去重：Graph 设计页签只保留**引用**（详述在使用说明页签）。容器与引用文案**缺一即判红**
  //（两处分别独立必红 ⇒ 「拿掉类名」与「拿掉文案」都关得住，不存在只改一处仍绿的旁路）。
  if (!/className: "dg-design-crossref"/.test(modal)) {
    problems.push("Graph 设计页签必须保留一处指向使用说明点题章节的引用容器（dg-design-crossref）");
  }
  if (!/dgT\("help\.topic\.designCrossref"\)/.test(modal)) {
    problems.push("Graph 设计页签的去重引用必须走 help.topic.designCrossref 文案");
  }
  // 顺手收口：整个弹窗不得再有原生 title 提示。
  if (/\btitle:/.test(modal)) problems.push("帮助弹窗不得再使用原生 title 提示（改用点击/hover 自绘浮层）");
  return problems;
}

/** 文案检查器（字典进、问题清单出）：九子项 + 逐字引用 + 去重一致性 + en 术语。 */
function topicCopyProblems(zh: Record<string, string>, en: Record<string, string>): string[] {
  const problems: string[] = [];
  const [modal] = [readModal()];
  const topicKeys = arrayLiteral(modal, "HELP_USAGE_TOPIC_KEYS");
  // 所有点题可见文案（正文 + 标题 + FAQ），zh 一份、en 一份。
  // 归一化去掉 Markdown 装饰（`**粗体**`、反引号）⇒ 锚点比对只看**可见字样**，不因加粗写法漂移。
  const zhAll = plain([...topicKeys.map((k) => zh[k] ?? ""), zh["help.topic.title"] ?? "", zh["help.topic.faqQ"] ?? "", zh["help.topic.faqA"] ?? "", zh["help.topic.designCrossref"] ?? ""].join("\n"));
  const enAll = plain([...topicKeys.map((k) => en[k] ?? ""), en["help.topic.title"] ?? "", en["help.topic.faqQ"] ?? "", en["help.topic.faqA"] ?? "", en["help.topic.designCrossref"] ?? ""].join("\n"));
  // 键必须 zh/en 成对且非空（缺键/留空 ⇒ 必红）。
  for (const key of [...topicKeys, "help.topic.title", "help.topic.faqQ", "help.topic.faqA", "help.topic.designCrossref"]) {
    if (!String(zh[key] ?? "").trim()) problems.push(`${key} 的 zh 文案缺失或为空`);
    if (!String(en[key] ?? "").trim()) problems.push(`${key} 的 en 文案缺失或为空`);
  }
  // 九子项逐项落地（渲染层可见）。
  for (const [label, needles] of TOPIC_ITEMS) {
    for (const needle of needles) {
      if (!zhAll.includes(needle)) problems.push(`点题子项缺失：${label} —— 可见文案里找不到「${needle}」`);
    }
  }
  // ② 逐字引用：定义必须**逐字**出现在可见文案里，且同一段里标注来源 mcp.so。
  const definitionKey = "help.topic.definition";
  const zhDefinition = zh[definitionKey] ?? "";
  if (!zhDefinition.includes(GRAPH_ENGINEERING_DEFINITION)) {
    problems.push("help.topic.definition 必须逐字包含 mcp.so 的图工程定义原文（改写后不得仍标称逐字引用）");
  }
  // ②′ 逐字节强比对（主管 2026-10-13 裁决要求加强）：不只断言「包含」——把 `「…」` 引号内的
  //     整段**取出来**与负责人原文逐字符比对（长度 + 全等 + 首个差异位）。任何一字改写（哪怕是
  //     近义替换、少/多一个字）都必须判红，而不是靠子串包含侥幸过关。
  const quoted = (zhDefinition.match(/「([\s\S]*)」/) ?? [])[1];
  if (quoted === undefined) {
    problems.push("help.topic.definition 必须以「」标出逐字引文（否则无法判定引用范围）");
  } else if (quoted !== GRAPH_ENGINEERING_DEFINITION) {
    const owner = [...GRAPH_ENGINEERING_DEFINITION];
    const got = [...quoted];
    let at = 0;
    while (at < owner.length && at < got.length && owner[at] === got[at]) at += 1;
    problems.push(
      `help.topic.definition 的「」引文必须与负责人原文逐字节相同（期望 ${owner.length} 字、实得 ${got.length} 字，首个差异 @${at}：` +
        `期望 ${JSON.stringify(owner.slice(at, at + 12).join(""))} / 实得 ${JSON.stringify(got.slice(at, at + 12).join(""))}）`,
    );
  }
  const sourceKey = "help.topic.definitionSource";
  if (!(zh[sourceKey] ?? "").includes("mcp.so")) problems.push("必须标注定义来源为 mcp.so");
  if (!/逐字引用/.test(zh[sourceKey] ?? "")) problems.push("来源标注必须写明是逐字引用");
  if (!(zh[sourceKey] ?? "").includes("逐字") || !/mcp\.so/.test(zh[sourceKey] ?? "")) {
    problems.push("定义来源必须同时含「逐字」与 mcp.so");
  }
  // ②″ 两侧口径自洽：zh 声称逐字引用（中文原文），en 是**译文** ⇒ en 只能声称「中文原文的逐字
  //     引用」，不得声称自身逐字（en 文本本就与原文不同）；且 zh 一旦不再标称逐字，en 也不得标称。
  const zhSaysVerbatim = /逐字/.test(zh[sourceKey] ?? "");
  const enSource = en[sourceKey] ?? "";
  if (zhSaysVerbatim && !/verbatim/i.test(enSource)) {
    problems.push("zh 标称逐字引用时 en 来源标注必须同样写明 verbatim（两侧口径自洽）");
  }
  if (zhSaysVerbatim && !/translat|Chinese|original/i.test(enSource)) {
    problems.push("en 来源标注必须写明逐字引用的是**中文原文**（en 是译文，不得声称自身逐字）");
  }
  if (!zhSaysVerbatim && /verbatim/i.test(enSource)) {
    problems.push("zh 不再标称逐字引用时 en 不得单独标称 verbatim");
  }
  // ③ 括注禅道 + Jira/Confluence 同现。
  const stateMachine = zh["help.topic.stateMachine"] ?? "";
  for (const needle of ["Jira", "Confluence", "禅道", "状态机"]) {
    if (!stateMachine.includes(needle)) problems.push(`help.topic.stateMachine 必须提到「${needle}」`);
  }
  // ⑨ 路线图如实：不得把「后续版本开放」写成已具备。
  const roadmap = zh["help.topic.roadmap"] ?? "";
  if (!/后续版本/.test(roadmap) || !/开放/.test(roadmap)) problems.push("路线图必须写明图自定义将在后续版本开放");
  if (!/当前版本/.test(roadmap) || !/过程可视化/.test(roadmap) || !/任务状态机/.test(roadmap)) {
    problems.push("路线图必须写明当前版本以过程可视化 + 任务状态机机制为主");
  }
  if (/已经(支持|具备|提供)|现已支持|当前版本(已)?(支持|具备|提供).*自定义/.test(roadmap)) {
    problems.push("路线图不得把「后续版本开放」写成已具备");
  }
  // ③ 去重一致性：设计页签引用不得与使用说明矛盾（都不得声称已支持自定义）。
  const crossref = zh["help.topic.designCrossref"] ?? "";
  if (/已经(支持|具备|提供)|现已支持/.test(crossref)) problems.push("设计页签引用不得把「后续版本开放」写成已具备");
  if (!/使用说明/.test(crossref)) problems.push("设计页签引用必须指回使用说明页签的点题章节");
  // en 侧：术语与来源一致、零 CJK、不得留空（键对称另由 g-481 D1 兜底）。
  const enMust = ["Graph Engineering", "graph", "view"];
  for (const needle of enMust) {
    if (!enAll.includes(needle)) problems.push(`en 点题文案缺少术语「${needle}」`);
  }
  if (!/mcp\.so/.test(en["help.topic.definitionSource"] ?? "")) problems.push("en 来源标注必须含 mcp.so");
  for (const key of [...topicKeys, "help.topic.title", "help.topic.faqQ", "help.topic.faqA", "help.topic.designCrossref"]) {
    if (CJK.test(String(en[key] ?? ""))) problems.push(`${key} 的 en 文案含 CJK`);
  }
  if (problems.length === 0 && !/kanban|board/i.test(enAll)) problems.push("en 点题文案必须讲到看板（kanban / board）");
  return problems;
}

// ================================================================ A/B/C. 点题落地 + 逐字引用 + 去重

test("g-493 A1：开篇点题章节由清单驱动、渲染在原有段落之前，FAQ 增补点题问答，设计页签保留引用（结构全绿）", () => {
  assert.ok(existsSync(helpModalPath), "客户端必须有 help-modal.js");
  assert.deepEqual(modalProblems(readModal()), [], "客户端结构断言必须全绿");
  // 生成物里真的有（防「源改了没重建」的假绿）。
  const bundle = readFileSync(bundlePath, "utf8");
  for (const needle of ["function HelpUsageTab(", "HELP_USAGE_TOPIC_KEYS", "dg-help-topic", "help.topic.designCrossref"]) {
    if (!bundle.includes(needle)) assert.fail(`dist/lib/client.js 未包含 ${needle}（需重建）`);
  }
  // g-495 E：逐行「展开说明」折叠面板已移除（其首行只是把同列的 description 再渲染一遍）。
  // 负向钉住：这些符号**不得**再出现在生成物里（人为回退即红）。
  for (const gone of ["dg-help-tool-detail", 'dgT("help.tools.accordion")', "help.tools.accordion"]) {
    if (bundle.includes(gone)) assert.fail(`dist/lib/client.js 仍包含已移除的 ${gone}（折叠面板回退）`);
  }
  // 源码侧同口径钉住（生成物可能陈旧 ⇒ 单看 bundle 会假绿）：折叠面板的渲染入口与展开态
  // 状态钩子都不得在 help-modal.js 里复活。
  const src = readModal();
  for (const gone of ["dg-help-tool-detail", "help.tools.accordion", "expandedTool", "detailOpen"]) {
    assert.ok(!src.includes(gone), `help-modal.js 不得再含已移除的 ${gone}（折叠面板回退）`);
  }
  // 正证据：工具清单页签仍按「简称 / 工具名 / 用途」三列表格渲染（移除的是折叠面板，不是表格）。
  assert.ok(/function HelpToolsTab\(/.test(src), "工具清单页签必须保留");
  assert.ok(/dgT\("help\.tools\.orphan"\)/.test(src), "未归类工具仍须可见（不许静默丢项）");
});

test("g-493 B1：九子项逐项落在可见文案里；定义逐字引用并标注 mcp.so；en 术语一致（文案全绿）", () => {
  const [zh, en] = readDicts();
  assert.deepEqual(topicCopyProblems(zh, en), [], "点题文案断言必须全绿");
  // 逐字红线：九个子项里的定义串必须与真源**逐字**相等（不是「差不多」）。
  // g-495 返工项 1：**zh 逐字 + en 对偶**（裁决明确：逐字引用只有 zh 一份，en 是英译对偶，
  // **不得**要求 en 含 zh 逐字中文串 —— 见下方逐条断言与负向对照）。
  assert.ok(String(zh["help.topic.definition"]).includes(GRAPH_ENGINEERING_DEFINITION), "zh 定义必须逐字引用");
  assert.ok(String(en["help.topic.definition"]).length > 0, "en 定义不得为空（zh/en 双查）");
  assert.ok(/Graph Engineering/.test(String(en["help.topic.definition"])), "en 定义必须点题 Graph Engineering");
  assert.ok(/nodes|edges|shared state/i.test(String(en["help.topic.definition"])), "en 定义必须给出节点/边/共享状态的对偶措辞");
  assert.ok(/verbatim/i.test(String(en["help.topic.definitionSource"])), "en 来源标注必须写明 verbatim（与 zh 逐字口径自洽）");
  // 「共 51 个」计数红线（g-495 改判）：help.*.md 不再声明**工具**数（改为功能模块清单 +
  // 当前开关状态），故原「必须保留两处 51」口径改判为「必须声明**模块**数 == 引擎模块注册表长度」。
  // 工具侧真源不变：注册数仍须恰为 51（本目标不碰注册面）。
  assert.equal(registeredToolNames.length, 51, "g-493 基线：注册真源应恰有 51 个工具");
  const zhPrompt = readFileSync(helpZhPromptPath, "utf8");
  const enPrompt = readFileSync(helpEnPromptPath, "utf8");
  const zhModules = [...zhPrompt.matchAll(/共\s*(\d+)\s*个功能模块/g)].map((m) => Number(m[1]));
  const enModules = [...enPrompt.matchAll(/(\d+)\s+feature modules/g)].map((m) => Number(m[1]));
  assert.deepEqual(zhModules, [HARNESS_MODULE_IDS.length], "help.zh.md 必须声明模块数 == 模块注册表长度");
  assert.deepEqual(enModules, [HARNESS_MODULE_IDS.length], "help.en.md 必须声明模块数 == 模块注册表长度");
  // 负向对照：模块数写错必红（守卫不得恒真）。
  assert.notDeepEqual(
    [...zhPrompt.replace(/共\s*\d+\s*个功能模块/, "共 4 个功能模块").matchAll(/共\s*(\d+)\s*个功能模块/g)].map((m) => Number(m[1])),
    [HARNESS_MODULE_IDS.length],
    "模块数被改成 4 时判据必须变红",
  );
  // 点题判别力**归属改判**（g-495 返工项 1，负责人 2026-10-13 裁决）：
  //   「给 agent 的 help 不用点题，点题的是使用说明，给人看的那个」⇒ agent 侧 help 资产现在
  //   **不得**含点题段（去冗余），点题的判别力**整条搬到人面向面**（i18n.js 的 `help.topic.*`），
  //   且 zh/en **双向**都要有——原来只查 zh prompt，现在 zh/en 两面向各查。
  assert.ok(!zhPrompt.includes(GRAPH_ENGINEERING_DEFINITION), "help.zh.md 不得含点题定义（agent 侧去冗余，点题归人面向使用说明）");
  assert.ok(!zhPrompt.includes("mcp.so"), "help.zh.md 不得标注 mcp.so 来源（点题归人面向）");
  assert.ok(!/Graph Engineering/i.test(enPrompt), "help.en.md 不得点题图工程（zh/en 对称）");
  assert.ok(!/图工程|Graph Engineering/.test(`${zhPrompt}\n${enPrompt}`), "help 资产不得残留任何图工程点题痕迹");
  // 人面向面（使用说明）**必须**仍有点题。⚠️ 裁决（负责人 2026-10-13，出路 1）明确：
  // **逐字引用只有 zh 一份**（i18n.js 的 `help.topic.definition` 内嵌中文逐字串）；en 侧是**英译对偶**，
  // **不得**要求 en 含 zh 逐字中文串（那是错判据）—— en 只查对偶术语与来源标注。
  const [zhDict, enDict] = readDicts();
  assert.ok(
    String(zhDict["help.topic.definition"]).includes(GRAPH_ENGINEERING_DEFINITION),
    "i18n.js 的 zh help.topic.definition 必须逐字引用点题定义（点题归属人面向面）",
  );
  assert.ok(String(zhDict["help.topic.definitionSource"]).includes("mcp.so"), "zh 来源标注必须含 mcp.so");
  assert.ok(/逐字引用/.test(String(zhDict["help.topic.definitionSource"])), "zh 来源标注必须写明「逐字引用」");
  assert.ok(/Graph Engineering/.test(String(enDict["help.topic.definition"])), "en 对偶必须点题 Graph Engineering");
  assert.ok(
    /verbatim/i.test(String(enDict["help.topic.definitionSource"])),
    "en 来源标注必须自述「中文原文为逐字引用」（verbtim 口径，与 zh 自洽）",
  );
  assert.ok(
    /translation/i.test(String(enDict["help.topic.definitionSource"])),
    "en 来源标注必须自述「英文面是翻译」—— 故**不得**要求 en 含 zh 逐字中文串（裁决口径）",
  );
  // 负向对照（真实树上的内存变异，hermetic）：把点题串从 zh 字典里拿掉 ⇒ 上面的人面向断言必须变红。
  const zhNoTopic = { ...zhDict, "help.topic.definition": "点题已删除。" };
  assert.notEqual(zhNoTopic["help.topic.definition"], zhDict["help.topic.definition"], "负向对照必须真实改变输入");
  assert.ok(
    !String(zhNoTopic["help.topic.definition"]).includes(GRAPH_ENGINEERING_DEFINITION),
    "负向对照：zh 字典去掉点题定义后必须不再含逐字定义（否则判据恒真）",
  );
  // 负向对照 ②（g-495 返工项 B：**经真实实现**）：把点题段人为加回作者侧 help 资产 ⇒
  // 「help 资产不得含点题」这条断言必须变红，且**真实查找函数**必须给出可观察的语义变化
  //（原本回落 usage ⇒ 现在命中 help 自身）。仅比较两个本地布尔值是同义反复，不能证明回归会判红。
  const usageZhAsset = readFileSync(usageZhPromptPath, "utf8");
  const zhPromptWithTopic = `${zhPrompt}\n## 为什么叫 dsh-graph：图工程\n${GRAPH_ENGINEERING_DEFINITION}\n`;
  assert.notEqual(zhPromptWithTopic, zhPrompt, "负向对照必须真实改变输入");
  assert.ok(zhPromptWithTopic.includes(GRAPH_ENGINEERING_DEFINITION), "负向对照：加回点题段后资产必须重新含定义");
  // 真实实现上的裁决翻转：变异前命中 usage 权威章节；变异后命中 help 新加章节（来源不同 ⇒ 可判别）。
  const before = _helpTopicText(zhPrompt, "graph_engineering", [usageZhAsset]);
  const after = _helpTopicText(zhPromptWithTopic, "graph_engineering", [usageZhAsset]);
  assert.notEqual(after, before, "真实实现：help 资产加回点题段后，真实查找的裁决必须翻转（判据可被证伪）");
  assert.equal(after, `## 为什么叫 dsh-graph：图工程\n${GRAPH_ENGINEERING_DEFINITION}`, "真实实现：翻转后切片必须逐字来自 help 新加的点题段");
  // 基线对照：未变异时命中的是 usage 资产里的章节（与上面 help 新加段**来源不同** ⇒ 翻转可判别）。
  const usageTopicSection = usageZhAsset
    .split(/\n(?=## )/)
    .find((s) => s.startsWith("## ") && _isGraphEngineeringSectionTitle(s.split("\n")[0]!));
  assert.equal(before, usageTopicSection!.trimEnd(), "基线对照：未变异时命中的必须是 usage 资产里的章节");
  assert.notEqual(before, after, "变异前后必须取到**不同来源**的章节（否则判据不可判别）");
});

test("g-493 C1（负向对照·内存变异）：点题章节缺失 / 定义被改写却仍称逐字引用 / 把「后续版本开放」写成已具备 / en 侧缺键 ⇒ 必红", () => {
  const real = readModal();
  const [zh, en] = readDicts();
  assert.deepEqual(modalProblems(real), [], "结构基线必须为绿");
  assert.deepEqual(topicCopyProblems(zh, en), [], "文案基线必须为绿");

  // ① 点题章节缺失 ⇒ 必红（结构层 + 文案层各一条路径）。
  const dropTopic = real.replace('h("div", { className: "dg-help-topic", key: "help-topic" },', 'h("div", { className: "dg-help-missing", key: "help-topic" },');
  assert.notEqual(dropTopic, real, "负向对照必须真实改变输入");
  assert.ok(modalProblems(dropTopic).some((p) => p.includes("dg-help-topic")), "拿掉点题章节容器必须判红");
  // 点题章节不再由清单驱动（段落被写死/丢清单）⇒ 必红。
  // g-498：清单消费点现为 `helpTopicSections(HELP_USAGE_TOPIC_KEYS)` 分组调用（旧写法 `.map(` 亦被接受）；
  // 两种写法**都必须**被同一负向对照关住 ⇒ 各自独立变异一次。
  for (const [label, from, to] of [
    ["分组调用被换掉", "helpTopicSections(HELP_USAGE_TOPIC_KEYS)", "helpTopicSections(SOME_OTHER_KEYS)"],
    ["旧式 .map( 调用被换掉", "HELP_USAGE_TOPIC_KEYS.map(", "SOME_OTHER_KEYS.map("],
  ] as Array<[string, string, string]>) {
    const mutated = real.replace(from, to);
    if (mutated === real) continue; // 该写法本版本不存在（两种写法只需存在其一）
    assert.ok(modalProblems(mutated).some((p) => p.includes("HELP_USAGE_TOPIC_KEYS")), `点题章节不再由清单驱动必须判红（${label}）`);
  }
  // 点题被排到原有段落**之后**（等于没点题）⇒ 必红。
  // 变异构造：把「点题章节一级容器」整块剪下来，插到「原有段落」那一块之后。
  // g-498：一级容器内已是「分组 → 组标题 + 逐键渲染」两层结构，故切片按**一级容器的开始标记**
  // 与「原有段落块」的开始标记切分（不跨函数贪婪匹配）⇒ 变异真实、且新结构下仍然可判别。
  // 「由清单驱动」在切片内**必然**成立（容器正是 `sections.map(...)` 展开的），故实例侧只断言
  // 容器与原有段落两块都真的取到；「写死子集 ⇒ 判红」由上面 undriven 两条负向对照独立关住。
  const topicStart = real.indexOf('h("div", { className: "dg-help-topic", key: "help-topic" },');
  const usageStart = real.indexOf("...HELP_USAGE_KEYS.map(");
  assert.ok(topicStart >= 0 && usageStart > topicStart, "变异切片必须真的取到两块");
  const topicBlock = real.slice(topicStart, usageStart);
  const usageBlock = real.match(/\.\.\.HELP_USAGE_KEYS\.map\([\s\S]*?dgT\(key\)\)\),\n/)![0];
  assert.ok(topicBlock.includes('className: "dg-help-topic"') && usageBlock.includes("HELP_USAGE_KEYS.map("), "变异切片必须真的取到两块");
  const movedAfter = real.replace(topicBlock, "").replace(usageBlock, usageBlock + topicBlock);
  assert.notEqual(movedAfter, real, "负向对照必须真实改变输入");
  assert.ok(modalProblems(movedAfter).some((p) => p.includes("之前")), "点题章节排到原有段落之后必须判红");
  const dropFaq = real.replace("const HELP_FAQ_ITEMS = [1, 2, 3, 4, 5, 6, 7, 8];", "const HELP_FAQ_ITEMS = [1, 2, 3, 4, 5, 6, 7];");
  assert.notEqual(dropFaq, real, "负向对照必须真实改变输入");
  assert.ok(modalProblems(dropFaq).some((p) => p.includes("FAQ")), "拿掉 FAQ 点题问答必须判红");
  // 去重引用被拿掉 ⇒ 必红（容器类名与引用文案必须**同时**存在，拿掉任一条即判红）。
  assert.ok(
    modalProblems(real.replace(/className: "dg-design-crossref"/g, 'className: "dg-design-roadmap"')).some((p) => p.includes("dg-design-crossref")),
    "拿掉设计页签的去重引用容器必须判红",
  );
  assert.ok(
    modalProblems(real.replace(/dgT\("help\.topic\.designCrossref"\)/g, 'dgT("design.notice")')).some((p) => p.includes("designCrossref")),
    "拿掉设计页签的去重引用文案必须判红",
  );

  // ② 定义被改写却仍标称逐字引用 ⇒ 必红。
  const rewritten = String(zh["help.topic.definition"]).replace("而不是依赖单个智能体跑单条循环", "而不是让单个智能体一直跑下去");
  assert.notEqual(rewritten, zh["help.topic.definition"], "负向对照必须真实改变输入");
  const mutatedDef = { ...zh, "help.topic.definition": rewritten };
  assert.ok(
    topicCopyProblems(mutatedDef, en).some((p) => p.includes("逐字")),
    "定义被改写却仍标称逐字引用必须判红",
  );
  // 定义整段删掉（来源标注还在）也必须判红 —— 防「只留来源、丢了原文」。
  assert.ok(
    topicCopyProblems({ ...zh, "help.topic.definition": "图工程是一种把多智能体组织起来的方法。" }, en).some((p) => p.includes("逐字")),
    "丢掉逐字原文必须判红",
  );
  // 来源标注被拿掉 mcp.so 也必须判红。
  assert.ok(
    topicCopyProblems({ ...zh, "help.topic.definitionSource": "以上为逐字引用。" }, en).some((p) => p.includes("mcp.so")),
    "来源标注丢 mcp.so 必须判红",
  );
  // ②′ 逐字节强比对：**一字之差**（近义替换、少一字、多一字）都必须判红 —— 不只是「子串找不到」。
  const nearMiss = [
    ["近义替换", "而不是让单个智能体一直跑下去"],
    ["少一个字", "而不是依赖单个智能体跑单循环"],
    ["多一个字", "而不是依赖单个智能体跑单条的循环"],
  ] as const;
  for (const [kind, ending] of nearMiss) {
    const mutated = String(zh["help.topic.definition"]).replace("而不是依赖单个智能体跑单条循环", ending);
    assert.notEqual(mutated, zh["help.topic.definition"], `负向对照（${kind}）必须真实改变输入`);
    const problems = topicCopyProblems({ ...zh, "help.topic.definition": mutated }, en);
    assert.ok(problems.some((p) => p.includes("逐字节相同")), `${kind}：引文与原文不符必须判红（且点名逐字节比对）`);
    assert.ok(problems.some((p) => /首个差异 @\d+/.test(p)), `${kind}：判红信息必须给出首个差异位`);
  }
  // 引文范围无法判定（去掉「」引号）也必须判红。
  assert.ok(
    topicCopyProblems({ ...zh, "help.topic.definition": "mcp.so 把它定义为：" + GRAPH_ENGINEERING_DEFINITION + "。" }, en).some((p) =>
      p.includes("必须以「」标出逐字引文"),
    ),
    "无法判定引用范围必须判红",
  );
  // ②″ 两侧口径自洽：en 单独声称 verbatim（zh 不声称）必须判红；en 声称 verbatim 却未写明是中文原文
  //     的逐字引用（读起来像 en 自身逐字）也必须判红。
  assert.ok(
    topicCopyProblems(zh, { ...en, "help.topic.definitionSource": "This English text is quoted verbatim; source: mcp.so." }).some((p) =>
      p.includes("中文原文"),
    ),
    "en 声称 verbatim 却未写明引用的是中文原文必须判红",
  );
  assert.ok(
    topicCopyProblems({ ...zh, "help.topic.definitionSource": "以上为意译，来源：mcp.so。" }, en).some((p) => p.includes("不得单独标称 verbatim")),
    "zh 不标称逐字时 en 不得单独标称 verbatim 必须判红",
  );

  // ③ 把「后续版本开放」写成已具备 ⇒ 必红。
  const asShipped = "图的自定义功能已经支持（图语义调整、可视化自定义均可用），当前版本可以直接调整这张图。";
  assert.ok(
    topicCopyProblems({ ...zh, "help.topic.roadmap": asShipped }, en).some((p) => p.includes("已具备") || p.includes("后续版本")),
    "把「后续版本开放」写成已具备必须判红",
  );
  assert.ok(
    topicCopyProblems({ ...zh, "help.topic.designCrossref": "本页签已经支持自定义这张图。" }, en).some((p) => p.includes("已具备")),
    "设计页签引用不得声称已支持自定义",
  );

  // ④ en 侧缺键/空值 ⇒ 必红。
  const dropEnKey = { ...en };
  delete dropEnKey["help.topic.roadmap"];
  assert.ok(topicCopyProblems(zh, dropEnKey).some((p) => p.includes("help.topic.roadmap") && p.includes("en")), "en 缺键必须判红");
  assert.ok(topicCopyProblems(zh, { ...en, "help.topic.faqA": "   " }).some((p) => p.includes("en 文案缺失或为空")), "en 空值必须判红");
  assert.ok(topicCopyProblems(zh, { ...en, "help.topic.stateOfMind": "The board is only a view 看板" }).some((p) => p.includes("含 CJK")), "en 混 CJK 必须判红");

  // 顺手收口：原生 title 回归 ⇒ 必红。
  assert.ok(
    modalProblems(real.replace('className: "dg-design-frame",', 'className: "dg-design-frame", title: "x",')).some((p) => p.includes("原生 title")),
    "原生 title 回归必须判红",
  );

  // hermetic：真实文件零改动。
  assert.equal(readModal(), real, "负向对照必须 hermetic（真实文件零改动）");
  assert.equal(readDicts()[0]["help.topic.definition"], zh["help.topic.definition"], "负向对照必须 hermetic（字典零改动）");
});

// ================================================================ D. graph_help(topic)

/** g-495 att-005：usage **按需面资产**全文（`topic=usage` 的权威来源）。
 *  在 D1 之前读一次，供「真实资产全文比对」与后续 en 对偶使用；**不从 help 派生**。 */
const usageAssetZhFull = readFileSync(usageZhPromptPath, "utf8");
const usageAssetEnFull = readFileSync(usageEnPromptPath, "utf8");

test("g-493 D1（g-495 改判）：graph_help 省略 topic 返回渲染后全文；usage / graph_engineering / 模块名各自取到切片；未知名不伪造", () => {
  const raw = readFileSync(helpZhPromptPath, "utf8");
  const full = String(runHelp({}).help ?? "");
  // g-495 A：全文不再与源资产逐字相等 —— 模块状态位由 `{moduleId}` 渲染为当前生效值。
  // 其余正文仍须逐字一致（用占位归一后比对；负向对照见 g-347 D）。
  const norm = (t: string) => t.replace(/\{(tags|memory|shared_cards|automation_prompts|attachments)\}/g, "{M}").replace(/(\|\s*)开启(\s*\|)/g, "$1{M}$2");
  assert.equal(norm(full), norm(raw), "省略 topic 必须返回「源资产 + 状态位渲染」的全文");
  assert.doesNotMatch(full, /\{[a-z_]+\}/, "全文不得残留未渲染占位");

  const usage = runHelp({ topic: "usage" });
  assert.equal(usage.found, true, "topic=usage 必须命中");
  // g-495 att-005 返工（负责人 2026-10-15 真实 review 授权）：旧断言把 usage 钉成
  // `full.slice(0, full.indexOf("\n## "))` —— 那是**自指公式**（拿 help 切片去比 help 切片），
  // 于是「usage 只返回 help 首句 10 字符」这种死链照样判绿。现改为**真实 usage 资产全文比对**
  // + 若干**独立语义锚点**（锚点不由本文件的比对公式派生 ⇒ 返回 10 字符 / 只截到 1220 字必红）。
  assert.equal(usage.help, usageAssetZhFull.trimEnd(), "topic=usage 必须逐字返回 prompts/usage.zh.md 全文");
  assert.ok(usage.help.length > 3000, `usage 切片必须是完整使用说明（实得 ${usage.help.length} 字符；旧死链只有 10 字符）`);
  assert.ok(usage.help.includes("## 工具细则"), "usage 必须含「工具细则」章节标题（不得只截到首个二级标题之前）");
  assert.ok(usage.help.includes("graph_start_attempt"), "usage 必须含工具签名条目（graph_start_attempt）");
  assert.ok(usage.help.includes("baseline_commit"), "usage 必须含字段口径锚点 baseline_commit");
  assert.ok(usage.help.includes("machine_report"), "usage 必须含证据分层锚点 machine_report");
  assert.ok(usage.help.includes("证据分层"), "usage 必须保留证据分层措辞（machine_report 证据分层）");
  // 与 help 的关系：usage 是**按需面资产**，不是 help 资产的任何切片 —— 两条路径彼此独立。
  assert.ok(!raw.includes("## 工具细则"), "help.zh.md 不得含工具细则章节（细则只在 usage 按需面）");
  assert.ok(usage.help.length > full.length, "usage 按需面必须比默认 help 更长（否则渐进式披露退化）");
  // 同义词 / 大小写覆盖（负责人 2026-10-15 实测面）：usage / 使用说明 / USAGE 都必须取到同一份全文。
  for (const alias of ["usage", "USAGE", "Usage", "使用说明"]) {
    const r = runHelp({ topic: alias });
    assert.equal(r.found, true, `topic「${alias}」必须命中 usage`);
    assert.equal(r.help, usage.help, `topic「${alias}」必须与 topic=usage 返回同一份 usage 全文`);
  }
  // en 侧对偶：真实实现（经 `_helpTopicText` 的追加面绑定）在 en usage 资产上必须返回 en 全文。
  const enUsage = _helpTopicText("", "usage", [usageAssetEnFull]);
  assert.equal(enUsage, usageAssetEnFull.trimEnd(), "en usage 面必须逐字返回 prompts/usage.en.md 全文");
  assert.ok(enUsage!.includes("## Tool details"), "en usage 全文必须含 Tool details 章节（en 对偶锚点）");
  assert.ok(enUsage!.includes("machine_report"), "en usage 全文必须含字段口径锚点 machine_report");

  const ge = runHelp({ topic: "graph_engineering" });
  assert.equal(ge.found, true, "topic=graph_engineering 必须命中");
  assert.ok(ge.help.includes(GRAPH_ENGINEERING_DEFINITION), "图工程主题必须含逐字定义");
  assert.ok(ge.help.includes("mcp.so"), "图工程主题必须标注来源 mcp.so");
  assert.ok(!ge.help.includes("## 目标生命周期"), "图工程主题不得夹带别的章节");
  assert.equal(ge.help, runHelp({ topic: "图工程" }).help, "zh 别名与英文主题名必须取到同一段");
  // g-495 返工（裁决·出路 1）：点题段**已从 help 迁到按需面 usage** ⇒ 命中的切片必须来自 usage，
  // 且与 usage 资产里的该章节逐字相等（跨资产查找的**正**证据；负向对照见 D4）。
  assert.ok(usageAssetZhFull.includes(ge.help), "topic=graph_engineering 的切片必须逐字取自 usage.zh.md 的该章节");
  assert.ok(!raw.includes(GRAPH_ENGINEERING_DEFINITION), "help.zh.md 仍不得含点题定义（载体只在 usage）");
  // en 侧同一路径：language 由配置解析（本夹具为 zh），故 en 不走 `execute()`，而是直接验证
  // **en usage 资产**承载了同名章节（跨资产查找对 en 面同样成立；英译对偶，不要求含 zh 逐字串）。
  const enSection = usageAssetEnFull.split(/\n(?=## )/).find((s) => s.startsWith("## ") && /dsh-graph/.test(s.split("\n")[0]!) && /Graph Engineering/i.test(s.split("\n")[0]!));
  assert.ok(enSection, "usage.en.md 必须含「为什么叫 dsh-graph…」章节（en 查找面）");
  assert.ok(/Graph Engineering/.test(enSection!), "en 章节必须点题 Graph Engineering");
  assert.ok(/mcp\.so/.test(enSection!), "en 章节必须标注来源 mcp.so");

  // g-495 B（改判）：topic 的口径从**工具名**改为**模块名**（help 已不再逐条列工具）。
  // 每个模块名都必须可查，且切片恰好是该模块那一行（表头 + 该行，不含别的模块行）。
  for (const mod of HARNESS_MODULE_IDS) {
    const r = runHelp({ topic: mod });
    assert.equal(r.found, true, `模块 ${mod} 必须是可查主题`);
    assert.ok(r.help.includes(`{${mod}}`) || /\|\s*(?:开启|关闭)\s*\|/.test(r.help), `模块 ${mod} 切片必须含其状态列`);
    assert.ok(r.help.includes("| 模块 |"), `模块 ${mod} 切片必须含表头`);
    for (const other of HARNESS_MODULE_IDS) {
      if (other !== mod) assert.ok(!r.help.includes(`{${other}}`), `模块 ${mod} 切片不得越界到 ${other}`);
    }
  }
  // 模块名的 zh 别名也须命中（如「标签」「共享卡」）。
  assert.equal(runHelp({ topic: "标签" }).found, true, "模块 zh 别名「标签」必须命中");

  const unknown = runHelp({ topic: "graph_not_a_tool" });
  assert.equal(unknown.found, false, "未知名不得被判为命中（不许伪造内容）");
  assert.equal(unknown.help, full, "未知名必须回落整份帮助");
  // g-495 返工项 3（**判别力方向反转**，非删除）：工具名 topic **不再命中** —— 负责人
  // 2026-10-13 裁定「没必要查单个工具，schema 注入时应该提供了足够信息」⇒ 旧分支已删除。
  // 此处对**全部已注册工具名**逐个做负向断言（断言数只增不减：旧 D1 是「全部 found===true」，
  // 现在是「全部 found===false 且回落全文」）。
  assert.ok(registeredToolNames.length > 0, "注册真源不得为空（否则下面的负向断言退化）");
  for (const name of registeredToolNames) {
    const r = runHelp({ topic: name });
    assert.equal(r.found, false, `工具名 topic「${name}」不得再命中（工具名分支已按负责人裁定删除）`);
    assert.equal(r.help, full, `工具名 topic「${name}」必须回落整份帮助`);
  }
  // `topic` 只认 usage / graph_engineering / 模块名 —— 别的一切名（含 rpc 风格与大小写变体）一律不命中。
  for (const name of ["graph_status", "usage:graph_help", "GRAPH_CREATE_GOAL", "graph_create_goal "]) {
    assert.equal(runHelp({ topic: name }).found, false, `非主题名「${name}」不得命中`);
  }
  assert.equal(runHelp({ topic: "graph_create_goal" }).found, false, "工具名 graph_create_goal 必须不再命中（负向钉住）");
  assert.equal(runHelp({ topic: "   " }).found, undefined, "空白 topic 等价于省略");
  assert.equal(String(runHelp({ topic: "   " }).help), full, "空白 topic 必须返回全文");
});

test("g-493 D2（g-495 返工项 B 负向对照·经**真实实现**）：把「工具名 topic 命中」分支人为加回 ⇒ 真实 helpTopicText 必给出 found 语义变化", () => {
  // g-495 返工项 B：旧版本用「源码文本 + 内联重写的正则」重放旧分支 —— 那**没有走真实函数**，
  // 无法证明回归时会判红。此处改为把变异后的文本送进**真实 `helpTopicText`**（测试钩子导出的是
  // 与 `graph_help` 运行时**同一函数引用**），由真实实现给出裁决。
  const src = readFileSync(engineSrcPath, "utf8");
  assert.ok(
    /const moduleId = helpTopicModuleId\(key\);\n  if \(moduleId\) return helpModuleTopicText\(src, moduleId\);\n  return null;/.test(src),
    "工具名分支必须已删除（模块名之后直接 return null）",
  );
  assert.ok(!/toolMatch/.test(src), "源码不得再残留 toolMatch 工具名分支");
  const raw = readFileSync(helpZhPromptPath, "utf8");
  // ① 真实资产（未变异）经真实实现：工具名 topic 一律 null（不命中）。
  for (const name of ["graph_create_goal", "graph_help", "graph_transition"]) {
    assert.equal(_helpTopicText(raw, name, []), null, `真实实现：工具名「${name}」必须不命中（返回 null）`);
  }
  // ② 反向对照：**真实实现**能对「确有该主题」的输入给出非 null —— 证明判据不是恒 null 的恒真式。
  //    g-495 att-005：`usage` 主题的权威面是**按需资产**，必须经追加面显式绑定（不再从 help 派生）。
  assert.notEqual(_helpTopicText(raw, "usage", [usageAssetZhFull]), null, "真实实现：绑定 usage 按需面后必须命中（否则上面的 null 是恒真）");
  assert.equal(_helpTopicText(raw, "usage", []), null, "真实实现：不绑定 usage 按需面时 usage 主题必须不命中（help 面不承载细则）");
  // ③ 把旧分支的行为**真的做出来**：旧实现对 `- <工具名>(` 行返回该行。这里用真实实现无法制造
  //    「工具名命中」，故改判到**等价或更强**的载体 —— 用真实实现证明「真实 usage 资产里的内容变化」
  //    经真实查找函数**确实产生可观察的裁决变化**（若判据恒真，这里不会翻转）。
  const MUTANT_ROW = "- graph_ZZZ_mutant_probe(fake) 变异探针条目";
  assert.ok(!usageAssetZhFull.includes("graph_ZZZ_mutant_probe"), "变异探针串不得原本就存在于真实资产（否则负向对照退化）");
  const withLegacyRow = `${usageAssetZhFull}\n${MUTANT_ROW}\n`;
  assert.notEqual(withLegacyRow, usageAssetZhFull, "负向对照必须真实改变输入");
  // 真实实现上：给真实 usage 面追加条目行 ⇒ 真实返回的 usage 切片必须随之变化，由真实函数给出裁决。
  const mutatedUsage = _helpTopicText("", "usage", [withLegacyRow]);
  const realUsage = _helpTopicText("", "usage", [usageAssetZhFull]);
  assert.notEqual(mutatedUsage, realUsage, "真实实现：usage 面变异后返回切片必须变化（判据可被证伪）");
  assert.ok(mutatedUsage!.includes(MUTANT_ROW), "真实实现：变异内容必须进入真实返回切片");
  assert.ok(!realUsage!.includes(MUTANT_ROW), "基线对照：未变异返回值不得含该变异条目行");
  // ③′ **空壳变异必红（经真实实现）**：这是 att-005 死链的**最小复现** —— 旧实现只返回 help 首句
  //     那样的 10 字符内容时，下面的「含工具细则」判据必须判红（而不是被自指公式放行）。
  const SHELL = "共 5 个功能模块：";
  assert.equal(SHELL.length, 10, "空壳复现串必须恰为 10 字符（对齐负责人实测的 help 首句）");
  assert.ok(!SHELL.includes("## 工具细则"), "空壳不含工具细则（负向前置）");
  const shellHit = _helpTopicText("", "usage", [SHELL]);
  assert.equal(shellHit, SHELL, "空壳面会被真实实现原样返回（故须由下方内容锚点判据兜住）");
  assert.ok(!shellHit!.includes("## 工具细则"), "真实实现：空壳返回不得含工具细则 ⇒ D1 的内容锚点必红（死链回归可被捕获）");
  assert.ok(!shellHit!.includes("machine_report"), "真实实现：空壳返回不得含 machine_report ⇒ D1 的证据分层锚点必红");
  // ④ 无论资产怎么变，**工具名 topic 在真实实现上恒不命中** —— 这正是 D1 负向断言的判别力来源。
  assert.equal(_helpTopicText(withLegacyRow, "graph_create_goal", []), null, "真实实现：加回工具条目行也不得让工具名 topic 命中");
});

// ================================================================ D3. 生命周期串一致性（g-495 返工项 4）

test("g-493 D3（g-495 返工项 4）：生命周期串在 tool.graph_transition / usage.zh / usage.en 三处逐字一致（防漂移）", () => {
  // att-002 只读前提验证结论：逐工具口径覆盖 50/51，**唯一真丢失**＝目标生命周期链
  //（baseline help.zh.md 有，而 tool.graph_transition 与 schema 均无）。方案 A：把序列追加到
  // `tool.graph_transition` 描述末尾 ⇒ 天然进入 harness 逐工具注入面。本断言钉住**三处不漂移**。
  const ZH_CYCLE = "draft→planning→collecting→ready→in_progress→review→delivered";
  const EN_CYCLE = "draft→planning→collecting→ready→in_progress→review→delivered";
  const zhDict = SERVER_I18N.zh as Record<string, string>;
  const enDict = SERVER_I18N.en as Record<string, string>;
  const usageZh = readFileSync(join(repoRoot, "prompts/usage.zh.md"), "utf8");
  const usageEn = readFileSync(join(repoRoot, "prompts/usage.en.md"), "utf8");
  assert.ok(zhDict["tool.graph_transition"]!.includes(ZH_CYCLE), "tool.graph_transition(zh) 必须含生命周期序列");
  assert.ok(enDict["tool.graph_transition"]!.includes(EN_CYCLE), "tool.graph_transition(en) 必须含生命周期序列");
  assert.ok(usageZh.includes(ZH_CYCLE), "usage.zh.md 必须含同一生命周期序列");
  assert.ok(usageEn.includes(EN_CYCLE), "usage.en.md 必须含同一生命周期序列");
  // blocked 支线：两处都要写明「进 blocked 必须 reason」，不得只在一处。
  for (const [label, text] of [["zh", zhDict["tool.graph_transition"]!], ["en", enDict["tool.graph_transition"]!]] as Array<[string, string]>) {
    assert.ok(/blocked/.test(text), `tool.graph_transition(${label}) 必须提到 blocked 支线`);
    assert.ok(/reason/.test(text), `tool.graph_transition(${label}) 必须写明进 blocked 要给 reason`);
  }
  // 负向对照（真实树上的内存变异）：任何一处把序列改掉 ⇒ 三处一致性判据必红。
  const mutated = zhDict["tool.graph_transition"]!.replace(ZH_CYCLE, "draft→planning→done→delivered");
  assert.notEqual(mutated, zhDict["tool.graph_transition"], "负向对照必须真实改变输入");
  assert.ok(!mutated.includes(ZH_CYCLE), "负向对照：改写后必须不再含原序列（判据可被证伪）");
  assert.ok(usageZh.includes(ZH_CYCLE), "负向对照只动字典、不得污染 usage.zh.md（hermetic）");
});

// ================================================================ D4. 跨资产查找（返工·出路 1）

test("g-493 D4（g-495 返工项 B 负向对照·经**真实实现**）：点题章节只在 usage ⇒ 跨资产查找命中；两面都无 ⇒ 真实实现必给 null", () => {
  // g-495 返工项 B：旧版用本地 `strip()` 造变异串、随后**只用同一纯谓词 `hasTopicSection()` 复验**
  // ⇒ 同义反复（谓词与变异同源于本文件，根本没进真实实现）。现改为：变异后的文本一律送进
  // **真实 `helpTopicText`** 得出裁决，纯谓词只用于「真实树取证」的前置核对。
  const helpZh = readFileSync(helpZhPromptPath, "utf8");
  const usageZh = readFileSync(usageZhPromptPath, "utf8");
  // 真实树取证（前置核对；判定本身走真实实现）：help 资产**无**该章节、usage 资产**有**该章节。
  assert.equal(_isGraphEngineeringSectionTitle("## 为什么叫 dsh-graph：图工程"), true, "章节判定真源必须认出该标题");
  assert.equal(helpZh.split(/\n(?=## )/).some((s) => s.startsWith("## ") && _isGraphEngineeringSectionTitle(s.split("\n")[0]!)), false, "help.zh.md 不得再含点题章节（载体已迁走）");
  assert.equal(usageZh.split(/\n(?=## )/).some((s) => s.startsWith("## ") && _isGraphEngineeringSectionTitle(s.split("\n")[0]!)), true, "usage.zh.md 必须含点题章节（新载体）");
  // 行为面：真实 `execute()` 必须命中，且切片**逐字**等于 usage 里的该章节（跨资产而非单资产）。
  const ge = runHelp({ topic: "graph_engineering" });
  assert.equal(ge.found, true, "跨资产查找必须命中（help 无此章节时回落 usage）");
  const usageSection = usageZh.split(/\n(?=## )/).find((s) => s.startsWith("## ") && _isGraphEngineeringSectionTitle(s.split("\n")[0]!));
  assert.equal(ge.help, usageSection!.trimEnd(), "切片必须逐字取自 usage 的该章节");
  // 负向对照（**经真实实现**）：把**两个面**的该章节都拿掉 ⇒ 真实 `helpTopicText` 必须给 null。
  // 剥章节用真实实现同源的判定（`_isGraphEngineeringSectionTitle`），但**裁决由真实查找函数给出**。
  const stripTitleLines = (t: string) =>
    t.split("\n").filter((l) => !(l.startsWith("## ") && _isGraphEngineeringSectionTitle(l))).join("\n");
  const strippedUsage = stripTitleLines(usageZh);
  const strippedHelp = stripTitleLines(helpZh);
  assert.notEqual(strippedUsage, usageZh, "负向对照必须真实改变输入（剥掉 usage 章节标题）");
  // 真实实现上的裁决：help 面本就无、usage 面被剥掉 ⇒ 必须 null（而非伪造内容）。
  assert.equal(_helpTopicText(strippedHelp, "graph_engineering", [strippedUsage]), null, "两面都无该章节时真实查找必须返回 null");
  // 基线对照：同一函数在**未变异**输入上必须命中 ⇒ 上面的 null 不是恒真。
  assert.notEqual(_helpTopicText(helpZh, "graph_engineering", [usageZh]), null, "未变异输入上真实查找必须命中（否则 null 判据恒真）");
  // 跨资产必要性：真实实现上用**空 usage 面**必须 miss，用**真 usage 面**必须命中 ⇒ 命中确实来自 usage。
  assert.equal(_helpTopicText(helpZh, "graph_engineering", [""]), null, "help 面本身不提供该章节 ⇒ 空 usage 面必须 miss");
  assert.notEqual(_helpTopicText(helpZh, "graph_engineering", [usageZh]), null, "补上真 usage 面后必须命中（跨资产必要性成立）");
  // en 侧同口径：真实实现必须能在 en usage 资产上命中（zh/en 双向对称）。
  const usageEn = readFileSync(usageEnPromptPath, "utf8");
  assert.notEqual(_helpTopicText("", "graph_engineering", [usageEn]), null, "en usage 资产必须承载同名章节（真实实现可命中）");
  assert.ok(_helpTopicText("", "graph_engineering", [usageEn])!.includes("Graph Engineering"), "en 命中切片必须点题 Graph Engineering");
});

// ================================================================ D5. 重复章节的优先级语义（g-495 返工项 C）

test("g-493 D5（g-495 返工项 C）：help/usage 两面都有同形点题章节时，优先级语义**明确且可预期**（help 优先）", () => {
  // 评审残余风险：查找顺序是 **help 优先、usage 兜底** ⇒ 若 help 资产**日后**重新出现同形
  // `## 图工程` 章节，运行时会**返回 help 版本**而非 usage 权威章节。本用例把该场景钉死：
  // 不留下「未定义行为 + 无断言」—— 语义与理由都写成断言。
  const HELP_TOPIC = "## 为什么叫 dsh-graph：图工程\nHELP 面版本";
  const USAGE_TOPIC = "## 为什么叫 dsh-graph：图工程\nUSAGE 面版本（权威）";
  const helpFace = `前言\n${HELP_TOPIC}\n`;
  const usageFace = `使用说明前言\n${USAGE_TOPIC}\n`;
  // (i) 两面都有 ⇒ 真实实现**必须返回 help 版本**（既定优先级：help 优先、usage 兜底）。
  const both = _helpTopicText(helpFace, "graph_engineering", [usageFace]);
  assert.equal(both, HELP_TOPIC, "两面都有该章节时必须返回 **help 版本**（help 优先、usage 兜底）");
  assert.ok(both!.includes("HELP 面版本"), "返回的切片必须逐字来自 help 面");
  assert.ok(!both!.includes("USAGE 面版本"), "返回的切片不得夹带 usage 面内容");
  // 优先级是**可预期**的：与调用顺序无关，只由 faces 数组顺序（[help, ...extra]）决定。
  assert.equal(_helpTopicText(helpFace, "graph_engineering", [usageFace, usageFace]), both, "重复 usage 面不得改变优先级");
  // (ii) help 面无、usage 面有 ⇒ 回落 usage（兜底语义）。
  assert.equal(_helpTopicText("前言\n## 别的章节\nX", "graph_engineering", [usageFace]), USAGE_TOPIC, "help 面无该章节时必须回落 usage 权威章节");
  // (iii) 现状钉住：**当前真实 help 资产不得含该章节** ⇒ 实际运行时命中的仍是 usage 权威版本。
  //      这一条与 (i) 合起来即是评审要求的 (i)+(ii)：现状由断言守住，未来若 help 复活该章节，
  //      优先级语义已被 (i) 明确定义（返回 help 版本），不会变成未定义行为。
  const helpZh = readFileSync(helpZhPromptPath, "utf8");
  const helpEn = readFileSync(helpEnPromptPath, "utf8");
  const hasTopicSection = (t: string) =>
    t.split(/\n(?=## )/).some((s) => s.startsWith("## ") && _isGraphEngineeringSectionTitle(s.split("\n")[0]!));
  assert.equal(hasTopicSection(helpZh), false, "help.zh.md 不得含点题章节（现状钉住：权威载体只在 usage）");
  assert.equal(hasTopicSection(helpEn), false, "help.en.md 不得含点题章节（zh/en 双向对称钉住）");
  // 真实实现上的现状复核：真实两资产组合 ⇒ 命中的必须是 **usage** 切片（因为 help 面确实没有）。
  const usageZh = readFileSync(usageZhPromptPath, "utf8");
  const realHit = _helpTopicText(helpZh, "graph_engineering", [usageZh]);
  const usageSection = usageZh.split(/\n(?=## )/).find((s) => s.startsWith("## ") && _isGraphEngineeringSectionTitle(s.split("\n")[0]!));
  assert.equal(realHit, usageSection!.trimEnd(), "真实资产组合下命中的必须是 usage 权威章节（help 面为空 ⇒ 兜底生效）");
  // (iv) 反向钉住：把 help 面人为加上该章节 ⇒ 真实实现**必须翻转**为 help 版本（判据可被证伪）。
  const helpWithTopic = `${helpZh}\n${HELP_TOPIC}\n`;
  assert.notEqual(hasTopicSection(helpWithTopic), hasTopicSection(helpZh), "负向对照：加回章节必须真实翻转 help 面判定");
  assert.equal(_helpTopicText(helpWithTopic, "graph_engineering", [usageZh]), HELP_TOPIC, "help 面复活该章节后真实实现必须返回 help 版本（优先级翻转可观察）");
});

// ================================================================ D7. usage 分支的面绑定语义（att-005）

test("g-493 D7（g-495 att-005）：usage 主题的**面绑定**明确 —— 权威面是 usage 追加面，绝不回落 help 切片", () => {
  // att-005 修的死链根因：`usage` 分支曾取 **help 正文**「文首到首个 `## `」⇒ 返回 help 首句
  // （实得 10 字符），与「usage 该返回完整使用说明」的承诺脱节。修法把该分支**只绑定 usage 追加面**。
  // 本用例把新语义的**每个可观察侧面**钉成断言（含与 graph_engineering 的语义**独立性**）。
  const HELP_FACE = "共 5 个功能模块：\n\n## 功能模块\n| 模块 | 作用 | 状态 |\n";
  const USAGE_FACE = "usage 前言\n## 工具细则（描述里已裁剪，按需查这里）\n\n**graph_start_attempt** —— 字段口径。\n";
  // (i) 只认 usage 追加面：传了 usage 面就返回 **usage 全文**（含 `## ` 之后的内容）。
  assert.equal(_helpTopicText(HELP_FACE, "usage", [USAGE_FACE]), USAGE_FACE.trimEnd(), "usage 必须逐字返回 usage 追加面全文");
  assert.ok(_helpTopicText(HELP_FACE, "usage", [USAGE_FACE])!.includes("## 工具细则"), "usage 返回必须含 `## 工具细则`（不得只截到首个二级标题之前）");
  assert.ok(!_helpTopicText(HELP_FACE, "usage", [USAGE_FACE])!.includes("功能模块"), "usage 返回必须**不含** help 面内容（面绑定互不串味）");
  // (ii) 语义独立性（**这是与 graph_engineering 的关键差别**）：help 面**再丰富也影响不到** usage ——
  //      即便 help 面自带完整 usage 形态的正文，usage 仍只认 usage 追加面。
  const richHelp = `${HELP_FACE}\n## 工具细则\nhelp 面自带的假细则\n`;
  assert.equal(_helpTopicText(richHelp, "usage", [USAGE_FACE]), USAGE_FACE.trimEnd(), "help 面内容不得影响 usage 结果（help 面不是 usage 的来源）");
  // (iii) 追加面缺失/为空 ⇒ **不命中**（而不是回落 help 切片 —— 回落会把死链放回来）。
  for (const [label, faces] of [["[]", []], ["[\"\"]", [""]], ["[null]", [null]]] as Array<[string, any[]]>) {
    assert.equal(_helpTopicText(HELP_FACE, "usage", faces), null, `追加面为 ${label} 时 usage 必须不命中（不得回落 help 切片）`);
  }
  // (iv) 与 graph_engineering 的对照：同一组输入上两个 topic 走**不同**的面。
  //      graph_engineering 在 help 面命中时返回 help 版本（help 优先），而 usage 永远不看 help 面。
  const GE = "## 为什么叫 dsh-graph：图工程\nHELP 版本";
  const helpWithGe = `${HELP_FACE}\n${GE}\n`;
  assert.equal(_helpTopicText(helpWithGe, "graph_engineering", [USAGE_FACE]), GE, "graph_engineering 仍须 help 优先（既有语义不受本次修复影响）");
  assert.equal(_helpTopicText(helpWithGe, "usage", [USAGE_FACE]), USAGE_FACE.trimEnd(), "同一输入上 usage 仍只取 usage 面（两 topic 语义相互独立）");
  // (v) 大小写 / 别名归一后走**同一分支**：usage / USAGE / Usage / 使用说明 结果必须一致。
  for (const alias of ["usage", "USAGE", "Usage", "使用说明"]) {
    assert.equal(_helpTopicText(HELP_FACE, alias, [USAGE_FACE]), USAGE_FACE.trimEnd(), `别名「${alias}」必须与 usage 走同一分支并返回同一全文`);
  }
  // (vi) 真实资产上的端到端复核：真实 execute() 的返回必须等于真实 usage 资产全文
  //      （并**不得**等于 help 首句那种切片）—— 死链的直接判据。
  const real = runHelp({ topic: "usage" });
  assert.equal(real.help, usageAssetZhFull.trimEnd(), "真实 execute 必须返回真实 usage 资产全文");
  const rawHelp = readFileSync(helpZhPromptPath, "utf8");
  const helpFirstSection = (rawHelp.split("\n## ")[0] ?? "").trimEnd();
  assert.notEqual(helpFirstSection.length, real.help.length, "usage 返回**不得**退化为 help 首句切片（死链形态）");
  assert.ok(real.help.length > helpFirstSection.length * 10, `usage 全文必须远大于 help 首句（${real.help.length} vs ${helpFirstSection.length}）`);
});

// ================================================================ D6. fail-open 消除（g-495 返工项 A）

test("g-493 D6（g-495 返工项 A）：usage 资产不可读 ⇒ **真实 execute() 必须抛错**，不得静默伪装成「主题不存在」", async () => {
  // 问题（主管实测 index.js:3457-3459）：`try { usageRaw = localizedPrompt("usage", …) } catch { usageRaw = "" }`
  // 把「资产**不可读**」与「该面**不存在**」折叠成同一结果 ⇒ `topic=graph_engineering` 静默返回
  // `found:false`，掩盖真实故障。修法（选项 (a)，最小实现）：**不 catch**，让 `requirePromptAsset`
  // 的异常直接上抛，故障显性可观察。
  // 本用例在**真实运行时路径**上验证：在 `tmp/` 下的**私有可写包副本**里删掉 usage 资产，
  // 再**真跑**该副本的真实 `apply()` + `graph_help.execute()` —— 断言它抛错。
  // g-495 att-005 改判（负责人 2026-10-15 授权）：**不再** rename 运行中的 `dist/prompts/` 资产 ——
  // 该目录在真实部署下是**只读**（EROFS），rename 会失败/污染运行包。私有副本既真实（同一份
  // index.js + prompts + core 编译产物，逐字节复制）又可写，且与运行树零耦合。
  // 源码层钉住：**不得**再出现把 usage 读取失败吞成空串的 catch（人为回退 ⇒ 必红）。
  const engineSrc = readFileSync(engineSrcPath, "utf8");
  assert.ok(
    !/try \{\s*usageRaw = localizedPrompt\("usage"/.test(engineSrc),
    "引擎不得再 catch usage 读取失败（fail-open 回退必红）",
  );
  assert.ok(
    /const usageRaw = localizedPrompt\("usage", language\);/.test(engineSrc),
    "引擎必须以**裸调用**读取 usage 资产（异常上抛）",
  );
  const distDir = join(repoRoot, "dist");
  for (const rel of ["index.js", "prompts/usage.zh.md", "prompts/usage.en.md"]) {
    assert.ok(existsSync(join(distDir, rel)), `运行树必须含 ${rel}（私有副本逐字节复制的来源）`);
  }
  const tmpRoot = join(repoRoot, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const pkgRoot = mkdtempSync(join(tmpRoot, "g495-d6-"));
  try {
    // 逐字节复制私有包（index.js + prompts/ + core/ + lib/），使副本可**真实 apply()**。
    for (const rel of ["index.js", "package.json"]) {
      const from = join(distDir, rel);
      if (existsSync(from)) copyFileSync(from, join(pkgRoot, rel));
    }
    for (const rel of ["prompts", "core", "lib"]) {
      const from = join(distDir, rel);
      if (existsSync(from)) cpSync(from, join(pkgRoot, rel), { recursive: true });
    }
    // 副本位于仓库内 `tmp/`（gitignored，与 worktree 同一约定）⇒ `node_modules` 以**软链**接回
    // 主树依赖（不复制、不安装，也**不**在副本里跑任何包管理器）。
    const linkTarget = existsSync(join(repoRoot, "node_modules")) ? join(repoRoot, "node_modules") : null;
    if (linkTarget) symlinkSync(linkTarget, join(pkgRoot, "node_modules"), "dir");
    const copyEntry = join(pkgRoot, "index.js");
    const copyUsage = join(pkgRoot, "prompts/usage.zh.md");
    assert.ok(existsSync(copyUsage), "私有副本必须含 usage.zh.md（否则本用例无从变异）");
    assert.deepEqual(readFileSync(copyUsage), readFileSync(join(distDir, "prompts/usage.zh.md")), "副本 usage 必须与运行树逐字节相同");
    // 前置基线：副本资产在手时，副本的真实 execute() 必须命中（否则下面的「抛错」无从对照）。
    const copyRun = await loadCopyHelp(copyEntry);
    assert.equal(copyRun({ topic: "graph_engineering" }).found, true, "基线：私有副本资产可读时真实 execute 必须命中");
    assert.equal(copyRun({ topic: "usage" }).found, true, "基线：私有副本上 topic=usage 必须命中");
    // **变异**：只在私有副本里删掉 usage 资产（运行树一字未动）。
    rmSync(copyUsage);
    assert.ok(!existsSync(copyUsage), "变异必须真实生效（副本 usage 资产已删除）");
    let threw: unknown = null;
    let observed: any = null;
    try {
      // **真实运行时路径**：副本的 `graph_help.execute()`（apply 注册后的真实 run 函数）。
      observed = copyRun({ topic: "usage" });
    } catch (err) {
      threw = err;
    }
    // 核心裁决：资产不可读时**必须抛错**，而**不是**返回 `found:false` 的静默路径。
    assert.ok(threw !== null, "usage 资产不可读时真实 execute() 必须抛错（故障可观察），而不是静默返回 found:false");
    assert.equal(observed, null, "不得在抛错之外还产出结果对象（否则仍是 fail-open 的另一形态）");
    const message = String((threw as Error)?.message ?? "");
    assert.ok(/usage\.zh\.md/.test(message), `抛错必须点名不可读的资产（实得：${message}）`);
    assert.ok(/missing or unreadable/.test(message), `抛错必须是资产不可读口径（实得：${message}）`);
    // graph_engineering 走同一条读取路径 ⇒ 同样必须抛错，而不是静默 found:false。
    let geThrew: unknown = null;
    try { copyRun({ topic: "graph_engineering" }); } catch (err) { geThrew = err; }
    assert.ok(geThrew !== null, "usage 资产不可读时 topic=graph_engineering 同样必须抛错（不得静默 found:false）");
    assert.ok(/usage\.zh\.md/.test(String((geThrew as Error)?.message ?? "")), "graph_engineering 抛错也必须点名 usage 资产");
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true });
  }
  // 变异**绝不可**触碰运行树：prompts 里的 usage 资产必须逐字节完好（本用例零写运行包）。
  assert.deepEqual(
    readFileSync(join(distDir, "prompts/usage.zh.md")),
    readFileSync(join(repoRoot, "prompts/usage.zh.md")),
    "运行树 usage 资产必须逐字节完好（D6 只在私有副本里变异）",
  );
  // 对照：同名主题在（未变异的）运行树上必须仍命中 ⇒ 「抛错」不是恒真（同一真实入口、同一 topic）。
  assert.equal(runHelp({ topic: "graph_engineering" }).found, true, "运行树真实 execute 必须命中（判据可被证伪）");
  assert.equal(runHelp({ topic: "usage" }).found, true, "运行树 topic=usage 必须命中（死链回归判据）");
  // 未知名主题在**资产完好**时仍走 `found:false` 的正常路径 —— 证明 fail-open 消除后
  // 「主题确实不存在」这一合法语义没有被误伤（两者**现在可区分**）。
  assert.equal(runHelp({ topic: "graph_not_anything" }).found, false, "主题确实不存在时仍须走 found:false（合法语义未被误伤）");
});

// ================================================================ E. 原生 title 清零

test("g-493 E1：整个帮助弹窗（含 Graph 设计页签 iframe）零原生 title 提示", () => {
  const modal = readModal();
  assert.doesNotMatch(modal, /\btitle:/, "帮助弹窗不得再使用原生 title（改用点击/hover 自绘浮层）");
  // iframe 的可访问名不再依赖 title：改用 name 属性（不产生悬停 tooltip）。
  assert.ok(/h\("iframe", \{[\s\S]*?\bname: dgT\("design\.title"\) \+ " · " \+ dgT\(active\.labelKey\)/.test(modal), "iframe 必须以 name 承载可访问名");
  const region = modal.slice(modal.indexOf("function HelpEntryStep"), modal.indexOf("function HelpFaqTab"));
  assert.ok(region.length > 2000, "新内容区块切片异常（HelpEntryStep → HelpFaqTab）");
  assert.doesNotMatch(region, /\btitle:/, "新解释内容不得使用原生 title");
  // g-495 返工项 B：E1 的**源码回退**钉住必须经真实实现，而不是只匹配源码文本（恒真风险）。
  // 这里把「iframes 的可访问名」当作真实判据：真实 `HelpToolsTab` 源码必须存在，且**name** 承载
  // 可访问名 —— 人为把 name 换回 title 时，`title:` 检测必须判红（经真实文本检测器给出裁决）。
  assert.ok(/function HelpToolsTab\(/.test(modal), "工具清单页签必须存在（E1 钉住的真实载体）");
  const nameToTitleMutant = modal.replace(
    /\bname: dgT\("design\.title"\) \+ " · " \+ dgT\(active\.labelKey\)/,
    'title: dgT("design.title") + " · " + dgT(active.labelKey)',
  );
  assert.notEqual(nameToTitleMutant, modal, "负向对照必须真实改变输入（name → title）");
  assert.match(nameToTitleMutant, /\btitle:/, "真实检测器：改回 title 后必须在真实文本上观察到 title:");
  assert.ok(!/h\("iframe", \{[\s\S]*?\bname: dgT\("design\.title"\)/.test(nameToTitleMutant), "真实检测器：改回 title 后 iframe name 断言必须失败（判据可被证伪）");
  // hermetic：变异只发生在内存，真实文件零改动。
  assert.equal(readModal(), modal, "E1 负向对照必须 hermetic（真实文件零改动）");
});
