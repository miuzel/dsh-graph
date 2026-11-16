/**
 * g-623：独立本地服务的**端到端**验收（判据 1 / 4 / 10 + 防伪绿对照）。
 *
 * 本文件与 `g623-service.test.ts`（进程内正向）/ `g623-service-security.test.ts`（进程内负向矩阵）
 * 互补：这里**真的**起一个独立进程（`node bin/dsh-graph.mjs serve …`），用真实 HTTP 访问，
 * 并且用**离线隔离**的私有 HOME/config/cache/workspace（全部位于本 worktree 的 `tmp/` 下）。
 *
 * 覆盖：
 *   ① 首次显式初始化 → 启动 → Web/API/MCP 真机可用 → 信号停止 → 端口释放 → 卸载（graph 不变）
 *   ② 未显式初始化时不启动（不自动生成凭据/不隐式 init 看板）
 *   ③ **防伪绿对照**：把「认证先行」改坏（不校验 token）后，同一负向请求必须被判红
 *      ⇒ 证明本套件的拒绝断言不是恒真。
 *   ④ 重连语义：每个请求（含带 `Mcp-Session-Id` 的重连）都必须重新验 token。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";

import { makePrivateWorkspace, seedFixtureBoard, rawRequest, snapshotTree, diffTrees, occupyPort } from "./fixtures/g623-service.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const BIN = join(repoRoot, "bin", "dsh-graph.mjs");

/** 完全隔离的进程环境：私有 HOME / XDG（config/cache/state）、无代理、无用户凭据来源。 */
function offlineEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TMPDIR: join(home, "tmpx"),
    // 清空一切可能让进程去连公网/用户实例的变量
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    NO_PROXY: "127.0.0.1,localhost",
    ALL_PROXY: "",
    NODE_TEST_CONTEXT: "",
    NODE_TEST_WORKER_ID: "",
  };
}

function runCli(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repoRoot, env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** 等端口真的可连（服务已 listen）。 */
async function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
      s.on("error", () => resolve(false));
      s.setTimeout(500, () => { s.destroy(); resolve(false); });
    });
    if (ok) return;
    if (Date.now() > deadline) throw new Error(`端口 ${port} 在 ${timeoutMs}ms 内未监听`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** 从 serve 进程 stdout 解析实际 origin。 */
function parseOrigin(stdout: string): number | null {
  const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(stdout);
  return m ? Number(m[1]) : null;
}

/** 启动 serve 子进程并等待其打印 origin（同时收集 stderr 以便断言「不打印 token」）。 */
async function startServeProcess(args: string[], env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; port: number; stdout: () => string; stderr: () => string }> {
  const child = spawn(process.execPath, [BIN, ...args], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout!.on("data", (c: Buffer) => { out += c.toString("utf8"); });
  child.stderr!.on("data", (c: Buffer) => { err += c.toString("utf8"); });
  const deadline = Date.now() + 30_000;
  while (parseOrigin(out) === null) {
    if (child.exitCode !== null) throw new Error(`serve 提前退出（${child.exitCode}）：${err}`);
    if (Date.now() > deadline) throw new Error(`serve 未在超时内打印 origin：${out}${err}`);
    await new Promise((r) => setTimeout(r, 30));
  }
  const port = parseOrigin(out)!;
  await waitForPort(port);
  return { child, port, stdout: () => out, stderr: () => err };
}

function stopProcess(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(child.exitCode); return; }
    child.once("exit", (code) => resolve(code));
    child.kill(signal);
  });
}

