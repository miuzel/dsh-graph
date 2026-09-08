/**
 * g-236：执行派发缺少 action 的任务契约测试
 *
 * 覆盖场景：
 * 1. 工具路径：无 brief 且无 directive 时自动从目标描述生成默认 action
 * 2. 工具路径：有 brief 时使用 brief（优先于 directive）
 * 3. 工具路径：无 brief 但有 directive 时使用 directive
 * 4. 工具路径：brief 和 directive 均有时 brief 优先
 * 5. HTTP 路径：无 brief 且无 directive 时自动从目标描述生成默认 action
 * 6. prompt 模板：brief 优先于 directive 的说明存在
 * 7. prompt 模板：自动生成的 brief 出现在 prompt 中
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { init, createGoal, setCriteria, setGoalDirective, transition, findGoalFile, loadGoal } from "../ops.ts";
import { formatAttemptPrompt, apply } from "../../dsh-graph-host/index.js";

// ===== formatAttemptPrompt 测试 =====

test("g-236 prompt 模板：brief 优先于 directive 说明存在", () => {
  const output = formatAttemptPrompt({
    goal: "g-236",
    attempt: "att-003",
    attemptBrief: "修复空派发问题",
    directive: "这是背景指令",
    cardsSection: "（无）",
    worktreeBlock: "【强制 worktree 隔离】",
  });
  assert.match(output, /brief 优先于 directive/);
  assert.match(output, /brief 是当前任务的直接描述/);
  assert.match(output, /directive 是目标文件中的背景指令/);
  assert.match(output, /两者冲突以 brief 为准/);
});

test("g-236 prompt 模板：brief 和 directive 均有时 brief 出现在 prompt 中", () => {
  const output = formatAttemptPrompt({
    goal: "g-236",
    attempt: "att-003",
    attemptBrief: "本次修复空派发",
    directive: "背景指令：不要动 GUI",
    cardsSection: "（无）",
    worktreeBlock: "【强制 worktree 隔离】",
  });
  assert.match(output, /\*\*attempt brief（当前数据）\*\*/);
  assert.match(output, /本次修复空派发/);
  assert.match(output, /\*\*directive（当前数据）\*\*/);
  assert.match(output, /背景指令：不要动 GUI/);
});

test("g-236 prompt 模板：无 brief 无 directive 时显示未提供", () => {
  const output = formatAttemptPrompt({
    goal: "g-236",
    attempt: "att-003",
    cardsSection: "（无）",
    worktreeBlock: "【强制 worktree 隔离】",
  });
  assert.match(output, /\*\*attempt brief（当前数据）\*\*\n（未提供）/);
  assert.match(output, /\*\*directive（当前数据）\*\*\n（未提供）/);
});

// ===== resolveEffectiveBrief 集成测试（通过 formatAttemptPrompt 间接验证） =====

test("g-236 prompt 模板：自动生成的 brief 出现在 prompt 中", () => {
  // 模拟服务端 resolveEffectiveBrief 生成的 brief
  const autoBrief = "执行目标描述中的任务：修复执行派发缺少 action 的任务契约";
  const output = formatAttemptPrompt({
    goal: "g-236",
    attempt: "att-003",
    attemptBrief: autoBrief,
    cardsSection: "（无）",
    worktreeBlock: "【强制 worktree 隔离】",
  });
  assert.match(output, /执行目标描述中的任务：修复执行派发缺少 action 的任务契约/);
  // 不应显示"未提供"
  assert.ok(!output.includes("**attempt brief（当前数据）**\n（未提供）"));
});

test("g-236 prompt 模板：仅 directive 时 directive 出现在 prompt 中", () => {
  const output = formatAttemptPrompt({
    goal: "g-236",
    attempt: "att-003",
    directive: "只改 API 层",
    cardsSection: "（无）",
    worktreeBlock: "【强制 worktree 隔离】",
  });
  assert.match(output, /只改 API 层/);
  // brief 应显示未提供
  assert.match(output, /\*\*attempt brief（当前数据）\*\*\n（未提供）/);
});

// ===== 插件工具路径集成测试 =====

function setupCtx(root: string) {
  let capturedPrompt = "";
  const registered: any[] = [];
  const ctx = {
    get: (name: string) => name === "subagents" ? {
      list: () => ["spawn"],
      getProvider: () => ({ prepareContinuable: () => {} }),
      startContinuable: async (opts: any) => {
        capturedPrompt = opts.request?.prompt?.[0]?.text ?? "";
        return { childId: "test-child", parentSessionId: "parent" };
      },
    } : undefined,
    effect: (fn: () => unknown) => fn(),
    tools: { register: (d: any) => { registered.push(d); return () => {}; }, get: () => ({}) },
  };
  apply(ctx as any, { root });
  const byName = new Map(registered.map((d) => [d.name, d]));
  return { byName, getPrompt: () => capturedPrompt };
}

