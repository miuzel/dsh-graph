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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { init } from "../ops.ts";
import { apply } from "../../dist/index.js";
import { assertSingleProtectedEntry, loadServicePlugin } from "./_http-auth-harness.ts";
import { loadHostStack, HOST_STACK_PINS, resolveHostStack } from "./_host-stack.ts";
import {
  PLUGIN_CONFIG,
  assertPrivateTestRoot,
  createPrivateTestRoot,
  realBoardRoot,
  removePrivateTestRoot,
  uniqueMarker,
  workspaceQuery,
} from "./_g611-private-root.ts";

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
  // g-611：workspace 必须是**本次测试独占**的私有根，并在任何请求/服务器启动之前 fail-closed 自证。
  // 旧实现在这里创建并 `init` 了 ws，却没有把它放进返回对象 ⇒ `h.ws === undefined` ⇒ B2/B3 拼出
  // `?workspace=undefined`；host 把 "undefined" 当普通相对路径（`resolve("undefined")` = `<cwd>/undefined`），
  // 在目录已存在且未被 gitignore 的后续运行中由 `resolveCanonicalRoot` 归一到**真实主看板**，
  // 真实 owner POST 的静态标题就写进了主图（历史 100 条空草稿的机制）。
  // 私有根放在仓库已忽略的 `tmp/`（g-363 scratch 边界 ⇒ 生产 resolver 走 workspace-fallback），
  // guard 再用与 server **逐字相同**的 resolver 调用复核（默认 TTL + ttl=0 双查）。
  const ws = createPrivateTestRoot("b-ws");
  // 顺序铁律：**先**证明最终 realpath 归属（禁符号链接/越界/主图），**再**允许写入（init）。
  // guard 失败时零写入（连 events.jsonl 都不会出现），绝不出现「先写用户路径再发现不对」。
  const wsGuard = assertPrivateTestRoot(ws, {
    where: "g507 real-host startHost（init 前）",
    config: PLUGIN_CONFIG,
    requireInitialized: false,
  });
  init(wsGuard.root);
  assertPrivateTestRoot(ws, {
    where: "g507 real-host startHost（init 后）",
    config: PLUGIN_CONFIG,
    requireInitialized: true,
  });
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
    // g-611：只清理本次测试**自己创建**、且已被 guard 校验过的私有根；
    // 既有 tmp/undefined、他人 worktree、真实看板一律不删（removePrivateTestRoot 强制校验）。
    removePrivateTestRoot(ws);
  };

  return {
    root, state, records, provider, start, origin, authority, request, shutdown,
    mintOwnerCookie, getConnection, bootConnection, disposeConnection, bootWeb,
    ws, wsGuard,
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
  const cleanup = apply(ctx, PLUGIN_CONFIG) as any;
  assert.equal(typeof cleanup, "function", "apply 必须返回清理函数（真实 ctx.effect disposer 语义）");
  (host as any).state.applyCleanup = cleanup;
  (host as any).state.pluginCtx = ctx;
  assertSingleProtectedEntry(host.state.routes);
  // g-611：所有 B 路径拿到的 h 都必须携带**已 guard 校验**的私有 ws（旧夹具在此处就是 undefined）。
  assert.equal(host.ws, host.wsGuard.workspace, "h.ws 必须与 guard 校验过的私有根一致");
  assert.equal(host.wsGuard.root, join(host.ws, ".dsh-graph"), "guard 的 graph root 必须落在私有 ws");
  assertPrivateTestRoot(host.ws, { where: "pluginOnRealHost", config: PLUGIN_CONFIG, requireInitialized: true });
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
    const wsQ = workspaceQuery(h.ws, { where: "B2 owner GET", config: PLUGIN_CONFIG });
    const ok = await h.request("GET", `${API}${wsQ}`, owner);
    assert.equal(ok.status, 200, "真实签发 cookie ⇒ 200（真实 admit + 真实 BrowserAuth 验收）");
    // g-611：端到端证明这次业务请求解析到的就是**本次私有根**（旧夹具这里是 undefined ⇒ 主图）。
    assert.equal(ok.body?._diagnostics?.workspace, h.ws, "host 解析出的 workspace 必须是私有根");
    assert.equal(ok.body?._diagnostics?.graphRoot, join(h.ws, ".dsh-graph"), "graph root 必须落在私有 ws 下");
    assert.equal(ok.body?._diagnostics?.rootMode, "workspace-fallback", "私有 tmp 根必须走 workspace-local 口径");
    assert.notEqual(ok.body?._diagnostics?.graphRoot, realBoardRoot(), "绝不得解析到真实看板");

    // 以下负向请求**不带 workspace**：宿主契约是「认证先行」，它们在解析 root 之前就被拒绝，原样保留。
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
    // g-611：写入型业务请求的落点必须可定位到私有根。只做**自己 fixture 根内**的前后对比 +
    // 单点路径存在性检查；**不读取真实主看板任何正文**（并发主管写入/清理对其免疫）。
    const strayUndefined = join(process.cwd(), "undefined");
    const strayExistedBefore = existsSync(strayUndefined);
    const privateBoard = join(h.ws, ".dsh-graph");
    assert.ok(existsSync(join(privateBoard, "events.jsonl")), "前置：私有根已由 init 建好骨架");
    const marker = uniqueMarker("b3-title");
    const owner = { cookie: h.mintOwnerCookie() };
    const wsQ = workspaceQuery(h.ws, { where: "B3 owner 业务", config: PLUGIN_CONFIG });
    const board = await h.request("GET", `${API}${wsQ}`, owner);
    assert.equal(board.status, 200);
    assert.equal(board.body?._diagnostics?.graphRoot, privateBoard, "board 必须解析到私有 ws 的看板根");
    assert.equal(board.body?._diagnostics?.rootMode, "workspace-fallback", "私有根必须走 workspace-local 口径");
    assert.notEqual(board.body?._diagnostics?.graphRoot, realBoardRoot(), "绝不得解析到真实看板（仅路径比较）");
    const etag = board.headers.etag;
    assert.ok(etag, "看板带 ETag");
    assert.equal((await h.request("GET", `${API}${wsQ}`, { ...owner, "if-none-match": String(etag) })).status, 304, "ETag 命中 ⇒ 304");
    const created = await h.request("POST", `${API}/create-goal${wsQ}`, owner, { title: `B3 目标 ${marker}` });
    assert.equal(created.status, 200, "真实 owner 可写");
    // 真实落盘证据：目标文件只在私有 ws 的看板里，标题是本次唯一 marker。
    const goalId = created.body?.goal;
    assert.equal(typeof goalId, "string", "create-goal 必须返回目标 id");
    const goalFile = join(privateBoard, "backlog", `${goalId}.md`);
    assert.ok(existsSync(goalFile), `真实 owner 写入必须落盘在私有根：${goalFile}`);
    assert.match(readFileSync(goalFile, "utf8"), new RegExp(marker), "落盘目标必须携带本次唯一标题");
    // 私有根之外：本次请求不得在 cwd 下**新建** `undefined/`（旧污染路径；既有目录不读、不删、不判）。
    if (!strayExistedBefore) {
      assert.equal(existsSync(strayUndefined), false, `本次请求不得新建 ${strayUndefined}`);
    }
    assert.equal(existsSync(join(h.ws, "undefined")), false, "私有根内不得出现 undefined/");
    assert.equal(existsSync(join(privateBoard, "undefined")), false, "私有看板内不得出现 undefined/");
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
      const wsQ = workspaceQuery(h.ws, { where: `B4 顺序(${connectionFirst})`, config: PLUGIN_CONFIG });
      assert.equal((await h.request("GET", API)).status, 401, `顺序(${connectionFirst})：匿名 401`);
      assert.equal(
        (await h.request("GET", `${API}${wsQ}`, { cookie: h.mintOwnerCookie() })).status,
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
  const cleanup = apply(ctx, PLUGIN_CONFIG);
  try {
    // 即使是 503 路径，请求 URL 也必须携带**已校验的私有 ws**，绝不出现 `?workspace=undefined`。
    const wsQ = workspaceQuery(host.ws, { where: "B4 connection 缺位 503", config: PLUGIN_CONFIG });
    const res = await host.request("GET", `${API}${wsQ}`);
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
    const wsQ = workspaceQuery(h.ws, { where: "B5 fiber 生命周期", config: PLUGIN_CONFIG });
    const cookie = h.mintOwnerCookie();
    assert.equal((await h.request("GET", `${API}${wsQ}`, { cookie })).status, 200);
    await h.disposeConnection(); // 真实卸载 fiber
    assert.equal((await h.request("GET", `${API}${wsQ}`, { cookie })).status, 503, "服务消失 ⇒ 503");
    await h.bootConnection(); // 真实重新引导
    // 行为观察：宿主把浏览器会话 secret 存在 credentials 里（本轮为空实现的内存表）⇒ 重新引导复用同一 secret，
    // 旧 cookie 仍然有效。这是宿主的真实语义，不称其为「撤销」，也不臆造失效结论。
    assert.equal((await h.request("GET", `${API}${wsQ}`, { cookie })).status, 200, "重新引导后旧 cookie 仍有效（宿主复用 credentials 中的 secret）");
    const fresh = h.mintOwnerCookie();
    assert.equal((await h.request("GET", `${API}${wsQ}`, { cookie: fresh })).status, 200, "新签发的 cookie ⇒ 200");
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
    const wsQ = workspaceQuery(h.ws, { where: "B6 cleanup 后", config: PLUGIN_CONFIG });
    const owner = { cookie: h.mintOwnerCookie() };
    const afterCleanup = await h.request("GET", `${API}${wsQ}`, owner);
    assert.notEqual(afterCleanup.body?.ok, true, "cleanup 后看板业务不再由本插件返回");

    // 再次 apply：仍只有一个入口，且可正常工作
    h.state.routes.length = 0;
    const ctx2 = pluginContext(h as any, h.root);
    (h as any).state.root = h.root;
    const cleanup2 = apply(ctx2, PLUGIN_CONFIG);
    assertSingleProtectedEntry(h.state.routes);
    assert.equal((await h.request("GET", API)).status, 401, "再次 apply 后匿名仍 401（单入口生效）");
    assert.equal(
      (await h.request("GET", `${API}${wsQ}`, { cookie: h.mintOwnerCookie() })).status,
      200,
      "再次 apply 后 owner 仍 200",
    );
    cleanup2?.();
  } finally {
    await h.shutdown();
  }
});

