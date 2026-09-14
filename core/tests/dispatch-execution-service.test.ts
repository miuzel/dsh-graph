import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  init,
  createGoal,
  setCriteria,
  addCard,
  fillCard,
  reviewCard,
  recordAttemptHandoff,
  startAttempt,
  goalDetail,
  findGoalFile,
  loadGoal,
  saveGoal,
  transition,
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
  customWorkspace,
  providers = ["spawn"],
  providerHasPrepareContinuable = true,
  spawnError = null,
  gitRepo = false,
}: {
  customWorkspace?: string;
  providers?: string[];
  providerHasPrepareContinuable?: boolean;
  spawnError?: string | null;
  gitRepo?: boolean;
} = {}) {
  const ws = customWorkspace ?? mkdtempSync(join(tmpdir(), "dsh-graph-g241-ws-"));
  // g-283：worktree=true 会真实 `git worktree add`，需要真实 Git 仓库作为代码工作区。
  if (gitRepo) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    writeFileSync(join(ws, "README"), "x");
    execFileSync("git", ["add", "."], { cwd: ws });
    execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
  }
  const root = join(ws, ".dsh-graph");
  init(root);

  let capturedRequests: any[] = [];
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
          getProvider: (name: string) => {
            if (providerHasPrepareContinuable) {
              return { prepareContinuable: () => {} };
            }
            return {};
          },
          startContinuable: async (opts: any) => {
            capturedRequests.push(opts);
            if (spawnError) throw new Error(spawnError);
            return { childId: "child-" + Math.random().toString(36).slice(2, 8), parentSessionId: "sess-super" };
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

  return {
    ws,
    root,
    toolsByName,
    registeredRoutes,
    execContext,
    capturedRequests,
  };
}

// ============================================================================
// 质量判据 1：工具与 HTTP 入口语义等价性、身份保留与 targetContext 注入
// ============================================================================

test("g-241 判据 1：工具与 HTTP 均注入 targetContext 且语义等价，入口身份各自分立", async () => {
  const { ws, root, toolsByName, registeredRoutes, execContext, capturedRequests } = createHarness();
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");

  const goalId = createGoal(root, { title: "统一派发目标", version: "v1.0", actor: "human:gui" });
  setCriteria(root, goalId, ["判据 A：实现统一服务", "判据 B：测试通过"], "human:gui");

  // 1. 工具入口执行
  const toolRes = await toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, attempt_brief: "工具派发 action" },
    execContext,
  );
  assert.ok(toolRes.attempt.startsWith("att-"));
  assert.ok(toolRes.child_id);

  const toolPrompt = capturedRequests[0].request.prompt[0].text;
  assert.ok(toolPrompt.includes("## 目标描述"), "工具入口 prompt 必须包含目标描述");
  assert.ok(toolPrompt.includes("## 质量判据"), "工具入口 prompt 必须包含质量判据");
  assert.ok(toolPrompt.includes("判据 A：实现统一服务"), "工具入口 prompt 包含判据内容");
  assert.ok(toolPrompt.includes("工具派发 action"), "工具入口 prompt 包含 brief");

  // 工具绑定的父会话来源为 execContext
  const toolAttemptDoc = loadGoal(join(root, "versions", "v1.0", "goals", goalId, "attempts", toolRes.attempt, "attempt.md"));
  assert.equal(toolAttemptDoc.meta.parent_session_id, "sess-exec", "工具入口保留调用者会话作为 parent_session_id");

  // 2. HTTP 入口执行
  const handler = registeredRoutes.get("/api/dsh-graph/start-execution");
  const req = fakeReq("POST", "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws), {
    goal: goalId,
    attempt_brief: "HTTP 派发 action",
  });
  const res = fakeRes();
  const p = handler(req, res);
  req._emit();
  await p;

  assert.equal(res._code, 200);
  assert.equal(res._body.ok, true);
  assert.ok(res._body.child_id);

  const httpPrompt = capturedRequests[1].request.prompt[0].text;
  assert.ok(httpPrompt.includes("## 目标描述"), "HTTP 入口 prompt 必须包含目标描述");
  assert.ok(httpPrompt.includes("## 质量判据"), "HTTP 入口 prompt 必须包含质量判据");
  assert.ok(httpPrompt.includes("判据 B：测试通过"), "HTTP 入口 prompt 包含判据内容");
  assert.ok(httpPrompt.includes("HTTP 派发 action"), "HTTP 入口 prompt 包含 brief");

  // HTTP 绑定的父会话来源为 supervisor.session
  const httpAttemptDoc = loadGoal(join(root, "versions", "v1.0", "goals", goalId, "attempts", res._body.attempt, "attempt.md"));
  assert.equal(httpAttemptDoc.meta.parent_session_id, "sess-super", "HTTP 入口保留 supervisor 作为 parent_session_id");
  const httpStartEv = readEvents(root).find((e) => e.event === "attempt.started" && e.details.attempt === res._body.attempt);
  assert.equal(httpStartEv?.actor, "human:gui", "HTTP 入口保留 human:gui 身份");
});

