/**
 * g-487 判据套件：评审结论解析健壮性 + 误记回填 + 提示词骨架同口径。
 *
 * 缺陷（真实发生，非假想）：评审者按提示词骨架写出**合规**的结论行（`## 总判：**PASS**`、
 * `## 总判` + 次行 `**PASS**`），而修复前的解析器只容忍行首可选的 `-`/`*`/`**`、**不认 `#+`
 * 标题前缀**，且要求标签与值**同一行** ⇒ 真实独立 PASS 被机械记为 UNVERIFIED；下游
 * `independentOk` 要求 `conclusion === "PASS"` ⇒ 一次真实独立复核在机器面等于不存在。
 *
 * 断言面（逐条对应 g-487 判据）：
 *  1. 解析容错：`- **总判**：PASS` / `**总判**：PASS` / `## 总判：PASS` / 无前缀 / 跨行
 *     （标签独占一行、值在下一非空行）/ `结论`·`Verdict` 同义 / 全半角冒号 / 大小写归一；
 *     值仅取闭集 `PASS|BLOCK|UNVERIFIED`。
 *  2. 不误判（fail-closed）：值缺失、值不在闭集、仅出现标签而无值、枚举模板
 *     （`总判：PASS / BLOCK / UNVERIFIED`）、冲突行 ⇒ 仍 UNVERIFIED；**绝不把 BLOCK 升格为 PASS**。
 *  3. 误记回填/重算：只读重算路径（零写入）+ 幂等回填（事件留痕 `review.conclusion_reconciled`
 *     + 刷新 frontmatter 快照），**评审正文逐字节不变**；failed / 无结论行 / 反向不一致一律不改写。
 *  4. 提示词骨架同步：骨架与评审提示词登记的**示例行**必须被解析器认（单一真源）；而含三选一枚举的
 *     **指令行**整体不得被解析为裁决（否则「照抄模板」= 机械记 PASS）。
 *  5. 端到端：写 review（settleReview）→ 读 conclusion（reviewRecordViews / goalReviewState），
 *     真实事故形态 ⇒ PASS 且 independentOk=true；异常终止/空输出仍降级 UNVERIFIED。
 *  6. 回归守卫：既有 g-436 解析断言逐条重放（只增不减）；事件闭集与写入集合一致。
 *
 * hermetic：全部在 tmp 私有看板副本内进行，不触碰仓库数据；不建 worktree、不建 Git 仓库。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  ATTEMPT_REPORT_SKELETON,
  ATTEMPT_REPORT_SKELETON_EN,
  REVIEW_CONCLUSION_EXAMPLE_EN,
  REVIEW_CONCLUSION_EXAMPLE_ZH,
  REVIEW_CONCLUSIONS,
  REVIEW_EVENT_NAMES,
  REVIEW_RECORD_EVENT_NAMES,
  appendReviewDispatch,
  bindReviewChild,
  createGoal,
  findGoalFile,
  formatReviewPrompt,
  goalReviewState,
  init,
  parseReviewConclusion,
  readReviewRecord,
  rebuild,
  reconcileReviewConclusions,
  reviewRecordViews,
  setCriteria,
  settleReview,
} from "../ops.ts";
import { readEvents, appendEvent } from "../events.ts";
import { parseDoc, serializeDoc } from "../model.ts";

const VERIFIED = "✅已验";
const CANDIDATE = "c0ffee1234567890abcdef1234567890abcdef12";

// =====================================================================================
// 旧实现（修复前逐字冻结；用于负向对照，证明「缺陷真实存在 + 新实现确实变了行为」）
// =====================================================================================

/** 逐字取自修复前的 `core/ops.ts`（`parseReviewConclusion`，基线 commit c8bfb70）。
 *  单行、只容忍 `-`/`*`/`**` 前缀 ⇒ `#+` 标题与跨行形态一律认不出；且 `\b` 结尾会把
 *  `总判：PASS / BLOCK / UNVERIFIED` 这种**枚举模板**误读成 PASS。 */
const OLD_RE = /(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?\s*(?:总判|结论|Verdict)\s*(?:\*\*)?\s*[:：]\s*(?:\*\*)?\s*(PASS|BLOCK|UNVERIFIED)\b/i;
function oldParseReviewConclusion(text: unknown): string {
  const raw = typeof text === "string" ? text : "";
  if (!raw.trim()) return "UNVERIFIED";
  const m = raw.match(OLD_RE);
  if (!m) return "UNVERIFIED";
  const v = m[1].toUpperCase();
  return (REVIEW_CONCLUSIONS as readonly string[]).includes(v) ? v : "UNVERIFIED";
}

// =====================================================================================
// 夹具
// =====================================================================================

interface Board { ws: string; root: string; goal: string; goalDir: string }

/** 私有看板副本 + 一个真实目标 + 一个真实 attempt 目录（评审是对既有 attempt 的附属记录）。 */
function mkBoard(): Board {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g487-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "g-487 夹具目标", version: "v-test", type: "feature", actor: "human:gui" });
  setCriteria(root, goal, [`判据一：结论解析与误记回填 ${VERIFIED}`], "human:gui");
  const goalDir = dirname(findGoalFile(root, goal));
  mkdirSync(join(goalDir, "attempts", "att-001"), { recursive: true });
  writeFileSync(
    join(goalDir, "attempts", "att-001", "attempt.md"),
    '---\n{\n  "id": "att-001"\n}\n---\n\n（g-487 夹具 attempt 正文）\n',
    "utf8",
  );
  return { ws, root, goal, goalDir };
}

