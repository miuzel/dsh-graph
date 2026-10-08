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
import { formatAttemptPrompt, resolveWorktreeGuide } from "../../dist/index.js";

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
    join(import.meta.dirname, "../../dist/prompts/discipline.zh.md"),
    join(import.meta.dirname, "../../dist/prompts/discipline.en.md"),
    join(import.meta.dirname, "../../dist/supervisor-guide.zh.md"),
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
  const hostIndex = readFileSync(join(import.meta.dirname, "../../dist/index.js"), "utf8");

  // 1. 确认 4 个死导入已被彻底移除
  assert.doesNotMatch(hostIndex, /\bformatTargetContext\b/, "formatTargetContext 死导入已清理");
  assert.doesNotMatch(hostIndex, /\bgetRoleProfile\b/, "getRoleProfile 死导入已清理");
  // g-436：原「formatReviewPrompt 死导入已清理（接线归 g-248）」断言按目标成交状态**反转**为「已接线」——
  // 断言强度只增不减：另外 3 个死导入仍要求彻底移除，并另加「唯一生产调用点」正断言。
  assert.match(hostIndex, /\bformatReviewPrompt\b/, "g-436：host 已接线 formatReviewPrompt（原 g-248 前置守卫按成交状态反转）");
  assert.doesNotMatch(hostIndex, /\bSUBAGENT_ROLES\b/, "SUBAGENT_ROLES 死导入已清理");

  // 2. toolFilterForMode 也已因接线 toolFilterForRole 而不再被 index.js 导入
  assert.doesNotMatch(hostIndex, /\btoolFilterForMode\b/, "toolFilterForMode 已由 toolFilterForRole 取代并清理导入");

  // 3. 验证当前从 ./core/ops.js 导入的所有符号，被清理后无孤立导入
  // g-436：formatReviewPrompt 已按目标接线（不再是死导入），故从本清单移除；其余 4 个仍必须不在导入列表。
  const cleanedDeadImports = ["formatTargetContext", "getRoleProfile", "SUBAGENT_ROLES", "toolFilterForMode"];
  for (const name of cleanedDeadImports) {
    assert.equal(hostIndex.includes(` ${name},`) || hostIndex.includes(` ${name} `), false, `${name} 不得出现在 import 列表中`);
  }
});

// =====================================================================================
// g-436 增量：formatReviewPrompt 接线的**调用点敏感**判定器
//
// 为什么不能只数 `formatReviewPrompt(` 的字面出现次数（独立复核反例，两例均曾判绿）：
//   ① 注释冒充：把唯一生产调用点删掉，只留 `// formatReviewPrompt(` ⇒ 字面次数仍为 1；
//   ② 别名绕过：`const a = formatReviewPrompt;` + `a({...})` ⇒ 值引用被当成「生产调用点」。
// 故判定器先剥掉注释与字符串字面量，再要求：
//   - 剥后「非调用」的标识符出现必须全部落在 `import … from` 语句内（值引用/别名 ⇒ 红）；
//   - 剥后**直接调用**（标识符紧跟 `(`）恰好 1 处，且位于 dispatchReview 服务区域内；
//   - 该调用实参含评审专有字段（goalId / candidateSha / changedPaths / criteria）⇒ 证明确实是
//     独立评审派发的 prompt 构造，而不是随便一个同名调用。
// 行为守卫（不在此文件）：把该 prompt 打桩会让 g-436 套件的注入材料断言判红（reviewer 实得材料错）。
// =====================================================================================

/** 逐字符剥离注释与字符串字面量（保留定界符为空格以维持下标对齐）。 */
function stripCommentsAndStrings(src: string): string {
  const out: string[] = [];
  let mode: "code" | "line" | "block" | "single" | "double" | "tpl" = "code";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; out.push(" "); continue; }
      if (c === "/" && n === "*") { mode = "block"; out.push(" "); continue; }
      if (c === '"') { mode = "double"; out.push(" "); continue; }
      if (c === "'") { mode = "single"; out.push(" "); continue; }
      if (c === "`") { mode = "tpl"; out.push(" "); continue; }
      out.push(c);
    } else if (mode === "line") {
      if (c === "\n") { mode = "code"; out.push("\n"); }
      else out.push(" ");
    } else if (mode === "block") {
      if (c === "*" && n === "/") { mode = "code"; out.push("  "); i++; }
      else out.push(c === "\n" ? "\n" : " ");
    } else {
      if (c === "\\") { out.push("  "); i++; continue; }
      if ((mode === "double" && c === '"') || (mode === "single" && c === "'") || (mode === "tpl" && c === "`")) {
        mode = "code";
      }
      out.push(c === "\n" ? "\n" : " ");
    }
  }
  return out.join("");
}

