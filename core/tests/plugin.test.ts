/** 插件工具输出的无损 JSON 回归测试（防止 undefined 字段这类问题再现）。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { init, findGoalFile, loadGoal, createGoal } from "../ops.ts";
import { resolveRoot } from "../root.ts";
import { apply } from "../../dsh-graph-host/index.js";

function assertLossless(v: unknown): void {
  assert.deepEqual(JSON.parse(JSON.stringify(v)), v, "输出必须是无损 JSON");
}

test("全部 graph_* 工具在 mock ctx 下可执行且输出无损 JSON", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-plugin-"));
  init(root);
  const registered: any[] = [];
  const ctx = {
    get: () => undefined, // 无 subagents 服务 → 走降级分支
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (def: any) => {
        registered.push(def);
        return () => {};
      },
      get: () => ({}),
    },
  };
  apply(ctx as any, { root });
  assert.equal(registered.length, 14);

  const byName = new Map(registered.map((d) => [d.name, d]));
  const exec = { agent: undefined, signal: new AbortController().signal };
  const call = async (name: string, args: Record<string, unknown>) => {
    const out = await byName.get(name)!.execute(args, exec);
    assertLossless(out);
    return out as any;
  };

  const { goal } = await call("graph_create_goal", { title: "t", version: "v-t" });
  await call("graph_set_criteria", { goal, criteria: ["通过"] });
  await call("graph_transition", { goal, to: "planning" });
  const { card } = await call("graph_add_card", { goal, title: "c", kind: "text" });
  await call("graph_fill_card", { goal, card, text: "内容" });
  await call("graph_review_card", { goal, card });
  const att = await call("graph_start_attempt", { goal });
  assert.equal(att.child_id, null); // 无 subagents → 降级
  assert.ok(typeof att.note === "string");
  await call("graph_report_status", { goal, attempt: att.attempt, status: "测试中" });
  await call("graph_report_supervisor_status", { status: "主管调度中" });
  const { readSupervisorStatus, readSupervisorStatusAt } = await import("../ops.ts");
  assert.equal(readSupervisorStatus(root), "主管调度中");
  assert.equal(typeof readSupervisorStatusAt(root), "number");
  await call("graph_amend_goal", { goal, note: "测试修订", append: "补充：修订内容" });
  await call("graph_move_goal", { goal, to: "standalone" });
  const v = await call("graph_validate", {});
  assert.deepEqual(v.problems, []);
  const r = await call("graph_rebuild", {});
  assert.deepEqual(r.drift, []);
});

// ===== g-113：host 工具 root 跟随会话 workspace（session.header.cwd → sandboxPolicy → process.cwd 兜底） =====

function hostCtx(extra: Record<string, unknown> = {}) {
  const registered: any[] = [];
  return {
    registered,
    ctx: {
      get: (name: string) => (name === "sandboxPolicy" ? extra.sandboxPolicy ?? undefined : undefined),
      effect: (fn: () => unknown) => fn(),
      tools: {
        register: (def: any) => { registered.push(def); return () => {}; },
        get: () => ({}),
      },
    } as any,
  };
}

test("g-113 host 工具按 session.header.cwd 建目标（不用服务进程 cwd）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-host-ws-"));
  const ws = join(base, "proj");
  const { registered, ctx } = hostCtx();
  apply(ctx, {}); // 无 config.root → 完全由会话 workspace 决定
  const byName = new Map(registered.map((d) => [d.name, d]));
  const exec = { agent: { session: { header: { cwd: ws } } }, signal: new AbortController().signal };
  const out = await byName.get("graph_create_goal")!.execute({ title: "ws 目标" }, exec);
  const goalFile = findGoalFile(join(ws, ".dsh-graph"), out.goal);
  assert.ok(goalFile.startsWith(join(ws, ".dsh-graph")), "目标落在会话 workspace 的 .dsh-graph");
  // 进程 cwd（服务进程沙箱根）下即使有同名 id（per-root 顺序 g-001 会撞仓库自身目标），
  // 内容也绝不是本次创建的——标题不同即证明数据没落到服务进程 cwd
  const cwdFile = findGoalFile(resolveRoot({}, process.cwd()), out.goal);
  assert.notEqual(loadGoal(cwdFile).meta.title, "ws 目标", "数据未落到服务进程 cwd 的项目");
});

test("g-113 host 工具兜底 sandboxPolicy.workspaceRoot（无 session header 时）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-host-ws-"));
  const ws = join(base, "proj2");
  const { registered, ctx } = hostCtx({ sandboxPolicy: { workspaceRoot: ws } });
  apply(ctx, {});
  const byName = new Map(registered.map((d) => [d.name, d]));
  const exec = { agent: {}, signal: new AbortController().signal }; // 无 session → 走 sandboxPolicy
  const out = await byName.get("graph_create_goal")!.execute({ title: "sp 目标" }, exec);
  const goalFile = findGoalFile(join(ws, ".dsh-graph"), out.goal);
  assert.ok(goalFile.startsWith(join(ws, ".dsh-graph")), "目标落在 sandboxPolicy.workspaceRoot 的 .dsh-graph");
});

test("g-113 graph_start_attempt 注入目标相对路径以 workspace 根为基准（.dsh-graph/versions/...）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-host-rel-"));
  const ws = join(base, "proj");
  init(join(ws, ".dsh-graph"));
  const goalId = createGoal(join(ws, ".dsh-graph"), { title: "rel 目标", version: "v-t", actor: "test" });
  let capturedPrompt = "";
  const registered: any[] = [];
  const ctx = {
    get: (name: string) => name === "subagents" ? {
      list: () => ["spawn"],
      getProvider: () => ({ prepareContinuable: () => {} }),
      startContinuable: async (opts: any) => {
        capturedPrompt = opts.request?.prompt?.[0]?.text ?? "";
        return { childId: "child-x" };
      },
    } : undefined,
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (def: any) => { registered.push(def); return () => {}; },
      get: () => ({}),
    },
  };
  apply(ctx as any, {});
  const byName = new Map(registered.map((d) => [d.name, d]));
  const exec = { agent: { id: "a1", session: { header: { cwd: ws }, id: "s1" } }, signal: new AbortController().signal };
  const out = await byName.get("graph_start_attempt")!.execute({ goal: goalId }, exec);
  assert.equal(out.child_id, "child-x");
  // 子代理工作目录 = workspace 根 → 相对路径必须含 .dsh-graph 前缀（此前 relative(rootFor,...) 会漏掉它）
  const expected = relative(ws, findGoalFile(join(ws, ".dsh-graph"), goalId));
  assert.ok(capturedPrompt.includes(expected), `prompt 含 workspace 根基准相对路径：${expected}`);
  assert.ok(capturedPrompt.includes(".dsh-graph/versions/v-t/goals/"), "路径带 .dsh-graph 前缀（不是 versions/... 裸相对）");
});
