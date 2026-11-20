/**
 * g-637：零配置 `goal-graph mcp`（stdio MCP）+ 按工作区自动起/复用本地 Web 看板服务的**自动化测试套件**。
 *
 * 覆盖面（源码入口 `bin/goal-graph.mjs` + 发布入口 `dist/bin/goal-graph.mjs` 真子进程）：
 *  1. 参数解析与防误判（`--root` / `--graph-dir-name` / `--state-dir` / `--read-only` / `--no-web` / `--root mcp info`）；
 *  2. stdio 协议完整性：`initialize`、`notifications/initialized`（无响应）、stdout 纯净仅输出合法 JSON-RPC、stderr 不泄露 token 明文；
 *  3. 工具注册表真源：默认 38 工具（11 只读 + 27 写），`--read-only` 切回 11 只读工具；
 *  4. 写工具真实落盘与非 human actor（`mcp:local-service`）；
 *  5. Human Gate 4 类 fail-closed（`graph_resolve_accept` / `graph_claim_supervisor` / `graph_start_attempt` ⇒ -32601；`transition → delivered` ⇒ E_FORBIDDEN）；
 *  6. 保留参数注入拒绝（`actor/owner/human/approval/allowWrite/writeMode/mode` ⇒ -32602 / E_FORBIDDEN，`--read-only` 无法提权）；
 *  7. 未初始化工作区照常启动且查询返回 `E_NOT_INITIALIZED`（零目录副作用）；
 *  8. 多工作区并发启动自动分配不同随机端口零冲突 + 0600 凭据/runtime.json + `--state-dir` 落入 `graphRoot` fail-closed；
 *  9. 同工作区二次启动复用已存活 Web 服务，且次进程退出不误杀主服务与 `runtime.json`；
 * 10. 主进程 `stdin` 关闭后自启 Web 服务自动退出、端口释放、`runtime.json` 清理、无僵尸进程。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../cli/args.ts";
import { init, createGoal } from "../ops.ts";
import { READ_ONLY_COMMAND_NAMES } from "../service/queries.ts";
import { HUMAN_GATE_TOOLS, MCP_WRITE_ACTOR, WRITE_MODE_COMMAND_NAMES } from "../service/write-commands.ts";
import {
  McpUsageError,
  WORKSPACE_RUNTIME_FILE,
  parseMcpArgs,
  probeWorkspaceWebService,
  workspaceStateDir,
} from "../service/stdio-mcp.ts";

const repoRoot = join(import.meta.dirname, "../..");
const SRC_BIN = join(repoRoot, "bin", "goal-graph.mjs");
const DIST_BIN = join(repoRoot, "dist", "bin", "goal-graph.mjs");

interface StdioClient {
  child: ChildProcessWithoutNullStreams;
  send(msg: unknown): void;
  request(msg: { id: number | string; method: string; params?: unknown }, timeoutMs?: number): Promise<any>;
  waitStderr(pattern: RegExp, timeoutMs?: number): Promise<string>;
  closeAndWait(timeoutMs?: number): Promise<{ code: number | null; stderr: string; rawStdout: string }>;
  stderrText(): string;
}

function spawnMcp(binPath: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv }): StdioClient {
  const child = spawn(process.execPath, [binPath, "mcp", ...args], {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let rawStdout = "";
  let stdoutBuf = "";
  let stderr = "";
  const lines: string[] = [];
  const lineWaiters: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
  const stderrWaiters: Array<{ pattern: RegExp; resolve: (text: string) => void }> = [];

  child.stdout.on("data", (chunk: Buffer) => {
    const s = chunk.toString("utf8");
    rawStdout += s;
    stdoutBuf += s;
    for (;;) {
      const nl = stdoutBuf.indexOf("\n");
      if (nl < 0) break;
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line === "") continue;
      if (lineWaiters.length > 0) {
        lineWaiters.shift()!.resolve(line);
      } else {
        lines.push(line);
      }
    }
  });

  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
    for (let i = stderrWaiters.length - 1; i >= 0; i--) {
      if (stderrWaiters[i]!.pattern.test(stderr)) {
        const w = stderrWaiters.splice(i, 1)[0]!;
        w.resolve(stderr);
      }
    }
  });

  const nextLine = (timeoutMs = 15_000): Promise<string> => {
    if (lines.length > 0) return Promise.resolve(lines.shift()!);
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = lineWaiters.findIndex((w) => w.resolve === onLine);
        if (idx >= 0) lineWaiters.splice(idx, 1);
        reject(new Error(`等待 stdio MCP 响应超时 (${timeoutMs}ms)；stderr=${stderr}`));
      }, timeoutMs);
      const onLine = (line: string) => {
        clearTimeout(timer);
        resolve(line);
      };
      const onErr = (err: Error) => {
        clearTimeout(timer);
        reject(err);
      };
      lineWaiters.push({ resolve: onLine, reject: onErr });
    });
  };

  child.once("exit", (code) => {
    while (lineWaiters.length > 0) {
      lineWaiters.shift()!.reject(new Error(`MCP 子进程提前退出 (code=${code})；stderr=${stderr}`));
    }
  });

  return {
    child,
    send(msg: unknown) {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    },
    async request(msg, timeoutMs = 15_000) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
      const line = await nextLine(timeoutMs);
      return JSON.parse(line);
    },
    waitStderr(pattern: RegExp, timeoutMs = 15_000) {
      if (pattern.test(stderr)) return Promise.resolve(stderr);
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`等待 stderr 匹配 ${pattern} 超时；实际 stderr=${stderr}`));
        }, timeoutMs);
        stderrWaiters.push({
          pattern,
          resolve: (text) => {
            clearTimeout(timer);
            resolve(text);
          },
        });
      });
    },
    async closeAndWait(timeoutMs = 15_000) {
      const exited = new Promise<number | null>((resolve, reject) => {
        if (child.exitCode !== null) return resolve(child.exitCode);
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`等待 MCP 子进程退出超时 (${timeoutMs}ms)`));
        }, timeoutMs);
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      child.stdin.end();
      const code = await exited;
      return { code, stderr, rawStdout };
    },
    stderrText: () => stderr,
  };
}

function makeTempBoard(prefix: string): { root: string; projectDir: string; graphRoot: string; stateBase: string; goalId: string; cleanup(): void } {
  const root = mkdtempSync(join(tmpdir(), `g637-${prefix}-`));
  const projectDir = join(root, "project");
  const graphRoot = join(projectDir, ".dsh-graph");
  const stateBase = join(root, "state");
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(stateBase, { recursive: true });
  init(graphRoot, { project: "g637-fixture", owner: "human:fixture" });
  const goalId = createGoal(graphRoot, { title: "基线目标", type: "task" });
  return {
    root,
    projectDir,
    graphRoot,
    stateBase,
    goalId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("g-637 ① 参数解析与防误判（parseMcpArgs + parseArgs）", () => {
  assert.deepEqual(parseMcpArgs([]), { readOnly: false, noWeb: false });
  assert.deepEqual(parseMcpArgs(["--read-only", "--no-web", "--root", "/tmp/ws", "--state-dir", "/tmp/st"]), {
    readOnly: true,
    noWeb: true,
    root: "/tmp/ws",
    stateDir: "/tmp/st",
  });
  assert.equal(parseMcpArgs(["--graph-dir-name", "boards/main"]).graphDirName, "boards/main");

  // 负向：互斥/非法值/取值布尔开关/多余位置参数
  assert.throws(() => parseMcpArgs(["--root", "/tmp/a", "--graph-dir-name", "board-a"]), McpUsageError);
  assert.throws(() => parseMcpArgs(["--state-dir", "relative/state"]), McpUsageError);
  assert.throws(() => parseMcpArgs(["--read-only=false"]), McpUsageError);
  assert.throws(() => parseMcpArgs(["--no-web=true"]), McpUsageError);
  assert.throws(() => parseMcpArgs(["--unknown"]), McpUsageError);
  assert.throws(() => parseMcpArgs(["extra-arg"]), McpUsageError);

  // parseArgs 集成：不把 `--root mcp info` 误判成 mcp 命令
  const notMcp = parseArgs(["--root", "mcp", "info"]);
  assert.equal(notMcp.error, null);
  assert.equal(notMcp.args?.command, "info");
  assert.equal(notMcp.args?.root, "mcp");

  const isMcp = parseArgs(["--root", "/tmp/proj", "mcp", "--read-only"]);
  assert.equal(isMcp.error, null);
  assert.equal(isMcp.args?.command, "mcp");
  assert.deepEqual(isMcp.args?.mcpArgv, ["--root", "/tmp/proj", "--read-only"]);
});

test("g-637 ② 真实子进程（源码 + dist）：initialize / notifications 无响应 / 默认 38 工具 / --read-only 11 工具 / 写落盘", async () => {
  const bins: Array<[string, string]> = [["source bin", SRC_BIN]];
  if (existsSync(DIST_BIN)) bins.push(["dist bin", DIST_BIN]);

  for (const [label, binPath] of bins) {
    const fx = makeTempBoard(label.replace(/\s+/g, "-"));
    try {
      // A. 默认模式（写模式 38 工具 + 自动 Web）
      const client = spawnMcp(binPath, ["--state-dir", fx.stateBase], { cwd: fx.projectDir });
      try {
        await client.waitStderr(/\[goal-graph mcp\] web=http:\/\/127\.0\.0\.1:\d+\//);
        const initResp = await client.request({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
        assert.equal(initResp.result.protocolVersion, "2025-06-18", `${label}: protocolVersion`);
        assert.equal(initResp.result.serverInfo.name, "goal-graph-local", `${label}: serverInfo.name`);
        assert.ok(initResp.result.capabilities?.tools, `${label}: capabilities.tools`);
        assert.match(initResp.result.instructions, /http:\/\/127\.0\.0\.1:\d+\//, `${label}: instructions 含本地 Web 看板 URL`);

        // 通知不产出任何响应（发两条 notification 再发 ping，下一条响应必须是 ping 的 id=2）
        client.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        client.send({ jsonrpc: "2.0", method: "notifications/unknown_custom_event", params: {} });
        const pong = await client.request({ id: 2, method: "ping" });
        assert.equal(pong.id, 2, `${label}: notification 不得产生响应`);

        const listResp = await client.request({ id: 3, method: "tools/list" });
        const names: string[] = listResp.result.tools.map((t: any) => t.name);
        assert.equal(names.length, 38, `${label}: 默认必须注册 38 个工具（11 只读 + 27 写）`);
        for (const n of [...READ_ONLY_COMMAND_NAMES, ...WRITE_MODE_COMMAND_NAMES]) {
          assert.ok(names.includes(n), `${label}: 缺少工具 ${n}`);
        }

        // 写工具真实落盘 + 非 human actor 留痕
        const created = await client.request({
          id: 4,
          method: "tools/call",
          params: { name: "graph_create_goal", arguments: { title: "stdio 创建目标", type: "task" } },
        });
        assert.equal(created.result.isError, false, `${label}: graph_create_goal 必须成功`);
        const newId = created.result.structuredContent.goal;
        assert.match(newId, /^g-/);

        const commented = await client.request({
          id: 5,
          method: "tools/call",
          params: { name: "graph_add_comment", arguments: { goal: newId, text: "stdio 评论留痕" } },
        });
        assert.equal(commented.result.isError, false);

        const eventsRaw = readFileSync(join(fx.graphRoot, "events.jsonl"), "utf8");
        assert.ok(eventsRaw.includes(`"actor":"${MCP_WRITE_ACTOR}"`), `${label}: 写事件 actor 必须为 ${MCP_WRITE_ACTOR}`);
      } finally {
        const closed = await client.closeAndWait();
        assert.equal(closed.code, 0, `${label}: stdin 关闭后必须退出 0`);
        // stdout 纯净：每一行都必须是合法 JSON-RPC 对象
        for (const line of closed.rawStdout.trim().split("\n").filter(Boolean)) {
          const parsed = JSON.parse(line);
          assert.equal(parsed.jsonrpc, "2.0", `${label}: stdout 每行必须是合法 JSON-RPC`);
        }
        // stderr 绝不泄露 token 明文
        const tokenFile = join(workspaceStateDir(fx.graphRoot, { stateDir: fx.stateBase }), "token");
        const token = readFileSync(tokenFile, "utf8").trim();
        assert.ok(token.length >= 64, `${label}: 0600 CSPRNG token 必须 ≥64 hex 字符`);
        assert.ok(!closed.stderr.includes(token), `${label}: stderr 绝不得打印 token 明文`);
        if (process.platform !== "win32") {
          assert.equal(statSync(tokenFile).mode & 0o777, 0o600, `${label}: token 文件必须 0600`);
        }
      }

      // B. --read-only 模式（11 只读工具，写工具 -32601 且零副作用）
      const ro = spawnMcp(binPath, ["--read-only", "--no-web"], { cwd: fx.projectDir });
      try {
        const listResp = await ro.request({ id: 1, method: "tools/list" });
        const roNames: string[] = listResp.result.tools.map((t: any) => t.name);
        assert.equal(roNames.length, 11, `${label}: --read-only 必须恰为 11 个只读工具`);
        assert.deepEqual(roNames, [...READ_ONLY_COMMAND_NAMES]);

        const denied = await ro.request({
          id: 2,
          method: "tools/call",
          params: { name: "graph_create_goal", arguments: { title: "只读下禁止创建" } },
        });
        assert.equal(denied.error.code, -32601, `${label}: --read-only 写工具必须返回 -32601`);
        assert.equal(denied.error.data?.code, "E_UNKNOWN_COMMAND");

        // 负向：--read-only 下无法靠保留参数提权
        for (const key of ["allowWrite", "writeMode", "mode"]) {
          const esc = await ro.request({
            id: 3,
            method: "tools/call",
            params: { name: "graph_list_goals", arguments: { [key]: true } },
          });
          assert.equal(esc.error.code, -32602, `${label}: --read-only 参数 ${key} 必须被 -32602 拒绝`);
        }
      } finally {
        const closed = await ro.closeAndWait();
        assert.equal(closed.code, 0);
      }
    } finally {
      fx.cleanup();
    }
  }
});

test("g-637 ③ Human Gate 4 类与保留参数注入严格 fail-closed", async () => {
  const fx = makeTempBoard("humangate");
  const client = spawnMcp(SRC_BIN, ["--no-web"], { cwd: fx.projectDir });
  try {
    const beforeEvents = readFileSync(join(fx.graphRoot, "events.jsonl"), "utf8");

    // 1. 3 个整工具 Human Gate：永不注册（-32601 + E_UNKNOWN_COMMAND）
    for (const tool of Object.keys(HUMAN_GATE_TOOLS)) {
      const r = await client.request({
        id: `gate-${tool}`,
        method: "tools/call",
        params: { name: tool, arguments: { goal: fx.goalId, verdict: "accept" } },
      });
      assert.equal(r.error?.code, -32601, `${tool} 必须 -32601`);
      assert.equal(r.error?.data?.code, "E_UNKNOWN_COMMAND");
    }

    // 2. 第 4 类：graph_transition → delivered 永远 E_FORBIDDEN
    const deliv = await client.request({
      id: "gate-delivered",
      method: "tools/call",
      params: { name: "graph_transition", arguments: { goal: fx.goalId, to: "delivered" } },
    });
    assert.equal(deliv.result?.isError, true, "transition→delivered 必须 isError=true");
    assert.match(JSON.stringify(deliv.result.content), /E_FORBIDDEN/);

    // 3. 顶层 params 保留参数全部 -32602
    for (const key of ["actor", "owner", "human", "approval", "allowWrite", "writeMode", "mode"]) {
      const r = await client.request({
        id: `top-${key}`,
        method: "tools/call",
        params: { name: "graph_list_goals", arguments: {}, [key]: "human:spoof" },
      });
      assert.equal(r.error?.code, -32602, `顶层 params.${key} 必须 -32602`);
    }

    // 4. 工具 arguments 保留参数：写模式开关族 -32602；身份伪造族 E_FORBIDDEN
    for (const key of ["allowWrite", "writeMode", "mode"]) {
      const r = await client.request({
        id: `arg-sw-${key}`,
        method: "tools/call",
        params: { name: "graph_query_goal", arguments: { goal: fx.goalId, [key]: true } },
      });
      assert.equal(r.error?.code, -32602, `arguments.${key} 必须 -32602`);
    }
    for (const key of ["actor", "owner", "human", "approval"]) {
      const r = await client.request({
        id: `arg-id-${key}`,
        method: "tools/call",
        params: { name: "graph_add_comment", arguments: { goal: fx.goalId, text: "spoof", [key]: "human:owner" } },
      });
      assert.equal(r.result?.isError, true, `arguments.${key} 必须被拒`);
      assert.match(JSON.stringify(r.result.content), /E_FORBIDDEN/);
    }

    // 以上全部被拒调用必须零事件副作用
    assert.equal(readFileSync(join(fx.graphRoot, "events.jsonl"), "utf8"), beforeEvents, "全部被拒请求必须零副作用");
  } finally {
    await client.closeAndWait();
    fx.cleanup();
  }
});

test("g-637 ④ 未初始化工作区照常启动且查询返回 E_NOT_INITIALIZED（零目录副作用）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "g637-uninit-"));
  const client = spawnMcp(SRC_BIN, ["--no-web"], { cwd: dir });
  try {
    const initResp = await client.request({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    assert.equal(initResp.result.serverInfo.name, "goal-graph-local");
    const callResp = await client.request({ id: 2, method: "tools/call", params: { name: "graph_list_goals", arguments: {} } });
    assert.equal(callResp.result.isError, true);
    assert.match(JSON.stringify(callResp.result.content), /E_NOT_INITIALIZED/);
    assert.equal(existsSync(join(dir, ".dsh-graph")), false, "查询未初始化工作区不得创建 .dsh-graph/");
  } finally {
    await client.closeAndWait();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("g-637 ⑤ 多工作区并发分配不同随机端口 + 同工作区复用 + stdin 关闭优雅回收（零僵尸进程）", async () => {
  const sharedStateBase = mkdtempSync(join(tmpdir(), "g637-multi-state-"));
  const fxA = makeTempBoard("wsA");
  const fxB = makeTempBoard("wsB");

  const procA1 = spawnMcp(SRC_BIN, ["--state-dir", sharedStateBase], { cwd: fxA.projectDir });
  const procB1 = spawnMcp(SRC_BIN, ["--state-dir", sharedStateBase], { cwd: fxB.projectDir });

  try {
    const [errA1, errB1] = await Promise.all([
      procA1.waitStderr(/\[goal-graph mcp\] web=(http:\/\/127\.0\.0\.1:(\d+))\/.*\(started pid=\d+\)/),
      procB1.waitStderr(/\[goal-graph mcp\] web=(http:\/\/127\.0\.0\.1:(\d+))\/.*\(started pid=\d+\)/),
    ]);
    const portA = Number(/web=http:\/\/127\.0\.0\.1:(\d+)\//.exec(errA1)?.[1]);
    const portB = Number(/web=http:\/\/127\.0\.0\.1:(\d+)\//.exec(errB1)?.[1]);
    assert.ok(portA > 0 && portB > 0, "两工作区均必须成功分配随机端口");
    assert.notEqual(portA, portB, "多工作区并发启动必须分配不同端口、互不冲突");

    // 两个本地 Web 服务都实际连通，且 runtime.json 权限为 0600
    assert.equal(await probeWorkspaceWebService(portA), true, "工作区 A 本地 Web 必须 HTTP 200 可达");
    assert.equal(await probeWorkspaceWebService(portB), true, "工作区 B 本地 Web 必须 HTTP 200 可达");
    const wsStateA = workspaceStateDir(fxA.graphRoot, { stateDir: sharedStateBase });
    const runtimeFileA = join(wsStateA, WORKSPACE_RUNTIME_FILE);
    assert.ok(existsSync(runtimeFileA), "工作区 A 必须落盘 runtime.json");
    if (process.platform !== "win32") {
      assert.equal(statSync(runtimeFileA).mode & 0o777, 0o600, "runtime.json 必须 0600");
    }
    const rtA = JSON.parse(readFileSync(runtimeFileA, "utf8"));
    assert.equal(rtA.port, portA);
    assert.equal(rtA.pid, procA1.child.pid);

    // 同工作区二次启动：复用已存活服务，不重复起端口
    const procA2 = spawnMcp(SRC_BIN, ["--state-dir", sharedStateBase], { cwd: fxA.projectDir });
    try {
      const errA2 = await procA2.waitStderr(/\[goal-graph mcp\] web=http:\/\/127\.0\.0\.1:(\d+)\/.*\(reused pid=(\d+)\)/);
      const reusedPort = Number(/web=http:\/\/127\.0\.0\.1:(\d+)\//.exec(errA2)?.[1]);
      const reusedPid = Number(/reused pid=(\d+)/.exec(errA2)?.[1]);
      assert.equal(reusedPort, portA, "同工作区二次启动必须复用同一端口");
      assert.equal(reusedPid, procA1.child.pid, "同工作区二次启动必须复用原进程服务");
      const pingA2 = await procA2.request({ id: 1, method: "ping" });
      assert.deepEqual(pingA2.result, {});
    } finally {
      const closedA2 = await procA2.closeAndWait();
      assert.equal(closedA2.code, 0);
    }

    // 复用方退出后：原服务仍存活且 runtime.json 未被误删
    assert.equal(await probeWorkspaceWebService(portA), true, "复用方退出不得关闭原服务");
    assert.equal(existsSync(runtimeFileA), true, "复用方退出不得误删原进程 runtime.json");

    // 原进程 stdin 关闭：自启 Web 服务自动退出、端口释放、runtime.json 被清理
    const closedA1 = await procA1.closeAndWait();
    assert.equal(closedA1.code, 0, "procA1 stdin 关闭必须退出 0");
    assert.equal(await probeWorkspaceWebService(portA, 500), false, "procA1 退出后端口必须释放");
    assert.equal(existsSync(runtimeFileA), false, "procA1 退出后自身 runtime.json 必须清理");

    const closedB1 = await procB1.closeAndWait();
    assert.equal(closedB1.code, 0, "procB1 stdin 关闭必须退出 0");
    assert.equal(await probeWorkspaceWebService(portB, 500), false, "procB1 退出后端口必须释放");

    // 负向对照：--state-dir 落在 graphRoot 内部必须触发 assertSeparatedRoots fail-closed
    const badStateInsideGraph = join(fxA.graphRoot, "illegal-state");
    const badProc = spawnMcp(SRC_BIN, ["--state-dir", badStateInsideGraph], { cwd: fxA.projectDir });
    const badClosed = await badProc.closeAndWait();
    assert.notEqual(badClosed.code, 0, "--state-dir 落入 graphRoot 内部必须 fail-closed 拒绝启动");
    assert.match(badClosed.stderr, /不得互相包含|不得相同|启动失败/);
  } finally {
    await procA1.closeAndWait().catch(() => {});
    await procB1.closeAndWait().catch(() => {});
    fxA.cleanup();
    fxB.cleanup();
    rmSync(sharedStateBase, { recursive: true, force: true });
  }
});
