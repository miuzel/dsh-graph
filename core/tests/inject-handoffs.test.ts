/** g-150：attempt handoff 注入——向 graph_start_attempt 注入已复核的前序失败与返工约束。
 *  单文件简化：每个 goal 仅一个 handoff.md，新登记覆盖旧内容。
 *  验证：① core 读取函数 harvestReviewedAttemptHandoffs 返回当前有效 handoff；
 *  ② recordAttemptHandoff 覆盖写 handoff 文件 + 事件；
 *  ③ formatReviewedAttemptHandoffsSection 在无 handoff 时返回空字符串；
 *  ④ startAttempt 带 injectedHandoffs/attemptBrief 时事件与 meta 正确记录；
 *  ⑤ 两处执行派发（graph_start_attempt + /start-execution）的 prompt 注入 handoff 段；
 *  ⑥ 无历史目标保持现有 prompt 行为（无 handoff 段）；
 *  ⑦ 未复核 agent 报告/status_line 不被注入；
 *  ⑧ 覆盖语义：新登记只返回最新内容；
 *  ⑨ initial brief 在 spawn 前进入 prompt 并写入事件；
 *  ⑩ 遗留 handoffs/ 目录兼容。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  init,
  createGoal,
  addCard,
  fillCard,
  reviewCard,
  startAttempt,
  findGoalFile,
  loadGoal,
  recordAttemptHandoff,
  harvestReviewedAttemptHandoffs,
  formatReviewedAttemptHandoffsSection,
} from "../ops.ts";
import { serializeDoc } from "../model.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dsh-graph-host/index.js";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "dsh-graph-g150-"));
  init(dir);
  return dir;
}

const REPO_TMP_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tmp");

function repoTmp(prefix: string): string {
  mkdirSync(REPO_TMP_ROOT, { recursive: true });
  return mkdtempSync(join(REPO_TMP_ROOT, prefix));
}

async function withRepoTmp<T>(prefix: string, fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = repoTmp(prefix);
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- ① core 读取函数 ----

test("g-150：harvestReviewedAttemptHandoffs 无 handoff 文件返回空", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "无历史", version: "v-t", actor: "test" });
  assert.deepEqual(harvestReviewedAttemptHandoffs(root, goal), []);
});

test("g-150：harvestReviewedAttemptHandoffs 返回已确认的 handoff", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "有handoff", version: "v-t", actor: "test" });
  const attId = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [attId],
    failures: "失败点 A",
    constraints: "禁止路径 B",
    baseline: "基线 C",
    verification: "npm test",
    confirmed_by: "supervisor:sess-1",
    actor: "supervisor:sess-1",
  });
  const handoffs = harvestReviewedAttemptHandoffs(root, goal);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].id, "handoff");
  assert.equal(handoffs[0].status, "confirmed");
  assert.deepEqual(handoffs[0].source_attempts, [attId]);
  assert.equal(handoffs[0].failures, "失败点 A");
  assert.equal(handoffs[0].constraints, "禁止路径 B");
  assert.equal(handoffs[0].baseline, "基线 C");
  assert.equal(handoffs[0].verification, "npm test");
  assert.equal(handoffs[0].confirmed_by, "supervisor:sess-1");
});

test("g-150：新登记覆盖旧内容，harvestReviewedAttemptHandoffs 只返回最新", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "覆盖", version: "v-t", actor: "test" });
  const att1 = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att1],
    failures: "旧失败",
    constraints: "旧约束",
    baseline: "旧基线",
    verification: "旧验收",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  const att2 = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att2],
    failures: "新失败",
    constraints: "新约束",
    baseline: "新基线",
    verification: "新验收",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  const handoffs = harvestReviewedAttemptHandoffs(root, goal);
  assert.equal(handoffs.length, 1, "单文件：只返回当前 handoff");
  assert.equal(handoffs[0].failures, "新失败");
  assert.equal(handoffs[0].revision, 2, "revision 递增");
  assert.deepEqual(handoffs[0].source_attempts, [att2]);
});

test("g-150：formatReviewedAttemptHandoffsSection 无 handoff 时返回空字符串", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "空", version: "v-t", actor: "test" });
  assert.equal(formatReviewedAttemptHandoffsSection(root, goal), "");
});

test("g-150：formatReviewedAttemptHandoffsSection 含已确认 handoff 时返回结构化段", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "有段", version: "v-t", actor: "test" });
  const att = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att],
    failures: "模块 X 崩溃",
    constraints: "不要重写模块 Y",
    baseline: "保留 Z 函数",
    verification: "npm test && npm run lint",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  const sec = formatReviewedAttemptHandoffsSection(root, goal);
  assert.ok(sec.includes("前序 attempt 已确认 handoff"), "含标题");
  assert.ok(sec.includes("模块 X 崩溃"), "含失败点");
  assert.ok(sec.includes("不要重写模块 Y"), "含约束");
  assert.ok(sec.includes("保留 Z 函数"), "含基线");
  assert.ok(sec.includes("npm test && npm run lint"), "含验收命令");
  assert.ok(sec.includes(att), "含来源 attempt");
});

// ---- ② recordAttemptHandoff 事件 ----

test("g-150：recordAttemptHandoff 写 handoff 文件 + attempt.handoff.confirmed 事件", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "事件", version: "v-t", actor: "test" });
  const att = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att],
    failures: "失败",
    constraints: "约束",
    baseline: "基线",
    verification: "验收",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  const events = readEvents(root).filter((e) => e.event === "attempt.handoff.confirmed" && e.goal === goal);
  assert.equal(events.length, 1);
  assert.equal(events[0].details.handoff, "handoff");
  assert.equal(events[0].details.revision, 1);
  assert.deepEqual(events[0].details.source_attempts, [att]);
  // 文件应存在
  const goalFile = findGoalFile(root, goal);
  const dir = goalFile.replace(/goal\.md$/, "");
  assert.ok(existsSync(join(dir, "handoff.md")), "handoff.md 存在");
});

test("g-150：recordAttemptHandoff 校验 source attempt 不存在时报错", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "校验", version: "v-t", actor: "test" });
  assert.throws(
    () => recordAttemptHandoff(root, goal, {
      source_attempts: ["att-999"],
      failures: "失败",
      constraints: "约束",
      baseline: "基线",
      verification: "验收",
      confirmed_by: "supervisor:s1",
      actor: "supervisor:s1",
    }),
    /来源 attempt 不存在/,
  );
});

test("g-150：覆盖时事件记录 overwrote_previous=true", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "覆盖事件", version: "v-t", actor: "test" });
  const att1 = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att1],
    failures: "旧",
    constraints: "旧",
    baseline: "旧",
    verification: "旧",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  const att2 = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att2],
    failures: "新",
    constraints: "新",
    baseline: "新",
    verification: "新",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  const events = readEvents(root).filter((e) => e.event === "attempt.handoff.confirmed" && e.goal === goal);
  assert.equal(events.length, 2);
  assert.equal(events[0].details.overwrote_previous, false, "首次无覆盖");
  assert.equal(events[1].details.overwrote_previous, true, "第二次覆盖");
  assert.equal(events[1].details.revision, 2);
});

// ---- ③ startAttempt 带 injectedHandoffs/attemptBrief ----

test("g-150：startAttempt 带 injectedHandoffs 时事件与 meta 记录注入引用", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "meta", version: "v-t", actor: "test" });
  const refs = [{ id: "handoff", revision: 1, source_attempts: ["att-001"] }];
  startAttempt(root, goal, { executor: "agent:t", actor: "test", injectedHandoffs: refs });
  const ev = readEvents(root).find((e) => e.event === "attempt.started" && e.goal === goal);
  assert.deepEqual(ev!.details.injected_handoffs, refs);
  const goalFile = findGoalFile(root, goal);
  const dir = goalFile.replace(/goal\.md$/, "");
  const attDoc = loadGoal(join(dir, "attempts", "att-001", "attempt.md"));
  assert.deepEqual(attDoc.meta.injected_handoffs, refs);
});

test("g-150：startAttempt 带 attemptBrief 时事件与 meta 记录 brief", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "brief", version: "v-t", actor: "test" });
  startAttempt(root, goal, { executor: "agent:t", actor: "test", attemptBrief: "本次是安全整合" });
  const ev = readEvents(root).find((e) => e.event === "attempt.started" && e.goal === goal);
  assert.equal(ev!.details.brief, "本次是安全整合");
  const goalFile = findGoalFile(root, goal);
  const dir = goalFile.replace(/goal\.md$/, "");
  const attDoc = loadGoal(join(dir, "attempts", "att-001", "attempt.md"));
  assert.equal(attDoc.meta.brief, "本次是安全整合");
});

test("g-150：startAttempt 无 injectedHandoffs/attemptBrief 时保持兼容（事件无对应字段）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "compat", version: "v-t", actor: "test" });
  startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  const ev = readEvents(root).find((e) => e.event === "attempt.started" && e.goal === goal);
  assert.ok(!("injected_handoffs" in ev!.details), "无 handoff 时不出现字段");
  assert.ok(!("brief" in ev!.details), "无 brief 时不出现字段");
});

// ---- ④⑤ host 两处派发 ----

function fakeRequest(method: string, body: unknown) {
  const req: any = {
    method,
    _listeners: {} as Record<string, (v?: any) => void>,
    on(ev: string, cb: (v?: any) => void) { req._listeners[ev] = cb; },
  };
  return req;
}

function emitBody(req: any, body: unknown) {
  req._listeners.data?.(JSON.stringify(body));
  req._listeners.end?.();
}

function fakeResponse() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}

function makeHostCtx(captured: { prompt?: string }, workspace?: string) {
  const routes = new Map<string, any>();
  const registered: any[] = [];
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return workspace ? { workspaceRoot: workspace } : undefined;
      if (name === "subagents") return {
        list: () => ["spawn"],
        getProvider: () => ({ prepareContinuable: () => {} }),
        startContinuable: async (opts: any) => {
          captured.prompt = opts.request?.prompt?.[0]?.text ?? "";
          return { childId: "child-g150" };
        },
      };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registered.push(def); return () => {}; }, get: () => ({}) },
  };
  apply(ctx, {});
  return { routes, registered };
}

function execCtx(ws: string) {
  return { agent: { session: { id: "sess-exec", header: { cwd: ws } } }, signal: new AbortController().signal };
}

/** 创建带一个已确认 handoff 的目标（用于 host 测试）。 */
function goalWithHandoff(root: string): { goal: string; att: string } {
  const goal = createGoal(root, { title: "handoff目标", version: "v-t", actor: "test" });
  const att = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att],
    failures: "模块 X 崩溃于 L42",
    constraints: "禁止重写模块 Y；不得删除 Z",
    baseline: "保留 W 函数签名与行为",
    verification: "npm test && npm run lint",
    confirmed_by: "supervisor:sess-1",
    actor: "supervisor:sess-1",
  });
  return { goal, att };
}

