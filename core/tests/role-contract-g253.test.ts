import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROLE_PROFILES,
  getRoleProfile,
  toolFilterForRole,
  buildSubagentDefaultPersona,
  formatReviewPrompt,
  GRAPH_MINIMAL_ALLOWED_TOOLS,
} from "../ops.ts";
import { formatAttemptPrompt, resolveWorktreeGuide } from "../../dsh-graph-host/index.js";

// ===== g-253 质量判据专项验证套件 =====
// 判据 1. 纪律文本单一真源：ROLE_PROFILES.disciplineLines 与 host formatAttemptDiscipline、buildSubagentDefaultPersona
//         的状态汇报口径一致（有限关键节点+节流），不得残留“每做一个动作”旧文案；新增纪律副本需有引用检查测试。
// 判据 2. 清理 dsh-graph-host/index.js 未使用导入（formatTargetContext、getRoleProfile、formatReviewPrompt、SUBAGENT_ROLES）
//         或明确接线使用，避免再次引入死代码。
// 判据 3. executor 执行派发使用 toolFilterForRole("executor", mode)（或明确记录保持 mode 过滤的理由），
//         角色能力与 prompt 要求保持统一映射测试。
// 判据 4. 角色纪律在 persona 切换与 standard/minimal 下不丢失 Human Gate 与隔离底线；
//         与 g-248 reviewer 派发接线边界清晰、不重复实现。

test("g-253 判据 1：纪律文本单一真源——ROLE_PROFILES 消除'每动作'旧文案，与 host 及 persona 单源一致", () => {
  const supervisorProfile = getRoleProfile("supervisor");
  const executorProfile = getRoleProfile("executor");

  // 1. supervisor 纪律消除“每次动作后”，更新为阶段变化与关键节点自报进展，无需机械汇报
  for (const line of supervisorProfile.disciplineLines) {
    assert.doesNotMatch(line, /每次动作后调用/, "supervisor 纪律不得残留'每次动作后调用'旧文案");
    assert.doesNotMatch(line, /每做一个动作/, "supervisor 纪律不得残留'每做一个动作'旧文案");
  }
  const supLine3 = supervisorProfile.disciplineLines[2];
  assert.match(supLine3, /阶段变化与关键节点自报进展/);
  assert.match(supLine3, /graph_report_supervisor_status/);
  assert.match(supLine3, /无需机械汇报/);

  // 2. executor 纪律消除“每做一个动作必须调用”，更新为有限关键节点+长任务适度节流
  for (const line of executorProfile.disciplineLines) {
    assert.doesNotMatch(line, /每做一个动作必须调用/, "executor 纪律不得残留'每做一个动作必须调用'旧文案");
    assert.doesNotMatch(line, /每做一个动作/, "executor 纪律不得残留'每做一个动作'旧文案");
    assert.doesNotMatch(line, /每次动作后/, "executor 纪律不得残留'每次动作后'旧文案");
  }
  const execLine1 = executorProfile.disciplineLines[0];
  assert.match(execLine1, /有限关键节点/);
  assert.match(execLine1, /长任务适度节流心跳/);
  assert.match(execLine1, /严禁每个动作机械追加汇报/);

  // 3. 单一真源：buildSubagentDefaultPersona 直接展开 ROLE_PROFILES.executor.disciplineLines
  const personaText = buildSubagentDefaultPersona("g-253", "att-001");
  for (const disciplineLine of executorProfile.disciplineLines) {
    assert.ok(
      personaText.includes(disciplineLine),
      `buildSubagentDefaultPersona 必须包含 executor 纪律单源行: "${disciplineLine}"`,
    );
  }

  // 4. formatAttemptPrompt 渲染的执行纪律与 ROLE_PROFILES 保持一致口径
  const promptOutput = formatAttemptPrompt({
    goal: "g-253",
    attempt: "att-001",
    goalRel: ".dsh-graph/versions/v0.10.0/goals/g-253/goal.md",
  });
  assert.doesNotMatch(promptOutput, /每做一个动作/);
  assert.doesNotMatch(promptOutput, /每次动作后/);
  assert.match(promptOutput, /有限阶段触发，严禁每动作机械追加/);
  assert.match(promptOutput, /长任务节流心跳/);

  // 5. 引用检查测试（防回归）：扫描核心代码与提示词文件，确保无旧文案残留
  const filesToCheck = [
    join(import.meta.dirname, "../ops.ts"),
    join(import.meta.dirname, "../../dsh-graph-host/prompts/discipline.zh.md"),
    join(import.meta.dirname, "../../dsh-graph-host/prompts/discipline.en.md"),
    join(import.meta.dirname, "../../dsh-graph-host/supervisor-guide.zh.md"),
    join(import.meta.dirname, "../../docs/guide-auto-injection.md"),
  ];
  for (const filePath of filesToCheck) {
    const content = readFileSync(filePath, "utf8");
    assert.doesNotMatch(content, /每做一个动作必须调用/, `${filePath} 中不得残留“每做一个动作必须调用”`);
    assert.doesNotMatch(content, /每次动作后调用 graph_report_supervisor_status/, `${filePath} 中不得残留“每次动作后调用”`);
    assert.doesNotMatch(content, /每动作后 graph_report_supervisor_status/, `${filePath} 中不得残留“每动作后”`);
  }
});

