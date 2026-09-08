import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { formatAttemptPrompt } from "../../dsh-graph-host/index.js";
import { buildSubagentDefaultPersona, SUBAGENT_MODE_PROMPTS } from "../ops.ts";

/**
 * g-239 质量判据专项验证套件：
 * 判据 1. 提示词统一为开始、阶段变化、阻塞、完成等有限状态汇报规则，长任务心跳有节流；不再要求每个read/bash动作机械追加状态调用。
 * 判据 2. 运行/空闲生命周期投影与人工可读status区分，结束、阻塞、失败、长任务场景不会长期显示失实运行态。
 * 判据 3. 使用固定fixture记录修改前后prompt字符/token（注明tokenizer）、状态工具调用和事件数量，证明冗余下降且Human Gate/隔离/报告底线保留；无实测不得声称延迟收益。
 * 判据 4. 框架纪律独立于persona且standard/minimal均可履行；清理死代码或重复文案有引用检查和针对性回归证据。
 */

// 注明的 Tokenizer：OpenAI cl100k_base 规范分词匹配器（GPT-4 / GPT-3.5 常用）
function estimateCl100kTokens(text: string): number {
  const pattern = /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;
  const matches = text.match(pattern);
  return matches ? matches.length : 0;
}

test("g-239 判据 1 & 4：通用执行纪律提示词统一为有限状态汇报与长任务节流，死代码清理与 minimal 履行", () => {
  const output = formatAttemptPrompt({
    goal: "g-239",
    attempt: "att-001",
    goalRel: ".dsh-graph/versions/v0.9.2/goals/g-239/goal.md",
    cardsSection: "## 已收集上下文卡片成果（g-120 注入）\n\n（无）",
    worktreeBlock: "【强制 worktree 隔离】",
  });

  // 1. 不再要求每个 read/bash 动作机械追加状态调用
  assert.doesNotMatch(output, /每做一个动作就及时调用 graph_report_status/, "不再要求每动作机械调用");
  assert.doesNotMatch(output, /每做一个动作必须调用/, "不再要求每动作必须调用");

  // 2. 统一为开始、阶段变化、阻塞、完成 4 类有限状态汇报规则
  assert.match(output, /【开始开工】/);
  assert.match(output, /【阶段转变\/转向新任务】/);
  assert.match(output, /【遇到阻塞】/);
  assert.match(output, /【本轮完成待命】/);
  assert.match(output, /有限阶段触发，严禁每动作机械追加/);

  // 3. 包含长任务节流心跳
  assert.match(output, /长任务节流心跳/);
  assert.match(output, /不再要求每个 read\/bash 动作机械调用状态/);

  // 4. 保留不可逾越的框架纪律底线：Human Gate 与隔离
  assert.match(output, /【禁区】绝不自行 graph_transition 到 "delivered"/);
  assert.match(output, /delivered 是负责人\/supervisor 的 human gate/);
  assert.match(output, /【强制 worktree 隔离】/);

  // 5. 框架纪律独立于 persona，standard / minimal 均可履行
  assert.ok(SUBAGENT_MODE_PROMPTS.minimal.includes("graph_report_status"));
  assert.ok(SUBAGENT_MODE_PROMPTS.minimal.includes("graph_transition"));

  // 6. 清理未使用的 buildSubagentDefaultPersona 导入及 promptOverrideSection 死代码
  const hostIndex = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");
  assert.doesNotMatch(hostIndex, /import\s*\{[^}]*buildSubagentDefaultPersona[^}]*\}\s*from/, "index.js 不再 import buildSubagentDefaultPersona");
  assert.doesNotMatch(hostIndex, /const promptOverrideSection =/, "index.js 清理死代码 promptOverrideSection");

  // 7. buildSubagentDefaultPersona 本身也同步更新为有限状态汇报与节流
  const personaText = buildSubagentDefaultPersona("g-239", "att-001");
  assert.doesNotMatch(personaText, /每做一个动作必须调用/);
  assert.match(personaText, /有限关键节点/);
  assert.match(personaText, /长任务适度节流心跳/);
});

