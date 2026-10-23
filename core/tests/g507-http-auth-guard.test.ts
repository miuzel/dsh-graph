/** g-507 结构守卫：**生产注册路径不可能留下裸业务路由** + 基线 63 条清单不漂移。
 *
 * A 层用「真实注册入口」证明行为；本套件用**源码结构**证明「未来新增路由也不会绕开门禁」：
 *   · webServer 上只允许一次 `register(...)`，且其参数必须是唯一的 prefix 命名空间入口（dispatchRequest）；
 *   · 取消 provider 的一条路由定义都在命名空间内（越界 ⇒ `buildRouteTable` 抛错 ⇒ 不注册）；
 *   · 业务 handler 只能出现在 `httpRoutes()` 定义数组里，入口之外没有第二条 `webServer.register` 通路；
 *   · 基线 63 条（61 exact + 2 prefix）在**实现里**可被枚举，且与 A 层清单逐条一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { API_NAMESPACE, DESIGN_DIAGRAM_ROUTE, HELP_ASSET_ROUTE, HELP_CATALOG_ROUTE, buildRouteTable, lookupRoute, getRegisteredRoutes } from "../../dist/index.js";
import { assertEndpointsDefined, assertSameRouteSet, createRegisterStub, ownerConnectionStub } from "./_http-auth-harness.ts";
import { assertSingleProtectedEntry as assertSingleProtectedEntryShared } from "./_http-auth-harness.ts";
import { apply } from "../../dist/index.js";

/** 变异对照专用文件：它们**故意**在私有副本里直接驱动变异代码，不属「业务套件」范畴（文件名固定登记）。 */
const NEGATIVE_CONTROL_FILES = new Set(["g507-auth-negative-controls.test.ts"]);

/** 真实装配一次插件（快照由**真实注册动作**产生；本文件不 mock 路由表，也不读源码形状）。 */
function bootPlugin() {
  const { routes, webServer } = createRegisterStub();
  const ctx: any = {
    get: (name: string) => (name === "webServer" ? webServer : name === "connection" ? ownerConnectionStub() : undefined),
    effect: (fn: () => unknown) => fn(),
    webServer,
    tools: { register: () => () => {}, get: () => ({}) },
    on() {},
  };
  apply(ctx, {});
  return routes;
}

const HOST_SRC = readFileSync(join(process.cwd(), "dsh-graph-host/index.js"), "utf8");
/** 去掉行注释与块注释后的可执行代码面（守卫只看真实代码，不被注释里的示例误导）。 */
const CODE = HOST_SRC.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

