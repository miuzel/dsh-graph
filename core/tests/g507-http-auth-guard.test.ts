/** g-507 结构守卫：**生产注册路径不可能留下裸业务路由** + 基线 65 条清单不漂移。
 *
 * A 层用「真实注册入口」证明行为；本套件用**源码结构**证明「未来新增路由也不会绕开门禁」：
 *   · webServer 上只允许一次 `register(...)`，且其参数必须是唯一的 prefix 命名空间入口（dispatchRequest）；
 *   · 取消 provider 的一条路由定义都在命名空间内（越界 ⇒ `buildRouteTable` 抛错 ⇒ 不注册）；
 *   · 业务 handler 只能出现在 `httpRoutes()` 定义数组里，入口之外没有第二条 `webServer.register` 通路；
 *   · 基线 65 条（63 exact + 2 prefix）在**实现里**可被枚举，且与 A 层清单逐条一致。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { API_NAMESPACE, DESIGN_DIAGRAM_ROUTE, HELP_ASSET_ROUTE, HELP_CATALOG_ROUTE, buildRouteTable, lookupRoute, getRegisteredRoutes } from "../../dist/index.js";
import { existsSync } from "node:fs";
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
  // g-507 返工：此前用源码里 `\n    {\n` 计数 ⇒ 对「单行追加一条路由」静默失聪（实测仍报 65）。
  // 现改为读取插件在**真实注册前**生成的快照（仅 path + kind），结构约束直接作用在真实集合上。
  bootPlugin();
  const registered = getRegisteredRoutes();
  assert.ok(registered, "必须能从真实注册获得路由快照");
  assert.equal(registered!.length, 65, `真实业务路由必须恰为 65 条（实得 ${registered!.length}）`);
  const prefixes = registered!.filter((r) => r.kind === "prefix").map((r) => r.path).sort();
  assert.deepEqual(prefixes, [DESIGN_DIAGRAM_ROUTE, HELP_ASSET_ROUTE].sort(), "只有两条有意 prefix（图 / 帮助资产）");
  assert.equal(DESIGN_DIAGRAM_ROUTE, `${API_NAMESPACE}/diagram`);
  assert.equal(HELP_ASSET_ROUTE, `${API_NAMESPACE}/help/asset`);
  assert.equal(HELP_CATALOG_ROUTE, `${API_NAMESPACE}/help/catalog`);
  assert.equal(new Set(registered!.map((r) => r.path)).size, registered!.length, "真实路由无重复");
  for (const r of registered!) {
    assert.equal(r.path === API_NAMESPACE || r.path.startsWith(`${API_NAMESPACE}/`), true, `${r.path} 必须在命名空间内`);
  }
  // 命名空间校验在**定义层**同样 fail-closed：越界 path 直接抛错（不会注册）。
  // g-561：三类路由定义 Error 都必须用**中性功能描述**，不得含历史目标编号。
  assert.throws(
    () => buildRouteTable([{ path: "/api/other-endpoint", handler: () => {} }]),
    (err: any) => {
      assert.match(err.message, /非法路由定义|命名空间/, "越界 path 必须判错（fail-closed，不得裸挂命名空间之外）");
      assert.doesNotMatch(err.message, /\bg-\d+\b/, "路由定义 Error 不得包含目标编号");
      return true;
    },
  );
  assert.throws(
    () => buildRouteTable([{ path: `${API_NAMESPACE}/no-handler` }]),
    (err: any) => {
      assert.match(err.message, /缺少 handler/, "缺 handler 必须判错");
      assert.doesNotMatch(err.message, /\bg-\d+\b/, "缺 handler Error 不得包含目标编号");
      return true;
    },
  );
  assert.throws(
    () => buildRouteTable([
      { path: `${API_NAMESPACE}/dup`, kind: "exact", handler: () => {} },
      { path: `${API_NAMESPACE}/dup`, kind: "exact", handler: () => {} },
    ]),
    (err: any) => {
      assert.match(err.message, /重复路由/, "重复 path 必须判错");
      assert.doesNotMatch(err.message, /\bg-\d+\b/, "重复路由 Error 不得包含目标编号");
      return true;
    },
  );
});

test("g-507 S4b：往返对账 —— 单行新增一条路由 / 删掉一条受测路由都必须判红", async () => {
  // 对被洗白的两类变化做**真实判红**证明（不是靠源码文本计数）：
  // ① 单行新增（源码里就是一行 `{ path: "…", handler: … }`）⇒ 快照 66 条 ⇒ 对账断言失败；
  // ② 删掉一条受测业务路由 ⇒ 该端点 lookupRoute 未命中 ⇒ 逐端点断言失败。
  bootPlugin();
  const baseline = getRegisteredRoutes()!;
  const withExtra = [...baseline, { path: `${API_NAMESPACE}/__extra_probe__`, kind: "exact" }];
  assert.equal(withExtra.length, 66);
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

/**
 * g-507 静态消费清单：**曾经直连业务 handler 的旧套件**（g-507 迁移对象），逐条列明。
 *
 * 与上一轮的启发式审计（变异后按失败文本猜测"是否驱动入口"，把判定不了的记成 unknown）不同，
 * 这份清单是**确定的事实**：每一行都是 g-507 之前通过 `routes.get(path)` 直接拿到 handler 的套件
 * （逐文件用 `git show cc6b0f8:<file>` 核对过），迁移后它们必须经入口适配器驱动并声明真实端点。
 * 新增一个「直连 handler」的套件不会被这份清单自动放行 —— 下面的 ① 会扫全集把它们抓出来。
 */
