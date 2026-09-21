/**
 * g-326：把「按改动性质分级测试力度」固化为机器证据。
 *
 * 判据映射：
 *  - 判据 1/3 → 主管工作指南 zh/en 均含显式三档分级，逐档写明适用范围与必做验收证据形式，
 *               并明确禁止以「轻量/文案」为由跳过、删改或削弱既有测试；
 *  - 判据 2  → **核心断言**：调用真实产物 formatAttemptPrompt（dist/index.js）渲染派发提示词，
 *               中文与英文两路都必须含同一分级要求；
 *  - 判据 4  → prompts/discipline.{zh,en}.md（每轮注入的主管纪律提醒）也含该分级提醒。
 *
 * 反自我满足设计：
 *  1. 渲染时**不传** attemptBrief / directive / targetContext，即渲染产物里没有任何调用方提供的
 *     长文本；因此命中的分级文本只可能来自框架自身注入的执行纪律，而不是被回显的 brief
 *     或粘贴的源码字符串；
 *  2. 断言打在**渲染后的字符串**上（第 2 条为核心）；纪律段的存在性证明一律做**段落切片**断言
 *     （切片内查，而不是 grep 全文——独立区块同样落在全文里，grep 全文不构成纪律段证据）；
 *  3. 指南与纪律提醒同时校验源码副本与构建后投递副本（dist），防止「只改一处」。
 *
 * 落点说明（重要，勿随手「整理」）：分级要求有两个投递落点，**两者并存**：
 *  1. index.js 的独立 section（TEST_INTENSITY_SECTIONS / formatTestIntensitySection）——完整三档；
 *  2. `formatAttemptDiscipline` 的 zh 纪律条目 3 / `formatAttemptPromptEnglish` 的 en 纪律条目——
 *     精简三档，纪律段是分级规则的正式投递渠道（负责人裁决，att-002 返工落地）。
 *
 * 关于 g-239 的收缩断言：`core/tests/prompt-discipline-g239.test.ts` 判据 3 对
 * 「## 通用执行纪律 → 若本 prompt 同时含」整段做收缩断言（字符减少 ≥ 8%、Token 减少 ≥ 10%）。
 * 其四个阈值一字未改，余量问题由「按增量放宽余量」解决——该测试在测量前按稳定标记把本次新增的
 * 分级条目**精确剔除**（见 `prompt-discipline-g239.test.ts` 顶部 `DISCIPLINE_INCREMENT_MARKER`
 * 与 `subtractRegisteredIncrement`）。故本文件的护栏断言已从 att-001 的反向断言
 * 「分级规则**不在**纪律段」**翻转为正向断言**「分级规则**就在**纪律段内」。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatAttemptPrompt } from "../../dist/index.js";

const sourceRoot = join(import.meta.dirname, "../../dsh-graph-host");
const shippedRoot = join(import.meta.dirname, "../../dist");
const read = (root: string, name: string) => readFileSync(join(root, name), "utf8");
const renderArgs = { goal: "g-326", attempt: "att-001", goalRel: ".dsh-graph/versions/v0.16.0/goals/g-326/goal.md" };

/** 断言一组「必须出现」的关键片段，失败信息带出处。 */
function expectAll(text: string, label: string, tokens: readonly string[]) {
  for (const token of tokens) {
    assert.ok(text.includes(token), `${label} 缺少测试力度分级的关键片段：「${token}」`);
  }
}

/** 断言片段按给定顺序出现：删档、改序或被压缩成一句都无法蒙混过关。 */
function expectOrder(text: string, label: string, tokens: readonly string[]) {
  const positions = tokens.map((token) => text.indexOf(token));
  positions.forEach((position, index) => {
    assert.ok(position >= 0, `${label} 缺少档位片段：「${tokens[index]}」`);
  });
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
    `${label} 档位顺序错乱（应为一档→二档→三档）：${tokens.map((t, i) => `${t}@${positions[i]}`).join(" ")}`,
  );
}

/** 指南用带空格的排版，派发提示词用压缩排版，故三档适用范围分开定义。 */
const GUIDE_ZH = [
  "测试力度分级（按改动性质）",
  "一档｜零行为逻辑改动",
  "二档｜小幅逻辑改动",
  "三档｜新增功能 / 契约变更 / 核心层重写 / 并发与状态机",
  "不要求新增单元测试",
  "全量既有测试全绿",
  "构建与语法检查通过",
  "真机/人工目视核验",
  "绝不是可以不验证",
  "针对性单测",
  "原行为不回归",
  "边界与负向用例",
  "改坏就会红",
  "绝不因",
  "「轻量/文案」为由跳过、删改或削弱既有测试",
  "不得降低质量判据门禁与人工 gate",
];
const GUIDE_EN = [
  "Test Intensity Tiers (by Nature of Change)",
  "Tier 1 | Zero behavioral-logic change",
  "Tier 2 | Small logic change",
  "Tier 3 | New feature / contract change / core-layer rewrite / concurrency and state machines",
  "no new unit tests required",
  "full existing suite still green",
  "build and syntax checks passing",
  "real-machine/manual visual verification",
  "it never means verification is optional",
  "targeted unit tests",
  "does not regress",
  "boundary and negative cases",
  "breaking it turns the test red",
  "Iron rule",
  "skip, delete, or weaken existing",
  "lower quality-criteria gates or human gates",
];
const GUIDE_ZH_TIERS = ["一档｜零行为逻辑改动", "二档｜小幅逻辑改动", "三档｜新增功能"];
const GUIDE_EN_TIERS = ["Tier 1", "Tier 2", "Tier 3"];

