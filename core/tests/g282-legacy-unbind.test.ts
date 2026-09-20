/** g-282：遗留无 token 绑定受控解绑与放弃（unbindGoalChild legacy / abandonAttempt）核心 + host 工具 + REST 端点测试。
 *  质量判据：
 *  1. 为「binding_token 缺失的遗留绑定」提供受控解绑能力：授权主管/owner 显式声明 legacy 并给 reason 时可解绑，写 attempt.detached 事件且 details 含 legacy/actor/reason
 *  2. 新增 abandon attempt 能力：把陈旧 attempt 置 result=cancelled、detached=true 并记 attempt.abandoned 事件（含 reason/actor），使其不再被 attemptIsActive 判为活跃
 *  3. 不得削弱既有安全语义：token 存在时必须严格 CAS（错误/空 token 被拒且不改数据）、delivered/archived 目标禁解绑、live registry 显示 running 时禁解绑
 *  4. 用新能力对 g-184 完成「解绑 → 暂缓」：迁回 backlog/g-184/goal.md、status=draft，事件链完整（attempt.detached/abandoned + goal.postponed），graph_validate 不新增违规
 *  5. 新增测试覆盖：遗留无 token 解绑成功路径、错 token/无授权被拒、delivered 目标被拒、running 子代理被拒、以及解绑后目标可暂缓
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  startAttempt,
  bindAttemptChild,
  unbindGoalChild,
  abandonAttempt,
  postponeGoal,
  transition,
  findGoalFile,
  loadGoal,
  saveGoal,
  archiveGoal,
  GraphError,
  GraphConflictError,
  writeSupervisorSession,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";

function setup(agents?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-g282-"));
  init(root);
  const registered: any[] = [];
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "agents" ? { get: (id: string) => agents?.[id] } : name === "webServer" ? webServer : name === "sandboxPolicy" ? { workspaceRoot: root } : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: {
      register: (def: any) => { registered.push(def); return () => {}; },
      get: () => ({}),
    },
  };
  apply(ctx, { root });
  return { root, routes, byName: new Map(registered.map((d) => [d.name, d])) };
}

const exec = (sessionId?: string) => ({
  agent: sessionId ? { id: "a1", session: { id: sessionId } } : undefined,
  signal: new AbortController().signal,
});

const attemptMeta = (root: string, goal: string, att: string) => {
  const goalFile = findGoalFile(root, goal)!;
  const f = join(dirname(goalFile), "attempts", att, "attempt.md");
  return loadGoal(f).meta;
};

/** 构造一个具有现代 binding_token 的目标。 */
function modernBoundGoal(root: string, actor = "human:gui") {
  const goal = createGoal(root, { title: "modern target", version: "v0.11.0", actor });
  setCriteria(root, goal, ["质量判据通过"], actor);
  const att = startAttempt(root, goal, { executor: "agent:exec-1", actor });
  bindAttemptChild(root, goal, att, "child-modern-1", actor, "session-parent");
  return { goal, attempt: att, childId: "child-modern-1" };
}

/** 构造一个遗留绑定目标（模拟 g-184：无 binding_token、无 binding_version、result=pending、status_line 为工作状态）。 */
function legacyBoundGoal(root: string, actor = "human:gui") {
  const goal = createGoal(root, { title: "legacy target", version: "v0.11.0", actor });
  setCriteria(root, goal, ["质量判据通过"], actor);
  const att = startAttempt(root, goal, { executor: "agent:exec-1", actor });
  const goalFile = findGoalFile(root, goal)!;
  const f = join(dirname(goalFile), "attempts", att, "attempt.md");
  const doc = loadGoal(f);
  doc.meta.child_id = "child-legacy-1";
  doc.meta.parent_session_id = "session-legacy-parent";
  doc.meta.status_line = "已覆盖generic后台Bash泄露+terminal补name，测试480通过";
  doc.meta.result = "pending";
  delete doc.meta.binding_token;
  delete doc.meta.binding_version;
  delete doc.meta.detached;
  saveGoal(f, doc);
  return { goal, attempt: att, childId: "child-legacy-1" };
}

const gone: any = () => "gone";
const running: any = () => "running";
const unknownState: any = () => "unknown";

