/**
 * g-436 判据套件：strict 评审闭环——接线 reviewer 派发入口 + 未派评审可见化。
 *
 * 负责人已裁决的**边界**（本套件按此判定，绝不放宽为硬阻断）：
 *  - 只做接线与可见化：strict 目标未派独立评审时 accept **仍可进行**（看板/事件如实标注）；
 *  - 不新增引擎硬门禁、不新增人类凭据体系；默认 accept 路径逐字不变。
 *  - 诚实边界：`role=reviewer` 的工具作用域过滤只是**正常工具通道**的约束，不等于 bash 沙箱；
 *    HTTP 侧 `human:gui` 不证明真人。本套件只对**可判定的**通道下断言，不声称覆盖任意绕行。
 *
 * 断言面（每条对应主管给定的验收项）：
 *  1. 真实入口（工具 + HTTP 共用一套实现）派发独立评审，且绑定**明确候选 SHA**；作者 attempt 的
 *     `child_id`/`binding_token`/attempt.md 与作者结果 `results-att-*.md` **逐字不变**。
 *  2. 身份真源 = 真实 spawn 返回的 child；工具参数面**不存在**任何自报身份字段；reviewer 身份
 *     （正常工具通道）不得 `graph_resolve_accept`（含 force / fast_track）或 `graph_transition`→delivered；
 *     作者不得把自己的输出登记为「独立评审」（记录为 self_requested，不构成 independent_ok）。
 *  3. 注入材料受限：只含目标定义/负责人约束、判据原文、候选+基线 SHA、审查范围、报告骨架；
 *     作者 brief / 作者结果 / 作者自报 PASS / 评论 / 返工 handoff **一律不注入**（用哨兵串实测）。
 *  4. strict 无独立评审 ⇒ `review_state.independent_missing` + 一条 `review.independent_missing`
 *     事件（追加在 accept 映射**之后**），accept 仍成功；非 strict 目标零新增事件（默认路径零回归）；
 *     GUI 源码/词条齐备，且 vm 真实渲染证明「有标注、接受按钮仍可点」。
 *  5. 结论按 `review_id` + 真实候选 SHA 独立留痕（`<goalDir>/reviews/<review_id>.md`，与作者结果分离）；
 *     空输出 / 异常终止 / 载荷缺失 / 无显式总判行 / 归属不明的 child **一律不得记 PASS**。
 *
 * hermetic：全部在 tmp 目录的私有看板副本内进行，不触碰仓库数据；不新建评审工作树（复用作者工作区）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import vm from "node:vm";

import {
  init,
  createGoal,
  setCriteria,
  findGoalFile,
  loadGoal,
  goalDetail,
  goalReviewState,
  parseReviewConclusion,
  isCleanReviewStopReason,
  REVIEW_CONCLUSIONS,
  REVIEW_RECORD_STATUSES,
  REVIEW_EVENT_NAMES,
  REVIEW_RECORD_EVENT_NAMES,
  REVIEW_INDEPENDENT_MISSING_EVENT,
  formatReviewPrompt,
} from "../ops.ts";
import { appendEvent, readEvents } from "../events.ts";
import { apply } from "../../dist/index.js";

const VERIFIED = "✅已验";
const REVIEWS_DIR = "reviews";

// =====================================================================================
// 夹具
// =====================================================================================

function fakeReq(method: string, url: string, body: unknown) {
  const listeners: Record<string, Function> = {};
  return {
    method,
    url,
    on: (e: string, fn: Function) => { listeners[e] = fn; },
    _emit: () => { listeners.data?.(JSON.stringify(body)); listeners.end?.(); },
  };
}

function fakeRes() {
  const res: any = { _code: 0, _body: null };
  res.writeHead = (code: number) => { res._code = code; };
  res.end = (s: string) => { res._body = s ? JSON.parse(s) : null; };
  return res;
}

/** 真实 Git 工作区 + 私有看板根；subagents 服务用可预测的 child 队列。 */
function createHarness(opts: { policy?: string; childQueue?: string[] } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g436-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
  writeFileSync(join(ws, "README"), "x");
  // 与真实仓库同款忽略规则：看板数据与隔离工作树不计入「未提交改动」。
  writeFileSync(join(ws, ".gitignore"), ".worktrees/\n.dsh-graph/\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: ws });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: ws });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws }).toString().trim();

  const root = join(ws, ".dsh-graph");
  init(root);
  const policyLine = opts.policy ? `review:\n  policy: ${opts.policy}\n` : "";
  writeFileSync(join(root, "project.yaml"), `${policyLine}supervisor:\n  session: sess-super\n`, "utf8");

  const childQueue = [...(opts.childQueue ?? ["child-exec-1", "child-review-1", "child-review-2", "child-review-3"])];
  // 派发失败注入：只作用于**评审**派发（作者 attempt 必须先真实建立，才有评审对象）。
  const spawnFail = { value: null as string | null };
  let auto = 0;
  const capturedRequests: any[] = [];
  const interrupted: any[] = [];
  const registeredTools: any[] = [];
  const registeredRoutes = new Map<string, any>();
  const events: Record<string, Function[]> = {};
  const webServer = { register: (def: any) => { registeredRoutes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "sandboxPolicy") return { workspaceRoot: ws };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      if (name === "subagents") {
        return {
          list: () => ["spawn"],
          getProvider: () => ({ prepareContinuable: () => {} }),
          startContinuable: async (o: any) => {
            capturedRequests.push(o);
            if (spawnFail.value) throw new Error(spawnFail.value);
            const id = childQueue.shift() ?? `child-auto-${++auto}`;
            return { childId: id, parentSessionId: "sess-super" };
          },
          interruptByParent: (childId: string, parent: string, kind: string) => { interrupted.push({ childId, parent, kind }); },
        };
      }
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: (def: any) => { registeredTools.push(def); return () => {}; }, get: () => ({}) },
    on: (name: string, fn: Function) => { (events[name] = events[name] ?? []).push(fn); return () => {}; },
  };
  apply(ctx, { root });

  const toolsByName = new Map<string, any>(registeredTools.map((t: any) => [t.name, t]));
  const execContext = {
    agent: { id: "a1", session: { header: { cwd: ws }, id: "sess-exec" } },
    signal: new AbortController().signal,
  };
  const authExec = {
    agent: { id: "sess-super", session: { header: { cwd: ws }, id: "sess-super" } },
    signal: new AbortController().signal,
  };
  const emit = (name: string, info: any) => {
    for (const fn of events[name] ?? []) fn(info);
    return (events[name] ?? []).length;
  };
  const reviewEvs = (goal: string) =>
    readEvents(root).filter((e) => e.goal === goal && e.event.startsWith("review."));
  return { ws, root, head, toolsByName, registeredRoutes, execContext, authExec, capturedRequests, interrupted, emit, events, reviewEvs, spawnFail };
}

type H = ReturnType<typeof createHarness>;

async function callTool(h: H, name: string, args: any, exec?: any) {
  const t = h.toolsByName.get(name);
  assert.ok(t, `工具未注册：${name}`);
  return await t.execute(args, exec ?? h.execContext);
}

/** 断言工具抛错并返回错误文案（工具入口既可能是同步抛也可能返回 rejected promise）。 */
async function toolError(h: H, name: string, args: any, exec?: any): Promise<string> {
  try {
    await callTool(h, name, args, exec);
  } catch (e) {
    return String((e as Error)?.message ?? e);
  }
  throw new Error(`工具 ${name} 未抛错（应被拒绝）`);
}

