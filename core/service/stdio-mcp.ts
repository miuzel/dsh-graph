/**
 * g-637：零配置 `goal-graph mcp`（JSON-RPC 2.0 over stdio）+ 按工作区自动起/复用本地 Web 看板服务。
 *
 * 设计约束（单一真源，绝不另立第二套工具表或安全门禁）：
 * - 直接复用 `core/service/mcp.ts` 的 `handleMcpJsonRpcText` / `dispatchRpc`：与 HTTP `/mcp`
 *   共用 100% 同一工具注册表、参数校验、保留参数拒绝与 Human Gate fail-closed 拦截。
 * - **默认写模式**：stdio 属本机当前工作区直连，默认 `writeMode = { enabled: true }`（38 工具：
 *   11 只读 + 27 执行类写工具，actor 固定 `mcp:local-service`）；传 `--read-only` 切回 11 只读工具。
 * - **Human Gate 严格 fail-closed**：`graph_resolve_accept` / `graph_claim_supervisor` /
 *   `graph_start_attempt` 永不注册（`-32601`）；`graph_transition → delivered` 永远 `E_FORBIDDEN`；
 *   客户端传入保留参数（`actor/owner/human/approval/allowWrite/writeMode/mode` 等）永远被拒。
 * - **stdout 纯净**：`stdout` 只输出合法 JSON-RPC 响应行（NDJSON，每条一行 JSON + `\n`）；
 *   无 `id` 的通知（如 `notifications/initialized`）不输出任何响应；所有诊断日志只走 `stderr`
 *   且**绝不打印 token 明文**。
 * - **自动本地 Web 服务**：按规范化 `graphRoot` 派生独立状态目录
 *   `<state-root>/goal-graph-service/workspaces/<hash12>/`，`executionWorkspace` 落在状态目录内
 *   `<ws-state-dir>/exec-ws`，天然满足 `assertSeparatedRoots`（零削弱 g-623 安全不变式）。
 *   若同工作区已有存活且健康探测通过的 Web 服务则直接复用，否则以 `127.0.0.1:0` 自动分配空闲端口
 *   启动并原子写 0600 `runtime.json`；`stdin` 关闭或收到 `SIGINT`/`SIGTERM` 时优雅关闭自启服务
 *   并仅在 `runtime.json.pid === process.pid` 时清理文件，不留僵尸进程与残留锁。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { assertGraphDirName, DEFAULT_GRAPH_DIR_NAME, resolveCanonicalRoot } from "../root.ts";
import { locateGraphRoot, LocateError } from "../cli/locate.ts";
import { assertSeparatedRoots, ServiceConfigError } from "./config.ts";
import { CredentialError, ensurePrivateDir, TOKEN_FILE_NAME, writePrivateFile } from "./credentials.ts";
import { handleMcpJsonRpcText, type McpContext } from "./mcp.ts";
import { ALLOWED_BIND_HOST } from "./policy.ts";
import { EXIT_FAILURE, EXIT_OK, EXIT_USAGE, resolveStateDir } from "./serve.ts";
import { startService, type RunningService } from "./server.ts";

/** 工作区运行时描述文件名（位于 `<ws-state-dir>/runtime.json`，0600）。 */
export const WORKSPACE_RUNTIME_FILE = "runtime.json";
/** 状态目录下隔离执行占位目录名（满足 `assertSeparatedRoots`，与真实 `graphRoot` 互不包含）。 */
export const WORKSPACE_EXEC_DIR = "exec-ws";

export interface McpArgs {
  root?: string;
  graphDirName?: string;
  stateDir?: string;
  readOnly: boolean;
  noWeb: boolean;
}

export class McpUsageError extends Error {}

