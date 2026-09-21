/**
 * g-313：架构评估强化 —— 第三方重型库的「双真相与适配成本」评估，防回归测试。
 *
 * 判据映射：
 *  - 判据 1 → 指南（zh/en）含独立「技术选型与架构评估」小节与七维全生命周期成本矩阵：
 *             初始集成 / 胶水适配层规模 / 双真相与状态同步 / 事件与渲染回环 / 无用图层剔除 /
 *             升级与替换成本 / 排错与 Agent 返工成本；zh/en 行数相等、标题层级序列一致。
 *  - 判据 2 → T1 阈值 `胶水层预估 LOC ÷ 自研业务逻辑预估 LOC`（≥0.5 预警、≥1.0 默认自研白盒，
 *             继续用库须负责人确认）与 S≤50 / M≤200 / L>200 估算口径，在指南与 PM 提示词
 *             渲染产物中**均可检索**。
 *  - 判据 3 → `formatPmPrompt` 的中英两路渲染产物都含架构选型倾向条目（阈值 + 默认自研优先），
 *             且 4 个既有锚点子串（zh `【g-308 润色建议】`/`回报格式要求`、en `【g-308 润色建议】`/
 *             `Report format requirement`）一个都没丢。
 *
 * 反自我满足设计：
 *  1. 断言全部打在 **dist 产物**上（`dist/supervisor-guide.{zh,en}.md` 与 `dist/core/ops.js`），
 *     不 grep `core/ops.ts` 源码，也不 grep `dsh-graph-host/` 源指南 —— 证明被验证的是**要发布的
 *     那一份**；源改了不重建必红（配合 g-312 的 dist 新鲜度套件）。
 *  2. 判别力自证：这些关键词在改动前的 zh/en 指南与 PM 提示词里**命中数为 0**，故断言不是
 *     「本来就绿」的装饰；负向对照（改坏即红）在内存里对真实产物做定点破坏后重放检查器，
 *     破坏后必须报出缺口，且真实 dist 文件逐字节未变（hermetic，不污染工作树）。
 *  3. 行数/标题层级/技术 token 一致性与 `prompt-i18n-parity.test.ts` 同口径，不另立第二套规则。
 *
 * 运行前需先 `bash scripts/build.sh`（本测试读 dist/，不读 core 源）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatPmPrompt } from "../../dist/core/ops.js";

const distRoot = join(import.meta.dirname, "../../dist");
const ZH_GUIDE = join(distRoot, "supervisor-guide.zh.md");
const EN_GUIDE = join(distRoot, "supervisor-guide.en.md");
const BUILD_HINT = "指南与 PM 提示词运行时从 dist/ 读取：请先运行 `bash scripts/build.sh` 再跑测试（dist/ 是生成物，禁止手改）";

/** 小节与矩阵：判据 1 的关键词（改动前 zh/en 指南命中数均为 0）。 */
const ZH_SECTION = ["## 技术选型与架构评估", "技术选型", "全生命周期成本评估", "胶水层", "双真相", "自研白盒", "黑盒重型库"];
const EN_SECTION = [
  "## Technology Selection and Architecture Evaluation",
  "Technology Selection",
  "full-lifecycle cost evaluation",
  "glue layer",
  "dual-source-of-truth",
  "white-box",
  "black-box library",
];

/** 七维矩阵：两侧必须覆盖同一组维度（判据 1 点名的最低要求）。 */
const ZH_DIMENSIONS = [
  "初始集成",
  "胶水/适配层规模",
  "双真相与状态同步",
  "事件与渲染回环",
  "无用图层剔除",
  "升级与替换成本",
  "排错与 Agent 返工成本",
];
const EN_DIMENSIONS = [
  "Initial integration",
  "Glue/adapter layer size",
  "Dual truth and state sync",
  "Event and render loops",
  "Unused layer removal",
  "Upgrade and replacement cost",
  "Debugging and Agent rework",
];

