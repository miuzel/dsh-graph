/**
 * g-613 真实宿主 E2E：`graph_start_attempt(goal, child_id=...)` 复用**空闲**专家子代理。
 *
 * 与 `g613-reuse-idle-child.test.ts`（16 例确定性桩覆盖）互补、不替代：本文件在**真实** 0.2.2 宿主栈
 * （Context / AgentRegistry / AgentLoop / SubagentRuntime + spawn-in-process provider；仅 LLM adapter 为
 * 进程内 fake ⇒ 不联网、不读凭据，tmp 全落本树 `tmp/`）上验证同一批判据。
 *
 * 真实宿主边界（本文件实测，0.2.2）：
 *   · continuable child 的「空闲」是**迁移态**：一轮结束 ⇒ `agent/status idle` ⇒ settlement watcher
 *     （独立微任务）立刻 dispose ⇒ registry 里只剩 `gone`。故「idle 且常驻」只在一轮**进行中**、
 *     由宿主自己发布的 idle 时刻成立。本文件用 `agent/created`/`agent/status` 两个**公开事件**只做
 *     观察（不写宿主状态、不改宿主行为），在该时刻发起**真实**工具调用；同时（不依赖时序）在
 *     `startChild()` 返回后再定位一次机会，二者先到先得。
 *   · 轮次之间冷恢复（宿主真实路径）：先发 `subagent/end`、再发下一代 `subagent/start`，且 durable
 *     childId 不变 ⇒ 场景 ④ 用**同一 child 的第二代**复现「上一轮 end / 跨代继续」。
 *   · `sendMessage` 只接受该 child 的**直接父会话**（宿主 `UNAUTHORIZED`）：场景 ⑤ 用 registry 的
 *     owner 交叉校验视图构造「另一个主管」发起投递，投递失败由宿**真拒**产生，不是模拟异常。
 *   · 既有契约：`subagent/end` 只写 `results-att-NNN.md` 与 `attempt.results_written`，不改
 *     `result` 字段（g-610 既有断言即 `result === "pending"`）——场景 ④ 的「不污染」据此断言。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createGoal, findGoalFile, goalDetail, setCriteria, setGoalDescription, transition } from "../ops.ts";
import { readEvents } from "../events.ts";
import { CRITERIA_VERIFIED_MARK } from "../ops.ts";
import { makeRealHost } from "./_g610-real-host.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, label: string, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(5);
  }
  assert.fail(`等待超时：${label}`);
}
/**
 * 建一个**可派发**的目标：判据已确认 + 目标描述非空（工具入口的 g-378 门禁）+ 状态 ready。
 * 夹具 `makeGoal` 只写判据（不写描述），直接派发会被「目标描述为空」拦在 execution admission，
 * 复用分支根本走不到 —— 这是夹具缺口，不是产品缺陷。
 */
function dispatchableGoal(h: any, title: string, type = "task") {
  const goal = createGoal(h.root, { title, version: "v1.0", type, actor: "human:gui" });
  setCriteria(h.root, goal, [`判据：真实宿主路径 ${CRITERIA_VERIFIED_MARK}`], "human:gui");
  setGoalDescription(h.root, goal, `E2E 目标：${title}。边界：仅在本树 tmp/ 私有 workspace 内。验收：见判据。`, "human:gui");
  transition(h.root, goal, "ready", { actor: "human:gui" });
  return goal as string;
}

const events = (h: any) => readEvents(h.root).map((e: any) => e.event);
const statusOf = (h: any, goal: string) => (goalDetail(h.root, goal).meta as any).status;

/**
 * 在 child 的**真实空闲时刻**发起一次复用派发（唯一一次）。
 *
 * 触发面两路（先到先得，均只在「宿主自己发布 idle 且 registry 仍可取到该 child」时触发）：
 *  a) `agent/status idle` 事件回调内同步判定（此时 child 仍常驻，宿主 settlement 尚未到）；
 *  b) `startChild()` 返回后（host 自建的首轮进行中，尚未结束时）第二次定位。
 * childId 由 `agent/created`（parentSession = 主管）观察得到；判定用 `reg.get(id).status === "idle"`。
 */
