/**
 * 统一 root 解析（g-112）：host 与 client 两半共用同一函数，杜绝解析分叉。
 * g-113 修订：基准 = 会话 workspace（session.header.cwd），不再默认服务进程 process.cwd()——
 * dsh web 服务进程的 cwd 在 bwrap 沙箱里固定（≈ ~/.dsh/profiles/web），不是当前会话的 workspace，
 * 用它会读到 profile 本地空骨架而非项目自己的 .dsh-graph。
 *
 * 约定：resolveRoot(config, workspaceRoot) 的 workspaceRoot 必须由调用方显式注入——
 * host 工具侧传 ex.agent.session.header.cwd（或 sandboxPolicy.workspaceRoot），
 * client board 端点侧传请求携带的 workspace 参数；process.cwd() 仅作最后的兜底
 * （CLI/headless 等无会话上下文场景）。
 * 默认相对 `.dsh-graph`——git 友好、多项目各用各数据（第三方插件数据约定在工作区内，非 $DSH_HOME）。
 * config.root 仍可覆盖（用户层 patch / --patch overlay）：绝对路径原样返回，相对路径以 workspace 根为基准。
 *
 * g-149 扩展：Git linked-worktree canonicalization。
 * `resolveCanonicalRoot` 包装 `resolveRoot`，在 config.root 为相对路径时检测 workspace
 * 是否处于 Git linked worktree，若是则归一到主工作树的 canonical graph root。
 * 显式绝对 config.root 不做 Git 发现（管理员覆盖）；Git 发现失败时安全回退到普通 resolveRoot。
 *
 * g-363 修正（只加 **scratch 边界**；判定基准**有意保持旧语义**——主管裁决 (a)）：
 * 1) 「是否 linked worktree」仍是 `realpath(workspace) !== realpath(mainWorktree)`：仓库内
 *    **被跟踪**的子目录（`core/`、`docs/` 等）照旧归一到该项目所属主工作树的看板，g-149 语义逐字不变。
 * 2) 工作树内**被 git 忽略**的子目录（`git check-ignore`，索引感知）**且不是工作树根自身**，
 *    不算该仓库的项目内容，一律当作 **独立项目根**（`isScratchWorkspace`）：不做 canonicalization、
 *    不归属外层仓库的代码工作树、干净度探测不可判。
 *    这一条就消除了旧实现的三个污染出口（实测）：仓库内 `tmp/` 下的测试夹具写生产
 *    project.yaml/事件流、隔离实例 workspace（`tmp/dsh-test/<版本>/workspace`）写生产 memory.jsonl、
 *    linked worktree 内跑全量 47 条假红。理由：仓库内 `tmp/`（`.gitignore` 的 `/tmp/`）是 AGENTS.md
 *    指定的临时/隔离区，它必须是一个可写的**独立看板**，而不是真实看板的别名
 *    （与 mem-73f84ba7 的相容方式见 docs/dev-instance-guide.md）。
 */
import { resolve, relative, isAbsolute, sep } from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";

/** Default TTL for canonical root / git worktree cache: 30 seconds. */
export const DEFAULT_CANONICAL_CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  gitMtimeMs: number | null;
}

const worktreeInfoCache = new Map<string, CacheEntry<GitWorktreeProbe | null>>();
const canonicalRootCache = new Map<string, CacheEntry<CanonicalRootResult>>();

/**
 * Inspect .git path (directory or worktree pointer file) mtime for cache invalidation.
 * Returns null if .git is not found or stat fails.
 */
function getGitMtime(workspaceRoot: string): number | null {
  try {
    const gitPath = resolve(workspaceRoot, ".git");
    if (existsSync(gitPath)) {
      return statSync(gitPath).mtimeMs;
    }
  } catch {
    // Ignore stat failures
  }
  return null;
}

/** Clear all in-memory git worktree and canonical root caches (testing/debugging). */
export function _clearCanonicalRootCache(): void {
  worktreeInfoCache.clear();
  canonicalRootCache.clear();
}

