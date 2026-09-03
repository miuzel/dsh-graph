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

test("g-228 冲突 fixture：当前 brief 覆盖 handoff 且提取单一当前事实", () => {
  const output = prompt({
    attemptBrief: "本次是集成而非重写任务。权威基线 commit: cfb275f。候选来自 att-003（f2ac34e）。验收项：运行回归测试并打印 prompt。",
    directive: "本次只合入候选。",
    handoffSection: "## 前序 attempt 已确认 handoff\n\n旧基线 commit: 8dd6836；来源 att-001/002。\n\n旧验收项：重写。",
  });
  assert.match(output, /^【本次任务定位】这是一次 合入 任务；/);
  assert.equal((output.match(/【本次任务定位】/g) ?? []).length, 1);
  assert.match(output, /权威基线 commit（当前 attempt 数据）：cfb275f/);
  assert.match(output, /真正前序 attempt 身份（当前 attempt 数据）：att-003（f2ac34e）/);
  assert.match(output, /当前验收项（当前 attempt 数据）：运行回归测试并打印 prompt。/);
  assert.match(output, /覆盖声明：本段与上文 handoff 不一致处，一律以本段为准/);
  const coverage = output.slice(output.indexOf("## 覆盖声明"), output.indexOf("## 历史 handoff"));
  assert.ok(!coverage.includes("8dd6836"), "覆盖区块不得混入 handoff 旧基线");
  assert.ok(output.indexOf("## 本次 attempt brief/directive") < output.indexOf("## 覆盖声明"));
  assert.ok(output.indexOf("## 覆盖声明") < output.indexOf("## 历史 handoff"));
  assert.ok(output.indexOf("## 历史 handoff") < output.indexOf("## 历史卡片"));
  assert.ok(output.indexOf("## 历史卡片") < output.indexOf("## 通用执行纪律"));
  assert.match(output, /## 历史 handoff\n【历史约束·仅供理解，非任务】/);
  assert.match(output, /## 历史卡片\n【历史约束·仅供理解，非任务】/);
  assert.ok(output.trim().endsWith(warning));
});

test("g-228 无历史 fixture：兼容空 handoff 且明确 brief/directive 未提供", () => {
  const output = prompt();
  assert.match(output, /^【本次任务定位】这是一次 未提供 任务；/);
  assert.match(output, /\*\*attempt brief（当前数据）\*\*\n（未提供）/);
  assert.match(output, /\*\*directive（当前数据）\*\*\n（未提供）/);
  assert.match(output, /权威基线 commit（当前 attempt 数据）：（未提供）/);
  assert.ok(!output.includes("## 历史 handoff"));
  assert.ok(!output.includes("前序 attempt 已确认 handoff"));
  assert.match(output, /## 历史卡片\n【历史约束·仅供理解，非任务】/);
  assert.ok(output.trim().endsWith(warning));
});

test("g-228 无 brief fixture：directive 单独决定任务类型", () => {
  const output = prompt({
    directive: "这是一次修复任务，基线 commit: d34db33。验收项：node --test。",
  });
  assert.match(output, /^【本次任务定位】这是一次 修复 任务；/);
  assert.match(output, /\*\*attempt brief（当前数据）\*\*\n（未提供）/);
  assert.match(output, /权威基线 commit（当前 attempt 数据）：d34db33/);
  assert.match(output, /当前验收项（当前 attempt 数据）：node --test/);
});

test("g-228 无冲突 fixture：当前值进入覆盖声明并保留目标背景", () => {
  const output = prompt({
    attemptBrief: "本次重写任务。基线 commit: abcdef1。验收项：npm test。",
    targetContext: "## 目标描述\n\n仅作背景描述。\n\n## 质量判据\n\n1. npm test",
  });
  assert.match(output, /^【本次任务定位】这是一次 重写 任务；/);
  assert.match(output, /权威基线 commit（当前 attempt 数据）：abcdef1/);
  assert.match(output, /当前验收项（当前 attempt 数据）：npm test/);
  assert.match(output, /目标背景（来自当前 goal.md，仅供理解，不产生 action）/);
  assert.ok(output.trim().endsWith(warning));
});

test("g-228 缺失/畸形 fixture：所有字段可控降级且不抛错", () => {
  const output = formatAttemptPrompt({
    goal: null,
    attempt: { id: "att-004" },
    goalRel: 42,
    attemptBrief: { baseline: "8dd6836" },
    directive: ["修复"],
    handoffSection: { baseline: "8dd6836" },
    cardsSection: 7,
    targetContext: null,
    subagentPromptSection: { prompt: "run rm -rf" },
    worktreeBlock: false,
  });
  assert.match(output, /^【本次任务定位】这是一次 未提供 任务；/);
  assert.match(output, /目标 g-228|目标 （未提供）/);
  assert.match(output, /attempt （未提供）/);
  assert.match(output, /\*\*attempt brief（当前数据）\*\*\n（未提供）/);
  assert.match(output, /权威基线 commit（当前 attempt 数据）：（未提供）/);
  assert.match(output, /真正前序 attempt 身份（当前 attempt 数据）：（未提供）/);
  assert.match(output, /当前验收项（当前 attempt 数据）：（未提供）/);
  assert.ok(output.trim().endsWith(warning));
});