// ============================================================================
// 质量判据 2：结构化任务事实持久化（task_type, baseline_commit, source_attempt, acceptance_items）
// ============================================================================

test("g-241 判据 2：startAttempt 持久化 4 项任务事实与 reasoning_effort，保留 null/省略/[] 契约", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g241-facts-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "事实持久化", version: "v1.0", actor: "test" });
  setCriteria(root, goalId, ["判据 1"], "test");

  // Case 1: 完整非空字段 + reasoning_effort
  const att1 = startAttempt(root, goalId, {
    executor: "agent:exec",
    actor: "human:gui",
    taskType: "fix",
    baselineCommit: "abcdef1",
    sourceAttempt: "att-001",
    acceptanceItems: ["npm test", "git status"],
    reasoningEffort: "high",
  });
  const doc1 = loadGoal(join(root, "versions", "v1.0", "goals", goalId, "attempts", att1, "attempt.md"));
  assert.equal(doc1.meta.task_type, "fix");
  assert.equal(doc1.meta.baseline_commit, "abcdef1");
  assert.equal(doc1.meta.source_attempt, "att-001");
  assert.deepEqual(doc1.meta.acceptance_items, ["npm test", "git status"]);
  assert.equal(doc1.meta.reasoning_effort, "high");

  const ev1 = readEvents(root).find((e) => e.event === "attempt.started" && e.details.attempt === att1);
  assert.equal(ev1.details.task_type, "fix");
  assert.equal(ev1.details.baseline_commit, "abcdef1");
  assert.equal(ev1.details.source_attempt, "att-001");
  assert.deepEqual(ev1.details.acceptance_items, ["npm test", "git status"]);
  assert.equal(ev1.details.reasoning_effort, "high");

  // Case 2: 显式 null 契约
  const att2 = startAttempt(root, goalId, {
    executor: "agent:exec",
    actor: "human:gui",
    taskType: null,
    baselineCommit: null,
    sourceAttempt: null,
    acceptanceItems: null,
  });
  const doc2 = loadGoal(join(root, "versions", "v1.0", "goals", goalId, "attempts", att2, "attempt.md"));
  assert.equal(doc2.meta.task_type, null, "meta 中 task_type 应为 null");
  assert.equal(doc2.meta.baseline_commit, null, "meta 中 baseline_commit 应为 null");
  assert.equal(doc2.meta.source_attempt, null, "meta 中 source_attempt 应为 null");
  assert.equal(doc2.meta.acceptance_items, null, "meta 中 acceptance_items 应为 null");

  const ev2 = readEvents(root).find((e) => e.event === "attempt.started" && e.details.attempt === att2);
  assert.equal(ev2.details.task_type, null, "details 中 task_type 应为 null");
  assert.equal(ev2.details.baseline_commit, null, "details 中 baseline_commit 应为 null");
  assert.equal(ev2.details.source_attempt, null, "details 中 source_attempt 应为 null");
  assert.equal(ev2.details.acceptance_items, null, "details 中 acceptance_items 应为 null");

  // Case 3: 显式 [] 契约（无单独验收项）
  const att3 = startAttempt(root, goalId, {
    executor: "agent:exec",
    actor: "human:gui",
    taskType: "rewrite",
    acceptanceItems: [],
  });
  const doc3 = loadGoal(join(root, "versions", "v1.0", "goals", goalId, "attempts", att3, "attempt.md"));
  assert.deepEqual(doc3.meta.acceptance_items, [], "meta 中 acceptance_items 应为空数组 []");
  assert.equal(doc3.meta.baseline_commit, undefined, "未提供 baseline_commit 不写字段");

  const ev3 = readEvents(root).find((e) => e.event === "attempt.started" && e.details.attempt === att3);
  assert.deepEqual(ev3.details.acceptance_items, [], "details 中 acceptance_items 应为空数组 []");
  assert.equal(ev3.details.baseline_commit, undefined);

  // Case 4: 完全省略
  const att4 = startAttempt(root, goalId, {
    executor: "agent:exec",
    actor: "human:gui",
  });
  const doc4 = loadGoal(join(root, "versions", "v1.0", "goals", goalId, "attempts", att4, "attempt.md"));
  assert.equal(doc4.meta.task_type, undefined);
  assert.equal(doc4.meta.baseline_commit, undefined);
  assert.equal(doc4.meta.source_attempt, undefined);
  assert.equal(doc4.meta.acceptance_items, undefined);

  const ev4 = readEvents(root).find((e) => e.event === "attempt.started" && e.details.attempt === att4);
  assert.equal(ev4.details.task_type, undefined);
  assert.equal(ev4.details.baseline_commit, undefined);
  assert.equal(ev4.details.source_attempt, undefined);
  assert.equal(ev4.details.acceptance_items, undefined);
});

