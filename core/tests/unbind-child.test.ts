/** g-190：从目标解绑执行子代理（unbindGoalChild）核心 + host 工具 + REST 端点测试。
 *  覆盖：权限（主管/owner/child 自解绑拒绝）、活跃/非活跃 child（running 拒绝/idle/gone 允许/unknown 拒绝）、
 *  并发/重复（token CAS、ABA、幂等、selector 冲突）、事件先行与审计（token_hash/binding_version）、
 *  重绑（新 token 旧 token 失效）、清理边界（delivered/archived 拒绝、解绑后可暂缓）、
 *  REST 严格 schema（未知字段/坏 JSON/缺 token/双 selector/409），工具注册 additionalProperties=false。 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import {
  init,
  createGoal,
  startAttempt,
  bindAttemptChild,
  unbindGoalChild,
  readGoalBinding,
  authorizeUnbind,
  findGoalFile,
  loadGoal,
  saveGoal,
  postponeGoal,
  archiveGoal,
  boardProjection,
  goalDetail,
  GraphError,
  GraphConflictError,
  writeSupervisorSession,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dsh-graph-host/index.js";

/** 临时图根 + mock ctx 应用插件，返回 { root, byName }。agents 可注入（live registry mock）。 */
function setup(agents?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-unbind-"));
  init(root);
  const registered: any[] = [];
  const ctx: any = {
    get: (name: string) => (name === "agents" ? { get: (id: string) => agents?.[id] } : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
    effect: (fn: () => unknown) => fn(),
    tools: {
      register: (def: any) => { registered.push(def); return () => {}; },
      get: () => ({}),
    },
  };
  apply(ctx, { root });
  return { root, byName: new Map(registered.map((d) => [d.name, d])) };
}

const exec = (sessionId?: string) => ({
  agent: sessionId ? { id: "a1", session: { id: sessionId } } : undefined,
  signal: new AbortController().signal,
});

const unboundEvents = (root: string, goal: string) =>
  readEvents(root).filter((e) => e.event === "attempt.unbound" && e.goal === goal);

const attemptMeta = (root: string, goal: string, att: string) => {
  const goalFile = findGoalFile(root, goal)!;
  const f = join(dirname(goalFile), "attempts", att, "attempt.md");
  return loadGoal(f).meta;
};

/** 建一个绑定好执行子代理的目标（human:gui 创建，版本泳道 → planning）。 */
function boundGoal(root: string, actor = "human:gui") {
  const goal = createGoal(root, { title: "t", version: "v-t", actor });
  const att = startAttempt(root, goal, { executor: "agent:exec-1", actor });
  bindAttemptChild(root, goal, att, "child-1", actor, "session-parent");
  return { goal, attempt: att };
}

const gone: any = () => "gone";

// ---- 核心层 ----

test("g-190 ① bind 生成 binding token + binding_version，bound 事件含版本", () => {
  const { root } = setup();
  const { goal, attempt } = boundGoal(root);
  const m = attemptMeta(root, goal, attempt);
  assert.ok(typeof m.binding_token === "string" && m.binding_token.length >= 32, "binding_token 应存在且足够随机");
  assert.equal(m.binding_version, 1);
  const ev = readEvents(root).find((e) => e.event === "attempt.bound" && e.goal === goal)!;
  assert.equal(ev.details.binding_version, 1);
  const b = readGoalBinding(root, goal)!;
  assert.equal(b.attempt, attempt);
  assert.equal(b.child_id, "child-1");
  assert.equal(b.binding_token, m.binding_token);
});

test("g-190 ② owner 解绑成功：清绑定 + detached 标记 + 事件先行（token_hash/version/reason 审计）", () => {
  const { root } = setup();
  const { goal, attempt } = boundGoal(root);
  const token = attemptMeta(root, goal, attempt).binding_token;
  const r = unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, reason: "任务完成需暂缓", liveCheck: gone });
  assert.equal(r.detached, true);
  assert.equal(r.attempt, attempt);
  assert.equal(r.child_id, "child-1");
  const m = attemptMeta(root, goal, attempt);
  assert.equal(m.child_id ?? null, null, "child_id 应被清除");
  assert.equal(m.binding_token ?? null, null, "binding_token 应被清除");
  assert.equal(m.detached, true);
  assert.equal(m.result, "detached");
  assert.equal(m.detached_by, "human:gui");
  assert.ok(m.detached_at);
  assert.equal(m.binding_version, 2, "解绑后 binding_version 递增");
  // 事件先行 + 审计
  const evs = unboundEvents(root, goal);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].actor, "human:gui");
  assert.equal(evs[0].details.attempt, attempt);
  assert.equal(evs[0].details.child_id, "child-1");
  assert.equal(evs[0].details.binding_version, 1);
  assert.equal(evs[0].details.token_hash, createHash("sha256").update(token).digest("hex"));
  assert.equal(evs[0].details.reason, "任务完成需暂缓");
  // 投影一致性：board 不再有 attempt_binding；readGoalBinding 为 null
  assert.equal(readGoalBinding(root, goal), null);
  const g = boardProjection(root).versions.flatMap((v) => v.goals).find((x) => x.id === goal)!;
  assert.equal(g.attempt_binding, null);
  assert.equal(g.attempt_child_id, null);
});

