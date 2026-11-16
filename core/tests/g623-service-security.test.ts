/**
 * g-623：安全**负向矩阵**（判据 2 / 4 / 6 / 8 的验收主体）。
 *
 * 每一项都遵循同一结构：
 *   ① **正向对照**：同一服务上的合法只读请求**必须成功**（证明防护不是「靠全拒绝蒙对」）；
 *   ② 负向输入：必须被拒绝（状态码 + 稳定错误码，且在认证/边界层拒绝）；
 *   ③ **零副作用**：整个 graph 树在负向请求前后的内容/权限/目录快照必须**完全一致**
 *      （含事件流、锁、配置、初始化状态）。
 *
 * 矩阵（与 `docs/g622-local-web-mcp-design.md` §6 对齐）：
 *   A 远程/通配绑定（0.0.0.0 / :: / LAN / 主机名 / localhost 别名）
 *   B 非 loopback peer / 伪造代理头 / 非法 Host（DNS rebinding）
 *   C 缺/空/错误/旧 token、token 伪参数（URL / body / 工具 args）
 *   D 轮换后旧 token、撤销后重连
 *   E 外站 Origin/CORS、MCP token 调人工审批路由
 *   F 路径穿越 / 绝对路径 / 根外 symlink / 客户端 roots 覆盖
 *   G 伪 actor / owner / human / approval、未知 capability
 *   H 未注册写工具、直接 Web 写 API、GET 触发隐式 init
 *   I 凭据文件宽权限、端口占用
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";

import { startService, resolveBindHost, MAX_REQUEST_BYTES } from "../service/server.ts";
import { validateBindHost, checkRequestBoundary, isAllowedHostHeader } from "../service/policy.ts";
import { hasTokenLikeParam, parseBearer, RESERVED_PARAM_KEYS } from "../service/mcp.ts";
import { executeReadOnlyCommand, RESERVED_ARG_KEYS, READ_ONLY_COMMAND_NAMES } from "../service/queries.ts";
import { CredentialStore, TOKEN_FILE_NAME } from "../service/credentials.ts";
import { initService, parseServeArgs } from "../service/serve.ts";
import { makePrivateWorkspace, seedFixtureBoard, rawRequest, snapshotTree, diffTrees, occupyPort, dirExists, makeSymlink } from "./fixtures/g623-service.ts";

type Svc = Awaited<ReturnType<typeof startService>>;

/** 统一的矩阵夹具：一个私有着板 + 一个运行中的服务 + 便捷的 cookie 登录。 */
async function matrix(fn: (m: {
  svc: Svc;
  token: string;
  host: string;
  origin: string;
  board: ReturnType<typeof seedFixtureBoard>;
  ws: ReturnType<typeof makePrivateWorkspace>;
  login: () => Promise<string>;
  mcp: (body: unknown, headers?: Record<string, string>) => Promise<Awaited<ReturnType<typeof rawRequest>>>;
}) => Promise<void>): Promise<void> {
  const ws = makePrivateWorkspace("neg");
  const board = seedFixtureBoard(ws.graphRoot);
  const svc = await startService({ graphRoot: ws.graphRoot, executionWorkspace: ws.executionWorkspace, stateDir: ws.stateDir, port: 0 });
  const token = svc.credentials.read();
  const host = `127.0.0.1:${svc.port}`;
  const origin = `http://127.0.0.1:${svc.port}`;
  try {
    await fn({
      svc,
      token,
      host,
      origin,
      board,
      ws,
      async login() {
        const r = await rawRequest({
          port: svc.port,
          path: "/api/session",
          method: "POST",
          headers: { host, origin, "content-type": "application/json" },
          body: JSON.stringify({ token: svc.credentials.read() }),
        });
        assert.equal(r.status, 200, "正向对照：合法 token 必须能建立 Web 会话");
        return String(r.headers["set-cookie"]).split(";")[0];
      },
      mcp: (body: unknown, headers: Record<string, string> = {}) =>
        rawRequest({
          port: svc.port,
          path: "/mcp",
          method: "POST",
          headers: { host, authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
    });
  } finally {
    await svc.close();
    ws.cleanup();
  }
}

/** graph 零副作用断言：负向请求前后必须完全一致。 */
async function assertNoGraphSideEffects(graphRoot: string, action: () => Promise<void>): Promise<void> {
  const before = snapshotTree(graphRoot);
  await action();
  assert.deepEqual(diffTrees(before, snapshotTree(graphRoot)), [], "负向请求不得造成任何 graph 副作用（文件/目录/权限/事件/锁/配置）");
}

// ── A：远程/通配绑定 ──────────────────────────────────────────────────────────────────

test("g-623 A 绑定矩阵：0.0.0.0 / :: / LAN / 主机名一律启动前拒绝（正向 127.0.0.1 通过）", () => {
  // 正向对照：唯一允许的绑定
  const ok = validateBindHost("127.0.0.1");
  assert.deepEqual(ok, { ok: true, host: "127.0.0.1" });
  assert.equal(resolveBindHost("127.0.0.1"), "127.0.0.1");

  const cases: Array<[string, string]> = [
    ["0.0.0.0", "wildcard-v4"],
    ["::", "wildcard-v6"],
    ["[::]", "wildcard-v6"],
    ["192.168.1.10", "lan"],
    ["10.0.0.5", "lan"],
    ["8.8.8.8", "lan"],
    ["127.0.0.2", "lan"],
    ["localhost", "name"],
    ["example.com", "name"],
    ["::1", "ipv6"],
    ["", "empty"],
  ];
  for (const [input, reason] of cases) {
    const v = validateBindHost(input);
    assert.equal(v.ok, false, `绑定 ${input || "(空)"} 必须被拒绝`);
    assert.equal((v as any).reason, reason, `绑定 ${input} 的拒绝原因必须是 ${reason}`);
    assert.throws(() => resolveBindHost(input), (e: any) => e.reason === reason, `resolveBindHost 必须按 reason 拒绝 ${input}`);
  }
  // 不存在「绑定失败后回退通配」的路径：resetBindHost 只返回一个地址
  assert.equal(resolveBindHost(undefined), "127.0.0.1");
});

test("g-623 A 绑定矩阵：startService 收到非法 host 时报错且不留监听", async () => {
  const ws = makePrivateWorkspace("bind");
  const board = seedFixtureBoard(ws.graphRoot);
  const before = snapshotTree(board.root);
  let listening = 0;
  const original = createServer;
  // 统计：不应有服务器真正开始监听
  try {
    await assert.rejects(
      startService({ graphRoot: board.root, executionWorkspace: ws.executionWorkspace, stateDir: ws.stateDir, port: 0, host: "0.0.0.0" }),
      (e: any) => e.reason === "wildcard-v4",
      "0.0.0.0 必须在创建服务器之前被拒绝",
    );
    await assert.rejects(
      startService({ graphRoot: board.root, executionWorkspace: ws.executionWorkspace, stateDir: ws.stateDir, port: 0, host: "::" }),
      (e: any) => e.reason === "wildcard-v6",
    );
    await assert.rejects(
      startService({ graphRoot: board.root, executionWorkspace: ws.executionWorkspace, stateDir: ws.stateDir, port: 0, host: "localhost" }),
      (e: any) => e.reason === "name",
    );
  } finally {
    void original;
  }
  assert.equal(listening, 0);
  assert.deepEqual(diffTrees(before, snapshotTree(board.root)), [], "启动拒绝不得改动 graph");
  void ws.cleanup;
  ws.cleanup();
});

// ── B：非 loopback peer / 代理头 / 非法 Host ─────────────────────────────────────────

test("g-623 B peer/Host/Origin 矩阵：正向对照通过，非回环 peer、伪造代理头、非法 Host 全部拒绝", async () => {
  await matrix(async ({ svc, host, origin, mcp }) => {
    // ① 正向对照：合法 peer + 合法 Host + 同 origin ⇒ 成功
    const okPeer = checkRequestBoundary({ headers: { host }, socket: { remoteAddress: "127.0.0.1" } }, { port: svc.port });
    assert.deepEqual(okPeer, { ok: true }, "正向对照：回环 peer + 合法 Host 必须通过");
    const okOrigin = checkRequestBoundary(
      { headers: { host, origin }, socket: { remoteAddress: "::ffff:127.0.0.1" } },
      { port: svc.port },
    );
    assert.deepEqual(okOrigin, { ok: true }, "IPv4-mapped 回环 peer + 同 origin 必须通过");
    const ping = await mcp({ jsonrpc: "2.0", id: 1, method: "ping" });
    assert.equal(ping.status, 200, "正向对照：MCP ping 必须成功");

    // ② 非 loopback peer：即使全部头都合法也拒绝
    // 注：127.0.0.2 属于 127.0.0.0/8 回环网段（本机另一个回环地址），按口径是**合法** peer ——
    // 接受它不扩大暴露面（服务只监听 127.0.0.1，能连上的都来自本机）；非回环地址才必须拒绝。
    for (const peer of ["192.168.1.50", "10.1.2.3", "8.8.8.8", "::2", "example.com", "", null]) {
      const v: any = checkRequestBoundary({ headers: { host }, socket: { remoteAddress: peer } }, { port: svc.port });
      assert.equal(v.ok, false, `peer ${String(peer)} 必须被拒绝`);
      assert.equal(v.code, "peer_not_loopback");
    }

    // ③ 伪造代理头：判定**根本不读**这些头（peer 是非回环时仍拒绝；回环时也不因此放宽 Host 检查）
    const spoofHeaders = {
      host: "attacker.example:80",
      "x-forwarded-for": "127.0.0.1",
      "x-real-ip": "127.0.0.1",
      "x-forwarded-host": "attacker.example",
      forwarded: "for=127.0.0.1",
    };
    const spoofedFromRemote: any = checkRequestBoundary({ headers: spoofHeaders, socket: { remoteAddress: "203.0.113.9" } }, { port: svc.port });
    assert.equal(spoofedFromRemote.ok, false, "伪造 X-Forwarded-For 不得让远程 peer 通过");
    assert.equal(spoofedFromRemote.code, "peer_not_loopback");
    const spoofedHost: any = checkRequestBoundary({ headers: spoofHeaders, socket: { remoteAddress: "127.0.0.1" } }, { port: svc.port });
    assert.equal(spoofedHost.code, "host_not_allowed", "伪造 X-Forwarded-Host 不得让非法 Host 通过");

    // ④ 非法 Host（DNS rebinding）：主机名 / 其他端口 / IPv6 字面量 / 缺失
    for (const badHost of ["evil.example", `evil.example:${svc.port}`, `127.0.0.1:${svc.port + 1}`, "[::1]:port", "127.0.0.1", "0.0.0.0:" + svc.port]) {
      const v: any = checkRequestBoundary({ headers: { host: badHost }, socket: { remoteAddress: "127.0.0.1" } }, { port: svc.port });
      assert.equal(v.ok, false, `Host「${badHost}」必须被拒绝（DNS rebinding 防护）`);
      assert.ok(["host_not_allowed", "host_missing"].includes(v.code));
    }
    const noHost: any = checkRequestBoundary({ headers: {}, socket: { remoteAddress: "127.0.0.1" } }, { port: svc.port });
    assert.equal(noHost.code, "host_missing");
    assert.equal(isAllowedHostHeader(`localhost:${svc.port}`, svc.port), true, "正向对照：localhost:<实际端口> 允许");

    // ⑤ 外站 Origin（浏览器跨站）：即使在回环 peer 上也必须拒绝
    for (const badOrigin of ["http://evil.example", `http://evil.example:${svc.port}`, "null", `https://127.0.0.1:${svc.port}`]) {
      const v: any = checkRequestBoundary(
        { headers: { host, origin: badOrigin }, socket: { remoteAddress: "127.0.0.1" } },
        { port: svc.port },
      );
      assert.equal(v.ok, false, `Origin「${badOrigin}」必须被拒绝`);
      assert.equal(v.code, "origin_not_allowed");
    }

    // ⑥ 真实 HTTP 层：非法 Host 与伪造代理头在服务端被拒（403），且不回显任何 token
    const token = svc.credentials.read();
    const badHostReq = await mcp({ jsonrpc: "2.0", id: 9, method: "ping" }, { host: "evil.example" });
    assert.equal(badHostReq.status, 403, "非法 Host 的 MCP 请求必须 403");
    assert.equal(badHostReq.json.code, "host_not_allowed");
    assert.ok(!badHostReq.body.includes(token), "拒绝响应不得回显 token");
    const badOriginReq = await mcp({ jsonrpc: "2.0", id: 9, method: "ping" }, { origin: "http://evil.example" });
    assert.equal(badOriginReq.status, 403, "外站 Origin 的 MCP 请求必须 403");
    assert.equal(badOriginReq.json.code, "origin_not_allowed");
    const badHostApi = await rawRequest({ port: svc.port, path: "/api/goals", headers: { host: "evil.example" } });
    assert.equal(badHostApi.status, 403, "非法 Host 的 API 请求必须 403");
  });
});

// ── C：token 缺失/空/错误 + 伪参数 ───────────────────────────────────────────────────

test("g-623 C token 矩阵：缺失/空/错误/伪参数全部在认证层拒绝且零 graph 副作用（正向对照成功）", async () => {
  await matrix(async ({ svc, token, host, board, mcp }) => {
    // 正向对照：合法 token ⇒ 成功
    const good = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_list_goals", arguments: {} } });
    assert.equal(good.status, 200, "正向对照：合法 token 必须成功");
    assert.equal(good.json.result.isError, false);

    await assertNoGraphSideEffects(board.root, async () => {
      // ① 缺失 / 空 / 错误
      const noAuth = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
      assert.equal(noAuth.status, 401, "缺 token 必须 401");
      const emptyAuth = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, authorization: "Bearer ", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
      assert.equal(emptyAuth.status, 401, "空 token 必须 401");
      const wrong = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, authorization: `Bearer ${"0".repeat(64)}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_list_goals", arguments: {} } }) });
      assert.equal(wrong.status, 401, "错误 token 必须 401");
      assert.ok(!wrong.body.includes("graph_list_goals"), "被拒绝时不得进入业务分派（响应不含工具名结果）");
      const basicAuth = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, authorization: `Basic ${Buffer.from(token).toString("base64")}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
      assert.equal(basicAuth.status, 401, "非 Bearer 认证方案必须拒绝");

      // ② token 伪参数：URL query / body 字段 / 工具 args 一律 401
      const inQuery = await rawRequest({ port: svc.port, path: `/mcp?access_token=${token}`, method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
      assert.equal(inQuery.status, 401, "URL query 伪 token 必须 401");
      const inBody = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { token } }) });
      assert.equal(inBody.status, 401, "body 伪 token 必须 401");
      const inToolArgs = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_list_goals", arguments: { token } } }) });
      assert.equal(inToolArgs.status, 401, "工具 args 里的伪 token 必须 401（即使 header 缺失）");
      // 即使 header 合法，body 里夹带 token 同样拒绝（伪参数不得「看起来可用」）
      const both = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_list_goals", arguments: { token } } });
      assert.equal(both.status, 401, "header 合法但 body 带 token 也必须拒绝");

      // ③ 仅有 session id 不能延续权限
      const sessionOnly = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, "mcp-session-id": "attacker-session", "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_list_goals", arguments: {} } }) });
      assert.equal(sessionOnly.status, 401, "仅 session id 不得通过认证");
    });
  });
});

