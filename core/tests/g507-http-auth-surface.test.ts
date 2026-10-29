/** g-507 分层验证 A：**从真实业务路由定义枚举完整集合**，验证未认证请求在业务侧「零触达」。
 *
 * 为什么这样做：g-507 之前 63 条定义逐条裸注册到宿主 webServer（61 条省略 kind ⇒ 宿主按 prefix
 * 处理），任何能连到端口的一方都能读看板、写目标、派发/清理子代理。修复后只注册**一个** prefix
 * 入口，先 admit + owner 后分发。本套件用**真实注册入口**（`webServer.register` 捕获的那个 handler）
 * 逐条发起匿名/伪造凭证请求，并用哨兵证明：
 *   · 请求体从未被读取（`readBodyCapped` 以 `req.on("data"/"end")` 读取 ⇒ 监听器登记即触达）；
 *   · `rootForReq` 的工作区初始化从未发生（全新 workspace 下 `.dsh-graph` 不被创建）；
 *   · 敏感文件读取/写入、子代理派发、worktree 清理均未被调用；
 *   · 拒绝响应不含凭证回显与内部异常细节。
 *
 * 路由集合**从实现枚举**（`httpRoutes()` 由插件 apply 内的注册表构建；测试通过结构的唯一入口 +
 * 定义清单交叉核对），新增路由若落在命名空间之外会被结构守卫判红；新增的命名空间内路由自动进入本
 * 矩阵（因此「新增路由但忘了鉴权」不可能悄悄通过）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, createGoal } from "../ops.ts";
import { readEvents } from "../events.ts";
import { apply, API_NAMESPACE, DESIGN_DIAGRAM_ROUTE, HELP_ASSET_ROUTE, HELP_CATALOG_ROUTE, getRegisteredRoutes } from "../../dist/index.js";
import { createRegisterStub, assertSingleProtectedEntry, OWNER_HEADER } from "./_http-auth-harness.ts";

/** 基线路由全集（g-507 之前 63 条；g-506 后 65 条：63 exact + 2 prefix 资产路由），逐条在此登记。 */
const BASELINE_EXACT = [
  "/api/dsh-graph/supervisor-session",
  "/api/dsh-graph",
  "/api/dsh-graph/goal",
  "/api/dsh-graph/refresh-results",
  "/api/dsh-graph/set-criteria",
  "/api/dsh-graph/relations",
  "/api/dsh-graph/accept",
  "/api/dsh-graph/resolve-accept",
  "/api/dsh-graph/worktrees",
  "/api/dsh-graph/worktrees/clean",
  "/api/dsh-graph/transition",
  "/api/dsh-graph/order",
  "/api/dsh-graph/move-goal",
  "/api/dsh-graph/edit-description",
  "/api/dsh-graph/rename-goal",
  "/api/dsh-graph/memory/list",
  "/api/dsh-graph/memory/add",
  "/api/dsh-graph/memory/delete",
  "/api/dsh-graph/memory/toggle-tools",
  "/api/dsh-graph/set-goal-tags",
  "/api/dsh-graph/set-goal-type",
  "/api/dsh-graph/add-card",
  "/api/dsh-graph/card",
  "/api/dsh-graph/shared-cards",
  "/api/dsh-graph/create-shared-card",
  "/api/dsh-graph/attach-shared-card",
  "/api/dsh-graph/unreference-shared-card",
  "/api/dsh-graph/delete-shared-card",
  "/api/dsh-graph/convert-card-to-shared",
  "/api/dsh-graph/convert-card-to-owned",
  "/api/dsh-graph/delete-card",
  "/api/dsh-graph/attachments",
  "/api/dsh-graph/attachment",
  "/api/dsh-graph/store-attachment",
  "/api/dsh-graph/delete-attachment",
  "/api/dsh-graph/start-collection",
  "/api/dsh-graph/define-polish",
  "/api/dsh-graph/start-execution",
  "/api/dsh-graph/start-review",
  "/api/dsh-graph/spawn-options",
  "/api/dsh-graph/settings",
  "/api/dsh-graph/care/status",
  "/api/dsh-graph/care/control",
  "/api/dsh-graph/create-goal",
  "/api/dsh-graph/set-directive",
  "/api/dsh-graph/set-description",
  "/api/dsh-graph/add-comment",
  "/api/dsh-graph/record-handoff",
  "/api/dsh-graph/archive",
  "/api/dsh-graph/postpone",
  "/api/dsh-graph/unarchive",
  "/api/dsh-graph/delete",
  "/api/dsh-graph/unbind",
  "/api/dsh-graph/abandon-attempt",
  "/api/dsh-graph/create-version",
  "/api/dsh-graph/rename-version",
  "/api/dsh-graph/delete-version",
  "/api/dsh-graph/version-detail",
  "/api/dsh-graph/version-goals",
  "/api/dsh-graph/backlog-goals",
  "/api/dsh-graph/release-version",
  "/api/dsh-graph/set-version-status",
  HELP_CATALOG_ROUTE,
];
const BASELINE_PREFIX = [DESIGN_DIAGRAM_ROUTE, HELP_ASSET_ROUTE];