test("g-507 S1：webServer.register 只有一处，且是唯一的 prefix 命名空间入口", () => {
  // g-507 返工：旧正则 `webServer\.register\(([^)]*)\)` 的 `[^)]*` 会在内层右括号处截断，
  // 于是 `for (const def of httpRoutes()) webServer.register({...})` 这类逐条裸注册**完全匹配不到**
  //（实测：把注册改回逐条裸注册，守卫仍全绿）。现改为两条独立判据：
  //   ① 计数：源码里 `webServer.register` 的出现次数恰为 1（任何新增调用点都会判红）；
  //   ② 参数：唯一调用点的参数必须是唯一的 prefix 命名空间入口（按源码切片逐字比对）。
  const occurrences = [...CODE.matchAll(/webServer\.register\b/g)].length;
  assert.equal(occurrences, 1, `生产代码只允许一次 webServer.register（实际 ${occurrences} 次）`);
  const at = CODE.indexOf("webServer.register");
  const argStart = CODE.indexOf("(", at) + 1;
  const argEnd = CODE.indexOf(");", argStart);
  const arg = CODE.slice(argStart, argEnd).trim();
  assert.equal(arg, '{ kind: "prefix", path: API_NAMESPACE, handler: dispatchRequest }', `唯一入口必须是显式 prefix + 命名空间根 + dispatchRequest（实得 ${arg.slice(0, 120)}）`);
  // 逐条注册的各种写法都不得出现（for/forEach/map/reduce 包裹 register）
  assert.doesNotMatch(CODE, /for\s*\([\s\S]{0,80}?webServer\.register/, "不得在循环里逐条注册业务定义");
  assert.doesNotMatch(CODE, /\.(forEach|map|reduce)\s*\([\s\S]{0,80}?webServer\.register/, "不得在集合遍历里逐条注册业务定义");
  // 运行时判据（更硬）：真实装配后注册集合必须恰为 1 条
  const routes = bootPlugin();
  assert.equal(routes.length, 1, `真实装配后注册集合必须恰为 1 条（实得 ${routes.length}）`);
  assertSingleProtectedEntryShared(routes);
});

test("g-507 S2：准入先于业务 —— dispatchRequest 先 admitRequest，再匹配路径/解析 body", () => {
  const start = CODE.indexOf("const dispatchRequest = (req, res) => {");
  assert.ok(start > 0, "存在唯一 dispatcher");
  const body = CODE.slice(start, CODE.indexOf("\n  };", start));
  const admitAt = body.indexOf("admitRequest(req)");
  assert.ok(admitAt > 0, "dispatcher 先调用准入");
  for (const later of ["routeState.table", "new URL(", ".handler(req, res)", "json(res"]) {
    const at = body.indexOf(later);
    if (at >= 0) assert.ok(at > admitAt, `「${later}」必须出现在准入之后`);
  }
  // 准入实现必须保留 this 绑定调用公开 admit（不得解构后裸调）
  assert.match(CODE, /service\.admit\(\{ headers:/, "以 service.admit(...) 形式调用（保留 this 绑定）");
  assert.doesNotMatch(CODE, /const \{[^}]*admit[^}]*\}\s*=\s*(?:service|connection)/, "不得解构 admit 后裸调（会丢 this）");
});

test("g-507 S3：准入拒绝面 —— 401/403 沿用宿主、非 owner 403、其余一律 503 fail-closed", () => {
  const start = CODE.indexOf("const admitRequest = (req) => {");
  const body = CODE.slice(start, CODE.indexOf("\n  };", start));
  assert.match(body, /if \(!service\)[\s\S]*?503/, "缺 active connection ⇒ 503");
  assert.match(body, /typeof service\.admit !== "function"[\s\S]*?503/, "缺公开 admit ⇒ 503");
  assert.match(body, /catch[\s\S]*?503/, "admit 抛错 ⇒ 503");
  assert.match(body, /status: rejection/, "宿主拒绝码沿用");
  assert.match(body, /peerIsOwner\(peer\)\) return \{ status: 403, reason: "not-owner" \}/, "非 owner ⇒ 403");
  // 不依赖 cookie 形状 / 私有 browserAuth / 自建签名
  assert.doesNotMatch(CODE, /browserAuth/, "不得使用私有 browserAuth");
  assert.doesNotMatch(CODE, /createHmac|"cookie"/i, "不得按 cookie 形状或自建签名判定");
  assert.doesNotMatch(CODE, /req\.headers\[["']cookie["']\]/, "不得读 cookie 值");
});

test("g-507 S4：业务路由集合来自**真实注册快照**，且与命名空间/kind 约束一致", () => {
  // g-507 返工：此前用源码里 `\n    {\n` 计数 ⇒ 对「单行追加一条路由」静默失聪（实测仍报 63）。
  // 现改为读取插件在**真实注册前**生成的快照（仅 path + kind），结构约束直接作用在真实集合上。
  bootPlugin();
  const registered = getRegisteredRoutes();
  assert.ok(registered, "必须能从真实注册获得路由快照");
  assert.equal(registered!.length, 63, `真实业务路由必须恰为 63 条（实得 ${registered!.length}）`);
  const prefixes = registered!.filter((r) => r.kind === "prefix").map((r) => r.path).sort();
  assert.deepEqual(prefixes, [DESIGN_DIAGRAM_ROUTE, HELP_ASSET_ROUTE].sort(), "只有两条有意 prefix（图 / 帮助资产）");
  assert.equal(DESIGN_DIAGRAM_ROUTE, `${API_NAMESPACE}/diagram`);
  assert.equal(HELP_ASSET_ROUTE, `${API_NAMESPACE}/help/asset`);
  assert.equal(HELP_CATALOG_ROUTE, `${API_NAMESPACE}/help/catalog`);
  assert.equal(new Set(registered!.map((r) => r.path)).size, registered!.length, "真实路由无重复");
  for (const r of registered!) {
    assert.equal(r.path === API_NAMESPACE || r.path.startsWith(`${API_NAMESPACE}/`), true, `${r.path} 必须在命名空间内`);
  }
  // 命名空间校验在**定义层**同样 fail-closed：越界 path 直接抛错（不会注册）
  assert.throws(
    () => buildRouteTable([{ path: "/api/other-endpoint", handler: () => {} }]),
    /非法路由定义|命名空间/,
    "越界 path 必须判错（fail-closed，不得裸挂命名空间之外）",
  );
  assert.throws(
    () => buildRouteTable([
      { path: `${API_NAMESPACE}/dup`, kind: "exact", handler: () => {} },
      { path: `${API_NAMESPACE}/dup`, kind: "exact", handler: () => {} },
    ]),
    /重复路由/,
    "重复 path 必须判错",
  );
});

test("g-507 S4b：往返对账 —— 单行新增一条路由 / 删掉一条受测路由都必须判红", async () => {
  // 对被洗白的两类变化做**真实判红**证明（不是靠源码文本计数）：
  // ① 单行新增（源码里就是一行 `{ path: "…", handler: … }`）⇒ 快照 64 条 ⇒ 对账断言失败；
  // ② 删掉一条受测业务路由 ⇒ 该端点 lookupRoute 未命中 ⇒ 逐端点断言失败。
  bootPlugin();
  const baseline = getRegisteredRoutes()!;
  const withExtra = [...baseline, { path: `${API_NAMESPACE}/__extra_probe__`, kind: "exact" }];
  assert.equal(withExtra.length, 64);
  assert.throws(
    () => assertSameRouteSet(withExtra, baseline),
    /路由集合漂移/,
    "单行新增一条路由必须被判红（测试全集 ↔ 实现全集双向对账）",
  );
  const removed = baseline.filter((r) => r.path !== "/api/dsh-graph/accept");
  const table = buildRouteTable(removed.map((r) => ({ path: r.path, kind: r.kind, handler: () => {} })));
  assert.throws(
    () => assertEndpointsDefined(table, ["/api/dsh-graph/accept"], lookupRoute),
    /不可达/,
    "删掉一条受测业务路由必须被判红（逐端点可达性断言）",
  );
});

test("g-507 S5：全部旧业务套件都经唯一门禁入口驱动（逐文件判定 + 不得按 path 取 handler）", () => {
  // 只允许经 _http-auth-harness 的入口适配器取 handler；禁止任何测试按 path 取业务 handler。
  const dir = join(process.cwd(), "core/tests");
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts"));
  assert.ok(files.length > 150, `应枚举到全部测试文件（实得 ${files.length}）`);
  const offenders: string[] = [];
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    const code = src.split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
    if (/routes\.get\(|registeredRoutes\.get\(|routes\.find\(|routeDefs\.find\(/.test(code)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `以下测试仍按 path 取业务 handler（等于绕过门禁）：${offenders.join(", ")}`);

  // 「哪些套件真的驱动了插件 HTTP 入口」不靠人工推断：由**变异反向审计**实测得出 ——
  // 在私有副本里把唯一入口改成「一律 401」，凡驱动过入口的套件必红；仍全绿的即「不驱动入口」。
  // 该审计结果登记在 core/tests/fixtures/g507-entry-driving-audit.json（由 4 号证据脚本产出）。
  const audit = JSON.parse(readFileSync(join(dir, "fixtures", "g507-entry-driving-audit.json"), "utf8"));
  assert.equal(audit.mutation, "entry returns 401 for every request", "审计口径必须是「入口一律 401」变异");
  const driving = new Set<string>(audit.driving);
  // 审计里「因非鉴权原因失败」的套件（副本环境差异）单独登记：它们**不计入**驱动入口，
  // 但必须显式列出，不能被默默漏掉（下面 ② 要求三类合计覆盖全集）。
  const nonDriving = new Set<string>([...audit.nonDriving, ...(audit.skippedLoadFailures ?? [])]);
  // 下限只做「清单没有整体塌陷」的护栏（实测稳定值 ~56，两次连续审计完全一致）；真正判据是下面两条逐文件断言。
  assert.ok(driving.size > 30, `驱动入口的套件数量异常偏低（实得 ${driving.size}），审计可能失效`);
  // ① 每个「驱动入口」的套件都必须经共享入口适配器（否则它调用插件入口的方式不统一）；
  //    审计的归因是**启发式**（失败文本与鉴权相关），因此这里用**源码事实**复核：
  //    若某文件被判「驱动入口」却没有入口适配器，则它必须在源码里既不装配插件、也不发 HTTP 请求
  //    （=审计的启发式误判），否则就是「真的驱动了入口却绕过了适配器」⇒ 判红。
  const suspicious: string[] = [];
  for (const f of driving) {
    if (NEGATIVE_CONTROL_FILES.has(f)) continue; // 变异对照文件在私有副本里驱动变异代码，另行登记
    const src = readFileSync(join(dir, f), "utf8");
    const code = src.split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
    if (/_http-auth-harness\.ts/.test(code)) continue; // 已走共享适配器
    const bootsPlugin = /\bapplyHost\(|\bapply\(/.test(code) && !/\bmod\.apply\(/.test(code);
    const callsEndpoints = /\/api\/dsh-graph/.test(code);
    if (bootsPlugin && callsEndpoints) suspicious.push(f);
  }
  assert.deepEqual(suspicious, [], `以下套件真的驱动了插件 HTTP 入口却未经共享入口适配器：${suspicious.join(", ")}`);

  // ② 审计必须覆盖全部套件（驱动 + 不驱动 = 全集），否则「不驱动」列表可能漏项
  const all = new Set(files);
  const uncovered = [...all].filter((f) => !driving.has(f) && !nonDriving.has(f));
  assert.deepEqual(uncovered, [], `以下套件未被审计覆盖（需重跑审计脚本）：${uncovered.join(", ")}`);
  const phantom = [...driving, ...nonDriving].filter((f) => !all.has(f));
  assert.deepEqual(phantom, [], `审计里出现了不存在的套件（清单已漂移）：${phantom.join(", ")}`);
});