/** 派发一个执行 attempt（作者），返回 goal / attempt / 作者 child 与工作区 HEAD。 */
async function prepareDispatched(h: H, o: { type?: string; brief?: string } = {}) {
  const goal = createGoal(h.root, { title: "g-436 夹具目标", version: "v-test", type: o.type ?? "feature", actor: "human:gui" });
  setCriteria(h.root, goal, [`判据一：接线与可见化 ${VERIFIED}`], "human:gui");
  await callTool(h, "graph_set_description", {
    goal,
    description: "## 目标描述\n- 负责人约束：OWNER-CONSTRAINT-SENTINEL-1 只做接线与可见化，不做硬阻断。",
  });
  const res = await callTool(h, "graph_start_attempt", {
    goal,
    worktree: false,
    attempt_brief: o.brief ?? "AUTHOR-BRIEF-SENTINEL-42",
  });
  const goalFile = findGoalFile(h.root, goal);
  const goalDir = dirname(goalFile);
  const attFile = join(goalDir, "attempts", res.attempt, "attempt.md");
  const authorChild = String(loadGoal(attFile).meta.child_id ?? "");
  assert.ok(authorChild, "作者 attempt 必须有真实 child_id");
  // 作者结果文件（评审**绝不得**覆盖它——last-wins 覆盖即毁证）
  await callTool(h, "graph_write_results", { goal, attempt: res.attempt, text: "AUTHOR-RESULTS-SENTINEL-7" });
  // 作者评论 / 返工 handoff（评审材料**绝不得**包含它们）
  await callTool(h, "graph_add_comment", { goal, text: "AUTHOR-COMMENT-SENTINEL-9" });
  await callTool(h, "graph_record_attempt_handoff", {
    goal, source_attempts: [res.attempt],
    failures: "REWORK-HANDOFF-SENTINEL-3", constraints: "无", baseline: "n/a", verification: "n/a",
  });
  // 迁移到 review（accept 交互发生的阶段）
  const raw = readFileSync(goalFile, "utf8");
  writeFileSync(goalFile, raw.replace(/"status": "in_progress"/, '"status": "review"'));
  const resultsFile = join(goalDir, `results-${res.attempt}.md`);
  return {
    goal, goalDir, goalFile, attempt: res.attempt, attFile, resultsFile, authorChild,
    attemptBytes: readFileSync(attFile),
    resultsBytes: readFileSync(resultsFile),
  };
}

function reviewsDirOf(fx: { goalDir: string }) {
  return join(fx.goalDir, REVIEWS_DIR);
}

function reviewFiles(fx: { goalDir: string }): string[] {
  const d = reviewsDirOf(fx);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")).sort() : [];
}

function recordOf(h: H, goal: string, reviewId: string) {
  const raw = readFileSync(join(dirname(findGoalFile(h.root, goal)), REVIEWS_DIR, `${reviewId}.md`), "utf8");
  return raw;
}

// =====================================================================================
// 判据 1：真实入口派发 + 明确候选 SHA 绑定 + 作者绑定/结果逐字不变
// =====================================================================================

test("g-436 判据1：工具入口派发独立评审、绑定完整候选 SHA，且作者 attempt/结果逐字不变", async () => {
  const h = createHarness();
  const fx = await prepareDispatched(h);

  const res = await callTool(h, "graph_start_review", {
    goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head, baseline_commit: h.head,
  });

  assert.equal(res.reused, false, "首次派发不复用");
  assert.equal(res.review_id, `rev-${fx.attempt}-01`, "review_id = rev-<attempt>-NN");
  assert.equal(res.candidate_sha, h.head, "候选 SHA 由真实 Git 解析为完整 40 位");
  assert.match(res.candidate_sha, /^[0-9a-f]{40}$/);
  assert.equal(res.baseline_sha, h.head);
  assert.equal(res.reviewer_child_id, "child-review-1", "reviewer child 身份取自真实 spawn 返回");
  assert.equal(res.goal, fx.goal);
  assert.equal(res.source_attempt, fx.attempt);

  // 事件：事件先行 + 真实调用身份 + 候选绑定
  const dispatched = h.reviewEvs(fx.goal).filter((e) => e.event === "review.dispatched");
  assert.equal(dispatched.length, 1, "恰好一条 review.dispatched");
  assert.equal(dispatched[0].details.candidate_sha, h.head);
  assert.equal(dispatched[0].details.review_id, res.review_id);
  assert.equal(dispatched[0].details.source_attempt, fx.attempt);
  assert.equal(dispatched[0].details.requested_by, "agent:sess-exec", "requested_by = 真实执行身份（会话 id）");
  assert.equal(dispatched[0].details.self_requested, false, "作者之外的身份 ⇒ 非自派");
  const bound = h.reviewEvs(fx.goal).filter((e) => e.event === "review.bound");
  assert.equal(bound.length, 1);
  assert.equal(bound[0].details.reviewer_child_id, "child-review-1");
  assert.equal(bound[0].details.candidate_sha, h.head);

  // 报告载体独立落盘：<goalDir>/reviews/<review_id>.md（**不在** attempts/ 内、**不是** results-att-*）
  const files = reviewFiles(fx);
  assert.deepEqual(files, [`${res.review_id}.md`], "评审记录独立目录");
  assert.ok(!existsSync(join(dirname(fx.attFile), `${res.review_id}.md`)), "评审记录不得写进 attempts/");
  assert.ok(readFileSync(join(reviewsDirOf(fx), `${res.review_id}.md`), "utf8").includes(h.head), "记录绑定候选 SHA");
  assert.ok(!existsSync(join(fx.goalDir, `results-att-${res.review_id}.md`)), "绝不产生 results-att-<review_id>");

  // 作者绑定与作者结果逐字不变（评审不是 attempt、不得改作者 child_id/results）
  assert.deepEqual(readFileSync(fx.attFile), fx.attemptBytes, "作者 attempt.md 逐字不变（含 child_id / binding_token）");
  assert.deepEqual(readFileSync(fx.resultsFile), fx.resultsBytes, "作者 results-att-*.md 逐字不变");
  const attMetaAfter = loadGoal(fx.attFile).meta;
  assert.equal(String(attMetaAfter.child_id), fx.authorChild, "作者 child_id 未被评审覆盖");
  assert.equal(h.capturedRequests.length, 2, "只有作者 + 一名 reviewer 两个子代理（评审不新建 attempt）");
  const reviewReq = h.capturedRequests[1];
  assert.match(String(reviewReq.label), /^graph:review\//, "reviewer 子代理用独立 label 前缀");
  assert.ok(!String(reviewReq.label).includes("graph:attempt"), "reviewer 不复用 attempt 派发路径");

  // 幂等：同 attempt + 同候选重复调用不重复派发
  const again = await callTool(h, "graph_start_review", {
    goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head,
  });
  assert.equal(again.reused, true);
  assert.equal(again.review_id, res.review_id);
  assert.equal(again.reviewer_child_id, "child-review-1");
  assert.equal(h.capturedRequests.length, 2, "幂等复用不新增子代理");
  assert.equal(h.reviewEvs(fx.goal).filter((e) => e.event === "review.dispatched").length, 1, "幂等复用不重新派发");
  // F1 幂等：该候选**已是当前候选且不陈旧** ⇒ 纯 no-op（不写事件、不改记录），只有状态确实改变时才写
  // 一条 review.reused 审计事件（见下表 A→B→A 用例）。
  assert.equal(h.reviewEvs(fx.goal).filter((e) => e.event === "review.reused").length, 0, "同候选重复调用为纯幂等 no-op");
  assert.ok(!/reuse_count/.test(recordOf(h, fx.goal, res.review_id)), "no-op 不得写 reuse_count（记录逐字未变）");
  assert.equal(again.reused_current, true, "F1：复用当前候选 ⇒ reused_current=true");
  assert.equal(again.stale, false);
  assert.equal(again.current_candidate_sha, h.head, "F1：返回值与投影同源（current_candidate_sha）");
  assert.equal(again.current_candidate_sha, goalReviewState(h.root, fx.goal).current_candidate_sha);
});

test("g-436 判据1：候选不可解析 / attempt 不存在 / 收集 attempt 一律拒绝（拒绝即零派发）", async () => {
  const h = createHarness();
  const fx = await prepareDispatched(h);
  const before = h.capturedRequests.length;

  assert.match(await toolError(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: "no-such-ref-xyz" }), /无法解析候选 commit/);
  assert.match(await toolError(h, "graph_start_review", { goal: fx.goal, attempt: "att-999", candidate_commit: h.head }), /attempt 不存在/);
  assert.ok(await toolError(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: "" }));
  assert.equal(h.capturedRequests.length, before, "拒绝路径不得启动任何子代理");
  assert.deepEqual(reviewFiles(fx), [], "拒绝路径不得留下评审记录");
});

