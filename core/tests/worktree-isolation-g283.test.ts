import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveWorktreeGuide, formatAttemptPrompt } from "../../dsh-graph-host/index.js";
import { defaultWorktreeForGoalType } from "../ops.ts";

/**
 * g-283 att-004 回归守卫：提示词中的 worktree 隔离声明必须与「本次是否真的建树」严格一致。
 * 覆盖矩阵：{显式 true | 显式 false | 未传} × {patch|chore, task, feature|bug}。
 * 核心缺陷：原 dispatch 用「原始 worktree 参数」解析提示词，却用「解析后 isWorktree」真实建树，
 *          导致 task 目标未显式传 worktree 时提示词声称强制隔离、实际却不建树。
 */

function resolvedIsolate(type: string, explicit?: boolean): boolean {
  return explicit !== undefined ? Boolean(explicit) : defaultWorktreeForGoalType(type);
}

test("g-283 回归：isolate=true 无论类型均返回 worktree 强制隔离指引（两种来源文案）", () => {
  for (const type of ["patch", "chore", "task", "feature", "bug", "improvement"]) {
    const guide = resolveWorktreeGuide(type, true);
    assert.ok(guide.includes("【强制 worktree 隔离】"), `${type} isolate=true 应含强制隔离声明`);
    assert.ok(guide.includes("supervisor 预建、或由插件在派发时创建"), `${type} 强制隔离指引覆盖两种来源`);
    assert.ok(!guide.includes("未启用 worktree 隔离"), `${type} isolate=true 不得含未启用声明`);
    assert.ok(!guide.includes("豁免独立 worktree 隔离"), `${type} isolate=true 不得含 minor-task 豁免`);
  }
});

test("g-283 回归：isolate=false 时 patch/chore 保留 minor-task 豁免指引", () => {
  for (const type of ["patch", "chore"]) {
    const guide = resolveWorktreeGuide(type, false);
    assert.ok(guide.includes("豁免独立 worktree 隔离"), `${type} isolate=false 应含 minor-task 豁免`);
    assert.ok(!guide.includes("【强制 worktree 隔离】"), `${type} isolate=false 不得含强制隔离`);
    assert.ok(!guide.includes("预创建"), `${type} isolate=false 不得含预创建字样`);
  }
});

test("g-283 回归：isolate=false 时其余类型（含 task）走 no-isolation 指引，绝无强制隔离/预创建", () => {
  for (const type of ["task", "feature", "bug", "improvement"]) {
    const guide = resolveWorktreeGuide(type, false);
    assert.ok(guide.includes("本次未启用 worktree 隔离"), `${type} isolate=false 应声明本次未启用 worktree 隔离`);
    assert.ok(guide.includes("当前工作区"), `${type} isolate=false 应声明在当前工作区执行`);
    assert.ok(!guide.includes("强制"), `${type} isolate=false 不得出现「强制」字样`);
    assert.ok(!guide.includes("预创建"), `${type} isolate=false 不得出现「预创建」字样`);
    assert.ok(!guide.includes("预建"), `${type} isolate=false 不得出现「预建」字样`);
  }
});

test("g-283 回归：未传 worktree 按目标类型默认值解析，隔离声明与 isWorktree 一致", () => {
  const matrix: Array<[string, boolean]> = [
    ["patch", false],
    ["chore", false],
    ["task", false],
    ["feature", true],
    ["bug", true],
    ["improvement", true],
  ];
  for (const [type, expected] of matrix) {
    const isWorktree = resolvedIsolate(type, undefined);
    assert.equal(isWorktree, expected, `${type} 默认 isWorktree=${expected}`);
    assert.equal(isWorktree, defaultWorktreeForGoalType(type), `${type} 默认值一致`);
    const guide = resolveWorktreeGuide(type, isWorktree);
    if (isWorktree) {
      assert.ok(guide.includes("【强制 worktree 隔离】"), `${type} 未传 → 默认隔离 → 强制隔离声明`);
    } else if (type === "patch" || type === "chore") {
      assert.ok(guide.includes("豁免独立 worktree 隔离"), `${type} 未传 → 默认不隔离 → minor-task 豁免`);
    } else {
      assert.ok(guide.includes("本次未启用 worktree 隔离"), `${type} 未传 → 默认不隔离 → no-isolation 声明`);
    }
  }
});