function fakeRequest(method: string, body: unknown) {
  const req: any = { method, _listeners: {} as Record<string, (v?: any) => void>,
    on(ev: string, cb: (v?: any) => void) { req._listeners[ev] = cb; } };
  return req;
}
function fakeResponse() {
  const res: any = { code: 200, headers: {}, body: null,
    writeHead(code: number, headers: any) { res.code = code; res.headers = headers; },
    end(payload: string) { res.body = JSON.parse(payload); } };
  return res;
}
async function post(routes: Map<string, any>, path: string, body: unknown) {
  const h = routes.get(path);
  assert.ok(h, "端点未注册: " + path);
  const req = fakeRequest("POST", body);
  const res = fakeResponse();
  const p = h(req, res);
  req._listeners.data?.(Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
  req._listeners.end?.();
  await p;
  return res;
}

// --------------------------------------------------------------------------
// 判据 1 & 5：遗留无 token 解绑成功路径
// --------------------------------------------------------------------------

test("g-282 判据1/5：遗留无 token 绑定受控解绑成功，写 attempt.detached 事件（含 legacy/actor/reason）", () => {
  const { root } = setup();
  const { goal, attempt, childId } = legacyBoundGoal(root);

  // 验证初始状态：确实无 token
  const initialMeta = attemptMeta(root, goal, attempt);
  assert.equal(initialMeta.binding_token, undefined);
  assert.equal(initialMeta.child_id, childId);
  assert.equal(initialMeta.result, "pending");

  // 执行 legacy 解绑
  const res = unbindGoalChild(root, goal, {
    actor: "human:gui",
    legacy: true,
    attempt,
    reason: "负责人要求解绑遗留子代理",
    liveCheck: gone,
  });

  assert.equal(res.detached, true);
  assert.equal(res.attempt, attempt);
  assert.equal(res.child_id, childId);

  // 验证 attempt.md 落盘
  const updatedMeta = attemptMeta(root, goal, attempt);
  assert.equal(updatedMeta.detached, true);
  assert.equal(updatedMeta.detached_by, "human:gui");
  assert.equal(updatedMeta.result, "detached");
  assert.equal(updatedMeta.child_id, undefined);
  assert.equal(updatedMeta.parent_session_id, undefined);
  assert.equal(updatedMeta.binding_token, undefined);

  // 验证事件先行：attempt.detached 存在且 details 包含完整审计字段
  const events = readEvents(root).filter((e) => e.goal === goal && e.event === "attempt.detached");
  assert.equal(events.length, 1);
  const evt = events[0];
  assert.equal(evt.actor, "human:gui");
  assert.equal(evt.details.attempt, attempt);
  assert.equal(evt.details.child_id, childId);
  assert.equal(evt.details.legacy, true);
  assert.equal(evt.details.reason, "负责人要求解绑遗留子代理");
  assert.equal(evt.details.actor, "human:gui");
  assert.equal(evt.details.previous_result, "pending");
  assert.ok(evt.details.detached_at);

  // 幂等重复解绑为 no-op
  const again = unbindGoalChild(root, goal, {
    actor: "human:gui",
    legacy: true,
    attempt,
    reason: "再次调用",
    liveCheck: gone,
  });
  assert.equal(again.already, true);
  assert.equal(again.detached, false);
});

// --------------------------------------------------------------------------
// 判据 3 & 5：错 token / 无授权被拒 / CAS 保护
// --------------------------------------------------------------------------

test("g-282 判据3/5：token 存在时必须严格 CAS；禁止用 legacy 绕过；错 token/空 token 被拒且不改数据", () => {
  const { root } = setup();
  const { goal, attempt, childId } = modernBoundGoal(root);
  const realToken = attemptMeta(root, goal, attempt).binding_token;
  assert.ok(realToken, "modern 目标拥有 token");

  // 1. 尝试用 legacy: true 绕过有 token 的绑定 -> 拒绝 TxCasError (GraphConflictError)
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "human:gui",
      legacy: true,
      attempt,
      reason: "试图绕过",
      liveCheck: gone,
    }),
    GraphConflictError,
    "绑定存在 token 时禁止使用 legacy 绕过",
  );
  assert.equal(attemptMeta(root, goal, attempt).child_id, childId, "数据未被修改");

  // 2. 传错 token -> 拒绝
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "human:gui",
      token: "wrong-token",
      attempt,
      liveCheck: gone,
    }),
    GraphConflictError,
    "错误 token 必须被拒",
  );
  assert.equal(attemptMeta(root, goal, attempt).child_id, childId, "数据未被修改");

  // 3. 空 token -> 拒绝
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "human:gui",
      token: "",
      attempt,
      liveCheck: gone,
    }),
    GraphError,
    "空 token 必须被拒",
  );
});