function makeIdleDispatcher(h: any, goal: string, extra: any = {}, brief = "reuse idle expert", seen?: string[]) {
  const realSend = h.subagents.sendMessage.bind(h.subagents);
  h.subagents.sendMessage = async (sender: any, targetId: string, content: any, opts: any) => {
    const out = await realSend(sender, targetId, content, opts);
    try { seen?.push(JSON.stringify(content)); } catch { /* observation only */ }
    return out;
  };
  const hook: { childId: string; fired: boolean; error: string | null; result: any; attempts: number } = {
    childId: "", fired: false, error: null, result: null, attempts: 0,
  };
  const tryFire = (id?: string) => {
    const childId = String(id ?? hook.childId ?? "");
    if (!childId || hook.fired) return;
    const live = h.reg.get(childId);
    // 只复用宿主**公开**状态为 idle 且仍常驻的 child（这正是产品准入的判定面）。
    if (!live || live.status !== "idle") return;
    hook.fired = true;
    hook.childId = childId;
    h.dispatch(goal, brief, { child_id: childId, ...extra }).then(
      (r: any) => { hook.result = r; },
      (e: any) => { hook.error = String(e?.message ?? e); },
    );
  };
  h.ctx.on("agent/created", (payload: any) => {
    const a = payload?.agent ?? payload;
    if (a?.session?.header?.parentSession === h.parent.id) hook.childId = a.id;
  });
  h.ctx.on("agent/status", ({ agent, status }: any = {}) => {
    if (status !== "idle") return;
    tryFire(agent?.id ?? agent);
  });
  const arm = () => tryFire();
  const settle = () => waitFor(() => hook.result !== null || hook.error !== null, "空闲时刻派发结果");
  return { hook, arm, settle };
}

// ───────────────────────── 场景 1：成功复用空闲专家 ─────────────────────────
test("g-613 真实宿主 E2E ①：child 空闲 ⇒ attempt 建立+绑定+in_progress+attempt.bound+收到任务", async () => {
  const h = await makeRealHost({ sessionQuery: true });
  try {
    const goal = dispatchableGoal(h, "e2e reuse idle", "task");
    const registryBefore = new Set(h.reg.list().map((a: any) => String(a.id)));
    const seen: string[] = [];
    const d = makeIdleDispatcher(h, goal, { task_type: "fix" }, "承接 E2E 场景一", seen);
    const started = await h.startChild("expert");
    d.arm();
    await d.settle();
    assert.equal(d.hook.error, null, `复用不得失败：${d.hook.error}`);
    assert.equal(d.hook.childId, started.childId, "复用的就是那个真实 child（不是新建的）");
    const r = d.hook.result;
    assert.equal(r.reused, true, "走复用路径");
    assert.equal(r.child_id, started.childId, "响应回传同一 child");
    assert.equal(r.delivery, "accepted", "投递被宿主受理");
    const rows: any[] = h.attempts(goal);
    assert.equal(rows.length, 1, "恰好建立 1 个 attempt");
    const row = rows[0];
    assert.equal(row.id, "att-001");
    assert.equal(row.child_id, started.childId, "attempt 绑定既有 child");
    assert.ok(row.binding_token, "绑定 token 已落盘");
    assert.equal(row.parent_session_id, "sess-super", "归属来自真实主管会话");
    assert.ok(Number(row.binding_version) >= 1, "绑定版本 ≥1");
    assert.equal(statusOf(h, goal), "in_progress", "目标迁移到 in_progress");
    const ev = events(h);
    assert.ok(ev.includes("attempt.started"), "attempt.started");
    assert.ok(ev.includes("attempt.bound"), "attempt.bound 留痕");
    // child 真的收到了任务：本次 attempt 的提示词含本次 brief（不是旧轮内容）。
    assert.equal(seen.length, 1, "恰好向该 child 投递一次任务");
    assert.match(seen[0], /承接 E2E 场景一/, "child 收到的就是本次 attempt 的任务（含本次 brief）");
    assert.equal(h.childLive(started.childId), "running", "复用后 child 进入新一轮");
    assert.deepEqual(new Set(h.reg.list().map((a: any) => String(a.id))),
      new Set([...registryBefore, String(started.childId)]), "完整 registry 仅增加目标 child，未新建其他 agent");
  } finally {
    h.fake.releaseAll();
    await h.shutdown();
  }
});