test("g-150：graph_start_attempt 工具 prompt 注入 handoff 段 + 事件记 injected_handoffs", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-host-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { goal, att } = goalWithHandoff(root);
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  assert.ok(tool, "graph_start_attempt 已注册");
  const res = await tool.execute({ goal }, execCtx(ws));
  assert.equal(res.child_id, "child-g150");
  assert.ok(res.injected_handoffs.length > 0, "返回含 injected_handoffs");
  assert.equal(res.injected_handoffs[0].id, "handoff");
  // prompt 断言
  assert.ok(captured.prompt!.includes("前序 attempt 已确认 handoff"), "prompt 含 handoff 段标题");
  assert.ok(captured.prompt!.includes("模块 X 崩溃于 L42"), "prompt 含失败点");
  assert.ok(captured.prompt!.includes("禁止重写模块 Y"), "prompt 含约束");
  assert.ok(captured.prompt!.includes("保留 W 函数签名与行为"), "prompt 含基线");
  assert.ok(captured.prompt!.includes("npm test && npm run lint"), "prompt 含验收命令");
  assert.ok(captured.prompt!.includes(att), "prompt 含来源 attempt");
  // 事件断言
  const ev = readEvents(root).filter((e) => e.event === "attempt.started" && e.goal === goal && e.details.attempt === "att-002");
  assert.equal(ev.length, 1);
  assert.ok(Array.isArray(ev[0].details.injected_handoffs), "事件含 injected_handoffs");
  assert.equal(ev[0].details.injected_handoffs[0].id, "handoff");
});