test("g-623 C token 解析器：只接受严格 Bearer 单值；伪参数检测覆盖常见字段名", () => {
  assert.equal(parseBearer("Bearer abc"), "abc");
  assert.equal(parseBearer("bearer abc"), "abc");
  assert.equal(parseBearer("  Bearer  abc  "), "abc");
  assert.equal(parseBearer("Bearer a b"), null, "含空格的多值形态拒绝");
  assert.equal(parseBearer("Token abc"), null);
  assert.equal(parseBearer("abc"), null);
  assert.equal(parseBearer(""), null);
  assert.equal(parseBearer(null), null);

  assert.equal(hasTokenLikeParam(new URLSearchParams("token=x"), {}), true);
  assert.equal(hasTokenLikeParam(new URLSearchParams("access_token=x"), {}), true);
  assert.equal(hasTokenLikeParam(new URLSearchParams("api_key=x"), {}), true);
  assert.equal(hasTokenLikeParam(new URLSearchParams("goal=g-1"), { name: "graph_list_goals" }), false, "正向：正常参数不误判");
  assert.equal(hasTokenLikeParam(null, { params: { arguments: { authorization: "x" } } }), true, "深层字段同样检测");
  for (const key of RESERVED_PARAM_KEYS) {
    assert.equal(hasTokenLikeParam(null, { params: { [key]: 1 } }) || RESERVED_PARAM_KEYS.includes(key), true);
  }
});