/** 「请求形态」矩阵：每个端点 × 每种形态都必须被拒绝且零触达。 */
const REQUEST_SHAPES = [
  { name: "匿名 GET（无凭证）", method: "GET", cred: "none" },
  { name: "匿名 POST（带 JSON body）", method: "POST", cred: "none", body: { goal: "g-001", workspace: "/tmp/never-used" } },
  { name: "伪造凭证头", method: "POST", cred: "forged", body: { goal: "g-001", workspace: "/tmp/never-used" } },
  { name: "伪造 owner 头但值不匹配", method: "GET", cred: "forged-owner", },
  { name: "信任边界拒绝 403", method: "GET", cred: "untrusted" },
] as const;

/**
 * 建立真实注册入口 + 哨兵基础设施。
 *
 * `connection` 桩在这里只扮演「宿主 401/403 判定」：不带测试自有 owner 凭证头的请求一律 401
 * （与真实 `HostConnectionService.admit` 对无凭证/伪造凭证的结果一致），`untrusted` 形态返回 403
 * （与真实 Host/Origin fence 拒绝一致）。**真实凭证验证**（签名 cookie、篡改、过期、撤销）在
 * `g507-http-auth-real-host.test.ts` 里用真实 HostConnectionService + 测试内存 credentials 完成。
 */