test("g-241 判据 2：旧 attempt 兼容性——缺少 4 项事实时 goalDetail 安全返回 null，旧 attempt 可读不崩溃", () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g241-compat-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "旧目标兼容", version: "v1.0", actor: "test" });
  // 手写模拟一个遗留历史 attempt.md（不含 task_type、acceptance_items、context_digest 等新字段）
  const legacyDir = join(root, "versions", "v1.0", "goals", goalId, "attempts", "att-001");
  mkdirSync(legacyDir, { recursive: true });
  saveGoal(join(legacyDir, "attempt.md"), {
    meta: {
      id: "att-001",
      goal: goalId,
      executor: "agent:legacy",
      started_at: "2026-01-01T00:00:00Z",
      status_line: "历史执行",
      result: "completed",
    },
    body: "历史执行记录",
  });

  const detail = goalDetail(root, goalId);
  assert.equal(detail.attempts.length, 1);
  const att = detail.attempts[0];
  assert.equal(att.id, "att-001");
  assert.equal(att.executor, "agent:legacy");
  assert.equal(att.task_type, null);
  assert.equal(att.baseline_commit, null);
  assert.equal(att.source_attempt, null);
  assert.equal(att.acceptance_items, null);
  assert.equal(att.template_version, null);
  assert.equal(att.prompt_hash, null);
  assert.equal(att.context_digest, null);
  assert.equal(att.context_version, null);
});

// ============================================================================
// 质量判据 3：保留模板版本、上下文版本/digest及prompt hash，能恢复事实，单快照零漂移
// ============================================================================