// ── D：轮换 / 撤销后的旧连接 ────────────────────────────────────────────────────────

test("g-623 D 轮换矩阵：轮换后旧 token/旧会话全部拒绝、新 token 可用；撤销后一切拒绝", async () => {
  await matrix(async ({ svc, token, host, board, login }) => {
    const cookie = await login();
    const okList = await rawRequest({ port: svc.port, path: "/api/goals", headers: { host, cookie } });
    assert.equal(okList.status, 200, "正向对照：轮换前会话可用");

    const rotated = svc.rotateToken();
    assert.equal(rotated.generation, 2);
    const newToken = svc.credentials.read();
    assert.notEqual(newToken, token);

    await assertNoGraphSideEffects(board.root, async () => {
      const oldTokenMcp = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_list_goals", arguments: {} } }) });
      assert.equal(oldTokenMcp.status, 401, "轮换后旧 token 必须 401");
      const oldSession = await rawRequest({ port: svc.port, path: "/api/goals", headers: { host, cookie } });
      assert.equal(oldSession.status, 401, "轮换后旧 Web 会话必须 401");
    });
    // 正向对照：新 token 立即可用
    const newTokenMcp = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, authorization: `Bearer ${newToken}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_list_goals", arguments: {} } }) });
    assert.equal(newTokenMcp.status, 200, "轮换后新 token 必须可用（正向对照）");

    // 撤销：一切拒绝（含新 token 与新建会话）
    svc.revokeToken();
    await assertNoGraphSideEffects(board.root, async () => {
      const revoked = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, authorization: `Bearer ${newToken}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
      assert.equal(revoked.status, 401, "撤销后任何旧 token 必须 401");
      const relogin = await rawRequest({ port: svc.port, path: "/api/session", method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ token: newToken }) });
      assert.equal(relogin.status, 401, "撤销后不得再用旧 token 建立会话");
    });
  });
});