test("g-282 判据3/5：遗留无 token 绑定未声明 legacy 或缺少 reason 被拒", () => {
  const { root } = setup();
  const { goal, attempt, childId } = legacyBoundGoal(root);

  // 1. 未声明 legacy: true 且未传 token -> 报缺 token
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "human:gui",
      attempt,
      liveCheck: gone,
    }),
    GraphError,
    "未声明 legacy 时需要 token",
  );

  // 2. 未声明 legacy: true 但传了假 token -> CAS 拒绝
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "human:gui",
      token: "dummy-token",
      attempt,
      liveCheck: gone,
    }),
    GraphConflictError,
    "未声明 legacy 但传 token 必须 CAS 拒绝",
  );

  // 3. 声明了 legacy: true 但未传 reason -> 拒绝
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "human:gui",
      legacy: true,
      attempt,
      reason: "",
      liveCheck: gone,
    }),
    GraphError,
    "遗留解绑缺少 reason 必须拒绝",
  );

  assert.equal(attemptMeta(root, goal, attempt).child_id, childId, "数据未改动");
});

test("g-282 判据3/5：授权安全门控——非 owner/未配置主管/子代理自身均被拒", () => {
  const { root } = setup();
  const { goal, attempt, childId } = legacyBoundGoal(root);

  // 1. 未授权 agent 拒绝
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "agent:stranger",
      legacy: true,
      attempt,
      reason: "非法解绑",
      liveCheck: gone,
    }),
    GraphError,
    "未授权 agent 拒绝",
  );

  // 2. 子代理自我解绑拒绝
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: childId,
      legacy: true,
      attempt,
      reason: "自我解绑",
      liveCheck: gone,
    }),
    GraphError,
    "子代理不能自我解绑",
  );
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "agent:" + childId,
      legacy: true,
      attempt,
      reason: "自我解绑",
      liveCheck: gone,
    }),
    GraphError,
    "子代理不能自我解绑",
  );

  // 3. 未匹配主管 session 拒绝
  writeSupervisorSession(root, "sess-super", "human:gui");
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "supervisor:wrong-sess",
      legacy: true,
      attempt,
      reason: "错会话",
      liveCheck: gone,
    }),
    GraphError,
    "错主管会话拒绝",
  );

  // 4. 正确主管放行
  const okSup = unbindGoalChild(root, goal, {
    actor: "supervisor:sess-super",
    legacy: true,
    attempt,
    reason: "主管授权解绑",
    liveCheck: gone,
  });
  assert.equal(okSup.detached, true);
});

// --------------------------------------------------------------------------
// 判据 3 & 5：delivered / archived 目标禁解绑
// --------------------------------------------------------------------------

test("g-282 判据3/5：delivered 与 archived 状态目标禁止解绑", () => {
  const { root } = setup();
  const { goal, attempt } = legacyBoundGoal(root);

  // 目标迁移至 delivered
  transition(root, goal, "in_progress", { actor: "human:gui" });
  transition(root, goal, "review", { actor: "human:gui" });
  transition(root, goal, "delivered", { actor: "human:gui" });

  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "human:gui",
      legacy: true,
      attempt,
      reason: "已交付试图解绑",
      liveCheck: gone,
    }),
    GraphError,
    "已交付目标禁解绑",
  );

  // 归档目标禁解绑测试
  const { goal: gArchived, attempt: aArchived } = legacyBoundGoal(root);
  archiveGoal(root, gArchived, { actor: "human:gui" });
  assert.throws(
    () => unbindGoalChild(root, gArchived, {
      actor: "human:gui",
      legacy: true,
      attempt: aArchived,
      reason: "已归档试图解绑",
      liveCheck: gone,
    }),
    GraphError,
    "已归档目标禁解绑",
  );
});