test("g-436 判据1：HTTP 入口与工具入口共用一套实现（同一候选给出一致结果，不同候选另立记录）", async () => {
  const h = createHarness();
  const fx = await prepareDispatched(h);

  const handler = h.registeredRoutes.get("/api/dsh-graph/start-review");
  assert.ok(handler, "start-review 端点已注册");
  const post = async (body: any) => {
    const req = fakeReq("POST", `/api/dsh-graph/start-review?workspace=${encodeURIComponent(h.ws)}`, body);
    const res = fakeRes();
    const p = handler(req, res);
    req._emit();
    await p;
    return { code: res._code, body: res._body };
  };

  const http1 = await post({ goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head });
  assert.equal(http1.code, 200);
  assert.equal(http1.body.ok, true);
  assert.equal(http1.body.review_id, `rev-${fx.attempt}-01`);
  assert.equal(http1.body.candidate_sha, h.head, "HTTP 与工具入口共用同一候选解析实现");
  assert.equal(http1.body.reviewer_child_id, "child-review-1");
  assert.equal(http1.body.reused, false);
  assert.equal(h.reviewEvs(fx.goal)[0].details.requested_by, "human:gui", "HTTP 入口身份如实记为 human:gui（不冒充真人）");
  // F1：HTTP 入口也必须是**同一套可见性字段**（两处手写响应各自登记 ⇒ 用一致性断言钉住漂移）
  for (const k of ["reused_current", "stale", "current_candidate_sha", "independent_ok", "independent_missing"]) {
    assert.ok(k in http1.body, `HTTP 响应缺少可见性字段 ${k}（工具入口与 HTTP 入口必须同源）`);
  }
  assert.equal(http1.body.current_candidate_sha, h.head, "HTTP 入口的当前候选与请求候选一致");
  assert.equal(http1.body.reused_current, true);
  assert.equal(http1.body.stale, false);
  assert.equal(http1.body.independent_missing, true, "派发瞬间尚无完成的独立评审（保守方向，与投影此刻一致）");

  // 工具入口对**同一候选**给出逐字段一致的结果
  const toolSame = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head });
  assert.equal(toolSame.review_id, http1.body.review_id);
  assert.equal(toolSame.candidate_sha, http1.body.candidate_sha);
  assert.equal(toolSame.reviewer_child_id, http1.body.reviewer_child_id);
  assert.equal(toolSame.reused, true);

  // 新候选 ⇒ 另立记录，旧记录只作历史（stale）
  writeFileSync(join(h.ws, "second.txt"), "y");
  execFileSync("git", ["add", "."], { cwd: h.ws });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "second"], { cwd: h.ws });
  const head2 = execFileSync("git", ["rev-parse", "HEAD"], { cwd: h.ws }).toString().trim();
  const http2 = await post({ goal: fx.goal, attempt: fx.attempt, candidate_commit: head2, baseline_commit: h.head });
  assert.equal(http2.code, 200);
  assert.equal(http2.body.review_id, `rev-${fx.attempt}-02`, "不同候选另立 review_id");
  assert.equal(http2.body.candidate_sha, head2);
  assert.deepEqual(http2.body.changed_paths, ["second.txt"], "审查范围 = 基线→候选的真实 diff");

  const state = goalReviewState(h.root, fx.goal);
  assert.equal(state.current_candidate_sha, head2);
  assert.equal(state.reviews.length, 2);
  assert.equal(state.reviews[0].stale, true, "旧候选记录标为 stale（只作历史）");
  assert.equal(state.reviews[1].stale, false);
  assert.deepEqual(readFileSync(fx.attFile), fx.attemptBytes, "HTTP 路径同样不改作者 attempt.md");
  assert.deepEqual(readFileSync(fx.resultsFile), fx.resultsBytes, "HTTP 路径同样不覆盖作者结果");
});

// =====================================================================================
// 判据 2：身份真源 + reviewer 越权守卫 + 作者不得自登记
// =====================================================================================

test("g-436 判据2：工具参数面无自报身份字段；reviewer child 只来自真实 spawn", async () => {
  const def = createHarness().toolsByName.get("graph_start_review");
  const props = Object.keys(def.parameters.properties).sort();
  assert.deepEqual(props, ["attempt", "baseline_commit", "candidate_commit", "goal", "guidance", "mode", "model", "provider", "reasoning_effort"]);
  for (const forbidden of ["actor", "role", "child_id", "reviewer_child_id", "reviewer", "requested_by", "status"]) {
    assert.ok(!props.includes(forbidden), `工具参数面不得暴露 ${forbidden}（身份只从真实执行上下文取）`);
  }
  assert.equal(def.parameters.additionalProperties, false, "参数严格白名单");
  assert.deepEqual([...def.parameters.required].sort(), ["attempt", "candidate_commit", "goal"]);
});

test("g-436 判据2：reviewer 身份不得裁决接受（含 force/fast_track）或直接推进 delivered；主管正常路径不受影响", async () => {
  const h = createHarness({ policy: "strict" });
  const fx = await prepareDispatched(h);
  const res = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head });

  // reviewer 的真实身份 = execute 上下文中的耗子身份（childId === 会话 id）
  const reviewerExec = { agent: { id: res.reviewer_child_id, session: { header: { cwd: h.ws }, id: res.reviewer_child_id } }, signal: new AbortController().signal };
  assert.match(await toolError(h, "graph_resolve_accept", { goal: fx.goal, verdict: "accept" }, reviewerExec), /复核子代理身份不得执行/);
  assert.match(await toolError(h, "graph_resolve_accept", { goal: fx.goal, verdict: "accept", force: true, reason: "x" }, reviewerExec), /graph_resolve_accept\(force\)/);
  assert.match(await toolError(h, "graph_resolve_accept", { goal: fx.goal, verdict: "accept", fast_track: true }, reviewerExec), /graph_resolve_accept\(fast_track\)/);
  assert.match(await toolError(h, "graph_transition", { goal: fx.goal, to: "delivered" }, reviewerExec), /graph_transition\(to=delivered\)/);
  // 越权被拒时零副作用：状态不变、无 review.passed
  assert.equal(String(loadGoal(fx.goalFile).meta.status), "review", "越权被拒不得改状态");
  assert.equal(h.reviewEvs(fx.goal).filter((e) => e.event === "review.passed").length, 0);

  // reviewer 自己也**不得**再派发评审（工具面同样不暴露 graph_start_review 给 reviewer 角色）
  assert.ok(!h.capturedRequests.slice(2).length, "越权尝试不得启动子代理");

  // 正向对照：主管身份正常裁决不受影响
  const accepted = await callTool(h, "graph_resolve_accept", { goal: fx.goal, verdict: "accept" }, h.authExec);
  assert.equal(accepted.ok, true);
  assert.equal(String(loadGoal(fx.goalFile).meta.status), "delivered");
});