// ───────────────────────── 场景 2：运行中拒绝 ─────────────────────────
test("g-613 真实宿主 E2E ②：child running ⇒ 可读拒绝、零副作用", async () => {
  const h = await makeRealHost({ sessionQuery: true });
  try {
    const goal = dispatchableGoal(h, "e2e running reject", "task");
    const gate = h.fake.hold();
    const started = await h.startChild("expert");
    await waitFor(() => h.childLive(started.childId) === "running", "child running");
    const before = { attempts: h.attempts(goal).length, events: events(h).length, status: statusOf(h, goal), calls: h.fake.calls };
    await assert.rejects(
      () => h.dispatch(goal, "must not steer", { child_id: started.childId, task_type: "fix" }),
      (e: any) => /正在运行/.test(String(e?.message ?? e)) && /空闲/.test(String(e?.message ?? e)),
      "运行中的 child 必须被可读拒绝",
    );
    const after = { attempts: h.attempts(goal).length, events: events(h).length, status: statusOf(h, goal), calls: h.fake.calls };
    assert.deepEqual(after, before, "零副作用：无新 attempt、无新事件、状态不变、child 未被 steer 出新轮");
    assert.equal(h.childLive(started.childId), "running", "child 未被打断");
    gate.resolve();
    await waitFor(() => h.childLive(started.childId) === "gone", "首轮自然结束");
    await sleep(150);
    assert.equal(h.attempts(goal).length, 0, "拒绝后自然结束也不得凭空写结果");
    assert.equal(statusOf(h, goal), "ready", "目标仍在 ready（未被迁移）");
  } finally {
    h.fake.releaseAll();
    await h.shutdown();
  }
});

// ───────────────────────── 场景 3：跨目标独占 ─────────────────────────
test("g-613 真实宿主 E2E ③：child 已被 A 的活跃 attempt 占用 ⇒ B 被拒且零副作用", async () => {
  const h = await makeRealHost({ sessionQuery: true });
  try {
    const a = dispatchableGoal(h, "e2e owner A", "task");
    const b = dispatchableGoal(h, "e2e contender B", "task");
    const first: any = await h.dispatch(a, "A 的执行", { task_type: "fix" });
    assert.ok(first.child_id, "A 首次派发真实启动 child");
    assert.equal(h.childLive(first.child_id), "running");
    const bBefore = { attempts: h.attempts(b).length, status: statusOf(h, b), bEvents: events(h).filter((x: string) => x.startsWith("attempt.")).length };
    await assert.rejects(
      () => h.dispatch(b, "B 想抢同一个专家", { child_id: first.child_id, task_type: "fix" }),
      (e: any) => /正在运行|已被其它未交付目标/.test(String(e?.message ?? e)),
      "同一 child 不得同时服务两个目标",
    );
    assert.equal(h.attempts(b).length, bBefore.attempts, "B 不建 attempt");
    assert.equal(statusOf(h, b), bBefore.status, "B 状态不变");
    assert.equal(events(h).filter((x: string) => x.startsWith("attempt.")).length, bBefore.bEvents, "B 零 attempt 事件");
    const aRows: any[] = h.attempts(a);
    assert.equal(aRows.length, 1, "A 不受影响");
    assert.equal(aRows[0].child_id, first.child_id);
    assert.equal(statusOf(h, a), "in_progress");
  } finally {
    h.fake.releaseAll();
    await h.shutdown();
  }
});

