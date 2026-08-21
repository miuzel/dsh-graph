/** dsh-graph-client host 半边（/api/dsh-graph 写端点）冒烟测试：g-109。
 *  mock webServer/ctx，无 subagents 服务 → 验证降级路径（attempt 本地创建、child_error 上报、
 *  卡片不误翻 collecting）；有 body 的 POST 走 readBody + 事件先行断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { init, createGoal, findGoalFile, loadGoal } from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dsh-graph-client/index.js";

function fakeRequest(method: string, body: unknown) {
  const req: any = {
    method,
    _listeners: {} as Record<string, (v?: any) => void>,
    on(ev: string, cb: (v?: any) => void) {
      req._listeners[ev] = cb;
    },
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

function setup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-client-"));
  init(root);
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  const routes = new Map<string, any>();
  const ctx: any = {
    get: () => undefined, // 无 subagents/agents 服务 → 降级分支
    effect: (fn: () => unknown) => fn(),
    webServer: {
      register: (def: any) => {
        routes.set(def.path, def.handler);
        return () => {};
      },
    },
  };
  apply(ctx, { root });
  return { root, routes, goalId };
}

const post = async (routes: Map<string, any>, path: string, body: unknown) => {
  const handler = routes.get(path);
  assert.ok(handler, `路由 ${path} 已注册`);
  const req = fakeRequest("POST", body);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, body);
  await p;
  return { code: res._code, body: res._body };
};

test("g-109 写端点全部注册（accept/edit-description/add-card/start-collection）", () => {
  const { routes } = setup();
  for (const p of ["/api/dsh-graph/accept", "/api/dsh-graph/resolve-accept",
    "/api/dsh-graph/edit-description", "/api/dsh-graph/add-card",
    "/api/dsh-graph/start-collection", "/api/dsh-graph/start-execution"]) {
    assert.ok(routes.has(p), `${p} 已注册`);
  }
});

test("add-card：建卡 + card.created 事件（事件先行）", async () => {
  const { root, routes, goalId } = setup();
  const goalFile = findGoalFile(root, goalId);
  const { code, body } = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "调研 A", kind: "text" });
  assert.equal(code, 200);
  assert.equal(body.ok, true);
  assert.ok(typeof body.card === "string");
  const ev = readEvents(root).filter((e) => e.event === "card.created");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.title, "调研 A");
  // 目标 frontmatter 引用卡片
  const doc = loadGoal(goalFile);
  assert.ok((doc.meta.context_cards ?? []).includes(body.card));
});

test("start-collection 无 subagents：attempt 本地创建、child_error 上报、卡片不误翻 collecting", async () => {
  const { root, routes, goalId } = setup();
  const goalFile = findGoalFile(root, goalId);
  const { body } = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "c", kind: "text" });
  const card = body.card;
  const r = await post(routes, "/api/dsh-graph/start-collection", { goal: goalId, card });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.attempt.startsWith("att-"));
  assert.equal(r.body.child_id, null);
  assert.ok(typeof r.body.child_error === "string");
  // attempt.started 已记（事件先行），卡片保持 empty（未派发成功不得翻 collecting）
  const events = readEvents(root);
  assert.ok(events.some((e) => e.event === "attempt.started" && e.goal === goalId));
  assert.ok(!events.some((e) => e.event === "card.collecting"));
  const cardFile = join(dirname(goalFile), "cards", `${card}.md`);
  assert.equal(loadGoal(cardFile).meta.status, "empty");
});

test("accept（非 force）：写 review.requested 事件", async () => {
  const { root, routes, goalId } = setup();
  const r = await post(routes, "/api/dsh-graph/accept", { goal: goalId });
  assert.equal(r.code, 200);
  assert.equal(r.body.pending, true);
  const ev = readEvents(root).filter((e) => e.event === "review.requested");
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.targetStage, "draft");
});

test("edit-description：改目标描述 + goal.amended 事件", async () => {
  const { root, routes, goalId } = setup();
  const r = await post(routes, "/api/dsh-graph/edit-description",
    { goal: goalId, text: "新描述内容" });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  const doc = loadGoal(findGoalFile(root, goalId));
  assert.ok(doc.body.includes("新描述内容"));
  const ev = readEvents(root).filter((e) => e.event === "goal.amended");
  assert.ok(ev.length >= 1);
});

test("spawn-options：无 llm 服务时容错返回（重新执行选择器数据源）", async () => {
  const { routes } = setup();
  const handler = routes.get("/api/dsh-graph/spawn-options");
  assert.ok(handler, "spawn-options 路由已注册");
  const res = fakeResponse();
  await handler({ method: "GET", on: () => {} }, res);
  assert.equal(res._code, 200);
  // modelGroups 无 llm 服务 → null；default 读 project.yaml（temp root 无 → null）
  assert.equal(res._body.modelGroups, null);
  assert.deepEqual(res._body.default, { provider: null, model: null });
});

test("start-execution 无 subagents：attempt 本地创建、child_error 上报（带 provider/model 参数不炸）", async () => {
  const { root, routes, goalId } = setup();
  const r = await post(routes, "/api/dsh-graph/start-execution",
    { goal: goalId, provider: "spawn", model: "deepseek-v4-flash" });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.body.attempt.startsWith("att-"));
  assert.equal(r.body.child_id, null);
  assert.ok(typeof r.body.child_error === "string");
  const events = readEvents(root);
  assert.ok(events.some((e) => e.event === "attempt.started" && e.goal === goalId));
});