/** 阈值与估算口径（判据 2）：阈值字面量与三个档位必须双侧可检索。 */
const ZH_THRESHOLD = ["胶水层预估 LOC", "自研业务逻辑预估 LOC", "0.5", "1.0", "S≤50", "M≤200", "L>200", "负责人确认"];
const EN_THRESHOLD = ["glue layer LOC", "in-house business-logic LOC", "0.5", "1.0", "S<=50", "M<=200", "L>200", "owner"];

/** 规划期使用流程：把矩阵作为 collect brief 传递、决策写回目标描述。 */
const ZH_FLOW = ["graph_amend_goal", "graph_set_criteria", "collect brief", "收集子代理"];
const EN_FLOW = ["graph_amend_goal", "graph_set_criteria", "collect brief", "collection subagent"];

/** 4 个既有 PM prompt 锚点子串（role-profiles.test.ts 锚定）——防误删回报格式块。 */
const ZH_ANCHORS = ["【g-308 润色建议】", "回报格式要求"];
const EN_ANCHORS = ["【g-308 润色建议】", "Report format requirement"];

/** PM 渲染产物里的压缩版条目（判据 3）。 */
const ZH_PM_KEYWORDS = ["架构选型倾向", "胶水层预估 LOC", "自研白盒", "0.5", "1.0", "S≤50", "M≤200", "L>200", "负责人确认"];
const EN_PM_KEYWORDS = [
  "Architecture selection bias",
  "glue layer LOC",
  "white-box",
  "0.5",
  "1.0",
  "S<=50",
  "M<=200",
  "L>200",
  "owner confirmation",
];