test("g-283 回归：未传 + task 提示词必须不含「强制隔离 / 预创建」这类字样", () => {
  const isWorktree = resolvedIsolate("task", undefined);
  assert.equal(isWorktree, false, "task 默认不建树");
  const guide = resolveWorktreeGuide("task", isWorktree);
  assert.ok(!guide.includes("强制"), "未传 task 不得出现「强制」");
  assert.ok(!guide.includes("预创建"), "未传 task 不得出现「预创建」");
  assert.ok(!guide.includes("已预创建"), "未传 task 不得出现「已预创建」");
  assert.ok(guide.includes("本次未启用 worktree 隔离"), "未传 task 应声明本次未启用");

  // 全量提示词同样不得混入强制隔离声明（声明与 isWorktree=false 严格一致）
  const prompt = formatAttemptPrompt({
    goal: "g-283",
    attempt: "att-004",
    goalRel: ".dsh-graph/versions/v0.11.0/goals/g-283/goal.md",
    worktreeBlock: resolveWorktreeGuide("task", isWorktree),
  });
  assert.ok(prompt.includes("本次未启用 worktree 隔离"), "全量提示词含未启用隔离声明");
  assert.ok(!prompt.includes("【强制 worktree 隔离】"), "全量提示词不得含强制隔离声明");
  assert.ok(!prompt.includes("预创建"), "全量提示词不得含预创建字样");
});

/**
 * g-283 att-005 补充守卫：已隔离指引必须讲清「子代理 cwd 在主/集成工作树」这一现实，
 * 否则不留神的代理会直接在主工作树里改代码（g-280/281/282 串扰事故形态）。
 * 三要素：(a) cwd 声明（含「预期行为」理由）(b) 工作树位置/核实方式 (c) 只能在 worktree 内改代码。
 * 同时要求「未隔离」指引不得混入任何强制隔离/核实/纪律字样。
 */

/** 已隔离指引三要素的锚点文案（zh / en 各一套，与 prompts/worktree.*.md 逐一对应） */
const ISOLATED_ELEMENTS = {
  zh: {
    cwdDecl: "你的 cwd 是主/集成工作树，不是你的工作树",
    cwdExpected: "预期行为",
    cwdBoardReason: ".dsh-graph",
    cwdNotPermit: "绝不代表可以在主工作树改代码",
    pathConvention: ".worktrees/g-<goal-number>-att-<NN>",
    verifyGit: "git worktree list",
    verifyTool: "graph_list_worktrees",
    disciplineCd: "cd <绝对路径>",
    disciplineGitC: "git -C <绝对路径>",
    disciplineForbidMain: "禁止在主工作树产生任何代码改动",
  },
  en: {
    cwdDecl: "Your cwd is the main/integration worktree, not your worktree",
    cwdExpected: "expected behavior, not a failure",
    cwdBoardReason: ".dsh-graph",
    cwdNotPermit: "never means you may change code in the main worktree",
    pathConvention: ".worktrees/g-<goal-number>-att-<NN>",
    verifyGit: "git worktree list",
    verifyTool: "graph_list_worktrees",
    disciplineCd: "cd <absolute path>",
    disciplineGitC: "git -C <absolute path>",
    disciplineForbidMain: "Producing any code change in the main worktree is forbidden",
  },
} as const;

test("g-283 att-005：已隔离指引（zh/en）必须齐备 cwd 声明 / 路径核实 / worktree 内操作纪律三要素", () => {
  for (const lang of ["zh", "en"] as const) {
    const e = ISOLATED_ELEMENTS[lang];
    for (const type of ["patch", "chore", "task", "feature", "bug", "improvement"]) {
      const guide = resolveWorktreeGuide(type, true, lang);
      const tag = `${lang}/${type}`;
      // (a) cwd 声明：cwd 在主/集成工作树、是预期行为、且不代表可在此改代码
      assert.ok(guide.includes(e.cwdDecl), `${tag} 必须声明 cwd 是主/集成工作树而非本次工作树`);
      assert.ok(guide.includes(e.cwdExpected), `${tag} 必须说明 cwd 在主树是预期行为`);
      assert.ok(guide.includes(e.cwdBoardReason), `${tag} 必须给出看板数据 .dsh-graph 写主树的原因`);
      assert.ok(guide.includes(e.cwdNotPermit), `${tag} 必须声明 cwd 在主树不代表可改代码`);
      // (b) 工作树位置 / 核实方式
      assert.ok(guide.includes(e.pathConvention), `${tag} 必须给出工作树命名约定（可拼绝对路径）`);
      assert.ok(guide.includes(e.verifyGit), `${tag} 必须要求 git worktree list 核实`);
      assert.ok(guide.includes(e.verifyTool), `${tag} 必须要求 graph_list_worktrees 核实`);
      // (c) 操作纪律：cd / git -C 绝对路径 + 禁止主树改动
      assert.ok(guide.includes(e.disciplineCd), `${tag} 必须给出 cd <绝对路径> 纪律`);
      assert.ok(guide.includes(e.disciplineGitC), `${tag} 必须给出 git -C <绝对路径> 纪律`);
      assert.ok(guide.includes(e.disciplineForbidMain), `${tag} 必须禁止在主工作树产生代码改动`);
      // 三要素存在的前提下，仍不得混入未隔离/豁免口径
      assert.ok(!guide.includes("未启用 worktree 隔离"), `${tag} 已隔离指引不得含未启用声明`);
      assert.ok(!guide.includes("豁免独立 worktree 隔离"), `${tag} 已隔离指引不得含豁免声明`);
    }
  }
});