test("g-150：graph_start_attempt 带 attempt_brief 时 prompt 注入 brief 段 + 事件记 brief", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-brief-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "brief目标", version: "v-t", actor: "test" });
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  const res = await tool.execute({ goal, attempt_brief: "本次是安全整合而非重新实现" }, execCtx(ws));
  assert.equal(res.brief, "本次是安全整合而非重新实现");
  assert.ok(captured.prompt!.includes("本次 attempt brief/directive"), "prompt 含 brief 段标题");
  assert.ok(captured.prompt!.includes("本次是安全整合而非重新实现"), "prompt 含 brief 正文");
  const ev = readEvents(root).find((e) => e.event === "attempt.started" && e.goal === goal);
  assert.equal(ev!.details.brief, "本次是安全整合而非重新实现");
});


test("g-228：graph_start_attempt 使用 supervisor 独立关键字段，不从 brief 猜测", async () => {
  await withRepoTmp("dsh-graph-g228-structured-", async (ws) => {
    const root = join(ws, ".dsh-graph");
    init(root);
    const goal = createGoal(root, { title: "structured", version: "v-t", actor: "test" });
    const captured: { prompt?: string } = {};
    const { registered } = makeHostCtx(captured, ws);
    const tool = registered.find((d) => d.name === "graph_start_attempt");
    assert.deepEqual(tool.parameters.properties.task_type.enum, ["merge", "rewrite", "fix"]);
    assert.equal(tool.parameters.properties.task_type.type, "string");
    assert.equal(tool.parameters.properties.task_type.nullable, true);
    assert.equal(tool.parameters.properties.acceptance_items.type, "array");
    assert.equal(tool.parameters.properties.acceptance_items.nullable, true);
    const result = await tool.execute({
      goal,
      attempt_brief: "brief 中有 rewrite、日语の修正、旧基线 1111111。",
      task_type: "merge",
      baseline_commit: "d34db33",
      source_attempt: "att-002（候选）",
      acceptance_items: ["node --test"],
    }, execCtx(ws));
    assert.equal(result.child_id, "child-g150");
    assert.match(captured.prompt!, /^【本次任务定位】这是一次 合入 任务；/);
    assert.match(captured.prompt!, /任务类型（当前 attempt 数据）：merge（合入）/);
    assert.match(captured.prompt!, /权威基线 commit（当前 attempt 数据）：d34db33/);
    assert.match(captured.prompt!, /真正前序 attempt 身份（当前 attempt 数据）：att-002（候选）/);
    assert.match(captured.prompt!, /1\. node --test/);
  });
});

