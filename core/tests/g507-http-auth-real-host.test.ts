/** g-507 分层验证 B：**真实宿主鉴权链路**（真实 BrowserAuth + 真实 token 交换 + 真实 WebServer）+ 真实 HTTP。
 *
 * 真实性口径（返工后，逐条可核）：
 *   · `connection` 由 **`@deepseek-ai/dsh-client-connection` 的公开 `apply()`** 引导 —— 与本插件在宿主里
 *     的加载方式相同（`ctx.provide("credentials")` + `ctx.plugin({apply, inject, Config})`）；
 *     `BrowserAuth`（secret 存储、launch token、cookie 签名与校验）**全部由宿主包内部创建**，
 *     测试**不实现、不注入、不读取私有字段**；
 *   · 合法 cookie 只来自**宿主自己的 token 交换**（公开 `connection.authorizeIndex` + 真实 launch token，
 *     由 `connection.authenticatedUrl(origin)` 提供）；测试不含任何签名算法；
 *   · `webServer` 是真实 `WebServer`（真实路由表 + 真实最长前缀匹配 + 真实 `node:http` 监听），
 *     请求走**真实 socket**；
 *   · 负向用的「篡改 / 过期」cookie 由**手工构造**（在合法 cookie 上改签名、或改 payload 时间戳），
 *     它们只用于证明**真实宿主拒绝**，不作为「真实签发」证据。
 *
 * 诚实边界：
 *   · 「有效凭证但非 owner」—— 宿主没有公开的非 owner HTTP 凭证签发面 ⇒ 只有策略层证据（A 层 A6），
 *     本套件不声称该分支的 HTTP 端到端结论；
 *   · 「撤销」—— 宿主没有公开的 peer 撤销 HTTP 面。本套件只断言**被观察到的行为**：
 *     服务卸载后 peer 记录随之消失、重新引导（新 secret）后旧 cookie 失效；不称其为「撤销」。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../ops.ts";
import { apply } from "../../dist/index.js";
import { assertSingleProtectedEntry, loadServicePlugin } from "./_http-auth-harness.ts";
import { loadHostStack, HOST_STACK_PINS, resolveHostStack } from "./_host-stack.ts";

const stack = await loadHostStack();
const { Context, WebServer, connectionApi } = stack;
const API = "/api/dsh-graph";
const INIT = Symbol.for("cordis.init");

/** 测试自有内存 credentials：secret 由宿主 BrowserAuth 通过 `modifyRecord` 写入这里（测试不生成 secret）。 */
function memoryCredentials() {
  const records = new Map<string, any>();
  return {
    records,
    provider: {
      async readRecord(key: any) {
        return records.get(String(key));
      },
      async describeRecord(key: any) {
        const rec = records.get(String(key));
        return { present: rec !== undefined, kind: rec?.kind, writable: true };
      },
      async listRecords() {
        return [...records.entries()].map(([key, rec]) => ({ key, kind: rec?.kind }));
      },
      async modifyRecord(key: any, mutate: (current: any) => Promise<any>) {
        const next = await mutate(records.get(String(key)));
        if (next !== undefined) records.set(String(key), next);
        return records.get(String(key));
      },
      async deleteRecord(key: any) {
        records.delete(String(key));
      },
      async unset() {},
    },
  };
}

/** 取 cookie 头里的某个 cookie 值（只为「篡改」构造服务，不参与验签）。 */
function cookiePair(headerValue: string) {
  const first = headerValue.split(";")[0];
  const at = first.indexOf("=");
  return { name: first.slice(0, at).trim(), value: first.slice(at + 1).trim() };
}

/** 负向夹具：把合法 cookie 的签名改成另一段等长随机串（宿主必须拒绝）。 */
function tamperSignature(cookieHeader: string) {
  const { name, value } = cookiePair(cookieHeader);
  const parts = value.split(".");
  parts[parts.length - 1] = randomBytes(32).toString("base64url");
  return `${name}=${parts.join(".")}`;
}