const MIGRATED_SUITES = [
  "cache.test.ts",
  "client.test.ts",
  "dispatch-execution-service.test.ts",
  "execution-admission-g237.test.ts",
  "g207-integration.test.ts",
  "g212-adversarial.test.ts",
  "g282-legacy-unbind.test.ts",
  "g311-review-policy.test.ts",
  "g321-dsh-016-compat.test.ts",
  "g333-subagent-prompt-override.test.ts",
  "g342-settings-review-policy.test.ts",
  "g374-results-tools.test.ts",
  "g374-summary-llm.test.ts",
  "g378-description-gate.test.ts",
  "g379-relations.test.ts",
  "g388-collect-orphan.test.ts",
  "g404-version-slug-guard.test.ts",
  "g405-empty-desc-fallback-i18n.test.ts",
  "g406-dispatch-isolation-verdict.test.ts",
  "g435-review-config.test.ts",
  "g436-review-wiring.test.ts",
  "g442-settings-review-conditions.test.ts",
  "g445-memory-single-source.test.ts",
  "g449-cross-board-clean-ownership.test.ts",
  "g450-flow-parent-write-guard.test.ts",
  "g462-board-design-modal.test.ts",
  "g481-help-modal.test.ts",
  "g505-keepalive.test.ts",
  "inject-cards.test.ts",
  "inject-handoffs.test.ts",
  "lazy-loading.test.ts",
  "model-metadata.test.ts",
  "root.test.ts",
  "unbind-child.test.ts",
  "version-lane-rest.test.ts",
];

test("g-507 S5：迁移清单上的旧套件全部经唯一门禁入口驱动（逐条静态+行为双证）", () => {
  const dir = join(process.cwd(), "core/tests");

  // ① 反向：全集里**任何**测试都不得按 path 取业务 handler（等价于绕过门禁）
  // 守卫文件自身含判据正则字面量，必须排除（否则它匹配到自己的模式）
  const SELF = "g507-http-auth-guard.test.ts";
  const NEG = new Set([SELF, "g507-auth-negative-controls.test.ts"]);
  const files = readdirSync(dir).filter((f) => f.endsWith(".test.ts") && !NEG.has(f));
  const offenders: string[] = [];
  for (const f of files) {
    const code = readFileSync(join(dir, f), "utf8").split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
    if (/routes\.get\(|registeredRoutes\.get\(|routes\.find\(|routeDefs\.find\(/.test(code)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], `以下测试仍按 path 取业务 handler（等于绕过门禁）：${offenders.join(", ")}`);

  // ② 正向：清单内每个套件都必须 (a) 文件存在 (b) 经共享入口适配器 (c) 引用真实端点 path
  const problems: string[] = [];
  for (const f of MIGRATED_SUITES) {
    const file = join(dir, f);
    if (!existsSync(file)) {
      problems.push(`${f}: 文件不存在（清单已过时）`);
      continue;
    }
    const src = readFileSync(file, "utf8");
    const code = src.split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
    if (!/_http-auth-harness\.ts/.test(code)) problems.push(`${f}: 未经共享入口适配器`);
    if (!/API_NAMESPACE|\/api\/dsh-graph/.test(code)) problems.push(`${f}: 未驱动任何 /api/dsh-graph 端点`);
    if (!/entryHandler|handlerFor|entry\(/.test(code)) problems.push(`${f}: 未调用入口适配器分发`);
  }
  assert.deepEqual(problems, [], `迁移清单未满足「经唯一入口」：${problems.join("; ")}`);

  // ③ 清单本身必须与「真实驱动入口的套件」一致：不允许把未迁移的套件悄悄算进来
  //    判据（静态、确定）：文件里出现 `/api/dsh-graph` 端点字面量即为「会驱动入口的套件」，
  //    这类文件若不在清单内，就必须自己也走入口适配器（否则是遗漏迁移 ⇒ 判红）。
  const drivesEntry = files.filter((f) => /\/api\/dsh-graph/.test(readFileSync(join(dir, f), "utf8")));
  const outsideList = drivesEntry.filter((f) => !MIGRATED_SUITES.includes(f));
  const unadapted = outsideList.filter((f) => {
    const code = readFileSync(join(dir, f), "utf8").split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
    // 客户端渲染/mock fetch 类文件不装配插件（`apply(` 来自其它模块）⇒ 不算驱动插件入口
    const bootsPluginEntry = /createRegisterStub\(/.test(code);
    return bootsPluginEntry && !/_http-auth-harness\.ts/.test(code);
  });
  assert.deepEqual(unadapted, [], `以下套件装配了插件入口却未经适配器：${unadapted.join(", ")}`);
  // g-507 自带的证据套件（不是"迁移对象"，但同样经入口驱动）：显式登记，避免被当成遗漏。
  const G507_EVIDENCE_SUITES = new Set([
    "g507-http-auth-surface.test.ts",
    "g507-http-auth-real-host.test.ts",
    "g251-brief-source-contract.test.ts",
    // g-506：关照 REST 门禁证据套件（同样经唯一入口驱动）。
    "g506-care.test.ts",
  ]);
  // 清单不得漏（有端点引用 + 装配入口 + 已适配）的套件
  const missingFromList = outsideList.filter(
    (f) => /_http-auth-harness\.ts/.test(readFileSync(join(dir, f), "utf8")) && !G507_EVIDENCE_SUITES.has(f),
  );
  assert.deepEqual(missingFromList, [], `以下套件已迁移但未登记进清单：${missingFromList.join(", ")}`);
});