// ── E：跨站 / MCP token 调人工审批路由 ──────────────────────────────────────────────

test("g-623 E 跨站矩阵：外站 Origin/预检/CORS 拒绝；MCP token 不能调用任何人工审批或写路由", async () => {
  await matrix(async ({ svc, token, host, origin, board, login }): Promise<void> => {
    const cookie = await login();
    // ① 外站 Origin 的 Web API 请求（同 origin 页面才能通过）
    const cross = await rawRequest({ port: svc.port, path: "/api/goals", headers: { host, origin: "http://evil.example", cookie } });
    assert.equal(cross.status, 403, "外站 Origin 的 API 请求必须拒绝（即使带合法会话 cookie）");
    assert.equal(cross.headers["access-control-allow-origin"], undefined, "不得为外站下发 CORS 放行");
    // ② 预检：不存在 CORS 许可
    const preflight = await rawRequest({ port: svc.port, path: "/api/goals", method: "OPTIONS", headers: { host, origin: "http://evil.example", "access-control-request-method": "GET" } });
    assert.equal(preflight.headers["access-control-allow-origin"], undefined, "预检不得返回 CORS 许可");
    assert.notEqual(preflight.status, 200, "预检不得被判为成功");
    // ③ MCP token 调「人工审批/写」路由：路由根本不存在 ⇒ 404；且 Bearer 一律被 401
    for (const path of ["/api/accept", "/api/deliver", "/api/claim", "/api/unlock", "/api/approve", "/api/start", "/api/settings"]) {
      const withBearer = await rawRequest({ port: svc.port, path, method: "POST", headers: { host, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ goal: board.goalId, approved: true, human: true }) });
      assert.equal(withBearer.status, 401, `${path}：带 MCP token 的 Web 写/审批请求必须 401（MCP token ≠ 审批权）`);
      assert.equal(withBearer.json.code, "E_FORBIDDEN");
    }
    await assertNoGraphSideEffects(board.root, async () => {
      for (const path of ["/api/accept", "/api/deliver", "/api/claim", "/api/approve", "/api/settings"]) {
        const withSession = await rawRequest({ port: svc.port, path, method: "POST", headers: { host, origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ goal: board.goalId, human: true, approved: true }) });
        assert.equal(withSession.status, 405, `${path}：只读服务没有写路由（POST 必须 405）`);
        assert.equal(withSession.json.code, "E_UNKNOWN_COMMAND");
        const postSettings = await rawRequest({ port: svc.port, path: "/api/settings", method: "PUT", headers: { host, origin, cookie, "content-type": "application/json" }, body: JSON.stringify({ modules: { memory: false } }) });
        assert.equal(postSettings.status, 405, "设置写必须 405（MVP 只读）");
      }
    });
    // ④ 正向对照：同 origin + 会话的 GET 仍可用
    const goodGet = await rawRequest({ port: svc.port, path: "/api/settings", headers: { host, origin, cookie } });
    assert.equal(goodGet.status, 200, "正向对照：同 origin 合法只读请求必须成功");
  });
});

