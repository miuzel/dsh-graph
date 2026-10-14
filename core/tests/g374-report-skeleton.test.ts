// g-374 F6：子代理**交回报文骨架**（注入 brief 尾注单一真源）+ F7 报文本体预算规范。
//
// 契约（负责人 2026-09-29 追加）：
//  ① 骨架只此一处定义（executor 8 项 + reviewer 6 项），由 `graph_start_attempt` 的注入文本尾注提供；
//  ② 任何 attempt 的注入文本都含该骨架，且**除骨架尾注块外与基线逐字节相同**（可精确框定新增块范围）；
//  ③ 截获路径零 LLM 调用不变；summarizer 角色提示面不得进入普通派发注入文本；
//  ④ 骨架 zh/en 对称、en 零 CJK；F7 的 4 KiB 软上限与分预算写进骨架规范。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  formatAttemptReportSkeleton, stripAttemptReportSkeleton,
  ATTEMPT_REPORT_SKELETON, ATTEMPT_REPORT_SKELETON_EN,
  ATTEMPT_REPORT_SKELETON_BEGIN, ATTEMPT_REPORT_SKELETON_END,
  ATTEMPT_REPORT_SOFT_MAX_BYTES, ATTEMPT_REPORT_SECTION_BUDGETS,
  SUMMARY_INPUT_ATTEMPT_MAX_BYTES, SUMMARY_INPUT_TOTAL_MAX_BYTES,
  REVIEW_CONCLUSION_EXAMPLE_ZH,
} from "../ops.ts";
import { formatAttemptPrompt } from "../../dist/index.js";

const repoRoot = join(import.meta.dirname, "../..");
const promptPath = (name: string) => join(repoRoot, "dsh-graph-host", "prompts", name);

/** 与宿主一致的最小 prompt 参数（只在测试内构造，不落到产品代码）。 */
const promptArgs = (over = {}) => ({
  goal: "g-374", attempt: "att-001", goalRel: ".dsh-graph/versions/v0.17.0/goals/g-374/goal.md",
  attemptBrief: "实现 F6 报文骨架", cardsSection: "## 已收集上下文卡片成果\n\n（无）",
  worktreeBlock: "【强制 worktree 隔离】", ...over,
});

const strip = (text: string) => stripAttemptReportSkeleton(text);

// ============================================================================
// ① 单一真源 + 逐项必填
// ============================================================================