/** 解析 `goal-graph mcp ...` 选项（纯函数，无副作用）。 */
export function parseMcpArgs(argv: readonly string[]): McpArgs {
  const out: McpArgs = { readOnly: false, noWeb: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [flag, inline] = eq >= 0 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
    const take = (): string => {
      if (inline !== undefined) {
        if (inline.trim() === "") throw new McpUsageError(`选项 ${flag} 缺少取值`);
        return inline;
      }
      const v = argv[++i];
      if (v === undefined || v.startsWith("-")) throw new McpUsageError(`选项 ${flag} 缺少取值`);
      return v;
    };
    switch (flag) {
      case "--root":
        if (out.root !== undefined) throw new McpUsageError("选项 --root 只能给出一次");
        out.root = take();
        break;
      case "--graph-dir-name":
        if (out.graphDirName !== undefined) throw new McpUsageError("选项 --graph-dir-name 只能给出一次");
        out.graphDirName = take();
        break;
      case "--state-dir":
        if (out.stateDir !== undefined) throw new McpUsageError("选项 --state-dir 只能给出一次");
        out.stateDir = take();
        break;
      case "--read-only":
        if (inline !== undefined) throw new McpUsageError(`--read-only 不接受取值：${inline}`);
        out.readOnly = true;
        break;
      case "--no-web":
        if (inline !== undefined) throw new McpUsageError(`--no-web 不接受取值：${inline}`);
        out.noWeb = true;
        break;
      default:
        throw new McpUsageError(flag.startsWith("-") ? `未知选项：${flag}` : `命令 mcp 不接受多余位置参数：${arg}`);
    }
  }
  if (out.root !== undefined && out.graphDirName !== undefined) {
    throw new McpUsageError("选项 --graph-dir-name 与 --root 不能同时给出");
  }
  if (out.graphDirName !== undefined) {
    try {
      out.graphDirName = assertGraphDirName(out.graphDirName);
    } catch (e: any) {
      throw new McpUsageError(`选项 --graph-dir-name 非法：${String(e?.message ?? e)}`);
    }
  }
  if (out.stateDir !== undefined && !isAbsolute(out.stateDir)) {
    throw new McpUsageError("--state-dir 必须是绝对路径");
  }
  return out;
}

/**
 * 规范化路径用于稳定哈希：沿着已存在的最近祖先做 `realpathSync`，再拼回尚未创建的尾段，
 * 确保 `.dsh-graph/` 初始化前后派生到同一个工作区状态目录。
 */
export function canonicalizeForStateHash(targetPath: string): string {
  const abs = resolve(targetPath);
  const tail: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = resolve(cur, "..");
    if (parent === cur) return abs;
    const prefixLen = parent.endsWith("/") || parent.endsWith("\\") ? parent.length : parent.length + 1;
    const seg = cur.slice(prefixLen);
    if (seg) tail.unshift(seg);
    cur = parent;
  }
  try {
    const real = realpathSync(cur);
    return tail.length > 0 ? join(real, ...tail) : real;
  } catch {
    return abs;
  }
}

/** 计算工作区状态目录短哈希（12 位 hex）。 */
export function workspaceStateHash(graphRoot: string): string {
  return createHash("sha256").update(canonicalizeForStateHash(graphRoot)).digest("hex").slice(0, 12);
}

/** 派生独立工作区状态目录：`<state-root>/goal-graph-service/workspaces/<hash12>`（或 `<--state-dir>/workspaces/<hash12>`）。 */
export function workspaceStateDir(
  graphRoot: string,
  opts: { stateDir?: string; env?: { HOME?: string; XDG_STATE_HOME?: string } } = {},
): string {
  const base = resolveStateDir({ action: "serve", stateDir: opts.stateDir }, opts.env ?? process.env);
  return join(base, "workspaces", workspaceStateHash(graphRoot));
}

/**
 * 解析 stdio MCP 的 `graphRoot`：
 * - 优先走既有 `locateGraphRoot`（复用 cwd 向上查找、`--root`、`--graph-dir-name`、危险路径与 symlink 拒绝）；
 * - 若当前目录尚未初始化（`graph-not-found`），MCP 进程仍照常启动并把候选 `graphRoot` 定为
 *   `<cwd>/<dirName>`（仍经 `resolveCanonicalRoot` 校验），查询将按既有约定返回 `E_NOT_INITIALIZED`。
 */