test("g-190 ③ 重复解绑幂等：no-op 不重复记事件", () => {
  const { root } = setup();
  const { goal, attempt } = boundGoal(root);
  const token = attemptMeta(root, goal, attempt).binding_token;
  unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: gone });
  const again = unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: gone });
  assert.deepEqual(again, { detached: false, already: true });
  assert.equal(unboundEvents(root, goal).length, 1, "重复解绑不重复记事件");
});

test("g-190 ④ token 未知/过期拒绝且不改数据（含 ABA：重绑后旧 token 失效）", () => {
  const { root } = setup();
  const { goal, attempt } = boundGoal(root);
  const token = attemptMeta(root, goal, attempt).binding_token;
  // 未知 token
  assert.throws(
    () => unbindGoalChild(root, goal, { actor: "human:gui", token: "deadbeef", attempt, liveCheck: gone }),
    GraphConflictError,
  );
  // 未改动数据
  const m = attemptMeta(root, goal, attempt);
  assert.equal(m.child_id, "child-1");
  assert.equal(unboundEvents(root, goal).length, 0);
  // 解绑 → 重绑（新 token）→ 旧 token 必须失效（ABA 防护）
  unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: gone });
  bindAttemptChild(root, goal, attempt, "child-2", "human:gui", "session-parent");
  const newToken = attemptMeta(root, goal, attempt).binding_token;
  assert.notEqual(newToken, token, "重绑必须换新 token");
  assert.throws(
    () => unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: gone }),
    GraphConflictError,
    "旧 token 在重绑后必须拒绝",
  );
  assert.equal(attemptMeta(root, goal, attempt).child_id, "child-2", "旧 token 解绑不得改动数据");
});

test("g-190 ⑤ selector：双指定/缺省/不匹配均拒绝", () => {
  const { root } = setup();
  const { goal, attempt } = boundGoal(root);
  const token = attemptMeta(root, goal, attempt).binding_token;
  assert.throws(() => unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, childId: "child-1", liveCheck: gone }), GraphError, "双 selector 拒绝");
  assert.throws(() => unbindGoalChild(root, goal, { actor: "human:gui", token, liveCheck: gone }), GraphError, "缺 selector 拒绝");
  assert.throws(() => unbindGoalChild(root, goal, { actor: "human:gui", token, attempt: "att-999", liveCheck: gone }), GraphConflictError, "attempt 不匹配拒绝");
  assert.throws(() => unbindGoalChild(root, goal, { actor: "human:gui", token, childId: "child-other", liveCheck: gone }), GraphConflictError, "child_id 不匹配拒绝");
  // 用 child_id selector 成功
  const r = unbindGoalChild(root, goal, { actor: "human:gui", token, childId: "child-1", liveCheck: gone });
  assert.equal(r.detached, true);
});

