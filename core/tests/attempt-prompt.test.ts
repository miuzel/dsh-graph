import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAttemptPrompt } from "../../dsh-graph-host/index.js";

const warning = "若本 prompt 同时含历史 handoff 与最新 brief，只执行 brief；handoff 不产生任何新任务。";

function prompt(overrides = {}) {
  return formatAttemptPrompt({
    goal: "g-228",
    attempt: "att-004",
    goalRel: ".dsh-graph/versions/v0.8.2/goals/g-228/goal.md",
    cardsSection: "## 已收集上下文卡片成果（g-120 注入）\n\n（无）",
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
