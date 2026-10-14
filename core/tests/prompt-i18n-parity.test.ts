import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SERVER_I18N, assertServerI18nParity } from "../../dist/lib/server-i18n.js";
import { resolvePromptLanguage } from "../../dist/index.js";

const distRoot = join(import.meta.dirname, "../../dist");
// g-496：全部提示词资产的单一源码副本在**公共层** `prompts/`（发布形态为合并后的
// `dist/prompts/`）。原插件内 `dsh-graph-host/prompts/` 已不复存在，故源侧根改指公共层。
const prompts = join(import.meta.dirname, "../../prompts");
const placeholders = (text: string) => [...text.matchAll(/\{\{?([A-Za-z0-9_.-]+)\}?\}/g)].map((m) => m[1]).sort();
const technicalTokens = (text: string) => [...text.matchAll(/(?:graph_[A-Za-z0-9_]+|@att\/[A-Za-z0-9_./<>-]+|worktree=false)/g)].map((m) => m[0]).sort();

// g-496（att-009 返工）：`attempt-instructions` 的中英文**结构基线本就不对等**，且三处差异都属于
// 「两侧各自都是真实产物形态、任何一侧改动都会改变产品行为」（判据 8：语义与产物不得变）：
//   ① 英文派发路径的 `## Task positioning` 是 g401 守卫强制保护的**框架小节标题**（英文产物必须有它）；
//      中文派发路径的对应定位行是 `【本次任务定位】` 这一**反伪装内文标记**（`attempt-prompt.test.ts`
//      断言中文产物以它开头，且 g400 守卫把它登记为 zh 保留标记）⇒ 标题数差 1、行数差 1。
//   ② 中文 `overrideAcceptance` 是单行；英文基线的验收项数组本就以**独立行**跟随（`- Acceptance items:`
//      换行后为缩进列表）⇒ 行数再差 1。
//   ③ 中文 `positioningLine1` 注入 `{{historyNotice}}`（前序 handoff 提名）；英文基线无该变量
//      （英文定位句为 "history is background only"）⇒ 英文资产不得凭空补写该占位符。
// 故仅对**这一份资产**给出上述**精确上限**的豁免：行数差必须恰好 2、标题数差必须恰好 1、
// 占位符差必须恰好为 {historyNotice} 一个且**只在中文侧**；超出即判红。
// 技术记号与其余全部资产的对偶断言**一字不减**。
const STRUCTURAL_PARITY_EXCEPTIONS: Record<
  string,
  { lines: number; headings: number; zhOnlyPlaceholders: string[]; zhOnlyTechnicalTokens: string[]; reason: string }
> = {
  "attempt-instructions": {
    lines: 2,
    headings: 1,
    zhOnlyPlaceholders: ["historyNotice"],
    zhOnlyTechnicalTokens: [],
    reason:
      "英文 `## Task positioning` 框架标题由 g401 强制（中文侧为 `【本次任务定位】` 内文标记）；英文验收项列表按基线独立成行；`{{historyNotice}}` 为中文独有注入变量",
  },
  // `review-task`：中文基线的权限说明**点名了具体管理写工具**（`graph_create_goal` 等）与
  // `graph_resolve_accept`，英文基线对应四条为简洁措辞、**不含**这些工具名。抽取必须逐字保持两侧
  // 基线语义（判据 8 / 复核 BLOCK：改写英文权限措辞 = 语义漂移），故英文资产不得凭空补写这些记号；
  // 中文侧多出的技术记号正是基线固有差异 ⇒ 仅此一份资产给出**精确枚举**的 zh-only 豁免。
  "review-task": {
    lines: 0,
    headings: 0,
    zhOnlyPlaceholders: [],
    zhOnlyTechnicalTokens: ["graph_create_goal", "graph_resolve_accept", "graph_start_attempt", "graph_transition"],
    reason:
      "中文基线权限说明点名具体管理写工具；英文基线为简洁措辞（抽取不得改写英文语义）",
  },
  // `collect-task`：**中文基线比英文基线多 8 行正文** —— 中文版含「附件安全与边界」整节
  // （绝对路径/`..` 遍历/反斜杠/NUL 拒绝、SSRF 约束）与更细的附件类型说明（Text/Binary/Excel、
  // `@att/` 回引），而基线英文分支本就是 31 行简版（`Store discovered attachments with
  // graph_store_attachment under the canonical attachment root.`）。复核 rev-att-009-02 判定：
  // 把中文独有的规范句**翻译追加**进英文资产属未授权扩写（判据 8 语义漂移）⇒ 英文必须逐字保持
  // 31 行简版。多出的 8 行与 `@att/` 示例记号是**基线固有**的中英差异，故如此登记。
  // 中文基线含「附件安全与边界」整节及附件类型细则（英文基线为 31 行简版；不得翻译追加进英文）。
  // 注意 `lines` 口径为 **en − zh**（英文 31 行 < 中文 39 行）⇒ 取 **−8**。
  "collect-task": {
    lines: -8,
    headings: 0,
    zhOnlyPlaceholders: [],
    zhOnlyTechnicalTokens: ["@att/<name>>", "@att/docs/report.md"],
    reason:
      "中文基线含「附件安全与边界」整节及附件类型细则（英文基线为 31 行简版；不得翻译追加进英文）",
  },
};

