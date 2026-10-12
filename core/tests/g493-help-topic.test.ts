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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { apply } from "../../dist/index.js";
import { SERVER_I18N } from "../../dist/lib/server-i18n.js";
import { HARNESS_MODULE_IDS } from "../ops.ts";

const repoRoot = join(import.meta.dirname, "../..");
const helpModalPath = join(repoRoot, "dsh-graph-host/lib/client/help-modal.js");
const i18nSrcPath = join(repoRoot, "dsh-graph-host/lib/client/i18n.js");
const bundlePath = join(repoRoot, "dist/lib/client.js");
const helpZhPromptPath = join(repoRoot, "dsh-graph-host/prompts/help.zh.md");
const helpEnPromptPath = join(repoRoot, "dsh-graph-host/prompts/help.en.md");

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
    const topicAt = modal.indexOf("HELP_USAGE_TOPIC_KEYS.map(");
    const usageAt = modal.indexOf("HELP_USAGE_KEYS.map(");
    if (topicAt < 0) problems.push("点题章节必须由 HELP_USAGE_TOPIC_KEYS 驱动（写死子集 ⇒ 新增段落界面不显示）");
    if (topicAt < 0 || usageAt < 0) problems.push("使用说明页签必须同时渲染点题章节与原有段落");
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
  // 负向对照 ②：把点题段人为加回作者侧 help 资产 ⇒ 「不得含点题」断言必须变红。
  const zhPromptWithTopic = `${zhPrompt}\n## 为什么叫 dsh-graph：图工程\n${GRAPH_ENGINEERING_DEFINITION}\n`;
  assert.ok(zhPromptWithTopic.includes(GRAPH_ENGINEERING_DEFINITION), "负向对照：加回点题段后资产必须重新含定义");
  assert.notEqual(
    zhPromptWithTopic.includes(GRAPH_ENGINEERING_DEFINITION),
    zhPrompt.includes(GRAPH_ENGINEERING_DEFINITION),
    "负向对照：加回点题段必须真实翻转「help 资产不得含点题」的判据",
  );
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
  const undriven = real.replace(/HELP_USAGE_TOPIC_KEYS\.map\(/g, "SOME_OTHER_KEYS.map(");
  assert.notEqual(undriven, real, "负向对照必须真实改变输入");
  assert.ok(modalProblems(undriven).some((p) => p.includes("HELP_USAGE_TOPIC_KEYS")), "点题章节不再由清单驱动必须判红");
  // 点题被排到原有段落**之后**（等于没点题）⇒ 必红。
  // 变异构造：把「点题段落」整块剪下来，插到「原有段落」那一块之后（两处均用**非贪婪**定位，
  // 不用跨函数的贪婪切片 —— 否则会把 HELP_USAGE_KEYS.map( 一并吞掉、变异形同没变）。
  const topicBlock = real.match(/h\("div", \{ className: "dg-help-topic", key: "help-topic" \}[\s\S]*?dgT\(key\)\)\)\),\n/)![0];
  const usageBlock = real.match(/\.\.\.HELP_USAGE_KEYS\.map\([\s\S]*?dgT\(key\)\)\),\n/)![0];
  assert.ok(topicBlock.includes("HELP_USAGE_TOPIC_KEYS.map(") && usageBlock.includes("HELP_USAGE_KEYS.map("), "变异切片必须真的取到两块");
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
  assert.ok(usage.help.length > 0 && usage.help.length < full.length, "usage 必须是切片而不是全文");
  assert.equal(usage.help, full.slice(0, full.indexOf("\n## ")).trimEnd(), "usage = 文首到第一个二级标题");

  const ge = runHelp({ topic: "graph_engineering" });
  assert.equal(ge.found, true, "topic=graph_engineering 必须命中");
  assert.ok(ge.help.includes(GRAPH_ENGINEERING_DEFINITION), "图工程主题必须含逐字定义");
  assert.ok(ge.help.includes("mcp.so"), "图工程主题必须标注来源 mcp.so");
  assert.ok(!ge.help.includes("## 目标生命周期"), "图工程主题不得夹带别的章节");
  assert.equal(ge.help, runHelp({ topic: "图工程" }).help, "zh 别名与英文主题名必须取到同一段");
  // g-495 返工（裁决·出路 1）：点题段**已从 help 迁到按需面 usage** ⇒ 命中的切片必须来自 usage，
  // 且与 usage 资产里的该章节逐字相等（跨资产查找的**正**证据；负向对照见 D4）。
  const usageAssetZh = readFileSync(join(repoRoot, "dsh-graph-host/prompts/usage.zh.md"), "utf8");
  assert.ok(usageAssetZh.includes(ge.help), "topic=graph_engineering 的切片必须逐字取自 usage.zh.md 的该章节");
  assert.ok(!raw.includes(GRAPH_ENGINEERING_DEFINITION), "help.zh.md 仍不得含点题定义（载体只在 usage）");
  // en 侧同一路径：language 由配置解析（本夹具为 zh），故 en 不走 `execute()`，而是直接验证
  // **en usage 资产**承载了同名章节（跨资产查找对 en 面同样成立；英译对偶，不要求含 zh 逐字串）。
  const usageAssetEn = readFileSync(join(repoRoot, "dsh-graph-host/prompts/usage.en.md"), "utf8");
  const enSection = usageAssetEn.split(/\n(?=## )/).find((s) => s.startsWith("## ") && /dsh-graph/.test(s.split("\n")[0]!) && /Graph Engineering/i.test(s.split("\n")[0]!));
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

test("g-493 D2（g-495 返工项 3 负向对照·真实树内存变异）：把「工具名 topic 命中」分支人为加回 ⇒ 判据必红", () => {
  // 真实树上的负向对照：用**源码文本**重放旧分支的行为，证明 D1 的负向断言不是恒真。
  const src = readFileSync(join(repoRoot, "dsh-graph-host/index.js"), "utf8");
  assert.ok(/const moduleId = helpTopicModuleId\(key\);\n  if \(moduleId\) return helpModuleTopicText\(src, moduleId\);\n  return null;/.test(src), "工具名分支必须已删除（模块名之后直接 return null）");
  assert.ok(!/toolMatch/.test(src), "源码不得再残留 toolMatch 工具名分支");
  // 旧分支的行为重放：命中 `- <工具名>(` 行 ⇒ found=true；真实资产里已无该形态 ⇒ 恒不命中。
  const raw = readFileSync(helpZhPromptPath, "utf8");
  const legacyHit = new RegExp(`^- ${"graph_create_goal"}\\(`, "m").exec(raw);
  assert.equal(legacyHit, null, "真实 help 资产里不得再有 `- <工具名>(` 形态（否则旧分支仍可命中）");
  // 反证：一旦资产里人为加回该形态，旧分支就会命中 —— 说明 D1 的 found=false 是**资产+源码**双条件决定，
  // 而不是判据恒真。
  const withLegacyRow = `${raw}\n- graph_create_goal(title[, version]) 建目标\n`;
  assert.notEqual(withLegacyRow, raw, "负向对照必须真实改变输入");
  assert.ok(new RegExp(`^- ${"graph_create_goal"}\\(`, "m").exec(withLegacyRow), "加回工具条目行后旧分支正则必须能命中（判据可被证伪）");
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
  const usageZh = readFileSync(join(repoRoot, "dsh-graph-host/prompts/usage.zh.md"), "utf8");
  const usageEn = readFileSync(join(repoRoot, "dsh-graph-host/prompts/usage.en.md"), "utf8");
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

test("g-493 D4（返工·出路 1 负向对照·真实树内存变异）：点题章节只在 usage ⇒ 跨资产查找命中；两处都无 ⇒ 必红", () => {
  // 真实树取证：help 资产**无**该章节、usage 资产**有**该章节（这正是跨资产查找的前提）。
  const helpZh = readFileSync(helpZhPromptPath, "utf8");
  const usageZh = readFileSync(join(repoRoot, "dsh-graph-host/prompts/usage.zh.md"), "utf8");
  const hasTopicSection = (t: string) =>
    t.split(/\n(?=## )/).some((s) => s.startsWith("## ") && /dsh-graph/.test(s.split("\n")[0]!) && /图工程|Graph Engineering/i.test(s.split("\n")[0]!));
  assert.equal(hasTopicSection(helpZh), false, "help.zh.md 不得再含点题章节（载体已迁走）");
  assert.equal(hasTopicSection(usageZh), true, "usage.zh.md 必须含点题章节（新载体）");
  // 行为面：真实 `execute()` 必须命中，且切片**逐字**等于 usage 里的该章节（跨资产而非单资产）。
  const ge = runHelp({ topic: "graph_engineering" });
  assert.equal(ge.found, true, "跨资产查找必须命中（help 无此章节时回落 usage）");
  const usageSection = usageZh.split(/\n(?=## )/).find((s) => s.startsWith("## ") && /dsh-graph/.test(s.split("\n")[0]!) && /图工程|Graph Engineering/i.test(s.split("\n")[0]!));
  assert.equal(ge.help, usageSection!.trimEnd(), "切片必须逐字取自 usage 的该章节");
  // 负向对照 ①：把**两个面**的章节都拿掉 ⇒ 查找必须失败（判据不得恒真）。
  const strip = (t: string) => t.split("\n").filter((l) => !/^## .*(图工程|Graph Engineering)/.test(l)).join("\n");
  assert.notEqual(strip(usageZh), usageZh, "负向对照必须真实改变输入（剥掉 usage 章节标题）");
  assert.equal(hasTopicSection(strip(usageZh)), false, "负向对照：剥掉后 usage 不得再有该章节");
  // 负向对照 ②：只保留 help 面 ⇒ 若 help 仍能提供该章节，则「跨资产」这一层就没被验证到。
  assert.equal(hasTopicSection(helpZh), false, "help 面本身不提供该章节 ⇒ 命中唯一来自 usage（跨资产必要性成立）");
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
});