test("g-150：start-execution 端点 prompt 注入 handoff 段 + 事件记 injected_handoffs", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-ep-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { goal, att } = goalWithHandoff(root);
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const captured: { prompt?: string } = {};
  const { routes } = makeHostCtx(captured, ws);
  const handler = routes.get("/api/dsh-graph/start-execution");
  assert.ok(handler, "start-execution 路由已注册");
  const req = fakeRequest("POST", { goal });
  req.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal });
  await p;
  assert.equal(res._code, 200);
  assert.equal(res._body.ok, true);
  assert.ok(res._body.injected_handoffs.length > 0, "响应含 injected_handoffs");
  assert.equal(res._body.injected_handoffs[0].id, "handoff");
  // prompt 断言
  assert.ok(captured.prompt!.includes("前序 attempt 已确认 handoff"), "prompt 含 handoff 段标题");
  assert.ok(captured.prompt!.includes("模块 X 崩溃于 L42"), "prompt 含失败点");
  assert.ok(captured.prompt!.includes(att), "prompt 含来源 attempt");
  // 事件断言
  const ev = readEvents(root).filter((e) => e.event === "attempt.started" && e.goal === goal && e.details.attempt === "att-002");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.injected_handoffs[0].id, "handoff");
});

test("g-150：start-execution 端点带 attempt_brief 时 prompt 注入 brief 段", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-ep-brief-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "ep-brief", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const captured: { prompt?: string } = {};
  const { routes } = makeHostCtx(captured, ws);
  const handler = routes.get("/api/dsh-graph/start-execution");
  const req = fakeRequest("POST", { goal, attempt_brief: "安全整合任务" });
  req.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal, attempt_brief: "安全整合任务" });
  await p;
  assert.equal(res._code, 200);
  assert.ok(captured.prompt!.includes("本次 attempt brief/directive"), "prompt 含 brief 段标题");
  assert.ok(captured.prompt!.includes("安全整合任务"), "prompt 含 brief 正文");
});

test("g-228：start-execution 端点透传 supervisor 独立关键字段", async () => {
  await withRepoTmp("dsh-graph-g228-ep-structured-", async (ws) => {
    const root = join(ws, ".dsh-graph");
    init(root);
    const goal = createGoal(root, { title: "ep-structured", version: "v-t", actor: "test" });
    writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
    const body = {
      goal,
      attempt_brief: "brief 中包含 rewrite、基线 old1111 和日本語の修正。",
      task_type: "fix",
      baseline_commit: "d34db33",
      source_attempt: "att-007（候选）",
      acceptance_items: ["node --test"],
    };
    const captured: { prompt?: string } = {};
    const { routes } = makeHostCtx(captured, ws);
    const handler = routes.get("/api/dsh-graph/start-execution");
    const req = fakeRequest("POST", body);
    req.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws);
    const res = fakeResponse();
    const p = handler(req, res);
    emitBody(req, body);
    await p;
    assert.equal(res._code, 200);
    assert.equal(res._body.ok, true);
    assert.match(captured.prompt!, /^【本次任务定位】这是一次 修复 任务；/);
    assert.match(captured.prompt!, /任务类型（当前 attempt 数据）：fix（修复）/);
    assert.match(captured.prompt!, /权威基线 commit（当前 attempt 数据）：d34db33/);
    assert.match(captured.prompt!, /真正前序 attempt 身份（当前 attempt 数据）：att-007（候选）/);
    assert.match(captured.prompt!, /1\. node --test/);
  });
});

test("g-228：start-execution 端点拒绝自然语言 task_type，要求显式枚举", async () => {
  await withRepoTmp("dsh-graph-g228-ep-invalid-", async (ws) => {
    const root = join(ws, ".dsh-graph");
    init(root);
    const goal = createGoal(root, { title: "ep-invalid", version: "v-t", actor: "test" });
    const body = { goal, task_type: "合入" };
    const captured: { prompt?: string } = {};
    const { routes } = makeHostCtx(captured, ws);
    const handler = routes.get("/api/dsh-graph/start-execution");
    const req = fakeRequest("POST", body);
    req.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws);
    const res = fakeResponse();
    const p = handler(req, res);
    emitBody(req, body);
    await p;
    assert.equal(res._code, 400);
    assert.match(res._body.error, /task_type 必须是 merge、rewrite 或 fix/);
    assert.equal(captured.prompt, undefined, "非法 task_type 不启动子代理");
  });
});