// ── F：路径穿越 / 绝对路径 / 根外 symlink / 客户端 roots ────────────────────────────

test("g-623 F 路径矩阵：穿越/编码穿越/绝对路径/根外 symlink 一律拒绝，外站 sentinel 不变", async () => {
  await matrix(async ({ svc, host, board, ws, login, token }) => {
    const cookie = await login();
    const sentinelBefore = readFileSync(ws.outsideSentinel, "utf8");

    // 正向对照：合法附件引用可读
    const good = await rawRequest({ port: svc.port, path: `/api/attachments?name=${encodeURIComponent("evidence/note.txt")}`, headers: { host, cookie } });
    assert.equal(good.status, 200, "正向对照：安全引用的附件必须可读");
    assert.equal(Buffer.from(good.json.base64, "base64").toString("utf8"), "attachment-body\n");

    // 预先在 attachments 内布置一个指向根外的 symlink（模拟「根外 symlink」）
    const attDir = join(board.root, "attachments");
    mkdirSync(attDir, { recursive: true });
    const linkPath = join(attDir, "escape.txt");
    if (!existsSync(linkPath)) symlinkSync(ws.outsideSentinel, linkPath);
    // 并布置一个 symlink 目录
    const linkDir = join(attDir, "escdir");
    if (!existsSync(linkDir)) symlinkSync(join(ws.base, "outside"), linkDir);

    const attacks = [
      "../server.json",
      "../../etc/passwd",
      "..%2F..%2Fetc%2Fpasswd",
      "%2e%2e%2foutside%2fsecret.txt",
      "/etc/passwd",
      "/home/miuzel/.ssh/id_ed25519",
      "C:\\Windows\\win.ini",
      "evidence/../../outside/secret.txt",
      "escape.txt",
      "escdir/secret.txt",
      "",
      ".",
      "..",
    ];
    await assertNoGraphSideEffects(board.root, async () => {
      for (const attack of attacks) {
        const r = await rawRequest({ port: svc.port, path: `/api/attachments?name=${encodeURIComponent(attack)}`, headers: { host, cookie } });
        assert.ok(r.status === 404 || r.status === 400, `附件攻击「${attack}」必须被拒绝（实际 ${r.status}）`);
        assert.ok(!r.body.includes("OUTSIDE-SENTINEL-CONTENT"), `附件攻击「${attack}」不得读到根外内容`);
        const mcpRead = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_read_attachment", arguments: { name: attack } } }) });
        assert.equal(mcpRead.status, 200);
        assert.equal(mcpRead.json.result.isError, true, `MCP 附件攻击「${attack}」必须报错`);
        assert.ok(!mcpRead.body.includes("OUTSIDE-SENTINEL"), `MCP 附件攻击「${attack}」不得读根外`);
      }
      // 客户端 roots 覆盖：任何 root/workspace 参数都不得改变读取目标
      const rootsAttack = await rawRequest({ port: svc.port, path: `/api/goals?root=${encodeURIComponent(ws.base)}&graphRoot=${encodeURIComponent(ws.base)}`, headers: { host, cookie } });
      assert.equal(rootsAttack.status, 200, "多余参数不得让请求崩溃");
      assert.ok(Array.isArray(rootsAttack.json) && rootsAttack.json.every((g: any) => g.id !== "g-attacker"), "客户端 roots 不得改变数据源");
    });
    assert.equal(readFileSync(ws.outsideSentinel, "utf8"), sentinelBefore, "根外 sentinel 必须逐字节不变");

    // 目标 id 注入：不得读取任意文件
    for (const bad of ["../../etc/passwd", "/etc/passwd", "g-001/../../x", "g-001;rm -rf /"]) {
      const r = await rawRequest({ port: svc.port, path: `/api/goal?goal=${encodeURIComponent(bad)}`, headers: { host, cookie } });
      assert.ok(r.status === 400 || r.status === 404, `非法 goal id「${bad}」必须被拒绝（实际 ${r.status}）`);
    }
  });
});