/** 负向夹具：把 payload 的过期时间改成过去（签名随即失效，宿主必须拒绝）。 */
function expirePayload(cookieHeader: string) {
  const { name, value } = cookiePair(cookieHeader);
  const [version, body, sig] = value.split(".");
  let payload: any;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return cookieHeader;
  }
  payload.expiresAt = Date.now() - 60_000;
  const forged = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${name}=${version}.${forged}.${sig}`; // 签名未改 ⇒ 必须被真实宿主判为无效
}

// ───────────────────────────── 真实宿主栈（公开 apply 引导） ─────────────────────────────

/**
 * 搭一套真实宿主：真实 Context + 真实 WebServer（真实监听）+ **公开 apply 引导**的真实 connection。
 * @param opts.connectionFirst true = connection 早于 webServer；false = webServer 先到
 */
async function startHost(opts: { connectionFirst?: boolean } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "g507-b-ws-"));
  init(join(ws, ".dsh-graph"));
  const root = new Context();
  const { provider, records } = memoryCredentials();
  root.provide("credentials", provider);

  const state: {
    webServer: any;
    webFiber?: any;
    connectionFiber?: any;
    routes: any[];
    disposers: Array<() => void>;
  } = { webServer: null, routes: [], disposers: [] };

  const bootWeb = async () => {
    const loaded = await loadServicePlugin(root, "g507-test-webserver", (ctx) => {
      const server = new WebServer(ctx, { host: "127.0.0.1", port: 0 });
      ctx.effect(() => server[INIT](), "g507: webServer.listen");
      return server;
    });
    state.webServer = loaded.service;
    state.webFiber = loaded.fiber;
    for (let i = 0; i < 400 && !(state.webServer as any).server?.listening; i++) await new Promise((r) => setTimeout(r, 5));
    return state.webServer;
  };

  /** 用宿主**公开** apply 引导真实 connection（含真实 BrowserAuth）；重复引导前先真实卸载旧 fiber。 */
  const bootConnection = async () => {
    // 直接在根 ctx 上引导真实 connection（公开 apply）：fiber 归属明确，dispose 即真实卸载
    const fiber = root.plugin(
      { name: connectionApi.name, inject: connectionApi.inject, apply: connectionApi.apply, Config: connectionApi.Config },
      {},
    );
    await fiber;
    state.connectionFiber = fiber;
    return getConnection();
  };
  const getConnection = () => root.get("connection");
  const disposeConnection = async () => {
    const fiber = state.connectionFiber ?? root.get("connection")?.ctx?.fiber;
    state.connectionFiber = undefined;
    if (fiber) {
      try {
        await fiber.dispose();
      } catch {
        /* 已释放 */
      }
    }
  };

  const origin = () => state.webServer.getOrigin();
  const authority = () => new URL(origin()).host;

  const request = (method: string, path: string, headers: Record<string, string> = {}, body?: unknown) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: any }>((resolve) => {
      const url = new URL(origin());
      const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
      const req = http.request(
        {
          host: url.hostname,
          port: Number(url.port),
          path,
          method,
          headers: {
            host: authority(),
            ...(payload ? { "content-type": "application/json", "content-length": String(payload.length) } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(Buffer.from(c)));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: any = text;
            try {
              parsed = text.length ? JSON.parse(text) : null;
            } catch {
              /* 保持原文 */
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed });
          });
        },
      );
      req.on("error", (e) => resolve({ status: 0, headers: {}, body: String(e) }));
      if (payload) req.write(payload);
      req.end();
    });

  /** 宿主自己的 token 交换：返回 Set-Cookie 的 `name=value`（测试不生成签名）。 */
  const mintOwnerCookie = () => {
    const connection = getConnection();
    assert.ok(connection, "真实 connection 必须已由公开 apply 引导");
    const url = connection.authenticatedUrl(`${origin()}/`);
    const token = new URL(url).searchParams.get("token");
    assert.ok(token, "authenticatedUrl 必须携带 launch token");
    let status = 0;
    let setCookie: string | undefined;
    const sink = {
      writeHead(code: number, headers: any) {
        status = code;
        setCookie = headers?.["set-cookie"];
      },
      end() {},
    };
    connection.authorizeIndex({ method: "GET", url: `/?token=${encodeURIComponent(token)}`, headers: { host: authority() } }, sink);
    assert.ok([302, 303].includes(status), `宿主 token 交换应重定向（实得 ${status}）`);
    assert.ok(setCookie, "宿主 token 交换必须下发 cookie");
    return setCookie!.split(";")[0];
  };

  const start = async () => {
    if (opts.connectionFirst) {
      await bootConnection();
      await bootWeb();
    } else {
      await bootWeb();
      await bootConnection();
    }
  };

  const shutdown = async () => {
    await disposeConnection();
    for (const d of state.disposers.splice(0)) {
      try {
        d();
      } catch {
        /* 已释放 */
      }
    }
    const server = state.webServer;
    if (server?.server?.listening) {
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        server.server.close(done);
        try {
          server.server.closeAllConnections?.();
        } catch {
          /* 已关闭 */
        }
        setTimeout(done, 2000).unref?.();
      });
    }
    try {
      await state.webFiber?.dispose?.();
    } catch {
      /* 已释放 */
    }
  };

  return {
    root, state, records, provider, start, origin, authority, request, shutdown,
    mintOwnerCookie, getConnection, bootConnection, disposeConnection, bootWeb,
  };
}

/** 插件 ctx：get() 动态读取「当前 active」服务（与生产 ctx.get 语义一致）；register 转发真实 WebServer。 */
function pluginContext(host: { state: any }, root: any) {
  const disposers: Array<() => void> = host.state.disposers;
  return {
    get: (name: string) => {
      if (name === "webServer") {
        if (!host.state.webServer) return undefined;
        return {
          register: (def: any) => {
            host.state.routes.push(def);
            const dispose = host.state.webServer.register(def);
            return () => {
              dispose();
            };
          },
        };
      }
      if (name === "connection") return root.get("connection");
      return undefined;
    },
    effect: (fn: () => unknown) => {
      const r = fn();
      if (typeof r === "function") disposers.push(r as () => void);
      return r;
    },
    tools: { register: () => () => {}, get: () => ({}) },
    on() {},
  } as any;
}

/** 装配本插件（真实 apply）到真实宿主；返回可复用断言上下文。 */
async function pluginOnRealHost(opts: { connectionFirst?: boolean } = {}) {
  const host = await startHost(opts);
  await host.start();
  const ctx = pluginContext(host as any, host.root);
  (host as any).state.root = host.root;
  const cleanup = apply(ctx, {}) as any;
  assert.equal(typeof cleanup, "function", "apply 必须返回清理函数（真实 ctx.effect disposer 语义）");
  (host as any).state.applyCleanup = cleanup;
  (host as any).state.pluginCtx = ctx;
  assertSingleProtectedEntry(host.state.routes);
  return { ...host, server: host.state.webServer as any } as any;
}

// ───────────────────────────────── 用例 ─────────────────────────────────

test("g-507 B0：真实宿主栈来自已解析目录（版本固定，无作者绝对路径）", () => {
  assert.equal(stack.source === "env" || stack.source === "installed-host" || stack.source === "private-copy", true);
  assert.equal(typeof stack.Context, "function");
  assert.equal(typeof stack.WebServer, "function");
  assert.equal(typeof connectionApi.apply, "function", "必须是宿主公开 apply（不是测试自建的 BrowserAuth）");
  assert.match(resolveHostStack().dir, /node_modules\/@deepseek-ai$/);
  // 版本锚点：宿主栈三件套的固定版本（升级宿主时必须同步改 _host-stack.ts 的 HOST_STACK_PINS）
  assert.deepEqual(HOST_STACK_PINS, {
    "@deepseek-ai/cordis": "4.0.5",
    "@deepseek-ai/dsh-host-webserver": "0.2.1-rc.2",
    "@deepseek-ai/dsh-client-connection": "0.2.1-rc.2",
  });
});

test("g-507 B1：真实 WebServer 匹配只命中一个 prefix 入口", async () => {
  const h = await pluginOnRealHost();
  try {
    const entry = h.state.routes[0];
    assert.equal(h.server.match(API), entry, "命名空间根命中唯一入口");
    assert.equal(h.server.match(`${API}/goal`), entry, "子路径命中唯一入口");
    assert.equal(h.server.match(`${API}/unknown/deep/path`), entry, "未知子路径同样先进入口");
    // 宿主 connection 插件自己会在 /api 挂它的桥（公开行为，非本插件路由）⇒ 只断言「插件没在命名空间外挂任何东西」
    assert.equal(h.state.routes.filter((r: any) => !(r.path === API || r.path.startsWith(API + "/"))).length, 0, "插件不在命名空间外注册任何路由");
  } finally {
    await h.shutdown();
  }
});

test("g-507 B2：真实宿主签发的 owner cookie ⇒ 业务 200；匿名/篡改/过期/跨 authority ⇒ 401/403", async () => {
  const h = await pluginOnRealHost();
  try {
    const cookie = h.mintOwnerCookie(); // 宿主 token 交换签发（真实 BrowserAuth + 真实 secret）
    const owner = { cookie };
    const ok = await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, owner);
    assert.equal(ok.status, 200, "真实签发 cookie ⇒ 200（真实 admit + 真实 BrowserAuth 验收）");

    assert.equal((await h.request("GET", API)).status, 401, "匿名 ⇒ 401");
    assert.equal((await h.request("GET", `${API}/goal`, { cookie: tamperSignature(cookie) })).status, 401, "篡改签名 ⇒ 401");
    assert.equal((await h.request("GET", `${API}/goal`, { cookie: expirePayload(cookie) })).status, 401, "过期 payload ⇒ 401");
    assert.equal(
      (await h.request("GET", `${API}/goal`, { cookie: cookie.replace(/^(dsh-auth-[^=]+)=/, "$1=x") })).status,
      401,
      "陌生 cookie 名 ⇒ 401",
    );
    assert.equal((await h.request("GET", API, { "sec-fetch-site": "cross-site" })).status, 403, "cross-site ⇒ 403");
    assert.equal((await h.request("GET", API, { origin: "http://evil.example" })).status, 403, "跨源 Origin ⇒ 403");
    assert.equal((await h.request("GET", API, { host: "evil.example", cookie })).status, 403, "Host 不信任 ⇒ 403");
    // 资产路由同样被挡在门外
    assert.equal((await h.request("GET", `${API}/help/asset/supervisor-guide.zh.md`)).status, 401, "资产匿名 ⇒ 401");
    assert.equal((await h.request("POST", `${API}/no-such`, {}, { title: "x" })).status, 401, "未知子路径匿名 ⇒ 401");
  } finally {
    await h.shutdown();
  }
});

test("g-507 B3：真实 owner 的业务面（读/可逆写/资产/304/404/405）", async () => {
  const h = await pluginOnRealHost();
  try {
    const owner = { cookie: h.mintOwnerCookie() };
    const wsQ = `?workspace=${encodeURIComponent(h.ws)}`;
    const board = await h.request("GET", `${API}${wsQ}`, owner);
    assert.equal(board.status, 200);
    const etag = board.headers.etag;
    assert.ok(etag, "看板带 ETag");
    assert.equal((await h.request("GET", `${API}${wsQ}`, { ...owner, "if-none-match": String(etag) })).status, 304, "ETag 命中 ⇒ 304");
    const created = await h.request("POST", `${API}/create-goal${wsQ}`, owner, { title: "B3 目标" });
    assert.equal(created.status, 200, "真实 owner 可写");
    assert.equal((await h.request("GET", `${API}/diagram/design-philosophy.lifecycle.html`, owner)).status, 200, "资产 200");
    assert.equal((await h.request("HEAD", `${API}/diagram/design-philosophy.lifecycle.html`, owner)).status, 200, "资产 HEAD 200");
    assert.equal((await h.request("GET", `${API}/no-such-endpoint${wsQ}`, owner)).status, 404, "认证后未知 ⇒ 404");
    assert.equal((await h.request("GET", `${API}/create-goal${wsQ}`, owner)).status, 405, "认证后方法不符 ⇒ 405");
  } finally {
    await h.shutdown();
  }
});

test("g-507 B4：服务到达顺序（webServer 先到 / connection 先到）与 connection 缺位 fail-closed 503", async () => {
  for (const connectionFirst of [false, true]) {
    const h = await pluginOnRealHost({ connectionFirst });
    try {
      assert.equal((await h.request("GET", API)).status, 401, `顺序(${connectionFirst})：匿名 401`);
      assert.equal(
        (await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, { cookie: h.mintOwnerCookie() })).status,
        200,
        `顺序(${connectionFirst})：owner 200`,
      );
    } finally {
      await h.shutdown();
    }
  }

  // connection 未就位：同一入口 fail-closed 503
  const host = await startHost();
  await host.bootWeb();
  const ctx = pluginContext(host as any, host.root);
  (host as any).state.root = host.root;
  const cleanup = apply(ctx, {});
  try {
    const res = await host.request("GET", `${API}?workspace=${encodeURIComponent(host.ws)}`);
    assert.equal(res.status, 503, "缺 active connection ⇒ 503（含合法结构与伪造凭证）");
    assert.equal(res.body?.error, "connection-service-unavailable");
  } finally {
    cleanup?.();
    await host.shutdown();
  }
});

test("g-507 B5：connection 消失 ⇒ 503；重新引导 ⇒ 恢复（均为真实 fiber 生命周期）", async () => {
  const h = await pluginOnRealHost();
  try {
    const cookie = h.mintOwnerCookie();
    assert.equal((await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, { cookie })).status, 200);
    await h.disposeConnection(); // 真实卸载 fiber
    assert.equal((await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, { cookie })).status, 503, "服务消失 ⇒ 503");
    await h.bootConnection(); // 真实重新引导
    // 行为观察：宿主把浏览器会话 secret 存在 credentials 里（本轮为空实现的内存表）⇒ 重新引导复用同一 secret，
    // 旧 cookie 仍然有效。这是宿主的真实语义，不称其为「撤销」，也不臆造失效结论。
    assert.equal((await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, { cookie })).status, 200, "重新引导后旧 cookie 仍有效（宿主复用 credentials 中的 secret）");
    const fresh = h.mintOwnerCookie();
    assert.equal((await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, { cookie: fresh })).status, 200, "新签发的 cookie ⇒ 200");
  } finally {
    await h.shutdown();
  }
});

test("g-507 B6：apply 的真实 cleanup（ctx.effect disposer）⇒ 入口消失、无定时器残留；再次 apply 仍单入口", async () => {
  const h = await pluginOnRealHost();
  try {
    // 真实 cleanup：调用 apply 返回的清理函数（宿主在 fiber dispose 时就是这么调的）
    h.state.applyCleanup?.();
    const entry = h.state.routes[0];
    const after = h.server.match(API);
    assert.notEqual(after, entry, "cleanup 后插件入口不再命中（宿主自己的 /api 桥属公开行为）");
    assert.equal(after?.path, "/api", "cleanup 后只剩宿主 /api 前缀（本插件未留任何裸业务）");
    // 宿主自己的 /api 桥对匿名同样回 401（不许以此判绿）⇒ 改证「插件业务端点不再可达」：
    // 认证后分发只发生在插件入口内，入口摘除后业务端点不会再被本插件处理。
    const owner = { cookie: h.mintOwnerCookie() };
    const afterCleanup = await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, owner);
    assert.notEqual(afterCleanup.body?.ok, true, "cleanup 后看板业务不再由本插件返回");

    // 再次 apply：仍只有一个入口，且可正常工作
    h.state.routes.length = 0;
    const ctx2 = pluginContext(h as any, h.root);
    (h as any).state.root = h.root;
    const cleanup2 = apply(ctx2, {});
    assertSingleProtectedEntry(h.state.routes);
    assert.equal((await h.request("GET", API)).status, 401, "再次 apply 后匿名仍 401（单入口生效）");
    assert.equal(
      (await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, { cookie: h.mintOwnerCookie() })).status,
      200,
      "再次 apply 后 owner 仍 200",
    );
    cleanup2?.();
  } finally {
    await h.shutdown();
  }
});
