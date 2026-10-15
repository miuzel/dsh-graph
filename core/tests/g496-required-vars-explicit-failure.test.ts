/**
 * core/tests/g496-required-vars-explicit-failure.test.ts
 *
 * g-496 att-012（终局复核 BLOCK 收口⑤）：**必需模板变量 / 短语缺失必须显性失败**。
 *
 * 背景：`fillPromptTemplate`（core）与 `fillPhrase`（host）此前对**未提供**的键一律
 * 替换为空串 —— 资产里写错一个变量名、或装配点漏传一个键，产物会**静默少一段正文**，
 * 而所有既有守卫都只看「没有第二副本 / 措辞对偶」，看不出载荷缺斤少两。
 *
 * 现口径（判据 9 的“唯一事实源”配套）：
 *   · 资产引用的每个 `{{name}}` 必须由调用方提供 ⇒ 缺失即**抛错并点名**变量名；
 *   · 「可选片段」由调用方**显式传空串**表达，空串是合法值、不得误红；
 *   · 用户输入里的 `{{...}}` 原样保留（单遍扫描、非递归），不被二次展开。
 *
 * 本测试消费**真实双语 renderer**（`formatCollectPrompt` / `formatSummaryPrompt` /
 * `formatPmPrompt` / `formatReviewPrompt`），不做纯函数自证：
 *   A. 四个 renderer × zh/en 都真能产出非空正文，且资产内的 `{{...}}` 已被全部消费；
 *   B. 缺失必需键必须抛错，且错误文本点名该键；
 *   C. 显式空串是可选项的合法形态（不误红），并在产物中表现为“该段不出现”；
 *   D. host 侧 `fillPhrase` 对「空/缺 phrase」「缺变量」「重复 marker」显性失败。
 */

import { test } from "node:test";

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  init, createGoal, findGoalFile, formatCollectPrompt,
  formatSummaryPrompt, formatPmPrompt, formatReviewPrompt, readCorePromptAsset, fillPromptTemplate,
} from "../ops.ts";
import { readFileSync } from "node:fs";

const repoRoot = join(import.meta.dirname, "../..");
const hostSrcPath = join(repoRoot, "dsh-graph-host/index.js");

/** 资产里出现过的全部 `{{name}}` 占位符。 */
const placeholdersIn = (text: string) => [...text.matchAll(/\{\{([A-Za-z0-9_.-]+)\}\}/g)].map((m) => m[1]);

function setupGoalWithCard() {
  const root = mkdtempSync(join(tmpdir(), "g496-var-"));
  init(root);
  const goalId = createGoal(root, { title: "变量缺失显性失败", version: "v-t", actor: "test" });
  const cardId = "card-var-01";
  const goalFile = findGoalFile(root, goalId);
  const cardsDir = join(dirname(goalFile), "cards");
  mkdirSync(cardsDir, { recursive: true });
  // 卡片 frontmatter 是 **JSON** 块（不是 YAML）—— 与 collect-prompt.test.ts 的既有夹具同形态。
  writeFileSync(join(cardsDir, `${cardId}.md`), `---
{
  "id": "${cardId}",
  "goal": "${goalId}",
  "title": "变量卡",
  "kind": "text",
  "status": "empty"
}
---

## 卡片内容
`);
  return { root, goalId, cardId };
}

// ---------------------------------------------------------------- A. 真实双语 renderer 消费

test("g-496 att-012 A：四个真实 renderer × zh/en 都产出非空正文且占位符全部被消费", () => {
  const { root, goalId, cardId } = setupGoalWithCard();
  for (const lang of ["zh", "en"] as const) {
    const produced: Array<[string, string, string]> = [
      // [标签, 资产名, 产物]
      ["collect", "collect-task", formatCollectPrompt(root, goalId, cardId, undefined, lang)],
      ["summary", "summary-task", formatSummaryPrompt({ goalId, goalRel: `goals/${goalId}/goal.md`, language: lang })],
      ["pm", "pm-task", formatPmPrompt({ goalId, goalRel: `goals/${goalId}/goal.md`, language: lang })],
      ["review", "review-task", formatReviewPrompt({ goalId, attemptId: "att-001", goalRel: `goals/${goalId}/goal.md`, language: lang })],
    ];
    for (const [label, asset, text] of produced) {
      assert.equal(typeof text, "string", `${lang}/${label} 必须返回字符串`);
      assert.ok(text.trim().length > 0, `${lang}/${label} 产物不得为空`);
      // 资产引用的占位符必须**全部**被消费（产物里不得残留 `{{name}}`）。
      assert.deepEqual(placeholdersIn(text), [], `${lang}/${label} 产物不得残留未消费占位符`);
      // 资产本身确实带占位符（否则本条断言空转）。
      assert.ok(placeholdersIn(readCorePromptAsset(asset, lang)).length > 0, `${asset}.${lang}.md 应当引用占位符`);
    }
  }
});