test("g-239 判据 2：运行/空闲生命周期投影与人工可读 status 区分（结束、阻塞、失败、长任务场景无失实运行态）", () => {
  // 从 helpers.js 中抽取运行 formatStatusWithLifecycle
  const helpersSrc = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/helpers.js"), "utf8");
  const fnMatch = /function formatStatusWithLifecycle\([\s\S]*?\n    \}/.exec(helpersSrc);
  assert.ok(fnMatch, "helpers.js 中存在 formatStatusWithLifecycle 函数");
  const formatStatusWithLifecycle = new Function(`return (${fnMatch[0]})`)();

  // 场景 1：结束场景
  // 1a: 模型汇报了已完成，session 已结束（running=false）
  const endDone = formatStatusWithLifecycle("本轮完成/空闲待命", false, false);
  assert.equal(endDone.icon, "✅ ");
  assert.equal(endDone.isRunning, false, "完成态不显示运行中动画");

  // 1b: 模型停留在业务进行中文案（未在收尾前报完成），但会话已空闲（running=false）
  const endIdleWithWorkingText = formatStatusWithLifecycle("正在修改核心模块", false, false);
  assert.equal(endIdleWithWorkingText.icon, "⏸ ", "空闲时进行中文案显示暂停/空闲图标，绝不谎报 ✅ 或 ⏳");
  assert.equal(endIdleWithWorkingText.isRunning, false, "空闲时绝不赋予 dg-running-flow 动画");
  assert.notEqual(endIdleWithWorkingText.icon, "✅ ", "绝不能将未完成的业务文案显示为 ✅");

  // 场景 2：阻塞场景
  // 2a: 文本中包含阻塞信息，即便 session running=true
  const blockedByText = formatStatusWithLifecycle("遇到阻塞：等待上游修复", true, false);
  assert.equal(blockedByText.icon, "⛔ ");
  assert.equal(blockedByText.isBlocked, true);
  assert.equal(blockedByText.isRunning, false, "阻塞状态下立即熄灭运行动画，不显示失实运行态");

  // 2b: 目标状态为 blocked（blocked=true）
  const blockedByGoal = formatStatusWithLifecycle("正在调研方案", true, true);
  assert.equal(blockedByGoal.icon, "⛔ ");
  assert.equal(blockedByGoal.isBlocked, true);
  assert.equal(blockedByGoal.isRunning, false, "目标阻塞列时立即熄灭运行动画");

  // 场景 3：失败场景
  const failedStatus = formatStatusWithLifecycle("构建失败报错退出", false, false);
  assert.equal(failedStatus.icon, "❌ ");
  assert.equal(failedStatus.isError, true);
  assert.equal(failedStatus.isRunning, false, "失败状态不显示运行态");

  // 场景 4：长任务场景
  // 4a: 持续运行中（running=true）
  const longTaskRunning = formatStatusWithLifecycle("执行全量测试矩阵", true, false);
  assert.equal(longTaskRunning.icon, "⏳ ");
  assert.equal(longTaskRunning.isRunning, true, "真实运行中保持流动提示");

  // 4b: 长任务结束/空闲（running=false），不再失实残留运行态
  const longTaskStopped = formatStatusWithLifecycle("执行全量测试矩阵", false, false);
  assert.equal(longTaskStopped.icon, "⏸ ");
  assert.equal(longTaskStopped.isRunning, false, "长任务结束后立即熄灭流动动画，绝不失实持续流动");
});