function recordFile(b: Board, reviewId: string): string {
  return join(b.goalDir, "reviews", `${reviewId}.md`);
}

/** 走真实写入路径：派发 → 绑定真实 reviewer child → 结算（= 「写 review」）。 */
function writeReview(
  b: Board,
  body: string,
  opts: { stopReason?: string | null } = {},
): { reviewId: string; conclusion: string; status: string; downgraded: boolean } {
  const { review_id } = appendReviewDispatch(b.root, {
    goalId: b.goal,
    sourceAttempt: "att-001",
    candidateSha: CANDIDATE,
    baselineSha: null,
    requestedBy: "agent:sess-super", // 主管请求 ⇒ 不构成 self_requested
    authorChildId: "child-exec-1",
    actor: "agent:sess-super",
  });
  bindReviewChild(b.root, b.goal, review_id, "child-review-1", "agent:sess-super");
  const res = settleReview(b.root, b.goal, review_id, {
    text: body,
    stopReason: opts.stopReason === undefined ? "completed" : opts.stopReason,
    actor: "host:subagent-end",
    childId: "child-review-1",
  });
  return { reviewId: review_id, conclusion: res.conclusion, status: res.status, downgraded: res.downgraded };
}

/** 复现**历史误记形态**（与线上 g-478/g-479/g-480/g-484 完全同形）：
 *  正文已给出合规结论行、frontmatter 快照也是 PASS，但**事件流**里的 `review.completed`
 *  记的是 UNVERIFIED（修复前的解析器在结算时认不出该形态）。
 *  ⇒ 机器面（`reviewRecordViews` / `independentOk`）因此读到 UNVERIFIED —— 这才是缺陷的
 *  真实后果：只改 `.md` 快照**不改变**机器面裁决。 */
function simulateOldMisrecord(b: Board, reviewId: string): void {
  appendEvent(b.root, {
    actor: "system:fixture-old-parser",
    event: "review.completed",
    goal: b.goal,
    details: { review_id: reviewId, conclusion: "UNVERIFIED", stop_reason: "completed", downgraded: false },
  });
}

/** 直接改写记录正文（模拟「结算后又改了正文」的重演形态；正文不入事件流）。 */
function rewriteBody(b: Board, reviewId: string, body: string): void {
  const file = recordFile(b, reviewId);
  const doc = parseDoc(readFileSync(file, "utf8"));
  doc.body = body;
  writeFileSync(file, serializeDoc(doc), "utf8");
}

/** 直接改写 frontmatter 快照（用于「快照与机器面不一致」的审计形态）。 */
function forceSnapshotConclusion(b: Board, reviewId: string, to: string): void {
  const file = recordFile(b, reviewId);
  const doc = parseDoc(readFileSync(file, "utf8"));
  doc.meta.conclusion = to;
  writeFileSync(file, serializeDoc(doc), "utf8");
}

function reviewCompletedEvents(root: string, reviewId: string) {
  return readEvents(root).filter((e: any) => e.event === "review.completed" && e.details?.review_id === reviewId);
}
function reconciledEvents(root: string, reviewId: string) {
  return readEvents(root).filter((e: any) => e.event === "review.conclusion_reconciled" && e.details?.review_id === reviewId);
}

// =====================================================================================
// 判据 1：解析容错（正例 ≥6 种变体）
// =====================================================================================

test("g-487 判据1：结论行解析容错——标题前缀/加粗/无前缀/跨行/同义词/全半角/大小写", () => {
  const cases: Array<[string, string, string]> = [
    ["既有形态：短横线 + 加粗", "- **总判**：PASS", "PASS"],
    ["仅加粗", "**总判**：PASS", "PASS"],
    ["二级标题前缀", "## 总判：PASS", "PASS"],
    ["三级标题 + 同义词「结论」", "### 结论：BLOCK", "BLOCK"],
    ["无任何前缀", "总判：PASS", "PASS"],
    ["半角冒号", "总判: PASS", "PASS"],
    ["大小写归一（值小写）", "Verdict: pass", "PASS"],
    ["英文标题 + 值大写", "# Verdict: BLOCK", "BLOCK"],
    ["真实事故形态：标题 + 值加粗", "## 总判：**PASS**", "PASS"],
    ["真实形态：整行加粗", "**总判：PASS**", "PASS"],
    ["列表序号前缀", "1. **总判**：PASS", "PASS"],
    ["引用前缀", "> **总判**：UNVERIFIED", "UNVERIFIED"],
    ["跨行：标题只写标签", "## 总判\n\n**PASS**", "PASS"],
    ["跨行：标签 + 次行裸值", "## 结论\nBLOCK", "BLOCK"],
    ["跨行 + 无前缀", "总判\nPASS", "PASS"],
    ["真值后跟正文（同行）", "**总判：PASS** —— 判据 1–7 全部成立，无 BLOCK 项。", "PASS"],
    ["真值后跟长括号说明", "**总判：PASS**（机制结论成立；我已独立重跑并得到零差异的复现。）", "PASS"],
    ["前置正文后再给结论行", "先说结论。\n\n## 总判：PASS\n\n## 未验证项\n无。", "PASS"],
  ];
  assert.ok(cases.length >= 6, `正例必须 ≥6 种变体（当前 ${cases.length}）`);
  for (const [label, text, expected] of cases) {
    const got = parseReviewConclusion(text);
    assert.equal(got, expected, `${label}：${JSON.stringify(text)} 应解析为 ${expected}，实际 ${got}`);
    assert.ok((REVIEW_CONCLUSIONS as readonly string[]).includes(got), `${label}：结果必须在闭集内`);
  }
  // 未验证项小节里的裸 UNVERIFIED（不在标签行之后）不得被当作裁决
  assert.equal(
    parseReviewConclusion("## 未验证项\n\n- UNVERIFIED\n- 未跑 Windows 真机"),
    "UNVERIFIED",
    "孤立的 UNVERIFIED 行不得被当作结论行（无标签 ⇒ 无裁决）",
  );
});