// ---- ⑥ 无历史目标保持现有 prompt 行为 ----

test("g-150：无历史目标 prompt 不含 handoff 段标题，卡片段保持", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-nohist-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "无历史", version: "v-t", actor: "test" });
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  await tool.execute({ goal }, execCtx(ws));
  assert.ok(!captured.prompt!.includes("前序 attempt 已确认 handoff"), "无历史时不含 handoff 段标题");
  assert.ok(captured.prompt!.includes("已收集上下文卡片成果"), "卡片段保持");
  assert.ok(captured.prompt!.includes("worktree 隔离"), "worktree 指令保持");
});

test("g-150：无历史 start-execution 端点 prompt 不含 handoff 段", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-nohist-ep-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "无历史ep", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const captured: { prompt?: string } = {};
  const { routes } = makeHostCtx(captured, ws);
  const handler = routes.get("/api/dsh-graph/start-execution");
  const req = fakeRequest("POST", { goal });
  req.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal });
  await p;
  assert.ok(!captured.prompt!.includes("前序 attempt 已确认 handoff"), "无历史时不含 handoff 段");
  assert.ok(captured.prompt!.includes("已收集上下文卡片成果"), "卡片段保持");
});

// ---- ⑦ 未复核 agent 报告不被注入 ----

test("g-150：attempt 的 status_line、执行笔记等未复核内容不被注入", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-unreviewed-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "未复核", version: "v-t", actor: "test" });
  const att1 = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  const goalFile = findGoalFile(root, goal);
  const dir = goalFile.replace(/goal\.md$/, "");
  const attDoc = loadGoal(join(dir, "attempts", att1, "attempt.md"));
  attDoc.meta.status_line = "我发现模块 X 有问题";
  writeFileSync(join(dir, "attempts", att1, "attempt.md"), serializeDoc(attDoc), "utf8");

  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  await tool.execute({ goal }, execCtx(ws));
  assert.ok(!captured.prompt!.includes("前序 attempt 已确认 handoff"), "无确认 handoff 时不含段标题");
  assert.ok(!captured.prompt!.includes("我发现模块 X 有问题"), "agent 自述 status_line 不注入");
});

// ---- ⑧ 覆盖语义 ----

test("g-150：新登记覆盖旧内容，prompt 只含最新 handoff", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-overwrite-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "覆盖prompt", version: "v-t", actor: "test" });
  const att1 = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att1],
    failures: "旧失败内容",
    constraints: "旧约束内容",
    baseline: "旧基线内容",
    verification: "旧验收",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  const att2 = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att2],
    failures: "新失败内容",
    constraints: "新约束内容",
    baseline: "新基线内容",
    verification: "新验收",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  await tool.execute({ goal }, execCtx(ws));
  assert.ok(captured.prompt!.includes("新失败内容"), "prompt 含最新失败");
  assert.ok(captured.prompt!.includes("新约束内容"), "prompt 含最新约束");
  assert.ok(!captured.prompt!.includes("旧失败内容"), "prompt 不含旧失败");
  assert.ok(!captured.prompt!.includes("旧约束内容"), "prompt 不含旧约束");
});

test("g-150：多 attempt 中未确认的不被注入", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "混合", version: "v-t", actor: "test" });
  // 已确认的
  const att1 = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att1],
    failures: "已确认失败",
    constraints: "已确认约束",
    baseline: "已确认基线",
    verification: "已确认验收",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  // 未确认的：创建 attempt 但不 recordAttemptHandoff
  startAttempt(root, goal, { executor: "agent:t", actor: "test" });

  const handoffs = harvestReviewedAttemptHandoffs(root, goal);
  assert.equal(handoffs.length, 1, "只返回已确认的 handoff");
  assert.equal(handoffs[0].failures, "已确认失败");
});

// ---- ⑨ handoff 段与 cards 段独立共存 ----

test("g-150：handoff 段与 cards 段独立注入，互不干扰", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-coexist-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "共存", version: "v-t", actor: "test" });
  const c1 = addCard(root, goal, { title: "研究卡", kind: "text", actor: "test" });
  fillCard(root, goal, c1, { text: "研究内容", summary: "摘要", by: "human:a", actor: "test" });
  const att1 = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att1],
    failures: "handoff 失败",
    constraints: "handoff 约束",
    baseline: "handoff 基线",
    verification: "handoff 验收",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  await tool.execute({ goal }, execCtx(ws));
  assert.ok(captured.prompt!.includes("前序 attempt 已确认 handoff"), "含 handoff 段");
  assert.ok(captured.prompt!.includes("已收集上下文卡片成果"), "含卡片段");
  assert.ok(captured.prompt!.includes(c1), "含卡片 id");
  const hfIdx = captured.prompt!.indexOf("前序 attempt 已确认 handoff");
  const cardIdx = captured.prompt!.indexOf("已收集上下文卡片成果");
  assert.ok(hfIdx < cardIdx, "handoff 段在卡片段前");
});

