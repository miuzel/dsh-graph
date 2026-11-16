/**
 * g-623：独立本地服务的**生命周期**（初始化 / 状态 / 停止 / 卸载）与 CLI 参数解析。
 *
 * 判据 1 / 3 / 7 / 10 的落地：
 * - **CLI adapter 不承担 UI，也不承担服务生命周期**：`dsh-graph serve` 只是把本模块的显式动作
 *   映射到一次性的进程（前台阻塞，Ctrl-C/信号退出）；不存在「CLI 托管 Web UI」或后台守护进程。
 * - **首次显式初始化**（`serve init`）：生成 ≥256 bit token（OS CSPRNG）、写 0600 私有凭据、
 *   写只含连接信息的运行配置。**未显式初始化**时 `serve` 只报错，不自动 init/claim 看板，
 *   也不自动创建凭据。
 * - graphRoot 与 executionWorkspace **显式分离**（`--root` / `--workspace` 两个独立参数，
 *   都是绝对路径；不做 cwd 推断）。
 * - **卸载**（`serve uninstall`）只删除本服务自有的运行配置与凭据，**graph 数据一字不动**；
 *   并断言端口已释放（由停止动作保证，不是假设）。
 */
import { existsSync, lstatSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  RUNTIME_CONFIG_NAME,
  SERVICE_CONTRACT_VERSION,
  STORAGE_PROFILE,
  assertSeparatedRoots,
  isGraphInitialized,
  readRuntimeConfig,
  runtimeConfigPath,
  writeRuntimeConfig,
  type RuntimeConfig,
} from "./config.ts";
import { CredentialStore, CredentialError, TOKEN_FILE_NAME } from "./credentials.ts";
import { ALLOWED_BIND_HOST, validateBindHost } from "./policy.ts";
import { startService, type RunningService } from "./server.ts";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** 服务自有状态目录的默认落点：`<state-root>/dsh-graph-service`（调用方必须给出显式 --state-dir 或 HOME）。 */
export const STATE_DIR_NAME = "dsh-graph-service";

export interface ServeArgs {
  action: "serve" | "init" | "status" | "stop" | "uninstall";
  root?: string;
  workspace?: string;
  stateDir?: string;
  port?: number;
  host?: string;
}

export class ServeUsageError extends Error {}

/** 解析 `dsh-graph serve …` 之后的参数（纯函数，无副作用）。 */
export function parseServeArgs(argv: string[]): ServeArgs {
  let action: ServeArgs["action"] = "serve";
  const rest: string[] = [];
  for (const a of argv) {
    if (a === "init" || a === "status" || a === "stop" || a === "uninstall" || a === "serve") {
      if (a !== "serve") action = a;
      continue;
    }
    rest.push(a);
  }
  const out: ServeArgs = { action };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const take = (): string => {
      if (inline !== undefined) return inline;
      const v = rest[++i];
      if (v === undefined) throw new ServeUsageError(`选项 ${flag} 缺少取值`);
      return v;
    };
    switch (flag) {
      case "--root":
        out.root = take();
        break;
      case "--workspace":
        out.workspace = take();
        break;
      case "--state-dir":
        out.stateDir = take();
        break;
      case "--port": {
        const raw = take();
        if (!/^\d+$/.test(raw)) throw new ServeUsageError(`--port 必须是十进制整数：${raw}`);
        const n = Number(raw);
        if (n < 0 || n > 65535) throw new ServeUsageError(`--port 越界：${raw}`);
        out.port = n;
        break;
      }
      case "--host":
        out.host = take();
        break;
      default:
        throw new ServeUsageError(`未知选项：${flag}`);
    }
  }
  if (action === "init" || action === "serve") {
    if (!out.root) throw new ServeUsageError(`需要 --root <绝对路径>（graphRoot，只读看板数据）`);
    if (!out.workspace) throw new ServeUsageError(`需要 --workspace <绝对路径>（executionWorkspace，执行目录；与 --root 显式分离）`);
    if (out.port === undefined || out.port === 0) {
      if (out.port === undefined) out.port = 0; // 0 = 系统分配空闲高位端口（不冻结具体端口）
    }
  }
  if (out.host !== undefined) {
    const v = validateBindHost(out.host);
    if (!v.ok) throw new ServeUsageError(v.message);
  }
  return out;
}

/** 解析状态目录：显式 --state-dir 优先；否则 HOME 下的默认落点（绝不写进 graphRoot）。 */
export function resolveStateDir(args: ServeArgs, env: { HOME?: string; XDG_STATE_HOME?: string } = process.env): string {
  if (args.stateDir) {
    if (!isAbsolute(args.stateDir)) throw new ServeUsageError("--state-dir 必须是绝对路径");
    return resolve(args.stateDir);
  }
  const base = env.XDG_STATE_HOME || (env.HOME ? join(env.HOME, ".local", "state") : "");
  if (!base) throw new ServeUsageError("缺少 --state-dir 且无法从 HOME/XDG_STATE_HOME 推断状态目录");
  return join(base, STATE_DIR_NAME);
}