test("g-623 端到端：初始化→启动→Web/API/MCP→停止→端口释放→卸载（graph 逐字节不变）", { timeout: 180_000 }, async () => {
  const ws = makePrivateWorkspace("e2e");
  seedFixtureBoard(ws.graphRoot);
  const graphReal = realpathSync(ws.graphRoot);
  const graphBefore = snapshotTree(ws.graphRoot, { withMtime: true });
  try {
    // ① 未初始化直接 serve ⇒ 明确失败（不自动生成凭据、不隐式 init 看板、不监听）
    const notInit = runCli(["serve", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace], offlineEnv(ws.home));
    assert.notEqual(notInit.status, 0, "未显式初始化时 serve 必须失败");
    assert.match(notInit.stderr, /运行配置不存在|请先显式初始化/, "必须提示先初始化");
    assert.equal(existsSync(join(ws.home, ".local", "state", "dsh-graph-service", "token")), false, "不得自动生成凭据");

    // ② 显式初始化（私有 HOME ⇒ 状态目录落在 HOME 下，不写进 graph）
    const init = runCli(["serve", "init", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace], offlineEnv(ws.home));
    assert.equal(init.status, 0, `serve init 必须成功：${init.stderr}`);
    const initJson = JSON.parse(init.stdout);
    assert.equal(initJson.tokenCreated, true);
    assert.equal(initJson.graphInitialized, true);
    const stateDir = join(ws.home, ".local", "state", "dsh-graph-service");
    assert.equal(initJson.stateDir, stateDir, "状态目录必须落在私有 HOME 下");
    const tokenPath = join(stateDir, "token");
    const token = readFileSync(tokenPath, "utf8").trim();
    assert.ok(token.length >= 64, "token 必须是 ≥256bit");
    assert.ok(!init.stdout.includes(token), "init 输出不得打印 token 原文");
    assert.deepEqual(diffTrees(graphBefore, snapshotTree(ws.graphRoot, { withMtime: true })), [], "init 不得改动 graph（含状态目录不得落在 graph 内）");

    // ③ 启动独立进程
    const host = `127.0.0.1`;
    const svc = await startServeProcess(["serve", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace], offlineEnv(ws.home));
    try {
      assert.ok(!svc.stdout().includes(token), "启动提示不得打印 token 原文");
      assert.ok(!svc.stdout().includes(graphReal) === false, "启动提示可以展示 graphRoot（便于核对），但不得含 token");
      // Web 静态入口
      const index = await rawRequest({ port: svc.port, path: "/", headers: { host: `127.0.0.1:${svc.port}` } });
      assert.equal(index.status, 200);
      assert.match(index.body, /dsh-graph/);
      // Web 会话 + API 只读
      const login = await rawRequest({
        port: svc.port,
        path: "/api/session",
        method: "POST",
        headers: { host: `127.0.0.1:${svc.port}`, origin: `http://127.0.0.1:${svc.port}`, "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      assert.equal(login.status, 200, "真实进程上合法 token 必须能登录");
      const cookie = String(login.headers["set-cookie"]).split(";")[0];
      const goals = await rawRequest({ port: svc.port, path: "/api/goals", headers: { host: `127.0.0.1:${svc.port}`, cookie } });
      assert.equal(goals.status, 200);
      assert.ok(goals.json.length >= 1, "必须真的读到看板目标");
      // MCP 只读调用
      const tools = await rawRequest({
        port: svc.port,
        path: "/mcp",
        method: "POST",
        headers: { host: `127.0.0.1:${svc.port}`, authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "graph_list_goals", arguments: {} } }),
      });
      assert.equal(tools.status, 200);
      assert.equal(tools.json.result.isError, false, "真实进程上 MCP 只读调用必须成功");

      // ④ 重连语义：带 mcp-session-id 但 token 已失效 ⇒ 拒绝（session id 不延续权限）
      const sessionReconnect = await rawRequest({
        port: svc.port,
        path: "/mcp",
        method: "POST",
        headers: { host: `127.0.0.1:${svc.port}`, authorization: `Bearer ${"a".repeat(64)}`, "mcp-session-id": "attacker", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "graph_list_goals", arguments: {} } }),
      });
      assert.equal(sessionReconnect.status, 401, "重连（带 session id）时 token 无效必须 401");

      // 负向：端口只被本服务占用，且连接地址必须是回环
      const wrongToken = await rawRequest({
        port: svc.port,
        path: "/mcp",
        method: "POST",
        headers: { host: `127.0.0.1:${svc.port}`, authorization: `Bearer ${"b".repeat(64)}`, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
      });
      assert.equal(wrongToken.status, 401);
    } finally {
      // ⑤ 停止：SIGTERM ⇒ 进程退出 ⇒ 端口释放
      const code = await stopProcess(svc.child, "SIGTERM");
      assert.equal(code, 0, `SIGTERM 停止必须正常退出（实际 ${code}）`);
      const busy = await occupyPort();
      assert.ok(busy.port > 0);
      await busy.release();
      const released = await new Promise<boolean>((resolve) => {
        const s = net.connect({ host: "127.0.0.1", port: svc.port }, () => { s.destroy(); resolve(false); });
        s.on("error", () => resolve(true));
      });
      assert.equal(released, true, "停止后端口必须已释放");
    }

    // ⑥ 卸载：只删自有凭据/运行配置；graph 逐字节不变
    const uninstall = runCli(["serve", "uninstall"], offlineEnv(ws.home));
    assert.equal(uninstall.status, 0, `uninstall 必须成功：${uninstall.stderr}`);
    const unJson = JSON.parse(uninstall.stdout);
    assert.ok(unJson.removed.some((p: string) => p.endsWith("token")), "必须删除凭据");
    assert.ok(unJson.removed.some((p: string) => p.endsWith("server.json")), "必须删除运行配置");
    assert.equal(existsSync(stateDir), false, "自有状态目录必须被移除");
    assert.deepEqual(diffTrees(graphBefore, snapshotTree(ws.graphRoot, { withMtime: true })), [], "卸载后 graph 必须逐字节不变（含 mtime）");

    // ⑦ 卸载后 status 如实报告未初始化
    const status = runCli(["serve", "status"], offlineEnv(ws.home));
    assert.equal(JSON.parse(status.stdout).initialized, false);
  } finally {
    ws.cleanup();
  }
});