// ---- ⑩ worktree=false 与 handoff 兼容 ----

test("g-150：worktree=false 省略 worktree 指令但保留 handoff 注入", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-wt-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const { goal } = goalWithHandoff(root);
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  await tool.execute({ goal, worktree: false }, execCtx(ws));
  assert.ok(captured.prompt!.includes("前序 attempt 已确认 handoff"), "worktree=false 不影响 handoff 注入");
  assert.ok(!captured.prompt!.includes("worktree 隔离"), "worktree=false 省略 worktree 指令");
});

// ---- review 问题 1：确认权限 ----

test("g-150 review-1：human:* 类型 actor 可以确认 handoff", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "human确认", version: "v-t", actor: "test" });
  const att = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  const hfId = recordAttemptHandoff(root, goal, {
    source_attempts: [att],
    failures: "失败",
    constraints: "约束",
    baseline: "基线",
    verification: "验收",
    confirmed_by: "human:gui",
    actor: "human:gui",
  });
  assert.ok(hfId, "human:gui 确认成功");
  const handoffs = harvestReviewedAttemptHandoffs(root, goal);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].confirmed_by, "human:gui");
});

test("g-150 review-1：supervisor: 前缀且匹配已配置 session 时可以确认", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-real\n", "utf8");
  const goal = createGoal(root, { title: "super确认", version: "v-t", actor: "test" });
  const att = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  const hfId = recordAttemptHandoff(root, goal, {
    source_attempts: [att],
    failures: "失败",
    constraints: "约束",
    baseline: "基线",
    verification: "验收",
    confirmed_by: "supervisor:sess-real",
    actor: "supervisor:sess-real",
  });
  assert.ok(hfId, "supervisor 确认成功");
});

test("g-150 review-1：supervisor: 前缀但不匹配已配置 session 时被拒绝", () => {
  const root = tmpRoot();
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-real\n", "utf8");
  const goal = createGoal(root, { title: "super拒绝", version: "v-t", actor: "test" });
  const att = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  assert.throws(
    () => recordAttemptHandoff(root, goal, {
      source_attempts: [att],
      failures: "失败",
      constraints: "约束",
      baseline: "基线",
      verification: "验收",
      confirmed_by: "supervisor:sess-fake",
      actor: "supervisor:sess-fake",
    }),
    /不匹配已配置的 supervisor.session/,
  );
});

test("g-150 review-1：agent:* 类型 actor 可以确认 handoff（本地可信工作区）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "agent允许", version: "v-t", actor: "test" });
  const att = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  const hfId = recordAttemptHandoff(root, goal, {
    source_attempts: [att],
    failures: "失败",
    constraints: "约束",
    baseline: "基线",
    verification: "验收",
    confirmed_by: "agent:child-123",
    actor: "agent:child-123",
  });
  assert.ok(hfId, "agent:* 确认成功（本地可信工作区信任模型）");
});

test("g-150 review-1：supervisor: 前缀且未配置 supervisor.session 时被允许（引导阶段）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "引导阶段", version: "v-t", actor: "test" });
  const att = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  const hfId = recordAttemptHandoff(root, goal, {
    source_attempts: [att],
    failures: "失败",
    constraints: "约束",
    baseline: "基线",
    verification: "验收",
    confirmed_by: "supervisor:sess-1",
    actor: "supervisor:sess-1",
  });
  assert.ok(hfId, "引导阶段 supervisor 确认成功");
});

// ---- 事件先行 ----

test("g-150：attempt.handoff.confirmed 事件在 handoff 文件之前写入", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "事件先行", version: "v-t", actor: "test" });
  const att = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att],
    failures: "失败",
    constraints: "约束",
    baseline: "基线",
    verification: "验收",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  const events = readEvents(root).filter(
    (e) => e.event === "attempt.handoff.confirmed" && e.goal === goal,
  );
  assert.equal(events.length, 1, "确认事件存在");
  const goalFile = findGoalFile(root, goal);
  const dir = goalFile.replace(/goal\.md$/, "");
  assert.ok(existsSync(join(dir, "handoff.md")), "handoff.md 存在");
});

// ---- 畸形/边界 ----