function makeEntry(opts: { withConnection?: boolean } = {}) {
  const withConnection = opts.withConnection ?? true;
  const { routes, webServer } = createRegisterStub();
  const calls = {
    spawns: 0,
    worktreeCleans: 0,
    cleans: 0,
    bodyReaders: 0,
    connectionAdmits: 0,
  };
  const subagents = {
    list: () => ["spawn"],
    getProvider: () => ({ prepareContinuable: () => {} }),
    startContinuable: async () => {
      calls.spawns++;
      return { childId: `child-${calls.spawns}` };
    },
  };
  const connection = {
    admit(request: any) {
      calls.connectionAdmits++;
      const headers = request?.headers ?? {};
      if (headers["x-dsh-graph-untrusted"] === "1") return { rejection: 403 as const };
      if (headers[OWNER_HEADER] === "1") return { peer: { principal: { kind: "owner" } } };
      return { rejection: 401 as const };
    },
  };
  const ctx: any = {
    get: (name: string) => {
      if (name === "webServer") return webServer;
      if (name === "connection") return withConnection ? connection : undefined;
      if (name === "subagents") return subagents;
      if (name === "agents") return { get: () => ({ id: "sess-super" }) };
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
    on() {},
  };
  apply(ctx, {});
  const entry = assertSingleProtectedEntry(routes).handler;
  return { entry, routes, calls, ctx };
}

/** 观测型请求：记录 `on("data"|"end")` 登记（= 业务读取 body 的唯一入口）与销毁状态。 */
function watchRequest(method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const seen: { bodyListeners: number; destroyed: boolean } = { bodyListeners: 0, destroyed: false };
  const listeners: Record<string, Array<(v?: any) => void>> = {};
  const req: any = {
    method,
    url,
    headers,
    on(ev: string, cb: (v?: any) => void) {
      if (ev === "data" || ev === "end") seen.bodyListeners++;
      (listeners[ev] ??= []).push(cb);
      return req;
    },
    destroy() {
      seen.destroyed = true;
    },
    emit(ev: string, v?: any) {
      for (const cb of listeners[ev] ?? []) cb(v);
    },
    _body: body,
  };
  return { req, seen };
}

function watchResponse() {
  const res: any = {
    status: 0,
    headers: {} as Record<string, string>,
    body: null as any,
    ended: false,
    headersSent: false,
    writableEnded: false,
    writeHead(code: number, headers?: Record<string, string>) {
      res.status = code;
      res.headers = headers ?? {};
      res.headersSent = true;
      return res;
    },
    write() {
      return true;
    },
    end(chunk?: any) {
      res.ended = true;
      res.writableEnded = true;
      if (typeof chunk === "string" && chunk.length > 0) {
        try {
          res.body = JSON.parse(chunk);
        } catch {
          res.body = chunk;
        }
      } else if (Buffer.isBuffer(chunk)) {
        res.body = chunk;
      }
      return res;
    },
  };
  return res;
}

/** 端点全集：per-endpoint 用例用「命名空间内所有业务路径」，另加资产 prefix 子路径与未知子路径。 */
function allEndpointPaths(): string[] {
  return [...BASELINE_EXACT, ...BASELINE_PREFIX.map((p) => `${p}/design-philosophy.lifecycle.html`)];
}

const ABSENT_HEADERS = ["x-dsh-graph-secret", "authorization", "cookie"];

test("g-507 A1：唯一受保护入口 —— 注册集合恰为 1 个 prefix，命名空间根，无裸业务注册", () => {
  const { routes, entry } = makeEntry();
  assert.equal(routes.length, 1, "只注册一个入口（不保留任何逐条裸注册）");
  assertSingleProtectedEntry(routes);
  assert.equal(typeof entry, "function");
});

test("g-507 A2：基线路由全集与**实现快照**双向对账（单行新增/删除都会判红）", () => {
  // 数量锚：基线 65 = 63 exact + 2 prefix；任一清单漂移都会在此判红（需人工确认新增/删除理由）。
  assert.equal(BASELINE_EXACT.length, 63, "基线 exact 路由 63 条");
  assert.equal(BASELINE_PREFIX.length, 2, "基线 prefix 资产路由 2 条");
  assert.equal(BASELINE_EXACT.length + BASELINE_PREFIX.length, 65, "基线路由全集 65 条");
  assert.equal(new Set(BASELINE_EXACT).size, BASELINE_EXACT.length, "exact 清单无重复");
  for (const p of [...BASELINE_EXACT, ...BASELINE_PREFIX]) {
    assert.ok(p === API_NAMESPACE || p.startsWith(`${API_NAMESPACE}/`), `${p} 在受保护命名空间内`);
  }
  assert.deepEqual(allEndpointPaths().length, 65, "端点矩阵 = 65 条基线");

  // g-507 返工：不再用源码文本计数（`\n    {\n` 对单行追加静默失聪），改用**真实注册时刻的快照**
  // `getRegisteredRoutes()`（由插件在注册前生成，仅 path+kind）做**双向**对账：
  //   ① 实现里的每条业务路由都必须在测试全集里（否则新增路由逃出拒绝矩阵）；
  //   ② 测试全集里的每条都必须仍在实现里（否则删掉业务路由无人发现）。
  // 先在本用例内真实装配一次（快照由注册动作产生，不依赖文件内其它用例的执行顺序）
  makeEntry();
  const registered = getRegisteredRoutes();
  assert.ok(registered, "插件 apply 之后必须能取到真实注册快照");
  const implExact = registered!.filter((r) => r.kind === "exact").map((r) => r.path).sort();
  const implPrefix = registered!.filter((r) => r.kind === "prefix").map((r) => r.path).sort();
  assert.deepEqual(implExact, [...BASELINE_EXACT].sort(), "实现 exact 集合必须与测试全集逐条一致");
  assert.deepEqual(implPrefix, [...BASELINE_PREFIX].sort(), "实现 prefix 集合必须与测试全集逐条一致");
  assert.equal(registered!.length, 65, "实现快照总数 = 65（单行新增一条也会在此判红）");
  // 快照只含 path+kind，绝不含 handler（不得变成绕过门禁的调用面）
  for (const r of registered!) assert.deepEqual(Object.keys(r).sort(), ["kind", "path"], "快照字段只允许 kind/path");
});

test("g-507 A3：全部 65 条端点 × 匿名/伪造/信任边界形态 ⇒ 一律拒绝，业务零触达", async () => {
  const { entry, calls } = makeEntry();
  const endpoints = allEndpointPaths();
  const unknownPaths = [
    `${API_NAMESPACE}/no-such-endpoint`,
    `${API_NAMESPACE}/goal/extra-segment`,
    `${API_NAMESPACE}/`,
    `${API_NAMESPACE}/.hidden`,
  ];
  let checked = 0;
  for (const [idx, path] of endpoints.entries()) {
    for (const shape of REQUEST_SHAPES) {
      const headers: Record<string, string> = {};
      if (shape.cred === "forged") headers[OWNER_HEADER] = "0"; // 伪造凭证：头存在但值不匹配
      if (shape.cred === "forged-owner") headers[OWNER_HEADER] = "true";
      if (shape.cred === "untrusted") headers["x-dsh-graph-untrusted"] = "1";
      const body = (shape as any).body ?? (shape.method === "POST" ? { goal: "g-001" } : undefined);
      const uniqueWs = `/nonexistent/g507-a3/${idx}/${shape.method}`;
      const url = `${path}${path.includes("?") ? "&" : "?"}workspace=${encodeURIComponent(uniqueWs)}`;
      const { req, seen } = watchRequest(shape.method, url, headers, body);
      const res = watchResponse();
      const ret = entry(req, res);
      if (ret && typeof (ret as any).then === "function") await ret;
      req.emit("end");
      const expected = shape.cred === "untrusted" ? 403 : 401;
      assert.equal(res.status, expected, `${path} × ${shape.name} ⇒ ${expected}（实得 ${res.status}）`);
      assert.equal(seen.bodyListeners, 0, `${path} × ${shape.name}：拒绝路径不得登记任何 body 监听器`);
      assert.ok(!existsSync(uniqueWs), `${path} × ${shape.name}：不得为请求 workspace 创建任何目录（rootForReq 未触达）`);
      // 拒绝响应不泄露凭证/内部细节
      assert.equal(typeof res.body, "object", "拒绝响应为固定 JSON");
      assert.equal(res.body.error, shape.cred === "untrusted" ? "trust-boundary-rejected" : "unauthenticated");
      for (const h of ABSENT_HEADERS) assert.ok(!(h in res.headers), `拒绝响应不得回显 ${h}`);
      assert.doesNotMatch(JSON.stringify(res.body), /at .*\(|Error:|stack/i, "拒绝响应不得携带内部异常细节");
      checked++;
    }
  }
  for (const path of unknownPaths) {
    for (const shape of REQUEST_SHAPES) {
      const headers: Record<string, string> = {};
      if (shape.cred === "untrusted") headers["x-dsh-graph-untrusted"] = "1";
      const { req, seen } = watchRequest(shape.method, path, headers);
      const res = watchResponse();
      await entry(req, res);
      assert.equal(res.status, shape.cred === "untrusted" ? 403 : 401, `${path} × ${shape.name}：未知子路径同样先鉴权（不泄露命名空间结构）`);
      assert.equal(seen.bodyListeners, 0);
    }
    checked++;
  }
  assert.equal(checked, 65 * REQUEST_SHAPES.length + unknownPaths.length, "矩阵覆盖数自证");
  assert.equal(calls.spawns, 0, "子代理派发零触达");
  assert.equal(calls.worktreeCleans, 0, "worktree 清理零触达");
  assert.equal(calls.bodyReaders, 0, "body 读取零触达");
});

test("g-507 A4：代表性真实 POST —— 匿名/伪造下事件流、文件、派发/清理均不变（哨兵）", async () => {
  // 真实工作区 + 真实 init：证明拒绝发生在 rootForReq/init 之前。
  const ws = mkdtempSync(join(tmpdir(), "g507-a4-ws-"));
  init(ws);
  const goalId = createGoal(ws, { title: "g-507 A4 哨兵目标", version: "v-t", actor: "test" });
  const eventsBefore = readEvents(ws).length;
  const filesBefore = readdirSync(ws).sort();
  const goalsBefore = readdirSync(join(ws, "versions", "v-t", "goals")).sort();

  const { entry, calls } = makeEntry();
  const writes = [
    { path: `${API_NAMESPACE}/add-card`, body: { goal: goalId, title: "恶意卡片", kind: "text", scope: "goal", workspace: ws } },
    { path: `${API_NAMESPACE}/set-criteria`, body: { goal: goalId, items: ["注入判据"], workspace: ws } },
    { path: `${API_NAMESPACE}/transition`, body: { goal: goalId, to: "collecting", workspace: ws } },
    { path: `${API_NAMESPACE}/start-execution`, body: { goal: goalId, workspace: ws } },
    { path: `${API_NAMESPACE}/start-collection`, body: { goal: goalId, workspace: ws } },
    { path: `${API_NAMESPACE}/delete`, body: { goal: goalId, workspace: ws } },
    { path: `${API_NAMESPACE}/worktrees/clean`, body: { id: "att-01", confirm: true, workspace: ws } },
    { path: `${API_NAMESPACE}/abandon-attempt`, body: { goal: goalId, attempt: "att-001", reason: "x", workspace: ws } },
    { path: `${API_NAMESPACE}/settings`, body: { prompt_overrides: { executor: { state: "override", value: "pwned" } } } },
  ];
  for (const w of writes) {
    for (const cred of ["none", "forged"] as const) {
      const headers: Record<string, string> = cred === "forged" ? { [OWNER_HEADER]: "0" } : {};
      const { req, seen } = watchRequest("POST", `${w.path}?workspace=${encodeURIComponent(ws)}`, headers, w.body);
      const res = watchResponse();
      const ret = entry(req, res);
      if (ret && typeof (ret as any).then === "function") await ret;
      req.emit("data", JSON.stringify(w.body));
      req.emit("end");
      assert.equal(res.status, 401, `${w.path}（${cred}）⇒ 401`);
      assert.equal(seen.bodyListeners, 0, `${w.path}：拒绝路径不得读取 body`);
    }
  }
  assert.equal(readEvents(ws).length, eventsBefore, "事件流未新增任何事件");
  assert.deepEqual(readdirSync(ws).sort(), filesBefore, "工作区顶层文件/目录未变化");
  assert.deepEqual(readdirSync(join(ws, "versions", "v-t", "goals")).sort(), goalsBefore, "目标目录未变化");
  assert.equal(calls.spawns, 0, "派发零触达");
  assert.equal(calls.worktreeCleans, 0, "cleanWorktree 零触达");
});

test("g-507 A5：缺 active connection / 缺 admit / admit 抛错 / 畸变 admission ⇒ 503 fail-closed 且零触达", async () => {
  const variants: Array<{ name: string; make: (calls: any) => any }> = [
    { name: "无 connection 服务", make: () => undefined },
    { name: "connection 无 admit", make: () => ({}) },
    { name: "admit 抛错", make: () => ({ admit: () => { throw new Error("boom"); } }) },
    { name: "admit 返回 undefined", make: () => ({ admit: () => undefined }) },
    { name: "admit 返回非对象拒绝码", make: () => ({ admit: () => ({ rejection: 500 }) }) },
    { name: "admit 既无 peer 也无 rejection", make: () => ({ admit: () => ({}) }) },
    { name: "admit 返回 null", make: () => ({ admit: () => null }) },
  ];
  for (const v of variants) {
    const calls = { spawns: 0, worktreeCleans: 0 };
    const { routes, webServer } = createRegisterStub();
    const conn = v.make(calls);
    const ctx: any = {
      get: (name: string) => (name === "webServer" ? webServer : name === "connection" ? conn : undefined),
      effect: (fn: () => unknown) => fn(),
      webServer,
      tools: { register: () => () => {}, get: () => ({}) },
    };
    apply(ctx, {});
    const entry = assertSingleProtectedEntry(routes).handler;
    const { req, seen } = watchRequest("POST", `${API_NAMESPACE}/create-goal?workspace=${encodeURIComponent(`/nonexistent/g507-a5/${Math.random()}`)}`, { [OWNER_HEADER]: "1" }, { title: "x" });
    const res = watchResponse();
    const ret = entry(req, res);
    if (ret && typeof (ret as any).then === "function") await ret;
    req.emit("end");
    assert.equal(res.status, 503, `${v.name} ⇒ 503 fail-closed（实得 ${res.status}）`);
    assert.equal(seen.bodyListeners, 0, `${v.name}：不得读取 body`);
    assert.ok(typeof res.body?.error === "string" && res.body.error.length > 0, `${v.name}：给出明确诊断`);
    assert.doesNotMatch(JSON.stringify(res.body), /boom|at .*\(/, `${v.name}：诊断不得携带内部异常文本`);
    assert.equal(calls.spawns, 0);
  }
});

test("g-507 A6：有效凭证但非 owner ⇒ 403（不进入业务、零触达）", async () => {
  const { routes, webServer } = createRegisterStub();
  const calls = { spawns: 0 };
  const ctx: any = {
    get: (name: string) =>
      name === "webServer" ? webServer
      : name === "connection" ? { admit: () => ({ peer: { principal: { kind: "remote" } } }) }
      : name === "subagents" ? { list: () => ["spawn"], getProvider: () => ({}), startContinuable: async () => { calls.spawns++; return {}; } }
      : undefined,
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
  };
  apply(ctx, {});
  const entry = assertSingleProtectedEntry(routes).handler;
  for (const path of [`${API_NAMESPACE}/create-goal`, `${API_NAMESPACE}/goal`, `${API_NAMESPACE}/diagram/x.html`]) {
    const { req, seen } = watchRequest("POST", path, {}, {});
    const res = watchResponse();
    await entry(req, res);
    assert.equal(res.status, 403, `${path}：有效凭证的非 owner ⇒ 403`);
    assert.equal(res.body.error, "not-owner");
    assert.equal(seen.bodyListeners, 0);
  }
  assert.equal(calls.spawns, 0);
});

test("g-507 A7：认证后未知子路径 404、method 不匹配 405、query 参与业务但不参与路径匹配", async () => {
  const ws = mkdtempSync(join(tmpdir(), "g507-a7-ws-"));
  init(ws);
  createGoal(ws, { title: "g-507 A7", version: "v-t", actor: "test" });
  const { entry } = makeEntry();
  const h = { [OWNER_HEADER]: "1" };

  const unknown = watchResponse();
  await entry(watchRequest("GET", `${API_NAMESPACE}/no-such-endpoint`, h).req, unknown);
  assert.equal(unknown.status, 404, "认证后未知子路径 404");

  const wrongMethod = watchResponse();
  await entry(watchRequest("GET", `${API_NAMESPACE}/create-version?workspace=${encodeURIComponent(ws)}`, h).req, wrongMethod);
  assert.equal(wrongMethod.status, 405, "POST-only 端点用 GET ⇒ 405（由业务在认证后判定）");

  const withQuery = watchResponse();
  await entry(watchRequest("GET", `${API_NAMESPACE}?workspace=${encodeURIComponent(ws)}&lazy=1`, h).req, withQuery);
  assert.equal(withQuery.status, 200, "query 不参与路径匹配，业务照常读到参数");
  assert.equal(withQuery.body.lazy, true, "query 原样交给业务 handler");

  const trailing = watchResponse();
  await entry(watchRequest("GET", `${API_NAMESPACE}/?workspace=${encodeURIComponent(ws)}`, h).req, trailing);
  assert.equal(trailing.status, 404, "尾斜杠不归一、不重定向：/api/dsh-graph/ ≠ /api/dsh-graph");

  // 资产 prefix 尾段为空（`/diagram/`）：命中 prefix ⇒ 业务白名单裁决空名 ⇒ 400 illegal-name
  // （既有 g-462/g-481 白名单语义不变；未认证时这些路径一律 401，只有认证后才看得到该状态）。
  const diagramDir = watchResponse();
  await entry(watchRequest("GET", `${DESIGN_DIAGRAM_ROUTE}/`, h).req, diagramDir);
  assert.equal(diagramDir.status, 400, "资产 prefix 尾段为空 ⇒ 400（illegal-name，白名单拒绝）");

  const helpDir = watchResponse();
  await entry(watchRequest("GET", `${HELP_ASSET_ROUTE}/`, h).req, helpDir);
  assert.equal(helpDir.status, 400, "帮助资产 prefix 尾段为空 ⇒ 400（illegal-name）");

  const diagramRoot = watchResponse();
  await entry(watchRequest("GET", DESIGN_DIAGRAM_ROUTE, h).req, diagramRoot);
  assert.equal(diagramRoot.status, 404, "资产 prefix 根自身 ⇒ 404 name-required");

  const methodOnAsset = watchResponse();
  await entry(watchRequest("POST", `${DESIGN_DIAGRAM_ROUTE}/design-philosophy.lifecycle.html`, h).req, methodOnAsset);
  assert.equal(methodOnAsset.status, 405, "资产路由 POST ⇒ 405（认证后由业务判定）");

  const segmentBoundary = watchResponse();
  await entry(watchRequest("GET", `${DESIGN_DIAGRAM_ROUTE}X/evil`, h).req, segmentBoundary);
  assert.equal(segmentBoundary.status, 404, "段边界：/diagramX 不得误中 /diagram prefix");
});

test("g-507 A8：401/403/503 拒绝诊断各只写一行 stderr，保留状态码/reason 且不含目标编号与凭证", async () => {
  // 三种拒绝面各自的真实调用：401 匿名 / 403 信任边界 / 503 connection 不可用。
  const cases = [
    {
      name: "401 匿名",
      make: () => makeEntry(),
      method: "GET",
      url: `${API_NAMESPACE}/goal`,
      headers: { [OWNER_HEADER]: "SECRET-E2E-VALUE" } as Record<string, string>,
      status: 401,
      line: /^\[dsh-graph-host\] HTTP 鉴权拒绝 401 unauthenticated\n?$/,
    },
    {
      name: "403 信任边界",
      make: () => makeEntry(),
      method: "GET",
      url: `${API_NAMESPACE}/goal`,
      headers: { "x-dsh-graph-untrusted": "1", cookie: "SECRET-E2E-COOKIE" } as Record<string, string>,
      status: 403,
      line: /^\[dsh-graph-host\] HTTP 鉴权拒绝 403 trust-boundary-rejected\n?$/,
    },
    {
      name: "503 connection 不可用",
      make: () => makeEntry({ withConnection: false }),
      method: "POST",
      url: `${API_NAMESPACE}/create-goal`,
      headers: {} as Record<string, string>,
      status: 503,
      line: /^\[dsh-graph-host\] HTTP 鉴权拒绝 503 connection-service-unavailable（宿主 connection 服务未就绪：fail-closed）\n?$/,
    },
  ] as const;
  for (const item of cases) {
    // 先在捕获窗口外完成 apply（注册期日志会合法携带 workspace 路径）；本用例只审计**请求期**
    // 的拒绝诊断 —— 不该把包含任意路径的注册日志误当拒绝日志。
    const { entry } = item.make();
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as any).write = (chunk: any) => {
      writes.push(String(chunk));
      return true;
    };
    try {
      const res = watchResponse();
      await entry(watchRequest(item.method, item.url, item.headers).req, res);
      assert.equal(res.status, item.status, `${item.name}：HTTP 状态码必须原样保留`);
    } finally {
      (process.stderr as any).write = orig;
    }
    const lines = writes.filter((w) => w.includes("HTTP 鉴权拒绝"));
    assert.equal(lines.length, 1, `${item.name}：每次拒绝留一条诊断`);
    assert.match(lines[0], item.line, `${item.name}：诊断保留中性功能标签、状态码与 reason`);
    assert.doesNotMatch(lines[0], /\bg-\d+\b/, `${item.name}：诊断不得包含目标编号（用中性功能描述）`);
    assert.doesNotMatch(lines[0], /SECRET-E2E-VALUE|SECRET-E2E-COOKIE/, `${item.name}：诊断不得包含凭证值`);
    assert.doesNotMatch(lines[0], /cookie|authorization/i, `${item.name}：诊断不得包含凭证头`);
    for (const w of writes) {
      assert.doesNotMatch(w, /\bg-\d+\b/, `${item.name}：拒绝路径写入 stderr 的任何内容都不得含目标编号`);
    }
  }
});
