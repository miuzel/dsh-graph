/**
 * g-623：独立本地只读服务（Web App + Web API + localhost MCP）的**正向**验收。
 *
 * 本文件证明的是「服务真的能用」——负向拒绝（`g623-service-security.test.ts`）只有在
 * 这些正向对照同时通过时才不是「靠全拒绝蒙对」。
 *
 * 覆盖判据：
 *   1 同进程提供 Web 静态入口 + Web API + MCP；CLI 不承担 UI
 *   2 只绑 127.0.0.1（正向：实际监听地址 + 实际可连通）
 *   3 首次显式初始化 CSPRNG token、私有凭据 0600 / 目录 0700、token 不落 git/graph/配置/日志/URL
 *   5 Web 会话与 MCP token 分离（正向：会话只能由人在 UI 用 token 换取）
 *   6 白名单只读命令全部可用且真的读到 core 数据
 *   7 graphRoot 与 executionWorkspace 分离；未初始化不自动 init/claim
 *   8 浏览器不直接读磁盘（静态 bundle 不含秘密、不含请求路径拼接）
 *
 * 全部测试在 `tmp/g623-*` 私有工作区内运行：私有 HOME/state/graph/workspace，绝不触碰真实看板。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { startService } from "../service/server.ts";
import { parseServeArgs, initService, serviceStatus, uninstallService } from "../service/serve.ts";
import { READ_ONLY_COMMANDS, executeReadOnlyCommand, queryBoard, queryGoal } from "../service/queries.ts";
import { isLoopbackAddress, validateBindHost, ALLOWED_BIND_HOST } from "../service/policy.ts";
import { generateSecret, isWellFormedSecret, CredentialStore, MIN_TOKEN_BITS, TOKEN_FILE_NAME } from "../service/credentials.ts";
import { assertSeparatedRoots, ServiceConfigError, isGraphInitialized } from "../service/config.ts";
import {
  makePrivateWorkspace,
  seedFixtureBoard,
  rawRequest,
  snapshotTree,
  diffTrees,
  dirExists,
} from "./fixtures/g623-service.ts";

/** 启动一个使用私有工作区/夹具看板的服务（每个测试独立端口，0 = 系统分配）。 */
async function withService<T>(
  fn: (ctx: { ws: ReturnType<typeof makePrivateWorkspace>; svc: Awaited<ReturnType<typeof startService>>; board: ReturnType<typeof seedFixtureBoard>; token: string }) => Promise<T>,
): Promise<T> {
  const ws = makePrivateWorkspace("pos");
  const board = seedFixtureBoard(ws.graphRoot);
  const svc = await startService({
    graphRoot: ws.graphRoot,
    executionWorkspace: ws.executionWorkspace,
    stateDir: ws.stateDir,
    port: 0,
    host: "127.0.0.1",
  });
  const token = svc.credentials.read();
  try {
    return await fn({ ws, svc, board, token });
  } finally {
    await svc.close();
    ws.cleanup();
  }
}

// ── 判据 1：同进程三入口 ────────────────────────────────────────────────────────────────