// ---------------------------------------------------------------- B. 缺失必需键必须抛错并点名

test("g-496 att-012 B：缺失必需变量显性抛错并点名，不静默替换为空串", () => {
  // 纯函数层：逐键点名（多键缺失时点名第一个，任一缺失都不得放行）。
  assert.throws(() => fillPromptTemplate("{{alpha}}", {}), /alpha/, "缺失键必须抛错并点名");
  assert.throws(() => fillPromptTemplate("{{alpha}}/{{beta}}", { alpha: "x" }), /beta/, "第二个缺失键同样点名");
  assert.throws(() => fillPromptTemplate("{{Alpha_1}}", { alpha_1: "x" }), /Alpha_1/,
    "键名大小写敏感：不得把大小写不同的键当作已提供");
  // 真实 renderer 层：在真实资产后追加一个**必然无人提供**的键 ⇒ 必须抛错点名。
  // 证明「未提供 ≠ 空串」这条 fail-closed 路径在真实资产形态下同样成立。
  const asset = readCorePromptAsset("summary-task", "zh");
  assert.ok(asset.length > 0);
  assert.throws(
    () => fillPromptTemplate(`${asset}\n{{definitelyNotProvided}}`, { goalId: "g-1", goalRel: "x", digest: "d", structureLines: "" }),
    /definitelyNotProvided/,
    "资产新增未提供键时必须抛错点名",
  );
  // 反向：同一模板、同一调用方，去掉注入键即恢复成功（证明失败由该键引起，非模板本身）。
  assert.doesNotThrow(() => fillPromptTemplate(asset, { goalId: "g-1", goalRel: "x", digest: "d", structureLines: "" }));
});

// ---------------------------------------------------------------- C. 显式空串合法、不误红

test("g-496 att-012 C：显式提供的空串是可选项的合法形态，不误红且表现为该段不出现", () => {
  assert.equal(fillPromptTemplate("A{{opt}}B", { opt: "" }), "AB", "显式空串应被接受并替换为空");
  assert.equal(fillPromptTemplate("{{a}}", { a: "" }), "", "全空成果为空串是合法的");
  // 「未提供」与「显式空串」是**不同**的：前者抛错、后者放行。
  assert.throws(() => fillPromptTemplate("{{opt}}", {}), /opt/);
  assert.doesNotThrow(() => fillPromptTemplate("{{opt}}", { opt: "" }));
  // 真实 renderer：summary 的 digest 为 null 时由**调用方**决定显式空/占位文案，
  // 但不得因此抛错（renderer 必须为它自己的可选槽位提供值）。
  const { root, goalId, cardId } = setupGoalWithCard();
  for (const lang of ["zh", "en"] as const) {
    assert.doesNotThrow(
      () => formatSummaryPrompt({ goalId, goalRel: "g/goal.md", digest: null, language: lang }),
      `${lang} summary 的 digest 可选为空，不得误红`,
    );
    assert.doesNotThrow(
      () => formatPmPrompt({ goalId, goalRel: "g/goal.md", guidance: null, language: lang }),
      `${lang} pm 的 guidance 可选为空，不得误红`,
    );
    assert.doesNotThrow(
      () => formatCollectPrompt(root, goalId, cardId, undefined, lang),
      `${lang} collect 的用户附加要求可缺省，不得误红`,
    );
    assert.doesNotThrow(
      () => formatReviewPrompt({ goalId, attemptId: "att-001", goalRel: "g/goal.md", guidance: null, language: lang }),
      `${lang} review 的 guidance 可缺省，不得误红`,
    );
  }
});