test("g-190 ⑥ 授权：非 owner agent / child 自解绑拒绝；supervisor / owner / human 放行", () => {
  const { root } = setup();
  const { goal, attempt } = boundGoal(root);
  const token = attemptMeta(root, goal, attempt).binding_token;
  // child 自解绑拒绝
  assert.throws(() => unbindGoalChild(root, goal, { actor: "agent:child-1", token, attempt, liveCheck: gone }), GraphError);
  assert.throws(() => unbindGoalChild(root, goal, { actor: "child-1", token, attempt, liveCheck: gone }), GraphError);
  // 任意 agent 拒绝
  assert.throws(() => unbindGoalChild(root, goal, { actor: "agent:someone-else", token, attempt, liveCheck: gone }), GraphError);
  // human（GUI owner）放行
  assert.equal(unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: gone }).detached, true);

  // supervisor 会话放行（重新绑定后）
  bindAttemptChild(root, goal, attempt, "child-3", "human:gui", "session-parent");
  const t2 = attemptMeta(root, goal, attempt).binding_token;
  writeSupervisorSession(root, "sess-sup", "human:gui");
  const r2 = unbindGoalChild(root, goal, { actor: "supervisor:sess-sup", token: t2, attempt, liveCheck: gone });
  assert.equal(r2.detached, true);
  // 未匹配 supervisor.session 的 supervisor: 前缀拒绝
  bindAttemptChild(root, goal, attempt, "child-4", "human:gui", "session-parent");
  const t3 = attemptMeta(root, goal, attempt).binding_token;
  assert.throws(() => unbindGoalChild(root, goal, { actor: "supervisor:other-sess", token: t3, attempt, liveCheck: gone }), GraphError);
});

test("g-190 ⑦ 活跃状态门控：running 拒绝 / unknown 拒绝 / idle / gone 放行 / 无 liveCheck 且 pending 拒绝", () => {
  const { root } = setup();
  const mk = () => {
    const g = boundGoal(root);
    return { ...g, token: attemptMeta(root, g.goal, g.attempt).binding_token };
  };
  // running → 拒绝（GraphConflictError）
  {
    const { goal, attempt, token } = mk();
    assert.throws(() => unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: () => "running" }), GraphConflictError);
    assert.equal(attemptMeta(root, goal, attempt).child_id, "child-1", "running 拒绝不得改动");
  }
  // unknown → 拒绝
  {
    const { goal, attempt, token } = mk();
    assert.throws(() => unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: () => "unknown" }), GraphError);
  }
  // idle / gone → 放行
  {
    const { goal, attempt, token } = mk();
    assert.equal(unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: () => "idle" }).detached, true);
  }
  {
    const { goal, attempt, token } = mk();
    assert.equal(unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: () => "gone" }).detached, true);
  }
  // 无 liveCheck 且 pending → 拒绝（CLI 路径）
  {
    const { goal, attempt, token } = mk();
    assert.throws(() => unbindGoalChild(root, goal, { actor: "human:gui", token, attempt }), GraphError, "无 live check 的 pending 绑定应拒绝");
  }
  // 无 liveCheck 且 result 非 pending → 放行（结果态 attempt 可安全清理绑定）
  {
    const { goal, attempt, token } = mk();
    const goalFile = findGoalFile(root, goal)!;
    const attFile = join(dirname(goalFile), "attempts", attempt, "attempt.md");
    const doc = loadGoal(attFile);
    doc.meta.result = "done";
    saveGoal(attFile, doc);
    assert.equal(unbindGoalChild(root, goal, { actor: "human:gui", token, attempt }).detached, true);
  }
});

test("g-190 ⑧ 边界：delivered / archived 拒绝；解绑后目标可暂缓", () => {
  const { root } = setup();
  // delivered 拒绝
  {
    const { goal, attempt } = boundGoal(root);
    const token = attemptMeta(root, goal, attempt).binding_token;
    const goalFile = findGoalFile(root, goal)!;
    const doc = loadGoal(goalFile);
    doc.meta.status = "delivered";
    saveGoal(goalFile, doc);
    assert.throws(() => unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: gone }), GraphError);
  }
  // archived 拒绝
  {
    const { goal, attempt } = boundGoal(root);
    const token = attemptMeta(root, goal, attempt).binding_token;
    archiveGoal(root, goal, { actor: "human:gui" });
    assert.throws(() => unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: gone }), GraphError);
  }
  // 解绑前暂缓被拒（活跃绑定）；解绑后暂缓成功
  {
    const { goal, attempt } = boundGoal(root);
    const token = attemptMeta(root, goal, attempt).binding_token;
    assert.throws(() => postponeGoal(root, goal, { actor: "human:gui" }), GraphError, "绑定中不能暂缓");
    unbindGoalChild(root, goal, { actor: "human:gui", token, attempt, liveCheck: gone });
    postponeGoal(root, goal, { actor: "human:gui" });
    const g = boardProjection(root).backlog.find((x) => x.id === goal)!;
    assert.ok(g, "解绑后目标应可暂缓回 backlog");
    assert.equal(g.status, "draft");
  }
});