test("g-487 判据1：本批真实评审正文形态逐字重放（g-478/479/480/484 四例 + 正常五例）", () => {
  // 正文片段逐字取自本批 v0.21.0 评审记录（只取结论行及其紧邻行）。
  const real: Array<[string, string, string]> = [
    ["g-478（跨行：## 总判 + 次行 **PASS**）", "## 总判\n\n**PASS**\n", "PASS"],
    ["g-479 / g-484-rev1（二级标题同行）", "## 总判：PASS\n", "PASS"],
    ["g-480（二级标题 + 加粗值）", "## 总判：**PASS**\n", "PASS"],
    ["g-481（整行加粗 + 破折号说明）", "**总判：PASS** —— 判据 1–7 全部成立，无 BLOCK 项。\n", "PASS"],
    ["g-482（整行加粗 + 长括号说明）", "**总判：PASS**（机制结论成立；我已独立重跑并得到与作者证据零差异的复现。）\n", "PASS"],
    ["g-483（整行加粗）", "**总判：PASS**\n", "PASS"],
    ["g-484-rev2（短横线 + 加粗，BLOCK）", "- **总判**：BLOCK\n", "BLOCK"],
    ["g-488（短横线 + 加粗）", "- **总判**：PASS\n", "PASS"],
  ];
  for (const [label, text, expected] of real) {
    assert.equal(parseReviewConclusion(text), expected, `${label} 必须解析为 ${expected}`);
  }
  // 负向对照：其中 4 例（真实标题/跨行形态）在**修复前**一律被记为 UNVERIFIED —— 这正是本目标的缺陷。
  const regressed = [
    "## 总判\n\n**PASS**\n",
    "## 总判：PASS\n",
    "## 总判：**PASS**\n",
  ];
  for (const text of regressed) {
    assert.equal(
      oldParseReviewConclusion(text), "UNVERIFIED",
      `负向对照失效：旧实现竟能解析 ${JSON.stringify(text)}（缺陷前提被改写，请复核本守卫）`,
    );
    assert.notEqual(parseReviewConclusion(text), "UNVERIFIED", `新实现必须能解析 ${JSON.stringify(text)}`);
  }
});

// =====================================================================================
// 判据 2：不误判（负例 ≥4）
// =====================================================================================

test("g-487 判据2：负例 ≥4——有标签无值/闭集外值/枚举模板/无标签/空输入一律 UNVERIFIED", () => {
  const negatives: Array<[string, unknown]> = [
    ["标签在文末但无值（有总判字样无值）", "## 总判\n"],
    ["标签独占一行且次行是自然语言", "## 总判\n\n本报告未发现阻断项。\n"],
    ["标签 + 冒号但值为空", "总判：\n"],
    ["同义词标签无值", "### Verdict\n"],
    ["闭集外的值", "总判：MAYBE\n"],
    ["中文裁决词（不在闭集）", "## 总判：通过\n"],
    ["标签被其它字粘连（不是登记词表）", "总判判定：PASS\n"],
    ["仅出现标签字样，值在别的句子", "总判见下节说明。\n"],
    ["完全无标签的散文", "我读了一遍，感觉没问题。\n"],
    ["空字符串", ""],
    ["纯空白", "   \n\n"],
    ["非字符串", null],
    ["undefined", undefined],
    ["数值", 42],
  ];
  assert.ok(negatives.length >= 4, `负例必须 ≥4 种（当前 ${negatives.length}）`);
  for (const [label, text] of negatives) {
    assert.equal(parseReviewConclusion(text), "UNVERIFIED", `${label}：${JSON.stringify(text)} 必须 fail-closed 为 UNVERIFIED`);
  }
});

test("g-487 判据2：枚举模板不得被机械读成 PASS（旧实现会，新实现不会）", () => {
  const enumerations = [
    "总判：PASS / BLOCK / UNVERIFIED\n",
    "- **总判**：PASS / BLOCK / UNVERIFIED（附一句话理由）。\n",
    "## 总判：PASS | BLOCK | UNVERIFIED\n",
    "**Verdict**: PASS / BLOCK / UNVERIFIED\n",
  ];
  for (const text of enumerations) {
    assert.equal(
      parseReviewConclusion(text), "UNVERIFIED",
      `枚举模板必须 fail-closed 为 UNVERIFIED（否则「照抄提示词模板」会被机械记 PASS）：${JSON.stringify(text)}`,
    );
  }
  // 负向对照：旧实现的 `\b` 结尾会把枚举模板读成 PASS —— 这是**收紧**，不是放宽。
  assert.equal(oldParseReviewConclusion(enumerations[0]), "PASS", "负向对照：旧实现确实误读枚举模板");
  assert.equal(parseReviewConclusion(enumerations[0]), "UNVERIFIED", "新实现必须收紧（不得因容错而新引入误读）");
});

