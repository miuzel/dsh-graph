/**
 * g-251：派发 action 契约（来源、完整性与最小审计闭环）。
 *
 * 背景（真实缺口）：无显式 brief/directive 时，合成的 auto_from_desc brief 被截到 200 字，
 * 而目标描述全文只出现在「目标背景（…不产生 action）」区块 ⇒ 描述尾部要求可能沦为非任务；
 * 同时来源（brief_source）只出现在派发响应里，attempt.md 与 attempt.started 事件缺该字段，
 * 「这次 action 文本从哪来」无法事后审计。
 *
 * 断言面（判据一一对应，全部走**真实工具/真实 REST** 派发，不测合成函数）：
 *  1. spawn prompt 清楚区分显式 brief / directive / auto_from_desc 合成来源；长描述尾部关键要求
 *     完整承载于 action 切片（不再静默落进非 action 背景）；显式 brief 原意逐字保留；
 *     brief/directive 冲突沿既有优先级（brief 优先）。
 *  2. brief_source 在 attempt meta / attempt.started 事件 / goalDetail 三处同值可读；旧记录缺字段
 *     返回 null（不按 brief/directive 反推冒充历史）；不新增常驻 GUI 面板。
 *  3. 空描述遵守现 g-378 门禁（工具入口拒、HTTP 入口豁免），负向回归覆盖 directive、长描述尾要求、
 *     brief/directive 冲突三种。
 *  4. 既有准入/派发行为不回退：四值闭集与实际文本同源、来源集合恰为闭集（不多不少），
 *     非法来源在持久化边界显式抛错。
 *
 * 负向对照（「改坏就会红」）：
 *  - 长描述尾部标记在描述中的下标 > 200 ⇒ 历史截断实现必然把它切出 action 切片，本用例即红；
 *  - 旧记录只带 meta.brief（无 brief_source）⇒ 任何「反推来源」的实现都会给出 "brief"，断言 null 即红；
 *  - 来源集合断言为**恰好**等于闭集 ⇒ 回退到「brief 被吞成 undefined」或新增野生来源都会红。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHarness, prepare, restCall } from "./_g374-harness.ts";
import {
  ATTEMPT_BRIEF_SOURCE_VALUES,
  createGoal,
  findGoalFile,
  goalDetail,
  loadGoal,
  setCriteria,
  setGoalDirective,
  startAttempt,
  transition,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { formatAttemptPrompt } from "../../dist/index.js";

type Harness = ReturnType<typeof createHarness>;

function routeOf(h: Harness, path: string) {
  const route = h.routes.find((r: any) => r.path === path);
  assert.ok(route, `REST 路由未注册：${path}`);
  return route;
}

/** 真实派发 prompt（工具/HTTP 均落在 startContinuable 捕获的请求上）。 */
function promptOf(h: Harness, index = 0): string {
  const req = h.capturedRequests[index];
  assert.ok(req, `第 ${index} 次派发未捕获到子代理请求`);
  return req.request?.prompt?.[0]?.text ?? "";
}

/** action 来源切片：`**attempt brief（当前数据）**` → `**directive（当前数据）**`。
 *  只在这个切片内找文本，才能证明它是 **action** 而不是「不产生 action」的背景。 */
function briefSlice(prompt: string): string {
  const start = prompt.indexOf("**attempt brief（当前数据）**");
  assert.ok(start >= 0, "prompt 必须含 attempt brief 标签");
  const end = prompt.indexOf("**directive（当前数据）**", start);
  assert.ok(end > start, "prompt 必须含 directive 标签（切片右界）");
  return prompt.slice(start, end);
}

/** attempt 三处来源事实（meta / 事件 / goalDetail 投影）。 */
function sourceTriple(h: Harness, goal: string, attempt: string) {
  const goalFile = findGoalFile(h.root, goal);
  const meta = loadGoal(join(dirname(goalFile), "attempts", attempt, "attempt.md")).meta;
  const ev = readEvents(h.root).find(
    (e) => e.event === "attempt.started" && e.details?.attempt === attempt,
  );
  const detail = goalDetail(h.root, goal).attempts.find((a: any) => a.id === attempt);
  return {
    meta: meta.brief_source ?? null,
    metaHasField: Object.prototype.hasOwnProperty.call(meta, "brief_source"),
    event: ev?.details?.brief_source ?? null,
    detail: detail?.brief_source ?? null,
  };
}

// ============================================================================
// 判据 1 + 2：显式 brief —— 来源可见、原意保留、三处同值
// ============================================================================