test("prompt markdown zh/en assets keep heading and placeholder parity", () => {
  const names = readdirSync(prompts).filter((name) => name.endsWith(".zh.md")).map((name) => name.slice(0, -6));
  assert.ok(names.length > 0);
  for (const name of names) {
    const zh = readFileSync(join(prompts, `${name}.zh.md`), "utf8");
    const en = readFileSync(join(prompts, `${name}.en.md`), "utf8");
    const exception = STRUCTURAL_PARITY_EXCEPTIONS[name];
    const lineDelta = en.split("\n").length - zh.split("\n").length;
    const headingDelta = (en.match(/^#{1,6} /gm) ?? []).length - (zh.match(/^#{1,6} /gm) ?? []).length;
    // 占位符差集：zh 独有（豁免上限）与 en 独有（**永远不允许**）分别核对。
    const zhOnly = placeholders(zh).filter((p) => !placeholders(en).includes(p));
    const enOnly = placeholders(en).filter((p) => !placeholders(zh).includes(p));
    const allowedZhOnly = [...(exception?.zhOnlyPlaceholders ?? [])].sort();
    if (exception) {
      assert.equal(lineDelta, exception.lines, `${name} line parity（结构性豁免上限 ${exception.lines}：${exception.reason}）`);
      assert.equal(headingDelta, exception.headings, `${name} heading parity（结构性豁免上限 ${exception.headings}：${exception.reason}）`);
      assert.deepEqual([...zhOnly].sort(), allowedZhOnly, `${name} zh-only 占位符必须恰为豁免清单`);
    } else {
      assert.equal(lineDelta, 0, `${name} line parity`);
      assert.equal(headingDelta, 0, `${name} heading parity`);
      assert.deepEqual(placeholders(zh), placeholders(en), `${name} placeholder parity`);
    }
    // 英文侧多出的占位符**无任何豁免**：英文资产不得夹带中文侧没有的缺口。
    assert.deepEqual(enOnly, [], `${name} 不得存在 en-only 占位符（英文资产夹带缺口）`);
    // 技术记号差集同样**分侧**核对：zh 独有无豁免时判红；en 独有**永远**判红。
    const zhTokens = [...new Set(technicalTokens(zh))].sort();
    const enTokens = [...new Set(technicalTokens(en))].sort();
    const enOnlyTokens = enTokens.filter((t) => !zhTokens.includes(t));
    assert.deepEqual(enOnlyTokens, [], `${name} 不得存在 en-only 技术记号（英文资产夹带缺口）`);
    const zhOnlyTokens = zhTokens.filter((t) => !enTokens.includes(t));
    assert.deepEqual(
      zhOnlyTokens,
      [...(exception?.zhOnlyTechnicalTokens ?? [])].sort(),
      `${name} zh-only 技术记号必须恰为豁免清单`,
    );
  }
});

test("supervisor guide zh/en is complete and structurally equivalent", () => {
  const zh = readFileSync(join(distRoot, "prompts", "supervisor-guide.zh.md"), "utf8");
  const en = readFileSync(join(distRoot, "prompts", "supervisor-guide.en.md"), "utf8");
  assert.ok(zh.split("\n").length >= 287, "supervisor-guide.zh.md must retain at least 90% of the original 319 lines");
  for (const phrase of ["不可妥协", "判据先于执行", "信息收集", "graph_report_status", "worktree 隔离"]) assert.ok(zh.includes(phrase), `guide contract phrase missing: ${phrase}`);
  assert.equal(zh.split("\n").length, en.split("\n").length, "supervisor guide line parity");
  assert.deepEqual((zh.match(/^#{1,6} /gm) ?? []).map((h) => h[0]), (en.match(/^#{1,6} /gm) ?? []).map((h) => h[0]), "supervisor guide heading levels");
  assert.deepEqual([...new Set(technicalTokens(zh))].sort(), [...new Set(technicalTokens(en))].sort(), "supervisor guide technical token parity");
});

test("zh prompt assets are not stubs", () => {
  const minimums: Record<string, number> = { usage: 10, "guide-hint": 4, discipline: 7, help: 19, worktree: 4, "minor-task": 4 };
  for (const [name, min] of Object.entries(minimums)) {
    const text = readFileSync(join(prompts, `${name}.zh.md`), "utf8");
    assert.ok(text.split("\n").length >= min, `${name}.zh.md is unexpectedly short`);
  }
});

test("server i18n dictionaries are symmetric and English has no CJK text", () => {
  assert.equal(assertServerI18nParity(), true);
  assert.deepEqual(Object.keys(SERVER_I18N.zh).sort(), Object.keys(SERVER_I18N.en).sort());
  assert.doesNotMatch(Object.values(SERVER_I18N.en).join("\n"), /[\u3400-\u9fff]/);
});

test("server i18n has one symmetric key for every graph tool", () => {
  const indexSource = readFileSync(join(distRoot, "index.js"), "utf8");
  const toolNames = [...indexSource.matchAll(/name: \"(graph_[A-Za-z0-9_]+)\"/g)].map((match) => match[1]);
  assert.equal(new Set(toolNames).size, toolNames.length);
  const expected = toolNames.map((name) => `tool.${name}`).sort();
  assert.deepEqual(Object.keys(SERVER_I18N.zh).filter((key) => key.startsWith("tool.")).sort(), expected);
  assert.deepEqual(Object.keys(SERVER_I18N.en).filter((key) => key.startsWith("tool.")).sort(), expected);
});

test("resolvePromptLanguage: override wins, locale.preference via settings, legacy locale probe, zh fallback", () => {
  // 显式覆盖优先
  assert.equal(resolvePromptLanguage("en"), "en");
  assert.equal(resolvePromptLanguage("zh"), "zh");
  // follow：首选 DSH settings 服务的 locale.preference（dsh-client-locale 注册的命名空间）
  const viaSettings = (preference?: string) => ({
    get: (name: string) => (name === "settings" ? { get: (ns: string) => (ns === "locale" ? { preference } : undefined) } : undefined),
  });
  assert.equal(resolvePromptLanguage("follow", viaSettings("en")), "en");
  assert.equal(resolvePromptLanguage("follow", viaSettings("zh-CN")), "zh");
  // preference 缺失（跟随浏览器）时走次选 locale 服务探测
  assert.equal(resolvePromptLanguage("follow", { locale: { getLocale: () => ({ active: "en-US" }) } }), "en");
  assert.equal(resolvePromptLanguage("follow", { get: (name: string) => (name === "locale" ? { snapshot: () => ({ active: "zh" }) } : undefined) }), "zh");
  // settings/locale 均不可用或异常 → 回退 zh
  assert.equal(resolvePromptLanguage("follow", null), "zh");
  assert.equal(resolvePromptLanguage("follow", { get: () => { throw new Error("no service"); } }), "zh");
  assert.equal(resolvePromptLanguage("follow", viaSettings(undefined)), "zh");
  assert.equal(resolvePromptLanguage(undefined, null), "zh");
});