test("g-487 判据2：BLOCK 绝不被升格为 PASS（标题/跨行/冲突三形态）", () => {
  assert.equal(parseReviewConclusion("### 结论：BLOCK"), "BLOCK");
  assert.equal(parseReviewConclusion("## 结论\n\n**BLOCK**"), "BLOCK");
  assert.equal(parseReviewConclusion("- **总判**：BLOCK\n"), "BLOCK");
  // 冲突（同一正文两条不同裁决）⇒ fail-closed 为 UNVERIFIED，绝不取 PASS
  const conflicted = "## 总判：BLOCK\n\n（复审补充）\n\n## 结论：PASS\n";
  assert.equal(parseReviewConclusion(conflicted), "UNVERIFIED", "冲突结论必须 fail-closed，不得任取其一（更不得升格 PASS）");
  // 只有标签而值为 BLOCK，同时正文别处提到 PASS 字样 ⇒ 仍 BLOCK
  assert.equal(
    parseReviewConclusion("评审结论如下：\n\n## 总判：BLOCK\n\n未验证项：无法确认作者声称的 PASS 是否成立。\n"),
    "BLOCK",
    "正文游离的 PASS 字样不得覆盖显式 BLOCK 结论行",
  );
});

// =====================================================================================
// 判据 4：提示词骨架与解析实现单一真源
// =====================================================================================

test("g-487 判据4：骨架/提示词登记的示例行必须被解析器认（单一真源，防「骨架给出解析器不认的形式」）", () => {
  // ① 常量本身必须是可解析的确定裁决
  assert.equal(parseReviewConclusion(REVIEW_CONCLUSION_EXAMPLE_ZH), "PASS", `zh 示例必须可解析：${REVIEW_CONCLUSION_EXAMPLE_ZH}`);
  assert.equal(parseReviewConclusion(REVIEW_CONCLUSION_EXAMPLE_EN), "PASS", `en 示例必须可解析：${REVIEW_CONCLUSION_EXAMPLE_EN}`);
  // ② g-504 解耦后，「登记可解析结论行」的责任落在**评审者自己的载体**上：
  //    评审提示词（review-task.{zh,en}.md）必须登记示例行与「总判」标签。
  //    执行者骨架（attempt-report-skeleton）已显式移出 reviewer 段 ⇒ 它**不得**再含 reviewer 标签
  //    （否则又逼执行者写「未做独立评审」，正是 g-504 要消除的冗余）。
  const zhPromptEarly = formatReviewPrompt({ goalId: "g-1", attemptId: "att-001", goalRel: "goal.md", language: "zh", candidateSha: CANDIDATE, criteria: ["c1"] });
  const enPromptEarly = formatReviewPrompt({ goalId: "g-1", attemptId: "att-001", goalRel: "goal.md", language: "en", candidateSha: CANDIDATE, criteria: ["c1"] });
  assert.ok(zhPromptEarly.includes(REVIEW_CONCLUSION_EXAMPLE_ZH), "zh 评审提示词必须登记可解析的结论行示例");
  assert.ok(enPromptEarly.includes(REVIEW_CONCLUSION_EXAMPLE_EN), "en 评审提示词必须登记可解析的结论行示例");
  assert.ok(zhPromptEarly.includes("总判"), "zh 评审载体必须保留「总判」标签（既有守卫口径不变）");
  assert.ok(/\*\*Verdict\*\*/.test(enPromptEarly), "en 评审载体必须保留 Verdict 标签（既有守卫口径不变）");
  assert.ok(!ATTEMPT_REPORT_SKELETON.includes("总判"),
    "g-504：执行者骨架不得再要求执行者写 reviewer 总判（解耦反回归）");
  assert.ok(!ATTEMPT_REPORT_SKELETON_EN.includes("Overall verdict"),
    "g-504：en 执行者骨架同样不得含 reviewer 标签（解耦反回归）");

  // ③ 评审提示词（zh/en）必须同时登记「示例行」与「可接受形态」，且每条形态都能被解析器认
  const zh = formatReviewPrompt({ goalId: "g-1", attemptId: "att-001", goalRel: "goal.md", language: "zh", candidateSha: CANDIDATE, criteria: ["c1"] });
  const en = formatReviewPrompt({ goalId: "g-1", attemptId: "att-001", goalRel: "goal.md", language: "en", candidateSha: CANDIDATE, criteria: ["c1"] });
  assert.ok(zh.includes(REVIEW_CONCLUSION_EXAMPLE_ZH), "zh 评审提示词必须登记示例行");
  assert.ok(en.includes(REVIEW_CONCLUSION_EXAMPLE_EN), "en 评审提示词必须登记示例行");
  const acceptedForms = ["- **总判**：PASS", "## 总判：PASS", "**总判：PASS**", "总判：PASS"];
  for (const form of acceptedForms) {
    assert.ok(zh.includes(form), `zh 评审提示词必须登记可接受形态：${form}`);
    assert.equal(parseReviewConclusion(form), "PASS", `登记的可接受形态必须真的可解析：${form}`);
  }
  for (const form of ["- **Verdict**: PASS", "## Verdict: PASS", "**Verdict**: PASS", "Verdict: PASS"]) {
    assert.ok(en.includes(form), `en 评审提示词必须登记可接受形态：${form}`);
    assert.equal(parseReviewConclusion(form), "PASS", `登记的可接受形态必须真的可解析：${form}`);
  }

  // ④ 反向边界：**指令行**（含三选一枚举与说明文字）整体不得被解析为裁决 ——
  //    否则「把骨架指令照抄进报告」就会机械记 PASS，比缺陷本身更危险。
  assert.equal(parseReviewConclusion(ATTEMPT_REPORT_SKELETON), "UNVERIFIED", "骨架指令整体不得被解析为裁决（fail-closed）");
  assert.equal(parseReviewConclusion(ATTEMPT_REPORT_SKELETON_EN), "UNVERIFIED", "en 骨架指令整体不得被解析为裁决（fail-closed）");
  assert.equal(parseReviewConclusion(zh), "UNVERIFIED", "zh 评审提示词整体不得被解析为裁决（fail-closed）");
  assert.equal(parseReviewConclusion(en), "UNVERIFIED", "en 评审提示词整体不得被解析为裁决（fail-closed）");
  // 反向边界的**具体成因**：指令行里保留了三选一枚举（提示词信息量不得因收紧而丢失）
  assert.ok(zh.includes("PASS / BLOCK / UNVERIFIED"), "zh 评审提示词必须保留三选一枚举（信息量不减）");
  assert.ok(en.includes("PASS / BLOCK / UNVERIFIED"), "en 评审提示词必须保留三选一枚举（信息量不减）");
});

