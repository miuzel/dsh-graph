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