/** 剥后源码里的 `import … from "…";` 区间（用于区分「导入说明符」与「值引用/别名」）。 */
function importStatementRanges(code: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // 注意：字符串字面量已被剥离成空白 ⇒ 不能要求 `from "…"`，只锚 `} from`。
  const re = /import\s*\{[\s\S]*?\}\s*from\b/g;
  for (const m of code.matchAll(re)) ranges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  return ranges;
}

/** dispatchReview 服务区域（剥后源码；边界 = 函数头 → 下一个同级服务/注册表）。 */
function dispatchReviewRange(code: string): [number, number] | null {
  const start = code.indexOf("const dispatchReview = async (");
  if (start < 0) return null;
  const end = code.indexOf("const tools = [", start);
  return end > start ? [start, end] : null;
}

function lineOfIndex(src: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

/** 返回问题列表（空 = 通过）；抽成纯函数以便负向对照在内存里重放同一判定。 */
function reviewPromptWiringProblems(src: string): string[] {
  const code = stripCommentsAndStrings(src);
  const name = "formatReviewPrompt";
  const problems: string[] = [];
  const hits: number[] = [];
  for (let i = code.indexOf(name); i >= 0; i = code.indexOf(name, i + 1)) hits.push(i);
  if (hits.length === 0) {
    problems.push("剥离注释/字符串后找不到 formatReviewPrompt 的任何代码出现（接线只存在于注释或字符串里）");
    return problems;
  }
  const imports = importStatementRanges(code);
  const inImport = (i: number) => imports.some(([a, b]) => i >= a && i < b);
  const calls = hits.filter((i) => code[i + name.length] === "(");
  const valueRefs = hits.filter((i) => code[i + name.length] !== "(" && !inImport(i));
  for (const i of valueRefs) {
    problems.push(`第 ${lineOfIndex(src, i)} 行把 formatReviewPrompt 当**值/别名**引用（非导入说明符）——生产调用点应是一次直接调用`);
  }
  if (calls.length !== 1) {
    problems.push(`formatReviewPrompt 的直接调用点应恰好 1 处（剥离注释/字符串后），实际 ${calls.length} 处`);
  }
  if (calls.length === 1) {
    const call = calls[0];
    const region = dispatchReviewRange(code);
    const line = lineOfIndex(src, call);
    if (!region) problems.push("找不到 dispatchReview 服务区域（结构已变，请同步本守卫）");
    else if (call < region[0] || call >= region[1]) {
      problems.push(`formatReviewPrompt 的调用点必须在独立评审派发服务 dispatchReview 内（实际在第 ${line} 行，区域外）`);
    }
    const window = code.slice(call, call + 800);
    for (const token of ["goalId:", "candidateSha", "changedPaths", "criteria"]) {
      if (!window.includes(token)) problems.push(`第 ${line} 行的调用实参缺少评审专有字段 ${token}（无法证明这是独立评审派发的 prompt 构造）`);
    }
  }
  return problems;
}

test("g-253 判据 3：executor 执行派发接线 toolFilterForRole('executor', mode) 及统一映射测试", () => {
  const hostIndex = readFileSync(join(import.meta.dirname, "../../dist/index.js"), "utf8");

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
    worktreeBlock: resolveWorktreeGuide("task", true),
  });
  assert.match(prompt, /【强制 worktree 隔离】/);
  assert.match(prompt, /【禁区】绝不自行 graph_transition 到 "delivered"/);

  // 4. minimal 模式支持：受控 6 工具覆盖了看板流转与状态汇报底线
  const minimalFilter = toolFilterForRole("executor", "minimal");
  assert.ok(minimalFilter?.allow?.includes("graph_report_status"));
  assert.ok(minimalFilter?.allow?.includes("graph_transition"));

  // 5. g-248 reviewer 边界清晰 + g-436 接线完成：formatReviewPrompt 由 core 定义/导出，host 现在**已**接线
  //    （唯一生产调用点在独立评审派发服务 dispatchReview 内；reviewer 的越权守卫见 g-436 套件）。
  //    原断言「host 未提前接入（由 g-248 承接）」是**接线前**的过渡守卫，按目标成交状态反转为
  //    「已接入且生产调用点唯一」——判别力只增不减（新增唯一性断言，不放宽任何既有约束）。
  assert.equal(typeof formatReviewPrompt, "function", "formatReviewPrompt 仍由 core 导出");
  const hostIndex = readFileSync(join(import.meta.dirname, "../../dist/index.js"), "utf8");
  assert.equal(hostIndex.includes("formatReviewPrompt"), true, "g-436：host 已接入 formatReviewPrompt（原 g-248 前置守卫按成交状态反转）");
  // 调用点敏感判定（注释冒充 / 字符串冒充 / 别名绕过 / 移出 dispatchReview 一律判红）
  const wiring = reviewPromptWiringProblems(hostIndex);
  assert.deepEqual(wiring, [], `formatReviewPrompt 接线判定失败：\n${wiring.join("\n")}`);
});