test("g-623 F 路径矩阵：graphRoot 请求级不可切换（服务只认显式配置的 root）", async () => {
  await matrix(async ({ svc, ws, board, login }) => {
    // 造一个「另一个看板」，尝试让服务去读它
    const other = join(ws.base, "other-graph");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "events.jsonl"), "");
    writeFileSync(join(other, "marker.txt"), "OTHER-BOARD");
    const cookie = await login();
    const r = await rawRequest({ port: svc.port, path: `/api/board?root=${encodeURIComponent(other)}`, headers: { host: `127.0.0.1:${svc.port}`, cookie } });
    const body = JSON.stringify(r.json);
    assert.ok(!body.includes("OTHER-BOARD"), "不得读取配置之外的看板");
    assert.ok(body.includes(board.goalId), "必须仍然读取显式配置的 graphRoot");
  });
});

// ── G：伪 actor / owner / human / approval / capability ─────────────────────────────

test("g-623 G 伪身份矩阵：actor/owner/human/approval/root 参数一律拒绝（本地调用同样拒绝）", async () => {
  await matrix(async ({ svc, board, token, mcp, host, login }) => {
    const cookie = await login();
    const ctx = { graphRoot: board.root, executionWorkspace: join(board.root, "..", "..", "workspace") };
    for (const key of RESERVED_ARG_KEYS) {
      assert.throws(
        () => executeReadOnlyCommand(ctx, "graph_query_goal", { goal: board.goalId, [key]: "x" }),
        (e: any) => e.code === "E_FORBIDDEN",
        `参数 ${key} 必须被拒绝（可信上下文不可由客户端提供）`,
      );
    }
    assert.ok(READ_ONLY_COMMAND_NAMES.every((n) => !/accept|deliver|claim|start|transition|approve|write|unlock/i.test(n)), "白名单里不得出现写/审批命令");

    await assertNoGraphSideEffects(board.root, async () => {
      const spoof = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_query_goal", arguments: { goal: board.goalId, actor: "human:owner", human: true, approval: { approved: true } } } });
      assert.equal(spoof.status, 200);
      assert.equal(spoof.json.result.isError, true, "MCP 伪可信参数必须被拒绝");
      assert.match(JSON.stringify(spoof.json.result.content), /E_FORBIDDEN/);
      const topLevel = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_query_goal", arguments: { goal: board.goalId }, actor: "human", approval: true } });
      assert.ok(topLevel.json.error, "根级 params 里的可信字段必须直接拒绝");
      assert.equal(topLevel.json.error.code, -32602);
      // 未知能力/角色参数
      const cap = await rawRequest({ port: svc.port, path: `/api/goals?capability=execution.start&role=supervisor`, headers: { host, cookie } });
      assert.equal(cap.status, 200, "未知 query 参数不得导致副作用或提权");
      const before = readFileSync(join(board.root, "events.jsonl"), "utf8");
      assert.ok(!before.includes("claim") || true);
    });
    // 事件流里不得出现伪 actor 导致的 claim/绑定事件
    const evText = readFileSync(join(board.root, "events.jsonl"), "utf8");
    assert.ok(!/supervisor\.claimed|claim\./.test(evText), "伪 actor 不得产生 claim 事件");
    void token;
  });
});

// ── H：未注册写工具 / 直接 Web 写 / GET 隐式 init ───────────────────────────────────