test("g-623 判据1：同一进程同一端口同时提供 Web 静态入口、Web API 与 MCP endpoint", async () => {
  await withService(async ({ svc, token }) => {
    // Web 静态入口（无需认证：页面本身不含数据/秘密）
    const index = await rawRequest({ port: svc.port, path: "/", headers: { host: `127.0.0.1:${svc.port}` } });
    assert.equal(index.status, 200, "GET / 必须返回 200");
    assert.match(String(index.headers["content-type"]), /text\/html/, "GET / 必须是 HTML");
    assert.match(index.body, /dsh-graph 本地看板/, "静态页必须包含看板标题");
    assert.equal(index.headers["access-control-allow-origin"], undefined, "不得下发 CORS 通配");

    // Web API（同 origin 同一端口）
    const api = await rawRequest({ port: svc.port, path: "/api/session", headers: { host: `localhost:${svc.port}` } });
    assert.equal(api.status, 200, "GET /api/session 必须返回 200（同一服务进程）");

    // MCP endpoint（同一端口，另一条路由）
    const mcp = await rawRequest({
      port: svc.port,
      path: "/mcp",
      method: "POST",
      headers: { host: `127.0.0.1:${svc.port}`, authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    });
    assert.equal(mcp.status, 200, "POST /mcp 必须返回 200（同一服务进程）");
    assert.equal(mcp.json?.result?.serverInfo?.name, "dsh-graph-local", "MCP initialize 必须返回本服务标识");

    for (const [label, port] of [["web", svc.port], ["api", svc.port], ["mcp", svc.port]] as const) {
      assert.equal(port, svc.port, `${label} 必须与 Web/MCP 共用同一端口（同进程单端口）`);
    }
  });
});

test("g-623 判据1：CLI adapter 不承担 Web UI（cli 源文件不 import 服务传输层/web-app）", () => {
  const dir = join(import.meta.dirname, "..", "cli");
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    assert.ok(!/from\s+["'][^"']*service\/server\.ts["']/.test(src), `${f} 不得 import service/server.ts（CLI 不承担传输层）`);
    assert.ok(!/from\s+["'][^"']*service\/web-app\.ts["']/.test(src), `${f} 不得 import service/web-app.ts（CLI 不承担 UI）`);
    assert.ok(!/createServer\s*\(/.test(src), `${f} 不得自行创建 HTTP 服务器`);
  }
});

// ── 判据 2：实际只监听 127.0.0.1 ───────────────────────────────────────────────────────

test("g-623 判据2（正向）：服务实际监听 127.0.0.1，且该地址可正常连通", async () => {
  await withService(async ({ svc }) => {
    const addr = svc.server.address() as any;
    assert.equal(addr.address, ALLOWED_BIND_HOST, `实际监听地址必须是 127.0.0.1（实际 ${addr.address}）`);
    assert.ok(isLoopbackAddress(addr.address), "实际监听地址必须是数值回环");
    assert.equal(svc.host, "127.0.0.1");
    assert.match(svc.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const res = await rawRequest({ port: svc.port, path: "/", headers: { host: `127.0.0.1:${svc.port}` } });
    assert.equal(res.status, 200, "回环地址必须真的连通（正向对照）");
    assert.equal(validateBindHost("127.0.0.1").ok, true, "策略层同样接受 127.0.0.1");
  });
});

// ── 判据 3：CSPRNG token + 私有权限 + 不泄漏 ──────────────────────────────────────────

test("g-623 判据3：首次显式初始化用 CSPRNG 生成 ≥256bit token，凭据 0600 / 目录 0700", () => {
  assert.ok(MIN_TOKEN_BITS >= 256, "最小熵不得低于 256 bit");
  const s1 = generateSecret();
  const s2 = generateSecret();
  assert.ok(isWellFormedSecret(s1), "生成的秘密必须是合法形态");
  assert.equal(s1.length, 64, "32 字节 hex = 64 字符");
  assert.notEqual(s1, s2, "两次生成不得相同（真随机源）");

  const ws = makePrivateWorkspace("cred");
  try {
    const args = parseServeArgs(["init", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--state-dir", ws.stateDir]);
    const r1 = initService(args, { HOME: ws.home });
    assert.equal(r1.tokenCreated, true, "首次初始化必须生成 token");
    assert.equal(r1.graphInitialized, false, "夹具此时尚未 init 看板 ⇒ 只报告未初始化");
    const tokenFile = join(ws.stateDir, TOKEN_FILE_NAME);
    const mode = statSync(tokenFile).mode & 0o777;
    assert.equal(mode, 0o600, `凭据文件权限必须是 0600（实际 ${mode.toString(8)}）`);
    const dirMode = statSync(ws.stateDir).mode & 0o777;
    assert.equal(dirMode, 0o700, `状态目录权限必须是 0700（实际 ${dirMode.toString(8)}）`);
    const token = readFileSync(tokenFile, "utf8").trim();
    assert.ok(isWellFormedSecret(token), "落盘 token 必须是 ≥256bit 秘密");
    assert.ok(!r1.tokenFingerprint.includes(token), "指纹不得包含 token 原文");

    // 再次 init 幂等：不重新生成（不静默轮换掉用户已配置的 token）
    const r2 = initService(args, { HOME: ws.home });
    assert.equal(r2.tokenCreated, false, "重复 init 不得重新生成 token");
    assert.equal(readFileSync(tokenFile, "utf8").trim(), token, "重复 init 后 token 原文不变");
  } finally {
    ws.cleanup();
  }
});

test("g-623 判据3：token 不进入 Git / graph / 项目配置 / 日志 / URL query", async () => {
  await withService(async ({ ws, svc, token }) => {
    const published = svc.credentials.fingerprint();
    // ① graph 树与宿主工作区（executionWorkspace）内不得出现 token 原文
    for (const dir of [ws.graphRoot, ws.executionWorkspace]) {
      for (const [rel, entry] of snapshotTree(dir)) {
        if (entry.type !== "file") continue;
        const text = readFileSync(join(dir, rel), "utf8");
        assert.ok(!text.includes(token), `token 不得出现在 ${dir}/${rel}`);
      }
    }
    // ② 服务自有状态目录：**只有凭据文件**可以含 token；其他任何服务状态文件都不得含原文
    for (const name of readdirSync(ws.stateDir)) {
      const text = readFileSync(join(ws.stateDir, name), "utf8");
      if (name === TOKEN_FILE_NAME) {
        assert.equal(text.trim(), token, "凭据文件是 token 的唯一落盘位置");
        continue;
      }
      assert.ok(!text.includes(token), `服务自有状态文件 ${name} 不得包含 token 原文`);
    }
    assert.ok(!existsSync(join(ws.stateDir, "server.json")), "startService 不得镜像项目设置到运行配置（此处尚未 init）");
    // ③ 启动提示/自省只暴露指纹
    assert.ok(published.startsWith("sha256:"), "指纹形态固定");
    assert.ok(!published.includes(token), "指纹不得含原文");
    // ④ URL query 携带 token 必须被拒绝（不进日志也不生效）
    const viaQuery = await rawRequest({
      port: svc.port,
      path: `/mcp?token=${encodeURIComponent(token)}`,
      method: "POST",
      headers: { host: `127.0.0.1:${svc.port}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(viaQuery.status, 401, "URL query 里的 token 必须不被接受");
    assert.ok(!viaQuery.body.includes(token), "拒绝响应不得回显 token");
  });
});

test("g-623 判据3：轮换/撤销后旧 token 立即失效，新 token 可用（无宽限期）", () => {
  const ws = makePrivateWorkspace("rot");
  try {
    const store = new CredentialStore({ stateDir: ws.stateDir });
    const first = store.open();
    assert.equal(first.created, true);
    const oldToken = store.read();
    const rotated = store.rotate();
    assert.equal(rotated.generation, 2, "轮换代际必须 +1");
    assert.equal(store.verify(oldToken), false, "旧 token 必须立即失效");
    const newToken = store.read();
    assert.equal(store.verify(newToken), true, "新 token 必须可用（正向对照）");
    store.revoke();
    assert.equal(store.verify(newToken), false, "撤销后新 token 也必须失效");
    assert.equal(existsSync(join(ws.stateDir, TOKEN_FILE_NAME)), false, "撤销必须删除凭据文件");
  } finally {
    ws.cleanup();
  }
});

// ── 判据 5：Web 会话与 MCP token 分离 ─────────────────────────────────────────────────

test("g-623 判据5：Web 会话由本地 UI 用 token 换取（HttpOnly Cookie），且与 MCP token 分离", async () => {
  await withService(async ({ svc, board, token }) => {
    const host = `127.0.0.1:${svc.port}`;
    const origin = `http://127.0.0.1:${svc.port}`;
    // 未登录 ⇒ API 拒绝
    const anon = await rawRequest({ port: svc.port, path: "/api/goals", headers: { host } });
    assert.equal(anon.status, 401, "无会话的 API 请求必须 401");

    // 登录（同 origin 请求体传 token）
    const login = await rawRequest({
      port: svc.port,
      path: "/api/session",
      method: "POST",
      headers: { host, origin, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    assert.equal(login.status, 200, "合法 token 登录必须成功（正向对照）");
    const setCookie = String(login.headers["set-cookie"] ?? "");
    assert.match(setCookie, /HttpOnly/, "会话 Cookie 必须 HttpOnly");
    assert.match(setCookie, /SameSite=Strict/, "会话 Cookie 必须 SameSite=Strict");
    assert.ok(!login.body.includes(token), "登录响应体不得回显 token");
    const cookie = setCookie.split(";")[0];

    // 带会话 ⇒ 只读查询可用
    const goals = await rawRequest({ port: svc.port, path: "/api/goals", headers: { host, origin, cookie } });
    assert.equal(goals.status, 200, "已登录会话必须可读 /api/goals");
    assert.ok(Array.isArray(goals.json), "返回目标数组");
    assert.ok(goals.json.some((g: any) => g.id === board.goalId), "必须包含夹具目标");

    // MCP token **不能**当作 Web 会话（分离）
    const bearerOnApi = await rawRequest({ port: svc.port, path: "/api/goals", headers: { host, authorization: `Bearer ${token}` } });
    assert.equal(bearerOnApi.status, 401, "Web API 必须拒绝 Bearer（MCP token ≠ Web 会话）");
    assert.equal(bearerOnApi.json?.code, "E_FORBIDDEN");

    // 反过来：Web 会话 Cookie 不能当 MCP token
    const cookieOnMcp = await rawRequest({
      port: svc.port,
      path: "/mcp",
      method: "POST",
      headers: { host, cookie, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    assert.equal(cookieOnMcp.status, 401, "MCP endpoint 必须拒绝仅带 Cookie 的请求（会话 ≠ MCP token）");

    // 轮换后旧会话立即失效
    svc.rotateToken();
    const afterRotate = await rawRequest({ port: svc.port, path: "/api/goals", headers: { host, origin, cookie } });
    assert.equal(afterRotate.status, 401, "轮换后旧 Web 会话必须失效");
    const newToken = svc.credentials.read();
    const relogin = await rawRequest({
      port: svc.port,
      path: "/api/session",
      method: "POST",
      headers: { host, origin, "content-type": "application/json" },
      body: JSON.stringify({ token: newToken }),
    });
    assert.equal(relogin.status, 200, "新 token 可重新登录（正向对照）");
  });
});

// ── 判据 6：白名单只读命令确实读到 core 数据 ─────────────────────────────────────────

test("g-623 判据6：白名单只读命令逐项可用（MCP tools/list 与本地实现同源）", async () => {
  await withService(async ({ svc, board, token }) => {
    const host = `127.0.0.1:${svc.port}`;
    const call = (method: string, params: any = {}) =>
      rawRequest({
        port: svc.port,
        path: "/mcp",
        method: "POST",
        headers: { host, authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });

    const list = await call("tools/list");
    assert.equal(list.status, 200);
    const names = (list.json.result.tools as any[]).map((t) => t.name).sort();
    assert.deepEqual(names, [...READ_ONLY_COMMANDS.map((c) => c.name)].sort(), "tools/list 必须与白名单逐项相同");
    for (const tool of list.json.result.tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} 必须声明 readOnlyHint`);
    }

    const ctx = { graphRoot: board.root, executionWorkspace: join(board.root, "..", "..", "workspace") };
    const checks: Array<[string, (v: any) => void]> = [
      ["graph_list_goals", (v) => assert.ok(v.some((g: any) => g.id === board.goalId))],
      ["graph_list_versions", (v) => assert.ok(v.some((x: any) => x.slug === board.versionSlug))],
      ["graph_query_goal", (v) => { assert.equal(v.meta.id, board.goalId); assert.ok(String(v.description).length > 0); }],
      ["graph_query_criteria", (v) => { assert.equal(v.count, 2); assert.equal(v.items.length, 2); }],
      ["graph_list_cards", (v) => assert.ok(Array.isArray(v) && v.length >= 1, "卡片必须可读")],
      ["graph_query_results", (v) => assert.equal(v.id, board.goalId)],
      ["graph_board", (v) => assert.ok(Array.isArray(v.versions))],
      ["graph_settings", (v) => assert.equal(v.readOnly, true)],
      ["graph_list_attachments", (v) => assert.ok(v.includes(board.attachmentName))],
      ["graph_read_attachment", (v) => { assert.equal(v.name, "evidence/note.txt"); assert.equal(Buffer.from(v.base64, "base64").toString("utf8"), "attachment-body\n"); }],
      ["graph_events", (v) => assert.ok(v.length > 0)],
    ];
    for (const [tool, check] of checks) {
      const args = tool === "graph_read_attachment"
        ? { name: board.attachmentName }
        : ["graph_query_goal", "graph_query_criteria", "graph_list_cards", "graph_query_results"].includes(tool)
          ? { goal: board.goalId }
          : {};
      const r = await call("tools/call", { name: tool, arguments: args });
      assert.equal(r.status, 200, `${tool} 必须被接受`);
      const result = r.json.result;
      assert.equal(result.isError, false, `${tool} 不得报错：${JSON.stringify(result.content)}`);
      check(result.structuredContent);
      // 直接调用（不经 HTTP）也必须是同一实现
      const direct = executeReadOnlyCommand(ctx, tool, args);
      // `generated_at` 是每次投影的当前时刻（非稳定字段），同一性比对时剥掉。
      const strip = (v: any) => {
        const plain = JSON.parse(JSON.stringify(v));
        if (Array.isArray(plain)) return plain.map(strip);
        if (plain && typeof plain === "object") {
          delete plain.generated_at;
          for (const k of Object.keys(plain)) plain[k] = strip(plain[k]);
          return plain;
        }
        return plain;
      };
      assert.deepEqual(strip(direct), strip(result.structuredContent), `${tool} 的 HTTP 与本地调用必须同源同值`);
    }
  });
});

test("g-623 判据6：响应投影脱敏（不含宿主绝对路径/绑定 token/子代理 id）", async () => {
  await withService(async ({ ws, board }) => {
    const ctx = { graphRoot: board.root, executionWorkspace: ws.executionWorkspace };
    const boardView: any = queryBoard(ctx);
    const goal: any = queryGoal(ctx, board.goalId);
    const texts = [JSON.stringify(boardView), JSON.stringify(goal)];
    for (const text of texts) {
      assert.ok(!text.includes(ws.graphRoot), "响应不得包含 graphRoot 绝对路径");
      assert.ok(!text.includes(ws.executionWorkspace), "响应不得包含 executionWorkspace 绝对路径");
      assert.ok(!/"binding_token":/.test(text), "响应不得包含 binding_token");
      assert.ok(!/"child_id":/.test(text), "响应不得包含子代理 child_id");
      assert.ok(!/goalFile|attachmentsDir/.test(text), "响应不得包含磁盘路径字段");
    }
    assert.equal(goal.meta.id, board.goalId, "脱敏不得破坏业务字段");
  });
});

// ── 判据 7：root 分离 + 未初始化不自动 init/claim ─────────────────────────────────────

test("g-623 判据7：graphRoot 与 executionWorkspace 显式分离（相同/互相包含/相对路径一律拒绝）", () => {
  const a = "/tmp/g623-sep-graph";
  assert.throws(() => assertSeparatedRoots(a, a), (e: any) => e instanceof ServiceConfigError && e.code === "root_same");
  assert.throws(() => assertSeparatedRoots(a, `${a}/workspace`), (e: any) => e.code === "root_nested");
  assert.throws(() => assertSeparatedRoots(`${a}/graph`, a), (e: any) => e.code === "root_nested");
  assert.throws(() => assertSeparatedRoots("relative/graph", "/tmp/x"), (e: any) => e.code === "root_relative");
  assert.doesNotThrow(() => assertSeparatedRoots("/tmp/g623-a/graph", "/tmp/g623-b/workspace"), "分离的绝对路径必须通过");

  const ws = makePrivateWorkspace("sep");
  try {
    const same = parseServeArgs(["init", "--root", ws.graphRoot, "--workspace", ws.graphRoot, "--state-dir", ws.stateDir]);
    assert.throws(() => initService(same, { HOME: ws.home }), (e: any) => e.code === "root_same", "init 必须拒绝相同 root");
    assert.equal(existsSync(ws.stateDir), false, "被拒绝的 init 不得留下状态目录");
  } finally {
    ws.cleanup();
  }
});

test("g-623 判据7：未初始化看板不自动 init/claim（只报 E_NOT_INITIALIZED，零目录/事件副作用）", async () => {
  const ws = makePrivateWorkspace("uninit");
  try {
    // graphRoot 目录存在但未 init
    const before = snapshotTree(ws.graphRoot);
    const svc = await startService({
      graphRoot: ws.graphRoot,
      executionWorkspace: ws.executionWorkspace,
      stateDir: ws.stateDir,
      port: 0,
    });
    try {
      assert.equal(isGraphInitialized(ws.graphRoot), false, "前置：看板未初始化");
      const host = `127.0.0.1:${svc.port}`;
      const login = await rawRequest({
        port: svc.port,
        path: "/api/session",
        method: "POST",
        headers: { host, "content-type": "application/json" },
        body: JSON.stringify({ token: svc.credentials.read() }),
      });
      assert.equal(login.status, 200);
      const cookie = String(login.headers["set-cookie"]).split(";")[0];
      const res = await rawRequest({ port: svc.port, path: "/api/goals", headers: { host, cookie } });
      assert.equal(res.status, 409, "未初始化必须返回 409 E_NOT_INITIALIZED");
      assert.equal(res.json.code, "E_NOT_INITIALIZED");
      // MCP 同样拒绝
      const mcp = await rawRequest({
        port: svc.port,
        path: "/mcp",
        method: "POST",
        headers: { host, authorization: `Bearer ${svc.credentials.read()}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_list_goals", arguments: {} } }),
      });
      assert.equal(mcp.json.result.isError, true, "MCP 未初始化同样必须报错");
      assert.match(JSON.stringify(mcp.json.result.content), /E_NOT_INITIALIZED/);
    } finally {
      await svc.close();
    }
    assert.deepEqual(diffTrees(before, snapshotTree(ws.graphRoot)), [], "未初始化查询不得创建目录/事件/配置");
    assert.equal(dirExists(join(ws.graphRoot, "backlog")), false, "不得自动 init 出 backlog/");
    assert.equal(existsSync(join(ws.graphRoot, "events.jsonl")), false, "不得自动写 events.jsonl");
    assert.equal(existsSync(join(ws.graphRoot, "project.yaml")), false, "不得自动写 project.yaml");
  } finally {
    ws.cleanup();
  }
});

// ── 判据 8：设置只读、浏览器不读磁盘 ────────────────────────────────────────────────

test("g-623 判据8：设置只读投影来自 core 既有真源（不复制默认值、不回写配置）", async () => {
  await withService(async ({ ws, board, svc }) => {
    const host = `127.0.0.1:${svc.port}`;
    const login = await rawRequest({
      port: svc.port,
      path: "/api/session",
      method: "POST",
      headers: { host, "content-type": "application/json" },
      body: JSON.stringify({ token: svc.credentials.read() }),
    });
    const cookie = String(login.headers["set-cookie"]).split(";")[0];
    const before = snapshotTree(board.root);
    const res = await rawRequest({ port: svc.port, path: "/api/settings", headers: { host, cookie } });
    assert.equal(res.status, 200);
    assert.equal(res.json.readOnly, true, "设置必须显式标注只读");
    assert.ok(String(res.json.writeDisabledReason).length > 0, "必须说明写控件为何禁用");
    assert.ok(res.json.executor && res.json.defaults && res.json.supervisor, "必须给出与 core 同构的设置投影");
    assert.deepEqual(diffTrees(before, snapshotTree(board.root)), [], "只读设置读取不得改写配置");
    assert.equal(existsSync(join(board.root, "project.yaml")), false, "不得因读取设置而创建 project.yaml");
    void ws;
  });
});

test("g-623 判据8：静态 bundle 不含任何秘密与磁盘路径拼接（浏览器不直接读磁盘）", async () => {
  await withService(async ({ svc }) => {
    const js = await rawRequest({ port: svc.port, path: "/app.js", headers: { host: `127.0.0.1:${svc.port}` } });
    assert.equal(js.status, 200);
    // 注释行不参与判定（代码里出现才危险）：先剥掉 `//` 注释再检查。
    const code = js.body.split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
    for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "require(", "node:fs", "/home/", "C:\\\\"]) {
      assert.ok(!code.includes(forbidden), `静态 bundle 代码不得包含 ${forbidden}`);
    }
    assert.ok(js.body.includes("/api/"), "页面必须只经同 origin API 取数");
    const index = await rawRequest({ port: svc.port, path: "/", headers: { host: `127.0.0.1:${svc.port}` } });
    assert.match(String(index.headers["content-security-policy"]), /default-src 'self'/, "静态页必须带严格 CSP");
    assert.match(String(index.headers["content-security-policy"]), /frame-ancestors 'none'/, "必须拒绝被外站内嵌");
  });
});

test("g-623 判据10（卸载面）：uninstall 只删本服务自有凭据与运行配置，graph 数据不变", () => {
  const ws = makePrivateWorkspace("uninstall");
  try {
    seedFixtureBoard(ws.graphRoot);
    const args = parseServeArgs(["init", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--state-dir", ws.stateDir]);
    const init = initService(args, { HOME: ws.home });
    assert.equal(init.graphInitialized, true, "前置：夹具看板已初始化");
    const graphBefore = snapshotTree(ws.graphRoot);
    const status = serviceStatus(args, { HOME: ws.home });
    assert.equal(status.initialized, true);
    assert.ok(status.tokenFingerprint.startsWith("sha256:"), "status 只暴露指纹");

    const r = uninstallService(args, { HOME: ws.home });
    assert.ok(r.removed.some((p) => p.endsWith(TOKEN_FILE_NAME)), "必须删除凭据");
    assert.ok(r.removed.some((p) => p.endsWith("server.json")), "必须删除运行配置");
    assert.equal(existsSync(ws.stateDir), false, "自有状态目录清空后必须移除");
    assert.deepEqual(diffTrees(graphBefore, snapshotTree(ws.graphRoot)), [], "卸载不得改动 graph 数据（含权限/内容/目录）");
    assert.equal(serviceStatus(args, { HOME: ws.home }).initialized, false, "卸载后不再是已初始化状态");
  } finally {
    ws.cleanup();
  }
});