test("g-241 判据 3：attempt meta 与事件记录 template_version、context_version、context_digest、prompt_hash，注入卡片/handoff 来自同一快照", async () => {
  const { ws, root, toolsByName, execContext, capturedRequests } = createHarness();
  const goalId = createGoal(root, { title: "快照与恢复", version: "v1.0", actor: "human:gui" });
  setCriteria(root, goalId, ["质量要求 1"], "human:gui");

  const c1 = addCard(root, goalId, { title: "卡片1", kind: "text", actor: "human:gui" });
  fillCard(root, goalId, c1, { text: "卡片正文详情", summary: "摘要1", by: "human:gui", actor: "human:gui" });
  reviewCard(root, goalId, c1, { by: "human:gui", actor: "human:gui" });

  const toolRes = await toolsByName.get("graph_start_attempt")!.execute(
    {
      goal: goalId,
      attempt_brief: "验证快照 hash",
      task_type: "merge",
      baseline_commit: "1234567",
      source_attempt: "att-000",
      acceptance_items: ["pnpm test"],
    },
    execContext,
  );

  const doc = loadGoal(join(root, "versions", "v1.0", "goals", goalId, "attempts", toolRes.attempt, "attempt.md"));
  assert.equal(doc.meta.template_version, "v1");
  assert.ok(typeof doc.meta.prompt_hash === "string" && doc.meta.prompt_hash.length > 0);
  assert.ok(typeof doc.meta.context_digest === "string" && doc.meta.context_digest.length > 0);
  assert.ok(doc.meta.context_version);

  const ev = readEvents(root).find((e) => e.event === "attempt.started" && e.details.attempt === toolRes.attempt);
  assert.equal(ev.details.template_version, "v1");
  assert.equal(ev.details.prompt_hash, doc.meta.prompt_hash);
  assert.equal(ev.details.context_digest, doc.meta.context_digest);
  assert.equal(ev.details.context_version, doc.meta.context_version);

  // 验证关键任务事实完全可从 attempt.md 恢复，而不是只剩 hash
  assert.equal(doc.meta.task_type, "merge");
  assert.equal(doc.meta.baseline_commit, "1234567");
  assert.equal(doc.meta.source_attempt, "att-000");
  assert.deepEqual(doc.meta.acceptance_items, ["pnpm test"]);
  assert.equal(doc.meta.brief, "验证快照 hash");

  // 验证注入清单与 prompt 实际注入内容来自同一快照
  assert.deepEqual(toolRes.injected_cards, [c1]);
  const promptText = capturedRequests[0].request.prompt[0].text;
  assert.ok(promptText.includes(c1));
  assert.ok(promptText.includes("卡片正文详情"));
});

// ============================================================================
// 质量判据 4：无 prepareContinuable provider 时明确失败不回退虚构 spawn；路由与优先级参数化测试
// ============================================================================

test("g-241 判据 4：无 prepareContinuable provider 时工具与 HTTP 均明确报错，绝不回退虚构 spawn", async () => {
  // 创建只有无 prepareContinuable 能力的 provider（或空 provider 列表）的环境
  const { ws, root, toolsByName, registeredRoutes, execContext, capturedRequests } = createHarness({
    providers: ["plain-spawn", "mock-agent"],
    providerHasPrepareContinuable: false,
  });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");

  const goalId = createGoal(root, { title: "无能力提供方目标", version: "v1.0", actor: "human:gui" });
  setCriteria(root, goalId, ["判据"], "human:gui");

  // 1. 工具入口
  const toolRes = await toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, attempt_brief: "尝试执行" },
    execContext,
  );
  assert.equal(toolRes.child_id, null);
  assert.ok(toolRes.child_error?.includes("需 prepareContinuable 能力"), "工具入口上报明确错误");
  assert.equal(capturedRequests.length, 0, "绝不调用 startContinuable");

  // 2. HTTP 入口
  const handler = registeredRoutes.get("/api/dsh-graph/start-execution");
  const req = fakeReq("POST", "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws), { goal: goalId });
  const res = fakeRes();
  const p = handler(req, res);
  req._emit();
  await p;

  assert.equal(res._code, 200);
  assert.equal(res._body.child_id, null);
  assert.ok(res._body.child_error?.includes("需 prepareContinuable 能力"), "HTTP 入口上报明确错误");
  assert.equal(capturedRequests.length, 0, "绝不调用 startContinuable");
});