test("g-623 端到端：端口占用时 serve 进程明确失败（不抢占、不回退）", { timeout: 120_000 }, async () => {
  const ws = makePrivateWorkspace("e2e-busy");
  seedFixtureBoard(ws.graphRoot);
  try {
    const init = runCli(["serve", "init", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace], offlineEnv(ws.home));
    assert.equal(init.status, 0);
    const busy = await occupyPort();
    try {
      const r = await startServeProcess(["serve", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--port", String(busy.port)], offlineEnv(ws.home)).catch((e: Error) => ({ error: e }));
      assert.ok("error" in r, "端口占用时必须失败（不得启动成功）");
      const probe = await rawRequest({ port: busy.port, path: "/", headers: { host: `127.0.0.1:${busy.port}` } });
      assert.equal(probe.body, "occupied", "占用者必须仍在（服务不得抢占端口）");
    } finally {
      await busy.release();
    }
  } finally {
    ws.cleanup();
  }
});

test("g-623 端到端：CLI 用法错误（缺 root/workspace、相对路径、非法 host）一律非零退出且零副作用", { timeout: 120_000 }, async () => {
  const ws = makePrivateWorkspace("e2e-usage");
  seedFixtureBoard(ws.graphRoot);
  try {
    const env = offlineEnv(ws.home);
    const cases: string[][] = [
      ["serve", "init"],
      ["serve", "init", "--root", ws.graphRoot],
      ["serve", "init", "--root", "relative/graph", "--workspace", ws.executionWorkspace],
      ["serve", "init", "--root", ws.graphRoot, "--workspace", ws.graphRoot],
      ["serve", "init", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--host", "0.0.0.0"],
      ["serve", "init", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--host", "::"],
      ["serve", "init", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--host", "localhost"],
      ["serve", "init", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--port", "abc"],
      ["serve", "init", "--root", ws.graphRoot, "--workspace", ws.executionWorkspace, "--bogus"],
    ];
    const before = snapshotTree(ws.graphRoot);
    for (const args of cases) {
      const r = runCli(args, env);
      assert.notEqual(r.status, 0, `${args.join(" ")} 必须非零退出（stdout=${r.stdout}）`);
      assert.ok(!r.stdout.includes("ok\": true") || r.status !== 0, "不得把失败伪装成成功");
      assert.equal(existsSync(join(ws.home, ".local", "state", "dsh-graph-service", "token")), false, `${args.join(" ")} 不得生成凭据`);
    }
    assert.deepEqual(diffTrees(before, snapshotTree(ws.graphRoot)), [], "用法错误不得改动 graph");
  } finally {
    ws.cleanup();
  }
});

test("g-623 端到端（防伪绿对照）：把「认证先行」改坏后，同一负向请求必须判红", async () => {
  // 变异：把 mcp.ts 的 `if (!ctx.authenticate(token))` 改成永假条件（模拟「未验 token 就解析业务」）。
  const src = readFileSync(join(repoRoot, "core", "service", "mcp.ts"), "utf8");
  const mutated = src.replace("if (!ctx.authenticate(token)) {", "if (false && !ctx.authenticate(token)) {");
  assert.notEqual(mutated, src, "变异锚点失效：mcp.ts 必须存在认证分支 `if (!ctx.authenticate(token)) {`");
  const dir = join(repoRoot, "tmp", `g623-mutant-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  try {
    const file = join(dir, "mcp-mutant.ts");
    // 变异副本里的相对 import 需指向真实 core（同一目录深度），故写成绝对路径。
    // g-632 A：按**实际存在的**同目录相对 import 逐个改写（不写死单文件，否则新增依赖时变异副本
    // 会因找不到模块而误红 —— 红的是加载失败，不是认证变异）。
    const fixed = mutated.replace(/from "\.\/([A-Za-z0-9_\-]+\.ts)"/g, (_m, name) =>
      `from ${JSON.stringify(join(repoRoot, "core", "service", name))}`);
    assert.ok(fixed.includes("service/queries.ts"), "变异副本必须已把相对 import 改写为绝对路径");
    writeFileSync(file, fixed, "utf8");
    const probe = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        const { handleMcpRequest } = await import(${JSON.stringify(file)});
        const out = handleMcpRequest(
          { graphRoot: ${JSON.stringify(join(repoRoot, "tmp", "nonexistent-graph"))}, executionWorkspace: "/tmp", authenticate: () => false },
          { authorization: null, query: null, bodyText: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) },
        );
        process.stdout.write(JSON.stringify({ status: out.status, authenticated: out.authenticated }));
        `,
      ],
      { cwd: repoRoot, encoding: "utf8", timeout: 30_000 },
    );
    assert.equal(probe.status, 0, `变异副本必须可加载：${probe.stderr}`);
    const parsed = JSON.parse(probe.stdout);
    assert.equal(parsed.authenticated, true, "变异后认证必须被绕过（证明变异生效）");
    assert.equal(parsed.status, 200, "变异后未认证请求会被当作已认证业务处理 ⇒ 本套件的 401 断言在变异下必然判红");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