test("g-436 判据2：作者不得把自己的输出登记为独立评审（self_requested 记录但不构成独立 PASS）", async () => {
  const h = createHarness({ policy: "strict" });
  const fx = await prepareDispatched(h);
  // 用**作者自己的真实身份**请求评审 ⇒ requested_by === agent:<作者 child_id>
  const authorExec = { agent: { id: fx.authorChild, session: { header: { cwd: h.ws }, id: fx.authorChild } }, signal: new AbortController().signal };
  const res = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head }, authorExec);
  const dispatched = h.reviewEvs(fx.goal).filter((e) => e.event === "review.dispatched")[0];
  assert.equal(dispatched.details.self_requested, true, "作者自派必须如实记录（可见化，不静默接受为独立）");
  assert.equal(dispatched.details.author_child_id, fx.authorChild);

  // 即便 reviewer 给出明文 PASS，也不构成「独立评审」
  h.emit("subagent/end", {
    id: res.reviewer_child_id, local: true, stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "**总判**：PASS\n逐项结论：自评通过" }],
  });
  const state = goalReviewState(h.root, fx.goal);
  assert.equal(state.reviews[0].conclusion, "PASS", "结论如实留痕");
  assert.equal(state.reviews[0].independent, false, "作者自派不构成独立");
  assert.equal(state.independent_ok, false, "作者自登记不得算作独立评审通过");
  assert.equal(state.independent_missing, true, "strict 目标仍如实标注未独立评审");
});

// =====================================================================================
// 判据 3：注入材料受限（无作者上下文）
// =====================================================================================

test("g-436 判据3：注入材料只含目标定义/判据/候选+基线/范围/骨架；作者上下文与自报 PASS 不注入", async () => {
  const h = createHarness();
  const fx = await prepareDispatched(h);
  await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head, baseline_commit: h.head });
  const prompt = String(h.capturedRequests[1].request.prompt[0].text);

  // 必须注入的材料
  assert.ok(prompt.includes(h.head), "候选 SHA 必须注入");
  assert.ok(prompt.includes(fx.attempt), "被评审 attempt 必须注入");
  assert.match(prompt, /\*\*验收判据（原文）\*\*/);
  assert.ok(prompt.includes("判据一：接线与可见化"), "判据原文必须注入");
  assert.match(prompt, /\*\*目标定义（原文，含负责人约束）\*\*/);
  assert.ok(prompt.includes("g-436 夹具目标"), "目标定义必须注入");
  assert.ok(prompt.includes("OWNER-CONSTRAINT-SENTINEL-1"), "负责人约束（写在目标描述里）必须注入");
  assert.match(prompt, /报告骨架/);
  assert.ok(prompt.includes("PASS / BLOCK / UNVERIFIED"), "报告骨架三值");
  assert.ok(prompt.includes("未验证项"), "报告骨架含未验证项");
  assert.match(prompt, /评审材料边界/);

  // 绝不注入：作者 brief / 作者结果 / 评论 / 返工 handoff / 作者自报结论
  for (const sentinel of [
    "AUTHOR-BRIEF-SENTINEL-42",
    "AUTHOR-RESULTS-SENTINEL-7",
    "AUTHOR-COMMENT-SENTINEL-9",
    "REWORK-HANDOFF-SENTINEL-3",
    "SELF-REPORTED-PASS-SENTINEL-5",
  ]) {
    assert.ok(!prompt.includes(sentinel), `作者上下文不得注入评审材料：${sentinel}`);
  }
  assert.ok(!/results-att-/.test(prompt), "不得提及/引用作者结果文件");
  assert.ok(!prompt.includes("## 通用执行纪律"), "不得复用执行 attempt 的 prompt 骨架（那是作者上下文通道）");
  assert.ok(!prompt.includes("【强制 worktree 隔离】"), "不得复用执行 prompt 的隔离段落");
  // 不是作者上下文的 fork：评审请求不带父对话续轮载荷（只有 prompt + parent + toolFilter）
  const req = h.capturedRequests[1].request;
  assert.deepEqual(Object.keys(req).sort(), ["parent", "prompt", "toolFilter"], "评审请求载荷面固定（无 fork/无作者会话续写）");

  // reviewer 工具作用域：只读，且不含任何管理写工具
  const allow: string[] = req.toolFilter?.allow ?? [];
  assert.ok(allow.includes("read") && allow.includes("glob") && allow.includes("grep"), "reviewer 保留只读审查工具");
  for (const w of ["graph_resolve_accept", "graph_transition", "graph_start_attempt", "graph_start_review", "graph_update_settings", "graph_set_criteria", "write", "edit"]) {
    assert.ok(!allow.includes(w), `reviewer 工具作用域不得含 ${w}`);
  }
});

// =====================================================================================
// 判据 4：strict 未独立评审可见化（不阻断 accept）+ 默认路径零回归 + GUI
// =====================================================================================

test("g-436 判据4：strict 未独立评审 ⇒ 可见标注 + 一条事件（追加在映射之后），accept 仍成功", async () => {
  const h = createHarness({ policy: "strict" });
  const fx = await prepareDispatched(h);
  // 已派发但未完成 ⇒ 进行中且无独立 PASS
  await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head });

  const state = goalReviewState(h.root, fx.goal);
  assert.equal(state.policy, "strict");
  assert.equal(state.status, "in_progress");
  assert.equal(state.independent_ok, false);
  assert.equal(state.independent_missing, true, "strict 且无独立评审 ⇒ 必须标注");
  // 看板/目标详情投影必须携带该可见性
  const detail = goalDetail(h.root, fx.goal);
  assert.deepEqual(detail.review_state, state, "goalDetail 如实透出 review_state（GUI 数据源）");

  const accepted = await callTool(h, "graph_resolve_accept", { goal: fx.goal, verdict: "accept" }, h.authExec);
  assert.equal(accepted.ok, true, "负责人裁决：可见化**不阻断** accept");
  assert.equal(String(loadGoal(fx.goalFile).meta.status), "delivered", "accept 仍照常完成交付收口");

  const evs = readEvents(h.root).filter((e) => e.goal === fx.goal);
  const markers = evs.filter((e) => e.event === "review.independent_missing");
  assert.equal(markers.length, 1, "恰好一条未独立评审标注事件");
  assert.equal(markers[0].details.policy, "strict");
  assert.equal(markers[0].details.current_candidate_sha, h.head);
  assert.equal(markers[0].details.review_status, "in_progress");
  assert.match(String(markers[0].details.note), /不阻断 accept/);
  // 追加在 accept 映射**之后** ⇒ 既有事件前缀逐字不变
  const lastTransition = evs.map((e) => e.event).lastIndexOf("goal.transition");
  assert.equal(evs.map((e) => e.event).lastIndexOf("review.independent_missing"), evs.length - 1, "标注事件是最后一条");
  assert.ok(evs.length - 1 > lastTransition, "标注事件位于映射事件之后");
});

test("g-436 判据4：非 strict 目标 accept 零新增事件（默认路径零回归）", async () => {
  const h = createHarness(); // 未配置 review.policy；type=patch ⇒ 策略 auto
  const fx = await prepareDispatched(h, { type: "patch" });
  const state = goalReviewState(h.root, fx.goal);
  assert.equal(state.policy, "auto", "patch 派生 auto");
  assert.equal(state.independent_missing, false, "非 strict 不标注");
  const before = readEvents(h.root).filter((e) => e.goal === fx.goal).length;
  await callTool(h, "graph_resolve_accept", { goal: fx.goal, verdict: "accept" }, h.authExec);
  const evs = readEvents(h.root).filter((e) => e.goal === fx.goal);
  assert.equal(evs.filter((e) => e.event === "review.independent_missing").length, 0, "非 strict 零新增标注事件");
  const delta = evs.slice(before).map((e) => e.event);
  assert.deepEqual(delta, ["goal.transition", "review.passed"], "默认 accept 路径事件序列逐字不变（仅既有映射事件）");
  assert.equal(String(loadGoal(fx.goalFile).meta.status), "delivered");
});

