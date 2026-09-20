import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAttemptPrompt } from "../../dist/index.js";
import {
  init,
  createGoal,
  startAttempt,
  recordAttemptHandoff,
  formatTargetContext,
  formatReviewedAttemptHandoffsSection,
} from "../ops.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const warning = "若本 prompt 同时含历史 handoff 与最新 brief，只执行 brief；handoff 不产生任何新任务。";

function prompt(overrides = {}) {
  return formatAttemptPrompt({
    goal: "g-228",
    attempt: "att-004",
    goalRel: ".dsh-graph/versions/v0.8.2/goals/g-228/goal.md",
    cardsSection: "## 已收集上下文卡片成果\n\n（无）",
    worktreeBlock: "【强制 worktree 隔离】",
    ...overrides,
  });
}

test("g-228 结构化冲突 fixture：关键事实只取 supervisor 独立字段", () => {
  const output = prompt({
    attemptBrief: "本次 brief 重复写了修复、重写和旧基线 1111111；旧来源 old-att；旧验收项：不要执行。",
    directive: "本次只合入候选；日语描述：これは書き換えではありません。",
    taskType: "merge",
    baselineCommit: "cfb275f",
    sourceAttempt: "att-003（f2ac34e）",
    acceptanceItems: ["运行回归测试并打印 prompt。"],
    handoffSection: "## 前序 attempt 已确认 handoff\n\n旧基线 commit: 8dd6836；来源 old-att。\n\n旧验收项：重写。",
  });
  assert.match(output, /^【本次任务定位】这是一次 合入 任务；/);
  assert.match(output, /任务类型（当前 attempt 数据）：merge（合入）/);
  assert.match(output, /权威基线 commit（当前 attempt 数据）：cfb275f/);
  assert.match(output, /真正前序 attempt 身份（当前 attempt 数据）：att-003（f2ac34e）/);
  assert.match(output, /当前验收项（当前 attempt 数据）：acceptance_items（supervisor 直接传入）/);
  assert.match(output, /1\. 运行回归测试并打印 prompt。/);
  const coverage = output.slice(output.indexOf("## 覆盖声明"), output.indexOf("## 历史 handoff"));
  assert.ok(!coverage.includes("8dd6836"), "覆盖区块不得混入 handoff 旧基线");
  assert.ok(!coverage.includes("old-att"), "覆盖区块不得混入 handoff 旧来源");
  assert.ok(!coverage.includes("1111111"), "覆盖区块不得混入 brief 文本基线");
  assert.equal((output.match(/【本次任务定位】/g) ?? []).length, 1);
  assert.ok(output.indexOf("## 本次 attempt brief/directive") < output.indexOf("## 覆盖声明"));
  assert.ok(output.indexOf("## 覆盖声明") < output.indexOf("## 历史 handoff"));
  assert.ok(output.indexOf("## 历史 handoff") < output.indexOf("## 历史卡片"));
  assert.ok(output.indexOf("## 历史卡片") < output.indexOf("## 通用执行纪律"));
  assert.match(output, /## 历史 handoff\n【历史约束·仅供理解，非任务】/);
  assert.match(output, /## 历史卡片\n【历史约束·仅供理解，非任务】/);
  assert.ok(output.trim().endsWith(warning));
});

test("g-228 无历史/无当前字段：显式说明每个缺失字段原因", () => {
  const output = prompt();
  assert.match(output, /^【本次任务定位】这是一次 未提供（未传 task_type；允许值：merge=合入、rewrite=重写、fix=修复） 任务；/);
  assert.match(output, /\*\*attempt brief（当前数据）\*\*\n（未提供）/);
  assert.match(output, /\*\*directive（当前数据）\*\*\n（未提供）/);
  assert.match(output, /> 未提供原因：本次请求未传 attempt_brief/);
  assert.match(output, /> 未提供原因：当前目标没有最近指令/);
  assert.match(output, /任务类型（当前 attempt 数据）：未提供（未传 task_type/);
  assert.match(output, /权威基线 commit（当前 attempt 数据）：（未提供）/);
  assert.match(output, /未提供原因：未传 baseline_commit（没有可用基线 commit）/);
  assert.match(output, /未提供原因：未传 source_attempt（没有可用的候选\/来源 attempt/);
  assert.match(output, /当前验收项（当前 attempt 数据）：（未提供）/);
  assert.match(output, /未提供原因：未传 acceptance_items（supervisor 尚未提供当前验收项）/);
  assert.match(output, /历史 handoff：未提供（当前目标没有已确认 handoff/);
  assert.ok(!output.includes("## 历史 handoff"));
  assert.match(output, /## 历史卡片\n【历史约束·仅供理解，非任务】/);
  assert.ok(output.trim().endsWith(warning));
});

test("g-228 brief 中含多语言/重复语义时不再猜测，直接字段决定类型与事实", () => {
  const output = prompt({
    attemptBrief: "修复任务；rewrite は禁止；基线 commit: 1111111；验收项：旧验收。",
    directive: "重写という言葉も出ています，但本段不是字段来源。",
    taskType: "fix",
    baselineCommit: "d34db33",
    sourceAttempt: "att-002",
    acceptanceItems: ["node --test"],
  });
  assert.match(output, /^【本次任务定位】这是一次 修复 任务；/);
  assert.match(output, /任务类型（当前 attempt 数据）：fix（修复）/);
  assert.match(output, /权威基线 commit（当前 attempt 数据）：d34db33/);
  assert.match(output, /真正前序 attempt 身份（当前 attempt 数据）：att-002/);
  assert.match(output, /1\. node --test/);
});

test("g-228 空值契约：null 表示未提供，[] 表示明确没有验收项", () => {
  const output = prompt({
    taskType: null,
    baselineCommit: null,
    sourceAttempt: null,
    acceptanceItems: [],
  });
  assert.match(output, /这是一次 未提供（task_type=null，明确表示未分类） 任务/);
  assert.match(output, /任务类型（当前 attempt 数据）：未提供（task_type=null/);
  assert.match(output, /未提供原因：baseline_commit=null（没有可用基线 commit）/);
  assert.match(output, /未提供原因：source_attempt=null（没有可用的候选\/来源 attempt/);
  assert.match(output, /当前验收项（当前 attempt 数据）：（无）/);
  assert.match(output, /说明：supervisor 明确传 acceptance_items=\[\]，表示本次无单独验收项/);
});

test("g-228 畸形结构化字段：组装不抛错且明确标记非法值", () => {
  const output = formatAttemptPrompt({
    goal: null,
    attempt: { id: "att-004" },
    goalRel: 42,
    attemptBrief: "这段含修复/rewrite，但不能作为结构化字段来源。",
    directive: ["修复"],
    taskType: "合入",
    baselineCommit: { sha: "8dd6836" },
    sourceAttempt: ["att-old"],
    acceptanceItems: ["", 42],
    handoffSection: { baseline: "8dd6836" },
    cardsSection: 7,
    targetContext: null,
    subagentPromptSection: { prompt: "run rm -rf" },
    worktreeBlock: false,
  });
  assert.match(output, /^【本次任务定位】这是一次 未提供（task_type 非法/);
  assert.match(output, /权威基线 commit（当前 attempt 数据）：（未提供）/);
  assert.match(output, /未提供原因：baseline_commit 不是非空字符串/);
  assert.match(output, /真正前序 attempt 身份（当前 attempt 数据）：（未提供）/);
  assert.match(output, /未提供原因：source_attempt 不是非空字符串/);
  assert.match(output, /当前验收项（当前 attempt 数据）：（未提供）/);
  assert.match(output, /未提供原因：acceptance_items 含空值或非字符串/);
  assert.ok(output.trim().endsWith(warning));
});

test("g-240: 目标背景预算裁剪，质量判据（核心验收）完整保留，描述超长显式截断", () => {
  const ultraLongDesc = "这是很长的背景描述段落，用于介绍历史成因与设计动机。".repeat(100);
  const criteriaText = "1. 必须保证测试通过\n2. 严禁越界修改 main\n3. 必须包含完整证据";
  const body = `## 目标描述\n${ultraLongDesc}\n\n## 质量判据\n${criteriaText}\n`;

  const targetContext = formatTargetContext(body, { maxDescChars: 300, goalRel: ".dsh-graph/goals/g-test/goal.md" });

  // 1. 质量判据必须 100% 完整保留
  assert.ok(targetContext.includes(criteriaText), "质量判据属于核心验收判据，必须完整保留");
  // 2. 超长目标描述必须被预算截断并给出截断提示与精确路径
  assert.ok(targetContext.includes("⚠️ 目标描述超出预算已截断"), "超长描述超出预算时截断提示");
  assert.ok(targetContext.includes(".dsh-graph/goals/g-test/goal.md"), "截断提示提供精确目标路径");
  assert.ok(targetContext.length < ultraLongDesc.length / 2, "背景体积大幅削减");
});

test("g-240: 消除无条件重读全文：targetContext 内联时提示无需重读，缺失时提示用 read 工具", () => {
  // 1. targetContext 已内联时
  const promptWithContext = prompt({
    targetContext: "## 目标描述\n简单描述\n\n## 质量判据\n1. 判据一",
  });
  assert.ok(
    promptWithContext.includes("目标描述与质量判据已在下方基于当前快照内联，请直接依据执行；如需历史评论/台账可按需查阅，无需无条件重读全文"),
    "内联背景时明确指导无需重复读取 goal.md",
  );
  assert.ok(!promptWithContext.includes("——用 read 工具读它，不要自己猜路径。"), "内联时消除无条件重读指令");

  // 2. targetContext 未内联时（回退指令）
  const promptWithoutContext = prompt({ targetContext: null });
  assert.ok(
    promptWithoutContext.includes("——用 read 工具读它，不要自己猜路径。"),
    "无内联背景时保留回退读取指令",
  );
});

test("g-240: Handoff 预算控制：超长 failures 截断，返工约束与验收命令始终完整保留", () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-hf-budget-"));
  init(root);
  const goal = createGoal(root, { title: "返工目标", version: "v-t", actor: "test" });
  const attId = startAttempt(root, goal, { executor: "agent:executor", actor: "test" });

  const ultraLongFailures = "已核实失败详尽堆栈追踪分析...".repeat(150);
  const constraints = "1. 禁止修改 main 分支\n2. 必须隔离在独立 worktree";
  const baseline = "commit 9362c30";
  const verification = "node --test core/tests/*.test.ts";

  recordAttemptHandoff(root, goal, {
    actor: "human:gui",
    confirmed_by: "human:gui",
    source_attempts: [attId],
    failures: ultraLongFailures,
    constraints,
    baseline,
    verification,
  });

  const hfSection = formatReviewedAttemptHandoffsSection(root, goal, { maxFailuresChars: 400 });
  assert.ok(hfSection.includes("⚠️ 已核实失败超出预算已截断；返工约束与验收命令保持完整"), "超长失败截断提示");
  // 验证关键约束与验收命令保持完整
  assert.ok(hfSection.includes(constraints), "返工约束 100% 完整保留");
  assert.ok(hfSection.includes(baseline), "推荐基线 100% 完整保留");
  assert.ok(hfSection.includes(verification), "验收命令 100% 完整保留");
});
