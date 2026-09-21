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
 *  2. 断言打在**渲染后的字符串**上（第 2 条为核心），并要求分级是可识别的独立区块
 *     （不得塞进既有纪律条目里）；
 *  3. 指南与纪律提醒同时校验源码副本与构建后投递副本（dist），防止「只改一处」。
 *
 * 落点说明（重要，勿随手「整理」）：分级要求由 index.js 的独立 section
 * （TEST_INTENSITY_SECTIONS / formatTestIntensitySection）随**同一份初始 prompt** 投递，
 * 而非加进 formatAttemptDiscipline 的纪律条目。原因是
 * `core/tests/prompt-discipline-g239.test.ts` 判据 3 对「## 通用执行纪律 → 若本 prompt 同时含」
 * 整段做收缩断言（字符减少 ≥ 8%、Token 减少 ≥ 10%），实测基线只剩约 +6 字符 / +3 Token 余量
 * （1701→1559、475→424），其余文本均为既有测试锚定或 worktree 隔离硬约束、无法等量压缩——
 * 在纪律段内新增任何条目都会让该既有测试变红。故本文件额外断言分级区块**不在**该纪律段内，
 * 防止后续被无意搬回去而撞红 g-239。
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

/** 派发提示词（渲染产物）的压缩版三档：档位标识 + 适用范围。 */
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

  // 必须是可识别的独立分级区块：不得被塞进既有纪律条目里（否则子代理难以识别，且会撞 g-239 预算）。
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

test("g-326 判据 2 补充：分级区块不得落在 g-239 收缩断言的纪律段内（否则纪律段预算被撑破）", () => {
  for (const [label, output, start, end] of [
    ["中文", formatAttemptPrompt({ ...renderArgs }), "## 通用执行纪律", "若本 prompt 同时含"],
    ["英文", formatAttemptPrompt({ ...renderArgs, promptLanguage: "en" }), "## Execution discipline", "If a prompt contains a historical handoff"],
  ] as const) {
    const discipline = output.slice(output.indexOf(start), output.indexOf(end));
    assert.ok(discipline.length > 0, `${label}纪律段必须存在`);
    assert.ok(
      !discipline.includes("测试力度") && !discipline.includes("Test intensity"),
      `${label}纪律段不得含测试力度分级（prompt-discipline-g239 判据 3 对该段做 ≥8% 字符收缩断言，基线仅剩约 6 字符余量）`,
    );
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