test("g-436 判据4：fast_track（auto 策略）成功路径的事件序列逐字不变", async () => {
  const h = createHarness(); // auto
  const fx = await prepareDispatched(h, { type: "patch" });
  await callTool(h, "graph_resolve_accept", {
    goal: fx.goal, verdict: "accept", fast_track: true,
    machine_report: {
      baseline_commit: h.head, changed_paths: ["core/ops.ts"], product_changed_lines: 12,
      untracked_files: 0, tests: { exit_code: 0, fail: 0 }, typecheck: { exit_code: 0 },
    },
  }, h.authExec);
  const names = readEvents(h.root).filter((e) => e.goal === fx.goal).map((e) => e.event);
  const tail = names.slice(-3);
  assert.deepEqual(tail, ["review.fast_track", "goal.transition", "review.passed"], "快速放行序列不被可见化污染");
  assert.ok(!names.includes("review.independent_missing"), "auto 策略不追加标注事件");
});

// ---------------------------------------------------------------------------------
// GUI：vm 真实渲染 AcceptFeedback（有标注 + 接受按钮仍可点）
// ---------------------------------------------------------------------------------

const CLIENT_DIR = join(import.meta.dirname, "../../dsh-graph-host/lib/client");

/** 字符串/注释感知的花括号配平切片（避免被字面量里的花括号误导）。 */
function extractBraced(src: string, header: string): string {
  const start = src.indexOf(header);
  assert.ok(start >= 0, `未找到 ${header}`);
  let i = src.indexOf("{", start);
  let depth = 0;
  let out = "";
  let mode: string = "code";
  for (; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; out += c; continue; }
      if (c === "/" && n === "*") { mode = "block"; out += c; continue; }
      if (c === '"' || c === "'" || c === "`") { mode = c; out += c; continue; }
      if (c === "{") depth++;
      else if (c === "}") { depth--; out += c; if (depth === 0) return out; continue; }
      out += c;
    } else if (mode === "line") {
      out += c;
      if (c === "\n") mode = "code";
    } else if (mode === "block") {
      out += c;
      if (c === "*" && n === "/") { out += n; i++; mode = "code"; }
    } else {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i++; continue; }
      if (c === mode) mode = "code";
    }
  }
  throw new Error(`${header} 未闭合`);
}

function loadClientI18n(): { zh: Record<string, string>; en: Record<string, string> } {
  const source = readFileSync(join(CLIENT_DIR, "i18n.js"), "utf8");
  const sandbox: any = { React: {} };
  vm.runInNewContext(source + "; this.zh = zh; this.en = en;", sandbox);
  return { zh: sandbox.zh, en: sandbox.en };
}

/** 渲染 AcceptFeedback 并返回扁平化节点列表（真实执行客户端源码）。 */
function renderAcceptFeedback(props: any, zh: Record<string, string>) {
  const source = readFileSync(join(CLIENT_DIR, "goal-actions.js"), "utf8");
  const body = extractBraced(source, "function AcceptFeedback(props) {");
  const sandbox: any = {
    h: (type: any, p: any, ...kids: any[]) => ({ type, props: p ?? {}, kids: kids.flat().filter((k) => k !== null && k !== undefined) }),
    React: { useState: (v: any) => [v, () => {}] },
    S: {},
    dgT: (k: string) => zh[k] ?? k,
    hasActiveExecutionAttempt: () => false,
    InProgressPrompt: () => null,
    DefinitionPolish: () => null,
    fetch: () => { throw new Error("render 期间不得发起请求"); },
    confirm: () => false,
    graphUrl: (p: string) => p,
    promptSessionQueue: async () => true,
    console,
    appCtx: undefined,
    sessionsRt: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(`function AcceptFeedback(props) ${body}; this.AcceptFeedback = AcceptFeedback;`, sandbox);
  const el = sandbox.AcceptFeedback(props);
  const nodes: any[] = [];
  const walk = (n: any) => {
    if (n === null || n === undefined) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n !== "object") { nodes.push({ text: String(n) }); return; }
    nodes.push({ className: n.props?.className, disabled: n.props?.disabled, title: n.props?.title, text: n.kids?.filter((k: any) => typeof k === "string").join("") ?? "" });
    (n.kids ?? []).forEach(walk);
  };
  walk(el);
  return nodes;
}

test("g-436 判据4：GUI 源码/词条齐备，且 vm 真实渲染证明「有标注、接受按钮仍可点」", () => {
  const actions = readFileSync(join(CLIENT_DIR, "goal-actions.js"), "utf8");
  assert.match(actions, /dg-review-missing/, "未独立评审标注的 className 存在");
  assert.match(actions, /dgT\("exec\.reviewMissing"\)/, "标注文案走 i18n");
  const modal = readFileSync(join(CLIENT_DIR, "goal-modal.js"), "utf8");
  assert.match(modal, /reviewState: d\.review_state/, "目标详情弹窗把 review_state 透传给接受交互");

  const { zh, en } = loadClientI18n();
  for (const key of ["exec.reviewMissing", "exec.reviewMissingTitle", "exec.reviewPass", "exec.reviewBlock", "exec.reviewInProgress", "exec.reviewUnverified"]) {
    assert.ok(zh[key], `zh 缺失 ${key}`);
    assert.ok(en[key], `en 缺失 ${key}`);
    assert.doesNotMatch(en[key], /[\u3400-\u9fff]/, `en ${key} 不得含 CJK`);
  }
  assert.equal(zh["exec.reviewMissing"], "⚠️ 未独立评审");

  const base = { goalId: "g-9", status: "review", events: [], attempts: [] };
  const strictNodes = renderAcceptFeedback({
    ...base,
    reviewState: { policy: "strict", status: "in_progress", independent_ok: false, independent_missing: true },
  }, zh);
  const badge = strictNodes.find((n) => n.className === "dg-review-missing");
  assert.ok(badge, "strict 未独立评审必须渲染出标注节点");
  assert.equal(badge.text, "⚠️ 未独立评审");
  const acceptBtn = strictNodes.find((n) => n.className === "dg-btn-accept");
  assert.ok(acceptBtn, "接受按钮仍必须渲染（可见化不阻断）");
  assert.equal(acceptBtn.disabled, false, "未独立评审**不得**禁用接受按钮（负责人裁决：只标注不阻断）");
  assert.equal(acceptBtn.text, zh["exec.accept"]);

  // 负向对照：无 review_state（非 strict / 旧数据）⇒ 不渲染标注，接受按钮行为逐字不变
  const plainNodes = renderAcceptFeedback(base, zh);
  assert.equal(plainNodes.find((n) => n.className === "dg-review-missing"), undefined, "无 review_state 不得渲染标注");
  assert.equal(plainNodes.find((n) => n.className === "dg-btn-accept")?.disabled, false);

  // 独立评审 PASS ⇒ 显示 PASS 而非「未独立评审」
  const passNodes = renderAcceptFeedback({
    ...base,
    reviewState: { policy: "strict", status: "pass", independent_ok: true, independent_missing: false },
  }, zh);
  assert.ok(passNodes.find((n) => n.className === "dg-review-pass"), "独立 PASS 显示 PASS 标注");
  assert.equal(passNodes.find((n) => n.className === "dg-review-missing"), undefined);
});

// =====================================================================================
// 判据 5：结论按 review_id + 真实候选 SHA 独立留痕；异常路径绝不记 PASS
// =====================================================================================