test("g-241 判据 4：参数化测试——模型、模式与推理档位优先级（单次调用 > project.yaml > profile 全局 > 继承）", async () => {
  const { ws, root, toolsByName, execContext } = createHarness();
  // project.yaml 设置
  writeFileSync(join(root, "project.yaml"), `supervisor:
  session: sess-super
executor:
  provider: proj-provider
  model: proj-model
  mode: standard
`, "utf8");

  const goalId = createGoal(root, { title: "路由测试目标", version: "v1.0", actor: "human:gui" });
  setCriteria(root, goalId, ["判据"], "human:gui");

  // Case 1: 显式 override 优先于 project.yaml
  const res1 = await toolsByName.get("graph_start_attempt")!.execute(
    {
      goal: goalId,
      provider: "override-provider",
      model: "override-model",
      reasoning_effort: "low",
      mode: "minimal",
      attempt_brief: "单次 override",
    },
    execContext,
  );
  assert.equal(res1.model_route, "override-provider/override-model");
  assert.equal(res1.mode, "minimal");
  assert.equal(res1.mode_source, "override");

  const doc1 = loadGoal(join(root, "versions", "v1.0", "goals", goalId, "attempts", res1.attempt, "attempt.md"));
  assert.equal(doc1.meta.provider, "override-provider");
  assert.equal(doc1.meta.model, "override-model");
  assert.equal(doc1.meta.reasoning_effort, "low");
  assert.equal(doc1.meta.mode, "minimal");
  assert.equal(doc1.meta.mode_source, "override");

  // Case 2: 无 override 时回退 project.yaml
  const res2 = await toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, attempt_brief: "回退 project" },
    execContext,
  );
  assert.equal(res2.model_route, "proj-provider/proj-model");
  assert.equal(res2.mode, "standard");
  assert.equal(res2.mode_source, "project");

  const doc2 = loadGoal(join(root, "versions", "v1.0", "goals", goalId, "attempts", res2.attempt, "attempt.md"));
  assert.equal(doc2.meta.provider, "proj-provider");
  assert.equal(doc2.meta.model, "proj-model");
  assert.equal(doc2.meta.mode, "standard");
  assert.equal(doc2.meta.mode_source, "project");
});

// ============================================================================
// 质量判据 5：协同回归（空 action 规范化、准入门禁失败、显式隔离优先级、绑定与派发失败收敛）
// ============================================================================

test("g-241 判据 5：空 action 协同回归（g-236 语义）——缺失 brief 与 directive 时自动规范化为默认 action，纯空白 brief 按空回退", async () => {
  const { ws, root, toolsByName, execContext, capturedRequests } = createHarness();
  const goalId = createGoal(root, { title: "自动补全Action目标", version: "v1.0", actor: "human:gui" });
  setCriteria(root, goalId, ["判据"], "human:gui");

  // 1. 未传 brief 且无 directive 时，生成基于目标意图的默认 action（fallback）
  const res1 = await toolsByName.get("graph_start_attempt")!.execute({ goal: goalId }, execContext);
  assert.equal(res1.brief, "执行目标描述和质量判据中的任务");
  assert.equal(res1.brief_source, "fallback");
  const prompt1 = capturedRequests[0].request.prompt[0].text;
  assert.ok(prompt1.includes("执行目标描述和质量判据中的任务"));
  assert.ok(!prompt1.includes("（未提供）\n> 未提供原因：本次请求未传 attempt_brief"));

  // 2. 显式传纯空白 brief 时，按 g-236 语义视为空并走回退（不抛错）
  const res2 = await toolsByName.get("graph_start_attempt")!.execute({ goal: goalId, attempt_brief: "   " }, execContext);
  assert.equal(res2.brief, "执行目标描述和质量判据中的任务");
  assert.equal(res2.brief_source, "fallback");
});