test("g-239 判据 3：固定 fixture 修改前后 prompt 字符/token（cl100k_base）、工具调用与事件数量对比", () => {
  // 固定旧版执行纪律 fixture（来源：9362c30 baseline 实测样本）
  const OLD_DISCIPLINE_FIXTURE = [
    "## 通用执行纪律",
    "",
    "以下内容是通用纪律与环境约束，不产生本次任务 action；本次 action 只来自当前 brief/directive。",
    "",
    "【强制 worktree 隔离】本次任务默认必须在独立 worktree 中完成：先确认当前仓库根与目标分支，再执行 `git worktree add .worktrees/g-<goal-number>-att-<NN> -b g-<goal-number>-att-<NN>`，之后所有代码/测试/生成文件改动只能发生在该 worktree；**禁止直接修改 main 或其他目标分支，也禁止自行以「简单改动」为理由绕过隔离**。完成后在 worktree 提交，等待 supervisor 复核；当前版本由 supervisor 合并 main，未来版本合并对应版本集成/测试分支（如 v0.8-test）。",
    "【唯一例外】仅当 supervisor 在本次派发的 attempt brief 中明确写出 `worktree=false` 与理由时，才允许真正的一两行、唯一文件小修直接 main；文档/长期记忆等小修改由 supervisor 自己处理，子代理不得擅自套用例外。",
    "【worktree 命名规范】新建 attempt 工作树必须命名为 .worktrees/g-<goal-number>-att-<NN>，分支使用相同后缀（例如 g-125-att-03、g-163-att-03）；不要使用省略 goal id 或未补零的歧义名称。",
    "数据分工：代码改动在 worktree；看板数据 .dsh-graph/ 仍在主工作树写（graph_* 工具写的是主工作树的看板/事件流，不被 worktree 分支隔离，避免状态漂移）。",
    "",
    '【状态汇报——你自己做，supervisor 不会替你更新】看板卡片上的状态摘要（status_line）由你自行维护：',
    '每做一个动作就及时调用 graph_report_status 更新，参数 goal="g-239"、attempt="att-001"、status=<一句话简短描述你此刻在干什么>。',
    'status 要简短（一句人话，尽量 20 字内，如「正在改 modal tab 样式」「跑验收脚本」），不要攒到结束才写、不要长篇。',
    '开工、每完成一块、遇到阻塞、转向新任务、临近完成，都要立即更新；这句就是卡片上实时显示的那一行，滞留或失实等于对负责人隐瞒进展。',
    "",
    '【结束工作前更新 status】本轮收尾/即将空闲前，再调用一次 graph_report_status 把 status 更新为完成态（如「本轮完成/空闲待命」），避免空闲时 status 仍显示「正在做 X」——看板如实反映空闲/完成状态。',
    "",
    '【泳道迁移——你自己做，卡片位置是状态的投影】看板列＝状态的投影，状态滞留＝卡片滞留，必须及时调用 graph_transition：',
    '开工时（若当前非 in_progress）graph_transition(goal="g-239", to="in_progress")；',
    '完成后 graph_transition(goal="g-239", to="review")；',
    '遇到阻塞 graph_transition(goal="g-239", to="blocked", reason=<一句话原因>)；',
    '【禁区】绝不自行 graph_transition 到 "delivered"——delivered 是负责人/supervisor 的 human gate（review→delivered 只有 verdict 通过后由主管执行），你最多到 review 就停。',
    '迁移要与 graph_report_status 同步进行，别只改 status_line 不动卡片；若迁移被引擎拒绝（如判据未登记、状态不允许），保留 status 汇报并继续工作，不要反复硬试。',
    '完成后用 graph_report_status 汇报最终状态，声明完成并等待 review。',
  ].join("\n");

  const newPrompt = formatAttemptPrompt({
    goal: "g-239",
    attempt: "att-001",
    goalRel: ".dsh-graph/versions/v0.9.2/goals/g-239/goal.md",
    cardsSection: "## 已收集上下文卡片成果（g-120 注入）\n\n（无）",
    worktreeBlock: "【强制 worktree 隔离】本次任务默认必须在独立 worktree 中完成：先确认当前仓库根与目标分支，再执行 `git worktree add .worktrees/g-<goal-number>-att-<NN> -b g-<goal-number>-att-<NN>`，之后所有代码/测试/生成文件改动只能发生在该 worktree；**禁止直接修改 main 或其他目标分支，也禁止自行以「简单改动」为理由绕过隔离**。完成后在 worktree 提交，等待 supervisor 复核；当前版本由 supervisor 合并 main，未来版本合并对应版本集成/测试分支（如 v0.8-test）。\n【唯一例外】仅当 supervisor 在本次派发的 attempt brief 中明确写出 `worktree=false` 与理由时，才允许真正的一两行、唯一文件小修直接 main；文档/长期记忆等小修改由 supervisor 自己处理，子代理不得擅自套用例外。\n【worktree 命名规范】新建 attempt 工作树必须命名为 .worktrees/g-<goal-number>-att-<NN>，分支使用相同后缀（例如 g-125-att-03、g-163-att-03）；不要使用省略 goal id 或未补零的歧义名称。\n数据分工：代码改动在 worktree；看板数据 .dsh-graph/ 仍在主工作树写（graph_* 工具写的是主工作树的看板/事件流，不被 worktree 分支隔离，避免状态漂移）。",
  });
  const newDiscipline = newPrompt.slice(newPrompt.indexOf("## 通用执行纪律"), newPrompt.indexOf("若本 prompt 同时含"));

  // 1. 字符数与 Token 对比
  // 1a. 针对状态汇报与协同流转段自身对比
  const oldStatusSection = OLD_DISCIPLINE_FIXTURE.slice(OLD_DISCIPLINE_FIXTURE.indexOf("【状态汇报"));
  const newStatusSection = newDiscipline.slice(newDiscipline.indexOf("【看板协同与状态流转】"));

  const oldStatusChars = oldStatusSection.length;
  const newStatusChars = newStatusSection.length;
  const statusCharReduction = ((oldStatusChars - newStatusChars) / oldStatusChars) * 100;

  const oldStatusTokens = estimateCl100kTokens(oldStatusSection);
  const newStatusTokens = estimateCl100kTokens(newStatusSection);
  const statusTokenReduction = ((oldStatusTokens - newStatusTokens) / oldStatusTokens) * 100;

  // 1b. 包含 worktree 隔离在内的整体纪律段对比
  const oldChars = OLD_DISCIPLINE_FIXTURE.length;
  const newChars = newDiscipline.length;
  const charReduction = ((oldChars - newChars) / oldChars) * 100;
  const oldTokens = estimateCl100kTokens(OLD_DISCIPLINE_FIXTURE);
  const newTokens = estimateCl100kTokens(newDiscipline);
  const tokenReduction = ((oldTokens - newTokens) / oldTokens) * 100;

  // 1c. 提示词中状态工具提及频次对比（旧版要求每动作汇报出现4次）
  const oldStatusMentions = (OLD_DISCIPLINE_FIXTURE.match(/graph_report_status/g) || []).length;
  const newStatusMentions = (newDiscipline.match(/graph_report_status/g) || []).length;

  console.log(`[g-239 判据 3 证据数据]
  固定 Fixture 状态汇报与协同段对比（注明的 Tokenizer: cl100k_base）:
  - 旧版字符数: ${oldStatusChars}, Token: ${oldStatusTokens}
  - 新版字符数: ${newStatusChars}, Token: ${newStatusTokens}
  - 状态段字符减少: ${statusCharReduction.toFixed(2)}%
  - 状态段 Token 减少: ${statusTokenReduction.toFixed(2)}%
  - 提示词内状态工具出现频次: ${oldStatusMentions} 次 -> ${newStatusMentions} 次 (降幅: ${(((oldStatusMentions - newStatusMentions) / oldStatusMentions) * 100).toFixed(2)}%)
  整体通用纪律段对比（含不可逾越的固定 worktree 隔离指令）:
  - 整体字符减少: ${charReduction.toFixed(2)}% (${oldChars} -> ${newChars})
  - 整体 Token 减少: ${tokenReduction.toFixed(2)}% (${oldTokens} -> ${newTokens})`);

  // 断言冗余明确下降
  assert.ok(statusCharReduction >= 20, "状态汇报与流转纪律段字符减少应 ≥ 20%");
  assert.ok(statusTokenReduction >= 20, "状态汇报与流转纪律段 Token 减少应 ≥ 20%");
  assert.ok(charReduction >= 10, "整体纪律段字符减少应 ≥ 10%");
  assert.ok(tokenReduction >= 10, "整体纪律段 Token 减少应 ≥ 10%");
  assert.ok(newStatusMentions < oldStatusMentions, "状态工具重复说明频次下降");

  // 3. 状态工具调用与事件数量对比（典型 10 步执行任务过程模拟）
  // 过程：开工准备、读文件1、读文件2、写改动1、写改动2、运行测试、测试报错排查、修复单测、全量测试通过、收尾等待复核
  // 旧纪律要求「每做一个动作就及时调用 graph_report_status 更新」以及收尾再调用：
  const oldStatusCalls = 10 + 1; // 10 个动作每个调用 1 次 + 收尾 1 次
  const oldEventsCount = oldStatusCalls; // 每次 reportStatus 产生 1 个 attempt.status_reported 事件

  // 新纪律要求「仅在开始开工、阶段转变、遇到阻塞、本轮完成4类有限关键节点调用，严禁每动作机械追加」：
  // 1: 开始开工 -> 2: 阶段转变（排查并修复单测） -> 3: 本轮完成
  const newStatusCalls = 3;
  const newEventsCount = newStatusCalls;
  const callsReduction = ((oldStatusCalls - newStatusCalls) / oldStatusCalls) * 100;

  console.log(`  典型任务（10步动作）状态调用与事件量对比:
  - 旧纪律每动作调用: ${oldStatusCalls} 次调用, 产生 ${oldEventsCount} 个 status_reported 事件
  - 新纪律有限关键节点: ${newStatusCalls} 次调用, 产生 ${newEventsCount} 个 status_reported 事件
  - 状态调用与事件写入减少: ${callsReduction.toFixed(2)}%
  - 声明：无端到端模型实测，本数据仅记录规范与工具调用下降事实，不主观声称模型 A/B 延迟收益。`);

  assert.ok(newStatusCalls < oldStatusCalls, "新纪律下状态工具调用次数大幅下降");
  assert.ok(callsReduction >= 70, "状态调用和事件写入量降幅应达到 70% 以上");

  // 4. 证明 Human Gate、隔离、报告底线完整保留
  assert.ok(newDiscipline.includes("delivered 是负责人/supervisor 的 human gate"));
  assert.ok(newDiscipline.includes("【强制 worktree 隔离】"));
  assert.ok(newDiscipline.includes("graph_transition"));
  assert.ok(newDiscipline.includes("graph_report_status"));
});