export function resolveMcpGraphRoot(args: McpArgs, cwd: string = process.cwd()): { graphRoot: string; workspace: string } {
  const resolvedCwd = resolve(cwd);
  try {
    const located = locateGraphRoot({ cwd: resolvedCwd, root: args.root ?? null, dirName: args.graphDirName ?? null });
    return { graphRoot: located.root, workspace: located.workspace };
  } catch (e) {
    if (e instanceof LocateError && e.code === "graph-not-found" && !args.root) {
      const dirName = args.graphDirName ?? DEFAULT_GRAPH_DIR_NAME;
      const canonical =
        dirName === DEFAULT_GRAPH_DIR_NAME
          ? resolveCanonicalRoot(null, resolvedCwd)
          : resolveCanonicalRoot({ root: dirName }, resolvedCwd);
      return { graphRoot: canonical.root, workspace: canonical.workspace };
    }
    throw e;
  }
}

export interface WorkspaceRuntimeInfo {
  pid: number;
  port: number;
  origin: string;
  graphRoot: string;
  tokenPath: string;
  startedAt: string;
}

export interface WorkspaceWebHandle {
  reused: boolean;
  owned: boolean;
  runtime: WorkspaceRuntimeInfo;
  stateDir: string;
  execWorkspace: string;
  service?: RunningService;
  stop(): Promise<void>;
}

/** 判断本地 PID 是否存活（`EPERM` 表示进程存在但属他用户，同样视为存活）。 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/** 对 `http://127.0.0.1:<port>/` 做轻量健康探测（不留 keep-alive 连接）。 */
export function probeWorkspaceWebService(port: number, timeoutMs = 1500): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise<boolean>((resolveProbe) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolveProbe(ok);
    };
    const req = httpRequest(
      {
        host: ALLOWED_BIND_HOST,
        port,
        path: "/",
        method: "GET",
        headers: {
          host: `${ALLOWED_BIND_HOST}:${port}`,
          connection: "close",
        },
        timeout: timeoutMs,
      },
      (res) => {
        const ct = String(res.headers["content-type"] ?? "");
        const ok = res.statusCode === 200 && ct.toLowerCase().includes("text/html");
        res.resume();
        res.once("end", () => done(ok));
        res.once("close", () => done(ok));
      },
    );
    req.once("timeout", () => {
      req.destroy();
      done(false);
    });
    req.once("error", () => done(false));
    req.end();
  });
}

function readWorkspaceRuntime(file: string): WorkspaceRuntimeInfo | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const pid = Number(parsed.pid);
    const port = Number(parsed.port);
    const origin = String(parsed.origin ?? "");
    const graphRoot = String(parsed.graphRoot ?? "");
    const tokenPath = String(parsed.tokenPath ?? "");
    const startedAt = String(parsed.startedAt ?? "");
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    if (origin !== `http://${ALLOWED_BIND_HOST}:${port}`) return null;
    if (graphRoot === "" || tokenPath === "") return null;
    return { pid, port, origin, graphRoot, tokenPath, startedAt };
  } catch {
    return null;
  }
}