/** 派发提示词的压缩版三档措辞（档位标识 + 适用范围）；独立分级区块与纪律段精简条目两处都含这些片段。 */
const PROMPT_ZH_TIERS = [
  "零行为逻辑改动（文案/标签/i18n 字符串、注释、文档、纯样式）",
  "小幅逻辑改动（分支/数据变换/边界错误处理）",
  "新增功能/契约变更/核心层重写/并发与状态机",
];
const PROMPT_EN_TIERS = [
  "Tier 1 | zero behavioral-logic change",
  "Tier 2 | small logic change",
  "Tier 3 | new feature / contract change / core-layer rewrite / concurrency and state machines",
];
const PROMPT_ZH = [
  "测试力度按改动性质分级",
  "不要求新增单测",
  "既有测试全绿",
  "构建/语法检查通过",
  "真机目视",
  "针对性单测覆盖被改分支，且原行为不回归",
  "完整单测 + 边界与负向用例",
  "改坏就会红",
  "绝不因「轻量/文案」跳过、删改或削弱既有测试，也不降低判据门禁与人工 gate。",
];
const PROMPT_EN = [
  "Test intensity is tiered by the nature of the change",
  "no new unit tests required",
  "full existing suite still green",
  "build/syntax checks passing",
  "real-machine visual verification",
  "targeted unit tests covering the changed branches",
  "complete unit tests plus boundary and negative cases",
  "breaking it turns it red",
  "skip, delete, or weaken existing tests because a change is",
  "never lower criteria gates or human gates",
];

test("g-326 判据 1：主管指南源码与投递副本（zh/en）都含三档分级、逐档证据形式与禁止削弱条款", () => {
  for (const [label, root] of [["源码", sourceRoot], ["投递副本 dist", shippedRoot]] as const) {
    const zh = read(root, "supervisor-guide.zh.md");
    const en = read(root, "supervisor-guide.en.md");
    expectAll(zh, `${label} supervisor-guide.zh.md`, GUIDE_ZH);
    expectAll(en, `${label} supervisor-guide.en.md`, GUIDE_EN);
    expectOrder(zh, `${label} supervisor-guide.zh.md`, GUIDE_ZH_TIERS);
    expectOrder(en, `${label} supervisor-guide.en.md`, GUIDE_EN_TIERS);
  }
});

test("g-326 判据 2（核心）：formatAttemptPrompt 渲染产物中英文两路都真的含三档分级要求", () => {
  // 刻意不传 brief/directive/targetContext：产物中的分级文本只可能来自框架注入的执行纪律。
  const zhOutput = formatAttemptPrompt({ ...renderArgs });
  const enOutput = formatAttemptPrompt({ ...renderArgs, promptLanguage: "en" });

  // 前提检查：两路确实走了各自的渲染路径，且没有调用方文本可被回显。
  assert.ok(zhOutput.includes("（未提供）"), "本次渲染未提供 brief/directive，产物应显式标注未提供");
  assert.doesNotMatch(enOutput, /[\u3400-\u9fff]/, "英文渲染路径不得回落到中文文案（含 CJK 即说明未走英文纪律块）");

  expectAll(zhOutput, "渲染产物·中文", PROMPT_ZH);
  expectAll(enOutput, "渲染产物·英文", PROMPT_EN);
  expectOrder(zhOutput, "渲染产物·中文", PROMPT_ZH_TIERS);
  expectOrder(enOutput, "渲染产物·英文", PROMPT_EN_TIERS);

  // 必须是可识别的独立分级区块（与纪律段内的精简条目并存，两者都不得被删）。
  assert.ok(zhOutput.includes("## 测试力度分级（按改动性质）"), "中文渲染产物必须有独立的测试力度分级区块标题");
  assert.ok(enOutput.includes("## Test intensity tiers (by nature of change)"), "英文渲染产物必须有独立的测试力度分级区块标题");
  // 初始 prompt 以固定收尾语结束，分级要求必须真的在 prompt 内（而不是被挤出收尾语之后）。
  assert.ok(
    zhOutput.indexOf("## 测试力度分级（按改动性质）") < zhOutput.indexOf("若本 prompt 同时含历史 handoff"),
    "中文分级区块必须位于初始 prompt 收尾语之前",
  );
  assert.ok(
    enOutput.indexOf("## Test intensity tiers (by nature of change)") < enOutput.indexOf("If a prompt contains a historical handoff"),
    "英文分级区块必须位于初始 prompt 收尾语之前",
  );
});