/** Check whether a cache entry is still valid (TTL not expired and .git mtime unchanged). */
function isCacheEntryValid<T>(workspaceKey: string, entry: CacheEntry<T>, ttlMs: number): boolean {
  if (Date.now() - entry.timestamp > ttlMs) {
    return false;
  }
  const currentMtime = getGitMtime(workspaceKey);
  if (currentMtime !== entry.gitMtimeMs) {
    return false;
  }
  return true;
}
function rejectSymlinkRoot(root: string): string {
  try {
    let probe = resolve(root);
    while (!existsSync(probe)) { const parent = resolve(probe, ".."); if (parent === probe) break; probe = parent; }
    if (realpathSync(probe) !== probe) throw new Error("graph root symlink is not allowed");
  } catch (e: any) { if (e?.message === "graph root symlink is not allowed") throw e; }
  return root;
}
/**
 * 核心资料目录**默认名**（g-632 B：唯一字面量真源）。
 *
 * g-632 裁决：不同 harness 中用户应能按项目修改核心资料目录名（如 `board-a`、`boards/main`）。
 * 约定（不新增配置通道）：
 * - **插件侧**沿用既有 `config.root`（profile 配置 / `--patch` overlay）：相对值即以 workspace 为基准的
 *   目录名（可含子目录），绝对值为管理员覆盖 —— 与 `resolveRoot` 旧语义逐字一致；
 * - **CLI 侧**沿用既有 `--root`；
 * - **服务侧**必须显式给出完整 graphRoot（`serve --root <abs>`）：服务不猜 cwd；
 * - 未给出时**一律**回落本常量 ⇒ 现有用户零迁移。
 */
export const DEFAULT_GRAPH_DIR_NAME = ".dsh-graph";

/**
 * 相对 root 形态的**目录名校验**（g-632 B）：只接受工作区内的普通相对路径段。
 * 拒绝绝对路径（那是管理员覆盖，需显式语义）、`..`、空段与 NUL —— 自定义名不得把看板
 * 根移出工作区（跨看板隔离与路径越界防线的**第一道**）。
 */
export function assertGraphDirName(name: string): string {
  const raw = String(name ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (raw === "") throw new Error("graph 目录名不能为空（默认 .dsh-graph）");
  if (raw.includes("\0")) throw new Error("graph 目录名不得包含 NUL");
  if (isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) {
    throw new Error(`graph 目录名必须是工作区内的相对路径（绝对路径请走显式 graphRoot 覆盖）：${name}`);
  }
  const segments = raw.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new Error(`graph 目录名不得包含空段 / . / ..（越界防线）：${name}`);
  }
  return segments.join("/");
}

/**
 * 相对 root 形态（配置给出则校验，未给出用默认名）。
 *
 * 「未给出」的口径：`undefined` / `null` / **空串**（与 config.root 既有的「空即未给」一致，
 * 保证零迁移）。**纯空白串不是未给出** —— 它是明显的配置错误，必须 fail-closed 而不是静默
 * 回落默认名（否则 `root: "  "` 会悄悄读默认看板）。
 */
export function relativeGraphDirName(config?: { root?: string } | null): string {
  const raw = config?.root;
  if (raw === undefined || raw === null) return DEFAULT_GRAPH_DIR_NAME;
  if (typeof raw !== "string") throw new Error(`graph 目录名必须是字符串：${String(raw)}`);
  if (raw === "") return DEFAULT_GRAPH_DIR_NAME;
  return assertGraphDirName(raw);
}

export function resolveRoot(
  config?: { root?: string } | null,
  workspaceRoot: string = process.cwd(),
): string {
  const raw = config?.root;
  // 管理员覆盖：**绝对** config.root 原样生效（g-112 既有语义，逐字保留）。
  if (typeof raw === "string" && raw !== "" && isAbsolute(raw)) return rejectSymlinkRoot(resolve(raw));
  return rejectSymlinkRoot(resolve(workspaceRoot, relativeGraphDirName(config)));
}

/** Git discovery metadata returned by `discoverGitWorktree`. */
export interface GitWorktreeInfo {
  /** Absolute path to the primary/main worktree. */
  mainWorktree: string;
  /** Absolute path to the current workspace (the one that was inspected). */
  workspace: string;
  /**
   * Absolute path to the worktree **root** containing `workspace`
   * (`git rev-parse --show-toplevel`). Equals `mainWorktree` for the main worktree
   * and for any of its subdirectories.
   */
  worktreeRoot: string;
  /**
   * Whether `workspace` belongs to a Git **linked worktree** (a real `git worktree add`
   * tree) or to any subdirectory of one.
   *
   * g-363（主管裁决 (a)）：判据**有意保持旧语义** `workspace !== mainWorktree` ——
   * 仓库内**被跟踪**的子目录因此仍归一到该项目主工作树的看板（g-149 逐字不变）。
   * 仓库内**被 git 忽略**的子目录不再走这里：它们是 scratch，`discoverGitWorktree`
   * 直接返回 null（见 {@link isScratchWorkspace}），污染出口由 scratch 边界消除。
   */
  isLinkedWorktree: boolean;
}