test("g-253 判据 2：清理 dsh-graph-host/index.js 未使用导入与死代码", () => {
  const hostIndex = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");

  // 1. 确认 4 个死导入已被彻底移除
  assert.doesNotMatch(hostIndex, /\bformatTargetContext\b/, "formatTargetContext 死导入已清理");
  assert.doesNotMatch(hostIndex, /\bgetRoleProfile\b/, "getRoleProfile 死导入已清理");
  assert.doesNotMatch(hostIndex, /\bformatReviewPrompt\b/, "formatReviewPrompt 死导入已清理（接线归 g-248）");
  assert.doesNotMatch(hostIndex, /\bSUBAGENT_ROLES\b/, "SUBAGENT_ROLES 死导入已清理");

  // 2. toolFilterForMode 也已因接线 toolFilterForRole 而不再被 index.js 导入
  assert.doesNotMatch(hostIndex, /\btoolFilterForMode\b/, "toolFilterForMode 已由 toolFilterForRole 取代并清理导入");

  // 3. 验证当前从 ./core/ops.js 导入的所有符号，被清理后无孤立导入
  const cleanedDeadImports = ["formatTargetContext", "getRoleProfile", "formatReviewPrompt", "SUBAGENT_ROLES", "toolFilterForMode"];
  for (const name of cleanedDeadImports) {
    assert.equal(hostIndex.includes(` ${name},`) || hostIndex.includes(` ${name} `), false, `${name} 不得出现在 import 列表中`);
  }
});

test("g-253 判据 3：executor 执行派发接线 toolFilterForRole('executor', mode) 及统一映射测试", () => {
  const hostIndex = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");

  // 1. dispatchAttempt 中使用 toolFilterForRole("executor", effModeRes.mode)
  assert.match(
    hostIndex,
    /toolFilterForRole\(\s*["']executor["']\s*,\s*effModeRes\.mode\s*\)/,
    "dispatchAttempt 必须使用 toolFilterForRole('executor', effModeRes.mode)",
  );
  assert.doesNotMatch(
    hostIndex,
    /toolFilterForMode\(\s*effModeRes\.mode\s*\)/,
    "dispatchAttempt 不再直接使用 toolFilterForMode",
  );

  // 2. 行为契约：standard 模式返回 undefined（全量工具可见）
  const standardFilter = toolFilterForRole("executor", "standard");
  assert.equal(standardFilter, undefined, "executor standard 模式工具过滤为 undefined（全量）");

  // 3. 行为契约：minimal 模式返回 GRAPH_MINIMAL_ALLOWED_TOOLS（受控 6 工具）
  const minimalFilter = toolFilterForRole("executor", "minimal");
  assert.deepEqual(
    minimalFilter?.allow,
    GRAPH_MINIMAL_ALLOWED_TOOLS,
    "executor minimal 模式工具过滤为受控 6 工具",
  );

  // 4. 容错契约：mode 为 null / undefined / 空串时规范化回退 standard
  assert.equal(toolFilterForRole("executor", null), undefined);
  assert.equal(toolFilterForRole("executor", undefined), undefined);

  // 5. 统一映射：executor 所要求的工具在 standard 与 minimal 下均可访问
  const profile = getRoleProfile("executor");
  for (const reqTool of profile.requiredTools) {
    assert.ok(
      minimalFilter?.allow?.includes(reqTool),
      `executor 核心协同工具 ${reqTool} 在 minimal 模式下必须可见`,
    );
  }
});

test("g-253 判据 4：角色纪律在 persona 切换与 standard/minimal 下不丢失 Human Gate 与隔离底线，与 g-248 边界清晰", () => {
  // 1. 底线契约：ROLE_PROFILES.executor.disciplineLines 包含 Human Gate 与隔离要求
  const executorProfile = getRoleProfile("executor");
  assert.ok(
    executorProfile.disciplineLines.some((l) => l.includes("绝不自行 delivered")),
    "executor 纪律必须包含 Human Gate: 绝不自行 delivered",
  );
  assert.ok(
    executorProfile.disciplineLines.some((l) => l.includes("严格遵守环境隔离要求")),
    "executor 纪律必须包含隔离底线",
  );

  // 2. Persona 切换时：buildSubagentDefaultPersona 继承同样底线
  const persona = buildSubagentDefaultPersona("g-253", "att-001");
  assert.match(persona, /绝不自行 delivered/);
  assert.match(persona, /严格遵守环境隔离要求/);

  // 3. Prompt 模板层底线：无论子代理为何种 persona，formatAttemptPrompt 均无条件注入通用纪律与隔离说明
  const prompt = formatAttemptPrompt({
    goal: "g-253",
    attempt: "att-001",
    goalRel: ".dsh-graph/versions/v0.10.0/goals/g-253/goal.md",
    worktreeBlock: resolveWorktreeGuide("task"),
  });
  assert.match(prompt, /【强制 worktree 隔离】/);
  assert.match(prompt, /【禁区】绝不自行 graph_transition 到 "delivered"/);

  // 4. minimal 模式支持：受控 6 工具覆盖了看板流转与状态汇报底线
  const minimalFilter = toolFilterForRole("executor", "minimal");
  assert.ok(minimalFilter?.allow?.includes("graph_report_status"));
  assert.ok(minimalFilter?.allow?.includes("graph_transition"));

  // 5. g-248 reviewer 边界清晰：formatReviewPrompt 在 core 中定义并导出供 g-248 接线，但 host 未提前耦合
  assert.equal(typeof formatReviewPrompt, "function", "formatReviewPrompt 仍由 core 导出");
  const hostIndex = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");
  assert.equal(hostIndex.includes("formatReviewPrompt"), false, "host 未提前接入 formatReviewPrompt（由 g-248 承接）");
});
