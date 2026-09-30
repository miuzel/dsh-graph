/**
 * g-378：派发前「先写目标描述」提醒 + `graph_start_attempt` 描述门禁（简单版，四条判据）。
 *
 * 为什么需要：主管常在只写了标题的目标上直接派发，执行子代理拿到的背景是「（无描述）」——
 * 任务边界与验收全靠 brief 临场补，派发质量取决于主管记性。本目标把「派发前写描述」从
 * 口头纪律变成**一次**机器检查（提醒 + 门禁），刻意不做更多。
 *
 * 断言面（判据一一对应）：
 *  1. 指南中英双份各含一条「派发前先写目标描述」提醒：**同一行号**（对称）、
 *     同时点明 `graph_start_attempt` 与 `graph_set_description`、且英文行零 CJK；
 *  2. 门禁负向：`ready` 目标描述为空/仅占位符/仅注释 ⇒ 工具入口拒绝派发，
 *     错误文案可操作（点明 `graph_set_description` 补写后重试），且**零副作用**
 *     （目标文件字节、attempt 目录与编号、事件流、子代理派发全部不变）；
 *  3. 门禁正向与豁免成对：补写描述后同一目标重试成功（编号仍从 att-001 起）；
 *     drag/强制启动（HTTP 入口：transition force + start-execution）、
 *     planning 的 g-236 兜底、已执行目标的存量空描述重派、validate/看板投影均不受影响；
 *  4. graph_* 工具集合只增不减（g-380 起 50），门禁为纯同步校验（不引入轮询/watcher、不写盘）。
 *
 * 生效面钉住：门禁只作用于「尚未开始执行」的准备态（见 `DESCRIPTION_GATE_STATUSES`）。
 * 两处豁免都不是顺手放过——`planning` 是 g-236 既有的无描述派发路径（引擎兜底 brief 承接，
 * 其断言不得改），`in_progress`/`review` 是已执行目标（含 GUI 强制启动/拖拽路径），
 * 不得因存量空描述被回溯拦截。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHarness, restCall } from "./_g374-harness.ts";
import {
  DESCRIPTION_GATE_STATUSES,
  createGoal,
  findGoalFile,
  goalDetail,
  loadGoal,
  setCriteria,
  setGoalDescription,
  transition,
  validate,
} from "../ops.ts";
import { readEvents } from "../events.ts";
import { descriptionPresent } from "../model.ts";

const REPO = join(import.meta.dirname, "../..");
type Harness = ReturnType<typeof createHarness>;

function routeOf(h: Harness, path: string) {
  const route = h.routes.find((r: any) => r.path === path);
  assert.ok(route, `REST 路由未注册：${path}`);
  return route;
}

/** 判据 2/3 的公共 fixture：越过 planning、尚未开始执行的 `ready` 目标（默认无描述）。 */
function readyGoal(h: Harness, opts: { description?: string } = {}): string {
  writeFileSync(join(h.root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  const goal = createGoal(h.root, {
    title: "g-378 目标",
    version: "v1.0",
    actor: "human:gui",
    ...(opts.description ? { description: opts.description } : {}),
  });
  setCriteria(h.root, goal, ["判据 A"], "human:gui");
  transition(h.root, goal, "ready", { actor: "human:gui" });
  return goal;
}

/** 零副作用快照：目标文件字节 / attempt 目录与编号 / 结果文件 / 事件流 / 子代理派发 / 状态。 */
function snapshot(h: Harness, goal: string) {
  const goalFile = findGoalFile(h.root, goal);
  const attDir = join(dirname(goalFile), "attempts");
  const attExists = existsSync(attDir);
  return {
    goalBytes: readFileSync(goalFile, "utf8"),
    attDirExists: attExists,
    attIds: attExists ? readdirSync(attDir).filter((d) => d.startsWith("att-")) : [],
    resultsFiles: attExists
      ? (readdirSync(attDir, { recursive: true }) as string[]).filter((f) => /(^|\/)results-att-.*\.md$/.test(f))
      : [],
    events: readEvents(h.root).length,
    spawns: h.capturedRequests.length,
    status: String(loadGoal(goalFile).meta.status),
  };
}

// ============================================================================
// 判据 1：指南中英双份各含一条「派发前先写目标描述」提醒
// ============================================================================

test("g-378 判据 1：中英指南的『派发前先写目标描述』提醒逐行对称，英文零 CJK", () => {
  const zh = readFileSync(join(REPO, "dsh-graph-host/supervisor-guide.zh.md"), "utf8").split("\n");
  const en = readFileSync(join(REPO, "dsh-graph-host/supervisor-guide.en.md"), "utf8").split("\n");

  const zhIdx = zh.findIndex((l) => l.startsWith("- **派发前先写目标描述**"));
  const enIdx = en.findIndex((l) => l.startsWith("- **Write the goal description before dispatching**"));
  assert.ok(zhIdx >= 0, "中文指南必须含该提醒条目");
  assert.ok(enIdx >= 0, "英文指南必须含该提醒条目");
  assert.equal(zhIdx, enIdx, "提醒条目必须中英逐行对称（同一行号）——否则一份指南缺条目");

  const zhLine = zh[zhIdx];
  const enLine = en[enIdx];
  for (const token of ["graph_start_attempt", "graph_set_description"]) {
    assert.ok(zhLine.includes(token), `中文提醒必须点明 ${token}`);
    assert.ok(enLine.includes(token), `英文提醒必须点明 ${token}`);
  }
  assert.doesNotMatch(enLine, /[\u3400-\u9fff\uf900-\ufaff]/, "英文提醒不得含 CJK");

  // 提醒是随包发布的资产：dist 副本必须已含同一条（源→dist 逐字一致由 g-312 新鲜度套件兜底）。
  const distEn = readFileSync(join(REPO, "dist/supervisor-guide.en.md"), "utf8");
  assert.ok(distEn.includes(enLine.trim()), "dist 英文指南必须含同一条提醒（构建资产已同步）");
});

// ============================================================================
// 判据 2：描述为空/占位符 ⇒ 拒绝派发，零副作用
// ============================================================================

test("g-378 判据 2（负向）：ready 目标描述为空 ⇒ 工具入口拒绝派发且零副作用", async () => {
  const h = createHarness();
  const goal = readyGoal(h);
  const before = snapshot(h, goal);

  await assert.rejects(
    () => h.call("graph_start_attempt", { goal, attempt_brief: "尝试派发" }),
    (e: any) => {
      const msg = String(e?.message ?? e);
      assert.match(msg, /目标描述为空/, "必须点明目标描述为空");
      assert.match(msg, /graph_set_description/, "必须点明可操作工具 graph_set_description");
      assert.match(msg, /重试 graph_start_attempt/, "必须点明补写后重试即可");
      assert.match(msg, /未创建 attempt、未启动子代理/, "必须点明零副作用");
      return true;
    },
    "工具入口必须拒绝空描述派发",
  );

  const after = snapshot(h, goal);
  assert.deepEqual(after, before, "拒绝必须零副作用（目标字节/attempt/事件/子代理/状态全不变）");
  assert.equal(after.status, "ready", "拒绝后状态不得迁移");
  assert.equal(after.spawns, 0, "拒绝时不得调用 startContinuable");
  assert.deepEqual(after.attIds, [], "拒绝时不得创建 attempt 目录（编号不前进）");
  assert.deepEqual(after.resultsFiles, [], "拒绝时不得写 results-att-*.md");
  assert.equal(
    readEvents(h.root).some((e) => e.event === "attempt.started" && e.goal === goal),
    false,
    "拒绝时不得记录 attempt.started",
  );
});

test("g-378 判据 2（负向）：仅占位符「（待填写）」/ 仅 HTML 注释同样被拒，编号不前进", async () => {
  const h = createHarness();
  const goal = readyGoal(h);
  const attDir = join(dirname(findGoalFile(h.root, goal)), "attempts");

  setGoalDescription(h.root, goal, "（待填写）", "human:gui");
  await assert.rejects(() => h.call("graph_start_attempt", { goal }), /目标描述为空/, "仅占位符必须被拒");
  setGoalDescription(h.root, goal, "<!-- 待主管补写 -->\n", "human:gui");
  await assert.rejects(() => h.call("graph_start_attempt", { goal }), /目标描述为空/, "仅注释必须被拒");

  assert.equal(existsSync(attDir), false, "被拒时不得创建 attempts 目录");
  assert.equal(h.capturedRequests.length, 0, "被拒时不得派发子代理");
});

test("g-378 判据 2（判定口径）：descriptionPresent 只认实质内容", () => {
  const cases: Array<[string, boolean]> = [
    ["", false],
    ["\n   \n", false],
    ["（待填写）", false],
    ["<!-- 占位注释 -->", false],
    ["真实描述：要做什么、边界与验收。", true],
    ["- 背景：某模块需要修复\n- 边界：不动契约", true],
  ];
  for (const [raw, expected] of cases) {
    const body = `## 目标描述\n\n${raw}\n\n## 质量判据\n\n1. 判据\n`;
    assert.equal(descriptionPresent(body), expected, `descriptionPresent(${JSON.stringify(raw)})`);
  }
  assert.equal(descriptionPresent("## 质量判据\n\n1. 判据\n"), false, "缺少目标描述小节 ⇒ 视为空");
});

// ============================================================================
// 判据 3：补写后重试即通过；豁免路径成对不受影响
// ============================================================================

test("g-378 判据 3（正向）：补写描述后同一目标重试即通过，编号仍从 att-001 起", async () => {
  const h = createHarness();
  const goal = readyGoal(h);
  await assert.rejects(() => h.call("graph_start_attempt", { goal }), /目标描述为空/);

  setGoalDescription(h.root, goal, "补写后的目标描述：要做什么、边界与验收。", "human:gui");
  const res = await h.call("graph_start_attempt", { goal, attempt_brief: "补写后重试" });

  assert.equal(res.attempt, "att-001", "被拒不得消耗 attempt 编号（重试仍是首个 attempt）");
  assert.ok(res.child_id, "补写后必须成功派发子代理");
  assert.equal(h.capturedRequests.length, 1, "只应发生一次子代理派发");
  assert.equal(String(loadGoal(findGoalFile(h.root, goal)).meta.status), "in_progress");
  assert.ok(readEvents(h.root).some((e) => e.event === "attempt.started" && e.goal === goal));
});

test("g-378 判据 3（豁免正向）：同一 ready 空描述目标经 HTTP 入口（GUI 拖拽/执行按钮）仍可派发", async () => {
  const h = createHarness();
  const goal = readyGoal(h);
  await assert.rejects(() => h.call("graph_start_attempt", { goal }), /目标描述为空/, "工具入口被拒");

  const res = await restCall(routeOf(h, "/api/dsh-graph/start-execution"), { goal, workspace: h.ws });
  assert.equal(res.code, 200, "HTTP 入口不得被描述门禁阻断（既有强制启动路径）");
  assert.equal(res.payload.ok, true);
  assert.ok(res.payload.child_id, "HTTP 入口必须照常派发子代理");
  assert.equal(h.capturedRequests.length, 1);
  assert.equal(String(loadGoal(findGoalFile(h.root, goal)).meta.status), "in_progress");
});

test("g-378 判据 3（豁免正向）：拖拽置 in_progress（force transition）与存量空描述重派均不被阻断", async () => {
  const h = createHarness();
  const goal = readyGoal(h);

  const tr = await restCall(routeOf(h, "/api/dsh-graph/transition"), {
    goal, to: "in_progress", force: true, workspace: h.ws,
  });
  assert.equal(tr.code, 200, "拖拽跨列不得被阻断");
  assert.equal(tr.payload.ok, true);
  assert.equal(String(loadGoal(findGoalFile(h.root, goal)).meta.status), "in_progress");

  // 存量空描述目标（已执行）经工具重派：属于既有执行路径的延续，不得被回溯拦截。
  const res = await h.call("graph_start_attempt", { goal });
  assert.equal(res.attempt, "att-001");
  assert.ok(res.child_id, "已执行目标的空描述重派必须照常派发");
});

test("g-378 判据 3（豁免正向）：planning 目标的 g-236 兜底派发行为保持不变", async () => {
  const h = createHarness();
  const goal = createGoal(h.root, { title: "planning 空描述目标", version: "v1.0", actor: "human:gui" });
  setCriteria(h.root, goal, ["判据 A"], "human:gui");

  const res = await h.call("graph_start_attempt", { goal });
  assert.equal(res.brief_source, "fallback", "planning 是 g-236 兜底路径，其行为与断言不得改");
  assert.equal(res.brief, "执行目标描述和质量判据中的任务");
  assert.ok(res.child_id, "g-236 兜底派发必须照常启动子代理");
});

test("g-378 判据 3（豁免正向）：validate 与看板投影不对空描述目标报警/新增标记字段", () => {
  const h = createHarness();
  const goal = readyGoal(h);

  assert.deepEqual(validate(h.root).filter((p) => p.includes("描述")), [], "validate 不得对空描述报警");
  const detail = goalDetail(h.root, goal);
  assert.equal(detail.description, "", "看板投影如实给出空描述");
  assert.ok(
    !Object.keys(detail).some((k) => /warn|alert|problem|flag|missing_desc/i.test(k)),
    "不得因空描述新增告警/标记字段（存量目标不标红）",
  );
});

// ============================================================================
// 判据 4：工具集合只增不减（g-380 起 50）；门禁为纯同步校验（生效面钉住）
// ============================================================================

test("g-378 判据 4：graph_* 工具集合只增不减（g-380 起 50），生效面仅『尚未开始执行的准备态』", () => {
  const h = createHarness();
  const graphTools = [...h.toolsByName.keys()].filter((n) => n.startsWith("graph_"));
  assert.equal(graphTools.length, 50, `graph_* 工具计数必须为 50（g-380 新增 graph_set_relation），实际 ${graphTools.length}`);
  assert.deepEqual(
    [...DESCRIPTION_GATE_STATUSES].sort(),
    ["collecting", "ready"],
    "门禁只作用于尚未开始执行的准备态（planning 走 g-236 兜底；in_progress/review 为存量执行路径）",
  );
});
