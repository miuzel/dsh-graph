/**
 * g-623：服务**私有运行配置**（只保存连接信息，不镜像项目业务设置）。
 *
 * 判据 7 / 8 的落地：
 * - `graphRoot`（只读看板数据）与 `executionWorkspace`（执行目录）**显式分离**：两者都必须是
 *   **显式**给出的绝对路径，且不得相同、不得互相包含；服务绝不按客户端 cwd、MCP `roots`
 *   参数或请求路径切换 root。
 * - 本文件**不**含 token/会话秘密（秘密只在 `credentials.ts` 管理的私有文件里），也**不**镜像
 *   `project.yaml` 的任何业务字段（设置页读取的是 graphRoot 下的既有真源）。
 * - 未初始化看板 ⇒ 报告 `E_NOT_INITIALIZED`，**绝不**自动 `init()` 或 `claim()`。
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { writePrivateFile } from "./credentials.ts";

/** 运行配置文件名（位于服务自有的私有状态目录）。 */
export const RUNTIME_CONFIG_NAME = "server.json";

/** 契约版本标签（设计 §1：草案版本，不等于 npm 发布号；不落入任何旧事实文件）。 */
export const SERVICE_CONTRACT_VERSION = "1.0-draft.1";
export const STORAGE_PROFILE = "dsh-graph/0.24-compatible";

export interface RuntimeConfig {
  /** 运行配置格式版本（本服务自有，语义为「连接信息」）。 */
  version: 1;
  /** 绑定地址（恒为 127.0.0.1；读取时也会重新过 policy 校验）。 */
  bindAddress: string;
  /** 实际/期望端口。 */
  port: number;
  /** 只读看板根（**绝对路径**，显式给出）。 */
  graphRoot: string;
  /** 执行目录（**绝对路径**，显式给出；与 graphRoot 必须分离）。 */
  executionWorkspace: string;
  /** 契约版本 / 存储兼容标签（只读声明）。 */
  contractVersion: string;
  storageProfile: string;
  /**
   * g-632 A：**MCP 写模式**（默认 false / 缺省即关闭）。只由服务端显式启动动作写入
   * （`serve init --allow-write` / `serve --allow-write`），**从不**由任何请求参数决定。
   * 缺省字段（旧运行配置）一律按 `false` 读取 ⇒ 升级后默认行为与 g-623 逐项一致。
   */
  allowWrite?: boolean;
}

export class ServiceConfigError extends Error {
  readonly code: "root_same" | "root_nested" | "root_relative" | "root_missing" | "config_malformed";
  constructor(code: ServiceConfigError["code"], message: string) {
    super(message);
    this.name = "ServiceConfigError";
    this.code = code;
  }
}

/** 严格的路径包含判定（按路径段，不受 `/a/bc` 与 `/a/b` 前缀同名影响）。 */
export function pathContains(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** 解析到真实路径（不存在时返回 null；不建目录）。 */
function realOrNull(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * 校验并规范化 graphRoot / executionWorkspace：
 * 1. 两者都必须是**绝对路径**（相对路径隐含依赖 cwd，等于「按进程 cwd 猜看板」，被显式拒绝）；
 * 2. 不得相同（realpath 后也一样，防止用 symlink 绕过）；
 * 3. 不得互相包含（任一方向）。
 */
export function assertSeparatedRoots(graphRoot: string, executionWorkspace: string): void {
  for (const [label, p] of [["graphRoot", graphRoot], ["executionWorkspace", executionWorkspace]] as const) {
    if (typeof p !== "string" || p.trim() === "") {
      throw new ServiceConfigError("root_missing", `${label} 必须显式给出（不允许隐式默认）`);
    }
    if (!isAbsolute(p)) {
      throw new ServiceConfigError("root_relative", `${label} 必须是绝对路径：${p}（不得按进程 cwd 猜测）`);
    }
  }
  // 字面路径与 realpath 双重判定：symlink 不能把两个 root 变成同一个。
  const variants: Array<[string, string]> = [
    [resolve(graphRoot), resolve(executionWorkspace)],
  ];
  const gReal = realOrNull(graphRoot);
  const wReal = realOrNull(executionWorkspace);
  if (gReal && wReal) variants.push([gReal, wReal]);
  for (const [g, w] of variants) {
    if (g === w) {
      throw new ServiceConfigError("root_same", `graphRoot 与 executionWorkspace 不得相同：${g}`);
    }
    if (pathContains(g, w) || pathContains(w, g)) {
      throw new ServiceConfigError(
        "root_nested",
        `graphRoot 与 executionWorkspace 不得互相包含：graphRoot=${g} executionWorkspace=${w}`,
      );
    }
  }
}

/** 看板是否**已初始化**：存在 `<root>/events.jsonl`（与 core `init` 的判定口径一致）。 */
export function isGraphInitialized(graphRoot: string): boolean {
  try {
    if (!statSync(graphRoot).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(graphRoot, "events.jsonl"));
}

export function runtimeConfigPath(stateDir: string): string {
  return join(stateDir, RUNTIME_CONFIG_NAME);
}

/** 写运行配置（0600；只含连接信息）。 */
export function writeRuntimeConfig(stateDir: string, config: RuntimeConfig): void {
  assertSeparatedRoots(config.graphRoot, config.executionWorkspace);
  writePrivateFile(runtimeConfigPath(stateDir), `${JSON.stringify(config, null, 2)}\n`);
}

/** 读运行配置（缺失/畸形 fail-closed；不含秘密）。 */
export function readRuntimeConfig(stateDir: string): RuntimeConfig {
  const file = runtimeConfigPath(stateDir);
  if (!existsSync(file)) {
    throw new ServiceConfigError("config_malformed", `运行配置不存在：${file}（请先显式初始化本服务）`);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ServiceConfigError("config_malformed", "运行配置不是合法 JSON");
  }
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
    throw new ServiceConfigError("config_malformed", "运行配置格式不受支持（需要 version=1）");
  }
  const cfg: RuntimeConfig = {
    version: 1,
    bindAddress: String(parsed.bindAddress ?? ""),
    port: Number(parsed.port),
    graphRoot: String(parsed.graphRoot ?? ""),
    executionWorkspace: String(parsed.executionWorkspace ?? ""),
    contractVersion: String(parsed.contractVersion ?? SERVICE_CONTRACT_VERSION),
    storageProfile: String(parsed.storageProfile ?? STORAGE_PROFILE),
    // 缺省即关闭；只接受**明确的布尔 true**（字符串 "true" 等一律不认，避免畸形配置意外开启）。
    allowWrite: parsed.allowWrite === true,
  };
  // 端口 0 = 「由系统分配空闲高位端口」（不冻结具体端口，见设计 §2）；1..65535 为显式端口。
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535) {
    throw new ServiceConfigError("config_malformed", `运行配置端口非法：${parsed.port}`);
  }
  assertSeparatedRoots(cfg.graphRoot, cfg.executionWorkspace);
  return cfg;
}