/** Internal discovery result: worktree metadata + the g-363 scratch verdict. */
interface GitWorktreeProbe {
  info: GitWorktreeInfo;
  /** workspace 是工作树内被 git 忽略的子目录（且不是工作树根自身）。 */
  isScratch: boolean;
}

/** Options for discoverGitWorktree / resolveCanonicalRoot. */
export interface CanonicalRootOptions {
  /** Cache TTL in milliseconds (default: 30_000). Set to 0 to bypass/refresh cache. */
  ttlMs?: number;
}

/** Custom runner for git exec commands (overridable in tests/mocking).
 *  g-363：带路径参数的命令一律走 `execFileSync` 的**参数数组**签名 —— 不经 shell，
 *  Windows 上不会出现「单引号不被 cmd.exe 剥离」而把引号当路径字符的问题。 */
export const _gitRunner = {
  execSync: (cmd: string, options: any) => execSync(cmd, options),
  execFileSync: (file: string, args: string[], options: any) => execFileSync(file, args, options),
};

/** Safe realpath: falls back to the lexical path when the target does not exist. */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * g-363: 生成 `git check-ignore` 的**参数数组**（纯函数，便于平台无关的字符级守卫）。
 *
 * - 路径一律用 `/` 分隔：`relative()` 在 Windows 上产出 `\`，匹配不上 `.gitignore` 里按 `/`
 *   写的规则，故用 `sep` 归一（仅在 Windows 上做转换，避免把 POSIX 文件名里的 `\` 误当分隔符）。
 * - 带尾斜杠：调用方只传**目录**，而「目录专用」忽略规则（如 `.gitignore` 里的 `tmpdata/`）
 *   对尚不存在的路径不匹配 —— 带尾斜杠让 `tmp/…` 这类规则在目录尚未创建时也能命中。
 * - 参数里**不得出现引号字符**：调用方用数组签名（不经 shell）传参，引号只会变成路径的一部分。
 *
 * @returns 参数数组；路径越界（工作树外）时返回 null。
 */
export function checkIgnoreArgv(worktreeRoot: string, target: string): string[] | null {
  const rel = relative(worktreeRoot, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const relPosix = sep === "\\" ? rel.split(sep).join("/") : rel;
  return ["check-ignore", "-q", "--", `${relPosix}/`];
}

/**
 * g-363: 判断 `target` 是否是 `worktreeRoot` 内**被 git 忽略**的路径。
 *
 * 语义：git-ignored 的内容不属于该仓库的项目内容（scratch/本地数据）。判定走
 * `git check-ignore`（默认索引感知：已跟踪的路径即使匹配 ignore 规则也报告「未忽略」），
 * 故「已跟踪的子目录」仍视作项目内容。
 * 命令用 `_gitRunner.execFileSync` 的数组签名（不经 shell）—— 见 {@link checkIgnoreArgv}。
 * 任何失败（git 不可用、路径越界）都返回 false —— 保守地按「非 scratch」处理，
 * 避免把正常项目误判成独立项目。
 */
function isIgnoredInsideWorktree(worktreeRoot: string, target: string): boolean {
  const argv = checkIgnoreArgv(worktreeRoot, target);
  if (!argv) return false;
  try {
    _gitRunner.execFileSync("git", argv, {
      cwd: worktreeRoot,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true; // exit 0 == ignored
  } catch {
    return false; // exit 1 == not ignored, or git unavailable
  }
}

/**
 * Probe Git worktree metadata for a workspace directory.
 * Uses `git worktree list --porcelain` whose first entry is always the main worktree,
 * plus `git rev-parse --show-toplevel` for the containing worktree root (g-363), plus
 * `git check-ignore` for the scratch verdict (only for non-root subdirectories).
 * Results are cached in memory per workspace with TTL and .git mtime validation.
 * Returns null if the workspace is not inside a Git repo, git is unavailable,
 * or any command fails (safe fallback).
 */
function probeGitWorktree(
  workspaceRoot: string,
  options?: CanonicalRootOptions,
): GitWorktreeProbe | null {
  const workspaceKey = resolve(workspaceRoot);
  const ttlMs = options?.ttlMs ?? DEFAULT_CANONICAL_CACHE_TTL_MS;

  if (ttlMs > 0) {
    const cached = worktreeInfoCache.get(workspaceKey);
    if (cached && isCacheEntryValid(workspaceKey, cached, ttlMs)) {
      return cached.value;
    }
  }

  let probe: GitWorktreeProbe | null = null;
  const gitMtimeMs = getGitMtime(workspaceKey);

  try {
    // First, verify this is a Git repo (any kind — main or linked worktree)
    _gitRunner.execSync("git rev-parse --is-inside-work-tree", {
      cwd: workspaceKey,
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rawOutput = _gitRunner.execSync("git worktree list --porcelain", {
      cwd: workspaceKey,
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // g-363: containing worktree root. `--show-toplevel` fails outside a work tree /
    // for bare repos; the outer catch then yields null (workspace-local fallback),
    // i.e. we never canonicalize when the worktree root is unknown.
    const rawTop = _gitRunner.execSync("git rev-parse --show-toplevel", {
      cwd: workspaceKey,
      timeout: 5000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Parse the first worktree entry (always the main worktree)
    const output = typeof rawOutput === "string" ? rawOutput : String(rawOutput);
    const lines = output.split("\n");
    let mainPath: string | null = null;
    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        mainPath = line.slice("worktree ".length).trim();
        break;
      }
    }
    if (mainPath) {
      const resolvedWorkspace = safeRealpath(workspaceKey);
      const resolvedMain = safeRealpath(resolve(mainPath));
      const topRaw = (typeof rawTop === "string" ? rawTop : String(rawTop)).trim();
      const worktreeRoot = topRaw ? safeRealpath(resolve(workspaceKey, topRaw)) : resolvedMain;
      // g-363: scratch = worktree 内被 git 忽略的子目录（不是工作树根自身）。
      // 工作树根即使匹配 ignore 规则（例如 `.worktrees/` 被忽略的 linked worktree 根）
      // 仍然是项目根：g-149 的 canonicalization 必须保留。
      const isScratch =
        worktreeRoot !== resolvedWorkspace && isIgnoredInsideWorktree(worktreeRoot, resolvedWorkspace);

      probe = {
        info: {
          mainWorktree: resolvedMain,
          workspace: resolvedWorkspace,
          worktreeRoot,
          // 裁决 (a)：判据保持旧语义（workspace 自身 vs 主工作树）。仓库内**被跟踪**子目录
          // 照旧归一；污染出口只由上面的 scratch 边界消除。
          isLinkedWorktree: resolvedWorkspace !== resolvedMain,
        },
        isScratch,
      };
    }
  } catch {
    probe = null; // not a git repo, git command failed, or git unavailable
  }

  if (ttlMs > 0) {
    worktreeInfoCache.set(workspaceKey, {
      value: probe,
      timestamp: Date.now(),
      gitMtimeMs,
    });
  }

  return probe;
}

/**
 * Discover Git worktree metadata for a workspace directory.
 *
 * Returns null when the workspace is **not a project of any git worktree** — either because it is
 * outside a Git repo / git is unavailable, or because it is a **git-ignored scratch subdirectory**
 * of a worktree (g-363: test fixtures under the repository's `tmp/`, isolated dev instance
 * workspace at `tmp/dsh-test/<version>/workspace`). Callers must resolve such a workspace locally:
 * it is its own project root and must never be attributed to the enclosing repository
 * (see {@link isScratchWorkspace} for the explicit verdict).
 */
export function discoverGitWorktree(
  workspaceRoot: string,
  options?: CanonicalRootOptions,
): GitWorktreeInfo | null {
  const probe = probeGitWorktree(workspaceRoot, options);
  return probe && !probe.isScratch ? probe.info : null;
}

/**
 * g-363: whether `workspaceRoot` is a **git-ignored subdirectory** of the worktree containing it
 * (and not the worktree root itself). Such a directory is scratch/local data, not part of the
 * repository's project content: it gets its own graph root, is not attributed to the enclosing
 * repo's code worktree, and its git cleanliness cannot be judged.
 * Returns false for non-repo paths and on any discovery failure.
 */
export function isScratchWorkspace(workspaceRoot: string): boolean {
  return probeGitWorktree(resolve(workspaceRoot))?.isScratch === true;
}

/** Result metadata from `resolveCanonicalRoot`. */
export interface CanonicalRootResult {
  /** The resolved canonical graph root (absolute path). */
  root: string;
  /** The original workspace that was passed in. */
  workspace: string;
  /** The workspace that was used for resolution (may differ from workspace if canonicalized). */
  canonicalWorkspace: string;
  /**
   * Resolution mode:
   * - "absolute-config": explicit absolute config.root, no Git discovery
   * - "main-tree": workspace is inside the main worktree, normal resolution
   * - "canonicalized": workspace is inside a Git linked worktree, resolved to main worktree
   * - "workspace-fallback": no worktree project owns the workspace — outside a Git repo, Git
   *   discovery failed, or (g-363) the workspace is a git-ignored scratch subdirectory —
   *   fell back to workspace-local resolution
   */
  mode: "absolute-config" | "main-tree" | "canonicalized" | "workspace-fallback";
  /** Warning message when legacy worktree-local graph data is detected. */
  rootWarning?: string;
}

/**
 * Canonical graph root resolver (g-149, g-210 cached).
 *
 * Wraps `resolveRoot` with Git linked-worktree detection:
 * - Explicit absolute `config.root`: returns as-is, no Git discovery.
 * - Relative config.root (default `.dsh-graph`): if workspace is **inside a Git linked worktree**
 *   (judged by its containing worktree root, g-363), canonicalizes to `<main-worktree>/<config.root>`.
 *   If discovery fails, falls back to normal `resolveRoot` with mode "workspace-fallback".
 * - g-363: a git-ignored subdirectory of a worktree (scratch: test fixture / isolated instance
 *   workspace under the repo's `tmp/`) is its own project root → workspace-local resolution with
 *   mode "workspace-fallback". This is what keeps fixtures and isolated instances off the real board.
 * - Detects legacy worktree-local `.dsh-graph` directories and attaches warnings.
 * - Caches results in memory per (workspace, config.root) key to eliminate per-request
 *   synchronous git subprocess calls.
 *
 * The `init` function is NOT called here — callers decide whether/where to init.
 */
export function resolveCanonicalRoot(
  config?: { root?: string } | null,
  workspaceRoot: string = process.cwd(),
  options?: CanonicalRootOptions,
): CanonicalRootResult {
  const rawRoot = config?.root;
  const workspace = resolve(workspaceRoot);

  // Case 1: explicit absolute config.root — bypass Git discovery entirely
  if (rawRoot && isAbsolute(rawRoot)) {
    return {
      root: rejectSymlinkRoot(resolve(rawRoot)),
      workspace,
      canonicalWorkspace: workspace,
      mode: "absolute-config",
    };
  }

  const relRoot = relativeGraphDirName(config);
  const ttlMs = options?.ttlMs ?? DEFAULT_CANONICAL_CACHE_TTL_MS;
  const cacheKey = `${workspace}::${relRoot}`;

  if (ttlMs > 0) {
    const cached = canonicalRootCache.get(cacheKey);
    if (cached && isCacheEntryValid(workspace, cached, ttlMs)) {
      return cached.value;
    }
  }

  const localRoot = rejectSymlinkRoot(resolve(workspace, relRoot));

  // Attempt Git discovery. g-363: `discoverGitWorktree` also yields null for a git-ignored
  // scratch subdirectory (test fixture / isolated instance workspace), so those resolve
  // workspace-local instead of being canonicalized onto the real board. The explicit verdict is
  // available via `isScratchWorkspace(workspace)`.
  const gitInfo = discoverGitWorktree(workspace, { ttlMs });

  let result: CanonicalRootResult;

  if (!gitInfo) {
    // No worktree project owns this workspace (non-repo, git unavailable, or g-363 scratch) —
    // workspace-local fallback
    result = {
      root: localRoot,
      workspace,
      canonicalWorkspace: workspace,
      mode: "workspace-fallback",
    };
  } else if (!gitInfo.isLinkedWorktree) {
    // Workspace is inside the main worktree — normal resolution
    result = {
      root: localRoot,
      workspace,
      canonicalWorkspace: workspace,
      mode: "main-tree",
    };
  } else {
    // Workspace is inside a linked worktree — canonicalize to main worktree
    const canonicalRoot = rejectSymlinkRoot(resolve(gitInfo.mainWorktree, relRoot));
    let rootWarning: string | undefined;

    // Detect legacy worktree-local graph data
    if (existsSync(localRoot) && existsSync(resolve(localRoot, "events.jsonl"))) {
      rootWarning = `发现 worktree 本地旧看板 ${localRoot}；canonical graph root 为 ${canonicalRoot}。旧数据不会自动合并或删除，请手动迁移。`;
    }

    result = {
      root: canonicalRoot,
      workspace,
      canonicalWorkspace: gitInfo.mainWorktree,
      mode: "canonicalized",
      rootWarning,
    };
  }

  if (ttlMs > 0) {
    canonicalRootCache.set(cacheKey, {
      value: result,
      timestamp: Date.now(),
      gitMtimeMs: getGitMtime(workspace),
    });
  }

  return result;
}