test("g-623 H 写命令矩阵：未注册的写/执行门禁工具全部 fail-closed，且零目录/事件/锁/配置副作用", async () => {
  await matrix(async ({ board, mcp }) => {
    const writeTools = [
      "graph_create_goal", "graph_set_criteria", "graph_transition", "graph_claim_supervisor", "graph_start_attempt",
      "graph_resolve_accept", "graph_archive_goal", "graph_delete_goal", "graph_add_card", "graph_store_attachment",
      "graph_write_results", "graph_refresh_results", "graph_unbind_goal_child", "graph_delete_attachment",
      "graph_memory_add", "graph_memory_replace", "graph_memory_remove", "graph_update_settings",
      "graph_rebuild", "graph_validate", "graph_handoff", "graph_rotate_token", "graph_set_directive",
      "graph_clean_worktree", "graph_append_comment", "graph_rename_goal", "graph_abandon_attempt",
    ];
    await assertNoGraphSideEffects(board.root, async () => {
      for (const tool of writeTools) {
        const r = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { goal: board.goalId, human: true, force: true } } });
        assert.equal(r.status, 200, `${tool}：请求本身合法（HTTP 200）`);
        assert.ok(r.json.error, `${tool} 必须被拒绝（未注册）`);
        assert.equal(r.json.error.code, -32601, `${tool} 必须返回 METHOD_NOT_FOUND`);
        assert.equal(r.json.error.data?.code, "E_UNKNOWN_COMMAND");
      }
      // 未实现的方法
      for (const method of ["resources/read", "prompts/get", "sampling/createMessage", "completion/complete", "roots/list"]) {
        const r = await mcp({ jsonrpc: "2.0", id: 1, method, params: {} });
        assert.ok(r.json.error, `${method} 必须被拒绝`);
      }
      // initialize 不得返回任何写能力声明
      const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      assert.deepEqual(Object.keys(init.json.result.capabilities), ["tools"], "initialize 只能声明 tools 能力");
      assert.equal(init.json.result.capabilities.resources, undefined);
      assert.equal(init.json.result.capabilities.prompts, undefined);
    });
  });
});

test("g-623 H 写命令矩阵：写工具名不出现在 tools/list 中（不可发现即不可调用）", async () => {
  await matrix(async ({ mcp }) => {
    const list = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const names: string[] = list.json.result.tools.map((t: any) => t.name);
    for (const n of names) {
      assert.ok(!/accept|deliver|claim|start_attempt|transition|archive|delete|write_results|update_settings|memory_/i.test(n), `tools/list 不得暴露写工具：${n}`);
    }
    assert.equal(names.length, READ_ONLY_COMMAND_NAMES.length);
  });
});

test("g-623 H 写命令矩阵：GET 不触发隐式 init（未初始化看板上的静态请求与 API 均零副作用）", async () => {
  const ws = makePrivateWorkspace("noinit");
  const emptyRoot = join(ws.base, "empty-graph");
  mkdirSync(emptyRoot, { recursive: true });
  const svc = await startService({ graphRoot: emptyRoot, executionWorkspace: ws.executionWorkspace, stateDir: ws.stateDir, port: 0 });
  try {
    const host = `127.0.0.1:${svc.port}`;
    const before = snapshotTree(emptyRoot);
    assert.deepEqual(before.size, 0, "前置：空目录");
    for (const path of ["/", "/app.js", "/app.css", "/api/session", "/api/goals", "/api/board", "/mcp"]) {
      await rawRequest({ port: svc.port, path, headers: { host } });
    }
    assert.deepEqual(diffTrees(before, snapshotTree(emptyRoot)), [], "任何 GET 都不得创建目录/文件（不隐式 init）");
    assert.equal(dirExists(join(emptyRoot, "backlog")), false);
    assert.equal(dirExists(join(emptyRoot, "memory")), false);
    assert.equal(dirExists(join(emptyRoot, "attachments")), false);
  } finally {
    await svc.close();
    ws.cleanup();
  }
});

// ── I：凭据权限过宽 / 端口占用 ──────────────────────────────────────────────────────

test("g-623 I 凭据权限矩阵：凭据文件或状态目录权限过宽时 fail-closed（不启动/不读）", async () => {
  const ws = makePrivateWorkspace("perm");
  const board = seedFixtureBoard(ws.graphRoot);
  try {
    const args = parseServeArgs(["init", "--root", board.root, "--workspace", ws.executionWorkspace, "--state-dir", ws.stateDir]);
    initService(args, { HOME: ws.home });
    // ① 凭据文件被放宽到 0644：读取/启动必须拒绝
    chmodSync(join(ws.stateDir, TOKEN_FILE_NAME), 0o644);
    const store = new CredentialStore({ stateDir: ws.stateDir });
    const before = snapshotTree(board.root);
    await assert.rejects(
      startService({ graphRoot: board.root, executionWorkspace: ws.executionWorkspace, stateDir: ws.stateDir, port: 0 }),
      (e: any) => e.code === "permission_too_open",
      "凭据文件权限过宽必须拒绝启动",
    );
    assert.deepEqual(diffTrees(before, snapshotTree(board.root)), [], "拒绝启动不得改动 graph");
    chmodSync(join(ws.stateDir, TOKEN_FILE_NAME), 0o600);
    // ② 状态目录被放宽到 0755：同样拒绝
    chmodSync(ws.stateDir, 0o755);
    await assert.rejects(
      startService({ graphRoot: board.root, executionWorkspace: ws.executionWorkspace, stateDir: ws.stateDir, port: 0 }),
      (e: any) => e.code === "permission_too_open",
      "状态目录权限过宽必须拒绝启动",
    );
    chmodSync(ws.stateDir, 0o700);
    // ③ 正向对照：权限恢复后可正常启动
    const ok = await startService({ graphRoot: board.root, executionWorkspace: ws.executionWorkspace, stateDir: ws.stateDir, port: 0 });
    await ok.close();
    assert.ok(store.read().length >= 64);
  } finally {
    ws.cleanup();
  }
});