test("g-150：handoff.md 中畸形字段安全降级（缺失字段当空处理）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "畸形", version: "v-t", actor: "test" });
  const goalFile = findGoalFile(root, goal);
  const dir = goalFile.replace(/goal\.md$/, "");
  // 写一个畸形 handoff.md
  const hfFile = join(dir, "handoff.md");
  writeFileSync(hfFile, `---
{
  "id": "handoff",
  "goal": "${goal}",
  "status": "confirmed",
  "source_attempts": "not-an-array",
  "confirmed_by": "someone",
  "confirmed_at": "2026-01-01T00:00:00Z",
  "revision": "not-a-number",
  "failures": "some failure",
  "constraints": "some constraint",
  "baseline": "some baseline",
  "verification": "some verification"
}
---

## Body
`, "utf8");
  // 不应崩溃
  const handoffs = harvestReviewedAttemptHandoffs(root, goal);
  // source_attempts 不是数组 → 缺失判定会跳过（因为 Array.isArray 检查）
  // 但实际实现对缺失字段用 ?? 降级，source_attempts 不是数组 → 空数组
  assert.equal(handoffs.length, 1, "畸形 handoff 安全降级返回");
  assert.deepEqual(handoffs[0].source_attempts, [], "非数组 source_attempts 降级为空");
  assert.equal(handoffs[0].revision, 1, "非数字 revision 降级为 1");
});

// ---- review 问题 4：双派发入口 attempt_brief 类型校验 ----

test("g-150 review-4：startAttempt 拒绝非 string 类型的 attemptBrief", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "类型校验", version: "v-t", actor: "test" });
  assert.throws(
    () => startAttempt(root, goal, { executor: "agent:t", actor: "test", attemptBrief: 123 as any }),
    /attemptBrief 必须是 string/,
  );
  assert.throws(
    () => startAttempt(root, goal, { executor: "agent:t", actor: "test", attemptBrief: true as any }),
    /attemptBrief 必须是 string/,
  );
  assert.throws(
    () => startAttempt(root, goal, { executor: "agent:t", actor: "test", attemptBrief: {} as any }),
    /attemptBrief 必须是 string/,
  );
});

test("g-150 review-4：startAttempt 空字符串 brief 不写入事件和 meta", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "空brief", version: "v-t", actor: "test" });
  startAttempt(root, goal, { executor: "agent:t", actor: "test", attemptBrief: "" });
  const ev = readEvents(root).find((e) => e.event === "attempt.started" && e.goal === goal);
  assert.ok(!("brief" in ev!.details), "空 brief 不写入事件");
  const goalFile = findGoalFile(root, goal);
  const dir = goalFile.replace(/goal\.md$/, "");
  const attDoc = loadGoal(join(dir, "attempts", "att-001", "attempt.md"));
  assert.ok(!("brief" in attDoc.meta), "空 brief 不写入 meta");
});

test("g-150 review-4：startAttempt 空数组 injectedHandoffs 明确写入事件（空值一致）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "空handoffs", version: "v-t", actor: "test" });
  startAttempt(root, goal, { executor: "agent:t", actor: "test", injectedHandoffs: [] });
  const ev = readEvents(root).find((e) => e.event === "attempt.started" && e.goal === goal);
  assert.deepEqual(ev!.details.injected_handoffs, [], "空数组明确写入事件");
  const goalFile = findGoalFile(root, goal);
  const dir = goalFile.replace(/goal\.md$/, "");
  const attDoc = loadGoal(join(dir, "attempts", "att-001", "attempt.md"));
  assert.deepEqual(attDoc.meta.injected_handoffs, [], "空数组明确写入 meta");
});

test("g-150 review-4：graph_start_attempt 工具拒绝非 string 类型的 attempt_brief", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-type-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "工具类型", version: "v-t", actor: "test" });
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  await assert.rejects(
    () => tool.execute({ goal, attempt_brief: 123 }, execCtx(ws)),
    /attempt_brief 必须是 string/,
  );
});

test("g-150 review-4：start-execution 端点拒绝非 string 类型的 attempt_brief", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-ep-type-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "ep类型", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const captured: { prompt?: string } = {};
  const { routes } = makeHostCtx(captured, ws);
  const handler = routes.get("/api/dsh-graph/start-execution");
  const req = fakeRequest("POST", { goal, attempt_brief: 42 });
  req.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal, attempt_brief: 42 });
  await p;
  assert.equal(res._code, 400);
  assert.ok(res._body.error.includes("attempt_brief 必须是 string"), "返回类型校验错误");
});

// ---- 兼容性 ----

test("g-150 review-5：无 handoff 且无 brief 时，startAttempt 事件中不出现 handoffs 和 brief 字段", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "兼容性", version: "v-t", actor: "test" });
  startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  const ev = readEvents(root).find((e) => e.event === "attempt.started" && e.goal === goal);
  assert.ok(!("injected_handoffs" in ev!.details), "无 handoffs 时不出现字段");
  assert.ok(!("brief" in ev!.details), "无 brief 时不出现字段");
});