// --------------------------------------------------------------------------
// 判据 3 & 5：running 子代理禁解绑
// --------------------------------------------------------------------------

test("g-282 判据3/5：live registry 探测到 running 或 unknown 时禁止解绑", () => {
  const { root } = setup();
  const { goal, attempt } = legacyBoundGoal(root);

  // 1. running 状态 -> GraphConflictError 409
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "human:gui",
      legacy: true,
      attempt,
      reason: "正在运行解绑",
      liveCheck: running,
    }),
    GraphConflictError,
    "子代理 running 时禁止解绑",
  );

  // 2. unknown 状态 -> GraphError 400
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "human:gui",
      legacy: true,
      attempt,
      reason: "未知状态解绑",
      liveCheck: unknownState,
    }),
    GraphError,
    "子代理状态 unknown 时禁止解绑",
  );

  // 3. 无 liveCheck 且 pending 绑定 -> GraphError
  assert.throws(
    () => unbindGoalChild(root, goal, {
      actor: "human:gui",
      legacy: true,
      attempt,
      reason: "无 live check",
    }),
    GraphError,
    "未提供 live check 且 pending 时拒绝",
  );
});

// --------------------------------------------------------------------------
// 判据 4 & 5：解绑后目标可暂缓（端到端验证）
// --------------------------------------------------------------------------

test("g-282 判据4/5：解绑后目标可暂缓迁回 backlog，事件链完整（attempt.detached + goal.postponed）", () => {
  const { root } = setup();
  const { goal, attempt } = legacyBoundGoal(root);

  // 暂缓前：因为 attempt.status_line 不含完成词汇且 result=pending，暂缓被拒
  assert.throws(
    () => postponeGoal(root, goal, { actor: "human:gui", reason: "测试暂缓" }),
    GraphError,
    "解绑前因有活跃子代理应被拒绝暂缓",
  );

  // 执行遗留解绑
  const unbindRes = unbindGoalChild(root, goal, {
    actor: "human:gui",
    legacy: true,
    attempt,
    reason: "为暂缓而解绑",
    liveCheck: gone,
  });
  assert.equal(unbindRes.detached, true);

  // 解绑后：暂缓成功！
  postponeGoal(root, goal, { actor: "human:gui", reason: "成功暂缓" });

  // 检查目标文件已迁回 backlog/
  const targetFile = join(root, "backlog", goal, "goal.md");
  const doc = loadGoal(targetFile);
  assert.equal(doc.meta.id, goal);
  assert.equal(doc.meta.status, "draft");
  assert.equal(doc.meta.version, null);

  // 检查事件链顺序
  const goalEvents = readEvents(root).filter((e) => e.goal === goal);
  const detachEvtIndex = goalEvents.findIndex((e) => e.event === "attempt.detached");
  const postponeEvtIndex = goalEvents.findIndex((e) => e.event === "goal.postponed");
  assert.ok(detachEvtIndex >= 0, "存在 attempt.detached 事件");
  assert.ok(postponeEvtIndex > detachEvtIndex, "goal.postponed 事件必须在 attempt.detached 之后");
});

// --------------------------------------------------------------------------
// 判据 2：abandonAttempt 能力与测试
// --------------------------------------------------------------------------

test("g-282 判据2：abandonAttempt 将 attempt 置为 cancelled/detached 并记 attempt.abandoned 事件", () => {
  const { root } = setup();
  const { goal, attempt, childId } = legacyBoundGoal(root);

  // 放弃 attempt
  const r = abandonAttempt(root, goal, {
    actor: "human:gui",
    attempt,
    reason: "历史陈旧任务放弃",
    liveCheck: gone,
  });
  assert.equal(r.abandoned, true);
  assert.equal(r.attempt, attempt);

  // 检查 attempt.md
  const meta = attemptMeta(root, goal, attempt);
  assert.equal(meta.result, "cancelled");
  assert.equal(meta.detached, true);
  assert.equal(meta.child_id, undefined);
  assert.equal(meta.detached_by, "human:gui");

  // 检查事件
  const events = readEvents(root).filter((e) => e.goal === goal && e.event === "attempt.abandoned");
  assert.equal(events.length, 1);
  assert.equal(events[0].details.reason, "历史陈旧任务放弃");
  assert.equal(events[0].details.child_id, childId);

  // 放弃后目标亦可暂缓
  postponeGoal(root, goal, { actor: "human:gui", reason: "放弃后暂缓" });
  const doc = loadGoal(join(root, "backlog", goal, "goal.md"));
  assert.equal(doc.meta.status, "draft");
});