// =====================================================================================
// 判据 5：端到端「写 review → 读 conclusion」
// =====================================================================================

test("g-487 判据5：写 review → 读 conclusion——标题+加粗的真实事故形态 ⇒ PASS 且 independentOk=true", () => {
  const b = mkBoard();
  const r = writeReview(b, "## 评审结论\n\n正文若干。\n\n## 总判：**PASS**\n\n理由：判据逐条成立。\n");
  assert.equal(r.conclusion, "PASS", "settleReview 必须解析出 PASS（修复前此处为 UNVERIFIED）");
  assert.equal(r.status, "completed");
  assert.equal(r.downgraded, false);

  const rec = readReviewRecord(b.root, b.goal, r.reviewId)!;
  assert.equal(rec.meta.conclusion, "PASS", "评审记录 frontmatter 必须记 PASS");
  const views = reviewRecordViews(b.root, b.goal);
  assert.equal(views.length, 1);
  assert.equal(views[0].conclusion, "PASS", "重放视图必须给出 PASS");
  assert.equal(views[0].stale, false, "唯一候选不得判为陈旧");
  assert.equal(views[0].independent, true, "真实 reviewer child ⇒ independent");

  const state = goalReviewState(b.root, b.goal, { policy: "auto" });
  assert.equal(state.status, "pass");
  assert.equal(state.independent_ok, true, "真实独立 PASS 必须在机器面成立（independentOk 不得被削弱）");
  assert.equal(state.independent_missing, false);
});

test("g-487 判据5：跨行形态（标签行 + 次行值）端到端记 PASS；BLOCK 记 BLOCK 且 independentOk=false", () => {
  const b = mkBoard();
  const pass = writeReview(b, "## 总判\n\n**PASS**\n");
  assert.equal(pass.conclusion, "PASS", "跨行形态（g-478 真实形态）必须记 PASS");
  assert.equal(goalReviewState(b.root, b.goal, { policy: "auto" }).independent_ok, true);

  const b2 = mkBoard();
  const block = writeReview(b2, "## 总判：BLOCK\n\n阻断项：见判据 3。\n");
  assert.equal(block.conclusion, "BLOCK");
  const state = goalReviewState(b2.root, b2.goal, { policy: "auto" });
  assert.equal(state.status, "block");
  assert.equal(state.independent_ok, false, "BLOCK 不得算作独立 PASS");
});

test("g-487 判据5：异常终止 / 空输出仍 fail-closed（正文有合规 PASS 行也不得记 PASS）", () => {
  const b = mkBoard();
  const aborted = writeReview(b, "## 总判：PASS\n", { stopReason: "aborted" });
  assert.equal(aborted.status, "failed");
  assert.equal(aborted.conclusion, "UNVERIFIED", "异常终止 ⇒ UNVERIFIED（PASS 被降级）");
  assert.equal(aborted.downgraded, true);
  assert.equal(readReviewRecord(b.root, b.goal, aborted.reviewId)!.meta.conclusion, "UNVERIFIED");
  assert.equal(goalReviewState(b.root, b.goal, { policy: "auto" }).independent_ok, false);

  const b2 = mkBoard();
  const empty = writeReview(b2, "");
  assert.equal(empty.status, "failed");
  assert.equal(empty.conclusion, "UNVERIFIED", "空输出 ⇒ UNVERIFIED");
  assert.equal(goalReviewState(b2.root, b2.goal, { policy: "auto" }).independent_ok, false);
});

// =====================================================================================
// 判据 3：误记回填 / 只读重算
// =====================================================================================