test("g-190 ⑨ goalDetail 下发绑定信息（token/version/detached）", () => {
  const { root } = setup();
  const { goal, attempt } = boundGoal(root);
  const m = attemptMeta(root, goal, attempt);
  const detail = goalDetail(root, goal);
  const a = detail.attempts.find((x: any) => x.id === attempt)!;
  assert.equal(a.binding_token, m.binding_token);
  assert.equal(a.binding_version, 1);
  assert.equal(a.detached, false);
  unbindGoalChild(root, goal, { actor: "human:gui", token: m.binding_token, attempt, liveCheck: gone });
  const d2 = goalDetail(root, goal);
  const a2 = d2.attempts.find((x: any) => x.id === attempt)!;
  assert.equal(a2.detached, true);
  assert.equal(a2.binding_token ?? null, null);
});

test("g-190 ⑩ authorizeUnbind 纯函数：未知前缀拒绝 / human 放行 / owner 放行 / supervisor 匹配", () => {
  const { root } = setup();
  writeSupervisorSession(root, "sess-sup", "human:gui");
  assert.throws(() => authorizeUnbind(root, "agent:x", "human:gui", "child-1"), GraphError);
  assert.throws(() => authorizeUnbind(root, "child-1", "human:gui", "child-1"), GraphError);
  authorizeUnbind(root, "human:gui", "human:gui", "child-1");
  authorizeUnbind(root, "supervisor:sess-sup", "human:gui", "child-1");
  authorizeUnbind(root, "agent:creator", "agent:creator", "child-1");
  assert.throws(() => authorizeUnbind(root, "supervisor:other", "human:gui", "child-1"), GraphError);
  assert.throws(() => authorizeUnbind(root, "", "human:gui", "child-1"), GraphError);
});

// ---- host 工具 ----

test("g-190 ⑪ 工具注册：graph_unbind_goal_child required=[goal,token]，additionalProperties=false", () => {
  const { byName } = setup();
  const t = byName.get("graph_unbind_goal_child");
  assert.ok(t, "应注册 graph_unbind_goal_child");
  assert.deepEqual(t.parameters.required, ["goal", "token"]);
  assert.equal(t.parameters.additionalProperties, false);
  for (const k of ["goal", "token", "attempt", "child_id", "reason"]) assert.ok(t.parameters.properties[k], "参数 " + k);
});

test("g-190 ⑫ 工具执行：supervisor 会话成功；agent 非 owner 拒绝；child 自解绑拒绝；双 selector 拒绝", async () => {
  const { root, byName } = setup({});
  const { goal, attempt } = boundGoal(root);
  const token = attemptMeta(root, goal, attempt).binding_token;
  const call = async (args: Record<string, unknown>, sid?: string) =>
    byName.get("graph_unbind_goal_child").execute(args, exec(sid));
  // child 自解绑拒绝
  await assert.rejects(() => call({ goal, token, attempt }, "child-1"));
  // 非 owner 普通 agent 拒绝
  await assert.rejects(() => call({ goal, token, attempt }, "some-other-session"));
  // 双 selector 拒绝
  await assert.rejects(() => call({ goal, token, attempt, child_id: "child-1" }, "sess-owner"));
  // supervisor 会话成功（claim 后）
  writeSupervisorSession(root, "sess-sup", "human:gui");
  const out = await call({ goal, token, attempt }, "sess-sup");
  assert.equal(out.ok, true);
  assert.equal(out.detached, true);
  assert.equal(attemptMeta(root, goal, attempt).detached, true);
  // 重复解绑幂等
  const again = await call({ goal, token, attempt }, "sess-sup");
  assert.equal(again.already, true);
});

// ---- REST 端点 ----

function fakeRequest(method: string, body: unknown) {
  const req: any = { method, _listeners: {} as Record<string, (v?: any) => void>,
    on(ev: string, cb: (v?: any) => void) { req._listeners[ev] = cb; } };
  return req;
}
function emitBody(req: any, body: unknown) {
  req._listeners.data?.(typeof body === "string" ? body : JSON.stringify(body));
  req._listeners.end?.();
}
function fakeResponse() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}
function restSetup() {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-unbind-rest-"));
  init(root);
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : name === "agents" ? { get: () => undefined } : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root });
  return { root, routes };
}
const post = async (routes: Map<string, any>, path: string, body: unknown) => {
  const handler = routes.get(path);
  assert.ok(handler, "路由 " + path + " 已注册");
  const req = fakeRequest("POST", body);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, body);
  await p;
  return { code: res._code, body: res._body };
};

