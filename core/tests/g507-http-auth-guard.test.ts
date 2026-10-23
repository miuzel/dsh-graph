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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { API_NAMESPACE, DESIGN_DIAGRAM_ROUTE, HELP_ASSET_ROUTE, HELP_CATALOG_ROUTE } from "../../dist/index.js";

const HOST_SRC = readFileSync(join(process.cwd(), "dsh-graph-host/index.js"), "utf8");
/** 去掉行注释与块注释后的可执行代码面（守卫只看真实代码，不被注释里的示例误导）。 */
const CODE = HOST_SRC.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");

test("g-507 S1：webServer.register 只有一处，且是唯一的 prefix 命名空间入口", () => {
  const calls = [...CODE.matchAll(/webServer\.register\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.equal(calls.length, 1, `生产代码只允许一次 webServer.register（实际 ${calls.length} 次：${calls.join(" | ")}）`);
  const arg = calls[0];
  assert.equal(arg, "{ kind: \"prefix\", path: API_NAMESPACE, handler: dispatchRequest }", "唯一入口必须是显式 prefix + 命名空间根 + dispatchRequest");
  // 计数器：`for (const r of httpRoutes()) webServer.register(r)` 这类逐条裸注册必须绝迹
  assert.doesNotMatch(CODE, /for\s*\([^)]*\)\s*disposers\.push\(webServer\.register/, "不得逐条注册业务定义");
  assert.doesNotMatch(CODE, /httpRoutes\(\)\s*\.\s*forEach\([^)]*register/, "不得逐条注册业务定义");
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

test("g-507 S4：业务定义全部在命名空间内，且基线 63 条（61 exact + 2 prefix）可枚举", () => {
  const start = CODE.indexOf("const httpRoutes = () => [");
  const end = CODE.indexOf("\n  ];\n", start);
  assert.ok(start > 0 && end > start, "存在业务定义数组");
  const defs = CODE.slice(start, end);
  const entries = [...defs.matchAll(/\n    \{\n/g)].length;
  assert.equal(entries, 63, `业务定义应为基线 63 条（实得 ${entries}）`);
  const prefixes = [...defs.matchAll(/kind: "prefix",\s*\n\s*path: ([A-Z_]+|"[^"]+")/g)].map((m) => m[1]);
  assert.deepEqual(prefixes, ["DESIGN_DIAGRAM_ROUTE", "HELP_ASSET_ROUTE"], "只有两条有意 prefix（图 / 帮助资产）");
  assert.equal(DESIGN_DIAGRAM_ROUTE, `${API_NAMESPACE}/diagram`);
  assert.equal(HELP_ASSET_ROUTE, `${API_NAMESPACE}/help/asset`);
  assert.equal(HELP_CATALOG_ROUTE, `${API_NAMESPACE}/help/catalog`);
  // 命名空间校验：越界 path 会抛错（fail-closed，不注册）
  assert.match(CODE, /def\.path === API_NAMESPACE \|\| def\.path\.startsWith\(API_NAMESPACE \+ "\/"\)/, "命名空间校验含根路径与子路径");
});

test("g-507 S5：旧业务套件不得再绕过门禁直调 handler（无 routes.get(path)(req,res) 形态）", () => {
  // 只允许经 _http-auth-harness 的入口适配器取 handler；禁止在任何测试里按 path 取业务 handler。
  const files = [
    "client.test.ts", "root.test.ts", "g212-adversarial.test.ts", "g374-results-tools.test.ts",
    "g481-help-modal.test.ts", "g489-help-content.test.ts", "version-lane-rest.test.ts",
  ];
  for (const f of files) {
    const src = readFileSync(join(process.cwd(), "core/tests", f), "utf8");
    const code = src.split("\n").map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
    assert.doesNotMatch(code, /routes\.get\(|registeredRoutes\.get\(|routes\.find\(/, `${f}：不得按 path 取业务 handler`);
    assert.match(code, /_http-auth-harness\.ts/, `${f}：必须经共享入口适配器驱动业务`);
  }
});