test("g-251 判据 1/2（显式 brief）：prompt 标注来源、正文逐字保留、meta/事件/goalDetail 同值", async () => {
  const h = createHarness();
  const { goal } = prepare(h, { title: "显式 brief 目标", description: "目标描述（不应被当作 action 冲突源）" });
  const brief = "只改 core/ops.ts 的 brief_source 落盘；**不得**顺手重构派发 prompt 组装（原意保留）";

  const res = await h.call("graph_start_attempt", { goal, attempt_brief: brief });
  assert.ok(res.child_id, "真实工具派发必须启动子代理");

  const prompt = promptOf(h);
  const slice = briefSlice(prompt);
  assert.ok(slice.includes(brief), "action 切片必须逐字保留显式 brief（不改原意）");
  assert.match(prompt, /来源：显式 attempt_brief/, "prompt 必须交代来源是显式 brief");
  assert.doesNotMatch(slice, /自动合成/, "显式 brief 的来源标注不得声称是合成");

  assert.equal(res.brief_source, "brief", "响应来源应为 brief（四值闭集，不再被吞成 undefined）");
  assert.deepEqual(sourceTriple(h, goal, res.attempt), {
    meta: "brief", metaHasField: true, event: "brief", detail: "brief",
  }, "attempt meta / attempt.started / goalDetail 三处来源必须同值");
});

// ============================================================================
// 判据 1 + 3：directive 承接 —— 真实工具派发
// ============================================================================

test("g-251 判据 1/3（directive）：无显式 brief 时来源记 directive，且 prompt 点明由「最近指令」承接", async () => {
  const h = createHarness();
  const { goal } = prepare(h, { title: "directive 承接目标", description: "目标描述存在，但 directive 优先于描述合成" });
  const directive = "只改 API 层，不动 GUI（g-251-DIRECTIVE-MARKER）";
  setGoalDirective(h.root, goal, directive, "human:gui");

  const res = await h.call("graph_start_attempt", { goal });
  assert.ok(res.child_id);
  assert.equal(res.brief, directive, "无显式 brief 时 directive 承接 action");
  assert.equal(res.brief_source, "directive");

  const prompt = promptOf(h);
  const slice = briefSlice(prompt);
  assert.match(slice, /来源：directive/, "action 切片必须交代来源是 directive");
  assert.match(slice, /最近指令/, "来源标注必须点明精确来源（目标文件「最近指令」小节）");
  assert.ok(slice.includes(directive), "directive 文本必须落在 action 切片内");
  assert.doesNotMatch(slice, /auto_from_desc/, "有 directive 就不得声称来源是描述合成");

  const triple = sourceTriple(h, goal, res.attempt);
  assert.deepEqual(triple, { meta: "directive", metaHasField: true, event: "directive", detail: "directive" });
});

// ============================================================================
// 判据 1 + 3：长描述尾要求 —— auto_from_desc 完整承载（负向对照钉住历史截断）
// ============================================================================

test("g-251 判据 1/3（长描述尾要求）：尾部关键要求完整承载于 action 切片，不再静默落入非 action 背景", async () => {
  const h = createHarness();
  const tail = "尾部关键要求：必须同时更新 CHANGELOG.md 与 README 的版本表述（g-251-TAIL-MARKER）";
  // 前缀把尾部要求推到 200 字符之外 ⇒ 历史 200 字截断实现下该标记必然被切掉。
  const prefix = "前置说明：这是一段用于把尾部要求推出历史截断边界的中性描述。".repeat(9);
  const desc = `${prefix}\n\n${tail}`;
  assert.ok(desc.indexOf(tail) > 200, `负向对照前提：尾部标记下标(${desc.indexOf(tail)})必须 > 200，否则本用例测不到截断`);

  const { goal } = prepare(h, { title: "长描述目标", description: desc });
  const res = await h.call("graph_start_attempt", { goal });
  assert.ok(res.child_id);
  assert.equal(res.brief_source, "auto_from_desc");
  assert.equal(res.brief, `执行目标描述中的任务：${desc}`, "合成 brief 必须完整承载目标描述全文");

  const prompt = promptOf(h);
  const slice = briefSlice(prompt);
  assert.ok(slice.includes(tail), "尾部关键要求必须出现在 action 切片内（不得只留在「不产生 action」背景）");
  assert.ok(slice.includes("来源：auto_from_desc"), "action 切片必须交代来源是描述合成");
  assert.ok(slice.includes("目标描述**全文**已完整承载"), "来源标注必须说明全文承载，杜绝静默截断");
  // 背景区块仍在（交叉核对），但它不是尾部要求的唯一去处。
  assert.ok(prompt.includes("目标背景（来自当前 goal.md，仅供理解，不产生 action）"));

  assert.deepEqual(sourceTriple(h, goal, res.attempt), {
    meta: "auto_from_desc", metaHasField: true, event: "auto_from_desc", detail: "auto_from_desc",
  });
});