test("g-241 判据 5：准入门禁失败协同回归——未规划/阻塞/已交付/暂存目标拒绝执行，不创建 attempt 且不启动子代理", async () => {
  const { ws, root, toolsByName, registeredRoutes, execContext, capturedRequests } = createHarness();
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");

  // 1. draft 目标（草稿未排期）
  const draftGoal = createGoal(root, { title: "草稿目标", version: "standalone", actor: "test" });
  await assert.rejects(
    () => toolsByName.get("graph_start_attempt")!.execute({ goal: draftGoal }, execContext),
    /草稿目标未规划，不允许直接执行/,
  );
  assert.equal(capturedRequests.length, 0, "草稿目标阻断，未调用子代理");

  // 2. blocked 目标
  const blockedGoal = createGoal(root, { title: "阻塞目标", version: "v1.0", actor: "test" });
  setCriteria(root, blockedGoal, ["判据"], "test");
  transition(root, blockedGoal, "blocked", { reason: "缺少依赖库", actor: "test" });
  await assert.rejects(
    () => toolsByName.get("graph_start_attempt")!.execute({ goal: blockedGoal }, execContext),
    /目标当前处于阻塞状态/,
  );
  assert.equal(capturedRequests.length, 0, "阻塞目标阻断，未调用子代理");

  // 3. delivered 目标
  const delivGoal = createGoal(root, { title: "交付目标", version: "v1.0", actor: "test" });
  setCriteria(root, delivGoal, ["判据"], "test");
  transition(root, delivGoal, "in_progress", { actor: "test" });
  transition(root, delivGoal, "review", { actor: "test" });
  transition(root, delivGoal, "delivered", { actor: "test" });
  await assert.rejects(
    () => toolsByName.get("graph_start_attempt")!.execute({ goal: delivGoal }, execContext),
    /已交付目标不允许直接派发执行/,
  );
  assert.equal(capturedRequests.length, 0, "交付目标阻断，未调用子代理");

  // HTTP 入口同样被 400 阻断
  const handler = registeredRoutes.get("/api/dsh-graph/start-execution");
  const req = fakeReq("POST", "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws), { goal: draftGoal });
  const res = fakeRes();
  const p = handler(req, res);
  req._emit();
  await p;
  assert.equal(res._code, 400);
  assert.ok(res._body.error.includes("草稿目标未规划"));
  assert.equal(capturedRequests.length, 0);
});

test("g-241 判据 5：显式隔离优先级协同回归（g-218 规则）——patch/chore 在 worktree=true 时仍强制隔离", async () => {
  // g-283：worktree=true 现在会真实建树，需真实 Git 仓库，否则按「非 git 仓库失败即停」拒绝派发。
  const { root, toolsByName, execContext, capturedRequests } = createHarness({ gitRepo: true });
  const patchGoal = createGoal(root, { title: "补丁目标", version: "v1.0", type: "patch", actor: "human:gui" });
  setCriteria(root, patchGoal, ["判据"], "human:gui");

  // 1. patch 目标显式 worktree=true → 必须包含【强制 worktree 隔离】
  await toolsByName.get("graph_start_attempt")!.execute(
    { goal: patchGoal, worktree: true, attempt_brief: "强制隔离补丁" },
    execContext,
  );
  const prompt1 = capturedRequests[0].request.prompt[0].text;
  assert.ok(prompt1.includes("【强制 worktree 隔离】"), "显式 worktree=true 必须强制隔离");
  assert.ok(!prompt1.includes("豁免独立 worktree 隔离"), "显式 worktree=true 不得包含豁免说明");

  // 2. patch 目标省略 worktree → 默认轻量通道【微小改动/轻量任务快速通道】
  await toolsByName.get("graph_start_attempt")!.execute(
    { goal: patchGoal, attempt_brief: "轻量通道补丁" },
    execContext,
  );
  const prompt2 = capturedRequests[1].request.prompt[0].text;
  assert.ok(prompt2.includes("【微小改动/轻量任务快速通道】"));
  assert.ok(prompt2.includes("豁免独立 worktree 隔离"));

  // 3. patch 目标显式 worktree=false → 仍走 minor-task 豁免指引（不强制隔离）
  await toolsByName.get("graph_start_attempt")!.execute(
    { goal: patchGoal, worktree: false, attempt_brief: "完全豁免" },
    execContext,
  );
  const prompt3 = capturedRequests[2].request.prompt[0].text;
  assert.ok(!prompt3.includes("【强制 worktree 隔离】"));
  assert.ok(prompt3.includes("【微小改动/轻量任务快速通道】"), "patch 显式 worktree=false → minor-task 豁免指引");
});

test("g-241 判据 5：绑定与派发失败收敛——子代理启动异常时 attempt 成功审计，child_error 明确上报，无无主运行 child", async () => {
  const { ws, root, toolsByName, registeredRoutes, execContext } = createHarness({
    spawnError: "LLM quota exceeded or model overloaded",
  });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");

  const goalId = createGoal(root, { title: "派发失败测试", version: "v1.0", actor: "human:gui" });
  setCriteria(root, goalId, ["判据"], "human:gui");

  // 1. 工具入口派发失败
  const toolRes = await toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, attempt_brief: "测试失败处理" },
    execContext,
  );
  assert.ok(toolRes.attempt.startsWith("att-"));
  assert.equal(toolRes.child_id, null);
  assert.ok(toolRes.child_error?.includes("LLM quota exceeded"));
  assert.ok(toolRes.note?.includes("subagent 派发失败（attempt 已本地创建）"));

  // 2. HTTP 入口派发失败
  const handler = registeredRoutes.get("/api/dsh-graph/start-execution");
  const req = fakeReq("POST", "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws), {
    goal: goalId,
    attempt_brief: "HTTP 失败测试",
  });
  const res = fakeRes();
  const p = handler(req, res);
  req._emit();
  await p;

  assert.equal(res._code, 200);
  assert.ok(res._body.attempt.startsWith("att-"));
  assert.equal(res._body.child_id, null);
  assert.ok(res._body.child_error?.includes("LLM quota exceeded"));

  // 审计：两个 attempt 均在本地磁盘正确记录，且 child_id 均为 null，无悬空绑定
  const detail = goalDetail(root, goalId);
  assert.equal(detail.attempts.length, 2);
  assert.equal(detail.attempts[0].child_id, null);
  assert.equal(detail.attempts[1].child_id, null);
});

