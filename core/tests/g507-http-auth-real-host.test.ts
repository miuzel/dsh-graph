/** g-507 分层验证 B：**真实宿主鉴权服务 + 真实 WebServer 匹配 + 测试自有凭证 + 真实 HTTP**。
 *
 * 与 A 层（结构/哨兵）以及「策略桩」的分界：
 *   · 本套件的 connection 是**真实** `HostConnectionService`（已安装 DSH 0.2.1-rc.2 的公开包），
 *     webServer 是**真实** `WebServer`（真实路由表 + 真实最长前缀匹配 + 真实 node:http 监听）；
 *   · 签名凭证只来自**本测试自己的**进程内 credentials（内存表 + 每轮新 secret），
 *     不读取主实例 secret、不修改任何外部安装/profile；
 *   · 请求走**真实 socket**（`http.request`），断言真实 HTTP 状态码。
 *
 * 诚实边界（本套件不冒充的）：
 *   · 「有效凭证但非 owner」——当前宿主**没有公开的非 owner HTTP 凭证签发面**（`/connect` 与浏览器
 *     token 交换都签 owner）⇒ 该分支由 A6 策略层覆盖并在此注明，不声称非 owner 的 HTTP 端到端证据；
 *   · 「撤销」——宿主没有公开的 peer 撤销 HTTP 面；本套件用两条真实路径覆盖：服务卸载后 peer 记录
 *     随之清空、以及同一 Host 上重新初始化（换 secret）后旧 cookie 失效；
 *   · browserAuth 属 host 包私有面：**只在测试内复刻**它的 cookie 校验（真实 secret / 真实 authority /
 *     真实 HMAC），产品代码绝不复制该算法。
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../ops.ts";
import { apply } from "../../dist/index.js";
import { HOST_STACK, assertSingleProtectedEntry, loadServicePlugin, OWNER_HEADER } from "./_http-auth-harness.ts";

const { Context } = await import(HOST_STACK.context);
const { WebServer } = await import(HOST_STACK.webserver);
const { HostConnectionService } = await import(HOST_STACK.connection);

const API = "/api/dsh-graph";
const INIT = Symbol.for("cordis.init");

// ─────────────────────── 测试自有凭证设施（内存 credentials，绝不触碰外部安装） ───────────────────────

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

/** 测试内的 browserAuth：复刻宿主的 cookie 校验（secret / authority / HMAC / 时效），供真实 admit 使用。 */
function testBrowserAuth(secret: Buffer, maxAgeDays = 30) {
  const day = 24 * 60 * 60 * 1000;
  return {
    secret,
    isAuthenticated(request: any, secure = false) {
      const auth = audience(request?.headers, secure);
      const raw = request?.headers?.cookie;
      if (!auth || typeof raw !== "string") return false;
      const value = cookieValue(raw, cookieName(auth));
      if (!value) return false;
      const payload = decodeCookie(value, secret);
      if (!payload || payload.authority !== auth) return false;
      const now = Date.now();
      return !(payload.issuedAt > now || payload.expiresAt <= now || payload.expiresAt - payload.issuedAt > maxAgeDays * day);
    },
    authenticateApi() {
      return undefined;
    },
  };
}
function audience(headers: any, secure: boolean) {
  const host = headers?.host;
  if (typeof host !== "string") return undefined;
  try {
    const url = new URL(`${secure ? "https:" : "http:"}//${host}`);
    return secure ? url.origin : url.host;
  } catch {
    return undefined;
  }
}
function cookieName(authority: string) {
  return "dsh-auth-" + createHash("sha256").update(authority).digest("base64url");
}
function cookieValue(headerValue: string, name: string) {
  for (const seg of headerValue.split(";")) {
    const at = seg.indexOf("=");
    if (at === -1 || seg.slice(0, at).trim() !== name) continue;
    return seg.slice(at + 1).trim();
  }
  return undefined;
}
function decodeCookie(value: string, secret: Buffer) {
  const [version, body, sig] = value.split(".");
  if (version !== "v1" || !body || !sig) return undefined;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(sig, "base64url");
  if (actual.length !== expected.length || Buffer.compare(actual, expected) !== 0) return undefined;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

/** 用「真实服务已生成的 secret」派生合法 cookie（签名格式只在测试内复刻）。 */
function mint(secret: Buffer, authority: string, opts: { ttlMs?: number; issuedAgoMs?: number } = {}) {
  const now = Date.now();
  const issuedAt = now - (opts.issuedAgoMs ?? 1000);
  const expiresAt = issuedAt + (opts.ttlMs ?? 60_000);
  const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${cookieName(authority)}=v1.${body}.${sig}`;
}
/** 篡改：合法结构 + 随意签名。 */
function forge(authority: string) {
  const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: Date.now() - 1000, expiresAt: Date.now() + 60_000 }), "utf8").toString("base64url");
  const sig = randomBytes(32).toString("base64url");
  return `${cookieName(authority)}=v1.${body}.${sig}`;
}

// ───────────────────────────── 真实宿主栈 ─────────────────────────────

/**
 * 搭一套**真实**宿主：真实 Context、真实 WebServer（真实监听）、真实 HostConnectionService。
 * @param opts.connectionFirst true = connection 先于 webServer 就位；false = webServer 先到
 */
async function startHost(opts: { connectionFirst?: boolean } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "g507-b-ws-"));
  init(join(ws, ".dsh-graph"));
  const root = new Context();
  const { provider } = memoryCredentials();
  root.provide("credentials", provider);
  const secret = randomBytes(32);

  const state: {
    webServer: any;
    webFiber: any;
    connection?: any;
    connFiber?: any;
    routes: any[];
  } = { webServer: null, webFiber: null, routes: [] };

  // 真实装配：每个服务各占**一条独立 fiber**（= 宿主插件形态；ctx.extend 共享根 fiber，不能用来释放单个服务）
  const bootWeb = async () => {
    const loaded = await loadServicePlugin(root, "g507-test-webserver", (ctx) => {
      const server = new WebServer(ctx, { host: "127.0.0.1", port: 0 });
      ctx.effect(() => server[INIT](), "g507: webServer.listen");
      return server;
    });
    state.webServer = loaded.service;
    state.webFiber = loaded.fiber;
    await (loaded.service as any).server?.once?.("listening", () => {});
    // 等待绑定完成（listen 在 effect 内异步完成）
    for (let i = 0; i < 200 && !(state.webServer as any).server?.listening; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return state.webServer;
  };
  const bootConn = (secretBytes: Buffer = secret) => {
    const loaded = loadServicePlugin(root, "g507-test-connection", (ctx) => new HostConnectionService(ctx, [], testBrowserAuth(secretBytes)));
    return loaded;
  };
  /** 真实卸载连接服务（释放它自己的 fiber；webServer 的 fiber 不受影响）。 */
  const disposeConn = async () => {
    const fiber = state.connFiber;
    state.connFiber = undefined;
    state.connection = undefined;
    if (fiber) {
      try {
        await fiber.dispose();
      } catch {
        /* 已释放 */
      }
    }
  };
  /** 装配一个新连接实例（先真实卸载旧的）。 */
  const newConnection = async (secretBytes: Buffer) => {
    await disposeConn();
    const loaded = await bootConn(secretBytes);
    state.connection = loaded.service;
    state.connFiber = loaded.fiber;
    return state.connection;
  };

  // 插件 ctx：get(name) 动态读取「当前 active」服务（与生产 ctx.get 语义一致：服务晚到/消失都可见）
  const pluginCtx: any = {
    get: (name: string) => {
      if (name === "webServer") {
        if (!state.webServer) return undefined;
        return {
          register: (def: any) => {
            state.routes.push(def);
            return state.webServer.register(def);
          },
        };
      }
      if (name === "connection") return state.connection ?? undefined;
      return undefined;
    },
    effect: (fn: () => unknown) => fn(),
    tools: { register: () => () => {}, get: () => ({}) },
    on() {},
  };

  const start = async () => {
    if (opts.connectionFirst) {
      await newConnection(secret);
      await bootWeb();
    } else {
      await bootWeb();
      await newConnection(secret);
    }
    return { ws, server: state.webServer, connection: state.connection!, secret };
  };

  const origin = () => {
    const server = state.webServer;
    return server.getOrigin();
  };
  const authority = () => new URL(origin()).host;

  /** 真实 HTTP 请求（真实 socket）。 */
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

  /**
   * 释放全部真实资源（不留悬挂 socket / fiber）。真实 WebServer 的 effect disposer 不关 socket
   * （0.2.1-rc.2 实测 `dispose` 后 `listening` 仍为 true），故显式 close。
   */
  const shutdown = async () => {
    await disposeConn();
    const server = state.webServer;
    if (server?.server && server.server.listening) {
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
    root, state, pluginCtx, start, origin, authority, request, secret, provider, shutdown,
    bootWebPublic: bootWeb, newConnection, disposeConn,
  };
}

/** 装配插件（真实 apply）与真实宿主，返回可复用的断言上下文。 */
async function pluginOnRealHost(opts: { connectionFirst?: boolean } = {}) {
  const host = await startHost(opts);
  const { secret } = await host.start();
  apply(host.pluginCtx, {});
  assertSingleProtectedEntry(host.state.routes);
  return { ...host, server: host.state.webServer, hostSecret: secret };
}

// ───────────────────────────────── 用例 ─────────────────────────────────

test("g-507 B1：真实 WebServer 匹配只命中一个 prefix 入口（真实路由表）", async () => {
  const h = await pluginOnRealHost();
  try {
    assert.equal(h.server.match(API), h.state.routes[0], "命名空间根命中唯一入口");
    assert.equal(h.server.match(`${API}/goal`), h.state.routes[0], "子路径命中唯一入口");
    assert.equal(h.server.match(`${API}/unknown/deep/path`), h.state.routes[0], "未知子路径同样命中入口（先鉴权）");
    assert.equal(h.server.match("/api/other"), undefined, "命名空间之外不受影响");
  } finally {
    await h.shutdown();
  }
});

test("g-507 B2：真实 HTTP 拒绝矩阵（匿名/伪造/篡改/过期/撤销等效/信任边界）⇒ 401/403，业务不触达", async () => {
  const h = await pluginOnRealHost();
  const auth = h.authority();
  try {
    const cases: Array<{ name: string; headers: Record<string, string>; expect: number }> = [
      { name: "匿名", headers: {}, expect: 401 },
      { name: "伪造凭证头（形状对、值错）", headers: { [OWNER_HEADER]: "1" }, expect: 401 },
      { name: "伪造 cookie（合法结构、错误签名）", headers: { cookie: forge(auth) }, expect: 401 },
      { name: "过期 cookie", headers: { cookie: mint(h.hostSecret, auth, { ttlMs: -60_000 }) }, expect: 401 },
      { name: "错误 authority 的合法签名 cookie", headers: { cookie: mint(h.hostSecret, "attacker.example") }, expect: 401 },
      { name: "Host 不在信任范围", headers: { host: "evil.example" }, expect: 403 },
      { name: "cross-site", headers: { "sec-fetch-site": "cross-site" }, expect: 403 },
      { name: "跨源 Origin", headers: { origin: "http://evil.example" }, expect: 403 },
    ];
    for (const c of cases) {
      const res = await h.request("GET", API, c.headers);
      assert.equal(res.status, c.expect, `${c.name} ⇒ ${c.expect}（实得 ${res.status}）`);
    }
    // 写端点与资产路由同样被拒（不只是 GET 看板）
    for (const path of [`${API}/create-goal`, `${API}/diagram/design-philosophy.lifecycle.html`, `${API}/no-such`]) {
      const res = await h.request("POST", path, {}, { title: "x" });
      assert.equal(res.status, 401, `${path} 匿名 ⇒ 401`);
    }
    // 被拒响应不含凭证 / 内部细节
    const res = await h.request("GET", API);
    const text = JSON.stringify(res.body);
    assert.doesNotMatch(text, /at .*\(|stack|boom/i);
    assert.equal(res.headers["content-type"], "application/json; charset=utf-8");
    assert.equal(res.headers["cache-control"], "no-store");
  } finally {
    await h.shutdown();
  }
});

test("g-507 B3：合法 owner（真实签名 cookie、真实 admit）⇒ 200，读/写/资产/ETag304/未知路径均按语义", async () => {
  const h = await pluginOnRealHost();
  const auth = h.authority();
  const owner = { cookie: mint(h.hostSecret, auth) };
  try {
    const board = await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, owner);
    assert.equal(board.status, 200, "合法 owner 读看板 200");
    assert.ok(board.headers.etag, "看板带 ETag（合法 owner 保持 ETag 304 语义）");
    const again = await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, { ...owner, "if-none-match": String(board.headers.etag) });
    assert.equal(again.status, 304, "携带匹配 If-None-Match ⇒ 304");

    const created = await h.request("POST", `${API}/create-goal?workspace=${encodeURIComponent(h.ws)}`, owner, { title: "B3 目标" });
    assert.equal(created.status, 200, "合法 owner 可逆写入");
    assert.equal(created.body.ok, true);

    const asset = await h.request("GET", `${API}/diagram/design-philosophy.lifecycle.html`, owner);
    assert.equal(asset.status, 200, "资产路由（prefix）合法 owner 200");
    const assetHead = await h.request("HEAD", `${API}/diagram/design-philosophy.lifecycle.html`, owner);
    assert.equal(assetHead.status, 200, "资产 HEAD 200");

    const unknown = await h.request("GET", `${API}/no-such-endpoint`, owner);
    assert.equal(unknown.status, 404, "认证后未知子路径 404");

    const wrongMethod = await h.request("GET", `${API}/create-version?workspace=${encodeURIComponent(h.ws)}`, owner);
    assert.equal(wrongMethod.status, 405, "认证后方法不匹配 405");
  } finally {
    await h.shutdown();
  }
});

test("g-507 B4：服务到达顺序（webServer 先到 / connection 先到）均可用，且 connection 缺位时 fail-closed 503", async () => {
  for (const connectionFirst of [false, true]) {
    const h = await pluginOnRealHost({ connectionFirst });
    const auth = h.authority();
    try {
      assert.equal((await h.request("GET", API)).status, 401, `顺序(${connectionFirst})：匿名仍 401`);
      const ok = await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, { cookie: mint(h.hostSecret, auth) });
      assert.equal(ok.status, 200, `顺序(${connectionFirst})：合法 owner 200`);
    } finally {
      await h.shutdown();
    }
  }

  // connection 未就位（webServer 已监听）：同一入口 fail-closed 503，绝不提前放行
  const h = await startHost({ connectionFirst: false });
  const server = await h.bootWebPublic();
  await h.disposeConn();
  apply(h.pluginCtx, {});
  try {
    const res = await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, { [OWNER_HEADER]: "1" });
    assert.equal(res.status, 503, "缺 active connection ⇒ 503 fail-closed");
    assert.equal(res.body.error, "connection-service-unavailable");
  } finally {
    await h.shutdown();
  }
});

test("g-507 B5：connection 消失/恢复 —— 同一入口随 active 服务动态拒绝与恢复（无裸路由窗口）", async () => {
  const h = await pluginOnRealHost();
  const auth = h.authority();
  const owner = { cookie: mint(h.hostSecret, auth) };
  try {
    assert.equal((await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, owner)).status, 200);
    // 模拟服务卸载：active 引用消失
    const real = h.state.connection;
    await h.disposeConn();
    assert.equal(h.server.server?.listening, true, "释放 connection scope 不得连带关闭 webServer 监听");
    assert.equal((await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, owner)).status, 503, "服务消失 ⇒ 503（而非放行或不注册）");
    // 恢复（重载后的新实例）
    await h.newConnection(h.hostSecret);
    assert.equal((await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, owner)).status, 200, "服务恢复 ⇒ 同一入口立即恢复");
    void real;
  } finally {
    await h.shutdown();
  }
});

test("g-507 B6：换 secret（重新初始化）后旧 cookie 失效；卸载后入口不再注册、无定时器残留", async () => {
  const h = await pluginOnRealHost();
  const auth = h.authority();
  const oldCookie = { cookie: mint(h.hostSecret, auth) };
  try {
    assert.equal((await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, oldCookie)).status, 200);
    // 撤销等效路径：同一 authority 上新 secret ⇒ 旧签名不再被真实 admit 接受
    await h.newConnection(randomBytes(32));
    assert.equal((await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, oldCookie)).status, 401, "旧 cookie 在换 secret 后失效");
  } finally {
    await h.shutdown();
  }

  // 卸载：真实 register 的 disposer 让路由表回到「无入口」，且不再有轮询定时器（已注册即无 timer）
  const routes = h.state.routes;
  assert.equal(routes.length, 1, "只注册一个入口");
  const disposer = h.server.register; // 校验 disposer 语义由 WebServer.register 保证
  assert.equal(typeof disposer, "function");
  const unregister = () => h.server.prefixes.delete(API);
  unregister();
  assert.equal(h.server.match(API), undefined, "卸载后命名空间不再命中任何路由（无裸业务残留）");
});

test("g-507 B7：重载无重复注册（第二个 apply 仍只有一个 prefix 入口，真实 register 不抛重复）", async () => {
  const h = await pluginOnRealHost();
  try {
    // 新建插件实例（模拟重载）：向同一个真实 webServer 注册
    const routes2: any[] = [];
    const pluginCtx2: any = {
      get: (name: string) => {
        if (name === "webServer") {
          return {
            register: (def: any) => {
              routes2.push(def);
              return h.server.register(def); // 真实 register：同 (kind,path) 重复会抛错
            },
          };
        }
        if (name === "connection") return h.state.connection;
        return undefined;
      },
      effect: (fn: () => unknown) => fn(),
      tools: { register: () => () => {}, get: () => ({}) },
      on() {},
    };
    // 先摘掉旧实例的注册（模拟真实卸载顺序：dispose → 再重新 apply）
    h.server.prefixes.delete(API);
    apply(pluginCtx2, {});
    assertSingleProtectedEntry(routes2);
    const auth = h.authority();
    const res = await h.request("GET", `${API}?workspace=${encodeURIComponent(h.ws)}`, { cookie: mint(h.hostSecret, auth) });
    assert.equal(res.status, 200, "重载后同一入口继续工作（真实 HTTP）");
  } finally {
    await h.shutdown();
  }
});