// ============================================================================
// 判据 1 + 3：brief/directive 冲突 —— 沿既有优先级（brief 优先）
// ============================================================================

test("g-251 判据 1/3（brief/directive 冲突）：brief 优先且来源记 brief，directive 仍作背景留痕", async () => {
  const h = createHarness();
  const { goal } = prepare(h, { title: "冲突优先级目标", description: "描述" });
  const directive = "背景指令：本次不要动 GUI（g-251-CONFLICT-DIRECTIVE）";
  const brief = "当前任务：改 brief_source 的落盘（g-251-CONFLICT-BRIEF）";
  setGoalDirective(h.root, goal, directive, "human:gui");

  const res = await h.call("graph_start_attempt", { goal, attempt_brief: brief });
  assert.ok(res.child_id);
  assert.equal(res.brief, brief, "冲突时 brief 是 action");
  assert.equal(res.brief_source, "brief", "冲突时来源必须记 brief（不是 directive）");

  const prompt = promptOf(h);
  assert.match(prompt, /两者冲突以 brief 为准/, "冲突优先级说明不得改");
  const slice = briefSlice(prompt);
  assert.ok(slice.includes(brief), "brief 必须在 action 切片内");
  assert.ok(slice.includes("来源：显式 attempt_brief"));
  assert.ok(prompt.includes(directive), "directive 必须仍作为背景出现在 prompt 中");

  assert.deepEqual(sourceTriple(h, goal, res.attempt), {
    meta: "brief", metaHasField: true, event: "brief", detail: "brief",
  });
});

// ============================================================================
// 判据 2：旧记录缺字段 ⇒ null（不反推、不伪造）
// ============================================================================

test("g-251 判据 2（旧记录）：无 brief_source 的历史 attempt 读回 null，不按 meta.brief 反推", () => {
  const h = createHarness();
  const { goal } = prepare(h, { title: "旧记录目标" });

  // 模拟历史记录：只有 brief（历史实现只写 brief），没有 brief_source。
  const att = startAttempt(h.root, goal, {
    executor: "agent:executor",
    actor: "human:gui",
    attemptBrief: "历史 attempt 的 brief（当时没有来源字段）",
  });
  const meta = loadGoal(join(dirname(findGoalFile(h.root, goal)), "attempts", att, "attempt.md")).meta;
  assert.equal(meta.brief_source, undefined, "未传来源时不得凭空写入字段（缺字段是历史事实）");
  assert.ok(meta.brief, "负向对照前提：meta.brief 存在，任何「反推来源」的实现都会给出 brief");

  const detail = goalDetail(h.root, goal).attempts.find((a: any) => a.id === att);
  assert.equal(detail.brief_source, null, "旧记录缺 brief_source 必须返回 null，不得伪造默认值冒充历史");
  const ev = readEvents(h.root).find((e) => e.event === "attempt.started" && e.details?.attempt === att);
  assert.equal(ev?.details?.brief_source ?? null, null, "旧事件的 details 里也不得出现伪造来源");
});

// ============================================================================
// 判据 2 + 3：HTTP 入口同值；空描述门禁未变（fallback 只在非门禁路径）
// ============================================================================

test("g-251 判据 2/3（HTTP + 空描述）：非门禁路径来源记 fallback 且四处同值；工具入口仍被 g-378 门禁拒绝", async () => {
  const h = createHarness();
  // HTTP 入口经 supervisor.session 解析 live parent（无则只本地建 attempt 且不派发）——
  // 本用例要断言真实派发 prompt，故先落盘 supervisor 会话。
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  // 空描述目标：工具入口（requireDescription）应被 g-378 拒绝；HTTP 入口（既有人工强制启动路径）豁免。
  // 门禁只作用于「尚未开始执行的准备态」⇒ 必须先排期到 ready（planning 是 g-236 兜底豁免路径）。
  const goal = createGoal(h.root, { title: "空描述目标", version: "v1.0", actor: "human:gui" });
  setCriteria(h.root, goal, ["判据 A"], "human:gui");
  transition(h.root, goal, "ready", { actor: "human:gui" });

  // ① 工具入口负向：拒绝且零副作用（不建 attempt、不派发）。
  const attDir = join(dirname(findGoalFile(h.root, goal)), "attempts");
  await assert.rejects(
    () => h.call("graph_start_attempt", { goal }),
    /目标描述为空/,
    "空描述目标经工具入口必须仍被 g-378 门禁拒绝（门禁未被本目标改动）",
  );
  assert.equal(h.capturedRequests.length, 0, "门禁拒绝必须零派发");
  assert.ok(!existsSync(attDir) || readdirSync(attDir).filter((d) => d.startsWith("att-")).length === 0, "门禁拒绝必须零 attempt");

  // ② HTTP 入口（非门禁路径）：照常派发，来源为 fallback。
  const res = await restCall(routeOf(h, "/api/dsh-graph/start-execution"), { goal, workspace: h.ws });
  assert.equal(res.code, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.brief_source, "fallback", "空描述兜底路径来源必须是 fallback");
  assert.equal(res.payload.brief, "执行目标描述和质量判据中的任务", "g-236 兜底文案一字未改");

  const prompt = promptOf(h, 0);
  const slice = briefSlice(prompt);
  assert.match(slice, /来源：fallback/, "action 切片必须交代来源是引擎兜底");
  assert.deepEqual(sourceTriple(h, goal, res.payload.attempt), {
    meta: "fallback", metaHasField: true, event: "fallback", detail: "fallback",
  });
});