test("g-374 F6：骨架是单一真源——正文只在 prompts/attempt-report-skeleton.*.md，代码只做装配", () => {
  // g-496 口径变更（负责人 2026-10-14 批准）：正文真源从 `core/ops.ts` 的模板字面量
  // **迁到随包 md 资产**；core 只保留装配（读取 + 两处占位符插值 + begin/end 包裹）。
  // 故本用例断言的不变量从「真源在 ops.ts」改为「真源在 md、且代码侧不留第二副本」。
  const assetNames = ["attempt-report-skeleton.zh.md", "attempt-report-skeleton.en.md"];
  for (const name of assetNames) {
    const text = readFileSync(promptPath(name), "utf8");
    assert.ok(text.includes("## "), `${name} 必须含骨架正文`);
    // 资产里**不得**含 begin/end 机器标记（标记仍由逻辑提供）
    assert.ok(!text.includes(ATTEMPT_REPORT_SKELETON_BEGIN), `${name} 不得含骨架 begin 标记（标记由逻辑提供）`);
    assert.ok(!text.includes(ATTEMPT_REPORT_SKELETON_END), `${name} 不得含骨架 end 标记（标记由逻辑提供）`);
    // 资产里以**占位符**引用「预算」与「结论示例」，二者仍由逻辑提供
    assert.ok(text.includes("{{soft_max_kib}}"), `${name} 必须用占位符引用预算（不得写死数字）`);
    assert.ok(text.includes("{{conclusion_example}}"), `${name} 必须用占位符引用结论示例`);
  }
  // 骨架独有句式（executor 8 项 + reviewer 6 项的标题行）：必须**恰好**在真源资产里出现一次，
  // 且不得出现在**其它**任何提示面资产里（单一真源约束，方向与 g-496 之前相反）。
  const skeletonLines = ATTEMPT_REPORT_SKELETON.split("\n").filter((l) => /^\d+\. \*\*/.test(l));
  assert.equal(skeletonLines.length, 14, "executor 8 项 + reviewer 6 项 = 14 条逐项必填");
  const zhAsset = readFileSync(promptPath("attempt-report-skeleton.zh.md"), "utf8");
  for (const line of skeletonLines) {
    // 资产里用 `{{conclusion_example}}` 占位符引用结论示例 ⇒ 比对时把插值结果还原成占位符形态。
    const assetForm = line.split(REVIEW_CONCLUSION_EXAMPLE_ZH).join("{{conclusion_example}}");
    assert.ok(zhAsset.includes(assetForm), `真源资产必须逐条含骨架项：${assetForm.slice(0, 30)}`);
  }
  const assets = readdirSync(promptPath(".")).filter((n) => n.endsWith(".md") && !assetNames.includes(n));
  assert.ok(assets.length > 0, "提示面资产必须存在");
  for (const name of assets) {
    const text = readFileSync(promptPath(name), "utf8");
    for (const line of skeletonLines) {
      assert.ok(!text.includes(line), `${name} 不得复制骨架条目（单一真源约束）：${line.slice(0, 40)}`);
    }
    assert.ok(!text.includes(ATTEMPT_REPORT_SKELETON_BEGIN), `${name} 不得复制骨架标记`);
  }
  // 代码侧（core/ops.ts）**不得**再内联骨架条目正文 —— 只允许读取 + 装配。
  const ops = readFileSync(join(import.meta.dirname, "../ops.ts"), "utf8");
  assert.ok(ops.includes("readCorePromptAsset(\"attempt-report-skeleton\""), "core 必须从资产读取骨架正文");
  for (const line of skeletonLines) assert.ok(!ops.includes(line), `core/ops.ts 不得内联骨架条目：${line.slice(0, 30)}`);
  // begin/end 标记仍**由逻辑提供**（常量声明），但不是正文：除两个常量声明行外不得再出现标记字面量。
  const markerOccurrences = ops.split(ATTEMPT_REPORT_SKELETON_BEGIN).length - 1;
  assert.equal(markerOccurrences, 1, "core/ops.ts 只应在常量声明处出现一次 begin 标记（标记由逻辑提供）");
  assert.ok(ops.includes(`ATTEMPT_REPORT_SKELETON_BEGIN = "${ATTEMPT_REPORT_SKELETON_BEGIN}"`), "标记必须由常量声明提供");
  // 宿主侧只允许 import + 调用（不得内联骨架文本）
  const host = readFileSync(join(repoRoot, "dsh-graph-host/index.js"), "utf8");
  assert.match(host, /formatAttemptReportSkeleton\("zh"\)|formatAttemptReportSkeleton\("en"\)|formatAttemptReportSkeleton\(/,
    "宿主必须调用 core 的骨架函数");
  assert.ok(!host.includes(ATTEMPT_REPORT_SKELETON_BEGIN), "宿主不得内联骨架标记");
  for (const line of skeletonLines) assert.ok(!host.includes(line), `宿主不得内联骨架条目：${line.slice(0, 30)}`);
});

test("g-374 F6：executor 8 项逐项必填——骨架逐项在列（含影响面/怎么改的/负向与基线对照）", () => {
  const execTitles = [
    "交付位置", "改了什么", "怎么改的", "影响面", "测过什么 / 没测什么", "值得注意的点", "与判据的对应", "需主管裁决事项",
  ];
  const reviewerTitles = ["总判", "逐项结论与单行证据", "BLOCK 最小返工清单", "非阻塞注记", "残余风险", "未验证项"];
  const zh = ATTEMPT_REPORT_SKELETON;
  for (const t of execTitles) assert.ok(zh.includes(`**${t}**`), `executor 骨架缺项：${t}`);
  for (const t of reviewerTitles) assert.ok(zh.includes(`**${t}**`), `reviewer 骨架缺项：${t}`);
  assert.ok(zh.includes("PASS / BLOCK / UNVERIFIED"), "reviewer 总判取值必须写死");
  assert.ok(zh.includes("负向对照") && zh.includes("基线对照"), "第 5 项必须要求负向对照与基线对照");
  assert.ok(zh.includes("含被否方案与否决理由"), "第 3 项必须要求被否方案与否决理由");
});

// ============================================================================
// ② 注入文本必含骨架；除骨架块外逐字节不变（可精确框定）
// ============================================================================

test("g-374 F6：任何 attempt 的注入文本都含骨架，且剥离骨架块后与其「无骨架」版本逐字节相同", () => {
  for (const over of [{}, { promptLanguage: "en" }, { attemptBrief: "另一个任务", taskType: "merge", worktreeBlock: "" }]) {
    const lang = (over as any).promptLanguage ?? "zh";
    const withSkeleton = formatAttemptPrompt(promptArgs(over));
    const parsed = strip(withSkeleton);
    assert.equal(parsed.stripped, true, `注入文本必须含骨架块（${lang}）`);
    // 精确框定新增块：必须是**尾注**（末尾），且 begin/end 各恰好一次。
    assert.ok(withSkeleton.trimEnd().endsWith(ATTEMPT_REPORT_SKELETON_END), "骨架必须是尾注（最后一块）");
    assert.equal(withSkeleton.split(ATTEMPT_REPORT_SKELETON_BEGIN).length - 1, 1);
    assert.equal(withSkeleton.split(ATTEMPT_REPORT_SKELETON_END).length - 1, 1);
    const block = withSkeleton.slice(withSkeleton.indexOf(ATTEMPT_REPORT_SKELETON_BEGIN));
    assert.equal(block.trimEnd(), formatAttemptReportSkeleton(lang).trimEnd(), "尾注块必须与单一真源逐字相同");
    // 「除骨架块外逐字节不变」：剥离后的文本 + 骨架块（含分隔空行）= 原文本。
    const rebuilt = parsed.text + "\n\n" + formatAttemptReportSkeleton(lang);
    assert.equal(rebuilt, withSkeleton.replace(/\n+$/, "") + "\n".repeat(withSkeleton.length - withSkeleton.replace(/\n+$/, "").length),
      "文本必须恰好等于「剥离结果 + 骨架块」（无其它差异）");
    // 骨架不得改变前面的任何字节：与基线（无骨架版本）比对由交付脚本用 cf7c66d 的真实 prompt cmp 给出；
    // 这里先钉住「剥离结果与去掉尾注的切片逐字相同」这一等价命题。
    assert.equal(parsed.text, withSkeleton.slice(0, withSkeleton.length - block.length).replace(/\n+$/, ""),
      "剥离结果必须等于「原文本去掉尾部骨架切片」");
  }
});

test("g-374 F6：骨架块字节数与基线 prompt 的差额一一对应（7 KiB 量级，可复算）", () => {
  const zh = formatAttemptPrompt(promptArgs());
  const block = formatAttemptReportSkeleton("zh");
  assert.equal(Buffer.byteLength(zh, "utf8"), Buffer.byteLength(strip(zh).text, "utf8") + Buffer.byteLength(block, "utf8") + 2,
    "总字节 = 剥离后字节 + 骨架块字节 + 两个分隔换行（精确框定新增范围）");
});

// ============================================================================
// ③ 零 token / 角色隔离不变
// ============================================================================

test("g-374 F6：骨架不得引入 summarizer 角色提示面，也不得引入新工具名（零 token 语义不变）", () => {
  for (const lang of ["zh", "en"] as const) {
    const block = formatAttemptReportSkeleton(lang);
    assert.ok(!block.includes("graph_refresh_results"), `${lang} 骨架不得提摘要工具（否则等于让执行者写总结）`);
    assert.ok(!block.includes("graph_write_results"), `${lang} 骨架不得提结果写入工具`);
    assert.ok(!block.includes("summarizer"), `${lang} 骨架不得混入 summarizer 角色面`);
    assert.ok(!/results-att|lastAssistantMessage/.test(block), `${lang} 骨架不得提截获实现细节`);
  }
  // 骨架提到 results.md 是**允许**的（它只描述回报格式，不指示调用工具）；但普通注入文本剥离骨架后不得含它。
  const zh = formatAttemptPrompt(promptArgs());
  assert.ok(!strip(zh).text.includes("results.md"), "剥离骨架后不得再提 results.md");
});

// ============================================================================
// ④ zh/en 对称 + en 零 CJK + F7 预算规范
// ============================================================================

test("g-374 F6/F7：骨架 zh/en 对称、en 零 CJK，且含 4 KiB 软上限与分预算", () => {
  assert.equal(ATTEMPT_REPORT_SOFT_MAX_BYTES, 4096, "报文本体软上限写死 4 KiB");
  assert.deepEqual(ATTEMPT_REPORT_SECTION_BUDGETS, {
    changes: 1536, how: 1024, impact: 512, tested: 512, noteworthy: 512, criteria: 512,
  }, "分预算：改了什么 1.5 KiB / 怎么改的 1 KiB / 其余四项各 0.5 KiB");
  const zhLines = ATTEMPT_REPORT_SKELETON.split("\n");
  const enLines = ATTEMPT_REPORT_SKELETON_EN.split("\n");
  assert.equal(zhLines.length, enLines.length, "zh/en 骨架行数必须一一对应（对称）");
  assert.doesNotMatch(ATTEMPT_REPORT_SKELETON_EN, /[\u3400-\u9fff]/, "en 骨架必须零 CJK");
  assert.match(ATTEMPT_REPORT_SKELETON_EN, /4 KiB/, "en 骨架必须写出 4 KiB 软上限");
  assert.match(ATTEMPT_REPORT_SKELETON_EN, /1\.5 KiB/);
  assert.match(ATTEMPT_REPORT_SKELETON_EN, /256 KiB/);
  assert.match(ATTEMPT_REPORT_SKELETON, /已超预算/, "zh 骨架必须要求超限自报");
  assert.match(ATTEMPT_REPORT_SKELETON_EN, /over budget/, "en 骨架必须要求超限自报");
  // 超限自报不算失败：文案里必须明确「不算交付失败」
  assert.match(ATTEMPT_REPORT_SKELETON, /超限不算交付失败|不算交付失败/);
  assert.match(ATTEMPT_REPORT_SKELETON_EN, /not a failed delivery/);
  // 与 F7 常数一致（骨架写的是 8 KiB / 256 KiB，产品常数必须同值）
  assert.equal(SUMMARY_INPUT_ATTEMPT_MAX_BYTES, 8 * 1024);
  assert.equal(SUMMARY_INPUT_TOTAL_MAX_BYTES, 256 * 1024);
});

test("g-374 F6：骨架中「落盘上限不变」必须写明（历史留档完整，只省喂给 LLM 的那一份）", () => {
  assert.match(ATTEMPT_REPORT_SKELETON, /64 KiB/, "zh 骨架必须写明落盘仍为 64 KiB");
  assert.match(ATTEMPT_REPORT_SKELETON, /1 MiB/, "zh 骨架必须写明读取仍为 1 MiB");
  assert.match(ATTEMPT_REPORT_SKELETON_EN, /64 KiB/);
  assert.match(ATTEMPT_REPORT_SKELETON_EN, /1 MiB/);
});