export interface InitResult {
  stateDir: string;
  tokenCreated: boolean;
  tokenFingerprint: string;
  graphInitialized: boolean;
  config: RuntimeConfig;
}

/**
 * **首次显式初始化**：凭据 + 运行配置。
 * 看板未初始化时**只**报告（不 init/claim）；凭据与配置仍属服务自有状态，与看板数据无关。
 */
export function initService(args: ServeArgs, env: NodeJS.ProcessEnv = process.env): InitResult {
  if (!args.root || !args.workspace) throw new ServeUsageError("init 需要 --root 与 --workspace");
  if (!isAbsolute(args.root) || !isAbsolute(args.workspace)) {
    throw new ServeUsageError("--root 与 --workspace 必须是绝对路径（不得按进程 cwd 猜测）");
  }
  assertSeparatedRoots(args.root, args.workspace);
  const stateDir = resolveStateDir(args, env);
  const store = new CredentialStore({ stateDir });
  const opened = store.open();
  const config: RuntimeConfig = {
    version: 1,
    bindAddress: ALLOWED_BIND_HOST,
    port: args.port ?? 0,
    graphRoot: resolve(args.root),
    executionWorkspace: resolve(args.workspace),
    contractVersion: SERVICE_CONTRACT_VERSION,
    storageProfile: STORAGE_PROFILE,
  };
  writeRuntimeConfig(stateDir, config);
  return {
    stateDir,
    tokenCreated: opened.created,
    tokenFingerprint: opened.fingerprint,
    graphInitialized: isGraphInitialized(config.graphRoot),
    config,
  };
}

export interface ServiceStatus {
  stateDir: string;
  initialized: boolean;
  tokenPresent: boolean;
  tokenFingerprint: string;
  graphInitialized: boolean;
  config: RuntimeConfig | null;
}

/** 只读状态（不创建目录、不生成凭据）。 */
export function serviceStatus(args: ServeArgs, env: NodeJS.ProcessEnv = process.env): ServiceStatus {
  const stateDir = resolveStateDir(args, env);
  const tokenFile = join(stateDir, TOKEN_FILE_NAME);
  const tokenPresent = existsSync(tokenFile);
  let fingerprint = "";
  if (tokenPresent) {
    try {
      const probe = new CredentialStore({ stateDir });
      probe.open();
      fingerprint = probe.fingerprint();
    } catch (e) {
      fingerprint = `(unreadable: ${e instanceof CredentialError ? e.code : "error"})`;
    }
  }
  let config: RuntimeConfig | null = null;
  try {
    config = readRuntimeConfig(stateDir);
  } catch {
    config = null;
  }
  return {
    stateDir,
    initialized: existsSync(runtimeConfigPath(stateDir)) && tokenPresent,
    tokenPresent,
    tokenFingerprint: fingerprint,
    graphInitialized: config ? isGraphInitialized(config.graphRoot) : false,
    config,
  };
}

/**
 * `serve`：读取运行配置（必须已显式 init）⇒ 启动服务 ⇒ 前台阻塞直到收到信号。
 * **不**自动 init 凭据/配置；未初始化时报错退出（EXIT_FAILURE）。
 */
export async function runServe(
  args: ServeArgs,
  io: { out: (s: string) => void; err: (s: string) => void; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): Promise<{ exitCode: number; service?: RunningService }> {
  const env = io.env ?? process.env;
  const stateDir = resolveStateDir(args, env);
  let config: RuntimeConfig;
  try {
    config = readRuntimeConfig(stateDir);
  } catch (e: any) {
    io.err(`错误：${e?.message ?? e}\n`);
    return { exitCode: EXIT_FAILURE };
  }
  // 显式参数（如 --port 覆盖）优先，但仍受绑定策略约束。
  const host = args.host ?? config.bindAddress;
  const verdict = validateBindHost(host);
  if (!verdict.ok) {
    io.err(`错误：${verdict.message}\n`);
    return { exitCode: EXIT_FAILURE };
  }
  let service: RunningService;
  try {
    service = await startService({
      graphRoot: config.graphRoot,
      executionWorkspace: config.executionWorkspace,
      stateDir,
      port: args.port ?? config.port,
      host,
      audit: (line) => io.err(`[audit] ${line}\n`),
    });
  } catch (e: any) {
    io.err(`错误：${e?.message ?? e}\n`);
    return { exitCode: EXIT_FAILURE };
  }
  io.out(
    [
      `dsh-graph 本地只读服务已启动：${service.origin}`,
      `  Web App   ${service.origin}/`,
      `  Web API   ${service.origin}/api/…（同 origin 会话 Cookie）`,
      `  MCP       ${service.origin}/mcp（Authorization: Bearer <token>）`,
      `  graphRoot          ${config.graphRoot}${isGraphInitialized(config.graphRoot) ? "" : "（未初始化：只读查询将报 E_NOT_INITIALIZED，本服务不会自动 init/claim）"}`,
      `  executionWorkspace ${config.executionWorkspace}`,
      `  token 指纹 ${service.tokenFingerprint}（完整 token 在服务私有状态目录的凭据文件中，未打印）`,
      "",
    ].join("\n"),
  );
  const stop = async () => {
    await service.close();
    io.out("已停止监听并撤销 Web 会话。\n");
    process.exitCode = EXIT_OK;
  };
  if (io.signal) {
    io.signal.addEventListener("abort", () => { void stop(); }, { once: true });
  } else {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.once(sig, () => { void stop(); });
    }
  }
  return { exitCode: EXIT_OK, service };
}

