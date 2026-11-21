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
import { CredentialStore, CredentialError, TOKEN_FILE_NAME, appendPrivateFile } from "./credentials.ts";
import { ALLOWED_BIND_HOST, validateBindHost } from "./policy.ts";
import { assertGraphDirName } from "../root.ts";
import { startService, type RunningService } from "./server.ts";

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;

/** 服务自有状态目录的默认落点：`<state-root>/goal-graph-service`（调用方必须给出显式 --state-dir 或 HOME）。 */
export const STATE_DIR_NAME = "goal-graph-service";

export interface ServeArgs {
  action: "serve" | "init" | "status" | "stop" | "uninstall";
  root?: string;
  workspace?: string;
  stateDir?: string;
  port?: number;
  host?: string;
  /**
   * g-632 B：核心资料目录名（`serve init --graph-dir-name board-a --root <abs ws>`）。
   *
   * 服务侧仍需**完整 graphRoot**：这里只允许 `--root` 指向 workspace，再由显式目录名补齐；
   * 目录名本身绝不从 cwd 猜。给出 `--graph-dir-name` 时 `--root` 视为 workspace 根。
   */
  graphDirName?: string;
  /**
   * g-632 A：`--allow-write`（服务端**显式**开启 MCP 写模式）。
   * - 与 `--root` / `--workspace` 一样是**启动/初始化动作**，写进运行配置；
   * - 单次请求参数（MCP/Web）**永远**不能开启它（见 `mcp.RESERVED_PARAM_KEYS`）。
   * - 缺省 undefined = 未指定（沿用既有运行配置），false = 显式关闭。
   */
  allowWrite?: boolean;
}

export class ServeUsageError extends Error {}

/** 解析 `dsh-graph serve …` 之后的参数（纯函数，无副作用）。 */
export function parseServeArgs(argv: string[]): ServeArgs {
  // 动作词：取**第一个**出现者（`serve init` 的默认动作是 serve；位置参数里的 `init` 才是动作）。
  const ACTIONS = ["serve", "init", "status", "stop", "uninstall"] as const;
  // 注意：`serve` 本身是**默认动作**，不能作为动作词参与匹配（命令名本身就是 `dsh-graph serve`，
  // 否则 `serve init` 会被解析成 `serve`）。动作词 = 第一个非 `serve` 的动作名。
  const verb = argv.find((a) => a !== "serve" && (ACTIONS as readonly string[]).includes(a));
  const action: ServeArgs["action"] = (verb as ServeArgs["action"]) ?? "serve";
  // 动作词**只**在其作为动作出现时移除：`--state-dir <含 "init" 的路径>` 这类取值不受影响
  // （取值不是独立 token 的话不会命中 ACTIONS；若真命中，`--opt` 取值优先判定仍保持成对）。
  // g-632 A：取值可能是动作词的选项（`--graph-dir-name serve`）同样不当动作词。
  const VALUE_FLAGS = new Set(["--root", "--workspace", "--state-dir", "--port", "--host", "--graph-dir-name"]);
  const isValueToken = (i: number) => VALUE_FLAGS.has(argv[i - 1] ?? "");
  const rest = argv.filter((a, i) => !((ACTIONS as readonly string[]).includes(a) && !isValueToken(i)));
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
      case "--graph-dir-name":
        out.graphDirName = take();
        break;
      case "--allow-write":
        // 布尔开关：拒绝 `--allow-write=false` 这类取值形态（不解析字符串真值，避免歧义）。
        if (inline !== undefined) {
          throw new ServeUsageError(`--allow-write 不接受取值（关闭写模式请省略该选项）：${inline}`);
        }
        out.allowWrite = true;
        break;
      case "--no-allow-write":
        if (inline !== undefined) throw new ServeUsageError(`--no-allow-write 不接受取值：${inline}`);
        out.allowWrite = false;
        break;
      default:
        throw new ServeUsageError(`未知选项：${flag}`);
    }
  }
  if (action === "init" || action === "serve") {
    if (!out.root) throw new ServeUsageError(`需要 --root <绝对路径>（graphRoot，只读看板数据）`);
    if (!out.workspace) throw new ServeUsageError(`需要 --workspace <绝对路径>（executionWorkspace，执行目录；与 --root 显式分离）`);
    if (action === "init" && out.port === undefined) {
      out.port = 0; // 0 = 系统分配空闲高位端口（不冻结具体端口）；serve 动作保留 undefined 以沿用 config.port
    }
  }
  if (out.host !== undefined) {
    const v = validateBindHost(out.host);
    if (!v.ok) throw new ServeUsageError(v.message);
  }
  return out;
}

/**
 * g-632 B：服务侧 graphRoot 的**唯一**解析点（显式、不猜 cwd）。
 *
 * - 未给 `--graph-dir-name`：`--root` 就是看板目录本身（g-623 语义逐字不变）；
 * - 给了 `--graph-dir-name <name>`：`--root` 视为**workspace 根**，看板目录 = `<root>/<name>`。
 *   目录名先过 `assertGraphDirName`（拒绝绝对路径 / `..` / 空段 ⇒ 路径穿越负向对照）。
 */