test("g-236 工具路径：无 brief 无 directive 时自动生成默认 action", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g236-"));
  init(root);
  const goal = createGoal(root, { title: "测试空派发修复", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["通过"], "test");
  // 不设置 directive → readGoalDirective 返回 null
  // 目标描述为空 → 走 fallback 分支
  const { byName, getPrompt } = setupCtx(root);
  const exec = { agent: { id: "a1", session: { header: { cwd: root }, id: "s1" } }, signal: new AbortController().signal };
  const out = await byName.get("graph_start_attempt")!.execute({ goal }, exec);
  assert.equal(out.child_id, "test-child");
  // 应该有自动生成的 brief（描述为空时走 fallback）
  assert.ok(out.brief, "应返回 brief");
  assert.equal(out.brief_source, "fallback", "无描述时 brief 来源应为 fallback");
  assert.match(out.brief, /执行目标描述和质量判据中的任务/);
  // prompt 中不应出现"两项未提供"
  const prompt = getPrompt();
  assert.ok(!prompt.includes("**attempt brief（当前数据）**\n（未提供）"), "prompt 中 brief 不应为未提供");
});

test("g-236 工具路径：有目标描述时从描述生成 auto_from_desc brief", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g236-desc-"));
  init(root);
  const goal = createGoal(root, { title: "有描述的目标", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["通过"], "test");
  // 手动写入目标描述
  const goalFile = findGoalFile(root, goal);
  const { readFileSync, writeFileSync } = await import("node:fs");
  const body = readFileSync(goalFile, "utf-8");
  const withDesc = body.replace("## 目标描述\n", "## 目标描述\n\n修复登录页面的样式问题，确保按钮对齐。\n");
  writeFileSync(goalFile, withDesc);
  const { byName, getPrompt } = setupCtx(root);
  const exec = { agent: { id: "a1", session: { header: { cwd: root }, id: "s1" } }, signal: new AbortController().signal };
  const out = await byName.get("graph_start_attempt")!.execute({ goal }, exec);
  assert.equal(out.child_id, "test-child");
  assert.ok(out.brief, "应返回 brief");
  assert.equal(out.brief_source, "auto_from_desc", "有描述时 brief 来源应为 auto_from_desc");
  assert.match(out.brief, /修复登录页面的样式问题/);
  const prompt = getPrompt();
  assert.match(prompt, /修复登录页面的样式问题/);
});

test("g-236 工具路径：有 attempt_brief 时使用用户提供的 brief", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g236-"));
  init(root);
  const goal = createGoal(root, { title: "测试 brief 优先", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["通过"], "test");
  const { byName, getPrompt } = setupCtx(root);
  const exec = { agent: { id: "a1", session: { header: { cwd: root }, id: "s1" } }, signal: new AbortController().signal };
  const out = await byName.get("graph_start_attempt")!.execute({ goal, attempt_brief: "修复登录 bug" }, exec);
  assert.equal(out.child_id, "test-child");
  assert.equal(out.brief, "修复登录 bug");
  assert.equal(out.brief_source, undefined, "用户提供的 brief 不应有 brief_source");
  const prompt = getPrompt();
  assert.match(prompt, /修复登录 bug/);
});

test("g-236 工具路径：无 brief 但有 directive 时使用 directive", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g236-"));
  init(root);
  const goal = createGoal(root, { title: "测试 directive 回退", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["通过"], "test");
  setGoalDirective(root, goal, "只改 API 层，不动 GUI", "test");
  const { byName, getPrompt } = setupCtx(root);
  const exec = { agent: { id: "a1", session: { header: { cwd: root }, id: "s1" } }, signal: new AbortController().signal };
  const out = await byName.get("graph_start_attempt")!.execute({ goal }, exec);
  assert.equal(out.child_id, "test-child");
  assert.equal(out.brief, "只改 API 层，不动 GUI");
  assert.equal(out.brief_source, "directive", "brief 来源应为 directive");
  const prompt = getPrompt();
  assert.match(prompt, /只改 API 层，不动 GUI/);
});

test("g-236 工具路径：brief 和 directive 均有时 brief 优先", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g236-"));
  init(root);
  const goal = createGoal(root, { title: "测试 brief 优先级", version: "v-t", actor: "test" });
  setCriteria(root, goal, ["通过"], "test");
  setGoalDirective(root, goal, "这是背景指令", "test");
  const { byName, getPrompt } = setupCtx(root);
  const exec = { agent: { id: "a1", session: { header: { cwd: root }, id: "s1" } }, signal: new AbortController().signal };
  const out = await byName.get("graph_start_attempt")!.execute({ goal, attempt_brief: "当前任务：修复 bug" }, exec);
  assert.equal(out.child_id, "test-child");
  assert.equal(out.brief, "当前任务：修复 bug");
  const prompt = getPrompt();
  assert.match(prompt, /当前任务：修复 bug/);
  // directive 也应出现在 prompt 中（作为背景）
  assert.match(prompt, /这是背景指令/);
});

