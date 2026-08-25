/** dsh-graph-host 单包（g-116 合并后）webServer 半边（/api/dsh-graph 写端点）冒烟测试：g-109。
 *  mock webServer/ctx，无 subagents 服务 → 验证降级路径（attempt 本地创建、child_error 上报、
 *  卡片不误翻 collecting）；有 body 的 POST 走 readBody + 事件先行断言。
 *  g-116：原 client 端点并入 host 包 index.js，此处 apply 指向合并后的 dsh-graph-host。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import vm from "node:vm";
import { init, createGoal, findGoalFile, loadGoal, setCriteria, transition } from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply } from "../../dsh-graph-host/index.js";

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
  const root = mkdtempSync(join(tmpdir(), "dsh-graph-host-"));
  init(root);
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined), // 无 subagents/agents 服务 → 降级分支
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, { root });
  return { root, routes, goalId };
}

// g-113：无 config.root 的 apply（完全由请求 workspace 决定 root，与生产默认一致）
function setupNoConfigRoot() {
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});
  return { routes };
}

function makeProject(base: string, name: string, title: string): { ws: string; goalId: string; title: string } {
  const ws = join(base, name);
  init(join(ws, ".dsh-graph"));
  // 带 version（backlog 目标无目录不能建卡，见 addCard 业务规则）；id 为 per-root 顺序 g-001，断言必须按标题
  const goalId = createGoal(join(ws, ".dsh-graph"), { title, version: "v-t", actor: "test" });
  return { ws, goalId, title };
}

function boardGoalTitles(body: any): string[] {
  return [
    ...body.versions.flatMap((v: any) => v.goals),
    ...body.standalone,
    ...body.backlog,
  ].map((g: any) => g.title);
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

test("g-157 拖动自动滚动源契约：仅拖动时监听并清理 RAF/监听器", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  assert.match(source, /g-157：拖动自动滚动/);
  assert.match(source, /window\.addEventListener\("dragover", handleDragOver, true\)/);
  assert.match(source, /scrollContainer\.scrollTop/);
  assert.match(source, /cancelAnimationFrame\(rafId\)/);
  assert.match(source, /window\.removeEventListener\("dragover", handleDragOver, true\)/);
  assert.match(source, /window\.removeEventListener\("dragleave", handleDragLeave, true\)/);
  assert.doesNotMatch(source, /overflowX: auto/);
});

test("g-163 判据方块按有序 key 渲染并支持即时同步", () => {
  const card = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/card.js"), "utf8");
  const actions = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  assert.match(card, /function CriteriaProgress\(props\)/);
  assert.match(card, /props\.items/);
  assert.match(card, /CRITERIA_PLACEHOLDERS/);
  assert.match(card, /!CRITERIA_PLACEHOLDERS\.has\(key\)/);
  assert.match(card, /checkedSet\.has\(key\) \? "🟩" : "◽"/);
  assert.match(card, /role: "img"/);
  assert.match(card, /"aria-label": label/);
  assert.match(card, /letterSpacing: "-3px"/);
  assert.match(card, /width: 5, transform: "scaleX\(\.2\)"/);
  assert.match(card, /letterSpacing: "-3px", marginLeft: 0, paddingRight: 2/);
  assert.match(card, /keys\.slice\(0, 10\)/);
  assert.match(card, /Number\(reportedCount\) === 0/);
  assert.match(card, /count: g\.criteria_count \?\? g\.criteriaCount/);
  assert.match(card, /badges\.push\("👤"\)/);
  assert.match(card, /`\$\{done\}\/\$\{total\}`/);
  assert.match(card, /dsh-graph\.criteria-changed/);
  assert.match(actions, /localStorage\.setItem\(storeKey, JSON\.stringify\(next\)\)/);
  assert.match(actions, /window\.dispatchEvent\(new Event\("dsh-graph\.criteria-changed"\)\)/);
  assert.match(card, /window\.addEventListener\("storage", refresh\)/);
  assert.match(card, /if \(!keys\.length\) return null/);
  assert.match(actions, /与 core\/model\.ts criteriaItems 同源/);
});

test("g-164 released 泳道与 active/version 泳道共用同一动态列模板源契约", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  // 顶部表头网格与 released 泳道网格必须共用同一份按折叠状态动态计算的列模板，
  // 否则 released 泳道展开并折叠交付/阻塞列时列宽与上方泳道错位。
  assert.match(source, /const gridCols = \["130px",/);
  assert.match(source, /deliverColumnCollapsed \? "36px" : "minmax\(150px, 1fr\)",\s*\/\/ deliver/);
  assert.match(source, /blockedColumnCollapsed \? "36px" : "minmax\(150px, 1fr\)",\s*\/\/ blocked/);
  // 顶部表头网格：(1) 处使用 gridCols。
  assert.match(source, /h\("div", \{ style: \{ \.\.\.S\.grid, gridTemplateColumns: gridCols \} \},\s*\n\s*h\("div", \{ style: S\.stageHead \}, "泳道＼阶段"\)/);
  // released 泳道网格：(1) 处使用 gridCols（relx- 容器），保证与上方泳道列宽/顺序一致。
  assert.match(source, /relx-" \+ v\.slug, style: \{ \.\.\.S\.grid, gridTemplateColumns: gridCols \}/);
  // 全文件恰好两处（顶部表头 + released 泳道）引用该共享模板，不存在各排各的静态模板。
  assert.equal((source.match(/gridTemplateColumns: gridCols/g) || []).length, 2);
});

test("g-156 交付/阻塞折叠列源契约：会话态、窄栏标题与数量均保留", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  // 折叠状态必须由 React state 持有，不能落到 workspace 或持久化存储。
  assert.match(source, /const \[deliverColumnCollapsed, setDeliverColumnCollapsed\] = React\.useState\(false\)/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  // 交付与阻塞窄栏都显示可识别的标题，并保留卡片计数。
  assert.match(source, /deliverColumnCollapsed\s*\?\s*\n?\s*h\(React\.Fragment, null, "交", h\("br"\), "付"\)/);
  assert.match(source, /blockedColumnCollapsed\s*\?\s*\n?\s*h\(React\.Fragment, null, "阻", h\("br"\), "塞"\)/);
  assert.match(source, /"交", h\("br"\), "付", h\("br"\), `×\$\{count\}`/);
  assert.match(source, /"阻", h\("br"\), "塞", h\("br"\), `×\$\{orderedGoals\.length\}`/);
  // 两列折叠后固定窄宽度，避免横向布局溢出。
  assert.match(source, /deliverColumnCollapsed \? "36px" : "minmax\(150px, 1fr\)"/);
  assert.match(source, /blockedColumnCollapsed \? "36px" : "minmax\(150px, 1fr\)"/);
});

test("g-162 普通泳道折叠入口位于内容底部且 released 不重复添加", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/kanban.js"), "utf8");
  assert.match(source, /const \[collapsedLanes, setCollapsedLanes\] = React\.useState\(\{\}\)/);
  assert.match(source, /className: "dg-lane-collapse"/);
  assert.match(source, /className: "dg-lane-collapse-triangle"/);
  assert.match(source, /gridColumn: "2 \/ -1"/);
  assert.match(source, /collapsible = true/);
  assert.match(source, /lane\(v\.name, v\.goals, "rellane-" \+ v\.slug, null, laneIndex \+ idx, false\)/);
  assert.doesNotMatch(source, /title: "折叠泳道"[\s\S]{0,180}lane\(v\.name, v\.goals, "rellane-/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
  const backlogControl = source.slice(source.indexOf("// g-162: 泳道折叠按钮"), source.indexOf("// g-137 修复"));
  assert.match(backlogControl, /className: "dg-lane-collapse"/);
  assert.match(backlogControl, /className: "dg-lane-collapse-triangle"/);
  assert.match(backlogControl, /"aria-label": "折叠泳道"/);
  assert.doesNotMatch(backlogControl, /className: "dg-btn",\s*title: "折叠泳道"|\}, "▾"\)/);
  const laneCreate = source.slice(source.indexOf("// g-129: 每个 lane 标题右下角"), source.indexOf("return [labelEl, ...cells]"));
  assert.match(laneCreate, /position: "absolute", right: 6, top: 8, bottom: "auto"/);
  assert.equal((source.match(/paddingRight: 40/g) || []).length, 4, "active/version 与 backlog 的展开/折叠标题均预留 + 空间");
  assert.doesNotMatch(laneCreate, /position: version \? "static"/);
  assert.ok(laneCreate.indexOf("// g-129: 每个 lane 标题右下角") < laneCreate.indexOf("collapsible ? h(\"button\""), "展开态应先渲染 + 再渲染折叠按钮");
  const backlogLane = source.slice(source.indexOf("const backlogRow"), source.indexOf("// g-137 修复"));
  assert.match(backlogLane, /position: "absolute", right: 6, top: 8, bottom: "auto"/);
  assert.match(backlogLane, /paddingRight: 40/);
  assert.doesNotMatch(source, /position: version \? "static"/);
});

test("g-163 Card 真实调用链转发 camelCase criteriaItems", () => {
  const source = readFileSync(join(process.cwd(), "dsh-graph-host/lib/client/card.js"), "utf8");
  const elements: any[] = [];
  const h = (type: any, props: any, ...children: any[]) => {
    const value = typeof type === "function" ? type({ ...(props ?? {}), children })
      : { type, props: props ?? {}, children };
    elements.push(value);
    return value;
  };
  const context: any = {
    React: {
      createElement: h,
      useState: (initial: any) => [typeof initial === "function" ? initial() : initial, () => {}],
      useEffect: () => {},
    },
    h,
    S: new Proxy({}, { get: () => ({}) }),
    STATUS_LABEL: { in_progress: "进行中" },
    CARD_STATUS_ICON: {},
    GOAL_TYPE_LABELS: { feature: "功能" },
    GOAL_TYPE_ABBREV: { feature: "F" },
    goalTypeColor: () => "#000",
    normalizeGoalType: () => "feature",
    rowHalf: () => "after",
    localStorage: { getItem: () => JSON.stringify(["第一"]) },
    window: { addEventListener: () => {}, removeEventListener: () => {} },
  };
  const progressStart = source.indexOf("const CRITERIA_PLACEHOLDERS");
  const cardStart = source.indexOf("function Card(");
  const cardEnd = source.indexOf("\n    // g-a92e1406：状态摘要行", cardStart);
  assert.ok(progressStart > 0 && cardStart > progressStart && cardEnd > cardStart);
  const progress = source.slice(progressStart, source.indexOf("    // 目标卡", progressStart));
  const card = source.slice(cardStart, cardEnd);
  new vm.Script(`(function () {\n${progress}\n${card}\nglobalThis.__Card = Card;\n})()`).runInNewContext(context);
  context.__Card(
    { id: "g-camel", title: "camel", status: "in_progress", criteriaItems: ["第一", "第二"] },
    () => {}, () => {}, false, null, {}, false, () => {}, null,
  );
  const progressView = elements.find((entry) => entry?.props?.role === "img");
  assert.ok(progressView, "Card 真实调用应渲染 CriteriaProgress");
  assert.equal(progressView.props["aria-label"], "质量判据：已完成 1/2");
  assert.deepEqual(Array.from(progressView.children[0], (entry: any) => entry?.children?.[0]), ["🟩", "◽"]);

  const beforeZero = elements.length;
  context.__Card(
    { id: "g-zero", title: "zero", status: "in_progress", criteriaItems: ["占位"], criteria_count: 0 },
    () => {}, () => {}, false, null, {}, false, () => {}, null,
  );
  assert.equal(
    elements.slice(beforeZero).some((entry) => entry?.props?.role === "img"),
    false,
    "criteria_count=0 时不应渲染方块",
  );

  const beforePlaceholder = elements.length;
  context.__Card(
    { id: "g-placeholder", title: "placeholder", status: "in_progress", criteriaItems: ["（待登记；进入 in_progress 前必须非空且已确认）"] },
    () => {}, () => {}, false, null, {}, false, () => {}, null,
  );
  assert.equal(
    elements.slice(beforePlaceholder).some((entry) => entry?.props?.role === "img"),
    false,
    "模板占位判据不应渲染方块",
  );
});

test("g-109 写端点全部注册（accept/edit-description/add-card/start-collection）", () => {
  const { routes } = setup();
  for (const p of ["/api/dsh-graph/accept", "/api/dsh-graph/resolve-accept",
    "/api/dsh-graph/edit-description", "/api/dsh-graph/add-card",
    "/api/dsh-graph/start-collection", "/api/dsh-graph/start-execution",
    "/api/dsh-graph/set-goal-type", "/api/dsh-graph/create-goal"]) {
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

test("start-collection 有 subagents：验证使用 formatCollectPrompt 生成完整提示词", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-collect-test-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");

  let capturedPrompt = "";
  const subagentsService = {
    list: () => ["spawn"],
    getProvider: () => ({ prepareContinuable: () => {} }),
    startContinuable: async (opts: any) => {
      capturedPrompt = opts.request?.prompt?.[0]?.text ?? "";
      return { childId: "c-test", parentSessionId: "p-test" };
    },
  };

  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "subagents") return subagentsService;
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  // add-card 必须带 workspace，否则卡片建到 process.cwd()
  const addRes = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "测试卡片", kind: "text", workspace: ws });
  assert.equal(addRes.code, 200);
  const card = addRes.body.card;

  // start-collection
  const handler = routes.get("/api/dsh-graph/start-collection");
  const req = fakeRequest("POST", { goal: goalId, card, workspace: ws });
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal: goalId, card, workspace: ws });
  await p;
  assert.equal(res._code, 200);
  assert.equal(res._body.child_id, "c-test");

  // 验证捕获的提示词包含所有必要字段
  assert.ok(capturedPrompt.includes("**工作目录**：当前分配的 worktree/当前工作目录"), "应包含当前工作目录约束");
  assert.ok(capturedPrompt.includes(`- id: \`${goalId}\``), "应包含 goal id");
  assert.ok(capturedPrompt.includes(`- 标题: 测试目标`), "应包含 goal 标题");
  assert.ok(capturedPrompt.includes(`- id: \`${card}\``), "应包含 card id");
  assert.ok(capturedPrompt.includes(`- 标题: 测试卡片`), "应包含 card 标题");
  assert.ok(capturedPrompt.includes(`- 类型: text`), "应包含 card 类型");
  assert.ok(capturedPrompt.includes(`graph_fill_card(goal="${goalId}", card="${card}", text=<全文>, summary=<≤100字摘要>)`), "应包含精确回填模板");
  assert.ok(capturedPrompt.includes("**禁区（严格遵守）**"), "应包含禁区说明");
});

test("start-collection 用户 prompt 作为附加要求追加，不可替代强制段", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-collect-user-prompt-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "测试目标", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");

  let capturedPrompt = "";
  const subagentsService = {
    list: () => ["spawn"],
    getProvider: () => ({ prepareContinuable: () => {} }),
    startContinuable: async (opts: any) => {
      capturedPrompt = opts.request?.prompt?.[0]?.text ?? "";
      return { childId: "c-user", parentSessionId: "p-user" };
    },
  };

  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "subagents") return subagentsService;
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  const addRes = await post(routes, "/api/dsh-graph/add-card",
    { goal: goalId, title: "用户提示卡", kind: "text", workspace: ws });
  assert.equal(addRes.code, 200);
  const card = addRes.body.card;

  const userPrompt = "请重点关注技术实现细节和性能指标";
  const handler = routes.get("/api/dsh-graph/start-collection");
  const req = fakeRequest("POST", { goal: goalId, card, prompt: userPrompt, workspace: ws });
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal: goalId, card, prompt: userPrompt, workspace: ws });
  await p;
  assert.equal(res._code, 200);

  // 强制段仍然存在
  assert.ok(capturedPrompt.includes("**工作目录**：当前分配的 worktree/当前工作目录"), "强制段：当前工作目录");
  assert.ok(capturedPrompt.includes(`graph_fill_card(goal="${goalId}"`), "强制段：回填模板");
  assert.ok(capturedPrompt.includes("**禁区（严格遵守）**"), "强制段：禁区");
  // 用户附加要求追加在末尾
  assert.ok(capturedPrompt.includes(userPrompt), "用户 prompt 应追加在末尾");
});

test("accept（非 force）：写 review.requested 事件", async () => {
  const { root, routes, goalId } = setup();
  const r = await post(routes, "/api/dsh-graph/accept", { goal: goalId });
  assert.equal(r.code, 200);
  assert.equal(r.body.pending, true);
  const ev = readEvents(root).filter((e) => e.event === "review.requested");
  assert.equal(ev.length, 1);
  // g-137：带 version 的目标初始状态为 planning
  assert.equal(ev[0].details.targetStage, "planning");
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

// ===== g-148：GUI ready→in_progress force transition + start-execution 成功链回归 =====

test("g-148 GUI 两步执行链：force ready→in_progress + start-execution 成功派发子代理", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g148-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  const goalId = createGoal(root, { title: "g-148 测试目标", version: "v-t", actor: "test" });
  writeFileSync(join(root, "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  // 准备目标到 ready（需先设判据再迁移）
  setCriteria(root, goalId, ["测试判据"], "test");
  transition(root, goalId, "ready", { actor: "test" });

  const subagentsService = {
    list: () => ["spawn"],
    getProvider: () => ({ prepareContinuable: () => {} }),
    startContinuable: async () => ({ childId: "c-g148", parentSessionId: "p-g148" }),
  };
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "subagents") return subagentsService;
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  // Step 1：GUI 模拟 force transition ready → in_progress
  const tr = await post(routes, "/api/dsh-graph/transition",
    { goal: goalId, to: "in_progress", force: true, workspace: ws });
  assert.equal(tr.code, 200);
  assert.equal(tr.body.ok, true, "force ready→in_progress 成功");

  // Step 2：start-execution
  const exec = await post(routes, "/api/dsh-graph/start-execution",
    { goal: goalId, workspace: ws });
  assert.equal(exec.code, 200);
  assert.equal(exec.body.ok, true);
  assert.equal(exec.body.child_id, "c-g148", "子代理已派发");
  assert.ok(!exec.body.child_error, "无子代理错误");

  // 验证事件链
  const events = readEvents(root);
  assert.ok(events.some((e) => e.event === "goal.transition" && e.goal === goalId &&
    e.details?.to === "in_progress" && e.actor === "human:gui"),
    "force transition 事件已记录");
  assert.ok(events.some((e) => e.event === "attempt.started" && e.goal === goalId),
    "attempt.started 事件已记录");
  assert.ok(events.some((e) => e.event === "attempt.bound" && e.goal === goalId &&
    e.details?.child_id === "c-g148"),
    "attempt.bound 事件已记录");

  // 验证目标最终状态为 in_progress
  const goalDoc = loadGoal(findGoalFile(root, goalId));
  assert.equal(goalDoc.meta.status, "in_progress");
});

test("g-148 GUI 两步执行链：transition 端点校验缺失参数", async () => {
  const ws = mkdtempSync(join(tmpdir(), "dsh-graph-g148-fail-"));
  const root = join(ws, ".dsh-graph");
  init(root);
  createGoal(root, { title: "g-148 失败测试", version: "v-t", actor: "test" });

  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});

  // 缺少 goal 参数 → 400
  const tr = await post(routes, "/api/dsh-graph/transition",
    { to: "in_progress", force: true, workspace: ws });
  assert.equal(tr.code, 400, "缺失 goal 返回 400");
  assert.ok(tr.body.error, "错误信息存在");

  // 不存在的目标 → 400
  const tr2 = await post(routes, "/api/dsh-graph/transition",
    { goal: "g-nonexist", to: "in_progress", force: true, workspace: ws });
  assert.equal(tr2.code, 400, "不存在的目标返回 400");
});

// ===== g-113：client board 端点跟随请求 workspace（前端带 ?workspace= / body.workspace） =====

test("g-113 board 端点跟随 ?workspace=：读该项目自己的 .dsh-graph，而非默认/进程 cwd 骨架", () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-ws-"));
  const a = makeProject(base, "proj-a", "A 项目目标");
  const b = makeProject(base, "proj-b", "B 项目目标");
  const { routes } = setupNoConfigRoot();
  const handler = routes.get("/api/dsh-graph");
  const res = fakeResponse();
  handler({ method: "GET", url: "/api/dsh-graph?workspace=" + encodeURIComponent(b.ws) }, res);
  assert.equal(res._code, 200);
  const titles = boardGoalTitles(res._body);
  assert.ok(titles.includes(b.title), "board 含 workspace 项目的目标");
  assert.ok(!titles.includes(a.title), "board 不含其他项目目标");
  // 反向：workspace=a 时读 a 的目标
  const res2 = fakeResponse();
  handler({ method: "GET", url: "/api/dsh-graph?workspace=" + encodeURIComponent(a.ws) }, res2);
  const titles2 = boardGoalTitles(res2._body);
  assert.ok(titles2.includes(a.title));
  assert.ok(!titles2.includes(b.title));
});

test("g-113 写端点跟随 body.workspace：add-card 写到该项目 .dsh-graph（事件落该项目）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-ws-"));
  const b = makeProject(base, "proj-b", "B 项目目标");
  const { routes } = setupNoConfigRoot();
  const handler = routes.get("/api/dsh-graph/add-card");
  const req = fakeRequest("POST", { goal: b.goalId, title: "收集卡", kind: "text", workspace: b.ws });
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal: b.goalId, title: "收集卡", kind: "text", workspace: b.ws });
  await p;
  assert.equal(res._code, 200);
  assert.equal(res._body.ok, true);
  assert.ok(typeof res._body.card === "string");
  const ev = readEvents(join(b.ws, ".dsh-graph")).filter((e) => e.event === "card.created");
  assert.equal(ev.length, 1, "卡片事件落在 workspace 项目自己的 .dsh-graph");
  assert.equal(ev[0].goal, b.goalId);
});

test("g-113 写端点同时接受 query 参数 workspace（前端 POST 也走 ?workspace=）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-ws-"));
  const b = makeProject(base, "proj-b", "B 项目目标");
  const { routes } = setupNoConfigRoot();
  const handler = routes.get("/api/dsh-graph/accept");
  const req = fakeRequest("POST", { goal: b.goalId });
  req.url = "/api/dsh-graph/accept?workspace=" + encodeURIComponent(b.ws);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal: b.goalId });
  await p;
  assert.equal(res._code, 200);
  assert.equal(res._body.pending, true);
  const ev = readEvents(join(b.ws, ".dsh-graph")).filter((e) => e.event === "review.requested");
  assert.equal(ev.length, 1, "review.requested 落在 workspace 项目自己的 .dsh-graph");
});

test("g-113 board 端点接受 ?root= 别名（与 ?workspace= 等价，均指 workspace 根）", () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-ws-"));
  const a = makeProject(base, "proj-a", "A 项目目标");
  const b = makeProject(base, "proj-b", "B 项目目标");
  const { routes } = setupNoConfigRoot();
  const handler = routes.get("/api/dsh-graph");
  const res = fakeResponse();
  handler({ method: "GET", url: "/api/dsh-graph?root=" + encodeURIComponent(b.ws) }, res);
  assert.equal(res._code, 200);
  const titles = boardGoalTitles(res._body);
  assert.ok(titles.includes(b.title), "?root= 读到 workspace 项目目标");
  assert.ok(!titles.includes(a.title), "?root= 不串其他项目");
});

test("g-113 无 workspace 参数时回退 config.root（现有行为不回归）", async () => {
  const { root, routes, goalId } = setup(); // config.root = temp
  const handler = routes.get("/api/dsh-graph/goal");
  const res = fakeResponse();
  handler({ method: "GET", url: "/api/dsh-graph/goal?id=" + encodeURIComponent(goalId) }, res);
  assert.equal(res._code, 200);
  assert.equal(res._body.meta?.id, goalId, "无 workspace 时按 config.root 解析（绝对 root 覆盖兜底）");
});

test("g-113 端点触达全新 workspace 时自动 init 骨架（开箱即用，不落 profile 骨架）", () => {
  const freshWs = join(mkdtempSync(join(tmpdir(), "dsh-graph-fresh-")), "brand-new-proj");
  const { routes } = setupNoConfigRoot();
  const handler = routes.get("/api/dsh-graph");
  const res = fakeResponse();
  handler({ method: "GET", url: "/api/dsh-graph?workspace=" + encodeURIComponent(freshWs) }, res);
  assert.equal(res._code, 200);
  assert.deepEqual(boardGoalTitles(res._body), [], "全新项目 board 返回空看板");
  for (const d of ["backlog", "goals", "versions", "memory/long-term"]) {
    assert.ok(existsSync(join(freshWs, ".dsh-graph", d)), `目录 ${d} 已在项目内自动建`);
  }
  assert.ok(existsSync(join(freshWs, ".dsh-graph", "events.jsonl")), "events.jsonl 已在项目内自动建");
  assert.ok(existsSync(join(freshWs, ".dsh-graph", "rules.md")), "rules.md 已在项目内自动建");
  // 骨架建在项目内，而非默认/进程 cwd（profile web 骨架未被写入新目标）
  assert.ok(!existsSync(join(process.cwd(), ".dsh-graph", "versions", "v-t")), "未污染默认骨架");
});

test("g-113 start-execution 注入目标相对路径以请求 workspace 为基准（.dsh-graph/versions/...）", async () => {
  const base = mkdtempSync(join(tmpdir(), "dsh-graph-host-rel-"));
  const ws = join(base, "proj");
  init(join(ws, ".dsh-graph"));
  const goalId = createGoal(join(ws, ".dsh-graph"), { title: "rel 目标", version: "v-t", actor: "test" });
  writeFileSync(join(ws, ".dsh-graph", "project.yaml"), "supervisor:\n  session: sess-super\n", "utf8");
  let capturedPrompt = "";
  const routes = new Map<string, any>();
  const webServer = { register: (def: any) => { routes.set(def.path, def.handler); return () => {}; } };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "subagents") return {
        list: () => ["spawn"],
        getProvider: () => ({ prepareContinuable: () => {} }),
        startContinuable: async (opts: any) => {
          capturedPrompt = opts.request?.prompt?.[0]?.text ?? "";
          return { childId: "c-x" };
        },
      };
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});
  const handler = routes.get("/api/dsh-graph/start-execution");
  const req = fakeRequest("POST", { goal: goalId });
  req.url = "/api/dsh-graph/start-execution?workspace=" + encodeURIComponent(ws);
  const res = fakeResponse();
  const p = handler(req, res);
  emitBody(req, { goal: goalId });
  await p;
  assert.equal(res._code, 200);
  assert.equal(res._body.child_id, "c-x");
  const expected = relative(ws, findGoalFile(join(ws, ".dsh-graph"), goalId));
  assert.ok(capturedPrompt.includes(expected), `prompt 含 workspace 根基准相对路径：${expected}`);
});

// ===== g-148：模块源/生成 bundle onRefresh 注入契约回归 =====

test("g-148 模块源契约：goal-actions.js AcceptFeedback 解构 onRefresh 并在成功路径调用 onRefresh?.()", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  // AcceptFeedback 解构 onRefresh
  assert.ok(
    /const\s*\{\s*goalId\s*,\s*status\s*,\s*events\s*,\s*supervisorSession\s*,\s*onRefresh\s*\}\s*=\s*props/.test(src),
    "AcceptFeedback props 解构包含 onRefresh");
  // 成功路径调用 onRefresh?.()
  assert.ok(
    /onRefresh\?\.\(\)/.test(src),
    "startExecution 成功分支调用 onRefresh?.()");
});

test("g-148 模块源契约：goal-actions.js AcceptFeedback 成功路径无裸 load() 调用", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  // 提取 AcceptFeedback 函数体（从 function AcceptFeedback 到同级函数定义或文件末尾）
  const fnMatch = /function AcceptFeedback\(props\)\s*\{([\s\S]*?)(?=\n    function |\n    \/\/ g-\d+[：:]|\n\s*\}$)/.exec(src);
  assert.ok(fnMatch, "找到 AcceptFeedback 函数体");
  const fnBody = fnMatch[1];
  // AcceptFeedback 函数体内不应有裸 load()（onRefresh?.() 是正确的）
  const bareLoadCalls = fnBody.match(/(?<!\.)load\(\)/g);
  assert.ok(!bareLoadCalls, "AcceptFeedback 函数体内无裸 load() 调用");
});

test("g-148 模块源契约：goal-modal.js 向 AcceptFeedback 传递 onRefresh: load", () => {
  const src = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  // GoalModal 中渲染 AcceptFeedback 时传入 onRefresh: load
  assert.ok(
    /onRefresh:\s*load/.test(src),
    "GoalModal 向 AcceptFeedback 传递 onRefresh: load");
  // load 使用 useCallback 定义（稳定引用）
  assert.ok(
    /const\s+load\s*=\s*React\.useCallback/.test(src),
    "load 使用 useCallback 定义为稳定回调");
});

test("g-148 生成 bundle 契约：client.js 含 onRefresh 解构/调用且无裸 load()，保留 generated header", () => {
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
  // generated header 存在
  assert.ok(
    bundle.startsWith("// ⚠️ GENERATED FILE — DO NOT EDIT DIRECTLY"),
    "client.js 保留 GENERATED FILE header");
  // AcceptFeedback 解构 onRefresh
  assert.ok(
    /const\s*\{\s*goalId\s*,\s*status\s*,\s*events\s*,\s*supervisorSession\s*,\s*onRefresh\s*\}\s*=\s*props/.test(bundle),
    "生成 bundle: AcceptFeedback 解构包含 onRefresh");
  // 成功路径调用 onRefresh?.()
  assert.ok(
    /onRefresh\?\.\(\)/.test(bundle),
    "生成 bundle: startExecution 成功分支调用 onRefresh?.()");
  // GoalModal 向 AcceptFeedback 传递 onRefresh: load
  assert.ok(
    /onRefresh:\s*load/.test(bundle),
    "生成 bundle: GoalModal 传递 onRefresh: load");
  // 提取 AcceptFeedback 函数体，验证无裸 load()
  const fnMatch = /function AcceptFeedback\(props\)\s*\{([\s\S]*?)(?=\n\s{2,4}function |\n\s{2,4}\/\/ g-\d+[：:]|\n\s{2,4}\/\/ 详情 modal)/.exec(bundle);
  assert.ok(fnMatch, "生成 bundle: 找到 AcceptFeedback 函数体");
  const fnBody = fnMatch[1];
  const bareLoadCalls = fnBody.match(/(?<!\.)load\(\)/g);
  assert.ok(!bareLoadCalls, "生成 bundle: AcceptFeedback 函数体内无裸 load() 调用");
});

// g-154：卡片抽屉文件入口 UI 契约回归
test("g-154 生成 bundle 契约：card-drawer.js 含 cardFile 开放/复制逻辑 + 无文件降级", () => {
  const bundle = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/lib/client.js"), "utf8");
  // CardDrawer 含 cardFile 开放逻辑
  assert.ok(
    /card\.cardFile/.test(bundle),
    "生成 bundle: CardDrawer 引用 card.cardFile");
  // 含 openPath 调用（复用 file-link 机制）
  assert.ok(
    /openPath.*card\.cardFile|card\.cardFile.*openPath/s.test(bundle),
    "生成 bundle: CardDrawer 通过 openPath 打开卡片文件");
  // 含复制路径逻辑
  assert.ok(
    /copyText\(card\.cardFile\)/.test(bundle),
    "生成 bundle: CardDrawer 含复制卡片文件路径逻辑");
  // 无文件降级状态
  assert.ok(
    /无文件路径/.test(bundle),
    "生成 bundle: CardDrawer 含无文件路径降级文案");
});

// g-154：编译产物 dsh-graph-host/core/ops.js 含 goalCards cardFile 字段（防止 sync-core 遗漏）
test("g-154 编译产物契约：dsh-graph-host/core/ops.js goalCards 输出含 cardFile 字段", () => {
  const compiledOps = readFileSync(
    join(import.meta.dirname, "../../dsh-graph-host/core/ops.js"), "utf8");
  assert.ok(
    /cardFile:\s*cardFilePath/.test(compiledOps),
    "编译 ops.js: goalCards 输出含 cardFile: cardFilePath");
  assert.ok(
    /if\s*\(c\.cardFile\)/.test(compiledOps),
    "编译 ops.js: goalDetail 使用 c.cardFile 读取全文");
});

// g-158：REST 端到端——create-goal type 透传 + set-goal-type 事件
test("g-158 create-goal REST 透传 type（默认 task/指定/非法回退）", async () => {
  const { root, routes } = setup();
  // 指定 type
  const r1 = await post(routes, "/api/dsh-graph/create-goal", { title: "Feature", type: "feature" });
  assert.equal(r1.code, 200);
  const f = findGoalFile(root, r1.body.goal);
  assert.equal(loadGoal(f).meta.type, "feature", "create-goal 应持久化指定 type");
  // 缺省 type → task
  const r2 = await post(routes, "/api/dsh-graph/create-goal", { title: "默认" });
  const f2 = findGoalFile(root, r2.body.goal);
  assert.equal(loadGoal(f2).meta.type, "task", "缺省 type 应为 task");
  // 非法 type → task
  const r3 = await post(routes, "/api/dsh-graph/create-goal", { title: "非法", type: "nope" });
  const f3 = findGoalFile(root, r3.body.goal);
  assert.equal(loadGoal(f3).meta.type, "task", "非法 type 应回退 task");
});

test("g-158 set-goal-type REST：更新 type + 记 goal.type_changed 事件 + no-op", async () => {
  const { root, routes, goalId } = setup();
  const before = loadGoal(findGoalFile(root, goalId));
  assert.equal(before.meta.type, "task");
  const r = await post(routes, "/api/dsh-graph/set-goal-type", { goal: goalId, type: "bug" });
  assert.equal(r.code, 200);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.old_type, "task");
  assert.equal(r.body.new_type, "bug");
  assert.equal(loadGoal(findGoalFile(root, goalId)).meta.type, "bug");
  const ev = readEvents(root).find((e) => e.event === "goal.type_changed" && e.goal === goalId);
  assert.ok(ev, "应记录 goal.type_changed 事件");
  assert.equal(ev.details.old_type, "task");
  assert.equal(ev.details.new_type, "bug");
  // no-op：相同类型不写事件
  const beforeCount = readEvents(root).filter((e) => e.event === "goal.type_changed").length;
  const r2 = await post(routes, "/api/dsh-graph/set-goal-type", { goal: goalId, type: "bug" });
  assert.equal(r2.body.old_type, "bug");
  assert.equal(r2.body.new_type, "bug");
  const afterCount = readEvents(root).filter((e) => e.event === "goal.type_changed").length;
  assert.equal(afterCount, beforeCount, "相同类型 no-op 不追加事件");
});

test("g-168 定义/润色源契约：按钮同排且请求仅含路径与指导意见", () => {
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  const modal = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  assert.ok(/function DefinitionPolish\(props\)/.test(actions));
  assert.ok(/goalPath/.test(actions) && /guidance/.test(actions));
  assert.ok(!/h\("pre"[\s\S]*request/.test(actions), "不渲染完整请求预览");
  assert.ok(/display: \"flex\", gap: 6, alignItems: \"center\"/.test(actions), "入口位于 AcceptFeedback flex 行");
  assert.ok(/goalPath:[\s\S]*d\.goalFile/.test(modal), "GoalModal 传递 goal.md 路径");
  assert.ok(/goal_path:\s*goalPath/.test(actions), "PM 请求传递路径而非正文");
});

test("g-168 活跃 attempt 回归：历史 completed/空闲不隐藏入口", () => {
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  const match = /function hasActiveExecutionAttempt\(attempts\)\s*\{[\s\S]*?\n    \}/.exec(actions);
  assert.ok(match, "找到活跃 attempt 判断函数");
  const isActive = new Function(`return (${match[0]})`)();
  assert.equal(isActive([{ executor: "agent:executor", result: "completed", status_line: "完成" }]), false);
  assert.equal(isActive([{ executor: "agent:executor", result: "pending", status_line: "空闲待命" }]), false);
  assert.equal(isActive([{ executor: "agent:collect", result: "pending", status_line: "正在收集" }]), false);
  assert.equal(isActive([{ executor: "agent:executor", result: "pending", status_line: "正在执行定义润色" }]), true);
});

test("g-168 复制失败 fallback：初始隐藏且只在失败后显示可复制请求", () => {
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  assert.ok(/const \[fallback, setFallback\] = React\.useState\(false\)/.test(actions));
  assert.ok(/setFallback\(!copied\)/.test(actions));
  assert.ok(/fallback \? h\("textarea"/.test(actions));
  assert.ok(/readOnly:\s*true[\s\S]*value:\s*request/.test(actions));
  assert.ok(!/h\("pre"[\s\S]*request/.test(actions), "初始界面不展示大段 prefill");
});

test("g-168 交互反馈：主管复制成功 toast 与 PM 润色动画", () => {
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  assert.ok(/if \(copied\) showToast\("✅ 请求已复制到剪贴板/.test(actions));
  assert.ok(/const pmRunning = loading && mode === "pm"/.test(actions));
  assert.ok(/className: pmRunning \? "dg-running-flow"/.test(actions));
  assert.ok(/animation: "dg-polish-flow 1\.8s ease infinite"/.test(actions));
  assert.ok(/@keyframes dg-polish-flow/.test(actions), "组件自带动画样式，避免依赖外层注入");
  assert.ok(/setLoading\(false\)/.test(actions), "PM 完成后解除 loading 动画");
  assert.ok(/const startedAt = Date\.now\(\)/.test(actions));
  assert.ok(/700 - \(Date\.now\(\) - startedAt\)/.test(actions), "accepted-running 至少保持短时可观察");
  assert.ok(/finally \{[\s\S]*setLoading\(false\)/.test(actions), "成功/业务失败/异常均最终解除 loading");
});

test("g-168 PM 结果反馈：关闭弹窗并把动画挂在看板卡片", () => {
  const actions = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-actions.js"), "utf8");
  const modal = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/goal-modal.js"), "utf8");
  const kanban = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/kanban.js"), "utf8");
  const card = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/lib/client/card.js"), "utf8");
  assert.ok(/onPmStarted\?\.\(goalId\)/.test(actions));
  assert.ok(/onClose\?\.\(\)/.test(actions), "PM 点击后关闭详情弹窗");
  assert.ok(/onPmFinished\?\.\(goalId\)/.test(actions));
  assert.ok(/onPmStarted: props\.onPmStarted[\s\S]*onPmFinished: props\.onPmFinished/.test(modal));
  assert.ok(/onPmStarted: setPolishGoal[\s\S]*onPmFinished: \(\) => setPolishGoal\(null\)/.test(kanban));
  assert.ok(/_polishActive: polishGoal === g\.id/.test(kanban));
  assert.ok(/g\._polishActive \? " dg-running-flow"/.test(card), "动画 class 挂在 goal card");
  assert.ok(/const cardStyle = g\._polishActive \?/.test(card));
  assert.ok(/background: "linear-gradient\(90deg/.test(card), "卡片 inline gradient 覆盖默认背景");
  assert.ok(/animation: "dg-flow-bg 1\.8s ease infinite"/.test(card));
  assert.equal((card.match(/style: cardStyle, className: dragClass/g) ?? []).length, 2, "折叠/展开路径都使用动画样式");
});

test("g-168 host prompt 契约：PM 读取 goal.md 并附带指导意见", () => {
  const host = readFileSync(join(import.meta.dirname, "../../dsh-graph-host/index.js"), "utf8");
  assert.ok(/const \{ goal, goal_path, guidance \}/.test(host));
  assert.ok(/goal\.md 工作区相对路径/.test(host));
  assert.ok(/read 工具读取上述 goal\.md/.test(host));
  assert.ok(!/目标标题：\$\{String\(title/.test(host));
});