test("g-611 B7：旧夹具形态（startHost 漏返回 ws / 字面量 undefined）必须在发出请求之前 fail-closed", async () => {
  const h = await pluginOnRealHost();
  const marker = uniqueMarker("b7-mutant");
  const privateBoard = join(h.ws, ".dsh-graph");
  const eventsBefore = readFileSync(join(privateBoard, "events.jsonl"), "utf8");
  const backlogFilesBefore = readdirSync(join(privateBoard, "backlog"));
  let requests = 0;
  /** 计数包装：先把 URL 参数求值完才会真正调用 request ⇒ 任何 guard 拒绝都发生在「请求发出之前」。 */
  const countedRequest = (...args: any[]) => {
    requests += 1;
    return (h as any).request(...args);
  };
  try {
    // 正向：正常夹具的 ws 能通过 guard，且 query 携带编码后的私有绝对路径（不是 undefined）。
    const okQ = workspaceQuery(h.ws, { where: "B7 正向", config: PLUGIN_CONFIG });
    assert.equal(okQ, `?workspace=${encodeURIComponent(h.ws)}`);
    assert.ok(!okQ.includes("undefined"), "正向 query 不得含 undefined");

    // 变异面：把旧代码的每种失效形态都喂给请求构造器。
    const mutantWithoutWs = { ...(h as any) };
    delete mutantWithoutWs.ws; // 旧 startHost 的返回形状（ws 未出现在 return 对象里）
    const hostile: Array<[string, unknown]> = [
      ["旧夹具（漏返回 ws）", mutantWithoutWs.ws],
      ["显式 undefined", undefined],
      ["字面量 \"undefined\"", "undefined"],
      ["空字符串", ""],
      ["相对路径", "tmp/not-private"],
      ["真实主看板", realBoardRoot()],
      ["cwd 下的 undefined 路径", join(process.cwd(), "undefined")],
    ];
    for (const [label, badWs] of hostile) {
      assert.throws(
        () => {
          const path = `${API}/create-goal${workspaceQuery(badWs, { where: `B7 ${label}`, config: PLUGIN_CONFIG })}`;
          return countedRequest("POST", path, {}, { title: `B3 目标 ${marker}` });
        },
        /拒绝使用该测试 workspace/,
        `${label}：必须在任何请求之前 fail-closed（旧行为会拼出 ?workspace=undefined 并可能写主图）`,
      );
    }
    assert.equal(requests, 0, "所有变异都不得真正发出 HTTP 请求（零副作用）");
    // 零写证据（只读**自己 fixture 根**）：私有看板事件流与 backlog 逐字未变、无 undefined 落点。
    assert.equal(readFileSync(join(privateBoard, "events.jsonl"), "utf8"), eventsBefore, "私有看板事件流不得被变异改动");
    assert.deepEqual(readdirSync(join(privateBoard, "backlog")), backlogFilesBefore, "私有看板 backlog 不得被变异改动");
    assert.equal(existsSync(join(h.ws, "undefined")), false, "私有根内不得出现 undefined/");

    // 变异不影响正常宿主：紧接一次合法的匿名 401（认证先行，无需 workspace）。
    assert.equal((await h.request("GET", API)).status, 401, "变异后宿主仍正常：匿名 ⇒ 401");
  } finally {
    await h.shutdown();
  }
});