// ───────────────────────── 场景 4：旧轮 end / 跨代继续不污染新目标 ─────────────────────────
test("g-613 真实宿主 E2E ④：上一轮结束事件/跨代继续 ⇒ 不污染其它目标结果与状态", async () => {
  const h = await makeRealHost({ sessionQuery: true });
  try {
    const goalA = dispatchableGoal(h, "e2e cross gen A", "task");
    const goalB = dispatchableGoal(h, "e2e cross gen B", "task");
    // 第一代：A 真实 spawn，然后真实结束（宿主发 subagent/end；既有契约只写 results 文件）
    const gen1: any = await h.dispatch(goalA, "A 的旧任务", { task_type: "fix" });
    assert.ok(gen1.child_id);
    h.fake.release();
    await waitFor(() => h.childLive(gen1.child_id) === "gone", "第一代结束");
    await waitFor(() => events(h).includes("attempt.results_written"), "A 收到 subagent/end 结果");
    const aRow: any = h.attempts(goalA)[0];
    assert.equal(aRow.result, "pending", "既有契约：subagent/end 不改 result 字段");
    assert.ok(readFileSync(findGoalFile(h.root, goalA)!, "utf8").length > 0);
    assert.equal(statusOf(h, goalA), "in_progress");
    // 第二代：同一 durable childId 冷恢复（宿主真实路径：end 已发，新一代 start 随后）
    h.fake.hold("GEN2-HOLD");
    const mid = await h.subagents.sendMessage(h.parent, gen1.child_id, [{ type: "text", text: "GEN2-HOLD" }], {
      signal: new AbortController().signal,
    });
    assert.ok(mid, "第二代真实启动");
    await waitFor(() => h.childLive(gen1.child_id) === "running", "第二代 running");
    // 运行中的 child 不得被「接力」复用（否则与旧任务混步）
    await assert.rejects(
      () => h.dispatch(goalB, "B 不应抢运行中的专家", { child_id: gen1.child_id, task_type: "fix" }),
      /正在运行/,
      "第二代运行中 ⇒ B 复用被拒",
    );
    assert.equal(h.attempts(goalB).length, 0, "B 零 attempt");
    // 第二代自然结束：同样不得改写 B（B 从未派发）
    h.fake.releaseAll();
    await waitFor(() => h.childLive(gen1.child_id) === "gone", "第二代结束");
    await sleep(300);
    assert.equal(h.attempts(goalB).length, 0, "第二代的 end 不得给 B 建 attempt");
    assert.equal(statusOf(h, goalB), "ready", "B 仍为 ready（未被迁移）");
    assert.equal(
      events(h).filter((x: string) => x.startsWith("attempt.") && !String(x).includes("reused")).length >= 3, true,
      "A 的 attempt 事件齐全",
    );
    assert.equal(
      readEvents(h.root).filter((e: any) => String(e.event).startsWith("attempt.") && e.details?.goal === goalB).length, 0,
      "B 没有任何 attempt 事件（跨代 end 未归因到 B）",
    );
    const bRowsAfter: any[] = h.attempts(goalB);
    assert.equal(bRowsAfter.length, 0, "B 无孤儿记录");
    assert.equal(h.attempts(goalA).length, 1, "A 仍只有 1 个 attempt");
  } finally {
    h.fake.releaseAll();
    await h.shutdown();
  }
});