// ============================================================================
// 判据 4：来源闭集恰为四值（不多不少）+ 非法来源显式抛错
// ============================================================================

test("g-251 判据 4：四条真实派发路径恰好覆盖来源闭集四值，未知来源在持久化边界抛错", async () => {
  const h = createHarness();
  const observed = new Set<string>();

  // ① brief
  const a = prepare(h, { title: "闭集-brief", description: "描述" });
  observed.add((await h.call("graph_start_attempt", { goal: a.goal, attempt_brief: "显式 brief" })).brief_source);

  // ② directive
  const b = prepare(h, { title: "闭集-directive", description: "描述" });
  setGoalDirective(h.root, b.goal, "directive 内容", "human:gui");
  observed.add((await h.call("graph_start_attempt", { goal: b.goal })).brief_source);

  // ③ auto_from_desc
  const c = prepare(h, { title: "闭集-auto", description: "描述自动合成" });
  observed.add((await h.call("graph_start_attempt", { goal: c.goal })).brief_source);

  // ④ fallback（空描述 + HTTP 非门禁路径）
  const d = createGoal(h.root, { title: "闭集-fallback", version: "v1.0", actor: "human:gui" });
  setCriteria(h.root, d, ["判据 A"], "human:gui");
  const httpRes = await restCall(routeOf(h, "/api/dsh-graph/start-execution"), { goal: d, workspace: h.ws });
  observed.add(httpRes.payload.brief_source);

  assert.deepEqual([...observed].sort(), [...ATTEMPT_BRIEF_SOURCE_VALUES].sort(),
    "四条真实路径必须恰好覆盖来源闭集（多出野生来源或某值不可达都视为漂移）");

  // 非法来源必须在写入前显式抛错（不静默落盘、不伪造）。
  const e = prepare(h, { title: "非法来源" });
  assert.throws(
    () => startAttempt(h.root, e.goal, { executor: "agent:executor", actor: "test", briefSource: "guessed" as any }),
    /briefSource 必须是/,
    "未知来源必须被拒绝",
  );
  assert.ok(!existsSync(join(e.dir, "attempts", "att-001", "attempt.md")), "拒绝必须零副作用（不留下半个 attempt）");
});

// ============================================================================
// 判据 1（英文路径）：来源标注随语言本地化且零 CJK
// ============================================================================

test("g-251 判据 1（英文路径）：四值来源标注全部为英文且零 CJK", () => {
  const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
  for (const source of ATTEMPT_BRIEF_SOURCE_VALUES) {
    const en = formatAttemptPrompt({
      goal: "g-251",
      attempt: "att-001",
      goalRel: ".dsh-graph/versions/v0.19.2/goals/g-251/goal.md",
      attemptBrief: "Execute the task from the goal description: fix the dispatch contract",
      briefSource: source,
      cardsSection: "(none)",
      worktreeBlock: "worktree guide",
      promptLanguage: "en",
    });
    const noteLine = en.split("\n").find((l) => l.startsWith("Source: "));
    assert.ok(noteLine, `${source}：英文路径必须标注来源`);
    assert.doesNotMatch(noteLine, HAN, `${source}：英文来源标注不得含汉字（实际：${noteLine}）`);
  }
  // auto_from_desc 的英文标注必须点明「全文承载、尾部要求同等有效」这一关键语义。
  const auto = formatAttemptPrompt({
    goal: "g-251",
    attempt: "att-001",
    goalRel: "g.md",
    attemptBrief: "Execute the task from the goal description.",
    briefSource: "auto_from_desc",
    cardsSection: "(none)",
    worktreeBlock: "worktree guide",
    promptLanguage: "en",
  });
  assert.match(auto, /Source: auto_from_desc/, "英文路径必须同样标注 auto_from_desc 来源");
  assert.match(auto, /trailing requirements are as authoritative as leading ones/, "英文标注必须说明尾部要求同等有效");
});