test("g-326 判据 2 补充（护栏·已翻转）：分级规则必须落在 g-239 收缩断言的纪律段**内部**", () => {
  // 翻转记录（att-002 返工）：att-001 此处是反向断言「纪律段不得含分级规则」（原意是防止被无意搬回而撞红
  // g-239 的 ≥8%/≥10% 收缩断言）。负责人裁决「分级规则必须进纪律段」后，该断言必须正向化；
  // g-239 的余量问题改由「按增量精确剔除」解决（见 core/tests/prompt-discipline-g239.test.ts 顶部登记表）。
  // 仅 grep 全文不足以证明——独立区块同样落在全文里，故这里做**段落切片**断言：只在纪律段切片内查。
  const cases = [
    {
      label: "中文",
      output: formatAttemptPrompt({ ...renderArgs }),
      start: "## 通用执行纪律",
      end: "若本 prompt 同时含",
      tiers: PROMPT_ZH_TIERS,
      heading: "3. 测试力度按改动性质分级（不为不值得单测的改动凑断言）：",
      ironRule: "绝不因「轻量/文案」跳过、删改或削弱既有测试，也不降低判据门禁与人工 gate。",
    },
    {
      label: "英文",
      output: formatAttemptPrompt({ ...renderArgs, promptLanguage: "en" }),
      start: "## Execution discipline",
      end: "If a prompt contains a historical handoff",
      tiers: PROMPT_EN_TIERS,
      heading: "Tier test intensity by the nature of the change",
      ironRule: "never skip, delete, or weaken existing tests because a change is",
    },
  ] as const;
  for (const c of cases) {
    const discipline = c.output.slice(c.output.indexOf(c.start), c.output.indexOf(c.end));
    assert.ok(discipline.length > 0, `${c.label}纪律段必须存在`);
    // 纪律段确实是被切出来的那一段（不含独立分级区块的标题），否则下面的断言不构成「段落切片」证据。
    assert.ok(
      !discipline.includes("## 测试力度分级（按改动性质）") && !discipline.includes("## Test intensity tiers (by nature of change)"),
      `${c.label}切片必须只覆盖纪律段，不得把独立分级区块算进来`,
    );
    assert.ok(discipline.includes(c.heading), `${c.label}纪律段内部必须含分级条目首行：「${c.heading}」`);
    for (const tier of c.tiers) {
      assert.ok(discipline.includes(tier), `${c.label}纪律段内部必须含档位：「${tier}」`);
    }
    assert.ok(discipline.includes(c.ironRule), `${c.label}纪律段内部必须含禁止削弱既有测试的铁律`);
    // 档位在纪律段切片内也必须按一档→二档→三档有序（防被压成一句或改序）。
    expectOrder(discipline, `${c.label}纪律段切片`, c.tiers);
  }
});

test("g-326 判据 3：渲染产物明确禁止以「轻量/文案」为由削弱既有测试，且不放松门禁", () => {
  const zhOutput = formatAttemptPrompt({ ...renderArgs });
  const enOutput = formatAttemptPrompt({ ...renderArgs, promptLanguage: "en" });

  assert.match(
    zhOutput,
    /绝不因「轻量\/文案」跳过、删改或削弱既有测试/,
    "中文派发提示词必须显式禁止以轻量/文案为由削弱既有测试",
  );
  assert.match(zhOutput, /不降低判据门禁与人工 gate/, "中文派发提示词不得放松判据门禁与人工 gate");
  assert.match(
    enOutput,
    /never skip, delete, or weaken existing tests because a change is "lightweight\/copy-only"/i,
    "英文派发提示词必须显式禁止以 lightweight/copy-only 为由削弱既有测试",
  );
  assert.match(enOutput, /never lower criteria gates or human gates/, "英文派发提示词不得放松判据门禁与人工 gate");

  // 反向断言：一档不得被写成「无需验证」。
  assert.doesNotMatch(zhOutput, /(零行为逻辑改动|一档).{0,20}(无需|不用|不必)验证/, "一档不得被写成可以从验证中豁免");
  assert.doesNotMatch(enOutput, /(zero behavioral-logic change|Tier 1).{0,30}(no verification|verification is not required)/i, "Tier 1 不得被写成可以免于验证");
});

test("g-326 判据 4：每轮注入的主管纪律提醒（discipline.zh/en）含同一分级提醒", () => {
  for (const [label, root] of [["源码", sourceRoot], ["投递副本 dist", shippedRoot]] as const) {
    const zh = read(join(root, "prompts"), "discipline.zh.md");
    const en = read(join(root, "prompts"), "discipline.en.md");
    expectAll(zh, `${label} prompts/discipline.zh.md`, ["测试力度按改动性质分级", "不强制新增单测", "全量既有测试全绿", "绝不因「轻量/文案」跳过、删改或削弱既有测试"]);
    expectAll(en, `${label} prompts/discipline.en.md`, ["Test intensity is tiered by the nature of the change", "does not force new unit tests", "full existing suite green", "never skip, delete, or weaken existing tests"]);
  }
});