// ───────────────────────── 场景 5：投递失败 fail-closed ─────────────────────────
test("g-613 真实宿主 E2E ⑤：投递被宿主拒 ⇒ fail-closed、不声称已开始工作", async () => {
  const h = await makeRealHost({ sessionQuery: true });
  try {
    const goal = dispatchableGoal(h, "e2e delivery fail closed", "task");
    const gate = h.fake.hold();
    const started = await h.startChild("expert");
    await waitFor(() => h.childLive(started.childId) === "running", "child running");
    // 「另一个主管」：与真实主管同一 session 内容，但**不是**该 child 的直接父会话行号。
    const outsider: any = Object.create(h.parent);
    const log: Array<{ sender: string; ok: boolean; detail: string }> = [];
    const realSend = h.subagents.sendMessage.bind(h.subagents);
    let attemptId: string | null = null;
    let thrown: string | null = null;
    let res: any = null;
    let fired = false;
    const fire = () => {
      const live = h.reg.get(started.childId);
      if (fired || !live || live.status !== "idle") return;
      fired = true;
      // 准入由**真实主管**执行（纯读取别），只把投递 sender 换成 outsider：
      // 于是投递必然被宿主以 UNAUTHORIZED 拒绝（真实拒绝，不是模拟异常），
      // 这条路径正是「准入通过、投递无法确认」的 fail-closed 场景。
      h.subagents.sendMessage = async (sender: any, targetId: string, content: any, opts: any) => {
        try {
          const out = await realSend(outsider, targetId, content, opts);
          log.push({ sender: String(sender?.id), ok: true, detail: String(out) });
          return out;
        } catch (e: any) {
          log.push({ sender: String(sender?.id), ok: false, detail: `${String(e?.code ?? "")} ${String(e?.message ?? e)}` });
          throw e;
        }
      };
      try {
        const out = h.tools.get("graph_start_attempt").execute(
          { goal, attempt_brief: "投递必须 fail-closed", worktree: false, task_type: "fix", child_id: started.childId },
          { agent: h.parent, signal: new AbortController().signal },
        );
        Promise.resolve(out).then(
          (r: any) => { res = r; attemptId = h.attempts(goal)[0]?.id ?? null; },
          (e: any) => { thrown = String(e?.message ?? e); },
        );
      } catch (e: any) {
        thrown = String(e?.message ?? e);
      }
    };
    h.ctx.on("agent/status", ({ status }: any = {}) => { if (status === "idle") fire(); });
    gate.resolve();
    await waitFor(() => thrown !== null || res !== null || h.childLive(started.childId) === "gone", "投递路径触发", 25000);
    assert.equal(thrown, null, `派发不应抛错（准入应通过，失败应落在投递上）：${thrown}`);
    assert.equal(log.length, 1, "恰好投递一次");
    assert.equal(log[0].ok, false, "宿主真实拒绝该投递");
    assert.match(log[0].detail, /UNAUTHORIZED|belongs to another parent|not a resident continuable child/i, "宿主拒绝原因可读");
    assert.equal(res.started, false, "不得声称已开始工作");
    assert.equal(res.delivery, "rejected", "如实标注 rejected（不是 accepted）");
    assert.equal(typeof res.child_error, "string", "给出可读 child_error");
    assert.ok(attemptId, "attempt 已落盘（准入通过后才投递）");
    const row: any = h.attempts(goal).find((a: any) => a.id === attemptId);
    // 「首次启动未结算」窗口已被结算（否则门禁会永久卡死），且 result 字段保持既有语义（不被臆断为 success）。
    assert.notEqual(row.dispatch_in_flight, true, "dispatch_in_flight 已结算");
    assert.notEqual(row.result, "success", "绝不把投递失败当成功");
    const resultsFile = readFileSync(join(dirname(findGoalFile(h.root, goal)!), "results-att-001.md"), "utf8");
    assert.match(resultsFile, /child_error/, "写入 child_error 占位摘要");
    assert.ok(events(h).includes("attempt.reuse_failed"), "记 attempt.reuse_failed");
    assert.equal(statusOf(h, goal), "in_progress", "投递失败不臆断为执行成功或撤销目标");
  } finally {
    h.fake.releaseAll();
    await h.shutdown();
  }
});

// ───────────────────────── 场景 6：复用不建 worktree ─────────────────────────
test("g-613 真实宿主 E2E ⑥：复用不创建 worktree（worktree_reason=reused_child）", async () => {
  const h = await makeRealHost({ sessionQuery: true, gitRepo: true });
  try {
    // feature 类型 + 干净 git 仓库 ⇒ 全新 spawn 默认建树；而复用路径无论如何都不建树。
    const goal = dispatchableGoal(h, "e2e no worktree", "feature");
    const d = makeIdleDispatcher(h, goal, {}, "复用承接 feature 目标");
    const started = await h.startChild("expert");
    d.arm();
    await d.settle();
    assert.equal(d.hook.error, null, `复用不得失败：${d.hook.error}`);
    const r = d.hook.result;
    assert.equal(r.reused, true);
    assert.equal(r.worktree, false, "复用不返回 worktree");
    assert.equal(r.isolated, false, "复用不创建隔离树");
    assert.equal(r.worktree_reason, "reused_child", "原因枚举为 reused_child");
    assert.equal(r.worktree_created, false);
    assert.equal(r.worktree_reused, false);
    assert.equal(statusOf(h, goal), "in_progress");
    const rows: any[] = h.attempts(goal);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].worktree, false, "attempt.md 记录 worktree=false");
    assert.equal(h.childLive(started.childId), "running");
    // 对照：新 spawn 不建树只发生在「feature 默认建树」这一策略之外的路径上；此处断言复用路径未碰 git 工作树。
    assert.equal(events(h).includes("attempt.started"), true);
  } finally {
    h.fake.releaseAll();
    await h.shutdown();
  }
});