test("g-436 判据5：纯函数——认不出显式总判行即为 UNVERIFIED；非 completed 一律不算干净结束", () => {
  assert.equal(parseReviewConclusion("**总判**：PASS\n证据：x"), "PASS");
  assert.equal(parseReviewConclusion("- Verdict: BLOCK"), "BLOCK");
  assert.equal(parseReviewConclusion("总判：UNVERIFIED"), "UNVERIFIED");
  assert.equal(parseReviewConclusion("看起来没问题，应该可以"), "UNVERIFIED", "无显式总判行不得当 PASS");
  assert.equal(parseReviewConclusion(""), "UNVERIFIED", "空输出不得当 PASS");
  assert.equal(parseReviewConclusion(null), "UNVERIFIED");
  assert.equal(parseReviewConclusion("总判：MAYBE"), "UNVERIFIED", "三值之外一律 UNVERIFIED");
  assert.deepEqual([...REVIEW_CONCLUSIONS], ["PASS", "BLOCK", "UNVERIFIED"]);
  assert.deepEqual([...REVIEW_RECORD_STATUSES], ["started", "bound", "completed", "failed"]);

  assert.equal(isCleanReviewStopReason("completed"), true);
  assert.equal(isCleanReviewStopReason(null), true);
  assert.equal(isCleanReviewStopReason("error"), false);
  assert.equal(isCleanReviewStopReason("aborted"), false);
  assert.equal(isCleanReviewStopReason("completed; diagnostic: restart"), false, "带诊断的完成不得视为干净");
});

test("g-436 判据5：正常完成 ⇒ 结论按 review_id+候选 SHA 独立落盘，作者结果不受影响", async () => {
  const h = createHarness({ policy: "strict" });
  const fx = await prepareDispatched(h);
  const res = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head });

  h.emit("subagent/end", {
    id: res.reviewer_child_id, local: true, stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "**总判**：PASS\n逐项结论：判据一 ✅ 证据：`node --test` 全绿（候选 " + h.head + "）\n未验证项：无" }],
  });

  const evs = h.reviewEvs(fx.goal);
  const completed = evs.filter((e) => e.event === "review.completed");
  assert.equal(completed.length, 1);
  assert.equal(completed[0].details.conclusion, "PASS");
  assert.equal(completed[0].details.status, "completed");
  assert.equal(completed[0].details.review_id, res.review_id);
  assert.equal(completed[0].details.candidate_sha, h.head, "结论绑定真实候选 SHA");
  assert.equal(completed[0].details.reviewer_child_id, res.reviewer_child_id, "结论归属真实 reviewer child");
  assert.ok(String(completed[0].details.report_file).endsWith(join(REVIEWS_DIR, `${res.review_id}.md`)), "报告文件独立于作者结果");

  const body = recordOf(h, fx.goal, res.review_id);
  assert.ok(body.includes("逐项结论：判据一"), "报告正文独立落盘");
  assert.equal(loadGoal(join(reviewsDirOf(fx), `${res.review_id}.md`)).meta.conclusion, "PASS");
  assert.equal(loadGoal(join(reviewsDirOf(fx), `${res.review_id}.md`)).meta.candidate_sha, h.head);

  const state = goalReviewState(h.root, fx.goal);
  assert.equal(state.status, "pass");
  assert.equal(state.independent_ok, true);
  assert.equal(state.independent_missing, false);
  // 作者结果逐字不变；没有产生任何 results-att-<review_id>.md
  assert.deepEqual(readFileSync(fx.resultsFile), fx.resultsBytes, "评审绝不覆盖作者结果（last-wins 毁证）");
  assert.deepEqual(reviewFiles(fx), [`${res.review_id}.md`]);
});

test("g-436 判据5：异常终止 / 空输出 / 无总判行 / 归属不明 child 一律不得记 PASS", async () => {
  const h = createHarness({ policy: "strict" });
  const fx = await prepareDispatched(h);

  // ① 异常终止但正文写了 PASS ⇒ 降级 UNVERIFIED + failed
  const r1 = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head });
  h.emit("subagent/end", { id: r1.reviewer_child_id, local: true, stopReason: "error", lastAssistantMessage: [{ type: "text", text: "**总判**：PASS" }] });
  let evs = h.reviewEvs(fx.goal);
  assert.equal(evs.filter((e) => e.event === "review.completed").length, 0, "异常终止不得记 review.completed");
  const failed1 = evs.filter((e) => e.event === "review.failed");
  assert.equal(failed1.length, 1);
  assert.equal(failed1[0].details.conclusion, "UNVERIFIED", "异常终止必须降级，绝不记 PASS");
  assert.match(String(failed1[0].details.reason), /异常终止/);
  assert.equal(goalReviewState(h.root, fx.goal).independent_ok, false);

  // ② 空输出 ⇒ failed + UNVERIFIED
  const h2 = createHarness({ policy: "strict" });
  const fx2 = await prepareDispatched(h2);
  const r2 = await callTool(h2, "graph_start_review", { goal: fx2.goal, attempt: fx2.attempt, candidate_commit: h2.head });
  h2.emit("subagent/end", { id: r2.reviewer_child_id, local: true, stopReason: "completed", lastAssistantMessage: [] });
  const failed2 = h2.reviewEvs(fx2.goal).filter((e) => e.event === "review.failed");
  assert.equal(failed2.length, 1);
  assert.equal(failed2[0].details.conclusion, "UNVERIFIED", "空输出不得当 PASS");
  assert.match(String(failed2[0].details.reason), /无输出/);
  assert.ok(recordOf(h2, fx2.goal, r2.review_id).includes("评审进行中"), "空输出保留占位正文，不伪造结论");
  assert.equal(goalReviewState(h2.root, fx2.goal).independent_ok, false);

  // ③ 载荷整体缺失（宿主未提供）⇒ 仍不得 PASS、且不留下「进行中」假象
  const h3 = createHarness({ policy: "strict" });
  const fx3 = await prepareDispatched(h3);
  const r3 = await callTool(h3, "graph_start_review", { goal: fx3.goal, attempt: fx3.attempt, candidate_commit: h3.head });
  h3.emit("subagent/end", { id: r3.reviewer_child_id, local: true });
  assert.equal(h3.reviewEvs(fx3.goal).filter((e) => e.event === "review.completed").length, 0, "载荷缺失不得记 PASS");
  assert.equal(h3.reviewEvs(fx3.goal).filter((e) => e.event === "review.failed").length, 1);
  assert.equal(goalReviewState(h3.root, fx3.goal).independent_ok, false);

  // ④ 有正文但无显式总判行 ⇒ completed 但结论 UNVERIFIED（不算独立通过）
  const h4 = createHarness({ policy: "strict" });
  const fx4 = await prepareDispatched(h4);
  const r4 = await callTool(h4, "graph_start_review", { goal: fx4.goal, attempt: fx4.attempt, candidate_commit: h4.head });
  h4.emit("subagent/end", {
    id: r4.reviewer_child_id, local: true, stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "我读了一遍，感觉没问题。" }],
  });
  const done4 = h4.reviewEvs(fx4.goal).filter((e) => e.event === "review.completed");
  assert.equal(done4.length, 1);
  assert.equal(done4[0].details.conclusion, "UNVERIFIED", "认不出总判行不得当 PASS");
  assert.equal(goalReviewState(h4.root, fx4.goal).independent_ok, false);

  // ⑤ 归属不明的 child（宿主重启后的冷恢复形态）⇒ 不写、不猜、不崩
  const h5 = createHarness({ policy: "strict" });
  const fx5 = await prepareDispatched(h5);
  const r5 = await callTool(h5, "graph_start_review", { goal: fx5.goal, attempt: fx5.attempt, candidate_commit: h5.head });
  const before = h5.reviewEvs(fx5.goal).length;
  assert.doesNotThrow(() => h5.emit("subagent/end", {
    id: "child-unknown-cold-restore", local: true, stopReason: "completed",
    lastAssistantMessage: [{ type: "text", text: "**总判**：PASS" }],
  }), "归属不明的 child 不得让宿主回调抛错");
  assert.equal(h5.reviewEvs(fx5.goal).length, before, "归属不明一律不写事件（绝不猜成 PASS）");
  const state5 = goalReviewState(h5.root, fx5.goal);
  assert.equal(state5.status, "in_progress", "记录如实保持「进行中」（不伪造终态）");
  assert.equal(state5.independent_ok, false);
  assert.deepEqual(readFileSync(fx5.resultsFile), fx5.resultsBytes, "作者结果全程不被触碰");
  // 真实绑定的 child 之后仍可正常结算
  h5.emit("subagent/end", { id: r5.reviewer_child_id, local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "总判：BLOCK" }] });
  assert.equal(goalReviewState(h5.root, fx5.goal).status, "block");
});