test("g-487 判据3：只读重算——历史误记（机器面 UNVERIFIED / 正文 PASS）可检出且零写入", () => {
  const b = mkBoard();
  const r = writeReview(b, "## 总判：**PASS**\n");
  simulateOldMisrecord(b, r.reviewId); // 与线上 g-479/g-480 完全同形

  // 前提：机器面（事件流重放）确实是 UNVERIFIED —— 这才是缺陷的真实后果
  assert.equal(reviewRecordViews(b.root, b.goal)[0].conclusion, "UNVERIFIED");
  assert.equal(goalReviewState(b.root, b.goal, { policy: "auto" }).independent_ok, false, "误记使真实独立 PASS 在机器面消失");

  const file = recordFile(b, r.reviewId);
  const before = readFileSync(file);
  const eventsBefore = readEvents(b.root).length;

  const items = reconcileReviewConclusions(b.root, { goalId: b.goal });
  assert.equal(items.length, 1, "每条已结算记录恰一条对账项");
  const it = items[0];
  assert.equal(it.review_id, r.reviewId);
  assert.equal(it.status, "completed");
  assert.equal(it.event_conclusion, "UNVERIFIED", "机器面现值如实报出（判定依据）");
  assert.equal(it.snapshot, "PASS", "快照现值一并报出（仅审计）");
  assert.equal(it.reparsed, "PASS", "按正文重算得到 PASS");
  assert.equal(it.changed, true, "只读模式须报出「将会回填」");
  assert.match(it.note, /只读重算/);
  assert.match(it.note, /UNVERIFIED → PASS/);

  assert.deepEqual(readFileSync(file), before, "只读重算必须零写入（文件逐字节不变）");
  assert.equal(readEvents(b.root).length, eventsBefore, "只读重算不得追加任何事件");
});

test("g-487 判据3：只改 .md 快照不足以修复机器面（判定必须以事件流为准）", () => {
  const b = mkBoard();
  const r = writeReview(b, "## 总判：**PASS**\n");
  simulateOldMisrecord(b, r.reviewId);
  // 手工把 frontmatter 快照改成 PASS（历史上就是这么对齐的）——机器面**不会**因此变正确
  forceSnapshotConclusion(b, r.reviewId, "PASS");
  assert.equal(
    reviewRecordViews(b.root, b.goal)[0].conclusion, "UNVERIFIED",
    "快照不是真相源：改快照不改变重放结论（这正是「手工回填仍误记」的成因）",
  );
  assert.equal(goalReviewState(b.root, b.goal, { policy: "auto" }).independent_ok, false);
  // 对账项仍报「将会回填」，方向以事件流为准
  const [it] = reconcileReviewConclusions(b.root, { goalId: b.goal });
  assert.equal(it.changed, true);
  assert.equal(it.snapshot, "PASS");
  assert.equal(it.event_conclusion, "UNVERIFIED");
});

test("g-487 判据3：幂等回填——机器面结论修复 + 事件留痕，评审正文逐字节不变，二次调用零变更", () => {
  const b = mkBoard();
  const body = "## 评审正文\n\n正文需逐字节保留：含 `代码`、表格与换行。\n\n## 总判：**PASS**\n\n理由：成立。\n";
  const r = writeReview(b, body);
  simulateOldMisrecord(b, r.reviewId);
  const file = recordFile(b, r.reviewId);
  const bodyBefore = parseDoc(readFileSync(file, "utf8")).body;

  const [applied] = reconcileReviewConclusions(b.root, { goalId: b.goal, apply: true, actor: "system:test-backfill" });
  assert.equal(applied.changed, true);
  assert.match(applied.note, /已回填 机器面 UNVERIFIED → PASS/);

  // ① 机器面真的被修复了（这是判据 3 要求的「不再误记」）
  assert.equal(reviewRecordViews(b.root, b.goal)[0].conclusion, "PASS", "回填后重放结论必须为 PASS");
  assert.equal(goalReviewState(b.root, b.goal, { policy: "auto" }).independent_ok, true, "回填后 independentOk 必须成立");

  // ② frontmatter 快照与事件流同口径
  const after = parseDoc(readFileSync(file, "utf8"));
  assert.equal(after.meta.conclusion, "PASS", "回填后快照必须是确定裁决");
  assert.equal(after.meta.conclusion_reconciled_from, "UNVERIFIED", "回填须记来源（可核对）");
  assert.equal(after.meta.conclusion_reconciled_by, "system:test-backfill");
  assert.equal(after.body, bodyBefore, "评审正文必须逐字节不变（不得改写正文）");

  // ③ 留痕：恰一条回填事件，含 from/to/正文字节数
  const evs = reconciledEvents(b.root, r.reviewId);
  assert.equal(evs.length, 1, "回填必须留痕（恰一条 review.conclusion_reconciled）");
  assert.equal(evs[0].details.from, "UNVERIFIED");
  assert.equal(evs[0].details.to, "PASS");
  assert.equal(evs[0].details.snapshot_before, "PASS");
  assert.equal(evs[0].details.body_bytes, Buffer.byteLength(bodyBefore, "utf8"), "事件须记正文字节数以佐证未改写");

  // ④ 幂等：二次调用零变更、零新增事件、文件逐字节不变
  const bytesAfterFirst = readFileSync(file);
  const eventsAfterFirst = readEvents(b.root).length;
  const [again] = reconcileReviewConclusions(b.root, { goalId: b.goal, apply: true, actor: "system:test-backfill" });
  assert.equal(again.changed, false, "重复回填必须幂等（changed=false）");
  assert.deepEqual(readFileSync(file), bytesAfterFirst, "幂等重跑不得改动文件");
  assert.equal(readEvents(b.root).length, eventsAfterFirst, "幂等重跑不得追加事件");
  assert.equal(reconciledEvents(b.root, r.reviewId).length, 1, "幂等重跑不得重复留痕");
});