test("g-270: 目标描述含闭合围栏内 ## 伪标题时，prompt 目标描述不截断且质量判据完整", async () => {
  const { root, toolsByName, execContext, capturedRequests } = createHarness();
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");

  const goalId = createGoal(root, {
    title: "围栏内包含标题的目标",
    version: "v1.0",
    description: "正文前言\n```typescript\n## 围栏内伪小节标题\nconst x = 1;\n```\n正文后记，确保不被截断",
    actor: "human:gui",
  });
  setCriteria(root, goalId, ["判据 1：测试必须通过", "判据 2：不得越界"], "human:gui");

  const toolRes = await toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, attempt_brief: "验证 prompt 目标背景完整性" },
    execContext,
  );
  assert.ok(toolRes.attempt.startsWith("att-"));

  const promptText = capturedRequests[0].request.prompt[0].text;
  assert.ok(promptText.includes("正文前言"), "prompt 必须包含正文前言");
  assert.ok(promptText.includes("## 围栏内伪小节标题"), "prompt 必须完整保留代码围栏内的 ## 标题");
  assert.ok(promptText.includes("正文后记，确保不被截断"), "prompt 目标描述不应在围栏内 ## 处截断");
  assert.ok(promptText.includes("## 质量判据"), "prompt 必须包含质量判据");
  assert.ok(promptText.includes("判据 1：测试必须通过"), "判据项 1 必须完整");
  assert.ok(promptText.includes("判据 2：不得越界"), "判据项 2 必须完整");
});

// ============================================================================
// g-283：派发时用户决定是否建 worktree（真实创建 / 幂等 / 失败即停），工具与 HTTP 同路径
// ============================================================================

test("g-283 派发端到端：worktree=true 真实建树并写入 attempt 记录，工具返回 worktree 对象", async () => {
  const { ws, root, toolsByName, execContext, capturedRequests } = createHarness({ gitRepo: true });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goalId = createGoal(root, { title: "隔离执行", version: "v1.0", type: "feature", actor: "human:gui" });
  setCriteria(root, goalId, ["判据"], "human:gui");

  const r = await toolsByName.get("graph_start_attempt")!.execute(
    { goal: goalId, worktree: true, attempt_brief: "隔离执行" },
    execContext,
  );
  assert.ok(r.attempt.startsWith("att-"));
  assert.ok(r.worktree && typeof r.worktree === "object" && r.worktree.path, "工具结果必须返回真实 worktree 记录");
  const wtPath = join(ws, ".worktrees", `${goalId}-att-01`);
  assert.ok(existsSync(wtPath), "worktree 目录必须真实存在");
  assert.equal(r.worktree.relative_path, join(".worktrees", `${goalId}-att-01`));
  assert.equal(r.worktree.branch, `refs/heads/${goalId}-att-01`);
  // attempt 记录写入了 worktree 与基线
  const detail = goalDetail(root, goalId);
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.attempts[0].worktree.path, wtPath);
  assert.equal(detail.attempts[0].worktree.head, r.worktree.head);
  // 子代理确实被派发
  assert.ok(capturedRequests.length >= 1, "勾选建树后仍应正常派发子代理");
});