test("g-436 判据5：派发失败（无 provider / spawn 抛错）如实结算为 failed，绝不留下「进行中」", async () => {
  const h = createHarness();
  const fx = await prepareDispatched(h);
  h.spawnFail.value = "ACTIVATION_LIMIT_REACHED";
  const res = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head });
  assert.equal(res.reviewer_child_id, null, "spawn 失败无 reviewer child");
  assert.match(String(res.child_error), /ACTIVATION_LIMIT|友好|上限/);
  h.spawnFail.value = null;
  const failed = h.reviewEvs(fx.goal).filter((e) => e.event === "review.failed");
  assert.equal(failed.length, 1);
  assert.equal(failed[0].details.conclusion, "UNVERIFIED");
  assert.equal(goalReviewState(h.root, fx.goal).status, "failed");
  assert.equal(goalReviewState(h.root, fx.goal).independent_ok, false);
  // failed 之后允许重新派发（不把失败记录当「已派发」而永久卡住）
  const again = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head });
  assert.equal(again.reused, false, "failed 记录不参与幂等复用");
  assert.notEqual(again.review_id, res.review_id);
});

// =====================================================================================
// 追加项 F1：A→B→A 时「工具返回值」与「看板投影」必须一致（此前两句自相矛盾）
// =====================================================================================

test("g-436 F1：A→B→A 复用旧记录时，返回值与投影同源一致，且保守方向不变", async () => {
  const h = createHarness({ policy: "strict" });
  const fx = await prepareDispatched(h);
  const shaA = h.head;

  // A：派发并完成独立评审 PASS
  const rA = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: shaA });
  h.emit("subagent/end", { id: rA.reviewer_child_id, local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "**总判**：PASS" }] });
  let st = goalReviewState(h.root, fx.goal);
  assert.equal(st.current_candidate_sha, shaA);
  assert.equal(st.independent_ok, true);
  assert.equal(st.independent_missing, false);

  // B：新候选 → R2；此时 R1(A) 变 stale、当前候选无独立评审（保守方向）
  writeFileSync(join(h.ws, "b.txt"), "b");
  execFileSync("git", ["add", "."], { cwd: h.ws });
  execFileSync("git", ["-c", "user.email=t@e", "-c", "user.name=t", "commit", "-qm", "B"], { cwd: h.ws });
  const shaB = execFileSync("git", ["rev-parse", "HEAD"], { cwd: h.ws }).toString().trim();
  const rB = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: shaB, baseline_commit: shaA });
  assert.equal(rB.independent_missing, true, "新候选在完成评审前必须标注「未独立评审」");
  // 保守方向（关键）：B 尚未完成时，A 的 PASS **不得**被算作当前候选的独立通过
  st = goalReviewState(h.root, fx.goal);
  assert.equal(st.current_candidate_sha, shaB, "B 成为当前候选");
  assert.equal(st.independent_ok, false, "旧候选（A）的 PASS 绝不适用于新候选（B）");
  assert.equal(st.independent_missing, true);
  assert.equal(st.reviews.find((r) => r.review_id === rA.review_id)!.stale, true, "A 的记录在 B 成为当前候选后 stale");
  // B 也完成 PASS（两面都有 PASS，仍以「当前候选」为准）
  h.emit("subagent/end", { id: rB.reviewer_child_id, local: true, stopReason: "completed", lastAssistantMessage: [{ type: "text", text: "**总判**：PASS" }] });
  st = goalReviewState(h.root, fx.goal);
  assert.equal(st.current_candidate_sha, shaB);
  assert.equal(st.independent_ok, true, "B 自身也有独立 PASS");

  // A→B→A：再次请求候选 A ⇒ 复用 R1，且**重新置为当前**（语义裁决①）
  const back = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: shaA });
  assert.equal(back.reused, true, "复用 R1");
  assert.equal(back.review_id, rA.review_id);
  assert.equal(back.reused_current, true, "F1：复用后该候选就是当前候选");
  assert.equal(back.stale, false, "F1：返回值不再自称 stale");

  const detail = goalDetail(h.root, fx.goal);
  const after = detail.review_state;
  // 两面一致：工具返回值 ↔ 看板投影（逐字段）
  assert.equal(back.current_candidate_sha, after.current_candidate_sha);
  assert.equal(back.independent_ok, after.independent_ok);
  assert.equal(back.independent_missing, after.independent_missing);
  assert.equal(back.stale, after.reviews.find((r: any) => r.review_id === back.review_id)!.stale);
  assert.equal(back.conclusion, after.reviews.find((r: any) => r.review_id === back.review_id)!.conclusion);
  // 投影语义：当前候选回到 A；B 的记录转 stale；无「未独立评审」标注
  assert.equal(after.current_candidate_sha, shaA);
  assert.equal(after.reviews.find((r: any) => r.review_id === rA.review_id)!.stale, false);
  assert.equal(after.reviews.find((r: any) => r.review_id === rB.review_id)!.stale, true);
  assert.equal(after.independent_missing, false);
  // 事件流留痕（可审计的再请求，不是静默复活）
  const reuseEvs = h.reviewEvs(fx.goal).filter((e) => e.event === "review.reused");
  assert.equal(reuseEvs.length, 1);
  assert.equal(reuseEvs[0].details.candidate_sha, shaA);
  assert.equal(h.capturedRequests.length, 3, "复用不新增子代理（仅 A/B 两次真实派发）");
  // 反向不会静默复活：复用 A 之后，B 的记录转为 stale（保留为历史，不再代表当前候选）
  assert.equal(after.reviews.find((r: any) => r.review_id === rB.review_id)!.stale, true, "B 的记录转为历史（stale）");
  const bEv = readEvents(h.root).filter((e) => e.goal === fx.goal && e.event === "review.reused");
  assert.equal(bEv.length, 1, "复用事件只在真实复用时出现（B 的派发是 dispatched 而非 reused）");
  // 幂等：再来一次「请求 A」——A 已是当前候选且不陈旧 ⇒ 纯 no-op（事件仍 1 条、记录逐字未变）
  const recordBefore = recordOf(h, fx.goal, back.review_id);
  const back2 = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: shaA });
  assert.equal(back2.review_id, back.review_id);
  assert.equal(back2.reused_current, true);
  assert.equal(back2.stale, false);
  assert.equal(back2.current_candidate_sha, back.current_candidate_sha);
  assert.equal(h.reviewEvs(fx.goal).filter((e) => e.event === "review.reused").length, 1, "重复复用为纯 no-op（不写事件）");
  assert.equal(recordOf(h, fx.goal, back.review_id), recordBefore, "no-op 复用不得改写记录文件（逐字未变）");
  assert.equal(h.capturedRequests.length, 3, "no-op 复用同样不派发子代理");
});