test("g-487 判据3：回填方向 fail-closed——failed 不回填、无结论行不回填、反向不一致只报告不改写", () => {
  // ① failed 记录（正文有合规 PASS 行、机器面 UNVERIFIED）不得被回填为 PASS
  const b1 = mkBoard();
  const failed = writeReview(b1, "## 总判：PASS\n", { stopReason: "aborted" });
  const f1 = recordFile(b1, failed.reviewId);
  const bytes1 = readFileSync(f1);
  const events1 = readEvents(b1.root).length;
  const [i1] = reconcileReviewConclusions(b1.root, { goalId: b1.goal, apply: true });
  assert.equal(i1.status, "failed");
  assert.equal(i1.event_conclusion, "UNVERIFIED");
  assert.equal(i1.reparsed, "UNVERIFIED", "failed 记录不重算正文结论");
  assert.equal(i1.changed, false, "异常终止记录绝不回填（即便正文写着 PASS）");
  assert.match(i1.note, /fail-closed/);
  assert.deepEqual(readFileSync(f1), bytes1, "未回填 ⇒ 文件零写入");
  assert.equal(readEvents(b1.root).length, events1, "未回填 ⇒ 零事件");
  assert.equal(goalReviewState(b1.root, b1.goal, { policy: "auto" }).independent_ok, false, "异常终止绝不算独立 PASS");

  // ② 正文无可解析结论行 ⇒ 保持 UNVERIFIED
  const b2 = mkBoard();
  const prose = writeReview(b2, "我读了一遍，感觉没问题。\n");
  const [i2] = reconcileReviewConclusions(b2.root, { goalId: b2.goal, apply: true });
  assert.equal(i2.reparsed, "UNVERIFIED");
  assert.equal(i2.changed, false);
  assert.equal(reconciledEvents(b2.root, prose.reviewId).length, 0);

  // ③ 事件流已记确定裁决、与正文重算不一致 ⇒ 只报告不改写（不得反向覆盖既有裁决，更不得升格）
  const b3 = mkBoard();
  const guarded = writeReview(b3, "## 总判：PASS\n");
  rewriteBody(b3, guarded.reviewId, "## 总判：BLOCK\n"); // 结算后正文被改（事件流仍 PASS）
  const f3 = recordFile(b3, guarded.reviewId);
  const bytes3 = readFileSync(f3);
  const events3 = readEvents(b3.root).length;
  const [i3] = reconcileReviewConclusions(b3.root, { goalId: b3.goal, apply: true });
  assert.equal(i3.event_conclusion, "PASS");
  assert.equal(i3.reparsed, "BLOCK");
  assert.equal(i3.changed, false, "反向不一致不得改写");
  assert.match(i3.note, /只报告不改写/);
  assert.deepEqual(readFileSync(f3), bytes3);
  assert.equal(readEvents(b3.root).length, events3, "只报告 ⇒ 零事件");
  assert.equal(reviewRecordViews(b3.root, b3.goal)[0].conclusion, "PASS", "既有裁决不得被解析结果覆盖");

  // ④ 机器面已正确、仅快照不一致 ⇒ 只报告不改写（不留第二真源）
  const b4 = mkBoard();
  const aligned = writeReview(b4, "## 总判：PASS\n");
  forceSnapshotConclusion(b4, aligned.reviewId, "UNVERIFIED");
  const [i4] = reconcileReviewConclusions(b4.root, { goalId: b4.goal, apply: true });
  assert.equal(i4.changed, false);
  assert.equal(i4.event_conclusion, "PASS");
  assert.equal(i4.reparsed, "PASS");
  assert.match(i4.note, /机器面已正确/);
  assert.equal(reconciledEvents(b4.root, aligned.reviewId).length, 0);
  assert.equal(goalReviewState(b4.root, b4.goal, { policy: "auto" }).independent_ok, true, "机器面本来就正确");
});

test("g-487 判据3：graph_rebuild（rebuild）是显式回填入口——drift 点名 + 机器面修复 + 幂等", () => {
  const b = mkBoard();
  const r = writeReview(b, "## 总判\n\n**PASS**\n"); // g-478 的真实跨行形态
  simulateOldMisrecord(b, r.reviewId);
  assert.equal(goalReviewState(b.root, b.goal, { policy: "auto" }).independent_ok, false);

  const drift = rebuild(b.root);
  const mine = drift.filter((l) => l.includes("评审结论误记回填"));
  assert.equal(mine.length, 1, `rebuild 必须点名误记回填（drift 实得 ${JSON.stringify(drift)}）`);
  assert.match(mine[0], /机器面 UNVERIFIED → PASS/);
  assert.match(mine[0], /报告正文未改/);
  assert.equal(reviewRecordViews(b.root, b.goal)[0].conclusion, "PASS", "rebuild 后机器面结论翻正");
  assert.equal(goalReviewState(b.root, b.goal, { policy: "auto" }).independent_ok, true, "rebuild 后 independentOk 成立");
  assert.equal(reconciledEvents(b.root, r.reviewId).length, 1, "rebuild 留痕一条回填事件");

  // 幂等：再次 rebuild 不再产生本类 drift，也不重复留痕
  const again = rebuild(b.root);
  assert.equal(again.filter((l) => l.includes("评审结论误记回填")).length, 0, "第二次 rebuild 不得重复回填");
  assert.equal(reconciledEvents(b.root, r.reviewId).length, 1);
  // 干净目标：无误记时 rebuild 不产生任何本类 drift（不污染既有 rebuild 语义）
  const clean = mkBoard();
  writeReview(clean, "## 总判：PASS\n");
  assert.equal(rebuild(clean.root).filter((l) => l.includes("评审结论误记回填")).length, 0);
});