test("g-282 判据2：abandonAttempt 安全门控（running 拒绝、delivered 拒绝、未授权拒绝）", () => {
  const { root } = setup();
  const { goal, attempt } = legacyBoundGoal(root);

  // running 拒绝
  assert.throws(
    () => abandonAttempt(root, goal, { actor: "human:gui", attempt, reason: "r", liveCheck: running }),
    GraphConflictError,
  );

  // 未授权拒绝
  assert.throws(
    () => abandonAttempt(root, goal, { actor: "agent:unauthorized", attempt, reason: "r", liveCheck: gone }),
    GraphError,
  );

  // delivered 拒绝
  transition(root, goal, "in_progress", { actor: "human:gui" });
  transition(root, goal, "review", { actor: "human:gui" });
  transition(root, goal, "delivered", { actor: "human:gui" });
  assert.throws(
    () => abandonAttempt(root, goal, { actor: "human:gui", attempt, reason: "r", liveCheck: gone }),
    GraphError,
  );
});

// --------------------------------------------------------------------------
// Host 工具与 REST 端点集成
// --------------------------------------------------------------------------

test("g-282 工具与 REST：graph_unbind_goal_child (legacy: true) 与 graph_abandon_attempt 执行", async () => {
  const { root, byName, routes } = setup({});
  writeSupervisorSession(root, "sess-sup-1", "human:gui");

  // 1. Host tool graph_unbind_goal_child 带 legacy: true
  const { goal: g1, attempt: a1 } = legacyBoundGoal(root);
  const out1 = await byName.get("graph_unbind_goal_child").execute(
    { goal: g1, attempt: a1, legacy: true, reason: "主管通过工具解绑" },
    exec("sess-sup-1"),
  );
  assert.equal(out1.ok, true);
  assert.equal(out1.detached, true);
  assert.equal(attemptMeta(root, g1, a1).detached, true);

  // 2. Host tool graph_abandon_attempt 执行
  const { goal: g2, attempt: a2 } = legacyBoundGoal(root);
  const out2 = await byName.get("graph_abandon_attempt").execute(
    { goal: g2, attempt: a2, reason: "主管通过工具放弃" },
    exec("sess-sup-1"),
  );
  assert.equal(out2.ok, true);
  assert.equal(out2.abandoned, true);
  assert.equal(attemptMeta(root, g2, a2).result, "cancelled");

  // 3. REST /api/dsh-graph/unbind 支持 legacy: true
  const { goal: g3, attempt: a3 } = legacyBoundGoal(root);
  const rRest1 = await post(routes, "/api/dsh-graph/unbind", {
    goal: g3,
    attempt: a3,
    legacy: true,
    reason: "REST 解绑",
  });
  assert.equal(rRest1.code, 200);
  assert.equal(rRest1.body.ok, true);
  assert.equal(rRest1.body.detached, true);

  // REST 遗留解绑缺 reason 报 400
  const { goal: g4, attempt: a4 } = legacyBoundGoal(root);
  const rRestFail = await post(routes, "/api/dsh-graph/unbind", {
    goal: g4,
    attempt: a4,
    legacy: true,
  });
  assert.equal(rRestFail.code, 400);

  // 4. REST /api/dsh-graph/abandon-attempt
  const rRest2 = await post(routes, "/api/dsh-graph/abandon-attempt", {
    goal: g4,
    attempt: a4,
    reason: "REST 放弃",
  });
  assert.equal(rRest2.code, 200);
  assert.equal(rRest2.body.ok, true);
  assert.equal(rRest2.body.abandoned, true);
});