test("g-283 att-005：未隔离指引（zh/en，minor-task / no-isolation）不得混入强制隔离三要素字样", () => {
  const forbiddenCommon = [
    "git worktree list",
    "graph_list_worktrees",
    "cd <绝对路径>",
    "git -C <绝对路径>",
    "cd <absolute path>",
    "git -C <absolute path>",
    "禁止在主工作树产生任何代码改动",
    "Producing any code change in the main worktree is forbidden",
    "Your cwd is the main/integration worktree",
    "你的 cwd 是主/集成工作树",
  ];
  const cases: Array<[string, string, string]> = [
    ["zh", "patch", "minor-task"],
    ["zh", "chore", "minor-task"],
    ["zh", "task", "no-isolation"],
    ["zh", "feature", "no-isolation"],
    ["en", "patch", "minor-task"],
    ["en", "chore", "minor-task"],
    ["en", "task", "no-isolation"],
    ["en", "feature", "no-isolation"],
  ];
  for (const [lang, type, kind] of cases) {
    const guide = resolveWorktreeGuide(type, false, lang);
    const tag = `${lang}/${type}/${kind}`;
    for (const bad of forbiddenCommon) {
      assert.ok(!guide.includes(bad), `${tag} 未隔离指引不得含强制隔离字样：${bad}`);
    }
    assert.ok(!guide.includes("【强制 worktree 隔离】"), `${tag} 未隔离指引不得含强制隔离标题`);
    assert.ok(!guide.includes("预创建") && !guide.includes("预建"), `${tag} 未隔离指引不得含预创建/预建字样`);
  }
});

test("g-283 att-005：静态 prompt 资源不写死 worktree 绝对路径，改由代理自行核实（并给出替代方案）", () => {
  // 静态资源无法内插本次 goal/attempt，因此指引必须显式声明「不含绝对路径」并要求核实；
  // 若未来改为动态内插，本断言会失败，提示同步更新契约与文案。
  for (const lang of ["zh", "en"] as const) {
    const guide = resolveWorktreeGuide("feature", true, lang);
    assert.ok(
      guide.includes("git worktree list"),
      `${lang} 指引必须以核实命令替代写死绝对路径`,
    );
    const cwd = process.cwd();
    assert.ok(
      !guide.includes(cwd),
      `${lang} 指引是静态资源，不得写死运行机绝对路径 ${cwd}`,
    );
  }
});

test("g-283 回归：dispatch 在提示词组装前计算 isWorktree 并传给 resolveWorktreeGuide", () => {
  const src = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");
  const isIdx = src.indexOf("const isWorktree = worktree !== undefined");
  const guideIdx = src.indexOf("resolveWorktreeGuide(gType, isWorktree, promptLanguage)");
  assert.ok(isIdx >= 0, "index.js 存在 isWorktree 解析");
  assert.ok(guideIdx >= 0, "index.js 调用 resolveWorktreeGuide 传入 isWorktree（解析后布尔，非原始 worktree 参数）");
  assert.ok(isIdx < guideIdx, "isWorktree 必须在 resolveWorktreeGuide 调用之前计算");
  // 不再以原始 worktree 参数作为第二参调用（旧缺陷根因）
  assert.ok(!src.includes("resolveWorktreeGuide(gType, worktree,"), "dispatch 不再用原始 worktree 参数解析提示词");
});