// =====================================================================================
// 判据 5/6：回归守卫（既有断言只增不减 + 闭集一致）
// =====================================================================================

test("g-487 判据6：既有 g-436 解析断言逐条重放（只增不减）", () => {
  // 逐字取自 g-436 既有套件，语义完全一致；本目标只**新增**可见性，不得改写既有判定。
  assert.equal(parseReviewConclusion("## 总判：PASS"), "PASS");
  assert.equal(parseReviewConclusion("**总判**：PASS"), "PASS");
  assert.equal(parseReviewConclusion("- Verdict: BLOCK"), "BLOCK");
  assert.equal(parseReviewConclusion("总判：UNVERIFIED"), "UNVERIFIED");
  assert.equal(parseReviewConclusion("我读了一遍，感觉没问题。"), "UNVERIFIED");
  assert.equal(parseReviewConclusion(""), "UNVERIFIED");
  assert.equal(parseReviewConclusion(null), "UNVERIFIED");
  assert.equal(parseReviewConclusion(undefined), "UNVERIFIED");
  assert.equal(parseReviewConclusion("总判：MAYBE"), "UNVERIFIED");
  for (const v of ["PASS", "BLOCK", "UNVERIFIED"] as const) {
    assert.equal(parseReviewConclusion(`## 总判：${v}`), v, `闭集内取值必须原样保留：${v}`);
  }
});

test("g-487 判据6：回填事件进入闭集与记录重放子集（写入侧 fail-closed 覆盖）", () => {
  const names = [...REVIEW_EVENT_NAMES];
  assert.deepEqual([...new Set(names)], names, "闭集不得有重复项");
  assert.ok(names.includes("review.conclusion_reconciled"), "回填事件必须在写入侧闭集内（否则 assertReviewEventName 抛错）");
  assert.ok(
    (REVIEW_RECORD_EVENT_NAMES as readonly string[]).includes("review.conclusion_reconciled"),
    "回填事件是**单条记录**语义 ⇒ 必须进入记录重放子集",
  );
  for (const n of REVIEW_RECORD_EVENT_NAMES) {
    assert.ok(names.includes(n), `记录子集事件 ${n} 必须属于闭集`);
  }
  assert.ok(!(REVIEW_RECORD_EVENT_NAMES as readonly string[]).includes("review.independent_missing"), "目标级标注不得进入记录子集");
  // 行为证明：回填事件确实参与重放（重放结论随之改变，而非只改快照）
  const b = mkBoard();
  const r = writeReview(b, "## 总判：PASS\n");
  simulateOldMisrecord(b, r.reviewId);
  assert.equal(reviewRecordViews(b.root, b.goal)[0].conclusion, "UNVERIFIED");
  reconcileReviewConclusions(b.root, { goalId: b.goal, apply: true });
  assert.equal(reviewRecordViews(b.root, b.goal)[0].conclusion, "PASS", "重放后的结论必须为 PASS（回填事件参与重放）");
});

test("g-487 判据6：回填只追加新事件，绝不改写历史 review.completed", () => {
  const b = mkBoard();
  const r = writeReview(b, "## 总判：**PASS**\n");
  const completed = reviewCompletedEvents(b.root, r.reviewId);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].details.conclusion, "PASS");
  simulateOldMisrecord(b, r.reviewId); // 追加一条 UNVERIFIED 的 completed（模拟旧解析器结算结果）
  const misrecorded = reviewCompletedEvents(b.root, r.reviewId);
  assert.equal(misrecorded.length, 2, "夹具追加了第二条 completed（历史误记由旧解析器写入）");
  const bytesBeforeBackfill = readEvents(b.root).map((e: any) => JSON.stringify(e));

  const [applied] = reconcileReviewConclusions(b.root, { goalId: b.goal, apply: true });
  assert.equal(applied.changed, true, "该形态必须真的回填（否则本守卫不覆盖回填路径）");

  const after = reviewCompletedEvents(b.root, r.reviewId);
  assert.equal(after.length, 2, "回填不得重复/删除 review.completed（事件流只追加）");
  assert.deepEqual(
    after.map((e: any) => JSON.stringify(e)), bytesBeforeBackfill.filter((l) => l.includes('"review.completed"')),
    "历史事件逐字节不变（不改写历史）",
  );
  assert.equal(reviewRecordViews(b.root, b.goal)[0].conclusion, "PASS", "回填事件后重放结论翻正");
  assert.equal(reconciledEvents(b.root, r.reviewId).length, 1, "回填动作本身留痕");
});