test("g-253 判据 3（g-436 增量）负向对照：注释冒充 / 字符串冒充 / 别名绕过 / 移出派发服务 四种绕过必红", () => {
  const src = readFileSync(join(import.meta.dirname, "../../dist/index.js"), "utf8");
  assert.deepEqual(reviewPromptWiringProblems(src), [], "基线（真实 dist/index.js）必须零问题");
  const REAL_CALL = "const prompt = formatReviewPrompt({";
  assert.ok(src.includes(REAL_CALL), "变异前提：找不到真实调用点");

  // ① 注释冒充：删掉真实调用，只留一处注释里的 `formatReviewPrompt(`
  const commentOnly = src.replace(REAL_CALL, "const prompt = /* formatReviewPrompt({ */ buildReviewPrompt({");
  assert.notEqual(commentOnly, src, "变异必须生效");
  assert.equal((commentOnly.match(/formatReviewPrompt\(/g) ?? []).length, 1, "字面计数仍是 1（这正是旧断言的漏洞）");
  assert.match(String(reviewPromptWiringProblems(commentOnly).join("\n")), /直接调用点应恰好 1 处（剥离注释\/字符串后），实际 0 处/, "注释冒充必红");

  // ② 字符串冒充：唯一出现落在字符串字面量里
  const stringOnly = src.replace(REAL_CALL, 'const prompt = buildReviewPrompt("formatReviewPrompt(", {');
  assert.notEqual(stringOnly, src, "变异必须生效");
  assert.equal((stringOnly.match(/formatReviewPrompt\(/g) ?? []).length, 1, "字面计数仍是 1（字符串里的出现也会骗过旧断言）");
  assert.match(String(reviewPromptWiringProblems(stringOnly).join("\n")), /直接调用点应恰好 1 处（剥离注释\/字符串后），实际 0 处/, "字符串冒充必红");

  // ③ 别名绕过：值引用 + 通过别名调用
  const aliased = src.replace(REAL_CALL, "const aliasReviewPrompt = formatReviewPrompt;\n    const prompt = aliasReviewPrompt({");
  assert.notEqual(aliased, src, "变异必须生效");
  const aliasProblems = reviewPromptWiringProblems(aliased).join("\n");
  assert.match(aliasProblems, /当\*\*值\/别名\*\*引用/, "别名绕过必红（值引用）");
  assert.match(aliasProblems, /直接调用点应恰好 1 处/, "别名绕过必红（直接调用为 0）");

  // ④ 移出派发服务：调用点合法但不在 dispatchReview 内（把调用提到服务之前的同名包装函数）
  const moved = src
    .replace(REAL_CALL, "const prompt = reviewPromptFor({")
    .replace("const dispatchReview = async (", "const reviewPromptFor = (o) => formatReviewPrompt(o);\n  const dispatchReview = async (");
  assert.notEqual(moved, src, "变异必须生效");
  assert.match(String(reviewPromptWiringProblems(moved).join("\n")), /必须在独立评审派发服务 dispatchReview 内|缺少评审专有字段/, "移出派发服务必红");

  // hermetic：负向对照只改内存副本，真实文件逐字未变
  assert.equal(readFileSync(join(import.meta.dirname, "../../dist/index.js"), "utf8"), src, "负向对照污染了真实 dist/index.js");
});