// ---------------------------------------------------------------- D. 用户输入不被二次展开

test("g-496 att-012 D：用户输入里的 {{...}} 原样保留（单遍扫描、非递归）", () => {
  assert.equal(fillPromptTemplate("{{goalId}}", { goalId: "用户字面 {{nested}}" }), "用户字面 {{nested}}",
    "回填文本里的占位符不得被二次展开");
  const { root, goalId, cardId } = setupGoalWithCard();
  const addendum = "请保留 {{thisIsUserLiteral}} 原文";
  const out = formatCollectPrompt(root, goalId, cardId, addendum, "zh");
  assert.ok(out.includes(addendum), "用户附加要求必须原样出现在产物中");
});

// ---------------------------------------------------------------- E. host 侧短语表 fail-closed
//
// `fillPhrase` / `attemptInstructionsPhrases` 是宿主模块内的**非导出**函数，故按仓库既有做法
// （见 client.test.ts 的 vm 抽取）从真实源码中抽函数体后执行 —— 断言打在**真实源码**上，
// 不用复制一份实现自证。

/** 从 host 源码里抽出一个顶层函数的完整源码（按大括号配平）。 */
function extractHostFunction(name: string): string {
  const src = readFileSync(hostSrcPath, "utf8");
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `宿主源码必须含 function ${name}`);
  let i = src.indexOf("{", start);
  assert.ok(i > 0, `${name} 必须有大括号体`);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start, j + 1);
    }
  }
  throw new Error(`${name} 大括号未配平`);
}

function loadFillPhrase(): (text: unknown, vars: Record<string, string>) => string {
  const body = extractHostFunction("fillPhrase");
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn fillPhrase;`)() as (t: unknown, v: Record<string, string>) => string;
}

test("g-496 att-012 E：host fillPhrase 对空/缺 phrase、缺变量显性失败，显式空串合法", () => {
  const fillPhrase = loadFillPhrase();
  // 空的 / 缺失的 phrase 本体必须失败（不得产出空段静默过关）。
  assert.throws(() => fillPhrase("", {}), /必需 attempt phrase/);
  assert.throws(() => fillPhrase("   \n  ", {}), /必需 attempt phrase/);
  assert.throws(() => fillPhrase(undefined, {}), /必需 attempt phrase/);
  assert.throws(() => fillPhrase(null, {}), /必需 attempt phrase/);
  // 缺变量：点名。
  assert.throws(() => fillPhrase("值是 {{missing}}", {}), /missing/);
  assert.throws(() => fillPhrase("{{a}} 与 {{b}}", { a: "1" }), /b/);
  // 显式空串合法且不误红。
  assert.equal(fillPhrase("前缀{{opt}}后缀", { opt: "" }), "前缀后缀");
  // 正常回填 + 非递归。
  assert.equal(fillPhrase("{{a}}", { a: "用户 {{b}}" }), "用户 {{b}}", "回填文本不得被二次展开");
  // 真实短语（zh/en）都能被回填：从真实资产抽取一对 marker→正文，逐语言验证。
  for (const lang of ["zh", "en"] as const) {
    const raw = readFileSync(join(repoRoot, "prompts", `attempt-instructions.${lang}.md`), "utf8");
    const marks = [...raw.matchAll(/^<!--\s*dsh-graph:phrase:([A-Za-z0-9_.-]+)\s*-->\s*$/gm)];
    assert.ok(marks.length >= 18, `${lang} 资产短语数应充分（实得 ${marks.length}）`);
    const first = raw.slice(marks[0].index! + marks[0][0].length, marks[1].index!).replace(/^\n+/, "").replace(/\n+$/, "");
    assert.ok(first.trim().length > 0, `${lang} 首个短语必须非空`);
    // 该短语若含占位符，给全变量后必须能成功回填；不含则可原样通过。
    const vars = Object.fromEntries(placeholdersIn(first).map((k) => [k, `<${k}>`]));
    const out = fillPhrase(first, vars);
    assert.deepEqual(placeholdersIn(out), [], `${lang} 短语回填后不得残留占位符`);
  }
});