// =====================================================================================
// 追加项 F2：REVIEW_EVENT_NAMES 闭集与实现实际写入的事件名集合一致 + 有真实消费点
// =====================================================================================

test("g-436 F2：REVIEW_EVENT_NAMES 闭集完整（含第 5 个事件名）且与实现写入集合逐一相等", () => {
  const names = [...REVIEW_EVENT_NAMES];
  assert.deepEqual([...new Set(names)], names, "闭集不得有重复项");
  assert.ok(names.includes("review.independent_missing"), "accept 时的可见化标注事件必须在闭集内（此前注释写 4 项、实现用 5 项）");
  for (const n of ["review.dispatched", "review.bound", "review.reused", "review.completed", "review.failed"]) {
    assert.ok(names.includes(n as any), `闭集缺少 ${n}`);
  }
  // 记录子集：⊂ 闭集，且不含目标级标注
  for (const n of REVIEW_RECORD_EVENT_NAMES) assert.ok(names.includes(n), `记录事件 ${n} 必须属于闭集`);
  assert.ok(!(REVIEW_RECORD_EVENT_NAMES as readonly string[]).includes("review.independent_missing"), "目标级标注不得进入记录重放子集");

  // 与实现源码实际写入的 `event: "review.*"` 集合逐一相等（区块边界缺失 ⇒ 判红，不得静默通过）
  const src = readFileSync(join(import.meta.dirname, "../ops.ts"), "utf8");
  const start = src.indexOf("g-436：独立评审（Independent Review）——接线与可见化");
  const end = src.indexOf("// ---- Attempt（SCHEMA §3） ----", start);
  assert.ok(start >= 0 && end > start, "找不到评审区块边界（结构已变，请同步本守卫）");
  const block = src.slice(start, end);
  // 写入名解析：① 字面量 `event: "review.X"`；② 间接形式 `event: <ident>` ⇒ 解析该标识符在区块内的
  // 字面量赋值（如 `const eventName = failed ? "review.failed" : "review.completed"`），或导出常量的值。
  // 解析不出的间接形式一律记为 unresolved ⇒ 判红（fail-closed，新增间接事件名逃不过守卫）。
  const writtenSet = new Set<string>();
  const unresolved: string[] = [];
  for (const m of block.matchAll(/event:\s*"([^"]+)"/g)) writtenSet.add(m[1]);
  for (const m of block.matchAll(/event:\s*([A-Za-z_$][\w$]*)\s*,/g)) {
    const ident = m[1];
    const assign = block.match(new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*([^;]+);`));
    if (assign) {
      for (const lit of assign[1].matchAll(/"([^"]+)"/g)) writtenSet.add(lit[1]);
    } else if (ident === "REVIEW_INDEPENDENT_MISSING_EVENT") {
      writtenSet.add(REVIEW_INDEPENDENT_MISSING_EVENT);
    } else {
      unresolved.push(ident);
    }
  }
  assert.deepEqual(unresolved, [], `评审区块出现无法解析的事件名标识符（请同步本守卫的解析规则）：${unresolved.join(", ")}`);
  const written = [...writtenSet].filter((n) => n.startsWith("review.")).sort();
  assert.deepEqual(written, [...names].sort(), "闭集必须与评审区块实际写入的事件名逐一相等（注释说的项数 == 代码用的项数）");
  assert.ok(written.includes(REVIEW_INDEPENDENT_MISSING_EVENT), "目标级标注事件必须被解析到（此前它在闭集外）");
  // 消费点（源码级）：重放侧按记录子集过滤
  assert.match(block, /REVIEW_RECORD_EVENT_NAMES as readonly string\[\]\)\.includes\(ev\.event\)/, "重放必须用记录子集过滤（闭集的真实消费点）");
  assert.match(block, /assertReviewEventName\("review\.[a-z]+"\)|assertReviewEventName\(eventName\)|assertReviewEventName\(REVIEW_INDEPENDENT_MISSING_EVENT\)/, "写入侧必须有 fail-closed 校验调用");
});

test("g-436 F2：非闭集事件不参与记录重放（消费点的行为证明）", async () => {
  const h = createHarness({ policy: "strict" });
  const fx = await prepareDispatched(h);
  const res = await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head });
  assert.equal(goalReviewState(h.root, fx.goal).reviews.length, 1);
  // 伪造一个形似评审、但不在闭集内的事件（带 review_id）⇒ 重放必须忽略它
  appendEvent(h.root, {
    actor: "test",
    event: "review.bogus",
    goal: fx.goal,
    details: { review_id: "rev-att-001-99", candidate_sha: "deadbeef", status: "completed", conclusion: "PASS" },
  });
  const st = goalReviewState(h.root, fx.goal);
  assert.equal(st.reviews.length, 1, "非闭集事件不得被重放成第 2 条记录");
  assert.equal(st.reviews[0].review_id, res.review_id);
  assert.equal(st.independent_ok, false, "伪造事件不得制造独立 PASS");
});

// =====================================================================================
// 追加项 F3：prompt 给出 goal.md 路径 ⇒ 显式划界（方案②：保留路径 + 明文排除非审查材料）
// =====================================================================================

test("g-436 F3：评审 prompt 对 goal.md 的非审查材料显式划界（评论/最近指令/返工 handoff/证据台账）", async () => {
  const h = createHarness({ policy: "strict" });
  const fx = await prepareDispatched(h);
  // 把哨兵放进**评论段**与**最近指令段**（它们在 goal.md 里，从文件侧可读到）
  await callTool(h, "graph_add_comment", { goal: fx.goal, text: "COMMENT-SECTION-SENTINEL-77" });
  await callTool(h, "graph_set_directive", { goal: fx.goal, directive: "DIRECTIVE-SECTION-SENTINEL-88" });
  await callTool(h, "graph_start_review", { goal: fx.goal, attempt: fx.attempt, candidate_commit: h.head });
  const prompt = String(h.capturedRequests[1].request.prompt[0].text);

  // 方案②：保留路径（供按需复核定义），但必须明文划界
  assert.ok(prompt.includes(fx.goalFile.replace(`${h.ws}/`, "")), "仍给出目标定义文件路径（按需复核定义/判据）");
  assert.match(prompt, /\*\*仅供\*\*按需复核目标定义与判据原文/, "路径必须带「仅供定义/判据」的范围限定");
  assert.match(prompt, /评论 \/ 最近指令 \/ 返工 handoff \/ 证据台账/, "必须逐项点明非审查材料（评论/最近指令/返工 handoff/证据台账）");
  assert.match(prompt, /均不属审查材料/, "必须明确「不属审查材料」");
  assert.match(prompt, /不得据以评判候选/, "必须明确禁止据以评判");
  assert.match(prompt, /若为定位定义而读到，必须在「未验证项」中声明/, "读到非审查材料须声明（可审计）");
  // 文件侧哨兵仍不得被**内联**注入（载荷面干净）
  assert.ok(!prompt.includes("COMMENT-SECTION-SENTINEL-77"), "评论内容不得内联注入");
  assert.ok(!prompt.includes("DIRECTIVE-SECTION-SENTINEL-88"), "最近指令内容不得内联注入");
  // 英文同款划界（en 分支同源）
  const en = formatReviewPrompt({ goalId: "g-1", attemptId: "att-001", goalRel: "goal.md", language: "en", candidateSha: "abc", criteria: ["c1"] });
  assert.match(en, /NOT review material/);
  assert.match(en, /comments \/ latest directive \/ rework handoff \/ evidence ledger/);
  assert.match(en, /declare it under Unverified items/);
});