test("g-190 ⑬ REST /api/dsh-graph/unbind：注册 + 成功 + schema 校验（未知字段/坏 JSON/缺 token/双 selector/409）", async () => {
  const { root, routes } = restSetup();
  const { goal, attempt } = boundGoal(root);
  const token = attemptMeta(root, goal, attempt).binding_token;
  // 成功（agents registry mock → gone → 放行）
  let r = await post(routes, "/api/dsh-graph/unbind", { goal, token, attempt, reason: "GUI 解绑" });
  assert.equal(r.code, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.detached, true);
  assert.equal(attemptMeta(root, goal, attempt).detached, true);
  // 幂等重复 → 200 already
  r = await post(routes, "/api/dsh-graph/unbind", { goal, token, attempt });
  assert.equal(r.code, 200);
  assert.equal(r.body.already, true);

  // 重新绑定 → 未知 token 409 且不改数据
  bindAttemptChild(root, goal, attempt, "child-9", "human:gui", "session-parent");
  const newToken = attemptMeta(root, goal, attempt).binding_token;
  r = await post(routes, "/api/dsh-graph/unbind", { goal, token: "wrong-token", attempt });
  assert.equal(r.code, 409, "错误 token 应 409");
  r = await post(routes, "/api/dsh-graph/unbind", { goal, token: newToken, attempt, extra_field: 1 });
  assert.equal(r.code, 400, "未知字段应 400");
  assert.ok(r.body.error, "schema 错误有 message");
  // 坏 JSON → 400 非 500
  r = await post(routes, "/api/dsh-graph/unbind", "{ bad json !!!");
  assert.equal(r.code, 400, "坏 JSON 应 400 而非 500");
  assert.ok(String(r.body.error).includes("JSON"));
  // 缺 token → 400
  r = await post(routes, "/api/dsh-graph/unbind", { goal, attempt });
  assert.equal(r.code, 400);
  // 双 selector → 400
  r = await post(routes, "/api/dsh-graph/unbind", { goal, token: newToken, attempt, child_id: "child-9" });
  assert.equal(r.code, 400);
});

test("g-190 ⑭ REST：running live registry → 409；unknown registry → 400", async () => {
  // running：agents.get 返回 { running: true }
  {
    const root = mkdtempSync(join(tmpdir(), "dsh-graph-unbind-run-"));
    init(root);
    const routes = new Map<string, any>();
    const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
    const ctx: any = {
      get: (name: string) => (name === "webServer" ? webServer : name === "agents" ? { get: () => ({ running: true }) } : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
      effect: (fn: () => unknown) => fn(),
      webServer,
      tools: { register: () => () => {}, get: () => ({}) },
    };
    apply(ctx, { root });
    const { goal, attempt } = boundGoal(root);
    const token = attemptMeta(root, goal, attempt).binding_token;
    const r = await post(routes, "/api/dsh-graph/unbind", { goal, token, attempt });
    assert.equal(r.code, 409, "运行中子代理应 409");
    assert.ok(String(r.body.error).includes("运行"), r.body.error);
    assert.equal(attemptMeta(root, goal, attempt).child_id, "child-1", "运行中拒绝不得改动");
  }
  // unknown：agents 服务缺失
  {
    const root = mkdtempSync(join(tmpdir(), "dsh-graph-unbind-unk-"));
    init(root);
    const routes = new Map<string, any>();
    const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
    const ctx: any = {
      get: (name: string) => (name === "webServer" ? webServer : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
      effect: (fn: () => unknown) => fn(),
      webServer,
      tools: { register: () => () => {}, get: () => ({}) },
    };
    apply(ctx, { root });
    const { goal, attempt } = boundGoal(root);
    const token = attemptMeta(root, goal, attempt).binding_token;
    const r = await post(routes, "/api/dsh-graph/unbind", { goal, token, attempt });
    assert.equal(r.code, 400, "registry 不可用应 400");
  }
});