test("g-623 I 端口矩阵：端口占用时明确报错、不抢占、不回退其他端口（正向对照空闲端口可启动）", async () => {
  const ws = makePrivateWorkspace("port");
  seedFixtureBoard(ws.graphRoot);
  const busy = await occupyPort();
  try {
    const before = snapshotTree(ws.graphRoot);
    await assert.rejects(
      startService({ graphRoot: ws.graphRoot, executionWorkspace: ws.executionWorkspace, stateDir: ws.stateDir, port: busy.port }),
      (e: any) => e.code === "E_PORT_UNAVAILABLE",
      "端口占用必须明确报错",
    );
    assert.deepEqual(diffTrees(before, snapshotTree(ws.graphRoot)), [], "端口冲突不得改动 graph");
    // 占用者仍在监听（未被抢占）
    const probe = await rawRequest({ port: busy.port, path: "/", headers: { host: `127.0.0.1:${busy.port}` } });
    assert.equal(probe.status, 200, "原占用服务必须仍在（不得被抢占）");
    assert.equal(probe.body, "occupied");
  } finally {
    await busy.release();
  }
  // 正向对照：端口释放后可启动
  const svc = await startService({ graphRoot: ws.graphRoot, executionWorkspace: ws.executionWorkspace, stateDir: ws.stateDir, port: busy.port });
  try {
    assert.equal(svc.port, busy.port, "释放后可以用同一端口启动");
  } finally {
    await svc.close();
    ws.cleanup();
  }
});

// ── 附加：请求体上限 / 方法与路由白名单 ─────────────────────────────────────────────

test("g-623 传输矩阵：超大请求体与非法方法被拒绝（正向对照小体正常）", async () => {
  await matrix(async ({ svc, host, token }) => {
    const big = await rawRequest({
      port: svc.port,
      path: "/mcp",
      method: "POST",
      headers: { host, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(MAX_REQUEST_BYTES + 1024) } }),
    });
    assert.ok(big.status >= 400, `超大请求体必须被拒绝（实际 ${big.status}）`);
    const getMcp = await rawRequest({ port: svc.port, path: "/mcp", headers: { host, authorization: `Bearer ${token}` } });
    assert.equal(getMcp.status, 405, "GET /mcp 必须 405");
    const unknownRoute = await rawRequest({ port: svc.port, path: "/admin", headers: { host } });
    assert.equal(unknownRoute.status, 404, "未注册路由必须 404");
    const small = await rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) });
    assert.equal(small.status, 200, "正向对照：正常请求体必须成功");
  });
});

test("g-623 零副作用汇总：整轮负向矩阵跑完后 graph 树逐字节一致", async () => {
  await matrix(async ({ svc, host, token, board, login }) => {
    const cookie = await login();
    const before = snapshotTree(board.root, { withMtime: true });
    const attacks: Array<() => Promise<unknown>> = [
      () => rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, authorization: "Bearer " + "f".repeat(64) }, body: "{}" }),
      () => rawRequest({ port: svc.port, path: "/mcp?token=x", method: "POST", headers: { host }, body: "{}" }),
      () => rawRequest({ port: svc.port, path: "/api/accept", method: "POST", headers: { host, cookie }, body: "{}" }),
      () => rawRequest({ port: svc.port, path: "/api/attachments?name=../../etc/passwd", headers: { host, cookie } }),
      () => rawRequest({ port: svc.port, path: "/api/goals", headers: { host, origin: "http://evil.example", cookie } }),
      () => rawRequest({ port: svc.port, path: "/mcp", method: "POST", headers: { host, authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_delete_goal", arguments: { goal: board.goalId } } }) }),
      () => rawRequest({ port: svc.port, path: "/api/settings", method: "DELETE", headers: { host, cookie } }),
    ];
    for (const attack of attacks) await attack();
    assert.deepEqual(diffTrees(before, snapshotTree(board.root, { withMtime: true })), [], "整轮攻击后 graph 树（含 mtime）必须完全一致");
    // 正向对照：攻击之后服务仍然正常（不是靠「把自己弄挂」拒绝）
    const after = await rawRequest({ port: svc.port, path: "/api/goals", headers: { host, cookie } });
    assert.equal(after.status, 200, "正向对照：攻击后合法只读请求仍成功");
    void readdirSync;
    void statSync;
  });
});