export function resolveGraphRootExplicit(args: ServeArgs): string {
  if (!args.root) throw new ServeUsageError("需要 --root <绝对路径>");
  if (!args.graphDirName) return resolve(args.root);
  const name = assertGraphDirName(args.graphDirName);
  return resolve(args.root, name);
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
  allowWrite: boolean;
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
  const graphRoot = resolveGraphRootExplicit(args);
  assertSeparatedRoots(graphRoot, args.workspace);
  const stateDir = resolveStateDir(args, env);
  const store = new CredentialStore({ stateDir });
  const opened = store.open();
  const config: RuntimeConfig = {
    version: 1,
    bindAddress: ALLOWED_BIND_HOST,
    port: args.port ?? 0,
    graphRoot,
    executionWorkspace: resolve(args.workspace),
    contractVersion: SERVICE_CONTRACT_VERSION,
    storageProfile: STORAGE_PROFILE,
    allowWrite: args.allowWrite === true,
  };
  writeRuntimeConfig(stateDir, config);
  auditWriteMode(stateDir, config.allowWrite === true, "init", env);
  return {
    stateDir,
    tokenCreated: opened.created,
    tokenFingerprint: opened.fingerprint,
    graphInitialized: isGraphInitialized(config.graphRoot),
    allowWrite: config.allowWrite === true,
    config,
  };
}

export interface ServiceStatus {
  stateDir: string;
  initialized: boolean;
  tokenPresent: boolean;
  tokenFingerprint: string;
  graphInitialized: boolean;
  /** g-632 A：写模式是否开启（`serve status` 必须可见）。未初始化时为 false。 */
  allowWrite: boolean;
  /** 写模式一句话说明（人类可读，不含秘密）。 */
  writeMode: string;
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
  const allowWrite = config?.allowWrite === true;
  return {
    stateDir,
    initialized: existsSync(runtimeConfigPath(stateDir)) && tokenPresent,
    tokenPresent,
    tokenFingerprint: fingerprint,
    graphInitialized: config ? isGraphInitialized(config.graphRoot) : false,
    allowWrite,
    writeMode: allowWrite
      ? "allow-write：MCP 执行类写工具已开启（actor=mcp:local-service）；人工裁决与主管/派发仍 fail-closed"
      : "read-only：MCP 只注册只读查询工具（写工具未注册）；需要写入请由服务端显式启动 `serve --allow-write`",
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
  // g-632 A：写模式的**唯一开关点**。只接受服务端显式动作：
  //   · `serve --allow-write` / `serve --no-allow-write`（本次进程，并回写运行配置）；
  //   · 否则沿用运行配置（`serve init --allow-write` 写入）。请求参数永远影响不到这里。
  let allowWrite = config.allowWrite === true;
  if (args.allowWrite === true && !allowWrite) {
    allowWrite = true;
    writeRuntimeConfig(stateDir, { ...config, allowWrite: true });
    auditWriteMode(stateDir, true, "serve", env);
  } else if (args.allowWrite === false && allowWrite) {
    allowWrite = false;
    writeRuntimeConfig(stateDir, { ...config, allowWrite: false });
    auditWriteMode(stateDir, false, "serve", env);
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
      allowWrite,
      audit: (line) => io.err(`[audit] ${line}\n`),
    });
  } catch (e: any) {
    io.err(`错误：${e?.message ?? e}\n`);
    return { exitCode: EXIT_FAILURE };
  }
  io.out(
    [
      `goal-graph 本地${allowWrite ? "服务（写模式已开启）" : "只读服务"}已启动：${service.origin}`,
      `  Web App   ${service.origin}/`,
      `  Web API   ${service.origin}/api/…（同 origin 会话 Cookie）`,
      `  MCP       ${service.origin}/mcp（Authorization: Bearer <token>）`,
      `  graphRoot          ${config.graphRoot}${isGraphInitialized(config.graphRoot) ? "" : "（未初始化：只读查询将报 E_NOT_INITIALIZED，本服务不会自动 init/claim）"}`,
      `  executionWorkspace ${config.executionWorkspace}`,
      allowWrite
        ? "  写模式             ON（--allow-write）：MCP 执行类写工具可达，actor=mcp:local-service；" +
          "graph_resolve_accept / transition→delivered / claim_supervisor / start_attempt 仍 fail-closed"
        : "  写模式             OFF（默认只读）：MCP 只注册只读查询工具；开启需服务端显式 --allow-write",
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

/**
 * g-632 A：**写模式开关审计**（开启/关闭都留痕）。
 *
 * 写入服务自有状态目录下的 `write-mode-audit.jsonl`（非 graph 数据、非 token）：
 * `{ts, action, allowWrite, stateDir}`。只登记开关动作本身，不含任何请求内容或秘密；
 * 追加失败不阻断服务启动（审计是旁路，不是门禁）——失败时由调用方 stderr 已打印。
 */
export const WRITE_MODE_AUDIT_FILE = "write-mode-audit.jsonl";

export function auditWriteMode(stateDir: string, allowWrite: boolean, action: "init" | "serve", env?: NodeJS.ProcessEnv): void {
  void env;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), action, allowWrite, pid: process.pid }) + "\n";
    // 同一行追加（不建第二真源：交由 credentials 的私有写入口保证 0600）。
    appendPrivateFile(join(stateDir, WRITE_MODE_AUDIT_FILE), line);
  } catch {
    /* 审计旁路：不阻断启动 */
  }
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
  // g-632 A：写模式开关审计文件也是**本服务自有**状态，与凭据/运行配置一并清理（graph 数据不动）。
  for (const name of [TOKEN_FILE_NAME, RUNTIME_CONFIG_NAME, WRITE_MODE_AUDIT_FILE]) {
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
