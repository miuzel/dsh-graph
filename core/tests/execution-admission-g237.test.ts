import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  startAttempt,
  ensureExecutionInProgress,
  transition,
  goalDetail,
  findGoalFile,
  loadGoal,
  saveGoal,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dsh-graph-host/index.js";

function fakeReq(method: string, queryParams: string, body: any) {
  const listeners: Record<string, Function> = {};
  return {
    method,
    url: queryParams,
    on: (e: string, fn: Function) => { listeners[e] = fn; },
    _emit: () => {
      listeners.data?.(JSON.stringify(body));
      listeners.end?.();
    },
  };
}

function fakeRes() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}

function createHarness({
  providers = ["spawn"],
  providerHasPrepareContinuable = true,
  spawnError = null,
  onSpawn,
}: {
  providers?: string[];
  providerHasPrepareContinuable?: boolean;
  spawnError?: string | null;
  onSpawn?: () => void;
} = {}) {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g237-ws-"));
  const root = join(ws, ".dsh-graph");
  init(root);

  const capturedRequests: any[] = [];
  const interruptCalls: any[] = [];
  const registeredTools: any[] = [];
  const registeredRoutes = new Map<string, any>();
  const webServer = { register: (def: any) => { registeredRoutes.set(def.path, def.handler); return () => {}; } };

  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "subagents") {
        return {
          list: () => providers,
          getProvider: () => (providerHasPrepareContinuable ? { prepareContinuable: () => {} } : {}),
          startContinuable: async (opts: any) => {
            capturedRequests.push(opts);
            if (spawnError) throw new Error(spawnError);
            const childId = "child-" + Math.random().toString(36).slice(2, 8);
            onSpawn?.();
            return { childId, parentSessionId: "sess-super" };
          },
          interruptByParent: (childId: string, parentSessionId: string, mode: string) => {
            interruptCalls.push({ childId, parentSessionId, mode });
            return {};
          },
        };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: {
      register: (def: any) => { registeredTools.push(def); return () => {}; },
      get: () => ({}),
    },
  };

  apply(ctx, { root });
  const toolsByName = new Map(registeredTools.map((t) => [t.name, t]));
  const execContext = {
    agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } },
    signal: new AbortController().signal,
  };

  const status = (goalId: string) => String(loadGoal(findGoalFile(root, goalId)).meta.status);
  const attemptIds = (goalId: string) => {
    const dir = join(root, "versions", "v1.0", "goals", goalId, "attempts");
    return existsSync(dir) ? readdirSync(dir).filter((d) => d.startsWith("att-")) : [];
  };

  return {
    ws,
    root,
    toolsByName,
    registeredRoutes,
    execContext,
    capturedRequests,
    interruptCalls,
    status,
    attemptIds,
  };
}