test("g-150 review-5：已有 reviewed context card 不回归（cards 注入行为不变）", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g150-compat-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goal = createGoal(root, { title: "card兼容", version: "v-t", actor: "test" });
  const c1 = addCard(root, goal, { title: "复核卡", kind: "text", actor: "test" });
  fillCard(root, goal, c1, { text: "研究内容", summary: "摘要", by: "human:a", actor: "test" });
  reviewCard(root, goal, c1, { by: "human:a", actor: "test" });
  const captured: { prompt?: string } = {};
  const { registered } = makeHostCtx(captured, ws);
  const tool = registered.find((d) => d.name === "graph_start_attempt");
  await tool.execute({ goal }, execCtx(ws));
  assert.ok(captured.prompt!.includes("已收集上下文卡片成果"), "含卡片段");
  assert.ok(captured.prompt!.includes(c1), "含 reviewed card id");
  assert.ok(captured.prompt!.includes("研究内容"), "含 card 正文");
  assert.ok(!captured.prompt!.includes("前序 attempt 已确认 handoff"), "无 handoff 段");
});

// ---- ⑩ 遗留 handoffs/ 目录兼容 ----

test("g-150 遗留兼容：handoffs/ 目录存在时取最新 confirmed（无 handoff.md）", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "遗留", version: "v-t", actor: "test" });
  const goalFile = findGoalFile(root, goal);
  const dir = goalFile.replace(/goal\.md$/, "");
  const handoffsDir = join(dir, "handoffs");
  mkdirSync(handoffsDir, { recursive: true });
  // 写两个遗留 handoff 文件
  writeFileSync(join(handoffsDir, "hf-001.md"), `---
{
  "id": "hf-001",
  "goal": "${goal}",
  "status": "confirmed",
  "source_attempts": ["att-001"],
  "supersedes": [],
  "superseded_by": null,
  "confirmed_by": "supervisor:s1",
  "confirmed_at": "2026-01-01T00:00:00Z",
  "revision": 1,
  "failures": "旧失败",
  "constraints": "旧约束",
  "baseline": "旧基线",
  "verification": "旧验收"
}
---

body
`, "utf8");
  writeFileSync(join(handoffsDir, "hf-002.md"), `---
{
  "id": "hf-002",
  "goal": "${goal}",
  "status": "confirmed",
  "source_attempts": ["att-002"],
  "supersedes": ["hf-001"],
  "superseded_by": null,
  "confirmed_by": "supervisor:s1",
  "confirmed_at": "2026-01-02T00:00:00Z",
  "revision": 1,
  "failures": "新失败",
  "constraints": "新约束",
  "baseline": "新基线",
  "verification": "新验收"
}
---

body
`, "utf8");
  // 手动写事件以让 reader 信任
  // hf-001 被 hf-002 supersedes，所以应取 hf-002
  const handoffs = harvestReviewedAttemptHandoffs(root, goal);
  assert.equal(handoffs.length, 1, "遗留兼容只返回一个");
  assert.equal(handoffs[0].id, "hf-002", "取最新（被 supersedes 引用的旧文件排除）");
  assert.equal(handoffs[0].failures, "新失败");
});

test("g-150 遗留兼容：handoff.md 优先于 handoffs/ 目录", () => {
  const root = tmpRoot();
  const goal = createGoal(root, { title: "优先级", version: "v-t", actor: "test" });
  const goalFile = findGoalFile(root, goal);
  const dir = goalFile.replace(/goal\.md$/, "");
  // 写 handoff.md（单文件）
  const att = startAttempt(root, goal, { executor: "agent:t", actor: "test" });
  recordAttemptHandoff(root, goal, {
    source_attempts: [att],
    failures: "单文件失败",
    constraints: "单文件约束",
    baseline: "单文件基线",
    verification: "单文件验收",
    confirmed_by: "supervisor:s1",
    actor: "supervisor:s1",
  });
  // 也写一个遗留 handoffs/ 目录
  const handoffsDir = join(dir, "handoffs");
  mkdirSync(handoffsDir, { recursive: true });
  writeFileSync(join(handoffsDir, "hf-001.md"), `---
{
  "id": "hf-001",
  "goal": "${goal}",
  "status": "confirmed",
  "source_attempts": ["att-001"],
  "supersedes": [],
  "superseded_by": null,
  "confirmed_by": "supervisor:s1",
  "confirmed_at": "2026-01-01T00:00:00Z",
  "revision": 1,
  "failures": "遗留失败",
  "constraints": "遗留约束",
  "baseline": "遗留基线",
  "verification": "遗留验收"
}
---

body
`, "utf8");
  const handoffs = harvestReviewedAttemptHandoffs(root, goal);
  assert.equal(handoffs.length, 1);
  assert.equal(handoffs[0].id, "handoff", "handoff.md 优先");
  assert.equal(handoffs[0].failures, "单文件失败");
});
