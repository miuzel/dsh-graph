// g-507 共用宿主桩：**经新注册入口**驱动 `/api/dsh-graph` 业务（既有业务回归用），并提供
// 「本插件一个受保护命名空间入口」的结构断言工具。
//
// 为什么需要它：g-507 起插件只向宿主 webServer 注册**一个** `kind:"prefix", path:"/api/dsh-graph"`
// 入口，**先**用宿主公开 `connection.admit(req)` + owner 判定鉴权，**后**才在插件内部按显式 exact
// 元数据与两条资产 prefix 分发业务 handler。既有业务套件此前直接 `routes.get(path)(req, res)` 调
// handler —— 那正是「绕过门禁直调业务」的形态，g-507 之后不再成立。
//
// 本 harness 的做法（**不是产品测试绕过开关**）：
//   1. 用真实 `webServer.register` 桩捕获注册（只应捕获到一个 prefix 入口）；
//   2. 调 `dispatch` 时把请求交给**被捕获的那个入口 handler**（= 生产同一段代码），
//      因此 `admit` 门禁与 owner 判定**照常执行**；
//   3. 鉴权通过所需的连接服务由本文件提供 `ownerConnectionStub()`（测试自有 owner 凭证夹具）——
//      真实宿主签名凭证的验证在 `g507-http-auth-real-host.test.ts` 里用真实
//      `HostConnectionService` + 测试内存 credentials 完成，两者互不替代。
//
// 安全性质：**不带 owner 凭证的请求不会被这些桩放行**（stub 对无凭证请求返回宿主同款
// `{ rejection: 401 }`），故业务套件不会掩盖「未认证也能读写」这类回归。
import assert from "node:assert/strict";

/** 生产入口命名空间（与 dsh-graph-host 的 API_NAMESPACE 逐字一致；结构断言会对照真实导出）。 */
export const NAMESPACE = "/api/dsh-graph";

/** 测试自有 owner 凭证夹具：请求带 `x-dsh-graph-test-owner: 1` 即被视作已认证 owner Peer。 */
export const OWNER_HEADER = "x-dsh-graph-test-owner";

/**
 * 构造一个**仅在测试中**使用的 connection 桩：形状对齐宿主公开 `admit(req)` 契约
 * （`{peer:{principal:{kind}}}` 或 `{rejection: 401|403}`），用于让业务套件经真实门禁调用业务。
 *
 * @param opts.owner 是否把带 owner 头的请求认作 owner（默认 true）
 * @param opts.rejection 强制返回的拒绝码（用于断言拒绝路径）
 */
export function ownerConnectionStub(opts: { owner?: boolean; rejection?: 401 | 403 } = {}) {
  const owner = opts.owner ?? true;
  return {
    admit(request: any) {
      if (opts.rejection) return { rejection: opts.rejection };
      const headers = request?.headers ?? {};
      if (headers[OWNER_HEADER] !== "1") return { rejection: 401 as const };
      if (!owner) return { peer: { principal: { kind: "remote" } } };
      return { peer: { id: "peer-test-owner", principal: { kind: "owner" } } };
    },
  };
}

/** 注册捕获桩：真实 `webServer.register` 语义（记录 kind/path/handler，返回 disposer）。 */
export function createRegisterStub() {
  const routes: any[] = [];
  const webServer = {
    register: (def: any) => {
      routes.push(def);
      return () => {
        const at = routes.indexOf(def);
        if (at >= 0) routes.splice(at, 1);
      };
    },
  };
  return { routes, webServer };
}

/** 结构断言：注册集合必须**恰好**是一个 `prefix` 入口，路径为命名空间根，handler 是函数。 */
export function assertSingleProtectedEntry(routes: any[], label = "插件") {
  assert.equal(routes.length, 1, `${label}只应向 webServer 注册一个入口（实际 ${routes.length} 条）`);
  const [only] = routes;
  assert.equal(only.kind, "prefix", "唯一入口必须是 prefix（覆盖整个命名空间，含未知子路径）");
  assert.equal(only.path, NAMESPACE, "唯一入口必须挂在命名空间根");
  assert.equal(typeof only.handler, "function", "唯一入口必须有 handler");
  return only;
}

/** 取唯一的命名空间入口 handler（未注册/多注册即判红）。 */
export function entryHandler(routes: any[]): (req: any, res: any) => unknown {
  return assertSingleProtectedEntry(routes).handler;
}

/**
 * 既有业务套件的「取 handler」兼容入口：g-507 之后业务 handler 不再单独可见，
 * 所有业务调用都必须经过**唯一门禁入口**（handler 内部先 admit + owner 判定，再按 url 分发）。
 * 业务套件因此保留原有 `handler(req, res)` 形状，但每次都真的走认证路径。
 */
export function handlerFor(routes: any[]): (req: any, res: any) => unknown {
  return entryHandler(routes);
}

/**
 * 认证后路径分发口径（与生产 `dispatchRequest` 逐条同规则；生产的结构守卫要求这里与实现同口径）：
 *   - exact 表逐字命中（尾斜杠不归一、不重定向：`/api/dsh-graph/` ≠ `/api/dsh-graph`）；
 *   - prefix 只按**段边界**匹配（`p === path || p.startsWith(path + "/")`），取最长；
 *   - query 不参与匹配。
 * 返回 `{ kind: "exact"|"prefix", base: string, pathname: string }`；未知返回 null。
 */
export function matchEndpoint(
  pathname: string,
  table: { exactPaths: readonly string[]; prefixPaths: readonly string[] },
): { kind: "exact" | "prefix"; base: string; pathname: string } | null {
  const exactSet = new Set(table.exactPaths);
  if (exactSet.has(pathname)) return { kind: "exact", base: pathname, pathname };
  let best: string | null = null;
  for (const p of table.prefixPaths) {
    if (pathname !== p && !pathname.startsWith(`${p}/`)) continue;
    if (best === null || p.length > best.length) best = p;
  }
  return best === null ? null : { kind: "prefix", base: best, pathname };
}

/** 取唯一的命名空间入口**定义**（kind/path/handler）；未注册或多注册即判红。 */
export function singleEntry(routes: any[]) {
  return assertSingleProtectedEntry(routes);
}