async function httpDispatch(
  h: ReturnType<typeof createHarness>,
  body: any,
) {
  const handler = h.registeredRoutes.get("/api/dsh-graph/start-execution");
  const req = fakeReq("POST", "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(h.ws), body);
  const res = fakeRes();
  const p = handler(req, res);
  req._emit();
  await p;
  return res;
}

/** 清空目标的质量判据小节（保留 criteria.confirmed 事件），用于精确触发“判据非空”门槛。 */
function clearCriteriaBody(root: string, goalId: string) {
  const file = findGoalFile(root, goalId);
  const doc = loadGoal(file);
  doc.body = doc.body.replace(/## 质量判据\n[\s\S]*?(?=\n## |$)/, "## 质量判据\n\n");
  saveGoal(file, doc);
}

// ============================================================================
// 判据 1：未准入 fixture 在工具/HTTP 入口均明确拒绝，spawn 次数为 0，无运行 child
// ============================================================================

test("g-237 判据 1：planning 且无判据目标在工具入口被拒——spawn=0、无 child、无 attempt", async () => {
  const h = createHarness();
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goalId = createGoal(h.root, { title: "无判据规划目标", version: "v1.0", actor: "test" });
  assert.equal(h.status(goalId), "planning");

  await assert.rejects(
    () => h.toolsByName.get("graph_start_attempt")!.execute({ goal: goalId, attempt_brief: "尝试执行" }, h.execContext),
    /进入 in_progress 前/,
    "工具入口必须拒绝未准入派发",
  );
  assert.equal(h.capturedRequests.length, 0, "拒绝时不得调用 startContinuable");
  assert.equal(h.status(goalId), "planning", "拒绝后目标状态不变");
  assert.deepEqual(h.attemptIds(goalId), [], "拒绝时不得创建 attempt");
  assert.equal(
    readEvents(h.root).some((e) => e.event === "attempt.started" && e.goal === goalId),
    false,
    "拒绝时不得记录 attempt.started",
  );
});

test("g-237 判据 1：planning 且无判据目标在 HTTP 入口被拒——400、spawn=0、无 child、无 attempt", async () => {
  const h = createHarness();
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goalId = createGoal(h.root, { title: "无判据规划目标", version: "v1.0", actor: "test" });

  const res = await httpDispatch(h, { goal: goalId });
  assert.equal(res._code, 400, "HTTP 入口必须返回 400");
  assert.ok(/进入 in_progress 前/.test(res._body.error), "HTTP 错误信息必须明确准入原因");
  assert.equal(h.capturedRequests.length, 0, "拒绝时不得调用 startContinuable");
  assert.equal(h.status(goalId), "planning");
  assert.deepEqual(h.attemptIds(goalId), []);
});

test("g-237 判据 1：判据小节被清空（criteria.confirmed 仍在）时拒绝，且不启动子代理", async () => {
  const h = createHarness();
  const goalId = createGoal(h.root, { title: "判据被清空目标", version: "v1.0", actor: "test" });
  setCriteria(h.root, goalId, ["判据 A"], "test");
  clearCriteriaBody(h.root, goalId);

  await assert.rejects(
    () => h.toolsByName.get("graph_start_attempt")!.execute({ goal: goalId }, h.execContext),
    /质量判据小节必须非空/,
  );
  assert.equal(h.capturedRequests.length, 0);
  assert.deepEqual(h.attemptIds(goalId), []);
});

test("g-237 判据 1：blocked 目标经 HTTP 入口同样被拒且不启动子代理", async () => {
  const h = createHarness();
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goalId = createGoal(h.root, { title: "阻塞目标", version: "v1.0", actor: "test" });
  setCriteria(h.root, goalId, ["判据 A"], "test");
  transition(h.root, goalId, "blocked", { reason: "缺少依赖", actor: "test" });

  const res = await httpDispatch(h, { goal: goalId });
  assert.equal(res._code, 400);
  assert.ok(/目标当前处于阻塞状态/.test(res._body.error));
  assert.equal(h.capturedRequests.length, 0);
  assert.deepEqual(h.attemptIds(goalId), []);
});

// ============================================================================
// 判据 2：合法状态正常派发或幂等；Human Gate 不弱化
// ============================================================================

test("g-237 判据 2：合法目标派发成功并自动落入 in_progress，看板状态与执行事实一致", async () => {
  const h = createHarness();
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goalId = createGoal(h.root, { title: "合法执行目标", version: "v1.0", actor: "test" });
  setCriteria(h.root, goalId, ["判据 A"], "test");
  transition(h.root, goalId, "ready", { actor: "test" });

  const res = await h.toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, attempt_brief: "正常派发" },
    h.execContext,
  );
  assert.ok(res.attempt.startsWith("att-"));
  assert.ok(res.child_id, "合法派发必须启动 child");
  assert.equal(h.capturedRequests.length, 1);
  assert.equal(h.status(goalId), "in_progress", "派发成功后目标必须落入 in_progress");

  const detail = goalDetail(h.root, goalId);
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.attempts[0].child_id, res.child_id, "看板 attempt 绑定与执行事实一致");
  const transitions = readEvents(h.root).filter((e) => e.event === "goal.transition" && e.goal === goalId);
  assert.deepEqual(transitions.at(-1)?.details, { from: "ready", to: "in_progress", reason: "attempt 派发（graph_start_attempt）" });
});

test("g-237 判据 2：已 in_progress 目标重复派发幂等——不因“状态未变化”失败、不吞错", async () => {
  const h = createHarness();
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goalId = createGoal(h.root, { title: "重复派发目标", version: "v1.0", actor: "test" });
  setCriteria(h.root, goalId, ["判据 A"], "test");
  transition(h.root, goalId, "in_progress", { actor: "test" });

  const res = await h.toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, attempt_brief: "重复派发" },
    h.execContext,
  );
  assert.ok(res.child_id, "已在执行的目标重复派发必须正常启动");
  assert.equal(h.status(goalId), "in_progress");
  const transitions = readEvents(h.root).filter((e) => e.event === "goal.transition" && e.goal === goalId);
  assert.equal(transitions.length, 1, "幂等路径不得产生额外迁移事件");
});

test("g-237 判据 2：Human Gate 不弱化——in_progress 门槛仍由状态机不变式强制", () => {
  const h = createHarness();
  const goalId = createGoal(h.root, { title: "门槛目标", version: "v1.0", actor: "test" });
  // 无判据直接迁移仍被状态机拒绝（未被重构弱化）
  assert.throws(() => transition(h.root, goalId, "in_progress", { actor: "test" }), /进入 in_progress 前/);
  setCriteria(h.root, goalId, ["判据 A"], "test");
  transition(h.root, goalId, "in_progress", { actor: "test" });
  assert.equal(h.status(goalId), "in_progress");
});