/** 卸载：只删除本服务自有的运行配置与凭据；**graph 数据不动**。 */
export function uninstallService(
  args: ServeArgs,
  env: NodeJS.ProcessEnv = process.env,
): { removed: string[]; kept: string[]; stateDir: string; graphRootUntouched: string | null } {
  const stateDir = resolveStateDir(args, env);
  const removed: string[] = [];
  const kept: string[] = [];
  let graphRoot: string | null = null;
  try {
    graphRoot = readRuntimeConfig(stateDir).graphRoot;
  } catch {
    graphRoot = null;
  }
  for (const name of [TOKEN_FILE_NAME, RUNTIME_CONFIG_NAME]) {
    const file = join(stateDir, name);
    if (!existsSync(file)) continue;
    const st = lstatSync(file);
    if (st.isSymbolicLink()) {
      // 绝不跟随 symlink 删除其目标（可能指向用户数据）。
      kept.push(`${file}（symlink，未删除）`);
      continue;
    }
    rmSync(file, { force: true });
    removed.push(file);
  }
  // 状态目录若已空则一并移除（只删本服务自有目录）。
  try {
    if (existsSync(stateDir) && readdirSync(stateDir).length === 0) {
      rmdirSync(stateDir);
      removed.push(stateDir);
    } else if (existsSync(stateDir)) {
      kept.push(`${stateDir}（非空，保留）`);
    }
    const parent = dirname(stateDir);
    if (existsSync(parent) && readdirSync(parent).length === 0 /* 仅在本服务创建了父目录时为空 */) {
      /* 不递归删除父目录：它可能属于用户既有 XDG 布局 */
    }
  } catch {
    /* 忽略 */
  }
  // graph 数据断言：只读检查，绝不修改。
  return { removed, kept, stateDir, graphRootUntouched: graphRoot };
}

/** CLI 入口：`dsh-graph serve …`。返回退出码（不直接退出进程）。 */
export async function runServeCommand(
  argv: string[],
  io: { out: (s: string) => void; err: (s: string) => void; env?: NodeJS.ProcessEnv } = {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
  },
): Promise<number> {
  let args: ServeArgs;
  try {
    args = parseServeArgs(argv);
  } catch (e: any) {
    io.err(`用法错误：${e?.message ?? e}\n`);
    return EXIT_USAGE;
  }
  try {
    switch (args.action) {
      case "init": {
        const r = initService(args, io.env ?? process.env);
        io.out(
          JSON.stringify(
            {
              ok: true,
              action: "init",
              stateDir: r.stateDir,
              tokenCreated: r.tokenCreated,
              tokenFingerprint: r.tokenFingerprint,
              graphInitialized: r.graphInitialized,
              // 不打印 token 原文；只给指纹与「到哪取」的提示。
              tokenFile: join(r.stateDir, TOKEN_FILE_NAME),
            },
            null,
            2,
          ) + "\n",
        );
        if (!r.graphInitialized) {
          io.out("注意：看板尚未初始化（缺 events.jsonl）；本服务不会自动 init/claim，只读查询将返回 E_NOT_INITIALIZED。\n");
        }
        return EXIT_OK;
      }
      case "status": {
        io.out(JSON.stringify({ ok: true, action: "status", ...serviceStatus(args, io.env ?? process.env) }, null, 2) + "\n");
        return EXIT_OK;
      }
      case "uninstall": {
        const r = uninstallService(args, io.env ?? process.env);
        io.out(JSON.stringify({ ok: true, action: "uninstall", ...r }, null, 2) + "\n");
        return EXIT_OK;
      }
      case "stop": {
        // 无后台守护进程：stop 只报告「本服务不托管后台进程」，并提示用信号停止前台进程。
        io.err("说明：本服务不以后台守护进程方式运行，stop 无事可做；请对前台 `serve` 进程发送 SIGINT/SIGTERM。\n");
        return EXIT_FAILURE;
      }
      case "serve":
      default: {
        const r = await runServe(args, io);
        return r.exitCode;
      }
    }
  } catch (e: any) {
    io.err(`错误：${e?.message ?? e}\n`);
    return EXIT_USAGE;
  }
}

export { startService };
export type { RunningService };