test("g-283 默认规则：feature 省略 worktree 默认勾选自动建树，task 默认不勾选不建树", async () => {
  const { ws, root, toolsByName, execContext } = createHarness({ gitRepo: true });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");

  const featureGoal = createGoal(root, { title: "功能", version: "v1.0", type: "feature", actor: "human:gui" });
  setCriteria(root, featureGoal, ["判据"], "human:gui");
  const r1 = await toolsByName.get("graph_start_attempt")!.execute(
    { goal: featureGoal, attempt_brief: "功能执行" },
    execContext,
  );
  assert.ok(r1.worktree && r1.worktree.path, "feature 默认应建树");
  assert.ok(existsSync(join(ws, ".worktrees", `${featureGoal}-att-01`)));

  const taskGoal = createGoal(root, { title: "任务", version: "v1.0", type: "task", actor: "human:gui" });
  setCriteria(root, taskGoal, ["判据"], "human:gui");
  const r2 = await toolsByName.get("graph_start_attempt")!.execute(
    { goal: taskGoal, attempt_brief: "任务执行" },
    execContext,
  );
  assert.equal(r2.worktree, false, "task 默认不建树");
  assert.ok(!existsSync(join(ws, ".worktrees", `${taskGoal}-att-01`)));
  const detail = goalDetail(root, taskGoal);
  assert.equal(detail.attempts[0].worktree, false);
  // attempt 记录里必须同时写入 worktree=false 与原因（读 attempt.md 元数据验证）
  const attFile = findGoalFile(root, taskGoal).replace(/goal\.md$/, `attempts/${detail.attempts[0].id}/attempt.md`);
  const attMeta = loadGoal(attFile).meta;
  assert.equal(attMeta.worktree, false);
  assert.equal(attMeta.worktree_reason, "user_choice");
});

test("g-283 失败即停：非 git 仓库 + worktree=true 拒绝派发，未创建 attempt 且未启动子代理", async () => {
  const { root, toolsByName, execContext, capturedRequests } = createHarness(); // 非 git 仓库
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goalId = createGoal(root, { title: "非git隔离", version: "v1.0", type: "feature", actor: "human:gui" });
  setCriteria(root, goalId, ["判据"], "human:gui");

  await assert.rejects(
    () => toolsByName.get("graph_start_attempt")!.execute(
      { goal: goalId, worktree: true, attempt_brief: "隔离" },
      execContext,
    ),
    /不是 Git 仓库|git 不可用/,
  );
  assert.equal(capturedRequests.length, 0, "失败即停：未启动任何子代理");
  const detail = goalDetail(root, goalId);
  assert.equal(detail.attempts.length, 0, "失败即停：未创建 attempt");
});

test("g-283 HTTP 入口同路径：worktree=false 不建树且 attempt 记录 worktree=false，端点 200", async () => {
  const { ws, root, registeredRoutes } = createHarness({ gitRepo: true });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goalId = createGoal(root, { title: "HTTP不隔离", version: "v1.0", type: "bug", actor: "human:gui" });
  setCriteria(root, goalId, ["判据"], "human:gui");

  const handler = registeredRoutes.get("/api/dsh-graph/start-execution");
  const req = fakeReq("POST", "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws), {
    goal: goalId,
    worktree: false,
    attempt_brief: "HTTP 不隔离",
  });
  const res = fakeRes();
  const p = handler(req, res);
  req._emit();
  await p;

  assert.equal(res._code, 200);
  assert.equal(res._body.worktree, false);
  assert.ok(!existsSync(join(ws, ".worktrees", `${goalId}-att-01`)));
  const detail = goalDetail(root, goalId);
  assert.equal(detail.attempts.length, 1);
  assert.equal(detail.attempts[0].worktree, false);
});