// ============================================================================
// 判据 3：失败路径可追溯、不吞真实拒绝、不留无主运行 child
// ============================================================================

test("g-237 判据 3：spawn 失败时无无主运行 child，attempt 审计与错误可追溯", async () => {
  const h = createHarness({ spawnError: "LLM quota exceeded" });
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goalId = createGoal(h.root, { title: "派发失败目标", version: "v1.0", actor: "test" });
  setCriteria(h.root, goalId, ["判据 A"], "test");

  const res = await h.toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, attempt_brief: "失败派发" },
    h.execContext,
  );
  assert.equal(res.child_id, null, "spawn 失败不得返回 child_id");
  assert.ok(res.child_error?.includes("LLM quota exceeded"), "失败原因必须可追溯");
  assert.equal(h.capturedRequests.length, 1);
  const detail = goalDetail(h.root, goalId);
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.attempts[0].child_id, null, "无绑定 child，绝不留无主运行 child");
});

test("g-237 判据 3：模板不得要求门禁拒绝后继续实现", async () => {
  const h = createHarness();
  const goalId = createGoal(h.root, { title: "模板检查目标", version: "v1.0", actor: "test" });
  setCriteria(h.root, goalId, ["判据 A"], "test");
  const res = await h.toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, attempt_brief: "模板检查" },
    h.execContext,
  );
  const prompt = res.prompt ?? h.capturedRequests[0].request.prompt[0].text;
  assert.ok(!prompt.includes("保留 status 汇报并继续工作"), "不得再指示门禁拒绝后继续工作");
  assert.ok(/迁移被引擎拒绝/.test(prompt), "必须保留迁移拒绝的处理说明");
  assert.ok(/不得继续实现|停止/.test(prompt), "必须明确要求停止而非继续实现");
});

test("g-237 判据 3：绑定失败时中断已启动 child 并给出可追溯错误，不留无主运行 child", async () => {
  let attemptsDir = "";
  const h = createHarness({
    onSpawn: () => {
      // 模拟绑定阶段前 attempt 记录被并发移除，使 bindAttemptChild 失败
      rmSync(attemptsDir, { recursive: true, force: true });
    },
  });
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goalId = createGoal(h.root, { title: "绑定失败目标", version: "v1.0", actor: "test" });
  setCriteria(h.root, goalId, ["判据 A"], "test");
  attemptsDir = join(h.root, "versions", "v1.0", "goals", goalId, "attempts");

  const res = await h.toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, attempt_brief: "绑定失败派发" },
    h.execContext,
  );
  assert.equal(res.child_id, null, "绑定失败不得上报为成功绑定");
  assert.ok(res.child_error?.includes("attempt 绑定失败"), "绑定失败必须可追溯");
  assert.ok(res.child_error?.includes("child-"), "错误中必须携带已启动的 child id");
  assert.equal(h.interruptCalls.length, 1, "必须请求中断已启动的 child，避免无主运行 child");
  assert.equal(h.interruptCalls[0].mode, "continuable");
  assert.ok(res.child_error?.includes("已请求中断该 child"), "错误中必须说明收敛动作");
});

test("g-237 判据 2：ensureExecutionInProgress 幂等——已在 in_progress 不抛“状态未变化”，真实拒绝仍抛出", () => {
  const h = createHarness();
  const goalId = createGoal(h.root, { title: "幂等迁移目标", version: "v1.0", actor: "test" });
  // 真实拒绝：无判据时迁移被状态机不变式拒绝，必须原样抛出（绝不吞）
  assert.throws(
    () => ensureExecutionInProgress(h.root, goalId, { actor: "test", reason: "派发" }),
    /进入 in_progress 前/,
  );
  setCriteria(h.root, goalId, ["判据 A"], "test");
  assert.deepEqual(
    ensureExecutionInProgress(h.root, goalId, { actor: "test", reason: "派发" }),
    { changed: true, status: "in_progress" },
  );
  // 并发/重复路径：第二次为幂等 no-op，不抛“状态未变化”
  assert.deepEqual(
    ensureExecutionInProgress(h.root, goalId, { actor: "test", reason: "派发" }),
    { changed: false, status: "in_progress" },
  );
  const transitions = readEvents(h.root).filter((e) => e.event === "goal.transition" && e.goal === goalId);
  assert.equal(transitions.length, 1, "幂等路径不得重复写迁移事件");
});

test("g-237 判据 3：startAttempt 自身不承担门禁（门禁只在派发服务前置）", () => {
  const h = createHarness();
  const goalId = createGoal(h.root, { title: "startAttempt 直调", version: "v1.0", actor: "test" });
  // core.startAttempt 保持纯记录语义，不做状态/判据准入（准入由共享派发服务统一前置）
  const att = startAttempt(h.root, goalId, { executor: "agent:x", actor: "test" });
  assert.ok(att.startsWith("att-"));
});