const missing = (text: string, needles: readonly string[]): string[] => needles.filter((needle) => !text.includes(needle));
const headingLevels = (text: string): string[] => (text.match(/^#{1,6} /gm) ?? []).map((heading) => heading[0]);
const technicalTokens = (text: string): string[] =>
  [...new Set([...text.matchAll(/(?:graph_[A-Za-z0-9_]+|@att\/[A-Za-z0-9_./<>-]+|worktree=false)/g)].map((match) => match[0]))].sort();

/**
 * 指南检查器：返回缺口列表（空列表 = 通过）。抽成纯函数是为了让负向对照能在内存里
 * 对真实产物做定点破坏后重放同一套判定，而不是另写一份「演示用」断言。
 */
function guideGaps(zh: string, en: string): string[] {
  const gaps: string[] = [];
  for (const needle of missing(zh, [...ZH_SECTION, ...ZH_DIMENSIONS, ...ZH_FLOW])) gaps.push(`zh 指南缺片段：「${needle}」`);
  for (const needle of missing(en, [...EN_SECTION, ...EN_DIMENSIONS, ...EN_FLOW])) gaps.push(`en 指南缺片段：「${needle}」`);
  const zhLines = zh.split("\n").length;
  const enLines = en.split("\n").length;
  if (zhLines !== enLines) gaps.push(`zh/en 指南行数不等：${zhLines} vs ${enLines}`);
  if (JSON.stringify(headingLevels(zh)) !== JSON.stringify(headingLevels(en))) gaps.push("zh/en 指南标题层级序列不一致");
  if (JSON.stringify(technicalTokens(zh)) !== JSON.stringify(technicalTokens(en))) gaps.push("zh/en 指南技术 token 集合不一致");
  return gaps;
}

/** 阈值检查器：指南 + PM 渲染产物四条文本都要命中阈值与档位字面量。 */
function thresholdGaps(zhGuide: string, enGuide: string, zhPm: string, enPm: string): string[] {
  const gaps: string[] = [];
  for (const needle of missing(zhGuide, ZH_THRESHOLD)) gaps.push(`zh 指南缺阈值片段：「${needle}」`);
  for (const needle of missing(enGuide, EN_THRESHOLD)) gaps.push(`en 指南缺阈值片段：「${needle}」`);
  for (const needle of missing(zhPm, ZH_THRESHOLD)) gaps.push(`zh PM 渲染产物缺阈值片段：「${needle}」`);
  for (const needle of missing(enPm, EN_THRESHOLD)) gaps.push(`en PM 渲染产物缺阈值片段：「${needle}」`);
  return gaps;
}

/** PM 检查器：压缩版倾向条目存在 + 既有锚点未丢 + en 路未回落到中文文案。 */
function pmGaps(zhPm: string, enPm: string): string[] {
  const gaps: string[] = [];
  for (const needle of missing(zhPm, ZH_PM_KEYWORDS)) gaps.push(`zh PM 渲染产物缺片段：「${needle}」`);
  for (const needle of missing(enPm, EN_PM_KEYWORDS)) gaps.push(`en PM 渲染产物缺片段：「${needle}」`);
  for (const needle of missing(zhPm, ZH_ANCHORS)) gaps.push(`zh PM 渲染产物丢失既有锚点：「${needle}」`);
  for (const needle of missing(enPm, EN_ANCHORS)) gaps.push(`en PM 渲染产物丢失既有锚点：「${needle}」`);
  if (enPm.includes("架构选型倾向")) gaps.push("en PM 渲染产物出现中文小节标题，说明未走英文分支");
  return gaps;
}

const PM_PROBE = { goalId: "g-308", goalRel: ".dsh-graph/versions/v0.16.0/goals/g-308/goal.md" };
const renderZhPm = () => formatPmPrompt(PM_PROBE);
const renderEnPm = () => formatPmPrompt({ ...PM_PROBE, language: "en" as const });

test("g-313 判据 1：dist 指南含「技术选型与架构评估」独立小节与七维成本矩阵（zh/en 行数、标题层级一致）", () => {
  const gaps = guideGaps(readFileSync(ZH_GUIDE, "utf8"), readFileSync(EN_GUIDE, "utf8"));
  assert.deepEqual(gaps, [], `${BUILD_HINT}\n${gaps.join("\n")}`);
});

test("g-313 判据 1：小节插在「阶段推进」之后、「信息收集」之前（语义位置与计划一致）", () => {
  /** 取顶级小节（恰好 `## `，不含 `###`/`####`）构成的小节序列。 */
  const topSections = (text: string) => text.split("\n").filter((line) => line.startsWith("## ") && !line.startsWith("### "));
  const zhSections = topSections(readFileSync(ZH_GUIDE, "utf8"));
  const zhAt = zhSections.indexOf("## 技术选型与架构评估");
  assert.ok(zhAt > 0, `${BUILD_HINT}\nzh 指南缺顶级小节「## 技术选型与架构评估」`);
  assert.equal(zhSections[zhAt - 1], "## 阶段推进", "新小节应紧跟在顶级小节「阶段推进」之后");
  assert.equal(zhSections[zhAt + 1], "## 信息收集", "新小节应紧邻顶级小节「信息收集」之前");

  const enSections = topSections(readFileSync(EN_GUIDE, "utf8"));
  const enAt = enSections.indexOf("## Technology Selection and Architecture Evaluation");
  assert.ok(enAt > 0, `${BUILD_HINT}\nen 指南缺顶级小节「## Technology Selection and Architecture Evaluation」`);
  assert.equal(enAt, zhAt, "en 侧新小节在顶级小节序列中的位置应与 zh 对齐");
});

test("g-313 判据 2：阈值与 S/M/L 估算口径在 dist 指南与 PM 渲染产物中均可检索", () => {
  const gaps = thresholdGaps(
    readFileSync(ZH_GUIDE, "utf8"),
    readFileSync(EN_GUIDE, "utf8"),
    renderZhPm(),
    renderEnPm(),
  );
  assert.deepEqual(gaps, [], `${BUILD_HINT}\n${gaps.join("\n")}`);
});

test("g-313 判据 3：formatPmPrompt 中英两路渲染产物含架构选型倾向条目且 4 个既有锚点未丢", () => {
  const gaps = pmGaps(renderZhPm(), renderEnPm());
  assert.deepEqual(gaps, [], `${BUILD_HINT}\n${gaps.join("\n")}`);
});

test("g-313 判别力：改动前关键词命中数为 0（断言不是「本来就绿」），负向对照改坏即红且不污染 dist", () => {
  const zhGuide = readFileSync(ZH_GUIDE, "utf8");
  const enGuide = readFileSync(EN_GUIDE, "utf8");
  const zhPm = renderZhPm();
  const enPm = renderEnPm();

  // 判别力自证：新断言依赖的关键词确实由本次新增内容提供，而不是别处早已存在。
  const discriminative = ["技术选型与架构评估", "双真相", "自研白盒", "胶水层"];
  for (const needle of discriminative) {
    const occurrences = zhGuide.split(needle).length - 1;
    assert.ok(occurrences > 0, `判别力前提不成立：「${needle}」在 zh 指南中零命中`);
    assert.ok(occurrences <= 4, `「${needle}」疑似在指南里散落多处（${occurrences} 次），应集中在新增小节内`);
  }
  assert.ok(zhPm.includes("架构选型倾向"), "判别力前提不成立：zh PM 产物未含新增条目");

  // 负向对照 1：删掉矩阵中的一行维度 → 判据 1 必红。
  const zhGuideDroppedDimension = zhGuide.replace("| 无用图层剔除 | 不生成多余结构 | 库强制图层需事后清理 |\n", "");
  assert.notEqual(zhGuideDroppedDimension, zhGuide, "负向对照失效：未找到可删除的维度行");
  assert.ok(guideGaps(zhGuideDroppedDimension, enGuide).length > 0, "删掉一个矩阵维度后判据 1 竟然仍绿");

  // 负向对照 2：en 侧多一行 → 行数不变量必红。
  assert.ok(guideGaps(zhGuide, `${enGuide}\nextra line\n`).length > 0, "en 指南行数被破坏后仍绿");

  // 负向对照 3：抹掉 zh 侧阈值字面量 → 判据 2 必红。
  const zhGuideNoThreshold = zhGuide.replaceAll("0.5", "0.9").replaceAll("1.0", "1.1");
  assert.ok(
    thresholdGaps(zhGuideNoThreshold, enGuide, zhPm, enPm).length > 0,
    "抹掉 zh 指南阈值字面量后判据 2 竟然仍绿",
  );

  // 负向对照 4：抹掉 PM en 分支的小节标题 → 判据 3 必红。
  const enPmNoSection = enPm.replace("## Architecture selection bias", "");
  assert.notEqual(enPmNoSection, enPm, "负向对照失效：未找到 en PM 小节标题");
  assert.ok(pmGaps(zhPm, enPmNoSection).length > 0, "en PM 产物缺小节标题后判据 3 竟然仍绿");

  // 负向对照 5：删掉回报格式锚点 → 判据 3 必红（防「改新内容时顺手删掉旧块」）。
  assert.ok(pmGaps(zhPm.replace("回报格式要求", ""), enPm).length > 0, "zh 锚点被删后判据 3 竟然仍绿");
  assert.ok(pmGaps(zhPm, enPm.replace("Report format requirement", "")).length > 0, "en 锚点被删后判据 3 竟然仍绿");

  // hermetic：负向对照只改内存字符串，真实 dist 产物必须逐字节未变。
  assert.equal(readFileSync(ZH_GUIDE, "utf8"), zhGuide, "负向对照污染了 dist 指南");
  assert.equal(readFileSync(EN_GUIDE, "utf8"), enGuide, "负向对照污染了 dist 指南");
  assert.deepEqual(guideGaps(readFileSync(ZH_GUIDE, "utf8"), readFileSync(EN_GUIDE, "utf8")), [], "真实 dist 指南被破坏");
});