/** 仅当 `runtime.json` 中记录的 `pid === ownPid` 时删除，避免误删他进程记录。 */
export function removeOwnRuntimeFile(runtimeFile: string, ownPid: number): boolean {
  const current = readWorkspaceRuntime(runtimeFile);
  if (!current || current.pid !== ownPid) return false;
  try {
    rmSync(runtimeFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查并复用当前工作区已存活的本地 Web 服务；若无则在 `127.0.0.1:0` 自动分配空闲端口启动。
 *
 * `executionWorkspace` 落在 `<ws-state-dir>/exec-ws`，与项目工作树内的 `graphRoot` 天然分离，
 * 完整满足 `assertSeparatedRoots`（零削弱 g-623 安全不变式）。
 */
export async function ensureWorkspaceWebService(opts: {
  graphRoot: string;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  probeTimeoutMs?: number;
}): Promise<WorkspaceWebHandle> {
  const canonicalGraphRoot = canonicalizeForStateHash(opts.graphRoot);
  const wsStateDir = workspaceStateDir(opts.graphRoot, { stateDir: opts.stateDir, env: opts.env });
  const execWorkspace = join(wsStateDir, WORKSPACE_EXEC_DIR);
  const runtimeFile = join(wsStateDir, WORKSPACE_RUNTIME_FILE);

  // 先过 g-623 根分离不变式（例如 --state-dir 若误指进 graphRoot 内则立刻 fail-closed）。
  assertSeparatedRoots(opts.graphRoot, execWorkspace);

  // ① 检查现有 runtime.json：PID 存活 + graphRoot 一致 + 轻量健康探测成功 ⇒ 直接复用
  const existing = readWorkspaceRuntime(runtimeFile);
  if (
    existing &&
    canonicalizeForStateHash(existing.graphRoot) === canonicalGraphRoot &&
    isPidAlive(existing.pid) &&
    (await probeWorkspaceWebService(existing.port, opts.probeTimeoutMs))
  ) {
    return {
      reused: true,
      owned: false,
      runtime: existing,
      stateDir: wsStateDir,
      execWorkspace,
      async stop() {
        /* 复用他进程服务：本进程退出不关闭对方服务、不删对方 runtime.json */
      },
    };
  }

  // ② 自启：初始化 0700 状态目录 + 独立 exec-ws + 0600 CSPRNG 凭据 + 127.0.0.1:0 随机端口
  ensurePrivateDir(wsStateDir);
  mkdirSync(execWorkspace, { recursive: true, mode: 0o700 });
  const service = await startService({
    graphRoot: opts.graphRoot,
    executionWorkspace: execWorkspace,
    stateDir: wsStateDir,
    port: 0,
    host: ALLOWED_BIND_HOST,
    allowWrite: false,
  });

  const runtime: WorkspaceRuntimeInfo = {
    pid: process.pid,
    port: service.port,
    origin: service.origin,
    graphRoot: canonicalGraphRoot,
    tokenPath: join(wsStateDir, TOKEN_FILE_NAME),
    startedAt: new Date().toISOString(),
  };

  try {
    writePrivateFile(runtimeFile, `${JSON.stringify(runtime, null, 2)}\n`);
  } catch (e) {
    await service.close();
    throw e;
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await service.close();
    } finally {
      removeOwnRuntimeFile(runtimeFile, process.pid);
    }
  };

  return {
    reused: false,
    owned: true,
    runtime,
    stateDir: wsStateDir,
    execWorkspace,
    service,
    stop,
  };
}

export interface RunMcpIo {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  writeOut?: (text: string) => void;
  writeErr?: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * `goal-graph mcp` 主入口：
 * 1. 解析选项并定位工作区 `graphRoot`；
 * 2. 若未传 `--no-web`，按工作区检查/复用或自动分配空闲端口启动本地 Web 服务；
 * 3. 在 `stdin`/`stdout` 上运行 NDJSON JSON-RPC 2.0 循环（复用 `core/service/mcp.ts` 真源）；
 * 4. `stdin` 关闭或收到 `SIGINT`/`SIGTERM` 时优雅关闭本进程自启的 Web 服务并退出。
 */
export async function runMcpCommand(argv: readonly string[], io: RunMcpIo = {}): Promise<number> {
  const writeOut = io.writeOut ?? ((text: string) => void process.stdout.write(text));
  const writeErr = io.writeErr ?? ((text: string) => void process.stderr.write(text));
  const env = io.env ?? process.env;
  const stdin = io.stdin ?? process.stdin;

  let args: McpArgs;
  try {
    args = parseMcpArgs(argv);
  } catch (e: any) {
    writeErr(`goal-graph mcp: 用法错误：${String(e?.message ?? e)}\n`);
    return EXIT_USAGE;
  }

  let resolved: { graphRoot: string; workspace: string };
  try {
    resolved = resolveMcpGraphRoot(args, io.cwd ?? process.cwd());
  } catch (e: any) {
    writeErr(`goal-graph mcp: 定位看板失败：${String(e?.message ?? e)}\n`);
    return EXIT_FAILURE;
  }

  let webHandle: WorkspaceWebHandle | null = null;
  let execWorkspace = join(resolved.workspace, ".goal-graph-stdio-exec");
  if (!args.noWeb) {
    try {
      webHandle = await ensureWorkspaceWebService({
        graphRoot: resolved.graphRoot,
        stateDir: args.stateDir,
        env,
      });
      execWorkspace = webHandle.execWorkspace;
      // 诊断信息只走 stderr，绝不打印 token 明文。
      const action = webHandle.reused ? `reused pid=${webHandle.runtime.pid}` : `started pid=${process.pid}`;
      writeErr(
        `[goal-graph mcp] web=${webHandle.runtime.origin}/ tokenPath=${webHandle.runtime.tokenPath} ` +
          `mode=${args.readOnly ? "read-only" : "write"} (${action})\n`,
      );
    } catch (e: any) {
      // 安全边界错误（根分离失败 / 凭据权限过宽 / 显式 --state-dir 失败）必须 fail-closed；
      // 仅当默认 HOME/XDG 状态目录只读或不可建时降级继续提供 stdio MCP，并在 stderr 如实告警。
      if (e instanceof ServiceConfigError || e instanceof CredentialError || args.stateDir !== undefined) {
        writeErr(`goal-graph mcp: 本地 Web 服务启动失败：${String(e?.message ?? e)}\n`);
        return EXIT_FAILURE;
      }
      writeErr(`[goal-graph mcp] warning: 本地 Web 服务未启动（继续以 stdio MCP 运行）：${String(e?.message ?? e)}\n`);
    }
  } else {
    writeErr(`[goal-graph mcp] web=disabled mode=${args.readOnly ? "read-only" : "write"}\n`);
  }

  const mcpCtx: McpContext = {
    graphRoot: resolved.graphRoot,
    executionWorkspace: execWorkspace,
    authenticate: () => true,
    // 默认开启执行类写工具（38 工具）；仅显式 --read-only 切回只读（11 工具）。
    writeMode: Object.freeze({ enabled: !args.readOnly }),
    webOrigin: webHandle?.runtime.origin,
  };

  const handleLine = (rawLine: string): void => {
    const trimmed = rawLine.trim();
    if (trimmed === "") return;
    const out = handleMcpJsonRpcText(mcpCtx, trimmed);
    if (out.response !== null) {
      writeOut(`${JSON.stringify(out.response)}\n`);
    }
  };

  return await new Promise<number>((resolveExit) => {
    let buffer = "";
    let shuttingDown = false;

    const cleanupSignals = () => {
      if (!io.signal) {
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      } else {
        io.signal.removeEventListener("abort", onSignal);
      }
      if (!io.writeOut) {
        process.stdout.removeListener("error", onStdoutError);
      }
    };

    const shutdown = () => {
      if (shuttingDown) return;
      shuttingDown = true;
      cleanupSignals();
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onClose);
      stdin.removeListener("error", onStdinError);
      if (typeof (stdin as any).pause === "function") (stdin as any).pause();
      void (webHandle ? webHandle.stop() : Promise.resolve()).then(
        () => resolveExit(EXIT_OK),
        () => resolveExit(EXIT_OK),
      );
    };

    const onSignal = () => shutdown();
    const onStdoutError = (err: any) => {
      if (err?.code === "EPIPE") shutdown();
    };
    const onStdinError = () => shutdown();

    const onData = (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        handleLine(line);
      }
    };

    const onEnd = () => {
      if (buffer.trim() !== "") {
        const tail = buffer;
        buffer = "";
        handleLine(tail);
      }
      shutdown();
    };

    const onClose = () => {
      if (buffer.trim() !== "") {
        const tail = buffer;
        buffer = "";
        handleLine(tail);
      }
      shutdown();
    };

    if (io.signal) {
      if (io.signal.aborted) {
        shutdown();
        return;
      }
      io.signal.addEventListener("abort", onSignal, { once: true });
    } else {
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
    }
    if (!io.writeOut) {
      process.stdout.on("error", onStdoutError);
    }

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("close", onClose);
    stdin.once("error", onStdinError);
    if (typeof (stdin as any).resume === "function") (stdin as any).resume();
  });
}
